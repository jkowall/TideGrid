/**
 * Private-charter balances through the API (W3-G2.8): the guest pays the
 * balance from the booking page, a verified webhook marks it paid, and staff
 * move the due date (owners) or email the balance link (owners and booking
 * staff). Finance and other tenants are refused. Contracts:
 * packages/contracts/src/balances.ts and self-service.ts.
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
import { type FakePaymentProvider, signatureHeaderValue } from "@tidegrid/domain-payments";
import { createPriceListVersion } from "@tidegrid/domain-pricing";
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
const TEAM = "tidegrid-balances.cloudflareaccess.com";
const AUD = "fb".repeat(32);
const DEPOSIT = 20_000;
const TOTAL = 107_000;

interface Tenant extends CheckoutFixture {
  host: string;
  owner: string;
  bookingStaff: string;
  finance: string;
}

describe.skipIf(!env)("private-charter balances through the API (W3-G2.8)", () => {
  let admin: Sql;
  let runtime: ReturnType<typeof createDb>;
  let app: ReturnType<typeof createApp>;
  let signingKey: CryptoKey;
  let payments: FakePaymentProvider;
  let A: Tenant;
  let B: Tenant;
  let tripsA: ReturnType<typeof tripAllocator>;
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
    const ctx: TenantContext = {
      tenantId: fixture.id,
      actorType: "system",
      actorId: "test-g28",
      requestId: `req-${randomUUID()}`,
    };
    const created = await inTenantTransaction(runtime.db, ctx, (trx) =>
      createPriceListVersion(trx, ctx, {
        productId: fixture.products.charter,
        charter: { name: "Whole boat", amount: 100_000, taxable: true },
        deposit: { kind: "fixed", amount: DEPOSIT, balanceDueDays: 1 },
        reason: "deposit terms",
      }),
    );
    if (created.kind !== "created") throw new Error(JSON.stringify(created));
    return {
      ...fixture,
      host,
      owner: await member(fixture.id, `${label}-owner-${tag}@example.test`, "owner"),
      bookingStaff: await member(fixture.id, `${label}-desk-${tag}@example.test`, "booking_staff"),
      finance: await member(fixture.id, `${label}-finance-${tag}@example.test`, "finance"),
    };
  }

  async function bookedCharter() {
    const made = await confirmBooking(runtime.db, payments, A, tripsA.charter(), 3, {
      charter: true,
    });
    const res = await request(
      "POST",
      `/v1/public/checkout-sessions/${made.checkoutSessionId}/manage-session`,
      { origin: `https://${A.host}`, headers: { authorization: `Bearer ${made.secret}` } },
    );
    if (res.status !== 201) throw new Error(`session: ${res.status} ${JSON.stringify(res.json)}`);
    return { ...made, session: res.json.session.token as string };
  }

  const guest = (session: string, key?: string) => ({
    origin: `https://${A.host}`,
    headers: { authorization: `Bearer ${session}`, ...(key ? { "idempotency-key": key } : {}) },
  });

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 3, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 8 });
    payments = fakeProvider(runtime.db);
    const [a, b] = await Promise.all([
      createCheckoutFixture(admin, runtime.db, "g28api-a", { days: 10 }),
      createCheckoutFixture(admin, runtime.db, "g28api-b", { days: 4 }),
    ]);
    A = await tenant(a, "g28api-a");
    B = await tenant(b, "g28api-b");
    tripsA = tripAllocator(A);
    for (let i = 0; i < 3; i += 1) tripsA.charter();
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

  it("shows the balance and takes it from the booking page", async () => {
    const booked = await bookedCharter();
    const view = await request("GET", "/v1/public/manage/booking", guest(booked.session));
    expect(view.status).toBe(200);
    expect(view.json.booking.balance).toMatchObject({
      total: TOTAL,
      deposit: DEPOSIT,
      owed: TOTAL - DEPOSIT,
    });

    const pay = await request("POST", "/v1/public/manage/balance-payment", guest(booked.session));
    expect(pay.status).toBe(200);
    expect(pay.headers.get("cache-control")).toBe("no-store");
    expect(pay.json).toMatchObject({ amount: TOTAL - DEPOSIT, payment: { provider: "fake" } });

    const settled = await payments.settlePayment(
      A.id,
      pay.json.payment.paymentRef,
      "succeeded",
      Date.now(),
    );
    if (settled.kind === "not_found") throw new Error("no fake payment");
    const hook = await app.request(
      "http://localhost/v1/webhooks/payments/fake",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "fake-signature": await signatureHeaderValue(
            TEST_FAKE_SECRET,
            Date.now(),
            settled.event.body,
          ),
        },
        body: settled.event.body,
      },
      bindings(),
      executionCtx,
    );
    expect(hook.status).toBe(200);

    const after = await request("GET", "/v1/public/manage/booking", guest(booked.session));
    expect(after.json.booking.balance).toMatchObject({ state: "paid", owed: 0 });
    const more = await request("POST", "/v1/public/manage/balance-payment", guest(booked.session));
    expect(more.status).toBe(409);
    expect(more.json.error.code).toBe("nothing_owed");
  });

  it("lets owners move the due date, and no one else", async () => {
    const booked = await bookedCharter();
    const path = `/v1/staff/tenants/${A.id}/bookings/${booked.bookingId}/balance/due-date`;
    const [trip] = await admin<{ starts_at: Date }[]>`
      select t.starts_at from public.bookings b
        join public.scheduled_trips t on t.id = b.trip_id where b.id = ${booked.bookingId}`;
    const dueAt = new Date((trip?.starts_at.getTime() ?? 0) - 2 * 3_600_000).toISOString();
    const body = { dueAt, reason: "Guest asked for more time" };

    expect((await request("POST", path, { body, key: randomUUID() })).status).toBe(401);
    expect(
      (await request("POST", path, { as: A.bookingStaff, body, key: randomUUID() })).status,
    ).toBe(403);
    expect((await request("POST", path, { as: A.finance, body, key: randomUUID() })).status).toBe(
      403,
    );
    expect((await request("POST", path, { as: B.owner, body, key: randomUUID() })).status).toBe(
      404,
    );

    const key = randomUUID();
    const moved = await request("POST", path, { as: A.owner, body, key });
    expect(moved.status).toBe(200);
    expect(moved.json.balance.dueAt).toBe(dueAt);
    const replay = await request("POST", path, { as: A.owner, body, key });
    expect(replay.status).toBe(200);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");

    const late = await request("POST", path, {
      as: A.owner,
      body: { dueAt: trip?.starts_at.toISOString(), reason: "Too late" },
      key: randomUUID(),
    });
    expect(late.status).toBe(422);
    expect(late.json.error.code).toBe("invalid_due_date");

    // Staff see the reason on the booking; the guest does not.
    const detail = await request("GET", `/v1/staff/tenants/${A.id}/bookings/${booked.bookingId}`, {
      as: A.bookingStaff,
    });
    expect(detail.json.booking.balance.dueChanges[0].reason).toBe("Guest asked for more time");
    const mine = await request("GET", "/v1/public/manage/booking", guest(booked.session));
    expect(mine.json.booking.balance.dueChanges[0].reason).toBeNull();
  });

  it("lets owners and booking staff email the link, three times an hour", async () => {
    const booked = await bookedCharter();
    const path = `/v1/staff/tenants/${A.id}/bookings/${booked.bookingId}/balance/link`;
    expect((await request("POST", path, { as: A.finance, key: randomUUID() })).status).toBe(403);
    for (let i = 0; i < 3; i += 1) {
      const sent = await request("POST", path, { as: A.bookingStaff, key: randomUUID() });
      expect(sent.status).toBe(202);
      expect(sent.json).toMatchObject({ status: "accepted", messageId: expect.any(String) });
    }
    const refused = await request("POST", path, { as: A.owner, key: randomUUID() });
    expect(refused.status).toBe(429);
    expect(refused.json.error.code).toBe("balance_link_rate_limited");
  });
});
