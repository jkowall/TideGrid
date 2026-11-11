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
import { auditLedger } from "./adversarial/harness.ts";
import {
  type BookingHooks,
  cancelBooking,
  listParticipants,
  listPartyChanges,
  type ParticipantRemovedEvent,
  previewCancellation,
  putParticipant,
  type RemoveParticipantInput,
  removeParticipant,
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

const adult = (name: string) => ({ name, isMinor: false });

describe.skipIf(!env)("giving up a place in a shared-seat party (W3-G2.11-rest)", () => {
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
  const remove = (ctx: TenantContext, input: RemoveParticipantInput, hooks?: BookingHooks) =>
    as(ctx, (trx, c) => removeParticipant(trx, c, input, hooks));
  const name = (tenantId: string, bookingId: string, position: number, who: string) =>
    as(guestContext(tenantId), (trx, c) =>
      putParticipant(trx, c, { bookingId, position, details: adult(who) }),
    );

  async function seatsUsed(tripId: string) {
    const [row] = await admin<{ held: number }[]>`
      select coalesce(sum(seats), 0)::int as held from public.capacity_holds
       where trip_id = ${tripId} and state in ('active', 'confirmed')`;
    return row?.held ?? 0;
  }
  async function bookingNow(bookingId: string) {
    const [row] = await admin<
      {
        state: string;
        party_size: number;
        hold_id: string;
        hold_state: string;
        hold_party: number;
        owner: string;
      }[]
    >`
      select b.state, b.party_size, b.hold_id, h.state as hold_state,
             h.party_size as hold_party, h.owner_ref as owner
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
    A = await createCheckoutFixture(admin, runtime.db, "pty-a");
    B = await createCheckoutFixture(admin, runtime.db, "pty-b");
    // Late: a 30-day change cutoff, so every trip is past it.
    L = await createCheckoutFixture(admin, runtime.db, "pty-l");
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
            reschedule: "Changes within 30 days need the operator.",
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

  it("frees the seat on a full trip, removes the named participant, and keeps the price", async () => {
    const trip = tripsA.shared();
    const big = await confirmBooking(runtime.db, payments, A, trip, 8);
    await confirmBooking(runtime.db, payments, A, trip, 2);
    expect(await seatsUsed(trip)).toBe(10);
    for (const [place, who] of [
      [1, "Ada One"],
      [2, "Ben Two"],
      [8, "Hal Eight"],
    ] as const) {
      expect((await name(A.id, big.bookingId, place, who)).kind).toBe("created");
    }
    const [ben] = await admin<{ id: string }[]>`
      select id from public.booking_participants where booking_id = ${big.bookingId} and position = 2`;
    const [paid] = await admin<{ amount: number }[]>`
      select p.amount from public.payments p join public.bookings b on b.payment_id = p.id
       where b.id = ${big.bookingId}`;
    const before = await bookingNow(big.bookingId);

    const seen: ParticipantRemovedEvent[] = [];
    const removed = await remove(
      guestContext(A.id),
      { bookingId: big.bookingId, position: 2, partySize: 8 },
      {
        async participantRemoved(_trx, _ctx, event) {
          seen.push(event);
        },
      },
    );
    if (removed.kind !== "removed") throw new Error(JSON.stringify(removed));
    expect(removed.change).toMatchObject({
      position: 2,
      participantId: ben?.id,
      fromPartySize: 8,
      toPartySize: 7,
      beforeCutoff: true,
      overridden: false,
      by: "guest",
    });
    expect(seen).toEqual([
      {
        bookingId: big.bookingId,
        participantId: ben?.id,
        position: 2,
        partyChangeId: removed.change.partyChangeId,
      },
    ]);
    expect(await seatsUsed(trip)).toBe(9);
    expect(await bookingNow(big.bookingId)).toMatchObject({
      state: "confirmed",
      party_size: 7,
      hold_state: "confirmed",
      hold_party: 7,
      owner: `booking_party_change:${removed.change.partyChangeId}`,
    });
    const [old] = await admin<{ state: string }[]>`
      select state from public.capacity_holds where id = ${before.hold_id}`;
    expect(old?.state).toBe("released");
    const [after] = await admin<{ amount: number; total: number }[]>`
      select p.amount, o.total_amount as total from public.bookings b
        join public.payments p on p.id = b.payment_id
        join public.orders o on o.id = b.order_id
       where b.id = ${big.bookingId}`;
    expect(after?.amount).toBe(paid?.amount);
    expect(after?.total).toBe(paid?.amount);

    const party = await as(guestContext(A.id), (trx) => listParticipants(trx, A.id, big.bookingId));
    expect(party).toMatchObject({ partySize: 7, places: [1, 3, 4, 5, 6, 7, 8] });
    expect(party?.participants.map((p) => p.position)).toEqual([1, 8]);
    const [kept] = await admin<{ removed: boolean }[]>`
      select removed_at is not null as removed from public.booking_participants
       where id = ${ben?.id ?? ""}`;
    expect(kept?.removed).toBe(true);

    // The place's number is never used again; the last place keeps its own.
    expect((await name(A.id, big.bookingId, 2, "New Two")).kind).toBe("place_removed");
    expect((await name(A.id, big.bookingId, 8, "Hal Renamed")).kind).toBe("updated");
    expect((await name(A.id, big.bookingId, 9, "No Nine")).kind).toBe("position_out_of_range");
    expect((await name(A.id, big.bookingId, 3, "Cy Three")).kind).toBe("created");

    // The freed seat is on sale: another guest books it.
    await confirmBooking(runtime.db, payments, A, trip, 1);
    expect(await seatsUsed(trip)).toBe(10);
    expect(await auditLedger(admin, [A.id])).toEqual([]);
  });

  it("gives up an unnamed place, answers a repeat with the same change, and refuses stale sizes", async () => {
    const trip = tripsA.shared();
    const booked = await confirmBooking(runtime.db, payments, A, trip, 4);
    const input = { bookingId: booked.bookingId, position: 4, partySize: 4 };
    const first = await remove(guestContext(A.id), input);
    if (first.kind !== "removed") throw new Error(JSON.stringify(first));
    expect(first.change.participantId).toBeNull();
    const again = await remove(guestContext(A.id), input);
    expect(again).toEqual({ kind: "already_removed", change: first.change });
    expect(await seatsUsed(trip)).toBe(3);
    // The guest saw 4 but the party is 3 now.
    expect(
      await remove(guestContext(A.id), { bookingId: booked.bookingId, position: 1, partySize: 4 }),
    ).toEqual({ kind: "booking_changed" });
    expect(
      await remove(guestContext(A.id), { bookingId: booked.bookingId, position: 5, partySize: 3 }),
    ).toEqual({ kind: "place_not_found" });
    const second = await remove(guestContext(A.id), {
      bookingId: booked.bookingId,
      position: 1,
      partySize: 3,
    });
    expect(second.kind).toBe("removed");
    expect(
      await as(guestContext(A.id), (trx) => listPartyChanges(trx, A.id, booked.bookingId)),
    ).toMatchObject([{ position: 4 }, { position: 1 }]);
    expect(await bookingNow(booked.bookingId)).toMatchObject({ party_size: 2, hold_party: 2 });
    expect(await seatsUsed(trip)).toBe(2);
    expect(await auditLedger(admin, [A.id])).toEqual([]);
  });

  it("refuses the last place, a charter, a canceled booking, and another tenant's booking", async () => {
    const one = await confirmBooking(runtime.db, payments, A, tripsA.shared(), 1);
    expect(
      await remove(guestContext(A.id), { bookingId: one.bookingId, position: 1, partySize: 1 }),
    ).toEqual({ kind: "last_place" });
    const charter = await confirmBooking(runtime.db, payments, A, tripsA.charter(), 4, {
      charter: true,
    });
    expect(
      await remove(guestContext(A.id), { bookingId: charter.bookingId, position: 4, partySize: 4 }),
    ).toEqual({ kind: "not_shared_seat" });
    const other = await confirmBooking(runtime.db, payments, B, tripsB.shared(), 3);
    expect(
      await remove(guestContext(A.id), { bookingId: other.bookingId, position: 3, partySize: 3 }),
    ).toEqual({ kind: "not_found" });
    expect(await bookingNow(other.bookingId)).toMatchObject({ party_size: 3 });

    const gone = await confirmBooking(runtime.db, payments, B, tripsB.shared(), 3);
    const terms = await as(guestContext(B.id), (trx) =>
      previewCancellation(trx, B.id, gone.bookingId),
    );
    await as(guestContext(B.id), (trx, ctx) =>
      cancelBooking(trx, ctx, {
        bookingId: gone.bookingId,
        expectedRefundAmount: terms?.refundAmount ?? 0,
      }),
    );
    expect(
      await remove(guestContext(B.id), { bookingId: gone.bookingId, position: 3, partySize: 3 }),
    ).toEqual({ kind: "not_confirmed" });
  });

  it("leaves everything as it was when the trip can't keep the smaller party", async () => {
    const trip = tripsA.shared();
    const booked = await confirmBooking(runtime.db, payments, A, trip, 3);
    await name(A.id, booked.bookingId, 3, "Stays Put");
    const before = await bookingNow(booked.bookingId);
    await admin`update public.scheduled_trips set sales_state = 'closed' where id = ${trip}`;
    const seen: unknown[] = [];
    const refused = await remove(
      guestContext(A.id),
      { bookingId: booked.bookingId, position: 3, partySize: 3 },
      {
        async participantRemoved(_trx, _ctx, event) {
          seen.push(event);
        },
      },
    );
    expect(refused).toEqual({ kind: "trip_unavailable", issue: "trip_unavailable" });
    expect(await bookingNow(booked.bookingId)).toEqual(before);
    expect(await seatsUsed(trip)).toBe(3);
    const party = await as(guestContext(A.id), (trx) =>
      listParticipants(trx, A.id, booked.bookingId),
    );
    expect(party?.participants.map((p) => p.position)).toEqual([3]);
    expect(
      await as(guestContext(A.id), (trx) => listPartyChanges(trx, A.id, booked.bookingId)),
    ).toEqual([]);
    const [audits] = await admin<{ n: number }[]>`
      select count(*)::int as n from public.audit_events
       where subject_id = ${booked.bookingId} and action like 'booking.party_reduced%'`;
    expect(audits?.n).toBe(0);
  });

  it("past the cutoff: refuses the guest, lets staff with a reason, and the database agrees", async () => {
    const trip = tripsL.shared();
    const booked = await confirmBooking(runtime.db, payments, L, trip, 3);
    expect(
      await remove(guestContext(L.id), { bookingId: booked.bookingId, position: 3, partySize: 3 }),
    ).toEqual({ kind: "past_cutoff" });
    expect(
      await remove(staffContext(L.id), { bookingId: booked.bookingId, position: 3, partySize: 3 }),
    ).toEqual({ kind: "past_cutoff" });
    // A guest naming an override reaches the database, which refuses it.
    await expect(
      remove(guestContext(L.id), {
        bookingId: booked.bookingId,
        position: 3,
        partySize: 3,
        overrideReason: "guest says so",
      }),
    ).rejects.toMatchObject({ code: "42501", constraint_name: "booking_party_changes_override" });
    const done = await remove(staffContext(L.id), {
      bookingId: booked.bookingId,
      position: 3,
      partySize: 3,
      overrideReason: "Owner approved a late change",
    });
    if (done.kind !== "removed") throw new Error(JSON.stringify(done));
    expect(done.change).toMatchObject({ beforeCutoff: false, overridden: true, by: "staff" });
    const [audit] = await admin<{ action: string; reason: string }[]>`
      select action, reason from public.audit_events
       where subject_id = ${booked.bookingId} and action like 'booking.party_reduced%'`;
    expect(audit).toEqual({
      action: "booking.party_reduced_override",
      reason: "Owner approved a late change",
    });
  });

  it("moves a booking and gives up a place in one transaction", async () => {
    const [from, to] = [tripsA.shared(), tripsA.shared()];
    const booked = await confirmBooking(runtime.db, payments, A, from, 3);
    await as(guestContext(A.id), async (trx, ctx) => {
      const moved = await rescheduleBooking(trx, ctx, {
        bookingId: booked.bookingId,
        fromTripId: from,
        toTripId: to,
      });
      expect(moved.kind).toBe("moved");
      const removed = await removeParticipant(trx, ctx, {
        bookingId: booked.bookingId,
        position: 1,
        partySize: 3,
      });
      expect(removed.kind).toBe("removed");
    });
    expect(await seatsUsed(from)).toBe(0);
    expect(await seatsUsed(to)).toBe(2);
    expect(await bookingNow(booked.bookingId)).toMatchObject({ party_size: 2, hold_party: 2 });
    expect(await auditLedger(admin, [A.id])).toEqual([]);
  });

  it("moves and cancels a booking whose party gave up places", async () => {
    const [from, to] = [tripsA.shared(), tripsA.shared()];
    const booked = await confirmBooking(runtime.db, payments, A, from, 3);
    await remove(guestContext(A.id), { bookingId: booked.bookingId, position: 2, partySize: 3 });
    const moved = await as(guestContext(A.id), (trx, ctx) =>
      rescheduleBooking(trx, ctx, { bookingId: booked.bookingId, fromTripId: from, toTripId: to }),
    );
    expect(moved.kind).toBe("moved");
    expect(await seatsUsed(from)).toBe(0);
    expect(await seatsUsed(to)).toBe(2);
    await remove(guestContext(A.id), { bookingId: booked.bookingId, position: 3, partySize: 2 });
    expect(await seatsUsed(to)).toBe(1);
    expect(await auditLedger(admin, [A.id])).toEqual([]);
    const terms = await as(guestContext(A.id), (trx) =>
      previewCancellation(trx, A.id, booked.bookingId),
    );
    const canceled = await as(guestContext(A.id), (trx, ctx) =>
      cancelBooking(trx, ctx, {
        bookingId: booked.bookingId,
        expectedRefundAmount: terms?.refundAmount ?? 0,
      }),
    );
    expect(canceled.kind).toBe("canceled");
    // The last party change's hold is the one released.
    expect(await seatsUsed(to)).toBe(0);
    expect(await bookingNow(booked.bookingId)).toMatchObject({
      state: "canceled",
      hold_state: "released",
      hold_party: 1,
    });
  });

  it("two removals racing on one party: one gives up its place, the other sees the change", async () => {
    const trip = tripsA.shared();
    const booked = await confirmBooking(runtime.db, payments, A, trip, 4);
    const results = await Promise.all([
      remove(guestContext(A.id), { bookingId: booked.bookingId, position: 1, partySize: 4 }),
      remove(staffContext(A.id), { bookingId: booked.bookingId, position: 2, partySize: 4 }),
    ]);
    expect(results.map((r) => r.kind).sort()).toEqual(["booking_changed", "removed"]);
    expect(await bookingNow(booked.bookingId)).toMatchObject({ party_size: 3, hold_party: 3 });
    expect(await seatsUsed(trip)).toBe(3);
  });

  it("refuses a party, a hold, or a removal written without its change, and keeps changes forever", async () => {
    const trip = tripsA.shared();
    const booked = await confirmBooking(runtime.db, payments, A, trip, 3);
    await name(A.id, booked.bookingId, 1, "Guarded One");
    const ctx = staffContext(A.id);
    await expect(
      as(ctx, (trx) =>
        trx
          .updateTable("bookings")
          .set({ party_size: 2 })
          .where("id", "=", booked.bookingId)
          .execute(),
      ),
    ).rejects.toMatchObject({ code: "23514", constraint_name: "bookings_immutable" });
    await expect(
      as(ctx, (trx) =>
        trx
          .updateTable("booking_participants")
          .set({ removed_at: new Date() })
          .where("booking_id", "=", booked.bookingId)
          .execute(),
      ),
    ).rejects.toMatchObject({ code: "23514", constraint_name: "booking_participants_removed" });
    const now = await bookingNow(booked.bookingId);
    // A change row alone, with nothing applied, fails at commit.
    await expect(
      as(ctx, (trx) =>
        trx
          .insertInto("booking_party_changes")
          .values({
            tenant_id: A.id,
            booking_id: booked.bookingId,
            trip_id: trip,
            from_hold_id: now.hold_id,
            from_party_size: 3,
            to_party_size: 2,
            position: 3,
            participant_id: null,
            before_cutoff: true,
          })
          .execute(),
      ),
    ).rejects.toMatchObject({ code: "23514", constraint_name: "booking_party_changes_applied" });
    // A change not yet applied never opens a place past the party sold.
    await expect(
      as(ctx, async (trx) => {
        await trx
          .insertInto("booking_party_changes")
          .values({
            tenant_id: A.id,
            booking_id: booked.bookingId,
            trip_id: trip,
            from_hold_id: now.hold_id,
            from_party_size: 3,
            to_party_size: 2,
            position: 2,
            participant_id: null,
            before_cutoff: true,
          })
          .execute();
        await trx
          .insertInto("booking_participants")
          .values({
            tenant_id: A.id,
            booking_id: booked.bookingId,
            position: 4,
            full_name: "Extra Four",
            is_minor: false,
          })
          .execute();
      }),
    ).rejects.toMatchObject({ code: "23514", constraint_name: "booking_participants_party_size" });
    // A change naming no one at a named place is refused at once.
    await expect(
      as(ctx, (trx) =>
        trx
          .insertInto("booking_party_changes")
          .values({
            tenant_id: A.id,
            booking_id: booked.bookingId,
            trip_id: trip,
            from_hold_id: now.hold_id,
            from_party_size: 3,
            to_party_size: 2,
            position: 1,
            participant_id: null,
            before_cutoff: true,
          })
          .execute(),
      ),
    ).rejects.toMatchObject({
      code: "23514",
      constraint_name: "booking_party_changes_participant",
    });

    const done = await remove(guestContext(A.id), {
      bookingId: booked.bookingId,
      position: 1,
      partySize: 3,
    });
    if (done.kind !== "removed") throw new Error(JSON.stringify(done));
    await expect(
      as(ctx, (trx) =>
        trx
          .updateTable("booking_participants")
          .set({ full_name: "Back Again" })
          .where("booking_id", "=", booked.bookingId)
          .execute(),
      ),
    ).rejects.toMatchObject({ code: "23514", constraint_name: "booking_participants_removed" });
    await expect(
      as(ctx, (trx) =>
        trx.deleteFrom("booking_party_changes").where("tenant_id", "=", A.id).execute(),
      ),
    ).rejects.toThrow();
    await expect(
      admin`update public.booking_party_changes set position = 9 where booking_id = ${booked.bookingId}`,
    ).rejects.toThrow();
  });
});
