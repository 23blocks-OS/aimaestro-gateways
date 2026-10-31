/** Tests outbound message formatting, routing, attachments, and authorization. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OutboundPoller } from "../outbound.js";
import { ThreadStore } from "../thread-store.js";
import type { GatewayConfig, RoutingConfig } from "../types.js";
import { isAgentSender } from "../routing.js";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
test("outbound selects plain text or card, splits, routes initiations and sends attachments", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lark-out-"));
  const inbox = path.join(dir, "inbox");
  fs.mkdirSync(inbox);
  const config = {
    amp: { inboxDir: inbox, tenant: "example" },
    pollIntervalMs: 10,
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
    default_reply_unknown: "",
    disabled_person: "",
    group_pointer: "",
  };
  const calls: Array<{ type: string; text?: string; chat?: string }> = [];
  const ops: any = {
    reply: async () => {},
    sendText: async (chat: string, text: string) => {
      calls.push({ type: "text", text, chat });
      return "";
    },
    sendCard: async (chat: string, card: any) => {
      calls.push({ type: "card", text: JSON.stringify(card), chat });
      return "";
    },
    sendAttachment: async (
      chat: string,
      _parent: string | undefined,
      attachment: any,
    ) => {
      calls.push({
        type: "attachment",
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
  ) =>
    fs.writeFileSync(
      path.join(inbox, name),
      JSON.stringify({
        envelope: {
          id: name,
          from: "alice-agent@example.aimaestro.local",
          in_reply_to: null,
        },
        payload: { message, context: { lark: context }, attachments },
      }),
    );
  mk("one.json", "Hello", { to: "alice" });
  mk(
    "two.json",
    "# Heading\n\n" + "x ".repeat(18000),
    {
      to: "alice",
      buttons: [{ label: "Confirm", action: "confirm", value: { yes: true } }],
    },
    [{ name: "a.png", content_type: "image/png", content: "eA==" }],
  );
  const poller = new OutboundPoller(
    config,
    () => routing,
    new ThreadStore(path.join(dir, "threads.json")),
    ops,
  );
  poller.start();
  for (let i = 0; i < 100 && fs.readdirSync(inbox).length; i++) await wait(10);
  poller.stop();
  assert.ok(calls.some((c) => c.type === "text" && c.text === "Hello"));
  assert.ok(calls.filter((c) => c.type === "card").length >= 2);
  assert.ok(calls.some((c) => c.type === "attachment"));
  assert.match(
    calls.find((c) => c.type === "attachment")?.text || "",
    /"content":"eA=="/,
  );
  assert.ok(calls.every((c) => c.chat === "ou_example"));
  assert.equal(
    isAgentSender(
      "alice-agent@example.aimaestro.local",
      "alice-agent",
      "example",
    ),
    true,
  );
});

test("parks wrong agent replies and agent-initiated DMs while allowing each configured owner", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lark-auth-"));
  const inbox = path.join(dir, "inbox");
  fs.mkdirSync(inbox);
  const config = {
    amp: { inboxDir: inbox, tenant: "example" },
    pollIntervalMs: 10,
  } as GatewayConfig;
  const routing: RoutingConfig = {
    people: {
      alice: {
        open_id: "ou_alice",
        agent: "alice-agent",
        enabled: true,
        admin: false,
      },
      bob: {
        open_id: "ou_bob",
        agent: "bob-agent",
        enabled: true,
        admin: false,
      },
    },
    default_reply_unknown: "unknown",
    disabled_person: "paused",
    group_pointer: "DM",
  };
  const sent: Array<{ chat: string; text: string }> = [];
  const ops = {
    reply: async () => {},
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
  const threads = new ThreadStore(path.join(dir, "threads.json"));
  threads.set("known-message", {
    messageId: "known-message",
    rootId: "known-root",
    chatId: "ou_bob",
    chatType: "p2p",
    openId: "ou_bob",
    person: "bob",
    agent: "bob-agent",
    createdAt: Date.now(),
  });
  const write = (
    name: string,
    from: string,
    context: Record<string, unknown>,
    reply?: string,
  ) =>
    fs.writeFileSync(
      path.join(inbox, name),
      JSON.stringify({
        envelope: { id: name, from, in_reply_to: reply || null },
        payload: { message: "hi", context: { lark: context } },
      }),
    );
  write(
    "wrong-thread.json",
    "alice-agent@example.aimaestro.local",
    {},
    "known-message",
  );
  write(
    "owner-thread.json",
    "bob-agent@example.aimaestro.local",
    {},
    "known-message",
  );
  write("wrong-to.json", "bob-agent@example.aimaestro.local", { to: "alice" });
  write("owner.json", "alice-agent@example.aimaestro.local", { to: "alice" });
  const poller = new OutboundPoller(config, () => routing, threads, ops);
  poller.start();
  for (let i = 0; i < 100 && fs.readdirSync(inbox).length; i++) await wait(10);
  poller.stop();
  threads.close();
  assert.deepEqual(
    sent.sort((a, b) => a.chat.localeCompare(b.chat)),
    [
      { chat: "ou_alice", text: "hi" },
      { chat: "ou_bob", text: "hi" },
    ],
  );
  assert.deepEqual(fs.readdirSync(path.join(dir, "undeliverable")).sort(), [
    "wrong-thread.json",
    "wrong-to.json",
  ]);
});
