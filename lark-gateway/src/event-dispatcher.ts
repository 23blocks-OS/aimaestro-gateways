/** Builds the SDK dispatcher used by Lark's persistent event connection. */
import { EventDispatcher } from '@larksuiteoapi/node-sdk';
import type { InboundEvent } from './inbound.js';

export interface InboundEnqueuer {
  enqueue(event: InboundEvent): void;
}

export type CardActionCallback = (
  event: unknown,
) => Promise<Record<string, unknown>>;

export function createLarkEventDispatcher(
  inbound: InboundEnqueuer,
  onCardAction?: CardActionCallback,
): EventDispatcher {
  const handlers: Record<string, (event: any) => Promise<unknown>> = {
    'im.message.receive_v1': async (event) => {
      inbound.enqueue(event);
      return {};
    },
  };
  if (onCardAction) handlers['card.action.trigger'] = onCardAction;
  return new EventDispatcher({}).register(handlers as any);
}
