import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizeCardAction, routeCardAction } from '../card-actions.js';
import type { GatewayConfig, RoutingConfig } from '../types.js';

const routing: RoutingConfig = { people: { alice: { open_id: 'ou_example_alice', agent: 'alice-agent', enabled: true, admin: false }, bob: { open_id: 'ou_example_bob', agent: 'bob-agent', enabled: true, admin: false } }, default_reply_unknown: '', disabled_person: '', group_pointer: '' };
test('card actions are owner-only and route to the button agent with person slug context', async () => {
  const owner = authorizeCardAction('ou_example_alice', 'alice', routing);
  assert.equal(owner, 'alice');
  assert.equal(authorizeCardAction('ou_example_bob', 'alice', routing), null);
  const captured: any[] = [];
  const config = { amp: { tenant: 'example', agentAddress: 'lark-bot@example.aimaestro.local', maestroUrl: 'http://amp', apiKey: 'key' }, timeoutMs: 1000 } as GatewayConfig;
  await routeCardAction(config, routing, { agent: 'alice-agent', action: 'approve', value: { yes: true }, amp_thread: 'amp-inbound-id' }, owner!, async (_url, init) => { captured.push(JSON.parse(String(init?.body))); return new Response('{}', { status: 200 }); });
  const request = captured[0];
  assert.equal(request.to, 'alice-agent@example.aimaestro.local');
  assert.equal(request.in_reply_to, 'amp-inbound-id');
  assert.deepEqual(request.payload.context.lark.card_action, { action: 'approve', value: { yes: true }, clicker: 'alice' });
  assert.equal(request.payload.context.channel.sender_id, 'alice');
  assert.equal(JSON.stringify(request).includes('ou_example_alice'), false);
  assert.equal(request.payload.context.security.trust, 'operator');
});

test('a clicker who owns another configured person is rejected before route', () => {
  assert.equal(authorizeCardAction('ou_example_bob', 'alice', routing), null);
});
