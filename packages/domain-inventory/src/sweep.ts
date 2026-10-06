import { type Database, inTenantTransaction, type TenantContext } from "@tidegrid/database";
import { type Kysely, sql } from "kysely";
import { expireDueHolds } from "./holds.ts";

export interface SweepOptions {
  /** Correlates this run's audit rows and events, like a request id. */
  runId: string;
  /** Tenants taken per run; the next run picks up the rest. */
  tenantLimit?: number;
  /** Holds expired per transaction. */
  batchSize?: number;
  /** No new batch starts after this many milliseconds. */
  budgetMs?: number;
  /** Called when one tenant's batch fails; the sweep moves on to the next tenant. */
  onTenantError?: (tenantId: string, error: unknown) => void;
  /** Milliseconds clock for the budget; tests pin it. Expiry itself uses the database clock. */
  clock?: () => number;
}

export interface SweepReport {
  /** Tenants that had due holds when the run started and that the run reached. */
  tenants: number;
  expired: number;
  failedTenants: number;
  /** False when the budget or the tenant limit cut the run short; the next run continues. */
  complete: boolean;
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
 * function that returns tenant ids only. Every hold is then read and changed
 * inside that tenant's own transaction, under row-level security, in batches.
 * Running twice, or twice at once, is safe: a hold is expired at most once, and
 * concurrent runs skip each other's locked rows.
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
  const overBudget = () => clock() - started >= budgetMs;

  const { rows } = await sql<{ tenant_id: string }>`
    select tenant_id from app.capacity_hold_sweep_tenants(${tenantLimit})`.execute(db);
  const report: SweepReport = {
    tenants: 0,
    expired: 0,
    failedTenants: 0,
    complete: rows.length < tenantLimit,
  };

  for (const { tenant_id: tenantId } of rows) {
    if (overBudget()) {
      report.complete = false;
      break;
    }
    report.tenants += 1;
    const ctx: TenantContext = {
      tenantId,
      actorType: "system",
      actorId: "hold-sweep",
      requestId: options.runId,
    };
    try {
      for (;;) {
        const { expired } = await inTenantTransaction(db, ctx, (trx) =>
          expireDueHolds(trx, ctx, { limit: batchSize }),
        );
        report.expired += expired.length;
        if (expired.length < batchSize) break;
        if (overBudget()) {
          report.complete = false;
          break;
        }
      }
    } catch (error) {
      report.failedTenants += 1;
      report.complete = false;
      options.onTenantError?.(tenantId, error);
    }
  }
  return report;
}
