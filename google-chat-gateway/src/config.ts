/**
 * Google Chat Gateway - Configuration (AMP Protocol)
 *
 * Bots come from GCHAT_BOTS_FILE (a JSON array, one entry per Chat app) or, for the common
 * single-app case, from GCHAT_PROJECT_ID + GCHAT_SUBSCRIPTION_ID. Everything else is env.
 * If AMP_API_KEY is missing, auto-registers with the provider on first boot.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { bootstrapAMP } from './amp-bootstrap.js';
import type { BotConfig, GatewayConfig } from './types.js';

dotenv.config();

const BOT_ID = /^[a-zA-Z0-9_-]{1,40}$/;

/** Validate and normalise a list of bot entries. Throws with a message naming the entry. */
export function parseBots(raw: unknown): BotConfig[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('GCHAT_BOTS_FILE must hold a non-empty JSON array of bots');
  }
  const seen = new Set<string>();
  return raw.map((entry, i) => {
    const e = (entry ?? {}) as Record<string, unknown>;
    const str = (k: string): string => (typeof e[k] === 'string' ? (e[k] as string).trim() : '');
    const id = str('id');
    if (!BOT_ID.test(id)) throw new Error(`bot #${i + 1}: "id" must match ${BOT_ID} (got "${id}")`);
    if (seen.has(id)) throw new Error(`bot "${id}": id is used twice`);
    seen.add(id);
    for (const k of ['projectId', 'subscriptionId']) {
      if (!str(k)) throw new Error(`bot "${id}": "${k}" is required`);
    }
    return {
      id,
      projectId: str('projectId'),
      subscriptionId: str('subscriptionId'),
      credentialsFile: str('credentialsFile') || undefined,
      impersonateServiceAccount: str('impersonateServiceAccount') || undefined,
      agent: str('agent') || undefined,
    };
  });
}

function loadBots(): BotConfig[] {
  const file = process.env.GCHAT_BOTS_FILE;
  if (file) {
    const resolved = path.resolve(file);
    return parseBots(JSON.parse(fs.readFileSync(resolved, 'utf-8')));
  }
  return parseBots([
    {
      id: process.env.GCHAT_BOT_ID || 'default',
      projectId: process.env.GCHAT_PROJECT_ID,
      subscriptionId: process.env.GCHAT_SUBSCRIPTION_ID,
      credentialsFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
      impersonateServiceAccount: process.env.GCHAT_IMPERSONATE_SA,
      agent: process.env.GCHAT_AGENT,
    },
  ]);
}

/**
 * Resolve the AMP inbox directory for the bridge agent.
 * Looks up the agent UUID from .index.json, falls back to name-based dir.
 */
function resolveInboxDir(agentName: string = 'gchat-bot'): string {
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

/** Find the .env file that started this process (.env.local, .env). */
function findEnvFile(): string {
  const gatewayDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  for (const name of ['.env.local', '.env']) {
    const candidate = path.join(gatewayDir, name);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return path.join(gatewayDir, '.env');
}

function buildConfig(bots: BotConfig[], ampOverrides?: {
  apiKey: string;
  address: string;
  tenant: string;
  inboxDir: string;
  maestroUrl: string;
}): GatewayConfig {
  const agentName = process.env.AMP_AGENT_NAME || 'gchat-bot';

  return {
    port: parseInt(process.env.PORT || '3024', 10),
    bots,
    amp: {
      apiKey: ampOverrides?.apiKey || process.env.AMP_API_KEY!,
      agentAddress: ampOverrides?.address || process.env.AMP_AGENT_ADDRESS || `${agentName}@default.aimaestro.local`,
      maestroUrl: ampOverrides?.maestroUrl || process.env.AMP_MAESTRO_URL || 'http://127.0.0.1:23000',
      defaultAgent: process.env.AMP_DEFAULT_AGENT || '',
      tenant: ampOverrides?.tenant || process.env.AMP_TENANT || 'default',
      inboxDir: ampOverrides?.inboxDir || process.env.AMP_INBOX_DIR || resolveInboxDir(agentName),
    },
    cache: {
      agentTtlMs: parseInt(process.env.CACHE_AGENT_TTL_MS || '300000', 10),
      userTtlMs: parseInt(process.env.CACHE_USER_TTL_MS || '600000', 10),
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
 * If AMP_API_KEY is not set, runs auto-registration with the provider. The resulting
 * API key and config are persisted to the .env file so restarts don't re-register.
 */
export async function loadConfig(): Promise<GatewayConfig> {
  let bots: BotConfig[];
  try {
    bots = loadBots();
  } catch (err) {
    console.error(`Invalid Google Chat configuration: ${(err as Error).message}`);
    console.error('Set GCHAT_PROJECT_ID and GCHAT_SUBSCRIPTION_ID, or GCHAT_BOTS_FILE (see README).');
    process.exit(1);
  }

  // A shared app with no default agent would have nowhere to send untagged messages.
  const shared = bots.filter(b => !b.agent);
  if (shared.length > 0 && !process.env.AMP_DEFAULT_AGENT) {
    console.error(
      `AMP_DEFAULT_AGENT is required: bot(s) ${shared.map(b => b.id).join(', ')} have no dedicated agent, ` +
      'so messages without an @AIM:agent tag need a default.'
    );
    process.exit(1);
  }

  if (process.env.AMP_API_KEY) {
    return buildConfig(bots);
  }

  const agentName = process.env.AMP_AGENT_NAME || 'gchat-bot';
  const maestroUrl = process.env.AMP_MAESTRO_URL || 'http://127.0.0.1:23000';

  const result = await bootstrapAMP({
    agentName,
    maestroUrl,
    tenant: process.env.AMP_TENANT,
    alias: process.env.AMP_ALIAS || 'Google Chat Bridge',
    envFile: findEnvFile(),
    metadata: {
      agent_type: 'bridge',
      channel_type: 'google-chat',
    },
  });

  return buildConfig(bots, {
    apiKey: result.apiKey,
    address: result.address,
    tenant: result.tenant,
    inboxDir: result.inboxDir,
    maestroUrl,
  });
}
