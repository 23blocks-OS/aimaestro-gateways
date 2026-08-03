/**
 * Slack Gateway - Outbound Response Poller (AMP Protocol)
 *
 * Scans the AMP filesystem inbox for agent messages and posts them to Slack.
 *
 * Two kinds of message are handled:
 *
 *   Replies      the agent is answering a Slack message, and routing context
 *                comes from the payload or the thread store.
 *
 *   Initiations  the agent is starting the conversation and names a
 *                destination in `payload.context.slack.to`. The gateway
 *                resolves it to a channel, posts a new top-level message,
 *                and registers the resulting thread so the human's reply
 *                routes back to that same agent.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { App } from '@slack/bolt';
import type { GatewayConfig, AMPMessage } from './types.js';
import type { ThreadStore } from './thread-store.js';
import type { TargetResolver } from './slack-target.js';
import { TargetResolutionError } from './slack-target.js';
import { logEvent } from './api/activity-log.js';

/** Where a message should be posted. A missing thread_ts means a new conversation. */
interface Destination {
  channel: string;
  thread_ts?: string;
  /** True when the agent initiated rather than replied. */
  initiated: boolean;
}

type Outcome = 'delivered' | 'undeliverable' | 'retry';

/**
 * Extract Slack reply context from an AMP message.
 * Checks three locations in priority order:
 * 1. payload.context.slack (if the responding agent preserved it)
 * 2. threadStore via envelope.in_reply_to
 * 3. payload.context.channel_reply (alternative reply format)
 */
function extractReplyContext(
  msg: AMPMessage,
  threadStore: ThreadStore
): { channel: string; thread_ts: string } | null {
  // 1. Direct slack context in payload
  const slackCtx = (msg.payload?.context as any)?.slack;
  if (slackCtx?.channel && slackCtx?.thread_ts) {
    return { channel: slackCtx.channel, thread_ts: slackCtx.thread_ts };
  }

  // 2. Thread store lookup via in_reply_to
  if (msg.envelope?.in_reply_to) {
    const stored = threadStore.get(msg.envelope.in_reply_to);
    if (stored) {
      return { channel: stored.channel, thread_ts: stored.thread_ts };
    }
  }

  // 3. Alternative channel_reply format
  const channelReply = (msg.payload?.context as any)?.channel_reply;
  if (channelReply?.channel && channelReply?.thread_ts) {
    return { channel: channelReply.channel, thread_ts: channelReply.thread_ts };
  }

  return null;
}

/**
 * Read the destination an agent named for a new conversation.
 * Accepts `context.slack.to` (preferred) or a bare `context.slack.channel`
 * with no thread_ts, which reads naturally as "post here, new message".
 */
function extractInitiationTarget(msg: AMPMessage): string | null {
  const slackCtx = (msg.payload?.context as any)?.slack;
  if (!slackCtx) return null;

  if (typeof slackCtx.to === 'string' && slackCtx.to.trim()) {
    return slackCtx.to.trim();
  }
  if (typeof slackCtx.channel === 'string' && slackCtx.channel.trim() && !slackCtx.thread_ts) {
    return slackCtx.channel.trim();
  }
  return null;
}

/**
 * Resolve where a message goes: an existing thread, or a new conversation.
 * Returns null when the message names neither.
 */
async function resolveDestination(
  msg: AMPMessage,
  threadStore: ThreadStore,
  targetResolver: TargetResolver
): Promise<Destination | null> {
  const reply = extractReplyContext(msg, threadStore);
  if (reply) {
    return { ...reply, initiated: false };
  }

  const target = extractInitiationTarget(msg);
  if (target) {
    const resolved = await targetResolver.resolve(target);
    return { channel: resolved.channel, initiated: true };
  }

  return null;
}

/**
 * Start the outbound filesystem poller.
 * Returns a cleanup function to stop polling.
 */
export function startOutboundPoller(
  config: GatewayConfig,
  slackApp: App,
  threadStore: ThreadStore,
  targetResolver: TargetResolver
): () => void {
  let isPolling = false;
  let pollTimeoutId: NodeJS.Timeout | null = null;

  // Messages we can't route are parked here rather than retried forever.
  const undeliverableDir = path.join(path.dirname(config.amp.inboxDir), 'undeliverable');

  function debug(message: string, ...args: unknown[]): void {
    if (config.debug) {
      console.log(`[DEBUG] ${message}`, ...args);
    }
  }

  /**
   * Move an unroutable message out of the inbox.
   *
   * Without this the poller re-reads the same file on every cycle, logs on
   * every pass, and the inbox grows without bound. Parking rather than
   * deleting keeps the payload available for debugging.
   */
  function park(filePath: string, reason: string): void {
    try {
      fs.mkdirSync(undeliverableDir, { recursive: true });
      const target = path.join(undeliverableDir, path.basename(filePath));
      fs.renameSync(filePath, target);
      console.warn(`[OUTBOUND] Undeliverable (${reason}), parked at ${target}`);
    } catch (error) {
      console.error(`[OUTBOUND] Failed to park ${filePath}:`, error);
    }
  }

  async function processMessageFile(filePath: string): Promise<Outcome> {
    let msg: AMPMessage;

    try {
      msg = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as AMPMessage;
    } catch (error) {
      park(filePath, 'unparseable JSON');
      logEvent('error', 'Unparseable outbound message parked', {
        error: (error as Error).message,
      });
      return 'undeliverable';
    }

    const displayName = msg.envelope?.from?.split('@')[0] || 'Agent';

    let destination: Destination | null;
    try {
      destination = await resolveDestination(msg, threadStore, targetResolver);
    } catch (error) {
      if (error instanceof TargetResolutionError) {
        park(filePath, error.message);
        logEvent('error', `Slack target could not be resolved: ${error.message}`, {
          from: displayName,
          subject: msg.envelope?.subject || '',
          ampMessageId: msg.envelope?.id,
        });
        return 'undeliverable';
      }
      // Transient (network, rate limit) — leave the file and try again later.
      console.error(`[OUTBOUND] Target resolution failed, will retry:`, error);
      return 'retry';
    }

    if (!destination) {
      park(filePath, 'no reply context and no context.slack.to');
      logEvent('error', 'Outbound message had no Slack destination', {
        from: displayName,
        subject: msg.envelope?.subject || '',
        ampMessageId: msg.envelope?.id,
      });
      return 'undeliverable';
    }

    try {
      const responseText = msg.payload?.message || '';
      const formattedResponse = `*[${displayName}]* ${
        typeof responseText === 'string' ? responseText : JSON.stringify(responseText)
      }`;

      const posted = await slackApp.client.chat.postMessage({
        channel: destination.channel,
        thread_ts: destination.thread_ts,
        text: formattedResponse,
      });

      if (destination.initiated) {
        // Register the new thread so the human's reply routes back to this
        // agent instead of falling through to the default agent.
        const ts = posted.ts;
        if (ts && msg.envelope?.id) {
          threadStore.set(msg.envelope.id, {
            channel: destination.channel,
            thread_ts: ts,
            user: '',
            userName: displayName,
            ampMessageId: msg.envelope.id,
            createdAt: Date.now(),
            agentAddress: msg.envelope.from,
          });
        }

        console.log(`[-> Slack] ${displayName} started a conversation in ${destination.channel}`);
        logEvent('outbound', `Agent started Slack conversation: ${displayName}`, {
          from: displayName,
          subject: msg.envelope?.subject || '',
          ampMessageId: msg.envelope?.id,
          deliveryStatus: 'delivered',
        });
      } else {
        console.log(
          `[-> Slack] Response from ${displayName} sent to ${destination.channel}/${destination.thread_ts}`
        );
        logEvent('outbound', `Agent response posted to Slack: ${displayName}`, {
          from: displayName,
          subject: msg.envelope?.subject || '',
          ampMessageId: msg.envelope?.id,
          deliveryStatus: 'delivered',
        });

        // Acknowledge the message being replied to.
        await slackApp.client.reactions
          .add({
            channel: destination.channel,
            timestamp: destination.thread_ts!,
            name: 'white_check_mark',
          })
          .catch(() => {});
      }

      fs.unlinkSync(filePath);
      debug(`Deleted processed message: ${filePath}`);
      return 'delivered';
    } catch (error) {
      console.error(`[OUTBOUND] Failed to post ${filePath}:`, error);
      logEvent('error', `Failed to post outbound message`, {
        error: (error as Error).message,
      });
      return 'retry';
    }
  }

  async function scanInbox(): Promise<boolean> {
    if (isPolling) return false;
    isPolling = true;
    let foundMessages = false;

    try {
      const inboxDir = config.amp.inboxDir;

      if (!fs.existsSync(inboxDir)) {
        debug(`Inbox directory does not exist: ${inboxDir}`);
        return false;
      }

      const entries = fs.readdirSync(inboxDir, { withFileTypes: true });

      for (const entry of entries) {
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
          const outcome = await processMessageFile(filePath);
          if (outcome === 'delivered') foundMessages = true;
        }

        // Clean up empty sender directories
        try {
          const remaining = fs.readdirSync(senderDir);
          if (remaining.length === 0) {
            fs.rmdirSync(senderDir);
            debug(`Cleaned empty sender dir: ${entry.name}`);
          }
        } catch {
          // Ignore cleanup errors
        }
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
