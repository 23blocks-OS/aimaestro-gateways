/** Upload and download attachments through the AMP capability URL contract. */
import { createHash } from 'node:crypto';
import type { GatewayConfig } from './types.js';

export interface AmpAttachmentReference {
  id: string;
  filename: string;
  content_type: string;
  size: number;
  digest: string;
  scan_status?: string;
  expires_at?: string;
  url?: string;
  download_url?: string;
  token?: string;
}

const RESERVED_NAMES = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);
export function sanitizeAttachmentFilename(
  raw: string,
  fallback: string,
): string {
  const valid = (value: string) => {
    const stripped = value.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
    return stripped.length > 0 &&
      stripped.length <= 255 &&
      /^[a-zA-Z0-9._-]+$/.test(stripped) &&
      !RESERVED_NAMES.has(stripped.split('.')[0].toUpperCase())
      ? stripped
      : null;
  };
  return valid(raw) || valid(fallback) || 'attachment';
}

interface JsonResponse {
  data?: Record<string, unknown>;
  attachment_id?: string;
  upload_url?: string;
  scan_status?: string;
  error?: string;
  message?: string;
}

function apiHeaders(config: GatewayConfig): Record<string, string> {
  return {
    authorization: `Bearer ${config.amp.apiKey}`,
    'content-type': 'application/json',
  };
}

async function responseData(
  response: Response,
  operation: string,
): Promise<Record<string, unknown>> {
  const body = (await response.json().catch(() => ({}))) as JsonResponse;
  if (!response.ok) {
    throw new Error(
      `AMP attachment ${operation} failed (${response.status}): ${body.message || body.error || 'request failed'}`,
    );
  }
  return body.data || (body as Record<string, unknown>);
}

/** Upload bytes, then confirm and return the small reference agents should receive. */
export async function uploadAmpAttachment(
  config: GatewayConfig,
  attachment: { name: string; content_type: string; bytes: Buffer },
  fetchImpl: typeof fetch = fetch,
): Promise<AmpAttachmentReference> {
  const digest = `sha256:${createHash('sha256').update(attachment.bytes).digest('hex')}`;
  const base = config.amp.maestroUrl.replace(/\/$/, '');
  const initialized = await fetchImpl(`${base}/api/v1/attachments/upload`, {
    method: 'POST',
    headers: apiHeaders(config),
    body: JSON.stringify({
      filename: attachment.name,
      content_type: attachment.content_type,
      size: attachment.bytes.length,
      digest,
    }),
    signal: AbortSignal.timeout(config.timeoutMs),
  });
  const init = await responseData(initialized, 'init');
  const id = String(init.id || init.attachment_id || '');
  const uploadUrl = String(init.upload_url || '');
  if (!id || !uploadUrl)
    throw new Error('AMP attachment init omitted attachment_id or upload_url');

  const uploaded = await fetchImpl(uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': attachment.content_type },
    body: Uint8Array.from(attachment.bytes).buffer as ArrayBuffer,
    signal: AbortSignal.timeout(config.timeoutMs),
  });
  await responseData(uploaded, 'content upload');

  const confirmation = await fetchImpl(
    `${base}/api/v1/attachments/${encodeURIComponent(id)}/confirm`,
    {
      method: 'POST',
      headers: apiHeaders(config),
      body: '{}',
      signal: AbortSignal.timeout(config.timeoutMs),
    },
  );
  const confirmed = await responseData(confirmation, 'confirm');
  if (confirmed.scan_status === 'rejected')
    throw new Error('AMP rejected the attachment during scanning');
  const statusResponse = await fetchImpl(
    `${base}/api/v1/attachments/${encodeURIComponent(id)}`,
    {
      method: 'GET',
      headers: apiHeaders(config),
      signal: AbortSignal.timeout(config.timeoutMs),
    },
  );
  const status = await responseData(statusResponse, 'status');
  if (typeof status.url !== 'string')
    throw new Error('AMP attachment status did not provide a download URL');
  return {
    id,
    filename: attachment.name,
    content_type: attachment.content_type,
    size: attachment.bytes.length,
    digest,
    scan_status:
      typeof status.scan_status === 'string'
        ? status.scan_status
        : typeof confirmed.scan_status === 'string'
          ? confirmed.scan_status
          : undefined,
    expires_at:
      typeof status.expires_at === 'string' ? status.expires_at : undefined,
    url: status.url,
  };
}

/** Resolve a capability reference into bytes without forwarding the bot API key. */
export async function downloadAmpAttachment(
  config: GatewayConfig,
  raw: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<{ name: string; contentType: string; bytes: Buffer }> {
  if (!raw || typeof raw !== 'object')
    throw new Error('Invalid AMP attachment reference');
  const attachment = raw as Record<string, unknown>;
  const name = String(attachment.filename || attachment.name || 'attachment');
  const contentType = String(
    attachment.content_type || 'application/octet-stream',
  );
  const hasInlineContent = typeof attachment.content === 'string';
  const inline = hasInlineContent ? String(attachment.content) : '';
  if (hasInlineContent)
    return { name, contentType, bytes: Buffer.from(inline, 'base64') };

  const directUrl = String(attachment.url || attachment.download_url || '');
  const id = String(attachment.attachment_id || attachment.id || '');
  const token = String(attachment.token || '');
  const url =
    directUrl ||
    (id && token
      ? `${config.amp.maestroUrl.replace(/\/$/, '')}/api/v1/attachments/${encodeURIComponent(id)}/content?token=${encodeURIComponent(token)}`
      : '');
  if (!url)
    throw new Error(
      `AMP attachment ${name} has no content URL or inline bytes`,
    );

  const response = await fetchImpl(url, {
    signal: AbortSignal.timeout(config.timeoutMs),
  });
  if (!response.ok)
    throw new Error(`AMP attachment download failed (${response.status})`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 25 * 1024 * 1024)
    throw new Error(`Attachment ${name} exceeds 25 MB`);
  return {
    name:
      response.headers
        .get('content-disposition')
        ?.match(/filename="?([^";]+)"?/)?.[1] || name,
    contentType: response.headers.get('content-type') || contentType,
    bytes,
  };
}
