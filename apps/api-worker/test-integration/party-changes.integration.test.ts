/**
 * Giving up a place in a shared-seat party through the API (W3-G2.11-rest):
 * the guest from the booking page before the change cutoff, staff with
 * bookings.reschedule, and owners past the cutoff with a reason. Finance and
 * other tenants are refused. Contract: packages/contracts/src/party-changes.ts.
 */
import { randomUUID } from "node:crypto";
import { createDb, inTenantTransaction, type TenantContext } from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import {
  type CheckoutFixture,
  confirmBooking,
  createCheckoutFixture,
  fakeProvider,
  TEST_FAKE_SECRET,
} from "@tidegrid/domain-booking/testing";
import { tripAllocator } from "@tidegrid/domain-inventory/testing";
import type { FakePaymentProvider } from "@tidegrid/domain-payments";
import { createPolicyVersion } from "@tidegrid/domain-pricing";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createApp } from "../src/app.ts";
import { createAccessVerifier } from "../src/auth/access.ts";

type Sql = ReturnType<typeof postgres>;
// biome-ignore lint/suspicious/noExplicitAny: response bodies are checked field by field.
type Json = Record<string, any>;

const env = inject("integrationDb");
const CONSOLE = "https://console.test";
const TEAM = "tidegrid-party-changes.cloudflareaccess.com";
const AUD = "fd".repeat(32);

interface Tenant extends CheckoutFixture {
  host: string;
  owner: string;
  bookingStaff: string;
  finance: string;
}

describe.skipIf(!env)("giving up a place through the API (W3-G2.11-rest)", () => {
  let admin: Sql;
  let runtime: ReturnType<typeof createDb>;
  let app: ReturnType<typeof createApp>;
  let signingKey: CryptoKey;
  let payments: FakePaymentProvider;
  let A: Tenant;
  let B: Tenant;
  let tripsA: ReturnType<typeof tripAllocator>;
  let tripsB: ReturnType<typeof tripAllocator>;
  const kid = `kid-${randomUUID().slice(0, 8)}`;

  const bindings = () => ({
    ENVIRONMENT: "local" as const,
    BUILD_ID: "integration",
    DATABASE_URL: env?.runtimeUrl ?? "",
    ALLOWED_ORIGINS: CONSOLE,
    STAFF_ORIGINS: CONSOLE,
    PAYMENT_PROVIDER: "fake",
    FAKE_PAYMENT_WEBHOOK_SECRET: TEST_FAKE_SECRET,
    EMAIL_PROVIDER: "fake",
    GUEST_LINK_ORIGIN: "https://{slug}.book.example.test",
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

  async function request(
    method: "GET" | "POST" | "PUT",
    path: string,
    options: {
      as?: string;
      key?: string;
      body?: unknown;
      origin?: string;
      headers?: Record<string, string>;
    } = {},
  ) {
    const headers = new Headers(options.headers);
    headers.set("origin", options.origin ?? CONSOLE);
    if (options.as) headers.set("cf-access-jwt-assertion", await token(options.as));
    if (options.key) headers.set("idempotency-key", options.key);
    if (options.body !== undefined) headers.set("content-type", "application/json");
    const res = await app.request(
      `http://localhost${path}`,
      {
        method,
        headers,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      },
      bindings(),
      executionCtx,
    );
    const text = await res.text();
    return {
      status: res.status,
      headers: res.headers,
      json: (text ? JSON.parse(text) : {}) as Json,
    };
  }

  async function member(tenantId: string, email: string, role: string) {
    const userId = randomUUID();
    await admin`insert into public.staff_users (id, email, display_name)
      values (${userId}, ${email}, ${role})`;
    await admin`insert into public.tenant_memberships (tenant_id, user_id, role, display_name)
      values (${tenantId}, ${userId}, ${role}, ${role})`;
    return email;
  }

  async function tenant(fixture: CheckoutFixture, label: string): Promise<Tenant> {
    const tag = fixture.id.slice(0, 8);
    const host = `${fixture.slug}.book.example.test`;
    await admin`insert into public.tenant_hostnames (hostname, tenant_id, kind, status, verified_at)
      values (${host}, ${fixture.id}, 'preview', 'active', now())`;
    return {
      ...fixture,
      host,
      owner: await member(fixture.id, `${label}-owner-${tag}@example.test`, "owner"),
      bookingStaff: await member(fixture.id, `${label}-desk-${tag}@example.test`, "booking_staff"),
      finance: await member(fixture.id, `${label}-finance-${tag}@example.test`, "finance"),
    };
  }

  async function booked(t: Tenant = A, party = 3, trip = tripsA.shared()) {
    const made = await confirmBooking(runtime.db, payments, t, trip, party);
    const res = await request(
      "POST",
      `/v1/public/checkout-sessions/${made.checkoutSessionId}/manage-session`,
      { origin: `https://${t.host}`, headers: { authorization: `Bearer ${made.secret}` } },
    );
    if (res.status !== 201) throw new Error(`session: ${res.status} ${JSON.stringify(res.json)}`);
    return { ...made, tripId: trip, session: res.json.session.token as string };
  }

  const guest = (session: string, key?: string, t: Tenant = A) => ({
    origin: `https://${t.host}`,
    headers: { authorization: `Bearer ${session}`, ...(key ? { "idempotency-key": key } : {}) },
  });

  /** Put tenant B's shared-seat product inside a 30-day change cutoff. */
  async function lateCutoff() {
    const ctx: TenantContext = {
      tenantId: B.id,
      actorType: "system",
      actorId: "test-party-change",
      requestId: `req-${randomUUID()}`,
    };
    const made = await inTenantTransaction(runtime.db, ctx, (trx) =>
      createPolicyVersion(trx, ctx, {
        productId: B.products.shared,
        changeCutoffMinutes: 43_200,
        beforeCutoff: { remedy: "full_refund" },
        afterCutoff: { remedy: "none" },
        noShow: { remedy: "none" },
        text: {
          cancellation: "Cancellation terms.",
          reschedule: "Within 30 days, ask the operator.",
          noShow: "No-show terms.",
          operatorCancellation: "Operator terms.",
          weather: "Weather terms.",
        },
        reason: "test: a long cutoff",
      }),
    );
    if (made.kind !== "created") throw new Error(JSON.stringify(made));
  }

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 3, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 8 });
    payments = fakeProvider(runtime.db);
    const [a, b] = await Promise.all([
      createCheckoutFixture(admin, runtime.db, "ptyapi-a", { days: 6 }),
      createCheckoutFixture(admin, runtime.db, "ptyapi-b", { days: 4 }),
    ]);
    A = await tenant(a, "ptyapi-a");
    B = await tenant(b, "ptyapi-b");
    tripsA = tripAllocator(A);
    tripsB = tripAllocator(B);
    await lateCutoff();
    const pair = await generateKeyPair("RS256", { extractable: true });
    signingKey = pair.privateKey;
    const jwk = { ...(await exportJWK(pair.publicKey)), kid, alg: "RS256", use: "sig" };
    app = createApp({
      accessVerifier: createAccessVerifier({
        teamDomain: TEAM,
        audience: AUD,
        keys: createLocalJWKSet({ keys: [jwk] }),
      }),
      deliverEmailAfterCommit: false,
    });
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end({ timeout: 5 });
  });

  it("lets the guest give up a place, once per key, and shows the smaller party", async () => {
    const b = await booked();
    const named = await request("PUT", "/v1/public/manage/participants/2", {
      ...guest(b.session, randomUUID()),
      body: { name: "Leaving Guest", isMinor: false },
    });
    expect(named.status).toBe(200);

    const path = "/v1/public/manage/participants/2/removal";
    const key = randomUUID();
    const body = { partySize: 3, overrideReason: "please" };
    const removed = await request("POST", path, { ...guest(b.session, key), body });
    expect(removed.status).toBe(200);
    expect(removed.headers.get("cache-control")).toBe("no-store");
    // An override in a guest's body is not part of the contract and changes nothing.
    expect(removed.json.change).toMatchObject({
      position: 2,
      participantId: named.json.participant.id,
      fromPartySize: 3,
      toPartySize: 2,
      by: "guest",
      overridden: false,
    });
    expect(removed.json.booking).toMatchObject({ reference: b.reference, state: "confirmed" });
    expect(removed.json.booking.participants).toEqual({
      partySize: 2,
      places: [1, 3],
      participants: [],
    });

    const replay = await request("POST", path, { ...guest(b.session, key), body });
    expect(replay.status).toBe(200);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(replay.json.change).toEqual(removed.json.change);

    const stale = await request("POST", "/v1/public/manage/participants/1/removal", {
      ...guest(b.session, randomUUID()),
      body: { partySize: 3 },
    });
    expect(stale.status).toBe(409);
    expect(stale.json.error.code).toBe("booking_changed");

    const renamed = await request("PUT", "/v1/public/manage/participants/2", {
      ...guest(b.session, randomUUID()),
      body: { name: "Back Again", isMinor: false },
    });
    expect(renamed.status).toBe(409);
    expect(renamed.json.error.code).toBe("place_not_found");

    const last = await booked(A, 1);
    const lastPlace = await request("POST", "/v1/public/manage/participants/1/removal", {
      ...guest(last.session, randomUUID()),
      body: { partySize: 1 },
    });
    expect(lastPlace.status).toBe(409);
    expect(lastPlace.json.error.code).toBe("last_place");

    const noSession = await request("POST", path, {
      origin: `https://${A.host}`,
      key: randomUUID(),
      body: { partySize: 2 },
    });
    expect(noSession.status).toBe(401);
  });

  it("refuses the guest past the cutoff, and lets only an owner override with a reason", async () => {
    const b = await booked(B, 3, tripsB.shared());
    const refused = await request("POST", "/v1/public/manage/participants/3/removal", {
      ...guest(b.session, randomUUID(), B),
      body: { partySize: 3, overrideReason: "please" },
    });
    expect(refused.status).toBe(409);
    expect(refused.json.error.code).toBe("party_change_cutoff_passed");

    const path = `/v1/staff/tenants/${B.id}/bookings/${b.bookingId}/participants/3/removal`;
    const desk = await request("POST", path, {
      as: B.bookingStaff,
      key: randomUUID(),
      body: { partySize: 3 },
    });
    expect(desk.status).toBe(409);
    expect(desk.json.error.code).toBe("party_change_cutoff_passed");
    const deskOverride = await request("POST", path, {
      as: B.bookingStaff,
      key: randomUUID(),
      body: { partySize: 3, overrideReason: "Guest called" },
    });
    expect(deskOverride.status).toBe(403);
    const owner = await request("POST", path, {
      as: B.owner,
      key: randomUUID(),
      body: { partySize: 3, overrideReason: "Guest called; one of them is ill" },
    });
    expect(owner.status).toBe(200);
    expect(owner.json.change).toMatchObject({
      overridden: true,
      by: "staff",
      beforeCutoff: false,
      toPartySize: 2,
    });
  });

  it("lets booking staff give up a place; finance and other tenants are refused", async () => {
    const b = await booked();
    const path = `/v1/staff/tenants/${A.id}/bookings/${b.bookingId}/participants/3/removal`;
    const body = { partySize: 3 };

    expect((await request("POST", path, { key: randomUUID(), body })).status).toBe(401);
    expect((await request("POST", path, { as: A.finance, key: randomUUID(), body })).status).toBe(
      403,
    );
    const otherTenant = await request(
      "POST",
      `/v1/staff/tenants/${B.id}/bookings/${b.bookingId}/participants/3/removal`,
      { as: B.owner, key: randomUUID(), body },
    );
    expect(otherTenant.status).toBe(404);

    const charter = await confirmBooking(runtime.db, payments, A, tripsA.charter(), 3, {
      charter: true,
    });
    const onCharter = await request(
      "POST",
      `/v1/staff/tenants/${A.id}/bookings/${charter.bookingId}/participants/3/removal`,
      { as: A.owner, key: randomUUID(), body },
    );
    expect(onCharter.status).toBe(409);
    expect(onCharter.json.error.code).toBe("party_change_not_allowed");

    const removed = await request("POST", path, { as: A.bookingStaff, key: randomUUID(), body });
    expect(removed.status).toBe(200);
    expect(removed.json.change).toMatchObject({ by: "staff", overridden: false, position: 3 });
    const [row] = await admin<{ party_size: number }[]>`
      select party_size from public.bookings where id = ${b.bookingId}`;
    expect(row?.party_size).toBe(2);
    const read = await request(
      "GET",
      `/v1/staff/tenants/${A.id}/bookings/${b.bookingId}/participants`,
      { as: A.bookingStaff },
    );
    expect(read.json.party).toMatchObject({ partySize: 2, places: [1, 2] });
  });
});
