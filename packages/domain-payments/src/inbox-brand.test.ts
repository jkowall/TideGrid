/**
 * The runtime brand the inbox checks (W1-PROVENANCE). Only an event that an
 * adapter's `verifyWebhook` built passes; every copy of one is refused before
 * the inbox touches the database. The text scan in `provenance.test.ts`
 * guards who may call the minting function; this suite guards what the inbox
 * accepts. No database and no network: the transaction is a stub that fails
 * on first use, so a refusal proves nothing reached it.
 */
import type { TenantContext, TenantTransaction } from "@tidegrid/database";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isVerifiedProviderEvent } from "./adapter.ts";
import { createFakePaymentProvider, parseFakeEventBody } from "./fake.ts";
import { recordProviderEvent, UnverifiedProviderEventError } from "./inbox.ts";
import { createStripePaymentProvider } from "./stripe.ts";
import { createStripeFixture } from "./stripe-fixture.ts";

const nowMs = Date.UTC(2026, 10, 8, 12, 0, 0);
const secret = "unit-test-fake-provider-secret-0123456789";
const noDatabase = () => {
  throw new Error("verifying a webhook must not touch a database");
};
const fake = createFakePaymentProvider({ db: noDatabase, secret, environment: "local" });

const fakeBody = JSON.stringify({
  id: "fevt_abcdefghijklmnopqrstuvwx",
  object: "event",
  type: "payment.succeeded",
  created: 1_762_603_200,
  account: "acct_fake_demo-harbor",
  data: {
    object: {
      id: "fpay_ABCDEFGHIJKLMNOPQRSTUVWX",
      object: "payment",
      amount: 12_345,
      currency: "usd",
      status: "succeeded",
      client_reference: "0b7f3a52-9c1e-4d2a-8f6b-1e2d3c4b5a69",
    },
  },
});

async function fakeEvent() {
  const signature = await fake.signDelivery(fakeBody, nowMs);
  const checked = await fake.verifyWebhook({
    rawBody: fakeBody,
    signatureHeader: signature.value,
    nowMs,
  });
  if (checked.kind !== "verified") throw new Error(`rejected: ${checked.reason}`);
  return checked.event;
}

async function stripeEvent() {
  const fixture = createStripeFixture({ now: () => nowMs });
  const provider = createStripePaymentProvider({
    secretKey: fixture.secretKey,
    webhookSecret: fixture.webhookSecret,
    environment: "local",
    fetch: fixture.fetch,
  });
  const created = await provider.createPayment({
    accountRef: "acct_1TestHarbor0000",
    amount: 5000,
    currency: "USD",
    idempotencyKey: "checkout_payment:7d0f3c1e-2b4a-4c5d-8e6f-9a0b1c2d3e4f",
    clientReference: "7d0f3c1e-2b4a-4c5d-8e6f-9a0b1c2d3e4f",
  });
  const delivery = await fixture.event(
    "payment_intent.succeeded",
    fixture.succeed(created.paymentRef),
  );
  const checked = await provider.verifyWebhook({
    rawBody: delivery.body,
    signatureHeader: delivery.header,
    nowMs: delivery.nowMs,
  });
  if (checked.kind !== "verified") throw new Error(`rejected: ${checked.reason}`);
  return checked.event;
}

class DatabaseReached extends Error {}

/** A transaction that records and refuses its first use. */
function stubTransaction() {
  const touched: string[] = [];
  const trx = new Proxy(
    {},
    {
      get(_target, property) {
        touched.push(String(property));
        throw new DatabaseReached(`the inbox reached the database (${String(property)})`);
      },
    },
  ) as unknown as TenantTransaction;
  return { trx, touched };
}

const ctx: TenantContext = {
  tenantId: "6f1e2d3c-4b5a-4968-8776-655443322110",
  actorType: "system",
  actorId: "fake-webhook",
  requestId: null,
};

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

/** Hand `candidate` to the inbox and say how far it got. */
async function record(candidate: Parameters<typeof recordProviderEvent>[2]) {
  const { trx, touched } = stubTransaction();
  try {
    await recordProviderEvent(trx, ctx, candidate);
  } catch (err) {
    if (err instanceof UnverifiedProviderEventError) return { result: "refused", touched };
    if (err instanceof DatabaseReached) return { result: "reached_database", touched };
    throw err;
  }
  throw new Error("the stub transaction cannot record anything");
}

describe("the inbox's runtime brand", () => {
  it("accepts an event that either adapter's verifyWebhook built", async () => {
    for (const event of [await fakeEvent(), await stripeEvent()]) {
      expect(isVerifiedProviderEvent(event)).toBe(true);
      expect((await record(event)).result).toBe("reached_database");
    }
  });

  it("refuses an unannotated spread of a real event, before the database", async () => {
    const event = await fakeEvent();
    // The forgery the text scan cannot see: the compiler keeps the type brand.
    const forged = { ...event, accountRef: "acct_fake_other-operator" };
    expect(isVerifiedProviderEvent(forged)).toBe(false);
    expect(await record(forged)).toEqual({ result: "refused", touched: [] });
    // A spread that changes nothing is refused too: the brand is identity.
    expect(await record({ ...event })).toEqual({ result: "refused", touched: [] });
    // And the real event still passes afterwards.
    expect((await record(event)).result).toBe("reached_database");
  });

  it("refuses every other copy of a real event", async () => {
    for (const event of [await fakeEvent(), await stripeEvent()]) {
      const copies = [
        { ...event },
        { ...event, payment: event.payment && { ...event.payment, amount: 1 } },
        Object.assign({}, event),
        structuredClone(event),
        JSON.parse(JSON.stringify(event)),
        Object.create(event),
        new Proxy(event, {}),
        new Proxy(event, {
          get: (t, p) => (p === "accountRef" ? "acct_fake_other" : t[p as keyof typeof t]),
        }),
        Object.freeze({ ...event }),
      ];
      for (const copy of copies) {
        expect(isVerifiedProviderEvent(copy)).toBe(false);
        expect(await record(copy)).toEqual({ result: "refused", touched: [] });
      }
    }
  });

  it("refuses parsed fields that never passed a signature check", async () => {
    const parsed = parseFakeEventBody(fakeBody);
    expect(parsed).not.toBeNull();
    // @ts-expect-error The parsed fields lack the type brand; the runtime brand refuses them too.
    expect(await record({ ...parsed, payloadSha256: "0".repeat(64) })).toEqual({
      result: "refused",
      touched: [],
    });
    for (const value of [null, undefined, 0, "event", [], {}]) {
      expect(isVerifiedProviderEvent(value)).toBe(false);
    }
  });

  it("cannot be widened by changing WeakSet after the module loaded", async () => {
    const event = await fakeEvent();
    const has = Object.getOwnPropertyDescriptor(WeakSet.prototype, "has");
    const add = Object.getOwnPropertyDescriptor(WeakSet.prototype, "add");
    if (!has || !add) throw new Error("no WeakSet methods");
    try {
      Object.defineProperty(WeakSet.prototype, "has", { ...has, value: () => true });
      Object.defineProperty(WeakSet.prototype, "add", {
        ...add,
        value(this: WeakSet<object>) {
          return this;
        },
      });
      const forged = { ...event, accountRef: "acct_fake_other-operator" };
      expect(isVerifiedProviderEvent(forged)).toBe(false);
      expect(await record(forged)).toEqual({ result: "refused", touched: [] });
      expect(isVerifiedProviderEvent(event)).toBe(true);
    } finally {
      Object.defineProperty(WeakSet.prototype, "has", has);
      Object.defineProperty(WeakSet.prototype, "add", add);
    }
  });

  it("still freezes an event minted after Object.freeze was replaced", async () => {
    const freeze = Object.freeze;
    let event: Awaited<ReturnType<typeof fakeEvent>>;
    try {
      (Object as { freeze: unknown }).freeze = <T>(value: T): T => value;
      event = await fakeEvent();
    } finally {
      Object.freeze = freeze;
    }
    expect(isVerifiedProviderEvent(event)).toBe(true);
    expect(Object.isFrozen(event)).toBe(true);
    expect(event.payment === null || Object.isFrozen(event.payment)).toBe(true);
    expect(Reflect.set(event, "accountRef", "acct_fake_other-operator")).toBe(false);
    if (event.payment) expect(Reflect.set(event.payment, "amount", 1)).toBe(false);
    expect(event.accountRef).toBe("acct_fake_demo-harbor");
  });

  it("reads occurredAt with the Date this module loaded with", async () => {
    const event = await fakeEvent();
    const when = event.occurredAt?.getTime();
    expect(when).toBe(1_762_603_200_000);
    const RealDate = globalThis.Date;
    class OtherDate extends RealDate {
      constructor() {
        super(0);
      }
    }
    try {
      globalThis.Date = OtherDate as DateConstructor;
      expect(event.occurredAt?.getTime()).toBe(when);
      expect(event.occurredAt).not.toBeInstanceOf(OtherDate);
    } finally {
      globalThis.Date = RealDate;
    }
  });

  it("keeps a branded event's content fixed", async () => {
    for (const event of [await fakeEvent(), await stripeEvent()]) {
      const before = JSON.stringify(event);
      const when = event.occurredAt?.getTime();
      expect(Object.isFrozen(event)).toBe(true);
      expect(event.payment === null || Object.isFrozen(event.payment)).toBe(true);
      expect(Reflect.set(event, "accountRef", "acct_fake_other")).toBe(false);
      if (event.payment) expect(Reflect.set(event.payment, "amount", 1)).toBe(false);
      // Each read of occurredAt is a new Date, so changing one changes nothing.
      event.occurredAt?.setTime(0);
      expect(event.occurredAt?.getTime()).toBe(when);
      expect(event.occurredAt).not.toBe(event.occurredAt);
      expect(JSON.stringify(event)).toBe(before);
      expect(isVerifiedProviderEvent(event)).toBe(true);
    }
  });

  it("keeps the fields the adapters assembled", async () => {
    const event = await fakeEvent();
    const parsed = parseFakeEventBody(fakeBody);
    expect({ ...event }).toEqual({ ...parsed, payloadSha256: event.payloadSha256 });
    expect(Object.keys(event).sort()).toEqual(
      [
        "accountRef",
        "dispute",
        "eventId",
        "occurredAt",
        "payloadSha256",
        "payment",
        "provider",
        "providerType",
        "refund",
        "type",
      ].sort(),
    );
  });
});
