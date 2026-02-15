/**
 * Slack Gateway - Inbound Message Handlers (AMP Protocol)
 *
 * Registers Slack event handlers (app_mention, DM, channel join) and
 * routes messages to agents via AMP POST /api/v1/route.
 */

import type { App } from '@slack/bolt';
import type { GatewayConfig, AMPRouteRequest } from './types.js';
import type { AgentResolver } from './agent-resolver.js';
import type { ThreadStore } from './thread-store.js';
import { sanitizeSlackMessage, type SecurityConfig } from './content-security.js';
import { logEvent } from './api/activity-log.js';

/**
 * Parse @AIM:agent-name routing from message text.
 * Allows full AMP addresses like @AIM:agent@tenant.domain
 */
function parseAgentRouting(
  text: string,
  defaultAgent: string
): { agent: string; message: string } {
  const match = text.match(/@AIM:([a-zA-Z0-9_@.\-]+)/i);

  if (match) {
    const message = text
      .replace(match[0], '')
      .replace(/\s+/g, ' ')
      .replace(/^[,.\s]+/, '')
      .trim();

    return {
      agent: match[1],
      message: message || '(no message)',
    };
  }

  return {
    agent: defaultAgent,
    message: text,
  };
}

/**
 * Send a message to an agent via AMP route API.
 */
async function sendToAgent(
  config: GatewayConfig,
  targetAddress: string,
  text: string,
  channel: string,
  thread_ts: string,
  userName: string,
  slackUserId: string,
  securityConfig: SecurityConfig,
  threadStore: ThreadStore
): Promise<void> {
  const { sanitized, trust, flags } = sanitizeSlackMessage(
    text,
    slackUserId,
    userName,
    securityConfig
  );

  if (flags.length > 0) {
    console.log(
      `[SECURITY] ${flags.length} injection pattern(s) flagged from ${userName} (trust: ${trust.level})`
    );
    logEvent('security', `Injection patterns flagged from ${userName}`, {
      from: userName,
      to: targetAddress,
      subject: text.substring(0, 80),
      securityFlags: flags.map((f) => `${f.category}: ${f.match}`),
    });
  }

  const ampRequest: AMPRouteRequest = {
    to: targetAddress,
    subject: `Slack message from ${userName}`,
    priority: 'normal',
    payload: {
      type: 'request',
      message: sanitized,
      context: {
        channel: {
          type: 'slack',
          sender: userName,
          sender_id: slackUserId,
          thread_id: channel,
          bridge_agent: config.amp.agentAddress,
          received_at: new Date().toISOString(),
        },
        slack: { channel, thread_ts, user: userName },
        security: {
          trust: trust.level,
          source: 'slack',
          scanned: true,
          injection_flags: flags.map((f) => f.category),
          wrapped: trust.level !== 'operator',
          scanned_at: new Date().toISOString(),
        },
      },
    },
  };

  const response = await fetch(`${config.amp.maestroUrl}/api/v1/route`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.amp.apiKey}`,
    },
    body: JSON.stringify(ampRequest),
    signal: AbortSignal.timeout(config.polling.timeoutMs),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    if (response.status === 404) {
      throw new Error(`agent_not_found: ${targetAddress}`);
    }
    if (response.status === 429) {
      throw new Error(`rate_limited: ${targetAddress}`);
    }
    throw new Error(`AMP route failed (${response.status}): ${errorBody}`);
  }

  const result = await response.json();

  // Store thread context for reply routing
  if (result.id) {
    threadStore.set(result.id, {
      channel,
      thread_ts,
      user: slackUserId,
      userName,
      ampMessageId: result.id,
      createdAt: Date.now(),
    });
  }

  const displayName = targetAddress.split('@')[0];
  console.log(
    `[-> ${targetAddress}] Message from ${userName} (trust: ${trust.level}): ${text.substring(0, 50)}...`
  );

  logEvent('inbound', `Slack message routed: ${userName} -> ${displayName}`, {
    from: userName,
    to: targetAddress,
    subject: text.substring(0, 80),
    ampMessageId: result.id,
    deliveryStatus: result.status,
  });
}

/**
 * Route a Slack message to the appropriate agent via AMP.
 */
async function routeMessage(
  config: GatewayConfig,
  resolver: AgentResolver,
  securityConfig: SecurityConfig,
  threadStore: ThreadStore,
  text: string,
  channel: string,
  thread_ts: string,
  userId: string,
  say: (msg: { text: string; thread_ts: string }) => Promise<unknown>
): Promise<void> {
  const { agent, message } = parseAgentRouting(text, config.amp.defaultAgent);
  const userName = await resolver.getUserDisplayName(userId);
  const { address } = resolver.lookupAgent(agent);

  try {
    await sendToAgent(
      config,
      address,
      message,
      channel,
      thread_ts,
      userName,
      userId,
      securityConfig,
      threadStore
    );
  } catch (error) {
    const errMsg = (error as Error).message;

    if (errMsg.startsWith('agent_not_found:')) {
      await say({
        text: `Agent \`${agent}\` not found.\n\nUse \`@AIM:agent-name message\` to route to a specific agent.`,
        thread_ts,
      });
      logEvent('error', `Agent not found: ${agent}`, { from: userName, to: agent });
      return;
    }

    if (errMsg.startsWith('rate_limited:')) {
      await say({
        text: `Agent \`${agent}\` is rate limited. Please try again in a moment.`,
        thread_ts,
      });
      return;
    }

    throw error;
  }
}

/**
 * Register all inbound Slack event handlers.
 */
export function registerInboundHandlers(
  app: App,
  config: GatewayConfig,
  resolver: AgentResolver,
  securityConfig: SecurityConfig,
  threadStore: ThreadStore
): void {
  // Handle @mentions in channels
  app.event('app_mention', async ({ event, say }) => {
    const text = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();
    const channel = event.channel;
    const user = event.user || 'unknown';
    const thread_ts = event.thread_ts || event.ts;

    console.log(`[Slack <-] Mention from ${user}: ${text.substring(0, 50)}...`);

    try {
      await app.client.reactions
        .add({
          channel: channel,
          timestamp: event.ts,
          name: 'eyes',
        })
        .catch(() => {});

      await routeMessage(config, resolver, securityConfig, threadStore, text, channel, thread_ts, user, say);
    } catch (error) {
      console.error('Error routing message:', error);
      await say({ text: 'Failed to route message. Please try again.', thread_ts });
    }
  });

  // Handle direct messages
  app.event('message', async ({ event, say }) => {
    const messageEvent = event as {
      channel_type?: string;
      bot_id?: string;
      text?: string;
      channel: string;
      user?: string;
      thread_ts?: string;
      ts: string;
    };

    if (messageEvent.channel_type !== 'im') return;
    if (messageEvent.bot_id) return;

    const text = messageEvent.text || '';
    const channel = messageEvent.channel;
    const user = messageEvent.user || 'unknown';
    const thread_ts = messageEvent.thread_ts || messageEvent.ts;

    console.log(`[Slack <-] DM from ${user}: ${text.substring(0, 50)}...`);

    try {
      await app.client.reactions
        .add({
          channel: channel,
          timestamp: messageEvent.ts,
          name: 'eyes',
        })
        .catch(() => {});

      await routeMessage(config, resolver, securityConfig, threadStore, text, channel, thread_ts, user, say);
    } catch (error) {
      console.error('Error routing message:', error);
      await say({ text: 'Failed to route message. Please try again.', thread_ts });
    }
  });

  // Handle bot joining a channel
  app.event('member_joined_channel', async ({ event }) => {
    try {
      const authResult = await app.client.auth.test();
      if (event.user === authResult.user_id) {
        console.log(`[Slack] Joined channel ${event.channel}`);

        await app.client.chat.postMessage({
          channel: event.channel,
          text:
            `Hi! I'm the AI Maestro gateway. Message me to reach agents on the network.\n\n` +
            `- DM or @mention me to talk to the default agent\n` +
            `- Use \`@AIM:agent-name\` to route to a specific agent`,
        });
      }
    } catch (error) {
      if (config.debug) {
        console.log('Error handling channel join:', error);
      }
    }
  });
}
