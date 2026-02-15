/**
 * AI Maestro - Email Gateway (AMP Protocol)
 *
 * Receives Mandrill inbound webhooks and routes emails to AI Maestro agents
 * via AMP protocol. Polls filesystem inbox for outbound email requests and
 * sends via Mandrill API. Serves management UI as a static SPA.
 *
 * URL pattern: https://email.{tenant}.{EMAIL_BASE_DOMAIN}/inbound
 */

import express, { Request, Response, NextFunction } from 'express';
import crypto, { timingSafeEqual } from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadConfig } from './config.js';
import { resolveRoute } from './router.js';
import { startOutboundPoller } from './outbound.js';
import { loadSecurityConfig, sanitizeEmail, type SecurityConfig, type EmailAuthResult } from './content-security.js';
import { logEvent } from './api/activity-log.js';
import { createConfigRouter } from './api/config-api.js';
import { createActivityRouter } from './api/activity-api.js';
import { createStatsRouter } from './api/stats-api.js';
import type { GatewayConfig, AMPRouteRequest, AMPRouteResponse } from './types.js';

const __filename_local = fileURLToPath(import.meta.url);
const __dirname_local = path.dirname(__filename_local);

function authMiddleware(adminToken: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!adminToken) {
      console.warn('[AUTH] No ADMIN_TOKEN configured - API access is unrestricted');
      return next();
    }
    const auth = req.headers.authorization || '';
    const expected = `Bearer ${adminToken}`;
    if (auth.length === expected.length && timingSafeEqual(Buffer.from(auth), Buffer.from(expected))) {
      return next();
    }
    res.status(401).json({ error: 'Unauthorized' });
  };
}

/**
 * Verify Mandrill webhook signature
 */
function verifyMandrillSignature(
  webhookKey: string,
  url: string,
  params: Record<string, string>,
  signature: string
): boolean {
  let signedData = url;
  const sortedKeys = Object.keys(params).sort();
  for (const key of sortedKeys) {
    signedData += key + params[key];
  }

  const expectedSignature = crypto
    .createHmac('sha1', webhookKey)
    .update(signedData)
    .digest('base64');

  const sigBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expectedSignature);
  if (sigBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(sigBuf, expectedBuf);
}

interface SavedAttachment {
  name: string;
  type: string;
  size: number;
  path: string;
}

async function saveAttachments(
  agentName: string,
  msgId: string,
  attachments: Record<string, any>,
  quarantine: boolean,
): Promise<SavedAttachment[]> {
  const basePath = config.storage.attachmentsPath;
  const date = new Date().toISOString().slice(0, 10);
  const folder = quarantine ? 'quarantine' : 'inbox';
  const dir = path.join(basePath, agentName, folder, date, msgId);

  await fs.promises.mkdir(dir, { recursive: true });

  const saved: SavedAttachment[] = [];

  for (const [key, att] of Object.entries(attachments)) {
    const name = att.name || key;
    const safeName = name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const filePath = path.join(dir, safeName);

    const content = att.base64
      ? Buffer.from(att.content, 'base64')
      : Buffer.from(att.content);

    await fs.promises.writeFile(filePath, content);

    saved.push({
      name: att.name || key,
      type: att.type || 'application/octet-stream',
      size: content.length,
      path: filePath,
    });

    console.log(`  Attachment saved: ${safeName} (${content.length} bytes) -> ${folder}/`);
  }

  const metadata = {
    savedAt: new Date().toISOString(),
    agent: agentName,
    folder,
    files: saved.map(s => ({ name: s.name, type: s.type, size: s.size })),
  };
  await fs.promises.writeFile(path.join(dir, '_metadata.json'), JSON.stringify(metadata, null, 2));

  return saved;
}

/**
 * Forward an inbound email to an AI Maestro agent via AMP route.
 */
async function forwardToAgent(
  tenant: string,
  toEmail: string,
  agentAddress: string,
  displayName: string,
  msg: any,
  authResult?: EmailAuthResult
): Promise<void> {
  const attachments = msg.attachments || {};
  const attachmentCount = Object.keys(attachments).length;

  const sanitized = sanitizeEmail(msg, securityConfig, authResult);
  const hasSecurityFlags = sanitized.flags.length > 0;

  if (hasSecurityFlags) {
    console.log(`  [SECURITY] ${sanitized.flags.length} injection pattern(s) flagged (trust: ${sanitized.trust.level})`);
    for (const flag of sanitized.flags) {
      console.log(`    - ${flag.category}: "${flag.match}"`);
    }
    logEvent('security', `Injection patterns flagged in email from ${msg.from_email}`, {
      from: msg.from_email,
      to: toEmail,
      subject: msg.subject,
      tenant,
      securityFlags: sanitized.flags.map((f: any) => `${f.category}: ${f.match}`),
    });
  } else if (sanitized.trust.level !== 'operator') {
    console.log(`  [SECURITY] Content wrapped (trust: ${sanitized.trust.level})`);
  }

  // Save attachments
  let savedAttachments: SavedAttachment[] = [];
  if (attachmentCount > 0) {
    const msgId = (msg.headers?.['Message-Id'] || `${Date.now()}`).replace(/[<>]/g, '').replace(/[^a-zA-Z0-9._@-]/g, '_');
    const quarantine = hasSecurityFlags;
    try {
      savedAttachments = await saveAttachments(displayName, msgId, attachments, quarantine);
      console.log(`  Saved ${savedAttachments.length} attachment(s) to ${quarantine ? 'quarantine' : 'inbox'}`);
    } catch (err) {
      console.error(`  Failed to save attachments:`, err);
      logEvent('error', `Failed to save attachments for ${msg.from_email}`, { error: (err as Error).message });
    }
  }

  // Build AMP route request
  const ampRequest: AMPRouteRequest = {
    to: agentAddress,
    subject: `[EMAIL] From: ${msg.from_name || msg.from_email} - ${msg.subject}`,
    priority: 'normal',
    payload: {
      type: 'notification',
      message: `New email from ${msg.from_name || ''} <${msg.from_email}>\nTo: ${toEmail}\nSubject: ${msg.subject}`,
      context: {
        channel: {
          type: 'email',
          sender: msg.from_email,
          sender_name: msg.from_name || null,
          recipient: toEmail,
          bridge_agent: config.amp.agentAddress,
          received_at: new Date().toISOString(),
        },
        email: {
          from: msg.from_email,
          fromName: msg.from_name || null,
          to: toEmail,
          subject: sanitized.subject,
          textBody: sanitized.textBody,
          htmlBody: sanitized.htmlBody,
          tenant,
          hasAttachments: attachmentCount > 0,
          attachmentCount,
          attachments: savedAttachments.length > 0 ? savedAttachments.map(a => ({
            name: a.name,
            type: a.type,
            size: a.size,
            path: a.path,
          })) : undefined,
          messageId: msg.headers?.['Message-Id'] || null,
          inReplyTo: msg.headers?.['In-Reply-To'] || null,
        },
        security: {
          trust: sanitized.trust.level,
          trustReason: sanitized.trust.reason,
          source: 'email',
          scanned: true,
          injection_flags: hasSecurityFlags ? sanitized.flags.map((f: any) => f.category) : [],
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
    const body = await response.text();
    throw new Error(`AMP route failed (${response.status}): ${body}`);
  }

  const result = await response.json() as AMPRouteResponse;
  if (config.debug) {
    console.log(`  AMP message ID: ${result.id || 'unknown'}`);
  }

  logEvent('inbound', `Email routed via AMP: ${msg.from_email} -> ${displayName}`, {
    from: msg.from_email,
    to: toEmail,
    subject: msg.subject,
    tenant,
    ampMessageId: result.id,
    deliveryStatus: result.status,
  });
}

function extractTenant(hostname: string): string {
  const parts = hostname.split('.');
  if (parts.length >= 3) {
    return parts[1];
  }
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Main entry point (async for config loading)
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Load config (async — may trigger AMP auto-registration)
  let configLoaded: GatewayConfig;
  let secConfigLoaded: SecurityConfig;
  try {
    configLoaded = await loadConfig();
    secConfigLoaded = loadSecurityConfig();
  } catch (err) {
    console.error('[FATAL] Failed to load config:', err);
    process.exit(1);
  }

  // Assign to module-level vars for use in handlers
  config = configLoaded;
  securityConfig = secConfigLoaded;

  const ALLOWED_TENANTS = new Set(Object.keys(config.mandrill.webhookKeys));

  const app = express();
  app.use(express.urlencoded({ extended: true, limit: '25mb' }));
  app.use(express.json({ limit: '25mb' }));

  app.use((req, res, next) => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${req.method} ${req.hostname}${req.path}`);
    next();
  });

  // Management API routes
  app.use('/api', authMiddleware(config.adminToken));

  app.use('/api/config', createConfigRouter(
    () => config,
    () => securityConfig,
    (newConfig) => { securityConfig = newConfig; },
    config.adminToken
  ));

  app.use('/api/activity', createActivityRouter());
  app.use('/api/stats', createStatsRouter(() => config));

  // Health check
  app.get('/health', (req: Request, res: Response) => {
    res.json({
      status: 'ok',
      service: 'email-gateway',
      protocol: 'AMP',
      tenants: Array.from(ALLOWED_TENANTS),
      routes: Object.keys(config.routing.routes).length,
      defaults: Object.keys(config.routing.defaults).length,
      amp: {
        agent: config.amp.agentAddress,
        maestro: config.amp.maestroUrl,
        tenant: config.amp.tenant,
      },
      timestamp: new Date().toISOString(),
    });
  });

  // Mandrill webhook validation
  app.head('/inbound', (req: Request, res: Response) => {
    const tenant = extractTenant(req.hostname);
    console.log(`[VALIDATION] Mandrill validating webhook for tenant: ${tenant}`);
    res.status(200).end();
  });

  // Mandrill inbound webhook
  app.post('/inbound', async (req: Request, res: Response) => {
    const tenant = extractTenant(req.hostname);

    if (!ALLOWED_TENANTS.has(tenant)) {
      console.log(`[SECURITY] Rejected unknown tenant: ${tenant}`);
      logEvent('security', `Rejected unknown tenant: ${tenant}`, { tenant });
      return res.status(403).json({ error: 'Unknown tenant' });
    }

    try {
      const eventsRaw = req.body.mandrill_events;

      if (!eventsRaw) {
        console.log(`[${tenant}] Validation ping (no mandrill_events) - returning 200`);
        return res.status(200).json({ received: true, events: 0 });
      }

      // Verify Mandrill signature
      const signature = req.headers['x-mandrill-signature'] as string;
      const webhookKey = config.mandrill.webhookKeys[tenant];
      const webhookUrl = `https://email.${tenant}.${config.emailBaseDomain}/inbound`;

      if (signature && webhookKey) {
        const isValid = verifyMandrillSignature(webhookKey, webhookUrl, req.body, signature);
        if (!isValid) {
          console.warn(`[SECURITY] Signature mismatch for tenant: ${tenant}`);
          logEvent('security', `Webhook signature mismatch for tenant ${tenant}`, { tenant });
          return res.status(403).json({ error: 'Invalid webhook signature' });
        }
        console.log(`[${tenant}] Signature verified`);
      } else if (!signature && webhookKey) {
        console.warn(`[SECURITY] No signature provided for tenant ${tenant}`);
        return res.status(403).json({ error: 'Missing webhook signature' });
      } else if (!signature && !webhookKey) {
        console.warn(`[${tenant}] Warning: No webhook key configured`);
      }

      const events = JSON.parse(eventsRaw);
      console.log(`[${tenant}] Received ${events.length} email event(s)`);

      let routed = 0;
      let unroutable = 0;

      for (const event of events) {
        if (event.event !== 'inbound') continue;

        const msg = event.msg;
        const toEmail = msg.to?.[0]?.[0] || '';

        const authResult: EmailAuthResult = {
          spf: msg.spf?.result || 'none',
          dkim: msg.dkim?.valid !== undefined ? { valid: !!msg.dkim.valid } : undefined,
          dmarc: msg.dmarc?.result || 'none',
        };

        console.log(`[${tenant}] Email received:`);
        console.log(`  From: ${msg.from_name} <${msg.from_email}>`);
        console.log(`  To: ${toEmail}`);
        console.log(`  Subject: ${msg.subject}`);
        console.log(`  Auth: SPF=${authResult.spf}, DKIM=${authResult.dkim?.valid ?? 'none'}, DMARC=${authResult.dmarc}`);

        const route = await resolveRoute(toEmail, tenant, config);

        if (route) {
          console.log(`  Route: ${route.agentAddress} (${route.matchType})`);
          try {
            await forwardToAgent(tenant, toEmail, route.agentAddress, route.displayName, msg, authResult);
            console.log(`  Forwarded via AMP`);
            routed++;
          } catch (err) {
            console.error(`  Failed to forward via AMP:`, err);
            logEvent('error', `Failed to forward email from ${msg.from_email}`, {
              from: msg.from_email,
              to: toEmail,
              subject: msg.subject,
              tenant,
              error: (err as Error).message,
            });
          }
        } else {
          console.log(`  No route found for ${toEmail}`);
          unroutable++;
          logEvent('error', `No route found for ${toEmail}`, {
            from: msg.from_email,
            to: toEmail,
            subject: msg.subject,
            tenant,
            error: 'unroutable',
          });
        }
      }

      console.log(`[${tenant}] Processed: ${routed} routed, ${unroutable} unroutable`);
      res.status(200).json({ received: true, events: events.length, routed, unroutable });

    } catch (error) {
      console.error(`[${tenant}] Error processing webhook:`, error);
      logEvent('error', `Webhook processing error for tenant ${tenant}`, {
        tenant,
        error: (error as Error).message,
      });
      res.status(200).json({ received: true, error: 'Processing error' });
    }
  });

  // Static file serving (UI)
  const uiDistPath = path.resolve(__dirname_local, '..', 'ui', 'dist');
  app.use(express.static(uiDistPath));

  app.get('*', (req: Request, res: Response) => {
    if (req.path.startsWith('/api/') || req.path === '/inbound' || req.path === '/health') {
      return res.status(404).json({ error: 'Not found' });
    }
    res.sendFile(path.join(uiDistPath, 'index.html'), (err) => {
      if (err) {
        res.status(200).send(`
          <html>
            <body style="font-family: system-ui; background: #0a0a0a; color: #e5e5e5; padding: 40px;">
              <h1>AI Maestro - Email Gateway (AMP)</h1>
              <p>The management UI has not been built yet.</p>
              <p>Run <code>cd ui && npm install && npm run build</code> to build it.</p>
              <p>API endpoints are available at <a href="/api/config" style="color: #60a5fa">/api/config</a></p>
            </body>
          </html>
        `);
      }
    });
  });

  // Start server
  const server = app.listen(config.port, '127.0.0.1', () => {
    const tenantList = Array.from(ALLOWED_TENANTS).join(', ');

    console.log('========================================');
    console.log('AI Maestro - Email Gateway (AMP)');
    console.log('========================================');
    console.log(`Port: ${config.port}`);
    console.log(`Protocol: AMP`);
    console.log(`Agent: ${config.amp.agentAddress}`);
    console.log(`Default agent: ${config.amp.defaultAgent}`);
    console.log(`Tenant: ${config.amp.tenant}`);
    console.log(`Maestro: ${config.amp.maestroUrl}`);
    console.log(`Inbox: ${config.amp.inboxDir}`);
    console.log(`Tenants: ${tenantList}`);
    console.log(`Webhook keys: ${Object.keys(config.mandrill.webhookKeys).length}`);
    console.log(`Routes: ${Object.keys(config.routing.routes).length} explicit, ${Object.keys(config.routing.defaults).length} defaults`);
    console.log(`Outbound poll: ${config.outbound.pollIntervalMs}ms`);
    console.log(`Security: ${securityConfig.operatorEmails.length} operator email(s) whitelisted`);
    console.log(`Debug: ${config.debug}`);
    console.log('');
    console.log('Endpoints:');
    console.log('  GET  /health        - Health check');
    console.log('  HEAD /inbound       - Mandrill validation');
    console.log('  POST /inbound       - Mandrill webhook');
    console.log('  GET  /api/config    - Gateway config');
    console.log('  GET  /api/stats     - Gateway metrics');
    console.log('  GET  /api/activity  - Activity log');
    console.log('  GET  /              - Management UI');
    console.log('========================================');
    console.log('');
    console.log('Gateway ready! (AMP Protocol)');
  });

  // Start outbound poller
  const stopPoller = startOutboundPoller(config);

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n[SHUTDOWN] Received ${signal}, shutting down...`);
    stopPoller();
    server.close(() => {
      console.log('[SHUTDOWN] HTTP server closed');
      process.exit(0);
    });
    setTimeout(() => {
      console.error('[SHUTDOWN] Forced exit after timeout');
      process.exit(1);
    }, 10000);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// Module-level config refs (set in main())
let config: GatewayConfig;
let securityConfig: SecurityConfig;

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
