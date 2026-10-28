/**
 * Path segments built from sender-controlled strings (Message-Id headers,
 * attachment names). Keeps them to one plain segment: no separators, no
 * leading dots, so "." and ".." can never climb out of the target folder.
 */
export function safeSegment(input: string, fallback = '_'): string {
  const cleaned = String(input).replace(/[^a-zA-Z0-9._@-]/g, '_').replace(/^\.+/, '_');
  return cleaned.length > 0 ? cleaned : fallback;
}
