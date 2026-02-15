/**
 * Email Gateway - Type Definitions (AMP Protocol)
 */

// ---------------------------------------------------------------------------
// AMP Protocol Types
// ---------------------------------------------------------------------------

export interface AMPEnvelope {
  version: string;
  id: string;
  from: string;
  to: string;
  subject: string;
  priority: 'critical' | 'high' | 'normal' | 'low';
  timestamp: string;
  signature?: string;
  in_reply_to?: string;
  thread_id?: string;
}

export interface AMPPayload {
  type: string;
  message: string;
  context?: Record<string, any>;
  attachments?: any[];
}

export interface AMPMessage {
  envelope: AMPEnvelope;
  payload: AMPPayload;
}

export interface AMPRouteRequest {
  to: string;
  subject: string;
  priority?: string;
  in_reply_to?: string;
  payload: {
    type: string;
    message: string;
    context?: Record<string, any>;
    attachments?: any[];
  };
  signature?: string;
}

export interface AMPRouteResponse {
  id: string;
  status: string;
  method?: string;
  delivered_at?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Gateway Config
// ---------------------------------------------------------------------------

export interface GatewayConfig {
  port: number;
  debug: boolean;
  amp: {
    apiKey: string;
    agentAddress: string;
    maestroUrl: string;
    defaultAgent: string;
    tenant: string;
    inboxDir: string;
  };
  mandrill: {
    apiKey: string;
    webhookKeys: Record<string, string>;
  };
  routing: {
    routes: Record<string, RouteTarget>;
    defaults: Record<string, RouteTarget>;
  };
  outbound: {
    pollIntervalMs: number;
  };
  storage: {
    attachmentsPath: string;
  };
  adminToken: string;
  emailBaseDomain: string;
}

export interface RouteTarget {
  agent: string;
}
