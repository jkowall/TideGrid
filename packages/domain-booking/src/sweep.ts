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
 * ids only, least recently served first (0013); every read and write then runs
 * in that tenant's own transaction. Tenants take fair turns (`runFairSweep`):
 * the first pass gives each listed tenant one quantum of each step, and later
 * passes continue only the steps that said there is more, round the tenants,
 * until the budget runs out. One tenant's backlog can no longer spend the
 * whole run.
 *
 * The expiry never waits on a lock. It takes checkouts and their holds with
 * SKIP LOCKED and leaves a busy one for the next run: acquisition and late
 * confirmation lock a trip and then expire its due holds in their own order,
 * and a sweep that waited for one hold while holding another could deadlock
 * with them. Processing an event or a refund takes the same locks, in the same
 * order, as the webhook that would have done it. One event or refund that
 * keeps failing is reported and skipped, so it never blocks the rest of its
 * tenant's work; so is an open checkout whose hold is in a state an open
 * checkout cannot have. Within a run each checkout, event, and refund is
 * reported once, and each event and refund is attempted at most once.
 */
import {
  type Database,
  type HoldState,
  inTenantTransaction,
  recordSweepTurn,
  runFairSweep,
  type TenantContext,
  type TenantTransaction,
} from "@tidegrid/database";
import { expireHold } from "@tidegrid/domain-inventory";
import type { PaymentProvider } from "@tidegrid/domain-payments";
import { type Kysely, sql } from "kysely";
import { ownerRefFor } from "./checkout.ts";
import { processProviderEvent, type SettleRefundResult, settleRefund } from "./finalize.ts";
import type { BookingHooks } from "./hooks.ts";
import { record } from "./views.ts";

/** What failed: a step, one item in it, or the stamp that keeps the tenant's place. */
export type CheckoutSweepItem = "checkouts" | "inbox_event" | "refund" | "stamp";

export interface CheckoutSweepOptions {
  /** Correlates this run's audit rows and events, like a request id. */
  runId: string;
  /** Sends requested refunds; without one, refunds wait for a run that has it. */
  provider?: PaymentProvider | null;
  /** Run inside a booking's confirmation when a reprocessed event confirms one (lane 1 contract). */
  hooks?: BookingHooks | undefined;
  tenantLimit?: number;
  /** Checkouts expired per batch, and the window of events and refunds read at a time. */
  batchSize?: number;
  /** Inbox events and refunds attempted per step in one turn. Default 10. */
  turnItems?: number;
  /** Inbox events and refunds younger than this (0 to 3,600 seconds) are left to the request that made them. */
  graceSeconds?: number;
  budgetMs?: number;
  /**
   * One tenant's step failed, or one item in it could not be done, or its
   * turn's stamp failed; the sweep moves on. `id` names the checkout, event,
   * or refund.
   */
  onError?: (tenantId: string, item: CheckoutSweepItem, error: unknown, id?: string) => void;
  clock?: () => number;
  /** Called as each tenant's turn starts, for tests and logs. */
  onTurnStart?: (tenantId: string, pass: number) => void;
}

export interface CheckoutSweepReport {
  tenants: number;
  expired: number;
  /**
   * Checkouts left open because another transaction held them or their holds,
   * or because their hold is in a state an open checkout cannot have (each of
   * those is also reported through onError). Each is counted once a run.
   */
  skipped: number;
  reprocessed: number;
  refundsSettled: number;
  /**
   * Refunds this run read or was handed that are still requested after it: no
   * provider, no answer, a failed attempt, or out of budget. Each once.
   */
  refundsPending: number;
  /** Tenants whose expiry step failed. */
  failedTenants: number;
  failedEvents: number;
  failedRefunds: number;
  complete: boolean;
  /** Tenant turns started. */
  turns: number;
  /** Passes over the tenants: the first gives each a quantum, later ones go round those with more. */
  passes: number;
  /** Tenants listed that the budget left for the next run. */
  deferredTenants: number;
}

export const DEFAULT_CHECKOUT_SWEEP_BATCH = 100;
export const DEFAULT_CHECKOUT_SWEEP_GRACE_SECONDS = 60;
export const DEFAULT_CHECKOUT_SWEEP_TURN_ITEMS = 10;

/**
 * An open checkout the sweep cannot expire because of its hold: missing or
 * not the checkout's own (null), released, or confirmed. The database refuses
 * all three at commit (the hold's foreign key and owner, and
 * capacity_holds_checkout), so one can only come from a writer that bypassed
 * a trigger. An operator must look at it; the sweep reports it every run and
 * leaves it as it is.
 */
export interface InconsistentCheckout {
  id: string;
  holdState: HoldState | null;
}

/** Raised through onError for each inconsistent checkout; carries ids only. */
export class InconsistentCheckoutError extends Error {
  constructor(readonly checkout: InconsistentCheckout) {
    super(
      `open checkout ${checkout.id} has ${checkout.holdState ? `a ${checkout.holdState}` : "no"} hold`,
    );
    this.name = "InconsistentCheckoutError";
  }
}

export interface ExpireCheckoutsResult {
  expired: string[];
  /** Left open: busy, not yet due, or inconsistent. */
  skipped: string[];
  /** The skipped checkouts whose hold an open checkout cannot have. */
  inconsistent: InconsistentCheckout[];
}

/**
 * Expire up to `limit` of this tenant's open checkouts past their instant,
 * oldest first: each hold is marked expired, then the checkout. Never waits:
 * a checkout or a hold another transaction holds is skipped and reported, as
 * is a checkout whose hold is not yet due (only possible when someone moved
 * one expiry and not the other). A checkout whose hold is missing, released,
 * or confirmed is skipped too, and listed as inconsistent, so one impossible
 * row cannot fail the whole batch, and with it every run.
 */
export async function expireCheckoutSessions(
  trx: TenantTransaction,
  ctx: TenantContext,
  options: { limit: number },
): Promise<ExpireCheckoutsResult> {
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
  const inconsistent: InconsistentCheckout[] = [];
  for (const session of rows) {
    const hold = await expireHold(trx, ctx, {
      holdId: session.hold_id,
      ownerRef: ownerRefFor(session.id),
    });
    if (hold.kind === "busy" || hold.kind === "not_due") {
      skipped.push(session.id);
      continue;
    }
    const holdState = hold.kind === "not_found" ? null : hold.hold.state;
    if (holdState !== "expired") {
      skipped.push(session.id);
      inconsistent.push({ id: session.id, holdState });
      continue;
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
  return { expired, skipped, inconsistent };
}

function graceOf(seconds: number | undefined): number {
  const grace = seconds ?? DEFAULT_CHECKOUT_SWEEP_GRACE_SECONDS;
  if (!Number.isInteger(grace) || grace < 0 || grace > 3600) {
    throw new RangeError("graceSeconds must be a whole number from 0 to 3600");
  }
  return grace;
}

/** One window of a tenant's waiting events or refunds, oldest first, leaving out this run's attempts. */
export interface WindowQuery {
  limit: number;
  graceSeconds: number;
  excluding: readonly string[];
}

/**
 * What the checkout sweep reads and writes, so its turns can be tested without
 * a database. `sweepCheckouts` supplies the real one; each call runs in a
 * tenant transaction of its own, except `settleRefund`, which calls the
 * provider between two.
 */
export interface CheckoutSweepStore {
  listTenants(limit: number, graceSeconds: number): Promise<readonly string[]>;
  stamp(ctx: TenantContext): Promise<void>;
  expire(ctx: TenantContext, limit: number): Promise<ExpireCheckoutsResult>;
  receivedEvents(ctx: TenantContext, query: WindowQuery): Promise<string[]>;
  processEvent(ctx: TenantContext, inboxId: string): Promise<{ refundId: string | null } | null>;
  requestedRefunds(ctx: TenantContext, query: WindowQuery): Promise<string[]>;
  /** Null without a provider: refunds are then read once and left requested. */
  settleRefund: ((ctx: TenantContext, refundId: string) => Promise<SettleRefundResult>) | null;
}

/** The store `sweepCheckouts` uses, over the database as the runtime role. */
export function checkoutSweepStore(
  db: Kysely<Database>,
  provider: PaymentProvider | null,
  hooks: BookingHooks | undefined,
): CheckoutSweepStore {
  return {
    listTenants: async (limit, graceSeconds) => {
      const { rows } = await sql<{ tenant_id: string }>`
        select tenant_id from app.checkout_sweep_tenants(${limit}, ${graceSeconds})`.execute(db);
      return rows.map((r) => r.tenant_id);
    },
    stamp: (ctx) => recordSweepTurn(db, ctx, "checkout"),
    expire: (ctx, limit) =>
      inTenantTransaction(db, ctx, (trx) => expireCheckoutSessions(trx, ctx, { limit })),
    receivedEvents: (ctx, query) =>
      inTenantTransaction(db, ctx, async (trx) => {
        const { rows } = await sql<{ id: string }>`
          select id from provider_events
           where tenant_id = ${ctx.tenantId} and processing_state = 'received'
             and verified_at <= now() - make_interval(secs => ${query.graceSeconds})
             and id <> all(${[...query.excluding]}::uuid[])
           order by verified_at, id
           limit ${query.limit}`.execute(trx);
        return rows.map((e) => e.id);
      }),
    processEvent: (ctx, inboxId) =>
      inTenantTransaction(db, ctx, (trx) =>
        processProviderEvent(trx, ctx, inboxId, { skipLocked: true, hooks }),
      ),
    requestedRefunds: (ctx, query) =>
      inTenantTransaction(db, ctx, async (trx) => {
        const { rows } = await sql<{ id: string }>`
          select id from payment_refunds
           where tenant_id = ${ctx.tenantId} and state = 'requested'
             and created_at <= now() - make_interval(secs => ${query.graceSeconds})
             and id <> all(${[...query.excluding]}::uuid[])
           order by created_at, id
           limit ${query.limit}`.execute(trx);
        return rows.map((r) => r.id);
      }),
    settleRefund: provider ? (ctx, refundId) => settleRefund(db, provider, ctx, refundId) : null,
  };
}

export async function sweepCheckouts(
  db: Kysely<Database>,
  options: CheckoutSweepOptions,
): Promise<CheckoutSweepReport> {
  return runCheckoutSweep(checkoutSweepStore(db, options.provider ?? null, options.hooks), options);
}

/** Where a step stands for one tenant in this run. */
type Step = "todo" | "more" | "done";

/** One tenant's state across its turns in one run. */
interface TenantRun {
  ctx: TenantContext;
  expiry: Step;
  inbox: Step;
  refunds: Step;
  expired: Set<string>;
  skipped: Set<string>;
  inconsistent: Set<string>;
  eventsAttempted: Set<string>;
  eventsReadFailed: boolean;
  /** Refunds the run's reprocessed events requested, in order, not yet attempted. */
  handedRefunds: string[];
  /** Every refund this run read or was handed. */
  refundsSeen: Set<string>;
  refundsAttempted: Set<string>;
  /** Succeeded or failed at the provider, or no longer requested. */
  refundsClosed: Set<string>;
  refundsReadFailed: boolean;
}

/**
 * The checkout sweep over any store. Each tenant's turn runs the steps not yet
 * done, in order: one expiry batch; up to `turnItems` inbox events; up to
 * `turnItems` refunds. A step says there is more when its batch was full and
 * expired something, or when its window held items it did not reach.
 */
export async function runCheckoutSweep(
  store: CheckoutSweepStore,
  options: CheckoutSweepOptions,
): Promise<CheckoutSweepReport> {
  const clock = options.clock ?? Date.now;
  const started = clock();
  const budgetMs = options.budgetMs ?? 20_000;
  const tenantLimit = options.tenantLimit ?? 100;
  const batchSize = options.batchSize ?? DEFAULT_CHECKOUT_SWEEP_BATCH;
  const turnItems = options.turnItems ?? DEFAULT_CHECKOUT_SWEEP_TURN_ITEMS;
  if (!Number.isInteger(turnItems) || turnItems < 1 || turnItems > 1000) {
    throw new RangeError("turnItems must be a whole number from 1 to 1000");
  }
  const grace = graceOf(options.graceSeconds);
  const overBudget = () => clock() - started >= budgetMs;
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
    complete: false,
    turns: 0,
    passes: 0,
    deferredTenants: 0,
  };
  let failures = false;
  const onError: NonNullable<CheckoutSweepOptions["onError"]> = (tenantId, item, error, id) => {
    if (item !== "stamp") failures = true;
    options.onError?.(tenantId, item, error, id);
  };
  const runs = new Map<string, TenantRun>();
  const runOf = (tenantId: string): TenantRun => {
    let run = runs.get(tenantId);
    if (!run) {
      run = {
        ctx: { tenantId, actorType: "system", actorId: "checkout-sweep", requestId: options.runId },
        expiry: "todo",
        inbox: "todo",
        refunds: "todo",
        expired: new Set(),
        skipped: new Set(),
        inconsistent: new Set(),
        eventsAttempted: new Set(),
        eventsReadFailed: false,
        handedRefunds: [],
        refundsSeen: new Set(),
        refundsAttempted: new Set(),
        refundsClosed: new Set(),
        refundsReadFailed: false,
      };
      runs.set(tenantId, run);
    }
    return run;
  };

  /** 1. One expiry batch. Each batch either expires something or ends the step. */
  const expiry = async (run: TenantRun): Promise<number> => {
    const { tenantId } = run.ctx;
    try {
      const batch = await store.expire(run.ctx, batchSize);
      for (const id of batch.expired) {
        if (!run.expired.has(id)) report.expired += 1;
        run.expired.add(id);
      }
      for (const id of batch.skipped) run.skipped.add(id);
      for (const checkout of batch.inconsistent) {
        if (run.inconsistent.has(checkout.id)) continue;
        run.inconsistent.add(checkout.id);
        // Reported for an operator; the batch itself did not fail.
        options.onError?.(
          tenantId,
          "checkouts",
          new InconsistentCheckoutError(checkout),
          checkout.id,
        );
      }
      run.expiry =
        batch.expired.length > 0 && batch.expired.length + batch.skipped.length >= batchSize
          ? "more"
          : "done";
      return batch.expired.length + batch.skipped.length;
    } catch (error) {
      report.failedTenants += 1;
      run.expiry = "done";
      onError(tenantId, "checkouts", error);
      return 0;
    }
  };

  /** 2. Up to turnItems inbox events a failed request left unprocessed, one transaction each. */
  const inbox = async (run: TenantRun): Promise<number> => {
    const { tenantId } = run.ctx;
    let window: string[];
    try {
      window = await store.receivedEvents(run.ctx, {
        limit: batchSize,
        graceSeconds: grace,
        excluding: [...run.eventsAttempted],
      });
    } catch (error) {
      report.failedEvents += 1;
      run.eventsReadFailed = true;
      run.inbox = "done";
      onError(tenantId, "inbox_event", error);
      return 0;
    }
    let attempted = 0;
    for (const inboxId of window) {
      if (attempted >= turnItems || overBudget()) break;
      if (run.eventsAttempted.has(inboxId)) continue;
      run.eventsAttempted.add(inboxId);
      attempted += 1;
      try {
        const processed = await store.processEvent(run.ctx, inboxId);
        if (!processed) continue;
        report.reprocessed += 1;
        if (processed.refundId && !run.refundsAttempted.has(processed.refundId)) {
          run.handedRefunds.push(processed.refundId);
          run.refundsSeen.add(processed.refundId);
          // A refund an event requested in a later pass reopens the refund step.
          if (run.refunds === "done") run.refunds = "more";
        }
      } catch (error) {
        report.failedEvents += 1;
        onError(tenantId, "inbox_event", error, inboxId);
      }
    }
    run.inbox = attempted < window.length || window.length >= batchSize ? "more" : "done";
    return attempted;
  };

  /** 3. Up to turnItems refunds whose outcome is unknown, sent again with their own keys. */
  const refunds = async (run: TenantRun): Promise<number> => {
    const { tenantId } = run.ctx;
    const settle = store.settleRefund;
    let window: string[] = [];
    // Without a provider the window is read once, so its refunds are counted.
    if (!run.refundsReadFailed && (settle || run.refunds === "todo")) {
      try {
        window = await store.requestedRefunds(run.ctx, {
          limit: batchSize,
          graceSeconds: grace,
          excluding: [...run.refundsAttempted],
        });
      } catch (error) {
        report.failedRefunds += 1;
        run.refundsReadFailed = true;
        onError(tenantId, "refund", error);
      }
    }
    for (const id of window) run.refundsSeen.add(id);
    if (!settle) {
      run.handedRefunds = [];
      run.refunds = "done";
      return 0;
    }
    const candidates = [...new Set([...run.handedRefunds, ...window])].filter(
      (id) => !run.refundsAttempted.has(id),
    );
    let attempted = 0;
    for (const refundId of candidates) {
      if (attempted >= turnItems || overBudget()) break;
      run.refundsAttempted.add(refundId);
      attempted += 1;
      try {
        const settled = await settle(run.ctx, refundId);
        if (settled.kind === "succeeded" || settled.kind === "failed") {
          report.refundsSettled += 1;
          run.refundsClosed.add(refundId);
        } else if (settled.kind === "not_pending") {
          run.refundsClosed.add(refundId);
        }
      } catch (error) {
        report.failedRefunds += 1;
        onError(tenantId, "refund", error, refundId);
      }
    }
    run.handedRefunds = run.handedRefunds.filter((id) => !run.refundsAttempted.has(id));
    run.refunds = attempted < candidates.length || window.length >= batchSize ? "more" : "done";
    return attempted;
  };

  const fair = await runFairSweep({
    listTenants: () => store.listTenants(tenantLimit, grace),
    tenantLimit,
    stamp: (tenantId) => store.stamp(runOf(tenantId).ctx),
    turn: async (tenantId) => {
      const run = runOf(tenantId);
      let units = 0;
      if (run.expiry !== "done") units += await expiry(run);
      if (run.inbox !== "done") units += await inbox(run);
      if (run.refunds !== "done") units += await refunds(run);
      const more = run.expiry === "more" || run.inbox === "more" || run.refunds === "more";
      return { units, more };
    },
    budgetMs,
    clock,
    startedAt: started,
    ...(options.onTurnStart ? { onTurnStart: options.onTurnStart } : {}),
    onTenantError: (tenantId, error, during) => {
      if (during === "turn") report.failedTenants += 1;
      onError(tenantId, during === "stamp" ? "stamp" : "checkouts", error);
    },
  });

  for (const run of runs.values()) {
    for (const id of run.skipped) if (!run.expired.has(id)) report.skipped += 1;
    for (const id of run.refundsSeen) if (!run.refundsClosed.has(id)) report.refundsPending += 1;
  }
  report.tenants = fair.tenants;
  report.turns = fair.turns;
  report.passes = fair.passes;
  report.deferredTenants = fair.deferredTenants;
  report.complete = fair.complete && !failures;
  return report;
}
