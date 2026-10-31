/**
 * AMP tenant discovery and registration error handling.
 *
 * Shared logic for amp-bootstrap.ts. This file is copied byte-for-byte into
 * every gateway package (slack, discord, email, whatsapp, google-chat); keep
 * the copies identical.
 *
 * AI Maestro only accepts registrations under its configured organization, and
 * the organization is the AMP tenant. So the tenant is discovered from
 * GET /api/organization instead of being hard-coded to "default".
 */

export const PROVIDER_SUFFIX = '.aimaestro.local';
export const MAX_BACKOFF_MS = 60_000;

type FetchLike = (input: string, init?: { signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export interface TenantDiscovery {
  /** Organization name to use as tenant, when AI Maestro told us one. */
  tenant?: string;
  /** True when AI Maestro answered and said no organization is configured. */
  organizationUnset: boolean;
  /** Where the tenant came from, for logs. */
  source?: string;
}

/** AI Maestro has no organization yet (`organization_not_set`). */
export class OrganizationNotSetError extends Error {
  constructor(public readonly maestroUrl: string) {
    super('AI Maestro has no organization configured');
    this.name = 'OrganizationNotSetError';
  }
}

/** A non-2xx answer from POST /api/v1/register. */
export class AmpRegistrationError extends Error {
  readonly code?: string;
  readonly expectedTenant?: string;

  constructor(public readonly status: number, public readonly body: string) {
    super(`AMP registration failed (${status}): ${body}`);
    this.name = 'AmpRegistrationError';
    try {
      const parsed = JSON.parse(body) as { error?: unknown; details?: { expected_tenant?: unknown } };
      if (typeof parsed.error === 'string') this.code = parsed.error;
      const expected = parsed.details?.expected_tenant;
      if (typeof expected === 'string' && expected) this.expectedTenant = expected;
    } catch {
      // Not JSON; leave code undefined.
    }
  }
}

export function organizationNotSetMessage(maestroUrl: string): string {
  return (
    `AI Maestro at ${maestroUrl} has no organization configured yet, so it cannot register this gateway. ` +
    `Set the organization in the AI Maestro dashboard (setup page), or run: ` +
    `curl -X POST ${maestroUrl}/api/organization -H 'Content-Type: application/json' -d '{"organization":"<name>"}'. ` +
    `The gateway will keep retrying (at most once a minute) and continue by itself once it is set. ` +
    `Alternatively set AMP_TENANT in .env.`
  );
}

/** "foo.bar.aimaestro.local" -> "bar"; null when the shape is not ours or the tenant is "default". */
export function tenantFromProvider(provider: unknown): string | null {
  if (typeof provider !== 'string' || !provider.endsWith(PROVIDER_SUFFIX)) return null;
  const labels = provider.slice(0, -PROVIDER_SUFFIX.length).split('.').filter(Boolean);
  const tenant = labels[labels.length - 1];
  // "default" is what AI Maestro reports both for a real "default" organization
  // and for an unset one, so it is not evidence of anything.
  return tenant && tenant !== 'default' ? tenant : null;
}

async function getJson(fetchImpl: FetchLike, url: string): Promise<any | null> {
  try {
    const resp = await fetchImpl(url, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

/**
 * Ask AI Maestro which organization (tenant) it is configured for.
 *
 * 1. GET /api/organization -> { organization, isSet }  (authoritative)
 * 2. Older servers without that route: the provider domain advertised by
 *    GET /api/v1/info or /.well-known/agent-messaging.json, whose first label
 *    before ".aimaestro.local" is the organization.
 */
export async function discoverTenant(
  maestroUrl: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike
): Promise<TenantDiscovery> {
  const org = await getJson(fetchImpl, `${maestroUrl}/api/organization`);
  if (org && typeof org === 'object') {
    if (typeof org.organization === 'string' && org.organization && org.isSet !== false) {
      return { tenant: org.organization, organizationUnset: false, source: '/api/organization' };
    }
    if (org.isSet === false || org.organization === null) {
      return { organizationUnset: true };
    }
  }

  const info = await getJson(fetchImpl, `${maestroUrl}/api/v1/info`);
  const fromInfo = tenantFromProvider(info?.provider);
  if (fromInfo) return { tenant: fromInfo, organizationUnset: false, source: '/api/v1/info' };

  const wellKnown = await getJson(fetchImpl, `${maestroUrl}/.well-known/agent-messaging.json`);
  const fromWellKnown = tenantFromProvider(wellKnown?.provider);
  if (fromWellKnown) return { tenant: fromWellKnown, organizationUnset: false, source: '/.well-known/agent-messaging.json' };

  return { organizationUnset: false };
}

/**
 * Run `register(tenant)`. If AI Maestro answers `invalid_field` with
 * `details.expected_tenant`, retry once with that tenant. If it answers
 * `organization_not_set`, throw OrganizationNotSetError.
 */
export async function registerWithTenantFallback<T>(
  tenant: string,
  maestroUrl: string,
  register: (tenant: string) => Promise<T>,
  log: (msg: string) => void = console.log
): Promise<{ result: T; tenant: string }> {
  try {
    return { result: await register(tenant), tenant };
  } catch (err) {
    if (!(err instanceof AmpRegistrationError)) throw err;
    if (err.code === 'organization_not_set') throw new OrganizationNotSetError(maestroUrl);
    if (err.code === 'invalid_field' && err.expectedTenant && err.expectedTenant !== tenant) {
      log(`[BOOTSTRAP] AI Maestro expects tenant '${err.expectedTenant}', not '${tenant}'; retrying once with '${err.expectedTenant}'`);
      try {
        return { result: await register(err.expectedTenant), tenant: err.expectedTenant };
      } catch (retryErr) {
        if (retryErr instanceof AmpRegistrationError && retryErr.code === 'organization_not_set') {
          throw new OrganizationNotSetError(maestroUrl);
        }
        throw retryErr;
      }
    }
    throw err;
  }
}

/**
 * Call `attempt` until it stops throwing OrganizationNotSetError. Prints the
 * actionable message once, then at most once a minute; waits 1s, 2s, 4s ...
 * capped at 60s between attempts, so a supervisor restart loop (pm2) cannot
 * spin. Other errors propagate.
 */
export async function retryWhileOrganizationNotSet<T>(
  attempt: () => Promise<T>,
  opts: {
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    log?: (msg: string) => void;
    maxAttempts?: number;
  } = {}
): Promise<T> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((m: string) => console.error(m));
  let lastLogged = -Infinity;

  for (let n = 0; ; n++) {
    try {
      return await attempt();
    } catch (err) {
      if (!(err instanceof OrganizationNotSetError)) throw err;
      if (opts.maxAttempts !== undefined && n + 1 >= opts.maxAttempts) throw err;
      if (now() - lastLogged >= MAX_BACKOFF_MS) {
        log(`[BOOTSTRAP] ${organizationNotSetMessage(err.maestroUrl)}`);
        lastLogged = now();
      }
      await sleep(Math.min(MAX_BACKOFF_MS, 1000 * 2 ** n));
    }
  }
}
