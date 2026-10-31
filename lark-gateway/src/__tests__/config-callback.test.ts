/** Tests callback credentials for persistent and legacy HTTP modes. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { hasLiveCredentials } from '../config.js';
import type { GatewayConfig } from '../types.js';
import express from 'express';
import { CardActionHandler, adaptExpress } from '@larksuiteoapi/node-sdk';
import { larkLogger } from '../lark-logger.js';
import { once } from 'node:events';

function config(
  mode: 'long-connection' | 'http',
  verificationToken: string,
): GatewayConfig {
  return {
    appId: 'app-id',
    appSecret: 'app-secret',
    verificationToken,
    cardCallbackMode: mode,
    amp: { apiKey: 'amp-key' },
  } as GatewayConfig;
}

test('long-connection card actions do not require a verification token', () => {
  assert.equal(hasLiveCredentials(config('long-connection', '')), true);
});

test('HTTP callback mode requires its verification token', () => {
  assert.equal(hasLiveCredentials(config('http', '')), false);
  assert.equal(hasLiveCredentials(config('http', 'callback-token')), true);
});

test('SDK Express callback adapter answers Lark URL verification before card dispatch', async () => {
  const app = express();
  app.use(express.json());
  const dispatcher = new CardActionHandler(
    { verificationToken: 'verify-me', encryptKey: '', logger: larkLogger },
    async () => ({ toast: { type: 'success', content: 'ok' } }),
  );
  app.post(
    '/lark/callback',
    adaptExpress(dispatcher, { autoChallenge: true, logger: larkLogger }),
  );
  const server = app.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const response = await fetch(
      `http://127.0.0.1:${address.port}/lark/callback`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'url_verification',
          token: 'verify-me',
          challenge: 'challenge-123',
        }),
      },
    );
    assert.deepEqual(await response.json(), { challenge: 'challenge-123' });
  } finally {
    server.close();
  }
});
