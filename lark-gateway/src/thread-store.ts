import fs from 'node:fs';
import path from 'node:path';
import type { ThreadContext } from './types.js';

export class ThreadStore {
  private entries = new Map<string, ThreadContext>();
  constructor(private filePath: string, private ttlMs = 30 * 24 * 60 * 60 * 1000) { this.load(); }
  set(id: string, context: ThreadContext): void { this.entries.set(id, context); this.save(); }
  get(id: string): ThreadContext | undefined { const ctx = this.entries.get(id); if (ctx && Date.now() - ctx.createdAt <= this.ttlMs) return ctx; return undefined; }
  findByRoot(rootId: string): ThreadContext | undefined { return [...this.entries.values()].find((ctx) => ctx.rootId === rootId && Date.now() - ctx.createdAt <= this.ttlMs); }
  updateStatus(rootId: string, status: 'working' | 'done'): void { for (const ctx of this.entries.values()) if (ctx.rootId === rootId) ctx.status = status; this.save(); }
  size(): number { return this.entries.size; }
  private load(): void { try { const data = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Record<string, ThreadContext>; for (const [key, value] of Object.entries(data)) if (Date.now() - value.createdAt <= this.ttlMs) this.entries.set(key, value); } catch { /* first run */ } }
  save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(Object.fromEntries(this.entries), null, 2), { mode: 0o600 });
    fs.renameSync(temporary, this.filePath);
  }
}
