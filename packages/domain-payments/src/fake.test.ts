import { describe, expect, it } from "vitest";
import { createFakePaymentProvider, FAKE_SIGNATURE_HEADER, parseFakeEventBody } from "./fake.ts";
import { signatureHeaderValue } from "./signature.ts";

const secret = "unit-test-fake-provider-secret-0123456789";
const noDatabase = () => {
  throw new Error("this check must not touch a database");
};
const fake = createFakePaymentProvider({ db: noDatabase, secret, environment: "local" });

const paymentRef = "fpay_ABCDEFGHIJKLMNOPQRSTUVWX";
const clientReference = "0b7f3a52-9c1e-4d2a-8f6b-1e2d3c4b5a69";

function body(overrides: Record<string, unknown> = {}, object: Record<string, unknown> = {}) {
  return JSON.stringify({
    id: "fevt_abcdefghijklmnopqrstuvwx",
    object: "event",
    type: "payment.succeeded",
    created: 1_759_665_600,
    account: "acct_fake_demo-harbor",
    data: {
      object: {
        id: paymentRef,
        object: "payment",
        amount: 12_345,
        currency: "usd",
        status: "succeeded",
        client_reference: clientReference,
        ...object,
      },
    },
    ...overrides,
  });
}

describe("the fake provider", () => {
  it("is refused in a production configuration and with a short secret", () => {
    expect(() =>
      createFakePaymentProvider({ db: noDatabase, secret, environment: "production" }),
    ).toThrow(/production/);
    expect(() =>
      createFakePaymentProvider({ db: noDatabase, secret: "short", environment: "local" }),
    ).toThrow(RangeError);
  });

  it("reads its own events into provider-neutral ones", () => {
    expect(parseFakeEventBody(body())).toEqual({
      provider: "fake",
      eventId: "fevt_abcdefghijklmnopqrstuvwx",
      type: "payment.succeeded",
      providerType: "payment.succeeded",
      accountRef: "acct_fake_demo-harbor",
      occurredAt: new Date(1_759_665_600_000),
      payment: { ref: paymentRef, amount: 12_345, currency: "USD", clientReference },
    });
    expect(parseFakeEventBody(body({ type: "payment.failed" }))?.type).toBe("payment.failed");
    // Anything else is recorded as other, without a payment.
    expect(parseFakeEventBody(body({ type: "charge.dispute.created" }))).toMatchObject({
      type: "other",
      providerType: "charge.dispute.created",
      payment: null,
    });
    expect(parseFakeEventBody(body({}, { client_reference: null }))?.payment?.clientReference).toBe(
      null,
    );
  });

  it("refuses bodies that are not its own envelope", () => {
    for (const bad of [
      "not json",
      "[]",
      body({ id: "evt_123" }),
      body({ object: "payment" }),
      body({ type: "Payment.Succeeded" }),
      body({ created: -1 }),
      body({ created: 1.5 }),
      body({ account: "someone" }),
      body({ data: {} }),
      body({}, { id: "pi_123" }),
      body({}, { amount: -1 }),
      body({}, { amount: 1.5 }),
      body({}, { currency: "USD" }),
      body({}, { client_reference: "not-a-uuid" }),
    ]) {
      expect({ bad, parsed: parseFakeEventBody(bad) }).toEqual({ bad, parsed: null });
    }
  });

  it("verifies a signed event without a database, and refuses tampering", async () => {
    const raw = body();
    const now = 1_759_665_600_000;
    const header = await signatureHeaderValue(secret, now, raw);
    const ok = await fake.verifyWebhook({ rawBody: raw, signatureHeader: header, nowMs: now });
    expect(ok.kind).toBe("verified");
    if (ok.kind === "verified") {
      expect(ok.event.payloadSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(Object.isFrozen(ok.event)).toBe(true);
    }
    expect(fake.signatureHeader).toBe(FAKE_SIGNATURE_HEADER);
    expect(
      await fake.verifyWebhook({
        rawBody: raw.replace("12345", "12346"),
        signatureHeader: header,
        nowMs: now,
      }),
    ).toEqual({ kind: "rejected", reason: "signature_mismatch" });
    const notOurs = "{}";
    expect(
      await fake.verifyWebhook({
        rawBody: notOurs,
        signatureHeader: await signatureHeaderValue(secret, now, notOurs),
        nowMs: now,
      }),
    ).toEqual({ kind: "rejected", reason: "payload_invalid" });
  });

  it("accepts only the client secret derived for the same payment", async () => {
    const clientSecret = await fake.clientSecretFor(paymentRef);
    expect(clientSecret).toMatch(/^fpay_[A-Za-z0-9]{24}_secret_[A-Za-z0-9_-]{43}$/);
    expect(await fake.checkClientSecret(paymentRef, clientSecret)).toBe(true);
    const other = "fpay_XWVUTSRQPONMLKJIHGFEDCBA";
    expect(await fake.checkClientSecret(other, clientSecret)).toBe(false);
    // Change a character that carries full bits (the last one also carries padding).
    const at = clientSecret.length - 10;
    const forged = `${clientSecret.slice(0, at)}${clientSecret[at] === "A" ? "B" : "A"}${clientSecret.slice(at + 1)}`;
    expect(await fake.checkClientSecret(paymentRef, forged)).toBe(false);
    expect(await fake.checkClientSecret(paymentRef, "")).toBe(false);
    const otherSecret = createFakePaymentProvider({
      db: noDatabase,
      secret: `${secret}-rotated`,
      environment: "local",
    });
    expect(await otherSecret.checkClientSecret(paymentRef, clientSecret)).toBe(false);
  });
});
