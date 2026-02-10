/**
 * Outbound Email - Mandrill Send API + AI Maestro Inbox Polling
 *
 * Polls the gateway's AI Maestro inbox for outbound email requests from agents,
 * then sends them via the Mandrill transactional API.
 *
 * Message format expected from agents:
 * {
 *   subject: "[EMAIL-REPLY] ..." or any subject,
 *   content: {
 *     type: "emailReply",
 *     message: "Human-readable description",
 *     emailReply: {
 *       from: "agent@tenant.example.com",
 *       fromName: "Agent Name",
 *       to: "recipient@example.com",
 *       subject: "Re: Original Subject",
 *       body: "The reply text (plain text)",
 *       html: "<p>HTML body</p>" (optional),
 *       inReplyTo: "<original-message-id>" (optional, for threading),
 *       attachments: [{ type: "application/pdf", name: "file.pdf", content: "base64..." }] (optional)
 *     }
 *   }
 * }
 */

import { GatewayConfig } from './config.js';

interface EmailAttachment {
  type: string;    // MIME type (e.g. "application/pdf")
  name: string;    // filename (e.g. "invoice.pdf")
  content: string; // base64-encoded file content
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
 * Check if a message is an outbound email request.
 */
function isEmailReplyMessage(msg: any): boolean {
  // Check subject prefix
  if (msg.subject?.startsWith('[EMAIL-REPLY]')) return true;
  // Check content type
  if (msg.content?.type === 'emailReply') return true;
  if (msg.content?.emailReply) return true;
  return false;
}

/**
 * Extract the email reply payload from an AI Maestro message.
 */
function extractReplyPayload(msg: any): EmailReplyPayload | null {
  const reply = msg.content?.emailReply;
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

// Track in-flight messages to prevent duplicate sends across poll cycles
const inFlightMessages = new Set<string>();

/**
 * Process a single outbound email request.
 */
async function processOutboundMessage(config: GatewayConfig, msgSummary: any): Promise<void> {
  const messageId = msgSummary.id;
  const fromAgent = msgSummary.from;
  const fromHost = msgSummary.fromHost || config.aimaestro.hostId;

  // Skip if already being processed
  if (inFlightMessages.has(messageId)) {
    return;
  }
  inFlightMessages.add(messageId);

  console.log(`[OUTBOUND] Processing email request from ${fromAgent}: ${msgSummary.subject}`);

  try {
    // Mark as read immediately to prevent duplicate pickup on next poll
    await markAsRead(config, messageId);

    // Fetch full message content
    const fullMsg = await fetchMessage(config, messageId);

    const reply = extractReplyPayload(fullMsg);
    if (!reply) {
      console.error(`[OUTBOUND] Could not extract reply payload from message ${messageId}`);
      inFlightMessages.delete(messageId);
      return;
    }

    const attachCount = reply.attachments?.length || 0;
    const ccInfo = reply.cc ? ` (CC: ${reply.cc})` : '';
    console.log(`[OUTBOUND] Sending: ${reply.from} → ${reply.to}${ccInfo} | ${reply.subject}${attachCount > 0 ? ` (${attachCount} attachment${attachCount > 1 ? 's' : ''})` : ''}`);

    // Send via Mandrill
    const results = await sendViaMandrill(config, reply);
    const result = results[0];

    if (result.status === 'sent' || result.status === 'queued') {
      console.log(`[OUTBOUND] Sent successfully (${result.status}): ${result._id || 'no-id'}`);

      // Send confirmation back to requesting agent
      await sendConfirmation(
        config,
        fromAgent,
        fromHost,
        `[EMAIL-SENT] ${reply.subject}`,
        `Email sent to ${reply.to}\nSubject: ${reply.subject}\nStatus: ${result.status}\nMandrill ID: ${result._id || 'n/a'}`
      );
    } else {
      console.error(`[OUTBOUND] Mandrill rejected: ${result.status} - ${result.reject_reason}`);

      await sendConfirmation(
        config,
        fromAgent,
        fromHost,
        `[EMAIL-FAILED] ${reply.subject}`,
        `Failed to send email to ${reply.to}\nStatus: ${result.status}\nReason: ${result.reject_reason || 'unknown'}`
      );
    }
  } catch (err) {
    console.error(`[OUTBOUND] Error processing message ${messageId}:`, err);
  } finally {
    inFlightMessages.delete(messageId);
  }
}

/**
 * Poll the inbox once and process any outbound email requests.
 */
async function pollOnce(config: GatewayConfig): Promise<void> {
  try {
    const messages = await fetchInbox(config);

    // Filter for email reply requests
    const emailRequests = messages.filter(isEmailReplyMessage);

    if (emailRequests.length > 0) {
      console.log(`[OUTBOUND] Found ${emailRequests.length} outbound email request(s)`);
    }

    const BATCH_SIZE = 5;
    for (let i = 0; i < emailRequests.length; i += BATCH_SIZE) {
      const batch = emailRequests.slice(i, i + BATCH_SIZE);
      await Promise.allSettled(batch.map(msg => processOutboundMessage(config, msg)));
    }
  } catch (err) {
    console.error('[OUTBOUND] Poll error:', err);
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
  const MAX_INTERVAL_MS = 60000; // email can use 60s max since base is already 30s
  const BACKOFF_MULTIPLIER = 1.5;

  const poll = async () => {
    if (isPolling) return;
    isPolling = true;

    let foundMessages = false;
    try {
      const messages = await fetchInbox(config);
      const emailRequests = messages.filter(isEmailReplyMessage);

      if (emailRequests.length > 0) {
        foundMessages = true;
        console.log(`[OUTBOUND] Found ${emailRequests.length} outbound email request(s)`);

        const BATCH_SIZE = 5;
        for (let i = 0; i < emailRequests.length; i += BATCH_SIZE) {
          const batch = emailRequests.slice(i, i + BATCH_SIZE);
          await Promise.allSettled(batch.map(msg => processOutboundMessage(config, msg)));
        }
      }
    } catch (err) {
      console.error('[OUTBOUND] Poll error:', err);
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
  pollTimeoutId = setTimeout(poll, 5000);
  console.log(`[OUTBOUND] Starting poller (interval: ${config.outbound.pollIntervalMs}ms)`);

  return () => {
    if (pollTimeoutId) {
      clearTimeout(pollTimeoutId);
      pollTimeoutId = null;
    }
    console.log('[OUTBOUND] Poller stopped');
  };
}
