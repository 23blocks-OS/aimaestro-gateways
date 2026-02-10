/**
 * AI Maestro - Slack Gateway
 *
 * Connects to Slack via Bolt (Socket Mode) and bridges messages with
 * AI Maestro agents. Runs as a long-lived service managed by pm2.
 *
 * Features:
 * - Bidirectional Slack <-> AI Maestro messaging
 * - Multi-host agent resolution with caching
 * - Content security (34 injection pattern detection)
 * - Activity logging (ring buffer, 500 events)
 * - Health endpoint and management APIs
 * - Graceful shutdown
 */

import { timingSafeEqual } from 'crypto';
import express, { Request, Response, NextFunction } from 'express';
import { App } from '@slack/bolt';
import { loadConfig } from './config.js';
import { loadSecurityConfig, type SecurityConfig } from './content-security.js';
import { createAgentResolver } from './agent-resolver.js';
import { registerInboundHandlers } from './inbound.js';
import { startOutboundPoller } from './outbound.js';
import { createConfigRouter } from './api/config-api.js';
import { createActivityRouter } from './api/activity-api.js';
import { createStatsRouter } from './api/stats-api.js';
import type { GatewayConfig } from './types.js';

// Load config
let config: GatewayConfig;
let securityConfig: SecurityConfig;
try {
  config = loadConfig();
  securityConfig = loadSecurityConfig();
} catch (err) {
  console.error('[FATAL] Failed to load config:', err);
  process.exit(1);
}

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

async function main(): Promise<void> {
  console.log('========================================');
  console.log('AI Maestro - Slack Gateway');
  console.log('========================================');
  console.log(`Port: ${config.port}`);
  console.log(`Default agent: ${config.aimaestro.defaultAgent}`);
  console.log(`Bot agent: ${config.aimaestro.botAgent}`);
  console.log(`Host ID: ${config.aimaestro.hostId}`);
  console.log(`AI Maestro API: ${config.aimaestro.apiUrl}`);
  console.log(`Cache TTLs: agent=${config.cache.agentTtlMs}ms, hosts=${config.cache.hostsTtlMs}ms, slack=${config.cache.slackUserTtlMs}ms`);
  console.log(`Poll interval: ${config.polling.intervalMs}ms`);
  console.log(`Security: ${securityConfig.operatorSlackIds.length} operator Slack ID(s) whitelisted`);
  console.log(`Debug: ${config.debug}`);

  // Create Slack Bolt app (Socket Mode)
  const slackApp = new App({
    token: config.slack.botToken,
    appToken: config.slack.appToken,
    signingSecret: config.slack.signingSecret,
    socketMode: true,
  });

  // Create agent resolver
  const resolver = createAgentResolver(config, slackApp);

  // Pre-warm caches
  console.log('Pre-warming caches...');
  await resolver.lookupAgentSmart(config.aimaestro.defaultAgent);
  console.log(`  Agent cache: ${resolver.getAgentCacheSize()} entries`);

  // Register Slack event handlers
  registerInboundHandlers(slackApp, config, resolver, securityConfig);

  // Start the Slack app (Socket Mode connection)
  await slackApp.start();
  console.log('Connected to Slack (Socket Mode)');

  // Start polling for agent responses
  const stopPoller = startOutboundPoller(config, slackApp, resolver);

  // Express server for health checks and management APIs
  const httpApp = express();
  httpApp.use(express.json());

  // Health check (public, no auth required)
  httpApp.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'slack-gateway',
      slack: { connected: true },
      aimaestro: { url: config.aimaestro.apiUrl },
      cache: { agents: resolver.getAgentCacheSize() },
      timestamp: new Date().toISOString(),
    });
  });

  // Auth middleware for management APIs
  httpApp.use('/api', authMiddleware(config.adminToken));

  // Management APIs
  httpApp.use(
    '/api/config',
    createConfigRouter(
      () => config,
      () => securityConfig,
      (newConfig) => {
        securityConfig = newConfig;
      },
      config.adminToken
    )
  );

  httpApp.use('/api/activity', createActivityRouter());

  httpApp.use(
    '/api/stats',
    createStatsRouter(
      () => config,
      () => resolver.getAgentCacheSize()
    )
  );

  const server = httpApp.listen(config.port, '127.0.0.1', () => {
    console.log(`[HTTP] Management API on http://127.0.0.1:${config.port}`);
  });

  console.log('');
  console.log('Endpoints:');
  console.log('  GET  /health        - Health check');
  console.log('  GET  /api/config    - Gateway config');
  console.log('  GET  /api/stats     - Gateway metrics');
  console.log('  GET  /api/activity  - Activity log');
  console.log('========================================');
  console.log('');
  console.log('Gateway ready!');
  console.log('  - DM the bot or @mention in channels');
  console.log('  - Use @AIM:agent-name to route to specific agents');
  console.log('  - Messages forwarded to AI Maestro network');
  console.log('  - Responses sent back to Slack');

  // Graceful shutdown
  let isShuttingDown = false;

  async function shutdown(signal: string): Promise<void> {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log(`\n[SHUTDOWN] Received ${signal}, shutting down...`);

    stopPoller();
    resolver.clearCaches();

    server.close(() => {
      console.log('[SHUTDOWN] HTTP server closed');
    });

    try {
      await slackApp.stop();
      console.log('[SHUTDOWN] Slack connection closed');
    } catch (error) {
      if (config.debug) {
        console.log('[SHUTDOWN] Error closing Slack:', error);
      }
    }

    console.log('[SHUTDOWN] Complete');
    process.exit(0);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
