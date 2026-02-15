/**
 * Discord Gateway - Inbound Message Handlers (AMP Protocol)
 *
 * Registers Discord event handlers (messageCreate) and routes messages
 * to agents via AMP POST /api/v1/route.
 */

import type { Client, Message, TextChannel } from 'discord.js';
import type { GatewayConfig, AMPRouteRequest } from './types.js';
import type { AgentResolver } from './agent-resolver.js';
import type { ThreadStore } from './thread-store.js';
import { sanitizeDiscordMessage, type SecurityConfig } from './content-security.js';
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
 * Remove bot mention from message text.
 */
function stripBotMention(text: string, botId: string): string {
  return text.replace(new RegExp(`<@!?${botId}>`, 'g'), '').trim();
}

/**
 * Send a message to an agent via AMP route API.
 */
async function sendToAgent(
  config: GatewayConfig,
  targetAddress: string,
  text: string,
  channelId: string,
  messageId: string,
  displayName: string,
  discordUserId: string,
  securityConfig: SecurityConfig,
  threadStore: ThreadStore
): Promise<void> {
  const { sanitized, trust, flags } = sanitizeDiscordMessage(
    text,
    discordUserId,
    displayName,
    securityConfig
  );

  if (flags.length > 0) {
    console.log(
      `[SECURITY] ${flags.length} injection pattern(s) flagged from ${displayName} (trust: ${trust.level})`
    );
    logEvent('security', `Injection patterns flagged from ${displayName}`, {
      from: displayName,
      to: targetAddress,
      subject: text.substring(0, 80),
      securityFlags: flags.map((f) => `${f.category}: ${f.match}`),
    });
  }

  const ampRequest: AMPRouteRequest = {
    to: targetAddress,
    subject: `Discord message from ${displayName}`,
    priority: 'normal',
    payload: {
      type: 'request',
      message: sanitized,
      context: {
        channel: {
          type: 'discord',
          sender: displayName,
          sender_id: discordUserId,
          thread_id: channelId,
          bridge_agent: config.amp.agentAddress,
          received_at: new Date().toISOString(),
        },
        discord: { channelId, messageId, user: displayName },
        security: {
          trust: trust.level,
          source: 'discord',
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

  if (result.id) {
    threadStore.set(result.id, {
      channelId,
      messageId,
      user: discordUserId,
      userName: displayName,
      ampMessageId: result.id,
      createdAt: Date.now(),
    });
  }

  const agentName = targetAddress.split('@')[0];
  console.log(
    `[-> ${targetAddress}] Message from ${displayName} (trust: ${trust.level}): ${text.substring(0, 50)}...`
  );

  logEvent('inbound', `Discord message routed: ${displayName} -> ${agentName}`, {
    from: displayName,
    to: targetAddress,
    subject: text.substring(0, 80),
    ampMessageId: result.id,
    deliveryStatus: result.status,
  });
}

/**
 * Route a Discord message to the appropriate agent via AMP.
 */
async function routeMessage(
  config: GatewayConfig,
  resolver: AgentResolver,
  securityConfig: SecurityConfig,
  threadStore: ThreadStore,
  text: string,
  channelId: string,
  messageId: string,
  displayName: string,
  discordUserId: string,
  reply: (text: string) => Promise<void>
): Promise<void> {
  const { agent, message } = parseAgentRouting(text, config.amp.defaultAgent);
  const { address } = resolver.lookupAgent(agent);

  try {
    await sendToAgent(
      config,
      address,
      message,
      channelId,
      messageId,
      displayName,
      discordUserId,
      securityConfig,
      threadStore
    );
  } catch (error) {
    const errMsg = (error as Error).message;

    if (errMsg.startsWith('agent_not_found:')) {
      await reply(
        `Agent \`${agent}\` not found.\n\nUse \`@AIM:agent-name message\` to route to a specific agent.`
      );
      logEvent('error', `Agent not found: ${agent}`, { from: displayName, to: agent });
      return;
    }

    if (errMsg.startsWith('rate_limited:')) {
      await reply(`Agent \`${agent}\` is rate limited. Please try again in a moment.`);
      return;
    }

    throw error;
  }
}

/**
 * Register all inbound Discord event handlers.
 */
export function registerInboundHandlers(
  client: Client,
  config: GatewayConfig,
  resolver: AgentResolver,
  securityConfig: SecurityConfig,
  threadStore: ThreadStore
): void {
  client.on('messageCreate', async (message: Message) => {
    if (message.author.bot) return;

    const isDM = !message.guild;
    const isMentioned = message.mentions.has(client.user!);

    if (!isDM && !isMentioned) return;

    const displayName = message.author.displayName || message.author.username;
    let text = message.content;

    if (isMentioned && client.user) {
      text = stripBotMention(text, client.user.id);
    }

    if (!text.trim()) return;

    const source = isDM ? 'DM' : `#${(message.channel as TextChannel).name || message.channelId}`;
    console.log(`[Discord <-] ${source} from ${displayName}: ${text.substring(0, 50)}...`);

    try {
      await message.react('\u{1F440}').catch(() => {});

      if ('sendTyping' in message.channel) {
        await message.channel.sendTyping().catch(() => {});
      }

      const reply = async (replyText: string) => {
        await message.reply(replyText);
      };

      await routeMessage(
        config,
        resolver,
        securityConfig,
        threadStore,
        text,
        message.channelId,
        message.id,
        displayName,
        message.author.id,
        reply
      );
    } catch (error) {
      console.error('Error routing message:', error);
      await message.reply('Failed to route message. Please try again.').catch(() => {});
    }
  });
}
