/**
 * Discord Gateway - Inbound Message Handlers
 *
 * Registers Discord event handlers (messageCreate) and routes messages
 * to AI Maestro agents via content security scanning.
 */

import type { Client, Message, TextChannel } from 'discord.js';
import type { GatewayConfig } from './types.js';
import type { AgentResolver } from './agent-resolver.js';
import { sanitizeDiscordMessage, type SecurityConfig } from './content-security.js';
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
 * Remove bot mention from message text.
 * Discord mentions look like <@BOT_ID> in message content.
 */
function stripBotMention(text: string, botId: string): string {
  return text.replace(new RegExp(`<@!?${botId}>`, 'g'), '').trim();
}

/**
 * Send a message to an AI Maestro agent.
 */
async function sendToAgent(
  config: GatewayConfig,
  targetAgent: string,
  targetHost: string,
  text: string,
  channelId: string,
  messageId: string,
  displayName: string,
  discordUserId: string,
  securityConfig: SecurityConfig
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
    subject: `Discord: Message from ${displayName}`,
    priority: 'normal',
    content: {
      type: 'request',
      message: sanitized,
      discord: {
        channelId,
        messageId,
        user: displayName,
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
    `[-> ${targetAgent}@${targetHost}] Message from ${displayName} (trust: ${trust.level}): ${text.substring(0, 50)}...`
  );

  logEvent('inbound', `Discord message routed: ${displayName} -> ${targetAgent}`, {
    from: displayName,
    to: targetAgent,
    subject: text.substring(0, 80),
  });
}

/**
 * Route a Discord message to the appropriate AI Maestro agent.
 */
async function routeMessage(
  config: GatewayConfig,
  resolver: AgentResolver,
  securityConfig: SecurityConfig,
  text: string,
  channelId: string,
  messageId: string,
  displayName: string,
  discordUserId: string,
  reply: (text: string) => Promise<void>
): Promise<void> {
  const { agent, message } = parseAgentRouting(text, config.aimaestro.defaultAgent);
  const result = await resolver.lookupAgentSmart(agent);

  if (result.status === 'not_found') {
    await reply(
      `Agent \`${agent}\` not found on any host.\n\nUse \`@AIM:agent-name message\` to route to a specific agent.`
    );
    logEvent('error', `Agent not found: ${agent}`, { from: displayName, to: agent });
    return;
  }

  if (result.status === 'multiple') {
    const matchList = result.matches.map((m) => `- \`${m.alias}@${m.hostId}\``).join('\n');
    await reply(
      `Found multiple matches for \`${agent}\`:\n\n${matchList}\n\nPlease specify the full agent name, e.g.:\n\`@AIM:${result.matches[0].alias}@${result.matches[0].hostId} your message\``
    );
    return;
  }

  // Found exactly one match
  if (result.fuzzy) {
    await reply(`Found partial match: \`${result.name}@${result.host}\``);
  }

  await sendToAgent(
    config,
    result.name,
    result.host,
    message,
    channelId,
    messageId,
    displayName,
    discordUserId,
    securityConfig
  );
}

/**
 * Register all inbound Discord event handlers.
 */
export function registerInboundHandlers(
  client: Client,
  config: GatewayConfig,
  resolver: AgentResolver,
  securityConfig: SecurityConfig
): void {
  client.on('messageCreate', async (message: Message) => {
    // Ignore bot messages (prevent loops)
    if (message.author.bot) return;

    const isDM = !message.guild;
    const isMentioned = message.mentions.has(client.user!);

    // Only respond to DMs or messages where bot is @mentioned
    if (!isDM && !isMentioned) return;

    const displayName = message.author.displayName || message.author.username;
    let text = message.content;

    // Strip bot mention from channel messages
    if (isMentioned && client.user) {
      text = stripBotMention(text, client.user.id);
    }

    if (!text.trim()) return;

    const source = isDM ? 'DM' : `#${(message.channel as TextChannel).name || message.channelId}`;
    console.log(`[Discord <-] ${source} from ${displayName}: ${text.substring(0, 50)}...`);

    try {
      // Add eyes reaction
      await message.react('\u{1F440}').catch(() => {});

      // Show typing indicator
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
