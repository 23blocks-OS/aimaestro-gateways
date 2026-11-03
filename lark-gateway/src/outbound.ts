/** Authorizes AMP senders and delivers queued replies to Lark. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { AMPMessage, GatewayConfig, RoutingConfig } from './types.js';
import { ThreadStore } from './thread-store.js';
import {
  looksStructured,
  splitMessage,
  splitMessageBytes,
} from './normalize.js';
import { logEvent } from './api/activity-log.js';
import { errLine } from './log-hygiene.js';
import { backoffMs, shouldPark } from './retry-policy.js';
import { agentAddress, isAgentSender } from './routing.js';

export interface OutboundOps {
  reply(chatId: string, text: string, parentId?: string): Promise<void>;
  sendText(
    chatId: string,
    text: string,
    parentId?: string,
    uuid?: string,
  ): Promise<string>;
  sendCard(
    chatId: string,
    card: Record<string, unknown>,
    parentId?: string,
    uuid?: string,
  ): Promise<string>;
  sendAttachment(
    chatId: string,
    parentId: string | undefined,
    attachment: unknown,
    uuid?: string,
  ): Promise<void>;
  finishReaction(messageId: string, emoji?: string): Promise<void>;
}
type Button = { label: string; action: string; value?: unknown };
class UndeliverableError extends Error {}

function object(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}
function deliveryUuid(messageId: string, part: string): string {
  return createHash('sha256')
    .update(`${messageId}:${part}`)
    .digest('hex')
    .slice(0, 32);
}
function buildCard(
  text: string,
  buttons: Button[],
  owner: string,
  agent: string,
  threadId: string,
  title?: string,
): Record<string, unknown> {
  // Card JSON 2.0: its markdown element renders headings, tables, code
  // blocks and quotes, which the 1.0 markdown element shows as raw text.
  const elements: unknown[] = [
    { tag: 'markdown', content: text.slice(0, 25000) },
  ];
  for (const b of buttons.slice(0, 5))
    elements.push({
      tag: 'button',
      text: { tag: 'plain_text', content: b.label.slice(0, 50) },
      type: 'primary',
      behaviors: [
        {
          type: 'callback',
          value: {
            agent,
            action: b.action,
            value: b.value ?? null,
            amp_thread: threadId,
            owner,
          },
        },
      ],
    });
  // No header by default: Lark already shows the bot's name. An agent can
  // set context.lark.title for one.
  return {
    schema: '2.0',
    ...(title
      ? { header: { title: { tag: 'plain_text', content: title } } }
      : {}),
    body: { elements },
  };
}

export class OutboundPoller {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  private retries = new Map<string, { attempts: number; next: number }>();
  /**
   * Where each inbox file may be delivered, recorded once its sender passed
   * the owner check. A failure notice goes only here: a message parked before
   * that check is not from the person's agent, and a notice would let any AMP
   * sender make the bot message any person.
   */
  private authorized = new Map<string, { chatId: string; parentId?: string }>();
  private undeliverable: string;
  constructor(
    private config: GatewayConfig,
    private routing: () => RoutingConfig,
    private threads: ThreadStore,
    private ops: OutboundOps,
  ) {
    this.undeliverable = path.join(
      path.dirname(config.amp.inboxDir),
      'undeliverable',
    );
  }
  start(): void {
    this.stopped = false;
    void this.poll();
    this.timer = setInterval(
      () => void this.poll(),
      this.config.pollIntervalMs,
    );
  }
  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }
  private async poll(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      fs.mkdirSync(this.config.amp.inboxDir, { recursive: true });
      for (const file of this.scanInbox()) {
        if (this.stopped) return;
        const name = path.basename(file);
        const retry = this.retries.get(file);
        if (retry && Date.now() < retry.next) continue;
        try {
          const msg = JSON.parse(fs.readFileSync(file, 'utf8')) as AMPMessage;
          await this.deliver(msg, file);
          if (this.stopped) return;
          fs.unlinkSync(file);
          try {
            fs.unlinkSync(`${file}.progress.json`);
          } catch {
            /* absent checkpoint */
          }
          this.retries.delete(file);
          this.authorized.delete(file);
        } catch (error) {
          if (error instanceof UndeliverableError) {
            this.park(file, error);
            continue;
          }
          const n = (this.retries.get(file)?.attempts || 0) + 1;
          const delay = backoffMs(n, this.config.pollIntervalMs);
          this.retries.set(file, { attempts: n, next: Date.now() + delay });
          console.error(
            `[OUTBOUND] ${path.basename(file)} attempt ${n}: ${errLine(error)}`,
          );
          try {
            if (shouldPark(n, Date.now() - fs.statSync(file).mtimeMs))
              this.park(file, error);
          } catch (parkError) {
            console.error(
              `[OUTBOUND] Could not park ${name}: ${errLine(parkError)}`,
            );
          }
        }
      }
    } catch (error) {
      console.error(`[OUTBOUND] Inbox poll failed: ${errLine(error)}`);
    } finally {
      this.running = false;
    }
  }

  /** AMP stores each sender's messages in its own directory. */
  private scanInbox(): string[] {
    const files: string[] = [];
    const now = Date.now();
    for (const entry of fs.readdirSync(this.config.amp.inboxDir, {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory()) continue;
      const senderDir = path.join(this.config.amp.inboxDir, entry.name);
      let children: string[];
      try {
        children = fs.readdirSync(senderDir);
      } catch (error) {
        console.error(
          `[OUTBOUND] Cannot read sender directory ${entry.name}: ${errLine(error)}`,
        );
        continue;
      }
      files.push(
        ...children
          .filter(
            (name) =>
              name.endsWith('.json') &&
              !name.endsWith('.progress.json') &&
              !name.endsWith('.retry.json'),
          )
          .map((name) => path.join(senderDir, name)),
      );
      if (children.length === 0) {
        try {
          const stat = fs.statSync(senderDir);
          if (now - stat.mtimeMs > 60_000) fs.rmdirSync(senderDir);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
            console.error(
              `[OUTBOUND] Could not clean empty sender directory ${entry.name}: ${errLine(error)}`,
            );
        }
      }
    }
    return files.sort();
  }
  private park(file: string, error: unknown): void {
    fs.mkdirSync(this.undeliverable, { recursive: true });
    fs.renameSync(file, path.join(this.undeliverable, path.basename(file)));
    try {
      fs.renameSync(
        `${file}.progress.json`,
        path.join(this.undeliverable, `${path.basename(file)}.progress.json`),
      );
    } catch {
      /* absent checkpoint */
    }
    this.retries.delete(file);
    const reason = errLine(error);
    console.error(`[OUTBOUND] ${path.basename(file)} parked: ${reason}`);
    logEvent('error', 'Outbound Lark message parked', { error: reason });
    try {
      fs.writeFileSync(
        path.join(this.undeliverable, `${path.basename(file)}.reason.json`),
        JSON.stringify({ reason, parkedAt: new Date().toISOString() }),
        { mode: 0o600 },
      );
    } catch (reasonError) {
      console.error(
        `[OUTBOUND] Could not record park reason: ${errLine(reasonError)}`,
      );
    }
    const destination = this.authorized.get(file);
    this.authorized.delete(file);
    if (!destination) return;
    void this.ops
      .reply(
        destination.chatId,
        "Your agent's reply could not be delivered. Please try again later or contact an administrator.",
        destination.parentId,
      )
      .catch((replyError) =>
        console.error(
          `[OUTBOUND] Could not notify Lark recipient: ${errLine(replyError)}`,
        ),
      );
  }
  private async deliver(message: AMPMessage, file: string): Promise<void> {
    // Re-checked on every attempt: routing may have changed since the last.
    this.authorized.delete(file);
    const progressFile = `${file}.progress.json`;
    let completed = new Set<string>();
    try {
      completed = new Set(
        JSON.parse(fs.readFileSync(progressFile, 'utf8')) as string[],
      );
    } catch {
      /* first delivery */
    }
    const sendPart = async (key: string, send: () => Promise<void>) => {
      if (completed.has(key)) return;
      try {
        await send();
      } catch (error) {
        const text = errLine(error);
        if (
          /Lark API (?:400|2300\d{2}|2300\d{3})|invalid (?:content|param)|too large|card.*(?:invalid|size)/i.test(
            text,
          )
        )
          throw new UndeliverableError(text);
        throw error;
      }
      completed.add(key);
      fs.writeFileSync(progressFile, JSON.stringify([...completed]), {
        mode: 0o600,
      });
    };
    const ctx = object(message.payload?.context);
    const lark = object(ctx.lark);
    const replyId = String(message.envelope?.in_reply_to || '');
    const larkMessageId =
      typeof lark.message_id === 'string' ? lark.message_id : '';
    const stored =
      (replyId ? this.threads.get(replyId) : undefined) ||
      (larkMessageId ? this.threads.get(larkMessageId) : undefined);
    const toSlug = typeof lark.to === 'string' ? lark.to : '';
    const person = toSlug ? this.routing().people[toSlug] : undefined;
    const direct =
      stored ||
      (person
        ? {
            messageId: '',
            rootId: '',
            chatId: '',
            chatType: 'p2p',
            openId: person.open_id,
            person: toSlug,
            agent: person.agent,
            createdAt: Date.now(),
          }
        : undefined);
    if (!direct)
      throw new UndeliverableError(
        'No Lark destination: missing in_reply_to thread or context.lark.to',
      );
    const expectedAgent = stored ? stored.agent : person?.agent;
    if (
      !expectedAgent ||
      !isAgentSender(
        message.envelope?.from,
        expectedAgent,
        this.config.amp.tenant,
      )
    ) {
      throw new UndeliverableError(
        `Unauthorized AMP sender for Lark destination ${direct.person}; expected ${agentAddress(expectedAgent || 'unknown', this.config.amp.tenant)}`,
      );
    }
    const chatId = direct.chatId || direct.openId;
    const parent = direct.messageId || undefined;
    this.authorized.set(file, { chatId, parentId: parent });
    const text = String(message.payload?.message || '');
    const larkContext = object(ctx.lark);
    const format = larkContext.format;
    const title =
      typeof larkContext.title === 'string'
        ? Array.from(larkContext.title.trim()).slice(0, 100).join('')
        : '';
    const buttons = Array.isArray(larkContext.buttons)
      ? (larkContext.buttons as Button[])
      : [];
    if (
      buttons.some(
        (button) =>
          typeof button?.label !== 'string' ||
          typeof button?.action !== 'string',
      )
    )
      throw new UndeliverableError(
        'Invalid Lark card button: label and action must be strings',
      );
    let sentMessageId = '';
    if (text) {
      if (
        format === 'card' ||
        (format !== 'text' && (looksStructured(text) || buttons.length))
      ) {
        // Reserve room for JSON escaping and the rest of the card structure.
        const chunks = splitMessageBytes(text, 4000);
        for (let i = 0; i < chunks.length; i++)
          await sendPart(`card-${i}`, async () => {
            sentMessageId = await this.ops.sendCard(
              chatId,
              buildCard(
                chunks[i],
                i === chunks.length - 1 ? buttons : [],
                direct.person,
                direct.agent,
                replyId || String(message.envelope?.id || ''),
                i === 0 ? title : undefined,
              ),
              parent,
              deliveryUuid(
                String(message.envelope?.id || replyId),
                `card-${i}`,
              ),
            );
          });
      } else {
        const chunks = splitMessage(text, 3500);
        for (let i = 0; i < chunks.length; i++)
          await sendPart(`text-${i}`, async () => {
            sentMessageId = await this.ops.sendText(
              chatId,
              chunks[i],
              parent,
              deliveryUuid(
                String(message.envelope?.id || replyId),
                `text-${i}`,
              ),
            );
          });
      }
    }
    const attachments = message.payload?.attachments || [];
    for (let i = 0; i < attachments.length; i++)
      await sendPart(`attachment-${i}`, () =>
        this.ops.sendAttachment(
          chatId,
          parent,
          attachments[i],
          deliveryUuid(
            String(message.envelope?.id || replyId),
            `attachment-${i}`,
          ),
        ),
      );
    if (parent) {
      const reactionDone =
        typeof larkContext.reaction_done === 'string'
          ? larkContext.reaction_done
          : 'DONE';
      await this.ops.finishReaction(parent, reactionDone).catch(() => {});
      this.threads.updateStatus(direct.rootId, 'done');
    }
    if (!stored && message.envelope?.id) {
      const initiated = {
        ...direct,
        chatId,
        messageId: sentMessageId,
        rootId: sentMessageId || message.envelope.id,
      };
      this.threads.set(message.envelope.id, initiated);
      if (sentMessageId) this.threads.set(sentMessageId, initiated);
    }
    logEvent('outbound', `Lark reply delivered to ${direct.person}`, {
      from: message.envelope?.from,
      to: direct.person,
      ampMessageId: message.envelope?.id,
      deliveryStatus: 'delivered',
    });
  }
}
