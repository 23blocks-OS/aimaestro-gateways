/** Tests inbound delivery limits and restart-safe multi-sender traffic. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InboundProcessor, type LarkOps } from '../inbound.js';
import { DedupeStore } from '../dedupe.js';
import { ThreadStore } from '../thread-store.js';
import { OutboundPoller } from '../outbound.js';
import type { GatewayConfig, RoutingConfig } from '../types.js';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (predicate: () => boolean, timeout = 8000) => {
  const end = Date.now() + timeout;
  while (!predicate() && Date.now() < end) await wait(5);
  assert.ok(predicate(), 'timed out waiting for queued events');
};

test('100-message soak routes 5 senders once across a persisted restart without leaking open_id', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-soak-'));
  const config = {
    amp: {
      apiKey: 'fake',
      agentAddress: 'lark-bot@example.aimaestro.local',
      tenant: 'example',
      maestroUrl: 'http://fake',
      inboxDir: path.join(dir, 'inbox'),
    },
    stateDir: dir,
    timeoutMs: 1000,
    pollIntervalMs: 10,
    workingDelayMs: 100000,
  } as GatewayConfig;
  const routing: RoutingConfig = {
    people: Object.fromEntries(
      Array.from({ length: 5 }, (_, i) => [
        `person${i}`,
        {
          open_id: `ou_example_${i}`,
          agent: `agent${i}`,
          enabled: true,
          admin: false,
        },
      ]),
    ),
    default_reply_unknown: 'unknown',
    disabled_person: 'paused',
    group_pointer: 'DM',
  };
  const seen = new Set<string>();
  const payloads: any[] = [];
  const deliveredReplies = new Map<string, string>();
  fs.mkdirSync(config.amp.inboxDir, { recursive: true });
  const oldFetch = globalThis.fetch;
  globalThis.fetch = (async (_url, init) => {
    await wait(2);
    const body = JSON.parse(String(init?.body));
    payloads.push(body);
    const messageId = body.payload.context.lark.message_id;
    if (seen.has(messageId)) throw new Error('duplicate route');
    seen.add(messageId);
    const senderDir = path.join(
      config.amp.inboxDir,
      body.to.replace(/[@.]/g, '_'),
    );
    fs.mkdirSync(senderDir, { recursive: true });
    const replyFile = path.join(senderDir, `reply-${messageId}.json`);
    fs.writeFileSync(
      replyFile,
      JSON.stringify({
        envelope: {
          id: `reply-${messageId}`,
          from: body.to,
          in_reply_to: `amp-${messageId}`,
        },
        payload: { message: `reply ${messageId}`, context: { lark: {} } },
      }),
    );
    return new Response(JSON.stringify({ id: `amp-${messageId}` }), {
      status: 200,
    });
  }) as typeof fetch;
  const ops: LarkOps = {
    download: async () => ({
      name: '',
      contentType: '',
      bytes: Buffer.alloc(0),
    }),
    parentText: async () => null,
    reply: async () => {},
    react: async () => {},
  };
  const make = () => {
    const threads = new ThreadStore(path.join(dir, 'threads.json'));
    const processor = new InboundProcessor(
      config,
      () => routing,
      new DedupeStore(path.join(dir, 'dedupe.json')),
      threads,
      ops,
    );
    return { processor, threads };
  };
  const outgoing = {
    reply: async () => {},
    sendText: async (chat: string, text: string) => {
      const messageId = text.replace('reply ', '');
      deliveredReplies.set(messageId, chat);
      return `lark-${messageId}`;
    },
    sendCard: async () => '',
    sendAttachment: async () => {},
    finishReaction: async () => {},
  };
  const deliverQueuedReplies = async (
    threads: ThreadStore,
    targetCount: number,
  ) => {
    await until(
      () =>
        fs
          .readdirSync(path.join(dir, 'inbound-queue'))
          .filter(
            (name) => name.endsWith('.json') && !name.endsWith('.retry.json'),
          ).length === 0,
    );
    const poller = new OutboundPoller(config, () => routing, threads, outgoing);
    poller.start();
    await until(() => deliveredReplies.size === targetCount);
    poller.stop();
  };
  const event = (n: number) => ({
    event_id: `event-${n}`,
    sender: {
      sender_id: { open_id: `ou_example_${n % 5}` },
      sender_type: 'user',
    },
    message: {
      message_id: `msg-${n}`,
      chat_id: `oc_dm_${n % 5}`,
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text: `hello ${n}` }),
      mentions: [],
    },
  });
  try {
    const first = make();
    first.processor.start();
    for (let n = 0; n < 40; n++) first.processor.enqueue(event(n));
    await until(() => seen.size === 40);
    await deliverQueuedReplies(first.threads, 40);
    first.processor.stop();
    first.threads.close();
    const restarted = make();
    restarted.processor.start();
    for (let n = 0; n < 40; n++) restarted.processor.enqueue(event(n));
    for (let n = 40; n < 100; n++) restarted.processor.enqueue(event(n));
    await until(() => seen.size === 100);
    await deliverQueuedReplies(restarted.threads, 100);
    restarted.processor.stop();
    restarted.threads.close();
    assert.equal(seen.size, 100);
    assert.equal(payloads.length, 100);
    for (const body of payloads) {
      const person = body.payload.context.channel.sender_id;
      assert.match(body.to, new RegExp(`agent${person.slice(-1)}@`));
      assert.equal(
        JSON.stringify(body).includes(`ou_example_${person.slice(-1)}`),
        false,
      );
      assert.equal(body.payload.context.security.trust, 'operator');
    }
    for (let n = 0; n < 100; n++)
      assert.equal(deliveredReplies.get(`msg-${n}`), `oc_dm_${n % 5}`);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test('100-DM in-flight restart soak measures the Maestro acceptance duplicate window', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-inflight-soak-'));
  const inbox = path.join(dir, 'inbox');
  const config = {
    amp: {
      apiKey: 'fake',
      agentAddress: 'lark-bot@example.aimaestro.local',
      tenant: 'example',
      maestroUrl: 'http://fake',
      inboxDir: inbox,
    },
    stateDir: dir,
    timeoutMs: 1000,
    pollIntervalMs: 5,
    workingDelayMs: 100000,
  } as GatewayConfig;
  const routing: RoutingConfig = {
    people: Object.fromEntries(
      Array.from({ length: 5 }, (_, i) => [
        `person${i}`,
        {
          open_id: `ou_example_${i}`,
          agent: `agent${i}`,
          enabled: true,
          admin: false,
        },
      ]),
    ),
    default_reply_unknown: 'unknown',
    disabled_person: 'paused',
    group_pointer: 'DM',
  };
  const routeAttempts = new Map<string, number>();
  const agentReplies = new Set<string>();
  const delivered = new Map<string, string>();
  const deliveryCounts = new Map<string, number>();
  let initialAccepted = false;
  let releaseInitial!: () => void;
  const initialResponse = new Promise<void>((resolve) => {
    releaseInitial = resolve;
  });
  const writeAgentReply = (messageId: string, attempt: number, body: any) => {
    if (agentReplies.has(messageId)) return;
    agentReplies.add(messageId);
    const senderDir = path.join(inbox, String(body.to).replace(/[@.]/g, '_'));
    fs.mkdirSync(senderDir, { recursive: true });
    fs.writeFileSync(
      path.join(senderDir, `reply-${messageId}.json`),
      JSON.stringify({
        envelope: {
          id: `reply-${messageId}`,
          from: body.to,
          in_reply_to: `amp-${messageId}-${attempt}`,
        },
        payload: {
          message: `reply ${messageId}`,
          context: {
            lark: {
              message_id: messageId,
              to: body.payload.context.lark.person,
            },
          },
        },
      }),
    );
  };
  const oldFetch = globalThis.fetch;
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    const messageId = body.payload.context.lark.message_id;
    const attempt = (routeAttempts.get(messageId) || 0) + 1;
    routeAttempts.set(messageId, attempt);
    writeAgentReply(messageId, attempt, body);
    if (messageId === 'msg-000' && attempt === 1) {
      initialAccepted = true;
      await initialResponse;
    }
    return Response.json({ id: `amp-${messageId}-${attempt}` });
  }) as typeof fetch;
  const ops: LarkOps = {
    download: async () => ({
      name: '',
      contentType: '',
      bytes: Buffer.alloc(0),
    }),
    parentText: async () => null,
    reply: async () => {},
    react: async () => {},
  };
  const make = () => {
    const threads = new ThreadStore(path.join(dir, 'threads.json'));
    const processor = new InboundProcessor(
      config,
      () => routing,
      new DedupeStore(path.join(dir, 'dedupe.json')),
      threads,
      ops,
    );
    const poller = new OutboundPoller(config, () => routing, threads, {
      reply: async () => {},
      sendText: async (chat, text) => {
        const messageId = text.replace('reply ', '');
        delivered.set(messageId, chat);
        deliveryCounts.set(messageId, (deliveryCounts.get(messageId) || 0) + 1);
        return `lark-${text}`;
      },
      sendCard: async () => '',
      sendAttachment: async () => {},
      finishReaction: async () => {},
    });
    return { threads, processor, poller };
  };
  const event = (n: number) => ({
    schema: '2.0',
    header: { event_id: `event-${n}`, event_type: 'im.message.receive_v1' },
    event: {
      sender: {
        sender_id: { open_id: `ou_example_${n % 5}` },
        sender_type: 'user',
      },
      message: {
        message_id: `msg-${String(n).padStart(3, '0')}`,
        chat_id: `oc_dm_${n % 5}`,
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: `hello ${n}` }),
        mentions: [],
      },
    },
  });
  try {
    const first = make();
    first.processor.start();
    first.poller.start();
    for (let n = 0; n < 100; n++) first.processor.enqueue(event(n) as any);
    await until(() => initialAccepted);
    await until(() => delivered.has('msg-000'));
    // The first route was accepted and produced a reply, but its HTTP response
    // (and therefore its AMP ID) is still outstanding. Stop both worker objects
    // and rebuild state readers from disk while the other 99 routes remain queued.
    first.processor.stop();
    first.poller.stop();
    first.threads.close();
    const restarted = make();
    restarted.processor.start();
    restarted.poller.start();
    await until(() => delivered.size === 100, 10000);
    releaseInitial();
    await wait(10);
    restarted.processor.stop();
    restarted.poller.stop();
    restarted.threads.close();
    const unique = routeAttempts.size;
    const accepted = [...routeAttempts.values()].reduce(
      (sum, count) => sum + count,
      0,
    );
    const duplicates = accepted - unique;
    const lost = 100 - delivered.size;
    console.log(
      `[SOAK] accepted route requests=${accepted}; logical messages=${unique}; acceptance-window duplicates=${duplicates}; lost replies=${lost}`,
    );
    assert.equal(unique, 100);
    assert.equal(duplicates, 1);
    assert.equal(lost, 0);
    assert.equal(delivered.size, 100);
    for (let n = 0; n < 100; n++) {
      const id = `msg-${String(n).padStart(3, '0')}`;
      assert.equal(routeAttempts.has(id), true, `${id} was routed`);
      assert.equal(
        delivered.get(id),
        `oc_dm_${n % 5}`,
        `${id} returned to its sender DM`,
      );
      assert.equal(deliveryCounts.get(id), 1, `${id} was delivered once`);
    }
    assert.equal(fs.existsSync(path.join(dir, 'undeliverable-inbound')), false);
    assert.equal(fs.existsSync(path.join(dir, 'undeliverable')), false);
  } finally {
    releaseInitial();
    globalThis.fetch = oldFetch;
  }
});

test('attachment limit replies clearly and does not route an oversized attachment set', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-limit-'));
  const config = {
    amp: {
      apiKey: 'fake',
      agentAddress: 'bot',
      tenant: 'example',
      maestroUrl: 'http://fake',
      inboxDir: path.join(dir, 'inbox'),
    },
    stateDir: dir,
    timeoutMs: 1000,
    workingDelayMs: 100000,
  } as GatewayConfig;
  const routing: RoutingConfig = {
    people: {
      alice: {
        open_id: 'ou_example',
        agent: 'alice',
        enabled: true,
        admin: false,
      },
    },
    default_reply_unknown: 'unknown',
    disabled_person: 'paused',
    group_pointer: 'DM',
  };
  let replies = 0;
  const oldFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('must not route');
  }) as typeof fetch;
  const ops: LarkOps = {
    download: async () => ({
      name: 'large.png',
      contentType: 'image/png',
      bytes: Buffer.alloc(26 * 1024 * 1024),
    }),
    parentText: async () => null,
    reply: async (_chat, text) => {
      if (text.includes('10 attachment limit') || text.includes('25 MB limit'))
        replies++;
    },
    react: async () => {},
  };
  try {
    const processor = new InboundProcessor(
      config,
      () => routing,
      new DedupeStore(path.join(dir, 'dedupe.json')),
      new ThreadStore(path.join(dir, 'threads.json')),
      ops,
    );
    processor.start();
    const items = Array.from({ length: 11 }, (_, i) => ({
      tag: 'img',
      image_key: `img_${i}`,
    }));
    processor.enqueue({
      event_id: 'limit-event',
      sender: { sender_id: { open_id: 'ou_example' }, sender_type: 'user' },
      message: {
        message_id: 'limit-msg',
        chat_id: 'oc_dm',
        chat_type: 'p2p',
        message_type: 'post',
        content: JSON.stringify({ content: [items] }),
        mentions: [],
      },
    } as any);
    await until(() => replies === 1);
    processor.enqueue({
      event_id: 'size-event',
      sender: { sender_id: { open_id: 'ou_example' }, sender_type: 'user' },
      message: {
        message_id: 'size-msg',
        chat_id: 'oc_dm',
        chat_type: 'p2p',
        message_type: 'image',
        content: JSON.stringify({ image_key: 'img_large' }),
        mentions: [],
      },
    } as any);
    await until(() => replies === 2);
    processor.stop();
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test('uploads inbound bytes to fake Maestro and routes only the resulting attachment reference', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-amp-attachment-'));
  const config = {
    amp: {
      apiKey: 'fake-key',
      agentAddress: 'lark-bot@example.aimaestro.local',
      tenant: 'example',
      maestroUrl: 'https://maestro.example.invalid',
      inboxDir: path.join(dir, 'inbox'),
    },
    stateDir: dir,
    timeoutMs: 1000,
    pollIntervalMs: 50,
    workingDelayMs: 100_000,
  } as GatewayConfig;
  const routing: RoutingConfig = {
    people: {
      alice: {
        open_id: 'ou_example_alice',
        agent: 'alice-agent',
        enabled: true,
        admin: false,
      },
    },
    default_reply_unknown: 'unknown',
    disabled_person: 'paused',
    group_pointer: 'DM',
  };
  const calls: string[] = [];
  let routed: any;
  let uploadFilename = '';
  const oldFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    calls.push(`${init?.method || 'GET'} ${url}`);
    if (url.endsWith('/api/v1/attachments/upload')) {
      uploadFilename = JSON.parse(String(init?.body)).filename;
      return Response.json({
        data: {
          attachment_id: 'att_123',
          upload_url: 'https://upload.example.invalid/put',
        },
      });
    }
    if ((init?.method || 'GET') === 'PUT')
      return Response.json({ data: { scan_status: 'clean' } });
    if (url.endsWith('/confirm'))
      return Response.json({ data: { scan_status: 'clean' } });
    if (url.endsWith('/att_123'))
      return Response.json({
        data: {
          url: 'https://maestro.example.invalid/api/v1/attachments/att_123/content?token=cap',
          scan_status: 'clean',
          expires_at: '2027-01-01T00:00:00Z',
        },
      });
    routed = JSON.parse(String(init?.body));
    return Response.json({ id: 'amp-attachment-route' });
  }) as typeof fetch;
  const ops: LarkOps = {
    download: async () => ({
      name: 'resource-key',
      contentType: 'text/plain',
      bytes: Buffer.from('hello attachment'),
    }),
    parentText: async () => null,
    reply: async () => {},
    react: async () => {},
  };
  try {
    const processor = new InboundProcessor(
      config,
      () => routing,
      new DedupeStore(path.join(dir, 'dedupe.json')),
      new ThreadStore(path.join(dir, 'threads.json')),
      ops,
    );
    processor.start();
    processor.enqueue({
      event_id: 'attachment-event',
      sender: {
        sender_id: { open_id: 'ou_example_alice' },
        sender_type: 'user',
      },
      message: {
        message_id: 'attachment-message',
        chat_id: 'ou_example_alice',
        chat_type: 'p2p',
        message_type: 'file',
        content: JSON.stringify({
          file_key: 'file_key',
          file_name: 'note.txt',
        }),
        mentions: [],
      },
    } as any);
    await until(() => Boolean(routed));
    processor.stop();
    assert.equal(
      calls.filter((call) => call.includes('attachments/')).length,
      3,
    );
    assert.equal(routed.payload.attachments[0].id, 'att_123');
    assert.equal(uploadFilename, 'note.txt');
    assert.equal(routed.payload.attachments[0].scan_status, 'clean');
    assert.equal(routed.payload.attachments[0].url.includes('token=cap'), true);
    assert.equal('content' in routed.payload.attachments[0], false);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

const parentCases = [
  [
    'their own message',
    { text: 'Parent asks about schedule', fromBot: false, senderOpenId: 'ou_example' },
    'alice',
  ],
  ['an agent message', { text: 'Parent asks about schedule', fromBot: true }, 'agent'],
] as const;
for (const [quoted, parentMessage, author] of parentCases)
  test(`fetches the reply parent text (quoting ${quoted}) and sends only the person slug while stripping bot mentions`, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-parent-'));
  const config = {
    amp: {
      apiKey: 'fake',
      agentAddress: 'bot',
      tenant: 'example',
      maestroUrl: 'http://fake',
      inboxDir: path.join(dir, 'inbox'),
    },
    stateDir: dir,
    timeoutMs: 1000,
    pollIntervalMs: 50,
    workingDelayMs: 100_000,
  } as GatewayConfig;
  const routing: RoutingConfig = {
    people: {
      alice: {
        open_id: 'ou_example',
        agent: 'alice-agent',
        enabled: true,
        admin: false,
      },
    },
    default_reply_unknown: 'unknown',
    disabled_person: 'paused',
    group_pointer: 'DM',
  };
  let routed: any;
  const oldFetch = globalThis.fetch;
  globalThis.fetch = (async (_url, init) => {
    routed = JSON.parse(String(init?.body));
    return Response.json({ id: 'amp-parent-route' });
  }) as typeof fetch;
  let fetched = '';
  const ops: LarkOps = {
    download: async () => ({
      name: '',
      contentType: '',
      bytes: Buffer.alloc(0),
    }),
    parentText: async (id) => {
      fetched = id;
      return parentMessage;
    },
    reply: async () => {},
    react: async () => {},
  };
  try {
    const processor = new InboundProcessor(
      config,
      () => routing,
      new DedupeStore(path.join(dir, 'dedupe.json')),
      new ThreadStore(path.join(dir, 'threads.json')),
      ops,
    );
    processor.start();
    processor.enqueue({
      event_id: 'parent-event',
      sender: { sender_id: { open_id: 'ou_example' }, sender_type: 'user' },
      message: {
        message_id: 'child',
        parent_id: 'parent',
        chat_id: 'oc_dm_parent',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: '@_bot @_alice answer please' }),
        mentions: [
          { key: '@_bot', name: 'AI', mentioned_type: 'bot' },
          { key: '@_alice', name: 'Alice', mentioned_type: 'user' },
        ],
      },
    } as any);
    await until(() => Boolean(routed));
    processor.stop();
    assert.equal(fetched, 'parent');
    assert.match(
      routed.payload.context.lark.parent_text,
      new RegExp(
        `<external-content source="lark" sender="${author}" trust="(?:external|forwarded)">[\\s\\S]*Parent asks about schedule[\\s\\S]*</external-content>`,
      ),
    );
    assert.equal(routed.payload.message.includes('@_bot'), false);
    assert.equal(routed.payload.message.includes('@Alice'), true);
    assert.equal(routed.payload.context.channel.sender_id, 'alice');
    assert.equal(JSON.stringify(routed).includes('ou_example'), false);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test('poison inbound messages back off, park, and send one failure reply', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-poison-'));
  const config = {
    amp: {
      apiKey: 'fake',
      agentAddress: 'bot',
      tenant: 'example',
      maestroUrl: 'http://fake',
      inboxDir: path.join(dir, 'inbox'),
    },
    stateDir: dir,
    timeoutMs: 1000,
    pollIntervalMs: 50,
    workingDelayMs: 100_000,
  } as GatewayConfig;
  const routing: RoutingConfig = {
    people: {
      alice: {
        open_id: 'ou_example',
        agent: 'alice-agent',
        enabled: true,
        admin: false,
      },
    },
    default_reply_unknown: 'unknown',
    disabled_person: 'paused',
    group_pointer: 'DM',
  };
  let attempts = 0;
  let replies = 0;
  const oldFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    attempts++;
    return new Response('unavailable', { status: 503 });
  }) as typeof fetch;
  const ops: LarkOps = {
    download: async () => ({
      name: '',
      contentType: '',
      bytes: Buffer.alloc(0),
    }),
    parentText: async () => null,
    reply: async (_chat, text) => {
      if (text.includes('could not deliver')) replies++;
    },
    react: async () => {},
  };
  try {
    const processor = new InboundProcessor(
      config,
      () => routing,
      new DedupeStore(path.join(dir, 'dedupe.json')),
      new ThreadStore(path.join(dir, 'threads.json')),
      ops,
      { maxAttempts: 3, maxAgeMs: 10_000, baseDelayMs: 1 },
    );
    processor.start();
    processor.enqueue({
      event_id: 'poison-event',
      sender: { sender_id: { open_id: 'ou_example' }, sender_type: 'user' },
      message: {
        message_id: 'poison',
        chat_id: 'ou_example',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: 'hello' }),
        mentions: [],
      },
    } as any);
    await until(
      () =>
        fs.existsSync(path.join(dir, 'undeliverable-inbound', 'poison.json')),
      5000,
    );
    processor.stop();
    assert.equal(attempts, 3);
    assert.equal(replies, 1);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test('permanent Maestro 4xx parks a message immediately and sends one notice', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-permanent-inbound-'));
  const config = {
    amp: {
      apiKey: 'fake',
      agentAddress: 'bot',
      tenant: 'example',
      maestroUrl: 'http://fake',
      inboxDir: path.join(dir, 'inbox'),
    },
    stateDir: dir,
    timeoutMs: 1000,
    pollIntervalMs: 10,
    workingDelayMs: 100000,
  } as GatewayConfig;
  const routing: RoutingConfig = {
    people: {
      alice: {
        open_id: 'ou_alice',
        agent: 'alice-agent',
        enabled: true,
        admin: false,
      },
    },
    default_reply_unknown: '',
    disabled_person: '',
    group_pointer: '',
  };
  let attempts = 0;
  let notices = 0;
  const oldFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    attempts++;
    return new Response('forbidden', { status: 403 });
  }) as typeof fetch;
  const ops: LarkOps = {
    download: async () => ({
      name: '',
      contentType: '',
      bytes: Buffer.alloc(0),
    }),
    parentText: async () => null,
    reply: async (_chat, text) => {
      if (text.includes('could not deliver')) notices++;
    },
    react: async () => {},
  };
  try {
    const processor = new InboundProcessor(
      config,
      () => routing,
      new DedupeStore(path.join(dir, 'dedupe.json')),
      new ThreadStore(path.join(dir, 'threads.json')),
      ops,
    );
    processor.start();
    processor.enqueue({
      event_id: 'permanent-event',
      sender: { sender_id: { open_id: 'ou_alice' }, sender_type: 'user' },
      message: {
        message_id: 'permanent-message',
        chat_id: 'oc_alice',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: 'hello' }),
        mentions: [],
      },
    } as any);
    await until(() =>
      fs.existsSync(
        path.join(dir, 'undeliverable-inbound', 'permanent-message.json'),
      ),
    );
    processor.stop();
    assert.equal(attempts, 1);
    assert.equal(notices, 1);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test('@AIM tags override routing only for admins and alternate-agent content is external', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-admin-tag-'));
  const config = {
    amp: {
      apiKey: 'fake',
      agentAddress: 'bot',
      tenant: 'example',
      maestroUrl: 'http://fake',
      inboxDir: path.join(dir, 'inbox'),
    },
    stateDir: dir,
    timeoutMs: 1000,
    pollIntervalMs: 50,
    workingDelayMs: 100_000,
  } as GatewayConfig;
  const routing: RoutingConfig = {
    people: {
      alice: {
        open_id: 'ou_alice',
        agent: 'alice-agent',
        enabled: true,
        admin: true,
      },
      carol: {
        open_id: 'ou_carol',
        agent: 'carol-agent',
        enabled: true,
        admin: false,
      },
    },
    default_reply_unknown: 'unknown',
    disabled_person: 'paused',
    group_pointer: 'DM',
  };
  const routed: any[] = [];
  const oldFetch = globalThis.fetch;
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    routed.push(body);
    return Response.json({ id: `amp-${body.payload.context.lark.message_id}` });
  }) as typeof fetch;
  const ops: LarkOps = {
    download: async () => ({
      name: '',
      contentType: '',
      bytes: Buffer.alloc(0),
    }),
    parentText: async () => null,
    reply: async () => {},
    react: async () => {},
  };
  try {
    const processor = new InboundProcessor(
      config,
      () => routing,
      new DedupeStore(path.join(dir, 'dedupe.json')),
      new ThreadStore(path.join(dir, 'threads.json')),
      ops,
    );
    processor.start();
    for (const person of ['alice', 'carol'])
      processor.enqueue({
        event_id: `tag-${person}`,
        sender: {
          sender_id: { open_id: routing.people[person]!.open_id },
          sender_type: 'user',
        },
        message: {
          message_id: `tag-message-${person}`,
          chat_id: routing.people[person]!.open_id,
          chat_type: 'p2p',
          message_type: 'text',
          content: JSON.stringify({ text: '@AIM:bob-agent review' }),
          mentions: [],
        },
      } as any);
    // A tag inside forwarded content is not the admin choosing an agent.
    processor.enqueue({
      event_id: 'tag-forward',
      sender: { sender_id: { open_id: 'ou_alice' }, sender_type: 'user' },
      message: {
        message_id: 'tag-message-forward',
        chat_id: 'ou_alice',
        chat_type: 'p2p',
        message_type: 'merge_forward',
        content: JSON.stringify({
          messages: [
            {
              content: JSON.stringify({ text: '@AIM:bob-agent review' }),
              sender: { sender_name: 'forwarded sender' },
            },
          ],
        }),
        mentions: [],
      },
    } as any);
    await until(() => routed.length === 3);
    processor.stop();
    const forward = routed.find(
      (body) =>
        body.payload.context.lark.message_id === 'tag-message-forward',
    );
    assert.equal(forward.to, 'alice-agent@example.aimaestro.local');
    assert.equal(forward.payload.context.security.wrapped, true);
    const alice = routed.find(
      (body) =>
        body.payload.context.channel.sender_id === 'alice' &&
        body.payload.context.lark.message_id === 'tag-message-alice',
    );
    const carol = routed.find(
      (body) => body.payload.context.channel.sender_id === 'carol',
    );
    assert.equal(alice.to, 'bob-agent@example.aimaestro.local');
    assert.equal(alice.payload.context.security.trust, 'external');
    assert.equal(carol.to, 'carol-agent@example.aimaestro.local');
    assert.equal(carol.payload.context.security.trust, 'operator');
    assert.match(carol.payload.message, /@AIM:bob-agent/);
  } finally {
    globalThis.fetch = oldFetch;
  }
});
