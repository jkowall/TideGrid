/**
 * W3-G2.12-rest: complimentary bookings against a real database, as
 * tidegrid_app (migration 0039).
 *
 * - An owner books a guest at no charge in one transaction: the staff
 *   checkout, the grant for the order's whole total, the confirmed hold, and
 *   a booking whose source is complimentary and which names no payment. The
 *   note stays out of the audit history.
 * - Only an active owner: booking staff, a disabled owner, and a guest are
 *   refused by the database. Never on a deposit order.
 * - No payment ever for a comped checkout, no grant for a checkout with a
 *   payment, and no payment-less booking without a grant.
 * - It cancels with nothing to return, by the guest or staff, and staff
 *   cannot override that into a refund or credit.
 * - TideGrid's fee on it is zero.
 * - The reads: the detail shows the grant in place of the payment (its note
 *   only with the booker), the day list, roster, and search call it
 *   complimentary, and the day report's money columns are zero.
 * - Another tenant reads none of it.
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
import { FAKE_MINIMUM_AMOUNT } from "@tidegrid/domain-payments";
import { createPriceListVersion, createQuote } from "@tidegrid/domain-pricing";
import { sql } from "kysely";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  assessClosedBookings,
  bookComplimentary,
  buildDayReport,
  cancelBooking,
  getBookingDetail,
  getTripRoster,
  listDayBookings,
  listTripBookings,
  openStaffCheckout,
  previewCancellation,
  searchBookings,
  staffCancelBooking,
} from "./index.ts";
import { type CheckoutFixture, createCheckoutFixture, guestContext } from "./test-fixtures.ts";

type Sql = ReturnType<typeof postgres>;

const env = inject("integrationDb");

async function failure(p: Promise<unknown>): Promise<{ code?: string; constraint?: string }> {
  try {
    await p;
  } catch (err) {
    const e = err as { code?: string; constraint_name?: string };
    return {
      ...(e.code ? { code: e.code } : {}),
      ...(e.constraint_name ? { constraint: e.constraint_name } : {}),
    };
  }
  throw new Error("expected a database error");
}

function systemContext(tenantId: string): TenantContext {
  return {
    tenantId,
    actorType: "system",
    actorId: "complimentary-test",
    requestId: `req-${randomUUID()}`,
    sourceIp: null,
  };
}

const attestations = { policyToldToGuest: true, emailReadBack: true } as const;
const booker = { name: "Comp Guest", email: "comp.guest@example.test" };

describe.skipIf(!env)("complimentary bookings (W3-G2.12-rest)", () => {
  let admin: Sql;
  let runtime: ReturnType<typeof createDb>;
  let A: CheckoutFixture;
  let B: CheckoutFixture;
  let tripsA: ReturnType<typeof tripAllocator>;
  let ownerA: string;
  let deskA: string;
  let ownerB: string;

  async function member(tenantId: string, role: "owner" | "booking_staff"): Promise<string> {
    const id = randomUUID();
    await admin`insert into public.staff_users (id, email, display_name)
      values (${id}, ${`comp-${id.slice(0, 8)}@example.test`}, ${role})`;
    await admin`insert into public.tenant_memberships (tenant_id, user_id, role, display_name)
      values (${tenantId}, ${id}, ${role}, ${role === "owner" ? "Olive Owner" : "Ben Desk"})`;
    return id;
  }

  const staffCtx = (tenantId: string, userId: string): TenantContext => ({
    tenantId,
    actorType: "staff",
    actorId: userId,
    requestId: `req-${randomUUID()}`,
    sourceIp: null,
  });

  const asStaff = <T>(
    tenantId: string,
    userId: string,
    fn: (trx: TenantTransaction, ctx: TenantContext) => Promise<T>,
  ): Promise<T> => {
    const ctx = staffCtx(tenantId, userId);
    return inTenantTransaction(runtime.db, ctx, (trx) => fn(trx, ctx));
  };

  async function staffQuote(
    tenant: CheckoutFixture,
    userId: string,
    tripId: string,
    party: number,
    charter = false,
  ) {
    const created = await asStaff(tenant.id, userId, (trx, ctx) =>
      createQuote(trx, ctx, {
        tripId,
        party: charter
          ? { kind: "charter", guests: party }
          : { kind: "tickets", tickets: [{ code: "adult", quantity: party }] },
        addOns: [],
        promotionCode: null,
        now: new Date(),
      }),
    );
    if (created.kind !== "created") throw new Error(`staff quote: ${JSON.stringify(created)}`);
    return created.quote;
  }

  async function comp(
    tenant: CheckoutFixture,
    userId: string,
    tripId: string,
    party: number,
    grant: { reasonCode: "service_recovery" | "other"; note: string | null } = {
      reasonCode: "service_recovery",
      note: null,
    },
    charter = false,
  ) {
    const quote = await staffQuote(tenant, userId, tripId, party, charter);
    return asStaff(tenant.id, userId, (trx, ctx) =>
      bookComplimentary(trx, ctx, {
        quoteId: quote.quoteId,
        acceptedPolicyVersion: quote.policy.version,
        booker,
        channel: "phone",
        attestations,
        complimentary: grant,
      }),
    );
  }

  async function booked(tenant: CheckoutFixture, userId: string, tripId: string, party: number) {
    const result = await comp(tenant, userId, tripId, party, {
      reasonCode: "other",
      note: "Skipper's family",
    });
    if (result.kind !== "booked") throw new Error(`comp: ${JSON.stringify(result)}`);
    return result;
  }

  async function localDate(tripId: string): Promise<string> {
    const [row] = await admin<{ d: string }[]>`
      select to_char(local_date, 'YYYY-MM-DD') as d from public.scheduled_trips where id = ${tripId}`;
    if (!row) throw new Error("no trip");
    return row.d;
  }

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 4, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 8 });
    [A, B] = await Promise.all([
      createCheckoutFixture(admin, runtime.db, "comp-a", { days: 30 }),
      createCheckoutFixture(admin, runtime.db, "comp-b", { days: 4 }),
    ]);
    tripsA = tripAllocator(A);
    ownerA = await member(A.id, "owner");
    deskA = await member(A.id, "booking_staff");
    ownerB = await member(B.id, "owner");
  }, 180_000);

  afterAll(async () => {
    await runtime?.end();
    await admin?.end({ timeout: 5 });
  });

  it("books a guest at no charge: a grant for the whole order, no payment, and a complimentary booking", async () => {
    const tripId = tripsA.shared();
    const result = await booked(A, ownerA, tripId, 2);
    const [row] = await admin<
      {
        source: string;
        payment_id: string | null;
        state: string;
        session_state: string;
        session_source: string;
        hold: string;
        order_status: string;
        total: number;
        payments: number;
        waived: number;
        reason_code: string;
        note: string | null;
        actor_id: string;
      }[]
    >`
      select b.source, b.payment_id, b.state, s.state as session_state, s.source as session_source,
             h.state as hold, o.status as order_status, o.total_amount as total,
             (select count(*)::int from public.payments p where p.checkout_session_id = s.id) as payments,
             g.waived_amount as waived, g.reason_code, g.note, g.actor_id
        from public.bookings b
        join public.checkout_sessions s on s.id = b.checkout_session_id
        join public.capacity_holds h on h.id = b.hold_id
        join public.orders o on o.id = b.order_id
        join public.complimentary_grants g on g.checkout_session_id = s.id
       where b.id = ${result.bookingId}`;
    expect(row).toMatchObject({
      source: "complimentary",
      payment_id: null,
      state: "confirmed",
      session_state: "confirmed",
      session_source: "staff_assisted",
      hold: "confirmed",
      order_status: "paid",
      payments: 0,
      reason_code: "other",
      note: "Skipper's family",
      actor_id: ownerA,
    });
    expect(row?.waived).toBe(row?.total);
    expect(result.waivedAmount).toBe(row?.total);
    expect(result.session.amount).toBe(0);

    // The note never reaches the audit history or the events.
    const [audit] = await admin<{ n: number; notes: number }[]>`
      select count(*)::int as n,
             count(*) filter (where after_state::text like '%Skipper%')::int as notes
        from public.audit_events where tenant_id = ${A.id}
         and subject_id in (${result.bookingId}, ${result.session.id})`;
    expect(audit?.n).toBeGreaterThan(0);
    expect(audit?.notes).toBe(0);
    const [outbox] = await admin<{ notes: number }[]>`
      select count(*) filter (where payload::text like '%Skipper%')::int as notes
        from public.outbox_events where tenant_id = ${A.id}`;
    expect(outbox?.notes).toBe(0);
    // The confirmation email is queued as for a paid booking.
    const [mail] = await admin<{ n: number }[]>`
      select count(*)::int as n from public.email_messages
       where booking_id = ${result.bookingId} and template = 'booking_confirmation'`;
    expect(mail?.n).toBe(1);
  });

  it("refuses booking staff, a disabled owner, and a guest at the database", async () => {
    const tripId = tripsA.shared();
    expect(await failure(comp(A, deskA, tripId, 1))).toMatchObject({
      code: "42501",
      constraint: "complimentary_grants_owner",
    });
    const former = await member(A.id, "owner");
    await admin`update public.tenant_memberships set status = 'disabled'
      where tenant_id = ${A.id} and user_id = ${former}`;
    expect(await failure(comp(A, former, tripId, 1))).toMatchObject({
      code: "42501",
      constraint: "complimentary_grants_owner",
    });
    // Nothing was left behind: no checkout of either stayed open.
    const [left] = await admin<{ n: number }[]>`
      select count(*)::int as n from public.checkout_sessions
       where tenant_id = ${A.id} and trip_id = ${tripId}`;
    expect(left?.n).toBe(0);
    // A guest writing a grant straight onto a guest checkout.
    const guest = guestContext(A.id);
    expect(
      await failure(
        inTenantTransaction(runtime.db, guest, (trx) =>
          sql`insert into complimentary_grants (tenant_id, checkout_session_id, order_id,
                waived_amount, reason_code)
              values (${A.id}, ${randomUUID()}, ${randomUUID()}, 0, 'service_recovery')`.execute(
            trx,
          ),
        ),
      ),
    ).toMatchObject({ code: "42501", constraint: "complimentary_grants_owner" });
  });

  it("never comps a deposit order", async () => {
    const tripId = tripsA.charter();
    await inTenantTransaction(runtime.db, systemContext(A.id), (trx) =>
      createPriceListVersion(trx, systemContext(A.id), {
        productId: A.products.charter,
        charter: { name: "Whole boat", amount: 100_000, taxable: true },
        deposit: { kind: "fixed", amount: 25_000, balanceDueDays: 1 },
        reason: "deposit terms",
      }),
    );
    const refused = await comp(A, ownerA, tripId, 4, undefined, true);
    expect(refused).toEqual({ kind: "complimentary_deposit" });
  });

  it("keeps a comped checkout and a payment apart, both ways", async () => {
    const { bookingId, session } = await booked(A, ownerA, tripsA.shared(), 1);
    const [order] = await admin<{ id: string; total: number }[]>`
      select id, total_amount as total from public.orders where checkout_session_id = ${session.id}`;
    // A payment for the comped checkout.
    expect(
      await failure(
        asStaff(A.id, ownerA, (trx) =>
          sql`insert into payments (tenant_id, checkout_session_id, order_id, provider, account_ref,
                idempotency_key, amount)
              values (${A.id}, ${session.id}, ${order?.id ?? ""}, 'fake', ${A.accountRef},
                      ${`checkout_payment:${randomUUID()}`}, ${order?.total ?? 1})`.execute(trx),
        ),
      ),
    ).toMatchObject({ constraint: "payments_complimentary" });

    // A grant for a staff checkout that already has a payment.
    const quote = await staffQuote(A, ownerA, tripsA.shared(), 1);
    const opened = await asStaff(A.id, ownerA, (trx, ctx) =>
      openStaffCheckout(trx, ctx, {
        quoteId: quote.quoteId,
        acceptedPolicyVersion: quote.policy.version,
        booker,
        channel: "phone",
        attestations,
        provider: "fake",
        minimumAmount: FAKE_MINIMUM_AMOUNT,
      }),
    );
    if (opened.kind !== "created") throw new Error(JSON.stringify(opened));
    const [paidOrder] = await admin<{ id: string; total: number }[]>`
      select id, total_amount as total from public.orders
       where checkout_session_id = ${opened.session.id}`;
    expect(
      await failure(
        asStaff(A.id, ownerA, (trx) =>
          sql`insert into complimentary_grants (tenant_id, checkout_session_id, order_id,
                waived_amount, reason_code)
              values (${A.id}, ${opened.session.id}, ${paidOrder?.id ?? ""}, ${paidOrder?.total ?? 0},
                      'service_recovery')`.execute(trx),
        ),
      ),
    ).toMatchObject({ constraint: "complimentary_grants_checkout" });

    // A booking without a payment needs a grant: the paid checkout's booking
    // naming no payment is refused (its source is not complimentary).
    const [paidSession] = await admin<{ hold_id: string; trip_id: string; party_size: number }[]>`
      select hold_id, trip_id, party_size from public.checkout_sessions where id = ${opened.session.id}`;
    expect(
      await failure(
        asStaff(A.id, ownerA, (trx) =>
          sql`insert into bookings (tenant_id, reference, checkout_session_id, order_id, payment_id,
                hold_id, trip_id, party_size, reacquired)
              values (${A.id}, 'ZZZZZZZ1', ${opened.session.id}, ${paidOrder?.id ?? ""}, null,
                      ${paidSession?.hold_id ?? ""}, ${paidSession?.trip_id ?? ""},
                      ${paidSession?.party_size ?? 1}, false)`.execute(trx),
        ),
      ),
    ).toMatchObject({ code: "23514" });

    // The grant is append-only, for the runtime and the admin.
    expect(
      await failure(
        asStaff(A.id, ownerA, (trx) =>
          sql`update complimentary_grants set note = 'changed'
               where checkout_session_id = ${session.id}`.execute(trx),
        ),
      ),
    ).toMatchObject({ code: "42501" });
    expect(
      await failure(
        admin`delete from public.complimentary_grants where checkout_session_id = ${session.id}`,
      ),
    ).toMatchObject({ code: "55000" });
    expect(bookingId).toBeTruthy();
  });

  it("cancels with nothing to return, by the guest, and refuses a staff override into money", async () => {
    const guestCancel = await booked(A, ownerA, tripsA.shared(), 2);
    const guest = guestContext(A.id);
    const terms = await inTenantTransaction(runtime.db, guest, (trx) =>
      previewCancellation(trx, A.id, guestCancel.bookingId),
    );
    expect(terms).toMatchObject({
      cancelable: true,
      refusal: null,
      remedy: "none",
      refundBp: 0,
      paidAmount: 0,
      refundAmount: 0,
    });
    const canceled = await inTenantTransaction(runtime.db, guest, (trx) =>
      cancelBooking(trx, guest, { bookingId: guestCancel.bookingId, expectedRefundAmount: 0 }),
    );
    expect(canceled).toMatchObject({
      kind: "canceled",
      cancellation: {
        remedy: "none",
        paidAmount: 0,
        refundAmount: 0,
        refundId: null,
        creditAmount: 0,
      },
    });
    const [row] = await admin<
      { payment_id: string | null; paid: number; policy_remedy: string; hold: string }[]
    >`
      select c.payment_id, c.paid_amount as paid, c.policy_remedy, h.state as hold
        from public.booking_cancellations c
        join public.bookings b on b.id = c.booking_id
        join public.capacity_holds h on h.id = b.hold_id
       where c.booking_id = ${guestCancel.bookingId}`;
    expect(row).toMatchObject({ payment_id: null, paid: 0, hold: "released" });
    expect(row?.policy_remedy).toBeTruthy();

    const staffCancel = await booked(A, ownerA, tripsA.shared(), 1);
    const override = await asStaff(A.id, ownerA, (trx, ctx) =>
      staffCancelBooking(trx, ctx, {
        bookingId: staffCancel.bookingId,
        choice: { kind: "override", remedy: "full_refund", refundBp: 10000, reason: "goodwill" },
        expectedAmount: 0,
      }),
    );
    expect(override).toMatchObject({ kind: "override_invalid" });
    expect(
      await asStaff(A.id, ownerA, (trx, ctx) =>
        staffCancelBooking(trx, ctx, {
          bookingId: staffCancel.bookingId,
          choice: { kind: "credit" },
          expectedAmount: 0,
        }),
      ),
    ).toMatchObject({ kind: "nothing_to_credit" });
    expect(
      await asStaff(A.id, ownerA, (trx, ctx) =>
        staffCancelBooking(trx, ctx, {
          bookingId: staffCancel.bookingId,
          choice: { kind: "policy", remedy: "none" },
          expectedAmount: 0,
        }),
      ),
    ).toMatchObject({ kind: "canceled", cancellation: { remedy: "none", refundAmount: 0 } });

    // The database refuses a cancellation of a comped booking that claims money.
    const third = await booked(A, ownerA, tripsA.shared(), 1);
    expect(
      await failure(
        asStaff(A.id, ownerA, (trx) =>
          sql`insert into booking_cancellations (tenant_id, booking_id, payment_id, product_id,
                policy_version, departs_at, cutoff_at, before_cutoff, remedy, refund_bp, paid_amount,
                refund_amount, override_reason)
              select b.tenant_id, b.id, null, o.product_id, o.policy_version, t.starts_at,
                     t.starts_at - make_interval(mins => v.change_cutoff_minutes),
                     now() < t.starts_at - make_interval(mins => v.change_cutoff_minutes),
                     'none', 0, 0, 0, 'staff wants a refund'
                from bookings b
                join orders o on o.id = b.order_id
                join scheduled_trips t on t.id = b.trip_id
                join policy_versions v on v.tenant_id = o.tenant_id and v.product_id = o.product_id
                 and v.version = o.policy_version
               where b.id = ${third.bookingId}`.execute(trx),
        ),
      ),
    ).toMatchObject({ constraint: "booking_cancellations_terms" });
  });

  it("charges no TideGrid fee on it", async () => {
    const result = await booked(A, ownerA, tripsA.shared(), 2);
    await asStaff(A.id, ownerA, (trx, ctx) =>
      staffCancelBooking(trx, ctx, {
        bookingId: result.bookingId,
        choice: { kind: "policy", remedy: "none" },
        expectedAmount: 0,
      }),
    );
    const sys = systemContext(A.id);
    for (;;) {
      const run = await inTenantTransaction(runtime.db, sys, (trx) =>
        assessClosedBookings(trx, sys, 50),
      );
      if (!run.more) break;
    }
    const [fee] = await admin<
      { order_total: number; eligible_total: number; fee_amount: number }[]
    >`
      select order_total, eligible_total, fee_amount from public.fee_assessments
       where booking_id = ${result.bookingId}`;
    expect(fee).toEqual({ order_total: 0, eligible_total: 0, fee_amount: 0 });
  });

  it("shows the grant in place of the payment, and calls it complimentary everywhere", async () => {
    const tripId = tripsA.shared();
    const result = await booked(A, ownerA, tripId, 2);
    const sys = systemContext(A.id);
    const read = <T>(fn: (trx: TenantTransaction) => Promise<T>) =>
      inTenantTransaction(runtime.db, sys, fn);

    const withBooker = await read((trx) =>
      getBookingDetail(trx, A.id, result.bookingId, { withBooker: true }),
    );
    expect(withBooker).toMatchObject({
      source: "complimentary",
      payment: null,
      complimentary: {
        reasonCode: "other",
        note: "Skipper's family",
        waivedAmount: result.waivedAmount,
        grantedBy: { userId: ownerA, displayName: "Olive Owner" },
      },
    });
    const finance = await read((trx) =>
      getBookingDetail(trx, A.id, result.bookingId, { withBooker: false }),
    );
    expect(finance?.complimentary).not.toHaveProperty("note");

    const date = await localDate(tripId);
    const day = await read((trx) =>
      listDayBookings(trx, A.id, { date, tripId, limit: 50, withBooker: true }),
    );
    if (day.kind !== "ok") throw new Error(JSON.stringify(day));
    const listed = day.bookings.find((b) => b.id === result.bookingId);
    expect(listed).toMatchObject({
      source: "complimentary",
      payment: { state: "complimentary", refund: null },
    });
    const only = await read((trx) =>
      listDayBookings(trx, A.id, { date, source: "complimentary", limit: 50, withBooker: true }),
    );
    if (only.kind !== "ok") throw new Error(JSON.stringify(only));
    expect(only.bookings.every((b) => b.source === "complimentary")).toBe(true);
    expect(only.bookings.some((b) => b.id === result.bookingId)).toBe(true);

    const roster = await read((trx) => getTripRoster(trx, A.id, tripId));
    expect(roster?.bookings.find((b) => b.id === result.bookingId)?.payment.state).toBe(
      "complimentary",
    );

    const trip = await read((trx) => listTripBookings(trx, A.id, tripId));
    expect(trip?.find((b) => b.id === result.bookingId)).toMatchObject({
      source: "complimentary",
      payment: null,
    });

    const found = await read((trx) =>
      searchBookings(trx, A.id, {
        from: date,
        to: date,
        source: "complimentary",
        limit: 50,
        withBooker: true,
      }),
    );
    if (found.kind !== "ok") throw new Error(JSON.stringify(found));
    expect(found.results.find((r) => r.id === result.bookingId)?.payment.state).toBe(
      "complimentary",
    );

    const report = await read((trx) => buildDayReport(trx, A.id, { date, withBooker: false }));
    if (report.kind !== "ok") throw new Error(JSON.stringify(report));
    const line = report.report.rows.find((r) => r.bookingId === result.bookingId);
    expect(line).toMatchObject({
      source: "complimentary",
      paymentState: "complimentary",
      gross: 0,
      total: 0,
      net: 0,
      taxes: 0,
      bookings: 1,
      guests: 2,
    });

    // Another tenant reads none of it.
    const other = systemContext(B.id);
    expect(
      await inTenantTransaction(runtime.db, other, (trx) =>
        getBookingDetail(trx, A.id, result.bookingId, { withBooker: true }),
      ),
    ).toBeNull();
    const seen = await asStaff(B.id, ownerB, (trx) =>
      sql<{ n: number }>`select count(*)::int as n from complimentary_grants`.execute(trx),
    );
    expect(seen.rows[0]?.n).toBe(0);
  });
});
