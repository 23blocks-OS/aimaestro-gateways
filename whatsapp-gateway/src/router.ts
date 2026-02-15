/**
 * Phone→Agent Routing (AMP Protocol)
 *
 * Resolves an inbound WhatsApp phone number to an AMP agent address.
 *
 * Lookup order:
 * 1. Exact phone match in routing.yaml → build AMP address
 * 2. Default route → build AMP address
 */

import type { GatewayConfig } from './types.js';
import { normalizePhone } from './normalize.js';

export interface RouteResult {
  agentAddress: string;
  displayName: string;
  matchType: 'exact' | 'default';
}

function buildAddress(agentName: string, tenant: string): string {
  return `${agentName}@${tenant}.aimaestro.local`;
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
        agentAddress: buildAddress(exactMatch.agent, config.amp.tenant),
        displayName: exactMatch.agent,
        matchType: 'exact',
      };
    }
  }

  // 2. Default route
  return {
    agentAddress: buildAddress(config.routing.default.agent, config.amp.tenant),
    displayName: config.routing.default.agent,
    matchType: 'default',
  };
}
