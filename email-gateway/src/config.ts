/**
 * Email Gateway Configuration (AMP Protocol)
 *
 * Loads config from:
 * - .env file (port, AMP credentials, Mandrill keys)
 * - credentials.yaml (Mandrill API key + webhook keys)
 * - routing.yaml (email→agent mapping)
 *
 * On first boot without AMP_API_KEY, triggers auto-registration.
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { parse as parseYaml } from 'yaml';
import { bootstrapAMP } from './amp-bootstrap.js';
import type { GatewayConfig, RouteTarget } from './types.js';

const __filename_local = fileURLToPath(import.meta.url);
const __dirname_local = dirname(__filename_local);

// Try multiple .env locations
const envCandidates = [
  resolve(__dirname_local, '..', '.env'),
  resolve(__dirname_local, '..', '.env.local'),
];
for (const envPath of envCandidates) {
  if (existsSync(envPath)) {
    dotenv.config({ path: envPath });
    break;
  }
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

/**
 * Resolve the AMP inbox directory from the .index.json file.
 */
function resolveInboxDir(agentAddress: string): string {
  const agentsDir = resolve(process.env.HOME || '/root', '.agent-messaging', 'agents');
  const indexPath = resolve(agentsDir, '.index.json');

  try {
    const index = JSON.parse(readFileSync(indexPath, 'utf-8'));
    const agentName = agentAddress.split('@')[0];

    // Try by name first, then check if value is a UUID
    const agentId = index[agentName];
    if (agentId) {
      const inboxDir = resolve(agentsDir, agentId, 'messages', 'inbox');
      if (existsSync(inboxDir)) return inboxDir;
    }
  } catch { /* Index not found */ }

  return '';
}

export async function loadConfig(): Promise<GatewayConfig> {
  const maestroUrl = process.env.AMP_MAESTRO_URL || process.env.AIMAESTRO_URL || 'http://127.0.0.1:23000';

  // Auto-bootstrap if no AMP_API_KEY
  let ampApiKey = process.env.AMP_API_KEY || '';
  let ampAgentAddress = process.env.AMP_AGENT_ADDRESS || '';
  let ampTenant = process.env.AMP_TENANT || '';
  let ampInboxDir = process.env.AMP_INBOX_DIR || '';

  if (!ampApiKey) {
    const envFile = envCandidates.find(p => existsSync(p)) || resolve(__dirname_local, '..', '.env');
    const result = await bootstrapAMP({
      agentName: process.env.AMP_AGENT_NAME || 'email-bot',
      maestroUrl,
      tenant: process.env.AMP_TENANT,
      alias: 'Email Bridge',
      envFile,
      metadata: {
        agent_type: 'bridge',
        channel_type: 'email',
      },
    });
    ampApiKey = result.apiKey;
    ampAgentAddress = result.address;
    ampTenant = result.tenant;
    ampInboxDir = result.inboxDir;
  }

  // Resolve inbox dir if not set
  if (!ampInboxDir && ampAgentAddress) {
    ampInboxDir = resolveInboxDir(ampAgentAddress);
  }

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
      routes[email] = { agent: t.agent };
    }
  }
  if (routingData?.defaults) {
    for (const [tenant, target] of Object.entries(routingData.defaults)) {
      const t = target as any;
      defaults[tenant] = { agent: t.agent };
    }
  }

  const defaultAgent = process.env.AMP_DEFAULT_AGENT || `pas-lola@${ampTenant}.aimaestro.local`;

  const config: GatewayConfig = {
    port: parseInt(process.env.PORT || '3020', 10),
    debug: process.env.DEBUG === 'true',
    amp: {
      apiKey: ampApiKey,
      agentAddress: ampAgentAddress,
      maestroUrl,
      defaultAgent,
      tenant: ampTenant,
      inboxDir: ampInboxDir,
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
  if (!config.amp.apiKey) {
    throw new Error('AMP_API_KEY not available after bootstrap');
  }

  return config;
}

export function getRoutingFilePath(): string {
  return process.env.ROUTING_FILE || resolve(__dirname_local, '..', 'routing.yaml');
}

export function reloadRouting(config: GatewayConfig): void {
  const routingPath = getRoutingFilePath();
  const routingData = loadYamlFile(routingPath);

  const routes: Record<string, RouteTarget> = {};
  const defaults: Record<string, RouteTarget> = {};

  if (routingData?.routes) {
    for (const [email, target] of Object.entries(routingData.routes)) {
      const t = target as any;
      routes[email] = { agent: t.agent };
    }
  }
  if (routingData?.defaults) {
    for (const [tenant, target] of Object.entries(routingData.defaults)) {
      const t = target as any;
      defaults[tenant] = { agent: t.agent };
    }
  }

  config.routing.routes = routes;
  config.routing.defaults = defaults;

  console.log(`[CONFIG] Routing reloaded: ${Object.keys(routes).length} routes, ${Object.keys(defaults).length} defaults`);
}
