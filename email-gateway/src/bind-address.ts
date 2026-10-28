/**
 * Bind address for the management HTTP server.
 *
 * Default is loopback (127.0.0.1), so a gateway started outside a container is
 * never reachable from the network. Set BIND_ADDRESS (or HOST) to change it. The
 * Docker image sets BIND_ADDRESS=0.0.0.0 because a published container port only
 * reaches a server listening on the container's own interface. docker-compose
 * publishes the port as 127.0.0.1:PORT:PORT, so the host side stays loopback-only.
 */

export const DEFAULT_BIND_ADDRESS = '127.0.0.1';

/** BIND_ADDRESS wins over HOST; blank values fall back to the loopback default. */
export function resolveBindAddress(env: NodeJS.ProcessEnv = process.env): string {
  const value = (env.BIND_ADDRESS ?? '').trim() || (env.HOST ?? '').trim();
  return value || DEFAULT_BIND_ADDRESS;
}

/** True for 127.0.0.0/8, ::1 and localhost (with or without IPv6 brackets). */
export function isLoopbackAddress(address: string): boolean {
  const a = address.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (a === 'localhost' || a === '::1' || a === '::ffff:127.0.0.1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a);
}

/** URL for log messages; wraps IPv6 literals in brackets. */
export function formatHttpUrl(address: string, port: number): string {
  const a = address.replace(/^\[|\]$/g, '');
  return `http://${a.includes(':') ? `[${a}]` : a}:${port}`;
}

/**
 * Warning text for a non-loopback bind with no ADMIN_TOKEN, or null when the
 * configuration is fine. Never returns the token value.
 */
export function exposureWarning(address: string, adminToken: string | undefined): string | null {
  if (isLoopbackAddress(address) || adminToken) return null;
  return (
    `[SECURITY WARNING] Management API is bound to ${address} (not loopback) and ADMIN_TOKEN is not set. ` +
    'Anyone who can reach this port can read the API without authentication. ' +
    'Set ADMIN_TOKEN, or bind to 127.0.0.1 (in Docker, keep the 127.0.0.1:PORT:PORT port mapping).'
  );
}
