/**
 * AMP Auto-Bootstrap
 *
 * On first boot (no AMP_API_KEY), registers the gateway as an AMP bridge
 * agent with the provider. Generates Ed25519 keys, calls /api/v1/register,
 * and persists everything to ~/.agent-messaging/ and the .env file.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export interface BootstrapOptions {
  agentName: string;
  maestroUrl: string;
  tenant?: string;
  alias?: string;
  envFile: string;
  metadata?: Record<string, string>;
}

export interface BootstrapResult {
  apiKey: string;
  address: string;
  agentId: string;
  tenant: string;
  inboxDir: string;
}

async function discoverProvider(maestroUrl: string): Promise<{ tenant: string; domain: string }> {
  const endpoints = [
    { url: `${maestroUrl}/.well-known/agent-messaging.json`, extract: (d: any) => ({ tenant: d.tenant || d.default_tenant, domain: d.domain }) },
    { url: `${maestroUrl}/api/v1/info`, extract: (d: any) => ({ tenant: d.tenant || d.default_tenant, domain: d.domain }) },
    { url: `${maestroUrl}/api/v1/health`, extract: (d: any) => ({ tenant: d.tenant || 'default', domain: d.domain || 'default.aimaestro.local' }) },
  ];

  for (const ep of endpoints) {
    try {
      const resp = await fetch(ep.url, { signal: AbortSignal.timeout(5000) });
      if (resp.ok) {
        const data = await resp.json();
        const result = ep.extract(data);
        if (result.tenant && result.domain) return result;
      }
    } catch { /* Try next */ }
  }

  return { tenant: 'default', domain: 'default.aimaestro.local' };
}

function generateKeyPair(): { publicKeyPem: string; privateKeyPem: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKeyPem: publicKey, privateKeyPem: privateKey };
}

async function registerAgent(
  maestroUrl: string, tenant: string, name: string,
  publicKeyPem: string, alias: string, metadata: Record<string, string>
): Promise<{ agent_id: string; address: string; api_key: string; tenant: string }> {
  const resp = await fetch(`${maestroUrl}/api/v1/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tenant, name, public_key: publicKeyPem, key_algorithm: 'Ed25519', alias, metadata }),
    signal: AbortSignal.timeout(10000),
  });

  if (!resp.ok) {
    const error = await resp.text();
    throw new Error(`AMP registration failed (${resp.status}): ${error}`);
  }

  return resp.json();
}

function saveAgentFiles(
  agentName: string, agentId: string, address: string, tenant: string,
  domain: string, apiKey: string, publicKeyPem: string, privateKeyPem: string
): string {
  const agentDir = path.join(process.env.HOME || '/root', '.agent-messaging', 'agents', agentId);
  const keysDir = path.join(agentDir, 'keys');
  const inboxDir = path.join(agentDir, 'messages', 'inbox');
  const sentDir = path.join(agentDir, 'messages', 'sent');
  const regDir = path.join(agentDir, 'registrations');

  for (const dir of [keysDir, inboxDir, sentDir, regDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(path.join(keysDir, 'public.pem'), publicKeyPem, { mode: 0o644 });
  fs.writeFileSync(path.join(keysDir, 'private.pem'), privateKeyPem, { mode: 0o600 });
  fs.writeFileSync(path.join(agentDir, 'config.json'), JSON.stringify({
    name: agentName, agent_id: agentId, address, tenant, domain,
    created_at: new Date().toISOString(),
  }, null, 2));
  fs.writeFileSync(path.join(regDir, `${domain}.json`), JSON.stringify({
    provider: domain, address, agent_id: agentId, api_key: apiKey,
    registered_at: new Date().toISOString(),
  }, null, 2), { mode: 0o600 });

  return inboxDir;
}

function updateIndex(agentName: string, agentId: string): void {
  const agentsDir = path.join(process.env.HOME || '/root', '.agent-messaging', 'agents');
  const indexPath = path.join(agentsDir, '.index.json');
  let index: Record<string, string> = {};
  try { index = JSON.parse(fs.readFileSync(indexPath, 'utf-8')); } catch { /* New index */ }
  index[agentName] = agentId;
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
}

function persistToEnv(envFile: string, apiKey: string, address: string, tenant: string, inboxDir: string): void {
  const vars: Record<string, string> = {
    AMP_API_KEY: apiKey,
    AMP_AGENT_ADDRESS: address,
    AMP_TENANT: tenant,
    AMP_INBOX_DIR: inboxDir,
  };
  let content = '';
  try { content = fs.readFileSync(envFile, 'utf-8'); } catch { /* File doesn't exist */ }

  for (const [key, value] of Object.entries(vars)) {
    const regex = new RegExp(`^${key}=.*$`, 'm');
    if (regex.test(content)) {
      content = content.replace(regex, `${key}=${value}`);
    } else {
      content += `\n${key}=${value}`;
    }
  }

  fs.writeFileSync(envFile, content.trimStart());
  console.log(`[BOOTSTRAP] Config persisted to ${envFile}`);
}

export async function bootstrapAMP(options: BootstrapOptions): Promise<BootstrapResult> {
  console.log('[BOOTSTRAP] No AMP_API_KEY found — starting auto-registration...');
  console.log(`[BOOTSTRAP] Agent: ${options.agentName}`);

  const provider = await discoverProvider(options.maestroUrl);
  const tenant = options.tenant || provider.tenant;
  console.log(`[BOOTSTRAP] Discovered tenant: ${tenant}, domain: ${provider.domain}`);

  const { publicKeyPem, privateKeyPem } = generateKeyPair();
  console.log('[BOOTSTRAP] Generated Ed25519 key pair');

  const result = await registerAgent(
    options.maestroUrl, tenant, options.agentName, publicKeyPem,
    options.alias || options.agentName, options.metadata || {}
  );
  console.log(`[BOOTSTRAP] Registered: ${result.address} (ID: ${result.agent_id})`);

  const inboxDir = saveAgentFiles(
    options.agentName, result.agent_id, result.address, tenant,
    provider.domain, result.api_key, publicKeyPem, privateKeyPem
  );
  updateIndex(options.agentName, result.agent_id);
  console.log(`[BOOTSTRAP] Saved agent files to ~/.agent-messaging/agents/${result.agent_id}/`);

  persistToEnv(options.envFile, result.api_key, result.address, tenant, inboxDir);
  console.log('[BOOTSTRAP] Auto-registration complete!');

  return {
    apiKey: result.api_key,
    address: result.address,
    agentId: result.agent_id,
    tenant,
    inboxDir,
  };
}
