import fs from 'node:fs';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import { adaptExpress, Client, Domain, EventDispatcher, WSClient } from '@larksuiteoapi/node-sdk';
import { loadConfig, loadRoutingFile } from './config.js';
import { resolveBindAddress, exposureWarning, formatHttpUrl } from './bind-address.js';
import { DedupeStore } from './dedupe.js';
import { ThreadStore } from './thread-store.js';
import { InboundProcessor } from './inbound.js';
import { LarkApi } from './lark-api.js';
import { OutboundPoller } from './outbound.js';
import { authorizeCardAction, routeCardAction } from './card-actions.js';
import { createActivityRouter } from './api/activity-api.js';
import { createStatsRouter } from './api/stats-api.js';
import { logEvent } from './api/activity-log.js';
import type { RoutingConfig } from './types.js';

function auth(token: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!token) return res.status(403).json({ error: 'ADMIN_TOKEN is required for management API access' });
    const value = req.headers.authorization || ''; const expected = `Bearer ${token}`;
    if (value.length === expected.length && timingSafeEqual(Buffer.from(value), Buffer.from(expected))) return next();
    return res.status(401).json({ error: 'Unauthorized' });
  };
}

function emptyRouting(): RoutingConfig { return { people: {}, default_reply_unknown: 'This bot is not configured for your account.', disabled_person: 'This agent is paused.', group_pointer: 'Please DM this bot.', tenant: undefined }; }
function object(value: unknown): Record<string, unknown> { return value && typeof value === 'object' ? value as Record<string, unknown> : {}; }

async function main(): Promise<void> {
  const config = await loadConfig(); fs.mkdirSync(config.stateDir, { recursive: true });
  const threads = new ThreadStore(path.join(config.stateDir, 'thread-store.json'));
  const dedupe = new DedupeStore(path.join(config.stateDir, 'dedupe.json'));
  let routing: RoutingConfig = emptyRouting();
  try { routing = loadRoutingFile(config.routingFile); } catch (error) { console.error(`[CONFIG] Routing file unavailable: ${(error as Error).message}`); }
  fs.watch(path.dirname(config.routingFile), (_event, filename) => {
    if (!filename || filename.toString() !== path.basename(config.routingFile)) return;
    try { routing = loadRoutingFile(config.routingFile); console.log('[CONFIG] routing.yaml reloaded'); }
    catch (error) { console.error(`[CONFIG] Routing reload rejected; keeping previous config: ${(error as Error).message}`); }
  });

  const app = express(); app.use(express.json({ limit: '1mb' }));
  app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'lark-gateway', protocol: 'AMP', configured: Boolean(config.appId && config.appSecret && config.verificationToken && config.amp.apiKey), threads: threads.size(), timestamp: new Date().toISOString() }));
  app.use('/api', auth(config.adminToken));
  app.get('/api/config', (_req, res) => res.json({ port: config.port, bindAddress: config.bindAddress, lark: { configured: Boolean(config.appId && config.appSecret), longConnection: true, cardCallbackConfigured: Boolean(config.verificationToken) }, amp: { agentAddress: config.amp.agentAddress, maestroUrl: config.amp.maestroUrl, tenant: config.amp.tenant, inboxDir: config.amp.inboxDir }, routing: { file: config.routingFile, people: Object.keys(routing.people).length }, polling: { intervalMs: config.pollIntervalMs } }));
  app.use('/api/stats', createStatsRouter(() => ({ port: config.port, amp: { agentAddress: config.amp.agentAddress, tenant: config.amp.tenant, maestroUrl: config.amp.maestroUrl } } as any)));
  app.use('/api/activity', createActivityRouter());
  const bind = resolveBindAddress({ BIND_ADDRESS: config.bindAddress });
  const warning = exposureWarning(bind, config.adminToken); if (warning) console.warn(warning);
  const server = app.listen(config.port, bind, () => console.log(`[HTTP] Management API on ${formatHttpUrl(bind, config.port)}`));

  const credsMissing = !config.appId || !config.appSecret || !config.verificationToken || !config.amp.apiKey;
  if (credsMissing) {
    console.error('[CONFIG ERROR] Lark gateway is in health-only mode. Set LARK_APP_ID, LARK_APP_SECRET, LARK_VERIFICATION_TOKEN, AMP_API_KEY (or AMP_AUTO_REGISTER=true), then restart.');
    return;
  }
  if (!fs.existsSync(config.routingFile)) console.warn(`[CONFIG] No routing file at ${config.routingFile}; DM senders receive the configured unknown-sender response.`);
  const domain = config.domain === 'feishu' ? Domain.Feishu : Domain.Lark;
  const client = new Client({ appId: config.appId, appSecret: config.appSecret, domain }) as Client & Record<string, any>;
  const ws = new WSClient({ appId: config.appId, appSecret: config.appSecret, domain, autoReconnect: true, onReady: () => console.log('[LARK] Long connection ready'), onReconnecting: () => console.warn('[LARK] Long connection reconnecting'), onReconnected: () => console.log('[LARK] Long connection restored'), onError: (e) => console.error(`[LARK] Connection error: ${e.message}`) });
  const lark = new LarkApi(client);
  const inbound = new InboundProcessor(config, () => routing, dedupe, threads, lark);
  inbound.start();

  const dispatcher = new EventDispatcher({}).register({
    'im.message.receive_v1': async (event: any) => { inbound.enqueue(event); return {}; },
  });
  const cardDispatcher = new EventDispatcher({ verificationToken: config.verificationToken, encryptKey: config.encryptKey }).register({
    'card.action.trigger': async (raw: any) => {
      const event = object(raw.event || raw); const action = object(event.action); const value = object(action.value);
      const owner = typeof value.owner === 'string' ? value.owner : '';
      const clickerId = typeof event.open_id === 'string' ? event.open_id : '';
      const clicker = authorizeCardAction(clickerId, owner, routing);
      if (!clicker) return { toast: { type: 'error', content: 'This button belongs to another user.' } };
      const eventId = typeof event.event_id === 'string' ? event.event_id : '';
      const actionKey = `card:${String(event.open_message_id || '')}:${clicker}:${JSON.stringify(action.value || {})}`;
      if (dedupe.hasOrAdd(eventId, actionKey)) return { toast: { type: 'success', content: 'This action was already received.' } };
      void routeCardAction(config, routing, value, clicker).catch((error) => console.error(`[CARD] Action route failed: ${(error as Error).message}`));
      return { toast: { type: 'success', content: 'Received. The agent is working on it.' } };
    },
  });
  app.use('/lark/callback', adaptExpress(cardDispatcher));
  await ws.start({ eventDispatcher: dispatcher });
  const poller = new OutboundPoller(config, () => routing, threads, lark); poller.start();
  logEvent('inbound', 'Lark gateway started');
  console.log('Lark gateway ready: DMs are routed by routing.yaml; group messages are ignored unless they mention the bot.');
  let closing = false;
  const shutdown = async (signal: string) => { if (closing) return; closing = true; console.log(`[SHUTDOWN] ${signal}`); poller.stop(); inbound.stop(); ws.close({ force: true }); threads?.save(); server.close(); };
  process.on('SIGTERM', () => void shutdown('SIGTERM')); process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error) => { console.error(`[FATAL] ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
