/** Tests callback credentials for persistent and legacy HTTP modes. */
import test from "node:test";
import assert from "node:assert/strict";
import { hasLiveCredentials } from "../config.js";
import type { GatewayConfig } from "../types.js";

function config(
  mode: "long-connection" | "http",
  verificationToken: string,
): GatewayConfig {
  return {
    appId: "app-id",
    appSecret: "app-secret",
    verificationToken,
    cardCallbackMode: mode,
    amp: { apiKey: "amp-key" },
  } as GatewayConfig;
}

test("long-connection card actions do not require a verification token", () => {
  assert.equal(hasLiveCredentials(config("long-connection", "")), true);
});

test("HTTP callback mode requires its verification token", () => {
  assert.equal(hasLiveCredentials(config("http", "")), false);
  assert.equal(hasLiveCredentials(config("http", "callback-token")), true);
});
