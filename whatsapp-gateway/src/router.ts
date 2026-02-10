/**
 * Phone→Agent Routing
 *
 * Resolves an inbound WhatsApp phone number to an AI Maestro agent.
 *
 * Lookup order:
 * 1. Exact phone match in routing.yaml
 * 2. Default route (catch-all)
 */

import type { GatewayConfig, RouteTarget } from './types.js';
import { normalizePhone } from './normalize.js';

export interface RouteResult {
  agent: string;
  host: string;
  matchType: 'exact' | 'default';
}

export function resolveRoute(
  phone: string,
  config: GatewayConfig
): RouteResult {
  const normalized = normalizePhone(phone);

  // 1. Exact phone match
  if (normalized) {
    const exactMatch = config.routing.phones[normalized];
    if (exactMatch) {
      return {
        agent: exactMatch.agent,
        host: exactMatch.host,
        matchType: 'exact',
      };
    }
  }

  // 2. Default route
  return {
    agent: config.routing.default.agent,
    host: config.routing.default.host,
    matchType: 'default',
  };
}
