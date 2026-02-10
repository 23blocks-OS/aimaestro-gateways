/**
 * Config Management API
 *
 * GET/PATCH endpoints for gateway configuration.
 */

import { Router, Request, Response } from 'express';
import { readFile, writeFile } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { GatewayConfig } from '../types.js';
import type { SecurityConfig } from '../content-security.js';

const __filename_local = fileURLToPath(import.meta.url);
const __dirname_local = dirname(__filename_local);

export function createConfigRouter(
  getConfig: () => GatewayConfig,
  getSecurityConfig: () => SecurityConfig,
  updateSecurityConfig: (config: SecurityConfig) => void,
  adminToken?: string
): Router {
  const router = Router();

  /**
   * GET /api/config — Overview (sanitized, no tokens)
   */
  router.get('/', (req: Request, res: Response) => {
    const config = getConfig();
    res.json({
      port: config.port,
      debug: config.debug,
      aimaestro: {
        apiUrl: config.aimaestro.apiUrl,
        botAgent: config.aimaestro.botAgent,
        hostId: config.aimaestro.hostId,
        defaultAgent: config.aimaestro.defaultAgent,
      },
      slack: {
        configured: !!config.slack.botToken,
      },
      cache: config.cache,
      polling: config.polling,
    });
  });

  /**
   * GET /api/config/security — Security settings
   */
  router.get('/security', (req: Request, res: Response) => {
    const secConfig = getSecurityConfig();
    res.json({
      operatorSlackIds: secConfig.operatorSlackIds,
    });
  });

  /**
   * PATCH /api/config/security — Update operator whitelist
   * Body: { operatorSlackIds: string[] }
   */
  router.patch('/security', async (req: Request, res: Response) => {
    if (!adminToken) {
      return res.status(403).json({ error: 'ADMIN_TOKEN required for security configuration changes' });
    }

    const { operatorSlackIds } = req.body;

    if (!Array.isArray(operatorSlackIds)) {
      return res.status(400).json({ error: 'operatorSlackIds must be an array' });
    }

    const normalized = operatorSlackIds.map((id: string) => id.trim()).filter(Boolean);

    // Validate Slack IDs (must match Slack user ID format: U followed by alphanumeric)
    const invalidIds = normalized.filter((id: string) => !/^U[A-Z0-9]+$/.test(id));
    if (invalidIds.length > 0) {
      return res.status(400).json({ error: `Invalid Slack ID(s): ${invalidIds.join(', ')}. Slack user IDs must match format U[A-Z0-9]+.` });
    }

    const newSecConfig: SecurityConfig = { operatorSlackIds: normalized };
    updateSecurityConfig(newSecConfig);

    // Persist to .env
    await updateEnvVariable('OPERATOR_SLACK_IDS', normalized.join(','));

    res.json({ ok: true, operatorSlackIds: normalized });
  });

  return router;
}

/**
 * Update a variable in the .env file.
 */
async function updateEnvVariable(key: string, value: string): Promise<void> {
  // Strip newlines to prevent .env injection
  value = value.replace(/[\r\n]/g, '');
  const envPath = resolve(__dirname_local, '..', '..', '.env');
  try {
    let content = await readFile(envPath, 'utf-8');
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`^${escapedKey}=.*$`, 'm');
    if (regex.test(content)) {
      content = content.replace(regex, `${key}=${value}`);
    } else {
      content += `\n${key}=${value}`;
    }
    await writeFile(envPath, content, 'utf-8');
  } catch (err) {
    console.error(`[CONFIG-API] Failed to update .env:`, err);
  }
}
