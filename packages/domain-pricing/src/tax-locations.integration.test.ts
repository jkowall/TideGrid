import { randomUUID } from "node:crypto";
import { Quote } from "@tidegrid/contracts";
import { createDb, inTenantTransaction, type TenantContext } from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import {
  createBoat,
  createLocation,
  createProduct,
  createSchedule,
  generateTrips,
  publishProduct,
} from "@tidegrid/domain-catalog";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  createPolicyVersion,
  createPriceListVersion,
  createQuote,
  createTaxRate,
  createTaxRateVersion,
  getQuote,
  getTripOffer,
  type PolicyInput,
} from "./index.ts";

type Sql = ReturnType<typeof postgres>;

const env = inject("integrationDb");
const NOW = new Date("2026-10-15T00:00:00Z");

async function pgCode(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (err) {
    return (err as { code?: string }).code;
  }
}

const policy: PolicyInput = {
  changeCutoffMinutes: 1440,
  beforeCutoff: { remedy: "full_refund" },
  afterCutoff: { remedy: "none" },
  noShow: { remedy: "none" },
  text: {
    cancellation: "Full refund until a day before departure.",
    reschedule: "Move to another departure before the cutoff.",
    noShow: "No refund for a no-show.",
    operatorCancellation: "If we cancel, choose a refund or a credit.",
    weather: "The captain decides on the day.",
  },
};

/**
 * W3-G2.5-TAX: a tax rate version can name the one location whose departures
 * it applies to. One operator with two docks: a state tax at both and a city
 * tax at the north dock only. Amounts are integer cents; 6% and 2.5% of a
 * $45.00 ticket round half up per line.
 */
describe.skipIf(!env)("per-location tax rates against a real database", () => {
  let admin: Sql;
  let runtime: ReturnType<typeof createDb>;
  const run = randomUUID().slice(0, 8);
  const A = { id: randomUUID(), slug: `taxloc-a-${run}` };
  const B = { id: randomUUID(), slug: `taxloc-b-${run}` };
  const system = (tenantId: string): TenantContext => ({
    tenantId,
    actorType: "system",
    actorId: `taxloc-test-${run}`,
    requestId: `req-${run}`,
  });
  const guest = (tenantId: string): TenantContext => ({
    tenantId,
    actorType: "guest",
    actorId: null,
    requestId: `guest-${run}`,
  });
  const asSystem = <T>(tenantId: string, fn: Parameters<typeof inTenantTransaction<T>>[2]) =>
    inTenantTransaction(runtime.db, system(tenantId), fn);
  const asGuest = <T>(tenantId: string, fn: Parameters<typeof inTenantTransaction<T>>[2]) =>
    inTenantTransaction(runtime.db, guest(tenantId), fn);

  const a = { north: "", south: "", northTrip: "", southTrip: "", state: "", city: "" };
  let bLocation = "";

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 2, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 4 });
    await admin`insert into public.tenants (id, slug, display_name) values
      (${A.id}, ${A.slug}, ${`Tax locations A ${run}`}),
      (${B.id}, ${B.slug}, ${`Tax locations B ${run}`})`;

    await asSystem(A.id, async (trx) => {
      const c = system(A.id);
      for (const side of ["north", "south"] as const) {
        const location = await createLocation(trx, c, {
          name: side === "north" ? "North Dock" : "South Dock",
          timeZone: "America/New_York",
          reason: "fixture",
        });
        a[side] = location;
        const boat = await createBoat(trx, c, {
          name: `${side} boat`,
          guestCapacity: 20,
          reason: "fixture",
        });
        const productId = await createProduct(trx, c, {
          locationId: location,
          kind: "shared_seat",
          name: `${side} cruise`,
          durationMinutes: 90,
          maxPartySize: 8,
          eligibleBoatIds: [boat],
          reason: "fixture",
        });
        await createPriceListVersion(trx, c, {
          productId,
          tickets: [{ code: "adult", name: "Adult", unitAmount: 4500, taxable: true }],
          fees: [
            {
              code: "dock",
              name: "Dock fee",
              unitAmount: 300,
              basis: "per_booking",
              taxable: false,
            },
          ],
          reason: "fixture",
        });
        await createPolicyVersion(trx, c, { ...policy, productId, reason: "fixture" });
        expect((await publishProduct(trx, c, { productId, reason: "fixture" })).kind).toBe(
          "published",
        );
        const schedule = await createSchedule(trx, c, {
          productId,
          boatId: boat,
          startsOn: "2026-11-01",
          endsOn: "2027-03-31",
          weekdays: [1, 2, 3, 4, 5, 6, 7],
          startTimes: ["10:00"],
          reason: "fixture",
        });
        if (schedule.kind !== "created") throw new Error(JSON.stringify(schedule));
        const generated = await generateTrips(trx, c, {
          scheduleId: schedule.id,
          fromDate: "2026-11-10",
          toDate: "2026-11-10",
          publish: true,
          reason: "fixture",
        });
        if (generated.kind !== "generated") throw new Error(JSON.stringify(generated));
        a[side === "north" ? "northTrip" : "southTrip"] = generated.created[0]?.tripId ?? "";
      }
      const state = await createTaxRate(trx, c, {
        name: "State sales tax",
        ratePpm: 60_000,
        inclusive: false,
        reason: "fixture",
      });
      const city = await createTaxRate(trx, c, {
        name: "City tax",
        ratePpm: 25_000,
        inclusive: false,
        locationId: a.north,
        reason: "fixture",
      });
      if (state.kind !== "created" || city.kind !== "created") throw new Error("tax fixture");
      a.state = state.taxRateId;
      a.city = city.taxRateId;
    });

    await asSystem(B.id, async (trx) => {
      bLocation = await createLocation(trx, system(B.id), {
        name: "Elsewhere",
        timeZone: "America/New_York",
        reason: "fixture",
      });
    });
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end({ timeout: 5 });
  });

  const quote = (tripId: string) =>
    asGuest(A.id, async (trx) => {
      const r = await createQuote(trx, guest(A.id), {
        tripId,
        party: { kind: "tickets", tickets: [{ code: "adult", quantity: 1 }] },
        addOns: [],
        promotionCode: null,
        now: NOW,
      });
      if (r.kind !== "created") throw new Error(JSON.stringify(r));
      return Quote.parse(r.quote);
    });
  const taxesOf = (q: Quote) => q.taxes.map((t) => [t.name, t.version, t.taxableAmount, t.amount]);

  it("applies a location's rate only to trips departing there, and a rate for every location to both", async () => {
    const north = await quote(a.northTrip);
    const south = await quote(a.southTrip);
    // 4500 x 2.5% = 112.5, rounds half up to 113; 4500 x 6% = 270.
    expect(taxesOf(north)).toEqual([
      ["City tax", 1, 4500, 113],
      ["State sales tax", 1, 4500, 270],
    ]);
    expect(north.totals).toMatchObject({ subtotal: 4500, fees: 300, tax: 383, total: 5183 });
    expect(taxesOf(south)).toEqual([["State sales tax", 1, 4500, 270]]);
    expect(south.totals).toMatchObject({ subtotal: 4500, fees: 300, tax: 270, total: 5070 });

    const offers = await asGuest(A.id, async (trx) => ({
      north: await getTripOffer(trx, A.id, a.northTrip, NOW),
      south: await getTripOffer(trx, A.id, a.southTrip, NOW),
    }));
    if (offers.north.kind !== "offer" || offers.south.kind !== "offer") throw new Error("offer");
    expect(offers.north.offer.taxes.map((t) => t.name)).toEqual(["City tax", "State sales tax"]);
    expect(offers.south.offer.taxes.map((t) => t.name)).toEqual(["State sales tax"]);
  });

  it("moves a rate by appending a version, and keeps earlier quotes exactly as priced", async () => {
    const before = await quote(a.northTrip);
    const moved = await asSystem(A.id, (trx) =>
      createTaxRateVersion(trx, system(A.id), {
        taxRateId: a.city,
        name: "City tax",
        ratePpm: 25_000,
        inclusive: false,
        active: true,
        locationId: a.south,
        reason: "the city tax belongs to the south dock",
      }),
    );
    expect(moved).toEqual({ kind: "created", version: 2 });

    expect(taxesOf(await quote(a.northTrip))).toEqual([["State sales tax", 1, 4500, 270]]);
    expect(taxesOf(await quote(a.southTrip))).toEqual([
      ["City tax", 2, 4500, 113],
      ["State sales tax", 1, 4500, 270],
    ]);
    const reread = await asGuest(A.id, (trx) => getQuote(trx, A.id, before.quoteId));
    expect(reread).toEqual(before);

    // A version that names no location keeps the current one, so a scoped
    // rate never widens to every location by accident.
    const restated = await asSystem(A.id, (trx) =>
      createTaxRateVersion(trx, system(A.id), {
        taxRateId: a.city,
        name: "City tax",
        ratePpm: 30_000,
        inclusive: false,
        active: true,
        reason: "new city rate",
      }),
    );
    expect(restated).toEqual({ kind: "created", version: 3 });
    expect(taxesOf(await quote(a.northTrip))).toEqual([["State sales tax", 1, 4500, 270]]);
    expect(taxesOf(await quote(a.southTrip))).toEqual([
      ["City tax", 3, 4500, 135],
      ["State sales tax", 1, 4500, 270],
    ]);

    // An explicit null applies it at every location.
    expect(
      await asSystem(A.id, (trx) =>
        createTaxRateVersion(trx, system(A.id), {
          taxRateId: a.city,
          name: "City tax",
          ratePpm: 30_000,
          inclusive: false,
          active: true,
          locationId: null,
          reason: "applies everywhere now",
        }),
      ),
    ).toEqual({ kind: "created", version: 4 });
    expect(taxesOf(await quote(a.northTrip))).toEqual([
      ["City tax", 4, 4500, 135],
      ["State sales tax", 1, 4500, 270],
    ]);

    const audit = await admin<{ after: { locationId: string | null; version: number } }[]>`
      select after_state as after from public.audit_events
       where tenant_id = ${A.id} and subject_id = ${a.city} order by id`;
    expect(audit.map((r) => [r.after.version, r.after.locationId])).toEqual([
      [1, a.north],
      [2, a.south],
      [3, a.south],
      [4, null],
    ]);
  });

  it("refuses a location that is malformed, unknown, or another operator's", async () => {
    const results = await asSystem(A.id, async (trx) => {
      const c = system(A.id);
      const base = { name: "Bad", ratePpm: 10_000, inclusive: false, reason: "test" };
      return [
        await createTaxRate(trx, c, { ...base, locationId: "not-a-uuid" }),
        await createTaxRate(trx, c, { ...base, locationId: randomUUID() }),
        await createTaxRate(trx, c, { ...base, locationId: bLocation }),
        await createTaxRateVersion(trx, c, {
          ...base,
          taxRateId: a.state,
          active: true,
          locationId: bLocation,
        }),
      ];
    });
    for (const r of results) expect(r).toEqual({ kind: "invalid", problems: ["invalid_location"] });
  });

  it("refuses, in the database, a rate version naming another tenant's location", async () => {
    const code = await pgCode(
      admin`insert into public.tax_rate_versions
              (tenant_id, tax_rate_id, version, name, rate_ppm, inclusive, active, reason, location_id)
            values (${B.id}, ${randomUUID()}, 1, 'Leak', 10000, false, true, 'test', ${a.north})`,
    );
    expect(code).toBe("23503");
  });

  it("refuses, in the database, a quote tax from a rate scoped to another location", async () => {
    // A rate scoped to the north dock, forged onto a south quote by a writer
    // with direct SQL in the quote's own transaction.
    const north = await asSystem(A.id, (trx) =>
      createTaxRate(trx, system(A.id), {
        name: "North levy",
        ratePpm: 10_000,
        inclusive: false,
        locationId: a.north,
        reason: "fixture",
      }),
    );
    if (north.kind !== "created") throw new Error("fixture");
    const code = await pgCode(
      asGuest(A.id, async (trx) => {
        const r = await createQuote(trx, guest(A.id), {
          tripId: a.southTrip,
          party: { kind: "tickets", tickets: [{ code: "adult", quantity: 1 }] },
          addOns: [],
          promotionCode: null,
          now: NOW,
        });
        if (r.kind !== "created") throw new Error(JSON.stringify(r));
        await trx
          .insertInto("quote_line_taxes")
          .values({
            tenant_id: A.id,
            quote_id: r.quote.quoteId,
            line_no: 1,
            tax_rate_id: north.taxRateId,
            tax_rate_version: 1,
            taxable_amount: 4500,
            amount: 45,
          })
          .execute();
      }),
    );
    expect(code).toBe("23514");
  });
});
