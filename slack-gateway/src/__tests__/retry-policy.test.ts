import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  backoffMs,
  isGlobalFailure,
  isPermanentSlackError,
  recordFailure,
  MAX_ATTEMPTS,
  MAX_AGE_MS,
  type RetryState,
} from '../retry-policy.js';

const slackErr = (code: string) => Object.assign(new Error(`An API error occurred: ${code}`), { data: { error: code } });

describe('isPermanentSlackError', () => {
  for (const code of [
    'channel_not_found', 'not_in_channel', 'invalid_blocks', 'is_archived', 'message_too_long',
  ]) {
    it(`treats ${code} as permanent`, () => assert.ok(isPermanentSlackError(slackErr(code))));
  }
  // Workspace/token errors hit every message at once. Parking on them would drop the whole
  // outbound queue out of retry until someone re-queued it by hand.
  for (const code of ['invalid_auth', 'not_authed', 'token_revoked', 'token_expired', 'account_inactive']) {
    it(`does NOT treat ${code} as permanent (it is global)`, () => {
      assert.ok(!isPermanentSlackError(slackErr(code)));
      assert.ok(isGlobalFailure(slackErr(code)));
    });
  }
  it('treats rate limits and network errors as transient', () => {
    assert.ok(!isPermanentSlackError(slackErr('ratelimited')));
    assert.ok(!isPermanentSlackError(new Error('getaddrinfo EAI_AGAIN slack.com')));
    assert.ok(!isPermanentSlackError(undefined));
  });
});

describe('backoffMs', () => {
  it('doubles from the base and caps at 5 minutes', () => {
    assert.deepStrictEqual([1, 2, 3, 4].map((n) => backoffMs(n, 3000)), [3000, 6000, 12000, 24000]);
    assert.strictEqual(backoffMs(8, 3000), 300000);
    assert.strictEqual(backoffMs(500, 3000), 300000);
  });
});

describe('recordFailure', () => {
  it('parks a permanent error on the first failure', () => {
    const d = recordFailure(undefined, slackErr('channel_not_found'), 'sig', 0, 3000);
    assert.strictEqual(d.action, 'park');
    assert.match((d as { reason: string }).reason, /channel_not_found/);
  });

  it('retries a transient error with backoff and logs transitions only', () => {
    const err = new Error('socket hang up');
    let d = recordFailure(undefined, err, 'socket hang up', 1000, 3000);
    assert.ok(d.action === 'retry');
    assert.strictEqual(d.log, 'first');
    assert.strictEqual(d.state.nextTryAt, 1000 + 3000);

    d = recordFailure(d.state, err, 'socket hang up', 5000, 3000);
    assert.ok(d.action === 'retry');
    assert.strictEqual(d.state.delayMs, 6000);
    assert.strictEqual(d.log, 'backoff');

    // At the cap the delay stops changing, so the log goes quiet.
    let state: RetryState = { ...d.state, attempts: 9, delayMs: 300000 };
    d = recordFailure(state, err, 'socket hang up', 10000, 3000);
    assert.ok(d.action === 'retry');
    assert.strictEqual(d.log, 'quiet');

    state = d.state;
    d = recordFailure(state, err, 'different error', 20000, 3000);
    assert.ok(d.action === 'retry');
    assert.strictEqual(d.log, 'changed');
  });

  // An unrecognised Slack error about this message can run out of attempts.
  it(`parks an unrecognised Slack error after ${MAX_ATTEMPTS} attempts`, () => {
    const prev: RetryState = { attempts: MAX_ATTEMPTS - 1, firstFailedAt: 0, nextTryAt: 0, delayMs: 300000, signature: 's' };
    const d = recordFailure(prev, slackErr('some_new_slack_error'), 's', 1000, 3000);
    assert.strictEqual(d.action, 'park');
  });

  it('parks an unrecognised Slack error after 24 hours', () => {
    const prev: RetryState = { attempts: 3, firstFailedAt: 0, nextTryAt: 0, delayMs: 12000, signature: 's' };
    const d = recordFailure(prev, slackErr('some_new_slack_error'), 's', MAX_AGE_MS, 3000);
    assert.strictEqual(d.action, 'park');
    assert.match((d as { reason: string }).reason, /24h/);
  });

  // A revoked token or a network outage says nothing about the message: keep retrying at the cap.
  for (const [label, err] of [
    ['a revoked token', slackErr('token_revoked')],
    ['invalid_auth', slackErr('invalid_auth')],
    ['a network error', new Error('getaddrinfo EAI_AGAIN slack.com')],
    ['a rate limit', slackErr('ratelimited')],
  ] as const) {
    it(`never parks on ${label}, even after the attempt and age limits`, () => {
      const prev: RetryState = { attempts: MAX_ATTEMPTS * 10, firstFailedAt: 0, nextTryAt: 0, delayMs: 300000, signature: 's' };
      const d = recordFailure(prev, err, 's', MAX_AGE_MS * 30, 3000);
      assert.strictEqual(d.action, 'retry');
      assert.strictEqual((d as { state: RetryState }).state.delayMs, 300000);
    });
  }
});
