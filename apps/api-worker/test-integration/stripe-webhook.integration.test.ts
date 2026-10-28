/**
 * The Stripe adapter through the API, against a real database, over the
 * recorded-shape Stripe fixture (standing goal item 3). No live Stripe call:
 * every Stripe request goes to the fixture's in-memory server. Two synthetic
 * tenants, each with a synthetic Stripe connected account written over the
 * admin connection, as onboarding would; the runtime only reads accounts.
 *
 * It proves: a checkout pays and confirms only from a signed Stripe event; a
 * redelivery with changed per-delivery fields is the same event, with no
 * payload_mismatch; a decline then a success on one intent confirms once; a
 * canceled intent fails its checkout with no payment_mismatch; an event for
 * another tenant naming this tenant's intent changes nothing here; a
 * cancellation refund settles through settleRefund, and a pending one through
 * the sweep; and a 401 on the refund leaves it requested, with no email
 * telling the guest it is not coming.
 */
import { randomUUID } from "node:crypto";
import { createDb } from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import { sweepCheckouts } from "@tidegrid/domain-booking";
import {
  type CheckoutFixture,
  createCheckoutFixture,
  newSecret,
  quoteFor,
} from "@tidegrid/domain-booking/testing";
import { tripAllocator } from "@tidegrid/domain-inventory/testing";
import { createStripePaymentProvider, type StripePaymentProvider } from "@tidegrid/domain-payments";
import {
  createStripeFixture,
  type StripeFixture,
  type StripeFixtureDelivery,
} from "@tidegrid/domain-payments/testing";
import postgres from "postgres";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  inject,
  it,
  vi,
} from "vitest";
import { createApp } from "../src/app.ts";

type Sql = ReturnType<typeof postgres>;
// biome-ignore lint/suspicious/noExplicitAny: response bodies are checked field by field.
type Json = Record<string, any>;

const env = inject("integrationDb");

interface Tenant extends CheckoutFixture {
  host: string;
  stripeAccount: string;
}

describe.skipIf(!env)("the Stripe adapter through the API over the recorded fixture", () => {
  let admin: Sql;
  let runtime: ReturnType<typeof createDb>;
  let app: ReturnType<typeof createApp>;
  let fixture: StripeFixture;
  let stripe: StripePaymentProvider;
  let A: Tenant;
  let B: Tenant;
  let tripsA: ReturnType<typeof tripAllocator>;
  let logs: string[] = [];
  let realFetch = 0;

  const bindings = () => ({
    ENVIRONMENT: "local" as const,
    BUILD_ID: "integration",
    DATABASE_URL: env?.runtimeUrl ?? "",
    ALLOWED_ORIGINS: "https://console.test",
    STAFF_ORIGINS: "https://console.test",
    // Stripe is selected through the test's provider override; the
    // configuration names it, with no keys, so nothing else can build one.
    PAYMENT_PROVIDER: "stripe",
    EMAIL_PROVIDER: "fake",
    GUEST_LINK_ORIGIN: "https://{slug}.book.example.test",
  });
  const executionCtx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} };

  async function request(
    method: string,
    path: string,
    opts: { origin?: string; body?: unknown; raw?: string; headers?: Record<string, string> } = {},
  ) {
    const headers = new Headers(opts.headers);
    if (opts.origin) headers.set("origin", opts.origin);
    if (opts.body !== undefined) headers.set("content-type", "application/json");
    const res = await app.request(
      `http://localhost${path}`,
      {
        method,
        headers,
        body: opts.raw ?? (opts.body === undefined ? null : JSON.stringify(opts.body)),
      },
      bindings(),
      executionCtx,
    );
    const text = await res.text();
    let json: Json = {};
    try {
      json = text ? (JSON.parse(text) as Json) : {};
    } catch {
      json = { text };
    }
    return { status: res.status, headers: res.headers, json, text };
  }

  const guest = (t: Tenant) => `https://${t.host}`;
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  async function open(t: Tenant, tripId: string, party = 2) {
    const q = await quoteFor(runtime.db, t.id, tripId, party);
    const secret = newSecret();
    const res = await request("POST", "/v1/public/checkout-sessions", {
      origin: guest(t),
      headers: { "idempotency-key": `stripe-chk-${randomUUID()}` },
      body: {
        quoteId: q.quoteId,
        acceptedPolicyVersion: q.policy.version,
        booker: { name: "Synthetic Stripe Booker", email: "synthetic.stripe@example.test" },
        checkoutSecret: secret,
      },
    });
    if (res.status !== 201 || !res.json.payment) {
      throw new Error(`open: ${res.status} ${res.text}`);
    }
    return {
      id: res.json.checkoutSession.id as string,
      amount: res.json.checkoutSession.amount as number,
      paymentRef: res.json.payment.paymentRef as string,
      provider: res.json.payment.provider as string,
      secret,
    };
  }

  const status = async (t: Tenant, id: string, secret: string) =>
    (
      await request("GET", `/v1/public/checkout-sessions/${id}`, {
        origin: guest(t),
        headers: bearer(secret),
      })
    ).json.checkoutSession;

  const deliver = (delivery: StripeFixtureDelivery) =>
    request("POST", "/v1/webhooks/payments/stripe", {
      raw: delivery.body,
      headers: { "stripe-signature": delivery.header },
    });

  async function confirmed(t: Tenant) {
    const opened = await open(t, tripsA.shared(), 2);
    const paid = await deliver(
      await fixture.event("payment_intent.succeeded", fixture.succeed(opened.paymentRef)),
    );
    expect(paid.json).toMatchObject({ received: true, outcome: "confirmed" });
    const session = await request(
      "POST",
      `/v1/public/checkout-sessions/${opened.id}/manage-session`,
      { origin: guest(t), headers: bearer(opened.secret) },
    );
    if (session.status !== 201) throw new Error(`manage: ${session.status} ${session.text}`);
    return { ...opened, session: session.json.session.token as string };
  }

  async function cancel(t: Tenant, session: string) {
    const terms = await request("GET", "/v1/public/manage/cancellation", {
      origin: guest(t),
      headers: bearer(session),
    });
    const amount = terms.json.terms.refundAmount as number;
    const res = await request("POST", "/v1/public/manage/cancellation", {
      origin: guest(t),
      headers: { ...bearer(session), "idempotency-key": `stripe-cancel-${randomUUID()}` },
      body: { expectedRefundAmount: amount },
    });
    expect(res.status).toBe(200);
    return { amount, res };
  }

  async function refundOf(paymentRef: string) {
    const [row] = await admin<
      { state: string; provider_refund_id: string | null; key: string; refused_emails: number }[]
    >`
      select r.state, r.provider_refund_id, r.idempotency_key as key,
             (select count(*)::int from public.email_messages m
               join public.bookings b on b.id = m.booking_id
              where b.payment_id = p.id and m.template = 'booking_refund_failed') as refused_emails
        from public.payment_refunds r
        join public.payments p on p.tenant_id = r.tenant_id and p.id = r.payment_id
       where p.provider = 'stripe' and p.provider_payment_id = ${paymentRef}`;
    if (!row) throw new Error(`no refund for ${paymentRef}`);
    return row;
  }

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 3, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 8 });
    fixture = createStripeFixture();
    stripe = createStripePaymentProvider({
      secretKey: fixture.secretKey,
      webhookSecret: fixture.webhookSecret,
      environment: "local",
      fetch: fixture.fetch,
    });
    const made: Tenant[] = [];
    for (const [label, account] of [
      ["stripe-a", fixture.syntheticAccounts.harbor],
      ["stripe-b", fixture.syntheticAccounts.reef],
    ] as const) {
      const tenant = await createCheckoutFixture(admin, runtime.db, label, { days: 30 });
      const host = `${tenant.slug}.book.example.test`;
      await admin`insert into public.tenant_hostnames (hostname, tenant_id, kind, status, verified_at)
        values (${host}, ${tenant.id}, 'preview', 'active', now())`;
      // Over the admin connection, as onboarding would; the runtime only reads it.
      await admin`insert into public.payment_accounts (tenant_id, provider, account_ref)
        values (${tenant.id}, 'stripe', ${account})`;
      made.push({ ...tenant, host, stripeAccount: account });
    }
    [A, B] = made as [Tenant, Tenant];
    tripsA = tripAllocator(A);
    app = createApp({ deliverEmailAfterCommit: false, paymentProvider: () => stripe });
  });

  beforeEach(() => {
    logs = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    // No test reaches the network: Stripe is the fixture's fetch.
    realFetch = 0;
    vi.stubGlobal("fetch", async () => {
      realFetch += 1;
      throw new Error("the real fetch was reached");
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    expect(realFetch).toBe(0);
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end({ timeout: 5 });
  });

  const logged = (name: string) => logs.some((line) => line.includes(name));

  it("confirms a checkout only from a signed Stripe success, and dedupes a changed redelivery", async () => {
    const opened = await open(A, tripsA.shared(), 2);
    expect(opened.provider).toBe("stripe");
    expect(opened.paymentRef).toMatch(/^pi_/);
    const created = fixture.requests.find(
      (r) => r.method === "POST" && r.path === "/v1/payment_intents",
    );
    expect(created?.stripeAccount).toBe(A.stripeAccount);
    expect(created?.form).toContainEqual(["amount", String(opened.amount)]);
    expect(created?.form.some(([k]) => k.includes("application_fee"))).toBe(false);
    expect((await status(A, opened.id, opened.secret)).state).toBe("open");

    const first = await fixture.event(
      "payment_intent.succeeded",
      fixture.succeed(opened.paymentRef),
      {
        pendingWebhooks: 2,
      },
    );
    const res = await deliver(first);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ received: true, duplicate: false, outcome: "confirmed" });
    const session = await status(A, opened.id, opened.secret);
    expect(session.state).toBe("confirmed");
    expect(session.booking?.reference).toBeTruthy();

    // Another endpoint took the event meanwhile: pending_webhooks fell, re-signed later.
    const again = await deliver(
      await fixture.redeliver(first, { pendingWebhooks: 0, nowMs: Date.now() + 1000 }),
    );
    expect(again.status).toBe(200);
    expect(again.json).toEqual({ received: true, duplicate: true, outcome: "confirmed" });
    expect(logged("payment_webhook_payload_mismatch")).toBe(false);
    const [inbox] = await admin<{ n: number }[]>`
      select count(*)::int as n from public.provider_events
       where provider = 'stripe' and event_id = ${first.id}`;
    expect(inbox?.n).toBe(1);
  });

  it("records a decline as other, then confirms the success on the same intent", async () => {
    const opened = await open(A, tripsA.shared(), 1);
    const declined = await deliver(
      await fixture.event("payment_intent.payment_failed", fixture.decline(opened.paymentRef)),
    );
    expect(declined.json).toMatchObject({ received: true, outcome: "ignored_event_type" });
    expect((await status(A, opened.id, opened.secret)).state).toBe("open");
    const paid = await deliver(
      await fixture.event("payment_intent.succeeded", fixture.succeed(opened.paymentRef)),
    );
    expect(paid.json).toMatchObject({ outcome: "confirmed" });
  });

  it("fails a checkout whose intent was canceled, with no payment mismatch", async () => {
    const opened = await open(A, tripsA.shared(), 1);
    const res = await deliver(
      await fixture.event("payment_intent.canceled", fixture.cancel(opened.paymentRef)),
    );
    expect(res.status).toBe(200);
    expect(res.json.outcome).toBe("released");
    expect(logged("payment_mismatch")).toBe(false);
    expect((await status(A, opened.id, opened.secret)).state).toBe("failed");
  });

  it("changes nothing for tenant A when tenant B's account names A's intent", async () => {
    const opened = await open(A, tripsA.shared(), 1);
    const intent = fixture.succeed(opened.paymentRef);
    const forged = await deliver(
      await fixture.event("payment_intent.succeeded", intent, { account: B.stripeAccount }),
    );
    // Verified and recorded in B's inbox, where no payment matches it.
    expect(forged.status).toBe(200);
    expect(forged.json.outcome).toBe("unmatched_payment");
    expect((await status(A, opened.id, opened.secret)).state).toBe("open");
    const [payment] = await admin<{ state: string }[]>`
      select state from public.payments where provider_payment_id = ${opened.paymentRef}`;
    expect(payment?.state).toBe("pending");
    const real = await deliver(await fixture.event("payment_intent.succeeded", intent));
    expect(real.json.outcome).toBe("confirmed");
  });

  it("refunds a cancellation through settleRefund, on the operator's account", async () => {
    const booked = await confirmed(A);
    const { amount, res } = await cancel(A, booked.session);
    expect(res.json.booking).toMatchObject({
      state: "canceled",
      refund: { state: "succeeded", amount },
    });
    const refund = await refundOf(booked.paymentRef);
    expect(refund.state).toBe("succeeded");
    expect(refund.provider_refund_id).toMatch(/^re_/);
    expect(fixture.refundIds(booked.paymentRef)).toEqual([refund.provider_refund_id]);
    const post = fixture.requests.filter((r) => r.method === "POST" && r.path === "/v1/refunds");
    expect(post.at(-1)?.stripeAccount).toBe(A.stripeAccount);
    expect(post.at(-1)?.idempotencyKey).toBe(refund.key);
    expect(post.at(-1)?.form.some(([k]) => k.includes("application_fee"))).toBe(false);
  });

  it("leaves a pending refund requested, and the sweep settles it once Stripe does", async () => {
    const booked = await confirmed(A);
    fixture.refundPending();
    const { res } = await cancel(A, booked.session);
    expect(res.json.booking.refund).toMatchObject({ state: "requested" });
    expect((await refundOf(booked.paymentRef)).state).toBe("requested");
    const [pending] = fixture.refundIds(booked.paymentRef);
    if (!pending) throw new Error("no Stripe refund");
    // Still pending at Stripe: the sweep leaves it requested.
    await sweepCheckouts(runtime.db, {
      runId: `stripe-${randomUUID()}`,
      provider: stripe,
      graceSeconds: 0,
    });
    expect((await refundOf(booked.paymentRef)).state).toBe("requested");
    fixture.settleRefund(pending, "succeeded");
    const report = await sweepCheckouts(runtime.db, {
      runId: `stripe-${randomUUID()}`,
      provider: stripe,
      graceSeconds: 0,
    });
    expect(report.refundsSettled).toBeGreaterThanOrEqual(1);
    const settled = await refundOf(booked.paymentRef);
    expect(settled).toMatchObject({ state: "succeeded", provider_refund_id: pending });
    // Found by its key, never created twice.
    expect(fixture.refundIds(booked.paymentRef)).toEqual([pending]);
  });

  it("leaves a refund requested on a 401, and tells the guest nothing is refused", async () => {
    const booked = await confirmed(A);
    fixture.answerNext(
      {
        status: 401,
        body: JSON.stringify({
          error: { type: "invalid_request_error", message: "Invalid API Key" },
        }),
      },
      { method: "POST", path: "/v1/refunds" },
    );
    const { res } = await cancel(A, booked.session);
    expect(res.json.booking.refund).toMatchObject({ state: "requested" });
    const refund = await refundOf(booked.paymentRef);
    expect(refund).toMatchObject({ state: "requested", refused_emails: 0 });
    expect(fixture.refundIds(booked.paymentRef)).toEqual([]);
  });
});
