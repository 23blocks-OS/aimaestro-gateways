/**
 * AI Maestro - Discord Gateway (AMP Protocol)
 *
 * Connects to Discord via discord.js and bridges messages with
 * AI Maestro agents using the AMP protocol. Runs as a long-lived
 * service managed by pm2.
 */

import * as path from 'path';
import { timingSafeEqual } from 'crypto';
import express, { Request, Response, NextFunction } from 'express';
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { loadConfig } from './config.js';
import { loadSecurityConfig, type SecurityConfig } from './content-security.js';
import { createAgentResolver } from './agent-resolver.js';
import { ThreadStore } from './thread-store.js';
import { registerInboundHandlers } from './inbound.js';
import { startOutboundPoller } from './outbound.js';
import { createConfigRouter } from './api/config-api.js';
import { createActivityRouter } from './api/activity-api.js';
import { createStatsRouter } from './api/stats-api.js';
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
  let securityConfig: SecurityConfig;
  try {
    config = await loadConfig();
    securityConfig = loadSecurityConfig();
  } catch (err) {
    console.error('[FATAL] Failed to load config:', err);
    process.exit(1);
  }

  console.log('========================================');
  console.log('AI Maestro - Discord Gateway (AMP)');
  console.log('========================================');
  console.log(`Port: ${config.port}`);
  console.log(`Agent: ${config.amp.agentAddress}`);
  console.log(`Default agent: ${config.amp.defaultAgent}`);
  console.log(`Tenant: ${config.amp.tenant}`);
  console.log(`Maestro: ${config.amp.maestroUrl}`);
  console.log(`Inbox: ${config.amp.inboxDir}`);
  console.log(`Poll interval: ${config.polling.intervalMs}ms`);
  console.log(`Security: ${securityConfig.operatorDiscordIds.length} operator Discord ID(s) whitelisted`);
  console.log(`Debug: ${config.debug}`);

  // Create Discord.js client
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
  });

  // Create agent resolver
  const resolver = createAgentResolver(config);

  // Create thread store with persistence
  const threadStore = new ThreadStore();
  const threadStorePath = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    '..',
    'thread-store.json'
  );
  threadStore.load(threadStorePath);
  threadStore.startCleanup(60000);

  // Register Discord event handlers
  registerInboundHandlers(client, config, resolver, securityConfig, threadStore);

  // Discord ready event
  client.once('ready', () => {
    console.log(`Connected to Discord as ${client.user?.tag}`);
    console.log(`  Serving ${client.guilds.cache.size} guild(s)`);
  });

  // Login to Discord
  await client.login(config.discord.botToken);

  // Start polling AMP inbox for agent responses
  const stopPoller = startOutboundPoller(config, client, threadStore);

  // Express server for health checks and management APIs
  const httpApp = express();
  httpApp.use(express.json());

  httpApp.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'discord-gateway',
      protocol: 'AMP',
      discord: {
        connected: client.isReady(),
        user: client.user?.tag || null,
        guilds: client.guilds.cache.size,
      },
      amp: {
        agent: config.amp.agentAddress,
        maestro: config.amp.maestroUrl,
        tenant: config.amp.tenant,
      },
      threads: threadStore.size(),
      timestamp: new Date().toISOString(),
    });
  });

  httpApp.use('/api', authMiddleware(config.adminToken));

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
      () => client.isReady()
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
  console.log('Gateway ready! (AMP Protocol)');
  console.log('  - DM the bot or @mention in channels');
  console.log('  - Use @AIM:agent-name to route to specific agents');
  console.log('  - Messages routed via AMP protocol');
  console.log('  - Responses delivered via filesystem inbox');

  let isShuttingDown = false;

  async function shutdown(signal: string): Promise<void> {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log(`\n[SHUTDOWN] Received ${signal}, shutting down...`);

    stopPoller();
    threadStore.stopCleanup();
    threadStore.save(threadStorePath);
    console.log('[SHUTDOWN] Thread store saved');

    resolver.clearCaches();

    server.close(() => {
      console.log('[SHUTDOWN] HTTP server closed');
    });

    try {
      client.destroy();
      console.log('[SHUTDOWN] Discord connection closed');
    } catch (error) {
      if (config.debug) {
        console.log('[SHUTDOWN] Error closing Discord:', error);
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
