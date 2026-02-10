/**
 * Slack Gateway - Inbound Message Handlers
 *
 * Registers Slack event handlers (app_mention, DM, channel join) and
 * routes messages to AI Maestro agents via content security scanning.
 */

import type { App } from '@slack/bolt';
import type { GatewayConfig } from './types.js';
import type { AgentResolver } from './agent-resolver.js';
import { sanitizeSlackMessage, type SecurityConfig } from './content-security.js';
import { logEvent } from './api/activity-log.js';

/**
 * Parse @AIM:agent-name routing from message text.
 */
function parseAgentRouting(
  text: string,
  defaultAgent: string
): { agent: string; message: string } {
  const match = text.match(/@AIM:([a-zA-Z0-9_-]+)/i);

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
 * Send a message to an AI Maestro agent.
 */
async function sendToAgent(
  config: GatewayConfig,
  targetAgent: string,
  targetHost: string,
  text: string,
  channel: string,
  thread_ts: string,
  user: string,
  slackUserId: string,
  securityConfig: SecurityConfig
): Promise<void> {
  const { sanitized, trust, flags } = sanitizeSlackMessage(
    text,
    slackUserId,
    user,
    securityConfig
  );

  if (flags.length > 0) {
    console.log(
      `[SECURITY] ${flags.length} injection pattern(s) flagged from ${user} (trust: ${trust.level})`
    );
    logEvent('security', `Injection patterns flagged from ${user}`, {
      from: user,
      to: targetAgent,
      subject: text.substring(0, 80),
      securityFlags: flags.map((f) => `${f.category}: ${f.match}`),
    });
  }

  const payload = {
    from: config.aimaestro.botAgent,
    fromHost: config.aimaestro.hostId,
    to: targetAgent,
    toHost: targetHost,
    subject: `Slack: Message from ${user}`,
    priority: 'normal',
    content: {
      type: 'request',
      message: sanitized,
      slack: {
        channel,
        thread_ts,
        user,
      },
      security: {
        trust: trust.level,
        trustReason: trust.reason,
        injectionFlags: flags.length > 0 ? flags : undefined,
      },
    },
  };

  const response = await fetch(`${config.aimaestro.apiUrl}/api/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(config.polling.timeoutMs),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to send to ${targetAgent}: ${error}`);
  }

  console.log(
    `[-> ${targetAgent}@${targetHost}] Message from ${user} (trust: ${trust.level}): ${text.substring(0, 50)}...`
  );

  logEvent('inbound', `Slack message routed: ${user} -> ${targetAgent}`, {
    from: user,
    to: targetAgent,
    subject: text.substring(0, 80),
  });
}

/**
 * Route a Slack message to the appropriate AI Maestro agent.
 */
async function routeMessage(
  config: GatewayConfig,
  resolver: AgentResolver,
  securityConfig: SecurityConfig,
  text: string,
  channel: string,
  thread_ts: string,
  userId: string,
  say: (msg: { text: string; thread_ts: string }) => Promise<unknown>
): Promise<void> {
  const { agent, message } = parseAgentRouting(text, config.aimaestro.defaultAgent);
  const userName = await resolver.getUserDisplayName(userId);
  const result = await resolver.lookupAgentSmart(agent);

  if (result.status === 'not_found') {
    await say({
      text: `Agent \`${agent}\` not found on any host.\n\nUse \`@AIM:agent-name message\` to route to a specific agent.`,
      thread_ts,
    });
    logEvent('error', `Agent not found: ${agent}`, { from: userName, to: agent });
    return;
  }

  if (result.status === 'multiple') {
    const matchList = result.matches.map((m) => `- \`${m.alias}@${m.hostId}\``).join('\n');
    await say({
      text: `Found multiple matches for \`${agent}\`:\n\n${matchList}\n\nPlease specify the full agent name, e.g.:\n\`@AIM:${result.matches[0].alias}@${result.matches[0].hostId} your message\``,
      thread_ts,
    });
    return;
  }

  // Found exactly one match
  if (result.fuzzy) {
    await say({
      text: `Found partial match: \`${result.name}@${result.host}\``,
      thread_ts,
    });
  }

  await sendToAgent(
    config,
    result.name,
    result.host,
    message,
    channel,
    thread_ts,
    userName,
    userId,
    securityConfig
  );
}

/**
 * Register all inbound Slack event handlers.
 */
export function registerInboundHandlers(
  app: App,
  config: GatewayConfig,
  resolver: AgentResolver,
  securityConfig: SecurityConfig
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

      await routeMessage(config, resolver, securityConfig, text, channel, thread_ts, user, say);
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

      await routeMessage(config, resolver, securityConfig, text, channel, thread_ts, user, say);
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
