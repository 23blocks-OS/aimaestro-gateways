/** Tests AMP upload/confirm and reference-based attachment retrieval. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  downloadAmpAttachment,
  sanitizeAttachmentFilename,
  uploadAmpAttachment,
} from '../attachment-flow.js';
import type { GatewayConfig } from '../types.js';

const config = {
  amp: {
    apiKey: 'fake-key',
    maestroUrl: 'https://maestro.example.invalid',
    tenant: 'example',
  },
  timeoutMs: 1000,
} as GatewayConfig;

test('uploads bytes through AMP init, PUT, confirm, and status, returning a capability reference', async () => {
  const calls: Array<{
    url: string;
    method: string;
    auth?: string;
    body?: string;
  }> = [];
  const fetchFake: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method || 'GET';
    calls.push({
      url,
      method,
      auth: new Headers(init?.headers).get('authorization') || undefined,
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    if (url.endsWith('/api/v1/attachments/upload')) {
      return Response.json({
        data: {
          attachment_id: 'att_123',
          upload_url: 'https://upload.example.invalid/put',
        },
      });
    }
    if (method === 'PUT')
      return Response.json({ data: { ok: true, scan_status: 'clean' } });
    if (url.endsWith('/confirm'))
      return Response.json({
        data: { attachment_id: 'att_123', scan_status: 'clean' },
      });
    return Response.json({
      data: {
        url: 'https://maestro.example.invalid/api/v1/attachments/att_123/content?token=cap',
        scan_status: 'clean',
        expires_at: '2027-01-01T00:00:00Z',
      },
    });
  };
  const result = await uploadAmpAttachment(
    config,
    {
      name: 'file.txt',
      content_type: 'text/plain',
      bytes: Buffer.from('hello'),
    },
    fetchFake,
  );
  assert.equal(calls.length, 4);
  assert.equal(calls[1]?.method, 'PUT');
  assert.equal(calls[1]?.auth, undefined);
  assert.equal(calls[2]?.url.endsWith('/att_123/confirm'), true);
  assert.equal(calls[3]?.url.endsWith('/att_123'), true);
  assert.equal(result.id, 'att_123');
  assert.equal(result.scan_status, 'clean');
  assert.equal(result.expires_at, '2027-01-01T00:00:00Z');
  assert.equal(
    result.digest,
    'sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
  );
  assert.match(result.url || '', /token=cap/);
});

test("sanitizes Lark filenames using Maestro's published filename rules", () => {
  assert.equal(
    sanitizeAttachmentFilename('../résumé.pdf', 'file_key_123'),
    'file_key_123',
  );
  assert.equal(
    sanitizeAttachmentFilename('report.pdf', 'file_key_123'),
    'report.pdf',
  );
  assert.equal(
    sanitizeAttachmentFilename('CON.txt', 'file_key_123'),
    'file_key_123',
  );
});

test('downloads references by capability URL and still accepts inline base64', async () => {
  let fetchCount = 0;
  const fetchFake: typeof fetch = async () => {
    fetchCount++;
    return new Response(Buffer.from('from reference'), {
      headers: {
        'content-type': 'text/plain',
        'content-disposition': 'attachment; filename="resolved.txt"',
      },
    });
  };
  const resolved = await downloadAmpAttachment(
    config,
    {
      filename: 'fallback.txt',
      content_type: 'application/octet-stream',
      url: 'https://maestro.example.invalid/content?token=cap',
    },
    fetchFake,
  );
  assert.equal(resolved.name, 'resolved.txt');
  assert.equal(resolved.contentType, 'text/plain');
  assert.equal(resolved.bytes.toString(), 'from reference');
  const inline = await downloadAmpAttachment(
    config,
    {
      name: 'inline.txt',
      content_type: 'text/plain',
      content: Buffer.from('inline').toString('base64'),
    },
    fetchFake,
  );
  assert.equal(inline.bytes.toString(), 'inline');
  assert.equal(fetchCount, 1);
});

test('rejects an outbound reference larger than the 25 MB limit', async () => {
  const fetchLarge: typeof fetch = async () =>
    new Response(Buffer.alloc(26 * 1024 * 1024));
  await assert.rejects(
    downloadAmpAttachment(
      config,
      {
        name: 'large.bin',
        url: 'https://maestro.example.invalid/content?token=cap',
      },
      fetchLarge,
    ),
    /exceeds 25 MB/,
  );
});
