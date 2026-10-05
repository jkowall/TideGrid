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
 * Run a guest request for the tenant the browser Origin resolves to: an
 * active, verified hostname of an active tenant, as /v1/public/trips does.
 * Anything else answers the same 404. The work runs in one tenant
 * transaction with a guest context; a command claims its idempotency key
 * first and stores its response before commit, and any thrown error rolls
 * everything back.
 */
export async function withPublicTenant<T extends JsonObject>(
  c: Context<AppEnv>,
  options: { idempotency?: PublicCommand },
  run: (trx: TenantTransaction, ctx: TenantContext) => Promise<T>,
): Promise<{ body: T; status: number; replayed: boolean }> {
  const host = normalizeHostname(c.req.header("origin"));
  if (!host) throw notPublished();
  const db = getDb(c);
  const { rows } = await sql<{ tenant_id: string }>`
    select tenant_id from app.resolve_hostname(${host})
  `.execute(db);
  const tenantId = rows[0]?.tenant_id;
  if (!tenantId) throw notPublished();
  const ctx: TenantContext = {
    tenantId,
    actorType: "guest",
    actorId: null,
    requestId: c.get("requestId"),
    sourceIp: c.req.header("cf-connecting-ip") ?? null,
  };
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
          return { body: claimed.body as T, status: claimed.status, replayed: true };
        }
      }
      const body = await run(trx, ctx);
      if (claim && idem) {
        await completeIdempotencyKey(trx, ctx, claim, { status: idem.successStatus, body });
      }
      return { body, status: idem?.successStatus ?? 200, replayed: false };
    });
  } catch (err) {
    if (err instanceof IdempotencyKeyMismatchError) {
      throw new ApiError(422, "idempotency_key_reused", err.message);
    }
    throw err;
  }
}
