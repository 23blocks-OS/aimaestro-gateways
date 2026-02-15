/**
 * In-memory activity log (ring buffer)
 *
 * Tracks gateway events for the management UI.
 * Not persisted - resets on restart.
 */

import crypto from 'crypto';

export interface ActivityEvent {
  id: string;
  timestamp: string;
  type: 'inbound' | 'outbound' | 'error' | 'security';
  summary: string;
  details: {
    from?: string;
    to?: string;
    subject?: string;
    tenant?: string;
    routeMatch?: string;
    securityFlags?: string[];
    error?: string;
    ampMessageId?: string;
    deliveryStatus?: string;
  };
}

const MAX_EVENTS = 500;
const events: ActivityEvent[] = [];

export function logEvent(
  type: ActivityEvent['type'],
  summary: string,
  details: ActivityEvent['details'] = {}
): ActivityEvent {
  const event: ActivityEvent = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    type,
    summary,
    details,
  };

  events.push(event);

  if (events.length > MAX_EVENTS) {
    events.shift();
  }

  return event;
}

export function getEvents(options: {
  limit?: number;
  type?: ActivityEvent['type'];
  search?: string;
} = {}): ActivityEvent[] {
  let filtered = events;

  if (options.type) {
    filtered = filtered.filter(e => e.type === options.type);
  }

  if (options.search) {
    const q = options.search.toLowerCase();
    filtered = filtered.filter(e =>
      e.summary.toLowerCase().includes(q) ||
      e.details.from?.toLowerCase().includes(q) ||
      e.details.to?.toLowerCase().includes(q) ||
      e.details.subject?.toLowerCase().includes(q)
    );
  }

  const limit = options.limit || 100;
  return filtered.slice(-limit).reverse();
}

export function getTodayStats(): {
  inbound: number;
  outbound: number;
  errors: number;
  security: number;
  total: number;
} {
  const today = new Date().toISOString().slice(0, 10);
  const counts = { inbound: 0, outbound: 0, errors: 0, security: 0, total: 0 };
  for (const e of events) {
    if (e.timestamp < today) continue;
    counts.total++;
    if (e.type === 'inbound') counts.inbound++;
    else if (e.type === 'outbound') counts.outbound++;
    else if (e.type === 'error') counts.errors++;
    else if (e.type === 'security') counts.security++;
  }
  return counts;
}

export function getEventCount(): number {
  return events.length;
}
