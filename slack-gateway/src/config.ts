/**
 * Slack Gateway - Configuration
 *
 * Loads and validates configuration from environment variables.
 */

import * as dotenv from 'dotenv';
import type { GatewayConfig } from './types.js';

dotenv.config();

export function loadConfig(): GatewayConfig {
  const required = ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'SLACK_SIGNING_SECRET'];
  const missing = required.filter(key => !process.env[key]);

  if (missing.length > 0) {
    console.error(`Missing required environment variables: ${missing.join(', ')}`);
    process.exit(1);
  }

  return {
    port: parseInt(process.env.PORT || '3022', 10),
    slack: {
      botToken: process.env.SLACK_BOT_TOKEN!,
      appToken: process.env.SLACK_APP_TOKEN!,
      signingSecret: process.env.SLACK_SIGNING_SECRET!,
    },
    aimaestro: {
      apiUrl: process.env.AIMAESTRO_API || 'http://127.0.0.1:23000',
      defaultAgent: process.env.DEFAULT_AGENT || 'default-agent',
      botAgent: 'slack-bot',
      hostId: process.env.HOST_ID || 'localhost',
    },
    cache: {
      agentTtlMs: parseInt(process.env.CACHE_AGENT_TTL_MS || '300000', 10),
      hostsTtlMs: parseInt(process.env.CACHE_HOSTS_TTL_MS || '60000', 10),
      slackUserTtlMs: parseInt(process.env.CACHE_SLACK_USER_TTL_MS || '600000', 10),
    },
    polling: {
      intervalMs: parseInt(process.env.POLL_INTERVAL_MS || '2000', 10),
      timeoutMs: parseInt(process.env.POLL_TIMEOUT_MS || '5000', 10),
    },
    debug: process.env.DEBUG === 'true',
    adminToken: process.env.ADMIN_TOKEN || '',
  };
}
