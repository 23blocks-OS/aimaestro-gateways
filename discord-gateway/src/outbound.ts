/**
 * Discord Gateway - Outbound Response Poller
 *
 * Polls the gateway's AI Maestro inbox for agent responses and posts
 * them back to the originating Discord channel.
 */

import type { Client, TextChannel } from 'discord.js';
import type { GatewayConfig, AIMessage, AIMessagesResponse } from './types.js';
import type { AgentResolver } from './agent-resolver.js';
import { logEvent } from './api/activity-log.js';

/** Discord's max message length */
const DISCORD_MAX_LENGTH = 2000;

/**
 * Split a long message into chunks that fit within Discord's 2000-char limit.
 * Splits on newlines when possible, otherwise hard-splits.
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

    // Try to split at a newline near the limit
    let splitAt = remaining.lastIndexOf('\n', DISCORD_MAX_LENGTH);
    if (splitAt < DISCORD_MAX_LENGTH * 0.5) {
      // Newline too far back, try space
      splitAt = remaining.lastIndexOf(' ', DISCORD_MAX_LENGTH);
    }
    if (splitAt < DISCORD_MAX_LENGTH * 0.5) {
      // No good break point, hard split
      splitAt = DISCORD_MAX_LENGTH;
    }

    chunks.push(remaining.substring(0, splitAt));
    remaining = remaining.substring(splitAt).trimStart();
  }

  return chunks;
}

/**
 * Start the outbound response polling loop.
 * Returns a cleanup function to stop polling.
 */
export function startOutboundPoller(
  config: GatewayConfig,
  client: Client,
  resolver: AgentResolver
): () => void {
  let isPolling = false;
  let pollTimeoutId: NodeJS.Timeout | null = null;
  let currentIntervalMs = config.polling.intervalMs;
  const MAX_INTERVAL_MS = 30000;
  const BACKOFF_MULTIPLIER = 1.5;

  function debug(message: string, ...args: unknown[]): void {
    if (config.debug) {
      console.log(`[DEBUG] ${message}`, ...args);
    }
  }

  async function processIncomingMessage(msgSummary: AIMessage): Promise<void> {
    const fromAgent = msgSummary.from || msgSummary.fromAlias || 'unknown';
    console.log(`[<- ${fromAgent}] Response received: ${msgSummary.subject}`);

    try {
      // Fetch full message to get content
      const fullMsgResponse = await fetch(
        `${config.aimaestro.apiUrl}/api/messages?agent=${config.aimaestro.botAgent}&id=${msgSummary.id}&box=inbox`,
        { signal: AbortSignal.timeout(config.polling.timeoutMs) }
      );

      if (!fullMsgResponse.ok) return;

      const msg = (await fullMsgResponse.json()) as AIMessage;
      const discordContext = msg.content?.discord;
      const responseText = msg.content?.message || msg.content;

      if (discordContext?.channelId) {
        // Get display name (from cache or lookup)
        let agentDisplayName = msg.fromAlias || fromAgent;

        const agentLookup = await resolver.lookupAgent(msg.fromAlias || fromAgent);
        if (agentLookup?.displayName) {
          agentDisplayName = agentLookup.displayName;
        }

        const fullResponse = `**[${agentDisplayName}]** ${
          typeof responseText === 'string' ? responseText : JSON.stringify(responseText)
        }`;

        // Get the channel and send the response
        const channel = await client.channels.fetch(discordContext.channelId).catch(() => null);

        if (channel && channel.isTextBased()) {
          const textChannel = channel as TextChannel;
          const chunks = splitMessage(fullResponse);

          // Try to reply to the original message if we have the messageId
          if (discordContext.messageId && chunks.length > 0) {
            try {
              const originalMessage = await textChannel.messages.fetch(discordContext.messageId).catch(() => null);
              if (originalMessage) {
                await originalMessage.reply(chunks[0]);
                // Send remaining chunks as follow-up messages
                for (let i = 1; i < chunks.length; i++) {
                  await textChannel.send(chunks[i]);
                }
                // Add checkmark reaction
                await originalMessage.react('\u2705').catch(() => {});
              } else {
                // Original message not found, send as regular messages
                for (const chunk of chunks) {
                  await textChannel.send(chunk);
                }
              }
            } catch {
              // Fallback: send as regular messages
              for (const chunk of chunks) {
                await textChannel.send(chunk);
              }
            }
          } else {
            // No messageId, send as regular messages
            for (const chunk of chunks) {
              await textChannel.send(chunk);
            }
          }

          console.log(
            `[-> Discord] Response from ${agentDisplayName} sent to ${discordContext.channelId}`
          );

          logEvent('outbound', `Agent response posted to Discord: ${agentDisplayName}`, {
            from: agentDisplayName,
            subject: msgSummary.subject,
          });
        } else {
          console.log(`[<- ${fromAgent}] Channel ${discordContext.channelId} not found or not text-based`);
        }
      } else {
        console.log(`[<- ${fromAgent}] Message has no Discord context, skipping: ${msg.subject}`);
      }

      // Mark message as read
      await fetch(
        `${config.aimaestro.apiUrl}/api/messages?agent=${config.aimaestro.botAgent}&id=${msg.id}&action=read`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(config.polling.timeoutMs),
        }
      ).catch((err) => debug('Failed to mark as read:', err));
    } catch (error) {
      console.error('Failed to process message:', error);
      logEvent('error', `Failed to process response from ${fromAgent}`, {
        from: fromAgent,
        error: (error as Error).message,
      });
    }
  }

  async function checkAgentResponses(): Promise<boolean> {
    if (isPolling) {
      debug('Polling already in progress, skipping...');
      return false;
    }

    isPolling = true;
    let foundMessages = false;

    try {
      const response = await fetch(
        `${config.aimaestro.apiUrl}/api/messages?agent=${config.aimaestro.botAgent}&box=inbox&status=unread`,
        { signal: AbortSignal.timeout(config.polling.timeoutMs) }
      );

      if (!response.ok) return false;

      const data = (await response.json()) as AIMessagesResponse;
      const messages = data.messages || [];
      foundMessages = messages.length > 0;

      const BATCH_SIZE = 5;
      for (let i = 0; i < messages.length; i += BATCH_SIZE) {
        const batch = messages.slice(i, i + BATCH_SIZE);
        await Promise.allSettled(batch.map(msg => processIncomingMessage(msg)));
      }
    } catch (error) {
      debug('Poll error:', error);
    } finally {
      isPolling = false;
    }

    return foundMessages;
  }

  const poll = async () => {
    const foundMessages = await checkAgentResponses();

    if (foundMessages) {
      // Reset to base interval when messages are found
      currentIntervalMs = config.polling.intervalMs;
      debug(`Poll interval reset to ${currentIntervalMs}ms (messages found)`);
    } else {
      // Increase interval with backoff when idle
      const previousInterval = currentIntervalMs;
      currentIntervalMs = Math.min(
        Math.round(currentIntervalMs * BACKOFF_MULTIPLIER),
        MAX_INTERVAL_MS
      );
      if (currentIntervalMs !== previousInterval) {
        debug(`Poll interval increased to ${currentIntervalMs}ms (idle backoff)`);
      }
    }

    pollTimeoutId = setTimeout(poll, currentIntervalMs);
  };

  poll();
  console.log(`[OUTBOUND] Polling starting at ${config.polling.intervalMs}ms (backoff up to ${MAX_INTERVAL_MS}ms)...`);

  return () => {
    if (pollTimeoutId) {
      clearTimeout(pollTimeoutId);
      pollTimeoutId = null;
    }
    console.log('[OUTBOUND] Poller stopped');
  };
}
