/** Tests card ownership checks, routing, and duplicate click handling. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  authorizeCardAction,
  createCardActionHandler,
  routeCardAction,
} from "../card-actions.js";
import { DedupeStore } from "../dedupe.js";
import { createLarkEventDispatcher } from "../event-dispatcher.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GatewayConfig, RoutingConfig } from "../types.js";
import { InboundProcessor } from "../inbound.js";
import { ThreadStore } from "../thread-store.js";
import { OutboundPoller } from "../outbound.js";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (predicate: () => boolean, timeout = 5000) => {
  const end = Date.now() + timeout;
  while (!predicate() && Date.now() < end) await wait(5);
  assert.ok(predicate(), "timed out waiting for card action delivery");
};

const routing: RoutingConfig = {
  people: {
    alice: {
      open_id: "ou_example_alice",
      agent: "alice-agent",
      enabled: true,
      admin: false,
    },
    bob: {
      open_id: "ou_example_bob",
      agent: "bob-agent",
      enabled: true,
      admin: false,
    },
  },
  default_reply_unknown: "",
  disabled_person: "",
  group_pointer: "",
};
test("card actions are owner-only and route to the button agent with person slug context", async () => {
  const owner = authorizeCardAction("ou_example_alice", "alice", routing);
  assert.equal(owner, "alice");
  assert.equal(authorizeCardAction("ou_example_bob", "alice", routing), null);
  const captured: any[] = [];
  const config = {
    amp: {
      tenant: "example",
      agentAddress: "lark-bot@example.aimaestro.local",
      maestroUrl: "http://amp",
      apiKey: "key",
    },
    timeoutMs: 1000,
  } as GatewayConfig;
  await routeCardAction(
    config,
    routing,
    {
      agent: "alice-agent",
      action: "approve",
      value: { yes: true },
      amp_thread: "amp-inbound-id",
    },
    owner!,
    async (_url, init) => {
      captured.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: 200 });
    },
  );
  const request = captured[0];
  assert.equal(request.to, "alice-agent@example.aimaestro.local");
  assert.equal(request.in_reply_to, "amp-inbound-id");
  assert.deepEqual(request.payload.context.lark.card_action, {
    action: "approve",
    value: { yes: true },
    clicker: "alice",
  });
  assert.equal(request.payload.context.channel.sender_id, "alice");
  assert.equal(JSON.stringify(request).includes("ou_example_alice"), false);
  assert.equal(request.payload.context.security.trust, "operator");
});

test("a clicker who owns another configured person is rejected before route", () => {
  assert.equal(authorizeCardAction("ou_example_bob", "alice", routing), null);
});

test("persistent-connection card event replies promptly and routes duplicate clicks once", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lark-card-ws-"));
  const dedupe = new DedupeStore(path.join(dir, "dedupe.json"));
  const config = {
    amp: {
      tenant: "example",
      agentAddress: "lark-bot@example.aimaestro.local",
      maestroUrl: "http://amp",
      apiKey: "key",
    },
    timeoutMs: 1000,
  } as GatewayConfig;
  let requestCount = 0;
  const queued = new Set<string>();
  const handler = createCardActionHandler(
    config,
    () => routing,
    dedupe,
    async () => {
      requestCount++;
      return new Response("{}", { status: 200 });
    },
    (raw) => {
      const id = (raw as any).event_id;
      if (!queued.has(id)) queued.add(id);
    },
  );
  const event = {
    schema: "2.0",
    header: { event_id: "click-event-1", event_type: "card.action.trigger" },
    event: {
      context: { open_message_id: "om_card", open_chat_id: "oc_chat" },
      operator: { open_id: "ou_example_alice" },
      action: {
        value: {
          owner: "alice",
          agent: "alice-agent",
          action: "confirm",
          amp_thread: "amp-thread",
        },
      },
    },
  };
  const dispatcher = createLarkEventDispatcher({ enqueue: () => {} }, handler);
  const first = await dispatcher.invoke(event, { needCheck: false });
  const duplicate = await dispatcher.invoke(event, { needCheck: false });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(
    ((first as any).toast as { content: string }).content,
    "Received. The agent is working on it.",
  );
  assert.equal(
    ((duplicate as any).toast as { content: string }).content,
    "Received. The agent is working on it.",
  );
  assert.equal(queued.size, 1);
  assert.equal(requestCount, 0);
});

test("queued card click stores its AMP thread and delivers the agent reply to the card DM", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lark-card-roundtrip-"));
  const inbox = path.join(dir, "inbox");
  const config = {
    amp: { tenant: "example", agentAddress: "lark-bot@example.aimaestro.local", maestroUrl: "http://amp", apiKey: "key", inboxDir: inbox },
    stateDir: dir,
    timeoutMs: 1000,
    pollIntervalMs: 5,
    workingDelayMs: 100000,
  } as GatewayConfig;
  const threads = new ThreadStore(path.join(dir, "threads.json"));
  const dedupe = new DedupeStore(path.join(dir, "dedupe.json"));
  const ops: any = {
    download: async () => ({ name: "", contentType: "", bytes: Buffer.alloc(0) }),
    parentText: async () => null,
    reply: async () => {},
    react: async () => {},
  };
  const processor = new InboundProcessor(config, () => routing, dedupe, threads, ops, { baseDelayMs: 5 });
  const oldFetch = globalThis.fetch;
  let routeAttempts = 0;
  globalThis.fetch = (async () => {
    routeAttempts++;
    if (routeAttempts === 1) return new Response("unavailable", { status: 503 });
    return new Response(JSON.stringify({ id: "amp-card-click-1" }), { status: 200 });
  }) as typeof fetch;
  const event = {
    schema: "2.0",
    header: { event_id: "click-roundtrip-1", event_type: "card.action.trigger" },
    event: {
      context: { open_message_id: "om_card_1", open_chat_id: "oc_alice_dm" },
      operator: { open_id: "ou_example_alice" },
      action: { value: { owner: "alice", agent: "alice-agent", action: "confirm", amp_thread: "original-amp-thread" } },
    },
  };
  try {
    processor.start();
    processor.enqueueCardAction(event);
    await until(() => fs.readdirSync(path.join(dir, "inbound-queue")).filter((n) => n.endsWith(".json")).length === 0);
    assert.equal(routeAttempts, 2, "a transient route failure is retried from the durable queue");
    assert.equal(threads.get("amp-card-click-1")?.messageId, "om_card_1");
    fs.mkdirSync(path.join(inbox, "alice_agent_example_aimaestro_local"), { recursive: true });
    fs.writeFileSync(path.join(inbox, "alice_agent_example_aimaestro_local", "answer.json"), JSON.stringify({
      envelope: { id: "answer", from: "alice-agent@example.aimaestro.local", in_reply_to: "amp-card-click-1" },
      payload: { message: "Confirmed", context: { lark: {} } },
    }));
    let delivered: any;
    const poller = new OutboundPoller(config, () => routing, threads, {
      reply: async () => {},
      sendText: async (chat, text, parent) => { delivered = { chat, text, parent }; return "om_answer"; },
      sendCard: async () => "",
      sendAttachment: async () => {},
      finishReaction: async () => {},
    });
    poller.start();
    await until(() => Boolean(delivered));
    poller.stop();
    assert.deepEqual(delivered, { chat: "oc_alice_dm", text: "Confirmed", parent: "om_card_1" });
  } finally {
    processor.stop();
    threads.close();
    globalThis.fetch = oldFetch;
  }
});
