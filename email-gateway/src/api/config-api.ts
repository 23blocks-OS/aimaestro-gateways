/**
 * Config Management API
 *
 * GET/PATCH endpoints for gateway configuration.
 */

import { Router, Request, Response } from 'express';
import { GatewayConfig, RouteTarget, reloadRouting, getRoutingFilePath } from '../config.js';
import { SecurityConfig } from '../content-security.js';
import { readFile, writeFile } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { stringify as yamlStringify } from 'yaml';

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
   * GET /api/config — Overview (sanitized, no secrets)
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
      },
      mandrill: {
        configured: !!config.mandrill.apiKey,
        tenants: Object.keys(config.mandrill.webhookKeys),
      },
      routing: {
        routeCount: Object.keys(config.routing.routes).length,
        defaultCount: Object.keys(config.routing.defaults).length,
      },
      outbound: {
        pollIntervalMs: config.outbound.pollIntervalMs,
      },
    });
  });

  /**
   * GET /api/config/routing — Full routing config
   */
  router.get('/routing', async (req: Request, res: Response) => {
    const config = getConfig();

    // Check if AI Maestro email index is reachable
    let emailIndexStatus = { available: false, lastError: '' };
    try {
      const resp = await fetch(`${config.aimaestro.apiUrl}/api/agents/email-index`, {
        signal: AbortSignal.timeout(3000),
      });
      emailIndexStatus.available = resp.ok;
      if (!resp.ok) emailIndexStatus.lastError = `HTTP ${resp.status}`;
    } catch (err: any) {
      emailIndexStatus.lastError = err.message || 'Connection failed';
    }

    res.json({
      routes: config.routing.routes,
      defaults: config.routing.defaults,
      emailIndex: emailIndexStatus,
    });
  });

  /**
   * PATCH /api/config/routing — Update routing rules
   * Body: { routes?: Record<string, RouteTarget>, defaults?: Record<string, RouteTarget> }
   */
  router.patch('/routing', async (req: Request, res: Response) => {
    if (!adminToken) {
      return res.status(403).json({ error: 'ADMIN_TOKEN required for security configuration changes' });
    }

    const config = getConfig();
    const { routes, defaults } = req.body;

    // Merge updates
    const newRoutes = routes !== undefined ? routes : config.routing.routes;
    const newDefaults = defaults !== undefined ? defaults : config.routing.defaults;

    // Write to routing.yaml (use empty object instead of null for YAML readability)
    const routingData: Record<string, unknown> = {};
    if (Object.keys(newRoutes).length > 0) {
      routingData.routes = newRoutes;
    }
    if (Object.keys(newDefaults).length > 0) {
      routingData.defaults = newDefaults;
    }

    const routingPath = getRoutingFilePath();
    const yamlContent = yamlStringify(routingData, { indent: 2 });
    await writeFile(routingPath, yamlContent, 'utf-8');

    // Hot-reload config
    reloadRouting(config);

    res.json({
      ok: true,
      routes: config.routing.routes,
      defaults: config.routing.defaults,
    });
  });

  /**
   * GET /api/config/security — Security settings
   */
  router.get('/security', (req: Request, res: Response) => {
    const secConfig = getSecurityConfig();
    res.json({
      operatorEmails: secConfig.operatorEmails,
    });
  });

  /**
   * PATCH /api/config/security — Update operator whitelist
   * Body: { operatorEmails: string[] }
   */
  router.patch('/security', async (req: Request, res: Response) => {
    if (!adminToken) {
      return res.status(403).json({ error: 'ADMIN_TOKEN required for security configuration changes' });
    }

    const { operatorEmails } = req.body;

    if (!Array.isArray(operatorEmails)) {
      return res.status(400).json({ error: 'operatorEmails must be an array' });
    }

    const normalized = operatorEmails.map((e: string) => e.trim().toLowerCase()).filter(Boolean);

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const invalidEmails = normalized.filter((e: string) => !emailRegex.test(e));
    if (invalidEmails.length > 0) {
      return res.status(400).json({ error: `Invalid email address(es): ${invalidEmails.join(', ')}` });
    }

    // Update in-memory config
    const newSecConfig: SecurityConfig = { operatorEmails: normalized };
    updateSecurityConfig(newSecConfig);

    // Persist to .env
    await updateEnvVariable('OPERATOR_EMAILS', normalized.join(','));

    res.json({ ok: true, operatorEmails: normalized });
  });

  /**
   * GET /api/config/outbound — Outbound settings
   */
  router.get('/outbound', async (req: Request, res: Response) => {
    const config = getConfig();

    // Check Mandrill API reachability (cached for 30s)
    const now = Date.now();
    if (cachedMandrillReachable === null || now - lastMandrillCheck > HEALTH_CACHE_TTL_MS) {
      try {
        const resp = await fetch('https://mandrillapp.com/api/1.0/users/ping', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: config.mandrill.apiKey }),
          signal: AbortSignal.timeout(5000),
        });
        cachedMandrillReachable = resp.ok;
        cachedMandrillLastError = resp.ok ? '' : `HTTP ${resp.status}`;
      } catch (err: any) {
        cachedMandrillReachable = false;
        cachedMandrillLastError = err.message || 'Connection failed';
      }
      lastMandrillCheck = now;
    }

    res.json({
      pollIntervalMs: config.outbound.pollIntervalMs,
      mandrill: { reachable: cachedMandrillReachable, lastError: cachedMandrillLastError },
    });
  });

  return router;
}

// Mandrill health check cache
let cachedMandrillReachable: boolean | null = null;
let cachedMandrillLastError: string = '';
let lastMandrillCheck = 0;
const HEALTH_CACHE_TTL_MS = 30000;

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
