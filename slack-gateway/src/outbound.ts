/**
 * Slack Gateway - Outbound Response Poller
 *
 * Polls the gateway's AI Maestro inbox for agent responses and posts
 * them back to the originating Slack thread.
 */

import type { App } from '@slack/bolt';
import type { GatewayConfig, AIMessage, AIMessagesResponse } from './types.js';
import type { AgentResolver } from './agent-resolver.js';
import { logEvent } from './api/activity-log.js';

/**
 * Start the outbound response polling loop.
 * Returns a cleanup function to stop polling.
 */
export function startOutboundPoller(
  config: GatewayConfig,
  slackApp: App,
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
      const slackContext = msg.content?.slack;
      const responseText = msg.content?.message || msg.content;

      if (slackContext?.channel && slackContext?.thread_ts) {
        // Get display name (from cache or lookup)
        let agentDisplayName = msg.fromAlias || fromAgent;

        const agentLookup = await resolver.lookupAgent(msg.fromAlias || fromAgent);
        if (agentLookup?.displayName) {
          agentDisplayName = agentLookup.displayName;
        }

        const formattedResponse = `*[${agentDisplayName}]* ${
          typeof responseText === 'string' ? responseText : JSON.stringify(responseText)
        }`;

        // Send response to Slack
        await slackApp.client.chat.postMessage({
          channel: slackContext.channel,
          thread_ts: slackContext.thread_ts,
          text: formattedResponse,
        });

        console.log(
          `[-> Slack] Response from ${agentDisplayName} sent to ${slackContext.channel}/${slackContext.thread_ts}`
        );

        logEvent('outbound', `Agent response posted to Slack: ${agentDisplayName}`, {
          from: agentDisplayName,
          subject: msgSummary.subject,
        });

        // Add checkmark reaction
        await slackApp.client.reactions
          .add({
            channel: slackContext.channel,
            timestamp: slackContext.thread_ts,
            name: 'white_check_mark',
          })
          .catch(() => {}); // Ignore if reaction already exists
      } else {
        console.log(`[<- ${fromAgent}] Message has no Slack context, skipping: ${msg.subject}`);
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
