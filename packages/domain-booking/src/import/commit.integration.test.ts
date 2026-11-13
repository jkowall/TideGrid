/**
 * Saving a standard CSV import batch (W3-G2.13, commit step, part A), against
 * the database: a clean dry run committed all or nothing, the import branches
 * of the booking rules reachable only through a commit, re-imports as no-ops,
 * and tenants kept apart.
 */
import { randomUUID } from "node:crypto";
import { createDb, inTenantTransaction, type TenantContext } from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import { sql } from "kysely";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { sendBalanceLink } from "../balance.ts";
import { getBookingBalance } from "../balance-read.ts";
import { cancelBooking, staffCancelBooking } from "../cancel.ts";
import { adjustCredit } from "../credits.ts";
import { inviteParticipant } from "../invitations.ts";
import { buildMoneyReport } from "../money-report.ts";
import { recordExternalSettlement } from "../reconciliation.ts";
import { type CheckoutFixture, createCheckoutFixture, guestContext } from "../test-fixtures.ts";
import { runImportCommit } from "./commit.ts";
import { runImportDryRun } from "./dry-run.ts";

type Sql = ReturnType<typeof postgres>;

const env = inject("integrationDb");

describe.skipIf(!env)("saving a standard CSV import (W3-G2.13, parts A and B)", () => {
  let admin: Sql;
  let runtime: ReturnType<typeof createDb>;
  let A: CheckoutFixture;
  let B: CheckoutFixture;
  let ownerA: string;
  let deskA: string;
  let ownerB: string;
  let day: string;
  let exportedAt: string;
  /** The day before the trips, when a charter's balance falls due. */
  let dueDay: string;
  let C: CheckoutFixture;
  let D: CheckoutFixture;
  let ownerC: string;
  let ownerD: string;

  async function member(tenantId: string, role: "owner" | "booking_staff"): Promise<string> {
    const id = randomUUID();
    await admin`insert into public.staff_users (id, email, display_name)
      values (${id}, ${`imc-${id.slice(0, 8)}@example.test`}, ${role})`;
    await admin`insert into public.tenant_memberships (tenant_id, user_id, role, display_name)
      values (${tenantId}, ${id}, ${role}, ${role})`;
    return id;
  }

  const staffCtx = (tenantId: string, userId: string): TenantContext => ({
    tenantId,
    actorType: "staff",
    actorId: userId,
    requestId: `req-${randomUUID()}`,
    sourceIp: null,
  });

  interface BatchOpts {
    batchId: string;
    run?: number;
    mode?: "dry_run" | "commit";
    /** Party on the 10:00 shared trip. */
    party?: number;
    /** Rows to leave out, by booking reference. */
    skip?: string[];
    /** A different name for C-1 (a changed row). */
    renameC1?: string;
    /** A further cash payment on R-2. */
    extraPayment?: boolean;
    /** What came in on the R-3 charter, when less than its total: it then owes a balance. */
    charterPaid?: number;
    /** A further check on the R-3 charter. */
    charterExtra?: number;
    /** A refund on the R-3 charter. */
    charterRefund?: number;
    /** An opening booking credit for C-1, in cents. */
    credit?: number;
  }

  /**
   * A batch on day+3: R-1 onto the fixture's 10:00 shared trip, R-2 onto a new
   * 14:00 shared trip, R-3 a charter paid in full, with participants, cash,
   * a check, and a refund.
   */
  function batch(t: CheckoutFixture, o: BatchOpts) {
    const party = o.party ?? 2;
    const skip = new Set(o.skip ?? []);
    const bookings = [
      ["R-1", `R-1,${day},T-AM,C-1,direct,,,${party},10000,0,0,0,0,10000,,${exportedAt}`],
      ["R-2", `R-2,${day},T-PM,C-2,staff_assisted,phone,,2,8000,0,0,0,0,8000,,`],
      [
        "R-3",
        `R-3,${day},T-CH,C-2,direct,,,3,50000,0,0,0,0,50000,${o.charterPaid === undefined ? "" : dueDay},`,
      ],
    ].filter(([ref]) => !skip.has(ref as string));
    const participants = [
      ["R-1", `R-1,${day},1,Ima Sample,false,ima.sample@example.test,,`],
      ["R-2", `R-2,${day},1,Jo Fixture,false,jo.fixture@example.test,,`],
      ["R-2", `R-2,${day},2,Kit Fixture,true,,Jo Fixture,jo.fixture@example.test`],
    ].filter(([ref]) => !skip.has(ref as string));
    const payments = [
      ["R-1", `PAY-1,R-1,${day},payment,12500,cash,,${exportedAt}`],
      ["R-1", `PAY-2,R-1,${day},refund,2500,cash,,${exportedAt}`],
      ...(o.charterPaid === 0
        ? []
        : [
            [
              "R-3",
              `PAY-3,R-3,${day},payment,${o.charterPaid ?? 50000},check,CHK-77,${exportedAt}`,
            ],
          ]),
      ...(o.charterExtra
        ? [["R-3", `PAY-8,R-3,${day},payment,${o.charterExtra},check,CHK-78,${exportedAt}`]]
        : []),
      ...(o.charterRefund
        ? [["R-3", `PAY-9,R-3,${day},refund,${o.charterRefund},check,CHK-79,${exportedAt}`]]
        : []),
      ["R-2", `PAY-4,R-2,${day},payment,8000,bank_transfer,,${exportedAt}`],
      ...(o.extraPayment ? [["R-2", `PAY-5,R-2,${day},payment,100,cash,,${exportedAt}`]] : []),
    ].filter(([ref]) => !skip.has(ref as string));
    const totals: Record<string, number> = { "R-1": 10000, "R-2": 8000, "R-3": 50000 };
    const parties: Record<string, number> = { "R-1": party, "R-2": 2, "R-3": 3 };
    const kept = bookings.map(([ref]) => ref as string);
    const paid = payments
      .filter(([, line]) => (line as string).includes(",payment,"))
      .reduce((n, [, line]) => n + Number((line as string).split(",")[4]), 0);
    const refunded = payments
      .filter(([, line]) => (line as string).includes(",refund,"))
      .reduce((n, [, line]) => n + Number((line as string).split(",")[4]), 0);
    const total = kept.reduce((n, ref) => n + (totals[ref] ?? 0), 0);
    return {
      "manifest.csv": [
        "item,file,value",
        `batch_id,,${o.batchId}`,
        `run_number,,${o.run ?? 1}`,
        "source_system,,legacy-booker",
        "mapping_version,,std-csv-v0",
        `batch_mode,,${o.mode ?? "dry_run"}`,
        "operator_time_zone,,UTC",
        `exported_at,,${exportedAt}`,
        "waiver_notifications,,hold_until_staff_release",
        "row_count,products.csv,2",
        "row_count,trips.csv,3",
        "sum_seat_capacity,trips.csv,20",
        "row_count,customers.csv,2",
        "rows_with_email,customers.csv,1",
        `row_count,bookings.csv,${kept.length}`,
        `rows_direct,bookings.csv,${kept.filter((ref) => ref !== "R-2").length}`,
        `rows_staff_assisted,bookings.csv,${kept.includes("R-2") ? 1 : 0}`,
        "rows_ota,bookings.csv,0",
        "sum_included_tax_cents,bookings.csv,0",
        `sum_party_size,bookings.csv,${kept.reduce((n, ref) => n + (parties[ref] ?? 0), 0)}`,
        `sum_total_cents,bookings.csv,${total}`,
        `row_count,participants.csv,${participants.length}`,
        `rows_minor,participants.csv,${participants.filter(([, line]) => (line as string).includes(",true,")).length}`,
        `row_count,payments.csv,${payments.length}`,
        `sum_payment_cents,payments.csv,${paid}`,
        `sum_refund_cents,payments.csv,${refunded}`,
        `sum_outstanding_cents,payments.csv,${total - paid + refunded}`,
        ...(o.credit
          ? [
              "row_count,opening_balances.csv,1",
              `sum_booking_credit_cents,opening_balances.csv,${o.credit}`,
              "sum_dollar_card_cents,opening_balances.csv,0",
              "sum_trip_count_units,opening_balances.csv,0",
            ]
          : []),
      ].join("\n"),
      "products.csv": [
        "source_product_id,source_product_name,tidegrid_product_id,tidegrid_product_name,product_kind",
        `P-SEATS,Legacy seats,${t.products.shared},Harbor Seats,shared_seat`,
        `P-CHARTER,Legacy charter,${t.products.charter},Wren Charter,private_charter`,
      ].join("\n"),
      "trips.csv": [
        "source_trip_id,source_product_id,tidegrid_boat_id,local_date,local_start_time,time_zone,utc_offset,seat_capacity",
        `T-AM,P-SEATS,${t.boats.lark},${day},10:00,UTC,,`,
        `T-PM,P-SEATS,${t.boats.lark},${day},14:00,UTC,,10`,
        `T-CH,P-CHARTER,${t.boats.wren},${day},14:00,UTC,,`,
      ].join("\n"),
      "customers.csv": [
        "source_customer_id,full_name,email,phone",
        `C-1,${o.renameC1 ?? "Ima Sample"},ima.sample@example.test,`,
        "C-2,Jo Fixture,,+15555550123",
      ].join("\n"),
      "bookings.csv": [
        "source_booking_ref,trip_date,source_trip_id,source_customer_id,booking_source,staff_channel,ota_channel,party_size,subtotal_cents,discount_cents,fee_cents,tax_cents,included_tax_cents,total_cents,balance_due_date,booked_at",
        ...bookings.map(([, line]) => line),
      ].join("\n"),
      "participants.csv": [
        "source_booking_ref,trip_date,position,full_name,is_minor,email,guardian_name,guardian_email",
        ...participants.map(([, line]) => line),
      ].join("\n"),
      "payments.csv": [
        "source_payment_id,source_booking_ref,trip_date,entry_kind,amount_cents,tender,reference,received_at",
        ...payments.map(([, line]) => line),
      ].join("\n"),
      ...(o.credit
        ? {
            "opening_balances.csv": [
              "source_balance_id,source_customer_id,balance_kind,lot_kind,amount_cents,units,eligible_source_product_ids,expires_on,source_card_ref",
              `OB-1,C-1,booking_credit,,${o.credit},,,,`,
            ].join("\n"),
          }
        : {}),
    };
  }

  async function dryRun(t: CheckoutFixture, user: string, o: BatchOpts) {
    const ctx = staffCtx(t.id, user);
    const result = await inTenantTransaction(runtime.db, ctx, (trx) =>
      runImportDryRun(trx, ctx, batch(t, { ...o, mode: "dry_run" })),
    );
    if (result.kind !== "checked") throw new Error(JSON.stringify(result));
    return result;
  }

  async function commit(t: CheckoutFixture, user: string, o: BatchOpts) {
    const ctx = staffCtx(t.id, user);
    return inTenantTransaction(runtime.db, ctx, (trx) =>
      runImportCommit(trx, ctx, batch(t, { ...o, mode: "commit" })),
    );
  }

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 4, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 6 });
    [A, B] = await Promise.all([
      createCheckoutFixture(admin, runtime.db, "imc-a", { days: 6 }),
      createCheckoutFixture(admin, runtime.db, "imc-b", { days: 6 }),
    ]);
    [C, D] = await Promise.all([
      createCheckoutFixture(admin, runtime.db, "imc-c", { days: 6 }),
      createCheckoutFixture(admin, runtime.db, "imc-d", { days: 6 }),
    ]);
    ownerC = await member(C.id, "owner");
    ownerD = await member(D.id, "owner");
    ownerA = await member(A.id, "owner");
    deskA = await member(A.id, "booking_staff");
    ownerB = await member(B.id, "owner");
    const [clock] = await admin<{ day: string; due: string; exported: string }[]>`
      select ((now() at time zone 'UTC')::date + 3)::text as day,
             ((now() at time zone 'UTC')::date + 2)::text as due,
             to_char((now() - interval '1 hour') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as exported`;
    day = clock?.day ?? "";
    exportedAt = clock?.exported ?? "";
    dueDay = clock?.due ?? "";
  }, 180_000);

  afterAll(async () => {
    await runtime?.end();
    await admin?.end({ timeout: 5 });
  });

  it("commits a clean dry run: trips, bookings, participants, and money, with no email", async () => {
    const dry = await dryRun(A, ownerA, { batchId: "SAVE-1" });
    expect(dry.result.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(dry.result.clean).toBe(true);
    const [emailsBefore] = await admin<{ n: number }[]>`
      select count(*)::int as n from public.email_messages where tenant_id = ${A.id}`;

    const saved = await commit(A, ownerA, { batchId: "SAVE-1", run: 2 });
    if (saved.kind !== "committed") throw new Error(JSON.stringify(saved));
    expect(saved.counts).toEqual({
      trips: 3,
      tripsCreated: 2,
      customers: 2,
      bookings: 3,
      participants: 3,
      payments: 3,
      refunds: 1,
      credits: 0,
      unchanged: 0,
    });

    const rows = await admin<
      {
        ref: string;
        source: string;
        payment_id: string | null;
        checkout_source: string;
        quote_id: string | null;
        booker_name: string;
        booker_email: string | null;
        checkout_state: string;
        order_status: string;
        total_amount: number;
        lines: number;
        hold_state: string;
        sales_state: string;
        seats: number;
      }[]
    >`
      select br.external_id as ref, b.source, b.payment_id, s.source as checkout_source,
             s.quote_id, s.booker_name, s.booker_email, s.state as checkout_state,
             o.status as order_status, o.total_amount,
             (select count(*) from public.order_lines l where l.order_id = o.id)::int as lines,
             h.state as hold_state, t.sales_state, h.seats
        from public.import_bookings ib
        join public.import_records br on br.id = ib.record_id
        join public.bookings b on b.checkout_session_id = ib.checkout_session_id
        join public.checkout_sessions s on s.id = b.checkout_session_id
        join public.orders o on o.id = b.order_id
        join public.capacity_holds h on h.id = b.hold_id
        join public.scheduled_trips t on t.id = b.trip_id
       where ib.tenant_id = ${A.id} and br.run_id = ${saved.runId}
       order by br.external_id`;
    expect(rows.map((r) => r.ref)).toEqual(["R-1", "R-2", "R-3"]);
    for (const r of rows) {
      expect(r).toMatchObject({
        source: "imported",
        payment_id: null,
        checkout_source: "imported",
        quote_id: null,
        checkout_state: "confirmed",
        order_status: "paid",
        lines: 0,
        hold_state: "confirmed",
      });
    }
    // The fixture's 10:00 trip is published; the two new ones wait in draft.
    expect(rows.map((r) => r.sales_state)).toEqual(["published", "draft", "draft"]);
    expect(rows[0]).toMatchObject({
      booker_name: "Ima Sample",
      booker_email: "ima.sample@example.test",
    });
    // A customer without an email books with none.
    expect(rows[1]).toMatchObject({ booker_name: "Jo Fixture", booker_email: null, seats: 2 });
    // A charter takes the whole boat.
    expect(rows[2]?.seats).toBeGreaterThan(3);

    const money = await admin<
      {
        kind: string;
        tender: string;
        amount: number;
        fee_amount: number | null;
        received: boolean;
      }[]
    >`
      select x.kind, x.tender, x.amount, x.fee_amount, x.received_at is not null as received
        from public.external_settlements x
        join public.import_records r on r.id = x.import_record_id
       where x.tenant_id = ${A.id} and r.run_id = ${saved.runId}
       order by r.external_id`;
    expect(money).toEqual([
      { kind: "payment", tender: "cash", amount: 12500, fee_amount: null, received: true },
      // It returned an overpayment before TideGrid, so it reverses no fee.
      { kind: "refund", tender: "cash", amount: 2500, fee_amount: 0, received: true },
      { kind: "payment", tender: "check", amount: 50000, fee_amount: null, received: true },
      { kind: "payment", tender: "bank_transfer", amount: 8000, fee_amount: null, received: true },
    ]);
    const [parts] = await admin<{ n: number; minors: number }[]>`
      select count(*)::int as n, count(*) filter (where p.is_minor)::int as minors
        from public.booking_participants p
        join public.import_records r on r.participant_id = p.id
       where r.run_id = ${saved.runId}`;
    expect(parts).toEqual({ n: 3, minors: 1 });

    // No email, and no personal data in the run or its audit row.
    const [emailsAfter] = await admin<{ n: number }[]>`
      select count(*)::int as n from public.email_messages where tenant_id = ${A.id}`;
    expect(emailsAfter?.n).toBe(emailsBefore?.n);
    const [stored] = await admin<{ text: string }[]>`
      select (select row_to_json(r)::text from public.import_runs r where r.id = ${saved.runId})
             || (select coalesce(string_agg(after_state::text, ''), '') from public.audit_events
                  where tenant_id = ${A.id} and subject_id = ${saved.runId}) as text`;
    expect(stored?.text).not.toMatch(/ima\.sample|Ima Sample|Jo Fixture|5555550123/);
    const [run] = await admin<{ mode: string; clean: boolean; dry_run_id: string }[]>`
      select mode, clean, dry_run_id from public.import_runs where id = ${saved.runId}`;
    expect(run).toEqual({ mode: "commit", clean: true, dry_run_id: dry.runId });

    // A batch commits once; a final delta is a new batch.
    expect(await commit(A, ownerA, { batchId: "SAVE-1", run: 3 })).toEqual({
      kind: "already_committed",
      batchId: "SAVE-1",
    });
  });

  it("treats rows imported before as no-ops and refuses changed ones", async () => {
    // A second batch with the same records: every row unchanged.
    const again = await dryRun(A, ownerA, { batchId: "SAVE-2" });
    expect(again.result.clean).toBe(true);
    const saved = await commit(A, ownerA, { batchId: "SAVE-2", run: 2 });
    if (saved.kind !== "committed") throw new Error(JSON.stringify(saved));
    expect(saved.counts).toMatchObject({ trips: 0, tripsCreated: 0, bookings: 0, payments: 0 });
    expect(saved.counts.unchanged).toBe(2 + 3 + 2 + 3 + 3 + 4);

    // A changed customer is refused: an import never overwrites.
    const changed = await dryRun(A, ownerA, { batchId: "SAVE-3", renameC1: "Ima Changed" });
    expect(changed.result.clean).toBe(false);
    expect(changed.result.issues).toContainEqual(
      expect.objectContaining({ file: "customers.csv", code: "changed_since_import" }),
    );
  });

  it("lets staff cancel an imported booking, returning nothing, and never its guest", async () => {
    const [row] = await admin<{ id: string }[]>`
      select b.id from public.bookings b
        join public.import_bookings ib on ib.checkout_session_id = b.checkout_session_id
        join public.import_records r on r.id = ib.record_id
       where b.tenant_id = ${A.id} and r.external_id = 'R-2' and b.state = 'confirmed'`;
    if (!row) throw new Error("no imported booking R-2");
    const guest = guestContext(A.id);
    await expect(
      inTenantTransaction(runtime.db, guest, (trx) =>
        cancelBooking(trx, guest, { bookingId: row.id, expectedRefundAmount: 0 }),
      ),
    ).rejects.toMatchObject({ code: "23514", constraint_name: "booking_cancellations_imported" });
    const [emailsBefore] = await admin<{ n: number }[]>`
      select count(*)::int as n from public.email_messages where tenant_id = ${A.id}`;
    const ctx = staffCtx(A.id, ownerA);
    const done = await inTenantTransaction(runtime.db, ctx, (trx) =>
      staffCancelBooking(trx, ctx, {
        bookingId: row.id,
        choice: { kind: "policy", remedy: "none" },
        expectedAmount: 0,
      }),
    );
    expect(done).toMatchObject({
      kind: "canceled",
      cancellation: { remedy: "none", paidAmount: 0, refundAmount: 0, creditAmount: 0 },
    });
    const [hold] = await admin<{ state: string }[]>`
      select h.state from public.capacity_holds h
        join public.bookings b on b.hold_id = h.id where b.id = ${row.id}`;
    expect(hold?.state).toBe("released");
    // Its emails are held: the cancellation sends none.
    const [emailsAfter] = await admin<{ n: number }[]>`
      select count(*)::int as n from public.email_messages where tenant_id = ${A.id}`;
    expect(emailsAfter?.n).toBe(emailsBefore?.n);
    // A later batch adds nothing to the canceled booking.
    const more = await dryRun(A, ownerA, { batchId: "SAVE-4", extraPayment: true });
    expect(more.result.clean).toBe(false);
    expect(more.result.issues).toContainEqual(
      expect.objectContaining({ file: "payments.csv", code: "booking_closed" }),
    );
  });

  it("commits only the latest clean dry run of the same files", async () => {
    // No dry run at all.
    expect(await commit(A, ownerA, { batchId: "ORDER-1", run: 1 })).toMatchObject({
      kind: "no_clean_dry_run",
    });
    // Other files than the dry run's.
    await dryRun(B, ownerB, { batchId: "ORDER-2", skip: ["R-3"] });
    expect(await commit(B, ownerB, { batchId: "ORDER-2", run: 2 })).toEqual({
      kind: "batch_changed_since_dry_run",
      batchId: "ORDER-2",
    });
    // The wrong run number.
    expect(await commit(B, ownerB, { batchId: "ORDER-2", run: 4, skip: ["R-3"] })).toMatchObject({
      kind: "run_number_used",
      expected: 2,
    });
    // Booking staff: the database refuses the run.
    const desk = staffCtx(A.id, deskA);
    await dryRun(A, ownerA, { batchId: "ORDER-3", skip: ["R-1", "R-2", "R-3"] });
    await expect(
      inTenantTransaction(runtime.db, desk, (trx) =>
        runImportCommit(
          trx,
          desk,
          batch(A, { batchId: "ORDER-3", run: 2, mode: "commit", skip: ["R-1", "R-2", "R-3"] }),
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("checks again at commit time and records a refused commit", async () => {
    // Tenant B's 10:00 trip has 10 seats. The dry run fits 8; then 6 are taken.
    await dryRun(B, ownerB, { batchId: "LATE-1", party: 8 });
    const [trip] = await admin<{ id: string }[]>`
      select id from public.scheduled_trips
       where tenant_id = ${B.id} and boat_id = ${B.boats.lark} and local_date = ${day}::date
         and local_start_time = '10:00'`;
    if (!trip) throw new Error("no fixture trip");
    const holdCtx: TenantContext = {
      tenantId: B.id,
      actorType: "system",
      actorId: "t",
      requestId: "r",
    };
    await inTenantTransaction(runtime.db, holdCtx, (trx) =>
      trx
        .insertInto("capacity_holds")
        .values({
          tenant_id: B.id,
          trip_id: trip.id,
          owner_ref: `test:${randomUUID()}`,
          party_size: 6,
          expires_at: new Date(Date.now() + 30 * 60_000),
        })
        .execute(),
    );
    const late = await commit(B, ownerB, { batchId: "LATE-1", run: 2, party: 8 });
    if (late.kind !== "refused") throw new Error(JSON.stringify(late));
    expect(late.result.issues).toContainEqual(
      expect.objectContaining({ file: "bookings.csv", code: "over_capacity" }),
    );
    const [run] = await admin<{ mode: string; clean: boolean }[]>`
      select mode, clean from public.import_runs where id = ${late.runId ?? ""}`;
    expect(run).toEqual({ mode: "commit", clean: false });
    const [booked] = await admin<{ n: number }[]>`
      select count(*)::int as n from public.bookings where tenant_id = ${B.id} and source = 'imported'`;
    expect(booked?.n).toBe(0);
    // The next commit needs a fresh dry run.
    expect(await commit(B, ownerB, { batchId: "LATE-1", run: 3, party: 8 })).toMatchObject({
      kind: "no_clean_dry_run",
    });
  });

  it("keeps the import branches out of reach of any other writer", async () => {
    const ctx = staffCtx(A.id, ownerA);
    const [run] = await admin<{ id: string }[]>`
      select id from public.import_runs
       where tenant_id = ${A.id} and batch_id = 'SAVE-1' and mode = 'commit'`;
    if (!run) throw new Error("no commit run");
    // A ledger row outside its commit's transaction.
    await expect(
      inTenantTransaction(runtime.db, ctx, (trx) =>
        trx
          .insertInto("import_records")
          .values({
            tenant_id: A.id,
            run_id: run.id,
            source_system: "legacy-booker",
            mapping_version: "std-csv-v0",
            file: "customers.csv",
            external_id: "C-9",
            dedupe_key: "legacy-booker|C-9",
            row_hash: "0".repeat(64),
          })
          .execute(),
      ),
    ).rejects.toMatchObject({ code: "23514", constraint_name: "import_records_run" });
    // A checkout with no quote and no ledger row.
    const [trip] = await admin<{ id: string; starts_at: Date }[]>`
      select id, starts_at from public.scheduled_trips
       where tenant_id = ${A.id} and sales_state = 'draft' order by starts_at limit 1`;
    if (!trip) throw new Error("no draft trip");
    const checkoutId = randomUUID();
    await expect(
      inTenantTransaction(runtime.db, ctx, (trx) =>
        trx
          .insertInto("capacity_holds")
          .values({
            tenant_id: A.id,
            trip_id: trip.id,
            owner_ref: `checkout_session:${checkoutId}`,
            party_size: 1,
            expires_at: trip.starts_at,
          })
          .execute(),
      ),
    ).rejects.toMatchObject({ code: "23514" });
    // An order with no quote carries a balance only from an import commit.
    await expect(
      inTenantTransaction(runtime.db, ctx, async (trx) => {
        await sql`
          insert into orders (tenant_id, checkout_session_id, quote_id, trip_id, product_id,
            party_size, policy_version, currency, subtotal_amount, discount_amount, fee_amount,
            tax_amount, included_tax_amount, total_amount, deposit_amount, balance_due_at)
          values (${A.id}, ${randomUUID()}, null, ${trip.id}, ${A.products.charter}, 1, 1, 'USD',
                  1000, 0, 0, 0, 0, 1000, 0, ${trip.starts_at})`.execute(trx);
      }),
    ).rejects.toMatchObject({ code: "23514" });
    // The ledger is append-only.
    await expect(
      admin`update public.import_records set row_hash = ${"1".repeat(64)} where tenant_id = ${A.id}`,
    ).rejects.toMatchObject({ code: "55000" });
    // Tenant B sees none of tenant A's ledger.
    const ctxB = staffCtx(B.id, ownerB);
    const seen = await inTenantTransaction(runtime.db, ctxB, (trx) =>
      trx.selectFrom("import_records").select("id").where("tenant_id", "=", A.id).execute(),
    );
    expect(seen).toEqual([]);
  });

  it("adds a new booking to a trip an earlier commit brought in", async () => {
    // The first commit brings in every trip but books nothing on the 10:00 one.
    await dryRun(B, ownerB, { batchId: "MORE-1", skip: ["R-1"] });
    const first = await commit(B, ownerB, { batchId: "MORE-1", run: 2, skip: ["R-1"] });
    if (first.kind !== "committed") throw new Error(JSON.stringify(first));
    // The second books R-1 on that trip, now unchanged: its product's policy
    // is looked up all the same.
    await dryRun(B, ownerB, { batchId: "MORE-2" });
    const second = await commit(B, ownerB, { batchId: "MORE-2", run: 2 });
    if (second.kind !== "committed") throw new Error(JSON.stringify(second));
    expect(second.counts).toMatchObject({
      trips: 0,
      bookings: 1,
      participants: 1,
      payments: 1,
      refunds: 1,
    });
    const [booking] = await admin<{ id: string }[]>`
      select b.id from public.bookings b
        join public.import_bookings ib on ib.checkout_session_id = b.checkout_session_id
        join public.import_records r on r.id = ib.record_id
       where b.tenant_id = ${B.id} and r.external_id = 'R-1'`;
    if (!booking) throw new Error("no imported booking R-1");

    // TideGrid sends an imported booking no email, invitations included.
    const ctx = staffCtx(B.id, ownerB);
    expect(
      await inTenantTransaction(runtime.db, ctx, (trx) =>
        inviteParticipant(trx, ctx, { bookingId: booking.id, position: 1 }),
      ),
    ).toEqual({ kind: "imported_booking" });
  });

  it("takes over a charter's balance: what came in, and what is owed by when", async () => {
    for (const [t, owner, paid] of [
      [C, ownerC, 20000],
      [D, ownerD, 0],
    ] as const) {
      await dryRun(t, owner, { batchId: "BAL-1", charterPaid: paid });
      const saved = await commit(t, owner, { batchId: "BAL-1", run: 2, charterPaid: paid });
      if (saved.kind !== "committed") throw new Error(JSON.stringify(saved));
      expect(saved.counts.payments).toBe(paid === 0 ? 2 : 3);
      const [row] = await admin<{ id: string; due: string }[]>`
        select b.id, to_char(o.balance_due_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI') as due
          from public.bookings b
          join public.orders o on o.id = b.order_id
          join public.import_bookings ib on ib.checkout_session_id = b.checkout_session_id
          join public.import_records r on r.id = ib.record_id
         where b.tenant_id = ${t.id} and r.external_id = 'R-3'`;
      if (!row) throw new Error("no imported charter");
      // Due at the end of its local due date (the batch's zone is UTC).
      expect(row.due).toBe(`${dueDay}T23:59`);
      const ctx = staffCtx(t.id, owner);
      const balance = await inTenantTransaction(runtime.db, ctx, (trx) =>
        getBookingBalance(trx, t.id, row.id),
      );
      expect(balance).toMatchObject({
        state: "due",
        total: 50000,
        deposit: paid,
        paidIn: paid,
        owed: 50000 - paid,
      });
      // Its email is held: no balance link goes out.
      expect(
        await inTenantTransaction(runtime.db, ctx, (trx) => sendBalanceLink(trx, ctx, row.id)),
      ).toEqual({ kind: "imported_booking" });
    }
    // Money staff record in TideGrid counts in a later batch: a check the
    // legacy system also logged during cutover is not taken a second time.
    const [charter] = await admin<{ id: string }[]>`
      select b.id from public.bookings b
        join public.import_bookings ib on ib.checkout_session_id = b.checkout_session_id
        join public.import_records r on r.id = ib.record_id
       where b.tenant_id = ${C.id} and r.external_id = 'R-3'`;
    if (!charter) throw new Error("no imported charter");
    const staff = staffCtx(C.id, ownerC);
    await inTenantTransaction(runtime.db, staff, (trx) =>
      recordExternalSettlement(trx, staff, {
        bookingId: charter.id,
        kind: "payment",
        tender: "cash",
        amount: 30000,
        reason: "Balance paid at the dock",
        idempotencyKey: `test-${randomUUID()}`,
      }),
    );
    const again = await dryRun(C, ownerC, {
      batchId: "BAL-2",
      charterPaid: 20000,
      charterExtra: 10000,
    });
    expect(again.result.issues).toContainEqual(
      expect.objectContaining({ file: "bookings.csv", code: "overpaid" }),
    );
    // TideGrid reads a charter's balance from the money that came in, so a
    // refund staff record on it does not lower it, and a later batch agrees:
    // the same extra check is still too much.
    await inTenantTransaction(runtime.db, staff, (trx) =>
      recordExternalSettlement(trx, staff, {
        bookingId: charter.id,
        kind: "refund",
        tender: "cash",
        amount: 10000,
        reason: "Returned part of the balance",
        idempotencyKey: `test-${randomUUID()}`,
      }),
    );
    const still = await dryRun(C, ownerC, {
      batchId: "BAL-3",
      charterPaid: 20000,
      charterExtra: 10000,
    });
    expect(still.result.issues).toContainEqual(
      expect.objectContaining({ file: "bookings.csv", code: "overpaid" }),
    );
    // Without it the batch is clean: the staff refund is not a refund the
    // batch carries. (The fixture's declared outstanding total still counts
    // the 30000 the batch alone leaves open, so only the manifest disagrees.)
    const paidOff = await dryRun(C, ownerC, { batchId: "BAL-5", charterPaid: 20000 });
    expect(paidOff.result.issues.filter((i) => i.file !== "manifest.csv")).toEqual([]);
    // On a booking paid in full, money staff record in TideGrid nets: a
    // payment and its refund leave an unchanged batch clean.
    const [shared] = await admin<{ id: string }[]>`
      select b.id from public.bookings b
        join public.import_bookings ib on ib.checkout_session_id = b.checkout_session_id
        join public.import_records r on r.id = ib.record_id
       where b.tenant_id = ${D.id} and r.external_id = 'R-1'`;
    if (!shared) throw new Error("no imported booking");
    const staffD = staffCtx(D.id, ownerD);
    for (const kind of ["payment", "refund"] as const) {
      await inTenantTransaction(runtime.db, staffD, (trx) =>
        recordExternalSettlement(trx, staffD, {
          bookingId: shared.id,
          kind,
          tender: "cash",
          amount: 1000,
          reason: "Card machine mix-up",
          idempotencyKey: `test-${randomUUID()}`,
        }),
      );
    }
    const netted = await dryRun(D, ownerD, { batchId: "BAL-6", charterPaid: 0 });
    expect(netted.result.issues.filter((i) => i.file !== "manifest.csv")).toEqual([]);
    // A charter imported with a balance takes no imported refund, even once a
    // later batch pays it off.
    const refunded = await dryRun(D, ownerD, {
      batchId: "BAL-4",
      charterPaid: 0,
      charterExtra: 55000,
      charterRefund: 5000,
    });
    expect(refunded.result.issues).toContainEqual(
      expect.objectContaining({ file: "bookings.csv", code: "refund_with_balance" }),
    );
  });

  it("carries a customer's booking credit over to the email they book with, once", async () => {
    // Tenant D's records are in from BAL-1; this batch repeats them with a credit.
    await dryRun(D, ownerD, { batchId: "CRED-1", charterPaid: 0, credit: 7500 });
    const saved = await commit(D, ownerD, {
      batchId: "CRED-1",
      run: 2,
      charterPaid: 0,
      credit: 7500,
    });
    if (saved.kind !== "committed") throw new Error(JSON.stringify(saved));
    expect(saved.counts).toMatchObject({ credits: 1, bookings: 0, payments: 0 });
    const entries = await admin<{ kind: string; amount: number; balance: number }[]>`
      select e.kind, e.amount, a.balance from public.credit_entries e
        join public.credit_accounts a on a.id = e.account_id
       where a.tenant_id = ${D.id} and a.customer_email = 'ima.sample@example.test'`;
    expect(entries).toEqual([{ kind: "import", amount: 7500, balance: 7500 }]);
    // The money report leaves imported credit out and keeps staff's own.
    const ctxD = staffCtx(D.id, ownerD);
    const [acct] = await admin<{ id: string }[]>`
      select id from public.credit_accounts
       where tenant_id = ${D.id} and customer_email = 'ima.sample@example.test'`;
    const adjusted = await inTenantTransaction(runtime.db, ctxD, (trx) =>
      adjustCredit(trx, ctxD, {
        accountId: acct?.id ?? "",
        amount: 1200,
        reason: "Goodwill for a late start",
        idempotencyKey: `test-${randomUUID()}`,
      }),
    );
    expect(adjusted.kind).toBe("applied");
    const [range] = await admin<{ from: string; to: string }[]>`
      select (now() - interval '1 day')::date::text as from,
             (now() + interval '1 day')::date::text as to`;
    const report = await inTenantTransaction(runtime.db, ctxD, (trx) =>
      buildMoneyReport(trx, D.id, {
        from: range?.from ?? "",
        to: range?.to ?? "",
        typedReferences: true,
        maskProviderReferences: false,
      }),
    );
    if (report.kind !== "ok") throw new Error(report.kind);
    const creditRows = report.report.entries.filter((e) => e.credit !== 0);
    expect(creditRows.map((e) => [e.kind, e.credit])).toEqual([["credit_adjusted", 1200]]);
    expect(report.report.controlTotalsMatch).toBe(true);
    // The same row again is a no-op.
    await dryRun(D, ownerD, { batchId: "CRED-2", charterPaid: 0, credit: 7500 });
    const again = await commit(D, ownerD, {
      batchId: "CRED-2",
      run: 2,
      charterPaid: 0,
      credit: 7500,
    });
    if (again.kind !== "committed") throw new Error(JSON.stringify(again));
    expect(again.counts.credits).toBe(0);
    // No other writer adds imported credit.
    const ctx = staffCtx(D.id, ownerD);
    const [account] = await admin<{ id: string }[]>`
      select id from public.credit_accounts where tenant_id = ${D.id}`;
    const [ledger] = await admin<{ id: string }[]>`
      select id from public.import_records
       where tenant_id = ${D.id} and file = 'opening_balances.csv'`;
    await expect(
      inTenantTransaction(runtime.db, ctx, (trx) =>
        sql`insert into credit_entries (tenant_id, account_id, kind, amount, import_record_id,
              idempotency_key)
            values (${D.id}, ${account?.id ?? ""}, 'import', 100, ${ledger?.id ?? ""},
                    ${`test:${randomUUID()}`})`.execute(trx),
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
