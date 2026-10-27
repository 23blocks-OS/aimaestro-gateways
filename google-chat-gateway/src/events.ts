/**
 * Google Chat event parsing.
 *
 * A Chat app delivers events in one of two shapes, depending on whether it was built as a
 * Google Workspace add-on (the default) or not:
 *   add-on   { chat: { user, eventTime, messagePayload | addedToSpacePayload | removedFromSpacePayload } }
 *   classic  { type: 'MESSAGE' | 'ADDED_TO_SPACE' | 'REMOVED_FROM_SPACE', space, message, user, eventTime }
 * Both are read into one ChatEvent. Anything else is `other` and ignored.
 */

export interface ChatUser {
  /** `users/123456789` */
  name: string;
  displayName: string;
  email: string;
  /** HUMAN or BOT */
  type: string;
}

export interface ChatEvent {
  kind: 'message' | 'added' | 'removed' | 'other';
  space: { name: string; type: string; displayName: string };
  /** Only for `message`. */
  message?: {
    name: string;
    /** Full text as typed. */
    text: string;
    /** Text with the app's @mention removed (Google fills it for mentions and slash commands). */
    argumentText: string;
    thread: string;
  };
  user: ChatUser;
  eventTime: string;
}

type Json = Record<string, any>;

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function readUser(u: Json | undefined): ChatUser {
  return {
    name: str(u?.name),
    displayName: str(u?.displayName) || 'Unknown',
    email: str(u?.email),
    type: str(u?.type) || 'HUMAN',
  };
}

function readSpace(s: Json | undefined): ChatEvent['space'] {
  return {
    name: str(s?.name),
    // `type` is the old field (ROOM | DM); `spaceType` the new (SPACE | GROUP_CHAT | DIRECT_MESSAGE).
    type: str(s?.spaceType) || str(s?.type),
    displayName: str(s?.displayName),
  };
}

function readMessage(m: Json | undefined): NonNullable<ChatEvent['message']> {
  const text = str(m?.text);
  return {
    name: str(m?.name),
    text,
    argumentText: str(m?.argumentText) || text,
    thread: str(m?.thread?.name),
  };
}

/** Parse the JSON body of a Pub/Sub message from Google Chat. Never throws. */
export function parseChatEvent(raw: unknown): ChatEvent {
  const other: ChatEvent = {
    kind: 'other',
    space: { name: '', type: '', displayName: '' },
    user: readUser(undefined),
    eventTime: '',
  };
  if (!raw || typeof raw !== 'object') return other;
  const ev = raw as Json;

  // Add-on format
  if (ev.chat && typeof ev.chat === 'object') {
    const chat = ev.chat as Json;
    const user = readUser(chat.user);
    const eventTime = str(chat.eventTime);
    if (chat.messagePayload) {
      const p = chat.messagePayload as Json;
      const message = readMessage(p.message);
      return {
        kind: 'message',
        space: readSpace(p.space ?? p.message?.space),
        message,
        user: readUser(p.message?.sender ?? chat.user),
        eventTime,
      };
    }
    if (chat.addedToSpacePayload) {
      return { kind: 'added', space: readSpace(chat.addedToSpacePayload.space), user, eventTime };
    }
    if (chat.removedFromSpacePayload) {
      return { kind: 'removed', space: readSpace(chat.removedFromSpacePayload.space), user, eventTime };
    }
    return { ...other, user, eventTime };
  }

  // Classic format
  const type = str(ev.type) || str(ev.eventType);
  const user = readUser(ev.message?.sender ?? ev.user);
  const base = { space: readSpace(ev.space), user, eventTime: str(ev.eventTime) };
  if (type === 'MESSAGE') return { kind: 'message', ...base, message: readMessage(ev.message) };
  if (type === 'ADDED_TO_SPACE') return { kind: 'added', ...base };
  if (type === 'REMOVED_FROM_SPACE') return { kind: 'removed', ...base };
  return { ...other, ...base };
}

/** True for a one-to-one chat with the app. */
export function isDirectMessage(space: ChatEvent['space']): boolean {
  return space.type === 'DIRECT_MESSAGE' || space.type === 'DM';
}
