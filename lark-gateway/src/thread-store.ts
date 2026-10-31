/** Persists Lark message-to-agent context with expiry and size limits. */
import fs from "node:fs";
import path from "node:path";
import type { ThreadContext } from "./types.js";

/** Persist Lark message-to-agent context and evict old or oversized state. */
export class ThreadStore {
  private entries = new Map<string, ThreadContext>();
  private pruneTimer: NodeJS.Timeout;

  constructor(
    private filePath: string,
    private ttlMs = 30 * 24 * 60 * 60 * 1000,
    private maxEntries = 5000,
    private maxFileBytes = 2 * 1024 * 1024,
    pruneIntervalMs = 60 * 60 * 1000,
  ) {
    this.load();
    this.pruneTimer = setInterval(() => this.pruneNow(), pruneIntervalMs);
    this.pruneTimer.unref();
  }

  set(id: string, context: ThreadContext): void {
    this.entries.set(id, context);
    this.save();
  }

  get(id: string): ThreadContext | undefined {
    const context = this.entries.get(id);
    if (!context) return undefined;
    if (Date.now() - context.createdAt <= this.ttlMs) return context;
    this.entries.delete(id);
    this.save();
    return undefined;
  }

  findByRoot(rootId: string): ThreadContext | undefined {
    this.pruneExpired();
    return [...this.entries.values()].find(
      (context) => context.rootId === rootId,
    );
  }

  updateStatus(rootId: string, status: "working" | "done"): void {
    for (const context of this.entries.values()) {
      if (context.rootId === rootId) context.status = status;
    }
    this.save();
  }

  size(): number {
    return this.entries.size;
  }

  pruneNow(): void {
    this.save();
  }

  close(): void {
    clearInterval(this.pruneTimer);
    this.save();
  }

  private pruneExpired(): boolean {
    const cutoff = Date.now() - this.ttlMs;
    let changed = false;
    for (const [key, context] of this.entries) {
      if (!Number.isFinite(context.createdAt) || context.createdAt < cutoff) {
        this.entries.delete(key);
        changed = true;
      }
    }
    return changed;
  }

  private load(): void {
    let changed = false;
    try {
      const data = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Record<
        string,
        ThreadContext
      >;
      for (const [key, value] of Object.entries(data)) {
        if (
          value &&
          Number.isFinite(value.createdAt) &&
          Date.now() - value.createdAt <= this.ttlMs
        )
          this.entries.set(key, value);
        else changed = true;
      }
    } catch {
      /* first run */
    }
    const loadedEntries = this.entries.size;
    this.enforceLimits();
    if (changed || this.entries.size !== loadedEntries) this.save();
  }

  private enforceLimits(): void {
    const oldestFirst = [...this.entries.entries()].sort(
      (a, b) => a[1].createdAt - b[1].createdAt,
    );
    while (this.entries.size > this.maxEntries) {
      const first = oldestFirst.shift();
      if (!first) break;
      this.entries.delete(first[0]);
    }
    while (
      Buffer.byteLength(
        JSON.stringify(Object.fromEntries(this.entries), null, 2),
      ) > this.maxFileBytes &&
      this.entries.size > 0
    ) {
      const first = oldestFirst.shift();
      if (!first) break;
      this.entries.delete(first[0]);
    }
  }

  save(): void {
    this.pruneExpired();
    this.enforceLimits();
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    fs.writeFileSync(
      temporary,
      JSON.stringify(Object.fromEntries(this.entries), null, 2),
      { mode: 0o600 },
    );
    fs.renameSync(temporary, this.filePath);
  }
}
