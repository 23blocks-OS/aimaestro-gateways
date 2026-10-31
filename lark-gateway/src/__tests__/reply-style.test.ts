/** Tests quoted DM replies by default and configurable topic-thread replies. */
import test from "node:test";
import assert from "node:assert/strict";
import { LarkApi } from "../lark-api.js";
import type { GatewayConfig } from "../types.js";

function makeApi(replyInThread: boolean): {
  api: LarkApi;
  captured: Record<string, unknown>[];
} {
  const captured: Record<string, unknown>[] = [];
  const client = {
    im: {
      message: {
        reply: async (request: { data: Record<string, unknown> }) => {
          captured.push(request.data);
          return { code: 0, data: {} };
        },
      },
    },
  };
  const config = { replyInThread } as GatewayConfig;
  return { api: new LarkApi(client as never, config), captured };
}

test("p2p quoted replies do not create a topic thread by default", async () => {
  const { api, captured } = makeApi(false);
  await api.sendText("ou_example", "hello", "om_parent");
  assert.equal(captured[0]?.reply_in_thread, false);
});

test("thread replies can be enabled by configuration", async () => {
  const { api, captured } = makeApi(true);
  await api.sendText("ou_example", "hello", "om_parent");
  assert.equal(captured[0]?.reply_in_thread, true);
});
