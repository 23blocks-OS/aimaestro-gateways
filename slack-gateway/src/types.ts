/**
 * Slack Gateway - Type Definitions
 */

export interface GatewayConfig {
  port: number;
  slack: {
    botToken: string;
    appToken: string;
    signingSecret: string;
  };
  aimaestro: {
    apiUrl: string;
    defaultAgent: string;
    botAgent: string;
    hostId: string;
  };
  cache: {
    agentTtlMs: number;
    hostsTtlMs: number;
    slackUserTtlMs: number;
  };
  polling: {
    intervalMs: number;
    timeoutMs: number;
  };
  debug: boolean;
  adminToken: string;
}

export interface Host {
  id: string;
  url: string;
  enabled: boolean;
}

export interface ResolvedAgent {
  agentId: string;
  alias: string;
  displayName?: string;
}

export interface AgentCacheEntry {
  agentId: string;
  alias: string;
  displayName?: string;
  host: string;
  hostUrl: string;
  cachedAt: number;
}

export interface HostsCacheEntry {
  hosts: Host[];
  cachedAt: number;
}

export type LookupResult =
  | { status: 'found'; name: string; host: string; hostUrl: string; displayName?: string; fuzzy?: boolean }
  | { status: 'multiple'; matches: Array<{ alias: string; hostId: string }> }
  | { status: 'not_found' };

export interface AIMessage {
  id: string;
  from: string;
  fromAlias?: string;
  subject: string;
  content?: {
    type?: string;
    message?: string;
    slack?: {
      channel: string;
      thread_ts: string;
      user: string;
    };
  };
}

export interface AIMessagesResponse {
  messages?: AIMessage[];
}

export interface AIResolveResponse {
  resolved?: {
    agentId: string;
    alias?: string;
    displayName?: string;
  };
}

export interface AISearchResponse {
  results?: Array<{ alias: string; agentId: string; displayName?: string }>;
}

export interface AIHostsResponse {
  hosts?: Host[];
}
