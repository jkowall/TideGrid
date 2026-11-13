/**
 * Money movements for a date range (W3-G2.12-rest, docs/v2/02 "Reports and
 * exports"): every entry in the money ledgers whose moment falls on the
 * operator's business dates `from` to `to`, one row each, with the range's
 * control totals. The console reads the totals; the CSV export carries the
 * rows and the totals as its last row.
 *
 * The ledgers, each row one entry:
 *
 * - money in: a card payment that succeeded, a balance payment that
 *   succeeded, and money recorded outside the card flow (cash, check, other);
 * - money out: a card refund that succeeded, an external refund, and a card
 *   dispute the operator lost;
 * - booking credit: each entry in the credit ledger (issued, used,
 *   reinstated, adjusted), signed as the ledger holds it;
 * - TideGrid's fee: each assessment, each card refund's reversal, and an
 *   external refund's reversal (on that refund's own row).
 *
 * The business date is the entry's moment in the operator's time zone: the
 * billing plan's, else the one zone all the operator's active locations
 * share, else UTC. The exact moment stays on each row.
 *
 * Everything comes from one statement, so the rows and the control figures
 * are one moment even under READ COMMITTED. The control figures are a second,
 * separate count and sum of each ledger, plus TideGrid's fee as the monthly
 * invoice computes it (app.fee_ledger_total). They use the same tables and
 * filters as the rows, so `controlTotalsMatch` proves the export is whole
 * and that the report and the invoice agree on the fee; it does not find a
 * ledger both leave out, and it does not tie money to orders (the day export
 * does that, by trip date). No guest's name or email is read.
 *
 * Who sees what (W3-G2.12-rest security review): a check or receipt number
 * staff typed is free text that may name a guest, so it is read only for
 * roles that hold `bookings.read`, as the external settlements list does
 * (`typedReferences`). TideGrid support reads provider ids masked
 * (`maskProviderReferences`), as the console shows them.
 */
import type { BookingSource, TenantTransaction } from "@tidegrid/database";
import { sql } from "kysely";
import { maskProviderReference } from "./console.ts";
import { iso } from "./views.ts";

/** More entries than this in one range is refused rather than cut short. */
export const MONEY_REPORT_LIMIT = 5000;
/** The longest range one report covers, in days: about a quarter. */
export const MONEY_REPORT_MAX_DAYS = 92;

export const MONEY_ENTRY_KINDS = [
  "card_payment",
  "balance_payment",
  "external_payment",
  "card_refund",
  "external_refund",
  "dispute_lost",
  "credit_issued",
  "credit_used",
  "credit_reinstated",
  "credit_adjusted",
  "fee_assessed",
  "fee_reversed",
] as const;
export type MoneyEntryKind = (typeof MONEY_ENTRY_KINDS)[number];

export interface MoneyFigures {
  /** Money received, in cents. */
  moneyIn: number;
  /** Money returned or taken back, in cents, as a positive amount. */
  moneyOut: number;
  /** Booking credit's change, signed: issued and reinstated add, used takes away. */
  credit: number;
  /** TideGrid's fee, signed: an assessment adds, a reversal takes away. */
  fee: number;
}

export interface MoneyEntry extends MoneyFigures {
  entryId: string;
  kind: MoneyEntryKind;
  /** The exact moment the ledger records. */
  at: string;
  /** That moment's date in the report's time zone. */
  businessDate: string;
  /** Null for a card payment that never became a booking. */
  booking: { bookingId: string; reference: string; source: BookingSource } | null;
  /** Cash, check, or other, for money recorded outside the card flow. */
  tender: "cash" | "check" | "other" | null;
  /**
   * The provider's payment, refund, or dispute id, or the check or receipt
   * number staff typed for external money.
   */
  reference: string | null;
}

export interface MoneyKindTotals extends MoneyFigures {
  kind: MoneyEntryKind;
  count: number;
}

export interface MoneyTotals extends MoneyFigures {
  entries: number;
  /** moneyIn - moneyOut. */
  netMoney: number;
}

export interface MoneyReport {
  from: string;
  to: string;
  timeZone: string;
  generatedAt: string;
  entries: MoneyEntry[];
  /** Summed from the rows, every kind listed whether or not it has any. */
  byKind: MoneyKindTotals[];
  totals: MoneyTotals;
  /** The same figures, summed by the database straight from each ledger. */
  ledger: MoneyKindTotals[];
  /** TideGrid's fee for the range as the invoices compute it (app.fee_ledger_total). */
  ledgerFeeTotal: number;
  /**
   * Every kind's rows add up to the separate count and sum of its ledger, and
   * the fee to the invoice's figure: the export is whole. Not a tie to orders.
   */
  controlTotalsMatch: boolean;
}

export type MoneyReportOutcome =
  | { kind: "ok"; report: MoneyReport }
  | { kind: "invalid_range" }
  | { kind: "too_large" };

const zero = (): MoneyFigures => ({ moneyIn: 0, moneyOut: 0, credit: 0, fee: 0 });

const datePattern = /^\d{4}-\d{2}-\d{2}$/;

/** Whole days from `from` to `to`, or NaN for a date that is not one. */
function daysBetween(from: string, to: string): number {
  if (!datePattern.test(from) || !datePattern.test(to)) return Number.NaN;
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.NaN;
  // Date.parse rolls 2026-02-30 over; a date that does not survive the round trip is not one.
  if (new Date(a).toISOString().slice(0, 10) !== from) return Number.NaN;
  if (new Date(b).toISOString().slice(0, 10) !== to) return Number.NaN;
  return Math.round((b - a) / 86_400_000);
}

interface EntryJson {
  id: string;
  kind: MoneyEntryKind;
  at: string;
  business_date: string;
  booking_id: string | null;
  reference: string | null;
  source: BookingSource | null;
  tender: MoneyEntry["tender"];
  ref: string | null;
  money_in: number;
  money_out: number;
  credit: number;
  fee: number;
}

interface LedgerJson {
  kind: MoneyEntryKind;
  count: number;
  money_in: number;
  money_out: number;
  credit: number;
  fee: number;
}

interface ReportRow {
  time_zone: string;
  generated_at: Date | string;
  entry_count: number;
  entries: EntryJson[] | null;
  ledger: LedgerJson[] | null;
  ledger_fee_total: string;
}

/** Each kind's figures summed over `entries`, in MONEY_ENTRY_KINDS order. */
export function totalsByKind(entries: readonly MoneyEntry[]): MoneyKindTotals[] {
  const byKind = new Map<MoneyEntryKind, MoneyKindTotals>(
    MONEY_ENTRY_KINDS.map((kind) => [kind, { kind, count: 0, ...zero() }]),
  );
  for (const e of entries) {
    const t = byKind.get(e.kind);
    if (!t) throw new Error(`unknown money entry kind ${e.kind}`);
    t.count += 1;
    t.moneyIn += e.moneyIn;
    t.moneyOut += e.moneyOut;
    t.credit += e.credit;
    t.fee += e.fee;
  }
  return [...byKind.values()];
}

/** The range's totals from its kinds. Integer cents throughout. */
export function moneyTotalsOf(byKind: readonly MoneyKindTotals[]): MoneyTotals {
  const totals: MoneyTotals = { entries: 0, netMoney: 0, ...zero() };
  for (const t of byKind) {
    totals.entries += t.count;
    totals.moneyIn += t.moneyIn;
    totals.moneyOut += t.moneyOut;
    totals.credit += t.credit;
    totals.fee += t.fee;
  }
  totals.netMoney = totals.moneyIn - totals.moneyOut;
  return totals;
}

const sameFigures = (a: MoneyKindTotals, b: MoneyKindTotals) =>
  a.kind === b.kind &&
  a.count === b.count &&
  a.moneyIn === b.moneyIn &&
  a.moneyOut === b.moneyOut &&
  a.credit === b.credit &&
  a.fee === b.fee;

/**
 * Whether the rows' figures by kind equal the ledgers' own, kind for kind in
 * MONEY_ENTRY_KINDS order, and their fee the invoice's fee total.
 */
export function controlsAgree(
  byKind: readonly MoneyKindTotals[],
  ledger: readonly MoneyKindTotals[],
  ledgerFeeTotal: number,
): boolean {
  if (byKind.length !== MONEY_ENTRY_KINDS.length || ledger.length !== byKind.length) return false;
  const fee = byKind.reduce((sum, t) => sum + t.fee, 0);
  return (
    byKind.every((t, i) => {
      const l = ledger[i];
      return t.kind === MONEY_ENTRY_KINDS[i] && l !== undefined && sameFigures(t, l);
    }) && ledgerFeeTotal === fee
  );
}

/**
 * The money entries on the operator's business dates `from` to `to`
 * (inclusive, at most MONEY_REPORT_MAX_DAYS apart), by moment, with their
 * control totals. More than `limit` entries (MONEY_REPORT_LIMIT unless a test
 * sets less) is `too_large`.
 */
export async function buildMoneyReport(
  trx: TenantTransaction,
  tenantId: string,
  query: {
    from: string;
    to: string;
    limit?: number;
    /** Read the check or receipt numbers staff typed: only for roles with bookings.read. */
    typedReferences: boolean;
    /** Show provider ids masked, as the console does: for TideGrid support. */
    maskProviderReferences: boolean;
  },
): Promise<MoneyReportOutcome> {
  const span = daysBetween(query.from, query.to);
  if (!Number.isFinite(span) || span < 0 || span >= MONEY_REPORT_MAX_DAYS) {
    return { kind: "invalid_range" };
  }
  const limit = Math.min(query.limit ?? MONEY_REPORT_LIMIT, MONEY_REPORT_LIMIT);
  const { rows } = await sql<ReportRow>`
    with zone as (
      select coalesce(
               (select time_zone::text from billing_plans where tenant_id = ${tenantId}),
               (select min(time_zone::text) from locations
                 where tenant_id = ${tenantId} and status = 'active'
                having count(distinct time_zone) = 1),
               'UTC') as tz
    ),
    bounds as (
      select zone.tz,
             (${query.from}::date)::timestamp at time zone zone.tz as f,
             (${query.to}::date + 1)::timestamp at time zone zone.tz as u
        from zone
    ),
    raw as (
      select p.id, 'card_payment'::text as kind, p.succeeded_at as at, b.id as booking_id,
             null::text as tender, p.provider_payment_id as ref,
             p.amount as money_in, 0 as money_out, 0 as credit, 0 as fee
        from payments p
        cross join bounds
        left join bookings b on b.tenant_id = p.tenant_id and b.payment_id = p.id
       where p.tenant_id = ${tenantId} and p.state = 'succeeded'
         and p.succeeded_at >= bounds.f and p.succeeded_at < bounds.u
      union all
      select x.id, 'balance_payment', x.succeeded_at, x.booking_id, null, x.provider_payment_id,
             x.amount, 0, 0, 0
        from balance_payments x, bounds
       where x.tenant_id = ${tenantId} and x.state = 'succeeded'
         and x.succeeded_at >= bounds.f and x.succeeded_at < bounds.u
      union all
      select x.id, 'external_' || x.kind, x.created_at, x.booking_id, x.tender,
             case when ${query.typedReferences}::boolean then x.tender_reference end,
             case when x.kind = 'payment' then x.amount else 0 end,
             case when x.kind = 'refund' then x.amount else 0 end,
             0, coalesce(x.fee_amount, 0)
        from external_settlements x, bounds
       where x.tenant_id = ${tenantId} and x.created_at >= bounds.f and x.created_at < bounds.u
         -- Imported money (0044) is an opening record, not money of the period.
         and x.import_record_id is null
      union all
      select r.id, 'card_refund', r.settled_at, b.id, null, r.provider_refund_id,
             0, r.amount, 0, 0
        from payment_refunds r
        cross join bounds
        left join bookings b on b.tenant_id = r.tenant_id and b.payment_id = r.payment_id
       where r.tenant_id = ${tenantId} and r.state = 'succeeded'
         and r.settled_at >= bounds.f and r.settled_at < bounds.u
      union all
      select d.id, 'dispute_lost', d.closed_at, b.id, null, d.dispute_ref,
             0, d.amount, 0, 0
        from payment_disputes d
        cross join bounds
        left join bookings b on b.tenant_id = d.tenant_id and b.payment_id = d.payment_id
       where d.tenant_id = ${tenantId} and d.status = 'lost'
         and d.closed_at >= bounds.f and d.closed_at < bounds.u
      union all
      select c.id,
             case c.kind when 'issue' then 'credit_issued' when 'redeem' then 'credit_used'
                         when 'reinstate' then 'credit_reinstated' else 'credit_adjusted' end,
             c.created_at, c.booking_id, null, null, 0, 0, c.amount, 0
        from credit_entries c, bounds
       where c.tenant_id = ${tenantId} and c.created_at >= bounds.f and c.created_at < bounds.u
      union all
      select a.id, 'fee_assessed', a.created_at, a.booking_id, null, null, 0, 0, 0, a.fee_amount
        from fee_assessments a, bounds
       where a.tenant_id = ${tenantId} and a.created_at >= bounds.f and a.created_at < bounds.u
      union all
      select l.id, 'fee_reversed', l.created_at, l.booking_id, null, null, 0, 0, 0, l.fee_amount
        from fee_ledger_entries l, bounds
       where l.tenant_id = ${tenantId} and l.created_at >= bounds.f and l.created_at < bounds.u
    ),
    entries as (
      select raw.*, to_char(raw.at at time zone bounds.tz, 'YYYY-MM-DD') as business_date
        from raw, bounds
    ),
    -- The control figures, straight from each ledger and apart from the rows.
    ledger as (
      select 'card_payment' as kind, count(*)::int as count,
             coalesce(sum(p.amount), 0)::bigint as money_in, 0::bigint as money_out,
             0::bigint as credit, 0::bigint as fee
        from payments p, bounds
       where p.tenant_id = ${tenantId} and p.state = 'succeeded'
         and p.succeeded_at >= bounds.f and p.succeeded_at < bounds.u
      union all
      select 'balance_payment', count(*)::int, coalesce(sum(x.amount), 0), 0, 0, 0
        from balance_payments x, bounds
       where x.tenant_id = ${tenantId} and x.state = 'succeeded'
         and x.succeeded_at >= bounds.f and x.succeeded_at < bounds.u
      union all
      select 'external_payment', count(*)::int, coalesce(sum(x.amount), 0), 0, 0, 0
        from external_settlements x, bounds
       where x.tenant_id = ${tenantId} and x.kind = 'payment' and x.import_record_id is null
         and x.created_at >= bounds.f and x.created_at < bounds.u
      union all
      select 'card_refund', count(*)::int, 0, coalesce(sum(r.amount), 0), 0, 0
        from payment_refunds r, bounds
       where r.tenant_id = ${tenantId} and r.state = 'succeeded'
         and r.settled_at >= bounds.f and r.settled_at < bounds.u
      union all
      select 'external_refund', count(*)::int, 0, coalesce(sum(x.amount), 0), 0,
             coalesce(sum(x.fee_amount), 0)
        from external_settlements x, bounds
       where x.tenant_id = ${tenantId} and x.kind = 'refund' and x.import_record_id is null
         and x.created_at >= bounds.f and x.created_at < bounds.u
      union all
      select 'dispute_lost', count(*)::int, 0, coalesce(sum(d.amount), 0), 0, 0
        from payment_disputes d, bounds
       where d.tenant_id = ${tenantId} and d.status = 'lost'
         and d.closed_at >= bounds.f and d.closed_at < bounds.u
      union all
      select k.kind, count(c.id)::int, 0, 0, coalesce(sum(c.amount), 0), 0
        from (values ('issue', 'credit_issued'), ('redeem', 'credit_used'),
                     ('reinstate', 'credit_reinstated'), ('adjust', 'credit_adjusted'))
             as k (ledger_kind, kind)
        cross join bounds
        left join credit_entries c
          on c.tenant_id = ${tenantId} and c.kind = k.ledger_kind
         and c.created_at >= bounds.f and c.created_at < bounds.u
       group by k.kind
      union all
      select 'fee_assessed', count(*)::int, 0, 0, 0, coalesce(sum(a.fee_amount), 0)
        from fee_assessments a, bounds
       where a.tenant_id = ${tenantId} and a.created_at >= bounds.f and a.created_at < bounds.u
      union all
      select 'fee_reversed', count(*)::int, 0, 0, 0, coalesce(sum(l.fee_amount), 0)
        from fee_ledger_entries l, bounds
       where l.tenant_id = ${tenantId} and l.created_at >= bounds.f and l.created_at < bounds.u
    ),
    limited as (
      select e.* from entries e order by e.at, e.kind, e.id limit ${limit + 1}
    )
    select bounds.tz as time_zone,
           statement_timestamp() as generated_at,
           (select count(*)::int from limited) as entry_count,
           (select json_agg(json_build_object(
                     'id', l.id, 'kind', l.kind, 'at', l.at, 'business_date', l.business_date,
                     'booking_id', l.booking_id, 'reference', b.reference, 'source', b.source,
                     'tender', l.tender, 'ref', l.ref,
                     'money_in', l.money_in, 'money_out', l.money_out,
                     'credit', l.credit, 'fee', l.fee)
                     order by l.at, l.kind, l.id)
              from limited l
              left join bookings b on b.tenant_id = ${tenantId} and b.id = l.booking_id) as entries,
           (select json_agg(json_build_object(
                     'kind', g.kind, 'count', g.count, 'money_in', g.money_in,
                     'money_out', g.money_out, 'credit', g.credit, 'fee', g.fee))
              from ledger g) as ledger,
           app.fee_ledger_total(${tenantId}, bounds.f, bounds.u)::text as ledger_fee_total
      from bounds`.execute(trx);
  const row = rows[0];
  if (!row) throw new Error("the money report's statement returned no row");
  if (row.entry_count > limit) return { kind: "too_large" };

  const entries = (row.entries ?? []).map(
    (e): MoneyEntry => ({
      entryId: e.id,
      kind: e.kind,
      at: iso(e.at),
      businessDate: e.business_date,
      booking:
        e.booking_id === null || e.reference === null || e.source === null
          ? null
          : { bookingId: e.booking_id, reference: e.reference, source: e.source },
      tender: e.tender,
      reference:
        e.kind === "external_payment" ||
        e.kind === "external_refund" ||
        !query.maskProviderReferences
          ? e.ref
          : maskProviderReference(e.ref),
      moneyIn: Number(e.money_in),
      moneyOut: Number(e.money_out),
      credit: Number(e.credit),
      fee: Number(e.fee),
    }),
  );
  const byKind = totalsByKind(entries);
  const ledgerByKind = new Map(
    (row.ledger ?? []).map((g): [MoneyEntryKind, MoneyKindTotals] => [
      g.kind,
      {
        kind: g.kind,
        count: Number(g.count),
        moneyIn: Number(g.money_in),
        moneyOut: Number(g.money_out),
        credit: Number(g.credit),
        fee: Number(g.fee),
      },
    ]),
  );
  const ledger = MONEY_ENTRY_KINDS.map(
    (kind) => ledgerByKind.get(kind) ?? { kind, count: 0, ...zero() },
  );
  const totals = moneyTotalsOf(byKind);
  const ledgerFeeTotal = Number(row.ledger_fee_total);
  const controlTotalsMatch = controlsAgree(byKind, ledger, ledgerFeeTotal);
  return {
    kind: "ok",
    report: {
      from: query.from,
      to: query.to,
      timeZone: row.time_zone,
      generatedAt: iso(row.generated_at),
      entries,
      byKind,
      totals,
      ledger,
      ledgerFeeTotal,
      controlTotalsMatch,
    },
  };
}
