/**
 * Discord Gateway - Configuration
 *
 * Loads and validates configuration from environment variables.
 */

import * as dotenv from 'dotenv';
import type { GatewayConfig } from './types.js';

dotenv.config();

export function loadConfig(): GatewayConfig {
  const required = ['DISCORD_BOT_TOKEN'];
  const missing = required.filter(key => !process.env[key]);

  if (missing.length > 0) {
    console.error(`Missing required environment variables: ${missing.join(', ')}`);
    process.exit(1);
  }

  return {
    port: parseInt(process.env.PORT || '3023', 10),
    discord: {
      botToken: process.env.DISCORD_BOT_TOKEN!,
    },
    aimaestro: {
      apiUrl: process.env.AIMAESTRO_API || 'http://127.0.0.1:23000',
      defaultAgent: process.env.DEFAULT_AGENT || 'default-agent',
      botAgent: 'discord-bot',
      hostId: process.env.HOST_ID || 'localhost',
    },
    cache: {
      agentTtlMs: parseInt(process.env.CACHE_AGENT_TTL_MS || '300000', 10),
      hostsTtlMs: parseInt(process.env.CACHE_HOSTS_TTL_MS || '60000', 10),
    },
    polling: {
      intervalMs: parseInt(process.env.POLL_INTERVAL_MS || '2000', 10),
      timeoutMs: parseInt(process.env.POLL_TIMEOUT_MS || '5000', 10),
    },
    debug: process.env.DEBUG === 'true',
    adminToken: process.env.ADMIN_TOKEN || '',
  };
}
