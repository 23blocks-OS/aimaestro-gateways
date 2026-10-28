/**
 * Retry policy for outbound Google Chat posts: which errors are permanent, how long
 * to wait between tries, and when to give up.
 */

/**
 * Google Chat API errors (the `status` string of the error body) that are about THIS message and will never succeed on retry.
 * Parking the file is right: retrying only repeats the same error.
 */
export const PERMANENT_CHAT_ERRORS: ReadonlySet<string> = new Set([
  'NOT_FOUND',
  'INVALID_ARGUMENT',
  'FAILED_PRECONDITION',
  'OUT_OF_RANGE',
  'ALREADY_EXISTS',
  // The app is not (or no longer) a member of the space, or the user blocked it.
  'PERMISSION_DENIED',
]);

/**
 * Google errors about the project, credentials or quota, not about one message.
 * They hit every message at once and clear when someone fixes the token, so they must
 * NEVER park anything: parking would drop the whole outbound queue out of retry. They
 * back off to the cap and log once.
 */
export const GLOBAL_CHAT_ERRORS: ReadonlySet<string> = new Set([
  'UNAUTHENTICATED',
  'RESOURCE_EXHAUSTED',
  'UNAVAILABLE',
  'INTERNAL',
  'DEADLINE_EXCEEDED',
  'ABORTED',
  'UNKNOWN',
  // PERMISSION_DENIED with these reasons is the API switched off or the key's scope, not
  // this message (see chat-client.ts, which rewrites the code).
  'SERVICE_DISABLED',
  'SCOPE_INSUFFICIENT',
]);

export const MAX_ATTEMPTS = 20;
export const MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const MAX_BACKOFF_MS = 5 * 60 * 1000;

/** The Google status code (data.error) carried by a ChatApiError, if any. */
export function chatErrorCode(err: unknown): string | undefined {
  const code = (err as { data?: { error?: unknown } } | null)?.data?.error;
  return typeof code === 'string' ? code : undefined;
}

export function isPermanentChatError(err: unknown): boolean {
  const code = chatErrorCode(err);
  return code !== undefined && PERMANENT_CHAT_ERRORS.has(code);
}

/**
 * Failures that say nothing about this message: a known workspace-level Google Chat error, or
 * no Google Chat error code at all (network down, DNS, timeout, socket reset). They back off
 * forever and never count toward giving up, so an outage does not park the queue.
 */
export function isGlobalFailure(err: unknown): boolean {
  const code = chatErrorCode(err);
  return code === undefined || GLOBAL_CHAT_ERRORS.has(code);
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
  if (isPermanentChatError(err)) {
    return { action: 'park', reason: `permanent Google Chat error: ${chatErrorCode(err)}` };
  }
  const attempts = (prev?.attempts ?? 0) + 1;
  const firstFailedAt = prev?.firstFailedAt ?? now;
  const global = isGlobalFailure(err);
  // Only an unrecognised Google Chat error about this message can run out of attempts. A global
  // failure (token, outage) keeps retrying at the cap until it clears.
  if (!global && attempts >= MAX_ATTEMPTS) {
    return { action: 'park', reason: `gave up after ${attempts} failed attempts (${signature})` };
  }
  if (!global && now - firstFailedAt >= MAX_AGE_MS) {
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
