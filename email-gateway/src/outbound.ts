/**
 * Outbound Email - Mandrill Send + AMP Filesystem Inbox Polling
 *
 * Scans the gateway's AMP filesystem inbox for outbound email requests,
 * then sends them via the Mandrill transactional API.
 * Sends confirmations back to requesting agents via AMP route.
 *
 * Message format expected from agents (in AMP envelope payload):
 * {
 *   type: "emailReply",
 *   message: "Human-readable description",
 *   context: {
 *     emailReply: {
 *       from: "agent@tenant.example.com",
 *       fromName: "Agent Name",
 *       to: "recipient@example.com",
 *       subject: "Re: Original Subject",
 *       body: "The reply text",
 *       html: "<p>HTML body</p>" (optional),
 *       inReplyTo: "<message-id>" (optional),
 *       cc: "cc@example.com" (optional),
 *       bcc: "bcc@example.com" (optional),
 *       attachments: [{ type: "...", name: "...", content: "base64..." }] (optional)
 *     }
 *   }
 * }
 */

import * as fs from 'fs';
import * as path from 'path';
import type { GatewayConfig, AMPMessage, AMPRouteRequest } from './types.js';
import { logEvent } from './api/activity-log.js';

interface EmailAttachment {
  type: string;
  name: string;
  content: string;
}

interface EmailReplyPayload {
  from: string;
  fromName?: string;
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  body: string;
  html?: string;
  inReplyTo?: string;
  attachments?: EmailAttachment[];
}

interface MandrillSendResult {
  email: string;
  status: 'sent' | 'queued' | 'rejected' | 'invalid';
  reject_reason?: string;
  _id?: string;
}

/**
 * Send an email via Mandrill transactional API.
 */
async function sendViaMandrill(
  config: GatewayConfig,
  reply: EmailReplyPayload
): Promise<MandrillSendResult[]> {
  const headers: Record<string, string> = {};
  if (reply.inReplyTo) {
    headers['In-Reply-To'] = reply.inReplyTo;
  }

  const message: Record<string, any> = {
    from_email: reply.from,
    from_name: reply.fromName || undefined,
    to: [
      { email: reply.to, type: 'to' as const },
      ...(reply.cc ? reply.cc.split(',').map(e => ({ email: e.trim(), type: 'cc' as const })) : []),
      ...(reply.bcc ? reply.bcc.split(',').map(e => ({ email: e.trim(), type: 'bcc' as const })) : []),
    ],
    subject: reply.subject,
    text: reply.body,
    preserve_recipients: !!(reply.cc || reply.bcc),
    headers: Object.keys(headers).length > 0 ? headers : undefined,
  };

  if (reply.html) {
    message.html = reply.html;
  }

  if (reply.attachments && reply.attachments.length > 0) {
    message.attachments = reply.attachments;
  }

  const payload = {
    key: config.mandrill.apiKey,
    message,
  };

  const response = await fetch('https://mandrillapp.com/api/1.0/messages/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Mandrill API error ${response.status}: ${errorBody}`);
  }

  return response.json() as Promise<MandrillSendResult[]>;
}

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
 * Check if an AMP message is an outbound email request.
 */
function isEmailReplyMessage(msg: AMPMessage): boolean {
  const subject = msg.envelope?.subject || '';
  if (subject.startsWith('[EMAIL-REPLY]')) return true;
  const payloadType = msg.payload?.type;
  if (payloadType === 'emailReply') return true;
  if (msg.payload?.context?.emailReply) return true;
  return false;
}

/**
 * Extract the email reply payload from an AMP message.
 */
function extractReplyPayload(msg: AMPMessage): EmailReplyPayload | null {
  const reply = msg.payload?.context?.emailReply;
  if (!reply) return null;

  if (!reply.from || !reply.to || !reply.subject || !reply.body) {
    console.error('[OUTBOUND] Incomplete emailReply payload:', JSON.stringify(reply));
    return null;
  }

  return {
    from: reply.from,
    fromName: reply.fromName,
    to: reply.to,
    cc: reply.cc,
    bcc: reply.bcc,
    subject: reply.subject,
    body: reply.body,
    html: reply.html,
    inReplyTo: reply.inReplyTo,
    attachments: reply.attachments,
  };
}

/**
 * Scan the AMP filesystem inbox for outbound email requests.
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

      if (isEmailReplyMessage(msg)) {
        const reply = extractReplyPayload(msg);
        if (!reply) {
          console.error(`[OUTBOUND] Could not extract reply payload from ${filePath}`);
          // Delete bad message to prevent re-processing
          try { fs.unlinkSync(filePath); } catch {}
          continue;
        }

        const attachCount = reply.attachments?.length || 0;
        const ccInfo = reply.cc ? ` (CC: ${reply.cc})` : '';
        console.log(`[OUTBOUND] Sending: ${reply.from} -> ${reply.to}${ccInfo} | ${reply.subject}${attachCount > 0 ? ` (${attachCount} attachment${attachCount > 1 ? 's' : ''})` : ''}`);

        try {
          const results = await sendViaMandrill(config, reply);
          const result = results[0];

          if (result.status === 'sent' || result.status === 'queued') {
            console.log(`[OUTBOUND] Sent successfully (${result.status}): ${result._id || 'no-id'}`);

            logEvent('outbound', `Email sent: ${reply.from} -> ${reply.to}`, {
              from: reply.from,
              to: reply.to,
              subject: reply.subject,
              ampMessageId: msg.envelope?.id,
              deliveryStatus: result.status,
            });

            await sendConfirmation(
              config,
              fromAddress,
              `[EMAIL-SENT] ${reply.subject}`,
              `Email sent to ${reply.to}\nSubject: ${reply.subject}\nStatus: ${result.status}\nMandrill ID: ${result._id || 'n/a'}`
            );
          } else {
            console.error(`[OUTBOUND] Mandrill rejected: ${result.status} - ${result.reject_reason}`);

            logEvent('error', `Email rejected by Mandrill: ${reply.to}`, {
              from: reply.from,
              to: reply.to,
              subject: reply.subject,
              error: `${result.status}: ${result.reject_reason}`,
            });

            await sendConfirmation(
              config,
              fromAddress,
              `[EMAIL-FAILED] ${reply.subject}`,
              `Failed to send email to ${reply.to}\nStatus: ${result.status}\nReason: ${result.reject_reason || 'unknown'}`
            );
          }
        } catch (err) {
          console.error(`[OUTBOUND] Error sending email:`, (err as Error).message);
          logEvent('error', `Email send error: ${reply.to}`, {
            from: reply.from,
            to: reply.to,
            error: (err as Error).message,
          });
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
 * Scans the AMP filesystem inbox for email requests.
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
  pollTimeoutId = setTimeout(poll, 5000);
  console.log(`[OUTBOUND] Starting filesystem poller (interval: ${config.outbound.pollIntervalMs}ms)`);

  return () => {
    if (pollTimeoutId) {
      clearTimeout(pollTimeoutId);
      pollTimeoutId = null;
    }
    console.log('[OUTBOUND] Poller stopped');
  };
}
