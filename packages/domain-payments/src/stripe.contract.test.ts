import { afterEach, beforeEach, expect, vi } from "vitest";
import {
  describePaymentProviderContract,
  type ProviderDelivery,
} from "./payment-provider.contract.ts";
import { createStripePaymentProvider } from "./stripe.ts";
import { createStripeFixture, type StripeFixtureDelivery } from "./stripe-fixture.ts";

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

describePaymentProviderContract("stripe over the recorded-shape fixture", () => {
  const fixture = createStripeFixture();
  const provider = createStripePaymentProvider({
    secretKey: fixture.secretKey,
    webhookSecret: fixture.webhookSecret,
    environment: "local",
    fetch: fixture.fetch,
  });
  const deliveries = new Map<string, StripeFixtureDelivery>();
  const keep = (delivery: StripeFixtureDelivery): ProviderDelivery => {
    deliveries.set(delivery.body, delivery);
    return { rawBody: delivery.body, signatureHeader: delivery.header, nowMs: delivery.nowMs };
  };
  return {
    provider,
    accountRef: fixture.syntheticAccounts.harbor,
    async succeed(paymentRef) {
      return keep(await fixture.event("payment_intent.succeeded", fixture.succeed(paymentRef)));
    },
    async failFinally(paymentRef) {
      return keep(await fixture.event("payment_intent.canceled", fixture.cancel(paymentRef)));
    },
    async redeliver(delivery) {
      const first = deliveries.get(delivery.rawBody);
      if (!first) throw new Error("not a fixture delivery");
      // Another endpoint took the event meanwhile, so pending_webhooks fell.
      return keep(
        await fixture.redeliver(first, { pendingWebhooks: 0, nowMs: delivery.nowMs + 60_000 }),
      );
    },
  };
});
