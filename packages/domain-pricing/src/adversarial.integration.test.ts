import { randomUUID } from "node:crypto";
import { Quote } from "@tidegrid/contracts";
import {
  createDb,
  inTenantTransaction,
  type QuoteLinesTable,
  type QuoteLineTaxesTable,
  type QuotesTable,
  type TenantContext,
  type TenantTransaction,
} from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import {
  changeTripSalesState,
  createBoat,
  createLocation,
  createProduct,
  createSchedule,
  generateTrips,
  publishProduct,
} from "@tidegrid/domain-catalog";
import { type Insertable, sql } from "kysely";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  type CreateQuoteInput,
  createPolicyVersion,
  createPriceListVersion,
  createPromotion,
  createPromotionVersion,
  createQuote,
  createTaxRate,
  createTaxRateVersion,
  findPromotion,
  findTripForSale,
  getQuote,
  getTripOffer,
  loadPolicy,
  loadPriceList,
  loadTaxRates,
  normalizePromotionCode,
  type PartySelection,
  type PolicyInput,
  type PricedQuote,
  type PriceList,
  type PromotionTerms,
  priceQuote,
  type SaleTrip,
  type TaxRate,
} from "./index.ts";

// Independent adversarial checks of G2.5 against a real database, as the
// runtime role. Every tenant, product, and code here is synthetic and created
// by this file. Quotes are priced at NOW, before the November fixture trips.

type Sql = ReturnType<typeof postgres>;

const env = inject("integrationDb");
const NOW = new Date("2026-10-15T00:00:00Z");

const TABLES = [
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
] as const;

interface Failure {
  code: string | undefined;
  message: string | undefined;
}

/** The SQLSTATE and message a promise rejects with, or null when it resolves. */
async function failure(p: Promise<unknown>): Promise<Failure | null> {
  try {
    await p;
    return null;
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return { code: e.code, message: e.message };
  }
}

const policyInput = (cutoffMinutes: number, label: string): PolicyInput => ({
  changeCutoffMinutes: cutoffMinutes,
  beforeCutoff: { remedy: "full_refund" },
  afterCutoff: { remedy: "percent_refund", refundBp: 5000 },
  noShow: { remedy: "none" },
  text: {
    cancellation: `${label}: full refund before the cutoff.`,
    reschedule: `${label}: move before the cutoff.`,
    noShow: `${label}: no refund for a no-show.`,
    operatorCancellation: `${label}: refund or credit if we cancel.`,
    weather: `${label}: the captain decides.`,
  },
});

/** Deterministic generator (mulberry32), so a failure reproduces from its seed. */
function generator(seed: number) {
  let a = seed >>> 0;
  return (n: number): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) % n;
  };
}

describe.skipIf(!env)("adversarial pricing checks against a real database", () => {
  let admin: Sql;
  let runtime: ReturnType<typeof createDb>;
  const run = randomUUID().slice(0, 8);
  const tenant = (label: string) => ({ id: randomUUID(), slug: `g25adv-${label}-${run}` });
  /** Money, eligibility, forgeries, tenancy, and sealing. */
  const A = tenant("a");
  /** The other tenant. */
  const B = tenant("b");
  /** Snapshot scenario: its terms change underneath a stored quote. */
  const S = tenant("s");
  /** Versions, races, guests, audit, and validation. */
  const V = tenant("v");

  const ctx = (tenantId: string, actorType: TenantContext["actorType"] = "system") => ({
    tenantId,
    actorType,
    actorId: actorType === "guest" ? null : `g25-adversarial-${run}`,
    requestId: `req-${run}`,
  });
  const as = <T>(tenantId: string, fn: (trx: TenantTransaction) => Promise<T>) =>
    inTenantTransaction(runtime.db, ctx(tenantId), fn);
  const asGuest = <T>(tenantId: string, fn: (trx: TenantTransaction) => Promise<T>) =>
    inTenantTransaction(runtime.db, ctx(tenantId, "guest"), fn);

  const a = {
    reef: "",
    charter: "",
    yacht: "",
    dawn: "",
    draft: "",
    pricedOnly: "",
    reefTrips: new Map<string, string>(),
    charterTrips: new Map<string, string>(),
    yachtTrips: new Map<string, string>(),
    dawnTrips: new Map<string, string>(),
    promotions: new Map<string, string>(),
    taxes: new Map<string, string>(),
  };
  const b = { dive: "", trip: "", tax: "", promotion: "", quote: "" };
  const s = { sail: "", other: "", trips: [] as string[], city: "", region: "", promotion: "" };
  const v = { product: "", tax: "", promotion: "" };

  const trip = (map: Map<string, string>, date: string): string => {
    const id = map.get(date);
    if (!id) throw new Error(`no fixture trip on ${date}`);
    return id;
  };

  async function scheduleTrips(
    trx: TenantTransaction,
    c: TenantContext,
    productId: string,
    boatId: string,
    time: string,
    from: string,
    to: string,
  ): Promise<Map<string, string>> {
    const schedule = await createSchedule(trx, c, {
      productId,
      boatId,
      startsOn: "2026-10-01",
      endsOn: "2027-03-31",
      weekdays: [1, 2, 3, 4, 5, 6, 7],
      startTimes: [time],
      reason: "fixture",
    });
    if (schedule.kind !== "created") throw new Error(JSON.stringify(schedule));
    const generated = await generateTrips(trx, c, {
      scheduleId: schedule.id,
      fromDate: from,
      toDate: to,
      publish: true,
      reason: "fixture",
    });
    if (generated.kind !== "generated") throw new Error(JSON.stringify(generated));
    return new Map(generated.created.map((t) => [t.localDate, t.tripId]));
  }

  async function publish(trx: TenantTransaction, c: TenantContext, productId: string) {
    const published = await publishProduct(trx, c, { productId, reason: "fixture" });
    if (published.kind !== "published") throw new Error(JSON.stringify(published));
  }

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 3, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 6 });
    for (const t of [A, B, S, V]) {
      await admin`insert into public.tenants (id, slug, display_name)
        values (${t.id}, ${t.slug}, ${`G25 adversarial ${t.slug}`})`;
    }

    await as(A.id, async (trx) => {
      const c = ctx(A.id);
      const dock = await createLocation(trx, c, {
        name: "Dock A",
        timeZone: "America/New_York",
        reason: "fixture",
      });
      const bay = await createLocation(trx, c, {
        name: "Bay A",
        timeZone: "Pacific/Auckland",
        reason: "fixture",
      });
      const boat = (name: string, guestCapacity: number) =>
        createBoat(trx, c, { name, guestCapacity, reason: "fixture" });
      const skiff = await boat("Skiff", 12);
      const cutter = await boat("Cutter", 8);
      const yachtBoat = await boat("Yacht", 12);
      const kayak = await boat("Kayak", 10);
      const product = (
        name: string,
        kind: "shared_seat" | "private_charter",
        locationId: string,
        boatId: string,
        maxPartySize: number,
      ) =>
        createProduct(trx, c, {
          locationId,
          kind,
          name,
          durationMinutes: 90,
          bookingCutoffMinutes: 60,
          maxPartySize,
          eligibleBoatIds: [boatId],
          reason: "fixture",
        });
      a.reef = await product("Reef Sail", "shared_seat", dock, skiff, 8);
      a.charter = await product("Cutter Charter", "private_charter", dock, cutter, 8);
      a.yacht = await product("Yacht Berths", "shared_seat", dock, yachtBoat, 12);
      a.dawn = await product("Dawn Paddle", "shared_seat", bay, kayak, 6);
      a.draft = await product("Unpriced Draft", "shared_seat", dock, skiff, 4);
      a.pricedOnly = await product("Priced Only", "shared_seat", dock, skiff, 4);

      const dated = [
        {
          code: "early",
          name: "Early bird snack",
          unitAmount: 500,
          quantityRule: "per_booking" as const,
          maxQuantity: 1,
          taxable: true,
          availableUntil: "2026-11-10",
        },
        {
          code: "late",
          name: "Late season snack",
          unitAmount: 500,
          quantityRule: "per_booking" as const,
          maxQuantity: 1,
          taxable: true,
          availableFrom: "2026-11-11",
        },
      ];
      const prices = [
        await createPriceListVersion(trx, c, {
          productId: a.reef,
          tickets: [
            { code: "adult", name: "Adult", unitAmount: 5999, taxable: true },
            { code: "child", name: "Child", unitAmount: 2999, taxable: true },
            { code: "senior", name: "Senior", unitAmount: 2999, taxable: true },
            { code: "infant", name: "Infant", unitAmount: 0, taxable: false },
          ],
          fees: [
            {
              code: "park",
              name: "Park fee",
              unitAmount: 150,
              basis: "per_participant",
              taxable: true,
            },
            {
              code: "booking",
              name: "Booking fee",
              unitAmount: 99,
              basis: "per_booking",
              taxable: false,
            },
          ],
          addOns: [
            {
              code: "snorkel",
              name: "Snorkel set",
              unitAmount: 1299,
              quantityRule: "per_participant",
              maxQuantity: 1,
              taxable: true,
            },
            {
              code: "photo",
              name: "Photo package",
              unitAmount: 2500,
              quantityRule: "per_booking",
              maxQuantity: 1,
              taxable: false,
            },
            ...dated,
          ],
          reason: "fixture",
        }),
        await createPriceListVersion(trx, c, {
          productId: a.charter,
          charter: { name: "Whole boat", amount: 120_000, taxable: true },
          fees: [
            { code: "fuel", name: "Fuel", unitAmount: 7500, basis: "per_booking", taxable: true },
          ],
          addOns: [
            {
              code: "lunch",
              name: "Lunch",
              unitAmount: 2500,
              quantityRule: "per_participant",
              maxQuantity: 1,
              taxable: true,
            },
          ],
          reason: "fixture",
        }),
        await createPriceListVersion(trx, c, {
          productId: a.yacht,
          tickets: [
            { code: "berth", name: "Berth", unitAmount: 10_000_000, taxable: false },
            { code: "berth_taxed", name: "Taxed berth", unitAmount: 10_000_000, taxable: true },
          ],
          reason: "fixture",
        }),
        await createPriceListVersion(trx, c, {
          productId: a.dawn,
          tickets: [{ code: "adult", name: "Adult", unitAmount: 3000, taxable: true }],
          addOns: dated,
          reason: "fixture",
        }),
        await createPriceListVersion(trx, c, {
          productId: a.pricedOnly,
          tickets: [{ code: "adult", name: "Adult", unitAmount: 1000, taxable: true }],
          reason: "fixture",
        }),
      ];
      for (const p of prices) if (p.kind !== "created") throw new Error(JSON.stringify(p));
      for (const productId of [a.reef, a.charter, a.yacht, a.dawn]) {
        const p = await createPolicyVersion(trx, c, {
          ...policyInput(1440, "A"),
          productId,
          reason: "fixture",
        });
        if (p.kind !== "created") throw new Error(JSON.stringify(p));
      }
      for (const [name, ratePpm, inclusive] of [
        ["County levy", 5000, true],
        ["General excise", 47_120, true],
        ["State sales tax", 60_000, false],
      ] as const) {
        const t = await createTaxRate(trx, c, { name, ratePpm, inclusive, reason: "fixture" });
        if (t.kind !== "created") throw new Error(JSON.stringify(t));
        a.taxes.set(name, t.taxRateId);
      }
      const season = {
        startsAt: new Date("2026-09-01T00:00:00Z"),
        endsAt: new Date("2027-06-01T00:00:00Z"),
      };
      const codes: Array<[string, Parameters<typeof createPromotion>[2]]> = [
        [
          "TIDE15",
          {
            code: "tide15",
            discount: { kind: "percent", percentOffBp: 1500 },
            ...season,
            products: { all: true },
            reason: "fixture",
          },
        ],
        [
          "FLAT999",
          {
            code: "FLAT999",
            discount: { kind: "fixed_amount", amountOff: 999 },
            ...season,
            products: { productIds: [a.reef] },
            reason: "fixture",
          },
        ],
        [
          "ALLFREE",
          {
            code: "ALLFREE",
            discount: { kind: "percent", percentOffBp: 10_000 },
            ...season,
            products: { all: true },
            reason: "fixture",
          },
        ],
        [
          "TINY",
          {
            code: "TINY",
            discount: { kind: "percent", percentOffBp: 1 },
            ...season,
            products: { all: true },
            reason: "fixture",
          },
        ],
        [
          "WINDOW",
          {
            code: "WINDOW",
            discount: { kind: "percent", percentOffBp: 1000 },
            startsAt: new Date("2026-10-15T00:00:00.000Z"),
            endsAt: new Date("2026-10-15T00:30:00.000Z"),
            products: { all: true },
            reason: "fixture",
          },
        ],
        [
          "RETIRED",
          {
            code: "RETIRED",
            discount: { kind: "percent", percentOffBp: 1000 },
            ...season,
            products: { all: true },
            reason: "fixture",
          },
        ],
        [
          "LATER",
          {
            code: "LATER",
            discount: { kind: "percent", percentOffBp: 1000 },
            startsAt: new Date("2026-12-01T00:00:00Z"),
            endsAt: new Date("2027-06-01T00:00:00Z"),
            products: { all: true },
            reason: "fixture",
          },
        ],
        [
          "OLD",
          {
            code: "OLD",
            discount: { kind: "percent", percentOffBp: 1000 },
            startsAt: new Date("2026-08-01T00:00:00Z"),
            endsAt: new Date("2026-10-01T00:00:00Z"),
            products: { all: true },
            reason: "fixture",
          },
        ],
        [
          "OTHERONLY",
          {
            code: "OTHERONLY",
            discount: { kind: "percent", percentOffBp: 1000 },
            ...season,
            products: { productIds: [a.charter] },
            reason: "fixture",
          },
        ],
        [
          "TWIN",
          {
            code: "TWIN",
            discount: { kind: "percent", percentOffBp: 1000 },
            ...season,
            products: { all: true },
            reason: "fixture",
          },
        ],
      ];
      for (const [code, input] of codes) {
        const created = await createPromotion(trx, c, input);
        if (created.kind !== "created") throw new Error(`${code}: ${JSON.stringify(created)}`);
        a.promotions.set(code, created.promotionId);
      }
      const retired = await createPromotionVersion(trx, c, {
        promotionId: a.promotions.get("RETIRED") ?? "",
        discount: { kind: "percent", percentOffBp: 1000 },
        ...season,
        products: { all: true },
        active: false,
        reason: "retired",
      });
      if (retired.kind !== "created") throw new Error(JSON.stringify(retired));
      for (const productId of [a.reef, a.charter, a.yacht, a.dawn]) {
        await publish(trx, c, productId);
      }
      a.reefTrips = await scheduleTrips(trx, c, a.reef, skiff, "21:00", "2026-11-01", "2026-11-12");
      a.charterTrips = await scheduleTrips(
        trx,
        c,
        a.charter,
        cutter,
        "08:00",
        "2026-11-10",
        "2026-11-12",
      );
      a.yachtTrips = await scheduleTrips(
        trx,
        c,
        a.yacht,
        yachtBoat,
        "10:00",
        "2026-11-10",
        "2026-11-11",
      );
      a.dawnTrips = await scheduleTrips(trx, c, a.dawn, kayak, "07:00", "2026-11-10", "2026-11-12");
    });

    await as(B.id, async (trx) => {
      const c = ctx(B.id);
      const location = await createLocation(trx, c, {
        name: "Reef B",
        timeZone: "Pacific/Honolulu",
        reason: "fixture",
      });
      const boat = await createBoat(trx, c, { name: "Runner", guestCapacity: 12, reason: "x" });
      b.dive = await createProduct(trx, c, {
        locationId: location,
        kind: "shared_seat",
        name: "Dive B",
        durationMinutes: 240,
        maxPartySize: 6,
        eligibleBoatIds: [boat],
        reason: "fixture",
      });
      await createPriceListVersion(trx, c, {
        productId: b.dive,
        tickets: [{ code: "diver", name: "Diver", unitAmount: 16_500, taxable: true }],
        reason: "fixture",
      });
      await createPolicyVersion(trx, c, {
        ...policyInput(2880, "B"),
        productId: b.dive,
        reason: "x",
      });
      const tax = await createTaxRate(trx, c, {
        name: "General excise",
        ratePpm: 47_120,
        inclusive: true,
        reason: "fixture",
      });
      if (tax.kind !== "created") throw new Error(JSON.stringify(tax));
      b.tax = tax.taxRateId;
      const only = await createPromotion(trx, c, {
        code: "BONLY",
        discount: { kind: "fixed_amount", amountOff: 2500 },
        startsAt: new Date("2026-09-01T00:00:00Z"),
        endsAt: new Date("2027-06-01T00:00:00Z"),
        products: { productIds: [b.dive] },
        reason: "fixture",
      });
      if (only.kind !== "created") throw new Error(JSON.stringify(only));
      b.promotion = only.promotionId;
      const twin = await createPromotion(trx, c, {
        code: "twin",
        discount: { kind: "fixed_amount", amountOff: 500 },
        startsAt: new Date("2026-09-01T00:00:00Z"),
        endsAt: new Date("2027-06-01T00:00:00Z"),
        products: { all: true },
        reason: "fixture",
      });
      if (twin.kind !== "created") throw new Error(JSON.stringify(twin));
      await publish(trx, c, b.dive);
      const trips = await scheduleTrips(trx, c, b.dive, boat, "07:30", "2026-11-10", "2026-11-10");
      b.trip = trip(trips, "2026-11-10");
    });
    const bQuote = await asGuest(B.id, (trx) =>
      createQuote(trx, ctx(B.id, "guest"), {
        tripId: b.trip,
        party: { kind: "tickets", tickets: [{ code: "diver", quantity: 2 }] },
        addOns: [],
        promotionCode: "TWIN",
        now: NOW,
      }),
    );
    if (bQuote.kind !== "created") throw new Error(JSON.stringify(bQuote));
    b.quote = bQuote.quote.quoteId;

    await as(S.id, async (trx) => {
      const c = ctx(S.id);
      const location = await createLocation(trx, c, {
        name: "Harbor S",
        timeZone: "America/New_York",
        reason: "fixture",
      });
      const boat = await createBoat(trx, c, { name: "Sloop", guestCapacity: 10, reason: "x" });
      s.sail = await createProduct(trx, c, {
        locationId: location,
        kind: "shared_seat",
        name: "Sunset Sail S",
        durationMinutes: 120,
        maxPartySize: 8,
        eligibleBoatIds: [boat],
        reason: "fixture",
      });
      s.other = await createProduct(trx, c, {
        locationId: location,
        kind: "shared_seat",
        name: "Other S",
        durationMinutes: 60,
        maxPartySize: 4,
        eligibleBoatIds: [],
        reason: "fixture",
      });
      await createPriceListVersion(trx, c, {
        productId: s.sail,
        tickets: [
          { code: "adult", name: "Adult", unitAmount: 4000, taxable: true },
          { code: "child", name: "Child", unitAmount: 2000, taxable: true },
        ],
        fees: [
          {
            code: "dock",
            name: "Dock fee",
            unitAmount: 300,
            basis: "per_participant",
            taxable: false,
          },
        ],
        addOns: [
          {
            code: "snack",
            name: "Snack box",
            unitAmount: 700,
            quantityRule: "per_participant",
            maxQuantity: 2,
            taxable: true,
          },
        ],
        reason: "fixture",
      });
      await createPolicyVersion(trx, c, {
        ...policyInput(1440, "S v1"),
        productId: s.sail,
        reason: "x",
      });
      const city = await createTaxRate(trx, c, {
        name: "City tax",
        ratePpm: 20_000,
        inclusive: false,
        reason: "fixture",
      });
      const region = await createTaxRate(trx, c, {
        name: "Region tax",
        ratePpm: 30_000,
        inclusive: true,
        reason: "fixture",
      });
      if (city.kind !== "created" || region.kind !== "created") throw new Error("tax fixture");
      s.city = city.taxRateId;
      s.region = region.taxRateId;
      const promo = await createPromotion(trx, c, {
        code: "SNAP15",
        discount: { kind: "percent", percentOffBp: 1500 },
        startsAt: new Date("2026-09-01T00:00:00Z"),
        endsAt: new Date("2027-06-01T00:00:00Z"),
        products: { all: true },
        reason: "fixture",
      });
      if (promo.kind !== "created") throw new Error(JSON.stringify(promo));
      s.promotion = promo.promotionId;
      await publish(trx, c, s.sail);
      const trips = await scheduleTrips(trx, c, s.sail, boat, "18:00", "2026-11-10", "2026-11-12");
      s.trips = [...trips.values()];
    });

    await as(V.id, async (trx) => {
      const c = ctx(V.id);
      const location = await createLocation(trx, c, {
        name: "Office V",
        timeZone: "America/New_York",
        reason: "fixture",
      });
      v.product = await createProduct(trx, c, {
        locationId: location,
        kind: "shared_seat",
        name: "Versions V",
        durationMinutes: 60,
        maxPartySize: 4,
        eligibleBoatIds: [],
        reason: "fixture",
      });
      await createPriceListVersion(trx, c, {
        productId: v.product,
        tickets: [{ code: "adult", name: "Adult", unitAmount: 1000, taxable: true }],
        reason: "fixture",
      });
      const tax = await createTaxRate(trx, c, {
        name: "Base tax",
        ratePpm: 10_000,
        inclusive: false,
        reason: "fixture",
      });
      if (tax.kind !== "created") throw new Error(JSON.stringify(tax));
      v.tax = tax.taxRateId;
      const promo = await createPromotion(trx, c, {
        code: "RACEBASE",
        discount: { kind: "percent", percentOffBp: 500 },
        startsAt: new Date("2026-09-01T00:00:00Z"),
        endsAt: new Date("2027-06-01T00:00:00Z"),
        products: { all: true },
        reason: "fixture",
      });
      if (promo.kind !== "created") throw new Error(JSON.stringify(promo));
      v.promotion = promo.promotionId;
    });
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end({ timeout: 5 });
  });

  const quoteIn = (tenantId: string, input: Omit<CreateQuoteInput, "now"> & { now?: Date }) =>
    asGuest(tenantId, (trx) => createQuote(trx, ctx(tenantId, "guest"), { now: NOW, ...input }));
  const party = (...pairs: Array<[string, number]>): PartySelection => ({
    kind: "tickets",
    tickets: pairs.map(([code, quantity]) => ({ code, quantity })),
  });

  // Money ----------------------------------------------------------------------------

  describe("money end to end", () => {
    it("stores a mixed inclusive and exclusive quote exactly as worked by hand, row for row", async () => {
      const created = await quoteIn(A.id, {
        tripId: trip(a.reefTrips, "2026-11-10"),
        party: party(["adult", 2], ["child", 1], ["infant", 1]),
        addOns: [
          { code: "photo", quantity: 1 },
          { code: "snorkel", quantity: 3 },
        ],
        promotionCode: " tide15 ",
      });
      if (created.kind !== "created") throw new Error(JSON.stringify(created));
      const q = Quote.parse(created.quote);
      // 15% of 14997 = 2249.55 -> 2250, split 1800 / 450 / 0 by the largest remainder.
      // Inclusive 0.5% + 4.712% are extracted together from each net, 6% is added on
      // the extracted base, all rounded half up per line.
      expect(
        q.lines.map((l) => [
          l.lineNo,
          l.kind,
          l.code,
          l.quantity,
          l.unitAmount,
          l.amount,
          l.discountAmount,
        ]),
      ).toEqual([
        [1, "ticket", "adult", 2, 5999, 11_998, 1800],
        [2, "ticket", "child", 1, 2999, 2999, 450],
        [3, "ticket", "infant", 1, 0, 0, 0],
        [4, "add_on", "snorkel", 3, 1299, 3897, 0],
        [5, "add_on", "photo", 1, 2500, 2500, 0],
        [6, "fee", "park", 4, 150, 600, 0],
        [7, "fee", "booking", 1, 99, 99, 0],
        [8, "discount", "TIDE15", 1, 2250, -2250, 0],
      ]);
      expect(q.lines.map((l) => l.taxes.map((t) => [t.name, t.taxableAmount, t.amount]))).toEqual([
        [
          ["County levy", 9693, 48],
          ["General excise", 9693, 457],
          ["State sales tax", 9693, 582],
        ],
        [
          ["County levy", 2423, 12],
          ["General excise", 2423, 114],
          ["State sales tax", 2423, 145],
        ],
        [],
        [
          ["County levy", 3704, 19],
          ["General excise", 3704, 174],
          ["State sales tax", 3704, 222],
        ],
        [],
        [
          ["County levy", 570, 3],
          ["General excise", 570, 27],
          ["State sales tax", 570, 34],
        ],
        [],
        [],
      ]);
      expect(q.taxes.map((t) => [t.name, t.inclusive, t.taxableAmount, t.amount])).toEqual([
        ["County levy", true, 16_390, 82],
        ["General excise", true, 16_390, 772],
        ["State sales tax", false, 16_390, 983],
      ]);
      expect(q.totals).toEqual({
        subtotal: 21_394,
        discount: 2250,
        fees: 699,
        tax: 983,
        includedTax: 854,
        total: 20_826,
        amountDueNow: 20_826,
      });
      // The database holds exactly what the guest was shown.
      const [header] = await admin<
        Array<{
          subtotal: number;
          discount: number;
          fees: number;
          tax: number;
          included: number;
          total: number;
        }>
      >`select subtotal_amount as subtotal, discount_amount as discount, fee_amount as fees,
               tax_amount as tax, included_tax_amount as included, total_amount as total
          from public.quotes where id = ${q.quoteId}`;
      expect(header).toEqual({
        subtotal: 21_394,
        discount: 2250,
        fees: 699,
        tax: 983,
        included: 854,
        total: 20_826,
      });
      const lineRows = await admin<
        Array<{ line_no: number; amount: number; discount_amount: number }>
      >`
        select line_no, amount, discount_amount from public.quote_lines
         where quote_id = ${q.quoteId} order by line_no`;
      expect(lineRows.map((l) => [l.line_no, l.amount, l.discount_amount])).toEqual(
        q.lines.map((l) => [l.lineNo, l.amount, l.discountAmount]),
      );
      const taxRows = await admin<
        Array<{ line_no: number; amount: number; taxable_amount: number }>
      >`
        select line_no, taxable_amount, amount from public.quote_line_taxes
         where quote_id = ${q.quoteId} order by line_no, amount`;
      expect(taxRows.reduce((acc, t) => acc + t.amount, 0)).toBe(983 + 854);
      expect(taxRows).toHaveLength(12);
    });

    it("stores every generated selection exactly as the pure computation prices it, and the database accepts each", {
      timeout: 150_000,
    }, async () => {
      // The commit-time check restates the pricing rules in SQL. A legitimate
      // quote it refused would fail checkout with a server error, so this hunts
      // for any disagreement between the two.
      const codes = [null, "tide15", "FLAT999", "allfree", "TINY", "twin", "OTHERONLY"];
      const reefDates = [...a.reefTrips.keys()];
      const chartered = [...a.charterTrips.keys()];
      let stored = 0;
      for (let seed = 1; seed <= 24; seed++) {
        const r = generator(seed * 7919);
        const onCharter = seed % 4 === 0;
        const date = onCharter
          ? (chartered[r(chartered.length)] ?? "")
          : (reefDates[r(reefDates.length)] ?? "");
        const tripId = trip(onCharter ? a.charterTrips : a.reefTrips, date);
        let selection: PartySelection;
        let size: number;
        if (onCharter) {
          size = 1 + r(8);
          selection = { kind: "charter", guests: size };
        } else {
          const pairs: Array<[string, number]> = [];
          let left = 8;
          for (const code of ["adult", "child", "senior", "infant"]) {
            if (left === 0 || r(2) === 0) continue;
            const n = 1 + r(Math.min(left, 3));
            pairs.push([code, n]);
            left -= n;
          }
          if (pairs.length === 0) pairs.push(["infant", 1 + r(3)]);
          if (r(2) === 0) pairs.reverse();
          size = pairs.reduce((acc, [, n]) => acc + n, 0);
          selection = party(...pairs);
        }
        const offered = onCharter
          ? [{ code: "lunch", max: size }]
          : [
              { code: "snorkel", max: size },
              { code: "photo", max: 1 },
              ...(date <= "2026-11-10" ? [{ code: "early", max: 1 }] : []),
              ...(date >= "2026-11-11" ? [{ code: "late", max: 1 }] : []),
            ];
        const addOns = offered
          .filter(() => r(2) === 0)
          .map((o) => ({ code: o.code, quantity: 1 + r(o.max) }));
        const promotionCode = codes[r(codes.length)] ?? null;
        const result = await asGuest(A.id, async (trx) => {
          const created = await createQuote(trx, ctx(A.id, "guest"), {
            tripId,
            party: selection,
            addOns,
            promotionCode,
            now: NOW,
          });
          const found = await findTripForSale(trx, A.id, tripId, NOW);
          if (found.kind !== "on_sale") throw new Error("fixture trip not on sale");
          const list = await loadPriceList(trx, A.id, found.trip.productId);
          if (!list) throw new Error("no price list");
          const pure = priceQuote({
            nowMs: NOW.getTime(),
            subject: {
              productId: found.trip.productId,
              productKind: found.trip.productKind,
              localDate: found.trip.localDate,
              minPartySize: found.trip.minPartySize,
              maxPartySize: found.trip.maxPartySize,
              capacityRemaining: found.trip.capacityRemaining,
            },
            priceList: list,
            taxRates: await loadTaxRates(trx, A.id),
            promotion:
              promotionCode === null
                ? null
                : await findPromotion(trx, A.id, normalizePromotionCode(promotionCode)),
            selection: { party: selection, addOns, promotionCode },
          });
          return { created, pure };
        });
        const { created, pure } = result;
        if (pure.kind === "rejected") {
          expect({ seed, created }).toEqual({
            seed,
            created: { kind: "rejected", problems: pure.problems },
          });
          continue;
        }
        if (created.kind !== "created") throw new Error(`seed ${seed}: ${JSON.stringify(created)}`);
        stored += 1;
        expect({
          seed,
          lines: created.quote.lines
            .filter((l) => l.kind !== "discount")
            .map((l) => [
              l.kind,
              l.code,
              l.quantity,
              l.amount,
              l.discountAmount,
              l.taxes.map((t) => t.amount),
            ]),
          totals: created.quote.totals,
        }).toEqual({
          seed,
          lines: pure.quote.lines.map((l) => [
            l.kind,
            l.code,
            l.quantity,
            l.amount,
            l.discountAmount,
            l.taxes.map((t) => t.amount),
          ]),
          totals: { ...pure.quote.totals, amountDueNow: pure.quote.totals.total },
        });
        if (seed % 3 === 0) {
          expect(await asGuest(A.id, (trx) => getQuote(trx, A.id, created.quote.quoteId))).toEqual(
            created.quote,
          );
        }
      }
      expect(stored).toBeGreaterThan(13);
    });

    it("gives a tied fixed discount's odd cent to the earlier price list line", async () => {
      const created = await quoteIn(A.id, {
        tripId: trip(a.reefTrips, "2026-11-11"),
        party: party(["senior", 1], ["child", 1]),
        addOns: [],
        promotionCode: "flat999",
      });
      if (created.kind !== "created") throw new Error(JSON.stringify(created));
      expect(
        created.quote.lines
          .filter((l) => l.kind === "ticket")
          .map((l) => [l.code, l.amount, l.discountAmount]),
      ).toEqual([
        ["child", 2999, 500],
        ["senior", 2999, 499],
      ]);
      expect(created.quote.totals.discount).toBe(999);
    });

    it("stores a quote of exactly $1,000,000 and refuses one that goes a cent over", async () => {
      const yacht = trip(a.yachtTrips, "2026-11-10");
      const exact = await quoteIn(A.id, {
        tripId: yacht,
        party: party(["berth", 10]),
        addOns: [],
        promotionCode: null,
      });
      if (exact.kind !== "created") throw new Error(JSON.stringify(exact));
      expect(exact.quote.totals).toMatchObject({ subtotal: 100_000_000, total: 100_000_000 });
      const [row] = await admin<Array<{ total_amount: number }>>`
        select total_amount from public.quotes where id = ${exact.quote.quoteId}`;
      expect(row?.total_amount).toBe(100_000_000);
      for (const selection of [
        party(["berth", 11]),
        party(["berth_taxed", 10]),
        party(["berth", 6], ["berth_taxed", 6]),
      ]) {
        expect(
          await quoteIn(A.id, { tripId: yacht, party: selection, addOns: [], promotionCode: null }),
        ).toEqual({ kind: "rejected", problems: [{ code: "quote_amount_too_large" }] });
      }
    });
  });

  // Eligibility -------------------------------------------------------------------------

  describe("eligibility against stored terms", () => {
    it("offers and accepts a dated add-on by the trip's local date, not its UTC date", async () => {
      // 21:00 in New York on 2026-11-10 is 02:00 UTC on 2026-11-11.
      const evening = trip(a.reefTrips, "2026-11-10");
      // 07:00 in Auckland on 2026-11-11 is 18:00 UTC on 2026-11-10.
      const dawn = trip(a.dawnTrips, "2026-11-11");
      const offered = async (tripId: string) => {
        const offer = await asGuest(A.id, (trx) => getTripOffer(trx, A.id, tripId, NOW));
        if (offer.kind !== "offer") throw new Error(JSON.stringify(offer));
        return {
          startsAt: offer.offer.trip.startsAt,
          localDate: offer.offer.trip.localDate,
          addOns: offer.offer.addOns
            .map((x) => x.code)
            .filter((code) => code === "early" || code === "late"),
        };
      };
      expect(await offered(evening)).toEqual({
        startsAt: "2026-11-11T02:00:00.000Z",
        localDate: "2026-11-10",
        addOns: ["early"],
      });
      expect(await offered(dawn)).toEqual({
        startsAt: "2026-11-10T18:00:00.000Z",
        localDate: "2026-11-11",
        addOns: ["late"],
      });
      const withAddOn = (tripId: string, tickets: PartySelection, code: string) =>
        quoteIn(A.id, {
          tripId,
          party: tickets,
          addOns: [{ code, quantity: 1 }],
          promotionCode: null,
        });
      expect((await withAddOn(evening, party(["adult", 1]), "early")).kind).toBe("created");
      expect(await withAddOn(evening, party(["adult", 1]), "late")).toEqual({
        kind: "rejected",
        problems: [{ code: "add_on_unavailable", subject: "late" }],
      });
      expect((await withAddOn(dawn, party(["adult", 1]), "late")).kind).toBe("created");
      expect(await withAddOn(dawn, party(["adult", 1]), "early")).toEqual({
        kind: "rejected",
        problems: [{ code: "add_on_unavailable", subject: "early" }],
      });
    });

    it("applies a promotion from the first instant of its window until just before its end", async () => {
      const at = (iso: string) =>
        quoteIn(A.id, {
          tripId: trip(a.reefTrips, "2026-11-12"),
          party: party(["adult", 1]),
          addOns: [],
          promotionCode: "window",
          now: new Date(iso),
        });
      const first = await at("2026-10-15T00:00:00.000Z");
      if (first.kind !== "created") throw new Error(JSON.stringify(first));
      expect(first.quote.totals.discount).toBe(600);
      expect(first.quote.quotedAt).toBe("2026-10-15T00:00:00.000Z");
      const last = await at("2026-10-15T00:29:59.999Z");
      expect(last.kind === "created" ? last.quote.totals.discount : last).toBe(600);
      expect(await at("2026-10-15T00:30:00.000Z")).toEqual({
        kind: "rejected",
        problems: [{ code: "promotion_not_applicable", reason: "expired" }],
      });
      expect(await at("2026-10-14T23:59:59.999Z")).toEqual({
        kind: "rejected",
        problems: [{ code: "promotion_not_applicable", reason: "not_started" }],
      });
    });

    it("names why each code does not apply and keeps one code's terms to its own tenant", async () => {
      const reason = async (code: string) => {
        const result = await quoteIn(A.id, {
          tripId: trip(a.reefTrips, "2026-11-12"),
          party: party(["adult", 1]),
          addOns: [],
          promotionCode: code,
        });
        if (result.kind === "created") return result.quote.totals.discount;
        return result.kind === "rejected" ? result.problems : result;
      };
      const expected = (r: string) => [{ code: "promotion_not_applicable", reason: r }];
      expect(await reason("NOSUCH")).toEqual(expected("unknown"));
      expect(await reason("retired")).toEqual(expected("inactive"));
      expect(await reason("LATER")).toEqual(expected("not_started"));
      expect(await reason("old")).toEqual(expected("expired"));
      expect(await reason("OTHERONLY")).toEqual(expected("product_ineligible"));
      expect(await reason("BONLY")).toEqual(expected("unknown"));
      // TWIN is 10% in A and $5 in B.
      expect(await reason("twin")).toBe(600);
      const inB = await quoteIn(B.id, {
        tripId: b.trip,
        party: party(["diver", 1]),
        addOns: [],
        promotionCode: "TWIN",
      });
      expect(inB.kind === "created" ? inB.quote.totals.discount : inB).toBe(500);
    });

    it("refuses a party over the trip's remaining seats, for shared seats and charters", async () => {
      const seats = trip(a.reefTrips, "2026-11-09");
      const boat = trip(a.charterTrips, "2026-11-11");
      const original = await admin<Array<{ id: string; seat_capacity: number }>>`
        select id, seat_capacity from public.scheduled_trips where id in (${seats}, ${boat})`;
      expect(original).toHaveLength(2);
      // Stands in for seats that G2.6 holds will take: the trip stays on sale.
      await admin`update public.scheduled_trips set seat_capacity = 3 where id = ${seats}`;
      await admin`update public.scheduled_trips set seat_capacity = 4 where id = ${boat}`;
      try {
        const shared = (n: number) =>
          quoteIn(A.id, {
            tripId: seats,
            party: party(["adult", n]),
            addOns: [],
            promotionCode: null,
          });
        const charter = (guests: number) =>
          quoteIn(A.id, {
            tripId: boat,
            party: { kind: "charter", guests },
            addOns: [],
            promotionCode: null,
          });
        expect(await shared(4)).toEqual({
          kind: "rejected",
          problems: [{ code: "insufficient_capacity" }],
        });
        expect((await shared(3)).kind).toBe("created");
        expect(await charter(5)).toEqual({
          kind: "rejected",
          problems: [{ code: "insufficient_capacity" }],
        });
        expect((await charter(4)).kind).toBe("created");
      } finally {
        for (const row of original) {
          await admin`update public.scheduled_trips set seat_capacity = ${row.seat_capacity}
            where id = ${row.id}`;
        }
      }
    });

    it("puts the change cutoff that many elapsed minutes before a departure after the clocks go back", async () => {
      // 21:00 EST on 2026-11-01 is 02:00 UTC on 2026-11-02. Twenty-four elapsed hours
      // earlier is 02:00 UTC on 2026-11-01, which is 22:00 EDT, not 21:00.
      const tripId = trip(a.reefTrips, "2026-11-01");
      const offer = await asGuest(A.id, (trx) => getTripOffer(trx, A.id, tripId, NOW));
      if (offer.kind !== "offer") throw new Error(JSON.stringify(offer));
      expect(offer.offer.trip.startsAtLocal).toBe("2026-11-01T21:00:00-05:00");
      expect(offer.offer.policy.changeCutoffAt).toBe("2026-11-01T02:00:00.000Z");
      const quote = await quoteIn(A.id, {
        tripId,
        party: party(["adult", 1]),
        addOns: [],
        promotionCode: null,
      });
      if (quote.kind !== "created") throw new Error(JSON.stringify(quote));
      expect(quote.quote.policy.changeCutoffAt).toBe("2026-11-01T02:00:00.000Z");
    });
  });

  // Snapshot ------------------------------------------------------------------------------

  describe("snapshots", () => {
    it("reads a stored quote back identically after every term and the catalog change, while new quotes name the new versions", async () => {
      const [first, second] = s.trips;
      if (!first || !second) throw new Error("fixture trips missing");
      const selection = {
        party: party(["adult", 2], ["child", 1]),
        addOns: [{ code: "snack", quantity: 2 }],
      };
      const before = await quoteIn(S.id, { tripId: first, ...selection, promotionCode: "snap15" });
      if (before.kind !== "created") throw new Error(JSON.stringify(before));
      const rows = async (quoteId: string) => ({
        header: [...(await admin`select * from public.quotes where id = ${quoteId}`)],
        lines: [
          ...(await admin`select * from public.quote_lines where quote_id = ${quoteId}
            order by line_no`),
        ],
        taxes: [
          ...(await admin`select * from public.quote_line_taxes where quote_id = ${quoteId}
            order by line_no, tax_rate_id`),
        ],
      });
      const rowsBefore = await rows(before.quote.quoteId);
      expect(before.quote).toMatchObject({
        product: { name: "Sunset Sail S" },
        priceListVersion: 1,
        policy: { version: 1, text: { cancellation: "S v1: full refund before the cutoff." } },
        promotion: { code: "SNAP15", version: 1, percentOffBp: 1500 },
      });
      expect(before.quote.taxes.map((t) => [t.name, t.version, t.ratePpm])).toEqual([
        ["City tax", 1, 20_000],
        ["Region tax", 1, 30_000],
      ]);

      await as(S.id, async (trx) => {
        const c = ctx(S.id);
        const changes = [
          await createPriceListVersion(trx, c, {
            productId: s.sail,
            tickets: [
              { code: "adult", name: "Adult", unitAmount: 5500, taxable: true },
              { code: "child", name: "Youth", unitAmount: 2500, taxable: false },
            ],
            fees: [
              {
                code: "dock",
                name: "Dock fee",
                unitAmount: 400,
                basis: "per_booking",
                taxable: true,
              },
            ],
            reason: "new season",
          }),
          await createPolicyVersion(trx, c, {
            ...policyInput(2880, "S v2"),
            productId: s.sail,
            reason: "x",
          }),
          await createTaxRateVersion(trx, c, {
            taxRateId: s.city,
            name: "Municipal tax",
            ratePpm: 25_000,
            inclusive: false,
            active: true,
            reason: "renamed and raised",
          }),
          await createTaxRateVersion(trx, c, {
            taxRateId: s.region,
            name: "Region tax",
            ratePpm: 30_000,
            inclusive: true,
            active: false,
            reason: "repealed",
          }),
          await createPromotionVersion(trx, c, {
            promotionId: s.promotion,
            discount: { kind: "percent", percentOffBp: 5000 },
            startsAt: new Date("2026-09-01T00:00:00Z"),
            endsAt: new Date("2027-06-01T00:00:00Z"),
            products: { productIds: [s.other] },
            active: true,
            reason: "moved to another product",
          }),
        ];
        expect(changes.map((x) => x.kind)).toEqual([
          "created",
          "created",
          "created",
          "created",
          "created",
        ]);
        const closed = await changeTripSalesState(trx, c, {
          tripId: first,
          to: "closed",
          reason: "chartered privately",
          now: NOW,
        });
        expect(closed.kind).toBe("changed");
      });
      // The runtime cannot rename a product; an operator with the owner role can.
      await admin`update public.products set name = 'Renamed Sail S' where id = ${s.sail}`;

      const reread = await asGuest(S.id, (trx) => getQuote(trx, S.id, before.quote.quoteId));
      expect(reread).toEqual(before.quote);
      expect(await rows(before.quote.quoteId)).toEqual(rowsBefore);

      expect(await quoteIn(S.id, { tripId: first, ...selection, promotionCode: null })).toEqual({
        kind: "trip_not_on_sale",
      });
      expect(
        await quoteIn(S.id, { tripId: second, ...selection, promotionCode: "SNAP15" }),
      ).toEqual({
        kind: "rejected",
        problems: [
          { code: "unknown_add_on", subject: "snack" },
          { code: "promotion_not_applicable", reason: "product_ineligible" },
        ],
      });
      const after = await quoteIn(S.id, {
        tripId: second,
        party: selection.party,
        addOns: [],
        promotionCode: null,
      });
      if (after.kind !== "created") throw new Error(JSON.stringify(after));
      expect(after.quote).toMatchObject({
        product: { name: "Renamed Sail S" },
        priceListVersion: 2,
        policy: { version: 2, changeCutoffMinutes: 2880 },
        promotion: null,
      });
      expect(after.quote.lines.map((l) => [l.code, l.name, l.unitAmount, l.taxable])).toEqual([
        ["adult", "Adult", 5500, true],
        ["child", "Youth", 2500, false],
        ["dock", "Dock fee", 400, true],
      ]);
      expect(after.quote.taxes.map((t) => [t.taxRateId, t.name, t.version, t.ratePpm])).toEqual([
        [s.city, "Municipal tax", 2, 25_000],
      ]);

      // Reinstating the regional rate applies its newest version to new quotes only.
      await as(S.id, (trx) =>
        createTaxRateVersion(trx, ctx(S.id), {
          taxRateId: s.region,
          name: "Region tax",
          ratePpm: 35_000,
          inclusive: true,
          active: true,
          reason: "reinstated",
        }),
      );
      const reinstated = await quoteIn(S.id, {
        tripId: second,
        party: selection.party,
        addOns: [],
        promotionCode: null,
      });
      if (reinstated.kind !== "created") throw new Error(JSON.stringify(reinstated));
      expect(reinstated.quote.taxes.map((t) => [t.name, t.version, t.ratePpm])).toEqual([
        ["Municipal tax", 2, 25_000],
        ["Region tax", 3, 35_000],
      ]);
      expect(await asGuest(S.id, (trx) => getQuote(trx, S.id, before.quote.quoteId))).toEqual(
        before.quote,
      );
    });
  });

  // Forgeries ---------------------------------------------------------------------------------

  describe("quotes the database refuses at commit, forged one rule at a time", () => {
    type Rows = {
      header: Insertable<QuotesTable>;
      lines: Array<Omit<Insertable<QuoteLinesTable>, "quote_id">>;
      taxes: Array<Omit<Insertable<QuoteLineTaxesTable>, "quote_id">>;
    };

    interface Forgery {
      tripId?: string;
      party?: PartySelection;
      addOns?: Array<{ code: string; quantity: number }>;
      promotionCode?: string | null;
      /** The pricing instant the forger computes with; quoted_at stays NOW unless rows change it. */
      nowMs?: number;
      list?: (list: PriceList) => PriceList;
      rates?: (rates: TaxRate[]) => TaxRate[];
      promotion?: (terms: PromotionTerms | null) => PromotionTerms | null;
      rows?: (rows: Rows) => void;
      savepoint?: boolean;
    }

    /**
     * Prices with the pure function, possibly from forged terms, and writes the
     * result as a quote that names the real current versions, as createQuote
     * would. Without forgery it must commit; with one, the database must refuse.
     */
    function forge(f: Forgery): Promise<Failure | null> {
      return failure(
        asGuest(A.id, async (trx) => {
          const tripId = f.tripId ?? trip(a.reefTrips, "2026-11-10");
          const found = await findTripForSale(trx, A.id, tripId, NOW);
          if (found.kind !== "on_sale") throw new Error("fixture trip not on sale");
          const t: SaleTrip = found.trip;
          const list = await loadPriceList(trx, A.id, t.productId);
          const policy = await loadPolicy(trx, A.id, t.productId);
          if (!list || !policy) throw new Error("fixture terms missing");
          const code = f.promotionCode === undefined ? "TIDE15" : f.promotionCode;
          const terms =
            code === null ? null : await findPromotion(trx, A.id, normalizePromotionCode(code));
          const outcome = priceQuote({
            nowMs: f.nowMs ?? NOW.getTime(),
            subject: {
              productId: t.productId,
              productKind: t.productKind,
              localDate: t.localDate,
              minPartySize: t.minPartySize,
              maxPartySize: t.maxPartySize,
              capacityRemaining: t.capacityRemaining,
            },
            priceList: f.list ? f.list(list) : list,
            taxRates: f.rates
              ? f.rates(await loadTaxRates(trx, A.id))
              : await loadTaxRates(trx, A.id),
            promotion: f.promotion ? f.promotion(terms) : terms,
            selection: {
              party: f.party ?? party(["adult", 2], ["child", 1], ["infant", 1]),
              addOns: f.addOns ?? [
                { code: "snorkel", quantity: 2 },
                { code: "photo", quantity: 1 },
              ],
              promotionCode: code,
            },
          });
          if (outcome.kind !== "priced") {
            throw new Error(`forgery setup did not price: ${JSON.stringify(outcome)}`);
          }
          const rows = rowsFor(t, list.version, policy.version, outcome.quote);
          f.rows?.(rows);
          const { id } = await trx
            .insertInto("quotes")
            .values(rows.header)
            .returning("id")
            .executeTakeFirstOrThrow();
          if (f.savepoint) await sql`savepoint forged_lines`.execute(trx);
          await trx
            .insertInto("quote_lines")
            .values(rows.lines.map((l) => ({ ...l, quote_id: id })))
            .execute();
          if (rows.taxes.length > 0) {
            await trx
              .insertInto("quote_line_taxes")
              .values(rows.taxes.map((x) => ({ ...x, quote_id: id })))
              .execute();
          }
          if (f.savepoint) await sql`release savepoint forged_lines`.execute(trx);
        }),
      );
    }

    function rowsFor(
      t: SaleTrip,
      priceListVersion: number,
      policyVersion: number,
      q: PricedQuote,
    ): Rows {
      const header: Insertable<QuotesTable> = {
        tenant_id: A.id,
        trip_id: t.tripId,
        product_id: t.productId,
        product_kind: t.productKind,
        product_name: t.productName,
        trip_time_zone: t.timeZone,
        trip_local_date: t.localDate,
        trip_local_start_time: `${t.localStartTime}:00`,
        trip_starts_at: t.startsAt,
        trip_start_utc_offset_minutes: t.startOffsetMinutes,
        price_list_version: priceListVersion,
        policy_version: policyVersion,
        promotion_id: q.discount?.promotionId ?? null,
        promotion_version: q.discount?.version ?? null,
        party_size: q.partySize,
        subtotal_amount: q.totals.subtotal,
        discount_amount: q.totals.discount,
        fee_amount: q.totals.fees,
        tax_amount: q.totals.tax,
        included_tax_amount: q.totals.includedTax,
        total_amount: q.totals.total,
        quoted_at: NOW,
        expires_at: new Date(NOW.getTime() + 30 * 60_000),
      };
      const lines: Rows["lines"] = q.lines.map((l) => ({
        tenant_id: A.id,
        line_no: l.lineNo,
        kind: l.kind,
        code: l.code,
        name: l.name,
        basis: l.basis,
        quantity: l.quantity,
        unit_amount: l.unitAmount,
        amount: l.amount,
        discount_amount: l.discountAmount,
        taxable: l.taxable,
      }));
      if (q.discount) {
        lines.push({
          tenant_id: A.id,
          line_no: q.discount.lineNo,
          kind: "discount",
          code: q.discount.code,
          name: `${q.discount.code} discount`,
          basis: null,
          quantity: 1,
          unit_amount: q.discount.amount,
          amount: -q.discount.amount,
          discount_amount: 0,
          taxable: false,
        });
      }
      const taxes: Rows["taxes"] = q.lines.flatMap((l) =>
        l.taxes.map((x) => ({
          tenant_id: A.id,
          line_no: l.lineNo,
          tax_rate_id: x.taxRateId,
          tax_rate_version: x.version,
          taxable_amount: x.taxableAmount,
          amount: x.amount,
        })),
      );
      return { header, lines, taxes };
    }

    const refused = (pattern: RegExp) => ({
      code: "23514",
      message: expect.stringMatching(pattern),
    });
    const TRIP = /does not match the trip it names/;
    const LINES = /has lines its price list does not allow/;
    const COVER = /does not cover its party and fees/;
    const PROMO = /applies a promotion it may not/;
    const TAXES = /has taxes that do not follow its rates/;
    const SUMS = /does not add up to its lines/;
    const withTicket =
      (code: string, change: Partial<PriceList["tickets"][number]>) => (l: PriceList) => ({
        ...l,
        tickets: l.tickets.map((x) => (x.code === code ? { ...x, ...change } : x)),
      });

    it("accepts an honest quote written the same way, also with its lines after a savepoint", async () => {
      expect(await forge({})).toBeNull();
      expect(await forge({ savepoint: true })).toBeNull();
      expect(await forge({ promotionCode: null, addOns: [] })).toBeNull();
    });

    it("refuses a trip snapshot that differs from the trip in any field", async () => {
      const header = (change: Partial<Insertable<QuotesTable>>) =>
        forge({ rows: (r) => Object.assign(r.header, change) });
      for (const change of [
        { trip_local_start_time: "20:00:00" },
        { trip_local_date: "2026-11-11" },
        { trip_time_zone: "America/Chicago" },
        { trip_starts_at: "2026-11-11T02:01:00Z" },
        { trip_start_utc_offset_minutes: -240 },
        { product_name: "Cheaper Sail" },
      ]) {
        expect({ change, result: await header(change) }).toEqual({ change, result: refused(TRIP) });
      }
    });

    it("refuses lines that are not the named price list's items copied exactly", async () => {
      // A cheaper ticket, an untaxed ticket, a renamed ticket.
      expect(await forge({ list: withTicket("adult", { unitAmount: 1 }) })).toEqual(refused(LINES));
      expect(await forge({ list: withTicket("adult", { taxable: false }) })).toEqual(
        refused(LINES),
      );
      expect(await forge({ list: withTicket("child", { name: "Kid" }) })).toEqual(refused(LINES));
      // An add-on over its per-participant limit, and one outside its dates.
      expect(
        await forge({
          list: (l) => ({
            ...l,
            addOns: l.addOns.map((x) => (x.code === "snorkel" ? { ...x, maxQuantity: 5 } : x)),
          }),
          addOns: [{ code: "snorkel", quantity: 5 }],
        }),
      ).toEqual(refused(LINES));
      expect(
        await forge({
          list: (l) => ({
            ...l,
            addOns: l.addOns.map((x) => (x.code === "late" ? { ...x, availableFrom: null } : x)),
          }),
          addOns: [{ code: "late", quantity: 1 }],
        }),
      ).toEqual(refused(LINES));
      // A per-participant fee charged once.
      expect(
        await forge({
          list: (l) => ({
            ...l,
            fees: l.fees.map((x) =>
              x.code === "park" ? { ...x, basis: "per_booking" as const } : x,
            ),
          }),
        }),
      ).toEqual(refused(LINES));
    });

    it("refuses a quote that drops a fee, a ticket, or repeats an item", async () => {
      expect(
        await forge({ list: (l) => ({ ...l, fees: l.fees.filter((x) => x.code !== "booking") }) }),
      ).toEqual(refused(COVER));
      // The free infant leaves the lines but stays in the party size.
      expect(
        await forge({
          rows: (r) => {
            r.lines = r.lines.filter((l) => l.code !== "infant");
          },
        }),
      ).toEqual(refused(COVER));
      // Two lines for one berth type, with the same party and totals.
      expect(
        await forge({
          tripId: trip(a.yachtTrips, "2026-11-11"),
          party: party(["berth", 2]),
          addOns: [],
          promotionCode: null,
          rows: (r) => {
            const [berth] = r.lines;
            if (!berth) throw new Error("no berth line");
            r.lines = [
              { ...berth, line_no: 1, quantity: 1, amount: 10_000_000 },
              { ...berth, line_no: 2, quantity: 1, amount: 10_000_000 },
            ];
          },
        }),
      ).toEqual(refused(COVER));
    });

    it("refuses a promotion that was retired, out of its window, for another product, misapplied, or mislabeled", async () => {
      const active = (p: PromotionTerms | null) => (p ? { ...p, active: true } : p);
      expect(await forge({ promotionCode: "RETIRED", promotion: active })).toEqual(refused(PROMO));
      // Priced as if it were mid-September, stored at its real quote instant.
      expect(
        await forge({ promotionCode: "OLD", nowMs: Date.parse("2026-09-15T00:00:00Z") }),
      ).toEqual(refused(PROMO));
      expect(
        await forge({
          promotionCode: "OTHERONLY",
          promotion: (p) => (p ? { ...p, appliesToAllProducts: true } : p),
        }),
      ).toEqual(refused(PROMO));
      expect(
        await forge({
          promotion: (p) => (p ? { ...p, discount: { kind: "percent", percentOffBp: 5000 } } : p),
        }),
      ).toEqual(refused(PROMO));
      expect(
        await forge({
          rows: (r) => {
            r.lines = r.lines.map((l) => (l.kind === "discount" ? { ...l, code: "TIDE16" } : l));
          },
        }),
      ).toEqual(refused(PROMO));
    });

    it("refuses taxes at the wrong rate, a wrong inclusive base, or a rate missing from one line", async () => {
      const state = a.taxes.get("State sales tax");
      const excise = a.taxes.get("General excise");
      const county = a.taxes.get("County levy");
      const rated = (id: string | undefined, ratePpm: number) => (rates: TaxRate[]) =>
        rates.map((x) => (x.taxRateId === id ? { ...x, ratePpm } : x));
      expect(await forge({ rates: rated(state, 50_000) })).toEqual(refused(TAXES));
      expect(await forge({ rates: rated(excise, 40_000) })).toEqual(refused(TAXES));
      expect(
        await forge({
          rows: (r) => {
            const dropped = r.taxes.find((x) => x.line_no === 1 && x.tax_rate_id === county);
            if (!dropped) throw new Error("no county tax on line 1");
            r.taxes = r.taxes.filter((x) => x !== dropped);
            r.header.included_tax_amount =
              Number(r.header.included_tax_amount) - Number(dropped.amount);
          },
        }),
      ).toEqual(refused(TAXES));
    });

    it("refuses a tax on an untaxed line and a discount line without its promotion, or the reverse", async () => {
      const state = a.taxes.get("State sales tax") ?? "";
      expect(
        await forge({
          rows: (r) => {
            const photo = r.lines.find((l) => l.code === "photo");
            if (!photo) throw new Error("no photo line");
            r.taxes.push({
              tenant_id: A.id,
              line_no: photo.line_no,
              tax_rate_id: state,
              tax_rate_version: 1,
              taxable_amount: 2500,
              amount: 150,
            });
            r.header.tax_amount = Number(r.header.tax_amount) + 150;
            r.header.total_amount = Number(r.header.total_amount) + 150;
          },
        }),
      ).toEqual(refused(SUMS));
      expect(
        await forge({
          rows: (r) => {
            r.header.promotion_id = null;
            r.header.promotion_version = null;
          },
        }),
      ).toEqual(refused(SUMS));
      // A $9.99 code on free tickets discounts nothing, but still needs its line.
      expect(
        await forge({
          party: party(["infant", 2]),
          addOns: [],
          promotionCode: "FLAT999",
          rows: (r) => {
            r.lines = r.lines.filter((l) => l.kind !== "discount");
          },
        }),
      ).toEqual(refused(SUMS));
    });
  });

  // Sealed children ------------------------------------------------------------------------------

  describe("child rows sealed to their parent's transaction", () => {
    it("refuses a child row for a committed parent in a later transaction, inside a savepoint, and as the owner", async () => {
      // A committed quote and one of its untaxed lines, which has no tax row yet.
      const [quote] = await admin<Array<{ id: string; line_no: number }>>`
        select q.id, l.line_no from public.quotes q
          join public.quote_lines l on l.tenant_id = q.tenant_id and l.quote_id = q.id
         where q.tenant_id = ${A.id} and l.kind <> 'discount' and not l.taxable
         order by q.created_at, l.line_no limit 1`;
      if (!quote) throw new Error("no committed quote with an untaxed line");
      const lineNo = quote.line_no;
      const otherOnly = a.promotions.get("OTHERONLY") ?? "";
      const state = a.taxes.get("State sales tax") ?? "";
      const attempts: Record<string, (trx: TenantTransaction) => Promise<unknown>> = {
        "a cheaper ticket on a committed price list": (trx) =>
          trx
            .insertInto("price_list_items")
            .values({
              tenant_id: A.id,
              product_id: a.reef,
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
        "another product on a committed promotion": (trx) =>
          trx
            .insertInto("promotion_version_products")
            .values({ tenant_id: A.id, promotion_id: otherOnly, version: 1, product_id: a.reef })
            .execute(),
        "a line on a committed quote": (trx) =>
          trx
            .insertInto("quote_lines")
            .values({
              tenant_id: A.id,
              quote_id: quote.id,
              line_no: 150,
              kind: "fee",
              code: "sneaky",
              name: "Sneaky fee",
              basis: "per_booking",
              quantity: 1,
              unit_amount: 100,
              amount: 100,
              taxable: false,
            })
            .execute(),
        "a tax on a committed quote": (trx) =>
          trx
            .insertInto("quote_line_taxes")
            .values({
              tenant_id: A.id,
              quote_id: quote.id,
              line_no: lineNo,
              tax_rate_id: state,
              tax_rate_version: 1,
              taxable_amount: 100,
              amount: 6,
            })
            .execute(),
      };
      for (const [label, attempt] of Object.entries(attempts)) {
        const later = await failure(as(A.id, attempt));
        const inSavepoint = await failure(
          as(A.id, async (trx) => {
            await sql`savepoint later`.execute(trx);
            await attempt(trx);
          }),
        );
        expect({ label, later: later?.code, inSavepoint: inSavepoint?.code }).toEqual({
          label,
          later: "55000",
          inSavepoint: "55000",
        });
      }
      const ownerProduct = await failure(
        admin`insert into public.promotion_version_products (tenant_id, promotion_id, version, product_id)
          values (${A.id}, ${otherOnly}, 1, ${a.reef})`,
      );
      const ownerTax = await failure(
        admin`insert into public.quote_line_taxes
            (tenant_id, quote_id, line_no, tax_rate_id, tax_rate_version, taxable_amount, amount)
          values (${A.id}, ${quote.id}, ${lineNo}, ${state}, 1, 100, 6)`,
      );
      expect([ownerProduct?.code, ownerTax?.code]).toEqual(["55000", "55000"]);
      const [counts] = await admin<Array<{ products: number; taxes: number }>>`
        select (select count(*)::int from public.promotion_version_products
                 where promotion_id = ${otherOnly}) as products,
               (select count(*)::int from public.quote_line_taxes
                 where quote_id = ${quote.id} and line_no = ${lineNo}) as taxes`;
      expect(counts).toEqual({ products: 1, taxes: 0 });
    });

    it("refuses a product list on a promotion version for all products, even in its own transaction", async () => {
      const result = await failure(
        as(A.id, async (trx) => {
          const promotionId = a.promotions.get("TWIN") ?? "";
          await trx
            .insertInto("promotion_versions")
            .values({
              tenant_id: A.id,
              promotion_id: promotionId,
              version: 2,
              discount_kind: "percent",
              percent_off_bp: 1000,
              starts_at: "2026-09-01T00:00:00Z",
              ends_at: "2027-06-01T00:00:00Z",
              applies_to_all_products: true,
              active: true,
              reason: "sneak a list in",
            })
            .execute();
          await trx
            .insertInto("promotion_version_products")
            .values({ tenant_id: A.id, promotion_id: promotionId, version: 2, product_id: a.reef })
            .execute();
        }),
      );
      expect(result?.code).toBe("23514");
    });
  });

  // Tenancy ------------------------------------------------------------------------------------

  describe("tenancy", () => {
    it("refuses a quote naming another tenant's trip, promotion, or tax rate, or a trip of another product", async () => {
      const reefTrip = trip(a.reefTrips, "2026-11-12");
      const header = async (trx: TenantTransaction, change: Partial<Insertable<QuotesTable>>) => {
        const found = await findTripForSale(trx, A.id, reefTrip, NOW);
        if (found.kind !== "on_sale") throw new Error("fixture trip not on sale");
        const t = found.trip;
        return trx
          .insertInto("quotes")
          .values({
            tenant_id: A.id,
            trip_id: t.tripId,
            product_id: t.productId,
            product_kind: t.productKind,
            product_name: t.productName,
            trip_time_zone: t.timeZone,
            trip_local_date: t.localDate,
            trip_local_start_time: `${t.localStartTime}:00`,
            trip_starts_at: t.startsAt,
            trip_start_utc_offset_minutes: t.startOffsetMinutes,
            price_list_version: 1,
            policy_version: 1,
            party_size: 1,
            subtotal_amount: 5999,
            discount_amount: 0,
            fee_amount: 249,
            tax_amount: 0,
            included_tax_amount: 0,
            total_amount: 6248,
            quoted_at: NOW,
            expires_at: new Date(NOW.getTime() + 60_000),
            ...change,
          })
          .returning("id")
          .executeTakeFirstOrThrow();
      };
      const [bTrip] = await admin<Array<{ product_id: string }>>`
        select product_id from public.scheduled_trips where id = ${b.trip}`;
      const results = {
        "B's trip": await failure(
          as(A.id, (trx) => header(trx, { trip_id: b.trip, product_id: bTrip?.product_id ?? "" })),
        ),
        "A's trip under A's charter": await failure(
          as(A.id, (trx) => header(trx, { product_id: a.charter })),
        ),
        "B's promotion": await failure(
          as(A.id, (trx) => header(trx, { promotion_id: b.promotion, promotion_version: 1 })),
        ),
        "B's tax rate": await failure(
          as(A.id, async (trx) => {
            const { id } = await header(trx, {});
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
                unit_amount: 5999,
                amount: 5999,
                taxable: true,
              })
              .execute();
            await trx
              .insertInto("quote_line_taxes")
              .values({
                tenant_id: A.id,
                quote_id: id,
                line_no: 1,
                tax_rate_id: b.tax,
                tax_rate_version: 1,
                taxable_amount: 5729,
                amount: 270,
              })
              .execute();
          }),
        ),
        "B's tenant id": await failure(as(A.id, (trx) => header(trx, { tenant_id: B.id }))),
      };
      // The trip snapshot trigger runs as the writer before row security and the
      // foreign keys, so a trip it cannot see in this tenant is refused first.
      expect(
        Object.fromEntries(Object.entries(results).map(([k, f]) => [k, f?.code ?? "accepted"])),
      ).toEqual({
        "B's trip": "23514",
        "A's trip under A's charter": "23514",
        "B's promotion": "23503",
        "B's tax rate": "23503",
        "B's tenant id": "23514",
      });
      const termsResults = {
        "a price list for B's product": await failure(
          as(A.id, (trx) =>
            trx
              .insertInto("price_list_versions")
              .values({
                tenant_id: A.id,
                product_id: b.dive,
                version: 9,
                product_kind: "shared_seat",
                reason: "escape",
              })
              .execute(),
          ),
        ),
        "a charter price list for a shared-seat product": await failure(
          as(A.id, (trx) =>
            trx
              .insertInto("price_list_versions")
              .values({
                tenant_id: A.id,
                product_id: a.reef,
                version: 9,
                product_kind: "private_charter",
                reason: "wrong kind",
              })
              .execute(),
          ),
        ),
        "a promotion listing B's product": await failure(
          as(A.id, async (trx) => {
            const promotionId = a.promotions.get("OTHERONLY") ?? "";
            await trx
              .insertInto("promotion_versions")
              .values({
                tenant_id: A.id,
                promotion_id: promotionId,
                version: 2,
                discount_kind: "percent",
                percent_off_bp: 1000,
                starts_at: "2026-09-01T00:00:00Z",
                ends_at: "2027-06-01T00:00:00Z",
                applies_to_all_products: false,
                active: true,
                reason: "escape",
              })
              .execute();
            await trx
              .insertInto("promotion_version_products")
              .values({
                tenant_id: A.id,
                promotion_id: promotionId,
                version: 2,
                product_id: b.dive,
              })
              .execute();
          }),
        ),
      };
      expect(
        Object.fromEntries(
          Object.entries(termsResults).map(([k, f]) => [k, f?.code ?? "accepted"]),
        ),
      ).toEqual({
        "a price list for B's product": "23503",
        "a charter price list for a shared-seat product": "23503",
        "a promotion listing B's product": "23503",
      });
    });

    it("keeps every service inside the caller's tenant even when the caller passes the other tenant's id", async () => {
      const count = async () =>
        (
          await admin<Array<{ n: number }>>`
            select (select count(*) from public.price_list_versions where tenant_id = ${B.id})
                 + (select count(*) from public.policy_versions where tenant_id = ${B.id})
                 + (select count(*) from public.tax_rate_versions where tenant_id = ${B.id})
                 + (select count(*) from public.promotion_versions where tenant_id = ${B.id})
                 + (select count(*) from public.quotes where tenant_id = ${B.id}) as n`
        )[0]?.n;
      const before = await count();
      const seen = await as(A.id, async (trx) => {
        const c = ctx(A.id);
        return {
          quote: await getQuote(trx, B.id, b.quote),
          offer: await getTripOffer(trx, B.id, b.trip, NOW),
          priceList: await loadPriceList(trx, B.id, b.dive),
          policy: await loadPolicy(trx, B.id, b.dive),
          taxes: await loadTaxRates(trx, B.id),
          promotion: await findPromotion(trx, B.id, "BONLY"),
          created: await createQuote(trx, c, {
            tripId: b.trip,
            party: party(["diver", 1]),
            addOns: [],
            promotionCode: null,
            now: NOW,
          }),
          price: await createPriceListVersion(trx, c, {
            productId: b.dive,
            tickets: [{ code: "diver", name: "Diver", unitAmount: 1, taxable: false }],
            reason: "escape",
          }),
          policyVersion: await createPolicyVersion(trx, c, {
            ...policyInput(0, "escape"),
            productId: b.dive,
            reason: "escape",
          }),
          taxVersion: await createTaxRateVersion(trx, c, {
            taxRateId: b.tax,
            name: "Zero",
            ratePpm: 1,
            inclusive: true,
            active: false,
            reason: "escape",
          }),
          promotionVersion: await createPromotionVersion(trx, c, {
            promotionId: b.promotion,
            discount: { kind: "percent", percentOffBp: 10_000 },
            startsAt: new Date("2026-09-01T00:00:00Z"),
            endsAt: new Date("2027-06-01T00:00:00Z"),
            products: { all: true },
            active: true,
            reason: "escape",
          }),
          promotionForB: await createPromotion(trx, c, {
            code: "ESCAPE",
            discount: { kind: "percent", percentOffBp: 10_000 },
            startsAt: new Date("2026-09-01T00:00:00Z"),
            endsAt: new Date("2027-06-01T00:00:00Z"),
            products: { productIds: [b.dive] },
            reason: "escape",
          }),
        };
      });
      expect(seen).toEqual({
        quote: null,
        offer: { kind: "trip_not_found" },
        priceList: null,
        policy: null,
        taxes: [],
        promotion: null,
        created: { kind: "trip_not_found" },
        price: { kind: "not_found" },
        policyVersion: { kind: "not_found" },
        taxVersion: { kind: "not_found" },
        promotionVersion: { kind: "not_found" },
        promotionForB: { kind: "invalid", problems: ["invalid_products"] },
      });
      expect(await count()).toBe(before);
    });

    it("reads no pricing row and writes none without a tenant context", async () => {
      for (const table of TABLES) {
        const { rows } = await sql<{ n: number }>`
          select count(*)::int as n from ${sql.table(`public.${table}`)}`.execute(runtime.db);
        expect({ table, n: rows[0]?.n }).toEqual({ table, n: 0 });
      }
      const write = await failure(
        sql`insert into public.tax_rate_versions
              (tenant_id, tax_rate_id, version, name, rate_ppm, inclusive, active, reason)
            values (${A.id}, ${randomUUID()}, 1, 'Contextless', 1000, false, true, 'escape')`.execute(
          runtime.db,
        ),
      );
      expect(write?.code).toBe("42501");
    });
  });

  // Immutability and publishing ------------------------------------------------------------------

  describe("immutability and publishing", () => {
    it("refuses TRUNCATE by the runtime on every pricing table", async () => {
      for (const table of TABLES) {
        const result = await failure(
          as(A.id, (trx) => sql.raw(`truncate public.${table} cascade`).execute(trx)),
        );
        expect({ table, code: result?.code }).toEqual({ table, code: "42501" });
      }
    });

    it("refuses a product inserted as published without terms, by the runtime and by the owner", async () => {
      const [location] = await admin<Array<{ id: string }>>`
        select id from public.locations where tenant_id = ${A.id} order by name limit 1`;
      const row = {
        tenant_id: A.id,
        location_id: location?.id ?? "",
        kind: "shared_seat" as const,
        name: "Born published",
        duration_minutes: 60,
        max_party_size: 2,
        sales_status: "published" as const,
      };
      const asRuntime = await failure(
        as(A.id, (trx) => trx.insertInto("products").values(row).execute()),
      );
      const asOwner = await failure(
        admin`insert into public.products (tenant_id, location_id, kind, name, duration_minutes,
                max_party_size, sales_status)
              values (${A.id}, ${row.location_id}, 'shared_seat', 'Born published', 60, 2, 'published')`,
      );
      expect([asRuntime?.code, asOwner?.code]).toEqual(["23514", "23514"]);
    });

    it("rolls back a publish that rides on an empty price list written in the same transaction", async () => {
      const result = await failure(
        as(A.id, async (trx) => {
          await trx
            .insertInto("policy_versions")
            .values({
              tenant_id: A.id,
              product_id: a.draft,
              version: 1,
              change_cutoff_minutes: 0,
              before_cutoff_remedy: "none",
              after_cutoff_remedy: "none",
              no_show_remedy: "none",
              cancellation_text: "x",
              reschedule_text: "x",
              no_show_text: "x",
              operator_cancellation_text: "x",
              weather_text: "x",
              reason: "sneak",
            })
            .execute();
          await trx
            .insertInto("price_list_versions")
            .values({
              tenant_id: A.id,
              product_id: a.draft,
              version: 1,
              product_kind: "shared_seat",
              reason: "empty",
            })
            .execute();
          await trx
            .updateTable("products")
            .set({ sales_status: "published" })
            .where("tenant_id", "=", A.id)
            .where("id", "=", a.draft)
            .execute();
        }),
      );
      expect(result?.code).toBe("23514");
      const [state] = await admin<Array<{ sales_status: string; versions: number }>>`
        select p.sales_status,
               (select count(*)::int from public.price_list_versions v where v.product_id = p.id) as versions
          from public.products p where p.id = ${a.draft}`;
      expect(state).toEqual({ sales_status: "draft", versions: 0 });
    });

    it("names only the missing policy when a price list exists, and the database agrees", async () => {
      const attempt = await as(A.id, (trx) =>
        publishProduct(trx, ctx(A.id), { productId: a.pricedOnly, reason: "try" }),
      );
      expect(attempt).toEqual({ kind: "not_publishable", problems: ["product_missing_policy"] });
      const direct = await failure(
        as(A.id, (trx) =>
          trx
            .updateTable("products")
            .set({ sales_status: "published" })
            .where("tenant_id", "=", A.id)
            .where("id", "=", a.pricedOnly)
            .execute(),
        ),
      );
      expect(direct?.code).toBe("23514");
      await as(A.id, (trx) =>
        createPolicyVersion(trx, ctx(A.id), {
          ...policyInput(60, "late"),
          productId: a.pricedOnly,
          reason: "x",
        }),
      );
      const published = await as(A.id, (trx) =>
        publishProduct(trx, ctx(A.id), { productId: a.pricedOnly, reason: "terms complete" }),
      );
      expect(published.kind).toBe("published");
    });
  });

  // Versions, races, guests, audit, validation -------------------------------------------------------

  describe("versions, races, guests, and audit", () => {
    it("numbers concurrent price list, tax rate, and promotion versions consecutively without failing one", async () => {
      const five = <T>(fn: (i: number) => Promise<T>) => Promise.all([0, 1, 2, 3, 4].map(fn));
      const prices = await five((i) =>
        as(V.id, (trx) =>
          createPriceListVersion(trx, ctx(V.id), {
            productId: v.product,
            tickets: [{ code: "adult", name: "Adult", unitAmount: 1000 + i, taxable: true }],
            reason: `race ${i}`,
          }),
        ),
      );
      const taxes = await five((i) =>
        as(V.id, (trx) =>
          createTaxRateVersion(trx, ctx(V.id), {
            taxRateId: v.tax,
            name: "Base tax",
            ratePpm: 10_000 + i,
            inclusive: false,
            active: true,
            reason: `race ${i}`,
          }),
        ),
      );
      const promotions = await five((i) =>
        as(V.id, (trx) =>
          createPromotionVersion(trx, ctx(V.id), {
            promotionId: v.promotion,
            discount: { kind: "percent", percentOffBp: 500 + i },
            startsAt: new Date("2026-09-01T00:00:00Z"),
            endsAt: new Date("2027-06-01T00:00:00Z"),
            products: { productIds: [v.product] },
            active: true,
            reason: `race ${i}`,
          }),
        ),
      );
      const numbers = (results: Array<{ kind: string; version?: number }>) =>
        results.map((r) => (r.kind === "created" ? r.version : r.kind)).sort();
      expect(numbers(prices)).toEqual([2, 3, 4, 5, 6]);
      expect(numbers(taxes)).toEqual([2, 3, 4, 5, 6]);
      expect(numbers(promotions)).toEqual([2, 3, 4, 5, 6]);
      const [rows] = await admin<Array<{ items: number; products: number }>>`
        select (select count(*)::int from public.price_list_items where tenant_id = ${V.id}) as items,
               (select count(*)::int from public.promotion_version_products where tenant_id = ${V.id}) as products`;
      expect(rows).toEqual({ items: 6, products: 5 });
    });

    it("creates a code once when four writers race with it in different case and spacing", async () => {
      const results = await Promise.all(
        ["race1", "RACE1", " Race1 ", "rAcE1"].map((code) =>
          as(V.id, (trx) =>
            createPromotion(trx, ctx(V.id), {
              code,
              discount: { kind: "fixed_amount", amountOff: 100 },
              startsAt: new Date("2026-09-01T00:00:00Z"),
              endsAt: new Date("2027-06-01T00:00:00Z"),
              products: { all: true },
              reason: "race",
            }),
          ),
        ),
      );
      expect(results.map((r) => r.kind).sort()).toEqual([
        "code_taken",
        "code_taken",
        "code_taken",
        "created",
      ]);
      const rows = await admin<Array<{ code: string; versions: number }>>`
        select p.code, (select count(*)::int from public.promotion_versions v where v.promotion_id = p.id) as versions
          from public.promotions p where p.tenant_id = ${V.id} and p.code like 'RACE1%'`;
      expect(rows).toEqual([{ code: "RACE1", versions: 1 }]);
    });

    it("refuses a guest writing any kind of terms through the commands", async () => {
      const g = ctx(V.id, "guest");
      const attempts = {
        priceList: await failure(
          asGuest(V.id, (trx) =>
            createPriceListVersion(trx, g, {
              productId: v.product,
              tickets: [{ code: "adult", name: "Adult", unitAmount: 1, taxable: false }],
              reason: "guest",
            }),
          ),
        ),
        policy: await failure(
          asGuest(V.id, (trx) =>
            createPolicyVersion(trx, g, {
              ...policyInput(0, "guest"),
              productId: v.product,
              reason: "guest",
            }),
          ),
        ),
        taxRate: await failure(
          asGuest(V.id, (trx) =>
            createTaxRate(trx, g, {
              name: "Guest tax",
              ratePpm: 1,
              inclusive: false,
              reason: "guest",
            }),
          ),
        ),
        promotion: await failure(
          asGuest(V.id, (trx) =>
            createPromotion(trx, g, {
              code: "GUESTCODE",
              discount: { kind: "percent", percentOffBp: 10_000 },
              startsAt: new Date("2026-09-01T00:00:00Z"),
              endsAt: new Date("2027-06-01T00:00:00Z"),
              products: { all: true },
              reason: "guest",
            }),
          ),
        ),
      };
      expect(Object.fromEntries(Object.entries(attempts).map(([k, f]) => [k, f?.code]))).toEqual({
        priceList: "23514",
        policy: "23514",
        taxRate: "23514",
        promotion: "23514",
      });
    });

    it("refuses a guest transaction writing terms even when the insert names another actor", async () => {
      // The actor check reads the actor_type column, whose default is the
      // transaction's actor. A writer that names the column itself is not the
      // transaction's actor, so a guest transaction must still be refused.
      class RolledBack extends Error {}
      const attempt = async (write: (trx: TenantTransaction) => Promise<unknown>) => {
        try {
          await asGuest(V.id, async (trx) => {
            await write(trx);
            throw new RolledBack();
          });
        } catch (err) {
          if (err instanceof RolledBack) return "accepted";
          return (err as { code?: string }).code;
        }
        return "accepted";
      };
      const taxRate = await attempt((trx) =>
        trx
          .insertInto("tax_rate_versions")
          .values({
            tenant_id: V.id,
            tax_rate_id: randomUUID(),
            version: 1,
            name: "Guest tax",
            rate_ppm: 1,
            inclusive: false,
            active: false,
            reason: "guest",
            actor_type: "staff",
          })
          .execute(),
      );
      const promotion = await attempt((trx) =>
        trx
          .insertInto("promotions")
          .values({ tenant_id: V.id, code: "GUESTSTAFF", actor_type: "system" })
          .execute(),
      );
      expect({ taxRate, promotion }).toEqual({ taxRate: "23514", promotion: "23514" });
    });

    it("records the actor, request, and reason of every terms command", async () => {
      const staff: TenantContext = {
        tenantId: V.id,
        actorType: "staff",
        actorId: `staff-${run}`,
        requestId: `audit-${run}`,
      };
      const created = await inTenantTransaction(runtime.db, staff, (trx) =>
        createPriceListVersion(trx, staff, {
          productId: v.product,
          tickets: [{ code: "adult", name: "Adult", unitAmount: 1234, taxable: true }],
          reason: "spring prices",
        }),
      );
      if (created.kind !== "created") throw new Error(JSON.stringify(created));
      const [version] = await admin<
        Array<{ actor_type: string; actor_id: string; request_id: string; reason: string }>
      >`
        select actor_type, actor_id, request_id, reason from public.price_list_versions
         where tenant_id = ${V.id} and product_id = ${v.product} and version = ${created.version}`;
      expect(version).toEqual({
        actor_type: "staff",
        actor_id: `staff-${run}`,
        request_id: `audit-${run}`,
        reason: "spring prices",
      });
      const audit = await admin<
        Array<{
          action: string;
          actor_type: string;
          actor_id: string;
          reason: string;
          after_state: { version: number };
        }>
      >`
        select action, actor_type, actor_id, reason, after_state from public.audit_events
         where tenant_id = ${V.id} and request_id = ${`audit-${run}`}`;
      expect(audit).toEqual([
        {
          action: "price_list.version_created",
          actor_type: "staff",
          actor_id: `staff-${run}`,
          reason: "spring prices",
          after_state: expect.objectContaining({ version: created.version }),
        },
      ]);
    });

    it("answers a C1 control character in a name as invalid instead of failing the insert", async () => {
      // The database's [[:cntrl:]] check refuses U+0085 and U+009B; the
      // commands must name the problem, not throw a raw 23514.
      const thrown = (err: { code?: string }) => ({ thrown: err.code });
      const priceList = await as(V.id, (trx) =>
        createPriceListVersion(trx, ctx(V.id), {
          productId: v.product,
          tickets: [{ code: "adult", name: "Adult\u0085", unitAmount: 1000, taxable: true }],
          reason: "control character",
        }),
      ).catch(thrown);
      const taxRate = await as(V.id, (trx) =>
        createTaxRate(trx, ctx(V.id), {
          name: "Sales\u009btax",
          ratePpm: 70_000,
          inclusive: false,
          reason: "control character",
        }),
      ).catch(thrown);
      expect({ priceList, taxRate }).toEqual({
        priceList: { kind: "invalid", problems: ["invalid_name"] },
        taxRate: { kind: "invalid", problems: ["invalid_name"] },
      });
    });
  });
});
