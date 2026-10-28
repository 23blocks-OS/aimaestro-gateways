/**
 * Google Chat Gateway - entry point.
 *
 * Pub/Sub pull subscriptions in (no public URL needed), the Chat REST API out, AMP between.
 * Binds the management API to 127.0.0.1 by default (BIND_ADDRESS or HOST overrides).
 */

import * as path from 'path';
import { timingSafeEqual } from 'crypto';
import express, { Request, Response, NextFunction } from 'express';
import { loadConfig } from './config.js';
import { resolveBindAddress, formatHttpUrl, exposureWarning } from './bind-address.js';
import { loadSecurityConfig, type SecurityConfig } from './content-security.js';
import { createAgentResolver } from './agent-resolver.js';
import { createTargetResolver } from './target.js';
import { ThreadStore } from './thread-store.js';
import { ChatClient } from './chat-client.js';
import { startBot, type BotRuntime } from './inbound.js';
import { startOutboundPoller } from './outbound.js';
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
  console.log('AI Maestro - Google Chat Gateway (AMP)');
  console.log('========================================');
  console.log(`Port: ${config.port}`);
  console.log(`Agent: ${config.amp.agentAddress}`);
  console.log(`Default agent: ${config.amp.defaultAgent || '(none: every bot has a dedicated agent)'}`);
  console.log(`Tenant: ${config.amp.tenant}`);
  console.log(`Maestro: ${config.amp.maestroUrl}`);
  console.log(`Inbox: ${config.amp.inboxDir}`);
  console.log(`Bots: ${config.bots.map((b) => b.id).join(', ')}`);
  console.log(`Security: ${securityConfig.operatorUsers.length} operator user(s) whitelisted`);

  const resolver = createAgentResolver(config);
  const targetResolver = createTargetResolver(config.cache.userTtlMs);

  const threadStore = new ThreadStore();
  const threadStorePath = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'thread-store.json');
  threadStore.load(threadStorePath);
  threadStore.startCleanup(60000);

  const runtimes: BotRuntime[] = config.bots.map((bot) =>
    startBot(
      { config, resolver, securityConfig: () => securityConfig, threadStore },
      bot,
      ChatClient.fromCredentials(bot.credentialsFile)
    )
  );

  const stopPoller = startOutboundPoller(
    config,
    runtimes.map((r) => ({ bot: r.bot, chat: r.chat })),
    threadStore,
    targetResolver
  );

  const httpApp = express();
  httpApp.use(express.json());

  httpApp.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'google-chat-gateway',
      protocol: 'AMP',
      bots: runtimes.map((r) => ({ id: r.bot.id, agent: r.bot.agent ?? null, subscribed: r.connected() })),
      amp: { agent: config.amp.agentAddress, maestro: config.amp.maestroUrl, tenant: config.amp.tenant },
      threads: threadStore.size(),
      timestamp: new Date().toISOString(),
    });
  });

  httpApp.use('/api', authMiddleware(config.adminToken));

  httpApp.get('/api/config', (_req, res) => {
    res.json({
      port: config.port,
      bots: config.bots.map((b) => ({ id: b.id, projectId: b.projectId, subscriptionId: b.subscriptionId, agent: b.agent ?? null })),
      amp: { agentAddress: config.amp.agentAddress, defaultAgent: config.amp.defaultAgent, tenant: config.amp.tenant, maestroUrl: config.amp.maestroUrl },
      operatorUsers: securityConfig.operatorUsers.length,
    });
  });
  httpApp.use('/api/activity', createActivityRouter());
  httpApp.use('/api/stats', createStatsRouter(() => config));

  const bindAddress = resolveBindAddress();
  const exposure = exposureWarning(bindAddress, config.adminToken);
  if (exposure) console.warn(`\n!!! ${exposure}\n`);

  const server = httpApp.listen(config.port, bindAddress, () => {
    console.log(`[HTTP] Management API on ${formatHttpUrl(bindAddress, config.port)}`);
  });

  console.log('');
  console.log('Gateway ready! (AMP Protocol)');
  console.log('  - DM the app, or @mention it in a space');
  console.log('  - Shared apps: use @AIM:agent-name to pick the agent');
  console.log('  - Agents can start conversations via context.gchat.to');
  console.log('========================================');

  let isShuttingDown = false;

  async function shutdown(signal: string): Promise<void> {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`\n[SHUTDOWN] Received ${signal}, shutting down...`);

    stopPoller();
    threadStore.stopCleanup();
    threadStore.save(threadStorePath);
    resolver.clearCaches();
    targetResolver.clearCaches();
    server.close();
    await Promise.all(runtimes.map((r) => r.stop()));
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
