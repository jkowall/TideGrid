import { randomUUID } from "node:crypto";
import { createDb } from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import {
  type CheckoutFixture,
  craftedFakeEventBody,
  createCheckoutFixture,
  newSecret,
  quoteFor,
  TEST_FAKE_SECRET,
} from "@tidegrid/domain-booking/testing";
import { tripAllocator } from "@tidegrid/domain-inventory/testing";
import { signatureHeaderValue } from "@tidegrid/domain-payments";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createApp } from "../src/app.ts";
import { createAccessVerifier } from "../src/auth/access.ts";
import { runScheduled } from "../src/scheduled.ts";

type Sql = ReturnType<typeof postgres>;
type Json = Record<string, unknown> & {
  error?: { code: string };
  checkoutSession?: {
    id: string;
    state: string;
    amount: number;
    booking: { reference: string } | null;
    refund: { state: string; amount: number } | null;
  };
  payment?: { provider: string; paymentRef: string; clientSecret: string } | null;
  quote?: { quoteId: string; policy: { version: number }; totals: { total: number } };
  delivery?: { status: number; outcome: string | null; duplicate: boolean | null } | null;
  event?: { id: string; type: string };
  outcome?: string;
  duplicate?: boolean;
};

const env = inject("integrationDb");
const CONSOLE = "https://console.test";
const TEAM = "tidegrid-checkout-test.cloudflareaccess.com";
const AUD = "cd".repeat(32);

describe.skipIf(!env)("checkout to confirmation through the API", () => {
  let admin: Sql;
  let runtime: ReturnType<typeof createDb>;
  let app: ReturnType<typeof createApp>;
  let signingKey: CryptoKey;
  let A: CheckoutFixture & { host: string; owner: string; finance: string };
  let B: CheckoutFixture & { host: string; owner: string; finance: string };
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
    method: string,
    path: string,
    opts: {
      origin?: string;
      as?: string;
      body?: unknown;
      raw?: string;
      headers?: Record<string, string>;
    } = {},
  ) {
    const headers = new Headers(opts.headers);
    if (opts.origin) headers.set("origin", opts.origin);
    if (opts.as) headers.set("cf-access-jwt-assertion", await token(opts.as));
    if (opts.body !== undefined || opts.raw !== undefined) {
      headers.set("content-type", "application/json");
    }
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
    return { status: res.status, headers: res.headers, json: (await res.json()) as Json };
  }

  const guest = (tenant: typeof A) => `https://${tenant.host}`;

  async function quote(tenant: typeof A, tripId: string, party: number) {
    const q = await quoteFor(runtime.db, tenant.id, tripId, party);
    return { quoteId: q.quoteId, policyVersion: q.policy.version, total: q.totals.total };
  }

  async function open(
    tenant: typeof A,
    tripId: string,
    party = 2,
    extra: { key?: string; secret?: string; headers?: Record<string, string> } = {},
  ) {
    const q = await quote(tenant, tripId, party);
    const secret = extra.secret ?? newSecret();
    const key = extra.key ?? `chk-${randomUUID()}`;
    const body = {
      quoteId: q.quoteId,
      acceptedPolicyVersion: q.policyVersion,
      booker: { name: "Api Booker", email: "api.booker@example.test" },
      checkoutSecret: secret,
    };
    const res = await request("POST", "/v1/public/checkout-sessions", {
      origin: guest(tenant),
      body,
      headers: { "idempotency-key": key, ...extra.headers },
    });
    return { ...res, secret, key, body, quote: q };
  }

  const status = (tenant: typeof A, id: string, secret: string) =>
    request("GET", `/v1/public/checkout-sessions/${id}`, {
      origin: guest(tenant),
      headers: { authorization: `Bearer ${secret}` },
    });

  const control = (
    tenant: typeof A,
    paymentRef: string,
    clientSecret: string,
    action: string,
    body?: unknown,
  ) =>
    request("POST", `/v1/fake-provider/payments/${paymentRef}/${action}`, {
      origin: guest(tenant),
      headers: { authorization: `Bearer ${clientSecret}` },
      ...(body === undefined ? {} : { body }),
    });

  async function withAccess(fixture: CheckoutFixture, label: string) {
    const host = `${fixture.slug}.book.example.test`;
    const people = { owner: "owner", finance: "finance" } as const;
    await admin`insert into public.tenant_hostnames (hostname, tenant_id, kind, status, verified_at)
      values (${host}, ${fixture.id}, 'preview', 'active', now())`;
    const emails: Record<string, string> = {};
    for (const [role, name] of Object.entries(people)) {
      const email = `${label}-${name}-${fixture.id.slice(0, 8)}@example.test`;
      const userId = randomUUID();
      await admin`insert into public.staff_users (id, email, display_name)
        values (${userId}, ${email}, ${name})`;
      await admin`insert into public.tenant_memberships (tenant_id, user_id, role, display_name)
        values (${fixture.id}, ${userId}, ${role}, ${name})`;
      emails[role] = email;
    }
    return { ...fixture, host, owner: emails.owner ?? "", finance: emails.finance ?? "" };
  }

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 2, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 2 });
    A = await withAccess(await createCheckoutFixture(admin, runtime.db, "chkapi-a"), "a");
    B = await withAccess(await createCheckoutFixture(admin, runtime.db, "chkapi-b"), "b");
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
    });
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end({ timeout: 5 });
  });

  it("opens a checkout, pays through the fake, and confirms only from the webhook", async () => {
    const tripId = tripsA.shared();
    const opened = await open(A, tripId, 2);
    expect(opened.status).toBe(201);
    expect(opened.headers.get("cache-control")).toBe("no-store");
    const session = opened.json.checkoutSession;
    const payment = opened.json.payment;
    if (!session || !payment) throw new Error(JSON.stringify(opened.json));
    expect(session).toMatchObject({ state: "open", amount: opened.quote.total, booking: null });
    expect(payment).toMatchObject({ provider: "fake" });
    // The response carries no personal data.
    expect(JSON.stringify(opened.json)).not.toContain("api.booker");

    expect((await status(A, session.id, opened.secret)).json.checkoutSession?.state).toBe("open");
    expect(
      (await request("GET", `/v1/public/checkout-sessions/${session.id}`, { origin: guest(A) }))
        .status,
    ).toBe(401);
    expect((await status(A, session.id, newSecret())).status).toBe(404);

    const paid = await control(A, payment.paymentRef, payment.clientSecret, "succeed");
    expect(paid.status).toBe(200);
    expect(paid.json.delivery).toEqual({ status: 200, outcome: "confirmed", duplicate: false });
    const after = await status(A, session.id, opened.secret);
    expect(after.json.checkoutSession?.state).toBe("confirmed");
    expect(after.json.checkoutSession?.booking?.reference).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);

    // Redelivering the same event, and replaying the exact signed request, change nothing.
    const eventId = paid.json.event?.id ?? "";
    const again = await control(
      A,
      payment.paymentRef,
      payment.clientSecret,
      `events/${eventId}/redeliver`,
    );
    expect(again.json.delivery).toEqual({ status: 200, outcome: "confirmed", duplicate: true });
    const [stored] = await admin<{ body: string }[]>`
      select body from public.fake_provider_events where id = ${eventId}`;
    const signature = await signatureHeaderValue(TEST_FAKE_SECRET, Date.now(), stored?.body ?? "");
    for (let i = 0; i < 2; i++) {
      const replay = await request("POST", "/v1/webhooks/payments/fake", {
        raw: stored?.body ?? "",
        headers: { "fake-signature": signature },
      });
      expect(replay.json).toMatchObject({ received: true, duplicate: true, outcome: "confirmed" });
    }
    const [counts] = await admin<{ bookings: number; events: number }[]>`
      select (select count(*)::int from public.bookings where checkout_session_id = ${session.id}) as bookings,
             (select count(*)::int from public.provider_events where event_id = ${eventId}) as events`;
    expect(counts).toEqual({ bookings: 1, events: 1 });
  });

  it("replays a checkout by key, refuses the key with another body, and offers no payment once closed", async () => {
    const opened = await open(A, tripsA.shared(), 1);
    const session = opened.json.checkoutSession;
    if (!session || !opened.json.payment) throw new Error(JSON.stringify(opened.json));
    const replay = await request("POST", "/v1/public/checkout-sessions", {
      origin: guest(A),
      body: opened.body,
      headers: { "idempotency-key": opened.key },
    });
    expect(replay.status).toBe(201);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(replay.json.checkoutSession?.id).toBe(session.id);
    expect(replay.json.payment).toEqual(opened.json.payment);
    const reused = await request("POST", "/v1/public/checkout-sessions", {
      origin: guest(A),
      body: { ...opened.body, checkoutSecret: newSecret() },
      headers: { "idempotency-key": opened.key },
    });
    expect(reused.status).toBe(422);
    expect(reused.json.error?.code).toBe("idempotency_key_reused");

    await control(A, opened.json.payment.paymentRef, opened.json.payment.clientSecret, "succeed");
    const late = await request("POST", "/v1/public/checkout-sessions", {
      origin: guest(A),
      body: opened.body,
      headers: { "idempotency-key": opened.key },
    });
    expect(late.status).toBe(201);
    expect(late.json.payment).toBeNull();
  });

  it("releases the hold on a failed payment, and lets the guest cancel an open checkout", async () => {
    const failing = await open(A, tripsA.shared(), 2);
    const payment = failing.json.payment;
    const session = failing.json.checkoutSession;
    if (!payment || !session) throw new Error("no checkout");
    const failed = await control(A, payment.paymentRef, payment.clientSecret, "fail");
    expect(failed.json.delivery).toMatchObject({ status: 200, outcome: "released" });
    expect((await status(A, session.id, failing.secret)).json.checkoutSession?.state).toBe(
      "failed",
    );
    // A second settle keeps the first outcome.
    const twice = await control(A, payment.paymentRef, payment.clientSecret, "succeed");
    expect(twice.json).toMatchObject({ alreadySettled: true, event: { type: "payment.failed" } });

    const leaving = await open(A, tripsA.shared(), 1);
    const leavingId = leaving.json.checkoutSession?.id ?? "";
    const cancel = () =>
      request("POST", `/v1/public/checkout-sessions/${leavingId}/cancel`, {
        origin: guest(A),
        headers: { authorization: `Bearer ${leaving.secret}` },
      });
    expect((await cancel()).json.checkoutSession?.state).toBe("canceled");
    expect((await cancel()).json.checkoutSession?.state).toBe("canceled");
    const [hold] = await admin<{ state: string }[]>`
      select h.state from public.capacity_holds h
        join public.checkout_sessions s on s.hold_id = h.id where s.id = ${leavingId}`;
    expect(hold?.state).toBe("released");
    const confirmedCancel = await request(
      "POST",
      `/v1/public/checkout-sessions/${session.id}/cancel`,
      { origin: guest(A), headers: { authorization: `Bearer ${failing.secret}` } },
    );
    expect(confirmedCancel.status).toBe(409);
    expect(confirmedCancel.json.error?.code).toBe("checkout_not_cancelable");
  });

  it("refunds a late success that cannot reacquire, and the sweep expires checkouts", async () => {
    const tripId = tripsA.charter();
    const q = await quoteFor(runtime.db, A.id, tripId, 2, { charter: true });
    const secret = newSecret();
    const opened = await request("POST", "/v1/public/checkout-sessions", {
      origin: guest(A),
      body: {
        quoteId: q.quoteId,
        acceptedPolicyVersion: q.policy.version,
        booker: { name: "Late Booker", email: "late@example.test" },
        checkoutSecret: secret,
      },
      headers: { "idempotency-key": `chk-${randomUUID()}` },
    });
    const session = opened.json.checkoutSession;
    const payment = opened.json.payment;
    if (!session || !payment) throw new Error(JSON.stringify(opened.json));
    // Time passes: the checkout and its hold expire, and the cron runs.
    await admin`
      with s as (update public.checkout_sessions set expires_at = now() - interval '1 second'
                  where id = ${session.id} returning hold_id)
      update public.capacity_holds h set expires_at = now() - interval '1 second'
        from s where h.id = s.hold_id`;
    expect((await status(A, session.id, secret)).json.checkoutSession?.state).toBe("expired");
    await runScheduled({ cron: "*/15 * * * *" }, bindings(), { log: () => {} });
    const [swept] = await admin<{ state: string; hold: string }[]>`
      select s.state, h.state as hold from public.checkout_sessions s
        join public.capacity_holds h on h.id = s.hold_id where s.id = ${session.id}`;
    expect(swept).toEqual({ state: "expired", hold: "expired" });
    // Another guest takes the boat; then the first guest's payment succeeds.
    const q2 = await quoteFor(runtime.db, A.id, tripId, 3, { charter: true });
    const other = await request("POST", "/v1/public/checkout-sessions", {
      origin: guest(A),
      body: {
        quoteId: q2.quoteId,
        acceptedPolicyVersion: q2.policy.version,
        booker: { name: "Other Booker", email: "other@example.test" },
        checkoutSecret: newSecret(),
      },
      headers: { "idempotency-key": `chk-${randomUUID()}` },
    });
    expect(other.status).toBe(201);
    const paid = await control(A, payment.paymentRef, payment.clientSecret, "succeed");
    expect(paid.json.delivery).toMatchObject({ status: 200, outcome: "refund_required" });
    const view = (await status(A, session.id, secret)).json.checkoutSession;
    expect(view).toMatchObject({
      state: "unfulfilled",
      booking: null,
      refund: { state: "succeeded", amount: session.amount },
    });
    const exceptions = await request("GET", `/v1/staff/tenants/${A.id}/finalization-exceptions`, {
      as: A.finance,
    });
    expect(exceptions.status).toBe(200);
    expect(
      (exceptions.json.exceptions as { checkoutSessionId: string; reason: string }[]).find(
        (e) => e.checkoutSessionId === session.id,
      ),
    ).toMatchObject({ reason: "no_capacity" });
  });

  it("refuses a checkout for a trip with too few seats, a stale quote, and too many open checkouts", async () => {
    const stale = await quoteFor(runtime.db, A.id, tripsA.shared(), 1, {
      now: new Date(Date.now() - 31 * 60_000),
    });
    const staleRes = await request("POST", "/v1/public/checkout-sessions", {
      origin: guest(A),
      body: {
        quoteId: stale.quoteId,
        acceptedPolicyVersion: stale.policy.version,
        booker: { name: "Stale", email: "stale@example.test" },
        checkoutSecret: newSecret(),
      },
      headers: { "idempotency-key": `chk-${randomUUID()}` },
    });
    expect(staleRes.json.error?.code).toBe("quote_expired");

    // Two seats left when the guest quotes; one goes to another checkout before
    // this guest opens theirs, so the hold re-checks the party and refuses.
    const tripId = tripsA.shared();
    expect((await open(A, tripId, 8)).status).toBe(201);
    const q = await quote(A, tripId, 2);
    expect((await open(A, tripId, 1)).status).toBe(201);
    const tooLate = await request("POST", "/v1/public/checkout-sessions", {
      origin: guest(A),
      body: {
        quoteId: q.quoteId,
        acceptedPolicyVersion: q.policyVersion,
        booker: { name: "Too Late", email: "late@example.test" },
        checkoutSecret: newSecret(),
      },
      headers: { "idempotency-key": `chk-${randomUUID()}` },
    });
    expect(tooLate.status).toBe(409);
    expect(tooLate.json.error?.code).toBe("insufficient_capacity");
    // Nothing was written for it: the quote can still be checked out later.
    const [used] = await admin<{ n: number }[]>`
      select count(*)::int as n from public.checkout_sessions where quote_id = ${q.quoteId}`;
    expect(used?.n).toBe(0);

    const address = `198.51.100.${Math.floor(Math.random() * 200) + 1}`;
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) {
      codes.push(
        (await open(A, tripsA.shared(), 1, { headers: { "cf-connecting-ip": address } })).status,
      );
    }
    expect(codes).toEqual([201, 201, 201, 429]);
  });

  it("keeps every new route inside its tenant", async () => {
    const tripId = tripsA.shared();
    const opened = await open(A, tripId, 1);
    const session = opened.json.checkoutSession;
    const payment = opened.json.payment;
    if (!session || !payment) throw new Error("no checkout");

    // A's quote at B's address, and A's checkout at B's address with A's secret.
    const bQuote = await request("POST", "/v1/public/checkout-sessions", {
      origin: guest(B),
      body: { ...(await open(A, tripsA.shared(), 1)).body, checkoutSecret: newSecret() },
      headers: { "idempotency-key": `chk-${randomUUID()}` },
    });
    expect(bQuote.json.error?.code).toBe("quote_not_found");
    expect((await status(B, session.id, opened.secret)).status).toBe(404);
    const cancelAtB = await request("POST", `/v1/public/checkout-sessions/${session.id}/cancel`, {
      origin: guest(B),
      headers: { authorization: `Bearer ${opened.secret}` },
    });
    expect(cancelAtB.status).toBe(404);
    // A's payment controls at B's address.
    for (const action of ["succeed", "fail"]) {
      expect((await control(B, payment.paymentRef, payment.clientSecret, action)).status).toBe(404);
    }
    expect(
      (
        await request("GET", `/v1/fake-provider/payments/${payment.paymentRef}`, {
          origin: guest(B),
          headers: { authorization: `Bearer ${payment.clientSecret}` },
        })
      ).status,
    ).toBe(404);
    // An event naming B's account but A's payment finds nothing in B and changes nothing in A.
    const [ids] = await admin<{ id: string }[]>`
      select id from public.payments where checkout_session_id = ${session.id}`;
    const crossed = craftedFakeEventBody({
      type: "payment.succeeded",
      accountRef: B.accountRef,
      paymentRef: payment.paymentRef,
      amount: session.amount,
      clientReference: ids?.id ?? null,
    });
    const crossedRes = await request("POST", "/v1/webhooks/payments/fake", {
      raw: crossed,
      headers: {
        "fake-signature": await signatureHeaderValue(TEST_FAKE_SECRET, Date.now(), crossed),
      },
    });
    expect(crossedRes.json).toMatchObject({ received: true, outcome: "unmatched_payment" });
    expect((await status(A, session.id, opened.secret)).json.checkoutSession?.state).toBe("open");

    // Staff of B cannot read A's bookings or exceptions.
    expect(
      (await request("GET", `/v1/staff/tenants/${A.id}/trips/${tripId}/bookings`, { as: B.owner }))
        .status,
    ).toBe(404);
    expect(
      (await request("GET", `/v1/staff/tenants/${A.id}/finalization-exceptions`, { as: B.owner }))
        .status,
    ).toBe(404);
    expect(
      (await request("GET", `/v1/staff/tenants/${B.id}/trips/${tripId}/bookings`, { as: B.owner }))
        .status,
    ).toBe(404);
    // Finance reads exceptions but not bookers' contact details.
    expect(
      (
        await request("GET", `/v1/staff/tenants/${A.id}/trips/${tripId}/bookings`, {
          as: A.finance,
        })
      ).status,
    ).toBe(403);
  });

  it("shows the trip's bookings to its staff and refuses to cancel a booked trip", async () => {
    const tripId = tripsA.shared();
    const opened = await open(A, tripId, 3);
    const payment = opened.json.payment;
    if (!payment) throw new Error("no payment");
    await control(A, payment.paymentRef, payment.clientSecret, "succeed");
    const list = await request("GET", `/v1/staff/tenants/${A.id}/trips/${tripId}/bookings`, {
      as: A.owner,
    });
    expect(list.status).toBe(200);
    expect(list.json.bookings).toEqual([
      expect.objectContaining({
        partySize: 3,
        state: "confirmed",
        booker: { name: "Api Booker", email: "api.booker@example.test" },
        order: expect.objectContaining({ status: "paid", total: opened.quote.total }),
        payment: expect.objectContaining({ provider: "fake", state: "succeeded" }),
      }),
    ]);
    const cancel = await request("POST", `/v1/staff/tenants/${A.id}/trips/${tripId}/sales-state`, {
      as: A.owner,
      origin: CONSOLE,
      body: { to: "canceled", reason: "weather" },
      headers: { "idempotency-key": `trip-${randomUUID()}` },
    });
    expect(cancel.status).toBe(409);
    expect(cancel.json.error?.code).toBe("trip_has_bookings");
  });
});
