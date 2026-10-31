/** Maps Lark senders and AMP agent identities to configured routes. */
import type { RoutingConfig } from "./types.js";

export interface RouteDecision {
  kind: "route" | "unknown" | "disabled" | "group" | "ignore";
  person?: string;
  agent?: string;
  reply?: string;
  isOwner: boolean;
  admin: boolean;
}

export function resolveSender(
  openId: string,
  config: RoutingConfig,
  chatType: string,
  mentioned: boolean,
): RouteDecision {
  if (chatType !== "p2p")
    return mentioned
      ? {
          kind: "group",
          reply: config.group_pointer,
          isOwner: false,
          admin: false,
        }
      : { kind: "ignore", isOwner: false, admin: false };
  const found = Object.entries(config.people).find(
    ([, person]) => person.open_id === openId,
  );
  if (!found)
    return {
      kind: "unknown",
      reply: config.default_reply_unknown,
      isOwner: false,
      admin: false,
    };
  const [slug, person] = found;
  if (!person.enabled)
    return {
      kind: "disabled",
      person: slug,
      reply: config.disabled_person,
      isOwner: false,
      admin: person.admin,
    };
  return {
    kind: "route",
    person: slug,
    agent: person.agent,
    isOwner: true,
    admin: person.admin,
  };
}

export function parseAgentTag(text: string): { agent?: string; text: string } {
  const match = text.match(/@AIM:([a-zA-Z0-9_@.\-]+)/i);
  return match
    ? {
        agent: match[1],
        text:
          text.replace(match[0], "").replace(/\s+/g, " ").trim() ||
          "(no message)",
      }
    : { text };
}

export function agentAddress(agent: string, tenant: string): string {
  return agent.includes("@") ? agent : `${agent}@${tenant}.aimaestro.local`;
}

/** Compare an AMP sender with an owner, accepting a slug or full address. */
export function isAgentSender(
  from: string | undefined,
  agent: string,
  tenant: string,
): boolean {
  if (!from) return false;
  const expected = agentAddress(agent, tenant).toLowerCase();
  const actual = from.trim().toLowerCase();
  if (actual === expected) return true;
  const [actualName, actualDomain, extra] = actual.split("@");
  const [expectedName, expectedDomain] = expected.split("@");
  return (
    !extra && actualName === expectedName && actualDomain === expectedDomain
  );
}

export function cardClickOwner(
  openId: string,
  owner: string,
  config: RoutingConfig,
): boolean {
  const person = Object.entries(config.people).find(
    ([, route]) => route.open_id === openId,
  )?.[0];
  return Boolean(person && person === owner && config.people[person]?.enabled);
}
