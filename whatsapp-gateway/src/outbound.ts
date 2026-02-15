/**
 * Outbound WhatsApp - Baileys Send + AMP Filesystem Inbox Polling
 *
 * Scans the gateway's AMP filesystem inbox for outbound WhatsApp requests,
 * then sends them via Baileys. Sends confirmations via AMP route.
 *
 * Message format expected from agents (in AMP envelope payload):
 * {
 *   type: "whatsappSend",
 *   message: "Human-readable description",
 *   context: {
 *     whatsappSend: {
 *       to: "+1234567890",
 *       message: "Hello!",
 *       quotedMessageId: "optional-stanza-id"
 *     }
 *   }
 * }
 */

import * as fs from 'fs';
import * as path from 'path';
import type { GatewayConfig, WhatsAppSendPayload, AMPMessage, AMPRouteRequest } from './types.js';
import { getSocket, getStatus } from './session.js';
import { normalizeTarget } from './normalize.js';
import { logEvent } from './api/activity-log.js';

/**
 * Send a confirmation message back to the requesting agent via AMP route.
 */
async function sendConfirmation(
  config: GatewayConfig,
  toAddress: string,
  subject: string,
  message: string
): Promise<void> {
  const ampRequest: AMPRouteRequest = {
    to: toAddress,
    subject,
    priority: 'low',
    payload: {
      type: 'notification',
      message,
    },
  };

  try {
    await fetch(`${config.amp.maestroUrl}/api/v1/route`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.amp.apiKey}`,
      },
      body: JSON.stringify(ampRequest),
      signal: AbortSignal.timeout(10000),
    });
  } catch (err) {
    console.error('[OUTBOUND] Failed to send confirmation:', (err as Error).message);
  }
}

/**
 * Check if an AMP message is an outbound WhatsApp request.
 */
function isWhatsAppSendMessage(msg: AMPMessage): boolean {
  const subject = msg.envelope?.subject || '';
  if (subject.startsWith('[WHATSAPP-SEND]')) return true;
  const payloadType = msg.payload?.type;
  if (payloadType === 'whatsappSend') return true;
  if (msg.payload?.context?.whatsappSend) return true;
  return false;
}

/**
 * Extract the WhatsApp send payload from an AMP message.
 */
function extractSendPayload(msg: AMPMessage): WhatsAppSendPayload | null {
  const send = msg.payload?.context?.whatsappSend;
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

  const chunks = chunkText(payload.message, config.whatsapp.textChunkLimit);

  try {
    for (let i = 0; i < chunks.length; i++) {
      const msgContent: any = { text: chunks[i] };

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

function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }

    let breakPoint = remaining.lastIndexOf('\n', limit);
    if (breakPoint < limit * 0.5) {
      breakPoint = remaining.lastIndexOf(' ', limit);
    }
    if (breakPoint < limit * 0.3) {
      breakPoint = limit;
    }

    chunks.push(remaining.slice(0, breakPoint));
    remaining = remaining.slice(breakPoint).trimStart();
  }

  return chunks;
}

/**
 * Scan the AMP filesystem inbox for outbound WhatsApp requests.
 */
async function scanInbox(config: GatewayConfig): Promise<void> {
  const inboxDir = config.amp.inboxDir;
  if (!inboxDir || !fs.existsSync(inboxDir)) return;

  let senderDirs: string[];
  try {
    senderDirs = fs.readdirSync(inboxDir).filter(d => {
      const full = path.join(inboxDir, d);
      return fs.statSync(full).isDirectory();
    });
  } catch {
    return;
  }

  for (const senderDir of senderDirs) {
    const senderPath = path.join(inboxDir, senderDir);
    let files: string[];
    try {
      files = fs.readdirSync(senderPath).filter(f => f.endsWith('.json'));
    } catch {
      continue;
    }

    for (const file of files) {
      const filePath = path.join(senderPath, file);
      let msg: AMPMessage;
      try {
        msg = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      } catch {
        console.error(`[OUTBOUND] Failed to parse ${filePath}`);
        continue;
      }

      const fromAddress = msg.envelope?.from || senderDir;

      if (isWhatsAppSendMessage(msg)) {
        const payload = extractSendPayload(msg);
        if (!payload) {
          console.error(`[OUTBOUND] Could not extract send payload from ${filePath}`);
          try { fs.unlinkSync(filePath); } catch {}
          continue;
        }

        console.log(`[OUTBOUND] Sending to ${payload.to}: ${payload.message.slice(0, 80)}`);

        const result = await sendViaWhatsApp(payload, config);

        if (result.success) {
          console.log(`[OUTBOUND] Sent successfully to ${payload.to}`);

          logEvent('outbound', `WhatsApp sent to ${payload.to}`, {
            from: fromAddress,
            to: payload.to,
            subject: payload.message.slice(0, 80),
            ampMessageId: msg.envelope?.id,
            deliveryStatus: 'sent',
          });

          await sendConfirmation(
            config,
            fromAddress,
            `[WHATSAPP-SENT] To: ${payload.to}`,
            `WhatsApp message sent to ${payload.to}\nPreview: ${payload.message.slice(0, 100)}`
          );
        } else {
          console.error(`[OUTBOUND] Send failed: ${result.error}`);

          logEvent('error', `WhatsApp send failed to ${payload.to}: ${result.error}`, {
            from: fromAddress,
            to: payload.to,
            error: result.error,
          });

          await sendConfirmation(
            config,
            fromAddress,
            `[WHATSAPP-FAILED] To: ${payload.to}`,
            `Failed to send WhatsApp to ${payload.to}\nError: ${result.error}`
          );
        }
      }

      // Delete processed message file
      try {
        fs.unlinkSync(filePath);
      } catch {}
    }

    // Clean up empty sender directories
    try {
      const remaining = fs.readdirSync(senderPath);
      if (remaining.length === 0) {
        fs.rmdirSync(senderPath);
      }
    } catch {}
  }
}

/**
 * Start the outbound polling loop.
 * Scans the AMP filesystem inbox for WhatsApp requests.
 */
export function startOutboundPoller(config: GatewayConfig): () => void {
  let pollTimeoutId: NodeJS.Timeout | null = null;

  const poll = async () => {
    try {
      await scanInbox(config);
    } catch (err) {
      console.error('[OUTBOUND] Poll error:', (err as Error).message);
    }
    pollTimeoutId = setTimeout(poll, config.outbound.pollIntervalMs);
  };

  // Initial poll after short delay
  pollTimeoutId = setTimeout(poll, 3000);
  console.log(`[OUTBOUND] Starting filesystem poller (interval: ${config.outbound.pollIntervalMs}ms)`);

  return () => {
    if (pollTimeoutId) {
      clearTimeout(pollTimeoutId);
      pollTimeoutId = null;
    }
    console.log('[OUTBOUND] Poller stopped');
  };
}
