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
import {
  AmpRegistrationError,
  OrganizationNotSetError,
  discoverTenant,
  registerWithTenantFallback,
  retryWhileOrganizationNotSet,
} from './amp-tenant.js';

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
    throw new AmpRegistrationError(resp.status, error);
  }

  return resp.json();
}

function saveAgentFiles(
  agentName: string, agentId: string, address: string, tenant: string,
  domain: string, apiKey: string, publicKeyPem: string, privateKeyPem: string
): string {
  const agentDir = path.join(process.env.HOME || '/root', '.agent-messaging', 'agents', agentName);
  const keysDir = path.join(agentDir, 'keys');
  const inboxDir = path.join(agentDir, 'messages', 'inbox');
  const sentDir = path.join(agentDir, 'messages', 'sent');
  const regDir = path.join(agentDir, 'registrations');

  for (const dir of [keysDir, inboxDir, sentDir, regDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(path.join(keysDir, 'public.pem'), publicKeyPem, { mode: 0o644 });
  fs.writeFileSync(path.join(keysDir, 'private.pem'), privateKeyPem, { mode: 0o600 });
  fs.writeFileSync(path.join(agentDir, 'config.json'), JSON.stringify({ name: agentName, agent_id: agentId, address, tenant, domain, created_at: new Date().toISOString() }, null, 2));
  fs.writeFileSync(path.join(regDir, `${domain}.json`), JSON.stringify({ provider: domain, address, agent_id: agentId, api_key: apiKey, registered_at: new Date().toISOString() }, null, 2), { mode: 0o600 });

  return inboxDir;
}

function updateIndex(agentName: string): void {
  const agentsDir = path.join(process.env.HOME || '/root', '.agent-messaging', 'agents');
  const indexPath = path.join(agentsDir, '.index.json');
  let index: Record<string, string> = {};
  try { index = JSON.parse(fs.readFileSync(indexPath, 'utf-8')); } catch { /* New index */ }
  index[agentName] = agentName;
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
}

function persistToEnv(envFile: string, apiKey: string, address: string, tenant: string, inboxDir: string): void {
  const vars: Record<string, string> = { AMP_API_KEY: apiKey, AMP_AGENT_ADDRESS: address, AMP_TENANT: tenant, AMP_INBOX_DIR: inboxDir };
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

  const { publicKeyPem, privateKeyPem } = generateKeyPair();
  console.log('[BOOTSTRAP] Generated Ed25519 key pair');

  // Tenant: AMP_TENANT when set (explicit override), otherwise the AI Maestro
  // organization. A wrong guess is corrected once from the server's answer, and
  // a missing organization waits with backoff instead of crashing in a loop.
  const { result, tenant } = await retryWhileOrganizationNotSet(async () => {
    let wanted = options.tenant;
    if (wanted) {
      console.log(`[BOOTSTRAP] Using tenant from AMP_TENANT: ${wanted}`);
    } else {
      const found = await discoverTenant(options.maestroUrl);
      if (found.organizationUnset) throw new OrganizationNotSetError(options.maestroUrl);
      wanted = found.tenant || 'default';
      console.log(`[BOOTSTRAP] Discovered tenant: ${wanted}${found.source ? ` (from ${found.source})` : ' (no organization reported, trying default)'}`);
    }
    const registered = await registerWithTenantFallback(wanted, options.maestroUrl, (t) =>
      registerAgent(
        options.maestroUrl,
        t,
        options.agentName,
        publicKeyPem,
        options.alias || options.agentName,
        options.metadata || {}
      )
    );
    console.log(`[BOOTSTRAP] Registered: ${registered.result.address} (ID: ${registered.result.agent_id})`);
    return registered;
  });
  const domain = result.address.split('@')[1] || `${tenant}.aimaestro.local`;

  const inboxDir = saveAgentFiles(options.agentName, result.agent_id, result.address, tenant, domain, result.api_key, publicKeyPem, privateKeyPem);
  updateIndex(options.agentName);
  console.log(`[BOOTSTRAP] Saved agent files to ~/.agent-messaging/agents/${options.agentName}/`);

  persistToEnv(options.envFile, result.api_key, result.address, tenant, inboxDir);
  console.log('[BOOTSTRAP] Auto-registration complete!');

  return { apiKey: result.api_key, address: result.address, agentId: result.agent_id, tenant, inboxDir };
}
