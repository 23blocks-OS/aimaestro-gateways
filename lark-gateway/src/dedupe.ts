/** Persists event, message, and card action deduplication state. */
import fs from "node:fs";
import path from "node:path";

const TTL_MS = 24 * 60 * 60 * 1000;
export class DedupeStore {
  private seen = new Map<string, number>();
  constructor(
    private filePath: string,
    private ttlMs = TTL_MS,
  ) {
    this.load();
  }
  private load(): void {
    try {
      const data = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Record<
        string,
        number
      >;
      for (const [key, at] of Object.entries(data))
        if (Date.now() - at < this.ttlMs) this.seen.set(key, at);
    } catch {
      /* first run */
    }
  }
  has(eventId: string, messageId: string): boolean {
    this.prune();
    return Boolean(
      (eventId && this.seen.has(`e:${eventId}`)) ||
      (messageId && this.seen.has(`m:${messageId}`)),
    );
  }
  mark(eventId: string, messageId: string): void {
    const now = Date.now();
    if (eventId) this.seen.set(`e:${eventId}`, now);
    if (messageId) this.seen.set(`m:${messageId}`, now);
    this.save();
  }
  hasRouted(messageId: string): boolean {
    this.prune();
    return this.seen.has(`r:${messageId}`);
  }
  markRouted(messageId: string): void {
    this.seen.set(`r:${messageId}`, Date.now());
    this.save();
  }
  hasOrAdd(eventId: string, messageId: string): boolean {
    if (this.has(eventId, messageId)) return true;
    this.mark(eventId, messageId);
    return false;
  }
  private prune(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [key, at] of this.seen) if (at < cutoff) this.seen.delete(key);
  }
  save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(Object.fromEntries(this.seen)), {
      mode: 0o600,
    });
    fs.renameSync(temporary, this.filePath);
  }
}
