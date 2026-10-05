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
  createTaxRate,
} from "@tidegrid/domain-pricing";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createApp } from "../src/app.ts";

type Sql = ReturnType<typeof postgres>;
type Json = Record<string, unknown> & { error?: { code: string; message: string } };

const env = inject("integrationDb");
/** Every request runs at this instant, before the fixture trips. */
const NOW = new Date("2026-10-15T00:00:00Z");

describe.skipIf(!env)("pricing API against a real database as the runtime role", () => {
  let admin: Sql;
  let runtime: ReturnType<typeof createDb>;
  let app: ReturnType<typeof createApp>;
  const run = randomUUID().slice(0, 8);
  const tenant = (label: string) => ({
    id: randomUUID(),
    slug: `priceapi-${label}-${run}`,
    host: `priceapi-${label}-${run}.book.example.test`,
  });
  const A = tenant("a");
  const B = tenant("b");
  const trips = { a: [] as string[], b: "" };
  let productA = "";

  const bindings = () => ({
    ENVIRONMENT: "local" as const,
    BUILD_ID: "integration",
    DATABASE_URL: env?.runtimeUrl ?? "",
  });
  const executionCtx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} };

  async function call(
    method: string,
    path: string,
    opts: { host?: string | null; body?: unknown; key?: string | null } = {},
  ) {
    const headers = new Headers();
    if (opts.host !== null) headers.set("origin", `https://${opts.host ?? A.host}`);
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

  const quoteBody = (tripId: string, extra: Record<string, unknown> = {}) => ({
    tripId,
    party: { kind: "tickets", tickets: [{ code: "adult", quantity: 2 }] },
    addOns: [{ code: "photo", quantity: 1 }],
    ...extra,
  });
  const quoteCount = async (tenantId: string) =>
    (
      await admin<{ n: number }[]>`
      select count(*)::int as n from public.quotes where tenant_id = ${tenantId}`
    )[0]?.n ?? 0;

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 2, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 2 });
    for (const t of [A, B]) {
      await admin`insert into public.tenants (id, slug, display_name)
        values (${t.id}, ${t.slug}, ${`Pricing API ${t.slug}`})`;
      await admin`insert into public.tenant_hostnames (hostname, tenant_id, kind, status, verified_at)
        values (${t.host}, ${t.id}, 'preview', 'active', now())`;
      const ctx: TenantContext = { tenantId: t.id, actorType: "system", actorId: "fixture" };
      await inTenantTransaction(runtime.db, ctx, async (trx) => {
        const locationId = await createLocation(trx, ctx, {
          name: `Dock ${t.slug}`,
          timeZone: "America/New_York",
          reason: "fixture",
        });
        const boatId = await createBoat(trx, ctx, {
          name: "Boat",
          guestCapacity: 10,
          reason: "fixture",
        });
        const productId = await createProduct(trx, ctx, {
          locationId,
          kind: "shared_seat",
          name: `Harbor Tour ${t.slug}`,
          durationMinutes: 60,
          bookingCutoffMinutes: 30,
          maxPartySize: 6,
          eligibleBoatIds: [boatId],
          reason: "fixture",
        });
        const price = await createPriceListVersion(trx, ctx, {
          productId,
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
              name: "Souvenir photo",
              unitAmount: 1000,
              quantityRule: "per_booking",
              maxQuantity: 1,
              taxable: true,
            },
          ],
          reason: "fixture",
        });
        if (price.kind !== "created") throw new Error(JSON.stringify(price));
        const policy = await createPolicyVersion(trx, ctx, {
          productId,
          changeCutoffMinutes: 1440,
          beforeCutoff: { remedy: "full_refund" },
          afterCutoff: { remedy: "credit" },
          noShow: { remedy: "none" },
          text: {
            cancellation: "Full refund until a day before.",
            reschedule: "Move until a day before.",
            noShow: "No refund for a no-show.",
            operatorCancellation: "Refund or credit if we cancel.",
            weather: "The captain decides.",
          },
          reason: "fixture",
        });
        if (policy.kind !== "created") throw new Error(JSON.stringify(policy));
        await createTaxRate(trx, ctx, {
          name: "Sales tax",
          ratePpm: 70_000,
          inclusive: false,
          reason: "fixture",
        });
        await createPromotion(trx, ctx, {
          code: `SAVE${t === A ? "A" : "B"}`,
          discount: { kind: "fixed_amount", amountOff: 1000 },
          startsAt: new Date("2026-09-01T00:00:00Z"),
          endsAt: new Date("2027-06-01T00:00:00Z"),
          products: { all: true },
          reason: "fixture",
        });
        expect((await publishProduct(trx, ctx, { productId, reason: "fixture" })).kind).toBe(
          "published",
        );
        const schedule = await createSchedule(trx, ctx, {
          productId,
          boatId,
          startsOn: "2026-11-01",
          endsOn: "2027-03-31",
          weekdays: [1, 2, 3, 4, 5, 6, 7],
          startTimes: ["09:00"],
          reason: "fixture",
        });
        if (schedule.kind !== "created") throw new Error(JSON.stringify(schedule));
        const generated = await generateTrips(trx, ctx, {
          scheduleId: schedule.id,
          fromDate: "2026-11-10",
          toDate: "2026-11-12",
          publish: true,
          reason: "fixture",
        });
        if (generated.kind !== "generated") throw new Error(JSON.stringify(generated));
        if (t === A) {
          productA = productId;
          trips.a = generated.created.map((x) => x.tripId);
        } else {
          trips.b = generated.created[0]?.tripId ?? "";
        }
      });
    }
    app = createApp({ now: () => NOW });
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end();
  });

  describe("offer", () => {
    it("lists the calling site's prices, add-ons, fees, taxes, and policy, uncached", async () => {
      const { res, json } = await call("GET", `/v1/public/trips/${trips.a[0]}/offer`);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("vary")).toContain("Origin");
      const { offer } = TripOfferResponse.parse(json);
      expect(offer).toMatchObject({
        tripId: trips.a[0],
        currency: "USD",
        priceListVersion: 1,
        tickets: [
          { code: "adult", unitAmount: 4000 },
          { code: "child", unitAmount: 2000 },
        ],
        charter: null,
        addOns: [{ code: "photo", quantityRule: "per_booking", maxQuantity: 1 }],
        fees: [{ code: "harbor", basis: "per_participant", unitAmount: 300 }],
        taxes: [{ name: "Sales tax", ratePpm: 70_000, inclusive: false }],
        policy: { version: 1, changeCutoffAt: "2026-11-09T14:00:00.000Z" },
      });
    });

    it("answers 404 for another tenant's trip, a malformed id, and an unknown origin", async () => {
      for (const [path, host, code] of [
        [`/v1/public/trips/${trips.b}/offer`, A.host, "trip_not_found"],
        ["/v1/public/trips/not-a-uuid/offer", A.host, "trip_not_found"],
        [`/v1/public/trips/${trips.a[0]}/offer`, "nobody.book.example.test", "tenant_not_found"],
      ] as const) {
        const r = await call("GET", path, { host });
        expect({ path, status: r.res.status, code: r.json.error?.code }).toEqual({
          path,
          status: 404,
          code,
        });
      }
    });
  });

  describe("quotes", () => {
    it("creates a quote that reads back identically, and only through its own tenant", async () => {
      const created = await call("POST", "/v1/public/quotes", {
        key: randomUUID(),
        body: quoteBody(trips.a[0] ?? "", { promotionCode: "savea" }),
      });
      expect(created.res.status).toBe(201);
      expect(created.res.headers.get("cache-control")).toBe("no-store");
      const { quote } = QuoteResponse.parse(created.json);
      // 2 adults 8000 (less 1000) and the photo 1000, 7% tax on 7000 and 1000; harbor 2 x 300.
      expect(quote.totals).toEqual({
        subtotal: 9000,
        discount: 1000,
        fees: 600,
        tax: 560,
        includedTax: 0,
        total: 9160,
        amountDueNow: 9160,
      });
      expect(quote.promotion?.code).toBe("SAVEA");
      const read = await call("GET", `/v1/public/quotes/${quote.quoteId}`);
      expect(read.res.status).toBe(200);
      expect(read.json).toEqual(created.json);
      const foreign = await call("GET", `/v1/public/quotes/${quote.quoteId}`, { host: B.host });
      expect(foreign.res.status).toBe(404);
      expect(foreign.json.error?.code).toBe("quote_not_found");
      const malformed = await call("GET", "/v1/public/quotes/not-a-uuid");
      expect(malformed.json.error?.code).toBe("quote_not_found");
    });

    it("replays a retried request once and refuses the key for another request", async () => {
      const key = randomUUID();
      const body = quoteBody(trips.a[1] ?? "");
      const before = await quoteCount(A.id);
      const first = await call("POST", "/v1/public/quotes", { key, body });
      const again = await call("POST", "/v1/public/quotes", { key, body });
      expect(first.res.status).toBe(201);
      expect(again.res.status).toBe(201);
      expect(again.res.headers.get("idempotent-replayed")).toBe("true");
      expect(again.json).toEqual(first.json);
      expect(await quoteCount(A.id)).toBe(before + 1);
      const other = await call("POST", "/v1/public/quotes", {
        key,
        body: quoteBody(trips.a[2] ?? ""),
      });
      expect(other.res.status).toBe(422);
      expect(other.json.error?.code).toBe("idempotency_key_reused");
      // The same key in another tenant is a different key.
      const elsewhere = await call("POST", "/v1/public/quotes", {
        host: B.host,
        key,
        body: quoteBody(trips.b),
      });
      expect(elsewhere.res.status).toBe(201);
      expect(await quoteCount(A.id)).toBe(before + 1);
    });

    it("creates one quote when duplicates race on one key", async () => {
      const key = randomUUID();
      const body = quoteBody(trips.a[2] ?? "");
      const before = await quoteCount(A.id);
      const results = await Promise.all(
        Array.from({ length: 4 }, () => call("POST", "/v1/public/quotes", { key, body })),
      );
      expect(results.map((r) => r.res.status)).toEqual([201, 201, 201, 201]);
      const ids = new Set(results.map((r) => (r.json.quote as { quoteId: string }).quoteId));
      expect(ids.size).toBe(1);
      expect(
        results.filter((r) => r.res.headers.get("idempotent-replayed") === "true"),
      ).toHaveLength(3);
      expect(await quoteCount(A.id)).toBe(before + 1);
    });

    it("names the problem with the first error code and lists every problem", async () => {
      const cases: Array<[string, unknown, number, string]> = [
        [
          "unknown ticket and add-on",
          {
            tripId: trips.a[0],
            party: { kind: "tickets", tickets: [{ code: "senior", quantity: 1 }] },
            addOns: [{ code: "kayak", quantity: 1 }],
          },
          422,
          "unknown_ticket_type",
        ],
        [
          "party over the product limit",
          {
            tripId: trips.a[0],
            party: { kind: "tickets", tickets: [{ code: "adult", quantity: 7 }] },
          },
          422,
          "party_size_out_of_range",
        ],
        [
          "wrong party kind",
          { tripId: trips.a[0], party: { kind: "charter", guests: 2 } },
          422,
          "party_kind_mismatch",
        ],
        [
          "another tenant's code",
          quoteBody(trips.a[0] ?? "", { promotionCode: "SAVEB" }),
          422,
          "promotion_not_applicable",
        ],
        ["another tenant's trip", quoteBody(trips.b), 404, "trip_not_found"],
      ];
      for (const [label, body, status, code] of cases) {
        const r = await call("POST", "/v1/public/quotes", { key: randomUUID(), body });
        expect({ label, status: r.res.status, code: r.json.error?.code }).toEqual({
          label,
          status,
          code,
        });
      }
      const both = await call("POST", "/v1/public/quotes", {
        key: randomUUID(),
        body: cases[0]?.[1],
      });
      expect(both.json.error?.message).toContain("unknown_ticket_type (senior)");
      expect(both.json.error?.message).toContain("unknown_add_on (kayak)");
    });

    it("validates the request against the contract before touching the database", async () => {
      const noKey = await call("POST", "/v1/public/quotes", {
        key: null,
        body: quoteBody(trips.a[0] ?? ""),
      });
      expect(noKey.res.status).toBe(400);
      expect(noKey.json.error?.code).toBe("validation_failed");
      for (const body of [
        { ...quoteBody(trips.a[0] ?? ""), tripId: "nope" },
        { ...quoteBody(trips.a[0] ?? ""), party: { kind: "tickets", tickets: [] } },
        {
          ...quoteBody(trips.a[0] ?? ""),
          party: { kind: "tickets", tickets: [{ code: "adult", quantity: 0 }] },
        },
        { ...quoteBody(trips.a[0] ?? ""), addOns: [{ code: "PHOTO", quantity: 1 }] },
        { ...quoteBody(trips.a[0] ?? ""), promotionCode: "x" },
      ]) {
        const r = await call("POST", "/v1/public/quotes", { key: randomUUID(), body });
        expect({ body, status: r.res.status }).toEqual({ body, status: 400 });
      }
    });

    it("refuses a trip that is no longer on sale", async () => {
      const tripId = trips.a[2] ?? "";
      await admin`update public.scheduled_trips set sales_state = 'closed' where id = ${tripId}`;
      try {
        const quote = await call("POST", "/v1/public/quotes", {
          key: randomUUID(),
          body: quoteBody(tripId),
        });
        expect(quote.res.status).toBe(409);
        expect(quote.json.error?.code).toBe("trip_not_bookable");
        const offer = await call("GET", `/v1/public/trips/${tripId}/offer`);
        expect(offer.json.error?.code).toBe("trip_not_bookable");
      } finally {
        await admin`update public.scheduled_trips set sales_state = 'published' where id = ${tripId}`;
      }
    });

    it("serves an old quote unchanged after the price list changes", async () => {
      const created = await call("POST", "/v1/public/quotes", {
        key: randomUUID(),
        body: quoteBody(trips.a[0] ?? ""),
      });
      expect(created.res.status).toBe(201);
      await inTenantTransaction(runtime.db, { tenantId: A.id, actorType: "system" }, (trx) =>
        createPriceListVersion(
          trx,
          { tenantId: A.id, actorType: "system" },
          {
            productId: productA,
            tickets: [
              { code: "adult", name: "Adult", unitAmount: 9900, taxable: true },
              { code: "child", name: "Child", unitAmount: 2000, taxable: true },
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
            ],
            reason: "price rise",
          },
        ),
      );
      const quoteId = (created.json.quote as { quoteId: string }).quoteId;
      const read = await call("GET", `/v1/public/quotes/${quoteId}`);
      expect(read.json).toEqual(created.json);
      const fresh = await call("POST", "/v1/public/quotes", {
        key: randomUUID(),
        body: quoteBody(trips.a[0] ?? ""),
      });
      const lines = (fresh.json.quote as { lines: { code: string; unitAmount: number }[] }).lines;
      expect(lines.find((l) => l.code === "adult")?.unitAmount).toBe(9900);
      expect((fresh.json.quote as { priceListVersion: number }).priceListVersion).toBe(2);
    });
  });
});
