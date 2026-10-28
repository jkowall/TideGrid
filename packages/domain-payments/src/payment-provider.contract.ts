/**
 * The payment provider contract. One suite drives the Stripe adapter over its
 * recorded-shape fixture (unit) and the fake over a real database
 * (integration), so the demo's fake cannot drift from what the Stripe
 * adapter does at the port.
 *
 * Known divergence: the fake treats a decline as final, and Stripe lets the
 * guest try again. The decline-then-retry case is Stripe-only and lives in
 * `stripe-webhook.test.ts`.
 */
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  type PaymentProvider,
  ProviderRejectedError,
  type VerifiedProviderEvent,
} from "./adapter.ts";

export interface ProviderDelivery {
  rawBody: string;
  signatureHeader: string;
  nowMs: number;
}

export interface PaymentProviderHarness {
  provider: PaymentProvider;
  /** A connected account the provider takes payments on. */
  accountRef: string;
  /** The guest pays. Returns the signed delivery of the success event. */
  succeed(paymentRef: string): Promise<ProviderDelivery>;
  /** The provider will never complete the payment. Returns the signed delivery of that event. */
  failFinally(paymentRef: string): Promise<ProviderDelivery>;
  /** The provider delivers the same event again, signed afresh. */
  redeliver(delivery: ProviderDelivery): Promise<ProviderDelivery>;
  /** Records an event in the real inbox, when the harness has a database. */
  record?(event: VerifiedProviderEvent): Promise<{ duplicate: boolean; samePayload: boolean }>;
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
}

export function describePaymentProviderContract(
  label: string,
  makeHarness: () => PaymentProviderHarness | Promise<PaymentProviderHarness>,
): void {
  describe(`payment provider contract: ${label}`, () => {
    let harness: PaymentProviderHarness;

    beforeEach(async () => {
      harness = await makeHarness();
    });

    const input = (overrides: { amount?: number; key?: string; reference?: string } = {}) => ({
      accountRef: harness.accountRef,
      amount: overrides.amount ?? 5000,
      currency: "USD" as const,
      idempotencyKey: overrides.key ?? `checkout_payment:${randomUUID()}`,
      clientReference: overrides.reference ?? randomUUID(),
    });

    async function verified(delivery: ProviderDelivery): Promise<VerifiedProviderEvent> {
      const checked = await harness.provider.verifyWebhook(delivery);
      if (checked.kind !== "verified") throw new Error(`rejected: ${checked.reason}`);
      return checked.event;
    }

    it("creates one payment per idempotency key", async () => {
      const first = input();
      const a = await harness.provider.createPayment(first);
      const b = await harness.provider.createPayment(first);
      expect(b.paymentRef).toBe(a.paymentRef);
      expect(b.clientSecret).toBe(a.clientSecret);
      expect(a).toMatchObject({
        status: "pending",
        amount: 5000,
        currency: "USD",
        amountRefunded: 0,
      });
      expect(a.clientSecret.length).toBeGreaterThan(0);
      expect(harness.provider.minimumAmount("USD")).toBe(50);
    });

    it("refuses a key reused for another payment", async () => {
      const first = input();
      await harness.provider.createPayment(first);
      const error = await caught(harness.provider.createPayment({ ...first, amount: 5001 }));
      expect(error).toBeInstanceOf(ProviderRejectedError);
      expect((error as ProviderRejectedError).code).toBe("idempotency_key_reused");
    });

    it("refunds once per key and never more than was paid", async () => {
      const created = await harness.provider.createPayment(input());
      await harness.succeed(created.paymentRef);
      const refund = (amount: number, key: string) =>
        harness.provider.refundPayment({
          accountRef: harness.accountRef,
          paymentRef: created.paymentRef,
          amount,
          currency: "USD",
          idempotencyKey: key,
        });
      const key = `checkout_refund:${randomUUID()}`;
      const first = await refund(4900, key);
      expect(first.status).toBe("succeeded");
      const again = await refund(4900, key);
      expect(again).toEqual(first);
      const over = await caught(refund(200, `checkout_refund:${randomUUID()}`));
      expect(over).toBeInstanceOf(ProviderRejectedError);
      const rest = await refund(100, `checkout_refund:${randomUUID()}`);
      expect(rest.status).toBe("succeeded");
      expect(rest.refundRef).not.toBe(first.refundRef);
      const reused = await caught(refund(4800, key));
      expect(reused).toBeInstanceOf(ProviderRejectedError);
      expect((reused as ProviderRejectedError).code).toBe("idempotency_key_reused");
    });

    it("verifies a success that echoes the client reference", async () => {
      const request = input();
      const created = await harness.provider.createPayment(request);
      const event = await verified(await harness.succeed(created.paymentRef));
      expect(event).toMatchObject({
        provider: harness.provider.name,
        type: "payment.succeeded",
        accountRef: harness.accountRef,
        payment: {
          ref: created.paymentRef,
          amount: 5000,
          currency: "USD",
          clientReference: request.clientReference,
        },
      });
      expect(event.payloadSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(Object.isFrozen(event)).toBe(true);
    });

    it("reports a payment that will never complete as payment.failed", async () => {
      const request = input();
      const created = await harness.provider.createPayment(request);
      const event = await verified(await harness.failFinally(created.paymentRef));
      expect(event).toMatchObject({
        type: "payment.failed",
        payment: {
          ref: created.paymentRef,
          amount: 5000,
          currency: "USD",
          clientReference: request.clientReference,
        },
      });
    });

    it("hashes a redelivery the same, so the inbox records it as the same payload", async () => {
      const created = await harness.provider.createPayment(input());
      const delivery = await harness.succeed(created.paymentRef);
      const first = await verified(delivery);
      const again = await verified(await harness.redeliver(delivery));
      expect(again.eventId).toBe(first.eventId);
      expect(again.payloadSha256).toBe(first.payloadSha256);
      if (harness.record) {
        expect(await harness.record(first)).toMatchObject({ duplicate: false });
        expect(await harness.record(again)).toEqual({ duplicate: true, samePayload: true });
      }
    });
  });
}
