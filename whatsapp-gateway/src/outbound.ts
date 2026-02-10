/**
 * Outbound WhatsApp - Baileys Send + AI Maestro Inbox Polling
 *
 * Polls the gateway's AI Maestro inbox for outbound WhatsApp requests from agents,
 * then sends them via Baileys.
 *
 * Message format expected from agents:
 * {
 *   subject: "[WHATSAPP-SEND]" or any subject,
 *   content: {
 *     type: "whatsappSend",
 *     whatsappSend: {
 *       to: "+1234567890",
 *       message: "Hello!",
 *       quotedMessageId: "optional-stanza-id"
 *     }
 *   }
 * }
 */

import type { GatewayConfig, WhatsAppSendPayload } from './types.js';
import { getSocket, getStatus } from './session.js';
import { normalizeTarget, phoneToJid } from './normalize.js';
import { logEvent } from './api/activity-log.js';

/**
 * Fetch unread messages from the gateway's AI Maestro inbox.
 */
async function fetchInbox(config: GatewayConfig): Promise<any[]> {
  const url = `${config.aimaestro.apiUrl}/api/messages?agent=${config.aimaestro.botAgent}&box=inbox&status=unread`;

  const response = await fetch(url, {
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    throw new Error(`AI Maestro inbox fetch failed: ${response.status}`);
  }

  const data = await response.json() as any;
  return data.messages || [];
}

/**
 * Fetch full message details by ID.
 */
async function fetchMessage(config: GatewayConfig, messageId: string): Promise<any> {
  const url = `${config.aimaestro.apiUrl}/api/messages?agent=${config.aimaestro.botAgent}&id=${encodeURIComponent(messageId)}&box=inbox`;

  const response = await fetch(url, {
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    throw new Error(`AI Maestro message fetch failed: ${response.status}`);
  }

  return response.json();
}

/**
 * Mark a message as read in AI Maestro.
 */
async function markAsRead(config: GatewayConfig, messageId: string): Promise<void> {
  const url = `${config.aimaestro.apiUrl}/api/messages?agent=${config.aimaestro.botAgent}&id=${encodeURIComponent(messageId)}&action=read`;

  await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(10000),
  });
}

/**
 * Send a confirmation message back to the requesting agent.
 */
async function sendConfirmation(
  config: GatewayConfig,
  toAgent: string,
  toHost: string,
  subject: string,
  message: string
): Promise<void> {
  const payload = {
    from: config.aimaestro.botAgent,
    fromHost: config.aimaestro.hostId,
    to: toAgent,
    toHost: toHost,
    subject,
    priority: 'low',
    content: {
      type: 'notification',
      message,
    },
  };

  await fetch(`${config.aimaestro.apiUrl}/api/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000),
  });
}

/**
 * Check if a message is an outbound WhatsApp request.
 */
function isWhatsAppSendMessage(msg: any): boolean {
  if (msg.subject?.startsWith('[WHATSAPP-SEND]')) return true;
  if (msg.content?.type === 'whatsappSend') return true;
  if (msg.content?.whatsappSend) return true;
  return false;
}

/**
 * Extract the WhatsApp send payload from an AI Maestro message.
 */
function extractSendPayload(msg: any): WhatsAppSendPayload | null {
  const send = msg.content?.whatsappSend;
  if (!send) return null;

  if (!send.to || !send.message) {
    console.error('[OUTBOUND] Incomplete whatsappSend payload:', JSON.stringify(send));
    return null;
  }

  return {
    to: send.to,
    message: send.message,
    quotedMessageId: send.quotedMessageId,
    accountId: send.accountId,
  };
}

/**
 * Send a text message via Baileys.
 * Chunks long messages to respect WhatsApp's limits.
 */
async function sendViaWhatsApp(
  payload: WhatsAppSendPayload,
  config: GatewayConfig
): Promise<{ success: boolean; error?: string }> {
  const sock = getSocket();
  if (!sock) {
    return { success: false, error: 'WhatsApp not connected' };
  }

  if (getStatus() !== 'connected') {
    return { success: false, error: `WhatsApp status: ${getStatus()}` };
  }

  const jid = normalizeTarget(payload.to);
  if (!jid) {
    return { success: false, error: `Invalid target: ${payload.to}` };
  }

  // Chunk long messages
  const chunks = chunkText(payload.message, config.whatsapp.textChunkLimit);

  try {
    for (let i = 0; i < chunks.length; i++) {
      const msgContent: any = { text: chunks[i] };

      // Quote only on the first chunk
      if (i === 0 && payload.quotedMessageId) {
        msgContent.quoted = {
          key: {
            remoteJid: jid,
            id: payload.quotedMessageId,
          },
        };
      }

      await sock.sendMessage(jid, msgContent);
    }

    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/**
 * Chunk text into segments that fit WhatsApp's limits.
 */
function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }

    // Try to break at a newline
    let breakPoint = remaining.lastIndexOf('\n', limit);
    if (breakPoint < limit * 0.5) {
      // Try to break at a space
      breakPoint = remaining.lastIndexOf(' ', limit);
    }
    if (breakPoint < limit * 0.3) {
      // Hard break
      breakPoint = limit;
    }

    chunks.push(remaining.slice(0, breakPoint));
    remaining = remaining.slice(breakPoint).trimStart();
  }

  return chunks;
}

// Track in-flight messages to prevent duplicate sends
const inFlightMessages = new Set<string>();

/**
 * Process a single outbound WhatsApp request.
 */
async function processOutboundMessage(config: GatewayConfig, msgSummary: any): Promise<void> {
  const messageId = msgSummary.id;
  const fromAgent = msgSummary.from;
  const fromHost = msgSummary.fromHost || config.aimaestro.hostId;

  if (inFlightMessages.has(messageId)) return;
  inFlightMessages.add(messageId);

  console.log(`[OUTBOUND] Processing WhatsApp request from ${fromAgent}: ${msgSummary.subject}`);

  try {
    // Mark as read immediately
    await markAsRead(config, messageId);

    // Fetch full message
    const fullMsg = await fetchMessage(config, messageId);

    const payload = extractSendPayload(fullMsg);
    if (!payload) {
      console.error(`[OUTBOUND] Could not extract send payload from message ${messageId}`);
      inFlightMessages.delete(messageId);
      return;
    }

    console.log(`[OUTBOUND] Sending to ${payload.to}: ${payload.message.slice(0, 80)}`);

    // Send via Baileys
    const result = await sendViaWhatsApp(payload, config);

    if (result.success) {
      console.log(`[OUTBOUND] Sent successfully to ${payload.to}`);

      logEvent('outbound', `WhatsApp sent to ${payload.to}`, {
        from: fromAgent,
        to: payload.to,
        subject: payload.message.slice(0, 80),
      });

      await sendConfirmation(
        config,
        fromAgent,
        fromHost,
        `[WHATSAPP-SENT] To: ${payload.to}`,
        `WhatsApp message sent to ${payload.to}\nPreview: ${payload.message.slice(0, 100)}`
      );
    } else {
      console.error(`[OUTBOUND] Send failed: ${result.error}`);

      logEvent('error', `WhatsApp send failed to ${payload.to}: ${result.error}`, {
        from: fromAgent,
        to: payload.to,
        error: result.error,
      });

      await sendConfirmation(
        config,
        fromAgent,
        fromHost,
        `[WHATSAPP-FAILED] To: ${payload.to}`,
        `Failed to send WhatsApp to ${payload.to}\nError: ${result.error}`
      );
    }
  } catch (err) {
    console.error(`[OUTBOUND] Error processing message ${messageId}:`, err);
  } finally {
    inFlightMessages.delete(messageId);
  }
}

/**
 * Poll the inbox once and process any outbound WhatsApp requests.
 */
async function pollOnce(config: GatewayConfig): Promise<void> {
  try {
    const messages = await fetchInbox(config);
    const waRequests = messages.filter(isWhatsAppSendMessage);

    if (waRequests.length > 0) {
      console.log(`[OUTBOUND] Found ${waRequests.length} outbound WhatsApp request(s)`);
    }

    const BATCH_SIZE = 5;
    for (let i = 0; i < waRequests.length; i += BATCH_SIZE) {
      const batch = waRequests.slice(i, i + BATCH_SIZE);
      await Promise.allSettled(batch.map(msg => processOutboundMessage(config, msg)));
    }
  } catch (err) {
    console.error('[OUTBOUND] Poll error:', (err as Error).message);
  }
}

/**
 * Start the outbound polling loop.
 * Uses setTimeout chain to prevent overlapping polls.
 * Returns a cleanup function to stop polling.
 */
export function startOutboundPoller(config: GatewayConfig): () => void {
  let isPolling = false;
  let pollTimeoutId: NodeJS.Timeout | null = null;
  let currentIntervalMs = config.outbound.pollIntervalMs;
  const MAX_INTERVAL_MS = 30000; // WhatsApp base is 5s, cap at 30s
  const BACKOFF_MULTIPLIER = 1.5;

  const poll = async () => {
    if (isPolling) return;
    isPolling = true;

    let foundMessages = false;
    try {
      const messages = await fetchInbox(config);
      const waRequests = messages.filter(isWhatsAppSendMessage);

      if (waRequests.length > 0) {
        foundMessages = true;
        console.log(`[OUTBOUND] Found ${waRequests.length} outbound WhatsApp request(s)`);

        const BATCH_SIZE = 5;
        for (let i = 0; i < waRequests.length; i += BATCH_SIZE) {
          const batch = waRequests.slice(i, i + BATCH_SIZE);
          await Promise.allSettled(batch.map(msg => processOutboundMessage(config, msg)));
        }
      }
    } catch (err) {
      console.error('[OUTBOUND] Poll error:', (err as Error).message);
    } finally {
      isPolling = false;
    }

    if (foundMessages) {
      currentIntervalMs = config.outbound.pollIntervalMs;
    } else {
      currentIntervalMs = Math.min(currentIntervalMs * BACKOFF_MULTIPLIER, MAX_INTERVAL_MS);
    }

    pollTimeoutId = setTimeout(poll, currentIntervalMs);
  };

  // Initial poll after short delay
  pollTimeoutId = setTimeout(poll, 3000);
  console.log(`[OUTBOUND] Starting poller (interval: ${config.outbound.pollIntervalMs}ms)`);

  return () => {
    if (pollTimeoutId) {
      clearTimeout(pollTimeoutId);
      pollTimeoutId = null;
    }
    console.log('[OUTBOUND] Poller stopped');
  };
}
