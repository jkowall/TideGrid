import { randomUUID } from "node:crypto";
import {
  createDb,
  inTenantTransaction,
  type TenantContext,
  type TenantTransaction,
} from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import { changeTripSalesState } from "@tidegrid/domain-catalog";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { acquireHold, confirmHold, getTripSale } from "./index.ts";
import {
  backdateHold,
  createTenantFixture,
  systemContext,
  type TenantFixture,
  tripAllocator,
} from "./test-fixtures.ts";

type Sql = ReturnType<typeof postgres>;

const env = inject("integrationDb");
const owner = () => `checkout_session:${randomUUID()}`;

/**
 * getTripSale (W1-GUEST-API): a trip's sale state for a guest who already
 * holds seats on it, with that guest's own hold set aside and every other
 * live hold counted.
 */
describe.skipIf(!env)("a trip's sale state without the guest's own hold", () => {
  let admin: Sql;
  let runtime: ReturnType<typeof createDb>;
  let A: TenantFixture;
  let B: TenantFixture;
  let tripsA: ReturnType<typeof tripAllocator>;
  let tripsB: ReturnType<typeof tripAllocator>;

  const as = <T>(
    tenantId: string,
    fn: (trx: TenantTransaction, ctx: TenantContext) => Promise<T>,
  ): Promise<T> => {
    const ctx = systemContext(tenantId);
    return inTenantTransaction(runtime.db, ctx, (trx) => fn(trx, ctx));
  };
  const hold = async (tenantId: string, tripId: string, partySize: number, ownerRef = owner()) => {
    const result = await as(tenantId, (trx, ctx) =>
      acquireHold(trx, ctx, { ownerRef, tripId, partySize, ttlSeconds: 600 }),
    );
    if (result.kind !== "acquired") throw new Error(`expected acquired, got ${result.kind}`);
    return result.hold;
  };
  const sale = (
    tenantId: string,
    tripId: string,
    input: { partySize: number; exceptOwnerRef?: string; at?: Date },
  ) => as(tenantId, (trx) => getTripSale(trx, tenantId, tripId, input));

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 2, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 4 });
    A = await createTenantFixture(admin, runtime.db, "sale-a");
    B = await createTenantFixture(admin, runtime.db, "sale-b");
    tripsA = tripAllocator(A);
    tripsB = tripAllocator(B);
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end({ timeout: 5 });
  });

  it("counts every live hold but the excepted owner's", async () => {
    const trip = tripsA.shared();
    const mine = await hold(A.id, trip, 2);
    const theirs = await hold(A.id, trip, 8);
    expect(await sale(A.id, trip, { partySize: 1 })).toEqual({
      tripId: trip,
      kind: "seats",
      notBookable: null,
      remaining: 0,
      boatRemaining: expect.any(Number),
    });
    expect(
      (await sale(A.id, trip, { partySize: 1, exceptOwnerRef: mine.ownerRef }))?.remaining,
    ).toBe(2);
    expect(
      (await sale(A.id, trip, { partySize: 1, exceptOwnerRef: theirs.ownerRef }))?.remaining,
    ).toBe(8);
    // An owner with no hold here sets nothing aside.
    expect((await sale(A.id, trip, { partySize: 1, exceptOwnerRef: owner() }))?.remaining).toBe(0);
  });

  it("sets aside a whole held boat for its own owner only", async () => {
    const trip = tripsA.charter();
    const mine = await hold(A.id, trip, 2);
    expect(await sale(A.id, trip, { partySize: 2 })).toMatchObject({
      kind: "whole_boat",
      remaining: 0,
    });
    expect(await sale(A.id, trip, { partySize: 2, exceptOwnerRef: mine.ownerRef })).toMatchObject({
      kind: "whole_boat",
      notBookable: null,
      remaining: 6,
    });
  });

  it("counts confirmed seats, and not a hold past its time", async () => {
    const trip = tripsA.shared();
    const paid = await hold(A.id, trip, 3);
    const confirmed = await as(A.id, (trx, ctx) =>
      confirmHold(trx, ctx, { holdId: paid.id, ownerRef: paid.ownerRef }),
    );
    expect(confirmed.kind).toBe("confirmed");
    const lapsed = await hold(A.id, trip, 4);
    await backdateHold(admin, lapsed.id);
    expect((await sale(A.id, trip, { partySize: 1 }))?.remaining).toBe(7);
  });

  it("still applies every other rule a hold must pass", async () => {
    const trip = tripsA.shared();
    const mine = await hold(A.id, trip, 2);
    expect(
      (await sale(A.id, trip, { partySize: 9, exceptOwnerRef: mine.ownerRef }))?.notBookable,
    ).toBe("party_size_out_of_range");
    await as(A.id, (trx, ctx) =>
      changeTripSalesState(trx, ctx, {
        tripId: trip,
        to: "closed",
        reason: "test",
        now: new Date(),
      }),
    );
    expect(await sale(A.id, trip, { partySize: 1, exceptOwnerRef: mine.ownerRef })).toMatchObject({
      notBookable: "trip_unavailable",
      remaining: 10,
    });
    // The cutoff is judged at the instant asked for.
    const late = tripsA.late();
    expect((await sale(A.id, late, { partySize: 1 }))?.notBookable).toBe("sales_closed");
    expect(
      (await sale(A.id, late, { partySize: 1, at: new Date("2000-01-01T00:00:00Z") }))?.notBookable,
    ).toBeNull();
  });

  it("never reads another tenant's trip or holds", async () => {
    const trip = tripsB.shared();
    const theirs = await hold(B.id, trip, 4);
    expect(await sale(A.id, trip, { partySize: 1 })).toBeNull();
    expect(await sale(A.id, trip, { partySize: 1, exceptOwnerRef: theirs.ownerRef })).toBeNull();
    expect(await sale(A.id, "not-a-uuid", { partySize: 1 })).toBeNull();
    // A's own trip is unaffected by B's hold with the same owner reference.
    const mine = tripsA.shared();
    expect(
      (await sale(A.id, mine, { partySize: 1, exceptOwnerRef: theirs.ownerRef }))?.remaining,
    ).toBe(10);
  });

  it("refuses a malformed owner reference", async () => {
    await expect(
      sale(A.id, tripsA.shared(), { partySize: 1, exceptOwnerRef: "no colon" }),
    ).rejects.toThrow();
  });
});
