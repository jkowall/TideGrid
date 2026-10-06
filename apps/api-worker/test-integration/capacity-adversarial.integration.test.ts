/**
 * G2.6 adversarial API checks across two tenants: the guest trip listing, the
 * staff trip listing, and the staff holds route. Tenant A's site and staff try
 * to see or count tenant B's trips and holds by date, by product, by trip id,
 * by hold id, by path, and through a shared owner reference. Every answer must
 * be A's own data or a bare error that repeats nothing of B.
 */
import { randomUUID } from "node:crypto";
import { createDb, inTenantTransaction } from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import { acquireHold, type Hold } from "@tidegrid/domain-inventory";
import {
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

type Sql = ReturnType<typeof postgres>;
type Capacity = {
  kind: string;
  total: number;
  remaining: number;
  soldOut?: boolean;
  held?: number;
  confirmed?: number;
};
type Trip = { tripId: string; capacity: Capacity };
type Body = {
  trips?: Trip[];
  holds?: { id: string; ownerRef: string; tripId: string }[];
  capacity?: Capacity & { tripId: string };
  error?: { code: string; message: string; requestId: string };
};

const env = inject("integrationDb");
const CONSOLE = "https://console.test";
const TEAM = "tidegrid-capadv-test.cloudflareaccess.com";
const AUD = "ad".repeat(32);
const DAYS = 12;

describe.skipIf(!env)("G2.6 adversarial API checks across two tenants", () => {
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
    const text = await res.text();
    return { status: res.status, text, json: JSON.parse(text) as Body };
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

  async function hold(tenant: TenantFixture, tripId: string, party: number, ownerRef?: string) {
    const ctx = systemContext(tenant.id);
    const result = await inTenantTransaction(runtime.db, ctx, (trx) =>
      acquireHold(trx, ctx, {
        ownerRef: ownerRef ?? `checkout_session:${randomUUID()}`,
        tripId,
        partySize: party,
        ttlSeconds: 600,
      }),
    );
    if (result.kind !== "acquired") throw new Error(`expected acquired, got ${result.kind}`);
    return result.hold;
  }

  /** The last fixture day is the same date in both tenants and no other test here uses it. */
  const lastDay = (f: TenantFixture, key: "shared" | "charter" | "late") => {
    const id = f.trips[key][DAYS - 1];
    if (!id) throw new Error("no trip");
    return id;
  };

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 2, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 2 });
    A = await withAccess(
      await createTenantFixture(admin, runtime.db, "capadv-a", { days: DAYS }),
      "a",
    );
    B = await withAccess(
      await createTenantFixture(admin, runtime.db, "capadv-b", { days: DAYS }),
      "b",
    );
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

  it("never lists or counts another tenant's trips on a site or in a staff listing, by date or by product", async () => {
    const [sharedA, charterA, sharedB, charterB] = [
      lastDay(A, "shared"),
      lastDay(A, "charter"),
      lastDay(B, "shared"),
      lastDay(B, "charter"),
    ];
    const [row] = await admin<{ a: string; b: string }[]>`
      select (select local_date::text from public.scheduled_trips where id = ${sharedA}) as a,
             (select local_date::text from public.scheduled_trips where id = ${sharedB}) as b`;
    expect(row?.a).toBe(row?.b);
    const date = row?.a ?? "";
    await hold(B, sharedB, 8);
    await hold(B, sharedB, 2);
    await hold(B, charterB, 2);
    await hold(A, sharedA, 3);
    const aTrips = new Set([...A.trips.shared, ...A.trips.charter, ...A.trips.late]);
    const bTrips = new Set([...B.trips.shared, ...B.trips.charter, ...B.trips.late]);
    const range = `from=${date}&to=${date}&party=2`;

    const siteA = await get(`/v1/public/trips?${range}`, { origin: `https://${A.host}` });
    expect(siteA.status).toBe(200);
    const listedA = siteA.json.trips ?? [];
    expect(listedA.every((t) => aTrips.has(t.tripId))).toBe(true);
    expect(Object.fromEntries(listedA.map((t) => [t.tripId, t.capacity.remaining]))).toMatchObject({
      [sharedA]: 7,
      [charterA]: 6,
    });

    // Asking A's site for B's product finds nothing, rather than B's trips.
    const byProduct = await get(`/v1/public/trips?${range}&product=${B.products.shared}`, {
      origin: `https://${A.host}`,
    });
    expect([byProduct.status, byProduct.json.trips]).toEqual([200, []]);

    // B's site shows B's trips only, and its full trips not at all.
    const siteB = await get(`/v1/public/trips?${range}`, { origin: `https://${B.host}` });
    expect(siteB.status).toBe(200);
    const listedB = (siteB.json.trips ?? []).map((t) => t.tripId);
    expect(listedB.every((id) => bTrips.has(id))).toBe(true);
    expect(listedB).not.toContain(sharedB);
    expect(listedB).not.toContain(charterB);

    const staffA = await get(`/v1/staff/tenants/${A.id}/trips?from=${date}&to=${date}`, {
      as: A.ownerEmail,
    });
    expect(staffA.status).toBe(200);
    expect((staffA.json.trips ?? []).every((t) => aTrips.has(t.tripId))).toBe(true);
    const capacityA = Object.fromEntries(
      (staffA.json.trips ?? []).map((t) => [t.tripId, t.capacity]),
    );
    expect(capacityA[sharedA]).toMatchObject({ held: 3, confirmed: 0, remaining: 7 });
    expect(capacityA[charterA]).toMatchObject({ held: 0, remaining: 6, soldOut: false });

    const staffCross = await get(`/v1/staff/tenants/${B.id}/trips?from=${date}&to=${date}`, {
      as: A.ownerEmail,
    });
    expect(staffCross.status).toBe(404);
    expect(staffCross.json).toEqual({
      error: {
        code: "tenant_not_found",
        message: expect.any(String),
        requestId: expect.any(String),
      },
    });
    for (const id of [sharedB, charterB]) expect(staffCross.text).not.toContain(id);
  });

  it("answers every cross-tenant or malformed holds request with a bare 404 that repeats nothing of the other tenant", async () => {
    const tripB = tripsB.shared();
    const holdB: Hold = await hold(B, tripB, 2);
    const tripA = tripsA.shared();
    await hold(A, tripA, 1);
    // The control: B's owner sees the hold, so it exists.
    const own = await get(`/v1/staff/tenants/${B.id}/trips/${tripB}/holds`, { as: B.ownerEmail });
    expect(own.status).toBe(200);
    expect(own.json.holds?.map((h) => h.id)).toEqual([holdB.id]);

    const probes = [
      [`/v1/staff/tenants/${A.id}/trips/${tripB}/holds`, "trip_not_found"],
      [`/v1/staff/tenants/${B.id}/trips/${tripB}/holds`, "tenant_not_found"],
      [`/v1/staff/tenants/${A.id}/trips/${holdB.id}/holds`, "trip_not_found"],
      [`/v1/staff/tenants/${A.id}/trips/${tripB.toUpperCase()}/holds`, "trip_not_found"],
      [`/v1/staff/tenants/${B.id.toUpperCase()}/trips/${tripB}/holds`, "tenant_not_found"],
      [`/v1/staff/tenants/${A.id}/trips/${tripA}%20/holds`, "trip_not_found"],
    ] as const;
    for (const [path, code] of probes) {
      const res = await get(path, { as: A.ownerEmail });
      expect([path, res.status, res.json]).toEqual([
        path,
        404,
        { error: { code, message: expect.any(String), requestId: expect.any(String) } },
      ]);
      for (const secret of [holdB.id, holdB.ownerRef, tripB, B.id]) {
        expect(res.json.error?.message ?? "").not.toContain(secret);
      }
    }
  });

  it("keeps a shared owner reference to each tenant's own holds in the staff view", async () => {
    const ownerRef = `checkout_session:${randomUUID()}`;
    const tripA = tripsA.shared();
    const tripB = tripsB.shared();
    const inA = await hold(A, tripA, 2, ownerRef);
    const inB = await hold(B, tripB, 3, ownerRef);
    const viewA = await get(`/v1/staff/tenants/${A.id}/trips/${tripA}/holds`, { as: A.ownerEmail });
    const viewB = await get(`/v1/staff/tenants/${B.id}/trips/${tripB}/holds`, { as: B.ownerEmail });
    expect(viewA.json.holds?.map((h) => [h.id, h.ownerRef])).toEqual([[inA.id, ownerRef]]);
    expect(viewB.json.holds?.map((h) => [h.id, h.ownerRef])).toEqual([[inB.id, ownerRef]]);
    expect(viewA.json.capacity).toMatchObject({ held: 2, remaining: 8 });
    expect(viewB.json.capacity).toMatchObject({ held: 3, remaining: 7 });
    expect(viewA.text).not.toContain(inB.id);
    expect(viewB.text).not.toContain(inA.id);
  });
});
