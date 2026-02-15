/**
 * Slack Gateway - Configuration (AMP Protocol)
 *
 * Loads configuration from environment variables.
 * If AMP_API_KEY is missing, auto-registers with the provider on first boot.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { bootstrapAMP } from './amp-bootstrap.js';
import type { GatewayConfig } from './types.js';

dotenv.config();

/**
 * Resolve the AMP inbox directory for the slack-bot agent.
 * Looks up the agent UUID from .index.json, falls back to name-based dir.
 */
function resolveInboxDir(agentName: string = 'slack-bot'): string {
  const agentMessagingDir = path.join(process.env.HOME || '/root', '.agent-messaging', 'agents');
  const indexPath = path.join(agentMessagingDir, '.index.json');

  try {
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    const uuid = index[agentName];
    if (uuid) {
      const uuidInbox = path.join(agentMessagingDir, uuid, 'messages', 'inbox');
      if (fs.existsSync(uuidInbox)) {
        return uuidInbox;
      }
    }
  } catch {
    // Fall through to name-based
  }

  return path.join(agentMessagingDir, agentName, 'messages', 'inbox');
}

/**
 * Find the .env file that started this process.
 * Checks for .env.lola, .env.local, .env in the gateway directory.
 */
function findEnvFile(): string {
  const gatewayDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  for (const name of ['.env.lola', '.env.local', '.env']) {
    const candidate = path.join(gatewayDir, name);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return path.join(gatewayDir, '.env');
}

/**
 * Build GatewayConfig from current env vars (or overrides).
 */
function buildConfig(ampOverrides?: {
  apiKey: string;
  address: string;
  tenant: string;
  inboxDir: string;
  maestroUrl: string;
}): GatewayConfig {
  const agentName = process.env.AMP_AGENT_NAME || 'slack-bot';

  return {
    port: parseInt(process.env.PORT || '3022', 10),
    slack: {
      botToken: process.env.SLACK_BOT_TOKEN!,
      appToken: process.env.SLACK_APP_TOKEN!,
      signingSecret: process.env.SLACK_SIGNING_SECRET!,
    },
    amp: {
      apiKey: ampOverrides?.apiKey || process.env.AMP_API_KEY!,
      agentAddress: ampOverrides?.address || process.env.AMP_AGENT_ADDRESS || `${agentName}@default.aimaestro.local`,
      maestroUrl: ampOverrides?.maestroUrl || process.env.AMP_MAESTRO_URL || 'http://127.0.0.1:23000',
      defaultAgent: process.env.AMP_DEFAULT_AGENT || 'pas-lola@default.aimaestro.local',
      tenant: ampOverrides?.tenant || process.env.AMP_TENANT || 'default',
      inboxDir: ampOverrides?.inboxDir || process.env.AMP_INBOX_DIR || resolveInboxDir(agentName),
    },
    cache: {
      agentTtlMs: parseInt(process.env.CACHE_AGENT_TTL_MS || '300000', 10),
      slackUserTtlMs: parseInt(process.env.CACHE_SLACK_USER_TTL_MS || '600000', 10),
    },
    polling: {
      intervalMs: parseInt(process.env.POLL_INTERVAL_MS || '3000', 10),
      timeoutMs: parseInt(process.env.POLL_TIMEOUT_MS || '10000', 10),
    },
    debug: process.env.DEBUG === 'true',
    adminToken: process.env.ADMIN_TOKEN || '',
  };
}

/**
 * Load gateway configuration.
 *
 * If AMP_API_KEY is not set, runs auto-registration with the provider.
 * The resulting API key and config are persisted to the .env file
 * so subsequent restarts don't need to re-register.
 */
export async function loadConfig(): Promise<GatewayConfig> {
  // Validate Slack config (always required)
  const slackRequired = ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'SLACK_SIGNING_SECRET'];
  const missing = slackRequired.filter(key => !process.env[key]);
  if (missing.length > 0) {
    console.error(`Missing required environment variables: ${missing.join(', ')}`);
    process.exit(1);
  }

  // If AMP_API_KEY exists, we're already registered — use env config
  if (process.env.AMP_API_KEY) {
    return buildConfig();
  }

  // No API key — auto-register
  const agentName = process.env.AMP_AGENT_NAME || 'slack-bot';
  const maestroUrl = process.env.AMP_MAESTRO_URL || 'http://127.0.0.1:23000';

  const result = await bootstrapAMP({
    agentName,
    maestroUrl,
    tenant: process.env.AMP_TENANT,
    alias: process.env.AMP_ALIAS || 'Slack Bridge',
    envFile: findEnvFile(),
    metadata: {
      agent_type: 'bridge',
      channel_type: 'slack',
    },
  });

  return buildConfig({
    apiKey: result.apiKey,
    address: result.address,
    tenant: result.tenant,
    inboxDir: result.inboxDir,
    maestroUrl,
  });
}
