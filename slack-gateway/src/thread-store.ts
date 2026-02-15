/**
 * Thread Context Store
 *
 * Maps AMP message IDs to Slack thread context so agent replies
 * can be routed back to the correct Slack channel and thread.
 */

import * as fs from 'fs';
import type { ThreadContext } from './types.js';

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export class ThreadStore {
  private store = new Map<string, ThreadContext>();
  private cleanupIntervalId: ReturnType<typeof setInterval> | null = null;
  private ttlMs: number;

  constructor(ttlMs: number = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  set(messageId: string, context: ThreadContext): void {
    this.store.set(messageId, context);
  }

  get(messageId: string): ThreadContext | undefined {
    const ctx = this.store.get(messageId);
    if (!ctx) return undefined;

    if (Date.now() - ctx.createdAt > this.ttlMs) {
      this.store.delete(messageId);
      return undefined;
    }

    return ctx;
  }

  /**
   * Find a thread context by Slack channel + thread_ts.
   * Useful for matching replies that come via a different path.
   */
  findByThread(channel: string, thread_ts: string): ThreadContext | undefined {
    for (const ctx of this.store.values()) {
      if (ctx.channel === channel && ctx.thread_ts === thread_ts) {
        if (Date.now() - ctx.createdAt > this.ttlMs) continue;
        return ctx;
      }
    }
    return undefined;
  }

  /** Remove all expired entries. */
  cleanup(): void {
    const now = Date.now();
    for (const [key, ctx] of this.store) {
      if (now - ctx.createdAt > this.ttlMs) {
        this.store.delete(key);
      }
    }
  }

  /** Start periodic cleanup. */
  startCleanup(intervalMs: number = 60000): void {
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

  size(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }

  /** Save to JSON file for restart persistence. */
  save(filePath: string): void {
    const data = Object.fromEntries(this.store);
    try {
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    } catch (err) {
      console.error('[ThreadStore] Failed to save:', err);
    }
  }

  /** Load from JSON file. */
  load(filePath: string): void {
    try {
      if (!fs.existsSync(filePath)) return;
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const now = Date.now();
      for (const [key, ctx] of Object.entries(data)) {
        const context = ctx as ThreadContext;
        if (now - context.createdAt < this.ttlMs) {
          this.store.set(key, context);
        }
      }
      console.log(`[ThreadStore] Loaded ${this.store.size} thread(s) from ${filePath}`);
    } catch (err) {
      console.error('[ThreadStore] Failed to load:', err);
    }
  }
}
