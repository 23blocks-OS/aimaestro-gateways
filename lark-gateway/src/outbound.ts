import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { AMPMessage, GatewayConfig, RoutingConfig } from './types.js';
import { ThreadStore } from './thread-store.js';
import { looksStructured, splitMessage, splitMessageBytes } from './normalize.js';
import { logEvent } from './api/activity-log.js';
import { errLine } from './log-hygiene.js';
import { backoffMs, shouldPark } from './retry-policy.js';

export interface OutboundOps {
  reply(chatId: string, text: string, parentId?: string): Promise<void>;
  sendText(chatId: string, text: string, parentId?: string, uuid?: string): Promise<string>;
  sendCard(chatId: string, card: Record<string, unknown>, parentId?: string, uuid?: string): Promise<string>;
  sendAttachment(chatId: string, parentId: string | undefined, attachment: unknown, uuid?: string): Promise<void>;
  finishReaction(messageId: string): Promise<void>;
}
type Button = { label: string; action: string; value?: unknown };

function object(v: unknown): Record<string, unknown> { return v && typeof v === 'object' ? v as Record<string, unknown> : {}; }
function deliveryUuid(messageId: string, part: string): string { return createHash('sha256').update(`${messageId}:${part}`).digest('hex').slice(0, 32); }
function buildCard(text: string, buttons: Button[], owner: string, agent: string, threadId: string): Record<string, unknown> {
  const elements: unknown[] = [{ tag: 'markdown', content: text.slice(0, 25000) }];
  if (buttons.length) elements.push({ tag: 'action', actions: buttons.slice(0, 5).map((b) => ({ tag: 'button', text: { tag: 'plain_text', content: b.label.slice(0, 50) }, type: 'primary', value: { agent, action: b.action, value: b.value ?? null, amp_thread: threadId, owner } })) });
  return { config: { wide_screen_mode: true }, header: { title: { tag: 'plain_text', content: 'AI Maestro' } }, elements };
}

export class OutboundPoller {
  private timer: NodeJS.Timeout | null = null; private running = false; private retries = new Map<string, { attempts: number; next: number }>();
  private undeliverable: string;
  constructor(private config: GatewayConfig, private routing: () => RoutingConfig, private threads: ThreadStore, private ops: OutboundOps) { this.undeliverable = path.join(path.dirname(config.amp.inboxDir), 'undeliverable'); }
  start(): void { void this.poll(); this.timer = setInterval(() => void this.poll(), this.config.pollIntervalMs); }
  stop(): void { if (this.timer) clearInterval(this.timer); }
  private async poll(): Promise<void> {
    if (this.running) return; this.running = true;
    try {
      fs.mkdirSync(this.config.amp.inboxDir, { recursive: true });
      for (const name of fs.readdirSync(this.config.amp.inboxDir).filter((n) => n.endsWith('.json')).sort()) {
        const file = path.join(this.config.amp.inboxDir, name); const retry = this.retries.get(file); if (retry && Date.now() < retry.next) continue;
        try { const msg = JSON.parse(fs.readFileSync(file, 'utf8')) as AMPMessage; await this.deliver(msg); fs.unlinkSync(file); this.retries.delete(file); }
        catch (error) { const n = (this.retries.get(file)?.attempts || 0) + 1; const delay = backoffMs(n, this.config.pollIntervalMs); this.retries.set(file, { attempts: n, next: Date.now() + delay }); console.error(`[OUTBOUND] ${path.basename(file)} attempt ${n}: ${errLine(error)}`); if (shouldPark(n, Date.now() - fs.statSync(file).mtimeMs)) this.park(file, error); }
      }
    } finally { this.running = false; }
  }
  private park(file: string, error: unknown): void { fs.mkdirSync(this.undeliverable, { recursive: true }); fs.renameSync(file, path.join(this.undeliverable, path.basename(file))); this.retries.delete(file); logEvent('error', 'Outbound Lark message parked', { error: errLine(error) }); }
  private async deliver(message: AMPMessage): Promise<void> {
    const ctx = object(message.payload?.context); const lark = object(ctx.lark); const replyId = String(message.envelope?.in_reply_to || '');
    const stored = replyId ? this.threads.get(replyId) : undefined;
    const toSlug = typeof lark.to === 'string' ? lark.to : '';
    const direct = stored || (toSlug ? (() => { const person = this.routing().people[toSlug]; return person ? { messageId: '', rootId: '', chatId: '', chatType: 'p2p', openId: person.open_id, person: toSlug, agent: person.agent, createdAt: Date.now() } : undefined; })() : undefined);
    if (!direct) throw new Error('No Lark destination: missing in_reply_to thread or context.lark.to');
    const chatId = direct.chatId || direct.openId;
    const parent = direct.messageId || undefined;
    const text = String(message.payload?.message || '');
    const larkContext = object(ctx.lark); const format = larkContext.format;
    const buttons = Array.isArray(larkContext.buttons) ? larkContext.buttons as Button[] : [];
    let sentMessageId = '';
    if (text) {
      if (format === 'card' || (format !== 'text' && (looksStructured(text) || buttons.length))) {
        const chunks = splitMessageBytes(text, 25000);
        for (let i = 0; i < chunks.length; i++) sentMessageId = await this.ops.sendCard(chatId, buildCard(chunks[i], i === chunks.length - 1 ? buttons : [], direct.person, direct.agent, replyId || String(message.envelope?.id || '')), parent, deliveryUuid(String(message.envelope?.id || replyId), `card-${i}`));
      } else {
        const chunks = splitMessage(text, 3500);
        for (let i = 0; i < chunks.length; i++) sentMessageId = await this.ops.sendText(chatId, chunks[i], parent, deliveryUuid(String(message.envelope?.id || replyId), `text-${i}`));
      }
    }
    const attachments = message.payload?.attachments || [];
    for (let i = 0; i < attachments.length; i++) await this.ops.sendAttachment(chatId, parent, attachments[i], deliveryUuid(String(message.envelope?.id || replyId), `attachment-${i}`));
    if (parent) { await this.ops.finishReaction(parent).catch(() => {}); this.threads.updateStatus(direct.rootId, 'done'); }
    if (!stored && message.envelope?.id) {
      const initiated = { ...direct, chatId, messageId: sentMessageId, rootId: sentMessageId || message.envelope.id };
      this.threads.set(message.envelope.id, initiated);
      if (sentMessageId) this.threads.set(sentMessageId, initiated);
    }
    logEvent('outbound', `Lark reply delivered to ${direct.person}`, { from: message.envelope?.from, to: direct.person, ampMessageId: message.envelope?.id, deliveryStatus: 'delivered' });
  }
}
