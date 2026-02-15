/**
 * Discord Gateway - Outbound Response Poller (AMP Protocol)
 *
 * Scans the AMP filesystem inbox for agent responses and posts
 * them back to the originating Discord channel.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Client, TextChannel } from 'discord.js';
import type { GatewayConfig, AMPMessage } from './types.js';
import type { ThreadStore } from './thread-store.js';
import { logEvent } from './api/activity-log.js';

/** Discord's max message length */
const DISCORD_MAX_LENGTH = 2000;

/**
 * Split a long message into chunks that fit within Discord's 2000-char limit.
 */
function splitMessage(text: string): string[] {
  if (text.length <= DISCORD_MAX_LENGTH) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= DISCORD_MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }

    let splitAt = remaining.lastIndexOf('\n', DISCORD_MAX_LENGTH);
    if (splitAt < DISCORD_MAX_LENGTH * 0.5) {
      splitAt = remaining.lastIndexOf(' ', DISCORD_MAX_LENGTH);
    }
    if (splitAt < DISCORD_MAX_LENGTH * 0.5) {
      splitAt = DISCORD_MAX_LENGTH;
    }

    chunks.push(remaining.substring(0, splitAt));
    remaining = remaining.substring(splitAt).trimStart();
  }

  return chunks;
}

/**
 * Extract Discord routing context from an AMP message.
 */
function extractDiscordContext(
  msg: AMPMessage,
  threadStore: ThreadStore
): { channelId: string; messageId?: string } | null {
  // 1. Direct discord context in payload
  const discordCtx = (msg.payload?.context as any)?.discord;
  if (discordCtx?.channelId) {
    return { channelId: discordCtx.channelId, messageId: discordCtx.messageId };
  }

  // 2. Thread store lookup via in_reply_to
  if (msg.envelope?.in_reply_to) {
    const stored = threadStore.get(msg.envelope.in_reply_to);
    if (stored) {
      return { channelId: stored.channelId, messageId: stored.messageId };
    }
  }

  // 3. Alternative channel_reply format
  const channelReply = (msg.payload?.context as any)?.channel_reply;
  if (channelReply?.channelId) {
    return { channelId: channelReply.channelId, messageId: channelReply.messageId };
  }

  return null;
}

/**
 * Start the outbound filesystem poller.
 */
export function startOutboundPoller(
  config: GatewayConfig,
  client: Client,
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

      const discordContext = extractDiscordContext(msg, threadStore);
      if (!discordContext) {
        console.log(`[OUTBOUND] No Discord context in ${path.basename(filePath)}, skipping`);
        return false;
      }

      const displayName = msg.envelope?.from?.split('@')[0] || 'Agent';
      const responseText = msg.payload?.message || '';
      const fullResponse = `**[${displayName}]** ${
        typeof responseText === 'string' ? responseText : JSON.stringify(responseText)
      }`;

      const channel = await client.channels.fetch(discordContext.channelId).catch(() => null);

      if (channel && channel.isTextBased()) {
        const textChannel = channel as TextChannel;
        const chunks = splitMessage(fullResponse);

        if (discordContext.messageId && chunks.length > 0) {
          try {
            const originalMessage = await textChannel.messages.fetch(discordContext.messageId).catch(() => null);
            if (originalMessage) {
              await originalMessage.reply(chunks[0]);
              for (let i = 1; i < chunks.length; i++) {
                await textChannel.send(chunks[i]);
              }
              await originalMessage.react('\u2705').catch(() => {});
            } else {
              for (const chunk of chunks) {
                await textChannel.send(chunk);
              }
            }
          } catch {
            for (const chunk of chunks) {
              await textChannel.send(chunk);
            }
          }
        } else {
          for (const chunk of chunks) {
            await textChannel.send(chunk);
          }
        }

        console.log(
          `[-> Discord] Response from ${displayName} sent to ${discordContext.channelId}`
        );

        logEvent('outbound', `Agent response posted to Discord: ${displayName}`, {
          from: displayName,
          subject: msg.envelope?.subject || '',
          ampMessageId: msg.envelope?.id,
          deliveryStatus: 'delivered',
        });
      } else {
        console.log(`[OUTBOUND] Channel ${discordContext.channelId} not found or not text-based`);
      }

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
