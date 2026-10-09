/**
 * Retry policy for outbound Slack posts: which errors are permanent, how long
 * to wait between tries, and when to give up.
 */

/** Slack API errors that will never succeed on retry. */
export const PERMANENT_SLACK_ERRORS: ReadonlySet<string> = new Set([
  'channel_not_found',
  'not_in_channel',
  'invalid_blocks',
  'invalid_blocks_format',
  'is_archived',
  'account_inactive',
  'invalid_auth',
  'not_authed',
  'token_revoked',
  'token_expired',
  'message_too_long',
  'msg_too_long',
  'no_text',
  'restricted_action',
  'user_not_found',
]);

export const MAX_ATTEMPTS = 20;
export const MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const MAX_BACKOFF_MS = 5 * 60 * 1000;

/** The Slack error code (data.error) carried by a Bolt/WebAPI error, if any. */
export function slackErrorCode(err: unknown): string | undefined {
  const code = (err as { data?: { error?: unknown } } | null)?.data?.error;
  return typeof code === 'string' ? code : undefined;
}

export function isPermanentSlackError(err: unknown): boolean {
  const code = slackErrorCode(err);
  return code !== undefined && PERMANENT_SLACK_ERRORS.has(code);
}

/** Delay before the next try after `attempts` failures: base, 2x, 4x ... capped at 5 min. */
export function backoffMs(attempts: number, baseMs: number): number {
  const exp = Math.max(0, attempts - 1);
  return Math.min(baseMs * 2 ** Math.min(exp, 30), MAX_BACKOFF_MS);
}

export interface RetryState {
  attempts: number;
  firstFailedAt: number;
  nextTryAt: number;
  delayMs: number;
  signature: string;
}

export type FailureDecision =
  | { action: 'park'; reason: string }
  | { action: 'retry'; state: RetryState; log: 'first' | 'changed' | 'backoff' | 'quiet' };

/**
 * Decide what to do after a failed attempt. Pure: the caller keeps the state
 * and does the logging and parking.
 */
export function recordFailure(
  prev: RetryState | undefined,
  err: unknown,
  signature: string,
  now: number,
  baseMs: number
): FailureDecision {
  if (isPermanentSlackError(err)) {
    return { action: 'park', reason: `permanent Slack error: ${slackErrorCode(err)}` };
  }
  const attempts = (prev?.attempts ?? 0) + 1;
  const firstFailedAt = prev?.firstFailedAt ?? now;
  if (attempts >= MAX_ATTEMPTS) {
    return { action: 'park', reason: `gave up after ${attempts} failed attempts (${signature})` };
  }
  if (now - firstFailedAt >= MAX_AGE_MS) {
    return { action: 'park', reason: `gave up after 24h of failures (${signature})` };
  }
  const delayMs = backoffMs(attempts, baseMs);
  const state: RetryState = { attempts, firstFailedAt, nextTryAt: now + delayMs, delayMs, signature };
  let log: 'first' | 'changed' | 'backoff' | 'quiet';
  if (!prev) log = 'first';
  else if (prev.signature !== signature) log = 'changed';
  else if (prev.delayMs !== delayMs) log = 'backoff';
  else log = 'quiet';
  return { action: 'retry', state, log };
}
