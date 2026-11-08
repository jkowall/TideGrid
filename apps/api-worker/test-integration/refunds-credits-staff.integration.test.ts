/**
 * Staff cancellation, booking credit, and refund exceptions through the API
 * (W3-G2.9): who may do what, idempotency, and other tenants hidden.
 * Owners and booking staff preview and cancel; only owners override the
 * policy or adjust credit; finance reads refund exceptions and changes none.
 * Contracts: packages/contracts/src/refunds-credits.ts.
 */
import { randomUUID } from "node:crypto";
import { createDb } from "@tidegrid/database";
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
const TEAM = "tidegrid-refunds-credits.cloudflareaccess.com";
const AUD = "fa".repeat(32);

interface Staffed extends CheckoutFixture {
  owner: string;
  bookingStaff: string;
  finance: string;
}

describe.skipIf(!env)("staff cancellation, credit, and refund exceptions (W3-G2.9)", () => {
  let admin: Sql;
  let runtime: ReturnType<typeof createDb>;
  let app: ReturnType<typeof createApp>;
  let signingKey: CryptoKey;
  let payments: FakePaymentProvider;
  let A: Staffed;
  let B: Staffed;
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
    options: { as?: string; key?: string; body?: unknown } = {},
  ) {
    const headers = new Headers({ origin: CONSOLE });
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

  async function staffed(fixture: CheckoutFixture, label: string): Promise<Staffed> {
    const tag = fixture.id.slice(0, 8);
    return {
      ...fixture,
      owner: await member(fixture.id, `${label}-owner-${tag}@example.test`, "owner"),
      bookingStaff: await member(fixture.id, `${label}-desk-${tag}@example.test`, "booking_staff"),
      finance: await member(fixture.id, `${label}-finance-${tag}@example.test`, "finance"),
    };
  }

  const paths = (tenantId: string, bookingId: string) => ({
    cancellation: `/v1/staff/tenants/${tenantId}/bookings/${bookingId}/cancellation`,
    credit: `/v1/staff/tenants/${tenantId}/bookings/${bookingId}/credit`,
    adjust: `/v1/staff/tenants/${tenantId}/bookings/${bookingId}/credit/adjustments`,
    exceptions: `/v1/staff/tenants/${tenantId}/refund-exceptions`,
  });

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 3, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 8 });
    payments = fakeProvider(runtime.db);
    const [a, b] = await Promise.all([
      createCheckoutFixture(admin, runtime.db, "g29api-a", { days: 8 }),
      createCheckoutFixture(admin, runtime.db, "g29api-b", { days: 4 }),
    ]);
    A = await staffed(a, "g29api-a");
    B = await staffed(b, "g29api-b");
    tripsA = tripAllocator(A);
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

  it("previews and cancels with the policy's refund, once, for owners and booking staff only", async () => {
    const booked = await confirmBooking(runtime.db, payments, A, tripsA.shared(), 2);
    const own = paths(A.id, booked.bookingId);
    // Finance and another tenant's owner see nothing to cancel.
    expect((await request("GET", own.cancellation, { as: A.finance })).status).toBe(403);
    expect((await request("GET", own.cancellation, { as: B.owner })).status).toBe(404);
    expect((await request("GET", own.cancellation)).status).toBe(401);
    const preview = await request("GET", own.cancellation, { as: A.bookingStaff });
    expect(preview.status).toBe(200);
    expect(preview.headers.get("cache-control")).toBe("no-store");
    const shown = preview.json.preview;
    expect(shown.refund.amount).toBeGreaterThan(0);
    expect(shown.refund.feeReversal).toBeLessThan(0);
    expect(shown.credit).toEqual({ amount: shown.policyValue, balanceAfter: shown.policyValue });

    // A booking-staff override is refused; a wrong amount changes nothing.
    const override = {
      choice: { kind: "override", remedy: "percent_refund", refundBp: 5000, reason: "Weather" },
      expectedAmount: 1,
    };
    const refused = await request("POST", own.cancellation, {
      as: A.bookingStaff,
      key: `k-${randomUUID()}`,
      body: override,
    });
    expect([refused.status, refused.json.error?.code]).toEqual([403, "forbidden"]);
    const stale = await request("POST", own.cancellation, {
      as: A.bookingStaff,
      key: `k-${randomUUID()}`,
      body: { choice: { kind: "policy" }, expectedAmount: shown.refund.amount + 1 },
    });
    expect([stale.status, stale.json.error?.code]).toEqual([409, "cancellation_terms_changed"]);

    const key = `k-${randomUUID()}`;
    const body = { choice: { kind: "policy" }, expectedAmount: shown.refund.amount };
    const done = await request("POST", own.cancellation, { as: A.bookingStaff, key, body });
    expect(done.status).toBe(200);
    expect(done.json).toMatchObject({
      cancellation: { refundAmount: shown.refund.amount, creditAmount: 0, overridden: false },
      refund: { state: "succeeded", amount: shown.refund.amount },
    });
    const replay = await request("POST", own.cancellation, { as: A.bookingStaff, key, body });
    expect(replay.status).toBe(200);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    const reused = await request("POST", own.cancellation, {
      as: A.bookingStaff,
      key,
      body: { choice: { kind: "credit" }, expectedAmount: shown.refund.amount },
    });
    expect([reused.status, reused.json.error?.code]).toEqual([422, "idempotency_key_reused"]);
    const [count] = await admin<{ n: number }[]>`
      select count(*)::int as n from public.payment_refunds r
        join public.bookings b on b.payment_id = r.payment_id where b.id = ${booked.bookingId}`;
    expect(count?.n).toBe(1);
  });

  it("issues credit instead, which only owners adjust and never below zero", async () => {
    const booker = { name: "Credit Api", email: `credit-api-${randomUUID()}@example.test` };
    const booked = await confirmBooking(runtime.db, payments, A, tripsA.shared(), 1, { booker });
    const own = paths(A.id, booked.bookingId);
    expect((await request("GET", own.credit, { as: A.owner })).json).toEqual({ account: null });
    const shown = (await request("GET", own.cancellation, { as: A.owner })).json.preview;
    const done = await request("POST", own.cancellation, {
      as: A.bookingStaff,
      key: `k-${randomUUID()}`,
      body: { choice: { kind: "credit" }, expectedAmount: shown.credit.amount },
    });
    expect(done.status).toBe(200);
    expect(done.json).toMatchObject({
      cancellation: { remedy: "credit", creditAmount: shown.credit.amount, refundAmount: 0 },
      refund: null,
    });
    const credit = await request("GET", own.credit, { as: A.bookingStaff });
    expect(credit.json.account).toMatchObject({ balance: shown.credit.amount });
    expect((await request("GET", own.credit, { as: A.finance })).status).toBe(403);
    expect((await request("GET", own.credit, { as: B.owner })).status).toBe(404);

    const adjust = (as: string, amount: number, key = `k-${randomUUID()}`) =>
      request("POST", own.adjust, { as, key, body: { amount, reason: "Goodwill" } });
    expect((await adjust(A.bookingStaff, 100)).status).toBe(403);
    expect((await adjust(A.finance, 100)).status).toBe(403);
    expect((await adjust(B.owner, 100)).status).toBe(404);
    const tooMuch = await adjust(A.owner, -(shown.credit.amount + 1));
    expect([tooMuch.status, tooMuch.json.error?.code]).toEqual([409, "credit_insufficient"]);
    const key = `k-${randomUUID()}`;
    const up = await adjust(A.owner, 250, key);
    expect(up.status).toBe(200);
    expect(up.json.account.balance).toBe(shown.credit.amount + 250);
    const again = await adjust(A.owner, 250, key);
    expect(again.headers.get("idempotent-replayed")).toBe("true");
    expect(again.json.account.balance).toBe(shown.credit.amount + 250);
  });

  it("lists refund exceptions for finance, inside the tenant", async () => {
    const own = paths(A.id, randomUUID());
    const listed = await request("GET", own.exceptions, { as: A.finance });
    expect(listed.status).toBe(200);
    expect(Array.isArray(listed.json.exceptions)).toBe(true);
    expect((await request("GET", own.exceptions, { as: B.owner })).status).toBe(404);
  });
});
