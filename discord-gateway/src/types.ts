/**
 * Discord Gateway - Type Definitions (AMP Protocol)
 */

// ---------------------------------------------------------------------------
// Gateway Configuration
// ---------------------------------------------------------------------------

export interface GatewayConfig {
  port: number;
  discord: {
    botToken: string;
  };
  amp: {
    apiKey: string;
    agentAddress: string;
    maestroUrl: string;
    defaultAgent: string;
    tenant: string;
    inboxDir: string;
  };
  cache: {
    agentTtlMs: number;
    slackUserTtlMs: number;
  };
  polling: {
    intervalMs: number;
    timeoutMs: number;
  };
  debug: boolean;
  adminToken: string;
}

// ---------------------------------------------------------------------------
// AMP Protocol Types
// ---------------------------------------------------------------------------

export interface AMPEnvelope {
  version: string;
  id: string;
  from: string;
  to: string;
  subject: string;
  priority: 'urgent' | 'high' | 'normal' | 'low';
  timestamp: string;
  signature: string | null;
  in_reply_to?: string | null;
  thread_id?: string;
  expires_at?: string | null;
}

export interface AMPPayload {
  type: string;
  message: string;
  context?: Record<string, unknown> | null;
}

export interface AMPMessage {
  envelope: AMPEnvelope;
  payload: AMPPayload;
  metadata?: {
    status?: string;
    queued_at?: string;
    delivery_attempts?: number;
  };
  local?: {
    received_at?: string;
    delivery_method?: string;
    status?: string;
  };
}

export interface AMPRouteRequest {
  to: string;
  subject: string;
  priority?: 'urgent' | 'high' | 'normal' | 'low';
  in_reply_to?: string | null;
  payload: {
    type: string;
    message: string;
    context?: Record<string, unknown>;
  };
}

export interface AMPRouteResponse {
  id: string;
  status: 'delivered' | 'queued' | 'failed';
  method?: string;
  delivered_at?: string;
  error?: string;
  message?: string;
}

// ---------------------------------------------------------------------------
// Thread Context (maps AMP message IDs to Discord channels)
// ---------------------------------------------------------------------------

export interface ThreadContext {
  channelId: string;
  messageId: string;
  user: string;
  userName: string;
  ampMessageId: string;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Agent Resolution (simplified for AMP)
// ---------------------------------------------------------------------------

export interface LookupResult {
  address: string;
  displayName: string;
}
