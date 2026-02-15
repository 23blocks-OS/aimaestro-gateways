/**
 * Discord Gateway - Agent Resolution (AMP Protocol)
 *
 * Simplified resolver that builds AMP addresses directly.
 * No more multi-host resolution or fuzzy search — the AMP route
 * handler resolves addresses on the provider side.
 */

import type { GatewayConfig, LookupResult } from './types.js';

export interface AgentResolver {
  buildAddress(name: string): string;
  lookupAgent(name: string): LookupResult;
  clearCaches(): void;
}

export function createAgentResolver(config: GatewayConfig): AgentResolver {
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
   */
  function lookupAgent(name: string): LookupResult {
    const address = buildAddress(name);
    const displayName = address.split('@')[0];
    debug(`Resolved "${name}" -> ${address}`);
    return { address, displayName };
  }

  return {
    buildAddress,
    lookupAgent,
    clearCaches: () => {},
  };
}
