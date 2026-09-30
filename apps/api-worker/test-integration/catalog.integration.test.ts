import { randomUUID } from "node:crypto";
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
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createApp } from "../src/app.ts";
import { createAccessVerifier } from "../src/auth/access.ts";

type Sql = ReturnType<typeof postgres>;
type Json = Record<string, unknown> & { error?: { code: string; message: string } };
type Trip = { tripId: string; localDate: string; localStartTime: string; salesState?: string };

const env = inject("integrationDb");
const CONSOLE = "https://console.test";
const TEAM = "tidegrid-catalog-test.cloudflareaccess.com";
const AUD = "cd".repeat(32);
/** Every request runs at this instant, before the fixture season. */
const NOW = new Date("2026-10-15T00:00:00Z");

describe.skipIf(!env)("catalog API against a real database as the runtime role", () => {
  let admin: Sql;
  let runtime: ReturnType<typeof createDb>;
  let app: ReturnType<typeof createApp>;
  let signingKey: CryptoKey;
  const run = randomUUID().slice(0, 8);
  const kid = `kid-${run}`;
  const tenant = (label: string) => ({
    id: randomUUID(),
    slug: `catapi-${label}-${run}`,
    host: `catapi-${label}-${run}.book.example.test`,
  });
  const A = tenant("a");
  const B = tenant("b");
  const person = (label: string) => ({ id: randomUUID(), email: `${label}-${run}@example.test` });
  const ownerA = person("owner-a");
  const staffA = person("staff-a");
  const financeA = person("finance-a");
  const ownerB = person("owner-b");
  const fixture = { scheduleA: "", scheduleA2: "", orphanA: "", tripB: "" };

  const bindings = () => ({
    ENVIRONMENT: "local" as const,
    BUILD_ID: "integration",
    DATABASE_URL: env?.runtimeUrl ?? "",
    ALLOWED_ORIGINS: CONSOLE,
    STAFF_ORIGINS: CONSOLE,
  });
  const executionCtx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} };

  async function token(email: string): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ type: "app", email })
      .setProtectedHeader({ alg: "RS256", kid })
      .setIssuer(`https://${TEAM}`)
      .setAudience(AUD)
      .setSubject(randomUUID())
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(signingKey);
  }

  async function call(
    method: string,
    path: string,
    opts: { as?: string; body?: unknown; origin?: string | null; key?: string } = {},
  ) {
    const headers = new Headers();
    if (opts.body !== undefined) headers.set("content-type", "application/json");
    const origin = opts.origin === undefined ? (method === "GET" ? null : CONSOLE) : opts.origin;
    if (origin) headers.set("origin", origin);
    if (opts.as) headers.set("cf-access-jwt-assertion", await token(opts.as));
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

  const staffPath = (tenantId: string, rest: string) => `/v1/staff/tenants/${tenantId}${rest}`;
  const publicTrips = (query: string, host: string | null) =>
    call("GET", `/v1/public/trips?${query}`, { origin: host ? `https://${host}` : null });

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 2, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 2 });
    for (const t of [A, B]) {
      await admin`insert into public.tenants (id, slug, display_name)
        values (${t.id}, ${t.slug}, ${`Catalog API ${t.slug}`})`;
      await admin`insert into public.tenant_hostnames (hostname, tenant_id, kind, status, verified_at)
        values (${t.host}, ${t.id}, 'preview', 'active', now())`;
    }
    for (const p of [ownerA, staffA, financeA, ownerB]) {
      await admin`insert into public.staff_users (id, email, display_name)
        values (${p.id}, ${p.email}, 'Fixture person')`;
    }
    await admin`insert into public.tenant_memberships (tenant_id, user_id, role, display_name) values
      (${A.id}, ${ownerA.id}, 'owner', 'Owner A'),
      (${A.id}, ${staffA.id}, 'booking_staff', 'Desk A'),
      (${A.id}, ${financeA.id}, 'finance', 'Books A'),
      (${B.id}, ${ownerB.id}, 'owner', 'Owner B')`;

    // Each tenant: one published shared-seat product with a daily 09:00 schedule.
    for (const t of [A, B]) {
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
        await publishProduct(trx, ctx, { productId, reason: "fixture" });
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
          fixture.scheduleA = schedule.id;
          const second = await createSchedule(trx, ctx, {
            productId,
            boatId,
            startsOn: "2026-11-01",
            endsOn: "2027-03-31",
            weekdays: [6],
            startTimes: ["15:00"],
            reason: "fixture",
          });
          if (second.kind !== "created") throw new Error(JSON.stringify(second));
          fixture.scheduleA2 = second.id;
          fixture.orphanA = await createProduct(trx, ctx, {
            locationId,
            kind: "shared_seat",
            name: "Unpublishable",
            durationMinutes: 60,
            maxPartySize: 4,
            eligibleBoatIds: [],
            reason: "fixture",
          });
        } else {
          fixture.tripB = generated.created[0]?.tripId ?? "";
        }
      });
    }

    const pair = await generateKeyPair("RS256", { extractable: true });
    signingKey = pair.privateKey;
    const jwk = { ...(await exportJWK(pair.publicKey)), kid, alg: "RS256", use: "sig" };
    app = createApp({
      accessVerifier: createAccessVerifier({
        teamDomain: TEAM,
        audience: AUD,
        keys: createLocalJWKSet({ keys: [jwk] }),
      }),
      now: () => NOW,
    });
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end();
  });

  describe("public availability", () => {
    it("answers only for the calling site's tenant and is never cached", async () => {
      const a = await publicTrips("from=2026-11-10&to=2026-11-12&party=2", A.host);
      const b = await publicTrips("from=2026-11-10&to=2026-11-12&party=2", B.host);
      expect(a.res.status).toBe(200);
      expect(a.res.headers.get("cache-control")).toBe("no-store");
      expect(a.res.headers.get("vary")).toContain("Origin");
      const aTrips = a.json.trips as Array<Trip & { product: { name: string } }>;
      const bTrips = b.json.trips as Array<Trip & { product: { name: string } }>;
      expect(aTrips.map((t) => `${t.localDate} ${t.localStartTime}`)).toEqual([
        "2026-11-10 09:00",
        "2026-11-11 09:00",
        "2026-11-12 09:00",
      ]);
      expect(new Set(aTrips.map((t) => t.product.name))).toEqual(
        new Set([`Harbor Tour ${A.slug}`]),
      );
      expect(new Set(bTrips.map((t) => t.product.name))).toEqual(
        new Set([`Harbor Tour ${B.slug}`]),
      );
      const aIds = new Set(aTrips.map((t) => t.tripId));
      expect(bTrips.some((t) => aIds.has(t.tripId))).toBe(false);
    });

    it("answers the same 404 for an unknown or missing origin", async () => {
      const unknown = await publicTrips(
        "from=2026-11-10&to=2026-11-12",
        "nobody.book.example.test",
      );
      const missing = await publicTrips("from=2026-11-10&to=2026-11-12", null);
      for (const r of [unknown, missing]) {
        expect(r.res.status).toBe(404);
        expect(r.json.error?.code).toBe("tenant_not_found");
      }
    });

    it("rejects bad ranges and party sizes before touching the database", async () => {
      expect((await publicTrips("from=2026-11-12&to=2026-11-10", A.host)).json.error?.code).toBe(
        "invalid_range",
      );
      expect((await publicTrips("from=2026-11-01&to=2027-02-10", A.host)).json.error?.code).toBe(
        "range_too_large",
      );
      const party = await publicTrips("from=2026-11-10&to=2026-11-12&party=0", A.host);
      expect(party.res.status).toBe(400);
      expect(party.json.error?.code).toBe("validation_failed");
      expect(
        (await publicTrips("from=2026-11-10&to=2026-11-12&party=7", A.host)).json.trips,
      ).toEqual([]);
    });
  });

  describe("staff reads", () => {
    it("lets every role read the catalog and calendar of its own tenant only", async () => {
      for (const who of [ownerA, staffA, financeA]) {
        const catalog = await call("GET", staffPath(A.id, "/catalog"), { as: who.email });
        expect(catalog.res.status).toBe(200);
        expect((catalog.json.products as unknown[]).length).toBe(2);
      }
      const trips = await call("GET", staffPath(A.id, "/trips?from=2026-11-10&to=2026-11-12"), {
        as: financeA.email,
      });
      expect(trips.res.status).toBe(200);
      expect((trips.json.trips as Trip[]).map((t) => t.salesState)).toEqual([
        "published",
        "published",
        "published",
      ]);
      const foreign = await call("GET", staffPath(A.id, "/catalog"), { as: ownerB.email });
      expect(foreign.res.status).toBe(404);
      expect(foreign.json.error?.code).toBe("tenant_not_found");
    });
  });

  describe("staff commands", () => {
    const tripsOnA = async () =>
      (
        await call("GET", staffPath(A.id, "/trips?from=2026-11-10&to=2026-11-12"), {
          as: ownerA.email,
        })
      ).json.trips as Trip[];

    it("lets owners and booking staff move trips, not finance, and hides a closed trip from guests", async () => {
      const [first, second] = await tripsOnA();
      if (!first || !second) throw new Error("fixture trips missing");
      const denied = await call("POST", staffPath(A.id, `/trips/${first.tripId}/sales-state`), {
        as: financeA.email,
        key: randomUUID(),
        body: { to: "closed", reason: "full" },
      });
      expect(denied.res.status).toBe(403);
      expect(denied.json.error?.code).toBe("forbidden");

      const closed = await call("POST", staffPath(A.id, `/trips/${first.tripId}/sales-state`), {
        as: staffA.email,
        key: randomUUID(),
        body: { to: "closed", reason: "chartered privately" },
      });
      expect(closed.res.status).toBe(200);
      expect((closed.json.trip as Trip).salesState).toBe("closed");

      const guests = await publicTrips("from=2026-11-10&to=2026-11-12", A.host);
      expect((guests.json.trips as Trip[]).map((t) => t.tripId)).not.toContain(first.tripId);

      const again = await call("POST", staffPath(A.id, `/trips/${first.tripId}/sales-state`), {
        as: ownerA.email,
        key: randomUUID(),
        body: { to: "completed", reason: "too early" },
      });
      expect(again.res.status).toBe(409);
      expect(again.json.error?.code).toBe("trip_not_departed");
    });

    it("replays a stored response and refuses the same key on another trip", async () => {
      const [, second, third] = await tripsOnA();
      if (!second || !third) throw new Error("fixture trips missing");
      const key = randomUUID();
      const body = { to: "closed", reason: "weather watch" };
      const first = await call("POST", staffPath(A.id, `/trips/${second.tripId}/sales-state`), {
        as: ownerA.email,
        key,
        body,
      });
      expect(first.res.status).toBe(200);
      const replay = await call("POST", staffPath(A.id, `/trips/${second.tripId}/sales-state`), {
        as: ownerA.email,
        key,
        body,
      });
      expect(replay.res.status).toBe(200);
      expect(replay.res.headers.get("idempotent-replayed")).toBe("true");
      expect(replay.json).toEqual(first.json);
      const elsewhere = await call("POST", staffPath(A.id, `/trips/${third.tripId}/sales-state`), {
        as: ownerA.email,
        key,
        body,
      });
      expect(elsewhere.res.status).toBe(422);
      expect(elsewhere.json.error?.code).toBe("idempotency_key_reused");
      expect((await tripsOnA()).find((t) => t.tripId === third.tripId)?.salesState).toBe(
        "published",
      );
    });

    it("answers 404 for another tenant's trip and for a malformed id", async () => {
      for (const id of [fixture.tripB, "not-a-uuid"]) {
        const r = await call("POST", staffPath(A.id, `/trips/${id}/sales-state`), {
          as: ownerA.email,
          key: randomUUID(),
          body: { to: "canceled", reason: "escape" },
        });
        expect(r.res.status).toBe(404);
        expect(r.json.error?.code).toBe("trip_not_found");
      }
    });

    it("lets only owners generate trips, and generation is idempotent", async () => {
      const body = {
        fromDate: "2026-11-13",
        toDate: "2026-11-15",
        publish: true,
        reason: "next days",
      };
      const path = staffPath(A.id, `/schedules/${fixture.scheduleA}/trips`);
      const staff = await call("POST", path, { as: staffA.email, key: randomUUID(), body });
      expect(staff.res.status).toBe(403);
      const key = randomUUID();
      const generated = await call("POST", path, { as: ownerA.email, key, body });
      expect(generated.res.status).toBe(200);
      expect((generated.json.created as Trip[]).map((t) => t.localDate)).toEqual([
        "2026-11-13",
        "2026-11-14",
        "2026-11-15",
      ]);
      const fresh = await call("POST", path, { as: ownerA.email, key: randomUUID(), body });
      expect(fresh.json).toMatchObject({ created: [], alreadyScheduled: 3, skipped: [] });
      const otherSchedule = await call(
        "POST",
        staffPath(A.id, `/schedules/${fixture.scheduleA2}/trips`),
        { as: ownerA.email, key, body },
      );
      expect(otherSchedule.res.status).toBe(422);
      expect(otherSchedule.json.error?.code).toBe("idempotency_key_reused");
    });

    it("answers a retryable 409 when another writer takes the boat mid-request", async () => {
      // Hold an overlapping trip uncommitted, let the request's insert block on
      // the boat constraint, then commit: the request must lose with 23P01.
      const [first] = await tripsOnA();
      if (!first) throw new Error("fixture trips missing");
      const [trip] = await admin<{ product_id: string; boat_id: string }[]>`
        select product_id, boat_id from public.scheduled_trips where id = ${first.tripId}`;
      if (!trip) throw new Error("fixture trip row missing");
      const path = staffPath(A.id, `/schedules/${fixture.scheduleA}/trips`);
      const body = { fromDate: "2026-11-20", toDate: "2026-11-20", publish: true, reason: "race" };
      let response: Awaited<ReturnType<typeof call>> | undefined;
      await admin.begin(async (tx) => {
        await tx`insert into public.scheduled_trips (tenant_id, product_id, boat_id, time_zone,
            local_date, local_start_time, starts_at, ends_at, start_utc_offset_minutes,
            end_utc_offset_minutes, duration_minutes, seat_capacity)
          values (${A.id}, ${trip.product_id}, ${trip.boat_id}, 'America/New_York', '2026-11-20',
            '09:30', '2026-11-20T14:30:00Z', '2026-11-20T15:30:00Z', -300, -300, 60, 10)`;
        const pending = call("POST", path, { as: ownerA.email, key: randomUUID(), body }).then(
          (r) => {
            response = r;
          },
        );
        const deadline = Date.now() + 30_000;
        for (;;) {
          const [waiting] = await admin<{ n: number }[]>`
            select count(*)::int as n from pg_locks where not granted`;
          if ((waiting?.n ?? 0) > 0 || response || Date.now() > deadline) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        // Commit by returning, then let the request finish.
        void pending;
      });
      for (let i = 0; !response && i < 300; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(response?.res.status).toBe(409);
      expect(response?.json.error?.code).toBe("boat_schedule_conflict");
    });

    it("blocks publishing with a specific code, for owners only", async () => {
      const path = staffPath(A.id, `/products/${fixture.orphanA}/publish`);
      const staff = await call("POST", path, {
        as: staffA.email,
        key: randomUUID(),
        body: { reason: "try" },
      });
      expect(staff.res.status).toBe(403);
      const owner = await call("POST", path, {
        as: ownerA.email,
        key: randomUUID(),
        body: { reason: "try" },
      });
      expect(owner.res.status).toBe(409);
      expect(owner.json.error?.code).toBe("product_missing_eligible_boat");
    });
  });
});
