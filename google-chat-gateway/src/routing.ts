/**
 * Which agent gets a message.
 *
 *   dedicated app (bot.agent set)  -> that agent, always; @AIM: tags are ignored
 *   shared app                     -> @AIM:agent tag, else the agent already answering this
 *                                     thread, else AMP_DEFAULT_AGENT
 */

import type { BotConfig } from './types.js';

const TAG = /@AIM:([a-zA-Z0-9_@.\-]+)/i;

/** Pull an `@AIM:agent` tag out of the text. */
export function parseAgentTag(text: string): { agent: string | null; message: string } {
  const match = text.match(TAG);
  if (!match) return { agent: null, message: text.trim() };
  const message = text
    .replace(match[0], '')
    .replace(/\s+/g, ' ')
    .replace(/^[,.\s]+/, '')
    .trim();
  return { agent: match[1], message: message || '(no message)' };
}

export interface RouteChoice {
  /** Agent name or AMP address, before address resolution. */
  agent: string;
  message: string;
  /** Why this agent: for the log. */
  via: 'dedicated' | 'tag' | 'thread' | 'default';
}

export function chooseAgent(
  bot: BotConfig,
  text: string,
  threadAgent: string | undefined,
  defaultAgent: string
): RouteChoice {
  const { agent: tagged, message } = parseAgentTag(text);
  if (bot.agent) return { agent: bot.agent, message: text.trim() || '(no message)', via: 'dedicated' };
  if (tagged) return { agent: tagged, message, via: 'tag' };
  if (threadAgent) return { agent: threadAgent, message: message || '(no message)', via: 'thread' };
  return { agent: defaultAgent, message: message || '(no message)', via: 'default' };
}
