/**
 * Moving a booking to another trip through the API (W3-G2.11-rest): the guest
 * from the booking page before the change cutoff, staff with
 * bookings.reschedule, and owners past the cutoff with a reason. Finance and
 * other tenants are refused. Contract: packages/contracts/src/reschedules.ts.
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
const TEAM = "tidegrid-reschedules.cloudflareaccess.com";
const AUD = "fc".repeat(32);

interface Tenant extends CheckoutFixture {
  host: string;
  owner: string;
  bookingStaff: string;
  finance: string;
}

describe.skipIf(!env)("moving a booking through the API (W3-G2.11-rest)", () => {
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
    method: "GET" | "POST",
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

  async function booked(trip = tripsA.shared()) {
    const made = await confirmBooking(runtime.db, payments, A, trip, 2);
    const res = await request(
      "POST",
      `/v1/public/checkout-sessions/${made.checkoutSessionId}/manage-session`,
      { origin: `https://${A.host}`, headers: { authorization: `Bearer ${made.secret}` } },
    );
    if (res.status !== 201) throw new Error(`session: ${res.status} ${JSON.stringify(res.json)}`);
    return { ...made, tripId: trip, session: res.json.session.token as string };
  }

  const guest = (session: string, key?: string) => ({
    origin: `https://${A.host}`,
    headers: { authorization: `Bearer ${session}`, ...(key ? { "idempotency-key": key } : {}) },
  });

  /** Put tenant A's charter product inside a 30-day change cutoff. */
  async function lateCutoff() {
    const ctx: TenantContext = {
      tenantId: A.id,
      actorType: "system",
      actorId: "test-reschedule",
      requestId: `req-${randomUUID()}`,
    };
    const made = await inTenantTransaction(runtime.db, ctx, (trx) =>
      createPolicyVersion(trx, ctx, {
        productId: A.products.charter,
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
      createCheckoutFixture(admin, runtime.db, "rscapi-a", { days: 20 }),
      createCheckoutFixture(admin, runtime.db, "rscapi-b", { days: 4 }),
    ]);
    A = await tenant(a, "rscapi-a");
    B = await tenant(b, "rscapi-b");
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

  it("lets the guest preview and move the booking, once per key", async () => {
    const b = await booked();
    const preview = await request("GET", "/v1/public/manage/reschedule", guest(b.session));
    expect(preview.status).toBe(200);
    expect(preview.headers.get("cache-control")).toBe("no-store");
    expect(preview.json.preview).toMatchObject({
      movable: true,
      refusal: null,
      tripId: b.tripId,
      price: { changes: false },
    });
    expect(preview.json.preview.bookingId).toBeUndefined();
    const to = preview.json.preview.options.find((o: Json) => o.available).tripId as string;

    const key = randomUUID();
    const body = { fromTripId: b.tripId, toTripId: to, overrideReason: "please" };
    const moved = await request("POST", "/v1/public/manage/reschedule", {
      ...guest(b.session, key),
      body,
    });
    expect(moved.status).toBe(200);
    expect(moved.json.move).toMatchObject({ fromTripId: b.tripId, toTripId: to, by: "guest" });
    expect(moved.json.booking).toMatchObject({ reference: b.reference, state: "confirmed" });

    // An override in a guest's body is not part of the contract and changes nothing.
    expect(moved.json.move.overridden).toBe(false);

    const replay = await request("POST", "/v1/public/manage/reschedule", {
      ...guest(b.session, key),
      body,
    });
    expect(replay.status).toBe(200);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(replay.json.move).toEqual(moved.json.move);

    const stale = await request("POST", "/v1/public/manage/reschedule", {
      ...guest(b.session, randomUUID()),
      body: {
        fromTripId: b.tripId,
        toTripId: preview.json.preview.options.find((o: Json) => o.tripId !== to).tripId,
      },
    });
    expect(stale.status).toBe(409);
    expect(stale.json.error.code).toBe("booking_changed");

    const reused = await request("POST", "/v1/public/manage/reschedule", {
      ...guest(b.session, key),
      body: { fromTripId: to, toTripId: b.tripId },
    });
    expect(reused.status).toBe(422);

    const noSession = await request("GET", "/v1/public/manage/reschedule", {
      origin: `https://${A.host}`,
    });
    expect(noSession.status).toBe(401);
  });

  it("refuses the guest past the cutoff, and lets only an owner override with a reason", async () => {
    const trip = tripsA.charter();
    const made = await confirmBooking(runtime.db, payments, A, trip, 2, { charter: true });
    const session = await request(
      "POST",
      `/v1/public/checkout-sessions/${made.checkoutSessionId}/manage-session`,
      { origin: `https://${A.host}`, headers: { authorization: `Bearer ${made.secret}` } },
    );
    const token = session.json.session.token as string;
    const to = tripsA.charter();
    const body = { fromTripId: trip, toTripId: to };

    const preview = await request("GET", "/v1/public/manage/reschedule", guest(token));
    expect(preview.json.preview).toMatchObject({ movable: false, refusal: "past_cutoff" });
    const refused = await request("POST", "/v1/public/manage/reschedule", {
      ...guest(token, randomUUID()),
      body,
    });
    expect(refused.status).toBe(409);
    expect(refused.json.error.code).toBe("reschedule_cutoff_passed");
    // An override in the guest's body is not part of the contract.
    const sneaky = await request("POST", "/v1/public/manage/reschedule", {
      ...guest(token, randomUUID()),
      body: { ...body, overrideReason: "please" },
    });
    expect(sneaky.status).toBe(409);
    expect(sneaky.json.error.code).toBe("reschedule_cutoff_passed");

    const path = `/v1/staff/tenants/${A.id}/bookings/${made.bookingId}/reschedule`;
    const desk = await request("POST", path, { as: A.bookingStaff, key: randomUUID(), body });
    expect(desk.status).toBe(409);
    expect(desk.json.error.code).toBe("reschedule_cutoff_passed");
    const deskOverride = await request("POST", path, {
      as: A.bookingStaff,
      key: randomUUID(),
      body: { ...body, overrideReason: "Guest called" },
    });
    expect(deskOverride.status).toBe(403);
    const owner = await request("POST", path, {
      as: A.owner,
      key: randomUUID(),
      body: { ...body, overrideReason: "Guest called; weather on the first day" },
    });
    expect(owner.status).toBe(200);
    expect(owner.json.move).toMatchObject({ overridden: true, by: "staff", beforeCutoff: false });
  });

  it("lets booking staff move before the cutoff; finance and other tenants are refused", async () => {
    const b = await booked();
    const path = `/v1/staff/tenants/${A.id}/bookings/${b.bookingId}/reschedule`;
    const body = { fromTripId: b.tripId, toTripId: tripsA.shared() };

    expect((await request("GET", path)).status).toBe(401);
    expect((await request("GET", path, { as: A.finance })).status).toBe(403);
    expect((await request("POST", path, { as: A.finance, key: randomUUID(), body })).status).toBe(
      403,
    );
    const otherTenant = await request(
      "GET",
      `/v1/staff/tenants/${B.id}/bookings/${b.bookingId}/reschedule`,
      { as: B.owner },
    );
    expect(otherTenant.status).toBe(404);
    expect(
      (
        await request("POST", `/v1/staff/tenants/${B.id}/bookings/${b.bookingId}/reschedule`, {
          as: B.owner,
          key: randomUUID(),
          body,
        })
      ).status,
    ).toBe(404);
    const onB = await request("POST", path, {
      as: A.owner,
      key: randomUUID(),
      body: { fromTripId: b.tripId, toTripId: tripsB.shared() },
    });
    expect(onB.status).toBe(409);
    expect(onB.json.error.code).toBe("trip_not_eligible");

    const read = await request("GET", path, { as: A.bookingStaff });
    expect(read.status).toBe(200);
    expect(read.json.preview.movable).toBe(true);
    const moved = await request("POST", path, { as: A.bookingStaff, key: randomUUID(), body });
    expect(moved.status).toBe(200);
    expect(moved.json.move).toMatchObject({ by: "staff", overridden: false });
    const [row] = await admin<{ trip_id: string }[]>`
      select trip_id from public.bookings where id = ${b.bookingId}`;
    expect(row?.trip_id).toBe(body.toTripId);
  });
});
