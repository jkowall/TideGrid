import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VerifiedProviderEvent, WebhookVerification } from "./adapter.ts";
import { sha256Hex, signatureHeaderValue, signPayload } from "./signature.ts";
import { createStripePaymentProvider, STRIPE_API_VERSION } from "./stripe.ts";
import {
  createStripeFixture,
  STRIPE_FIXTURE_ACCOUNTS,
  type StripeFixtureDelivery,
} from "./stripe-fixture.ts";

const nowMs = Date.UTC(2026, 9, 28, 15, 0, 0);
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
/** Another endpoint's secret, random per run, so no committed literal passes the deployment checks. */
const otherSecret = () =>
  [
    "whsec",
    Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => alphabet[b % 62]).join(""),
  ].join("_");
const harbor = STRIPE_FIXTURE_ACCOUNTS.harbor;
const reef = STRIPE_FIXTURE_ACCOUNTS.reef;

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

function harness(toleranceSeconds?: number) {
  const fixture = createStripeFixture({ now: () => nowMs });
  const provider = createStripePaymentProvider({
    secretKey: fixture.secretKey,
    webhookSecret: fixture.webhookSecret,
    environment: "local",
    fetch: fixture.fetch,
    ...(toleranceSeconds === undefined ? {} : { toleranceSeconds }),
  });
  const verify = (delivery: { body: string; header: string | null; nowMs: number }) =>
    provider.verifyWebhook({
      rawBody: delivery.body,
      signatureHeader: delivery.header,
      nowMs: delivery.nowMs,
    });
  /** Sign any body with the endpoint's secret. */
  const signed = async (payload: unknown) => {
    const body = typeof payload === "string" ? payload : JSON.stringify(payload);
    return { body, header: await signatureHeaderValue(fixture.webhookSecret, nowMs, body), nowMs };
  };
  const intent = async (account: string = harbor, amount = 5000) => {
    const reference = randomUUID();
    const created = await provider.createPayment({
      accountRef: account,
      amount,
      currency: "USD",
      idempotencyKey: `checkout_payment:${randomUUID()}`,
      clientReference: reference,
    });
    return { ref: created.paymentRef, reference };
  };
  return { fixture, provider, verify, signed, intent };
}

function accepted(result: WebhookVerification): VerifiedProviderEvent {
  if (result.kind !== "verified") throw new Error(`rejected: ${result.reason}`);
  return result.event;
}

function rejection(result: WebhookVerification): string {
  if (result.kind !== "rejected") throw new Error("verified");
  return result.reason;
}

describe("Stripe webhook verification", () => {
  it("returns the signature check's own reason for each bad signature", async () => {
    const { fixture, verify, intent } = harness();
    const { ref } = await intent();
    const delivery = await fixture.event("payment_intent.succeeded", fixture.succeed(ref));
    expect(rejection(await verify({ ...delivery, header: null }))).toBe("missing_signature");
    expect(rejection(await verify({ ...delivery, header: "" }))).toBe("missing_signature");
    expect(rejection(await verify({ ...delivery, header: "t=abc,v1=zz" }))).toBe(
      "malformed_signature",
    );
    const tampered = delivery.body.replace('"amount": 5000', '"amount": 1');
    expect(tampered).not.toBe(delivery.body);
    expect(rejection(await verify({ ...delivery, body: tampered }))).toBe("signature_mismatch");
    const other = await signatureHeaderValue(otherSecret(), nowMs, delivery.body);
    expect(rejection(await verify({ ...delivery, header: other }))).toBe("signature_mismatch");
    expect(rejection(await verify({ ...delivery, nowMs: nowMs + 301_000 }))).toBe(
      "timestamp_out_of_tolerance",
    );
    expect(rejection(await verify({ ...delivery, nowMs: nowMs - 301_000 }))).toBe(
      "timestamp_out_of_tolerance",
    );
    expect(accepted(await verify({ ...delivery, nowMs: nowMs + 300_000 })).type).toBe(
      "payment.succeeded",
    );
  });

  it("ignores v0, so a v0-only header is malformed", async () => {
    const { fixture, verify, intent } = harness();
    const { ref } = await intent();
    const delivery = await fixture.event("payment_intent.succeeded", fixture.succeed(ref));
    const t = Math.floor(nowMs / 1000);
    const v0 = await signPayload(fixture.webhookSecret, t, delivery.body);
    expect(rejection(await verify({ ...delivery, header: `t=${t},v0=${v0}` }))).toBe(
      "malformed_signature",
    );
    expect(
      accepted(await verify({ ...delivery, header: `t=${t},v0=${v0},v1=${v0}` })).eventId,
    ).toBe(delivery.id);
  });

  it("checks the signature before reading the body", async () => {
    const { verify } = harness();
    expect(rejection(await verify({ body: "not json", header: "t=1,v1=00", nowMs }))).toBe(
      "malformed_signature",
    );
    const forged = await signatureHeaderValue(otherSecret(), nowMs, "not json");
    expect(rejection(await verify({ body: "not json", header: forged, nowMs }))).toBe(
      "signature_mismatch",
    );
  });

  it("verifies while the secret rolls, with two v1 values", async () => {
    const { fixture, verify, intent } = harness();
    const { ref } = await intent();
    const delivery = await fixture.event("payment_intent.succeeded", fixture.succeed(ref), {
      extraV1: otherSecret(),
    });
    expect(delivery.header.match(/v1=/g)).toHaveLength(2);
    expect(accepted(await verify(delivery)).eventId).toBe(delivery.id);
  });

  it("applies the clamped tolerance", async () => {
    const { fixture, verify, intent } = harness(10);
    const { ref } = await intent();
    const delivery = await fixture.event("payment_intent.succeeded", fixture.succeed(ref));
    expect(rejection(await verify({ ...delivery, nowMs: nowMs + 11_000 }))).toBe(
      "timestamp_out_of_tolerance",
    );
    expect(accepted(await verify({ ...delivery, nowMs: nowMs + 10_000 })).eventId).toBe(
      delivery.id,
    );
  });

  it("refuses verified bodies TideGrid cannot take as payload_invalid", async () => {
    const { fixture, verify, signed, intent } = harness();
    const { ref } = await intent();
    const good = (await fixture.event("payment_intent.succeeded", fixture.succeed(ref))).payload;
    const without = (key: string) => {
      const copy: Record<string, unknown> = { ...good };
      delete copy[key];
      return copy;
    };
    const object = (good.data as { object: Record<string, unknown> }).object;
    const bodies: unknown[] = [
      "not json",
      "[]",
      JSON.stringify({ ...good, livemode: true }),
      without("account"),
      { ...good, account: null },
      { ...good, account: "acct_fake_demo-harbor" },
      { ...good, object: "charge" },
      { ...good, id: "ch_TestFixture0000000000001" },
      { ...good, type: "Payment_Intent.Succeeded" },
      { ...good, created: "1790000000" },
      { ...good, created: 1.5 },
      without("livemode"),
      { ...good, livemode: "false" },
      without("api_version"),
      without("data"),
      { ...good, data: {} },
      { ...good, data: { object: "pi_TestFixture0000000000001" } },
      // A non-USD TideGrid intent.
      { ...good, data: { object: { ...object, currency: "eur" } } },
      // A success whose intent did not succeed.
      { ...good, data: { object: { ...object, status: "processing" } } },
      { ...good, data: { object: { ...object, amount_received: -1 } } },
      { ...good, data: { object: { ...object, id: "pi_bad-id" } } },
      // A thin event: no data.object, only a pointer to the object.
      {
        id: "evt_TestFixture0000000000099",
        object: "v2.core.event",
        type: "v1.payment_intent.succeeded",
        created: "2026-10-28T15:00:00.000Z",
        livemode: false,
        context: harbor,
        related_object: { id: ref, type: "payment_intent", url: `/v1/payment_intents/${ref}` },
      },
      // Nested past any real event.
      {
        ...good,
        data: { object: { ...object, nested: JSON.parse(`${"[".repeat(80)}${"]".repeat(80)}`) } },
      },
    ];
    for (const body of bodies) {
      const result = await verify(await signed(body));
      expect(rejection(result), JSON.stringify(body).slice(0, 120)).toBe("payload_invalid");
    }
  });

  it("verifies a body close to the 64 KiB route limit", async () => {
    const { fixture, verify, intent } = harness();
    const { ref } = await intent();
    const object = { ...fixture.succeed(ref), description: "x".repeat(60 * 1024) };
    const delivery = await fixture.event("payment_intent.succeeded", object);
    expect(new TextEncoder().encode(delivery.body).length).toBeGreaterThan(60 * 1024);
    expect(new TextEncoder().encode(delivery.body).length).toBeLessThan(64 * 1024);
    expect(accepted(await verify(delivery)).type).toBe("payment.succeeded");
  });
});

describe("Stripe event mapping", () => {
  it("maps a TideGrid intent's success to payment.succeeded with the amount received", async () => {
    const { fixture, verify, intent } = harness();
    const { ref, reference } = await intent();
    const delivery = await fixture.event("payment_intent.succeeded", fixture.succeed(ref));
    const event = accepted(await verify(delivery));
    expect(event).toEqual({
      provider: "stripe",
      eventId: delivery.id,
      type: "payment.succeeded",
      providerType: "payment_intent.succeeded",
      accountRef: harbor,
      occurredAt: new Date(Math.floor(nowMs / 1000) * 1000),
      payment: { ref, amount: 5000, currency: "USD", clientReference: reference },
      payloadSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(Object.isFrozen(event)).toBe(true);
  });

  it("maps a canceled intent to payment.failed with the intent's amount", async () => {
    const { fixture, verify, intent } = harness();
    const { ref, reference } = await intent(reef, 7300);
    const object = fixture.cancel(ref);
    expect(object.amount_received).toBe(0);
    const event = accepted(await verify(await fixture.event("payment_intent.canceled", object)));
    expect(event).toMatchObject({
      type: "payment.failed",
      accountRef: reef,
      payment: { ref, amount: 7300, currency: "USD", clientReference: reference },
    });
  });

  it("records a decline as other, so the guest can try again, then the success", async () => {
    const { fixture, verify, intent } = harness();
    const { ref } = await intent();
    const declined = accepted(
      await verify(await fixture.event("payment_intent.payment_failed", fixture.decline(ref))),
    );
    expect(declined).toMatchObject({
      type: "other",
      providerType: "payment_intent.payment_failed",
      payment: null,
    });
    const paid = accepted(
      await verify(await fixture.event("payment_intent.succeeded", fixture.succeed(ref))),
    );
    expect(paid).toMatchObject({ type: "payment.succeeded", payment: { ref } });
  });

  it("records every other type as other, with no payment", async () => {
    const { fixture, provider, verify, intent } = harness();
    const { ref } = await intent();
    const pending = fixture.intent(ref);
    fixture.succeed(ref);
    const refund = await provider.refundPayment({
      accountRef: harbor,
      paymentRef: ref,
      amount: 1000,
      currency: "USD",
      idempotencyKey: `checkout_refund:${randomUUID()}`,
    });
    const cases: [string, Record<string, unknown>][] = [
      ["payment_intent.processing", { ...pending, status: "processing" }],
      ["payment_intent.requires_action", { ...pending, status: "requires_action" }],
      ["payment_intent.created", pending],
      ["payment_intent.amount_capturable_updated", pending],
      ["charge.succeeded", fixture.charge(ref)],
      ["charge.refunded", fixture.charge(ref)],
      ["refund.created", fixture.refund(refund.refundRef)],
      ["refund.updated", fixture.refund(refund.refundRef)],
      ["refund.failed", { ...fixture.refund(refund.refundRef), status: "failed" }],
      ["charge.dispute.created", { id: "dp_TestFixture0000000000001", object: "dispute" }],
      ["charge.dispute.closed", { id: "dp_TestFixture0000000000001", object: "dispute" }],
      ["account.updated", { id: harbor, object: "account" }],
      [
        "account.application.deauthorized",
        { id: "ca_TestFixture00000000001", object: "application" },
      ],
      ["issuing_card.created", { id: "ic_TestFixture0000000000001", object: "issuing.card" }],
      // A success type whose object is not an intent.
      ["payment_intent.succeeded", fixture.charge(ref)],
    ];
    for (const [type, object] of cases) {
      const event = accepted(await verify(await fixture.event(type, object, { account: harbor })));
      expect(event, type).toMatchObject({ type: "other", providerType: type, payment: null });
    }
  });

  it("records an intent TideGrid did not make as other", async () => {
    const { fixture, verify } = harness();
    const foreign = fixture.addForeignIntent(harbor, 2500);
    const succeeded = { ...foreign, status: "succeeded", amount_received: 2500 };
    for (const object of [
      succeeded,
      { ...succeeded, metadata: { tidegrid_payment_id: "order-7" } },
      { ...succeeded, metadata: { tidegrid_payment_id: 7 } },
      { ...succeeded, metadata: null },
    ]) {
      for (const type of ["payment_intent.succeeded", "payment_intent.canceled"]) {
        const event = accepted(await verify(await fixture.event(type, object)));
        expect(event).toMatchObject({ type: "other", providerType: type, payment: null });
      }
    }
    // Another currency on a sale TideGrid did not make is not TideGrid's to refuse.
    const euro = accepted(
      await verify(
        await fixture.event("payment_intent.succeeded", { ...succeeded, currency: "eur" }),
      ),
    );
    expect(euro.type).toBe("other");
  });
});

describe("the dedupe hash", () => {
  it("is equal for redeliveries that differ only in per-delivery fields and formatting", async () => {
    const { fixture, verify, intent } = harness();
    const { ref } = await intent();
    const first: StripeFixtureDelivery = await fixture.event(
      "payment_intent.succeeded",
      fixture.succeed(ref),
      { pendingWebhooks: 3 },
    );
    const again = await fixture.redeliver(first, { pendingWebhooks: 1, nowMs: nowMs + 90_000 });
    const compact = await fixture.redeliver(first, {
      pendingWebhooks: 0,
      nowMs: nowMs + 120_000,
      pretty: false,
    });
    expect(again.body).not.toBe(first.body);
    expect(again.header).not.toBe(first.header);
    expect(compact.body).not.toBe(again.body);
    const hashes = await Promise.all(
      [first, again, compact].map(async (d) => accepted(await verify(d)).payloadSha256),
    );
    expect(new Set(hashes).size).toBe(1);
    // Not the raw body's hash: that is the fake's meaning.
    expect(hashes[0]).not.toBe(await sha256Hex(first.body));

    // Keys in another order, and a request block that changed.
    const reordered = Object.fromEntries(Object.entries(first.payload).reverse());
    const resent = {
      ...reordered,
      request: { id: "req_TestFixture0000000000001", idempotency_key: null },
    };
    const body = JSON.stringify(resent);
    const header = await signatureHeaderValue(fixture.webhookSecret, nowMs, body);
    expect(accepted(await verify({ body, header, nowMs })).payloadSha256).toBe(hashes[0]);
  });

  it("differs when anything the event says differs", async () => {
    const { fixture, verify, signed, intent } = harness();
    const { ref } = await intent();
    const first = await fixture.event("payment_intent.succeeded", fixture.succeed(ref));
    const base = accepted(await verify(first)).payloadSha256;
    const object = (first.payload.data as { object: Record<string, unknown> }).object;
    const variants = [
      { ...first.payload, data: { object: { ...object, amount_received: 4999 } } },
      { ...first.payload, created: Number(first.payload.created) + 1 },
      { ...first.payload, api_version: "2026-08-27.dahlia" },
      { ...first.payload, type: "payment_intent.created" },
      { ...first.payload, data: { object, previous_attributes: { status: "processing" } } },
    ];
    for (const variant of variants) {
      expect(accepted(await verify(await signed(variant))).payloadSha256).not.toBe(base);
    }
    expect(first.payload.api_version).toBe(STRIPE_API_VERSION);
  });
});
