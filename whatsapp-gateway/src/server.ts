/**
 * AI Maestro - WhatsApp Gateway
 *
 * Connects to WhatsApp via Baileys and bridges messages with AI Maestro agents.
 * Runs as a long-lived service managed by pm2.
 */

import { timingSafeEqual } from 'crypto';
import express, { Request, Response, NextFunction } from 'express';
import { loadConfig } from './config.js';
import { createSession, getStatus, getSelfJid, closeSession } from './session.js';
import { handleInboundMessage } from './inbound.js';
import { startOutboundPoller } from './outbound.js';
import { createActivityRouter } from './api/activity-api.js';
import type { GatewayConfig } from './types.js';

// Load config
let config: GatewayConfig;
try {
  config = loadConfig();
} catch (err) {
  console.error('[FATAL] Failed to load config:', err);
  process.exit(1);
}

console.log('[STARTUP] WhatsApp Gateway v0.1.0');
console.log(`[STARTUP] AI Maestro: ${config.aimaestro.apiUrl}`);
console.log(`[STARTUP] Bot agent: ${config.aimaestro.botAgent}`);
console.log(`[STARTUP] State dir: ${config.whatsapp.stateDir}`);
console.log(`[STARTUP] DM policy: ${config.whatsapp.dmPolicy}`);
console.log(`[STARTUP] Allow from: ${config.whatsapp.allowFrom.length > 0 ? config.whatsapp.allowFrom.join(', ') : '(all)'}`);

/**
 * Bearer token authentication middleware for management API routes.
 * If ADMIN_TOKEN is not set, access is allowed (backwards compatibility).
 */
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

// Express server for health checks and management
const app = express();
app.use(express.json());

// Health check (public, no auth required)
app.get('/health', (_req, res) => {
  const status = getStatus();
  const selfJid = getSelfJid();

  res.json({
    status: status === 'connected' ? 'healthy' : 'degraded',
    whatsapp: {
      connection: status,
      selfJid,
    },
    service: {
      name: 'whatsapp-gateway',
      version: '0.1.0',
      uptime: process.uptime(),
    },
    aimaestro: {
      url: config.aimaestro.apiUrl,
      agent: config.aimaestro.botAgent,
    },
  });
});

// Status (short)
app.get('/status', (_req, res) => {
  res.json({
    connected: getStatus() === 'connected',
    selfJid: getSelfJid(),
    dmPolicy: config.whatsapp.dmPolicy,
  });
});

// Auth middleware for management APIs
app.use('/api', authMiddleware(config.adminToken));

// Activity log
app.use('/api/activity', createActivityRouter());

// Start the HTTP server
app.listen(config.port, '127.0.0.1', () => {
  console.log(`[HTTP] Management API on http://127.0.0.1:${config.port}`);
});

// Start the WhatsApp session
async function startup(): Promise<void> {
  try {
    console.log('[STARTUP] Connecting to WhatsApp...');

    await createSession(config, {
      printQr: true,
      onMessage: (msg) => handleInboundMessage(msg, config),
    });

    // Start the outbound poller
    const stopPoller = startOutboundPoller(config);

    // Graceful shutdown
    const shutdown = async (signal: string) => {
      console.log(`\n[SHUTDOWN] Received ${signal}, shutting down...`);
      stopPoller();
      await closeSession();
      process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

  } catch (err) {
    console.error('[FATAL] Startup failed:', err);
    process.exit(1);
  }
}

startup();
