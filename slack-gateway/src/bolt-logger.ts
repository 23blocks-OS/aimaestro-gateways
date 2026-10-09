/**
 * Logger for the Slack Bolt App.
 *
 * Bolt's default logger prints every socket-mode warning ("pong wasn't
 * received", "getaddrinfo EAI_AGAIN" while the network is down) each time it
 * happens. This one passes info/debug through unchanged and rate-limits
 * warn/error with logOnce, one line per distinct message per window.
 */

import { LogLevel, type Logger } from '@slack/bolt';
import { createLogOnce, errLine } from './log-hygiene.js';

const ORDER: Record<string, number> = {
  [LogLevel.DEBUG]: 0,
  [LogLevel.INFO]: 1,
  [LogLevel.WARN]: 2,
  [LogLevel.ERROR]: 3,
};

function format(args: unknown[]): string {
  return args
    .map((a) => (typeof a === 'string' ? a : errLine(a)))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Dedup key: the message with digits removed, so "client:0" and "client:1" collapse. */
function keyOf(level: string, message: string): string {
  return `${level}:${message.replace(/\d+/g, '#').slice(0, 160)}`;
}

export function createBoltLogger(
  level: LogLevel = LogLevel.INFO,
  sink: (level: 'info' | 'debug' | 'warn' | 'error', line: string) => void = (l, line) => console[l === 'debug' ? 'log' : l](line),
  windowMs?: number
): Logger {
  let current = level;
  let name = '';
  const limited = {
    warn: createLogOnce({ windowMs, sink: (line) => sink('warn', line) }),
    error: createLogOnce({ windowMs, sink: (line) => sink('error', line) }),
  };
  const enabled = (l: LogLevel) => ORDER[l] >= ORDER[current];
  const prefix = () => (name ? `[${name}] ` : '');

  return {
    debug: (...args) => enabled(LogLevel.DEBUG) && sink('debug', `[DEBUG] ${prefix()}${format(args)}`),
    info: (...args) => enabled(LogLevel.INFO) && sink('info', `[INFO] ${prefix()}${format(args)}`),
    warn: (...args) => {
      if (!enabled(LogLevel.WARN)) return;
      const msg = format(args);
      limited.warn(keyOf('warn', msg), `[WARN] ${prefix()}${msg}`);
    },
    error: (...args) => {
      if (!enabled(LogLevel.ERROR)) return;
      const msg = format(args);
      limited.error(keyOf('error', msg), `[ERROR] ${prefix()}${msg}`);
    },
    setLevel: (l) => {
      current = l;
    },
    getLevel: () => current,
    setName: (n) => {
      name = n;
    },
  };
}
