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
import { createPolicyVersion } from "@tidegrid/domain-pricing";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  cancelBooking,
  previewCancellation,
  previewReschedule,
  type RescheduleInput,
  rescheduleBooking,
} from "./index.ts";
import {
  type CheckoutFixture,
  confirmBooking,
  createCheckoutFixture,
  fakeProvider,
  guestContext,
} from "./test-fixtures.ts";

type Sql = ReturnType<typeof postgres>;

const env = inject("integrationDb");

function staffContext(tenantId: string): TenantContext {
  return {
    tenantId,
    actorType: "staff",
    actorId: `user:${randomUUID()}`,
    requestId: `req-${randomUUID()}`,
    sourceIp: null,
  };
}

describe.skipIf(!env)("moving a whole booking to another trip (W3-G2.11-rest)", () => {
  let admin: Sql;
  let runtime: ReturnType<typeof createDb>;
  let payments: FakePaymentProvider;
  let A: CheckoutFixture;
  let B: CheckoutFixture;
  let L: CheckoutFixture;
  let tripsA: ReturnType<typeof tripAllocator>;
  let tripsB: ReturnType<typeof tripAllocator>;
  let tripsL: ReturnType<typeof tripAllocator>;

  const as = <T>(
    ctx: TenantContext,
    fn: (trx: TenantTransaction, ctx: TenantContext) => Promise<T>,
  ): Promise<T> => inTenantTransaction(runtime.db, ctx, (trx) => fn(trx, ctx));
  const move = (ctx: TenantContext, input: RescheduleInput) =>
    as(ctx, (trx, c) => rescheduleBooking(trx, c, input));

  async function seatsUsed(tripId: string) {
    const [row] = await admin<{ held: number }[]>`
      select coalesce(sum(seats), 0)::int as held from public.capacity_holds
       where trip_id = ${tripId} and state in ('active', 'confirmed')`;
    return row?.held ?? 0;
  }
  async function bookingNow(bookingId: string) {
    const [row] = await admin<
      { state: string; trip_id: string; hold_id: string; hold_state: string; owner: string }[]
    >`
      select b.state, b.trip_id, b.hold_id, h.state as hold_state, h.owner_ref as owner
        from public.bookings b join public.capacity_holds h on h.id = b.hold_id
       where b.id = ${bookingId}`;
    if (!row) throw new Error("no booking");
    return row;
  }

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 2, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 8 });
    payments = fakeProvider(runtime.db);
    A = await createCheckoutFixture(admin, runtime.db, "rsc-a");
    B = await createCheckoutFixture(admin, runtime.db, "rsc-b");
    // Late: a 30-day change cutoff, so every trip is past it.
    L = await createCheckoutFixture(admin, runtime.db, "rsc-l");
    tripsA = tripAllocator(A);
    tripsB = tripAllocator(B);
    tripsL = tripAllocator(L);
    const products = await admin<{ id: string }[]>`
      select id from public.products where tenant_id = ${L.id} and kind = 'shared_seat'`;
    const ctx: TenantContext = { tenantId: L.id, actorType: "system", actorId: "test" };
    await inTenantTransaction(runtime.db, ctx, async (trx) => {
      for (const p of products) {
        const made = await createPolicyVersion(trx, ctx, {
          productId: p.id,
          changeCutoffMinutes: 43_200,
          beforeCutoff: { remedy: "full_refund" },
          afterCutoff: { remedy: "none" },
          noShow: { remedy: "none" },
          text: {
            cancellation: "Cancellation terms.",
            reschedule: "Moves within 30 days need the operator.",
            noShow: "No-show terms.",
            operatorCancellation: "Operator terms.",
            weather: "Weather terms.",
          },
          reason: "test: a long cutoff",
        });
        if (made.kind !== "created") throw new Error(`policy: ${JSON.stringify(made)}`);
      }
    });
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end({ timeout: 5 });
  });

  it("previews the other trips of the product with the price unchanged", async () => {
    const from = tripsA.shared();
    const booked = await confirmBooking(runtime.db, payments, A, from, 2);
    const preview = await as(guestContext(A.id), (trx) =>
      previewReschedule(trx, A.id, booked.bookingId),
    );
    if (!preview) throw new Error("no preview");
    expect(preview).toMatchObject({
      movable: true,
      refusal: null,
      tripId: from,
      beforeCutoff: true,
      partySize: 2,
      policyText: "Fixture reschedule terms.",
      price: { currency: "USD", changes: false },
    });
    expect(preview.options.length).toBeGreaterThan(0);
    expect(preview.options.length).toBeLessThanOrEqual(30);
    expect(preview.options.some((o) => o.tripId === from)).toBe(false);
    expect(preview.options.every((o) => o.available && o.issue === null)).toBe(true);
    const shared = new Set(A.trips.shared);
    expect(preview.options.every((o) => shared.has(o.tripId))).toBe(true);
    const starts = preview.options.map((o) => o.startsAt);
    expect([...starts].sort()).toEqual(starts);
    expect(preview.moves).toEqual([]);
  });

  it("moves a booking: new seats taken, old seats back, email and audit, once", async () => {
    const from = tripsA.shared();
    const to = tripsA.shared();
    const booked = await confirmBooking(runtime.db, payments, A, from, 3);
    const before = await bookingNow(booked.bookingId);
    expect(await seatsUsed(from)).toBe(3);
    const input = { bookingId: booked.bookingId, fromTripId: from, toTripId: to };
    const moved = await move(guestContext(A.id), input);
    if (moved.kind !== "moved") throw new Error(`move: ${JSON.stringify(moved)}`);
    expect(moved.move).toMatchObject({
      fromTripId: from,
      toTripId: to,
      beforeCutoff: true,
      overridden: false,
      by: "guest",
    });
    expect(await seatsUsed(from)).toBe(0);
    expect(await seatsUsed(to)).toBe(3);
    const after = await bookingNow(booked.bookingId);
    expect(after).toMatchObject({
      state: "confirmed",
      trip_id: to,
      hold_state: "confirmed",
      owner: `booking_reschedule:${moved.move.rescheduleId}`,
    });
    const [old] = await admin<{ state: string }[]>`
      select state from public.capacity_holds where id = ${before.hold_id}`;
    expect(old?.state).toBe("released");

    const mails = await admin<
      { template: string; state: string; last_error_code: string | null }[]
    >`
      select template, state, last_error_code from public.email_messages
       where booking_id = ${booked.bookingId} order by created_at, id`;
    expect(mails.filter((m) => m.template === "booking_rescheduled")).toEqual([
      { template: "booking_rescheduled", state: "queued", last_error_code: null },
    ]);
    const reminders = mails.filter((m) => m.template === "booking_reminder");
    // The reminder for the old trip, if one was written, is canceled; one for the new trip waits.
    expect(reminders.filter((m) => m.state === "queued")).toHaveLength(1);
    expect(
      reminders
        .filter((m) => m.state !== "queued")
        .every((m) => m.state === "canceled" && m.last_error_code === "booking_moved"),
    ).toBe(true);

    const [audit] = await admin<{ action: string; actor_type: string }[]>`
      select action, actor_type from public.audit_events
       where subject_id = ${booked.bookingId} and action like 'booking.rescheduled%'`;
    expect(audit).toEqual({ action: "booking.rescheduled", actor_type: "guest" });
    const [event] = await admin<{ n: number }[]>`
      select count(*)::int as n from public.outbox_events
       where aggregate_id = ${booked.bookingId} and topic = 'booking.rescheduled'`;
    expect(event?.n).toBe(1);

    // The same move again answers with the first; nothing more changes.
    const again = await move(guestContext(A.id), input);
    expect(again).toEqual({ kind: "already_moved", move: moved.move });
    expect(await seatsUsed(to)).toBe(3);
    // A move from a trip it is no longer on is refused.
    expect(await move(guestContext(A.id), { ...input, toTripId: tripsA.shared() })).toEqual({
      kind: "booking_changed",
    });

    const preview = await as(guestContext(A.id), (trx) =>
      previewReschedule(trx, A.id, booked.bookingId),
    );
    expect(preview?.moves).toEqual([moved.move]);
    expect(preview?.tripId).toBe(to);
  });

  it("moves twice, then cancels: the last move's hold is released", async () => {
    const [t1, t2, t3] = [tripsA.shared(), tripsA.shared(), tripsA.shared()];
    const booked = await confirmBooking(runtime.db, payments, A, t1, 2);
    const first = await move(guestContext(A.id), {
      bookingId: booked.bookingId,
      fromTripId: t1,
      toTripId: t2,
    });
    expect(first.kind).toBe("moved");
    const second = await move(staffContext(A.id), {
      bookingId: booked.bookingId,
      fromTripId: t2,
      toTripId: t3,
    });
    expect(second).toMatchObject({ kind: "moved", move: { by: "staff" } });
    expect([await seatsUsed(t1), await seatsUsed(t2), await seatsUsed(t3)]).toEqual([0, 0, 2]);
    const terms = await as(guestContext(A.id), (trx) =>
      previewCancellation(trx, A.id, booked.bookingId),
    );
    if (!terms) throw new Error("no terms");
    const canceled = await as(guestContext(A.id), (trx, ctx) =>
      cancelBooking(trx, ctx, {
        bookingId: booked.bookingId,
        expectedRefundAmount: terms.refundAmount,
      }),
    );
    expect(canceled.kind).toBe("canceled");
    expect(await seatsUsed(t3)).toBe(0);
    expect(await bookingNow(booked.bookingId)).toMatchObject({
      state: "canceled",
      hold_state: "released",
    });
    // A canceled booking does not move.
    expect(
      await move(guestContext(A.id), { bookingId: booked.bookingId, fromTripId: t3, toTripId: t1 }),
    ).toEqual({ kind: "not_confirmed" });
    const [moved] = await admin<{ n: number }[]>`
      select count(*)::int as n from public.email_messages
       where booking_id = ${booked.bookingId} and template = 'booking_rescheduled'
         and state = 'queued'`;
    expect(moved?.n).toBe(0);
  });

  it("changes nothing when the new trip has no room, and refuses another product's trip", async () => {
    const [x, y] = [tripsA.charter(), tripsA.charter()];
    const first = await confirmBooking(runtime.db, payments, A, x, 4, { charter: true });
    await confirmBooking(runtime.db, payments, A, y, 2, { charter: true });
    const preview = await as(guestContext(A.id), (trx) =>
      previewReschedule(trx, A.id, first.bookingId),
    );
    expect(preview?.options.find((o) => o.tripId === y)).toMatchObject({
      available: false,
      issue: "insufficient_capacity",
    });
    const refused = await move(guestContext(A.id), {
      bookingId: first.bookingId,
      fromTripId: x,
      toTripId: y,
    });
    expect(refused).toEqual({ kind: "trip_unavailable", issue: "insufficient_capacity" });
    expect((await bookingNow(first.bookingId)).trip_id).toBe(x);
    const [holds] = await admin<{ n: number }[]>`
      select count(*)::int as n from public.capacity_holds
       where tenant_id = ${A.id} and owner_ref like 'booking_reschedule:%' and trip_id = ${y}`;
    expect(holds?.n).toBe(0);
    expect(
      await move(guestContext(A.id), {
        bookingId: first.bookingId,
        fromTripId: x,
        toTripId: tripsA.shared(),
      }),
    ).toEqual({ kind: "trip_not_found" });
    expect(
      await move(guestContext(A.id), { bookingId: first.bookingId, fromTripId: x, toTripId: x }),
    ).toEqual({ kind: "trip_not_found" });
  });

  it("lets one of two racing moves take the last boat, and opposite moves never deadlock", async () => {
    const [x1, x2, y] = [tripsA.charter(), tripsA.charter(), tripsA.charter()];
    const one = await confirmBooking(runtime.db, payments, A, x1, 2, { charter: true });
    const two = await confirmBooking(runtime.db, payments, A, x2, 2, { charter: true });
    const results = await Promise.all([
      move(guestContext(A.id), { bookingId: one.bookingId, fromTripId: x1, toTripId: y }),
      move(guestContext(A.id), { bookingId: two.bookingId, fromTripId: x2, toTripId: y }),
    ]);
    expect(results.map((r) => r.kind).sort()).toEqual(["moved", "trip_unavailable"]);
    expect(await seatsUsed(y)).toBe(6);

    // Two shared bookings swap trips at once: both moves finish.
    const [p, q] = [tripsA.shared(), tripsA.shared()];
    const onP = await confirmBooking(runtime.db, payments, A, p, 1);
    const onQ = await confirmBooking(runtime.db, payments, A, q, 1);
    const swapped = await Promise.all([
      move(guestContext(A.id), { bookingId: onP.bookingId, fromTripId: p, toTripId: q }),
      move(guestContext(A.id), { bookingId: onQ.bookingId, fromTripId: q, toTripId: p }),
    ]);
    expect(swapped.map((r) => r.kind)).toEqual(["moved", "moved"]);
    expect([await seatsUsed(p), await seatsUsed(q)]).toEqual([1, 1]);
  });

  it("past the cutoff only staff with a reason move it; a guest cannot override", async () => {
    const [from, to] = [tripsL.shared(), tripsL.shared()];
    const booked = await confirmBooking(runtime.db, payments, L, from, 1);
    const preview = await as(guestContext(L.id), (trx) =>
      previewReschedule(trx, L.id, booked.bookingId),
    );
    expect(preview).toMatchObject({ movable: false, refusal: "past_cutoff", beforeCutoff: false });
    const input = { bookingId: booked.bookingId, fromTripId: from, toTripId: to };
    expect(await move(guestContext(L.id), input)).toEqual({ kind: "past_cutoff" });
    expect(await move(staffContext(L.id), input)).toEqual({ kind: "past_cutoff" });
    // The database refuses an override from anyone but staff.
    await expect(
      move(guestContext(L.id), { ...input, overrideReason: "guest says so" }),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      move(staffContext(L.id), { ...input, overrideReason: "bad\u0007reason" }),
    ).rejects.toThrow(RangeError);
    const moved = await move(staffContext(L.id), {
      ...input,
      overrideReason: "Guest called; weather on the original day",
    });
    expect(moved).toMatchObject({
      kind: "moved",
      move: { beforeCutoff: false, overridden: true, by: "staff" },
    });
    const [audit] = await admin<{ action: string; reason: string }[]>`
      select action, reason from public.audit_events
       where subject_id = ${booked.bookingId} and action like 'booking.rescheduled%'`;
    expect(audit).toEqual({
      action: "booking.rescheduled_override",
      reason: "Guest called; weather on the original day",
    });
  });

  it("keeps tenants apart: another tenant's booking and trips are not found", async () => {
    const [from, to] = [tripsA.shared(), tripsA.shared()];
    const booked = await confirmBooking(runtime.db, payments, A, from, 1);
    expect(
      await as(guestContext(B.id), (trx) => previewReschedule(trx, B.id, booked.bookingId)),
    ).toBeNull();
    expect(
      await move(staffContext(B.id), {
        bookingId: booked.bookingId,
        fromTripId: from,
        toTripId: to,
      }),
    ).toEqual({ kind: "not_found" });
    // A's booking cannot move onto B's trip either.
    expect(
      await move(staffContext(A.id), {
        bookingId: booked.bookingId,
        fromTripId: from,
        toTripId: tripsB.shared(),
      }),
    ).toEqual({ kind: "trip_not_found" });
    expect((await bookingNow(booked.bookingId)).trip_id).toBe(from);
  });

  it("refuses a booking's trip or hold changed without a move, and a move row that does not match", async () => {
    const [from, to] = [tripsA.shared(), tripsA.shared()];
    const booked = await confirmBooking(runtime.db, payments, A, from, 1);
    const ctx = staffContext(A.id);
    await expect(
      as(ctx, (trx) =>
        trx
          .updateTable("bookings")
          .set({ trip_id: to })
          .where("tenant_id", "=", A.id)
          .where("id", "=", booked.bookingId)
          .execute(),
      ),
    ).rejects.toMatchObject({ code: "23514", constraint_name: "bookings_immutable" });
    const hold = (await bookingNow(booked.bookingId)).hold_id;
    // A move row needs its own confirmed hold on the new trip.
    await expect(
      as(ctx, (trx) =>
        trx
          .insertInto("booking_reschedules")
          .values({
            tenant_id: A.id,
            booking_id: booked.bookingId,
            from_trip_id: from,
            to_trip_id: to,
            from_hold_id: hold,
            to_hold_id: hold,
          })
          .execute(),
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      as(ctx, (trx) =>
        trx.deleteFrom("booking_reschedules").where("tenant_id", "=", A.id).execute(),
      ),
    ).rejects.toThrow();
  });
});
