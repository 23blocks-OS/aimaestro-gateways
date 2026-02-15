/**
 * WhatsApp Inbound Message Handler (AMP Protocol)
 *
 * Processes incoming WhatsApp messages from Baileys and routes them
 * to AI Maestro agents via AMP protocol. Handles DM policy, content
 * security, and read receipts.
 */

import type { proto } from '@whiskeysockets/baileys';
import type { GatewayConfig, WhatsAppInboundMessage, AMPRouteRequest, AMPRouteResponse } from './types.js';
import { jidToPhone, isGroupJid } from './normalize.js';
import { resolveRoute } from './router.js';
import { getSocket, getSelfJid } from './session.js';
import { sanitizeWhatsAppMessage, createSecurityConfig } from './content-security.js';
import { logEvent } from './api/activity-log.js';

function isAllowed(phone: string, config: GatewayConfig): boolean {
  if (config.whatsapp.dmPolicy === 'open') return true;
  if (config.whatsapp.dmPolicy === 'disabled') return false;
  if (config.whatsapp.allowFrom.length === 0) return true;
  return config.whatsapp.allowFrom.includes(phone);
}

function extractMessage(msg: proto.IWebMessageInfo, config: GatewayConfig): WhatsAppInboundMessage | null {
  const key = msg.key;
  if (!key?.remoteJid) return null;

  const chatJid = key.remoteJid;
  if (chatJid === 'status@broadcast') return null;
  if (isGroupJid(chatJid)) return null;

  const selfJid = getSelfJid();
  if (key.fromMe && selfJid) return null;

  const senderJid = key.participant || chatJid;
  const phone = jidToPhone(senderJid);
  if (!phone) return null;

  if (!isAllowed(phone, config)) {
    if (config.debug) {
      console.log(`[INBOUND] Blocked message from ${phone} (DM policy: ${config.whatsapp.dmPolicy})`);
    }
    return null;
  }

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
    return null;
  }

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

function formatBody(msg: WhatsAppInboundMessage): string {
  let body = msg.textBody;

  if (msg.quotedMessage) {
    body += `\n\n[Replying to ${msg.quotedMessage.sender} id:${msg.quotedMessage.id}]\n${msg.quotedMessage.body}\n[/Replying]`;
  }

  return body;
}

/**
 * Deliver an inbound WhatsApp message to an agent via AMP route.
 */
async function deliverViaAMP(
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
      to: route.displayName,
      subject: msg.textBody.substring(0, 80),
      securityFlags: flags.map(f => `${f.category}: ${f.match}`),
    });
  }

  const preview = msg.textBody.slice(0, 50).replace(/\n/g, ' ');
  const subject = `[WHATSAPP] From: ${msg.fromName} (${msg.from}) - ${preview}`;

  const ampRequest: AMPRouteRequest = {
    to: route.agentAddress,
    subject,
    priority: 'normal',
    payload: {
      type: 'notification',
      message: sanitized,
      context: {
        channel: {
          type: 'whatsapp',
          sender: msg.from,
          sender_name: msg.fromName,
          bridge_agent: config.amp.agentAddress,
          received_at: new Date().toISOString(),
        },
        whatsapp: {
          from: msg.from,
          fromName: msg.fromName,
          chatJid: msg.chatJid,
          messageId: msg.messageId,
          isGroup: msg.isGroup,
          groupJid: msg.groupJid,
          groupName: msg.groupName,
          quotedMessage: msg.quotedMessage,
          hasMedia: msg.hasMedia,
          mediaType: msg.mediaType,
          timestamp: msg.timestamp,
        },
        security: {
          trust: trust.level,
          source: 'whatsapp',
          scanned: true,
          injection_flags: flags.map(f => f.category),
          scanned_at: new Date().toISOString(),
        },
      },
    },
  };

  const response = await fetch(`${config.amp.maestroUrl}/api/v1/route`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.amp.apiKey}`,
    },
    body: JSON.stringify(ampRequest),
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    throw new Error(`AMP route failed: ${response.status}`);
  }

  const result = await response.json() as AMPRouteResponse;

  console.log(`[INBOUND] Delivered via AMP: ${msg.from} -> ${route.agentAddress} (${route.matchType})`);

  logEvent('inbound', `WhatsApp message routed: ${msg.from} -> ${route.displayName}`, {
    from: msg.from,
    to: route.displayName,
    subject: msg.textBody.substring(0, 80),
    ampMessageId: result.id,
    deliveryStatus: result.status,
  });
}

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

export async function handleInboundMessage(
  rawMsg: proto.IWebMessageInfo,
  config: GatewayConfig
): Promise<void> {
  try {
    const msg = extractMessage(rawMsg, config);
    if (!msg) return;

    console.log(`[INBOUND] ${msg.from} (${msg.fromName}): ${msg.textBody.slice(0, 80)}`);

    await deliverViaAMP(msg, config);

    if (config.whatsapp.sendReadReceipts) {
      await sendReadReceipt(msg);
    }
  } catch (err) {
    console.error('[INBOUND] Error handling message:', (err as Error).message);
  }
}
