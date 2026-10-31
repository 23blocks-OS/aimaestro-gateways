/** Loads gateway environment settings and validates sender routing files. */
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { parse } from "yaml";
import { bootstrapAMP } from "./amp-bootstrap.js";
import type { GatewayConfig, RoutingConfig } from "./types.js";

dotenv.config();

function resolveInboxDir(agentName: string): string {
  const root = path.join(
    process.env.HOME || "/root",
    ".agent-messaging",
    "agents",
  );
  try {
    const index = JSON.parse(
      fs.readFileSync(path.join(root, ".index.json"), "utf8"),
    ) as Record<string, string>;
    const uuid = index[agentName];
    if (uuid) return path.join(root, uuid, "messages", "inbox");
  } catch {
    /* use name-based path */
  }
  return path.join(root, agentName, "messages", "inbox");
}

export function loadRoutingFile(file: string): RoutingConfig {
  const parsed = parse(fs.readFileSync(file, "utf8")) as Partial<RoutingConfig>;
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !parsed.people ||
    typeof parsed.people !== "object"
  )
    throw new Error(`Invalid routing file: ${file}`);
  const people: Record<string, RoutingConfig["people"][string]> = {};
  for (const [person, route] of Object.entries(parsed.people)) {
    if (!/^[a-zA-Z0-9_-]+$/.test(person) || !route?.open_id || !route.agent)
      throw new Error(`Invalid person route: ${person}`);
    people[person] = {
      open_id: String(route.open_id),
      agent: String(route.agent),
      enabled: route.enabled !== false,
      admin: route.admin === true,
    };
  }
  return {
    tenant: parsed.tenant,
    default_reply_unknown:
      parsed.default_reply_unknown ||
      "This bot is not configured for your account.",
    disabled_person:
      parsed.disabled_person ||
      "This agent is paused. Please contact an administrator.",
    group_pointer:
      parsed.group_pointer ||
      "Please DM this bot to reach your AI Maestro agent.",
    people,
  };
}

export async function loadConfig(): Promise<GatewayConfig> {
  const ampName = process.env.AMP_AGENT_NAME || "lark-bot";
  const maestroUrl = process.env.AMP_MAESTRO_URL || "http://127.0.0.1:23000";
  const routeFile = path.resolve(
    process.env.LARK_ROUTING_FILE || "./routing.yaml",
  );
  let routingTenant: string | undefined;
  try {
    routingTenant = loadRoutingFile(routeFile).tenant;
  } catch {
    /* routing file may be provisioned after startup */
  }
  let amp = {
    apiKey: process.env.AMP_API_KEY || "",
    agentAddress:
      process.env.AMP_AGENT_ADDRESS || `${ampName}@default.aimaestro.local`,
    maestroUrl,
    defaultAgent: process.env.AMP_DEFAULT_AGENT || "default-agent",
    tenant: process.env.AMP_TENANT || routingTenant || "default",
    inboxDir: process.env.AMP_INBOX_DIR || resolveInboxDir(ampName),
  };
  if (!amp.apiKey && process.env.AMP_AUTO_REGISTER === "true") {
    const dir = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      "..",
    );
    const result = await bootstrapAMP({
      agentName: ampName,
      maestroUrl,
      tenant: process.env.AMP_TENANT,
      alias: "Lark Bridge",
      envFile: path.join(dir, ".env"),
      metadata: { agent_type: "bridge", channel_type: "lark" },
    });
    amp = {
      ...amp,
      apiKey: result.apiKey,
      agentAddress: result.address,
      tenant: result.tenant,
      inboxDir: result.inboxDir,
    };
  }
  return {
    port: Number.parseInt(process.env.PORT || "3025", 10),
    bindAddress: process.env.BIND_ADDRESS || process.env.HOST || "127.0.0.1",
    adminToken: process.env.ADMIN_TOKEN || "",
    appId: process.env.LARK_APP_ID || "",
    appSecret: process.env.LARK_APP_SECRET || "",
    verificationToken: process.env.LARK_VERIFICATION_TOKEN || "",
    encryptKey: process.env.LARK_ENCRYPT_KEY || "",
    domain: process.env.LARK_DOMAIN === "feishu" ? "feishu" : "lark",
    amp,
    routingFile: routeFile,
    stateDir: path.resolve(process.env.STATE_DIR || "./data"),
    pollIntervalMs: Number.parseInt(process.env.POLL_INTERVAL_MS || "3000", 10),
    timeoutMs: Number.parseInt(process.env.POLL_TIMEOUT_MS || "15000", 10),
    workingDelayMs: Number.parseInt(
      process.env.WORKING_DELAY_MS || "30000",
      10,
    ),
    replyInThread: process.env.LARK_REPLY_IN_THREAD === "true",
    cardCallbackMode:
      process.env.LARK_CARD_CALLBACK_MODE === "http"
        ? "http"
        : "long-connection",
  };
}

/** WebSocket callbacks do not need webhook tokens; HTTP callbacks do. */
export function hasLiveCredentials(config: GatewayConfig): boolean {
  return Boolean(
    config.appId &&
    config.appSecret &&
    config.amp.apiKey &&
    (config.cardCallbackMode !== "http" || config.verificationToken),
  );
}
