import {
  type Database,
  inTenantTransaction,
  recordSweepTurn,
  runFairSweep,
  type TenantContext,
} from "@tidegrid/database";
import { type Kysely, sql } from "kysely";
import { expireDueHolds } from "./holds.ts";

export interface SweepOptions {
  /** Correlates this run's audit rows and events, like a request id. */
  runId: string;
  /** Tenants taken per run; the next run picks up the rest. */
  tenantLimit?: number;
  /** Holds expired per transaction: one tenant's turn. */
  batchSize?: number;
  /** No new batch starts after this many milliseconds. */
  budgetMs?: number;
  /** Called when one tenant's batch fails; the sweep moves on to the next tenant. */
  onTenantError?: (tenantId: string, error: unknown) => void;
  /**
   * Called when a turn's stamp fails; the turn still runs. Without it,
   * onTenantError hears the failure, so it is never silent. Either way it is
   * counted in stampFailures, not in failedTenants. The API Worker's cron
   * passes only onTenantError until Part E of the hardening goal wires this,
   * so until then a stamp failure logs as hold_sweep_tenant_failed while
   * failed_tenant_count stays 0.
   */
  onStampError?: (tenantId: string, error: unknown) => void;
  /** Milliseconds clock for the budget; tests pin it. Expiry itself uses the database clock. */
  clock?: () => number;
  /** Called as each turn (one batch for one tenant) starts, for tests and logs. */
  onTurnStart?: (tenantId: string, pass: number) => void;
}

export interface SweepReport {
  /** Tenants that had due holds when the run started and that the run reached. */
  tenants: number;
  expired: number;
  failedTenants: number;
  /** False when the budget or the tenant limit cut the run short; the next run continues. */
  complete: boolean;
  /** Batches started, one tenant's turn each. */
  turns: number;
  /** Passes over the tenants: the first gives each one batch, later ones go round those with more. */
  passes: number;
  /** Tenants listed that the budget left for the next run. */
  deferredTenants: number;
  /** Tenants whose stamp failed; each still took its turn. */
  stampFailures: number;
}

export const DEFAULT_SWEEP_TENANT_LIMIT = 100;
export const DEFAULT_SWEEP_BATCH_SIZE = 100;
export const DEFAULT_SWEEP_BUDGET_MS = 20_000;

/**
 * Expire due holds across tenants, for the API Worker's cron. Correctness
 * never waits for this: acquisition and availability already treat a hold
 * past its instant as gone. The sweep writes that down, with the audit row and
 * the inventory.hold.expired event, so other modules hear about it.
 *
 * The tenant list comes from app.capacity_hold_sweep_tenants, a definer
 * function that returns tenant ids only, least recently served first (0013).
 * Every hold is then read and changed inside that tenant's own transaction,
 * under row-level security, one batch per turn. The first pass gives each
 * listed tenant one batch; later passes go round the tenants whose last batch
 * was full, until the budget runs out (`runFairSweep`). Running twice, or twice
 * at once, is safe: a hold is expired at most once, and concurrent runs skip
 * each other's locked rows.
 */
export async function sweepExpiredHolds(
  db: Kysely<Database>,
  options: SweepOptions,
): Promise<SweepReport> {
  const clock = options.clock ?? Date.now;
  const started = clock();
  const budgetMs = options.budgetMs ?? DEFAULT_SWEEP_BUDGET_MS;
  const tenantLimit = options.tenantLimit ?? DEFAULT_SWEEP_TENANT_LIMIT;
  const batchSize = options.batchSize ?? DEFAULT_SWEEP_BATCH_SIZE;
  const contextOf = (tenantId: string): TenantContext => ({
    tenantId,
    actorType: "system",
    actorId: "hold-sweep",
    requestId: options.runId,
  });

  let expired = 0;
  const fair = await runFairSweep({
    listTenants: async () => {
      const { rows } = await sql<{ tenant_id: string }>`
        select tenant_id from app.capacity_hold_sweep_tenants(${tenantLimit})`.execute(db);
      return rows.map((r) => r.tenant_id);
    },
    tenantLimit,
    stamp: (tenantId) => recordSweepTurn(db, contextOf(tenantId), "hold"),
    turn: async (tenantId) => {
      const ctx = contextOf(tenantId);
      const batch = await inTenantTransaction(db, ctx, (trx) =>
        expireDueHolds(trx, ctx, { limit: batchSize }),
      );
      expired += batch.expired.length;
      return { units: batch.expired.length, more: batch.expired.length >= batchSize };
    },
    budgetMs,
    clock,
    startedAt: started,
    ...(options.onTurnStart ? { onTurnStart: options.onTurnStart } : {}),
    onTenantError: (tenantId, error, during) => {
      if (during === "stamp" && options.onStampError) options.onStampError(tenantId, error);
      else options.onTenantError?.(tenantId, error);
    },
  });
  return {
    tenants: fair.tenants,
    expired,
    failedTenants: fair.failedTenants,
    complete: fair.complete,
    turns: fair.turns,
    passes: fair.passes,
    deferredTenants: fair.deferredTenants,
    stampFailures: fair.stampFailures,
  };
}
