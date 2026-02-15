/**
 * AI Maestro - WhatsApp Gateway (AMP Protocol)
 *
 * Connects to WhatsApp via Baileys and bridges messages with AI Maestro
 * agents using the AMP protocol. Runs as a long-lived service managed by pm2.
 */

import { timingSafeEqual } from 'crypto';
import express, { Request, Response, NextFunction } from 'express';
import { loadConfig } from './config.js';
import { createSession, getStatus, getSelfJid, closeSession } from './session.js';
import { handleInboundMessage } from './inbound.js';
import { startOutboundPoller } from './outbound.js';
import { createActivityRouter } from './api/activity-api.js';
import type { GatewayConfig } from './types.js';

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

async function main(): Promise<void> {
  // Load config (async — may trigger AMP auto-registration)
  let config: GatewayConfig;
  try {
    config = await loadConfig();
  } catch (err) {
    console.error('[FATAL] Failed to load config:', err);
    process.exit(1);
  }

  console.log('========================================');
  console.log('AI Maestro - WhatsApp Gateway (AMP)');
  console.log('========================================');
  console.log(`Port: ${config.port}`);
  console.log(`Protocol: AMP`);
  console.log(`Agent: ${config.amp.agentAddress}`);
  console.log(`Default agent: ${config.amp.defaultAgent}`);
  console.log(`Tenant: ${config.amp.tenant}`);
  console.log(`Maestro: ${config.amp.maestroUrl}`);
  console.log(`Inbox: ${config.amp.inboxDir}`);
  console.log(`State dir: ${config.whatsapp.stateDir}`);
  console.log(`DM policy: ${config.whatsapp.dmPolicy}`);
  console.log(`Allow from: ${config.whatsapp.allowFrom.length > 0 ? config.whatsapp.allowFrom.join(', ') : '(all)'}`);
  console.log(`Debug: ${config.debug}`);

  // Express server for health checks and management
  const app = express();
  app.use(express.json());

  app.get('/health', (_req, res) => {
    const status = getStatus();
    const selfJid = getSelfJid();

    res.json({
      status: status === 'connected' ? 'healthy' : 'degraded',
      protocol: 'AMP',
      whatsapp: {
        connection: status,
        selfJid,
      },
      service: {
        name: 'whatsapp-gateway',
        version: '0.2.0',
        uptime: process.uptime(),
      },
      amp: {
        agent: config.amp.agentAddress,
        maestro: config.amp.maestroUrl,
        tenant: config.amp.tenant,
      },
    });
  });

  app.get('/status', (_req, res) => {
    res.json({
      connected: getStatus() === 'connected',
      selfJid: getSelfJid(),
      dmPolicy: config.whatsapp.dmPolicy,
    });
  });

  app.use('/api', authMiddleware(config.adminToken));
  app.use('/api/activity', createActivityRouter());

  const server = app.listen(config.port, '127.0.0.1', () => {
    console.log(`[HTTP] Management API on http://127.0.0.1:${config.port}`);
  });

  console.log('');
  console.log('Endpoints:');
  console.log('  GET  /health        - Health check');
  console.log('  GET  /status        - Connection status');
  console.log('  GET  /api/activity  - Activity log');
  console.log('========================================');
  console.log('');
  console.log('Gateway ready! (AMP Protocol)');

  // Start the WhatsApp session
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
      server.close(() => {
        console.log('[SHUTDOWN] HTTP server closed');
      });
      process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

  } catch (err) {
    console.error('[FATAL] Startup failed:', err);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
