/** Tests inbound delivery limits and restart-safe multi-sender traffic. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { InboundProcessor, type LarkOps } from "../inbound.js";
import { DedupeStore } from "../dedupe.js";
import { ThreadStore } from "../thread-store.js";
import { OutboundPoller } from "../outbound.js";
import type { GatewayConfig, RoutingConfig } from "../types.js";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (predicate: () => boolean, timeout = 8000) => {
  const end = Date.now() + timeout;
  while (!predicate() && Date.now() < end) await wait(5);
  assert.ok(predicate(), "timed out waiting for queued events");
};

test("100-message soak routes 5 senders once across a persisted restart without leaking open_id", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lark-soak-"));
  const config = {
    amp: {
      apiKey: "fake",
      agentAddress: "lark-bot@example.aimaestro.local",
      tenant: "example",
      maestroUrl: "http://fake",
      inboxDir: path.join(dir, "inbox"),
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
    default_reply_unknown: "unknown",
    disabled_person: "paused",
    group_pointer: "DM",
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
    if (seen.has(messageId)) throw new Error("duplicate route");
    seen.add(messageId);
    const replyFile = path.join(config.amp.inboxDir, `reply-${messageId}.json`);
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
      name: "",
      contentType: "",
      bytes: Buffer.alloc(0),
    }),
    parentText: async () => null,
    reply: async () => {},
    react: async () => {},
  };
  const make = () => {
    const threads = new ThreadStore(path.join(dir, "threads.json"));
    const processor = new InboundProcessor(
      config,
      () => routing,
      new DedupeStore(path.join(dir, "dedupe.json")),
      threads,
      ops,
    );
    return { processor, threads };
  };
  const outgoing = {
    reply: async () => {},
    sendText: async (chat: string, text: string) => {
      const messageId = text.replace("reply ", "");
      deliveredReplies.set(messageId, chat);
      return `lark-${messageId}`;
    },
    sendCard: async () => "",
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
          .readdirSync(path.join(dir, "inbound-queue"))
          .filter(
            (name) => name.endsWith(".json") && !name.endsWith(".retry.json"),
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
      sender_type: "user",
    },
    message: {
      message_id: `msg-${n}`,
      chat_id: `oc_dm_${n % 5}`,
      chat_type: "p2p",
      message_type: "text",
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
      assert.equal(body.payload.context.security.trust, "operator");
    }
    for (let n = 0; n < 100; n++)
      assert.equal(deliveredReplies.get(`msg-${n}`), `oc_dm_${n % 5}`);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("attachment limit replies clearly and does not route an oversized attachment set", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lark-limit-"));
  const config = {
    amp: {
      apiKey: "fake",
      agentAddress: "bot",
      tenant: "example",
      maestroUrl: "http://fake",
      inboxDir: path.join(dir, "inbox"),
    },
    stateDir: dir,
    timeoutMs: 1000,
    workingDelayMs: 100000,
  } as GatewayConfig;
  const routing: RoutingConfig = {
    people: {
      alice: {
        open_id: "ou_example",
        agent: "alice",
        enabled: true,
        admin: false,
      },
    },
    default_reply_unknown: "unknown",
    disabled_person: "paused",
    group_pointer: "DM",
  };
  let replies = 0;
  const oldFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("must not route");
  }) as typeof fetch;
  const ops: LarkOps = {
    download: async () => ({
      name: "large.png",
      contentType: "image/png",
      bytes: Buffer.alloc(26 * 1024 * 1024),
    }),
    parentText: async () => null,
    reply: async (_chat, text) => {
      if (text.includes("10 attachment limit") || text.includes("25 MB limit"))
        replies++;
    },
    react: async () => {},
  };
  try {
    const processor = new InboundProcessor(
      config,
      () => routing,
      new DedupeStore(path.join(dir, "dedupe.json")),
      new ThreadStore(path.join(dir, "threads.json")),
      ops,
    );
    processor.start();
    const items = Array.from({ length: 11 }, (_, i) => ({
      tag: "img",
      image_key: `img_${i}`,
    }));
    processor.enqueue({
      event_id: "limit-event",
      sender: { sender_id: { open_id: "ou_example" }, sender_type: "user" },
      message: {
        message_id: "limit-msg",
        chat_id: "oc_dm",
        chat_type: "p2p",
        message_type: "post",
        content: JSON.stringify({ content: [items] }),
        mentions: [],
      },
    } as any);
    await until(() => replies === 1);
    processor.enqueue({
      event_id: "size-event",
      sender: { sender_id: { open_id: "ou_example" }, sender_type: "user" },
      message: {
        message_id: "size-msg",
        chat_id: "oc_dm",
        chat_type: "p2p",
        message_type: "image",
        content: JSON.stringify({ image_key: "img_large" }),
        mentions: [],
      },
    } as any);
    await until(() => replies === 2);
    processor.stop();
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("uploads inbound bytes to fake Maestro and routes only the resulting attachment reference", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lark-amp-attachment-"));
  const config = {
    amp: {
      apiKey: "fake-key",
      agentAddress: "lark-bot@example.aimaestro.local",
      tenant: "example",
      maestroUrl: "https://maestro.example.invalid",
      inboxDir: path.join(dir, "inbox"),
    },
    stateDir: dir,
    timeoutMs: 1000,
    pollIntervalMs: 50,
    workingDelayMs: 100_000,
  } as GatewayConfig;
  const routing: RoutingConfig = {
    people: {
      alice: {
        open_id: "ou_example_alice",
        agent: "alice-agent",
        enabled: true,
        admin: false,
      },
    },
    default_reply_unknown: "unknown",
    disabled_person: "paused",
    group_pointer: "DM",
  };
  const calls: string[] = [];
  let routed: any;
  const oldFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    calls.push(`${init?.method || "GET"} ${url}`);
    if (url.endsWith("/api/v1/attachments/upload"))
      return Response.json({
        data: {
          attachment_id: "att_123",
          upload_url: "https://upload.example.invalid/put",
        },
      });
    if ((init?.method || "GET") === "PUT")
      return Response.json({ data: { scan_status: "clean" } });
    if (url.endsWith("/confirm"))
      return Response.json({ data: { scan_status: "clean" } });
    if (url.endsWith("/att_123"))
      return Response.json({
        data: {
          url: "https://maestro.example.invalid/api/v1/attachments/att_123/content?token=cap",
        },
      });
    routed = JSON.parse(String(init?.body));
    return Response.json({ id: "amp-attachment-route" });
  }) as typeof fetch;
  const ops: LarkOps = {
    download: async () => ({
      name: "note.txt",
      contentType: "text/plain",
      bytes: Buffer.from("hello attachment"),
    }),
    parentText: async () => null,
    reply: async () => {},
    react: async () => {},
  };
  try {
    const processor = new InboundProcessor(
      config,
      () => routing,
      new DedupeStore(path.join(dir, "dedupe.json")),
      new ThreadStore(path.join(dir, "threads.json")),
      ops,
    );
    processor.start();
    processor.enqueue({
      event_id: "attachment-event",
      sender: {
        sender_id: { open_id: "ou_example_alice" },
        sender_type: "user",
      },
      message: {
        message_id: "attachment-message",
        chat_id: "ou_example_alice",
        chat_type: "p2p",
        message_type: "file",
        content: JSON.stringify({
          file_key: "file_key",
          file_name: "note.txt",
        }),
        mentions: [],
      },
    } as any);
    await until(() => Boolean(routed));
    processor.stop();
    assert.equal(
      calls.filter((call) => call.includes("attachments/")).length,
      3,
    );
    assert.equal(routed.payload.attachments[0].attachment_id, "att_123");
    assert.equal(routed.payload.attachments[0].url.includes("token=cap"), true);
    assert.equal("content" in routed.payload.attachments[0], false);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("fetches the reply parent text and sends only the person slug while stripping bot mentions", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lark-parent-"));
  const config = {
    amp: {
      apiKey: "fake",
      agentAddress: "bot",
      tenant: "example",
      maestroUrl: "http://fake",
      inboxDir: path.join(dir, "inbox"),
    },
    stateDir: dir,
    timeoutMs: 1000,
    pollIntervalMs: 50,
    workingDelayMs: 100_000,
  } as GatewayConfig;
  const routing: RoutingConfig = {
    people: {
      alice: {
        open_id: "ou_example",
        agent: "alice-agent",
        enabled: true,
        admin: false,
      },
    },
    default_reply_unknown: "unknown",
    disabled_person: "paused",
    group_pointer: "DM",
  };
  let routed: any;
  const oldFetch = globalThis.fetch;
  globalThis.fetch = (async (_url, init) => {
    routed = JSON.parse(String(init?.body));
    return Response.json({ id: "amp-parent-route" });
  }) as typeof fetch;
  let fetched = "";
  const ops: LarkOps = {
    download: async () => ({
      name: "",
      contentType: "",
      bytes: Buffer.alloc(0),
    }),
    parentText: async (id) => {
      fetched = id;
      return "Parent asks about schedule";
    },
    reply: async () => {},
    react: async () => {},
  };
  try {
    const processor = new InboundProcessor(
      config,
      () => routing,
      new DedupeStore(path.join(dir, "dedupe.json")),
      new ThreadStore(path.join(dir, "threads.json")),
      ops,
    );
    processor.start();
    processor.enqueue({
      event_id: "parent-event",
      sender: { sender_id: { open_id: "ou_example" }, sender_type: "user" },
      message: {
        message_id: "child",
        parent_id: "parent",
        chat_id: "ou_example",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "@_bot answer please" }),
        mentions: [{ key: "@_bot", name: "AI", mentioned_type: "bot" }],
      },
    } as any);
    await until(() => Boolean(routed));
    processor.stop();
    assert.equal(fetched, "parent");
    assert.equal(
      routed.payload.context.lark.parent_text,
      "Parent asks about schedule",
    );
    assert.equal(routed.payload.message.includes("@_bot"), false);
    assert.equal(routed.payload.context.channel.sender_id, "alice");
    assert.equal(JSON.stringify(routed).includes("ou_example"), false);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("poison inbound messages back off, park, and send one failure reply", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lark-poison-"));
  const config = {
    amp: {
      apiKey: "fake",
      agentAddress: "bot",
      tenant: "example",
      maestroUrl: "http://fake",
      inboxDir: path.join(dir, "inbox"),
    },
    stateDir: dir,
    timeoutMs: 1000,
    pollIntervalMs: 50,
    workingDelayMs: 100_000,
  } as GatewayConfig;
  const routing: RoutingConfig = {
    people: {
      alice: {
        open_id: "ou_example",
        agent: "alice-agent",
        enabled: true,
        admin: false,
      },
    },
    default_reply_unknown: "unknown",
    disabled_person: "paused",
    group_pointer: "DM",
  };
  let attempts = 0;
  let replies = 0;
  const oldFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    attempts++;
    return new Response("unavailable", { status: 503 });
  }) as typeof fetch;
  const ops: LarkOps = {
    download: async () => ({
      name: "",
      contentType: "",
      bytes: Buffer.alloc(0),
    }),
    parentText: async () => null,
    reply: async (_chat, text) => {
      if (text.includes("could not deliver")) replies++;
    },
    react: async () => {},
  };
  try {
    const processor = new InboundProcessor(
      config,
      () => routing,
      new DedupeStore(path.join(dir, "dedupe.json")),
      new ThreadStore(path.join(dir, "threads.json")),
      ops,
      { maxAttempts: 3, maxAgeMs: 10_000, baseDelayMs: 1 },
    );
    processor.start();
    processor.enqueue({
      event_id: "poison-event",
      sender: { sender_id: { open_id: "ou_example" }, sender_type: "user" },
      message: {
        message_id: "poison",
        chat_id: "ou_example",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
        mentions: [],
      },
    } as any);
    await until(
      () =>
        fs.existsSync(path.join(dir, "undeliverable-inbound", "poison.json")),
      5000,
    );
    processor.stop();
    assert.equal(attempts, 3);
    assert.equal(replies, 1);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("@AIM tags override routing only for admins and alternate-agent content is external", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lark-admin-tag-"));
  const config = {
    amp: {
      apiKey: "fake",
      agentAddress: "bot",
      tenant: "example",
      maestroUrl: "http://fake",
      inboxDir: path.join(dir, "inbox"),
    },
    stateDir: dir,
    timeoutMs: 1000,
    pollIntervalMs: 50,
    workingDelayMs: 100_000,
  } as GatewayConfig;
  const routing: RoutingConfig = {
    people: {
      alice: {
        open_id: "ou_alice",
        agent: "alice-agent",
        enabled: true,
        admin: true,
      },
      carol: {
        open_id: "ou_carol",
        agent: "carol-agent",
        enabled: true,
        admin: false,
      },
    },
    default_reply_unknown: "unknown",
    disabled_person: "paused",
    group_pointer: "DM",
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
      name: "",
      contentType: "",
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
      new DedupeStore(path.join(dir, "dedupe.json")),
      new ThreadStore(path.join(dir, "threads.json")),
      ops,
    );
    processor.start();
    for (const person of ["alice", "carol"])
      processor.enqueue({
        event_id: `tag-${person}`,
        sender: {
          sender_id: { open_id: routing.people[person]!.open_id },
          sender_type: "user",
        },
        message: {
          message_id: `tag-message-${person}`,
          chat_id: routing.people[person]!.open_id,
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text: "@AIM:bob-agent review" }),
          mentions: [],
        },
      } as any);
    await until(() => routed.length === 2);
    processor.stop();
    const alice = routed.find(
      (body) => body.payload.context.channel.sender_id === "alice",
    );
    const carol = routed.find(
      (body) => body.payload.context.channel.sender_id === "carol",
    );
    assert.equal(alice.to, "bob-agent@example.aimaestro.local");
    assert.equal(alice.payload.context.security.trust, "external");
    assert.equal(carol.to, "carol-agent@example.aimaestro.local");
    assert.equal(carol.payload.context.security.trust, "operator");
  } finally {
    globalThis.fetch = oldFetch;
  }
});
