/**
 * What the console reads once guests cancel and name their party (lane 1,
 * G2.11c, after lane 3's console completion).
 *
 * - A canceled booking keeps its money in the day's report (its order and its
 *   refunds) and leaves the bookings and guests counts, as the day list's
 *   counts do; search and the day list still show it, as canceled.
 * - The roster names each party's guests by place, as given so far.
 */
import { createDb } from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import { tripAllocator } from "@tidegrid/domain-inventory/testing";
import { FakeEmailProvider } from "@tidegrid/domain-messaging";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  buildDayReport,
  cancelBooking,
  getTripRoster,
  listDayBookings,
  previewCancellation,
  putParticipant,
  searchBookings,
  settleRefund,
} from "../index.ts";
import {
  type CheckoutFixture,
  createCheckoutFixture,
  fakeProvider,
  guestContext,
} from "../test-fixtures.ts";
import { asGuest, type Booked, book, type SelfServiceWorld } from "./self-service-harness.ts";

const env = inject("integrationDb");

describe.skipIf(!env)("adversarial: the console's reads of canceled and named bookings", () => {
  let world: SelfServiceWorld;
  let runtime: ReturnType<typeof createDb>;
  let A: CheckoutFixture;
  let trips: ReturnType<typeof tripAllocator>;

  async function cancelAndRefund(b: Booked) {
    const terms = await asGuest(world.db, A.id, (trx) =>
      previewCancellation(trx, A.id, b.bookingId),
    );
    if (!terms) throw new Error("setup: no terms");
    const done = await asGuest(world.db, A.id, (trx, ctx) =>
      cancelBooking(trx, ctx, { bookingId: b.bookingId, expectedRefundAmount: terms.refundAmount }),
    );
    if (done.kind !== "canceled" || !done.cancellation.refundId) throw new Error("setup cancel");
    const settled = await settleRefund(
      world.db,
      world.payments,
      guestContext(A.id),
      done.cancellation.refundId,
    );
    if (settled.kind !== "succeeded") throw new Error(`setup refund: ${settled.kind}`);
    return terms.refundAmount;
  }

  async function localDateOf(tripId: string): Promise<string> {
    const [row] = await world.admin<{ d: string }[]>`
      select to_char(local_date, 'YYYY-MM-DD') as d from public.scheduled_trips where id = ${tripId}`;
    if (!row) throw new Error("setup: no trip");
    return row.d;
  }

  beforeAll(async () => {
    if (!env) return;
    const admin = postgres(env.adminUrl, { max: 2, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 6 });
    world = {
      admin,
      db: runtime.db,
      payments: fakeProvider(runtime.db),
      mail: new FakeEmailProvider({ db: runtime.db, environment: "local" }),
    };
    A = await createCheckoutFixture(admin, runtime.db, "ss-console-a", { days: 24 });
    trips = tripAllocator(A);
  });

  afterAll(async () => {
    await runtime?.end();
    await world?.admin.end({ timeout: 5 });
  });

  it("keeps a canceled booking's money in the day's report and leaves it out of the counts", async () => {
    const tripId = trips.shared();
    const stays = await book(world, A, tripId, 1);
    const leaves = await book(world, A, tripId, 2);
    const refunded = await cancelAndRefund(leaves);
    const date = await localDateOf(tripId);

    const report = await asGuest(world.db, A.id, (trx) =>
      buildDayReport(trx, A.id, { date, withBooker: false }),
    );
    if (report.kind !== "ok") throw new Error(report.kind);
    const rows = report.report.rows.filter((r) => r.trip.tripId === tripId);
    const kept = rows.find((r) => r.bookingId === stays.bookingId);
    const canceled = rows.find((r) => r.bookingId === leaves.bookingId);
    expect(kept).toMatchObject({ state: "confirmed", bookings: 1, guests: 1 });
    expect(canceled).toMatchObject({
      state: "canceled",
      bookings: 0,
      guests: 0,
      total: leaves.amount,
      refunds: refunded,
      net: leaves.amount - refunded,
    });
    // The day's totals sum the rows: the money of both, the count of one.
    const totals = report.report.totals;
    expect(totals.bookings).toBe(report.report.rows.reduce((n, r) => n + r.bookings, 0));
    expect(totals.total).toBe(report.report.rows.reduce((n, r) => n + r.total, 0));
    expect(totals.refunds).toBe(report.report.rows.reduce((n, r) => n + r.refunds, 0));

    // The day list's counts follow the same rule, and it still lists the canceled booking.
    const day = await asGuest(world.db, A.id, (trx) =>
      listDayBookings(trx, A.id, { date, tripId, limit: 50, withBooker: false }),
    );
    if (day.kind !== "ok") throw new Error(day.kind);
    expect(day.trips.find((t) => t.tripId === tripId)).toMatchObject({ bookings: 1, guests: 1 });
    expect(day.bookings.map((b) => [b.id, b.state])).toEqual([
      [stays.bookingId, "confirmed"],
      [leaves.bookingId, "canceled"],
    ]);

    // Search finds it, as canceled.
    const found = await asGuest(world.db, A.id, (trx) =>
      searchBookings(trx, A.id, { q: leaves.reference, limit: 25, withBooker: false }),
    );
    if (found.kind !== "ok") throw new Error(found.kind);
    expect(found.results.map((r) => [r.id, r.state])).toEqual([[leaves.bookingId, "canceled"]]);
  });

  it("names each party's guests on the roster by place, as given so far", async () => {
    const tripId = trips.shared();
    const b = await book(world, A, tripId, 3);
    for (const [position, name, isMinor] of [
      [3, "Robin Synthetic", true],
      [1, "Morgan Synthetic", false],
    ] as const) {
      const put = await asGuest(world.db, A.id, (trx, ctx) =>
        putParticipant(trx, ctx, {
          bookingId: b.bookingId,
          position,
          details: isMinor
            ? {
                name,
                isMinor,
                guardian: { name: "Morgan Synthetic", email: "morgan.synthetic@example.test" },
              }
            : { name, isMinor },
        }),
      );
      if (put.kind !== "created") throw new Error(`setup participant: ${put.kind}`);
    }
    const roster = await asGuest(world.db, A.id, (trx) => getTripRoster(trx, A.id, tripId));
    const row = roster?.bookings.find((r) => r.id === b.bookingId);
    expect(row?.participants).toEqual([
      { position: 1, name: "Morgan Synthetic", minor: false },
      { position: 3, name: "Robin Synthetic", minor: true },
    ]);
  });
});
