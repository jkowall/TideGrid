/**
 * The checkout sweep (G2.7), run by the API Worker's cron after the hold
 * sweep. Correctness never waits for it: a guest sees an open checkout past its
 * instant as expired at once, the hold stops counting at its instant, and a
 * late success reacquires or is refunded whether or not the sweep has run. The
 * sweep writes those facts down and finishes work an interrupted request left:
 *
 * 1. open checkouts past their instant expire, with their holds, idempotently;
 * 2. inbox events received at least the grace period ago and never processed
 *    (the request that recorded them failed) are processed;
 * 3. refunds requested at least the grace period ago and never settled (the
 *    provider did not answer, or the Worker stopped) are sent again with their
 *    keys.
 *
 * The tenant list comes from app.checkout_sweep_tenants, which returns tenant
 * ids only; every read and write then runs in that tenant's own transaction.
 *
 * The expiry never waits on a lock. It takes checkouts and their holds with
 * SKIP LOCKED and leaves a busy one for the next run: acquisition and late
 * confirmation lock a trip and then expire its due holds in their own order,
 * and a sweep that waited for one hold while holding another could deadlock
 * with them. Processing an event or a refund takes the same locks, in the same
 * order, as the webhook that would have done it. One event or refund that
 * keeps failing is reported and skipped, so it never blocks the rest of its
 * tenant's work.
 */
import {
  type Database,
  inTenantTransaction,
  type TenantContext,
  type TenantTransaction,
} from "@tidegrid/database";
import { expireHold } from "@tidegrid/domain-inventory";
import type { PaymentProvider } from "@tidegrid/domain-payments";
import { type Kysely, sql } from "kysely";
import { ownerRefFor } from "./checkout.ts";
import { processProviderEvent, settleRefund } from "./finalize.ts";
import { record } from "./views.ts";

export type CheckoutSweepItem = "checkouts" | "inbox_event" | "refund";

export interface CheckoutSweepOptions {
  /** Correlates this run's audit rows and events, like a request id. */
  runId: string;
  /** Sends requested refunds; without one, refunds wait for a run that has it. */
  provider?: PaymentProvider | null;
  tenantLimit?: number;
  batchSize?: number;
  /** Inbox events and refunds younger than this (0 to 3,600 seconds) are left to the request that made them. */
  graceSeconds?: number;
  budgetMs?: number;
  /** One tenant's step failed; the sweep moves on. `id` names the event or refund. */
  onError?: (tenantId: string, item: CheckoutSweepItem, error: unknown, id?: string) => void;
  clock?: () => number;
}

export interface CheckoutSweepReport {
  tenants: number;
  expired: number;
  /** Checkouts left open because another transaction held them or their holds. */
  skipped: number;
  reprocessed: number;
  refundsSettled: number;
  /** Refunds still requested after this run: no provider, no answer, or out of budget. */
  refundsPending: number;
  /** Tenants whose expiry step failed. */
  failedTenants: number;
  failedEvents: number;
  failedRefunds: number;
  complete: boolean;
}

export const DEFAULT_CHECKOUT_SWEEP_BATCH = 100;
export const DEFAULT_CHECKOUT_SWEEP_GRACE_SECONDS = 60;

/**
 * Expire up to `limit` of this tenant's open checkouts past their instant,
 * oldest first: each hold is marked expired, then the checkout. Never waits:
 * a checkout or a hold another transaction holds is skipped and reported, as
 * is a checkout whose hold is not yet due (only possible when someone moved
 * one expiry and not the other).
 */
export async function expireCheckoutSessions(
  trx: TenantTransaction,
  ctx: TenantContext,
  options: { limit: number },
): Promise<{ expired: string[]; skipped: string[] }> {
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 1000) {
    throw new RangeError("limit must be a whole number from 1 to 1000");
  }
  const { rows } = await sql<{ id: string; hold_id: string }>`
    select id, hold_id from checkout_sessions
     where tenant_id = ${ctx.tenantId} and state = 'open' and expires_at <= now()
     order by expires_at, id
     limit ${options.limit}
       for update skip locked`.execute(trx);
  const expired: string[] = [];
  const skipped: string[] = [];
  for (const session of rows) {
    const hold = await expireHold(trx, ctx, {
      holdId: session.hold_id,
      ownerRef: ownerRefFor(session.id),
    });
    if (hold.kind === "busy" || hold.kind === "not_due") {
      skipped.push(session.id);
      continue;
    }
    if (hold.kind === "not_found") throw new Error(`open checkout ${session.id} has no hold`);
    if (hold.hold.state !== "expired") {
      throw new Error(`open checkout ${session.id} has a ${hold.hold.state} hold`);
    }
    await trx
      .updateTable("checkout_sessions")
      .set({ state: "expired" })
      .where("tenant_id", "=", ctx.tenantId)
      .where("id", "=", session.id)
      .where("state", "=", "open")
      .execute();
    await record(trx, ctx, {
      action: "checkout.session_expired",
      subjectType: "checkout_session",
      subjectId: session.id,
      before: { state: "open" },
      after: { state: "expired" },
      topic: "checkout.session.expired",
      payload: { checkoutSessionId: session.id },
    });
    expired.push(session.id);
  }
  return { expired, skipped };
}

function graceOf(seconds: number | undefined): number {
  const grace = seconds ?? DEFAULT_CHECKOUT_SWEEP_GRACE_SECONDS;
  if (!Number.isInteger(grace) || grace < 0 || grace > 3600) {
    throw new RangeError("graceSeconds must be a whole number from 0 to 3600");
  }
  return grace;
}

export async function sweepCheckouts(
  db: Kysely<Database>,
  options: CheckoutSweepOptions,
): Promise<CheckoutSweepReport> {
  const clock = options.clock ?? Date.now;
  const started = clock();
  const budgetMs = options.budgetMs ?? 20_000;
  const tenantLimit = options.tenantLimit ?? 100;
  const batchSize = options.batchSize ?? DEFAULT_CHECKOUT_SWEEP_BATCH;
  const grace = graceOf(options.graceSeconds);
  const overBudget = () => clock() - started >= budgetMs;

  const { rows } = await sql<{ tenant_id: string }>`
    select tenant_id from app.checkout_sweep_tenants(${tenantLimit}, ${grace})`.execute(db);
  const report: CheckoutSweepReport = {
    tenants: 0,
    expired: 0,
    skipped: 0,
    reprocessed: 0,
    refundsSettled: 0,
    refundsPending: 0,
    failedTenants: 0,
    failedEvents: 0,
    failedRefunds: 0,
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
      actorId: "checkout-sweep",
      requestId: options.runId,
    };

    // 1. Expiry, in batches. Each batch either expires something or ends the
    // loop, so skipped checkouts cannot keep it turning.
    try {
      for (;;) {
        const { expired, skipped } = await inTenantTransaction(db, ctx, (trx) =>
          expireCheckoutSessions(trx, ctx, { limit: batchSize }),
        );
        report.expired += expired.length;
        report.skipped += skipped.length;
        if (expired.length === 0 || expired.length + skipped.length < batchSize) break;
        if (overBudget()) {
          report.complete = false;
          break;
        }
      }
    } catch (error) {
      report.failedTenants += 1;
      report.complete = false;
      options.onError?.(tenantId, "checkouts", error);
    }

    // 2. Inbox events a failed request left unprocessed, one transaction each.
    const refundIds: string[] = [];
    let pending: string[] = [];
    try {
      pending = await inTenantTransaction(db, ctx, async (trx) => {
        const { rows: events } = await sql<{ id: string }>`
          select id from provider_events
           where tenant_id = ${tenantId} and processing_state = 'received'
             and verified_at <= now() - make_interval(secs => ${grace})
           order by verified_at, id
           limit ${batchSize}`.execute(trx);
        return events.map((e) => e.id);
      });
    } catch (error) {
      report.failedEvents += 1;
      report.complete = false;
      options.onError?.(tenantId, "inbox_event", error);
    }
    for (const inboxId of pending) {
      if (overBudget()) {
        report.complete = false;
        break;
      }
      try {
        const processed = await inTenantTransaction(db, ctx, (trx) =>
          processProviderEvent(trx, ctx, inboxId, { skipLocked: true }),
        );
        if (!processed) continue;
        report.reprocessed += 1;
        if (processed.refundId) refundIds.push(processed.refundId);
      } catch (error) {
        report.failedEvents += 1;
        report.complete = false;
        options.onError?.(tenantId, "inbox_event", error, inboxId);
      }
    }

    // 3. Refunds whose outcome is unknown, sent again with their own keys.
    let requested: string[] = [];
    try {
      requested = await inTenantTransaction(db, ctx, async (trx) => {
        const { rows: refunds } = await sql<{ id: string }>`
          select id from payment_refunds
           where tenant_id = ${tenantId} and state = 'requested'
             and created_at <= now() - make_interval(secs => ${grace})
           order by created_at, id
           limit ${batchSize}`.execute(trx);
        return refunds.map((r) => r.id);
      });
    } catch (error) {
      report.failedRefunds += 1;
      report.complete = false;
      options.onError?.(tenantId, "refund", error);
    }
    for (const refundId of [...new Set([...refundIds, ...requested])]) {
      if (!options.provider || overBudget()) {
        report.refundsPending += 1;
        continue;
      }
      try {
        const settled = await settleRefund(db, options.provider, ctx, refundId);
        if (settled.kind === "succeeded" || settled.kind === "failed") report.refundsSettled += 1;
        else if (settled.kind === "unknown") report.refundsPending += 1;
      } catch (error) {
        report.failedRefunds += 1;
        report.refundsPending += 1;
        options.onError?.(tenantId, "refund", error, refundId);
      }
    }
  }
  return report;
}
