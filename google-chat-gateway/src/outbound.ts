/**
 * Google Chat Gateway - Outbound Response Poller (AMP Protocol)
 *
 * Scans the AMP filesystem inbox for agent messages and posts them to Google Chat.
 *
 * Two kinds of message are handled:
 *
 *   Replies      the agent is answering a Chat message. Routing comes from
 *                `payload.context.gchat` (if the agent kept it) or the thread store.
 *
 *   Initiations  the agent starts the conversation and names a destination in
 *                `payload.context.gchat.to` (a space, a user, or an email). The gateway posts a
 *                new thread and registers it so the human's reply routes back to that agent.
 *
 * Every message goes out through the SAME bot (Chat app) the conversation is with.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { BotConfig, GatewayConfig, AMPMessage } from './types.js';
import type { ThreadStore } from './thread-store.js';
import type { TargetResolver } from './target.js';
import { TargetResolutionError } from './target.js';
import type { ChatClient } from './chat-client.js';
import { logEvent } from './api/activity-log.js';
import { errLine } from './log-hygiene.js';
import { recordFailure, type RetryState } from './retry-policy.js';

/**
 * An empty sender folder is only removed after it has been quiet for this long. amp-send.sh creates the folder
 * and writes the message a moment later; removing it in between made the send fail with "No such file or directory".
 */
const EMPTY_DIR_GRACE_MS = 60_000;

/** Where a message should be posted. An empty thread means a new conversation. */
export interface Destination {
  bot: BotConfig;
  space: string;
  thread?: string;
  /** True when the agent initiated rather than replied. */
  initiated: boolean;
}

type Outcome = 'delivered' | 'undeliverable' | 'retry';

export interface BotHandle {
  bot: BotConfig;
  chat: Pick<ChatClient, 'postMessage' | 'findDirectMessage'>;
}

const localName = (address: string): string => address.split('@')[0].toLowerCase();

/**
 * Which bot starts a conversation for this agent: the one named in the message, else the app
 * dedicated to the sending agent, else the only bot, else the only shared one.
 */
export function pickBotForInitiation(bots: BotHandle[], named: string | undefined, from: string): BotHandle | null {
  if (named) return bots.find((b) => b.bot.id === named) ?? null;
  const dedicated = bots.find((b) => b.bot.agent && localName(b.bot.agent) === localName(from));
  if (dedicated) return dedicated;
  if (bots.length === 1) return bots[0];
  const shared = bots.filter((b) => !b.bot.agent);
  return shared.length === 1 ? shared[0] : null;
}

/** Reply context from the message itself, or the thread store. */
export function extractReplyContext(
  msg: AMPMessage,
  threadStore: ThreadStore
): { botId: string; space: string; thread: string } | null {
  const ctx = (msg.payload?.context as any)?.gchat;
  if (ctx?.space && typeof ctx.space === 'string' && !ctx.to) {
    return { botId: String(ctx.bot ?? ''), space: ctx.space, thread: String(ctx.thread ?? '') };
  }
  if (msg.envelope?.in_reply_to) {
    const stored = threadStore.get(msg.envelope.in_reply_to);
    if (stored) return { botId: stored.botId, space: stored.space, thread: stored.thread };
  }
  return null;
}

/** Destination an agent named for a new conversation (`context.gchat.to`). */
export function extractInitiationTarget(msg: AMPMessage): { to: string; bot?: string } | null {
  const ctx = (msg.payload?.context as any)?.gchat;
  if (!ctx) return null;
  if (typeof ctx.to === 'string' && ctx.to.trim()) {
    return { to: ctx.to.trim(), bot: typeof ctx.bot === 'string' ? ctx.bot : undefined };
  }
  return null;
}

/** The text posted: shared apps name the agent (one app, many agents); a dedicated app is the agent.
 * Standard Markdown bold: Chat apps default to standard Markdown, where a single asterisk is italic. */
export function formatOutbound(bot: BotConfig, displayName: string, body: unknown): string {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return bot.agent ? text : `**[${displayName}]** ${text}`;
}

/**
 * Start the outbound filesystem poller.
 * Returns a cleanup function to stop polling.
 */
export function startOutboundPoller(
  config: GatewayConfig,
  bots: BotHandle[],
  threadStore: ThreadStore,
  targetResolver: TargetResolver
): () => void {
  let isPolling = false;
  let pollTimeoutId: NodeJS.Timeout | null = null;

  const undeliverableDir = path.join(path.dirname(config.amp.inboxDir), 'undeliverable');
  const retryState = new Map<string, RetryState>();
  const byId = new Map(bots.map((b) => [b.bot.id, b]));

  function debug(message: string, ...args: unknown[]): void {
    if (config.debug) console.log(`[DEBUG] ${message}`, ...args);
  }

  /** Move an unroutable message out of the inbox (kept for debugging, not re-read every cycle). */
  function park(filePath: string, reason: string): void {
    try {
      fs.mkdirSync(undeliverableDir, { recursive: true });
      const target = path.join(undeliverableDir, path.basename(filePath));
      fs.renameSync(filePath, target);
      retryState.delete(filePath);
      console.warn(`[OUTBOUND] Undeliverable (${reason}), parked at ${target}`);
    } catch (error) {
      console.error(`[OUTBOUND] Failed to park ${filePath}: ${errLine(error)}`);
    }
  }

  /** Park permanent errors and stuck files, otherwise schedule a backed-off retry. One log line per transition. */
  function handleFailure(filePath: string, stage: string, error: unknown): Outcome {
    const sig = errLine(error);
    const name = path.basename(filePath);
    const decision = recordFailure(retryState.get(filePath), error, sig, Date.now(), config.polling.intervalMs);

    if (decision.action === 'park') {
      park(filePath, `${stage}: ${decision.reason}`);
      logEvent('error', `Outbound message parked after ${stage} failure`, { error: sig });
      return 'undeliverable';
    }

    retryState.set(filePath, decision.state);
    const { attempts, delayMs } = decision.state;
    if (decision.log === 'first') {
      console.error(`[OUTBOUND] ${stage} failed for ${name} (attempt ${attempts}), retrying in ${Math.round(delayMs / 1000)}s: ${sig}`);
      logEvent('error', `Failed to post outbound message`, { error: sig });
    } else if (decision.log === 'changed') {
      console.error(`[OUTBOUND] ${stage} error changed for ${name} (attempt ${attempts}), retrying in ${Math.round(delayMs / 1000)}s: ${sig}`);
    } else if (decision.log === 'backoff') {
      console.warn(`[OUTBOUND] ${name} still failing (attempt ${attempts}), next try in ${Math.round(delayMs / 1000)}s`);
    }
    return 'retry';
  }

  async function resolveDestination(msg: AMPMessage): Promise<Destination | null> {
    const reply = extractReplyContext(msg, threadStore);
    if (reply) {
      const handle = reply.botId ? byId.get(reply.botId) : bots.length === 1 ? bots[0] : undefined;
      if (!handle) throw new TargetResolutionError(`reply names bot "${reply.botId}", which is not configured`);
      return { bot: handle.bot, space: reply.space, thread: reply.thread || undefined, initiated: false };
    }

    const target = extractInitiationTarget(msg);
    if (target) {
      const handle = pickBotForInitiation(bots, target.bot, msg.envelope?.from || '');
      if (!handle) {
        throw new TargetResolutionError(
          target.bot
            ? `bot "${target.bot}" is not configured`
            : 'several bots could send this: name one in context.gchat.bot'
        );
      }
      const space = await targetResolver.resolve(handle.bot.id, handle.chat, target.to);
      return { bot: handle.bot, space, initiated: true };
    }

    return null;
  }

  async function processMessageFile(filePath: string): Promise<Outcome> {
    const pending = retryState.get(filePath);
    if (pending && Date.now() < pending.nextTryAt) return 'retry';

    let msg: AMPMessage;
    try {
      msg = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as AMPMessage;
    } catch (error) {
      park(filePath, 'unparseable JSON');
      logEvent('error', 'Unparseable outbound message parked', { error: (error as Error).message });
      return 'undeliverable';
    }

    const displayName = msg.envelope?.from?.split('@')[0] || 'Agent';

    let destination: Destination | null;
    try {
      destination = await resolveDestination(msg);
    } catch (error) {
      if (error instanceof TargetResolutionError) {
        park(filePath, error.message);
        logEvent('error', `Google Chat target could not be resolved: ${error.message}`, {
          from: displayName,
          subject: msg.envelope?.subject || '',
          ampMessageId: msg.envelope?.id,
        });
        return 'undeliverable';
      }
      return handleFailure(filePath, 'target resolution', error);
    }

    if (!destination) {
      park(filePath, 'no reply context and no context.gchat.to');
      logEvent('error', 'Outbound message had no Google Chat destination', {
        from: displayName,
        subject: msg.envelope?.subject || '',
        ampMessageId: msg.envelope?.id,
      });
      return 'undeliverable';
    }

    try {
      const handle = byId.get(destination.bot.id)!;
      const text = formatOutbound(destination.bot, displayName, msg.payload?.message ?? '');
      const posted = await handle.chat.postMessage(destination.space, text, destination.thread);

      if (destination.initiated && msg.envelope?.id) {
        threadStore.set(msg.envelope.id, {
          botId: destination.bot.id,
          space: destination.space,
          thread: posted.thread,
          user: '',
          userName: displayName,
          ampMessageId: msg.envelope.id,
          createdAt: Date.now(),
          agentAddress: msg.envelope.from,
        });
        console.log(`[-> Chat] ${displayName} started a conversation in ${destination.space} via ${destination.bot.id}`);
        logEvent('outbound', `Agent started Google Chat conversation: ${displayName}`, {
          from: displayName,
          subject: msg.envelope?.subject || '',
          ampMessageId: msg.envelope?.id,
          deliveryStatus: 'delivered',
        });
      } else {
        console.log(`[-> Chat] Response from ${displayName} sent to ${destination.space} via ${destination.bot.id}`);
        logEvent('outbound', `Agent response posted to Google Chat: ${displayName}`, {
          from: displayName,
          subject: msg.envelope?.subject || '',
          ampMessageId: msg.envelope?.id,
          deliveryStatus: 'delivered',
        });
      }

      retryState.delete(filePath);
      fs.unlinkSync(filePath);
      debug(`Deleted processed message: ${filePath}`);
      return 'delivered';
    } catch (error) {
      return handleFailure(filePath, 'post', error);
    }
  }

  async function scanInbox(): Promise<boolean> {
    if (isPolling) return false;
    isPolling = true;
    let foundMessages = false;
    const seen = new Set<string>();

    try {
      const inboxDir = config.amp.inboxDir;
      if (!fs.existsSync(inboxDir)) {
        debug(`Inbox directory does not exist: ${inboxDir}`);
        return false;
      }

      for (const entry of fs.readdirSync(inboxDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;

        const senderDir = path.join(inboxDir, entry.name);
        let files: string[];
        try {
          files = fs.readdirSync(senderDir).filter((f) => f.endsWith('.json'));
        } catch {
          continue;
        }

        for (const file of files) {
          const filePath = path.join(senderDir, file);
          seen.add(filePath);
          if ((await processMessageFile(filePath)) === 'delivered') foundMessages = true;
        }

        try {
          if (fs.readdirSync(senderDir).length === 0 && Date.now() - fs.statSync(senderDir).mtimeMs > EMPTY_DIR_GRACE_MS) {
            fs.rmdirSync(senderDir);
          }
        } catch {
          // Race with a new file: leave it.
        }
      }

      for (const known of retryState.keys()) {
        if (!seen.has(known)) retryState.delete(known);
      }
    } catch (error) {
      debug('Inbox scan error:', error);
    } finally {
      isPolling = false;
    }

    return foundMessages;
  }

  const poll = async () => {
    await scanInbox();
    pollTimeoutId = setTimeout(poll, config.polling.intervalMs);
  };

  poll();
  console.log(`[OUTBOUND] Filesystem polling started at ${config.polling.intervalMs}ms`);
  console.log(`[OUTBOUND] Inbox: ${config.amp.inboxDir}`);

  return () => {
    if (pollTimeoutId) {
      clearTimeout(pollTimeoutId);
      pollTimeoutId = null;
    }
    console.log('[OUTBOUND] Poller stopped');
  };
}
