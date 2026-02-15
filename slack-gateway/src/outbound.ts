/**
 * Slack Gateway - Outbound Response Poller (AMP Protocol)
 *
 * Scans the AMP filesystem inbox for agent responses and posts
 * them back to the originating Slack thread.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { App } from '@slack/bolt';
import type { GatewayConfig, AMPMessage, ThreadContext } from './types.js';
import type { ThreadStore } from './thread-store.js';
import { logEvent } from './api/activity-log.js';

/**
 * Extract Slack routing context from an AMP message.
 * Checks three locations in priority order:
 * 1. payload.context.slack (if the responding agent preserved it)
 * 2. threadStore via envelope.in_reply_to
 * 3. payload.context.channel_reply (alternative reply format)
 */
function extractSlackContext(
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
 * Start the outbound filesystem poller.
 * Returns a cleanup function to stop polling.
 */
export function startOutboundPoller(
  config: GatewayConfig,
  slackApp: App,
  threadStore: ThreadStore
): () => void {
  let isPolling = false;
  let pollTimeoutId: NodeJS.Timeout | null = null;

  function debug(message: string, ...args: unknown[]): void {
    if (config.debug) {
      console.log(`[DEBUG] ${message}`, ...args);
    }
  }

  async function processMessageFile(filePath: string): Promise<boolean> {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const msg = JSON.parse(raw) as AMPMessage;

      const slackContext = extractSlackContext(msg, threadStore);
      if (!slackContext) {
        console.log(`[OUTBOUND] No Slack context in ${path.basename(filePath)}, skipping`);
        return false;
      }

      const displayName = msg.envelope?.from?.split('@')[0] || 'Agent';
      const responseText = msg.payload?.message || '';
      const formattedResponse = `*[${displayName}]* ${
        typeof responseText === 'string' ? responseText : JSON.stringify(responseText)
      }`;

      await slackApp.client.chat.postMessage({
        channel: slackContext.channel,
        thread_ts: slackContext.thread_ts,
        text: formattedResponse,
      });

      console.log(
        `[-> Slack] Response from ${displayName} sent to ${slackContext.channel}/${slackContext.thread_ts}`
      );

      logEvent('outbound', `Agent response posted to Slack: ${displayName}`, {
        from: displayName,
        subject: msg.envelope?.subject || '',
        ampMessageId: msg.envelope?.id,
        deliveryStatus: 'delivered',
      });

      // Add checkmark reaction
      await slackApp.client.reactions
        .add({
          channel: slackContext.channel,
          timestamp: slackContext.thread_ts,
          name: 'white_check_mark',
        })
        .catch(() => {});

      // Delete processed message file
      fs.unlinkSync(filePath);
      debug(`Deleted processed message: ${filePath}`);

      return true;
    } catch (error) {
      console.error(`[OUTBOUND] Failed to process ${filePath}:`, error);
      logEvent('error', `Failed to process outbound message`, {
        error: (error as Error).message,
      });
      return false;
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
          const processed = await processMessageFile(filePath);
          if (processed) foundMessages = true;
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
