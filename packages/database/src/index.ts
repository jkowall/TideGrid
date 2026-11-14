import { Kysely } from "kysely";
import { PostgresJSDialect } from "kysely-postgres-js";
import postgres from "postgres";
import type { Database } from "./types.ts";

export { type AuditEntry, recordAudit } from "./audit.ts";
export {
  type CleanupReport,
  type ConsumeOutcome,
  consumeDelivery,
  DEFAULT_LOST_AFTER_SECONDS,
  DEFAULT_MAX_PUBLISH_ATTEMPTS,
  DEFAULT_PUBLISH_BATCH_SIZE,
  type DeadLetterInput,
  type DeadLetterResult,
  type DeadLetterRow,
  type DeliveredEvent,
  type DeliveryHandler,
  DeliveryHandlerError,
  type DeliveryMessage,
  type DeliverySender,
  type DockLookupCleanupReport,
  deliveryErrorCode,
  getOpenDeadLetter,
  listDeadLetters,
  type PublishOptions,
  type PublishReport,
  parseDeliveryMessage,
  publishOutbox,
  ReplayRefusedError,
  recordDeadLetter,
  replayDeadLetter,
  runDeliveryCleanup,
  runDockLookupCleanup,
  SEND_RETRY_SECONDS,
} from "./delivery.ts";
export {
  DEFAULT_FAIR_SWEEP_MAX_PASSES,
  type FairSweepOptions,
  type FairSweepReport,
  type FairTurnResult,
  recordSweepTurn,
  runFairSweep,
} from "./fair-sweep.ts";
export {
  type ClaimResult,
  canonicalJson,
  claimIdempotencyKey,
  completeIdempotencyKey,
  type IdempotencyClaim,
  IdempotencyKeyMismatchError,
  requestHash,
} from "./idempotency.ts";
export { enqueueOutbox, type OutboxEvent } from "./outbox.ts";
export {
  inTenantTransaction,
  isUuid,
  type SnapshotRead,
  setTenantContext,
  snapshotRead,
  type TenantContext,
  type TenantTransaction,
} from "./tenant.ts";
export type * from "./types.ts";

export interface DbOptions {
  /** Maximum connections. Workers keep this small; Hyperdrive pools upstream. */
  max?: number;
}

/**
 * Create a Kysely instance over postgres.js. In a Worker, create one per
 * request and pass `end()` to `ctx.waitUntil` so connections do not leak.
 *
 * Keep postgres.js on its defaults here. `fetch_types: false` makes the Kysely
 * dialect hang on the first query (bisected 2026-09-20 and again 2026-09-23
 * against Neon), and `prepare: false` is unnecessary because Hyperdrive
 * supports prepared statements. The type fetch costs one round trip per
 * connection, not per query.
 *
 * `end()` closes postgres.js first, with a timeout, and only then destroys
 * Kysely. postgres.js `end()` without a timeout can wait forever: on a query
 * still running, and on a connection whose peer went silent. The Kysely
 * dialect's `destroy()` passes no timeout. postgres.js keeps the first
 * shutdown, so the later `destroy()` reuses it. `end()` returns within about
 * 5 s. Against a silent peer the socket can stay half-open until TCP keepalive
 * gives up. Call `end()` once the handle's work is done: a query started after
 * it may open a connection it never closes.
 */
export function createDb(connectionString: string, options: DbOptions = {}) {
  const sql = postgres(connectionString, { max: options.max ?? 5 });
  const db = new Kysely<Database>({ dialect: new PostgresJSDialect({ postgres: sql }) });
  return {
    db,
    sql,
    end: async () => {
      await sql.end({ timeout: 5 });
      await db.destroy();
    },
  };
}
