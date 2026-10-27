/**
 * Google Chat Gateway - Inbound (Chat -> AMP)
 *
 * Each bot (Chat app) has a Pub/Sub pull subscription. Every event is parsed, de-duplicated
 * (Pub/Sub is at-least-once and Chat can retry), screened, and routed to an agent over AMP.
 * Messages from other apps, and the app's own, are ignored so two bots cannot talk in a loop.
 */

import { PubSub, type Message } from '@google-cloud/pubsub';
import type { AMPRouteRequest, BotConfig, GatewayConfig } from './types.js';
import type { SecurityConfig } from './content-security.js';
import { sanitizeChatMessage } from './content-security.js';
import type { AgentResolver } from './agent-resolver.js';
import type { ThreadStore } from './thread-store.js';
import type { ChatClient } from './chat-client.js';
import { parseChatEvent, isDirectMessage, type ChatEvent } from './events.js';
import { chooseAgent } from './routing.js';
import { Cache } from './cache.js';
import { logEvent } from './api/activity-log.js';
import { errLine, clip } from './log-hygiene.js';

export interface BotRuntime {
  bot: BotConfig;
  chat: ChatClient;
  /** Stop listening. */
  stop: () => Promise<void>;
  connected: () => boolean;
}

export interface InboundDeps {
  config: GatewayConfig;
  resolver: AgentResolver;
  securityConfig: () => SecurityConfig;
  threadStore: ThreadStore;
}

/** Event ids seen in the last 10 minutes. Pub/Sub redelivers; a message must not reach an agent twice. */
const seen = new Cache<true>(10 * 60 * 1000, 5000);

/** Short greeting when the app is added to a space or a DM is opened. */
export function greeting(bot: BotConfig, dm: boolean): string {
  if (bot.agent) {
    const name = bot.agent.split('@')[0];
    return dm
      ? `Hi, I'm connected to ${name}. Send me a message and ${name} will answer here.`
      : `Hi, I'm connected to ${name}. @mention me in this space and ${name} will answer in the thread.`;
  }
  return dm
    ? 'Hi, I connect you to AI Maestro agents. Send a message, or start it with @AIM:agent-name to pick the agent.'
    : 'Hi, @mention me in this space. Add @AIM:agent-name to pick the agent.';
}

/** Handle one parsed event. Exported for tests. */
export async function handleEvent(
  deps: InboundDeps,
  bot: BotConfig,
  chat: Pick<ChatClient, 'postMessage'>,
  event: ChatEvent
): Promise<void> {
  const { config } = deps;

  if (event.kind === 'added') {
    await chat.postMessage(event.space.name, greeting(bot, isDirectMessage(event.space)));
    logEvent('inbound', `Bot ${bot.id} added to ${event.space.displayName || event.space.name}`, {
      from: event.user.displayName,
    });
    return;
  }
  if (event.kind !== 'message' || !event.message) return;

  // Other apps' messages (and our own) never reach an agent.
  if (event.user.type === 'BOT') return;

  const dedupeKey = event.message.name || `${event.space.name}|${event.eventTime}|${event.message.text}`;
  if (seen.get(dedupeKey)) return;
  seen.set(dedupeKey, true);

  const text = event.message.argumentText.trim();
  if (!text) return;

  const threadAgent = event.message.thread
    ? deps.threadStore.findByThread(event.space.name, event.message.thread)?.agentAddress
    : undefined;
  const choice = chooseAgent(bot, text, threadAgent, config.amp.defaultAgent);
  const { address } = deps.resolver.lookupAgent(choice.agent);
  const thread = event.message.thread;

  try {
    await sendToAgent(deps, bot, address, choice.message, event);
  } catch (error) {
    const msg = (error as Error).message;
    let reply: string;
    if (msg.startsWith('agent_not_found')) {
      reply = `I couldn't find an agent called "${choice.agent.split('@')[0]}".`;
    } else if (msg.startsWith('rate_limited')) {
      reply = 'The agent is receiving too many messages right now. Try again in a moment.';
    } else {
      reply = "I couldn't deliver your message to the agent. Try again in a moment.";
    }
    console.error(`[INBOUND] ${bot.id} -> ${address} failed: ${errLine(error)}`);
    logEvent('error', `Failed to route Chat message to ${address}`, { error: errLine(error) });
    await chat.postMessage(event.space.name, reply, thread || undefined).catch(() => {});
  }
}

async function sendToAgent(
  deps: InboundDeps,
  bot: BotConfig,
  targetAddress: string,
  text: string,
  event: ChatEvent
): Promise<void> {
  const { config } = deps;
  const message = event.message!;
  const userName = event.user.displayName;
  const { sanitized, trust, flags } = sanitizeChatMessage(
    text,
    [event.user.name, event.user.email],
    userName,
    deps.securityConfig()
  );

  if (flags.length > 0) {
    console.log(`[SECURITY] ${flags.length} injection pattern(s) flagged from ${userName} (trust: ${trust.level})`);
    logEvent('security', `Injection patterns flagged from ${userName}`, {
      from: userName,
      to: targetAddress,
      subject: clip(text),
      securityFlags: flags.map((f) => `${f.category}: ${f.match}`),
    });
  }

  const ampRequest: AMPRouteRequest = {
    to: targetAddress,
    subject: `Google Chat message from ${userName}`,
    priority: 'normal',
    payload: {
      type: 'request',
      message: sanitized,
      context: {
        channel: {
          type: 'google-chat',
          sender: userName,
          sender_id: event.user.name,
          thread_id: event.space.name,
          bridge_agent: config.amp.agentAddress,
          received_at: new Date().toISOString(),
        },
        gchat: { bot: bot.id, space: event.space.name, thread: message.thread, user: userName },
        security: {
          trust: trust.level,
          source: 'google-chat',
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
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.amp.apiKey}` },
    body: JSON.stringify(ampRequest),
    signal: AbortSignal.timeout(config.polling.timeoutMs),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    if (response.status === 404) throw new Error(`agent_not_found: ${targetAddress}`);
    if (response.status === 429) throw new Error(`rate_limited: ${targetAddress}`);
    throw new Error(`AMP route failed (${response.status}): ${errorBody}`);
  }

  const result = await response.json();

  if (result.id) {
    deps.threadStore.set(result.id, {
      botId: bot.id,
      space: event.space.name,
      thread: message.thread,
      user: event.user.name,
      userName,
      ampMessageId: result.id,
      createdAt: Date.now(),
    });
  }

  console.log(`[-> ${targetAddress}] Message from ${userName} via ${bot.id} (trust: ${trust.level}): ${clip(text, 50)}`);
  logEvent('inbound', `Google Chat message routed: ${userName} -> ${targetAddress.split('@')[0]}`, {
    from: userName,
    to: targetAddress,
    subject: clip(text),
    ampMessageId: result.id,
    deliveryStatus: result.status,
  });
}

/** Subscribe one bot to its Pub/Sub subscription. */
export function startBot(deps: InboundDeps, bot: BotConfig, chat: ChatClient): BotRuntime {
  const pubsub = new PubSub({ projectId: bot.projectId, keyFilename: bot.credentialsFile });
  const subscription = pubsub.subscription(bot.subscriptionId, {
    // A few at a time: the agent side is slow, and Pub/Sub holds the rest.
    flowControl: { maxMessages: 4 },
  });
  let connected = true;

  subscription.on('message', (m: Message) => {
    // Ack first: a Chat event is a human message with no retry value if our handler throws, and
    // redelivery would post the same error reply again.
    m.ack();
    connected = true;
    let event: ChatEvent;
    try {
      event = parseChatEvent(JSON.parse(m.data.toString('utf-8')));
    } catch (error) {
      logEvent('error', `Unreadable Pub/Sub message on bot ${bot.id}`, { error: errLine(error) });
      return;
    }
    handleEvent(deps, bot, chat, event).catch((error) => {
      console.error(`[INBOUND] ${bot.id} handler error: ${errLine(error)}`);
      logEvent('error', `Handler error on bot ${bot.id}`, { error: errLine(error) });
    });
  });

  subscription.on('error', (error: Error) => {
    connected = false;
    // The client library reconnects by itself; log one line, not a stack.
    console.error(`[PUBSUB] ${bot.id} subscription error: ${errLine(error)}`);
    logEvent('error', `Pub/Sub error on bot ${bot.id}`, { error: errLine(error) });
  });

  console.log(`[PUBSUB] ${bot.id}: listening on ${bot.projectId}/${bot.subscriptionId}` + (bot.agent ? ` (dedicated to ${bot.agent})` : ' (shared, @AIM: tags)'));

  return {
    bot,
    chat,
    connected: () => connected,
    stop: async () => {
      await subscription.close().catch(() => {});
      await pubsub.close().catch(() => {});
    },
  };
}
