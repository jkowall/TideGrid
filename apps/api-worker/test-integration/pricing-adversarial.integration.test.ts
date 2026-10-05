import { randomUUID } from "node:crypto";
import { QuoteResponse, TripOfferResponse } from "@tidegrid/contracts";
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
import {
  createPolicyVersion,
  createPriceListVersion,
  createPromotion,
  createPromotionVersion,
  createTaxRate,
  createTaxRateVersion,
} from "@tidegrid/domain-pricing";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createApp } from "../src/app.ts";

// Independent adversarial checks of the public pricing routes, run as the
// Hono app in Node against a throwaway branch as the runtime role. Every
// tenant, hostname, and code is synthetic and created here.

type Sql = ReturnType<typeof postgres>;
type Json = Record<string, unknown> & { error?: { code: string; message: string } };

const env = inject("integrationDb");
/** Requests run at this instant unless a test moves the clock. */
const NOW = new Date("2026-10-15T00:00:00Z");

describe.skipIf(!env)("adversarial pricing API checks as the runtime role", () => {
  let admin: Sql;
  let runtime: ReturnType<typeof createDb>;
  let app: ReturnType<typeof createApp>;
  let clock = NOW;
  const run = randomUUID().slice(0, 8);
  const tenant = (label: string) => ({
    id: randomUUID(),
    slug: `g25api-${label}-${run}`,
    host: `g25api-${label}-${run}.book.example.test`,
  });
  const A = tenant("a");
  const B = tenant("b");
  /** A suspended operator whose hostname is still active and verified. */
  const X = tenant("x");
  /** A's hostnames that must not resolve. */
  const pendingHost = `g25api-pending-${run}.book.example.test`;
  const disabledHost = `g25api-disabled-${run}.book.example.test`;
  const a = {
    cruise: "",
    other: "",
    boat: "",
    trips: new Map<string, string>(),
    tax: "",
    open10: "",
  };
  const b = { dive: "", trip: "" };

  const bindings = () => ({
    ENVIRONMENT: "local" as const,
    BUILD_ID: "integration",
    DATABASE_URL: env?.runtimeUrl ?? "",
  });
  const executionCtx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} };

  async function call(
    method: "GET" | "POST",
    path: string,
    opts: { origin?: string | null; body?: unknown; key?: string } = {},
  ) {
    const headers = new Headers();
    const origin = opts.origin === undefined ? `https://${A.host}` : opts.origin;
    if (origin !== null) headers.set("origin", origin);
    if (opts.body !== undefined) headers.set("content-type", "application/json");
    if (opts.key) headers.set("idempotency-key", opts.key);
    const res = await app.request(
      `http://localhost${path}`,
      { method, headers, body: opts.body === undefined ? null : JSON.stringify(opts.body) },
      bindings(),
      executionCtx,
    );
    const text = await res.text();
    return { res, json: (text ? JSON.parse(text) : {}) as Json };
  }

  const tripOn = (date: string) => {
    const id = a.trips.get(date);
    if (!id) throw new Error(`no fixture trip on ${date}`);
    return id;
  };
  const body = (tripId: string, extra: Record<string, unknown> = {}) => ({
    tripId,
    party: { kind: "tickets", tickets: [{ code: "adult", quantity: 2 }] },
    ...extra,
  });
  const post = (payload: unknown, opts: { origin?: string | null; key?: string } = {}) =>
    call("POST", "/v1/public/quotes", { body: payload, key: opts.key ?? randomUUID(), ...opts });
  const quoteOf = (r: { json: Json }) => QuoteResponse.parse(r.json).quote;
  const brief = (r: { res: Response; json: Json }) => ({
    status: r.res.status,
    code: r.json.error?.code,
    message: r.json.error?.message,
  });
  const quoteCount = async (tenantId: string) =>
    (
      await admin<Array<{ n: number }>>`
        select count(*)::int as n from public.quotes where tenant_id = ${tenantId}`
    )[0]?.n ?? 0;
  const keyRows = (key: string) =>
    admin<Array<{ tenant_id: string; status: string; response_status: number | null }>>`
      select tenant_id, status, response_status from public.idempotency_keys
       where scope = 'public.quotes.create' and key = ${key} order by tenant_id`;
  const withClock = async <T>(at: Date, fn: () => Promise<T>): Promise<T> => {
    clock = at;
    try {
      return await fn();
    } finally {
      clock = NOW;
    }
  };

  const season = {
    startsAt: new Date("2026-09-01T00:00:00Z"),
    endsAt: new Date("2027-06-01T00:00:00Z"),
  };
  const policy = {
    changeCutoffMinutes: 1440,
    beforeCutoff: { remedy: "full_refund" as const },
    afterCutoff: { remedy: "credit" as const },
    noShow: { remedy: "none" as const },
    text: {
      cancellation: "Full refund until a day before.",
      reschedule: "Move until a day before.",
      noShow: "No refund for a no-show.",
      operatorCancellation: "Refund or credit if we cancel.",
      weather: "The captain decides.",
    },
  };

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 2, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 2 });
    for (const t of [A, B, X]) {
      await admin`insert into public.tenants (id, slug, display_name, status)
        values (${t.id}, ${t.slug}, ${`G25 API ${t.slug}`},
                ${t === X ? "suspended" : "active"})`;
      await admin`insert into public.tenant_hostnames (hostname, tenant_id, kind, status, verified_at)
        values (${t.host}, ${t.id}, 'preview', 'active', now())`;
    }
    await admin`insert into public.tenant_hostnames (hostname, tenant_id, kind, status, verified_at)
      values (${pendingHost}, ${A.id}, 'custom', 'pending', null),
             (${disabledHost}, ${A.id}, 'custom', 'disabled', now())`;

    const ctxA: TenantContext = { tenantId: A.id, actorType: "system", actorId: "fixture" };
    await inTenantTransaction(runtime.db, ctxA, async (trx) => {
      const location = await createLocation(trx, ctxA, {
        name: "Pier A",
        timeZone: "America/New_York",
        reason: "fixture",
      });
      const boat = await createBoat(trx, ctxA, { name: "Tern", guestCapacity: 10, reason: "x" });
      a.boat = boat;
      a.cruise = await createProduct(trx, ctxA, {
        locationId: location,
        kind: "shared_seat",
        name: "Bay Cruise",
        durationMinutes: 90,
        bookingCutoffMinutes: 30,
        maxPartySize: 6,
        eligibleBoatIds: [boat],
        reason: "fixture",
      });
      a.other = await createProduct(trx, ctxA, {
        locationId: location,
        kind: "shared_seat",
        name: "Other Cruise",
        durationMinutes: 60,
        maxPartySize: 2,
        eligibleBoatIds: [],
        reason: "fixture",
      });
      const price = await createPriceListVersion(trx, ctxA, {
        productId: a.cruise,
        tickets: [
          { code: "adult", name: "Adult", unitAmount: 4000, taxable: true },
          { code: "child", name: "Child", unitAmount: 2000, taxable: true },
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
            name: "Photo",
            unitAmount: 1000,
            quantityRule: "per_booking",
            maxQuantity: 1,
            taxable: true,
          },
          {
            code: "early",
            name: "Early snack",
            unitAmount: 500,
            quantityRule: "per_booking",
            maxQuantity: 1,
            taxable: true,
            availableUntil: "2026-11-10",
          },
          {
            code: "late",
            name: "Late snack",
            unitAmount: 500,
            quantityRule: "per_booking",
            maxQuantity: 1,
            taxable: true,
            availableFrom: "2026-11-11",
          },
        ],
        reason: "fixture",
      });
      if (price.kind !== "created") throw new Error(JSON.stringify(price));
      const terms = await createPolicyVersion(trx, ctxA, {
        ...policy,
        productId: a.cruise,
        reason: "fixture",
      });
      if (terms.kind !== "created") throw new Error(JSON.stringify(terms));
      const tax = await createTaxRate(trx, ctxA, {
        name: "Sales tax",
        ratePpm: 70_000,
        inclusive: false,
        reason: "fixture",
      });
      if (tax.kind !== "created") throw new Error(JSON.stringify(tax));
      a.tax = tax.taxRateId;
      const promos: Array<Parameters<typeof createPromotion>[2]> = [
        {
          code: "OPEN10",
          discount: { kind: "percent", percentOffBp: 1000 },
          ...season,
          products: { all: true },
          reason: "x",
        },
        {
          code: "RETIRED",
          discount: { kind: "percent", percentOffBp: 1000 },
          ...season,
          products: { all: true },
          reason: "x",
        },
        {
          code: "LATER",
          discount: { kind: "percent", percentOffBp: 1000 },
          startsAt: new Date("2026-12-01T00:00:00Z"),
          endsAt: new Date("2027-06-01T00:00:00Z"),
          products: { all: true },
          reason: "x",
        },
        {
          code: "OLD",
          discount: { kind: "percent", percentOffBp: 1000 },
          startsAt: new Date("2026-08-01T00:00:00Z"),
          endsAt: new Date("2026-10-01T00:00:00Z"),
          products: { all: true },
          reason: "x",
        },
        {
          code: "OTHERONLY",
          discount: { kind: "percent", percentOffBp: 1000 },
          ...season,
          products: { productIds: [a.other] },
          reason: "x",
        },
        {
          code: "WINDOW",
          discount: { kind: "percent", percentOffBp: 1000 },
          startsAt: new Date("2026-10-15T00:00:00.000Z"),
          endsAt: new Date("2026-10-15T00:30:00.000Z"),
          products: { all: true },
          reason: "x",
        },
        {
          code: "TWIN",
          discount: { kind: "percent", percentOffBp: 1000 },
          ...season,
          products: { all: true },
          reason: "x",
        },
      ];
      for (const promo of promos) {
        const created = await createPromotion(trx, ctxA, promo);
        if (created.kind !== "created")
          throw new Error(`${promo.code}: ${JSON.stringify(created)}`);
        if (promo.code === "OPEN10") a.open10 = created.promotionId;
        if (promo.code === "RETIRED") {
          const retired = await createPromotionVersion(trx, ctxA, {
            promotionId: created.promotionId,
            discount: { kind: "percent", percentOffBp: 1000 },
            ...season,
            products: { all: true },
            active: false,
            reason: "retired",
          });
          if (retired.kind !== "created") throw new Error(JSON.stringify(retired));
        }
      }
      const published = await publishProduct(trx, ctxA, { productId: a.cruise, reason: "x" });
      if (published.kind !== "published") throw new Error(JSON.stringify(published));
      const schedule = await createSchedule(trx, ctxA, {
        productId: a.cruise,
        boatId: boat,
        startsOn: "2026-11-01",
        endsOn: "2027-03-31",
        weekdays: [1, 2, 3, 4, 5, 6, 7],
        startTimes: ["21:00"],
        reason: "fixture",
      });
      if (schedule.kind !== "created") throw new Error(JSON.stringify(schedule));
      const generated = await generateTrips(trx, ctxA, {
        scheduleId: schedule.id,
        fromDate: "2026-11-09",
        toDate: "2026-11-14",
        publish: true,
        reason: "fixture",
      });
      if (generated.kind !== "generated") throw new Error(JSON.stringify(generated));
      a.trips = new Map(generated.created.map((t) => [t.localDate, t.tripId]));
    });

    const ctxB: TenantContext = { tenantId: B.id, actorType: "system", actorId: "fixture" };
    await inTenantTransaction(runtime.db, ctxB, async (trx) => {
      const location = await createLocation(trx, ctxB, {
        name: "Reef B",
        timeZone: "Pacific/Honolulu",
        reason: "fixture",
      });
      const boat = await createBoat(trx, ctxB, { name: "Runner", guestCapacity: 12, reason: "x" });
      b.dive = await createProduct(trx, ctxB, {
        locationId: location,
        kind: "shared_seat",
        name: "Reef Dive",
        durationMinutes: 180,
        maxPartySize: 6,
        eligibleBoatIds: [boat],
        reason: "fixture",
      });
      await createPriceListVersion(trx, ctxB, {
        productId: b.dive,
        tickets: [{ code: "adult", name: "Diver", unitAmount: 15_000, taxable: true }],
        reason: "fixture",
      });
      await createPolicyVersion(trx, ctxB, { ...policy, productId: b.dive, reason: "fixture" });
      await createTaxRate(trx, ctxB, {
        name: "General excise",
        ratePpm: 47_120,
        inclusive: true,
        reason: "fixture",
      });
      for (const [code, amountOff] of [
        ["BONLY", 2500],
        ["TWIN", 500],
      ] as const) {
        const created = await createPromotion(trx, ctxB, {
          code,
          discount: { kind: "fixed_amount", amountOff },
          ...season,
          products: { all: true },
          reason: "fixture",
        });
        if (created.kind !== "created") throw new Error(JSON.stringify(created));
      }
      const published = await publishProduct(trx, ctxB, { productId: b.dive, reason: "x" });
      if (published.kind !== "published") throw new Error(JSON.stringify(published));
      const schedule = await createSchedule(trx, ctxB, {
        productId: b.dive,
        boatId: boat,
        startsOn: "2026-11-01",
        endsOn: "2027-03-31",
        weekdays: [1, 2, 3, 4, 5, 6, 7],
        startTimes: ["09:00"],
        reason: "fixture",
      });
      if (schedule.kind !== "created") throw new Error(JSON.stringify(schedule));
      const generated = await generateTrips(trx, ctxB, {
        scheduleId: schedule.id,
        fromDate: "2026-11-10",
        toDate: "2026-11-10",
        publish: true,
        reason: "fixture",
      });
      if (generated.kind !== "generated") throw new Error(JSON.stringify(generated));
      b.trip = generated.created[0]?.tripId ?? "";
    });
    app = createApp({ now: () => clock });
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end({ timeout: 5 });
  });

  // Origins and tenants ----------------------------------------------------------------

  describe("origins and tenants", () => {
    it("answers every pricing route the same 404 for a missing, opaque, unknown, unverified, disabled, or suspended origin, and writes nothing", async () => {
      const created = await post(body(tripOn("2026-11-10")));
      expect(created.res.status).toBe(201);
      const quoteId = quoteOf(created).quoteId;
      const quotesBefore = await quoteCount(A.id);
      const origins: Array<string | null> = [
        null,
        "null",
        `https://nobody-${run}.book.example.test`,
        `https://${pendingHost}`,
        `https://${disabledHost}`,
        `https://${X.host}`,
        `https://${A.host}.evil.example.test`,
      ];
      const keys: string[] = [];
      const answers = [];
      for (const origin of origins) {
        const key = randomUUID();
        keys.push(key);
        for (const r of [
          await call("GET", `/v1/public/trips/${tripOn("2026-11-10")}/offer`, { origin }),
          await post(body(tripOn("2026-11-10")), { origin, key }),
          await call("GET", `/v1/public/quotes/${quoteId}`, { origin }),
        ]) {
          answers.push({ origin, ...brief(r) });
        }
      }
      const expected = {
        status: 404,
        code: "tenant_not_found",
        message: "No operator is published at this address",
      };
      expect(answers).toEqual(answers.map(({ origin }) => ({ origin, ...expected })));
      expect(await quoteCount(A.id)).toBe(quotesBefore);
      for (const key of keys) expect(await keyRows(key)).toEqual([]);
    });

    it("never resolves another tenant's trip or quote, and answers exactly as for an unknown id", async () => {
      const bQuote = await post(body(b.trip), { origin: `https://${B.host}` });
      expect(bQuote.res.status).toBe(201);
      const bQuoteId = quoteOf(bQuote).quoteId;
      const aBefore = await quoteCount(A.id);
      const bBefore = await quoteCount(B.id);
      const unknown = randomUUID();
      const offers = [
        brief(await call("GET", `/v1/public/trips/${b.trip}/offer`)),
        brief(await call("GET", `/v1/public/trips/${unknown}/offer`)),
      ];
      const quotes = [brief(await post(body(b.trip))), brief(await post(body(unknown)))];
      const reads = [
        brief(await call("GET", `/v1/public/quotes/${bQuoteId}`)),
        brief(await call("GET", `/v1/public/quotes/${unknown}`)),
        brief(await call("GET", `/v1/public/quotes/${bQuoteId.toUpperCase()}`)),
        brief(await call("GET", "/v1/public/quotes/not-a-uuid")),
      ];
      const tripMissing = {
        status: 404,
        code: "trip_not_found",
        message: "No such trip at this address",
      };
      const quoteMissing = {
        status: 404,
        code: "quote_not_found",
        message: "No such quote at this address",
      };
      expect({ offers, quotes, reads }).toEqual({
        offers: [tripMissing, tripMissing],
        quotes: [tripMissing, tripMissing],
        reads: [quoteMissing, quoteMissing, quoteMissing, quoteMissing],
      });
      expect([await quoteCount(A.id), await quoteCount(B.id)]).toEqual([aBefore, bBefore]);
      // And B's site cannot read A's quotes either.
      const aQuote = await post(body(tripOn("2026-11-11")));
      const fromB = await call("GET", `/v1/public/quotes/${quoteOf(aQuote).quoteId}`, {
        origin: `https://${B.host}`,
      });
      expect(brief(fromB)).toEqual(quoteMissing);
    });

    it("keeps one promotion code's terms to the tenant whose site asks", async () => {
      const inA = await post(body(tripOn("2026-11-11"), { promotionCode: "twin" }));
      const inB = await post(body(b.trip, { promotionCode: "twin" }), {
        origin: `https://${B.host}`,
      });
      expect([quoteOf(inA).promotion, quoteOf(inB).promotion]).toEqual([
        { code: "TWIN", version: 1, discountKind: "percent", amountOff: null, percentOffBp: 1000 },
        {
          code: "TWIN",
          version: 1,
          discountKind: "fixed_amount",
          amountOff: 500,
          percentOffBp: null,
        },
      ]);
      expect([quoteOf(inA).totals.discount, quoteOf(inB).totals.discount]).toEqual([800, 500]);
    });
  });

  // Idempotency -------------------------------------------------------------------------

  describe("idempotency", () => {
    it("leaves the key unused after a refused request, so a corrected retry with the same key succeeds once", async () => {
      const key = randomUUID();
      const tripId = tripOn("2026-11-12");
      const before = await quoteCount(A.id);
      const wrong = body(tripId, {
        party: { kind: "tickets", tickets: [{ code: "senior", quantity: 2 }] },
      });
      const refused = await post(wrong, { key });
      expect(brief(refused)).toMatchObject({ status: 422, code: "unknown_ticket_type" });
      expect(await keyRows(key)).toEqual([]);
      const right = body(tripId);
      const first = await post(right, { key });
      expect(first.res.status).toBe(201);
      expect(first.res.headers.get("idempotent-replayed")).toBeNull();
      const again = await post(right, { key });
      expect(again.res.status).toBe(201);
      expect(again.res.headers.get("idempotent-replayed")).toBe("true");
      expect(again.json).toEqual(first.json);
      const reused = await post(wrong, { key });
      expect(brief(reused)).toMatchObject({ status: 422, code: "idempotency_key_reused" });
      expect(await keyRows(key)).toEqual([
        { tenant_id: A.id, status: "completed", response_status: 201 },
      ]);
      expect(await quoteCount(A.id)).toBe(before + 1);
    });

    it("leaves the key unused while the trip is not on sale, and quotes once it reopens", async () => {
      const key = randomUUID();
      const tripId = tripOn("2026-11-13");
      await admin`update public.scheduled_trips set sales_state = 'closed' where id = ${tripId}`;
      let closed: Awaited<ReturnType<typeof post>>;
      try {
        closed = await post(body(tripId), { key });
      } finally {
        await admin`update public.scheduled_trips set sales_state = 'published' where id = ${tripId}`;
      }
      expect(brief(closed)).toMatchObject({ status: 409, code: "trip_not_bookable" });
      expect(await keyRows(key)).toEqual([]);
      const reopened = await post(body(tripId), { key });
      expect(reopened.res.status).toBe(201);
      expect(reopened.res.headers.get("idempotent-replayed")).toBeNull();
    });

    it("replays the first response after the trip closes, with the original quote", async () => {
      const key = randomUUID();
      const tripId = tripOn("2026-11-14");
      const first = await post(body(tripId), { key });
      expect(first.res.status).toBe(201);
      await admin`update public.scheduled_trips set sales_state = 'closed' where id = ${tripId}`;
      try {
        const replay = await post(body(tripId), { key });
        expect(replay.res.status).toBe(201);
        expect(replay.res.headers.get("idempotent-replayed")).toBe("true");
        expect(replay.json).toEqual(first.json);
        const fresh = await post(body(tripId));
        expect(brief(fresh)).toMatchObject({ status: 409, code: "trip_not_bookable" });
      } finally {
        await admin`update public.scheduled_trips set sales_state = 'published' where id = ${tripId}`;
      }
    });

    it("replays a retry that differs only in key order, spaces around the code, or an explicit empty add-on list", async () => {
      const key = randomUUID();
      const tripId = tripOn("2026-11-12");
      const first = await post(
        {
          tripId,
          party: { kind: "tickets", tickets: [{ code: "adult", quantity: 1 }] },
          promotionCode: "OPEN10",
        },
        { key },
      );
      expect(first.res.status).toBe(201);
      const retry = await post(
        {
          promotionCode: "  OPEN10 ",
          addOns: [],
          party: { tickets: [{ quantity: 1, code: "adult" }], kind: "tickets" },
          tripId,
        },
        { key },
      );
      expect(retry.res.status).toBe(201);
      expect(retry.res.headers.get("idempotent-replayed")).toBe("true");
      expect(quoteOf(retry).quoteId).toBe(quoteOf(first).quoteId);
    });

    it("creates exactly one quote when one key races with two different bodies", async () => {
      const key = randomUUID();
      const tripId = tripOn("2026-11-11");
      const before = await quoteCount(A.id);
      const one = body(tripId, {
        party: { kind: "tickets", tickets: [{ code: "adult", quantity: 1 }] },
      });
      const two = body(tripId, {
        party: { kind: "tickets", tickets: [{ code: "adult", quantity: 2 }] },
      });
      const sent = [one, two, one, two, one, two];
      const results = await Promise.all(sent.map((payload) => post(payload, { key })));
      const winners = results.filter((r) => r.res.status === 201);
      const losers = results.filter((r) => r.res.status !== 201);
      expect(winners).toHaveLength(3);
      expect(new Set(winners.map((r) => quoteOf(r).quoteId)).size).toBe(1);
      expect(new Set(winners.map((r) => quoteOf(r).partySize)).size).toBe(1);
      expect(
        winners.filter((r) => r.res.headers.get("idempotent-replayed") === "true"),
      ).toHaveLength(2);
      expect(losers.map(brief).map(({ status, code }) => ({ status, code }))).toEqual([
        { status: 422, code: "idempotency_key_reused" },
        { status: 422, code: "idempotency_key_reused" },
        { status: 422, code: "idempotency_key_reused" },
      ]);
      expect(await quoteCount(A.id)).toBe(before + 1);
      expect(await keyRows(key)).toEqual([
        { tenant_id: A.id, status: "completed", response_status: 201 },
      ]);
    });

    it("keeps one key in two tenants independent when both requests race", async () => {
      const key = randomUUID();
      const [inA, inB] = await Promise.all([
        post(body(tripOn("2026-11-10")), { key }),
        post(body(b.trip), { key, origin: `https://${B.host}` }),
      ]);
      expect([inA.res.status, inB.res.status]).toEqual([201, 201]);
      expect([
        inA.res.headers.get("idempotent-replayed"),
        inB.res.headers.get("idempotent-replayed"),
      ]).toEqual([null, null]);
      expect(quoteOf(inA).quoteId).not.toBe(quoteOf(inB).quoteId);
      expect(quoteOf(inB).product.id).toBe(b.dive);
      expect((await keyRows(key)).map((r) => r.tenant_id).sort()).toEqual([A.id, B.id].sort());
    });
  });

  // Eligibility and responses -------------------------------------------------------------

  describe("eligibility and responses", () => {
    it("answers every promotion problem with one indistinguishable response and writes nothing", async () => {
      const before = await quoteCount(A.id);
      const promos = ["NOSUCH", "RETIRED", "LATER", "OLD", "OTHERONLY", "BONLY"];
      const answers = [];
      for (const promo of promos) {
        const key = randomUUID();
        const r = await post(body(tripOn("2026-11-12"), { promotionCode: promo }), { key });
        answers.push({ promo, ...brief(r), keyRows: (await keyRows(key)).length });
      }
      // Unknown, retired, not yet valid, expired, another product's, and another
      // tenant's codes must look the same, or the reason could be probed.
      expect(answers).toEqual(
        promos.map((promo) => ({
          promo,
          status: 422,
          code: "promotion_not_applicable",
          message: "This quote cannot be priced: promotion_not_applicable",
          keyRows: 0,
        })),
      );
      expect(await quoteCount(A.id)).toBe(before);
    });

    it("applies a promotion from the first instant of its window and refuses it from its end", async () => {
      const tripId = tripOn("2026-11-12");
      const start = await withClock(new Date("2026-10-15T00:00:00.000Z"), () =>
        post(body(tripId, { promotionCode: "window" })),
      );
      expect(start.res.status).toBe(201);
      expect(quoteOf(start)).toMatchObject({
        quotedAt: "2026-10-15T00:00:00.000Z",
        expiresAt: "2026-10-15T00:30:00.000Z",
        totals: { discount: 800 },
      });
      const end = await withClock(new Date("2026-10-15T00:30:00.000Z"), () =>
        post(body(tripId, { promotionCode: "window" })),
      );
      expect(brief(end)).toMatchObject({ status: 422, code: "promotion_not_applicable" });
    });

    it("offers and accepts a dated add-on by the trip's local date, not its UTC date", async () => {
      // 21:00 in New York on 2026-11-10 is 02:00 UTC on 2026-11-11.
      const tripId = tripOn("2026-11-10");
      const offer = await call("GET", `/v1/public/trips/${tripId}/offer`);
      const parsed = TripOfferResponse.parse(offer.json).offer;
      expect(parsed.trip).toMatchObject({
        localDate: "2026-11-10",
        startsAt: "2026-11-11T02:00:00.000Z",
      });
      expect(parsed.addOns.map((x) => x.code)).toEqual(["photo", "early"]);
      const late = await post(body(tripId, { addOns: [{ code: "late", quantity: 1 }] }));
      expect(brief(late)).toEqual({
        status: 422,
        code: "add_on_unavailable",
        message: "This quote cannot be priced: add_on_unavailable (late)",
      });
      const early = await post(body(tripId, { addOns: [{ code: "early", quantity: 1 }] }));
      expect(early.res.status).toBe(201);
    });

    it("answers 409 insufficient_capacity when the party fits the product but not the trip", async () => {
      const tripId = tripOn("2026-11-13");
      const [original] = await admin<Array<{ seat_capacity: number }>>`
        select seat_capacity from public.scheduled_trips where id = ${tripId}`;
      // Stands in for seats G2.6 holds will take; the trip stays on sale.
      await admin`update public.scheduled_trips set seat_capacity = 2 where id = ${tripId}`;
      try {
        const over = await post(
          body(tripId, { party: { kind: "tickets", tickets: [{ code: "adult", quantity: 3 }] } }),
        );
        expect(brief(over)).toEqual({
          status: 409,
          code: "insufficient_capacity",
          message: "This quote cannot be priced: insufficient_capacity",
        });
        const both = await post(
          body(tripId, { party: { kind: "tickets", tickets: [{ code: "adult", quantity: 7 }] } }),
        );
        expect(brief(both)).toEqual({
          status: 422,
          code: "party_size_out_of_range",
          message: "This quote cannot be priced: party_size_out_of_range, insufficient_capacity",
        });
        expect((await post(body(tripId))).res.status).toBe(201);
      } finally {
        await admin`update public.scheduled_trips set seat_capacity = ${original?.seat_capacity ?? 10}
          where id = ${tripId}`;
      }
    });

    it("records the guest actor and the server's request id on the stored quote, and no audit or outbox event", async () => {
      const events = async () =>
        (
          await admin<Array<{ audit: number; outbox: number }>>`
            select (select count(*)::int from public.audit_events where tenant_id = ${A.id}) as audit,
                   (select count(*)::int from public.outbox_events where tenant_id = ${A.id}) as outbox`
        )[0];
      const before = await events();
      const created = await post(body(tripOn("2026-11-10")));
      expect(created.res.status).toBe(201);
      expect(await events()).toEqual(before);
      const requestId = created.res.headers.get("x-request-id");
      expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
      const [row] = await admin<
        Array<{ actor_type: string; actor_id: string | null; request_id: string }>
      >`
        select actor_type, actor_id, request_id from public.quotes where id = ${quoteOf(created).quoteId}`;
      expect(row).toEqual({ actor_type: "guest", actor_id: null, request_id: requestId });
    });

    it("keeps money in integer cents and every total equal to its lines in the stored response", async () => {
      const inclusive = await post(
        body(b.trip, {
          party: { kind: "tickets", tickets: [{ code: "adult", quantity: 1 }] },
          promotionCode: "BONLY",
        }),
        { origin: `https://${B.host}` },
      );
      const exclusive = await post(
        body(tripOn("2026-11-11"), {
          party: {
            kind: "tickets",
            tickets: [
              { code: "child", quantity: 1 },
              { code: "adult", quantity: 2 },
            ],
          },
          addOns: [
            { code: "photo", quantity: 1 },
            { code: "late", quantity: 1 },
          ],
          promotionCode: "open10",
        }),
      );
      for (const r of [inclusive, exclusive]) {
        expect(r.res.status).toBe(201);
        const q = quoteOf(r);
        const sum = (values: number[]) => values.reduce((acc, x) => acc + x, 0);
        const money = [
          ...Object.values(q.totals),
          ...q.lines.flatMap((l) => [
            l.unitAmount,
            l.amount,
            l.discountAmount,
            ...l.taxes.map((t) => t.amount),
          ]),
        ];
        expect(money.every(Number.isSafeInteger)).toBe(true);
        const allTaxes = q.lines.flatMap((l) => l.taxes);
        expect(q.totals).toEqual({
          subtotal: sum(
            q.lines.filter((l) => ["ticket", "add_on"].includes(l.kind)).map((l) => l.amount),
          ),
          discount: -sum(q.lines.filter((l) => l.kind === "discount").map((l) => l.amount)),
          fees: sum(q.lines.filter((l) => l.kind === "fee").map((l) => l.amount)),
          tax: sum(allTaxes.filter((t) => !t.inclusive).map((t) => t.amount)),
          includedTax: sum(allTaxes.filter((t) => t.inclusive).map((t) => t.amount)),
          total: q.totals.subtotal - q.totals.discount + q.totals.fees + q.totals.tax,
          amountDueNow: q.totals.total,
        });
        expect(sum(q.lines.map((l) => l.discountAmount))).toBe(q.totals.discount);
      }
      // B: 15000 less 2500 = 12500 inside the price; 12500 / 1.04712 = 11937.505 -> 11938,
      // so 562 is included.
      expect(quoteOf(inclusive).totals).toMatchObject({ total: 12_500, includedTax: 562, tax: 0 });
      // A: adult 2 x 4000 and child 2000, 10% off = 1000 split 800 / 200, 7% on 7200, 1800,
      // the photo 1000 and the late snack 500, harbor fee 3 x 300 untaxed.
      expect(quoteOf(exclusive).totals).toMatchObject({
        subtotal: 11_500,
        discount: 1000,
        fees: 900,
        tax: 504 + 126 + 70 + 35,
        total: 11_500 - 1000 + 900 + 735,
      });
    });

    it("applies a code pasted with non-breaking or ideographic spaces around it, in any case", async () => {
      const created = await post(body(tripOn("2026-11-12"), { promotionCode: " oPeN10　" }));
      expect(created.res.status).toBe(201);
      expect(quoteOf(created).promotion?.code).toBe("OPEN10");
      expect(quoteOf(created).totals.discount).toBe(800);
    });

    it("quotes an on-sale trip whose start time carries seconds, and a failed write leaves nothing behind", async () => {
      // The database accepts this departure (time(0) keeps seconds, and 0003's
      // trigger checks it against its instant) and the availability query lists
      // it, so by the contract it is on sale and can be quoted.
      const [inserted] = await admin<Array<{ id: string }>>`
        insert into public.scheduled_trips
          (tenant_id, product_id, boat_id, time_zone, local_date, local_start_time, starts_at,
           ends_at, boat_free_at, start_utc_offset_minutes, end_utc_offset_minutes,
           duration_minutes, seat_capacity, sales_state)
        values (${A.id}, ${a.cruise}, ${a.boat}, 'America/New_York', '2026-11-15', '21:00:30',
                '2026-11-16T02:00:30Z', '2026-11-16T03:30:30Z', '2026-11-16T03:30:30Z', -300, -300,
                90, 10, 'published')
        returning id`;
      const tripId = inserted?.id ?? "";
      const listed = await call("GET", "/v1/public/trips?from=2026-11-15&to=2026-11-15&party=1");
      expect((listed.json.trips as Array<{ tripId: string }>).map((t) => t.tripId)).toContain(
        tripId,
      );
      const key = randomUUID();
      const before = await quoteCount(A.id);
      const first = await post(body(tripId), { key });
      if (first.res.status !== 201) {
        // Whatever went wrong, the claim and every row must have rolled back.
        expect(await keyRows(key)).toEqual([]);
        expect(await quoteCount(A.id)).toBe(before);
      }
      expect(brief(first)).toEqual({ status: 201, code: undefined, message: undefined });
      expect(quoteOf(first).trip.startsAt).toBe("2026-11-16T02:00:30.000Z");
    });

    it("serves a stored quote with no-store and Vary: Origin", async () => {
      const created = await post(body(tripOn("2026-11-10")));
      const read = await call("GET", `/v1/public/quotes/${quoteOf(created).quoteId}`);
      expect(read.res.status).toBe(200);
      expect(read.res.headers.get("cache-control")).toBe("no-store");
      expect(read.res.headers.get("vary")).toContain("Origin");
    });

    it("marks error responses no-store and Vary: Origin too, as the contract says of every response", async () => {
      const answers = [
        await call("GET", `/v1/public/trips/${randomUUID()}/offer`),
        await call("GET", `/v1/public/quotes/${randomUUID()}`),
        await call("GET", `/v1/public/quotes/${randomUUID()}`, {
          origin: "https://nobody.example.test",
        }),
        await post(body(tripOn("2026-11-12"), { promotionCode: "NOSUCH" })),
      ];
      expect(
        answers.map((r) => ({
          status: r.res.status,
          cacheControl: r.res.headers.get("cache-control"),
          varyOrigin: (r.res.headers.get("vary") ?? "").includes("Origin"),
        })),
      ).toEqual([
        { status: 404, cacheControl: "no-store", varyOrigin: true },
        { status: 404, cacheControl: "no-store", varyOrigin: true },
        { status: 404, cacheControl: "no-store", varyOrigin: true },
        { status: 422, cacheControl: "no-store", varyOrigin: true },
      ]);
    });
  });

  // Snapshots (last: changes A's terms) ----------------------------------------------------

  describe("snapshots", () => {
    it("serves an old quote unchanged after its tax is renamed, its code retired, and its trip closed, while new quotes name the new versions", async () => {
      const tripId = tripOn("2026-11-09");
      const created = await post(body(tripId, { promotionCode: "OPEN10" }));
      expect(created.res.status).toBe(201);
      const original = quoteOf(created);
      expect(original.taxes.map((t) => [t.name, t.version, t.ratePpm])).toEqual([
        ["Sales tax", 1, 70_000],
      ]);
      const ctxA: TenantContext = { tenantId: A.id, actorType: "staff", actorId: "g25-api" };
      await inTenantTransaction(runtime.db, ctxA, async (trx) => {
        const renamed = await createTaxRateVersion(trx, ctxA, {
          taxRateId: a.tax,
          name: "State tax",
          ratePpm: 80_000,
          inclusive: false,
          active: true,
          reason: "renamed and raised",
        });
        const retired = await createPromotionVersion(trx, ctxA, {
          promotionId: a.open10,
          discount: { kind: "percent", percentOffBp: 1000 },
          ...season,
          products: { all: true },
          active: false,
          reason: "ended early",
        });
        expect([renamed.kind, retired.kind]).toEqual(["created", "created"]);
      });
      await admin`update public.scheduled_trips set sales_state = 'closed' where id = ${tripId}`;
      const read = await call("GET", `/v1/public/quotes/${original.quoteId}`);
      expect(read.res.status).toBe(200);
      expect(read.json).toEqual(created.json);
      expect(
        brief(await post(body(tripOn("2026-11-12"), { promotionCode: "OPEN10" }))),
      ).toMatchObject({
        status: 422,
        code: "promotion_not_applicable",
      });
      const fresh = await post(body(tripOn("2026-11-12")));
      expect(fresh.res.status).toBe(201);
      expect(quoteOf(fresh).taxes.map((t) => [t.name, t.version, t.ratePpm])).toEqual([
        ["State tax", 2, 80_000],
      ]);
      expect(brief(await post(body(tripId)))).toMatchObject({
        status: 409,
        code: "trip_not_bookable",
      });
    });
  });
});
