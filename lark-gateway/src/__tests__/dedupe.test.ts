import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DedupeStore } from '../dedupe.js';

test('deduplicates both event and message ids across a process restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-dedupe-')); const file = path.join(dir, 'dedupe.json');
  const first = new DedupeStore(file); assert.equal(first.hasOrAdd('event-1', 'message-1'), false);
  const restarted = new DedupeStore(file); assert.equal(restarted.hasOrAdd('event-1b', 'message-1'), true);
  assert.equal(restarted.hasOrAdd('event-1', 'message-2'), true);
  restarted.markRouted('message-1');
  assert.equal(new DedupeStore(file).hasRouted('message-1'), true);
});
