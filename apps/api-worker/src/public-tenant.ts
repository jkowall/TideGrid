import {
  claimIdempotencyKey,
  completeIdempotencyKey,
  IdempotencyKeyMismatchError,
  inTenantTransaction,
  type JsonObject,
  requestHash,
  type TenantContext,
  type TenantTransaction,
} from "@tidegrid/database";
import { normalizeHostname } from "@tidegrid/domain-identity";
import type { Context } from "hono";
import { sql } from "kysely";
import type { AppEnv } from "./context.ts";
import { getDb } from "./db.ts";
import { ApiError } from "./errors.ts";

/**
 * Guests are anonymous until checkout issues scoped credentials, so every
 * guest of one tenant shares this idempotency principal. Keys are random,
 * client-generated, and scoped by tenant and operation, and a quote holds no
 * personal data, so a guessed key could only replay a price.
 */
export const GUEST_PRINCIPAL = "guest:public";

const notPublished = () =>
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

/**
 * The tenant the browser Origin resolves to: an active, verified hostname of
 * an active tenant, as /v1/public/trips does. Anything else answers the same
 * 404. Opens no transaction.
 */
export async function resolvePublicTenant(c: Context<AppEnv>): Promise<string> {
  const host = normalizeHostname(c.req.header("origin"));
  if (!host) throw notPublished();
  const { rows } = await sql<{ tenant_id: string }>`
    select tenant_id from app.resolve_hostname(${host})
  `.execute(getDb(c));
  const tenantId = rows[0]?.tenant_id;
  if (!tenantId) throw notPublished();
  return tenantId;
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
