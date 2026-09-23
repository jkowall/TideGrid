import { type Kysely, sql, type Transaction } from "kysely";
import type { ActorType, Database } from "./types.ts";

/**
 * Tenant context for one database transaction. Every read or write of a
 * tenant-owned table happens inside `inTenantTransaction`. Outside it, forced
 * row-level security returns no rows and rejects every write.
 */
export interface TenantContext {
  tenantId: string;
  actorType: ActorType;
  /** Staff user id, guest credential id, or a system job name. */
  actorId?: string | null;
  requestId?: string | null;
  sourceIp?: string | null;
}

export type TenantTransaction = Transaction<Database>;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && uuidPattern.test(value);
}

const actorTypes: readonly ActorType[] = ["staff", "guest", "system", "support"];

/**
 * Set transaction-local context. `set_config(..., true)` is `SET LOCAL`: it
 * reverts at commit or rollback, so a pooled connection (Hyperdrive) never
 * carries one request's tenant into the next.
 */
export async function setTenantContext(trx: TenantTransaction, ctx: TenantContext): Promise<void> {
  if (!isUuid(ctx.tenantId)) {
    throw new TypeError("tenant context requires a lowercase UUID tenant id");
  }
  if (!actorTypes.includes(ctx.actorType)) {
    throw new TypeError(`unknown actor type ${String(ctx.actorType)}`);
  }
  await sql`
    select
      set_config('app.tenant_id', ${ctx.tenantId}, true),
      set_config('app.actor_type', ${ctx.actorType}, true),
      set_config('app.actor_id', ${ctx.actorId ?? ""}, true),
      set_config('app.request_id', ${ctx.requestId ?? ""}, true),
      set_config('app.source_ip', ${ctx.sourceIp ?? ""}, true)
  `.execute(trx);
}

/**
 * Run `fn` in one transaction bound to one tenant. The transaction commits
 * when `fn` resolves and rolls back when it throws.
 */
export function inTenantTransaction<T>(
  db: Kysely<Database>,
  ctx: TenantContext,
  fn: (trx: TenantTransaction) => Promise<T>,
): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await setTenantContext(trx, ctx);
    return fn(trx);
  });
}
