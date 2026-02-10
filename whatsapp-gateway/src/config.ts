/**
 * WhatsApp Gateway Configuration
 *
 * Loads config from:
 * - .env file (port, AI Maestro URL, bot identity, state dir)
 * - routing.yaml (phone→agent mapping)
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { parse as parseYaml } from 'yaml';
import type { GatewayConfig, RouteTarget } from './types.js';

const __filename_local = fileURLToPath(import.meta.url);
const __dirname_local = dirname(__filename_local);
dotenv.config({ path: resolve(__dirname_local, '..', '.env') });

function loadYamlFile(path: string): any {
  try {
    const content = readFileSync(path, 'utf-8');
    return parseYaml(content);
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      console.warn(`[CONFIG] File not found: ${path}`);
      return null;
    }
    throw err;
  }
}

export function getRoutingFilePath(): string {
  return process.env.ROUTING_FILE || resolve(__dirname_local, '..', 'routing.yaml');
}

export function loadConfig(): GatewayConfig {
  // Load routing
  const routingPath = getRoutingFilePath();
  const routingData = loadYamlFile(routingPath);

  // Build routing tables
  const phones: Record<string, RouteTarget> = {};
  if (routingData?.phones) {
    for (const [phone, target] of Object.entries(routingData.phones)) {
      const t = target as any;
      phones[phone] = { agent: t.agent, host: t.host };
    }
  }

  const defaultRoute: RouteTarget = routingData?.default
    ? { agent: routingData.default.agent, host: routingData.default.host }
    : { agent: 'default-agent', host: 'localhost' };

  // Parse operator phones
  const operatorPhones = (process.env.OPERATOR_PHONES || '')
    .split(',')
    .map(p => p.trim())
    .filter(Boolean);

  // Parse allow list from env (comma-separated)
  const allowFrom = (process.env.ALLOW_FROM || '')
    .split(',')
    .map(p => p.trim())
    .filter(Boolean);

  const config: GatewayConfig = {
    port: parseInt(process.env.PORT || '3021', 10),
    debug: process.env.DEBUG === 'true',
    aimaestro: {
      apiUrl: process.env.AIMAESTRO_URL || 'http://127.0.0.1:23000',
      botAgent: process.env.BOT_AGENT || 'whatsapp-gateway',
      hostId: process.env.HOST_ID || 'localhost',
    },
    whatsapp: {
      stateDir: process.env.STATE_DIR || resolve(process.env.HOME || '/tmp', '.whatsapp-gateway'),
      allowFrom,
      dmPolicy: (process.env.DM_POLICY as any) || 'allowlist',
      sendReadReceipts: process.env.SEND_READ_RECEIPTS !== 'false',
      textChunkLimit: parseInt(process.env.TEXT_CHUNK_LIMIT || '4000', 10),
    },
    routing: {
      phones,
      default: defaultRoute,
    },
    outbound: {
      pollIntervalMs: parseInt(process.env.OUTBOUND_POLL_INTERVAL_MS || '5000', 10),
    },
    operatorPhones,
    adminToken: process.env.ADMIN_TOKEN || '',
  };

  return config;
}

/**
 * Reload routing configuration from disk.
 */
export function reloadRouting(config: GatewayConfig): void {
  const routingPath = getRoutingFilePath();
  const routingData = loadYamlFile(routingPath);

  const phones: Record<string, RouteTarget> = {};
  if (routingData?.phones) {
    for (const [phone, target] of Object.entries(routingData.phones)) {
      const t = target as any;
      phones[phone] = { agent: t.agent, host: t.host };
    }
  }

  config.routing.phones = phones;

  if (routingData?.default) {
    config.routing.default = {
      agent: routingData.default.agent,
      host: routingData.default.host,
    };
  }

  console.log(`[CONFIG] Routing reloaded: ${Object.keys(phones).length} phone routes`);
}
