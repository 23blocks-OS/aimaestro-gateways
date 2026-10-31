import fs from 'node:fs';
import path from 'node:path';
import type { GatewayConfig, NormalizedMessage, RoutingConfig, ThreadContext } from './types.js';
import { DedupeStore } from './dedupe.js';
import { ThreadStore } from './thread-store.js';
import { normalizeMessage } from './normalize.js';
import { agentAddress, parseAgentTag, resolveSender } from './routing.js';
import { sanitizeMessage } from './content-security.js';
import { logEvent } from './api/activity-log.js';

type Dict = Record<string, unknown>;
export interface LarkOps {
  download(messageId: string, key: string, type: string): Promise<{ name: string; contentType: string; bytes: Buffer }>;
  parentText(messageId: string): Promise<string | null>;
  reply(chatId: string, text: string, parentId?: string): Promise<void>;
  react(messageId: string, emoji: string): Promise<void>;
  forwardedMessages?(messageId: string): Promise<Array<{ content: string; sender?: { sender_name?: string } }>>;
}
export interface InboundEvent { event_id?: string; schema?: string; header?: Dict; event?: Dict }

function obj(value: unknown): Dict { return value && typeof value === 'object' ? value as Dict : {}; }
function str(value: unknown): string { return typeof value === 'string' ? value : ''; }
function pickEvent(raw: InboundEvent): Dict { return Object.keys(obj(raw.event)).length ? obj(raw.event) : raw as Dict; }

export class InboundProcessor {
  private busy = false;
  private timer: NodeJS.Timeout | null = null;
  private queueDir: string;
  constructor(private config: GatewayConfig, private getRouting: () => RoutingConfig, private dedupe: DedupeStore, private threads: ThreadStore, private ops: LarkOps) {
    this.queueDir = path.join(config.stateDir, 'inbound-queue'); fs.mkdirSync(this.queueDir, { recursive: true });
  }

  /** Durable enqueue is the only work performed in the SDK callback, so it can acknowledge promptly. */
  enqueue(raw: InboundEvent): void {
    const event = pickEvent(raw); const message = obj(event.message); const header = obj(raw.header);
    const eventId = str(header.event_id) || str(raw.event_id) || str(event.event_id); const messageId = str(message.message_id);
    if (!messageId || this.dedupe.has(eventId, messageId)) return;
    const file = path.join(this.queueDir, `${messageId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
    const tmp = `${file}.tmp`;
    if (!fs.existsSync(file)) { fs.writeFileSync(tmp, JSON.stringify(raw), { mode: 0o600 }); fs.renameSync(tmp, file); }
    this.dedupe.mark(eventId, messageId);
    this.kick();
  }

  start(): void { this.kick(); this.timer = setInterval(() => this.kick(), 1000); }
  stop(): void { if (this.timer) clearInterval(this.timer); this.threads.save(); }
  private kick(): void { if (!this.busy) void this.drain(); }

  private async drain(): Promise<void> {
    this.busy = true;
    try {
      const files = fs.readdirSync(this.queueDir).filter((n) => n.endsWith('.json')).sort();
      for (const name of files) {
        const file = path.join(this.queueDir, name);
        try {
          const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as InboundEvent;
          await this.process(raw);
          fs.unlinkSync(file);
        } catch (error) {
          console.error(`[INBOUND] Retry queued message ${name}: ${(error as Error).message}`);
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
    } finally { this.busy = false; }
  }

  private async process(raw: InboundEvent): Promise<void> {
    const event = pickEvent(raw); const message = obj(event.message); const sender = obj(event.sender); const senderId = obj(sender.sender_id);
    const id = str(message.message_id); const chatId = str(message.chat_id); const chatType = str(message.chat_type); const messageType = str(message.message_type);
    const openId = str(senderId.open_id); const mentionRows = Array.isArray(message.mentions) ? message.mentions.map((m) => obj(m)) : [];
    const mentions = mentionRows.flatMap((m) => [str(m.key), m.mentioned_type === 'bot' || m.mentioned_type === 'app' ? (str(m.name) ? `@${str(m.name)}` : '') : '']).filter(Boolean);
    if (!id || !openId || str(sender.sender_type) === 'app') return;
    if (this.dedupe.hasRouted(id)) return;
    const content = str(message.content);
    let normalizedContent = content;
    if (messageType === 'merge_forward' && this.ops.forwardedMessages) {
      try {
        const parsed = JSON.parse(content || '{}') as { message_id?: string };
        if (parsed.message_id) {
          const messages = await this.ops.forwardedMessages(parsed.message_id);
          normalizedContent = JSON.stringify({ messages });
        }
      } catch { /* keep the captured forwarding envelope as a fallback */ }
    }
    const normalized = normalizeMessage(messageType, normalizedContent, mentions);
    if (normalized.ignored) return;
    const mentionedBot = mentionRows.some((m) => m.mentioned_type === 'bot' || m.mentioned_type === 'app');
    const route = resolveSender(openId, this.getRouting(), chatType, mentionedBot);
    if (route.kind === 'ignore') return;
    if (route.reply) { await this.ops.reply(chatId, route.reply, id); logEvent('inbound', `Lark ${route.kind} sender response`, { subject: messageType }); return; }
    if (!route.agent || !route.person) return;

    // Fetch reply parent content when available, but failure does not block the message.
    const parentId = str(message.parent_id) || null;
    let parentText: string | null = null;
    if (parentId) { try { parentText = await this.ops.parentText(parentId); } catch { parentText = null; } }
    const messageData = await this.downloadAttachments(chatId, id, normalized);
    if (messageData === null) return;
    const tagged = parseAgentTag(normalized.text);
    const sticky = parentId ? this.threads.get(parentId) : undefined;
    const target = route.admin && tagged.agent ? tagged.agent : sticky?.agent || route.agent;
    const forwarded = messageType === 'merge_forward';
    const trust = target === route.agent ? 'operator' : 'external';
    const security = sanitizeMessage(tagged.text, route.person, trust, forwarded);
    const now = new Date().toISOString();
    const larkRootId = str(message.root_id) || null;
    const rootId = larkRootId || parentId || id;
    const ampPayload = {
      to: agentAddress(target, this.config.amp.tenant), subject: `Lark message from ${route.person}`, priority: 'normal',
      payload: { type: 'request', message: security.sanitized, attachments: messageData, context: {
        channel: { type: 'lark', bridge_agent: this.config.amp.agentAddress, sender: route.person, sender_id: route.person, thread_id: rootId, received_at: now },
        lark: { app: 'agent', chat_id: chatId, chat_type: chatType, message_id: id, root_id: larkRootId, parent_id: parentId, person: route.person, parent_text: parentText, card_action: null },
        security: { trust: security.trust.level, injection_flags: security.flags.map((f) => f.category), wrapped: security.wrapped, source: 'lark', scanned: true },
      } },
    };
    const response = await fetch(`${this.config.amp.maestroUrl}/api/v1/route`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${this.config.amp.apiKey}` }, body: JSON.stringify(ampPayload), signal: AbortSignal.timeout(this.config.timeoutMs) });
    if (!response.ok) throw new Error(`AMP route failed (${response.status})`);
    const result = await response.json() as { id?: string };
    const ctx: ThreadContext = { messageId: id, rootId, chatId, chatType, openId, person: route.person, agent: target, createdAt: Date.now(), status: 'working' };
    this.threads.set(id, ctx); if (result.id) this.threads.set(result.id, ctx);
    this.dedupe.markRouted(id);
    await this.ops.react(id, 'THUMBSUP').catch(() => {});
    const progressTimer = setTimeout(() => {
      const current = this.threads.findByRoot(rootId);
      if (current?.status === 'working') void this.ops.reply(chatId, 'Still working on it.', id).catch(() => {});
    }, this.config.workingDelayMs);
    progressTimer.unref();
    logEvent('inbound', `Lark message routed: ${route.person} -> ${target}`, { from: route.person, to: target, subject: normalized.text.slice(0, 80), ampMessageId: result.id, deliveryStatus: 'queued' });
  }

  private async downloadAttachments(chatId: string, messageId: string, message: NormalizedMessage): Promise<Array<{ name: string; content_type: string; content: string; size: number }> | null> {
    if (message.attachments.length > 10) { await this.ops.reply(chatId, 'This message has more than the 10 attachment limit. Please send fewer files.', messageId); return null; }
    const result = [];
    for (const item of message.attachments) {
      const downloaded = await this.ops.download(messageId, item.key, item.type);
      if (downloaded.bytes.length > 25 * 1024 * 1024) { await this.ops.reply(chatId, `Attachment ${downloaded.name} is larger than the 25 MB limit. Please send a smaller file.`, messageId); return null; }
      result.push({ name: downloaded.name || item.name, content_type: downloaded.contentType || 'application/octet-stream', content: downloaded.bytes.toString('base64'), size: downloaded.bytes.length });
    }
    return result;
  }
}
