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
  const handler = createCardActionHandler(
    config,
    () => routing,
    dedupe,
    async () => {
      requestCount++;
      return new Response("{}", { status: 200 });
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
    "This action was already received.",
  );
  assert.equal(requestCount, 1);
});
