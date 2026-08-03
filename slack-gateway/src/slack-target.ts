/**
 * Slack Target Resolution
 *
 * Turns a human-friendly destination into a Slack channel ID that
 * chat.postMessage can accept. Lets agents address Slack as `@juan` or
 * `#general` instead of carrying raw IDs around.
 *
 * Supported forms:
 *   D0AAHQP345T   already-open DM channel  -> used as-is
 *   C…, G…        public/private channel   -> used as-is
 *   U…, W…        user ID                  -> conversations.open -> DM channel
 *   @display-name user by name             -> users.list -> conversations.open
 *   #channel-name channel by name          -> conversations.list
 *   general       bare name, treated as #general
 */

import type { App } from '@slack/bolt';
import { Cache } from './cache.js';

export interface ResolvedTarget {
  /** Channel ID suitable for chat.postMessage. */
  channel: string;
  kind: 'dm' | 'channel';
  /** What the caller originally asked for, for logging. */
  requested: string;
}

export class TargetResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TargetResolutionError';
  }
}

const CHANNEL_ID = /^[CG][A-Z0-9]{6,}$/;
const DM_ID = /^D[A-Z0-9]{6,}$/;
const USER_ID = /^[UW][A-Z0-9]{6,}$/;

export interface TargetResolver {
  resolve(target: string): Promise<ResolvedTarget>;
  clearCaches(): void;
}

export function createTargetResolver(slackApp: App, ttlMs: number = 600000): TargetResolver {
  // target string -> resolved channel ID
  const resolved = new Cache<ResolvedTarget>(ttlMs);

  async function openDm(userId: string, requested: string): Promise<ResolvedTarget> {
    const result = await slackApp.client.conversations.open({ users: userId });
    const channel = result.channel?.id;
    if (!channel) {
      throw new TargetResolutionError(`could not open DM with user ${userId}`);
    }
    return { channel, kind: 'dm', requested };
  }

  async function findUserByName(name: string): Promise<string> {
    const wanted = name.toLowerCase().replace(/^@/, '');
    let cursor: string | undefined;

    do {
      const page = await slackApp.client.users.list({ limit: 200, cursor });
      for (const member of page.members || []) {
        if (member.deleted || member.is_bot) continue;
        const candidates = [
          member.name,
          member.profile?.display_name,
          member.profile?.display_name_normalized,
          member.profile?.real_name,
          member.profile?.real_name_normalized,
        ];
        if (candidates.some((c) => c && c.toLowerCase() === wanted)) {
          if (member.id) return member.id;
        }
      }
      cursor = page.response_metadata?.next_cursor || undefined;
    } while (cursor);

    throw new TargetResolutionError(`no Slack user matches "@${wanted}"`);
  }

  async function findChannelByName(name: string): Promise<string> {
    const wanted = name.toLowerCase().replace(/^#/, '');
    let cursor: string | undefined;

    do {
      const page = await slackApp.client.conversations.list({
        limit: 200,
        cursor,
        types: 'public_channel,private_channel',
        exclude_archived: true,
      });
      for (const channel of page.channels || []) {
        if (channel.name?.toLowerCase() === wanted && channel.id) {
          return channel.id;
        }
      }
      cursor = page.response_metadata?.next_cursor || undefined;
    } while (cursor);

    throw new TargetResolutionError(
      `no Slack channel matches "#${wanted}" (the bot may not be a member of it)`
    );
  }

  async function resolveUncached(target: string): Promise<ResolvedTarget> {
    const trimmed = target.trim();
    if (!trimmed) {
      throw new TargetResolutionError('empty target');
    }

    // Slack sometimes hands back mention syntax like <@U123> or <#C123|name>
    const mention = trimmed.match(/^<[@#]([A-Z0-9]+)(\|[^>]*)?>$/);
    const bare = mention ? mention[1] : trimmed;

    if (DM_ID.test(bare)) return { channel: bare, kind: 'dm', requested: target };
    if (CHANNEL_ID.test(bare)) return { channel: bare, kind: 'channel', requested: target };
    if (USER_ID.test(bare)) return openDm(bare, target);

    if (bare.startsWith('@')) {
      const userId = await findUserByName(bare);
      return openDm(userId, target);
    }

    // Anything else is treated as a channel name, with or without the #
    const channel = await findChannelByName(bare);
    return { channel, kind: 'channel', requested: target };
  }

  return {
    async resolve(target: string): Promise<ResolvedTarget> {
      const cached = resolved.get(target);
      if (cached) return cached;

      const result = await resolveUncached(target);
      resolved.set(target, result);
      return result;
    },

    clearCaches(): void {
      resolved.clear();
    },
  };
}
