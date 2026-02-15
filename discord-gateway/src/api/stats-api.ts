/**
 * Stats API (AMP Protocol)
 *
 * Gateway metrics endpoint.
 */

import { Router, Request, Response } from 'express';
import type { GatewayConfig } from '../types.js';
import { getEventCount, getTodayStats } from './activity-log.js';

const startTime = Date.now();

let cachedMaestroStatus: boolean | null = null;
let lastMaestroCheck = 0;
const HEALTH_CACHE_TTL_MS = 30000;

export function createStatsRouter(
  getConfig: () => GatewayConfig,
  isDiscordConnected: () => boolean
): Router {
  const router = Router();

  router.get('/', async (req: Request, res: Response) => {
    const config = getConfig();
    const uptime = Date.now() - startTime;

    const now = Date.now();
    if (cachedMaestroStatus === null || now - lastMaestroCheck > HEALTH_CACHE_TTL_MS) {
      try {
        const resp = await fetch(`${config.amp.maestroUrl}/api/v1/health`, {
          signal: AbortSignal.timeout(3000),
        });
        cachedMaestroStatus = resp.ok;
      } catch {
        cachedMaestroStatus = false;
      }
      lastMaestroCheck = now;
    }

    const today = getTodayStats();

    res.json({
      status: 'online',
      protocol: 'AMP',
      version: '0.2.0',
      uptime,
      uptimeHuman: formatUptime(uptime),
      port: config.port,
      totalEventsLogged: getEventCount(),
      today,
      connections: {
        maestro: cachedMaestroStatus,
        discord: isDiscordConnected(),
      },
      amp: {
        agent: config.amp.agentAddress,
        tenant: config.amp.tenant,
      },
    });
  });

  return router;
}

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}
