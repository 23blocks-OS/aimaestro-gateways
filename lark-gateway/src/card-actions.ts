import { agentAddress, cardClickOwner } from './routing.js';
import { sanitizeMessage } from './content-security.js';
import type { GatewayConfig, RoutingConfig } from './types.js';

export function authorizeCardAction(openId: string, owner: string, routing: RoutingConfig): string | null {
  if (!cardClickOwner(openId, owner, routing)) return null;
  return Object.entries(routing.people).find(([, person]) => person.open_id === openId)?.[0] || null;
}

export async function routeCardAction(config: GatewayConfig, routing: RoutingConfig, value: Record<string, unknown>, clicker: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const selectedAgent = typeof value.agent === 'string' ? value.agent : '';
  if (!selectedAgent) throw new Error('Card action has no agent');
  const target = routing.people[clicker]?.agent === selectedAgent ? 'operator' : 'external';
  const text = JSON.stringify({ action: value.action, value: value.value });
  const sanitized = sanitizeMessage(text, clicker, target, false);
  const request = {
    to: agentAddress(selectedAgent, config.amp.tenant),
    subject: `Lark card action from ${clicker}`,
    in_reply_to: typeof value.amp_thread === 'string' ? value.amp_thread : undefined,
    payload: {
      type: 'request', message: sanitized.sanitized,
      context: {
        channel: { type: 'lark', bridge_agent: config.amp.agentAddress, sender: clicker, sender_id: clicker },
        lark: { app: 'agent', person: clicker, card_action: { action: value.action, value: value.value, clicker } },
        security: { trust: sanitized.trust.level, injection_flags: sanitized.flags.map((flag) => flag.category), wrapped: sanitized.wrapped },
      },
    },
  };
  const response = await fetchImpl(`${config.amp.maestroUrl}/api/v1/route`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${config.amp.apiKey}` }, body: JSON.stringify(request), signal: AbortSignal.timeout(config.timeoutMs) });
  if (!response.ok) throw new Error(`AMP route failed (${response.status})`);
}
