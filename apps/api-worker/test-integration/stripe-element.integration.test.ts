/**
 * The guest's card form under Stripe (W1-STRIPE-ELEMENT D2), through the API,
 * against a real database, over the recorded-shape Stripe fixture. No live
 * Stripe call: every Stripe request goes to the fixture's in-memory server,
 * and the real fetch fails the test. Two synthetic tenants, each with a
 * synthetic Stripe connected account written over the admin connection.
 *
 * It proves: the publishable key and the connected account reach only the
 * checkout's holder, through the Bearer payment read, beside the client
 * secret; opening the checkout and reading its state never carry them; each
 * tenant's read names its own account; a wrong secret, another operator, and
 * a closed checkout get neither; a checkout that lapses while its account is
 * read answers its closed state, with neither; and without a valid test-mode
 * key an open checkout answers 503 before Stripe is asked.
 */
import { randomUUID } from "node:crypto";
import { createDb } from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import {
  type CheckoutFixture,
  createCheckoutFixture,
  newSecret,
  quoteFor,
} from "@tidegrid/domain-booking/testing";
import { tripAllocator } from "@tidegrid/domain-inventory/testing";
import { createStripePaymentProvider, type StripePaymentProvider } from "@tidegrid/domain-payments";
import { createStripeFixture, type StripeFixture } from "@tidegrid/domain-payments/testing";
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

// Synthetic, built at run time: never a real key.
const publishableKey = `pk_test_${"E".repeat(32)}`;
// Synthetic accounts of this suite's own: account refs are unique per provider
// across the shared test database, and the webhook suite uses the fixture's.
const accounts = { a: "acct_1TestElementA000", b: "acct_1TestElementB000" } as const;

interface Tenant extends CheckoutFixture {
  host: string;
  stripeAccount: string;
}

describe.skipIf(!env)("the Stripe card form's configuration through the API", () => {
  let admin: Sql;
  let runtime: ReturnType<typeof createDb>;
  let app: ReturnType<typeof createApp>;
  let fixture: StripeFixture;
  let stripe: StripePaymentProvider;
  let A: Tenant;
  let B: Tenant;
  let tripsA: ReturnType<typeof tripAllocator>;
  let tripsB: ReturnType<typeof tripAllocator>;
  let realFetch = 0;
  let stripeCalls = 0;
  /** Runs once, after the fixture answers and before the adapter sees it. */
  let afterStripe: (() => Promise<void>) | null = null;

  const bindings = (key: string | undefined) => ({
    ENVIRONMENT: "local" as const,
    BUILD_ID: "integration",
    DATABASE_URL: env?.runtimeUrl ?? "",
    ALLOWED_ORIGINS: "https://console.test",
    STAFF_ORIGINS: "https://console.test",
    // Stripe is the test's provider override; the configuration names it with
    // no secret key, so nothing else can build one.
    PAYMENT_PROVIDER: "stripe",
    ...(key === undefined ? {} : { STRIPE_PUBLISHABLE_KEY: key }),
  });
  const executionCtx = {
    waitUntil: () => {},
    passThroughOnException: () => {},
    props: {},
  };

  async function request(
    method: string,
    path: string,
    opts: {
      origin: string;
      body?: unknown;
      headers?: Record<string, string>;
      key?: string | undefined;
    },
  ) {
    const headers = new Headers(opts.headers);
    headers.set("origin", opts.origin);
    if (opts.body !== undefined) headers.set("content-type", "application/json");
    const res = await app.request(
      `http://localhost${path}`,
      {
        method,
        headers,
        body: opts.body === undefined ? null : JSON.stringify(opts.body),
      },
      bindings("key" in opts ? opts.key : publishableKey),
      executionCtx,
    );
    const text = await res.text();
    return { status: res.status, json: (text ? JSON.parse(text) : {}) as Json, text };
  }

  const guest = (t: Tenant) => `https://${t.host}`;
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  async function open(t: Tenant, tripId: string) {
    const q = await quoteFor(runtime.db, t.id, tripId, 2);
    const secret = newSecret();
    const res = await request("POST", "/v1/public/checkout-sessions", {
      origin: guest(t),
      headers: { "idempotency-key": `stripe-element-${randomUUID()}` },
      body: {
        quoteId: q.quoteId,
        acceptedPolicyVersion: q.policy.version,
        booker: { name: "Synthetic Element Booker", email: "synthetic.element@example.test" },
        checkoutSecret: secret,
      },
    });
    if (res.status !== 201 || !res.json.payment) throw new Error(`open: ${res.status} ${res.text}`);
    return { id: res.json.checkoutSession.id as string, secret, opened: res };
  }

  const readPayment = (t: Tenant, id: string, secret: string, key?: string | null) =>
    request("GET", `/v1/public/checkout-sessions/${id}/payment`, {
      origin: guest(t),
      headers: bearer(secret),
      ...(key === null ? { key: undefined } : key === undefined ? {} : { key }),
    });

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 3, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 8 });
    fixture = createStripeFixture({ accounts: Object.values(accounts) });
    // Counts every call the adapter makes to the fixture's server. Each
    // fixture numbers its intents from 1, and the webhook suite's fixture
    // shares this database, where (provider, provider_payment_id) is unique:
    // so this suite's intent ids read pi_TestFixture9..., never ...0..., on
    // the way out, and back again on the way in.
    const ours = "pi_TestFixture9";
    const theirs = "pi_TestFixture0";
    const counted: typeof fetch = async (input, init) => {
      stripeCalls += 1;
      const url = (input instanceof Request ? input.url : String(input)).replaceAll(ours, theirs);
      const body = typeof init?.body === "string" ? init.body.replaceAll(ours, theirs) : init?.body;
      const res = await fixture.fetch(url, { ...init, body: body ?? null });
      const text = (await res.text()).replaceAll(theirs, ours);
      const hook = afterStripe;
      afterStripe = null;
      await hook?.();
      return new Response(text, { status: res.status, headers: res.headers });
    };
    stripe = createStripePaymentProvider({
      secretKey: fixture.secretKey,
      webhookSecret: fixture.webhookSecret,
      environment: "local",
      fetch: counted,
    });
    const made: Tenant[] = [];
    for (const [label, account] of [
      ["element-a", accounts.a],
      ["element-b", accounts.b],
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
    tripsB = tripAllocator(B);
    app = createApp({ deliverEmailAfterCommit: false, paymentProvider: () => stripe });
  });

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    realFetch = 0;
    vi.stubGlobal("fetch", async () => {
      realFetch += 1;
      throw new Error("the real fetch was reached");
    });
  });

  afterEach(() => {
    afterStripe = null;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    expect(realFetch).toBe(0);
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end({ timeout: 5 });
  });

  it("gives the key and the payment's own account only through the Bearer read", async () => {
    const { id, secret, opened } = await open(A, tripsA.shared());
    // Opening answers the client secret, as before, but never the key or account.
    expect(opened.json.payment.provider).toBe("stripe");
    expect(opened.json.payment).not.toHaveProperty("stripe");
    expect(opened.text).not.toContain(publishableKey);
    expect(opened.text).not.toContain(A.stripeAccount);

    const read = await readPayment(A, id, secret);
    expect(read.status).toBe(200);
    expect(read.json.checkoutSession).toMatchObject({ id, state: "open" });
    expect(read.json.payment).toEqual({
      provider: "stripe",
      paymentRef: opened.json.payment.paymentRef,
      clientSecret: opened.json.payment.clientSecret,
      stripe: { publishableKey, account: A.stripeAccount },
    });
    expect(read.json.payment.clientSecret).toMatch(
      new RegExp(`^${opened.json.payment.paymentRef}_secret_`),
    );

    // The checkout's own state never carries them.
    const state = await request("GET", `/v1/public/checkout-sessions/${id}`, {
      origin: guest(A),
      headers: bearer(secret),
    });
    expect(state.status).toBe(200);
    expect(state.text).not.toContain(publishableKey);
    expect(state.text).not.toContain(A.stripeAccount);
  });

  it("names each operator's own connected account", async () => {
    const b = await open(B, tripsB.shared());
    const read = await readPayment(B, b.id, b.secret);
    expect(read.status).toBe(200);
    expect(read.json.payment.stripe).toEqual({ publishableKey, account: B.stripeAccount });
    expect(read.text).not.toContain(A.stripeAccount);
  });

  it("answers a wrong secret and another operator the same 404, with nothing to pay with", async () => {
    const a = await open(A, tripsA.shared());
    for (const res of [
      await readPayment(A, a.id, newSecret()),
      await readPayment(B, a.id, a.secret),
    ]) {
      expect(res.status).toBe(404);
      expect(res.json.error.code).toBe("checkout_not_found");
      expect(res.text).not.toContain(publishableKey);
      expect(res.text).not.toContain("_secret_");
    }
  });

  it("gives a canceled checkout no client secret, key, or account", async () => {
    const a = await open(A, tripsA.shared());
    const canceled = await request("POST", `/v1/public/checkout-sessions/${a.id}/cancel`, {
      origin: guest(A),
      headers: bearer(a.secret),
    });
    expect(canceled.status).toBe(200);
    const read = await readPayment(A, a.id, a.secret);
    expect(read.status).toBe(200);
    expect(read.json).toMatchObject({ checkoutSession: { state: "canceled" }, payment: null });
    expect(read.text).not.toContain(publishableKey);
    expect(read.text).not.toContain(A.stripeAccount);
  });

  it("answers the closed state when the checkout lapses while its account is read", async () => {
    const a = await open(A, tripsA.shared());
    // The first runtime query left waiting on a lock, other than this one.
    const firstWaiting = async () => {
      for (let i = 0; i < 200; i += 1) {
        const [row] = await admin<{ query: string }[]>`
          select query from pg_stat_activity
           where wait_event_type = 'Lock' and datname = current_database()
             and pid <> pg_backend_pid()
           limit 1`;
        if (row) return row.query;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error("no query waited on the payments lock");
    };
    // Once Stripe has answered the read, hold every read of payments behind
    // a lock. The first one to wait must be the account lookup. Lapse the
    // checkout while it waits, so the read after it finds the closed state.
    let held: Promise<string> | undefined;
    afterStripe = async () => {
      let locked: () => void = () => {};
      const isLocked = new Promise<void>((resolve) => {
        locked = resolve;
      });
      held = admin.begin(async (tx) => {
        await tx`lock table public.payments in access exclusive mode`;
        locked();
        const waiting = await firstWaiting();
        if (/account_ref/.test(waiting) && !/checkout_sessions/.test(waiting)) {
          await tx`update public.checkout_sessions set expires_at = now() - interval '1 second'
                    where id = ${a.id}`;
        }
        return waiting;
      });
      await isLocked;
    };
    const read = await readPayment(A, a.id, a.secret);
    const waiting = await held;
    expect(waiting).toMatch(/account_ref/);
    expect(waiting).not.toMatch(/checkout_sessions/);
    expect(read.status).toBe(200);
    expect(read.json).toMatchObject({ checkoutSession: { state: "expired" }, payment: null });
    expect(read.text).not.toContain("_secret_");
    expect(read.text).not.toContain(publishableKey);
    expect(read.text).not.toContain(A.stripeAccount);
  });

  it("answers 503 without a valid test-mode key, before Stripe is asked", async () => {
    const a = await open(A, tripsA.shared());
    for (const key of [null, `pk_live_${"E".repeat(32)}`, "pk_test_short"]) {
      const before = stripeCalls;
      const read = await readPayment(A, a.id, a.secret, key);
      expect(read.status).toBe(503);
      expect(read.json.error.code).toBe("payments_unavailable");
      expect(read.text).not.toContain("_secret_");
      expect(stripeCalls).toBe(before);
    }
    // With the key back, the same checkout pays as before.
    const read = await readPayment(A, a.id, a.secret);
    expect(read.status).toBe(200);
    expect(read.json.payment.stripe.account).toBe(A.stripeAccount);
  });
});
