import { createExecutionContext, env } from "cloudflare:test";
import { StripePaymentProvider, signatureHeaderValue } from "@tidegrid/domain-payments";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import example from "../.dev.vars.example?raw";
import { createApp } from "../src/app.ts";
import type { Bindings } from "../src/env.ts";
import { markConsoleGateway } from "../src/gateway.ts";
import { paymentProvider, paymentSettings } from "../src/payments.ts";

// The Stripe adapter's configuration in the Workers runtime, with no database:
// everything here is decided before any database is reached. No test here
// reaches Stripe: a configured adapter is built, never called, and the global
// fetch fails the test if anything reaches it.

const keyOf = (...parts: string[]) => parts.join("_");
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
/** Letters and digits, random per run, so no committed value passes the key checks. */
const randomTail = (length = 32) =>
  Array.from(crypto.getRandomValues(new Uint8Array(length)), (b) => alphabet[b % 62]).join("");
const secretKey = keyOf("sk", "test", randomTail());
const webhookSecret = keyOf("whsec", randomTail());
const app = createApp();

let realFetchCalls = 0;
beforeEach(() => {
  realFetchCalls = 0;
  vi.stubGlobal("fetch", async () => {
    realFetchCalls += 1;
    throw new Error("the real fetch was reached");
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  expect(realFetchCalls).toBe(0);
});

const stripeEnv = (overrides: Partial<Bindings> = {}): Bindings => ({
  ...(env as Bindings),
  PAYMENT_PROVIDER: "stripe",
  STRIPE_SECRET_KEY: secretKey,
  STRIPE_WEBHOOK_SECRET: webhookSecret,
  STAFF_ORIGINS: "https://console.test",
  ...overrides,
});

async function call(path: string, init: RequestInit, bindings: Bindings) {
  const res = await app.request(
    `http://localhost${path}`,
    init,
    bindings,
    createExecutionContext(),
  );
  const json = (await res.json()) as { error?: { code: string } };
  return { status: res.status, code: json.error?.code };
}

/** The commented placeholder for one name in .dev.vars.example. */
function placeholder(name: string): string {
  const line = example.split("\n").find((l) => l.startsWith(`# ${name}=`));
  if (!line) throw new Error(`.dev.vars.example has no placeholder for ${name}`);
  return line.slice(`# ${name}=`.length).trim();
}

describe("Stripe payment settings", () => {
  it("reports every branch", () => {
    const { STRIPE_SECRET_KEY: _k, STRIPE_WEBHOOK_SECRET: _w, ...bare } = stripeEnv();
    expect(paymentSettings(stripeEnv())).toEqual({ kind: "stripe", secretKey, webhookSecret });
    expect(paymentSettings(bare)).toEqual({ kind: "off", reason: "stripe_key_missing" });
    expect(paymentSettings({ ...bare, STRIPE_SECRET_KEY: secretKey })).toEqual({
      kind: "off",
      reason: "stripe_webhook_secret_missing",
    });
    for (const prefix of ["sk", "rk", "pk"]) {
      const live = keyOf(prefix, "live", "LiveLiveLiveLiveLiveLive00");
      for (const environment of ["local", "preview", "staging", "production"] as const) {
        expect(
          paymentSettings(stripeEnv({ STRIPE_SECRET_KEY: live, ENVIRONMENT: environment })),
        ).toEqual({ kind: "refused", reason: "live_key" });
      }
    }
    expect(paymentSettings(stripeEnv({ STRIPE_SECRET_KEY: keyOf("sk", "test", "short") }))).toEqual(
      { kind: "refused", reason: "key_malformed" },
    );
    expect(paymentSettings(stripeEnv({ ENVIRONMENT: "production" }))).toEqual({
      kind: "refused",
      reason: "stripe_test_in_production",
    });
    expect(paymentSettings(stripeEnv({ STRIPE_WEBHOOK_SECRET: "whsec_short" }))).toEqual({
      kind: "refused",
      reason: "webhook_secret_malformed",
    });
    for (const environment of ["local", "preview", "staging"] as const) {
      expect(paymentSettings(stripeEnv({ ENVIRONMENT: environment })).kind).toBe("stripe");
    }
  });

  it("fails closed on an unset or unknown ENVIRONMENT, for Stripe and the fake", () => {
    const { ENVIRONMENT: _e, ...unset } = stripeEnv();
    const fake = {
      ...unset,
      PAYMENT_PROVIDER: "fake",
      FAKE_PAYMENT_WEBHOOK_SECRET: "workers-test-fake-provider-secret-0123456789",
    };
    const refused = { kind: "refused", reason: "environment_unknown" };
    expect(paymentSettings(unset as Bindings)).toEqual(refused);
    expect(paymentSettings(fake as Bindings)).toEqual(refused);
    for (const environment of ["prod", "Production", "production ", "", "dev"]) {
      const bindings = { ENVIRONMENT: environment } as unknown as Partial<Bindings>;
      expect(paymentSettings(stripeEnv(bindings)), environment).toEqual(refused);
      expect(paymentSettings({ ...fake, ...bindings } as Bindings), environment).toEqual(refused);
    }
    expect(
      paymentProvider(unset as Bindings, () => {
        throw new Error("the database was opened");
      }),
    ).toBeNull();
  });

  it("refuses the placeholders in .dev.vars.example", () => {
    const key = placeholder("STRIPE_SECRET_KEY");
    const secret = placeholder("STRIPE_WEBHOOK_SECRET");
    expect(paymentSettings(stripeEnv({ STRIPE_SECRET_KEY: key }))).toEqual({
      kind: "refused",
      reason: "key_malformed",
    });
    expect(paymentSettings(stripeEnv({ STRIPE_WEBHOOK_SECRET: secret }))).toEqual({
      kind: "refused",
      reason: "webhook_secret_malformed",
    });
    expect(
      paymentSettings(stripeEnv({ STRIPE_SECRET_KEY: key, STRIPE_WEBHOOK_SECRET: secret })).kind,
    ).toBe("refused");
    // Commented out, so a copied example never selects Stripe at all.
    expect(example).not.toMatch(/^STRIPE_/m);
    expect(example).not.toMatch(/^PAYMENT_PROVIDER=stripe/m);
  });

  it("builds the Stripe adapter only from a valid configuration", () => {
    const db = () => {
      throw new Error("the database was opened");
    };
    expect(paymentProvider(stripeEnv(), db)).toBeInstanceOf(StripePaymentProvider);
    expect(paymentProvider(stripeEnv(), db)?.name).toBe("stripe");
    expect(paymentProvider(stripeEnv({ ENVIRONMENT: "production" }), db)).toBeNull();
    expect(
      paymentProvider(stripeEnv({ STRIPE_SECRET_KEY: keyOf("rk", "live", "LiveLiveLive0") }), db),
    ).toBeNull();
    const { STRIPE_WEBHOOK_SECRET: _w, ...noSecret } = stripeEnv();
    expect(paymentProvider(noSecret, db)).toBeNull();
  });

  it("keeps Stripe off in every deployed and test configuration", () => {
    // The unit tests run the wrangler "test" environment, which sets nothing.
    expect((env as Bindings).PAYMENT_PROVIDER).toBeUndefined();
    expect((env as Bindings).STRIPE_SECRET_KEY).toBeUndefined();
    expect((env as Bindings).STRIPE_WEBHOOK_SECRET).toBeUndefined();
  });
});

describe("routes under PAYMENT_PROVIDER=stripe", () => {
  it("answers 404 for the fake provider's controls", async () => {
    for (const [path, method] of [
      ["/v1/fake-provider/payments/fpay_ABCDEFGHIJKLMNOPQRSTUVWX", "GET"],
      ["/v1/fake-provider/payments/fpay_ABCDEFGHIJKLMNOPQRSTUVWX/succeed", "POST"],
      ["/v1/fake-provider/payments/fpay_ABCDEFGHIJKLMNOPQRSTUVWX/fail", "POST"],
    ] as const) {
      expect(
        await call(path, { method, headers: { origin: "https://guest.test" } }, stripeEnv()),
      ).toEqual({ status: 404, code: "not_found" });
    }
  });

  it("answers 404 for the staff test payment, which stays on the shim (D9)", async () => {
    const path =
      "/v1/staff/tenants/0b7f3a52-9c1e-4d2a-8f6b-1e2d3c4b5a69/checkouts/1c8f3a52-9c1e-4d2a-8f6b-1e2d3c4b5a69/test-payment";
    const init = {
      method: "POST",
      headers: {
        origin: "https://console.test",
        "content-type": "application/json",
        "idempotency-key": "staff-test-payment-0001",
      },
      body: JSON.stringify({ outcome: "succeed" }),
    };
    // Through the console gateway, so only the provider decides; nothing is authenticated yet.
    expect(await call(path, init, markConsoleGateway(stripeEnv()))).toEqual({
      status: 404,
      code: "not_found",
    });
  });

  it("verifies a Stripe webhook before reaching the database", async () => {
    const now = Date.now();
    const event = {
      id: "evt_1SettingsTest0000000001",
      object: "event",
      account: "acct_1TestHarbor0000",
      api_version: "2026-09-30.endive",
      created: Math.floor(now / 1000),
      data: { object: { id: "ch_1SettingsTest0000000001", object: "charge" } },
      livemode: false,
      pending_webhooks: 1,
      request: { id: null, idempotency_key: null },
      type: "charge.succeeded",
    };
    const post = async (body: string, headers: Record<string, string>, provider = "stripe") =>
      call(`/v1/webhooks/payments/${provider}`, { method: "POST", headers, body }, stripeEnv());
    const body = JSON.stringify(event);
    const signed = await signatureHeaderValue(webhookSecret, now, body);
    // The fake's route does not exist here.
    expect(await post(body, { "fake-signature": signed }, "fake")).toEqual({
      status: 404,
      code: "not_found",
    });
    expect(await post(body, {})).toEqual({ status: 400, code: "signature_invalid" });
    expect(
      await post(body, {
        "stripe-signature": await signatureHeaderValue(`${webhookSecret}x`, now, body),
      }),
    ).toEqual({ status: 400, code: "signature_invalid" });
    const live = JSON.stringify({ ...event, livemode: true });
    expect(
      await post(live, {
        "stripe-signature": await signatureHeaderValue(webhookSecret, now, live),
      }),
    ).toEqual({ status: 400, code: "payload_invalid" });
    // A verified event goes on to the database, which this suite leaves unconfigured.
    expect(await post(body, { "stripe-signature": signed })).toEqual({
      status: 503,
      code: "database_unconfigured",
    });
  });
});
