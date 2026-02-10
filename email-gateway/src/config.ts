/**
 * Email Gateway Configuration
 *
 * Loads config from:
 * - .env file (port, AI Maestro URL, bot identity)
 * - credentials.yaml (Mandrill API key + webhook keys)
 * - routing.yaml (email→agent mapping, stopgap until AI Maestro email index)
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { parse as parseYaml } from 'yaml';

// Load .env from gateway directory
const __filename_local = fileURLToPath(import.meta.url);
const __dirname_local = dirname(__filename_local);
dotenv.config({ path: resolve(__dirname_local, '..', '.env') });

export interface RouteTarget {
  agent: string;
  host: string;
}

export interface GatewayConfig {
  port: number;
  debug: boolean;
  aimaestro: {
    apiUrl: string;
    botAgent: string;
    hostId: string;
  };
  mandrill: {
    apiKey: string;
    webhookKeys: Record<string, string>;
  };
  routing: {
    routes: Record<string, RouteTarget>;
    defaults: Record<string, RouteTarget>;
  };
  outbound: {
    pollIntervalMs: number;
  };
  storage: {
    attachmentsPath: string;
  };
  adminToken: string;
  emailBaseDomain: string;
}

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

export function loadConfig(): GatewayConfig {
  // Load credentials
  const credentialsPath = process.env.CREDENTIALS_FILE
    || resolve(__dirname_local, '..', '..', '..', 'credentials.yaml');
  const credentials = loadYamlFile(credentialsPath);

  if (!credentials?.mandrill) {
    throw new Error(`Missing mandrill section in credentials file: ${credentialsPath}`);
  }

  // Load routing
  const routingPath = getRoutingFilePath();
  const routingData = loadYamlFile(routingPath);

  // Build webhook keys from credentials
  const webhookKeys: Record<string, string> = credentials.mandrill.webhook_keys || {};

  // Build routing tables
  const routes: Record<string, RouteTarget> = {};
  const defaults: Record<string, RouteTarget> = {};

  if (routingData?.routes) {
    for (const [email, target] of Object.entries(routingData.routes)) {
      const t = target as any;
      routes[email] = { agent: t.agent, host: t.host };
    }
  }
  if (routingData?.defaults) {
    for (const [tenant, target] of Object.entries(routingData.defaults)) {
      const t = target as any;
      defaults[tenant] = { agent: t.agent, host: t.host };
    }
  }

  const config: GatewayConfig = {
    port: parseInt(process.env.PORT || '3020', 10),
    debug: process.env.DEBUG === 'true',
    aimaestro: {
      apiUrl: process.env.AIMAESTRO_URL || 'http://127.0.0.1:23000',
      botAgent: process.env.BOT_AGENT || 'email-gateway',
      hostId: process.env.HOST_ID || 'localhost',
    },
    mandrill: {
      apiKey: credentials.mandrill.api_key,
      webhookKeys,
    },
    routing: {
      routes,
      defaults,
    },
    outbound: {
      pollIntervalMs: parseInt(process.env.OUTBOUND_POLL_INTERVAL_MS || '30000', 10),
    },
    storage: {
      attachmentsPath: process.env.ATTACHMENTS_PATH || './attachments',
    },
    adminToken: process.env.ADMIN_TOKEN || '',
    emailBaseDomain: process.env.EMAIL_BASE_DOMAIN || 'example.com',
  };

  // Validate essentials
  if (!config.mandrill.apiKey) {
    throw new Error('Missing mandrill.api_key in credentials');
  }
  if (Object.keys(config.mandrill.webhookKeys).length === 0) {
    console.warn('[CONFIG] No webhook keys loaded - signature verification will fail');
  }

  return config;
}

/**
 * Get the routing file path.
 */
export function getRoutingFilePath(): string {
  return process.env.ROUTING_FILE || resolve(__dirname_local, '..', 'routing.yaml');
}

/**
 * Reload routing configuration from disk into an existing config object.
 */
export function reloadRouting(config: GatewayConfig): void {
  const routingPath = getRoutingFilePath();
  const routingData = loadYamlFile(routingPath);

  const routes: Record<string, RouteTarget> = {};
  const defaults: Record<string, RouteTarget> = {};

  if (routingData?.routes) {
    for (const [email, target] of Object.entries(routingData.routes)) {
      const t = target as any;
      routes[email] = { agent: t.agent, host: t.host };
    }
  }
  if (routingData?.defaults) {
    for (const [tenant, target] of Object.entries(routingData.defaults)) {
      const t = target as any;
      defaults[tenant] = { agent: t.agent, host: t.host };
    }
  }

  config.routing.routes = routes;
  config.routing.defaults = defaults;

  console.log(`[CONFIG] Routing reloaded: ${Object.keys(routes).length} routes, ${Object.keys(defaults).length} defaults`);
}
