/**
 * An owner's capacity override (W3-G2.12-rest, migration 0038) on the local
 * PostgreSQL: one booking may take the seats it lacks past a full shared-seat
 * trip, never past the boat. Only an active owner writes one, the database
 * checks it, every other hold still counts against the trip's capacity, and
 * racing writers never pass the override.
 */
import { randomUUID } from "node:crypto";
import {
  createDb,
  inTenantTransaction,
  type TenantContext,
  type TenantTransaction,
} from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import { sql } from "kysely";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  type AcquireHoldInput,
  acquireHold,
  type CapacityOverrideRequest,
  confirmHold,
  getTripCapacity,
  getTripSale,
} from "./index.ts";
import {
  backdateHold,
  createTenantFixture,
  systemContext,
  type TenantFixture,
  tripAllocator,
} from "./test-fixtures.ts";

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

const ownerRef = () => `checkout_session:${randomUUID()}`;
const because: CapacityOverrideRequest = { reasonCode: "regular_guest" };

describe.skipIf(!env)("an owner's capacity override (W3-G2.12-rest)", () => {
  let admin: Sql;
  let runtime: ReturnType<typeof createDb>;
  let A: TenantFixture;
  let trips: ReturnType<typeof tripAllocator>;
  let ownerId: string;
  let deskId: string;
  let otherOwnerId: string;
  let bId: string;

  const staff = (tenantId: string, userId: string): TenantContext => ({
    tenantId,
    actorType: "staff",
    actorId: userId,
    requestId: `req-${randomUUID()}`,
  });
  const run = <T>(
    ctx: TenantContext,
    fn: (trx: TenantTransaction, ctx: TenantContext) => Promise<T>,
  ): Promise<T> => inTenantTransaction(runtime.db, ctx, (trx) => fn(trx, ctx));
  const acquire = (ctx: TenantContext, input: Omit<AcquireHoldInput, "ttlSeconds">) =>
    run(ctx, (trx, c) => acquireHold(trx, c, { ttlSeconds: 600, ...input }));

  async function member(tenantId: string, role: string, status = "active") {
    const id = randomUUID();
    await admin`insert into public.staff_users (id, email, display_name)
      values (${id}, ${`${role}-${id.slice(0, 8)}@example.test`}, ${role})`;
    await admin`insert into public.tenant_memberships (tenant_id, user_id, role, display_name, status)
      values (${tenantId}, ${id}, ${role}, ${role}, ${status})`;
    return id;
  }

  /** Fill a shared trip (10 seats on a 20-guest boat) with two plain holds. */
  async function fullTrip() {
    const tripId = trips.shared();
    for (const party of [5, 5]) {
      const done = await acquire(systemContext(A.id), {
        ownerRef: ownerRef(),
        tripId,
        partySize: party,
      });
      expect(done.kind).toBe("acquired");
    }
    return tripId;
  }

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 3, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 8 });
    A = await createTenantFixture(admin, runtime.db, "override-a", { days: 12 });
    trips = tripAllocator(A);
    ownerId = await member(A.id, "owner");
    deskId = await member(A.id, "booking_staff");
    const B = await createTenantFixture(admin, runtime.db, "override-b", { days: 1 });
    otherOwnerId = await member(B.id, "owner");
    bId = B.id;
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end({ timeout: 5 });
  });

  it("lets an owner's booking past a full trip by exactly what it lacks, and no one else", async () => {
    const tripId = await fullTrip();
    const owner = staff(A.id, ownerId);
    // Full without an override.
    expect(await acquire(owner, { ownerRef: ownerRef(), tripId, partySize: 3 })).toEqual({
      kind: "insufficient_capacity",
      remaining: 0,
    });
    const ref = ownerRef();
    const done = await acquire(owner, { ownerRef: ref, tripId, partySize: 3, override: because });
    if (done.kind !== "acquired") throw new Error(done.kind);
    expect(done.override?.extraSeats).toBe(3);
    const capacity = await run(owner, (trx) => getTripCapacity(trx, A.id, tripId));
    expect(capacity).toMatchObject({ total: 10, held: 13, remaining: 0, soldOut: true });
    // Every other hold still counts against the trip's ten seats.
    expect(
      await acquire(systemContext(A.id), { ownerRef: ownerRef(), tripId, partySize: 1 }),
    ).toEqual({ kind: "insufficient_capacity", remaining: 0 });
    // The row, the audit, and the event: who, why, and how many, never the note.
    const [row] = await admin<
      { extra_seats: number; reason_code: string; actor_type: string; actor_id: string }[]
    >`select extra_seats, reason_code, actor_type, actor_id from public.capacity_overrides
       where trip_id = ${tripId} and owner_ref = ${ref}`;
    expect(row).toEqual({
      extra_seats: 3,
      reason_code: "regular_guest",
      actor_type: "staff",
      actor_id: ownerId,
    });
    const audits = await admin<{ action: string; after_state: Record<string, unknown> }[]>`
      select action, after_state from public.audit_events
       where tenant_id = ${A.id} and action = 'capacity.overridden' and subject_id = ${tripId}`;
    expect(audits).toHaveLength(1);
    expect(audits[0]?.after_state).toMatchObject({ extraSeats: 3, reasonCode: "regular_guest" });

    // Booking staff cannot: the database refuses their override.
    expect(
      await failure(
        acquire(staff(A.id, deskId), {
          ownerRef: ownerRef(),
          tripId,
          partySize: 1,
          override: because,
        }),
      ),
    ).toEqual({ code: "42501", constraint: "capacity_overrides_owner" });
    // Nor an owner of another operator, nor the system.
    for (const ctx of [staff(A.id, otherOwnerId), systemContext(A.id)]) {
      expect(
        await failure(
          acquire(ctx, { ownerRef: ownerRef(), tripId, partySize: 1, override: because }),
        ),
      ).toMatchObject({ code: "42501" });
    }
  });

  it("keeps the note out of the audit and event, refuses a disabled owner, and stays in its tenant", async () => {
    const tripId = await fullTrip();
    const note = "Maria Lopez and her son, regulars";
    const ref = ownerRef();
    const done = await acquire(staff(A.id, ownerId), {
      ownerRef: ref,
      tripId,
      partySize: 2,
      override: { reasonCode: "other", note },
    });
    if (done.kind !== "acquired" || !done.override) throw new Error(done.kind);
    const [row] = await admin<{ note: string }[]>`
      select note from public.capacity_overrides where id = ${done.override.overrideId}`;
    expect(row?.note).toBe(note);
    const audits = await admin<{ after_state: unknown }[]>`
      select after_state from public.audit_events
       where tenant_id = ${A.id} and subject_id in (${tripId}, ${done.hold.id})`;
    expect(audits.length).toBeGreaterThan(0);
    expect(JSON.stringify(audits)).not.toContain("Maria");
    const events = await admin<{ payload: Record<string, unknown> }[]>`
      select payload from public.outbox_events
       where tenant_id = ${A.id} and topic = 'inventory.capacity.overridden'
         and aggregate_id = ${tripId}`;
    expect(events.map((e) => e.payload)).toEqual([
      { tripId, capacityOverrideId: done.override.overrideId, extraSeats: 2 },
    ]);
    expect(
      JSON.stringify(
        await admin`select payload from public.outbox_events where tenant_id = ${A.id}
                     and aggregate_id in (${tripId}, ${done.hold.id})`,
      ),
    ).not.toContain("Maria");

    // An owner whose membership is disabled is not an owner.
    const suspended = await member(A.id, "owner", "disabled");
    expect(
      await failure(
        acquire(staff(A.id, suspended), {
          ownerRef: ownerRef(),
          tripId,
          partySize: 1,
          override: because,
        }),
      ),
    ).toEqual({ code: "42501", constraint: "capacity_overrides_owner" });

    // Another operator sees none of A's overrides.
    const seen = await run(
      staff(bId, otherOwnerId),
      (trx) => sqlOf(trx)`select count(*)::int as n from capacity_overrides`,
    );
    expect(seen.rows[0]).toEqual({ n: 0 });
  });

  it("never passes the boat, never overrides a charter, and needs a note for other", async () => {
    const tripId = await fullTrip();
    const owner = staff(A.id, ownerId);
    // 10 taken on a 20-guest boat: 8 more fit, 11 do not (the party limit is 8 anyway).
    const first = await acquire(owner, {
      ownerRef: ownerRef(),
      tripId,
      partySize: 7,
      override: because,
    });
    expect(first).toMatchObject({ kind: "acquired", override: { extraSeats: 7 } });
    expect(
      await acquire(owner, { ownerRef: ownerRef(), tripId, partySize: 4, override: because }),
    ).toEqual({ kind: "override_exceeds_boat", boatRemaining: 3 });
    const sale = await run(owner, (trx) => getTripSale(trx, A.id, tripId, { partySize: 1 }));
    expect(sale).toMatchObject({ remaining: 0, boatRemaining: 3 });
    expect(
      await acquire(owner, { ownerRef: ownerRef(), tripId, partySize: 3, override: because }),
    ).toMatchObject({ kind: "acquired", override: { extraSeats: 10 } });
    // A charter takes the whole boat already.
    const charter = trips.charter();
    expect(
      (await acquire(systemContext(A.id), { ownerRef: ownerRef(), tripId: charter, partySize: 2 }))
        .kind,
    ).toBe("acquired");
    expect(
      await acquire(owner, {
        ownerRef: ownerRef(),
        tripId: charter,
        partySize: 2,
        override: because,
      }),
    ).toEqual({ kind: "override_exceeds_boat", boatRemaining: 0 });
    // Other needs a note.
    await expect(
      acquire(owner, {
        ownerRef: ownerRef(),
        tripId: trips.shared(),
        partySize: 1,
        override: { reasonCode: "other" },
      }),
    ).resolves.toMatchObject({ kind: "acquired", override: null });
    const full = await fullTrip();
    await expect(
      acquire(owner, {
        ownerRef: ownerRef(),
        tripId: full,
        partySize: 1,
        override: { reasonCode: "other" },
      }),
    ).rejects.toThrow(RangeError);
  });

  it("holds the rule in the database for every writer", async () => {
    const tripId = await fullTrip();
    const owner = staff(A.id, ownerId);
    const ref = ownerRef();
    // Direct writes as the runtime, as an owner: more seats than the boat has room for.
    expect(
      await failure(
        run(
          owner,
          (trx) =>
            sqlOf(
              trx,
            )`insert into capacity_overrides (tenant_id, trip_id, owner_ref, extra_seats, reason_code)
                    values (${A.id}, ${tripId}, ${ref}, 11, 'make_good')`,
        ),
      ),
    ).toEqual({ code: "23514", constraint: "capacity_overrides_boat" });
    // Only for a staff checkout's hold.
    expect(
      await failure(
        run(
          owner,
          (trx) =>
            sqlOf(
              trx,
            )`insert into capacity_overrides (tenant_id, trip_id, owner_ref, extra_seats, reason_code)
                    values (${A.id}, ${tripId}, ${`cart:${randomUUID()}`}, 1, 'make_good')`,
        ),
      ),
    ).toEqual({ code: "23514", constraint: "capacity_overrides_trip" });
    // An override of 2 lets its own hold take 2 past capacity, and no more.
    await run(
      owner,
      (trx) =>
        sqlOf(
          trx,
        )`insert into capacity_overrides (tenant_id, trip_id, owner_ref, extra_seats, reason_code)
                values (${A.id}, ${tripId}, ${ref}, 2, 'make_good')`,
    );
    const insertHold = (party: number, who: string) =>
      run(
        owner,
        (trx) =>
          sqlOf(
            trx,
          )`insert into capacity_holds (tenant_id, trip_id, owner_ref, party_size, expires_at)
                  values (${A.id}, ${tripId}, ${who}, ${party}, now() + interval '10 minutes')`,
      );
    expect(await failure(insertHold(3, ref))).toEqual({
      code: "23514",
      constraint: "capacity_holds_capacity",
    });
    await insertHold(2, ref);
    // Another owner reference gets nothing from it.
    expect(await failure(insertHold(1, ownerRef()))).toEqual({
      code: "23514",
      constraint: "capacity_holds_capacity",
    });
    // A second override for the same hold, one after its hold, a change, and
    // a removal are all refused.
    expect(
      await failure(
        run(
          owner,
          (trx) =>
            sqlOf(
              trx,
            )`insert into capacity_overrides (tenant_id, trip_id, owner_ref, extra_seats, reason_code)
                    values (${A.id}, ${tripId}, ${ref}, 1, 'make_good')`,
        ),
      ),
    ).toEqual({ code: "23514", constraint: "capacity_overrides_trip" });
    const open = trips.shared();
    const early = ownerRef();
    expect(
      (await acquire(systemContext(A.id), { ownerRef: early, tripId: open, partySize: 1 })).kind,
    ).toBe("acquired");
    expect(
      await failure(
        run(
          owner,
          (trx) =>
            sqlOf(
              trx,
            )`insert into capacity_overrides (tenant_id, trip_id, owner_ref, extra_seats, reason_code)
                    values (${A.id}, ${open}, ${early}, 1, 'make_good')`,
        ),
      ),
    ).toEqual({ code: "23514", constraint: "capacity_overrides_trip" });
    expect(
      await failure(
        run(
          owner,
          (trx) =>
            sqlOf(trx)`update capacity_overrides set extra_seats = 5 where owner_ref = ${ref}`,
        ),
      ),
    ).toMatchObject({ code: "42501" });
    expect(
      await failure(
        run(owner, (trx) => sqlOf(trx)`delete from capacity_overrides where owner_ref = ${ref}`),
      ),
    ).toMatchObject({ code: "42501" });
  });

  it("never lets racing writers pass the override, and reacquires an expired overridden hold", async () => {
    const tripId = await fullTrip();
    const owner = staff(A.id, ownerId);
    // Two owners' overrides and two plain holds at once on a full trip.
    const results = await Promise.all([
      acquire(owner, { ownerRef: ownerRef(), tripId, partySize: 4, override: because }),
      acquire(owner, { ownerRef: ownerRef(), tripId, partySize: 4, override: because }),
      acquire(systemContext(A.id), { ownerRef: ownerRef(), tripId, partySize: 1 }),
      acquire(systemContext(A.id), { ownerRef: ownerRef(), tripId, partySize: 1 }),
    ]);
    expect(results.slice(2).map((r) => r.kind)).toEqual([
      "insufficient_capacity",
      "insufficient_capacity",
    ]);
    const capacity = await run(owner, (trx) => getTripCapacity(trx, A.id, tripId));
    expect(capacity?.held).toBe(18);
    // Each override is the shortfall at its turn under the trip lock: 4, then 8.
    const extras = results
      .slice(0, 2)
      .map((r) => (r.kind === "acquired" ? r.override?.extraSeats : null))
      .sort();
    expect(extras).toEqual([4, 8]);

    // The overridden hold expires, then a late payment reacquires it with its allowance.
    const late = await fullTrip();
    const ref = ownerRef();
    const held = await acquire(owner, {
      ownerRef: ref,
      tripId: late,
      partySize: 2,
      override: because,
    });
    if (held.kind !== "acquired") throw new Error(held.kind);
    await backdateHold(admin, held.hold.id);
    const confirmed = await run(systemContext(A.id), (trx, c) =>
      confirmHold(trx, c, { holdId: held.hold.id, ownerRef: ref }),
    );
    expect(confirmed).toMatchObject({ kind: "confirmed", reacquired: true });
  });
});

/** The kysely sql tag bound to a transaction, for direct writes. */
function sqlOf(trx: TenantTransaction) {
  return (strings: TemplateStringsArray, ...values: unknown[]) =>
    sql(strings, ...values).execute(trx);
}
