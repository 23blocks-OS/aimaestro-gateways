/**
 * WhatsApp Inbound Message Handler
 *
 * Processes incoming WhatsApp messages from Baileys and routes them
 * to AI Maestro agents. Handles DM policy, content security, and
 * read receipts.
 */

import type { proto } from '@whiskeysockets/baileys';
import type { GatewayConfig, WhatsAppInboundMessage } from './types.js';
import { jidToPhone, isGroupJid } from './normalize.js';
import { resolveRoute } from './router.js';
import { getSocket, getSelfJid } from './session.js';
import { sanitizeWhatsAppMessage, createSecurityConfig } from './content-security.js';
import { logEvent } from './api/activity-log.js';

/**
 * Check if a phone is in the allowlist.
 */
function isAllowed(phone: string, config: GatewayConfig): boolean {
  if (config.whatsapp.dmPolicy === 'open') return true;
  if (config.whatsapp.dmPolicy === 'disabled') return false;

  // allowlist mode
  if (config.whatsapp.allowFrom.length === 0) return true; // empty = allow all
  return config.whatsapp.allowFrom.includes(phone);
}

/**
 * Extract text and metadata from a Baileys message.
 */
function extractMessage(msg: proto.IWebMessageInfo, config: GatewayConfig): WhatsAppInboundMessage | null {
  const key = msg.key;
  if (!key?.remoteJid) return null;

  const chatJid = key.remoteJid;

  // Skip status/broadcast
  if (chatJid === 'status@broadcast') return null;

  // Skip groups for Phase 1
  if (isGroupJid(chatJid)) return null;

  // Skip messages from self
  const selfJid = getSelfJid();
  if (key.fromMe && selfJid) return null;

  // Extract sender phone
  const senderJid = key.participant || chatJid;
  const phone = jidToPhone(senderJid);
  if (!phone) return null;

  // Check DM policy
  if (!isAllowed(phone, config)) {
    if (config.debug) {
      console.log(`[INBOUND] Blocked message from ${phone} (DM policy: ${config.whatsapp.dmPolicy})`);
    }
    return null;
  }

  // Extract text body
  const messageContent = msg.message;
  if (!messageContent) return null;

  let textBody = '';
  let hasMedia = false;
  let mediaType: string | null = null;

  if (messageContent.conversation) {
    textBody = messageContent.conversation;
  } else if (messageContent.extendedTextMessage?.text) {
    textBody = messageContent.extendedTextMessage.text;
  } else if (messageContent.imageMessage) {
    hasMedia = true;
    mediaType = 'image';
    textBody = messageContent.imageMessage.caption || '<media:image>';
  } else if (messageContent.videoMessage) {
    hasMedia = true;
    mediaType = 'video';
    textBody = messageContent.videoMessage.caption || '<media:video>';
  } else if (messageContent.audioMessage) {
    hasMedia = true;
    mediaType = 'audio';
    textBody = '<media:audio>';
  } else if (messageContent.documentMessage) {
    hasMedia = true;
    mediaType = 'document';
    textBody = messageContent.documentMessage.fileName || '<media:document>';
  } else if (messageContent.stickerMessage) {
    hasMedia = true;
    mediaType = 'sticker';
    textBody = '<media:sticker>';
  } else {
    // Unknown message type - skip
    return null;
  }

  // Extract quoted message context
  let quotedMessage = null;
  const contextInfo = messageContent.extendedTextMessage?.contextInfo;
  if (contextInfo?.quotedMessage) {
    const quotedText =
      contextInfo.quotedMessage.conversation ||
      contextInfo.quotedMessage.extendedTextMessage?.text ||
      '<media>';

    quotedMessage = {
      id: contextInfo.stanzaId || '',
      sender: contextInfo.participant ? (jidToPhone(contextInfo.participant) || contextInfo.participant) : '',
      body: quotedText,
    };
  }

  // Extract push name
  const fromName = msg.pushName || phone;

  return {
    from: phone,
    fromName,
    chatJid,
    messageId: key.id || '',
    isGroup: false,
    groupJid: null,
    groupName: null,
    textBody,
    quotedMessage,
    hasMedia,
    mediaType,
    timestamp: new Date((msg.messageTimestamp as number) * 1000).toISOString(),
  };
}

/**
 * Format the message body for the AI Maestro notification.
 * Includes quoted reply context when present.
 */
function formatBody(msg: WhatsAppInboundMessage): string {
  let body = msg.textBody;

  if (msg.quotedMessage) {
    body += `\n\n[Replying to ${msg.quotedMessage.sender} id:${msg.quotedMessage.id}]\n${msg.quotedMessage.body}\n[/Replying]`;
  }

  return body;
}

/**
 * Deliver an inbound WhatsApp message to AI Maestro.
 */
async function deliverToAiMaestro(
  msg: WhatsAppInboundMessage,
  config: GatewayConfig
): Promise<void> {
  const route = resolveRoute(msg.from, config);
  const securityConfig = createSecurityConfig(config.operatorPhones);

  const formattedBody = formatBody(msg);
  const { sanitized, trust, flags } = sanitizeWhatsAppMessage(
    formattedBody,
    msg.from,
    securityConfig
  );

  if (flags.length > 0) {
    console.log(`[SECURITY] ${flags.length} injection pattern(s) flagged from ${msg.from} (trust: ${trust.level})`);
    logEvent('security', `Injection patterns flagged from ${msg.from}`, {
      from: msg.from,
      to: route.agent,
      subject: msg.textBody.substring(0, 80),
      securityFlags: flags.map(f => `${f.category}: ${f.match}`),
    });
  }

  // Build the notification subject
  const preview = msg.textBody.slice(0, 50).replace(/\n/g, ' ');
  const subject = `[WHATSAPP] From: ${msg.fromName} (${msg.from}) - ${preview}`;

  const payload = {
    from: config.aimaestro.botAgent,
    fromHost: config.aimaestro.hostId,
    to: route.agent,
    toHost: route.host,
    subject,
    priority: 'normal',
    content: {
      type: 'notification',
      message: sanitized,
      whatsapp: {
        from: msg.from,
        fromName: msg.fromName,
        chatJid: msg.chatJid,
        messageId: msg.messageId,
        isGroup: msg.isGroup,
        groupJid: msg.groupJid,
        groupName: msg.groupName,
        // textBody removed: raw unsanitized text should not be in payload;
        // the sanitized version is already in content.message
        quotedMessage: msg.quotedMessage,
        hasMedia: msg.hasMedia,
        mediaType: msg.mediaType,
        timestamp: msg.timestamp,
      },
      security: {
        trust: trust.level,
        trustReason: trust.reason,
        injectionFlags: flags.length > 0 ? flags : undefined,
      },
    },
  };

  const response = await fetch(`${config.aimaestro.apiUrl}/api/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    throw new Error(`AI Maestro delivery failed: ${response.status}`);
  }

  console.log(`[INBOUND] Delivered: ${msg.from} → ${route.agent}@${route.host} (${route.matchType})`);

  logEvent('inbound', `WhatsApp message routed: ${msg.from} -> ${route.agent}`, {
    from: msg.from,
    to: route.agent,
    subject: msg.textBody.substring(0, 80),
  });
}

/**
 * Send a read receipt for a message.
 */
async function sendReadReceipt(msg: WhatsAppInboundMessage): Promise<void> {
  const sock = getSocket();
  if (!sock) return;

  try {
    await sock.readMessages([{
      remoteJid: msg.chatJid,
      id: msg.messageId,
    }]);
  } catch (err) {
    console.warn(`[INBOUND] Failed to send read receipt:`, (err as Error).message);
  }
}

/**
 * Handle an incoming Baileys message event.
 * This is the main entry point called from session.ts.
 */
export async function handleInboundMessage(
  rawMsg: proto.IWebMessageInfo,
  config: GatewayConfig
): Promise<void> {
  try {
    const msg = extractMessage(rawMsg, config);
    if (!msg) return;

    console.log(`[INBOUND] ${msg.from} (${msg.fromName}): ${msg.textBody.slice(0, 80)}`);

    // Deliver to AI Maestro
    await deliverToAiMaestro(msg, config);

    // Send read receipt
    if (config.whatsapp.sendReadReceipts) {
      await sendReadReceipt(msg);
    }
  } catch (err) {
    console.error('[INBOUND] Error handling message:', (err as Error).message);
  }
}
