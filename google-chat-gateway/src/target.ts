/**
 * Destination of an agent-started conversation (`context.gchat.to`).
 *
 *   spaces/AAAA        a space, used as given
 *   users/123 | email  the direct message with that person (found, not created: the person must
 *                      have the app installed or an admin must have installed it for them)
 */

import { Cache } from './cache.js';
import type { ChatClient } from './chat-client.js';

export class TargetResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TargetResolutionError';
  }
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export interface TargetResolver {
  resolve(botId: string, chat: Pick<ChatClient, 'findDirectMessage'>, target: string): Promise<string>;
  clearCaches(): void;
}

export function createTargetResolver(ttlMs: number): TargetResolver {
  const cache = new Cache<string>(ttlMs);

  return {
    async resolve(botId, chat, raw) {
      const target = raw.trim();
      if (/^spaces\/[A-Za-z0-9_-]+$/.test(target)) return target;

      const isUser = /^users\/[A-Za-z0-9_.@-]+$/.test(target);
      if (!isUser && !EMAIL.test(target)) {
        throw new TargetResolutionError(
          `"${target}" is not a space (spaces/...), a user (users/...) or an email address`
        );
      }

      const key = `${botId}|${target.toLowerCase()}`;
      const hit = cache.get(key);
      if (hit) return hit;
      try {
        const space = await chat.findDirectMessage(target);
        cache.set(key, space);
        return space;
      } catch (error) {
        if ((error as { httpStatus?: number }).httpStatus === 404) {
          throw new TargetResolutionError(
            `no direct message with ${target} on bot ${botId}: the person has to open the app once, or an admin install it for them`
          );
        }
        throw error;
      }
    },
    clearCaches: () => cache.clear(),
  };
}
