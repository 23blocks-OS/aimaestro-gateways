/** Tests outbound message formatting, routing, attachments, and authorization. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OutboundPoller } from '../outbound.js';
import { ThreadStore } from '../thread-store.js';
import type { GatewayConfig, RoutingConfig } from '../types.js';
import { isAgentSender } from '../routing.js';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const inboxFiles = (inbox: string) =>
  fs
    .readdirSync(inbox, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? fs
            .readdirSync(path.join(inbox, entry.name))
            .map((name) => path.join(inbox, entry.name, name))
        : [path.join(inbox, entry.name)],
    );
test('outbound selects plain text or card, splits, routes initiations and sends attachments', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-out-'));
  const inbox = path.join(dir, 'inbox');
  fs.mkdirSync(inbox);
  const config = {
    amp: { inboxDir: inbox, tenant: 'example' },
    pollIntervalMs: 10,
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
    default_reply_unknown: '',
    disabled_person: '',
    group_pointer: '',
  };
  const calls: Array<{ type: string; text?: string; chat?: string }> = [];
  const ops: any = {
    reply: async () => {},
    sendText: async (chat: string, text: string) => {
      calls.push({ type: 'text', text, chat });
      return '';
    },
    sendCard: async (chat: string, card: any) => {
      calls.push({ type: 'card', text: JSON.stringify(card), chat });
      return '';
    },
    sendAttachment: async (
      chat: string,
      _parent: string | undefined,
      attachment: any,
    ) => {
      calls.push({
        type: 'attachment',
        chat,
        text: JSON.stringify(attachment),
      });
    },
    finishReaction: async () => {},
  };
  const mk = (
    name: string,
    message: string,
    context: Record<string, unknown>,
    attachments: unknown[] = [],
  ) => {
    fs.mkdirSync(path.join(inbox, 'alice_agent_example_aimaestro_local'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(inbox, 'alice_agent_example_aimaestro_local', name),
      JSON.stringify({
        envelope: {
          id: name,
          from: 'alice-agent@example.aimaestro.local',
          in_reply_to: null,
        },
        payload: { message, context: { lark: context }, attachments },
      }),
    );
  };
  mk('one.json', 'Hello', { to: 'alice' });
  mk('three.json', '# Untitled\n\nbody', { to: 'alice' });
  mk(
    'two.json',
    '# Heading\n\n' + 'x '.repeat(18000),
    {
      to: 'alice',
      title: 'Shortlist',
      buttons: [{ label: 'Confirm', action: 'confirm', value: { yes: true } }],
    },
    [{ name: 'a.png', content_type: 'image/png', content: 'eA==' }],
  );
  const poller = new OutboundPoller(
    config,
    () => routing,
    new ThreadStore(path.join(dir, 'threads.json')),
    ops,
  );
  poller.start();
  for (let i = 0; i < 100 && inboxFiles(inbox).length; i++) await wait(10);
  poller.stop();
  assert.ok(calls.some((c) => c.type === 'text' && c.text === 'Hello'));
  assert.ok(calls.filter((c) => c.type === 'card').length >= 2);
  // Card JSON 2.0, so headings and tables render; buttons use a callback.
  const cards = calls
    .filter((c) => c.type === 'card')
    .map((c) => JSON.parse(c.text || '{}'));
  assert.ok(cards.every((card) => card.schema === '2.0'));
  // A header only when the agent sets context.lark.title, on the first chunk.
  assert.deepEqual(
    cards.filter((card) => card.header).map((card) => card.header),
    [{ title: { tag: 'plain_text', content: 'Shortlist' } }],
  );
  assert.match(
    cards.find((card) => card.header).body.elements[0].content,
    /^# Heading/,
  );
  // Inbox order is filesystem order; find two.json's last chunk by its buttons.
  const withButtons = cards.filter((card) => card.body.elements.length > 1);
  assert.equal(withButtons.length, 1, 'buttons only on the last chunk');
  const last = withButtons[0].body.elements;
  assert.equal(last[0].tag, 'markdown');
  assert.equal(last[1].tag, 'button');
  assert.deepEqual(last[1].behaviors[0], {
    type: 'callback',
    value: {
      agent: 'alice-agent',
      action: 'confirm',
      value: { yes: true },
      amp_thread: 'two.json',
      owner: 'alice',
    },
  });
  const twoCards = cards.filter(
    (card) => !card.body.elements[0].content.startsWith('# Untitled'),
  );
  assert.equal(twoCards[twoCards.length - 1], withButtons[0]);
  assert.ok(calls.some((c) => c.type === 'attachment'));
  assert.match(
    calls.find((c) => c.type === 'attachment')?.text || '',
    /"content":"eA=="/,
  );
  assert.ok(calls.every((c) => c.chat === 'ou_example'));
  assert.equal(
    isAgentSender(
      'alice-agent@example.aimaestro.local',
      'alice-agent',
      'example',
    ),
    true,
  );
});

test('parks wrong agent replies and agent-initiated DMs while allowing each configured owner', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-auth-'));
  const inbox = path.join(dir, 'inbox');
  fs.mkdirSync(inbox);
  const config = {
    amp: { inboxDir: inbox, tenant: 'example' },
    pollIntervalMs: 10,
  } as GatewayConfig;
  const routing: RoutingConfig = {
    people: {
      alice: {
        open_id: 'ou_alice',
        agent: 'alice-agent',
        enabled: true,
        admin: false,
      },
      bob: {
        open_id: 'ou_bob',
        agent: 'bob-agent',
        enabled: true,
        admin: false,
      },
    },
    default_reply_unknown: 'unknown',
    disabled_person: 'paused',
    group_pointer: 'DM',
  };
  const sent: Array<{ chat: string; text: string }> = [];
  const notices: string[] = [];
  const ops = {
    reply: async (chat: string) => {
      notices.push(chat);
    },
    sendText: async (chat: string, text: string) => {
      sent.push({ chat, text });
      return `sent-${sent.length}`;
    },
    sendCard: async (chat: string, card: Record<string, unknown>) => {
      sent.push({ chat, text: JSON.stringify(card) });
      return `sent-${sent.length}`;
    },
    sendAttachment: async () => {},
    finishReaction: async () => {},
  };
  const threads = new ThreadStore(path.join(dir, 'threads.json'));
  threads.set('known-message', {
    messageId: 'known-message',
    rootId: 'known-root',
    chatId: 'ou_bob',
    chatType: 'p2p',
    openId: 'ou_bob',
    person: 'bob',
    agent: 'bob-agent',
    createdAt: Date.now(),
  });
  const write = (
    name: string,
    from: string,
    context: Record<string, unknown>,
    reply?: string,
  ) => {
    fs.mkdirSync(path.join(inbox, from.replace(/[@.]/g, '_')), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(inbox, from.replace(/[@.]/g, '_'), name),
      JSON.stringify({
        envelope: { id: name, from, in_reply_to: reply || null },
        payload: { message: 'hi', context: { lark: context } },
      }),
    );
  };
  write(
    'wrong-thread.json',
    'alice-agent@example.aimaestro.local',
    {},
    'known-message',
  );
  write(
    'owner-thread.json',
    'bob-agent@example.aimaestro.local',
    {},
    'known-message',
  );
  write('wrong-to.json', 'bob-agent@example.aimaestro.local', { to: 'alice' });
  write('owner.json', 'alice-agent@example.aimaestro.local', { to: 'alice' });
  const poller = new OutboundPoller(config, () => routing, threads, ops);
  poller.start();
  for (let i = 0; i < 100 && inboxFiles(inbox).length; i++) await wait(10);
  poller.stop();
  threads.close();
  assert.deepEqual(
    sent.sort((a, b) => a.chat.localeCompare(b.chat)),
    [
      { chat: 'ou_alice', text: 'hi' },
      { chat: 'ou_bob', text: 'hi' },
    ],
  );
  assert.deepEqual(fs.readdirSync(path.join(dir, 'undeliverable')).sort(), [
    'wrong-thread.json',
    'wrong-thread.json.reason.json',
    'wrong-to.json',
    'wrong-to.json.reason.json',
  ]);
  const reason = JSON.parse(
    fs.readFileSync(
      path.join(dir, 'undeliverable', 'wrong-to.json.reason.json'),
      'utf8',
    ),
  );
  assert.match(reason.reason, /Unauthorized AMP sender/);
  // A message from another agent must not make the bot message the person.
  await wait(20);
  assert.deepEqual(notices, []);
});

test('a parked message notifies only the destination its sender was authorized for', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-notice-'));
  const inbox = path.join(dir, 'inbox');
  const config = {
    amp: { inboxDir: inbox, tenant: 'example' },
    pollIntervalMs: 5,
  } as GatewayConfig;
  const routing: RoutingConfig = {
    people: {
      alice: {
        open_id: 'ou_alice',
        agent: 'alice-agent',
        enabled: true,
        admin: false,
      },
      bob: {
        open_id: 'ou_bob',
        agent: 'bob-agent',
        enabled: true,
        admin: false,
      },
    },
    default_reply_unknown: '',
    disabled_person: '',
    group_pointer: '',
  };
  const notices: string[] = [];
  const ops = {
    reply: async (chat: string) => {
      notices.push(chat);
    },
    sendText: async (): Promise<string> => {
      throw new Error('Lark API 400: invalid content');
    },
    sendCard: async () => '',
    sendAttachment: async () => {},
    finishReaction: async () => {},
  };
  const write = (agent: string, name: string, lark: Record<string, unknown>) => {
    const senderDir = path.join(inbox, `${agent}_agent_example_aimaestro_local`);
    fs.mkdirSync(senderDir, { recursive: true });
    fs.writeFileSync(
      path.join(senderDir, name),
      JSON.stringify({
        envelope: {
          id: name,
          from: `${agent}-agent@example.aimaestro.local`,
          in_reply_to: null,
        },
        payload: { message: 'hi', context: { lark } },
      }),
    );
  };
  // Lark rejects the owner's reply: one notice, to the owner's DM.
  write('alice', 'bad.json', { to: 'alice' });
  // Same, addressed by the Lark message id of the owner's thread.
  write('alice', 'viaid.json', { message_id: 'thread-a' });
  // Authorized through its own thread, but names bob and breaks: the notice
  // still goes to the thread it was authorized for, never to bob.
  write('alice', 'spoof.json', {
    message_id: 'thread-a',
    to: 'bob',
    buttons: [{ label: 1, action: 'a' }],
  });
  // Not bob's agent: parked silently.
  write('mallory', 'intruder.json', { to: 'bob' });
  const threads = new ThreadStore(path.join(dir, 'threads.json'));
  threads.set('thread-a', {
    messageId: 'thread-a',
    rootId: 'thread-a',
    chatId: 'oc_alice',
    chatType: 'p2p',
    openId: 'ou_alice',
    person: 'alice',
    agent: 'alice-agent',
    createdAt: Date.now(),
  });
  const poller = new OutboundPoller(config, () => routing, threads, ops);
  poller.start();
  for (let i = 0; i < 100 && inboxFiles(inbox).length; i++) await wait(10);
  await wait(20);
  poller.stop();
  threads.close();
  assert.deepEqual(notices.sort(), ['oc_alice', 'oc_alice', 'ou_alice']);
  assert.ok(
    fs.existsSync(path.join(dir, 'undeliverable', 'intruder.json.reason.json')),
  );
  const reason = JSON.parse(
    fs.readFileSync(
      path.join(dir, 'undeliverable', 'bad.json.reason.json'),
      'utf8',
    ),
  );
  assert.match(reason.reason, /invalid content/);
});

test('an authorization from an earlier attempt does not survive a routing change', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-stale-'));
  const inbox = path.join(dir, 'inbox');
  const config = {
    amp: { inboxDir: inbox, tenant: 'example' },
    pollIntervalMs: 5,
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
  const notices: string[] = [];
  const ops = {
    reply: async (chat: string) => {
      notices.push(chat);
    },
    sendText: async (): Promise<string> => {
      // The first attempt fails in transit, and meanwhile alice is moved to
      // another agent: the retry must fail the owner check and park quietly.
      routing.people.alice!.agent = 'new-agent';
      throw new Error('ECONNRESET');
    },
    sendCard: async () => '',
    sendAttachment: async () => {},
    finishReaction: async () => {},
  };
  const senderDir = path.join(inbox, 'alice_agent_example_aimaestro_local');
  fs.mkdirSync(senderDir, { recursive: true });
  fs.writeFileSync(
    path.join(senderDir, 'stale.json'),
    JSON.stringify({
      envelope: {
        id: 'stale.json',
        from: 'alice-agent@example.aimaestro.local',
        in_reply_to: null,
      },
      payload: { message: 'hi', context: { lark: { to: 'alice' } } },
    }),
  );
  const threads = new ThreadStore(path.join(dir, 'threads.json'));
  const poller = new OutboundPoller(config, () => routing, threads, ops);
  poller.start();
  for (let i = 0; i < 300 && inboxFiles(inbox).length; i++) await wait(10);
  await wait(20);
  poller.stop();
  threads.close();
  assert.ok(
    fs.existsSync(path.join(dir, 'undeliverable', 'stale.json.reason.json')),
  );
  assert.deepEqual(notices, []);
});

test('partial outbound sends checkpoint completed chunks and do not resend after permanent or local failures', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-partial-out-'));
  const inbox = path.join(dir, 'inbox');
  const senderDir = path.join(inbox, 'alice_agent_example_aimaestro_local');
  fs.mkdirSync(senderDir, { recursive: true });
  const config = {
    amp: { inboxDir: inbox, tenant: 'example' },
    pollIntervalMs: 5,
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
  const write = (name: string, reply?: string) =>
    fs.writeFileSync(
      path.join(senderDir, name),
      JSON.stringify({
        envelope: {
          id: name,
          from: 'alice-agent@example.aimaestro.local',
          in_reply_to: reply || null,
        },
        payload: {
          message: 'x '.repeat(4000),
          context: { lark: reply ? {} : { to: 'alice' } },
        },
      }),
    );
  write('permanent.json');
  let attempts = 0;
  let failSecond = true;
  const threads = new ThreadStore(path.join(dir, 'threads.json'));
  const ops: any = {
    reply: async () => {},
    sendText: async () => {
      attempts++;
      if (failSecond && attempts === 2)
        throw new Error('Lark API 400: invalid params');
      return 'sent';
    },
    sendCard: async () => '',
    sendAttachment: async () => {},
    finishReaction: async () => {},
  };
  const poller = new OutboundPoller(config, () => routing, threads, ops);
  poller.start();
  for (
    let i = 0;
    i < 100 && fs.existsSync(path.join(senderDir, 'permanent.json'));
    i++
  )
    await wait(10);
  poller.stop();
  assert.equal(attempts, 2);
  assert.ok(fs.existsSync(path.join(dir, 'undeliverable', 'permanent.json')));

  const replyDir = path.join(inbox, 'reply_agent_example_aimaestro_local');
  fs.mkdirSync(replyDir, { recursive: true });
  write('local.json', 'known');
  threads.set('known', {
    messageId: 'lark-parent',
    rootId: 'lark-parent',
    chatId: 'oc_chat',
    chatType: 'p2p',
    openId: 'ou_alice',
    person: 'alice',
    agent: 'alice-agent',
    createdAt: Date.now(),
  });
  fs.renameSync(
    path.join(senderDir, 'local.json'),
    path.join(replyDir, 'local.json'),
  );
  let localFailures = 0;
  const originalUpdate = threads.updateStatus.bind(threads);
  threads.updateStatus = ((root: string, status: 'working' | 'done') => {
    if (localFailures++ === 0) throw new Error('local bookkeeping failure');
    originalUpdate(root, status);
  }) as typeof threads.updateStatus;
  attempts = 0;
  failSecond = false;
  const localPoller = new OutboundPoller(config, () => routing, threads, ops);
  localPoller.start();
  for (
    let i = 0;
    i < 100 && fs.existsSync(path.join(replyDir, 'local.json'));
    i++
  )
    await wait(10);
  localPoller.stop();
  threads.close();
  assert.equal(
    attempts,
    3,
    `all chunks should have been delivered; inbox=${JSON.stringify(fs.readdirSync(inbox))}, parked=${JSON.stringify(fs.readdirSync(path.join(dir, 'undeliverable')))}; local=${localFailures}`,
  );
});
