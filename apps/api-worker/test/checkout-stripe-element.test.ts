import { createExecutionContext, env } from "cloudflare:test";
import type { CheckoutSessionView } from "@tidegrid/domain-booking";
import type { PaymentProvider } from "@tidegrid/domain-payments";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.ts";
import type { Bindings } from "../src/env.ts";

// The payment read under Stripe (W1-STRIPE-ELEMENT) in the Workers runtime,
// with no database and no Stripe: the publishable key and the connected
// account go out only beside a client secret, to the checkout's holder, and
// never without a valid test-mode key. The modules that would reach the
// database are replaced by one in-memory checkout; `state.log` records what
// ran. The same read over a real database and the Stripe fixture is in
// test-integration/stripe-element.integration.test.ts.

const A = "11111111-1111-4111-8111-111111111111";
const secretA = "a".repeat(43);
const sessionA = "5d0c4a1e-2b3c-4d5e-8f60-0000000000a1";
// Synthetic, built at run time: never a real key.
const testKey = `pk_test_${"S".repeat(30)}`;
const liveKey = `pk_live_${"S".repeat(30)}`;
const account = "acct_1TestHarbor0000";
const clientSecret = `pi_UNIT0000000000000000_secret_${"u".repeat(24)}`;

const state = vi.hoisted(() => ({
  open: true,
  /** The payment row's account, as the database would answer it. */
  account: "acct_1TestHarbor0000" as string | null,
  /** Runs while the account is read, as a close racing the lookup would. */
  duringAccount: null as (() => void) | null,
  log: [] as string[],
}));

const view = (): CheckoutSessionView => ({
  id: sessionA,
  state: state.open ? "open" : "canceled",
  quoteId: "5d0c4a1e-2b3c-4d5e-8f60-0000000000c1",
  tripId: "5d0c4a1e-2b3c-4d5e-8f60-0000000000d1",
  partySize: 2,
  amount: 9000,
  currency: "USD",
  expiresAt: "2026-11-08T12:15:00.000Z",
  createdAt: "2026-11-08T12:00:00.000Z",
  booking: null,
  refund: null,
});

vi.mock("../src/db.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/db.ts")>();
  return { ...real, getDb: () => ({}) as never };
});

vi.mock("../src/public-tenant.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/public-tenant.ts")>();
  const { ApiError } = await import("../src/errors.ts");
  return {
    ...real,
    withPublicTenant: async (
      c: { req: { header: (name: string) => string | undefined } },
      _options: unknown,
      run: (trx: unknown, ctx: unknown) => Promise<Record<string, unknown>>,
    ) => {
      if (c.req.header("origin") !== "https://a.book.example.test") {
        throw new ApiError(404, "tenant_not_found", "No such operator");
      }
      const ctx = {
        tenantId: A,
        actorType: "guest",
        actorId: null,
        requestId: "r",
        sourceIp: null,
      };
      state.log.push("read");
      const body = await run({}, ctx);
      return { body, status: 200, replayed: false, ctx };
    },
  };
});

vi.mock("@tidegrid/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@tidegrid/database")>();
  // A transaction whose one query is the payment row's account.
  const trx = {
    selectFrom: (table: string) => {
      const where: unknown[][] = [];
      const query = {
        select: () => query,
        where: (...args: unknown[]) => {
          where.push(args);
          return query;
        },
        executeTakeFirst: async () => {
          state.log.push(`account:${table}`);
          expect(where).toContainEqual(["tenant_id", "=", A]);
          expect(where).toContainEqual(["checkout_session_id", "=", sessionA]);
          expect(where).toContainEqual(["provider", "=", "stripe"]);
          state.duringAccount?.();
          return state.account === null ? undefined : { account_ref: state.account };
        },
      };
      return query;
    },
  };
  return {
    ...real,
    inTenantTransaction: async (_db: unknown, _ctx: unknown, fn: (trx: unknown) => unknown) => {
      state.log.push("tx");
      return fn(trx);
    },
  };
});

vi.mock("@tidegrid/domain-booking", async (importOriginal) => {
  const real = await importOriginal<typeof import("@tidegrid/domain-booking")>();
  return {
    ...real,
    getCheckoutSession: async (_trx: unknown, tenantId: string, input: { secret: string }) =>
      tenantId === A && input.secret === secretA ? view() : null,
    ensureProviderPayment: async (_db: unknown, provider: PaymentProvider) => {
      state.log.push("ensure");
      if (!state.open) return { kind: "not_open", state: "canceled" };
      const created = await provider.createPayment({
        accountRef: account,
        amount: 9000,
        currency: "USD",
        idempotencyKey: `pay-${sessionA}`,
        clientReference: sessionA,
      });
      return {
        kind: "ready",
        provider: provider.name,
        paymentRef: created.paymentRef,
        clientSecret: created.clientSecret,
      };
    },
  };
});

const providerNamed = (name: "stripe" | "fake") =>
  ({
    name,
    signatureHeader: "stripe-signature",
    minimumAmount: () => 50,
    createPayment: async () => {
      state.log.push("provider");
      return { paymentRef: "pi_UNIT0000000000000000", clientSecret };
    },
    retrievePayment: async () => null,
    refundPayment: async () => {
      throw new Error("not in this test");
    },
    verifyWebhook: async () => {
      throw new Error("not in this test");
    },
  }) as unknown as PaymentProvider;

const underStripe = createApp({ paymentProvider: () => providerNamed("stripe") });
const underFake = createApp({ paymentProvider: () => providerNamed("fake") });

const bindings = (overrides: Partial<Bindings>): Bindings => {
  const { PAYMENT_PROVIDER: _off, PUBLIC_CORS: _cors, ...rest } = env as Bindings;
  return { ...rest, ENVIRONMENT: "local", ...overrides };
};

type Body = {
  error?: { code: string };
  checkoutSession?: { state: string };
  payment?: {
    provider: string;
    clientSecret: string;
    stripe?: { publishableKey: string; account: string };
  } | null;
};

async function readPayment(
  app: ReturnType<typeof createApp>,
  overrides: Partial<Bindings>,
  secret = secretA,
) {
  const res = await app.request(
    `http://localhost/v1/public/checkout-sessions/${sessionA}/payment`,
    {
      headers: { origin: "https://a.book.example.test", authorization: `Bearer ${secret}` },
    },
    bindings(overrides),
    createExecutionContext(),
  );
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text) as Body };
}

afterEach(() => {
  state.open = true;
  state.account = account;
  state.duringAccount = null;
  state.log = [];
});

describe("the payment read under Stripe (W1-STRIPE-ELEMENT)", () => {
  it("returns the publishable key and the payment's account beside the client secret", async () => {
    const res = await readPayment(underStripe, { STRIPE_PUBLISHABLE_KEY: testKey });
    expect(res.status).toBe(200);
    expect(res.json.payment).toEqual({
      provider: "stripe",
      paymentRef: "pi_UNIT0000000000000000",
      clientSecret,
      stripe: { publishableKey: testKey, account },
    });
    // The account is read before the checkout is read again, under the
    // tenant, so the last read decides whether a client secret goes out.
    expect(state.log).toEqual(["read", "ensure", "provider", "tx", "account:payments", "tx"]);
  });

  it("answers the closed state when the checkout closes while the account is read", async () => {
    state.duringAccount = () => {
      state.open = false;
    };
    const res = await readPayment(underStripe, { STRIPE_PUBLISHABLE_KEY: testKey });
    expect(res.status).toBe(200);
    expect(res.json.checkoutSession?.state).toBe("canceled");
    expect(res.json.payment).toBeNull();
    expect(res.text).not.toContain(clientSecret);
    expect(res.text).not.toContain(testKey);
    expect(res.text).not.toContain(account);
  });

  for (const [label, stored] of [
    ["no payment row", null],
    ["a malformed account", "acct_fake_demo-harbor"],
  ] as const) {
    it(`answers a checkout that closes while the account is read with its closed state, even with ${label}`, async () => {
      state.account = stored;
      state.duringAccount = () => {
        state.open = false;
      };
      const res = await readPayment(underStripe, { STRIPE_PUBLISHABLE_KEY: testKey });
      expect(res.status).toBe(200);
      expect(res.json.checkoutSession?.state).toBe("canceled");
      expect(res.json.payment).toBeNull();
      expect(res.text).not.toContain(clientSecret);
      expect(res.text).not.toContain(testKey);
    });
  }

  for (const [label, overrides] of [
    ["no key", {}],
    ["a live key", { STRIPE_PUBLISHABLE_KEY: liveKey }],
    ["a secret key in its place", { STRIPE_PUBLISHABLE_KEY: `sk_test_${"S".repeat(30)}` }],
    ["a short key", { STRIPE_PUBLISHABLE_KEY: "pk_test_short" }],
    ["a key with a newline", { STRIPE_PUBLISHABLE_KEY: `${testKey}\n` }],
    ["production", { STRIPE_PUBLISHABLE_KEY: testKey, ENVIRONMENT: "production" as const }],
    [
      "an unknown environment",
      { STRIPE_PUBLISHABLE_KEY: testKey, ENVIRONMENT: "prod" as Bindings["ENVIRONMENT"] },
    ],
  ] as const) {
    it(`answers 503 with ${label}, before the provider is asked`, async () => {
      const res = await readPayment(underStripe, overrides);
      expect(res.status).toBe(503);
      expect(res.json.error?.code).toBe("payments_unavailable");
      expect(res.text).not.toContain(clientSecret);
      expect(res.text).not.toMatch(/pk_(test|live)_/);
      expect(state.log).toEqual(["read"]);
    });
  }

  for (const [label, stored] of [
    ["no payment row", null],
    ["a malformed account", "acct_fake_demo-harbor"],
  ] as const) {
    it(`answers 503 for ${label}, with neither secret nor key`, async () => {
      state.account = stored;
      const res = await readPayment(underStripe, { STRIPE_PUBLISHABLE_KEY: testKey });
      expect(res.status).toBe(503);
      expect(res.json.error?.code).toBe("payments_unavailable");
      expect(res.text).not.toContain(clientSecret);
      expect(res.text).not.toContain(testKey);
    });
  }

  it("answers a closed checkout with no payment, key, or account", async () => {
    state.open = false;
    const res = await readPayment(underStripe, { STRIPE_PUBLISHABLE_KEY: testKey });
    expect(res.status).toBe(200);
    expect(res.json.payment).toBeNull();
    expect(res.text).not.toContain(testKey);
    expect(res.text).not.toContain(account);
  });

  it("answers a wrong secret 404, with no key", async () => {
    const res = await readPayment(underStripe, { STRIPE_PUBLISHABLE_KEY: testKey }, "c".repeat(43));
    expect(res.status).toBe(404);
    expect(res.text).not.toContain(testKey);
    expect(state.log).toEqual(["read"]);
  });

  it("never adds the Stripe fields under the fake provider, even with a key set", async () => {
    const res = await readPayment(underFake, { STRIPE_PUBLISHABLE_KEY: testKey });
    expect(res.status).toBe(200);
    expect(res.json.payment?.provider).toBe("fake");
    expect(res.json.payment).not.toHaveProperty("stripe");
    expect(res.text).not.toContain(testKey);
    expect(state.log).not.toContain("account:payments");
  });
});
