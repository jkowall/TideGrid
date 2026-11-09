/**
 * External payment and reconciliation through the API (W3-G2.10): who may
 * record cash, check, and other tender, idempotency, refund limits, the
 * disputes a verified webhook reports, pending-payment readings, the month's
 * reconciliation, and fee invoices, with other tenants hidden.
 * Contracts: packages/contracts/src/reconciliation.ts.
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
import { type FakePaymentProvider, signatureHeaderValue } from "@tidegrid/domain-payments";
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
const TEAM = "tidegrid-reconciliation.cloudflareaccess.com";
const AUD = "fb".repeat(32);

interface Staffed extends CheckoutFixture {
  owner: string;
  bookingStaff: string;
  finance: string;
}

describe.skipIf(!env)("external payment and reconciliation (W3-G2.10)", () => {
  let admin: Sql;
  let runtime: ReturnType<typeof createDb>;
  let app: ReturnType<typeof createApp>;
  let signingKey: CryptoKey;
  let payments: FakePaymentProvider;
  let A: Staffed;
  let B: Staffed;
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
      raw?: string;
      headers?: Record<string, string>;
    } = {},
  ) {
    // A provider's webhook comes from no browser, so it carries no origin.
    const headers = new Headers({
      ...(options.raw === undefined ? { origin: CONSOLE } : {}),
      ...options.headers,
    });
    if (options.as) headers.set("cf-access-jwt-assertion", await token(options.as));
    if (options.key) headers.set("idempotency-key", options.key);
    if (options.body !== undefined || options.raw !== undefined) {
      headers.set("content-type", "application/json");
    }
    const res = await app.request(
      `http://localhost${path}`,
      {
        method,
        headers,
        ...(options.raw !== undefined
          ? { body: options.raw }
          : options.body !== undefined
            ? { body: JSON.stringify(options.body) }
            : {}),
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

  const paths = (tenantId: string, bookingId = "") => ({
    settlements: `/v1/staff/tenants/${tenantId}/bookings/${bookingId}/external-settlements`,
    disputes: `/v1/staff/tenants/${tenantId}/disputes`,
    exceptions: `/v1/staff/tenants/${tenantId}/payment-reconciliation-exceptions`,
    report: `/v1/staff/tenants/${tenantId}/reconciliation`,
    invoices: `/v1/staff/tenants/${tenantId}/fee-invoices`,
  });

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 3, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 8 });
    payments = fakeProvider(runtime.db);
    const [a, b] = await Promise.all([
      createCheckoutFixture(admin, runtime.db, "g210api-a", { days: 8 }),
      createCheckoutFixture(admin, runtime.db, "g210api-b", { days: 4 }),
    ]);
    A = await staffed(a, "g210api-a");
    B = await staffed(b, "g210api-b");
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
      deliverEmailAfterCommit: false,
    });
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end({ timeout: 5 });
  });

  it("records cash and check for owners and booking staff, refunds for owners only, idempotently", async () => {
    const booked = await confirmBooking(runtime.db, payments, A, tripsA.shared(), 2);
    const own = paths(A.id, booked.bookingId);
    const payment = {
      kind: "payment",
      tender: "cash",
      amount: 1_200,
      reason: "Paid the balance at the dock",
    };
    // Not signed in, finance, and another tenant's owner record nothing.
    const key = `k-${randomUUID()}`;
    expect((await request("POST", own.settlements, { key, body: payment })).status).toBe(401);
    for (const who of [A.finance]) {
      const refused = await request("POST", own.settlements, { as: who, key, body: payment });
      expect([refused.status, refused.json.error?.code]).toEqual([403, "forbidden"]);
    }
    expect(
      (await request("POST", own.settlements, { as: B.owner, key, body: payment })).status,
    ).toBe(404);
    // A malformed booking id answers the same 404.
    expect(
      (
        await request("POST", paths(A.id, "not-a-uuid").settlements, {
          as: A.owner,
          key,
          body: payment,
        })
      ).status,
    ).toBe(404);

    const first = await request("POST", own.settlements, {
      as: A.bookingStaff,
      key,
      body: payment,
    });
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(first.json.settlement).toMatchObject({
      kind: "payment",
      tender: "cash",
      amount: 1_200,
      reason: "Paid the balance at the dock",
      tenderReference: null,
      feeAmount: null,
    });
    const replay = await request("POST", own.settlements, {
      as: A.bookingStaff,
      key,
      body: payment,
    });
    expect(replay.status).toBe(200);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(replay.json.settlement.id).toBe(first.json.settlement.id);
    const reused = await request("POST", own.settlements, {
      as: A.bookingStaff,
      key,
      body: { ...payment, amount: 1_201 },
    });
    expect([reused.status, reused.json.error?.code]).toEqual([422, "idempotency_key_reused"]);
    // Missing key, control characters, and a zero amount are refused.
    expect((await request("POST", own.settlements, { as: A.owner, body: payment })).status).toBe(
      400,
    );
    for (const bad of [
      { reason: "two\nlines" },
      { reason: "   " },
      { tenderReference: " " },
      { amount: 0 },
      { tender: "card" },
    ]) {
      const res = await request("POST", own.settlements, {
        as: A.owner,
        key: `k-${randomUUID()}`,
        body: { ...payment, ...bad },
      });
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }

    // A refund: owners only, bounded by the money in and the booking's total.
    const refund = { kind: "refund", tender: "check", amount: 900, reason: "Short trip" };
    const desk = await request("POST", own.settlements, {
      as: A.bookingStaff,
      key: `k-${randomUUID()}`,
      body: refund,
    });
    expect(desk.status).toBe(403);
    const listed = await request("GET", own.settlements, { as: A.finance });
    expect(listed.status).toBe(200);
    const refundable = listed.json.refundable as number;
    expect(refundable).toBeGreaterThan(0);
    const tooLarge = await request("POST", own.settlements, {
      as: A.owner,
      key: `k-${randomUUID()}`,
      body: { ...refund, amount: refundable + 1 },
    });
    expect([tooLarge.status, tooLarge.json.error?.code]).toEqual([
      409,
      "external_refund_too_large",
    ]);
    const done = await request("POST", own.settlements, {
      as: A.owner,
      key: `k-${randomUUID()}`,
      body: { ...refund, tenderReference: "CHK-77" },
    });
    expect(done.status).toBe(200);
    expect(done.json.settlement).toMatchObject({ kind: "refund", tenderReference: "CHK-77" });
    expect(done.json.settlement.feeAmount).toBeLessThan(0);
    expect(done.json.refundable).toBe(refundable - 900);

    // Reading: payments.read roles; another tenant sees nothing.
    const after = await request("GET", own.settlements, { as: A.bookingStaff });
    expect(after.json.settlements.map((s: Json) => s.kind)).toEqual(["payment", "refund"]);
    expect((await request("GET", own.settlements, { as: B.owner })).status).toBe(404);
  });

  it("shows a dispute a verified webhook reported, and the month's reconciliation and invoices", async () => {
    const booked = await confirmBooking(runtime.db, payments, B, tripsB.shared(), 2);
    const [paid] = await admin<{ ref: string; amount: number }[]>`
      select p.provider_payment_id as ref, p.amount from public.bookings b
        join public.payments p on p.id = b.payment_id where b.id = ${booked.bookingId}`;
    if (!paid) throw new Error("no payment");
    const body = JSON.stringify({
      id: `fevt_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
      object: "event",
      type: "dispute.updated",
      created: Math.floor(Date.now() / 1000),
      account: B.accountRef,
      data: {
        object: {
          object: "dispute",
          id: `fdp_${randomUUID().replace(/-/g, "")}`,
          payment: paid.ref,
          amount: 3_000,
          currency: "usd",
          status: "needs_response",
          reason: "product_not_received",
        },
      },
    });
    const delivered = await request("POST", "/v1/webhooks/payments/fake", {
      raw: body,
      headers: { "fake-signature": await signatureHeaderValue(TEST_FAKE_SECRET, Date.now(), body) },
    });
    expect(delivered.status).toBe(200);
    expect(delivered.json.outcome).toBe("dispute_opened");

    const own = paths(B.id);
    const disputes = await request("GET", own.disputes, { as: B.finance });
    expect(disputes.status).toBe(200);
    expect(disputes.json.disputes).toEqual([
      expect.objectContaining({
        status: "needs_response",
        open: true,
        amount: 3_000,
        reason: "product_not_received",
        booking: { id: booked.bookingId, reference: booked.reference },
      }),
    ]);
    expect((await request("GET", paths(A.id).disputes, { as: B.owner })).status).toBe(404);
    expect((await request("GET", paths(A.id).disputes, { as: A.owner })).json.disputes).toEqual([]);

    const exceptions = await request("GET", own.exceptions, { as: B.bookingStaff });
    expect(exceptions.status).toBe(200);
    expect(exceptions.json.exceptions).toEqual([]);

    // The month's reconciliation and invoices: owners and finance, never booking staff.
    const [month] = await admin<
      { m: string }[]
    >`select to_char(now() at time zone 'UTC', 'YYYY-MM') as m`;
    const report = await request("GET", `${own.report}?month=${month?.m}`, { as: B.finance });
    expect(report.status).toBe(200);
    expect(report.headers.get("cache-control")).toBe("no-store");
    expect(report.json).toMatchObject({
      month: month?.m,
      timeZone: "UTC",
      controlTotalsMatch: true,
    });
    expect(report.json.ledgerFeeTotal).toBe(report.json.totals.feeAmount);
    expect(
      (await request("GET", `${own.report}?month=${month?.m}`, { as: B.bookingStaff })).status,
    ).toBe(403);
    expect((await request("GET", `${own.report}?month=2026-13`, { as: B.owner })).status).toBe(400);
    expect((await request("GET", `${own.report}?month=0000-01`, { as: B.owner })).status).toBe(400);
    expect((await request("GET", own.report, { as: B.owner })).status).toBe(400);

    await admin`
      insert into public.billing_plans (tenant_id, monthly_fee, annual_minimum, starts_on, time_zone)
      values (${B.id}, 2500, 0, (date_trunc('month', now() at time zone 'UTC') - interval '1 month')::date, 'UTC')`;
    const empty = await request("GET", own.invoices, { as: B.owner });
    expect(empty.status).toBe(200);
    expect(empty.json.invoices).toEqual([]);
    expect((await request("GET", own.invoices, { as: B.bookingStaff })).status).toBe(403);
  });
});
