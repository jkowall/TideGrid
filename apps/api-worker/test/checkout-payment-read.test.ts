import { createExecutionContext, env } from "cloudflare:test";
import type { CheckoutSessionView } from "@tidegrid/domain-booking";
import type { PaymentProvider } from "@tidegrid/domain-payments";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.ts";
import type { Bindings } from "../src/env.ts";

// The payment read's order (W1-GUEST-API) in the Workers runtime, with no
// database: the bearer secret and the checkout come first, then the
// provider, and only an open checkout within its expiry is answered with a
// client secret. The modules that would reach the database are replaced by
// one in-memory checkout per tenant; `state.log` records what ran. The same
// order over a real database is in
// test-integration/guest-api-followups.integration.test.ts.

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const secretA = "a".repeat(43);
const secretB = "b".repeat(43);
const sessionA = "5d0c4a1e-2b3c-4d5e-8f60-0000000000a1";
const sessionB = "5d0c4a1e-2b3c-4d5e-8f60-0000000000b1";

type Stored = { tenantId: string; secret: string; state: string; lapsed: boolean };

const state = vi.hoisted(() => ({
  checkouts: new Map<string, Stored>(),
  /** Runs inside the provider call, after the provider created the payment. */
  duringCreate: null as null | (() => void),
  /** The provider throws after `duringCreate`, so the payment is unavailable. */
  failCreate: false,
  log: [] as string[],
}));

const view = (id: string, s: Stored): CheckoutSessionView => ({
  id,
  state: (s.lapsed && s.state === "open" ? "expired" : s.state) as CheckoutSessionView["state"],
  quoteId: "5d0c4a1e-2b3c-4d5e-8f60-0000000000c1",
  tripId: "5d0c4a1e-2b3c-4d5e-8f60-0000000000d1",
  partySize: 2,
  amount: 9000,
  currency: "USD",
  expiresAt: "2026-11-08T12:15:00.000Z",
  createdAt: "2026-11-08T12:00:00.000Z",
  booking: s.state === "confirmed" ? { reference: "TG7K2M9Q" } : null,
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
      options: { limit?: boolean },
      run: (trx: unknown, ctx: unknown) => Promise<Record<string, unknown>>,
    ) => {
      const origin = c.req.header("origin");
      const tenantId =
        origin === "https://a.book.example.test"
          ? "11111111-1111-4111-8111-111111111111"
          : origin === "https://b.book.example.test"
            ? "22222222-2222-4222-8222-222222222222"
            : null;
      if (!tenantId) throw new ApiError(404, "tenant_not_found", "No such operator");
      if (options.limit) state.log.push("limit");
      const ctx = { tenantId, actorType: "guest", actorId: null, requestId: "r", sourceIp: null };
      state.log.push("read");
      const body = await run({}, ctx);
      return { body, status: 200, replayed: false, ctx };
    },
  };
});

vi.mock("@tidegrid/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@tidegrid/database")>();
  return {
    ...real,
    inTenantTransaction: async (_db: unknown, _ctx: unknown, fn: (trx: unknown) => unknown) => {
      state.log.push("reread");
      return fn({});
    },
  };
});

vi.mock("@tidegrid/domain-booking", async (importOriginal) => {
  const real = await importOriginal<typeof import("@tidegrid/domain-booking")>();
  const find = (tenantId: string, id: string, secret?: string) => {
    const s = state.checkouts.get(id);
    if (!s || s.tenantId !== tenantId || (secret !== undefined && s.secret !== secret)) return null;
    return s;
  };
  return {
    ...real,
    getCheckoutSession: async (
      _trx: unknown,
      tenantId: string,
      input: { sessionId: string; secret: string },
    ) => {
      const s = find(tenantId, input.sessionId, input.secret);
      return s ? view(input.sessionId, s) : null;
    },
    // As the real one: no payment for a closed or lapsed checkout, else the
    // provider's payment by the row's own key.
    ensureProviderPayment: async (
      _db: unknown,
      provider: PaymentProvider,
      ctx: { tenantId: string },
      sessionId: string,
    ) => {
      state.log.push("ensure");
      const s = find(ctx.tenantId, sessionId);
      if (!s) return { kind: "not_found" };
      if (s.state !== "open" || s.lapsed) {
        return { kind: "not_open", state: s.state === "open" ? "expired" : s.state };
      }
      let created: Awaited<ReturnType<PaymentProvider["createPayment"]>>;
      try {
        created = await provider.createPayment({
          accountRef: "acct_fake_unit",
          amount: 9000,
          currency: "USD",
          idempotencyKey: `pay-${sessionId}`,
          clientReference: sessionId,
        });
      } catch {
        return { kind: "unavailable", reason: "provider_error" };
      }
      return {
        kind: "ready",
        provider: provider.name,
        paymentRef: created.paymentRef,
        clientSecret: created.clientSecret,
      };
    },
  };
});

const clientSecret = "fpay_UNITPAYMENT00000000000_secret_unitunitunitunit";

/** A provider whose payment is created, then `duringCreate` runs before it answers. */
const provider = {
  name: "fake",
  signatureHeader: "tidegrid-fake-signature",
  minimumAmount: () => 50,
  createPayment: async () => {
    state.log.push("provider");
    const hook = state.duringCreate;
    state.duringCreate = null;
    hook?.();
    if (state.failCreate) throw new Error("provider timed out");
    return { paymentRef: "fpay_UNITPAYMENT00000000000", clientSecret };
  },
  retrievePayment: async () => null,
  refundPayment: async () => {
    throw new Error("not in this test");
  },
  verifyWebhook: async () => {
    throw new Error("not in this test");
  },
} as unknown as PaymentProvider;

const withPayments = createApp({ paymentProvider: () => provider });
const withoutPayments = createApp();
/** Payments off unless a test's provider is given; CORS, which reads the database, off. */
const bindings = (): Bindings => {
  const { PAYMENT_PROVIDER: _off, PUBLIC_CORS: _cors, ...rest } = env as Bindings;
  return rest;
};

type Body = {
  error?: { code: string };
  checkoutSession?: { id: string; state: string };
  payment?: { clientSecret: string } | null;
};

async function readPayment(
  app: ReturnType<typeof createApp>,
  id: string,
  secret: string,
  tenant: "a" | "b" = "a",
) {
  const res = await app.request(
    `http://localhost/v1/public/checkout-sessions/${id}/payment`,
    {
      headers: { origin: `https://${tenant}.book.example.test`, authorization: `Bearer ${secret}` },
    },
    bindings(),
    createExecutionContext(),
  );
  const text = await res.text();
  return {
    status: res.status,
    cacheControl: res.headers.get("cache-control"),
    text,
    json: JSON.parse(text) as Body,
  };
}

function reset(stateA: string, lapsed = false) {
  state.checkouts.clear();
  state.checkouts.set(sessionA, { tenantId: A, secret: secretA, state: stateA, lapsed });
  state.checkouts.set(sessionB, { tenantId: B, secret: secretB, state: "open", lapsed: false });
  state.duringCreate = null;
  state.failCreate = false;
  state.log = [];
}

afterEach(() => reset("open"));

describe("a checkout that closes or lapses while the provider is asked", () => {
  for (const [label, close] of [
    ["canceled", (s: Stored) => Object.assign(s, { state: "canceled" })],
    ["confirmed", (s: Stored) => Object.assign(s, { state: "confirmed" })],
    ["expired", (s: Stored) => Object.assign(s, { lapsed: true })],
  ] as const) {
    it(`answers it ${label}, with no client secret`, async () => {
      reset("open");
      state.duringCreate = () => {
        const s = state.checkouts.get(sessionA);
        if (s) close(s);
      };
      const res = await readPayment(withPayments, sessionA, secretA);
      expect(res.status).toBe(200);
      expect(res.cacheControl).toBe("no-store");
      expect(res.text).not.toContain(clientSecret);
      expect(res.json.payment).toBeNull();
      expect(res.json.checkoutSession).toMatchObject({ id: sessionA, state: label });
      // The checkout was read again after the provider answered.
      expect(state.log).toEqual(["limit", "read", "ensure", "provider", "reread"]);
    });
  }

  for (const [label, close] of [
    ["canceled", (s: Stored) => Object.assign(s, { state: "canceled" })],
    ["expired", (s: Stored) => Object.assign(s, { lapsed: true })],
  ] as const) {
    it(`answers it ${label} when the provider then fails, not 503`, async () => {
      reset("open");
      state.failCreate = true;
      state.duringCreate = () => {
        const s = state.checkouts.get(sessionA);
        if (s) close(s);
      };
      const res = await readPayment(withPayments, sessionA, secretA);
      expect(res.status).toBe(200);
      expect(res.json.payment).toBeNull();
      expect(res.json.checkoutSession).toMatchObject({ id: sessionA, state: label });
      expect(state.log).toEqual(["limit", "read", "ensure", "provider", "reread"]);
    });
  }

  it("answers 503 when the provider fails and the checkout is still open", async () => {
    reset("open");
    state.failCreate = true;
    const res = await readPayment(withPayments, sessionA, secretA);
    expect(res.status).toBe(503);
    expect(res.json.error?.code).toBe("payment_provider_unavailable");
    expect(res.text).not.toContain(clientSecret);
  });

  it("answers an open checkout that stays open with its client secret", async () => {
    reset("open");
    const res = await readPayment(withPayments, sessionA, secretA);
    expect(res.status).toBe(200);
    expect(res.json.checkoutSession?.state).toBe("open");
    expect(res.json.payment?.clientSecret).toBe(clientSecret);
  });
});

describe("with payments off", () => {
  it("answers a wrong secret, another checkout, or another operator's the same 404", async () => {
    reset("open");
    for (const [id, secret, tenant] of [
      [sessionA, secretB, "a"],
      [sessionA, "c".repeat(43), "a"],
      ["5d0c4a1e-2b3c-4d5e-8f60-0000000000ff", secretA, "a"],
      [sessionA, secretA, "b"],
      [sessionB, secretB, "a"],
    ] as const) {
      const res = await readPayment(withoutPayments, id, secret, tenant);
      expect({ id, tenant, status: res.status, code: res.json.error?.code }).toEqual({
        id,
        tenant,
        status: 404,
        code: "checkout_not_found",
      });
    }
  });

  for (const [label, stored, lapsed] of [
    ["canceled", "canceled", false],
    ["confirmed", "confirmed", false],
    ["expired", "open", true],
  ] as const) {
    it(`answers a ${label} checkout 200 with no payment and no provider`, async () => {
      reset(stored, lapsed);
      const res = await readPayment(withoutPayments, sessionA, secretA);
      expect(res.status).toBe(200);
      expect(res.cacheControl).toBe("no-store");
      expect(res.json).toMatchObject({
        checkoutSession: { id: sessionA, state: label },
        payment: null,
      });
      expect(state.log).toEqual(["limit", "read"]);
    });
  }

  it("needs the provider only for an open checkout", async () => {
    reset("open");
    const res = await readPayment(withoutPayments, sessionA, secretA);
    expect(res.status).toBe(503);
    expect(res.json.error?.code).toBe("payments_unavailable");
    expect(state.log).toEqual(["limit", "read"]);
  });
});
