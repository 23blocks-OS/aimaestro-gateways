/**
 * WhatsApp Gateway Configuration (AMP Protocol)
 *
 * Loads config from:
 * - .env file (port, AMP credentials, state dir)
 * - routing.yaml (phone→agent mapping)
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
    const agentId = index[agentName];
    if (agentId) {
      const inboxDir = resolve(agentsDir, agentId, 'messages', 'inbox');
      if (existsSync(inboxDir)) return inboxDir;
    }
  } catch { /* Index not found */ }

  return '';
}

export function getRoutingFilePath(): string {
  return process.env.ROUTING_FILE || resolve(__dirname_local, '..', 'routing.yaml');
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
      agentName: process.env.AMP_AGENT_NAME || 'whatsapp-bot',
      maestroUrl,
      tenant: process.env.AMP_TENANT,
      alias: 'WhatsApp Bridge',
      envFile,
      metadata: {
        agent_type: 'bridge',
        channel_type: 'whatsapp',
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

  // Load routing
  const routingPath = getRoutingFilePath();
  const routingData = loadYamlFile(routingPath);

  // Build routing tables
  const phones: Record<string, RouteTarget> = {};
  if (routingData?.phones) {
    for (const [phone, target] of Object.entries(routingData.phones)) {
      const t = target as any;
      phones[phone] = { agent: t.agent };
    }
  }

  const defaultRoute: RouteTarget = routingData?.default
    ? { agent: routingData.default.agent }
    : { agent: 'default-agent' };

  // Parse operator phones
  const operatorPhones = (process.env.OPERATOR_PHONES || '')
    .split(',')
    .map(p => p.trim())
    .filter(Boolean);

  // Parse allow list from env
  const allowFrom = (process.env.ALLOW_FROM || '')
    .split(',')
    .map(p => p.trim())
    .filter(Boolean);

  const defaultAgent = process.env.AMP_DEFAULT_AGENT || `pas-lola@${ampTenant}.aimaestro.local`;

  const config: GatewayConfig = {
    port: parseInt(process.env.PORT || '3021', 10),
    debug: process.env.DEBUG === 'true',
    amp: {
      apiKey: ampApiKey,
      agentAddress: ampAgentAddress,
      maestroUrl,
      defaultAgent,
      tenant: ampTenant,
      inboxDir: ampInboxDir,
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

  if (!config.amp.apiKey) {
    throw new Error('AMP_API_KEY not available after bootstrap');
  }

  return config;
}

export function reloadRouting(config: GatewayConfig): void {
  const routingPath = getRoutingFilePath();
  const routingData = loadYamlFile(routingPath);

  const phones: Record<string, RouteTarget> = {};
  if (routingData?.phones) {
    for (const [phone, target] of Object.entries(routingData.phones)) {
      const t = target as any;
      phones[phone] = { agent: t.agent };
    }
  }

  config.routing.phones = phones;

  if (routingData?.default) {
    config.routing.default = { agent: routingData.default.agent };
  }

  console.log(`[CONFIG] Routing reloaded: ${Object.keys(phones).length} phone routes`);
}
