/**
 * External payment and reconciliation (W3-G2.10). docs/v2/03: the Core fee
 * applies to all value TideGrid manages, whatever the payment rail, so staff
 * record money that changed hands outside the card flow against the booking,
 * and TideGrid reconciles each booking's value, its recorded settlements and
 * refunds, and the fee base it invoices.
 *
 * - External settlements: cash, check, or other tender, a payment or a refund,
 *   with a reason and an idempotency key. A refund reverses the fee on its
 *   eligible share, as a card refund does (fee-ledger.ts).
 * - Fee assessment: the fee on a booking's eligible value, once, when it
 *   closes (its trip ended, or it was canceled). Refunds reverse their share
 *   separately, so the fee base is the retained eligible value.
 * - Invoices: one draft per billing-plan month. The database computes and
 *   checks each figure from the ledgers (migration 0031).
 * - Disputes: opened and moved only by verified provider events.
 * - Missing webhooks (D1, proposed): a pending payment past its checkout's
 *   hold is read at the provider. The reading never confirms, fails, or
 *   refunds anything: a booking confirms only from a verified provider event.
 *   A reading that disagrees is raised once for staff.
 */
import {
  type Database,
  type ExternalSettlementKind,
  type ExternalTender,
  type FeeAssessmentBasis,
  inTenantTransaction,
  type PaymentReconciliationReason,
  type ProviderDisputeStatus,
  recordSweepTurn,
  runFairSweep,
  type TenantContext,
  type TenantTransaction,
} from "@tidegrid/database";
import {
  type InboxEvent,
  type PaymentProvider,
  type PaymentProviderName,
  ProviderRejectedError,
  ProviderUnavailableError,
} from "@tidegrid/domain-payments";
import { type Kysely, sql } from "kysely";
import { CORE_FEE_BP, feeReversalFor } from "./fee-ledger.ts";
import { iso, record } from "./views.ts";

// Disputes -------------------------------------------------------------------------

export type DisputeEventOutcome =
  /** A dispute on a TideGrid payment was opened. */
  | "dispute_opened"
  /** An open dispute moved. */
  | "dispute_updated"
  /** A dispute closed: won, lost, or closed. */
  | "dispute_closed"
  /** The dispute had already closed; nothing changed. */
  | "dispute_already_closed"
  /** The event names a TideGrid payment but not as the payment is. */
  | "dispute_mismatch"
  /** No payment of this tenant matches: not a sale TideGrid made. */
  | "unmatched_dispute";

const closedStatuses = new Set<ProviderDisputeStatus>(["won", "lost", "closed"]);

/**
 * Act on a locked, unprocessed dispute.updated inbox event (W3-G2.10). The
 * dispute is recorded against the payment the provider names, only when that
 * payment is TideGrid's, succeeded, on the same account, and the disputed
 * amount is at most what was paid. A closed dispute never moves again.
 */
export async function onDisputeEvent(
  trx: TenantTransaction,
  ctx: TenantContext,
  event: InboxEvent,
): Promise<DisputeEventOutcome> {
  const dispute = event.dispute;
  if (!dispute || event.paymentRef === null || event.amount === null) return "dispute_mismatch";
  const { rows: payments } = await sql<{
    id: string;
    account_ref: string;
    state: string;
    amount: number;
    currency: string;
  }>`
    select id, account_ref, state, amount, currency from payments
     where tenant_id = ${ctx.tenantId} and provider = ${event.provider}
       and provider_payment_id = ${event.paymentRef}
       for share`.execute(trx);
  const payment = payments[0];
  if (!payment) return "unmatched_dispute";
  if (
    payment.account_ref !== event.accountRef ||
    payment.state !== "succeeded" ||
    event.currency !== payment.currency ||
    event.amount < 1 ||
    event.amount > payment.amount
  ) {
    return "dispute_mismatch";
  }
  const { rows: existing } = await sql<{
    id: string;
    payment_id: string;
    amount: number;
    status: ProviderDisputeStatus;
  }>`
    select id, payment_id, amount, status from payment_disputes
     where tenant_id = ${ctx.tenantId} and provider = ${event.provider}
       and dispute_ref = ${dispute.ref}
       for update`.execute(trx);
  const prior = existing[0];
  const closes = closedStatuses.has(dispute.status);
  if (!prior) {
    const { rows } = await sql<{ id: string }>`
      insert into payment_disputes (tenant_id, payment_id, provider, dispute_ref, amount, reason,
        status, opened_event_id, last_event_id)
      values (${ctx.tenantId}, ${payment.id}, ${event.provider}, ${dispute.ref}, ${event.amount},
        ${dispute.reason}, ${dispute.status}, ${event.id}, ${event.id})
      returning id`.execute(trx);
    const id = rows[0]?.id;
    if (!id) throw new Error("a dispute was not recorded");
    await record(trx, ctx, {
      action: "payment.dispute_opened",
      subjectType: "payment",
      subjectId: payment.id,
      after: {
        disputeId: id,
        status: dispute.status,
        amount: event.amount,
        reason: dispute.reason,
      },
    });
    return closes ? "dispute_closed" : "dispute_opened";
  }
  if (prior.payment_id !== payment.id || prior.amount !== event.amount) return "dispute_mismatch";
  if (closedStatuses.has(prior.status)) return "dispute_already_closed";
  await sql`
    update payment_disputes set status = ${dispute.status}, last_event_id = ${event.id}
     where tenant_id = ${ctx.tenantId} and id = ${prior.id}`.execute(trx);
  if (prior.status !== dispute.status) {
    await record(trx, ctx, {
      action: closes ? "payment.dispute_closed" : "payment.dispute_updated",
      subjectType: "payment",
      subjectId: payment.id,
      before: { disputeId: prior.id, status: prior.status },
      after: { disputeId: prior.id, status: dispute.status },
    });
  }
  return closes ? "dispute_closed" : "dispute_updated";
}

export interface DisputeView {
  id: string;
  status: ProviderDisputeStatus;
  open: boolean;
  amount: number;
  reason: string;
  openedAt: string;
  updatedAt: string;
  closedAt: string | null;
  payment: { id: string; amount: number };
  booking: { id: string; reference: string } | null;
}

/** The tenant's disputes, newest first. */
export async function listDisputes(
  trx: TenantTransaction,
  tenantId: string,
  limit = 100,
): Promise<DisputeView[]> {
  const { rows } = await sql<{
    id: string;
    status: ProviderDisputeStatus;
    amount: number;
    reason: string;
    created_at: Date | string;
    updated_at: Date | string;
    closed_at: Date | string | null;
    payment_id: string;
    payment_amount: number;
    booking_id: string | null;
    reference: string | null;
  }>`
    select d.id, d.status, d.amount, d.reason, d.created_at, d.updated_at, d.closed_at,
           p.id as payment_id, p.amount as payment_amount, b.id as booking_id, b.reference
      from payment_disputes d
      join payments p on p.tenant_id = d.tenant_id and p.id = d.payment_id
      left join bookings b on b.tenant_id = p.tenant_id and b.payment_id = p.id
     where d.tenant_id = ${tenantId}
     order by d.created_at desc, d.id
     limit ${clampLimit(limit)}`.execute(trx);
  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    open: !closedStatuses.has(row.status),
    amount: row.amount,
    reason: row.reason,
    openedAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    closedAt: row.closed_at === null ? null : iso(row.closed_at),
    payment: { id: row.payment_id, amount: row.payment_amount },
    booking:
      row.booking_id !== null && row.reference !== null
        ? { id: row.booking_id, reference: row.reference }
        : null,
  }));
}

// External settlements --------------------------------------------------------------

export interface ExternalSettlementInput {
  bookingId: string;
  kind: ExternalSettlementKind;
  tender: ExternalTender;
  amount: number;
  reason: string;
  tenderReference?: string | null;
  /** Already scoped to the actor by the caller; the same key names the same command. */
  idempotencyKey: string;
}

export interface ExternalSettlementView {
  id: string;
  bookingId: string;
  kind: ExternalSettlementKind;
  tender: ExternalTender;
  amount: number;
  reason: string;
  tenderReference: string | null;
  /** For a refund: the eligible value it returned and the fee it reversed (negative or zero). */
  eligibleAmount: number | null;
  feeAmount: number | null;
  recordedAt: string;
  recordedBy: string | null;
}

export type ExternalSettlementResult =
  | { kind: "recorded"; settlement: ExternalSettlementView; replayed: boolean }
  | { kind: "not_found" }
  /** A refund would return more than came in, or more than the booking cost. */
  | { kind: "refund_too_large"; refundable: number }
  /** The key was used for another command. */
  | { kind: "key_reused" };

interface SettlementRow {
  id: string;
  booking_id: string;
  kind: ExternalSettlementKind;
  tender: ExternalTender;
  amount: number;
  reason: string;
  tender_reference: string | null;
  idempotency_key: string;
  eligible_amount: number | null;
  fee_amount: number | null;
  created_at: Date | string;
  actor_id: string | null;
}

const settlementColumns = sql`id, booking_id, kind, tender, amount, reason, tender_reference,
  idempotency_key, eligible_amount, fee_amount, created_at, actor_id`;

function settlementView(row: SettlementRow): ExternalSettlementView {
  return {
    id: row.id,
    bookingId: row.booking_id,
    kind: row.kind,
    tender: row.tender,
    amount: row.amount,
    reason: row.reason,
    tenderReference: row.tender_reference,
    eligibleAmount: row.eligible_amount,
    feeAmount: row.fee_amount,
    recordedAt: iso(row.created_at),
    recordedBy: row.actor_id,
  };
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it refuses.
const controlCharacters = /[\u0000-\u001f\u007f]/;

function checkText(value: string, max: number, what: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > max || controlCharacters.test(trimmed)) {
    throw new RangeError(`${what} is 1 to ${max} characters, without control characters`);
  }
  return trimmed;
}

function sameSettlement(row: SettlementRow, input: Required<ExternalSettlementInput>) {
  return (
    row.booking_id === input.bookingId &&
    row.kind === input.kind &&
    row.tender === input.tender &&
    row.amount === input.amount &&
    row.reason === input.reason &&
    row.tender_reference === input.tenderReference
  );
}

async function settlementByKey(trx: TenantTransaction, tenantId: string, key: string) {
  const { rows } = await sql<SettlementRow>`
    select ${settlementColumns} from external_settlements
     where tenant_id = ${tenantId} and idempotency_key = ${key}`.execute(trx);
  return rows[0];
}

/** What a refund may still return: the lower of the money in and what the booking cost, less refunds. */
async function refundable(trx: TenantTransaction, tenantId: string, bookingId: string) {
  const { rows } = await sql<{ refundable: number }>`
    select greatest(0, least(
             coalesce(case when p.state = 'succeeded' then p.amount end, 0) - coalesce(r.refunded, 0)
               + coalesce(s.paid, 0) - coalesce(s.refunded, 0),
             o.total_amount - coalesce(r.refunded, 0) - coalesce(s.refunded, 0)))::int as refundable
      from bookings b
      join orders o on o.tenant_id = b.tenant_id and o.id = b.order_id
      join payments p on p.tenant_id = b.tenant_id and p.id = b.payment_id
      left join lateral (
        select sum(x.amount) as refunded from payment_refunds x
         where x.tenant_id = b.tenant_id and x.payment_id = b.payment_id
           and x.state in ('requested', 'pending', 'succeeded')) r on true
      left join lateral (
        select sum(x.amount) filter (where x.kind = 'payment') as paid,
               sum(x.amount) filter (where x.kind = 'refund') as refunded
          from external_settlements x
         where x.tenant_id = b.tenant_id and x.booking_id = b.id) s on true
     where b.tenant_id = ${tenantId} and b.id = ${bookingId}`.execute(trx);
  return rows[0]?.refundable ?? 0;
}

/**
 * Record cash, check, or other tender against a booking, as the signed-in
 * staff member in `ctx`. Idempotent by key: the same command returns the
 * first record; another command under the key is refused. A refund takes the
 * booking's lock in the database and may not return more than came in, nor
 * more than the booking cost.
 */
export async function recordExternalSettlement(
  trx: TenantTransaction,
  ctx: TenantContext,
  input: ExternalSettlementInput,
): Promise<ExternalSettlementResult> {
  if (ctx.actorType !== "staff" || !ctx.actorId) {
    throw new TypeError("external money is recorded by a signed-in staff member");
  }
  if (!Number.isInteger(input.amount) || input.amount < 1 || input.amount > 100_000_000) {
    throw new RangeError("amount is a whole number of cents from 1 to 100,000,000");
  }
  const command: Required<ExternalSettlementInput> = {
    ...input,
    reason: checkText(input.reason, 500, "reason"),
    tenderReference:
      input.tenderReference === undefined || input.tenderReference === null
        ? null
        : checkText(input.tenderReference, 100, "tenderReference"),
  };
  const prior = await settlementByKey(trx, ctx.tenantId, command.idempotencyKey);
  if (prior) {
    return sameSettlement(prior, command)
      ? { kind: "recorded", settlement: settlementView(prior), replayed: true }
      : { kind: "key_reused" };
  }
  const { rows: bookings } = await sql<{ total_amount: number; eligible_total: number }>`
    select o.total_amount, o.total_amount - o.tax_amount - o.included_tax_amount as eligible_total
      from bookings b
      join orders o on o.tenant_id = b.tenant_id and o.id = b.order_id
     where b.tenant_id = ${ctx.tenantId} and b.id = ${command.bookingId}`.execute(trx);
  const order = bookings[0];
  if (!order) return { kind: "not_found" };
  let fee: {
    orderTotal: number;
    eligibleTotal: number;
    eligibleAmount: number;
    feeBp: number;
    feeAmount: number;
  } | null = null;
  if (command.kind === "refund") {
    if (command.amount > order.total_amount) {
      return {
        kind: "refund_too_large",
        refundable: await refundable(trx, ctx.tenantId, command.bookingId),
      };
    }
    const computed = feeReversalFor({
      refundAmount: command.amount,
      orderTotal: order.total_amount,
      eligibleTotal: order.eligible_total,
    });
    fee = {
      orderTotal: order.total_amount,
      eligibleTotal: order.eligible_total,
      ...computed,
    };
  }
  await sql`savepoint external_settlement`.execute(trx);
  let inserted: SettlementRow | undefined;
  try {
    const { rows } = await sql<SettlementRow>`
      insert into external_settlements (tenant_id, booking_id, kind, tender, amount, reason,
        tender_reference, idempotency_key, order_total, eligible_total, eligible_amount, fee_bp,
        fee_amount)
      values (${ctx.tenantId}, ${command.bookingId}, ${command.kind}, ${command.tender},
        ${command.amount}, ${command.reason}, ${command.tenderReference}, ${command.idempotencyKey},
        ${fee?.orderTotal ?? null}, ${fee?.eligibleTotal ?? null}, ${fee?.eligibleAmount ?? null},
        ${fee?.feeBp ?? null}, ${fee?.feeAmount ?? null})
      returning ${settlementColumns}`.execute(trx);
    inserted = rows[0];
    await sql`release savepoint external_settlement`.execute(trx);
  } catch (error) {
    await sql`rollback to savepoint external_settlement`.execute(trx);
    const e = error as { code?: unknown; constraint_name?: unknown };
    if (e.code === "23505" && e.constraint_name === "external_settlements_key") {
      const raced = await settlementByKey(trx, ctx.tenantId, command.idempotencyKey);
      if (raced) {
        return sameSettlement(raced, command)
          ? { kind: "recorded", settlement: settlementView(raced), replayed: true }
          : { kind: "key_reused" };
      }
    }
    if (e.code === "23514" && e.constraint_name === "external_settlements_refund_limit") {
      return {
        kind: "refund_too_large",
        refundable: await refundable(trx, ctx.tenantId, command.bookingId),
      };
    }
    throw error;
  }
  if (!inserted) throw new Error("an external settlement was not recorded");
  const view = settlementView(inserted);
  await record(trx, ctx, {
    action: `booking.external_${command.kind}_recorded`,
    subjectType: "booking",
    subjectId: command.bookingId,
    reason: command.reason,
    after: {
      settlementId: view.id,
      tender: view.tender,
      amount: view.amount,
      tenderReference: view.tenderReference,
      feeAmount: view.feeAmount,
    },
  });
  return { kind: "recorded", settlement: view, replayed: false };
}

/** A booking's external settlements, oldest first, with what a refund may still return. */
export async function listExternalSettlements(
  trx: TenantTransaction,
  tenantId: string,
  bookingId: string,
): Promise<{ settlements: ExternalSettlementView[]; refundable: number } | null> {
  const { rows: found } = await sql<{ id: string }>`
    select id from bookings where tenant_id = ${tenantId} and id = ${bookingId}`.execute(trx);
  if (!found[0]) return null;
  const { rows } = await sql<SettlementRow>`
    select ${settlementColumns} from external_settlements
     where tenant_id = ${tenantId} and booking_id = ${bookingId}
     order by created_at, id
     limit 500`.execute(trx);
  return {
    settlements: rows.map(settlementView),
    refundable: await refundable(trx, tenantId, bookingId),
  };
}

// Fee assessment ----------------------------------------------------------------------

/** How long after a booking closes the sweep still assesses it. */
export const ASSESSMENT_WINDOW_DAYS = 35;

/**
 * Assess TideGrid's fee on up to `limit` closed bookings that have none: a
 * confirmed booking whose trip has ended, a canceled one at once. Returns how
 * many were assessed and whether more remain.
 */
export async function assessClosedBookings(
  trx: TenantTransaction,
  ctx: TenantContext,
  limit: number,
): Promise<{ assessed: number; more: boolean }> {
  const { rows } = await sql<{
    booking_id: string;
    basis: FeeAssessmentBasis;
    total_amount: number;
    eligible_total: number;
  }>`
    select b.id as booking_id,
           case when b.state = 'canceled' then 'canceled' else 'trip_completed' end as basis,
           o.total_amount, o.total_amount - o.tax_amount - o.included_tax_amount as eligible_total
      from bookings b
      join orders o on o.tenant_id = b.tenant_id and o.id = b.order_id
      join scheduled_trips t on t.tenant_id = b.tenant_id and t.id = b.trip_id
      left join booking_cancellations c on c.tenant_id = b.tenant_id and c.booking_id = b.id
     where b.tenant_id = ${ctx.tenantId}
       and ((b.state = 'confirmed' and t.ends_at <= now()
             and t.ends_at > now() - make_interval(days => ${ASSESSMENT_WINDOW_DAYS}))
         or (b.state = 'canceled'
             and c.created_at > now() - make_interval(days => ${ASSESSMENT_WINDOW_DAYS})))
       and not exists (select 1 from fee_assessments a
                        where a.tenant_id = b.tenant_id and a.booking_id = b.id)
     order by b.id
     limit ${limit + 1}`.execute(trx);
  const batch = rows.slice(0, limit);
  let assessed = 0;
  for (const row of batch) {
    const fee = Number((BigInt(row.eligible_total) * BigInt(CORE_FEE_BP) + 5000n) / 10000n);
    const { rows: inserted } = await sql<{ id: string }>`
      insert into fee_assessments (tenant_id, booking_id, basis, order_total, eligible_total,
        fee_bp, fee_amount)
      values (${ctx.tenantId}, ${row.booking_id}, ${row.basis}, ${row.total_amount},
        ${row.eligible_total}, ${CORE_FEE_BP}, ${fee})
      on conflict (tenant_id, booking_id) do nothing
      returning id`.execute(trx);
    if (inserted[0]) assessed += 1;
  }
  return { assessed, more: rows.length > limit };
}

// Invoices ----------------------------------------------------------------------------

export interface FeeInvoiceView {
  id: string;
  /** The plan month, YYYY-MM, in the plan's time zone. */
  month: string;
  contractMonth: number;
  subscriptionAmount: number;
  variableAmount: number;
  carriedIn: number;
  variableBilled: number;
  carriedOut: number;
  trueUpAmount: number;
  totalAmount: number;
  state: "draft";
  issuedAt: string;
}

interface InvoiceRow {
  id: string;
  period_start: string;
  contract_month: number;
  subscription_amount: number;
  variable_amount: number;
  carried_in: number;
  variable_billed: number;
  carried_out: number;
  true_up_amount: number;
  total_amount: number;
  created_at: Date | string;
}

const invoiceColumns = sql`id, to_char(period_start, 'YYYY-MM') as period_start, contract_month,
  subscription_amount, variable_amount, carried_in, variable_billed, carried_out, true_up_amount,
  total_amount, created_at`;

function invoiceView(row: InvoiceRow): FeeInvoiceView {
  return {
    id: row.id,
    month: row.period_start,
    contractMonth: row.contract_month,
    subscriptionAmount: row.subscription_amount,
    variableAmount: row.variable_amount,
    carriedIn: row.carried_in,
    variableBilled: row.variable_billed,
    carriedOut: row.carried_out,
    trueUpAmount: row.true_up_amount,
    totalAmount: row.total_amount,
    state: "draft",
    issuedAt: iso(row.created_at),
  };
}

/**
 * Issue the plan's next draft invoice if its month has ended (an hour's
 * grace), as TideGrid (a system actor). Returns null when none is due or the
 * tenant has no plan. The database recomputes and checks every figure.
 */
export async function issueNextInvoice(
  trx: TenantTransaction,
  ctx: TenantContext,
): Promise<FeeInvoiceView | null> {
  if (ctx.actorType !== "system") throw new TypeError("TideGrid issues fee invoices");
  const { rows } = await sql<{
    next_start: string;
    due: boolean;
    months: number;
    monthly_fee: number;
    annual_minimum: number;
    carried_in: number;
    variable_amount: string;
    year_billed: string;
  }>`
    with plan as (
      select p.*, coalesce(
               (select (max(i.period_start) + interval '1 month')::date
                  from fee_invoices i where i.tenant_id = p.tenant_id),
               p.starts_on) as next_start
        from billing_plans p where p.tenant_id = ${ctx.tenantId}
    )
    select to_char(plan.next_start, 'YYYY-MM-DD') as next_start,
           ((plan.next_start + interval '1 month')::timestamp at time zone plan.time_zone::text)
             + interval '1 hour' <= now() as due,
           ((extract(year from plan.next_start) * 12 + extract(month from plan.next_start))
             - (extract(year from plan.starts_on) * 12 + extract(month from plan.starts_on)))::int
             as months,
           plan.monthly_fee, plan.annual_minimum,
           coalesce((select i.carried_out from fee_invoices i
                      where i.tenant_id = plan.tenant_id
                        and i.period_start = (plan.next_start - interval '1 month')::date), 0)
             as carried_in,
           app.fee_ledger_total(plan.tenant_id,
             plan.next_start::timestamp at time zone plan.time_zone::text,
             (plan.next_start + interval '1 month')::timestamp at time zone plan.time_zone::text)
             as variable_amount,
           coalesce((select sum(i.subscription_amount + i.variable_billed) from fee_invoices i
                      where i.tenant_id = plan.tenant_id
                        and i.period_start >= (plan.next_start - interval '11 months')::date
                        and i.period_start < plan.next_start), 0) as year_billed
      from plan`.execute(trx);
  const plan = rows[0];
  if (!plan?.due) return null;
  const contractMonth = (plan.months % 12) + 1;
  const variable = Number(plan.variable_amount);
  const net = variable + plan.carried_in;
  const variableBilled = Math.max(0, net);
  const carriedOut = Math.min(0, net);
  const trueUp =
    contractMonth === 12
      ? Math.max(
          0,
          plan.annual_minimum - (Number(plan.year_billed) + plan.monthly_fee + variableBilled),
        )
      : 0;
  const { rows: inserted } = await sql<InvoiceRow>`
    insert into fee_invoices (tenant_id, period_start, contract_month, subscription_amount,
      variable_amount, carried_in, variable_billed, carried_out, true_up_amount, total_amount)
    values (${ctx.tenantId}, ${plan.next_start}::date, ${contractMonth}, ${plan.monthly_fee},
      ${variable}, ${plan.carried_in}, ${variableBilled}, ${carriedOut}, ${trueUp},
      ${plan.monthly_fee + variableBilled + trueUp})
    on conflict (tenant_id, period_start) do nothing
    returning ${invoiceColumns}`.execute(trx);
  const row = inserted[0];
  if (!row) return null;
  const view = invoiceView(row);
  await record(trx, ctx, {
    action: "billing.invoice_drafted",
    subjectType: "fee_invoice",
    subjectId: view.id,
    after: { month: view.month, totalAmount: view.totalAmount, trueUpAmount: view.trueUpAmount },
  });
  return view;
}

/** The tenant's fee invoices, newest month first. */
export async function listFeeInvoices(
  trx: TenantTransaction,
  tenantId: string,
): Promise<FeeInvoiceView[]> {
  const { rows } = await sql<InvoiceRow>`
    select ${invoiceColumns} from fee_invoices
     where tenant_id = ${tenantId}
     order by period_start desc
     limit 120`.execute(trx);
  return rows.map(invoiceView);
}

// Missing webhooks (D1) ----------------------------------------------------------------

/** How long the sweep keeps asking about a pending payment. */
export const PAYMENT_CHECK_DAYS = 7;

export type PaymentCheckResult =
  /** The provider agrees the payment is still pending. */
  | { kind: "pending" }
  /** The reading disagrees; raised for staff (once per reason). Nothing changed. */
  | { kind: "raised"; reason: PaymentReconciliationReason }
  /** The payment settled meanwhile, by its event. */
  | { kind: "not_pending" }
  /** No answer; asked again within the hour. */
  | { kind: "unknown" };

/**
 * Read the provider about one pending payment whose checkout's hold has
 * ended (D1, proposed). A reading never confirms, fails, or refunds anything;
 * only a verified provider event does. One that disagrees is raised for staff.
 */
export async function checkPendingPayment(
  db: Kysely<Database>,
  provider: PaymentProvider,
  ctx: TenantContext,
  paymentId: string,
): Promise<PaymentCheckResult> {
  const found = await inTenantTransaction(db, ctx, async (trx) => {
    const { rows } = await sql<{
      account_ref: string;
      provider_payment_id: string | null;
      state: string;
      amount: number;
      provider: PaymentProviderName;
    }>`
      select account_ref, provider_payment_id, state, amount, provider from payments
       where tenant_id = ${ctx.tenantId} and id = ${paymentId}`.execute(trx);
    return rows[0];
  });
  if (found?.state !== "pending" || found.provider_payment_id === null) {
    return { kind: "not_pending" };
  }
  if (found.provider !== provider.name) return { kind: "unknown" };
  let reading: Awaited<ReturnType<PaymentProvider["retrievePayment"]>>;
  try {
    reading = await provider.retrievePayment({
      accountRef: found.account_ref,
      paymentRef: found.provider_payment_id,
    });
  } catch (error) {
    if (!(error instanceof ProviderUnavailableError || error instanceof ProviderRejectedError)) {
      throw error;
    }
    await inTenantTransaction(db, ctx, (trx) => stampPaymentCheck(trx, ctx.tenantId, paymentId));
    return { kind: "unknown" };
  }
  const reason: PaymentReconciliationReason | null =
    reading === null
      ? "missing_at_provider"
      : reading.amount !== found.amount
        ? "amount_mismatch"
        : reading.status === "succeeded"
          ? "succeeded_without_event"
          : reading.status === "failed"
            ? "failed_without_event"
            : null;
  return inTenantTransaction(db, ctx, async (trx) => {
    const { rows } = await sql<{ state: string }>`
      select state from payments where tenant_id = ${ctx.tenantId} and id = ${paymentId}
         for no key update`.execute(trx);
    if (rows[0]?.state !== "pending") return { kind: "not_pending" as const };
    await stampPaymentCheck(trx, ctx.tenantId, paymentId);
    if (reason === null) return { kind: "pending" as const };
    const { rows: raised } = await sql<{ id: string }>`
      insert into payment_reconciliation_exceptions (tenant_id, payment_id, reason,
        provider_status, provider_amount)
      values (${ctx.tenantId}, ${paymentId}, ${reason}, ${reading?.status ?? null},
        ${reading?.amount ?? null})
      on conflict (tenant_id, payment_id, reason) do nothing
      returning id`.execute(trx);
    if (raised[0]) {
      await record(trx, ctx, {
        action: "payment.reconciliation_raised",
        subjectType: "payment",
        subjectId: paymentId,
        after: { reason, providerStatus: reading?.status ?? null },
      });
    }
    return { kind: "raised" as const, reason };
  });
}

async function stampPaymentCheck(trx: TenantTransaction, tenantId: string, paymentId: string) {
  // The value is the database clock's; the trigger stamps it.
  await sql`update payments set checked_at = now()
             where tenant_id = ${tenantId} and id = ${paymentId} and state = 'pending'`.execute(
    trx,
  );
}

/** Pending payments due a check, oldest check first. */
async function paymentsDueCheck(
  trx: TenantTransaction,
  tenantId: string,
  limit: number,
  excluding: readonly string[],
): Promise<string[]> {
  const { rows } = await sql<{ id: string }>`
    select p.id from payments p
      join checkout_sessions s on s.tenant_id = p.tenant_id and s.id = p.checkout_session_id
     where p.tenant_id = ${tenantId} and p.state = 'pending'
       and p.provider_payment_id is not null
       and p.created_at > now() - make_interval(days => ${PAYMENT_CHECK_DAYS})
       and (p.checked_at is null or p.checked_at <= now() - interval '1 hour')
       and s.expires_at <= now() - interval '1 hour'
       and not (p.id = any(${[...excluding]}::uuid[]))
     order by p.checked_at nulls first, p.id
     limit ${limit}`.execute(trx);
  return rows.map((r) => r.id);
}

export interface PaymentExceptionView {
  id: string;
  reason: PaymentReconciliationReason;
  providerStatus: string | null;
  providerAmount: number | null;
  raisedAt: string;
  /** Open while the payment is still pending: no verified event has settled it. */
  open: boolean;
  payment: { id: string; state: string; amount: number; checkedAt: string | null };
  checkoutSessionId: string;
}

/** Provider readings that disagreed with a pending payment, newest first. */
export async function listPaymentReconciliationExceptions(
  trx: TenantTransaction,
  tenantId: string,
  limit = 100,
): Promise<PaymentExceptionView[]> {
  const { rows } = await sql<{
    id: string;
    reason: PaymentReconciliationReason;
    provider_status: string | null;
    provider_amount: number | null;
    created_at: Date | string;
    payment_id: string;
    state: string;
    amount: number;
    checked_at: Date | string | null;
    checkout_session_id: string;
  }>`
    select x.id, x.reason, x.provider_status, x.provider_amount, x.created_at,
           p.id as payment_id, p.state, p.amount, p.checked_at, p.checkout_session_id
      from payment_reconciliation_exceptions x
      join payments p on p.tenant_id = x.tenant_id and p.id = x.payment_id
     where x.tenant_id = ${tenantId}
     order by x.created_at desc, x.id
     limit ${clampLimit(limit)}`.execute(trx);
  return rows.map((row) => ({
    id: row.id,
    reason: row.reason,
    providerStatus: row.provider_status,
    providerAmount: row.provider_amount,
    raisedAt: iso(row.created_at),
    open: row.state === "pending",
    payment: {
      id: row.payment_id,
      state: row.state,
      amount: row.amount,
      checkedAt: row.checked_at === null ? null : iso(row.checked_at),
    },
    checkoutSessionId: row.checkout_session_id,
  }));
}

// The reconciliation report -----------------------------------------------------------

export interface ReconciliationRow {
  bookingId: string;
  reference: string;
  state: string;
  /** Eligible value assessed this month (the booking closed). */
  assessedValue: number;
  /** Eligible value refunded this month, by card and externally. */
  refundedValue: number;
  /** Money recorded this month outside the card flow. */
  externalPaid: number;
  externalRefunded: number;
  /** TideGrid's fee entries this month for the booking: assessment less reversals. */
  feeAmount: number;
}

export interface ReconciliationTotals {
  assessedValue: number;
  refundedValue: number;
  /** assessedValue - refundedValue: the month's net managed booking value. */
  netManagedValue: number;
  externalPaid: number;
  externalRefunded: number;
  feeAmount: number;
}

export interface ReconciliationReport {
  month: string;
  timeZone: string;
  rows: ReconciliationRow[];
  totals: ReconciliationTotals;
  /** The fee ledgers' own total for the month, summed apart from the rows. */
  ledgerFeeTotal: number;
  /** The rows add up to the ledger: the export's control total. */
  controlTotalsMatch: boolean;
  /**
   * Of the bookings assessed this month, the share of their booking value
   * received by card or recorded externally, in basis points, and how many
   * fall short. docs/v2/03 asks for at least 98% (9,800).
   */
  receivedShareBp: number;
  shortBookings: number;
  meetsTarget: boolean;
}

export const RECEIVED_SHARE_TARGET_BP = 9800;

/**
 * The month's reconciliation: every booking with fee or external-money
 * activity in the month, in the billing plan's time zone (UTC without a
 * plan), its totals, and the fee ledgers' own total as the control total.
 * Run it in a snapshot so the rows and the control total describe one moment.
 */
export async function reconciliationReport(
  trx: TenantTransaction,
  tenantId: string,
  month: string,
): Promise<ReconciliationReport> {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new RangeError("month is YYYY-MM");
  const start = `${month}-01`;
  const { rows: zones } = await sql<{ time_zone: string }>`
    select coalesce((select time_zone::text from billing_plans where tenant_id = ${tenantId}),
                    'UTC') as time_zone`.execute(trx);
  const timeZone = zones[0]?.time_zone ?? "UTC";
  const { rows } = await sql<{
    booking_id: string;
    reference: string;
    state: string;
    assessed_value: number;
    refunded_value: number;
    external_paid: number;
    external_refunded: number;
    fee_amount: number;
  }>`
    with bounds as (
      select ${start}::date::timestamp at time zone ${timeZone} as f,
             (${start}::date + interval '1 month')::timestamp at time zone ${timeZone} as u
    ),
    a as (
      select x.booking_id, sum(x.eligible_total) as value, sum(x.fee_amount) as fee
        from fee_assessments x, bounds
       where x.tenant_id = ${tenantId} and x.created_at >= bounds.f and x.created_at < bounds.u
       group by x.booking_id
    ),
    r as (
      select x.booking_id, sum(x.eligible_amount) as value, sum(x.fee_amount) as fee
        from fee_ledger_entries x, bounds
       where x.tenant_id = ${tenantId} and x.created_at >= bounds.f and x.created_at < bounds.u
       group by x.booking_id
    ),
    s as (
      select x.booking_id,
             sum(x.amount) filter (where x.kind = 'payment') as paid,
             sum(x.amount) filter (where x.kind = 'refund') as refunded,
             sum(x.eligible_amount) filter (where x.kind = 'refund') as value,
             sum(x.fee_amount) filter (where x.kind = 'refund') as fee
        from external_settlements x, bounds
       where x.tenant_id = ${tenantId} and x.created_at >= bounds.f and x.created_at < bounds.u
       group by x.booking_id
    ),
    ids as (select booking_id from a union select booking_id from r union select booking_id from s)
    select b.id as booking_id, b.reference, b.state,
           coalesce(a.value, 0)::int as assessed_value,
           (coalesce(r.value, 0) + coalesce(s.value, 0))::int as refunded_value,
           coalesce(s.paid, 0)::int as external_paid,
           coalesce(s.refunded, 0)::int as external_refunded,
           (coalesce(a.fee, 0) + coalesce(r.fee, 0) + coalesce(s.fee, 0))::int as fee_amount
      from ids
      join bookings b on b.tenant_id = ${tenantId} and b.id = ids.booking_id
      left join a on a.booking_id = ids.booking_id
      left join r on r.booking_id = ids.booking_id
      left join s on s.booking_id = ids.booking_id
     order by b.reference, b.id`.execute(trx);
  const { rows: control } = await sql<{
    ledger: string;
    expected: string;
    received: string;
    short: number;
  }>`
    with bounds as (
      select ${start}::date::timestamp at time zone ${timeZone} as f,
             (${start}::date + interval '1 month')::timestamp at time zone ${timeZone} as u
    ),
    assessed as (
      select a.booking_id, a.order_total,
             coalesce((select case when p.state = 'succeeded' then p.amount end
                         from bookings b join payments p
                           on p.tenant_id = b.tenant_id and p.id = b.payment_id
                        where b.tenant_id = a.tenant_id and b.id = a.booking_id), 0)
             + coalesce((select sum(x.amount) from external_settlements x
                          where x.tenant_id = a.tenant_id and x.booking_id = a.booking_id
                            and x.kind = 'payment'), 0) as received
        from fee_assessments a, bounds
       where a.tenant_id = ${tenantId} and a.created_at >= bounds.f and a.created_at < bounds.u
    )
    select app.fee_ledger_total(${tenantId}, bounds.f, bounds.u)::text as ledger,
           coalesce((select sum(order_total) from assessed), 0)::text as expected,
           coalesce((select sum(least(received, order_total)) from assessed), 0)::text as received,
           (select count(*) from assessed where received < order_total)::int as short
      from bounds`.execute(trx);
  const reportRows: ReconciliationRow[] = rows.map((row) => ({
    bookingId: row.booking_id,
    reference: row.reference,
    state: row.state,
    assessedValue: row.assessed_value,
    refundedValue: row.refunded_value,
    externalPaid: row.external_paid,
    externalRefunded: row.external_refunded,
    feeAmount: row.fee_amount,
  }));
  const sum = (pick: (row: ReconciliationRow) => number) =>
    reportRows.reduce((total, row) => total + pick(row), 0);
  const totals: ReconciliationTotals = {
    assessedValue: sum((r) => r.assessedValue),
    refundedValue: sum((r) => r.refundedValue),
    netManagedValue: sum((r) => r.assessedValue) - sum((r) => r.refundedValue),
    externalPaid: sum((r) => r.externalPaid),
    externalRefunded: sum((r) => r.externalRefunded),
    feeAmount: sum((r) => r.feeAmount),
  };
  const c = control[0];
  const ledgerFeeTotal = Number(c?.ledger ?? 0);
  const expected = Number(c?.expected ?? 0);
  const received = Number(c?.received ?? 0);
  const receivedShareBp = expected === 0 ? 10000 : Math.floor((received * 10000) / expected);
  return {
    month,
    timeZone,
    rows: reportRows,
    totals,
    ledgerFeeTotal,
    controlTotalsMatch: ledgerFeeTotal === totals.feeAmount,
    receivedShareBp,
    shortBookings: c?.short ?? 0,
    meetsTarget: receivedShareBp >= RECEIVED_SHARE_TARGET_BP,
  };
}

// The reconciliation sweep -------------------------------------------------------------

export interface ReconciliationSweepOptions {
  runId: string | null;
  /** Without a provider, payments are not read; assessment and invoices still run. */
  provider?: PaymentProvider | null;
  batchSize?: number;
  tenantLimit?: number;
  budgetMs?: number;
  clock?: () => number;
  onTenantError?: (tenantId: string, error: unknown) => void;
  onStampError?: (tenantId: string, error: unknown) => void;
}

export interface ReconciliationSweepReport {
  tenants: number;
  assessed: number;
  invoiced: number;
  paymentsChecked: number;
  paymentsRaised: number;
  failedTenants: number;
  turns: number;
  passes: number;
  deferredTenants: number;
  stampFailures: number;
  complete: boolean;
}

/**
 * The reconciliation sweep, in fair turns across tenants: assess closed
 * bookings, draft any invoice whose month has ended, and read the provider
 * about pending payments past their hold.
 */
export async function sweepReconciliation(
  db: Kysely<Database>,
  options: ReconciliationSweepOptions,
): Promise<ReconciliationSweepReport> {
  const clock = options.clock ?? Date.now;
  const batchSize = options.batchSize ?? 50;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500) {
    throw new RangeError("batchSize is a whole number from 1 to 500");
  }
  const tenantLimit = options.tenantLimit ?? 100;
  const report = { assessed: 0, invoiced: 0, paymentsChecked: 0, paymentsRaised: 0 };
  const contextOf = (tenantId: string): TenantContext => ({
    tenantId,
    actorType: "system",
    actorId: "reconciliation-sweep",
    requestId: options.runId,
  });
  // A payment read once per run.
  const checked = new Map<string, Set<string>>();
  const fair = await runFairSweep({
    listTenants: async () => {
      const { rows } = await sql<{ tenant_id: string }>`
        select tenant_id from app.reconciliation_tenants(${tenantLimit})`.execute(db);
      return rows.map((r) => r.tenant_id);
    },
    tenantLimit,
    stamp: (tenantId) => recordSweepTurn(db, contextOf(tenantId), "reconciliation"),
    budgetMs: options.budgetMs ?? 10_000,
    clock,
    turn: async (tenantId) => {
      const ctx = contextOf(tenantId);
      let units = 0;
      let more = false;
      const assessment = await inTenantTransaction(db, ctx, (trx) =>
        assessClosedBookings(trx, ctx, batchSize),
      );
      report.assessed += assessment.assessed;
      units += assessment.assessed;
      more ||= assessment.more;
      // Catch up at most a year of months a turn.
      for (let i = 0; i < 12; i++) {
        const invoice = await inTenantTransaction(db, ctx, (trx) => issueNextInvoice(trx, ctx));
        if (!invoice) break;
        report.invoiced += 1;
        units += 1;
        if (i === 11) more = true;
      }
      if (options.provider) {
        const seen = checked.get(tenantId) ?? new Set<string>();
        checked.set(tenantId, seen);
        const due = await inTenantTransaction(db, ctx, (trx) =>
          paymentsDueCheck(trx, tenantId, batchSize + 1, [...seen]),
        );
        for (const paymentId of due.slice(0, batchSize)) {
          seen.add(paymentId);
          const result = await checkPendingPayment(db, options.provider, ctx, paymentId);
          report.paymentsChecked += 1;
          if (result.kind === "raised") report.paymentsRaised += 1;
          units += 1;
        }
        more ||= due.length > batchSize;
      }
      return { units, more };
    },
    onTenantError: (tenantId, error, during) => {
      if (during === "stamp") options.onStampError?.(tenantId, error);
      else options.onTenantError?.(tenantId, error);
    },
  });
  return {
    tenants: fair.tenants,
    ...report,
    failedTenants: fair.failedTenants,
    turns: fair.turns,
    passes: fair.passes,
    deferredTenants: fair.deferredTenants,
    stampFailures: fair.stampFailures,
    complete: fair.complete,
  };
}

function clampLimit(limit: number): number {
  return Math.max(1, Math.min(Math.trunc(limit) || 1, 500));
}
