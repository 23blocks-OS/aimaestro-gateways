import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  AmpRegistrationError,
  OrganizationNotSetError,
  discoverTenant,
  registerWithTenantFallback,
  retryWhileOrganizationNotSet,
  tenantFromProvider,
} from '../amp-tenant.js';
import { bootstrapAMP } from '../amp-bootstrap.js';

const URL_ = 'http://maestro.test';

type Handler = (url: string, init?: any) => { status: number; body: unknown } | Error;

/** A fake fetch driven by a route table; records every call. */
function fakeFetch(handler: Handler) {
  const calls: { url: string; body?: any }[] = [];
  const fn = async (input: any, init?: any) => {
    const url = String(input);
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
    const r = handler(url, init);
    if (r instanceof Error) throw r;
    const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => JSON.parse(text),
      text: async () => text,
    };
  };
  return { fn: fn as any, calls };
}

const registered = (tenant: string) => ({
  agent_id: 'id-1',
  address: `gw@${tenant}.aimaestro.local`,
  api_key: 'amp_key',
  tenant,
});

test('tenantFromProvider reads the organization and ignores "default"', () => {
  assert.equal(tenantFromProvider('aim-poc.aimaestro.local'), 'aim-poc');
  assert.equal(tenantFromProvider('host1.aim-poc.aimaestro.local'), 'aim-poc');
  assert.equal(tenantFromProvider('default.aimaestro.local'), null);
  assert.equal(tenantFromProvider('example.com'), null);
  assert.equal(tenantFromProvider(undefined), null);
});

test('discoverTenant uses /api/organization', async () => {
  const { fn } = fakeFetch((u) =>
    u.endsWith('/api/organization')
      ? { status: 200, body: { organization: 'aim-poc', isSet: true } }
      : { status: 404, body: {} }
  );
  assert.deepEqual(await discoverTenant(URL_, fn), {
    tenant: 'aim-poc',
    organizationUnset: false,
    source: '/api/organization',
  });
});

test('discoverTenant reports an unset organization', async () => {
  const { fn } = fakeFetch(() => ({ status: 200, body: { organization: null, isSet: false } }));
  const d = await discoverTenant(URL_, fn);
  assert.equal(d.organizationUnset, true);
  assert.equal(d.tenant, undefined);
});

test('discoverTenant falls back to the provider domain on older servers', async () => {
  const { fn } = fakeFetch((u) =>
    u.endsWith('/api/v1/info') ? { status: 200, body: { provider: 'aim-poc.aimaestro.local' } } : { status: 404, body: {} }
  );
  assert.equal((await discoverTenant(URL_, fn)).tenant, 'aim-poc');
});

test('discoverTenant returns nothing when the server is unreachable', async () => {
  const { fn } = fakeFetch(() => new Error('ECONNREFUSED'));
  assert.deepEqual(await discoverTenant(URL_, fn), { organizationUnset: false });
});

test('invalid_field with expected_tenant retries once with that tenant', async () => {
  const seen: string[] = [];
  const logs: string[] = [];
  const out = await registerWithTenantFallback(
    'default',
    URL_,
    async (t) => {
      seen.push(t);
      if (t === 'default') {
        throw new AmpRegistrationError(
          400,
          JSON.stringify({ error: 'invalid_field', field: 'tenant', details: { expected_tenant: 'aim-poc' } })
        );
      }
      return registered(t);
    },
    (m) => logs.push(m)
  );
  assert.deepEqual(seen, ['default', 'aim-poc']);
  assert.equal(out.tenant, 'aim-poc');
  assert.match(logs[0], /aim-poc/);
});

test('invalid_field retries only once', async () => {
  const seen: string[] = [];
  const err = new AmpRegistrationError(
    400,
    JSON.stringify({ error: 'invalid_field', details: { expected_tenant: 'other' } })
  );
  await assert.rejects(
    registerWithTenantFallback('default', URL_, async (t) => { seen.push(t); throw err; }, () => {}),
    AmpRegistrationError
  );
  assert.equal(seen.length, 2);
});

test('organization_not_set becomes OrganizationNotSetError', async () => {
  await assert.rejects(
    registerWithTenantFallback('default', URL_, async () => {
      throw new AmpRegistrationError(400, JSON.stringify({ error: 'organization_not_set', message: 'x' }));
    }),
    OrganizationNotSetError
  );
});

test('other registration errors propagate unchanged', async () => {
  await assert.rejects(
    registerWithTenantFallback('t', URL_, async () => { throw new AmpRegistrationError(500, 'boom'); }),
    /registration failed \(500\): boom/
  );
});

test('wait loop backs off, caps at 60s, logs once a minute, then succeeds', async () => {
  let clock = 0;
  const sleeps: number[] = [];
  const logs: string[] = [];
  let calls = 0;
  const out = await retryWhileOrganizationNotSet(
    async () => {
      if (++calls <= 10) throw new OrganizationNotSetError(URL_);
      return 'ok';
    },
    {
      sleep: async (ms) => { sleeps.push(ms); clock += ms; },
      now: () => clock,
      log: (m) => logs.push(m),
    }
  );
  assert.equal(out, 'ok');
  assert.deepEqual(sleeps, [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000, 60000]);
  assert.ok(Math.max(...sleeps) <= 60000);
  // 1+2+4+8+16+32 = 63s before the 7th attempt, then 60s steps: far fewer logs than attempts.
  assert.ok(logs.length < 10 && logs.length >= 2, `logged ${logs.length} times`);
  assert.match(logs[0], /POST .*\/api\/organization/);
  assert.match(logs[0], /dashboard/);
});

test('wait loop does not swallow other errors', async () => {
  await assert.rejects(
    retryWhileOrganizationNotSet(async () => { throw new Error('network down'); }, { sleep: async () => {} }),
    /network down/
  );
});

// --- bootstrapAMP end to end with a fake fetch -------------------------------

async function runBootstrap(handler: Handler, tenant?: string) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'amp-tenant-test-'));
  const oldHome = process.env.HOME;
  const oldFetch = globalThis.fetch;
  const { fn, calls } = fakeFetch(handler);
  process.env.HOME = home;
  globalThis.fetch = fn;
  const silence = console.log;
  console.log = () => {};
  try {
    const result = await bootstrapAMP({
      agentName: 'gw',
      maestroUrl: URL_,
      tenant,
      envFile: path.join(home, '.env'),
    });
    return { result, calls, env: fs.readFileSync(path.join(home, '.env'), 'utf-8') };
  } finally {
    console.log = silence;
    globalThis.fetch = oldFetch;
    process.env.HOME = oldHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const registerBodies = (calls: { url: string; body?: any }[]) =>
  calls.filter((c) => c.url.endsWith('/api/v1/register')).map((c) => c.body.tenant);

test('bootstrap without AMP_TENANT registers under the discovered organization', async () => {
  const { result, calls, env } = await runBootstrap((u) =>
    u.endsWith('/api/organization')
      ? { status: 200, body: { organization: 'aim-poc', isSet: true } }
      : { status: 200, body: registered('aim-poc') }
  );
  assert.deepEqual(registerBodies(calls), ['aim-poc']);
  assert.equal(result.tenant, 'aim-poc');
  assert.match(env, /AMP_TENANT=aim-poc/);
});

test('bootstrap with AMP_TENANT does not discover and uses the override', async () => {
  const { calls, result } = await runBootstrap(
    (u) => (u.endsWith('/api/v1/register') ? { status: 200, body: registered('mine') } : { status: 500, body: {} }),
    'mine'
  );
  assert.deepEqual(calls.map((c) => c.url), [`${URL_}/api/v1/register`]);
  assert.equal(result.tenant, 'mine');
});

test('bootstrap corrects a wrong tenant from invalid_field', async () => {
  let n = 0;
  const { calls, result } = await runBootstrap((u) => {
    if (!u.endsWith('/api/v1/register')) return { status: 404, body: {} };
    return n++ === 0
      ? { status: 400, body: { error: 'invalid_field', field: 'tenant', details: { expected_tenant: 'aim-poc' } } }
      : { status: 200, body: registered('aim-poc') };
  });
  assert.deepEqual(registerBodies(calls), ['default', 'aim-poc']);
  assert.equal(result.tenant, 'aim-poc');
});
