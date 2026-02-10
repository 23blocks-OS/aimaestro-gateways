/**
 * Discord Gateway - Agent Resolution
 *
 * Resolves agent names to AI Maestro agent IDs across all hosts.
 * Uses a two-phase lookup: exact match first, then fuzzy search.
 */

import { Cache } from './cache.js';
import type {
  GatewayConfig,
  Host,
  AgentCacheEntry,
  HostsCacheEntry,
  LookupResult,
  ResolvedAgent,
  AIHostsResponse,
  AIResolveResponse,
  AISearchResponse,
} from './types.js';

export interface AgentResolver {
  lookupAgentSmart(agentName: string): Promise<LookupResult>;
  lookupAgent(agentName: string): Promise<{ name: string; host: string; displayName?: string } | null>;
  getAgentCacheSize(): number;
  clearCaches(): void;
}

export function createAgentResolver(config: GatewayConfig): AgentResolver {
  const agentCache = new Cache<AgentCacheEntry>(config.cache.agentTtlMs);
  agentCache.startCleanup(60000); // Clean expired entries every 60 seconds
  let hostsCache: HostsCacheEntry | null = null;

  function debug(message: string, ...args: unknown[]): void {
    if (config.debug) {
      console.log(`[DEBUG] ${message}`, ...args);
    }
  }

  async function getHosts(): Promise<Host[]> {
    if (hostsCache && Date.now() - hostsCache.cachedAt < config.cache.hostsTtlMs) {
      debug('Hosts cache hit');
      return hostsCache.hosts;
    }

    debug('Hosts cache miss, fetching...');

    try {
      const response = await fetch(`${config.aimaestro.apiUrl}/api/hosts`, {
        signal: AbortSignal.timeout(config.polling.timeoutMs),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = (await response.json()) as AIHostsResponse;
      const hosts = (data.hosts || []).filter((h) => h.enabled);

      hostsCache = { hosts, cachedAt: Date.now() };
      debug(`Cached ${hosts.length} hosts`);

      return hosts;
    } catch (error) {
      debug('Failed to get hosts:', error);
      return [{ id: config.aimaestro.hostId, url: config.aimaestro.apiUrl, enabled: true }];
    }
  }

  async function resolveOnHost(
    agentName: string,
    hostUrl: string,
    hostId: string
  ): Promise<ResolvedAgent | null> {
    try {
      const response = await fetch(
        `${hostUrl}/api/messages?action=resolve&agent=${encodeURIComponent(agentName)}`,
        { signal: AbortSignal.timeout(config.polling.timeoutMs) }
      );

      if (!response.ok) return null;

      const data = (await response.json()) as AIResolveResponse;

      if (data.resolved) {
        return {
          agentId: data.resolved.agentId,
          alias: data.resolved.alias || agentName,
          displayName: data.resolved.displayName,
        };
      }

      return null;
    } catch (error) {
      debug(`Resolve failed on ${hostId}:`, error);
      return null;
    }
  }

  async function searchOnHost(
    agentName: string,
    hostUrl: string,
    hostId: string
  ): Promise<Array<{ alias: string; agentId: string; displayName?: string }>> {
    try {
      const response = await fetch(
        `${hostUrl}/api/messages?action=search&agent=${encodeURIComponent(agentName)}`,
        { signal: AbortSignal.timeout(config.polling.timeoutMs) }
      );

      if (!response.ok) return [];

      const data = (await response.json()) as AISearchResponse;
      return data.results || [];
    } catch (error) {
      debug(`Search failed on ${hostId}:`, error);
      return [];
    }
  }

  async function lookupAgentSmart(agentName: string): Promise<LookupResult> {
    // Check cache first
    const cached = agentCache.get(agentName.toLowerCase());
    if (cached) {
      debug(`Agent cache hit for "${agentName}"`);
      return {
        status: 'found',
        name: cached.agentId,
        host: cached.host,
        hostUrl: cached.hostUrl,
        displayName: cached.displayName,
      };
    }

    debug(`Agent cache miss for "${agentName}", looking up...`);
    const hosts = await getHosts();

    // Phase 1: Try exact match on all hosts IN PARALLEL
    const exactPromises = hosts.map(async (host) => {
      const resolved = await resolveOnHost(agentName, host.url, host.id);
      if (resolved) {
        return {
          name: resolved.agentId,
          host: host.id,
          hostUrl: host.url,
          displayName: resolved.displayName,
          alias: resolved.alias,
        };
      }
      return null;
    });

    const exactResults = await Promise.all(exactPromises);
    const exactMatches = exactResults.filter((r): r is NonNullable<typeof r> => r !== null);

    if (exactMatches.length === 1) {
      const match = exactMatches[0];

      agentCache.set(agentName.toLowerCase(), {
        agentId: match.name,
        alias: match.alias,
        displayName: match.displayName,
        host: match.host,
        hostUrl: match.hostUrl,
        cachedAt: Date.now(),
      });

      if (match.alias && match.alias.toLowerCase() !== agentName.toLowerCase()) {
        agentCache.set(match.alias.toLowerCase(), {
          agentId: match.name,
          alias: match.alias,
          displayName: match.displayName,
          host: match.host,
          hostUrl: match.hostUrl,
          cachedAt: Date.now(),
        });
      }

      return {
        status: 'found',
        name: match.name,
        host: match.host,
        hostUrl: match.hostUrl,
        displayName: match.displayName,
      };
    }

    if (exactMatches.length > 1) {
      return {
        status: 'multiple',
        matches: exactMatches.map((m) => ({ alias: m.name, hostId: m.host })),
      };
    }

    // Phase 2: No exact match - try fuzzy search on all hosts IN PARALLEL
    const fuzzyPromises = hosts.map(async (host) => {
      const matches = await searchOnHost(agentName, host.url, host.id);
      return matches.map((match) => ({
        alias: match.alias,
        hostId: host.id,
        hostUrl: host.url,
        agentId: match.agentId,
        displayName: match.displayName,
      }));
    });

    const fuzzyResults = await Promise.all(fuzzyPromises);
    const fuzzyMatches = fuzzyResults.flat();

    if (fuzzyMatches.length === 1) {
      const match = fuzzyMatches[0];
      console.log(`[Lookup] Found partial match: ${match.alias}@${match.hostId}`);

      agentCache.set(agentName.toLowerCase(), {
        agentId: match.agentId,
        alias: match.alias,
        displayName: match.displayName,
        host: match.hostId,
        hostUrl: match.hostUrl,
        cachedAt: Date.now(),
      });

      return {
        status: 'found',
        name: match.agentId,
        host: match.hostId,
        hostUrl: match.hostUrl,
        displayName: match.displayName,
        fuzzy: true,
      };
    }

    if (fuzzyMatches.length > 1) {
      return {
        status: 'multiple',
        matches: fuzzyMatches.map((m) => ({ alias: m.alias, hostId: m.hostId })),
      };
    }

    return { status: 'not_found' };
  }

  async function lookupAgent(
    agentName: string
  ): Promise<{ name: string; host: string; displayName?: string } | null> {
    const result = await lookupAgentSmart(agentName);
    if (result.status === 'found') {
      return { name: result.name, host: result.host, displayName: result.displayName };
    }
    return null;
  }

  return {
    lookupAgentSmart,
    lookupAgent,
    getAgentCacheSize: () => agentCache.size(),
    clearCaches: () => {
      agentCache.stopCleanup();
      agentCache.clear();
      hostsCache = null;
    },
  };
}
