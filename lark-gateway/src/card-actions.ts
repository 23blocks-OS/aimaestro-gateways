/** Validates card click owners and routes accepted actions to AMP. */
import { agentAddress, cardClickOwner } from "./routing.js";
import { sanitizeMessage } from "./content-security.js";
import type { GatewayConfig, RoutingConfig } from "./types.js";
import { DedupeStore } from "./dedupe.js";
import { normalizeCardAction } from "@larksuiteoapi/node-sdk";

type Dict = Record<string, unknown>;
function object(value: unknown): Dict {
  return value && typeof value === "object" ? (value as Dict) : {};
}

export function authorizeCardAction(
  openId: string,
  owner: string,
  routing: RoutingConfig,
): string | null {
  if (!cardClickOwner(openId, owner, routing)) return null;
  return (
    Object.entries(routing.people).find(
      ([, person]) => person.open_id === openId,
    )?.[0] || null
  );
}

export async function routeCardAction(
  config: GatewayConfig,
  routing: RoutingConfig,
  value: Record<string, unknown>,
  clicker: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const selectedAgent = typeof value.agent === "string" ? value.agent : "";
  if (!selectedAgent) throw new Error("Card action has no agent");
  const target =
    routing.people[clicker]?.agent === selectedAgent ? "operator" : "external";
  const text = JSON.stringify({ action: value.action, value: value.value });
  const sanitized = sanitizeMessage(text, clicker, target, false);
  const request = {
    to: agentAddress(selectedAgent, config.amp.tenant),
    subject: `Lark card action from ${clicker}`,
    in_reply_to:
      typeof value.amp_thread === "string" ? value.amp_thread : undefined,
    payload: {
      type: "request",
      message: sanitized.sanitized,
      context: {
        channel: {
          type: "lark",
          bridge_agent: config.amp.agentAddress,
          sender: clicker,
          sender_id: clicker,
        },
        lark: {
          app: "agent",
          person: clicker,
          card_action: { action: value.action, value: value.value, clicker },
        },
        security: {
          trust: sanitized.trust.level,
          injection_flags: sanitized.flags.map((flag) => flag.category),
          wrapped: sanitized.wrapped,
        },
      },
    },
  };
  const response = await fetchImpl(`${config.amp.maestroUrl}/api/v1/route`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.amp.apiKey}`,
    },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(config.timeoutMs),
  });
  if (!response.ok) throw new Error(`AMP route failed (${response.status})`);
}

/** Return the Lark callback response promptly and route accepted clicks once. */
export function createCardActionHandler(
  config: GatewayConfig,
  getRouting: () => RoutingConfig,
  dedupe: DedupeStore,
  fetchImpl: typeof fetch = fetch,
): (raw: unknown) => Promise<Record<string, unknown>> {
  return async (raw: unknown) => {
    const outer = object(raw);
    const event = normalizeCardAction(object(outer.event || raw) as any);
    if (!event)
      return {
        toast: {
          type: "error",
          content: "This card action could not be read.",
        },
      };

    const value = object(event.action.value);
    const owner = typeof value.owner === "string" ? value.owner : "";
    const routing = getRouting();
    const clicker = authorizeCardAction(event.operator.openId, owner, routing);
    if (!clicker)
      return {
        toast: {
          type: "error",
          content: "This button belongs to another user.",
        },
      };

    const headerEventId = object(outer.header).event_id;
    const eventId =
      typeof headerEventId === "string"
        ? headerEventId
        : typeof outer.event_id === "string"
          ? outer.event_id
          : "";
    const actionKey = `card:${event.messageId}:${clicker}:${JSON.stringify(event.action.value || {})}`;
    if (dedupe.hasOrAdd(eventId, actionKey)) {
      return {
        toast: {
          type: "success",
          content: "This action was already received.",
        },
      };
    }

    void routeCardAction(config, routing, value, clicker, fetchImpl).catch(
      (error) =>
        console.error(
          `[CARD] Action route failed: ${(error as Error).message}`,
        ),
    );
    return {
      toast: {
        type: "success",
        content: "Received. The agent is working on it.",
      },
    };
  };
}
