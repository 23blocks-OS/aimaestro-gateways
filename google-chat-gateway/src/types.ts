/**
 * Google Chat Gateway - Type Definitions (AMP Protocol)
 */

// ---------------------------------------------------------------------------
// Gateway Configuration
// ---------------------------------------------------------------------------

/**
 * One Google Chat app. Google allows ONE Chat app per Cloud project, and the app is the
 * identity people see (name, avatar), so "one identity per agent" means one bot entry per
 * agent, each with its own project, topic, subscription and service account.
 */
export interface BotConfig {
  /** Short id used in logs, the thread store and `context.gchat.bot`. */
  id: string;
  /** Cloud project that owns the Chat app, topic and subscription. */
  projectId: string;
  /** Pull subscription on the app's topic. */
  subscriptionId: string;
  /** Service account key file. Falls back to GOOGLE_APPLICATION_CREDENTIALS / ADC. */
  credentialsFile?: string;
  /**
   * Service account email to impersonate for Chat API calls (keyless, for cloud VMs). The machine's
   * login needs roles/iam.serviceAccountTokenCreator on it, and the IAM Credentials API must be enabled.
   */
  impersonateServiceAccount?: string;
  /**
   * Dedicated agent: every message to this app goes to this agent (name or AMP address) and
   * `@AIM:` tags are ignored. Leave empty for a SHARED app: messages are routed by `@AIM:agent`
   * tag, then thread affinity, then the default agent.
   */
  agent?: string;
}

export interface GatewayConfig {
  port: number;
  bots: BotConfig[];
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
    userTtlMs: number;
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
// Thread Context (maps AMP message IDs to Google Chat threads)
// ---------------------------------------------------------------------------

export interface ThreadContext {
  /** Which bot (Chat app) the conversation is with. Replies must go out through the same one. */
  botId: string;
  /** `spaces/AAAA` */
  space: string;
  /** `spaces/AAAA/threads/BBBB`. Empty in a space that does not use threads. */
  thread: string;
  /** Sender resource name, `users/123`. */
  user: string;
  userName: string;
  ampMessageId: string;
  createdAt: number;
  /**
   * AMP address of the agent on the other end of this thread. Set when an agent starts the
   * conversation, so a human reply in that thread routes back to it.
   */
  agentAddress?: string;
}

export interface LookupResult {
  address: string;
  displayName: string;
}
