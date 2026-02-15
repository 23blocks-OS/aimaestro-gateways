/**
 * Slack Gateway - Agent Resolution (AMP Protocol)
 *
 * Simplified resolver that builds AMP addresses directly.
 * No more multi-host resolution or fuzzy search — the AMP route
 * handler resolves addresses on the provider side.
 */

import type { App } from '@slack/bolt';
import { Cache } from './cache.js';
import type { GatewayConfig, LookupResult } from './types.js';

export interface AgentResolver {
  buildAddress(name: string): string;
  lookupAgent(name: string): LookupResult;
  getUserDisplayName(userId: string): Promise<string>;
  clearCaches(): void;
}

export function createAgentResolver(config: GatewayConfig, slackApp: App): AgentResolver {
  const slackUserCache = new Cache<string>(config.cache.slackUserTtlMs);

  function debug(message: string, ...args: unknown[]): void {
    if (config.debug) {
      console.log(`[DEBUG] ${message}`, ...args);
    }
  }

  /**
   * Build a full AMP address from an agent name.
   * If the name already contains '@', assume it's a full address.
   */
  function buildAddress(name: string): string {
    if (name.includes('@')) {
      return name;
    }
    return `${name}@${config.amp.tenant}.aimaestro.local`;
  }

  /**
   * Look up an agent — just builds the AMP address.
   * Display name defaults to the agent name portion.
   */
  function lookupAgent(name: string): LookupResult {
    const address = buildAddress(name);
    const displayName = address.split('@')[0];
    debug(`Resolved "${name}" -> ${address}`);
    return { address, displayName };
  }

  async function getUserDisplayName(userId: string): Promise<string> {
    const cached = slackUserCache.get(userId);
    if (cached) {
      debug(`Slack user cache hit for ${userId}`);
      return cached;
    }

    debug(`Slack user cache miss for ${userId}, fetching...`);

    try {
      const result = await slackApp.client.users.info({ user: userId });
      if (result.ok && result.user) {
        const displayName = result.user.real_name || result.user.name || userId;
        slackUserCache.set(userId, displayName);
        return displayName;
      }
    } catch (error) {
      debug(`Failed to get user info for ${userId}:`, error);
    }

    return userId;
  }

  return {
    buildAddress,
    lookupAgent,
    getUserDisplayName,
    clearCaches: () => {
      slackUserCache.clear();
    },
  };
}
