/**
 * Money movements for a date range (W3-G2.12-rest) on the local PostgreSQL:
 * every ledger's entries in the range, one row each, by business date in the
 * operator's zone, with control totals that match each ledger summed apart
 * and the fee the monthly invoice computes. Another tenant's entries never
 * appear; a range too long or too full is refused, never cut short.
 */
import { randomUUID } from "node:crypto";
import {
  createDb,
  inTenantTransaction,
  type TenantContext,
  type TenantTransaction,
} from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import { tripAllocator } from "@tidegrid/domain-inventory/testing";
import type { FakePaymentProvider } from "@tidegrid/domain-payments";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { renderMoneyExport } from "./csv.ts";
import {
  adjustCredit,
  assessClosedBookings,
  buildMoneyReport,
  controlsAgree,
  MONEY_ENTRY_KINDS,
  previewStaffCancellation,
  recordExternalSettlement,
  settleRefund,
  staffCancelBooking,
} from "./index.ts";
import {
  type CheckoutFixture,
  confirmBooking,
  createCheckoutFixture,
  fakeProvider,
} from "./test-fixtures.ts";

type Sql = ReturnType<typeof postgres>;

const env = inject("integrationDb");

const staffContext = (tenantId: string): TenantContext => ({
  tenantId,
  actorType: "staff",
  actorId: "staff-money",
  requestId: `req-${randomUUID()}`,
});
/** What owners and booking staff see: typed references, provider ids in full. */
const full = { typedReferences: true, maskProviderReferences: false } as const;

const systemContext = (tenantId: string): TenantContext => ({
  tenantId,
  actorType: "system",
  actorId: "test-money",
  requestId: `req-${randomUUID()}`,
});

describe.skipIf(!env)("money movements for a date range (W3-G2.12-rest)", () => {
  let admin: Sql;
  let runtime: ReturnType<typeof createDb>;
  let payments: FakePaymentProvider;
  let A: CheckoutFixture;
  let B: CheckoutFixture;
  let daysBack = 1;

  const as = <T>(
    ctx: TenantContext,
    fn: (trx: TenantTransaction, ctx: TenantContext) => Promise<T>,
  ): Promise<T> => inTenantTransaction(runtime.db, ctx, (trx) => fn(trx, ctx));

  async function today(zone: string): Promise<string> {
    const [row] = await admin<{ d: string }[]>`
      select (now() at time zone ${zone})::date::text as d`;
    return row?.d ?? "";
  }

  /** Move a booking's trip into the past, each to its own day so boats never overlap. */
  async function endTrip(bookingId: string) {
    daysBack += 1;
    await admin`
      with t as (select date_trunc('minute', now()) - make_interval(days => ${daysBack}) as s)
      update public.scheduled_trips st
         set starts_at = t.s, ends_at = t.s + make_interval(mins => st.duration_minutes),
             boat_free_at = t.s + (st.boat_free_at - st.starts_at),
             local_date = (t.s at time zone st.time_zone)::date,
             local_start_time = (t.s at time zone st.time_zone)::time(0)
        from t, public.bookings b
       where b.id = ${bookingId} and st.id = b.trip_id`;
  }

  /** Move a ledger row's time, as if it was written then. Admin only, triggers off. */
  async function backdate(table: string, column: string, id: string, at: string) {
    await admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update ${tx(`public.${table}`)} set ${tx(column)} = ${at}::timestamptz
                where id = ${id}`;
    });
  }

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 2, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 6 });
    payments = fakeProvider(runtime.db);
    A = await createCheckoutFixture(admin, runtime.db, "money-a");
    B = await createCheckoutFixture(admin, runtime.db, "money-b");
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end({ timeout: 5 });
  });

  it("lists every ledger's entries for the range, and its totals match each ledger", async () => {
    const trips = tripAllocator(A);
    const staff = staffContext(A.id);
    const kept = await confirmBooking(runtime.db, payments, A, trips.shared(), 2);
    const refunded = await confirmBooking(runtime.db, payments, A, trips.shared(), 1);
    const credited = await confirmBooking(runtime.db, payments, A, trips.shared(), 1);

    // A card refund that succeeded, with its fee reversal.
    const cancel = await as(staff, async (trx, c) => {
      const preview = await previewStaffCancellation(trx, A.id, refunded.bookingId);
      if (!preview?.refund) throw new Error("no refund to preview");
      return staffCancelBooking(trx, c, {
        bookingId: refunded.bookingId,
        choice: { kind: "policy", remedy: preview.terms.remedy },
        expectedAmount: preview.refund.amount,
      });
    });
    if (cancel.kind !== "canceled" || !cancel.cancellation.refundId) {
      throw new Error(JSON.stringify(cancel));
    }
    expect(
      (await settleRefund(runtime.db, payments, staff, cancel.cancellation.refundId)).kind,
    ).toBe("succeeded");
    // Booking credit instead of a refund.
    const credit = await as(staff, async (trx, c) => {
      const preview = await previewStaffCancellation(trx, A.id, credited.bookingId);
      return staffCancelBooking(trx, c, {
        bookingId: credited.bookingId,
        choice: { kind: "credit" },
        expectedAmount: preview?.credit?.amount ?? 0,
      });
    });
    if (credit.kind !== "canceled") throw new Error(JSON.stringify(credit));
    // Staff take part of that credit back by hand.
    const [account] = await admin<{ id: string }[]>`
      select account_id as id from public.credit_entries
       where tenant_id = ${A.id} and booking_id = ${credited.bookingId}`;
    expect(
      (
        await as(staff, (trx, c) =>
          adjustCredit(trx, c, {
            accountId: account?.id ?? "",
            amount: -100,
            reason: "Goodwill reversed",
            idempotencyKey: `money:${randomUUID()}`,
          }),
        )
      ).kind,
    ).toBe("applied");
    // Cash in, a check back, and TideGrid's fee on the closed bookings.
    for (const input of [
      {
        kind: "payment" as const,
        tender: "cash" as const,
        amount: 1_200,
        tenderReference: "001234",
      },
      {
        kind: "refund" as const,
        tender: "check" as const,
        amount: 500,
        tenderReference: "=HYPERLINK(1)",
      },
    ]) {
      const done = await as(staff, (trx, c) =>
        recordExternalSettlement(trx, c, {
          bookingId: kept.bookingId,
          reason: "At the dock",
          idempotencyKey: `money:${randomUUID()}`,
          ...input,
        }),
      );
      expect(done.kind).toBe("recorded");
    }
    await endTrip(kept.bookingId);
    expect(
      (await as(systemContext(A.id), (trx, c) => assessClosedBookings(trx, c, 50))).assessed,
    ).toBeGreaterThanOrEqual(2);

    const day = await today("UTC");
    const outcome = await as(staff, (trx) =>
      buildMoneyReport(trx, A.id, { from: day, to: day, ...full }),
    );
    if (outcome.kind !== "ok") throw new Error(outcome.kind);
    const r = outcome.report;
    expect(r.timeZone).toBe("UTC");
    expect(r.controlTotalsMatch).toBe(true);
    expect(r.byKind.map((k) => k.kind)).toEqual([...MONEY_ENTRY_KINDS]);
    const count = (kind: string) => r.byKind.find((k) => k.kind === kind)?.count;
    expect(count("card_payment")).toBe(3);
    expect(count("card_refund")).toBe(1);
    expect(count("fee_reversed")).toBe(1);
    expect(count("credit_issued")).toBe(1);
    expect(count("credit_adjusted")).toBe(1);
    expect(r.byKind.find((k) => k.kind === "credit_adjusted")?.credit).toBe(-100);
    expect(count("external_payment")).toBe(1);
    expect(count("external_refund")).toBe(1);
    expect(count("fee_assessed")).toBeGreaterThanOrEqual(2);
    expect(r.entries.every((e) => e.businessDate === day)).toBe(true);

    // The totals, against the ledgers read straight by the admin.
    const [ledger] = await admin<
      {
        paid: string;
        refunded: string;
        cash_in: string;
        cash_out: string;
        credit: string;
        fee: string;
      }[]
    >`
      select
        (select coalesce(sum(amount), 0) from public.payments
          where tenant_id = ${A.id} and state = 'succeeded')::text as paid,
        (select coalesce(sum(amount), 0) from public.payment_refunds
          where tenant_id = ${A.id} and state = 'succeeded')::text as refunded,
        (select coalesce(sum(amount), 0) from public.external_settlements
          where tenant_id = ${A.id} and kind = 'payment')::text as cash_in,
        (select coalesce(sum(amount), 0) from public.external_settlements
          where tenant_id = ${A.id} and kind = 'refund')::text as cash_out,
        (select coalesce(sum(amount), 0) from public.credit_entries
          where tenant_id = ${A.id})::text as credit,
        ((select coalesce(sum(fee_amount), 0) from public.fee_assessments where tenant_id = ${A.id})
         + (select coalesce(sum(fee_amount), 0) from public.fee_ledger_entries where tenant_id = ${A.id})
         + (select coalesce(sum(fee_amount), 0) from public.external_settlements
             where tenant_id = ${A.id} and kind = 'refund'))::text as fee`;
    expect(r.totals.moneyIn).toBe(Number(ledger?.paid) + Number(ledger?.cash_in));
    expect(r.totals.moneyOut).toBe(Number(ledger?.refunded) + Number(ledger?.cash_out));
    expect(r.totals.netMoney).toBe(r.totals.moneyIn - r.totals.moneyOut);
    expect(r.totals.credit).toBe(Number(ledger?.credit));
    expect(r.totals.fee).toBe(Number(ledger?.fee));
    expect(r.ledgerFeeTotal).toBe(r.totals.fee);
    expect(r.totals.fee).toBeGreaterThan(0);

    // Each card entry names its booking and the provider's id; external money its tender.
    const refundRow = r.entries.find((e) => e.kind === "card_refund");
    expect(refundRow).toMatchObject({
      booking: { bookingId: refunded.bookingId, source: "direct" },
      tender: null,
    });
    expect(refundRow?.reference).toMatch(/^[A-Za-z0-9_]+$/);
    expect(r.entries.find((e) => e.kind === "external_refund")).toMatchObject({
      tender: "check",
      reference: "=HYPERLINK(1)",
      moneyOut: 500,
    });

    // The CSV: a row per entry, then the totals, a typed reference neutralized.
    const csv = renderMoneyExport(r, { name: "Money A" });
    const lines = csv.replace(/^﻿/, "").trimEnd().split("\r\n");
    expect(lines).toHaveLength(r.entries.length + 2);
    expect(lines[0]?.split(",")[0]).toBe("Row");
    expect(csv).toContain(",'=HYPERLINK(1),");
    // A number-shaped receipt number keeps its leading zeros in a spreadsheet.
    expect(csv).toContain(",'001234,");
    const total = lines.at(-1)?.split(",") ?? [];
    expect(total[0]).toBe("Total");
    expect(total[7]).toBe("");
    expect(total[18]).toBe(String(r.totals.entries));
    expect(lines[1]?.split(",")[18]).toBe("1");
    // Each entry's moment to the millisecond, as the report has it.
    const first = r.entries[0];
    if (!first) throw new Error("no entries");
    expect(lines[1]?.split(",")[6]).toBe(
      new Date(first.at).toISOString().slice(0, 23).replace("T", " "),
    );
    expect(total[12]).toBe((r.totals.moneyIn / 100).toFixed(2));
    expect(total[13]).toBe((r.totals.moneyOut / 100).toFixed(2));
    expect(csv).not.toContain("@");

    // A role that does not see guests gets no typed reference; support sees provider ids masked.
    const limited = await as(staff, (trx) =>
      buildMoneyReport(trx, A.id, {
        from: day,
        to: day,
        typedReferences: false,
        maskProviderReferences: true,
      }),
    );
    if (limited.kind !== "ok") throw new Error(limited.kind);
    expect(limited.report.entries.find((e) => e.kind === "external_refund")?.reference).toBeNull();
    const masked = limited.report.entries.find((e) => e.kind === "card_refund")?.reference;
    expect(masked).not.toBe(refundRow?.reference);
    expect(masked).toContain("•");
    expect(limited.report.totals).toEqual(r.totals);
    expect(renderMoneyExport(limited.report, { name: "Money A" })).not.toContain("HYPERLINK");

    // Another tenant's range is its own: B has its own payment, and none of A's entries.
    await confirmBooking(runtime.db, payments, B, tripAllocator(B).shared(), 1);
    const other = await as(staffContext(B.id), (trx) =>
      buildMoneyReport(trx, B.id, { from: day, to: day, ...full }),
    );
    if (other.kind !== "ok") throw new Error(other.kind);
    const ids = new Set(r.entries.map((e) => e.entryId));
    expect(other.report.entries.length).toBeGreaterThan(0);
    expect(other.report.entries.some((e) => ids.has(e.entryId))).toBe(false);
    expect(other.report.controlTotalsMatch).toBe(true);
    // Asked inside A's tenancy for B's id, row-level security leaves nothing.
    const crossed = await as(staff, (trx) =>
      buildMoneyReport(trx, B.id, { from: day, to: day, ...full }),
    );
    expect(crossed).toMatchObject({
      kind: "ok",
      report: { entries: [], controlTotalsMatch: true },
    });
    // The control is a real comparison: one cent off on one kind fails it.
    const off = r.ledger.map((k) =>
      k.kind === "card_payment" ? { ...k, moneyIn: k.moneyIn + 1 } : k,
    );
    expect(controlsAgree(r.byKind, r.ledger, r.ledgerFeeTotal)).toBe(true);
    expect(controlsAgree(r.byKind, off, r.ledgerFeeTotal)).toBe(false);
    expect(controlsAgree(r.byKind, r.ledger, r.ledgerFeeTotal + 1)).toBe(false);
  });

  it("counts business dates in the billing plan's zone, and keeps the exact moment", async () => {
    const T = await createCheckoutFixture(admin, runtime.db, "money-tz");
    const booked = await confirmBooking(runtime.db, payments, T, tripAllocator(T).shared(), 1);
    const [pay] = await admin<{ id: string }[]>`
      select payment_id as id from public.bookings where id = ${booked.bookingId}`;
    // 03:30 UTC on Nov 5 is 22:30 on Nov 4 in New York.
    await backdate("payments", "succeeded_at", pay?.id ?? "", "2026-11-05T03:30:00Z");
    const read = (from: string, to: string) =>
      as(staffContext(T.id), (trx) => buildMoneyReport(trx, T.id, { from, to, ...full }));

    // Without a plan, the one location's zone: UTC.
    const utc = await read("2026-11-05", "2026-11-05");
    expect(utc).toMatchObject({ kind: "ok", report: { timeZone: "UTC" } });
    if (utc.kind !== "ok") throw new Error(utc.kind);
    expect(utc.report.entries.map((e) => e.kind)).toEqual(["card_payment"]);

    await admin`
      insert into public.billing_plans (tenant_id, monthly_fee, annual_minimum, starts_on, time_zone)
      values (${T.id}, 500, 0, '2026-01-01', 'America/New_York')`;
    const nov4 = await read("2026-11-04", "2026-11-04");
    if (nov4.kind !== "ok") throw new Error(nov4.kind);
    expect(nov4.report.timeZone).toBe("America/New_York");
    expect(nov4.report.entries).toHaveLength(1);
    expect(nov4.report.entries[0]).toMatchObject({
      businessDate: "2026-11-04",
      at: "2026-11-05T03:30:00.000Z",
    });
    expect(nov4.report.controlTotalsMatch).toBe(true);
    const nov5 = await read("2026-11-05", "2026-11-05");
    expect(nov5).toMatchObject({ kind: "ok", report: { entries: [] } });
    // Exactly at local midnight belongs to the day that starts then; Nov 1 2026
    // in New York is 25 hours long (clocks fall back), and its end is the next midnight.
    await backdate("payments", "succeeded_at", pay?.id ?? "", "2026-11-02T05:00:00Z");
    const nov1 = await read("2026-11-01", "2026-11-01");
    const nov2 = await read("2026-11-02", "2026-11-02");
    expect(nov1).toMatchObject({ kind: "ok", report: { entries: [] } });
    expect(nov2).toMatchObject({
      kind: "ok",
      report: { entries: [{ businessDate: "2026-11-02", at: "2026-11-02T05:00:00.000Z" }] },
    });
    await backdate("payments", "succeeded_at", pay?.id ?? "", "2026-11-02T04:59:59Z");
    expect(await read("2026-11-01", "2026-11-01")).toMatchObject({
      kind: "ok",
      report: { entries: [{ businessDate: "2026-11-01" }] },
    });
  });

  it("refuses a range backwards or longer than 92 days, and one too full, never cut short", async () => {
    const read = (query: { from: string; to: string; limit?: number }) =>
      as(staffContext(A.id), (trx) => buildMoneyReport(trx, A.id, { ...query, ...full }));
    expect(await read({ from: "2026-11-02", to: "2026-11-01" })).toEqual({ kind: "invalid_range" });
    expect(await read({ from: "2026-01-01", to: "2026-04-03" })).toEqual({ kind: "invalid_range" });
    expect(await read({ from: "2026-02-30", to: "2026-03-01" })).toEqual({ kind: "invalid_range" });
    expect(await read({ from: "2026-13-01", to: "2026-13-02" })).toEqual({ kind: "invalid_range" });
    expect((await read({ from: "2026-01-01", to: "2026-04-02" })).kind).toBe("ok");
    const day = await today("UTC");
    expect(await read({ from: day, to: day, limit: 1 })).toEqual({ kind: "too_large" });
  });
});
