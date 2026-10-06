import { createExecutionContext, env, SELF } from "cloudflare:test";
import { signatureHeaderValue } from "@tidegrid/domain-payments";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import type { Bindings } from "../src/env.ts";
import { paymentSettings } from "../src/payments.ts";

// Payments in the Workers runtime, with no database configured: everything
// here must be decided before any database is reached.

const secret = "workers-test-fake-provider-secret-0123456789";
const app = createApp();
const fakeEnv = (overrides: Partial<Bindings> = {}): Bindings => ({
  ...(env as Bindings),
  PAYMENT_PROVIDER: "fake",
  FAKE_PAYMENT_WEBHOOK_SECRET: secret,
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

const eventBody = JSON.stringify({
  id: "fevt_abcdefghijklmnopqrstuvwx",
  object: "event",
  type: "payment.succeeded",
  created: Math.floor(Date.now() / 1000),
  account: "acct_fake_demo-harbor",
  data: {
    object: {
      id: "fpay_ABCDEFGHIJKLMNOPQRSTUVWX",
      object: "payment",
      amount: 5000,
      currency: "usd",
      status: "succeeded",
      client_reference: null,
    },
  },
});

describe("payment configuration", () => {
  it("runs the fake only outside production, with a long enough secret", () => {
    const { PAYMENT_PROVIDER: _unset, ...base } = env as Bindings;
    expect(paymentSettings(base)).toEqual({ kind: "off", reason: "unset" });
    expect(paymentSettings(fakeEnv())).toEqual({ kind: "fake", secret });
    expect(paymentSettings(fakeEnv({ ENVIRONMENT: "production" }))).toEqual({
      kind: "refused",
      reason: "fake_in_production",
    });
    expect(paymentSettings(fakeEnv({ FAKE_PAYMENT_WEBHOOK_SECRET: "too-short" }))).toEqual({
      kind: "off",
      reason: "secret_missing",
    });
    expect(paymentSettings(fakeEnv({ PAYMENT_PROVIDER: "stripe" }))).toEqual({
      kind: "off",
      reason: "not_built",
    });
    expect(paymentSettings(fakeEnv({ PAYMENT_PROVIDER: "paypal" }))).toEqual({
      kind: "refused",
      reason: "unknown_provider",
    });
  });

  it("offers no checkout, webhook, or fake controls in a production configuration", async () => {
    const production = fakeEnv({ ENVIRONMENT: "production" });
    expect(
      await call(
        "/v1/public/checkout-sessions",
        {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": "key-12345678" },
          body: JSON.stringify({
            quoteId: "0b7f3a52-9c1e-4d2a-8f6b-1e2d3c4b5a69",
            acceptedPolicyVersion: 1,
            booker: { name: "Guest", email: "guest@example.test" },
            checkoutSecret: "a".repeat(43),
          }),
        },
        production,
      ),
    ).toEqual({ status: 503, code: "payments_unavailable" });
    expect(
      await call("/v1/webhooks/payments/fake", { method: "POST", body: eventBody }, production),
    ).toEqual({ status: 404, code: "not_found" });
    expect(
      await call(
        "/v1/fake-provider/payments/fpay_ABCDEFGHIJKLMNOPQRSTUVWX/succeed",
        { method: "POST", headers: { origin: "https://guest.test" } },
        production,
      ),
    ).toEqual({ status: 404, code: "not_found" });
  });

  it("hides the fake controls where payments are off", async () => {
    const res = await SELF.fetch(
      "https://api.test/v1/fake-provider/payments/fpay_ABCDEFGHIJKLMNOPQRSTUVWX",
      { headers: { origin: "https://guest.test" } },
    );
    expect(res.status).toBe(404);
  });
});

describe("the payment webhook refuses before touching the database", () => {
  const post = (headers: Record<string, string>, body = eventBody, bindings = fakeEnv()) =>
    call("/v1/webhooks/payments/fake", { method: "POST", headers, body }, bindings);

  it("refuses a browser request", async () => {
    const signature = await signatureHeaderValue(secret, Date.now(), eventBody);
    expect(await post({ origin: "https://guest.test", "fake-signature": signature })).toEqual({
      status: 403,
      code: "origin_not_allowed",
    });
  });

  it("answers 404 for a provider this deployment does not use", async () => {
    expect(
      await call("/v1/webhooks/payments/stripe", { method: "POST", body: eventBody }, fakeEnv()),
    ).toEqual({ status: 404, code: "not_found" });
  });

  it("refuses a missing, wrong, stale, or future signature", async () => {
    const now = Date.now();
    expect(await post({})).toEqual({ status: 400, code: "signature_invalid" });
    expect(
      await post({
        "fake-signature": await signatureHeaderValue(`${secret}-wrong`, now, eventBody),
      }),
    ).toEqual({ status: 400, code: "signature_invalid" });
    expect(
      await post({
        "fake-signature": await signatureHeaderValue(secret, now - 301_000, eventBody),
      }),
    ).toEqual({ status: 400, code: "signature_invalid" });
    expect(
      await post({
        "fake-signature": await signatureHeaderValue(secret, now + 301_000, eventBody),
      }),
    ).toEqual({ status: 400, code: "signature_invalid" });
    // A valid signature over another body.
    expect(await post({ "fake-signature": await signatureHeaderValue(secret, now, "{}") })).toEqual(
      { status: 400, code: "signature_invalid" },
    );
  });

  it("refuses a signed body that is not an event, and an oversized one", async () => {
    const notAnEvent = '{"hello":"world"}';
    expect(
      await post(
        { "fake-signature": await signatureHeaderValue(secret, Date.now(), notAnEvent) },
        notAnEvent,
      ),
    ).toEqual({ status: 400, code: "payload_invalid" });
    const huge = `{"pad":"${"x".repeat(70_000)}"}`;
    expect(
      await post({ "fake-signature": await signatureHeaderValue(secret, Date.now(), huge) }, huge),
    ).toEqual({ status: 413, code: "payload_too_large" });
  });
});

describe("published contract", () => {
  it("documents checkout, the webhook, the fake controls, and the staff reads", async () => {
    const doc = (await (await SELF.fetch("https://api.test/v1/openapi.json")).json()) as {
      paths: Record<string, unknown>;
    };
    for (const path of [
      "/v1/public/checkout-sessions",
      "/v1/public/checkout-sessions/{checkoutSessionId}",
      "/v1/public/checkout-sessions/{checkoutSessionId}/cancel",
      "/v1/webhooks/payments/{provider}",
      "/v1/fake-provider/payments/{paymentRef}",
      "/v1/fake-provider/payments/{paymentRef}/succeed",
      "/v1/fake-provider/payments/{paymentRef}/fail",
      "/v1/fake-provider/payments/{paymentRef}/events/{eventId}/redeliver",
      "/v1/staff/tenants/{tenantId}/trips/{tripId}/bookings",
      "/v1/staff/tenants/{tenantId}/finalization-exceptions",
    ]) {
      expect({ path, present: path in doc.paths }).toEqual({ path, present: true });
    }
  });
});
