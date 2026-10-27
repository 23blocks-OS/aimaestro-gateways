/**
 * Google Chat REST client (app authentication, scope chat.bot).
 *
 * The app posts as ITSELF (its configured name and avatar). Google gives a Chat app no way to
 * post under another name, so a different identity means a different Chat app (see types.ts).
 * Plain fetch with a google-auth-library token: no googleapis dependency.
 */

import { GoogleAuth } from 'google-auth-library';

const CHAT_API = 'https://chat.googleapis.com/v1';
const SCOPE = 'https://www.googleapis.com/auth/chat.bot';

/** Messages are capped at 32,000 bytes. Stay well under it and break on paragraph/line ends. */
export const MAX_MESSAGE_BYTES = 28000;

/** A failed Chat API call. `data.error` carries Google's status string so retry-policy can read it. */
export class ChatApiError extends Error {
  readonly httpStatus: number;
  readonly data: { error?: string };
  constructor(httpStatus: number, status: string | undefined, message: string) {
    super(message);
    this.name = 'ChatApiError';
    this.httpStatus = httpStatus;
    this.data = { error: status };
  }
}

export interface PostedMessage {
  /** `spaces/AAAA/messages/CCCC` */
  name: string;
  /** `spaces/AAAA/threads/BBBB` */
  thread: string;
}

export interface ChatTransport {
  token(): Promise<string>;
  fetch: typeof fetch;
}

/**
 * Split text into chunks of at most `maxBytes` UTF-8 bytes, preferring paragraph, then line,
 * then word boundaries. Never splits a character.
 */
export function splitMessage(text: string, maxBytes: number = MAX_MESSAGE_BYTES): string[] {
  const enc = new TextEncoder();
  if (enc.encode(text).length <= maxBytes) return [text];

  const chunks: string[] = [];
  let rest = text;
  while (enc.encode(rest).length > maxBytes) {
    // Largest prefix (by characters) that fits.
    let lo = 1;
    let hi = rest.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (enc.encode(rest.slice(0, mid)).length <= maxBytes) lo = mid;
      else hi = mid - 1;
    }
    let cut = lo;
    const head = rest.slice(0, cut);
    const boundary = Math.max(head.lastIndexOf('\n\n'), head.lastIndexOf('\n'), head.lastIndexOf(' '));
    if (boundary > cut * 0.5) cut = boundary;
    // Do not cut inside a surrogate pair.
    const code = rest.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).replace(/^\s+/, '');
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/** Turn a Google error body into a ChatApiError. Re-labels "API switched off" as a global failure. */
export function toChatError(httpStatus: number, body: string): ChatApiError {
  let status: string | undefined;
  let message = body.slice(0, 300);
  try {
    const err = JSON.parse(body)?.error;
    if (err) {
      status = typeof err.status === 'string' ? err.status : undefined;
      message = typeof err.message === 'string' ? err.message : message;
      const reasons: string[] = (err.details ?? [])
        .map((d: { reason?: unknown }) => d?.reason)
        .filter((r: unknown): r is string => typeof r === 'string');
      if (reasons.includes('SERVICE_DISABLED')) status = 'SERVICE_DISABLED';
      else if (reasons.includes('ACCESS_TOKEN_SCOPE_INSUFFICIENT')) status = 'SCOPE_INSUFFICIENT';
    }
  } catch {
    // Not JSON (a proxy page, say): keep the raw text.
  }
  return new ChatApiError(httpStatus, status, `Chat API ${httpStatus} ${status ?? ''}: ${message}`.trim());
}

export class ChatClient {
  constructor(private transport: ChatTransport, private timeoutMs = 15000) {}

  static fromCredentials(credentialsFile?: string): ChatClient {
    const auth = new GoogleAuth({ keyFile: credentialsFile, scopes: [SCOPE] });
    return new ChatClient({
      token: async () => {
        const client = await auth.getClient();
        const t = await client.getAccessToken();
        if (!t.token) throw new ChatApiError(401, 'UNAUTHENTICATED', 'no access token from Google credentials');
        return t.token;
      },
      fetch: (...a) => fetch(...a),
    });
  }

  private async call<T>(method: string, pathAndQuery: string, body?: unknown): Promise<T> {
    const res = await this.transport.fetch(`${CHAT_API}/${pathAndQuery}`, {
      method,
      headers: {
        Authorization: `Bearer ${await this.transport.token()}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) throw toChatError(res.status, text);
    return (text ? JSON.parse(text) : {}) as T;
  }

  /**
   * Post text to a space. `thread` is a thread resource name to reply in; without it the
   * message starts a new thread. Long text goes out as several messages in the same thread.
   * Returns the FIRST message posted.
   */
  async postMessage(space: string, text: string, thread?: string): Promise<PostedMessage> {
    let first: PostedMessage | undefined;
    let threadName = thread;
    for (const chunk of splitMessage(text)) {
      const body: Record<string, unknown> = { text: chunk };
      if (threadName) body.thread = { name: threadName };
      const query = threadName ? '?messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD' : '';
      const msg = await this.call<{ name?: string; thread?: { name?: string } }>(
        'POST',
        `${space}/messages${query}`,
        body
      );
      const posted = { name: msg.name ?? '', thread: msg.thread?.name ?? threadName ?? '' };
      first ??= posted;
      threadName = posted.thread || threadName;
    }
    return first!;
  }

  /** The direct-message space between this app and a user (`users/123` or an email). */
  async findDirectMessage(user: string): Promise<string> {
    const res = await this.call<{ name?: string }>(
      'GET',
      `spaces:findDirectMessage?name=${encodeURIComponent(user.startsWith('users/') ? user : `users/${user}`)}`
    );
    if (!res.name) throw new ChatApiError(404, 'NOT_FOUND', `no direct message space with ${user}`);
    return res.name;
  }
}
