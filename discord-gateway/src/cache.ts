/**
 * Discord Gateway - Generic TTL Cache
 *
 * Simple in-memory cache with time-based expiration.
 */

export class Cache<T> {
  private store = new Map<string, { value: T; cachedAt: number }>();
  private ttlMs: number;
  private maxSize: number;
  private cleanupIntervalId: ReturnType<typeof setInterval> | null = null;

  constructor(ttlMs: number, maxSize: number = 1000) {
    this.ttlMs = ttlMs;
    this.maxSize = maxSize;
  }

  get(key: string): T | null {
    const entry = this.store.get(key);
    if (!entry) return null;

    if (Date.now() - entry.cachedAt > this.ttlMs) {
      this.store.delete(key);
      return null;
    }

    return entry.value;
  }

  set(key: string, value: T): void {
    // Evict oldest entry if at max capacity
    if (this.store.size >= this.maxSize && !this.store.has(key)) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey !== undefined) {
        this.store.delete(oldestKey);
      }
    }
    this.store.set(key, { value, cachedAt: Date.now() });
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }

  size(): number {
    return this.store.size;
  }

  /** Remove all expired entries from the cache. */
  cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (now - entry.cachedAt > this.ttlMs) {
        this.store.delete(key);
      }
    }
  }

  /** Start periodic cleanup of expired entries. */
  startCleanup(intervalMs: number): void {
    this.stopCleanup();
    this.cleanupIntervalId = setInterval(() => this.cleanup(), intervalMs);
  }

  /** Stop periodic cleanup. */
  stopCleanup(): void {
    if (this.cleanupIntervalId !== null) {
      clearInterval(this.cleanupIntervalId);
      this.cleanupIntervalId = null;
    }
  }
}
