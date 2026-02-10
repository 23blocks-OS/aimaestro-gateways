/**
 * WhatsApp phone number and JID normalization.
 *
 * WhatsApp uses JIDs (Jabber IDs):
 * - User chats: 1234567890@s.whatsapp.net
 * - Groups: 120363012345@g.us
 *
 * We normalize to E.164 format for routing (+1234567890).
 */

const USER_JID_RE = /^(\d+)(?::\d+)?@s\.whatsapp\.net$/i;
const GROUP_JID_RE = /^[\d]+([-][\d]+)*@g\.us$/i;

/**
 * Extract the phone number from a WhatsApp user JID.
 * "1234567890@s.whatsapp.net" → "+1234567890"
 * "1234567890:0@s.whatsapp.net" → "+1234567890"
 */
export function jidToPhone(jid: string): string | null {
  const match = jid.match(USER_JID_RE);
  if (!match) return null;
  return `+${match[1]}`;
}

/**
 * Convert a phone number to a WhatsApp JID.
 * "+1234567890" → "1234567890@s.whatsapp.net"
 */
export function phoneToJid(phone: string): string {
  const digits = phone.replace(/[^0-9]/g, '');
  return `${digits}@s.whatsapp.net`;
}

/**
 * Check if a JID is a group.
 */
export function isGroupJid(jid: string): boolean {
  return GROUP_JID_RE.test(jid);
}

/**
 * Normalize a phone number to E.164 format.
 * Strips everything except digits, prepends + if missing.
 */
export function normalizePhone(input: string): string | null {
  const digits = input.replace(/[^0-9]/g, '');
  if (digits.length < 7 || digits.length > 15) return null;
  return `+${digits}`;
}

/**
 * Normalize an outbound target (phone or group JID).
 * Returns a WhatsApp JID ready for Baileys.
 */
export function normalizeTarget(target: string): string | null {
  const trimmed = target.trim();

  // Already a JID
  if (trimmed.includes('@')) {
    if (USER_JID_RE.test(trimmed) || GROUP_JID_RE.test(trimmed)) {
      return trimmed;
    }
    return null;
  }

  // Phone number → user JID
  const phone = normalizePhone(trimmed);
  if (!phone) return null;
  return phoneToJid(phone);
}
