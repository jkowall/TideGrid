import { randomUUID } from "node:crypto";
import { Quote, TripOffer } from "@tidegrid/contracts";
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
import { sql } from "kysely";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  createPolicyVersion,
  createPriceListVersion,
  createPromotion,
  createPromotionVersion,
  createQuote,
  createTaxRate,
  createTaxRateVersion,
  getQuote,
  getTripOffer,
  type PolicyInput,
} from "./index.ts";

type Sql = ReturnType<typeof postgres>;

const env = inject("integrationDb");
/** Every quote is priced at this instant, before the fixture trips depart. */
const NOW = new Date("2026-10-15T00:00:00Z");

async function pgCode(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (err) {
    return (err as { code?: string }).code;
  }
}

const policy = (cutoffMinutes: number): PolicyInput => ({
  changeCutoffMinutes: cutoffMinutes,
  beforeCutoff: { remedy: "full_refund" },
  afterCutoff: { remedy: "percent_refund", refundBp: 5000 },
  noShow: { remedy: "none" },
  text: {
    cancellation: `Full refund until ${cutoffMinutes / 60} hours before departure.`,
    reschedule: "Move to another departure before the cutoff.",
    noShow: "No refund for a no-show.",
    operatorCancellation: "If we cancel, choose a refund or a credit.",
    weather: "The captain decides on the day.",
  },
});

describe.skipIf(!env)("pricing services against a real database as the runtime role", () => {
  let admin: Sql;
  let runtime: ReturnType<typeof createDb>;
  const run = randomUUID().slice(0, 8);
  const A = { id: randomUUID(), slug: `price-a-${run}` };
  const B = { id: randomUUID(), slug: `price-b-${run}` };
  const system = (tenantId: string): TenantContext => ({
    tenantId,
    actorType: "system",
    actorId: `pricing-test-${run}`,
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

  const a = {
    cruise: "",
    charter: "",
    cruiseSchedule: "",
    cruiseTrips: [] as string[],
    charterTrip: "",
    state: "",
    county: "",
  };
  const b = { dive: "", diveTrip: "" };

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 2, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 4 });
    await admin`insert into public.tenants (id, slug, display_name) values
      (${A.id}, ${A.slug}, ${`Pricing A ${run}`}), (${B.id}, ${B.slug}, ${`Pricing B ${run}`})`;

    await asSystem(A.id, async (trx) => {
      const c = system(A.id);
      const location = await createLocation(trx, c, {
        name: "Dock C",
        timeZone: "America/New_York",
        reason: "fixture",
      });
      const lark = await createBoat(trx, c, { name: "Lark", guestCapacity: 20, reason: "fixture" });
      const heron = await createBoat(trx, c, {
        name: "Heron",
        guestCapacity: 8,
        reason: "fixture",
      });
      a.cruise = await createProduct(trx, c, {
        locationId: location,
        kind: "shared_seat",
        name: "Sunset Cruise",
        durationMinutes: 90,
        bookingCutoffMinutes: 60,
        maxPartySize: 8,
        seatLimit: 12,
        eligibleBoatIds: [lark],
        reason: "fixture",
      });
      a.charter = await createProduct(trx, c, {
        locationId: location,
        kind: "private_charter",
        name: "Half-Day Charter",
        durationMinutes: 240,
        bookingCutoffMinutes: 1440,
        maxPartySize: 8,
        eligibleBoatIds: [heron],
        reason: "fixture",
      });
      const cruisePrice = await createPriceListVersion(trx, c, {
        productId: a.cruise,
        tickets: [
          { code: "adult", name: "Adult", unitAmount: 4500, taxable: true },
          { code: "child", name: "Child", unitAmount: 2500, taxable: true },
        ],
        fees: [
          {
            code: "harbor",
            name: "Harbor fee",
            unitAmount: 250,
            basis: "per_participant",
            taxable: false,
          },
        ],
        addOns: [
          {
            code: "photo",
            name: "Souvenir photo",
            unitAmount: 1200,
            quantityRule: "per_booking",
            maxQuantity: 2,
            taxable: true,
          },
          {
            code: "toast",
            name: "Holiday toast",
            unitAmount: 1500,
            quantityRule: "per_participant",
            maxQuantity: 1,
            taxable: true,
            availableFrom: "2026-12-15",
            availableUntil: "2027-01-02",
          },
        ],
        reason: "fixture",
      });
      expect(cruisePrice).toEqual({ kind: "created", version: 1 });
      expect(
        await createPriceListVersion(trx, c, {
          productId: a.charter,
          charter: { name: "Whole boat", amount: 120000, taxable: true },
          fees: [
            { code: "fuel", name: "Fuel", unitAmount: 7500, basis: "per_booking", taxable: true },
          ],
          reason: "fixture",
        }),
      ).toEqual({ kind: "created", version: 1 });
      expect(
        await createPolicyVersion(trx, c, {
          ...policy(1440),
          productId: a.cruise,
          reason: "fixture",
        }),
      ).toEqual({
        kind: "created",
        version: 1,
      });
      expect(
        await createPolicyVersion(trx, c, {
          ...policy(10080),
          productId: a.charter,
          reason: "fixture",
        }),
      ).toEqual({ kind: "created", version: 1 });
      const state = await createTaxRate(trx, c, {
        name: "State sales tax",
        ratePpm: 60_000,
        inclusive: false,
        reason: "fixture",
      });
      const county = await createTaxRate(trx, c, {
        name: "County surtax",
        ratePpm: 10_000,
        inclusive: false,
        reason: "fixture",
      });
      if (state.kind !== "created" || county.kind !== "created") throw new Error("tax fixture");
      a.state = state.taxRateId;
      a.county = county.taxRateId;
      const promo = await createPromotion(trx, c, {
        code: "harbor10",
        discount: { kind: "percent", percentOffBp: 1000 },
        startsAt: new Date("2026-09-01T00:00:00Z"),
        endsAt: new Date("2027-06-01T00:00:00Z"),
        products: { all: true },
        reason: "fixture",
      });
      expect(promo.kind).toBe("created");
      // A second code, for the charter only, so the product list table has rows.
      const charterOnly = await createPromotion(trx, c, {
        code: "CHARTER50",
        discount: { kind: "fixed_amount", amountOff: 5000 },
        startsAt: new Date("2026-09-01T00:00:00Z"),
        endsAt: new Date("2027-06-01T00:00:00Z"),
        products: { productIds: [a.charter] },
        reason: "fixture",
      });
      expect(charterOnly.kind).toBe("created");
      for (const productId of [a.cruise, a.charter]) {
        expect((await publishProduct(trx, c, { productId, reason: "fixture" })).kind).toBe(
          "published",
        );
      }
      for (const [productId, boatId, days, times] of [
        [a.cruise, lark, [1, 2, 3, 4, 5, 6, 7], ["18:00"]],
        [a.charter, heron, [6], ["08:00"]],
      ] as const) {
        const schedule = await createSchedule(trx, c, {
          productId,
          boatId,
          startsOn: "2026-11-01",
          endsOn: "2027-03-31",
          weekdays: [...days],
          startTimes: [...times],
          reason: "fixture",
        });
        if (schedule.kind !== "created") throw new Error(JSON.stringify(schedule));
        const generated = await generateTrips(trx, c, {
          scheduleId: schedule.id,
          fromDate: productId === a.cruise ? "2026-11-10" : "2026-11-14",
          toDate: productId === a.cruise ? "2026-11-12" : "2026-11-14",
          publish: true,
          reason: "fixture",
        });
        if (generated.kind !== "generated") throw new Error(JSON.stringify(generated));
        if (productId === a.cruise) {
          a.cruiseSchedule = schedule.id;
          a.cruiseTrips = generated.created.map((t) => t.tripId);
        } else a.charterTrip = generated.created[0]?.tripId ?? "";
      }
    });

    await asSystem(B.id, async (trx) => {
      const c = system(B.id);
      const location = await createLocation(trx, c, {
        name: "Reef Point",
        timeZone: "Pacific/Honolulu",
        reason: "fixture",
      });
      const boat = await createBoat(trx, c, {
        name: "Runner",
        guestCapacity: 12,
        reason: "fixture",
      });
      b.dive = await createProduct(trx, c, {
        locationId: location,
        kind: "shared_seat",
        name: "Morning Dive",
        durationMinutes: 240,
        maxPartySize: 6,
        eligibleBoatIds: [boat],
        reason: "fixture",
      });
      await createPriceListVersion(trx, c, {
        productId: b.dive,
        tickets: [{ code: "diver", name: "Certified diver", unitAmount: 16500, taxable: true }],
        reason: "fixture",
      });
      await createPolicyVersion(trx, c, { ...policy(2880), productId: b.dive, reason: "fixture" });
      await createTaxRate(trx, c, {
        name: "General excise tax",
        ratePpm: 47_120,
        inclusive: true,
        reason: "fixture",
      });
      await createPromotion(trx, c, {
        code: "REEFONLY",
        discount: { kind: "fixed_amount", amountOff: 2500 },
        startsAt: new Date("2026-09-01T00:00:00Z"),
        endsAt: new Date("2027-06-01T00:00:00Z"),
        products: { productIds: [b.dive] },
        reason: "fixture",
      });
      expect((await publishProduct(trx, c, { productId: b.dive, reason: "fixture" })).kind).toBe(
        "published",
      );
      const schedule = await createSchedule(trx, c, {
        productId: b.dive,
        boatId: boat,
        startsOn: "2026-11-01",
        endsOn: "2027-03-31",
        weekdays: [1, 2, 3, 4, 5, 6, 7],
        startTimes: ["07:30"],
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
      b.diveTrip = generated.created[0]?.tripId ?? "";
    });
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end();
  });

  const cruiseQuote = (tenantId: string, tripId: string, extra: { promotionCode?: string } = {}) =>
    asGuest(tenantId, (trx) =>
      createQuote(trx, guest(tenantId), {
        tripId,
        party: {
          kind: "tickets",
          tickets: [
            { code: "adult", quantity: 2 },
            { code: "child", quantity: 1 },
          ],
        },
        addOns: [{ code: "photo", quantity: 1 }],
        promotionCode: extra.promotionCode ?? null,
        now: NOW,
      }),
    );

  describe("quotes", () => {
    it("stores a quote that names every version it used and reads back identically", async () => {
      const created = await cruiseQuote(A.id, a.cruiseTrips[0] ?? "", {
        promotionCode: "Harbor10",
      });
      if (created.kind !== "created") throw new Error(JSON.stringify(created));
      const q = Quote.parse(created.quote);
      expect(q.product).toEqual({ id: a.cruise, name: "Sunset Cruise", kind: "shared_seat" });
      expect(q.trip).toMatchObject({
        timeZone: "America/New_York",
        localDate: "2026-11-10",
        localStartTime: "18:00",
        startsAt: "2026-11-10T23:00:00.000Z",
        startsAtLocal: "2026-11-10T18:00:00-05:00",
      });
      expect(q.partySize).toBe(3);
      expect(q.priceListVersion).toBe(1);
      expect(q.policy).toMatchObject({
        version: 1,
        changeCutoffMinutes: 1440,
        changeCutoffAt: "2026-11-09T23:00:00.000Z",
        afterCutoff: { remedy: "percent_refund", refundBp: 5000 },
      });
      expect(q.promotion).toEqual({
        code: "HARBOR10",
        version: 1,
        discountKind: "percent",
        amountOff: null,
        percentOffBp: 1000,
      });
      expect(
        q.lines.map((l) => [l.lineNo, l.kind, l.code, l.quantity, l.amount, l.discountAmount]),
      ).toEqual([
        [1, "ticket", "adult", 2, 9000, 900],
        [2, "ticket", "child", 1, 2500, 250],
        [3, "add_on", "photo", 1, 1200, 0],
        [4, "fee", "harbor", 3, 750, 0],
        [5, "discount", "HARBOR10", 1, -1150, 0],
      ]);
      expect(q.lines[4]?.name).toBe("HARBOR10, 10% off");
      // County 1% and state 6% on 8100, 2250, and 1200; the harbor fee is not taxable.
      expect(q.taxes.map((t) => [t.name, t.taxableAmount, t.amount])).toEqual([
        ["County surtax", 11550, 116],
        ["State sales tax", 11550, 693],
      ]);
      expect(q.totals).toEqual({
        subtotal: 12700,
        discount: 1150,
        fees: 750,
        tax: 809,
        includedTax: 0,
        total: 13109,
        amountDueNow: 13109,
      });
      expect(q.quotedAt).toBe(NOW.toISOString());
      expect(q.expiresAt).toBe("2026-10-15T00:30:00.000Z");
      const read = await asGuest(A.id, (trx) => getQuote(trx, A.id, q.quoteId));
      expect(read).toEqual(created.quote);
    });

    it("keeps an old quote exactly as priced after every term changes", async () => {
      const tripId = a.cruiseTrips[1] ?? "";
      const before = await cruiseQuote(A.id, tripId, { promotionCode: "HARBOR10" });
      if (before.kind !== "created") throw new Error(JSON.stringify(before));
      await asSystem(A.id, async (trx) => {
        const c = system(A.id);
        expect(
          await createPriceListVersion(trx, c, {
            productId: a.cruise,
            tickets: [
              { code: "adult", name: "Adult", unitAmount: 5500, taxable: true },
              { code: "child", name: "Child", unitAmount: 3000, taxable: true },
            ],
            fees: [
              {
                code: "harbor",
                name: "Harbor fee",
                unitAmount: 300,
                basis: "per_participant",
                taxable: false,
              },
            ],
            addOns: [
              {
                code: "photo",
                name: "Photo package",
                unitAmount: 1500,
                quantityRule: "per_booking",
                maxQuantity: 2,
                taxable: true,
              },
            ],
            reason: "price rise",
          }),
        ).toEqual({ kind: "created", version: 2 });
        expect(
          await createPolicyVersion(trx, c, {
            ...policy(2880),
            productId: a.cruise,
            reason: "longer cutoff",
          }),
        ).toEqual({ kind: "created", version: 2 });
        expect(
          await createTaxRateVersion(trx, c, {
            taxRateId: a.state,
            name: "State sales tax",
            ratePpm: 65_000,
            inclusive: false,
            active: true,
            reason: "rate change",
          }),
        ).toEqual({ kind: "created", version: 2 });
        const promo = await trx
          .selectFrom("promotions")
          .select("id")
          .where("tenant_id", "=", A.id)
          .where("code", "=", "HARBOR10")
          .executeTakeFirstOrThrow();
        expect(
          await createPromotionVersion(trx, c, {
            promotionId: promo.id,
            discount: { kind: "percent", percentOffBp: 2000 },
            startsAt: new Date("2026-09-01T00:00:00Z"),
            endsAt: new Date("2027-06-01T00:00:00Z"),
            products: { all: true },
            active: true,
            reason: "bigger discount",
          }),
        ).toEqual({ kind: "created", version: 2 });
      });

      const reread = await asGuest(A.id, (trx) => getQuote(trx, A.id, before.quote.quoteId));
      expect(reread).toEqual(before.quote);

      const after = await cruiseQuote(A.id, tripId, { promotionCode: "HARBOR10" });
      if (after.kind !== "created") throw new Error(JSON.stringify(after));
      expect(after.quote.priceListVersion).toBe(2);
      expect(after.quote.policy.version).toBe(2);
      expect(after.quote.promotion?.version).toBe(2);
      expect(after.quote.taxes.find((t) => t.name === "State sales tax")).toMatchObject({
        version: 2,
        ratePpm: 65_000,
      });
      expect(after.quote.lines.slice(0, 3).map((l) => [l.code, l.unitAmount, l.name])).toEqual([
        ["adult", 5500, "Adult"],
        ["child", 3000, "Child"],
        ["photo", 1500, "Photo package"],
      ]);
      expect(after.quote.totals.total).not.toBe(before.quote.totals.total);
    });

    it("stops taxing with a retired rate in new quotes only", async () => {
      const tripId = a.cruiseTrips[2] ?? "";
      const before = await cruiseQuote(A.id, tripId);
      if (before.kind !== "created") throw new Error(JSON.stringify(before));
      await asSystem(A.id, (trx) =>
        createTaxRateVersion(trx, system(A.id), {
          taxRateId: a.county,
          name: "County surtax",
          ratePpm: 10_000,
          inclusive: false,
          active: false,
          reason: "repealed",
        }),
      );
      const after = await cruiseQuote(A.id, tripId);
      if (after.kind !== "created") throw new Error(JSON.stringify(after));
      expect(before.quote.taxes.map((t) => t.name)).toEqual(["County surtax", "State sales tax"]);
      expect(after.quote.taxes.map((t) => t.name)).toEqual(["State sales tax"]);
      expect(await asGuest(A.id, (trx) => getQuote(trx, A.id, before.quote.quoteId))).toEqual(
        before.quote,
      );
    });

    it("prices a charter at its fixed price and lists its offer", async () => {
      const offer = await asGuest(A.id, (trx) => getTripOffer(trx, A.id, a.charterTrip, NOW));
      if (offer.kind !== "offer") throw new Error(JSON.stringify(offer));
      expect(TripOffer.parse(offer.offer)).toMatchObject({
        product: { kind: "private_charter", minPartySize: 1, maxPartySize: 8 },
        tickets: [],
        charter: { name: "Whole boat", amount: 120000, taxable: true },
        fees: [{ code: "fuel", basis: "per_booking", unitAmount: 7500 }],
        policy: { version: 1, changeCutoffMinutes: 10080 },
      });
      const quote = await asGuest(A.id, (trx) =>
        createQuote(trx, guest(A.id), {
          tripId: a.charterTrip,
          party: { kind: "charter", guests: 6 },
          addOns: [],
          promotionCode: null,
          now: NOW,
        }),
      );
      if (quote.kind !== "created") throw new Error(JSON.stringify(quote));
      expect(quote.quote.lines.map((l) => [l.kind, l.amount])).toEqual([
        ["charter", 120000],
        ["fee", 7500],
      ]);
      expect(quote.quote.partySize).toBe(6);
    });

    it("offers a dated add-on only for trips on its dates", async () => {
      const december = await asSystem(A.id, async (trx) => {
        const c = system(A.id);
        const created = await createPriceListVersion(trx, c, {
          productId: a.cruise,
          tickets: [
            { code: "adult", name: "Adult", unitAmount: 4500, taxable: true },
            { code: "child", name: "Child", unitAmount: 2500, taxable: true },
          ],
          fees: [
            {
              code: "harbor",
              name: "Harbor fee",
              unitAmount: 250,
              basis: "per_participant",
              taxable: false,
            },
          ],
          addOns: [
            {
              code: "photo",
              name: "Souvenir photo",
              unitAmount: 1200,
              quantityRule: "per_booking",
              maxQuantity: 2,
              taxable: true,
            },
            {
              code: "toast",
              name: "Holiday toast",
              unitAmount: 1500,
              quantityRule: "per_participant",
              maxQuantity: 1,
              taxable: true,
              availableFrom: "2026-12-15",
              availableUntil: "2027-01-02",
            },
          ],
          reason: "holiday menu",
        });
        expect(created.kind).toBe("created");
        const generated = await generateTrips(trx, c, {
          scheduleId: a.cruiseSchedule,
          fromDate: "2026-12-20",
          toDate: "2026-12-20",
          publish: true,
          reason: "holiday trip",
        });
        if (generated.kind !== "generated") throw new Error(JSON.stringify(generated));
        return generated.created[0]?.tripId ?? "";
      });
      const offerOn = async (tripId: string) => {
        const offer = await asGuest(A.id, (trx) => getTripOffer(trx, A.id, tripId, NOW));
        if (offer.kind !== "offer") throw new Error(JSON.stringify(offer));
        return offer.offer.addOns.map((x) => x.code);
      };
      expect(await offerOn(a.cruiseTrips[0] ?? "")).toEqual(["photo"]);
      expect(await offerOn(december)).toEqual(["photo", "toast"]);
      const toast = (tripId: string) =>
        asGuest(A.id, (trx) =>
          createQuote(trx, guest(A.id), {
            tripId,
            party: { kind: "tickets", tickets: [{ code: "adult", quantity: 3 }] },
            addOns: [{ code: "toast", quantity: 3 }],
            promotionCode: null,
            now: NOW,
          }),
        );
      expect(await toast(a.cruiseTrips[0] ?? "")).toEqual({
        kind: "rejected",
        problems: [{ code: "add_on_unavailable", subject: "toast" }],
      });
      const holiday = await toast(december);
      if (holiday.kind !== "created") throw new Error(JSON.stringify(holiday));
      expect(holiday.quote.lines.find((l) => l.code === "toast")).toMatchObject({
        quantity: 3,
        amount: 4500,
        basis: "per_participant",
      });
    });

    it("refuses a trip that is not on sale and a trip of another tenant", async () => {
      const closed = a.cruiseTrips[2] ?? "";
      await admin`update public.scheduled_trips set sales_state = 'closed' where id = ${closed}`;
      expect(await cruiseQuote(A.id, closed)).toEqual({ kind: "trip_not_on_sale" });
      expect(await cruiseQuote(A.id, b.diveTrip)).toEqual({ kind: "trip_not_found" });
      expect(await cruiseQuote(A.id, "not-a-uuid")).toEqual({ kind: "trip_not_found" });
      expect(await asGuest(A.id, (trx) => getTripOffer(trx, A.id, b.diveTrip, NOW))).toEqual({
        kind: "trip_not_found",
      });
      // After the sales cutoff the trip is not on sale either.
      const late = await asGuest(A.id, (trx) =>
        getTripOffer(trx, A.id, a.cruiseTrips[0] ?? "", new Date("2026-11-10T22:30:00Z")),
      );
      expect(late).toEqual({ kind: "trip_not_on_sale" });
    });

    it("never applies another tenant's promotion code or reveals its quotes", async () => {
      const foreignCode = await cruiseQuote(A.id, a.cruiseTrips[0] ?? "", {
        promotionCode: "REEFONLY",
      });
      expect(foreignCode).toEqual({
        kind: "rejected",
        problems: [{ code: "promotion_not_applicable", reason: "unknown" }],
      });
      const bQuote = await asGuest(B.id, (trx) =>
        createQuote(trx, guest(B.id), {
          tripId: b.diveTrip,
          party: { kind: "tickets", tickets: [{ code: "diver", quantity: 2 }] },
          addOns: [],
          promotionCode: "reefonly",
          now: NOW,
        }),
      );
      if (bQuote.kind !== "created") throw new Error(JSON.stringify(bQuote));
      // Inclusive tax: 33000 less 2500 = 30500; 30500 / 1.04712 = 29127.51 -> 29128, 1372 included.
      expect(bQuote.quote.totals).toMatchObject({
        subtotal: 33000,
        discount: 2500,
        includedTax: 1372,
        total: 30500,
      });
      expect(await asGuest(A.id, (trx) => getQuote(trx, A.id, bQuote.quote.quoteId))).toBeNull();
      expect(await asGuest(B.id, (trx) => getQuote(trx, B.id, bQuote.quote.quoteId))).toEqual(
        bQuote.quote,
      );
    });
  });

  describe("immutability and tenancy in the database", () => {
    const tables = [
      "price_list_versions",
      "price_list_items",
      "policy_versions",
      "tax_rate_versions",
      "promotions",
      "promotion_versions",
      "promotion_version_products",
      "quotes",
      "quote_lines",
      "quote_line_taxes",
    ];

    it("refuses UPDATE, DELETE, and TRUNCATE on every pricing table for every role", async () => {
      for (const table of tables) {
        const ownerUpdate = await pgCode(
          admin.unsafe(`update public.${table} set tenant_id = tenant_id where tenant_id = $1`, [
            A.id,
          ]),
        );
        const ownerDelete = await pgCode(
          admin.unsafe(`delete from public.${table} where tenant_id = $1`, [A.id]),
        );
        const ownerTruncate = await pgCode(admin.unsafe(`truncate public.${table} cascade`));
        expect({ table, ownerUpdate, ownerDelete, ownerTruncate }).toEqual({
          table,
          ownerUpdate: "55000",
          ownerDelete: "55000",
          ownerTruncate: "55000",
        });
        const runtimeUpdate = await pgCode(
          asSystem(A.id, (trx) =>
            sql.raw(`update public.${table} set tenant_id = tenant_id`).execute(trx),
          ),
        );
        const runtimeDelete = await pgCode(
          asSystem(A.id, (trx) => sql.raw(`delete from public.${table}`).execute(trx)),
        );
        expect({ table, runtimeUpdate, runtimeDelete }).toEqual({
          table,
          runtimeUpdate: "42501",
          runtimeDelete: "42501",
        });
      }
    });

    it("refuses to add a line to a committed quote or an item to a committed version", async () => {
      const [quote] = await admin<{ id: string }[]>`
        select id from public.quotes where tenant_id = ${A.id} order by created_at limit 1`;
      if (!quote) throw new Error("no quote");
      // Each attempt starts only when the loop awaits it. Started together, a
      // later refusal could reject before its handler is attached, which
      // Vitest reports as an unhandled error.
      const attempts: Array<[string, () => Promise<unknown>]> = [
        [
          "quote line as runtime",
          () =>
            asSystem(A.id, (trx) =>
              trx
                .insertInto("quote_lines")
                .values({
                  tenant_id: A.id,
                  quote_id: quote.id,
                  line_no: 99,
                  kind: "fee",
                  code: "sneaky",
                  name: "Sneaky fee",
                  basis: "per_booking",
                  quantity: 1,
                  unit_amount: 0,
                  amount: 0,
                  taxable: false,
                })
                .execute(),
            ),
        ],
        [
          "quote line as owner",
          () => admin`insert into public.quote_lines (tenant_id, quote_id, line_no, kind, code, name, basis,
              quantity, unit_amount, amount, taxable)
            values (${A.id}, ${quote.id}, 98, 'fee', 'sneaky', 'Sneaky fee', 'per_booking', 1, 0, 0, false)`,
        ],
        [
          "price list item",
          () =>
            asSystem(A.id, (trx) =>
              trx
                .insertInto("price_list_items")
                .values({
                  tenant_id: A.id,
                  product_id: a.cruise,
                  version: 1,
                  product_kind: "shared_seat",
                  item_kind: "ticket",
                  code: "stowaway",
                  name: "Stowaway",
                  unit_amount: 1,
                  taxable: false,
                  sort_order: 9,
                })
                .execute(),
            ),
        ],
      ];
      for (const [label, attempt] of attempts) {
        expect({ label, code: await pgCode(attempt()) }).toEqual({ label, code: "55000" });
      }
    });

    it("refuses at commit a quote that does not add up and a price list with nothing to sell", async () => {
      const [trip] = await admin<{ id: string }[]>`
        select id from public.scheduled_trips where id = ${a.cruiseTrips[0] ?? ""}`;
      if (!trip) throw new Error("no trip");
      const header = {
        tenant_id: A.id,
        trip_id: trip.id,
        product_id: a.cruise,
        product_kind: "shared_seat" as const,
        product_name: "Sunset Cruise",
        trip_time_zone: "America/New_York",
        trip_local_date: "2026-11-10",
        trip_local_start_time: "18:00:00",
        trip_starts_at: "2026-11-10T23:00:00Z",
        trip_start_utc_offset_minutes: -300,
        price_list_version: 1,
        policy_version: 1,
        party_size: 1,
        subtotal_amount: 4500,
        discount_amount: 0,
        fee_amount: 0,
        tax_amount: 0,
        included_tax_amount: 0,
        total_amount: 4500,
        quoted_at: NOW,
        expires_at: new Date(NOW.getTime() + 60_000),
      };
      const wrong = await pgCode(
        asGuest(A.id, async (trx) => {
          const { id } = await trx
            .insertInto("quotes")
            .values(header)
            .returning("id")
            .executeTakeFirstOrThrow();
          await trx
            .insertInto("quote_lines")
            .values({
              tenant_id: A.id,
              quote_id: id,
              line_no: 1,
              kind: "ticket",
              code: "adult",
              name: "Adult",
              quantity: 1,
              unit_amount: 4000,
              amount: 4000,
              taxable: false,
            })
            .execute();
        }),
      );
      expect(wrong).toBe("23514");
      const empty = await pgCode(
        asGuest(A.id, (trx) => trx.insertInto("quotes").values(header).execute()),
      );
      expect(empty).toBe("23514");
      const nothingToSell = await pgCode(
        asSystem(A.id, (trx) =>
          trx
            .insertInto("price_list_versions")
            .values({
              tenant_id: A.id,
              product_id: a.cruise,
              version: 50,
              product_kind: "shared_seat",
              reason: "empty",
            })
            .execute(),
        ),
      );
      expect(nothingToSell).toBe("23514");
    });

    it("refuses at commit a quote that its trip and versions do not produce", async () => {
      // A real quote is the template. Each case writes a copy with one change
      // that keeps the totals consistent, so only the derivation check can
      // refuse it.
      const created = await cruiseQuote(A.id, a.cruiseTrips[1] ?? "", {
        promotionCode: "HARBOR10",
      });
      if (created.kind !== "created") throw new Error(JSON.stringify(created));
      const id = created.quote.quoteId;
      type Row = Record<string, unknown>;
      const [head] = await admin<Row[]>`select * from public.quotes where id = ${id}`;
      const lines = await admin<Row[]>`
        select * from public.quote_lines where quote_id = ${id} order by line_no`;
      const taxes = await admin<Row[]>`
        select * from public.quote_line_taxes where quote_id = ${id} order by line_no, tax_rate_id`;
      if (!head) throw new Error("no quote");
      const num = (value: unknown) => Number(value);
      const copy = (change: (h: Row, l: Row[], t: Row[]) => void) => {
        const h: Row = { ...head };
        const l = lines.map((x) => ({ ...x }));
        const t = taxes.map((x) => ({ ...x }));
        change(h, l, t);
        for (const k of [
          "id",
          "created_at",
          "created_txid",
          "actor_type",
          "actor_id",
          "request_id",
        ]) {
          delete h[k];
        }
        return pgCode(
          asGuest(A.id, async (trx) => {
            const { id: copyId } = await trx
              .insertInto("quotes")
              .values(h as never)
              .returning("id")
              .executeTakeFirstOrThrow();
            await trx
              .insertInto("quote_lines")
              .values(l.map((x) => ({ ...x, quote_id: copyId })) as never)
              .execute();
            if (t.length > 0) {
              await trx
                .insertInto("quote_line_taxes")
                .values(t.map((x) => ({ ...x, quote_id: copyId })) as never)
                .execute();
            }
          }),
        );
      };
      const line = (l: Row[], code: string) => {
        const found = l.find((x) => x.code === code);
        if (!found) throw new Error(`no ${code} line`);
        return found;
      };
      const shift = (h: Row, field: string, by: number) => {
        h[field] = num(h[field]) + by;
      };
      // The unchanged copy commits: the checks accept what the service writes.
      expect(await copy(() => {})).toBeUndefined();
      const cases: Array<[string, (h: Row, l: Row[], t: Row[]) => void]> = [
        [
          "a trip time other than the trip's",
          (h) => {
            h.trip_starts_at = new Date("2026-11-11T22:00:00Z");
          },
        ],
        [
          "a product name other than the product's",
          (h) => {
            h.product_name = "Renamed cruise";
          },
        ],
        [
          "a line name other than the price list's",
          (_h, l) => {
            line(l, "adult").name = "Grown-up";
          },
        ],
        [
          "a per-participant fee charged for fewer participants",
          (h, l) => {
            const fee = line(l, "harbor");
            fee.quantity = 2;
            fee.amount = 2 * num(fee.unit_amount);
            shift(h, "fee_amount", -num(fee.unit_amount));
            shift(h, "total_amount", -num(fee.unit_amount));
          },
        ],
        [
          "a mandatory fee left out",
          (h, l) => {
            const fee = line(l, "harbor");
            l.splice(l.indexOf(fee), 1);
            shift(h, "fee_amount", -num(fee.amount));
            shift(h, "total_amount", -num(fee.amount));
          },
        ],
        [
          // Before the trip departs, so only the promotion's window refuses it.
          "a promotion redeemed before its window",
          (h) => {
            h.quoted_at = new Date("2026-08-31T23:00:00Z");
            h.expires_at = new Date("2026-08-31T23:30:00Z");
          },
        ],
        [
          "a discount one cent smaller than the rule",
          (h, l, t) => {
            const adult = line(l, "adult");
            adult.discount_amount = num(adult.discount_amount) - 1;
            const discount = l.find((x) => x.kind === "discount");
            if (!discount) throw new Error("no discount line");
            discount.unit_amount = num(discount.unit_amount) - 1;
            discount.amount = num(discount.amount) + 1;
            shift(h, "discount_amount", -1);
            shift(h, "total_amount", 1);
            // The adult line's pre-tax amount grows by a cent; recompute its taxes.
            let added = 0;
            for (const x of t.filter((r) => r.line_no === adult.line_no)) {
              const before = num(x.amount);
              x.taxable_amount = num(x.taxable_amount) + 1;
              const rate = created.quote.taxes.find((r) => r.taxRateId === x.tax_rate_id);
              x.amount = Math.floor((2 * num(x.taxable_amount) * (rate?.ratePpm ?? 0) + 1e6) / 2e6);
              added += num(x.amount) - before;
            }
            shift(h, "tax_amount", added);
            shift(h, "total_amount", added);
          },
        ],
        [
          "an added tax one cent off its rate",
          (h, _l, t) => {
            const first = t[0];
            if (!first) throw new Error("no tax rows");
            first.amount = num(first.amount) + 1;
            shift(h, "tax_amount", 1);
            shift(h, "total_amount", 1);
          },
        ],
        [
          "a taxable line without its taxes",
          (h, l, t) => {
            const photo = line(l, "photo");
            const dropped = t.filter((x) => x.line_no === photo.line_no);
            t.splice(0, t.length, ...t.filter((x) => x.line_no !== photo.line_no));
            const removed = dropped.reduce((sum, x) => sum + num(x.amount), 0);
            shift(h, "tax_amount", -removed);
            shift(h, "total_amount", -removed);
          },
        ],
      ];
      const outcomes: { label: string; code: string | undefined }[] = [];
      for (const [label, change] of cases) outcomes.push({ label, code: await copy(change) });
      expect(outcomes).toEqual(cases.map(([label]) => ({ label, code: "23514" })));
    });

    it("keeps guests from writing terms and every row inside its tenant", async () => {
      const guestTerms = await pgCode(
        asGuest(A.id, (trx) =>
          trx
            .insertInto("tax_rate_versions")
            .values({
              tenant_id: A.id,
              tax_rate_id: randomUUID(),
              version: 1,
              name: "Guest tax",
              rate_ppm: 1,
              inclusive: false,
              active: true,
              reason: "guest",
            })
            .execute(),
        ),
      );
      expect(guestTerms).toBe("23514");
      for (const table of tables) {
        const seen = await asSystem(A.id, (trx) =>
          sql<{
            tenant_id: string;
          }>`select distinct tenant_id from ${sql.table(`public.${table}`)}`.execute(trx),
        );
        expect({ table, tenants: seen.rows.map((r) => r.tenant_id) }).toEqual({
          table,
          tenants: [A.id],
        });
      }
      // A's context cannot attach terms to B's product, nor read B's promotion.
      const crossPolicy = await pgCode(
        asSystem(A.id, (trx) =>
          trx
            .insertInto("policy_versions")
            .values({
              tenant_id: A.id,
              product_id: b.dive,
              version: 9,
              change_cutoff_minutes: 0,
              before_cutoff_remedy: "none",
              after_cutoff_remedy: "none",
              no_show_remedy: "none",
              cancellation_text: "x",
              reschedule_text: "x",
              no_show_text: "x",
              operator_cancellation_text: "x",
              weather_text: "x",
              reason: "escape",
            })
            .execute(),
        ),
      );
      expect(crossPolicy).toBe("23503");
      const crossWrite = await pgCode(
        asSystem(A.id, (trx) =>
          trx.insertInto("promotions").values({ tenant_id: B.id, code: "ESCAPE" }).execute(),
        ),
      );
      expect(crossWrite).toBe("42501");
    });

    it("numbers concurrent versions consecutively instead of failing one", async () => {
      const version = (label: string) =>
        asSystem(A.id, (trx) =>
          createPolicyVersion(trx, system(A.id), {
            ...policy(60),
            productId: a.charter,
            reason: label,
          }),
        );
      const results = await Promise.all([version("one"), version("two"), version("three")]);
      const numbers = results.map((r) => (r.kind === "created" ? r.version : 0)).sort();
      expect(numbers).toEqual([2, 3, 4]);
    });
  });
});
