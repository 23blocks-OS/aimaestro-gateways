/** Tests retry backoff and terminal parking decisions. */
import test from "node:test";
import assert from "node:assert/strict";
import { backoffMs, shouldPark } from "../retry-policy.js";

test("outbound failures back off before parking; 20 persistent per-message failures park", () => {
  assert.equal(backoffMs(1, 3000), 3000);
  assert.equal(backoffMs(9, 3000), 300000);
  assert.equal(shouldPark(19, 24 * 60 * 60 * 1000), false);
  assert.equal(shouldPark(20, 24 * 60 * 60 * 1000), true);
});
