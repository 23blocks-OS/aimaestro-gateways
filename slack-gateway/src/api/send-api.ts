/**
 * Send API
 *
 * Lets a caller post to Slack directly, without going through the AMP
 * inbox. Useful for scripts, cron jobs, and for testing target resolution
 * without a round trip through the mesh.
 *
 *   POST /api/slack/send
 *   { "to": "@juan", "text": "hello", "thread_ts": "…", "agent": "…" }
 *
 * `to`        destination — see slack-target.ts for accepted forms
 * `text`      message body
 * `thread_ts` optional; reply into an existing thread instead of starting one
 * `agent`     optional AMP address to route human replies back to
 *
 * Sits behind the same ADMIN_TOKEN auth as the other /api routes.
 */

import { Router, Request, Response } from 'express';
import type { App } from '@slack/bolt';
import type { TargetResolver } from '../slack-target.js';
import { TargetResolutionError } from '../slack-target.js';
import type { ThreadStore } from '../thread-store.js';
import { logEvent } from './activity-log.js';

export function createSendRouter(
  slackApp: App,
  targetResolver: TargetResolver,
  threadStore: ThreadStore
): Router {
  const router = Router();

  router.post('/send', async (req: Request, res: Response) => {
    const { to, text, thread_ts, agent } = (req.body ?? {}) as {
      to?: unknown;
      text?: unknown;
      thread_ts?: unknown;
      agent?: unknown;
    };

    if (typeof to !== 'string' || !to.trim()) {
      return res.status(400).json({ error: 'to is required' });
    }
    if (typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ error: 'text is required' });
    }
    if (thread_ts !== undefined && typeof thread_ts !== 'string') {
      return res.status(400).json({ error: 'thread_ts must be a string' });
    }
    if (agent !== undefined && typeof agent !== 'string') {
      return res.status(400).json({ error: 'agent must be a string' });
    }

    try {
      const target = await targetResolver.resolve(to);

      const posted = await slackApp.client.chat.postMessage({
        channel: target.channel,
        thread_ts,
        text,
      });

      // Register the thread so a human reply routes back to the named agent.
      if (agent && !thread_ts && posted.ts) {
        const key = `slack-http-${posted.ts}`;
        threadStore.set(key, {
          channel: target.channel,
          thread_ts: posted.ts,
          user: '',
          userName: agent.split('@')[0],
          ampMessageId: key,
          createdAt: Date.now(),
          agentAddress: agent,
        });
      }

      logEvent('outbound', `Message posted to Slack via API: ${target.requested}`, {
        to: target.requested,
        subject: text.substring(0, 80),
        deliveryStatus: 'delivered',
      });

      return res.json({
        ok: true,
        channel: target.channel,
        kind: target.kind,
        ts: posted.ts,
      });
    } catch (error) {
      if (error instanceof TargetResolutionError) {
        return res.status(404).json({ error: error.message });
      }
      const message = (error as Error).message;
      console.error('[SEND] Failed to post message:', message);
      logEvent('error', `Failed to post message via API: ${message}`, { to });
      return res.status(502).json({ error: message });
    }
  });

  return router;
}
