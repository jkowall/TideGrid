import { randomUUID } from "node:crypto";
import { ProblemResponse, TripOfferResponse } from "@tidegrid/contracts";
import { createDb, inTenantTransaction } from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import {
  type CheckoutFixture,
  createCheckoutFixture,
  newSecret,
  quoteFor,
  TEST_FAKE_SECRET,
} from "@tidegrid/domain-booking/testing";
import { changeTripSalesState } from "@tidegrid/domain-catalog";
import { systemContext, tripAllocator } from "@tidegrid/domain-inventory/testing";
import type { PaymentProvider } from "@tidegrid/domain-payments";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from "vitest";
import { createApp } from "../src/app.ts";
import type { Bindings } from "../src/env.ts";
import { paymentProvider } from "../src/payments.ts";

/**
 * A seam for the race between the payment read's view and the provider
 * payment: a test can run something just before the route asks for the
 * provider payment. Every other call passes straight through.
 */
const race = vi.hoisted(() => ({
  beforeEnsure: null as null | ((sessionId: string) => Promise<void>),
  /** Runs inside the provider call, after the provider created the payment. */
  duringCreate: null as null | ((paymentId: string) => Promise<void>),
}));
vi.mock("@tidegrid/domain-booking", async (importOriginal) => {
  const original = await importOriginal<typeof import("@tidegrid/domain-booking")>();
  return {
    ...original,
    ensureProviderPayment: async (...args: Parameters<typeof original.ensureProviderPayment>) => {
      const hook = race.beforeEnsure;
      race.beforeEnsure = null;
      if (hook) await hook(args[3]);
      return original.ensureProviderPayment(...args);
    },
  };
});

/**
 * The four guest API follow-ups (W1-GUEST-API) through the API, on a real
 * database as the runtime role: the Bearer read of the payment's client
 * secret, problem details on the guest commands' 409 and 422, the offer of a
 * checkout's trip without its own hold, and the seats left on a capacity
 * refusal. Two tenants, so every changed read is tried from the other one.
 */

type Sql = ReturnType<typeof postgres>;
type Json = Record<string, unknown> & {
  error?: { code: string; message: string };
  checkoutSession?: { id: string; state: string; tripId: string };
  payment?: { provider: string; paymentRef: string; clientSecret: string } | null;
  offer?: { tripId: string };
  problems?: { code: string; subject: string | null }[];
  remaining?: number;
};

const env = inject("integrationDb");

describe.skipIf(!env)("guest API follow-ups through the API", () => {
  let admin: Sql;
  let runtime: ReturnType<typeof createDb>;
  let app: ReturnType<typeof createApp>;
  /** The same app over a provider that runs `race.duringCreate` mid-call. */
  let racing: ReturnType<typeof createApp>;
  let A: CheckoutFixture & { host: string };
  let B: CheckoutFixture & { host: string };
  let tripsA: ReturnType<typeof tripAllocator>;
  let tripsB: ReturnType<typeof tripAllocator>;
  /** Every log line the app wrote during the test. */
  let lines: string[] = [];

  const bindings = (): Bindings => ({
    ENVIRONMENT: "local" as const,
    BUILD_ID: "integration",
    DATABASE_URL: env?.runtimeUrl ?? "",
    ALLOWED_ORIGINS: "https://console.test",
    STAFF_ORIGINS: "https://console.test",
    PAYMENT_PROVIDER: "fake",
    FAKE_PAYMENT_WEBHOOK_SECRET: TEST_FAKE_SECRET,
  });
  const executionCtx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} };

  async function request(
    method: string,
    path: string,
    opts: {
      tenant: { host: string };
      body?: unknown;
      headers?: Record<string, string>;
      via?: ReturnType<typeof createApp> | undefined;
      paymentsOff?: boolean;
    },
  ) {
    const headers = new Headers(opts.headers);
    headers.set("origin", `https://${opts.tenant.host}`);
    if (opts.body !== undefined) headers.set("content-type", "application/json");
    const { PAYMENT_PROVIDER: _off, ...withoutPayments } = bindings();
    const res = await (opts.via ?? app).request(
      `http://localhost${path}`,
      { method, headers, body: opts.body === undefined ? null : JSON.stringify(opts.body) },
      opts.paymentsOff ? withoutPayments : bindings(),
      executionCtx,
    );
    return { status: res.status, headers: res.headers, json: (await res.json()) as Json };
  }

  const bearer = (secret: string) => ({ authorization: `Bearer ${secret}` });

  async function open(
    tenant: typeof A,
    tripId: string,
    party: number,
    charter = false,
    via?: ReturnType<typeof createApp>,
  ) {
    const q = await quoteFor(runtime.db, tenant.id, tripId, party, { charter });
    const secret = newSecret();
    const res = await request("POST", "/v1/public/checkout-sessions", {
      tenant,
      via,
      body: {
        quoteId: q.quoteId,
        acceptedPolicyVersion: q.policy.version,
        booker: { name: "Follow Up", email: "follow.up@example.test" },
        checkoutSecret: secret,
      },
      headers: { "idempotency-key": `chk-${randomUUID()}` },
    });
    return { ...res, secret, quote: q };
  }
  async function opened(tenant: typeof A, tripId: string, party: number, charter = false) {
    const res = await open(tenant, tripId, party, charter);
    const session = res.json.checkoutSession;
    const payment = res.json.payment;
    if (res.status !== 201 || !session || !payment) throw new Error(JSON.stringify(res.json));
    return { session, payment, secret: res.secret };
  }

  const quote = (tenant: typeof A, body: unknown, key = `q-${randomUUID()}`) =>
    request("POST", "/v1/public/quotes", { tenant, body, headers: { "idempotency-key": key } });
  const adults = (tripId: string, quantity: number, extra: Record<string, unknown> = {}) => ({
    tripId,
    party: { kind: "tickets", tickets: [{ code: "adult", quantity }] },
    addOns: [],
    ...extra,
  });
  const paymentRead = (
    tenant: typeof A,
    id: string,
    secret: string,
    opts: { via?: ReturnType<typeof createApp>; paymentsOff?: boolean } = {},
  ) =>
    request("GET", `/v1/public/checkout-sessions/${id}/payment`, {
      tenant,
      headers: bearer(secret),
      ...opts,
    });
  const pay = (tenant: typeof A, payment: { paymentRef: string; clientSecret: string }) =>
    request("POST", `/v1/fake-provider/payments/${payment.paymentRef}/succeed`, {
      tenant,
      headers: bearer(payment.clientSecret),
    });
  /** The checkout whose payment row the provider was asked about. */
  async function checkoutOfPayment(paymentId: string): Promise<string> {
    const [row] = await admin<{ id: string }[]>`
      select checkout_session_id as id from public.payments where id = ${paymentId}`;
    if (!row) throw new Error("no such payment");
    return row.id;
  }
  const lapse = (sessionId: string) =>
    admin`update public.checkout_sessions set expires_at = now() - interval '1 second'
      where id = ${sessionId}`;
  const ownOffer = (tenant: typeof A, id: string, secret: string) =>
    request("GET", `/v1/public/checkout-sessions/${id}/offer`, { tenant, headers: bearer(secret) });
  const publicOffer = (tenant: typeof A, tripId: string) =>
    request("GET", `/v1/public/trips/${tripId}/offer`, { tenant });
  const cancel = (tenant: typeof A, id: string, secret: string) =>
    request("POST", `/v1/public/checkout-sessions/${id}/cancel`, {
      tenant,
      headers: bearer(secret),
    });

  /** A problem body: the old envelope still reads, and the new shape parses. */
  function expectProblem(json: Json, status: number, code: string) {
    expect(json.error?.code).toBe(code);
    const parsed = ProblemResponse.safeParse(json);
    if (!parsed.success) throw new Error(`not a problem body: ${JSON.stringify(json)}`);
    expect(parsed.data).toMatchObject({
      type: "about:blank",
      status,
      code,
      detail: json.error?.message,
    });
    return parsed.data;
  }

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 2, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 2 });
    const withHost = async (fixture: CheckoutFixture) => {
      const host = `${fixture.slug}.book.example.test`;
      await admin`insert into public.tenant_hostnames (hostname, tenant_id, kind, status, verified_at)
        values (${host}, ${fixture.id}, 'preview', 'active', now())`;
      return { ...fixture, host };
    };
    A = await withHost(await createCheckoutFixture(admin, runtime.db, "gfu-a"));
    B = await withHost(await createCheckoutFixture(admin, runtime.db, "gfu-b"));
    tripsA = tripAllocator(A);
    tripsB = tripAllocator(B);
    app = createApp();
    racing = createApp({
      paymentProvider: (db, env): PaymentProvider => {
        const real = paymentProvider(env, db);
        if (!real) throw new Error("the fake provider is not configured");
        return {
          name: real.name,
          signatureHeader: real.signatureHeader,
          minimumAmount: (currency) => real.minimumAmount(currency),
          createPayment: async (input) => {
            const created = await real.createPayment(input);
            const hook = race.duringCreate;
            race.duringCreate = null;
            if (hook) await hook(input.clientReference);
            return created;
          },
          retrievePayment: (input) => real.retrievePayment(input),
          refundPayment: (input) => real.refundPayment(input),
          verifyWebhook: (input) => real.verifyWebhook(input),
        };
      },
    });
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end({ timeout: 5 });
  });

  afterEach(() => {
    race.beforeEnsure = null;
    race.duringCreate = null;
    vi.restoreAllMocks();
    lines = [];
  });
  const captureLogs = () => {
    for (const method of ["log", "info", "warn", "error"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
      });
    }
  };

  describe("1. the Bearer read of the payment's client secret", () => {
    it("returns the same provider payment while open, never cached, and never logs it", async () => {
      captureLogs();
      const { session, payment, secret } = await opened(A, tripsA.shared(), 2);
      const first = await paymentRead(A, session.id, secret);
      expect(first.status).toBe(200);
      expect(first.headers.get("cache-control")).toBe("no-store");
      expect(first.json.payment).toEqual(payment);
      expect(first.json.checkoutSession).toMatchObject({ id: session.id, state: "open" });
      // Read again: still the one payment, not a second.
      const again = await paymentRead(A, session.id, secret);
      expect(again.json.payment).toEqual(payment);
      const [count] = await admin<{ n: number }[]>`
        select count(*)::int as n from public.payments where checkout_session_id = ${session.id}`;
      expect(count?.n).toBe(1);
      // Neither secret reaches a log line.
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line).not.toContain(payment.clientSecret);
        expect(line).not.toContain(secret);
      }
    });

    it("offers no payment once the checkout is closed", async () => {
      const { session, secret } = await opened(A, tripsA.shared(), 1);
      expect((await cancel(A, session.id, secret)).status).toBe(200);
      const read = await paymentRead(A, session.id, secret);
      expect(read.status).toBe(200);
      expect(read.json.payment).toBeNull();
      expect(read.json.checkoutSession?.state).toBe("canceled");
    });

    it("answers the closed state when the checkout closes while the payment is read", async () => {
      const { session, secret } = await opened(A, tripsA.shared(), 1);
      // The view reads open; then the guest cancels in another tab before
      // the route asks for the provider payment.
      race.beforeEnsure = async (id) => {
        expect((await cancel(A, id, secret)).status).toBe(200);
      };
      const canceled = await paymentRead(A, session.id, secret);
      expect(canceled.status).toBe(200);
      expect(canceled.json.payment).toBeNull();
      expect(canceled.json.checkoutSession).toMatchObject({ id: session.id, state: "canceled" });

      // The same when the expiry passes in between.
      const lapsing = await opened(A, tripsA.shared(), 1);
      race.beforeEnsure = async (id) => {
        await admin`update public.checkout_sessions set expires_at = now() - interval '1 second'
          where id = ${id}`;
      };
      const expired = await paymentRead(A, lapsing.session.id, lapsing.secret);
      expect(expired.status).toBe(200);
      expect(expired.json.payment).toBeNull();
      expect(expired.json.checkoutSession).toMatchObject({
        id: lapsing.session.id,
        state: "expired",
      });
    });

    it("never answers a client secret when the checkout closes during the provider call", async () => {
      // Canceled by the guest in another tab while the provider answers.
      const canceling = await opened(A, tripsA.shared(), 1);
      race.duringCreate = async (paymentId) => {
        const id = await checkoutOfPayment(paymentId);
        expect((await cancel(A, id, canceling.secret)).status).toBe(200);
      };
      const canceled = await paymentRead(A, canceling.session.id, canceling.secret, {
        via: racing,
      });
      expect(race.duringCreate).toBeNull();
      expect(canceled.status).toBe(200);
      expect(JSON.stringify(canceled.json)).not.toContain(canceling.payment.clientSecret);
      expect(canceled.json.payment).toBeNull();
      expect(canceled.json.checkoutSession).toMatchObject({
        id: canceling.session.id,
        state: "canceled",
      });

      // Confirmed by the provider's success event while it answers.
      const paying = await opened(A, tripsA.shared(), 1);
      race.duringCreate = async () => {
        const paid = await pay(A, paying.payment);
        expect(paid.json).toMatchObject({ delivery: { outcome: "confirmed" } });
      };
      const confirmed = await paymentRead(A, paying.session.id, paying.secret, { via: racing });
      expect(race.duringCreate).toBeNull();
      expect(confirmed.status).toBe(200);
      expect(JSON.stringify(confirmed.json)).not.toContain(paying.payment.clientSecret);
      expect(confirmed.json.payment).toBeNull();
      expect(confirmed.json.checkoutSession).toMatchObject({
        id: paying.session.id,
        state: "confirmed",
      });

      // Past its expiry by the time the provider answers.
      const lapsing = await opened(A, tripsA.shared(), 1);
      race.duringCreate = async (paymentId) => {
        await lapse(await checkoutOfPayment(paymentId));
      };
      const expired = await paymentRead(A, lapsing.session.id, lapsing.secret, { via: racing });
      expect(race.duringCreate).toBeNull();
      expect(expired.status).toBe(200);
      expect(JSON.stringify(expired.json)).not.toContain(lapsing.payment.clientSecret);
      expect(expired.json.payment).toBeNull();
      expect(expired.json.checkoutSession).toMatchObject({
        id: lapsing.session.id,
        state: "expired",
      });

      // One that stays open still gets its client secret through the same app.
      const staying = await opened(A, tripsA.shared(), 1);
      const open = await paymentRead(A, staying.session.id, staying.secret, { via: racing });
      expect(open.json.payment).toEqual(staying.payment);
    });

    it("never answers a client secret when the checkout lapses while it is opened", async () => {
      race.duringCreate = async (paymentId) => {
        await lapse(await checkoutOfPayment(paymentId));
      };
      const res = await open(A, tripsA.shared(), 1, false, racing);
      expect(race.duringCreate).toBeNull();
      expect(res.status).toBe(201);
      expect(res.json.payment).toBeNull();
      // The create answer is the checkout as it was opened (its contract).
      expect(res.json.checkoutSession?.state).toBe("open");
    });

    it("with payments off, answers every wrong secret 404 and a closed checkout 200", async () => {
      const off = { paymentsOff: true };
      const one = await opened(A, tripsA.shared(), 1);
      const two = await opened(A, tripsA.shared(), 1);
      const theirs = await opened(B, tripsB.shared(), 1);
      for (const [tenant, id, secret] of [
        [A, one.session.id, newSecret()],
        [A, one.session.id, two.secret],
        [A, randomUUID(), one.secret],
        [B, one.session.id, one.secret],
        [A, theirs.session.id, theirs.secret],
      ] as const) {
        const res = await paymentRead(tenant, id, secret, off);
        expect({ status: res.status, code: res.json.error?.code }).toEqual({
          status: 404,
          code: "checkout_not_found",
        });
      }
      // Open: only now is the provider needed.
      const needs = await paymentRead(A, one.session.id, one.secret, off);
      expect(needs.status).toBe(503);
      expect(needs.json.error?.code).toBe("payments_unavailable");

      expect((await cancel(A, one.session.id, one.secret)).status).toBe(200);
      const paid = await pay(A, two.payment);
      expect(paid.json).toMatchObject({ delivery: { outcome: "confirmed" } });
      const lapsing = await opened(A, tripsA.shared(), 1);
      await lapse(lapsing.session.id);
      for (const [o, state] of [
        [one, "canceled"],
        [two, "confirmed"],
        [lapsing, "expired"],
      ] as const) {
        const res = await paymentRead(A, o.session.id, o.secret, off);
        expect(res.status).toBe(200);
        expect(res.headers.get("cache-control")).toBe("no-store");
        expect(res.json.payment).toBeNull();
        expect(res.json.checkoutSession).toMatchObject({ id: o.session.id, state });
      }
    });

    it("answers a wrong secret, another checkout's secret, or no secret as nothing", async () => {
      const one = await opened(A, tripsA.shared(), 1);
      const two = await opened(A, tripsA.shared(), 1);
      expect((await paymentRead(A, one.session.id, newSecret())).status).toBe(404);
      expect((await paymentRead(A, one.session.id, two.secret)).status).toBe(404);
      expect((await paymentRead(A, randomUUID(), one.secret)).status).toBe(404);
      const none = await request("GET", `/v1/public/checkout-sessions/${one.session.id}/payment`, {
        tenant: A,
      });
      expect(none.status).toBe(401);
      // A secret in the URL is never read.
      const inUrl = await request(
        "GET",
        `/v1/public/checkout-sessions/${one.session.id}/payment?checkoutSecret=${one.secret}`,
        { tenant: A },
      );
      expect(inUrl.status).toBe(401);
    });

    it("never crosses tenants", async () => {
      const mine = await opened(A, tripsA.shared(), 1);
      const theirs = await opened(B, tripsB.shared(), 1);
      // A's checkout, with its own secret, from B's site.
      const escaped = await paymentRead(B, mine.session.id, mine.secret);
      expect(escaped.status).toBe(404);
      expect(escaped.json.payment).toBeUndefined();
      expect(JSON.stringify(escaped.json)).not.toContain(mine.payment.clientSecret);
      // And the other way round.
      expect((await paymentRead(A, theirs.session.id, theirs.secret)).status).toBe(404);
      expect((await paymentRead(B, theirs.session.id, theirs.secret)).status).toBe(200);
    });
  });

  describe("2. problem details on the guest commands", () => {
    it("lists every quote problem with its subject, and keeps error.code first", async () => {
      const res = await quote(A, {
        tripId: tripsA.shared(),
        party: {
          kind: "tickets",
          tickets: [
            { code: "senior", quantity: 1 },
            { code: "adult", quantity: 1 },
          ],
        },
        addOns: [{ code: "kayak", quantity: 1 }],
        promotionCode: "NOSUCHCODE",
      });
      expect(res.status).toBe(422);
      const problem = expectProblem(res.json, 422, "unknown_ticket_type");
      expect(problem.title).toBe("Unprocessable Content");
      expect(problem.problems).toEqual([
        { code: "unknown_ticket_type", subject: "senior" },
        { code: "unknown_add_on", subject: "kayak" },
        { code: "promotion_not_applicable", subject: null },
      ]);
      expect(problem.remaining).toBeUndefined();
    });

    it("gives a reused key and a refused checkout the same shape", async () => {
      const tripId = tripsA.shared();
      const key = `q-${randomUUID()}`;
      expect((await quote(A, adults(tripId, 1), key)).status).toBe(201);
      const reused = await quote(A, adults(tripId, 2), key);
      expect(reused.status).toBe(422);
      expectProblem(reused.json, 422, "idempotency_key_reused");

      const q = await quoteFor(runtime.db, A.id, tripsA.shared(), 1);
      const refused = await request("POST", "/v1/public/checkout-sessions", {
        tenant: A,
        body: {
          quoteId: q.quoteId,
          acceptedPolicyVersion: q.policy.version + 1,
          booker: { name: "Follow Up", email: "follow.up@example.test" },
          checkoutSecret: newSecret(),
        },
        headers: { "idempotency-key": `chk-${randomUUID()}` },
      });
      expect(refused.status).toBe(422);
      expect(expectProblem(refused.json, 422, "policy_not_accepted").problems).toEqual([
        { code: "policy_not_accepted", subject: null },
      ]);
    });

    it("gives a trip off sale the same shape, with no count", async () => {
      const tripId = tripsA.late();
      const res = await quote(A, adults(tripId, 1));
      expect(res.status).toBe(409);
      expect(expectProblem(res.json, 409, "trip_not_bookable").remaining).toBeUndefined();
    });
  });

  describe("3. the offer of a checkout's trip, without its own hold", () => {
    it("reads the offer when the guest's own hold took the last seats", async () => {
      const tripId = tripsA.shared();
      const before = await publicOffer(A, tripId);
      expect(before.status).toBe(200);
      const other = await opened(A, tripId, 8);
      const mine = await opened(A, tripId, 2);
      // Sold out to everyone else: the public offer refuses.
      expect((await publicOffer(A, tripId)).status).toBe(409);
      const own = await ownOffer(A, mine.session.id, mine.secret);
      expect(own.status).toBe(200);
      expect(own.headers.get("cache-control")).toBe("no-store");
      expect(TripOfferResponse.safeParse(own.json).success).toBe(true);
      // The same offer the public route gave while the trip was on sale.
      expect(own.json.offer).toEqual(before.json.offer);
      // The other guest's own hold leaves 2 seats: on sale for them too.
      expect((await ownOffer(A, other.session.id, other.secret)).status).toBe(200);
    });

    it("reads the offer of a charter whose whole boat the guest holds", async () => {
      const tripId = tripsA.charter();
      const mine = await opened(A, tripId, 2, true);
      expect((await publicOffer(A, tripId)).status).toBe(409);
      const own = await ownOffer(A, mine.session.id, mine.secret);
      expect(own.status).toBe(200);
      expect(own.json.offer?.tripId).toBe(tripId);
    });

    it("counts the hold again once the checkout is closed, and keeps every other rule", async () => {
      const tripId = tripsA.charter();
      const mine = await opened(A, tripId, 2, true);
      const someone = await opened(A, tripsA.charter(), 2, true);
      // Canceled: nothing is held, so the trip is on sale to everyone again.
      expect((await cancel(A, mine.session.id, mine.secret)).status).toBe(200);
      expect((await ownOffer(A, mine.session.id, mine.secret)).status).toBe(200);
      expect((await publicOffer(A, tripId)).status).toBe(200);
      // A closed trip stays off sale even for the guest who holds it.
      const ctx = systemContext(A.id);
      await inTenantTransaction(runtime.db, ctx, (trx) =>
        changeTripSalesState(trx, ctx, {
          tripId: someone.session.tripId,
          to: "closed",
          reason: "test",
          now: new Date(),
        }),
      );
      const closed = await ownOffer(A, someone.session.id, someone.secret);
      expect(closed.status).toBe(409);
      expect(closed.json.error?.code).toBe("trip_not_bookable");
    });

    it("sets aside only the guest's own hold, and never crosses tenants", async () => {
      const tripId = tripsA.shared();
      const big = await opened(A, tripId, 8);
      const small = await opened(A, tripId, 2);
      // Another checkout's secret reads nothing.
      expect((await ownOffer(A, small.session.id, big.secret)).status).toBe(404);
      expect((await ownOffer(A, small.session.id, newSecret())).status).toBe(404);
      const none = await request("GET", `/v1/public/checkout-sessions/${small.session.id}/offer`, {
        tenant: A,
      });
      expect(none.status).toBe(401);
      // From B's site, A's checkout does not exist, with or without its secret.
      expect((await ownOffer(B, small.session.id, small.secret)).status).toBe(404);
      const theirs = await opened(B, tripsB.charter(), 2, true);
      expect((await ownOffer(A, theirs.session.id, theirs.secret)).status).toBe(404);
      expect((await ownOffer(B, theirs.session.id, theirs.secret)).status).toBe(200);
    });
  });

  describe("4. the seats left on a capacity refusal", () => {
    it("a quote names the count left on the trip it asked about", async () => {
      const tripId = tripsA.shared();
      await opened(A, tripId, 7);
      // A busier trip next to it must not leak into the answer.
      await opened(A, tripsA.shared(), 8);
      const res = await quote(A, adults(tripId, 5));
      expect(res.status).toBe(409);
      const problem = expectProblem(res.json, 409, "insufficient_capacity");
      expect(problem.remaining).toBe(3);
      expect(problem.problems).toEqual([{ code: "insufficient_capacity", subject: null }]);
      // Count only: nothing about the holds behind it.
      expect(Object.keys(problem).sort()).toEqual(
        ["code", "detail", "error", "problems", "remaining", "status", "title", "type"].sort(),
      );
    });

    it("a checkout names the count left when another hold got there first", async () => {
      const tripId = tripsA.shared();
      const q = await quoteFor(runtime.db, A.id, tripId, 5);
      await opened(A, tripId, 7);
      const res = await request("POST", "/v1/public/checkout-sessions", {
        tenant: A,
        body: {
          quoteId: q.quoteId,
          acceptedPolicyVersion: q.policy.version,
          booker: { name: "Follow Up", email: "follow.up@example.test" },
          checkoutSecret: newSecret(),
        },
        headers: { "idempotency-key": `chk-${randomUUID()}` },
      });
      expect(res.status).toBe(409);
      const problem = expectProblem(res.json, 409, "insufficient_capacity");
      expect(problem.remaining).toBe(3);
      // The message still says it, for clients that read the envelope only.
      expect(problem.error.message).toBe("Only 3 seat(s) are left on this trip");
    });

    it("never gives a count for another tenant's trip", async () => {
      const theirs = tripsB.shared();
      await opened(B, theirs, 7);
      const res = await quote(A, adults(theirs, 5));
      expect(res.status).toBe(404);
      expect(res.json.remaining).toBeUndefined();
      expect(res.json.error?.code).toBe("trip_not_found");
    });
  });
});
