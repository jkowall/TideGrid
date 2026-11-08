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
 *
 * Ingress hardening (W1-STRIPE-WEBHOOK): under Stripe the route answers 200
 * once the event is recorded and processes it after the response, through
 * `waitUntil`, with the sweep as the backstop; and it refuses any client
 * address, read from CF-Connecting-IP only, that is not on Stripe's list.
 * The test's execution context keeps every `waitUntil` promise, and `drain`
 * awaits them, so a test sees the state after the background work.
 */
import { randomUUID } from "node:crypto";
import { createDb } from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import { type BookingHooks, sweepCheckouts } from "@tidegrid/domain-booking";
import {
  type CheckoutFixture,
  createCheckoutFixture,
  newSecret,
  quoteFor,
} from "@tidegrid/domain-booking/testing";
import { tripAllocator } from "@tidegrid/domain-inventory/testing";
import {
  createStripePaymentProvider,
  STRIPE_WEBHOOK_IPS,
  type StripePaymentProvider,
} from "@tidegrid/domain-payments";
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

const [STRIPE_IP = "", OTHER_STRIPE_IP = ""] = STRIPE_WEBHOOK_IPS;

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
  // Keeps the background work each request schedules, for `drain`.
  let pending: Promise<unknown>[] = [];
  const executionCtx = {
    waitUntil: (work: Promise<unknown>) => {
      pending.push(work);
    },
    passThroughOnException: () => {},
    props: {},
  };
  /** Await every `waitUntil` promise so far, and any they schedule. */
  async function drain() {
    while (pending.length > 0) {
      const batch = pending;
      pending = [];
      await Promise.allSettled(batch);
    }
  }

  async function request(
    method: string,
    path: string,
    opts: {
      origin?: string;
      body?: unknown;
      raw?: string;
      headers?: Record<string, string>;
      via?: ReturnType<typeof createApp>;
    } = {},
  ) {
    const headers = new Headers(opts.headers);
    if (opts.origin) headers.set("origin", opts.origin);
    if (opts.body !== undefined) headers.set("content-type", "application/json");
    const res = await (opts.via ?? app).request(
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

  /** One delivery from Stripe's first listed address, answered before processing. */
  const send = (
    delivery: StripeFixtureDelivery,
    opts: {
      /** CF-Connecting-IP; null sends none. Stripe's first listed address by default. */
      address?: string | null;
      headers?: Record<string, string>;
      via?: ReturnType<typeof createApp>;
    } = {},
  ) => {
    const address = opts.address === undefined ? STRIPE_IP : opts.address;
    return request("POST", "/v1/webhooks/payments/stripe", {
      raw: delivery.body,
      headers: {
        "stripe-signature": delivery.header,
        ...(address === null ? {} : { "cf-connecting-ip": address }),
        ...opts.headers,
      },
      ...(opts.via ? { via: opts.via } : {}),
    });
  };

  /** The inbox row for a Stripe event, read over the admin connection. */
  async function inbox(eventId: string) {
    const rows = await admin<{ processing_state: string; outcome: string | null }[]>`
      select processing_state, outcome from public.provider_events
       where provider = 'stripe' and event_id = ${eventId}`;
    return rows[0] ?? null;
  }

  /**
   * One delivery, its background processing awaited. The response's outcome
   * is `received` for a new event; the inbox's outcome is what processing did.
   */
  async function deliver(delivery: StripeFixtureDelivery) {
    const res = await send(delivery);
    await drain();
    const row = await inbox(delivery.id);
    return { ...res, processed: row?.outcome ?? null };
  }

  async function confirmed(t: Tenant) {
    const opened = await open(t, tripsA.shared(), 2);
    const paid = await deliver(
      await fixture.event("payment_intent.succeeded", fixture.succeed(opened.paymentRef)),
    );
    expect(paid.json).toMatchObject({ received: true, outcome: "received" });
    expect(paid.processed).toBe("confirmed");
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
    pending = [];
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

  afterEach(async () => {
    await drain();
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
    expect(res.json).toEqual({ received: true, duplicate: false, outcome: "received" });
    expect(res.processed).toBe("confirmed");
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
    expect(declined.json).toMatchObject({ received: true, outcome: "received" });
    expect(declined.processed).toBe("ignored_event_type");
    expect((await status(A, opened.id, opened.secret)).state).toBe("open");
    const paid = await deliver(
      await fixture.event("payment_intent.succeeded", fixture.succeed(opened.paymentRef)),
    );
    expect(paid.processed).toBe("confirmed");
  });

  it("fails a checkout whose intent was canceled, with no payment mismatch", async () => {
    const opened = await open(A, tripsA.shared(), 1);
    const res = await deliver(
      await fixture.event("payment_intent.canceled", fixture.cancel(opened.paymentRef)),
    );
    expect(res.status).toBe(200);
    expect(res.processed).toBe("released");
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
    expect(forged.processed).toBe("unmatched_payment");
    expect((await status(A, opened.id, opened.secret)).state).toBe("open");
    const [payment] = await admin<{ state: string }[]>`
      select state from public.payments where provider_payment_id = ${opened.paymentRef}`;
    expect(payment?.state).toBe("pending");
    const real = await deliver(await fixture.event("payment_intent.succeeded", intent));
    expect(real.processed).toBe("confirmed");
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
  const appWith = (hooks: BookingHooks) =>
    createApp({
      deliverEmailAfterCommit: false,
      paymentProvider: () => stripe,
      bookingHooks: hooks,
    });

  async function bookingsFor(paymentRef: string) {
    const [row] = await admin<{ n: number }[]>`
      select count(*)::int as n from public.bookings b
        join public.payments p on p.tenant_id = b.tenant_id and p.id = b.payment_id
       where p.provider = 'stripe' and p.provider_payment_id = ${paymentRef}`;
    return row?.n ?? 0;
  }

  it("answers 200 once the event is recorded, before processing confirms the booking", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = 0;
    const gated = appWith({
      async bookingConfirmed() {
        entered += 1;
        await gate;
      },
    });
    const opened = await open(A, tripsA.shared(), 1);
    const event = await fixture.event(
      "payment_intent.succeeded",
      fixture.succeed(opened.paymentRef),
    );
    const res = await send(event, { via: gated });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ received: true, duplicate: false, outcome: "received" });
    // The answer came while processing is held inside its transaction: the
    // event is committed as received, and nothing is confirmed yet.
    await vi.waitFor(() => expect(entered).toBe(1));
    expect(await inbox(event.id)).toEqual({ processing_state: "received", outcome: null });
    expect((await status(A, opened.id, opened.secret)).state).toBe("open");
    expect(logged("payment_webhook_recorded")).toBe(true);
    release();
    await drain();
    expect(await inbox(event.id)).toEqual({ processing_state: "processed", outcome: "confirmed" });
    expect((await status(A, opened.id, opened.secret)).state).toBe("confirmed");
    expect(await bookingsFor(opened.paymentRef)).toBe(1);
  });

  it("leaves an event received when processing fails after the 200, and the sweep confirms it", async () => {
    const crashing = appWith({
      async bookingConfirmed() {
        throw new Error("the isolate went away after the 200");
      },
    });
    const opened = await open(A, tripsA.shared(), 1);
    const event = await fixture.event(
      "payment_intent.succeeded",
      fixture.succeed(opened.paymentRef),
    );
    const res = await send(event, { via: crashing });
    expect(res.json).toEqual({ received: true, duplicate: false, outcome: "received" });
    await drain();
    expect(logged("payment_webhook_processing_failed")).toBe(true);
    expect(await inbox(event.id)).toEqual({ processing_state: "received", outcome: null });
    expect((await status(A, opened.id, opened.secret)).state).toBe("open");
    expect(await bookingsFor(opened.paymentRef)).toBe(0);

    const report = await sweepCheckouts(runtime.db, {
      runId: `stripe-${randomUUID()}`,
      provider: stripe,
      graceSeconds: 0,
    });
    expect(report.reprocessed).toBeGreaterThanOrEqual(1);
    expect(await inbox(event.id)).toEqual({ processing_state: "processed", outcome: "confirmed" });
    expect((await status(A, opened.id, opened.secret)).state).toBe("confirmed");

    // Stripe counts the 200 as delivered and does not retry it, so until the
    // sweep ran nothing else processed the event. A manual resend after the
    // sweep is a duplicate and changes nothing.
    const again = await deliver(await fixture.redeliver(event, { nowMs: Date.now() + 1000 }));
    expect(again.json).toEqual({ received: true, duplicate: true, outcome: "confirmed" });
    expect(await bookingsFor(opened.paymentRef)).toBe(1);
  });

  it("processes an event left received when it is resent by hand from Stripe's dashboard", async () => {
    // Stripe does not retry a delivery it got a 200 for. A redelivery after a
    // 200 happens only when a person resends the event, or when the 200 was
    // lost on the way and Stripe saw a timeout.
    const crashing = appWith({
      async bookingConfirmed() {
        throw new Error("the isolate went away after the 200");
      },
    });
    const opened = await open(A, tripsA.shared(), 1);
    const event = await fixture.event(
      "payment_intent.succeeded",
      fixture.succeed(opened.paymentRef),
    );
    await send(event, { via: crashing });
    await drain();
    expect(await inbox(event.id)).toEqual({ processing_state: "received", outcome: null });
    const resent = await deliver(await fixture.redeliver(event, { nowMs: Date.now() + 1000 }));
    expect(resent.json).toEqual({ received: true, duplicate: true, outcome: "received" });
    expect(resent.processed).toBe("confirmed");
    expect(await bookingsFor(opened.paymentRef)).toBe(1);
  });

  it("sends the confirmation email in the same background work, after processing", async () => {
    // Email after commit is on in this app; the bindings name the fake email provider.
    const mailing = createApp({ paymentProvider: () => stripe });
    const opened = await open(A, tripsA.shared(), 1);
    const event = await fixture.event(
      "payment_intent.succeeded",
      fixture.succeed(opened.paymentRef),
    );
    const res = await send(event, { via: mailing });
    expect(res.json.outcome).toBe("received");
    await drain();
    const mail = await admin<{ template: string; state: string }[]>`
      select m.template, m.state from public.email_messages m
        join public.bookings b on b.tenant_id = m.tenant_id and b.id = m.booking_id
        join public.payments p on p.tenant_id = b.tenant_id and p.id = b.payment_id
       where p.provider = 'stripe' and p.provider_payment_id = ${opened.paymentRef}`;
    expect(mail).toEqual([{ template: "booking_confirmation", state: "sent" }]);
    expect(logged("email_delivery")).toBe(true);
  });

  it("confirms once when one event arrives many times at once, and on later replays", async () => {
    let confirmations = 0;
    const counting = appWith({
      async bookingConfirmed() {
        confirmations += 1;
      },
    });
    const opened = await open(A, tripsA.shared(), 1);
    const intent = fixture.succeed(opened.paymentRef);
    const event = await fixture.event("payment_intent.succeeded", intent, { pendingWebhooks: 3 });
    const copies = [
      event,
      event,
      await fixture.redeliver(event, { pendingWebhooks: 2 }),
      await fixture.redeliver(event, { pendingWebhooks: 1, pretty: true }),
      await fixture.redeliver(event, { pendingWebhooks: 0 }),
    ];
    const answers = await Promise.all(copies.map((copy) => send(copy, { via: counting })));
    for (const answer of answers) expect(answer.status).toBe(200);
    expect(answers.filter((a) => a.json.duplicate === false)).toHaveLength(1);
    await drain();
    expect(confirmations).toBe(1);
    expect(await inbox(event.id)).toEqual({ processing_state: "processed", outcome: "confirmed" });
    expect(logged("payment_webhook_payload_mismatch")).toBe(false);

    // A replay after processing answers its outcome and processes nothing.
    const seen = logs.length;
    const replay = await send(event, { via: counting });
    expect(replay.json).toEqual({ received: true, duplicate: true, outcome: "confirmed" });
    await drain();
    expect(
      logs.slice(seen).some((line) => /payment_webhook_(recorded|processing)/.test(line)),
    ).toBe(false);

    // A second event id for the same success, as Stripe sometimes sends.
    const second = await fixture.event("payment_intent.succeeded", intent);
    expect(second.id).not.toBe(event.id);
    await send(second, { via: counting });
    await drain();
    expect(await inbox(second.id)).toEqual({
      processing_state: "processed",
      outcome: "already_succeeded",
    });
    expect(confirmations).toBe(1);
    expect(await bookingsFor(opened.paymentRef)).toBe(1);
    const [inboxRows] = await admin<{ n: number }[]>`
      select count(*)::int as n from public.provider_events
       where provider = 'stripe' and event_id in (${event.id}, ${second.id})`;
    expect(inboxRows?.n).toBe(2);
  });

  it("refuses an address not on Stripe's list with 403, reading CF-Connecting-IP only", async () => {
    const opened = await open(A, tripsA.shared(), 1);
    const event = await fixture.event(
      "payment_intent.succeeded",
      fixture.succeed(opened.paymentRef),
    );
    const refused: [string, string | null, Record<string, string>][] = [
      ["an unlisted address", "203.0.113.50", {}],
      ["no CF-Connecting-IP", null, {}],
      ["an empty CF-Connecting-IP", "", {}],
      ["X-Forwarded-For naming Stripe", "203.0.113.51", { "x-forwarded-for": STRIPE_IP }],
      ["X-Forwarded-For only", null, { "x-forwarded-for": STRIPE_IP }],
      ["X-Real-IP only", null, { "x-real-ip": STRIPE_IP }],
      ["a list", `${STRIPE_IP}, ${OTHER_STRIPE_IP}`, {}],
      ["IPv4-mapped IPv6", `::ffff:${STRIPE_IP}`, {}],
      ["loopback", "127.0.0.1", {}],
    ];
    const got: Record<string, [number, string | undefined]> = {};
    for (const [name, address, headers] of refused) {
      const res = await send(event, { address, headers });
      got[name] = [res.status, res.json.error?.code];
    }
    expect(got).toEqual(
      Object.fromEntries(refused.map(([name]) => [name, [403, "source_not_allowed"]])),
    );
    expect(await inbox(event.id)).toBeNull();
    expect(logged("payment_webhook_source_refused")).toBe(true);
    expect(logged("source_address_missing")).toBe(true);
    expect(logged("source_address_not_listed")).toBe(true);
    expect((await status(A, opened.id, opened.secret)).state).toBe("open");

    // From a listed address, whatever X-Forwarded-For says, it is accepted.
    const accepted = await send(event, {
      address: OTHER_STRIPE_IP,
      headers: { "x-forwarded-for": "203.0.113.52" },
    });
    expect(accepted.json).toEqual({ received: true, duplicate: false, outcome: "received" });
    await drain();
    expect((await status(A, opened.id, opened.secret)).state).toBe("confirmed");
  });

  it("answers a bad signature from Stripe's address with 400 as before, and checks the address first", async () => {
    const opened = await open(A, tripsA.shared(), 1);
    const intent = fixture.succeed(opened.paymentRef);
    const event = await fixture.event("payment_intent.succeeded", intent);
    const other = await fixture.event("payment_intent.succeeded", intent);
    const bad: [string, StripeFixtureDelivery][] = [
      ["another event's signature", { ...event, header: other.header }],
      ["a changed body", { ...event, body: event.body.replace('"livemode"', ' "livemode"') }],
      ["no signature", { ...event, header: "" }],
    ];
    for (const [name, delivery] of bad) {
      const res = await send(delivery);
      expect([name, res.status, res.json.error?.code]).toEqual([name, 400, "signature_invalid"]);
    }
    // An unlisted address is refused before its signature is read.
    const elsewhere = await send({ ...event, header: other.header }, { address: "203.0.113.53" });
    expect([elsewhere.status, elsewhere.json.error?.code]).toEqual([403, "source_not_allowed"]);
    expect(await inbox(event.id)).toBeNull();
    expect((await status(A, opened.id, opened.secret)).state).toBe("open");
  });

  it("measures the time to the 200 and to confirmation", async () => {
    const samples: { ack: number; confirmed: number }[] = [];
    for (let i = 0; i < 8; i++) {
      const opened = await open(A, tripsA.shared(), 1);
      const event = await fixture.event(
        "payment_intent.succeeded",
        fixture.succeed(opened.paymentRef),
      );
      const started = performance.now();
      const res = await send(event);
      const ack = performance.now() - started;
      await drain();
      const confirmed = performance.now() - started;
      expect(res.json.outcome).toBe("received");
      expect((await inbox(event.id))?.outcome).toBe("confirmed");
      samples.push({ ack, confirmed });
    }
    // The route logs both: the 200's duration, and receipt to the processing commit.
    const durations = (name: string) =>
      logs
        .map((line) => {
          try {
            return JSON.parse(line) as Record<string, unknown>;
          } catch {
            return null;
          }
        })
        .filter((line) => line?.["event.name"] === name)
        .map((line) => line?.duration_ms);
    expect(durations("payment_webhook_recorded")).toHaveLength(samples.length);
    expect(durations("payment_webhook").every((ms) => typeof ms === "number")).toBe(true);
    expect(durations("payment_webhook")).toHaveLength(samples.length);
    const median = (values: number[]) => {
      const sorted = [...values].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)] ?? 0;
    };
    const ms = (n: number) => n.toFixed(1);
    const acks = samples.map((s) => s.ack);
    const confirms = samples.map((s) => s.confirmed);
    process.stderr.write(
      `stripe webhook timing, ${samples.length} deliveries on local PostgreSQL: ` +
        `200 median ${ms(median(acks))} ms, max ${ms(Math.max(...acks))} ms; ` +
        `confirmed median ${ms(median(confirms))} ms, max ${ms(Math.max(...confirms))} ms\n`,
    );
  });
});
