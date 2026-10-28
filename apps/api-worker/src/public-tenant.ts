import { BrandConfig, brandSchemaVersion, PublicExperienceResponse } from "@tidegrid/contracts";
import {
  claimIdempotencyKey,
  completeIdempotencyKey,
  type Database,
  IdempotencyKeyMismatchError,
  inTenantTransaction,
  type JsonObject,
  requestHash,
  type TenantContext,
  type TenantTransaction,
} from "@tidegrid/database";
import { type HostPolicy, type ParsedOrigin, parseBrowserOrigin } from "@tidegrid/domain-hostnames";
import type { Context } from "hono";
import { type Kysely, sql } from "kysely";
import type { AppEnv } from "./context.ts";
import { getDb } from "./db.ts";
import type { Bindings } from "./env.ts";
import { ApiError } from "./errors.ts";

/**
 * Guests are anonymous until checkout issues scoped credentials, so every
 * guest of one tenant shares this idempotency principal. Keys are random,
 * client-generated, and scoped by tenant and operation, and a quote holds no
 * personal data, so a guessed key could only replay a price.
 */
export const GUEST_PRINCIPAL = "guest:public";

/** Every miss, whatever its cause, answers this same 404. */
export const notPublished = () =>
  new ApiError(404, "tenant_not_found", "No operator is published at this address");

/**
 * Public commands write rows for anyone a published origin lets through, and
 * an Origin header is not authentication, so each client address may send
 * only so many to one operator per minute. Checked before the transaction
 * opens, so a limited request writes nothing. A no-op where the binding is
 * absent, as the sign-in limiter is.
 */
export async function limitPublicCommand(c: Context<AppEnv>, tenantId: string): Promise<void> {
  const limiter = c.env.PUBLIC_RATE_LIMITER;
  if (!limiter) return;
  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  const { success } = await limiter.limit({ key: `${tenantId}:${ip}` });
  if (!success) throw new ApiError(429, "rate_limited", "Too many requests; wait a minute");
}

export interface PublicCommand {
  /** Operation name, for example `public.quotes.create`. */
  scope: string;
  key: string;
  /** Route template, so the same body on another route never matches. */
  route: string;
  params?: Record<string, string>;
  body: unknown;
  successStatus: number;
}

/** The host rules for this deployment: local development may use http, ports, and *.localhost. */
export function hostPolicy(env: Bindings): HostPolicy {
  return { environment: env.ENVIRONMENT };
}

/**
 * The calling page's origin under the strict origin parser (G2.14b), or null.
 * Only the Origin header is read: never Host, X-Forwarded-Host, or Referer.
 */
export function publicOrigin(c: Context<AppEnv>): ParsedOrigin | null {
  return parseBrowserOrigin(c.req.header("origin"), hostPolicy(c.env));
}

/** One lookup per request, shared by the CORS check and the route. */
const resolutions = new WeakMap<Request, Promise<string | null>>();

/** The tenant an active, verified hostname maps to, or null. */
export async function tenantForHost(db: Kysely<Database>, host: string): Promise<string | null> {
  const { rows } = await sql<{ tenant_id: string }>`
    select tenant_id from app.resolve_hostname(${host})
  `.execute(db);
  return rows[0]?.tenant_id ?? null;
}

/**
 * The tenant this request's Origin resolves to, or null, looked up at most
 * once per request: the CORS middleware and the route share the answer, so
 * they always agree. A non-canonical origin never reaches the database.
 */
export function tenantForOrigin(c: Context<AppEnv>): Promise<string | null> {
  const key = c.req.raw;
  let resolution = resolutions.get(key);
  if (!resolution) {
    const parsed = publicOrigin(c);
    resolution = parsed ? tenantForHost(getDb(c), parsed.host) : Promise.resolve(null);
    resolutions.set(key, resolution);
  }
  return resolution;
}

/**
 * The tenant the browser Origin resolves to: an active, verified hostname of
 * an active tenant. Anything else, a non-canonical origin included, answers
 * the same 404. Opens no transaction.
 */
export async function resolvePublicTenant(c: Context<AppEnv>): Promise<string> {
  const tenantId = await tenantForOrigin(c);
  if (!tenantId) throw notPublished();
  return tenantId;
}

interface ResolvedBrandRow {
  tenant_id: string;
  tenant_slug: string;
  tenant_name: string;
  brand_version: number | null;
  brand_schema_version: number | null;
  brand_config: unknown;
}

export type PublicExperience =
  | { kind: "found"; tenantId: string; experience: PublicExperienceResponse }
  | { kind: "miss" }
  /** The stored identity or brand failed validation and is withheld. */
  | { kind: "withheld"; tenantId: string; version: number | null; reason: string };

/**
 * The public experience for a normalized hostname: the tenant's identity and
 * its active brand, validated on the way out as well as on the way in. The
 * stored config must pass the stored shape exactly (a config that names its
 * own version, or carries any other extra field, fails), and the whole answer
 * must pass the public contract, identity included. The bootstrap route and
 * the guest Worker's gateway both read it here.
 */
export async function loadPublicExperience(
  db: Kysely<Database>,
  host: string,
): Promise<PublicExperience> {
  const { rows } = await sql<ResolvedBrandRow>`
    select tenant_id, tenant_slug, tenant_name, brand_version, brand_schema_version, brand_config
      from app.resolve_public_brand(${host})
  `.execute(db);
  const row = rows[0];
  if (!row) return { kind: "miss" };
  const withheld = (reason: string): PublicExperience => ({
    kind: "withheld",
    tenantId: row.tenant_id,
    version: row.brand_version,
    reason,
  });
  let body: unknown = { tenant: { slug: row.tenant_slug, name: row.tenant_name } };
  if (row.brand_version !== null) {
    if (row.brand_schema_version !== brandSchemaVersion)
      return withheld("BrandSchemaVersionUnknown");
    const stored = BrandConfig.safeParse(row.brand_config);
    if (!stored.success) return withheld("BrandConfigInvalid");
    body = {
      tenant: { slug: row.tenant_slug, name: row.tenant_name },
      brand: { ...stored.data, version: row.brand_version },
    };
  }
  const response = PublicExperienceResponse.safeParse(body);
  if (!response.success) return withheld("PublicExperienceInvalid");
  return { kind: "found", tenantId: row.tenant_id, experience: response.data };
}

/** A guest's context in the tenant the Origin resolved to. */
export function guestContext(c: Context<AppEnv>, tenantId: string): TenantContext {
  return {
    tenantId,
    actorType: "guest",
    actorId: null,
    requestId: c.get("requestId"),
    sourceIp: c.req.header("cf-connecting-ip") ?? null,
  };
}

/**
 * Run a guest request for the tenant the browser Origin resolves to (see
 * resolvePublicTenant). The work runs in one tenant transaction with a guest
 * context. A command, idempotent or `limit`ed, is rate limited per client
 * address and tenant; an idempotent one claims its key first and stores its
 * response before commit; any thrown error rolls everything back. Reads are
 * not limited. The guest context is returned for work after commit.
 */
export async function withPublicTenant<T extends JsonObject>(
  c: Context<AppEnv>,
  options: { idempotency?: PublicCommand; limit?: boolean },
  run: (trx: TenantTransaction, ctx: TenantContext) => Promise<T>,
): Promise<{ body: T; status: number; replayed: boolean; ctx: TenantContext }> {
  const tenantId = await resolvePublicTenant(c);
  const db = getDb(c);
  if (options.idempotency || options.limit) await limitPublicCommand(c, tenantId);
  const ctx = guestContext(c, tenantId);
  const idem = options.idempotency;
  const claim = idem
    ? {
        scope: idem.scope,
        principal: GUEST_PRINCIPAL,
        key: idem.key,
        requestHash: await requestHash({
          method: c.req.method,
          route: idem.route,
          params: { ...idem.params, tenantId },
          body: idem.body,
        }),
      }
    : null;
  try {
    return await inTenantTransaction(db, ctx, async (trx) => {
      if (claim) {
        const claimed = await claimIdempotencyKey(trx, ctx, claim);
        if (claimed.kind === "replay") {
          return { body: claimed.body as T, status: claimed.status, replayed: true, ctx };
        }
      }
      const body = await run(trx, ctx);
      if (claim && idem) {
        await completeIdempotencyKey(trx, ctx, claim, { status: idem.successStatus, body });
      }
      return { body, status: idem?.successStatus ?? 200, replayed: false, ctx };
    });
  } catch (err) {
    if (err instanceof IdempotencyKeyMismatchError) {
      throw new ApiError(422, "idempotency_key_reused", err.message);
    }
    throw err;
  }
}
