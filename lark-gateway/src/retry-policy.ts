export const MAX_ATTEMPTS = 20;
export const MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const MAX_BACKOFF_MS = 5 * 60 * 1000;

export function backoffMs(attempts: number, baseMs: number): number {
  return Math.min(baseMs * 2 ** Math.max(0, Math.min(attempts - 1, 30)), MAX_BACKOFF_MS);
}

export function shouldPark(attempts: number, ageMs: number): boolean {
  return attempts >= MAX_ATTEMPTS && ageMs >= MAX_AGE_MS;
}
