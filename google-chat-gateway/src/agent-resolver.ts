/**
 * Agent address resolution (AMP). A bare name becomes name@<tenant>.aimaestro.local; a value
 * that already holds an @ is used as given. The provider resolves the rest.
 */

import { Cache } from './cache.js';
import type { GatewayConfig, LookupResult } from './types.js';

export interface AgentResolver {
  lookupAgent(nameOrAddress: string): LookupResult;
  clearCaches(): void;
}

export function createAgentResolver(config: GatewayConfig): AgentResolver {
  const cache = new Cache<LookupResult>(config.cache.agentTtlMs);

  return {
    lookupAgent(nameOrAddress: string): LookupResult {
      const key = nameOrAddress.trim();
      const hit = cache.get(key);
      if (hit) return hit;
      const address = key.includes('@') ? key : `${key}@${config.amp.tenant}.aimaestro.local`;
      const result = { address, displayName: key.split('@')[0] };
      cache.set(key, result);
      return result;
    },
    clearCaches: () => cache.clear(),
  };
}
