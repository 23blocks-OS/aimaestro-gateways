/** Verifies Lark message API response shapes used by the gateway. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { LarkApi } from '../lark-api.js';
import type { GatewayConfig } from '../types.js';

test('merge_forward fetch uses its own message id and omits the parent record', async () => {
  let requestedId = '';
  const client = {
    im: {
      message: {
        get: async ({ path }: any) => {
          requestedId = path.message_id;
          return {
            data: {
              items: [
                {
                  message_id: 'merge-parent',
                  body: { content: 'parent envelope' },
                  sender: { id: { open_id: 'ou_bot' } },
                },
                {
                  message_id: 'forwarded-1',
                  upper_message_id: 'merge-parent',
                  body: {
                    content: JSON.stringify({ text: 'hello from forwarding' }),
                  },
                  sender: { id: { open_id: 'ou_person' } },
                },
              ],
            },
          };
        },
      },
    },
  };
  const api = new LarkApi(client as any, {} as GatewayConfig);
  const messages = await api.forwardedMessages('merge-parent');
  assert.equal(requestedId, 'merge-parent');
  assert.deepEqual(messages, [
    {
      content: JSON.stringify({ text: 'hello from forwarding' }),
      sender: { sender_name: 'forwarded sender' },
    },
  ]);
});
