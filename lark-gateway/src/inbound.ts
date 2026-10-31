/** Queues, normalizes, secures, and routes inbound Lark messages. */
import fs from 'node:fs';
import path from 'node:path';
import type {
  GatewayConfig,
  NormalizedMessage,
  RoutingConfig,
  ThreadContext,
} from './types.js';
import { DedupeStore } from './dedupe.js';
import { ThreadStore } from './thread-store.js';
import { normalizeMessage } from './normalize.js';
import { agentAddress, parseAgentTag, resolveSender } from './routing.js';
import { sanitizeMessage } from './content-security.js';
import { logEvent } from './api/activity-log.js';
import {
  sanitizeAttachmentFilename,
  uploadAmpAttachment,
} from './attachment-flow.js';
import { normalizeCardAction } from '@larksuiteoapi/node-sdk';
import { authorizeCardAction, routeCardAction } from './card-actions.js';

type Dict = Record<string, unknown>;
export interface LarkOps {
  download(
    messageId: string,
    key: string,
    type: string,
  ): Promise<{ name: string; contentType: string; bytes: Buffer }>;
  parentText(messageId: string): Promise<string | null>;
  reply(chatId: string, text: string, parentId?: string): Promise<void>;
  react(messageId: string, emoji: string): Promise<void>;
  forwardedMessages?(
    messageId: string,
  ): Promise<Array<{ content: string; sender?: { sender_name?: string } }>>;
}
export interface InboundEvent {
  event_id?: string;
  schema?: string;
  header?: Dict;
  event?: Dict;
}
interface InboundRetry {
  attempts: number;
  firstFailedAt: number;
  nextAttemptAt: number;
}
export interface InboundRetryOptions {
  maxAttempts?: number;
  maxAgeMs?: number;
  baseDelayMs?: number;
}

function obj(value: unknown): Dict {
  return value && typeof value === 'object' ? (value as Dict) : {};
}
function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
function pickEvent(raw: InboundEvent): Dict {
  return Object.keys(obj(raw.event)).length ? obj(raw.event) : (raw as Dict);
}

function selectTargetAgent(
  isAdmin: boolean,
  taggedAgent: string | undefined,
  stickyAgent: string | undefined,
  senderAgent: string,
): string {
  if (isAdmin && taggedAgent) return taggedAgent;
  if (stickyAgent) return stickyAgent;
  return senderAgent;
}

export class InboundProcessor {
  private busy = false;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private queueDir: string;
  constructor(
    private config: GatewayConfig,
    private getRouting: () => RoutingConfig,
    private dedupe: DedupeStore,
    private threads: ThreadStore,
    private ops: LarkOps,
    private retryOptions: InboundRetryOptions = {},
  ) {
    this.queueDir = path.join(config.stateDir, 'inbound-queue');
    fs.mkdirSync(this.queueDir, { recursive: true });
  }

  /** Durable enqueue is the only work performed in the SDK callback, so it can acknowledge promptly. */
  enqueue(raw: InboundEvent): void {
    const event = pickEvent(raw);
    const message = obj(event.message);
    const header = obj(raw.header);
    const eventId =
      str(header.event_id) || str(raw.event_id) || str(event.event_id);
    const messageId = str(message.message_id);
    if (!messageId || this.dedupe.has(eventId, messageId)) return;
    const file = path.join(
      this.queueDir,
      `${messageId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`,
    );
    const tmp = `${file}.tmp`;
    if (!fs.existsSync(file)) {
      fs.writeFileSync(tmp, JSON.stringify(raw), { mode: 0o600 });
      fs.renameSync(tmp, file);
    }
    this.dedupe.mark(eventId, messageId);
    this.kick();
  }

  /** Persist card callbacks before acknowledging them to the Lark SDK. */
  enqueueCardAction(raw: unknown): void {
    const outer = obj(raw);
    const header = obj(outer.header);
    const eventId = str(header.event_id) || str(outer.event_id);
    if (!eventId || this.dedupe.hasCard(eventId)) return;
    const file = path.join(
      this.queueDir,
      `card-${eventId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`,
    );
    if (!fs.existsSync(file)) {
      const temporary = `${file}.tmp`;
      fs.writeFileSync(
        temporary,
        JSON.stringify({ kind: 'card_action', eventId, raw }),
        { mode: 0o600 },
      );
      fs.renameSync(temporary, file);
    }
    this.kick();
  }

  start(): void {
    this.stopped = false;
    this.kick();
    this.timer = setInterval(
      () => this.kick(),
      Math.max(50, this.config.pollIntervalMs),
    );
  }
  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.threads.save();
  }
  private kick(): void {
    if (!this.busy) void this.drain();
  }

  private async drain(): Promise<void> {
    this.busy = true;
    try {
      const files = fs
        .readdirSync(this.queueDir)
        .filter((n) => n.endsWith('.json') && !n.endsWith('.retry.json'))
        .sort();
      for (const name of files) {
        const file = path.join(this.queueDir, name);
        const retry = this.loadRetry(file);
        if (retry && Date.now() < retry.nextAttemptAt) continue;
        try {
          const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as InboundEvent;
          await this.process(raw);
          if (this.stopped) return;
          fs.unlinkSync(file);
          const retryPath = this.retryFile(file);
          if (fs.existsSync(retryPath)) fs.unlinkSync(retryPath);
        } catch (error) {
          await this.handleFailure(file, name, error, retry);
        }
      }
    } catch (error) {
      console.error(
        `[INBOUND] Queue drain failed: ${(error as Error).message}`,
      );
    } finally {
      this.busy = false;
    }
  }

  private async process(raw: InboundEvent): Promise<void> {
    const queued = raw as InboundEvent & {
      kind?: string;
      eventId?: string;
      raw?: unknown;
    };
    if (queued.kind === 'card_action') {
      await this.processCardAction(queued.raw, queued.eventId || '');
      return;
    }
    const event = pickEvent(raw);
    const message = obj(event.message);
    const sender = obj(event.sender);
    const senderId = obj(sender.sender_id);
    const id = str(message.message_id);
    const chatId = str(message.chat_id);
    const chatType = str(message.chat_type);
    const messageType = str(message.message_type);
    const openId = str(senderId.open_id);
    const mentionRows = Array.isArray(message.mentions)
      ? message.mentions.map((m) => obj(m))
      : [];
    const mentions = Object.fromEntries(
      mentionRows.flatMap((mention) => {
        const key = str(mention.key);
        if (!key) return [];
        const isBot =
          mention.mentioned_type === 'bot' || mention.mentioned_type === 'app';
        const display = str(mention.name) || str(mention.user_name) || key;
        return [
          [key, isBot ? '' : `@${display}`],
          ...(isBot && display ? [[`@${display}`, '']] : []),
        ];
      }),
    );
    if (!id || !openId || str(sender.sender_type) === 'app') return;
    if (this.dedupe.hasRouted(id)) return;
    const content = str(message.content);
    let normalizedContent = content;
    if (messageType === 'merge_forward' && this.ops.forwardedMessages) {
      try {
        if (id) {
          const messages = await this.ops.forwardedMessages(id);
          normalizedContent = JSON.stringify({ messages });
        }
      } catch {
        /* keep the captured forwarding envelope as a fallback */
      }
    }
    const normalized = normalizeMessage(
      messageType,
      normalizedContent,
      mentions,
    );
    if (normalized.ignored) return;
    const mentionedBot = mentionRows.some(
      (m) => m.mentioned_type === 'bot' || m.mentioned_type === 'app',
    );
    const route = resolveSender(
      openId,
      this.getRouting(),
      chatType,
      mentionedBot,
    );
    if (route.kind === 'ignore') return;
    if (route.reply) {
      await this.ops.reply(chatId, route.reply, id);
      logEvent('inbound', `Lark ${route.kind} sender response`, {
        subject: messageType,
      });
      return;
    }
    if (!route.agent || !route.person) return;

    // Fetch reply parent content when available, but failure does not block the message.
    const parentId = str(message.parent_id) || null;
    let parentText: string | null = null;
    if (parentId) {
      try {
        parentText = await this.ops.parentText(parentId);
      } catch {
        parentText = null;
      }
    }
    const messageData = await this.downloadAttachments(chatId, id, normalized);
    if (messageData === null) return;
    const tagged = parseAgentTag(normalized.text);
    const sticky = parentId ? this.threads.get(parentId) : undefined;
    const target = selectTargetAgent(
      route.admin,
      tagged.agent,
      sticky?.agent,
      route.agent,
    );
    const forwarded = messageType === 'merge_forward';
    const trust = target === route.agent ? 'operator' : 'external';
    const messageText = route.admin ? tagged.text : normalized.text;
    const security = sanitizeMessage(
      messageText,
      route.person,
      trust,
      forwarded,
    );
    const now = new Date().toISOString();
    const larkRootId = str(message.root_id) || null;
    const rootId = larkRootId || parentId || id;
    const safeParentText = parentText
      ? sanitizeMessage(parentText, route.person, 'external', true).sanitized
      : null;
    const ampPayload = {
      to: agentAddress(target, this.config.amp.tenant),
      subject: `Lark message from ${route.person}`,
      priority: 'normal',
      payload: {
        type: 'request',
        message: security.sanitized,
        attachments: messageData,
        context: {
          channel: {
            type: 'lark',
            bridge_agent: this.config.amp.agentAddress,
            sender: route.person,
            sender_id: route.person,
            sender_name:
              str(sender.sender_name) || str(sender.name) || route.person,
            chat_id: chatId,
            thread_id: rootId,
            received_at: now,
          },
          lark: {
            app: 'agent',
            chat_type: chatType,
            chat_id: chatId,
            message_id: id,
            root_id: larkRootId,
            parent_id: parentId,
            person: route.person,
            parent_text: safeParentText,
            card_action: null,
          },
          security: {
            trust: security.trust.level,
            injection_flags: security.flags.map((f) => f.category),
            wrapped: security.wrapped,
            source: 'lark',
            scanned: true,
          },
        },
      },
    };
    const ctx: ThreadContext = {
      messageId: id,
      rootId,
      chatId,
      chatType,
      openId,
      person: route.person,
      agent: target,
      createdAt: Date.now(),
      status: 'working',
    };
    // A response can arrive as soon as Maestro accepts the route, before the
    // HTTP response gives us the AMP id. Key the destination by Lark id too.
    this.threads.set(id, ctx);
    const response = await fetch(`${this.config.amp.maestroUrl}/api/v1/route`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.config.amp.apiKey}`,
      },
      body: JSON.stringify(ampPayload),
      signal: AbortSignal.timeout(this.config.timeoutMs),
    });
    if (!response.ok) throw new Error(`AMP route failed (${response.status})`);
    if (this.stopped) return;
    const result = (await response.json()) as { id?: string };
    if (result.id) this.threads.set(result.id, ctx);
    this.dedupe.markRouted(id);
    await this.ops.react(id, 'THUMBSUP').catch(() => {});
    const progressTimer = setTimeout(() => {
      const current = this.threads.findByRoot(rootId);
      if (current?.status === 'working')
        void this.ops.reply(chatId, 'Still working on it.', id).catch(() => {});
    }, this.config.workingDelayMs);
    progressTimer.unref();
    logEvent('inbound', `Lark message routed: ${route.person} -> ${target}`, {
      from: route.person,
      to: target,
      subject: normalized.text.slice(0, 80),
      ampMessageId: result.id,
      deliveryStatus: 'queued',
    });
  }

  private async processCardAction(
    raw: unknown,
    eventId: string,
  ): Promise<void> {
    const outer = obj(raw);
    const event = normalizeCardAction(obj(outer.event || raw) as any);
    if (!event)
      throw new Error(
        'Card callback is missing message, chat, or operator identity',
      );
    const value = obj(event.action.value);
    const owner = str(value.owner);
    const routing = this.getRouting();
    const clicker = authorizeCardAction(event.operator.openId, owner, routing);
    if (!clicker) throw new Error('Card callback owner authorization failed');
    const targetAgent = str(value.agent);
    const ampId = await routeCardAction(
      this.config,
      routing,
      value,
      clicker,
      fetch,
      event.chatId,
    );
    if (!ampId)
      throw new Error('AMP card-action route response omitted its message id');
    const person = routing.people[clicker];
    const context: ThreadContext = {
      messageId: event.messageId,
      rootId: event.messageId,
      chatId: event.chatId,
      chatType: 'p2p',
      openId: person.open_id,
      person: clicker,
      agent: targetAgent,
      createdAt: Date.now(),
      status: 'working',
    };
    this.threads.set(event.messageId, context);
    this.threads.set(ampId, context);
    if (eventId) this.dedupe.markCard(eventId);
  }

  private async downloadAttachments(
    chatId: string,
    messageId: string,
    message: NormalizedMessage,
  ): Promise<unknown[] | null> {
    if (message.attachments.length > 10) {
      await this.ops.reply(
        chatId,
        'This message has more than the 10 attachment limit. Please send fewer files.',
        messageId,
      );
      return null;
    }
    const result: unknown[] = [];
    for (const item of message.attachments) {
      const downloaded = await this.ops.download(
        messageId,
        item.key,
        item.type,
      );
      if (downloaded.bytes.length > 25 * 1024 * 1024) {
        await this.ops.reply(
          chatId,
          `Attachment ${downloaded.name} is larger than the 25 MB limit. Please send a smaller file.`,
          messageId,
        );
        return null;
      }
      const reference = await uploadAmpAttachment(this.config, {
        name: sanitizeAttachmentFilename(item.name, item.key),
        content_type: downloaded.contentType || 'application/octet-stream',
        bytes: downloaded.bytes,
      });
      result.push(reference);
    }
    return result;
  }

  private retryFile(file: string): string {
    return `${file}.retry.json`;
  }

  private loadRetry(file: string): InboundRetry | undefined {
    try {
      return JSON.parse(
        fs.readFileSync(this.retryFile(file), 'utf8'),
      ) as InboundRetry;
    } catch {
      return undefined;
    }
  }

  private saveRetry(file: string, retry: InboundRetry): void {
    fs.writeFileSync(this.retryFile(file), JSON.stringify(retry), {
      mode: 0o600,
    });
  }

  private async handleFailure(
    file: string,
    name: string,
    error: unknown,
    prior?: InboundRetry,
  ): Promise<void> {
    const now = Date.now();
    const retry: InboundRetry = {
      attempts: (prior?.attempts || 0) + 1,
      firstFailedAt: prior?.firstFailedAt || now,
      nextAttemptAt: 0,
    };
    // Capped five-minute retries remain active for an hour-long Maestro outage.
    const maxAttempts = this.retryOptions.maxAttempts ?? 100;
    const maxAgeMs = this.retryOptions.maxAgeMs ?? 24 * 60 * 60 * 1000;
    const baseDelayMs =
      this.retryOptions.baseDelayMs ?? this.config.pollIntervalMs;
    const ageMs = now - retry.firstFailedAt;
    const permanent =
      /(?:AMP route failed|API failed) \((?:400|401|403|404|413)\)/.test(
        (error as Error).message || '',
      );
    if (permanent || retry.attempts >= maxAttempts || ageMs >= maxAgeMs) {
      await this.parkInbound(file, name, error);
      return;
    }
    retry.nextAttemptAt =
      now + Math.min(baseDelayMs * 2 ** (retry.attempts - 1), 5 * 60 * 1000);
    this.saveRetry(file, retry);
    console.error(
      `[INBOUND] ${name} failed on attempt ${retry.attempts}; retrying in ${Math.ceil((retry.nextAttemptAt - now) / 1000)}s: ${(error as Error).message}`,
    );
  }

  private async parkInbound(
    file: string,
    name: string,
    error: unknown,
  ): Promise<void> {
    const targetDir = path.join(this.config.stateDir, 'undeliverable-inbound');
    fs.mkdirSync(targetDir, { recursive: true });
    const target = path.join(targetDir, name);
    try {
      fs.renameSync(file, target);
    } catch (renameError) {
      console.error(
        `[INBOUND] Could not park ${name}: ${(renameError as Error).message}`,
      );
      return;
    }
    const retryPath = this.retryFile(file);
    if (fs.existsSync(retryPath))
      fs.renameSync(retryPath, `${target}.retry.json`);
    logEvent('error', 'Inbound Lark message parked', {
      subject: name,
      error: (error as Error).message,
    });
    console.error(
      `[INBOUND] ${name} parked after repeated failure: ${(error as Error).message}`,
    );
    try {
      const raw = JSON.parse(fs.readFileSync(target, 'utf8')) as InboundEvent;
      const queued = raw as InboundEvent & { kind?: string; raw?: unknown };
      if (queued.kind === 'card_action') {
        const outer = obj(queued.raw);
        const event = normalizeCardAction(
          obj(outer.event || queued.raw) as any,
        );
        if (event) {
          await this.ops.reply(
            event.chatId,
            "Your agent's reply could not be delivered. Please try again later or contact an administrator.",
            event.messageId,
          );
        }
        return;
      }
      const event = pickEvent(raw);
      const message = obj(event.message);
      if (
        typeof message.chat_id === 'string' &&
        typeof message.message_id === 'string'
      ) {
        await this.ops.reply(
          message.chat_id,
          'I could not deliver this message to your AI Maestro agent. Please try again later or contact an administrator.',
          message.message_id,
        );
      }
    } catch (replyError) {
      console.error(
        `[INBOUND] Could not send failure reply for ${name}: ${(replyError as Error).message}`,
      );
    }
  }
}
