/**
 * Email→Agent Routing
 *
 * Resolves an inbound email address to an AI Maestro agent target.
 *
 * Lookup order:
 * 1. AI Maestro email index (GET /api/agents/email-index) - centralized identity
 * 2. Local routing.yaml fallback (exact address, then tenant default)
 * 3. null (unroutable)
 */

import { GatewayConfig } from './config.js';

export interface RouteResult {
  agent: string;
  host: string;
  matchType: 'email-index' | 'exact' | 'default';
}

interface EmailIndexEntry {
  agentId: string;
  agentName: string;
  hostId: string;
  displayName: string;
  primary: boolean;
}

type EmailIndex = Record<string, EmailIndexEntry>;

// Cached email index
let cachedIndex: EmailIndex | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 60_000; // 1 minute

/**
 * Fetch the email index from AI Maestro, with caching.
 */
async function fetchEmailIndex(config: GatewayConfig): Promise<EmailIndex> {
  const now = Date.now();
  if (cachedIndex && (now - cacheTimestamp) < CACHE_TTL_MS) {
    return cachedIndex;
  }

  const response = await fetch(`${config.aimaestro.apiUrl}/api/agents/email-index`, {
    signal: AbortSignal.timeout(5000),
  });

  if (!response.ok) {
    throw new Error(`email-index returned ${response.status}`);
  }

  cachedIndex = await response.json() as EmailIndex;
  cacheTimestamp = now;
  return cachedIndex;
}

/**
 * Resolve an email address to an AI Maestro agent.
 */
export async function resolveRoute(
  toEmail: string,
  tenant: string,
  config: GatewayConfig
): Promise<RouteResult | null> {
  const emailLower = toEmail.toLowerCase();

  // 1. AI Maestro email index (centralized identity)
  try {
    const index = await fetchEmailIndex(config);
    const entry = index[emailLower];
    if (entry) {
      return {
        agent: entry.agentName,
        host: entry.hostId,
        matchType: 'email-index',
      };
    }
  } catch (err) {
    console.warn(`[ROUTER] email-index unavailable, using local fallback:`, (err as Error).message);
  }

  // 2. Local fallback: exact address match
  const exactMatch = config.routing.routes[emailLower];
  if (exactMatch) {
    return {
      agent: exactMatch.agent,
      host: exactMatch.host,
      matchType: 'exact',
    };
  }

  // 3. Local fallback: tenant default (catch-all)
  const tenantDefault = config.routing.defaults[tenant];
  if (tenantDefault) {
    return {
      agent: tenantDefault.agent,
      host: tenantDefault.host,
      matchType: 'default',
    };
  }

  // 4. Unroutable
  return null;
}
