/**
 * Log hygiene helpers.
 *
 * A gateway that loops on a permanent error can write gigabytes of log in a
 * few days (a 13 GB pm2 log came from exactly that). These helpers keep the
 * log useful: one line per transition, repeats counted instead of repeated,
 * and errors reduced to one short line instead of whole objects.
 *
 * This file is intentionally identical in slack-gateway and email-gateway
 * (each gateway ships on its own, so it cannot be imported across them).
 */

const MAX_ERR_LINE = 300;

/** Collapse any thrown value to a single line of at most 300 characters. No stack. */
export function errLine(err: unknown): string {
  let text: string;
  if (err === null || err === undefined) {
    text = String(err);
  } else if (typeof err === 'string') {
    text = err;
  } else if (typeof err === 'object') {
    const e = err as { message?: unknown; data?: { error?: unknown }; code?: unknown };
    const parts: string[] = [];
    if (typeof e.message === 'string' && e.message) parts.push(e.message);
    if (typeof e.data?.error === 'string' && e.data.error) parts.push(`slack=${e.data.error}`);
    if (e.code !== undefined && e.code !== null && e.code !== '') parts.push(`code=${String(e.code)}`);
    text = parts.length > 0 ? parts.join(' | ') : Object.prototype.toString.call(err);
  } else {
    text = String(err);
  }
  text = text.replace(/\s+/g, ' ').trim();
  return text.length > MAX_ERR_LINE ? `${text.slice(0, MAX_ERR_LINE - 3)}...` : text;
}

/** Truncate untrusted text for logging, flattening whitespace. */
export function clip(text: unknown, max = 80): string {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}

export interface LogOnceOptions {
  windowMs?: number;
  sink?: (line: string) => void;
}

/**
 * Build a rate-limited logger. The first call for a key logs immediately.
 * Further calls with the same key inside the window are only counted; when the
 * window closes a single "repeated N times" line is emitted (if N > 0).
 */
export function createLogOnce(options: LogOnceOptions = {}) {
  const windowMs = options.windowMs ?? 5 * 60 * 1000;
  const sink = options.sink ?? ((line: string) => console.warn(line));
  const open = new Map<string, { count: number; message: string; timer: NodeJS.Timeout }>();

  function logOnce(key: string, message: string): void {
    const entry = open.get(key);
    if (entry) {
      entry.count++;
      return;
    }
    sink(message);
    const created = {
      count: 0,
      message,
      timer: setTimeout(() => {
        open.delete(key);
        if (created.count > 0) {
          sink(`${created.message} (repeated ${created.count} times in the last ${Math.round(windowMs / 1000)}s)`);
        }
      }, windowMs),
    };
    created.timer.unref?.();
    open.set(key, created);
  }

  return logOnce;
}

/** Process-wide default: 5 minute window, console.warn. */
export const logOnce = createLogOnce();
