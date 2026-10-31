export interface PersonRoute { open_id: string; agent: string; enabled: boolean; admin: boolean }
export interface RoutingConfig { tenant?: string; default_reply_unknown: string; disabled_person: string; group_pointer: string; people: Record<string, PersonRoute> }
export interface GatewayConfig {
  port: number; bindAddress: string; adminToken: string; appId: string; appSecret: string; verificationToken: string; encryptKey: string; domain: 'lark' | 'feishu';
  amp: { apiKey: string; agentAddress: string; maestroUrl: string; defaultAgent: string; tenant: string; inboxDir: string };
  routingFile: string; stateDir: string; pollIntervalMs: number; timeoutMs: number; workingDelayMs: number;
}
export interface AMPEnvelope { id?: string; from?: string; to?: string; in_reply_to?: string | null; thread_id?: string; subject?: string; }
export interface AMPMessage { envelope: AMPEnvelope; payload: { type?: string; message?: string; context?: Record<string, unknown> | null; attachments?: unknown[] }; }
export interface LarkAttachment { name: string; content_type: string; content: string; size: number }
export interface ThreadContext { messageId: string; rootId: string; chatId: string; chatType: string; openId: string; person: string; agent: string; createdAt: number; status?: 'working' | 'done'; }
export interface NormalizedMessage { text: string; attachments: Array<{ key: string; name: string; type: string }>; ignored: boolean; }
