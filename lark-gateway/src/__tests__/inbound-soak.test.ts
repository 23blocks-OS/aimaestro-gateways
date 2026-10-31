import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InboundProcessor, type LarkOps } from '../inbound.js';
import { DedupeStore } from '../dedupe.js';
import { ThreadStore } from '../thread-store.js';
import type { GatewayConfig, RoutingConfig } from '../types.js';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (predicate: () => boolean, timeout = 8000) => { const end = Date.now() + timeout; while (!predicate() && Date.now() < end) await wait(5); assert.ok(predicate(), 'timed out waiting for queued events'); };

test('100-message soak routes 5 senders once across a persisted restart without leaking open_id', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-soak-'));
  const config = { amp: { apiKey: 'fake', agentAddress: 'lark-bot@example.aimaestro.local', tenant: 'example', maestroUrl: 'http://fake', inboxDir: path.join(dir, 'inbox') }, stateDir: dir, timeoutMs: 1000, workingDelayMs: 100000 } as GatewayConfig;
  const routing: RoutingConfig = { people: Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`person${i}`, { open_id: `ou_example_${i}`, agent: `agent${i}`, enabled: true, admin: false }])), default_reply_unknown: 'unknown', disabled_person: 'paused', group_pointer: 'DM' };
  const seen = new Set<string>(); const payloads: any[] = [];
  const oldFetch = globalThis.fetch;
  globalThis.fetch = (async (_url, init) => { await wait(2); const body = JSON.parse(String(init?.body)); payloads.push(body); const messageId = body.payload.context.lark.message_id; if (seen.has(messageId)) throw new Error('duplicate route'); seen.add(messageId); return new Response(JSON.stringify({ id: `amp-${messageId}` }), { status: 200 }); }) as typeof fetch;
  const ops: LarkOps = { download: async () => ({ name: '', contentType: '', bytes: Buffer.alloc(0) }), parentText: async () => null, reply: async () => {}, react: async () => {} };
  const make = () => new InboundProcessor(config, () => routing, new DedupeStore(path.join(dir, 'dedupe.json')), new ThreadStore(path.join(dir, 'threads.json')), ops);
  const event = (n: number) => ({ event_id: `event-${n}`, sender: { sender_id: { open_id: `ou_example_${n % 5}` }, sender_type: 'user' }, message: { message_id: `msg-${n}`, chat_id: `oc_dm_${n % 5}`, chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text: `hello ${n}` }), mentions: [] } });
  try {
    const first = make(); first.start(); for (let n = 0; n < 40; n++) first.enqueue(event(n));
    await until(() => seen.size === 40); first.stop();
    const restarted = make(); restarted.start();
    for (let n = 0; n < 40; n++) restarted.enqueue(event(n));
    for (let n = 40; n < 100; n++) restarted.enqueue(event(n));
    await until(() => seen.size === 100); restarted.stop();
    assert.equal(seen.size, 100); assert.equal(payloads.length, 100);
    for (const body of payloads) {
      const person = body.payload.context.channel.sender_id;
      assert.match(body.to, new RegExp(`agent${person.slice(-1)}@`));
      assert.equal(JSON.stringify(body).includes(`ou_example_${person.slice(-1)}`), false);
      assert.equal(body.payload.context.security.trust, 'operator');
    }
  } finally { globalThis.fetch = oldFetch; }
});

test('attachment limit replies clearly and does not route an oversized attachment set', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-limit-'));
  const config = { amp: { apiKey: 'fake', agentAddress: 'bot', tenant: 'example', maestroUrl: 'http://fake', inboxDir: path.join(dir, 'inbox') }, stateDir: dir, timeoutMs: 1000, workingDelayMs: 100000 } as GatewayConfig;
  const routing: RoutingConfig = { people: { alice: { open_id: 'ou_example', agent: 'alice', enabled: true, admin: false } }, default_reply_unknown: 'unknown', disabled_person: 'paused', group_pointer: 'DM' };
  let replies = 0; const oldFetch = globalThis.fetch; globalThis.fetch = (async () => { throw new Error('must not route'); }) as typeof fetch;
  const ops: LarkOps = { download: async () => ({ name: 'large.png', contentType: 'image/png', bytes: Buffer.alloc(26 * 1024 * 1024) }), parentText: async () => null, reply: async (_chat, text) => { if (text.includes('10 attachment limit') || text.includes('25 MB limit')) replies++; }, react: async () => {} };
  try {
    const processor = new InboundProcessor(config, () => routing, new DedupeStore(path.join(dir, 'dedupe.json')), new ThreadStore(path.join(dir, 'threads.json')), ops); processor.start();
    const items = Array.from({ length: 11 }, (_, i) => ({ tag: 'img', image_key: `img_${i}` }));
    processor.enqueue({ event_id: 'limit-event', sender: { sender_id: { open_id: 'ou_example' }, sender_type: 'user' }, message: { message_id: 'limit-msg', chat_id: 'oc_dm', chat_type: 'p2p', message_type: 'post', content: JSON.stringify({ content: [items] }), mentions: [] } } as any);
    await until(() => replies === 1);
    processor.enqueue({ event_id: 'size-event', sender: { sender_id: { open_id: 'ou_example' }, sender_type: 'user' }, message: { message_id: 'size-msg', chat_id: 'oc_dm', chat_type: 'p2p', message_type: 'image', content: JSON.stringify({ image_key: 'img_large' }), mentions: [] } } as any);
    await until(() => replies === 2); processor.stop();
  } finally { globalThis.fetch = oldFetch; }
});
