/**
 * WhatsApp Gateway - Type Definitions
 */

export interface RouteTarget {
  agent: string;
  host: string;
}

export interface GatewayConfig {
  port: number;
  debug: boolean;
  aimaestro: {
    apiUrl: string;
    botAgent: string;
    hostId: string;
  };
  whatsapp: {
    stateDir: string;
    allowFrom: string[];
    dmPolicy: 'allowlist' | 'open' | 'disabled';
    sendReadReceipts: boolean;
    textChunkLimit: number;
  };
  routing: {
    phones: Record<string, RouteTarget>;
    default: RouteTarget;
  };
  outbound: {
    pollIntervalMs: number;
  };
  operatorPhones: string[];
  adminToken: string;
}

export interface WhatsAppInboundMessage {
  from: string;           // E.164 phone number
  fromName: string;       // Push name from WhatsApp
  chatJid: string;        // Full WhatsApp JID
  messageId: string;      // WhatsApp stanza ID
  isGroup: boolean;
  groupJid: string | null;
  groupName: string | null;
  textBody: string;
  quotedMessage: QuotedMessage | null;
  hasMedia: boolean;
  mediaType: string | null;
  timestamp: string;      // ISO 8601
}

export interface QuotedMessage {
  id: string;
  sender: string;
  body: string;
}

export interface WhatsAppSendPayload {
  to: string;             // E.164 or group JID
  message: string;
  quotedMessageId?: string;
  accountId?: string;
}
