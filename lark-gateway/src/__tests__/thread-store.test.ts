/** Tests expiration pruning and bounded durable thread context. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ThreadStore } from "../thread-store.js";
import type { ThreadContext } from "../types.js";

function context(id: string, createdAt = Date.now()): ThreadContext {
  return {
    messageId: id,
    rootId: id,
    chatId: "ou_example",
    chatType: "p2p",
    openId: "ou_example",
    person: "alice",
    agent: "alice-agent",
    createdAt,
  };
}

test("prunes expired entries on load and caps entries and file size", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lark-thread-store-"));
  const file = path.join(dir, "threads.json");
  fs.writeFileSync(
    file,
    JSON.stringify({ old: context("old", Date.now() - 200_000) }),
  );
  const store = new ThreadStore(file, 100_000, 2, 4096, 60_000);
  assert.equal(store.get("old"), undefined);
  store.set("first", context("first", Date.now() - 2));
  store.set("second", context("second", Date.now() - 1));
  store.set("third", context("third"));
  store.pruneNow();
  const saved = JSON.parse(fs.readFileSync(file, "utf8")) as Record<
    string,
    ThreadContext
  >;
  assert.equal(store.size(), 2);
  assert.equal(Object.keys(saved).length, 2);
  assert.equal(Buffer.byteLength(JSON.stringify(saved)) <= 4096, true);
  assert.equal("first" in saved, false);
  store.close();

  const cappedFile = path.join(dir, "capped.json");
  const capped = new ThreadStore(cappedFile, 100_000, 10, 1000, 60_000);
  for (let index = 0; index < 10; index++) {
    const entry = context(`entry-${index}`);
    entry.person = "alice".repeat(20);
    entry.agent = "agent".repeat(20);
    capped.set(`entry-${index}`, entry);
  }
  assert.equal(capped.size() < 10, true);
  assert.equal(fs.statSync(cappedFile).size <= 1000, true);
  capped.close();
});
