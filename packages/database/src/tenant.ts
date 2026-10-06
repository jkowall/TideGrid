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
  // A session-level set_config would survive on a pooled connection and follow
  // it into the next request. Nothing in this codebase does that; refuse to run
  // if something ever has.
  const leaked = await sql<{ tenant: string | null }>`
    select nullif(current_setting('app.tenant_id', true), '') as tenant
  `.execute(trx);
  if (leaked.rows[0]?.tenant) {
    throw new Error("tenant context is already set on this connection; refusing to reuse it");
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
 * How a read that must see one moment runs (G2.12b): every statement in the
 * transaction reads the same snapshot, and the transaction refuses writes. A
 * page and the counts beside it then always agree. The default, READ
 * COMMITTED, is what every command needs.
 */
export interface SnapshotRead {
  isolation: "repeatable read";
  readOnly: true;
}

export const snapshotRead: SnapshotRead = { isolation: "repeatable read", readOnly: true };

/**
 * Run `fn` in one transaction bound to one tenant. The transaction commits
 * when `fn` resolves and rolls back when it throws. With `options`, it is a
 * read-only snapshot (see SnapshotRead); the isolation level is set before the
 * tenant context, since PostgreSQL fixes it at the first statement.
 */
export function inTenantTransaction<T>(
  db: Kysely<Database>,
  ctx: TenantContext,
  fn: (trx: TenantTransaction) => Promise<T>,
  options?: SnapshotRead,
): Promise<T> {
  const builder = options
    ? db.transaction().setIsolationLevel(options.isolation).setAccessMode("read only")
    : db.transaction();
  return builder.execute(async (trx) => {
    await setTenantContext(trx, ctx);
    return fn(trx);
  });
}
