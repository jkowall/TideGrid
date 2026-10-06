import { randomUUID } from "node:crypto";
import { createDb, inTenantTransaction } from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import { acquireHold, confirmHold, type Hold } from "@tidegrid/domain-inventory";
import {
  backdateHold,
  createTenantFixture,
  systemContext,
  type TenantFixture,
  tripAllocator,
} from "@tidegrid/domain-inventory/testing";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createApp } from "../src/app.ts";
import { createAccessVerifier } from "../src/auth/access.ts";
import { runScheduled } from "../src/scheduled.ts";

type Sql = ReturnType<typeof postgres>;
type Capacity = {
  kind: string;
  total: number;
  remaining: number;
  soldOut?: boolean;
  held?: number;
  confirmed?: number;
};
type Trip = { tripId: string; localDate: string; capacity: Capacity };
type Json = { trips?: Trip[]; error?: { code: string } };

const env = inject("integrationDb");
const CONSOLE = "https://console.test";
const TEAM = "tidegrid-capacity-test.cloudflareaccess.com";
const AUD = "ef".repeat(32);

describe.skipIf(!env)("capacity in the trip listings and the hold sweep", () => {
  let admin: Sql;
  let runtime: ReturnType<typeof createDb>;
  let app: ReturnType<typeof createApp>;
  let signingKey: CryptoKey;
  let A: TenantFixture & { host: string; ownerEmail: string };
  let B: TenantFixture & { host: string; ownerEmail: string };
  let tripsA: ReturnType<typeof tripAllocator>;
  let tripsB: ReturnType<typeof tripAllocator>;
  const kid = `kid-${randomUUID().slice(0, 8)}`;

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

  async function get(path: string, opts: { origin?: string; as?: string } = {}) {
    const headers = new Headers();
    if (opts.origin) headers.set("origin", opts.origin);
    if (opts.as) headers.set("cf-access-jwt-assertion", await token(opts.as));
    const res = await app.request(`http://localhost${path}`, { headers }, bindings(), executionCtx);
    return { status: res.status, json: (await res.json()) as Json };
  }

  async function dateOf(tripId: string): Promise<string> {
    const [row] = await admin<{ local_date: string }[]>`
      select local_date::text from public.scheduled_trips where id = ${tripId}`;
    if (!row) throw new Error("no trip");
    return row.local_date;
  }

  /** The trip as the guest listing shows it to `tenant`'s site, or undefined when left out. */
  async function guestView(tenant: typeof A, tripId: string, party: number) {
    const date = await dateOf(tripId);
    const { status, json } = await get(`/v1/public/trips?from=${date}&to=${date}&party=${party}`, {
      origin: `https://${tenant.host}`,
    });
    expect(status).toBe(200);
    return json.trips?.find((t) => t.tripId === tripId);
  }

  async function staffView(tenant: typeof A, tripId: string, as = tenant.ownerEmail) {
    const date = await dateOf(tripId);
    const res = await get(`/v1/staff/tenants/${tenant.id}/trips?from=${date}&to=${date}`, { as });
    return { status: res.status, trip: res.json.trips?.find((t) => t.tripId === tripId) };
  }

  async function hold(tenant: typeof A, tripId: string, partySize: number): Promise<Hold> {
    const ctx = systemContext(tenant.id);
    const result = await inTenantTransaction(runtime.db, ctx, (trx) =>
      acquireHold(trx, ctx, {
        ownerRef: `checkout_session:${randomUUID()}`,
        tripId,
        partySize,
        ttlSeconds: 600,
      }),
    );
    if (result.kind !== "acquired") throw new Error(`expected acquired, got ${result.kind}`);
    return result.hold;
  }

  async function confirm(tenant: typeof A, h: Hold) {
    const ctx = systemContext(tenant.id);
    return inTenantTransaction(runtime.db, ctx, (trx) =>
      confirmHold(trx, ctx, { holdId: h.id, ownerRef: h.ownerRef }),
    );
  }

  async function withAccess(fixture: TenantFixture, label: string) {
    const host = `${fixture.slug}.book.example.test`;
    const ownerEmail = `${label}-owner-${fixture.id.slice(0, 8)}@example.test`;
    const userId = randomUUID();
    await admin`insert into public.tenant_hostnames (hostname, tenant_id, kind, status, verified_at)
      values (${host}, ${fixture.id}, 'preview', 'active', now())`;
    await admin`insert into public.staff_users (id, email, display_name)
      values (${userId}, ${ownerEmail}, 'Fixture owner')`;
    await admin`insert into public.tenant_memberships (tenant_id, user_id, role, display_name)
      values (${fixture.id}, ${userId}, 'owner', 'Owner')`;
    return { ...fixture, host, ownerEmail };
  }

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 2, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 2 });
    A = await withAccess(await createTenantFixture(admin, runtime.db, "capapi-a"), "a");
    B = await withAccess(await createTenantFixture(admin, runtime.db, "capapi-b"), "b");
    tripsA = tripAllocator(A);
    tripsB = tripAllocator(B);
    const pair = await generateKeyPair("RS256", { extractable: true });
    signingKey = pair.privateKey;
    const jwk = { ...(await exportJWK(pair.publicKey)), kid, alg: "RS256", use: "sig" };
    app = createApp({
      accessVerifier: createAccessVerifier({
        teamDomain: TEAM,
        audience: AUD,
        keys: createLocalJWKSet({ keys: [jwk] }),
      }),
    });
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end({ timeout: 5 });
  });

  it("subtracts held and confirmed seats for guests and splits them for staff", async () => {
    const trip = tripsA.shared();
    expect((await guestView(A, trip, 2))?.capacity).toEqual({
      kind: "seats",
      total: 10,
      remaining: 10,
      soldOut: false,
    });
    await hold(A, trip, 3);
    const booked = await hold(A, trip, 4);
    expect(await confirm(A, booked)).toMatchObject({ kind: "confirmed" });
    expect((await guestView(A, trip, 3))?.capacity).toEqual({
      kind: "seats",
      total: 10,
      remaining: 3,
      soldOut: false,
    });
    expect(await guestView(A, trip, 4)).toBeUndefined();
    const { status, trip: seen } = await staffView(A, trip);
    expect(status).toBe(200);
    expect(seen?.capacity).toEqual({
      kind: "seats",
      total: 10,
      remaining: 3,
      soldOut: false,
      held: 3,
      confirmed: 4,
    });
  });

  it("quotes against held seats: a trip without room is not bookable, a large party lacks capacity", async () => {
    // A quote finds its trip through the guest listing for the product's
    // smallest party (G2.5), then checks the party against the seats left.
    const quote = async (tripId: string, party: unknown) => {
      const headers = new Headers({
        origin: `https://${A.host}`,
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
      });
      const res = await app.request(
        "http://localhost/v1/public/quotes",
        { method: "POST", headers, body: JSON.stringify({ tripId, party }) },
        bindings(),
        executionCtx,
      );
      const json = (await res.json()) as Json;
      return [res.status, json.error?.code ?? "quoted"];
    };
    const adults = (quantity: number) => ({
      kind: "tickets",
      tickets: [{ code: "adult", quantity }],
    });
    const shared = tripsA.shared();
    await hold(A, shared, 8);
    expect(await quote(shared, adults(2))).toEqual([201, "quoted"]);
    expect(await quote(shared, adults(3))).toEqual([409, "insufficient_capacity"]);
    await hold(A, shared, 2);
    expect(await quote(shared, adults(1))).toEqual([409, "trip_not_bookable"]);
    const charter = tripsA.charter();
    expect(await quote(charter, { kind: "charter", guests: 2 })).toEqual([201, "quoted"]);
    await hold(A, charter, 2);
    expect(await quote(charter, { kind: "charter", guests: 2 })).toEqual([
      409,
      "trip_not_bookable",
    ]);
  });

  it("hides a held charter from guests, shows it sold out to staff, and frees it at expiry", async () => {
    const trip = tripsA.charter();
    const held = await hold(A, trip, 2);
    expect(await guestView(A, trip, 2)).toBeUndefined();
    expect((await staffView(A, trip)).trip?.capacity).toEqual({
      kind: "whole_boat",
      total: 6,
      remaining: 0,
      soldOut: true,
      held: 6,
      confirmed: 0,
    });
    await backdateHold(admin, held.id);
    expect((await guestView(A, trip, 2))?.capacity).toMatchObject({ remaining: 6, soldOut: false });
    expect((await staffView(A, trip)).trip?.capacity).toMatchObject({ held: 0, soldOut: false });
  });

  it("keeps each tenant's capacity to that tenant's site and staff", async () => {
    const tripB = tripsB.charter();
    await hold(B, tripB, 2);
    // Tenant A's site and staff never see tenant B's trip or its hold.
    expect(await guestView(A, tripB, 1)).toBeUndefined();
    const crossStaff = await staffView(B, tripB, A.ownerEmail);
    expect(crossStaff.status).toBe(404);
    expect(crossStaff.trip).toBeUndefined();
    // Tenant B's own staff see it sold out; A's untouched trip on the same day stays open.
    expect((await staffView(B, tripB)).trip?.capacity).toMatchObject({ soldOut: true, held: 6 });
    const tripA = tripsA.charter();
    expect((await guestView(A, tripA, 2))?.capacity).toMatchObject({ remaining: 6 });
  });

  it("lets staff read a trip's capacity and holds, in their own tenant only", async () => {
    const trip = tripsA.shared();
    const stale = await hold(A, trip, 2);
    const live = await hold(A, trip, 3);
    const booked = await hold(A, trip, 1);
    await confirm(A, booked);
    await backdateHold(admin, stale.id);
    const res = await get(`/v1/staff/tenants/${A.id}/trips/${trip}/holds`, { as: A.ownerEmail });
    expect(res.status).toBe(200);
    const body = res.json as unknown as {
      capacity: Capacity & { tripId: string };
      holds: { id: string; state: string; takesCapacity: boolean; ownerRef: string }[];
    };
    expect(body.capacity).toEqual({
      tripId: trip,
      kind: "seats",
      total: 10,
      held: 3,
      confirmed: 1,
      remaining: 6,
      soldOut: false,
    });
    expect(body.holds.map((h) => [h.id, h.state, h.takesCapacity])).toEqual([
      [stale.id, "active", false],
      [live.id, "active", true],
      [booked.id, "confirmed", true],
    ]);
    expect(body.holds[1]?.ownerRef).toBe(live.ownerRef);

    // Another tenant's trip, a malformed id, and another tenant's staff all answer 404.
    const tripB = tripsB.shared();
    const crossTrip = await get(`/v1/staff/tenants/${A.id}/trips/${tripB}/holds`, {
      as: A.ownerEmail,
    });
    expect([crossTrip.status, crossTrip.json.error?.code]).toEqual([404, "trip_not_found"]);
    const malformed = await get(`/v1/staff/tenants/${A.id}/trips/not-a-trip/holds`, {
      as: A.ownerEmail,
    });
    expect([malformed.status, malformed.json.error?.code]).toEqual([404, "trip_not_found"]);
    const crossStaff = await get(`/v1/staff/tenants/${A.id}/trips/${trip}/holds`, {
      as: B.ownerEmail,
    });
    expect([crossStaff.status, crossStaff.json.error?.code]).toEqual([404, "tenant_not_found"]);
    const anonymous = await get(`/v1/staff/tenants/${A.id}/trips/${trip}/holds`);
    expect(anonymous.status).toBe(401);
  });

  it("expires due holds in every tenant from the cron entry point, once", async () => {
    const inA = await hold(A, tripsA.shared(), 2);
    const inB = await hold(B, tripsB.shared(), 2);
    await backdateHold(admin, inA.id);
    await backdateHold(admin, inB.id);
    const lines: string[] = [];
    await runScheduled({ cron: "*/15 * * * *" }, bindings(), { log: (l) => lines.push(l) });
    const summary = lines.map((l) => JSON.parse(l)).find((l) => l.message === "hold_sweep");
    expect(summary).toMatchObject({
      level: "info",
      "event.name": "hold_sweep",
      "tidegrid.hold_sweep.failed_tenant_count": 0,
      "tidegrid.hold_sweep.complete": true,
    });
    expect(summary["tidegrid.hold_sweep.expired_count"]).toBeGreaterThanOrEqual(2);
    const states = await admin<{ id: string; state: string }[]>`
      select id, state from public.capacity_holds where id in (${inA.id}, ${inB.id}) order by id`;
    expect(states.map((s) => s.state)).toEqual(["expired", "expired"]);

    const again: string[] = [];
    await runScheduled({ cron: "*/15 * * * *" }, bindings(), { log: (l) => again.push(l) });
    const [audits] = await admin<{ n: number }[]>`
      select count(*)::int as n from public.audit_events
       where action = 'hold.expired' and subject_id in (${inA.id}, ${inB.id})`;
    expect(audits?.n).toBe(2);
    expect(lines.concat(again).join("\n")).not.toContain(env?.runtimeUrl ?? "never");
  });
});
