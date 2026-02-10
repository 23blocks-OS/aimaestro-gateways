/**
 * Stats API
 *
 * Gateway metrics endpoint.
 */

import { Router, Request, Response } from 'express';
import type { GatewayConfig } from '../types.js';
import { getEventCount, getTodayStats } from './activity-log.js';

const startTime = Date.now();

let cachedAimaestroStatus: boolean | null = null;
let lastAimaestroCheck = 0;
const HEALTH_CACHE_TTL_MS = 30000;

export function createStatsRouter(
  getConfig: () => GatewayConfig,
  getAgentCacheSize: () => number
): Router {
  const router = Router();

  /**
   * GET /api/stats — Gateway metrics
   */
  router.get('/', async (req: Request, res: Response) => {
    const config = getConfig();
    const uptime = Date.now() - startTime;

    // Check AI Maestro connectivity (cached for 30s)
    const now = Date.now();
    if (cachedAimaestroStatus === null || now - lastAimaestroCheck > HEALTH_CACHE_TTL_MS) {
      try {
        const resp = await fetch(`${config.aimaestro.apiUrl}/api/health`, {
          signal: AbortSignal.timeout(3000),
        });
        cachedAimaestroStatus = resp.ok;
      } catch {
        cachedAimaestroStatus = false;
      }
      lastAimaestroCheck = now;
    }
    const aimaestroReachable = cachedAimaestroStatus;

    const today = getTodayStats();

    res.json({
      status: 'online',
      version: '0.1.0',
      uptime,
      uptimeHuman: formatUptime(uptime),
      port: config.port,
      totalEventsLogged: getEventCount(),
      today,
      connections: {
        aimaestro: aimaestroReachable,
        slack: true, // If we're serving this request, Slack bolt is running
      },
      cache: {
        agents: getAgentCacheSize(),
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
