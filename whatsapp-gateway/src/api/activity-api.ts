/**
 * Activity Log API
 *
 * Endpoints for retrieving gateway activity events and stats.
 */

import { Router } from 'express';
import { getEvents, getTodayStats } from './activity-log.js';
import type { ActivityEvent } from './activity-log.js';

export function createActivityRouter(): Router {
  const router = Router();

  /**
   * GET /api/activity — Recent events
   * Query params: limit, type, search
   */
  router.get('/', (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 100, 1), 500);
    const type = req.query.type as ActivityEvent['type'] | undefined;
    const search = req.query.search as string | undefined;

    const events = getEvents({ limit, type, search });
    res.json({ events, count: events.length });
  });

  /**
   * GET /api/activity/stats — Today's aggregate stats
   */
  router.get('/stats', (_req, res) => {
    res.json(getTodayStats());
  });

  return router;
}
