import type { Context } from "hono";
import type { AppEnv } from "../context.ts";
import { getDb } from "../db.ts";
import { allowedOrigins } from "../env.ts";
import { publicOrigin, tenantForHost, tenantForOrigin } from "../public-tenant.ts";

/**
 * Which browser origins may read an API answer (G2.14b). Origins bind to the
 * verified hostname and its tenant (the target architecture): a Host header
 * grants nothing, and CORS never grants credentials.
 *
 * - Every route: the configured ALLOWED_ORIGINS, as before.
 * - `/v1/public/*` and `/v1/fake-provider/*`, unless PUBLIC_CORS is "static"
 *   (the rollback):
 *   - `/v1/public/tenant` echoes any origin the strict parser accepts. Its 200
 *     is that same host's public brand and its 404 is one constant body, and
 *     the guest page can show "not published" (and clear its service worker)
 *     only from a 404 it can read.
 *   - any other public route echoes an origin only when it is canonical and
 *     its host resolves to an active, verified hostname. The route and this
 *     check share one lookup per request.
 *   - a preflight is answered from an in-isolate projection (below), so an
 *     OPTIONS flood costs at most one lookup per host per 30 seconds, behind a
 *     per-address limiter.
 * - Staff routes stay on STAFF_ORIGINS through their own guard.
 */
/**
 * The routes a guest page calls, each of which selects its tenant from the
 * Origin through the same resolver: the public routes, and the demo's fake
 * payment provider, which the page's pay step calls from the tenant's own
 * origin (G2.14b; the fake exists only where payments are the fake).
 */
const guestRoutePrefixes = ["/v1/public/", "/v1/fake-provider/"] as const;

export async function allowedOrigin(origin: string, c: Context<AppEnv>): Promise<string | null> {
  if (!origin) return null;
  if (allowedOrigins(c.env).includes(origin)) return origin;
  if (c.env.PUBLIC_CORS === "static") return null;
  const path = new URL(c.req.url).pathname;
  if (!guestRoutePrefixes.some((prefix) => path.startsWith(prefix))) return null;
  const parsed = publicOrigin(c);
  if (!parsed) return null;
  if (path === "/v1/public/tenant") return parsed.origin;
  if (c.req.method === "OPTIONS") {
    return (await preflightAllows(c, parsed.origin, parsed.host)) ? parsed.origin : null;
  }
  return (await tenantForOrigin(c)) ? parsed.origin : null;
}

/**
 * The preflight projection: whether a canonical origin's host resolved, kept
 * in this isolate's memory for at most 30 seconds, positive or negative, and
 * at most 1,000 origins, least recently used first out. It answers CORS
 * preflights only; tenant selection for data is never cached across requests.
 *
 * The target architecture allows a cache of a "signed, short-lived
 * projection". This one never leaves the isolate: it crosses no process,
 * network, or storage boundary, so no party could forge an entry and a
 * signature would protect nothing. A shared cache (KV, the Cache API) would
 * need the signature. The demo build plan records this reading.
 */
export const PREFLIGHT_TTL_MS = 30_000;
export const PREFLIGHT_MAX_ENTRIES = 1_000;

export class PreflightProjection {
  readonly #entries = new Map<string, { allowed: boolean; expires: number }>();

  constructor(
    readonly maxEntries = PREFLIGHT_MAX_ENTRIES,
    readonly ttlMs = PREFLIGHT_TTL_MS,
  ) {}

  get(origin: string, now: number): boolean | undefined {
    const entry = this.#entries.get(origin);
    if (!entry) return undefined;
    this.#entries.delete(origin);
    if (entry.expires <= now) return undefined;
    // Re-inserted, so iteration order is least recently used first.
    this.#entries.set(origin, entry);
    return entry.allowed;
  }

  set(origin: string, allowed: boolean, now: number): void {
    this.#entries.delete(origin);
    this.#entries.set(origin, { allowed, expires: now + this.ttlMs });
    while (this.#entries.size > this.maxEntries) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }

  get size(): number {
    return this.#entries.size;
  }

  clear(): void {
    this.#entries.clear();
  }
}

export const preflightProjection = new PreflightProjection();

async function preflightAllows(c: Context<AppEnv>, origin: string, host: string) {
  const now = Date.now();
  const cached = preflightProjection.get(origin, now);
  if (cached !== undefined) return cached;
  // A lookup the projection cannot answer is limited per client address, so
  // a flood of distinct origins cannot turn preflights into database load.
  const limiter = c.env.PUBLIC_RATE_LIMITER;
  if (limiter) {
    const ip = c.req.header("cf-connecting-ip") ?? "unknown";
    const { success } = await limiter.limit({ key: `preflight:${ip}` });
    if (!success) return false;
  }
  const allowed = (await tenantForHost(getDb(c), host)) !== null;
  preflightProjection.set(origin, allowed, now);
  return allowed;
}
