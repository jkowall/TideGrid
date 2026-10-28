import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderRejectedError, ProviderUnavailableError } from "./adapter.ts";
import {
  checkStripeConfig,
  createStripePaymentProvider,
  STRIPE_API_VERSION,
  type StripeProviderOptions,
} from "./stripe.ts";
import { createStripeFixture, STRIPE_FIXTURE_ACCOUNTS } from "./stripe-fixture.ts";

// Key-shaped strings are joined at run time so secret scanners do not flag them.
const keyOf = (...parts: string[]) => parts.join("_");
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

type Fixture = ReturnType<typeof createStripeFixture>;

function harness(options: Partial<StripeProviderOptions> = {}) {
  const fixture = createStripeFixture();
  const provider = createStripePaymentProvider({
    secretKey: fixture.secretKey,
    webhookSecret: fixture.webhookSecret,
    environment: "local",
    fetch: fixture.fetch,
    ...options,
  });
  return { fixture, provider };
}

const createInput = (
  overrides: Partial<{ account: string; amount: number; key: string }> = {},
) => ({
  accountRef: overrides.account ?? harbor,
  amount: overrides.amount ?? 5000,
  currency: "USD" as const,
  idempotencyKey: overrides.key ?? `checkout_payment:${randomUUID()}`,
  clientReference: randomUUID(),
});

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
}

async function unavailable(promise: Promise<unknown>): Promise<string> {
  const error = await caught(promise);
  expect(error).toBeInstanceOf(ProviderUnavailableError);
  return (error as Error).message;
}

async function rejectedCode(promise: Promise<unknown>): Promise<string> {
  const error = await caught(promise);
  expect(error).toBeInstanceOf(ProviderRejectedError);
  return (error as ProviderRejectedError).code;
}

/**
 * Stripe's documented codes for a key, account, or mode fault
 * (https://docs.stripe.com/error-codes). None is about the request itself.
 */
const configurationCodes = [
  "api_key_expired",
  "platform_api_key_expired",
  "secret_key_required",
  "account_invalid",
  "livemode_mismatch",
  "platform_account_required",
  "capability_not_active",
  "action_blocked",
  "testmode_charges_only",
  "tls_version_unsupported",
  "anomalous_money_movement_request",
  "account_country_invalid_address",
  "progressive_onboarding_limit_exceeded",
];
/** Codes that say "not now": the same request may succeed later. */
const transientCodes = [
  "lock_timeout",
  "rate_limit",
  "idempotency_key_in_use",
  "balance_insufficient",
  "charge_exceeds_source_limit",
  "payment_method_not_available",
];

const stripeError = (type: string, code?: string, message = "Stripe's own words") =>
  JSON.stringify({ error: { type, ...(code ? { code } : {}), message } });

async function paid(fixture: Fixture, provider: ReturnType<typeof harness>["provider"]) {
  const created = await provider.createPayment(createInput());
  fixture.succeed(created.paymentRef);
  return created;
}

const refundInput = (paymentRef: string, overrides: { amount?: number; key?: string } = {}) => ({
  accountRef: harbor,
  paymentRef,
  amount: overrides.amount ?? 1000,
  currency: "USD" as const,
  idempotencyKey: overrides.key ?? `checkout_refund:${randomUUID()}`,
});

describe("the Stripe adapter's requests", () => {
  it("creates a card-only PaymentIntent on the connected account, with the port's key", async () => {
    const { fixture, provider } = harness();
    const input = createInput();
    const created = await provider.createPayment(input);
    expect(created.paymentRef).toMatch(/^pi_/);
    expect(created).toMatchObject({
      status: "pending",
      amount: 5000,
      currency: "USD",
      amountRefunded: 0,
    });
    expect(created.clientSecret.startsWith(`${created.paymentRef}_secret_`)).toBe(true);
    expect(fixture.requests).toHaveLength(1);
    const [request] = fixture.requests;
    expect(request).toMatchObject({
      method: "POST",
      path: "/v1/payment_intents",
      search: [],
      authorized: true,
      stripeAccount: harbor,
      stripeVersion: STRIPE_API_VERSION,
      idempotencyKey: input.idempotencyKey,
      contentType: "application/x-www-form-urlencoded",
    });
    expect(request?.form).toEqual([
      ["amount", "5000"],
      ["currency", "usd"],
      ["payment_method_types[]", "card"],
      ["metadata[tidegrid_payment_id]", input.clientReference],
    ]);
    expect(request?.form.some(([k]) => k.includes("application_fee"))).toBe(false);
  });

  it("reads an intent with its latest charge expanded, without a key", async () => {
    const { fixture, provider } = harness();
    const created = await provider.createPayment(createInput());
    await provider.retrievePayment({ accountRef: harbor, paymentRef: created.paymentRef });
    expect(fixture.requests[1]).toMatchObject({
      method: "GET",
      path: `/v1/payment_intents/${created.paymentRef}`,
      search: [["expand[]", "latest_charge"]],
      form: [],
      stripeAccount: harbor,
      stripeVersion: STRIPE_API_VERSION,
      idempotencyKey: null,
    });
  });

  it("looks a refund up by its key before creating it, and sends no fee reversal", async () => {
    const { fixture, provider } = harness();
    const created = await paid(fixture, provider);
    const input = refundInput(created.paymentRef);
    await provider.refundPayment(input);
    const [lookup, post] = fixture.requests.slice(1);
    expect(lookup).toMatchObject({
      method: "GET",
      path: "/v1/refunds",
      search: [
        ["payment_intent", created.paymentRef],
        ["limit", "100"],
      ],
      stripeAccount: harbor,
      idempotencyKey: null,
    });
    expect(post).toMatchObject({
      method: "POST",
      path: "/v1/refunds",
      stripeAccount: harbor,
      stripeVersion: STRIPE_API_VERSION,
      idempotencyKey: input.idempotencyKey,
    });
    expect(post?.form).toEqual([
      ["payment_intent", created.paymentRef],
      ["amount", "1000"],
      ["metadata[tidegrid_refund_key]", input.idempotencyKey],
    ]);
  });

  it("puts the key in the Authorization header and nowhere else", async () => {
    const fixture = createStripeFixture();
    const seen: { url: string; headers: Record<string, string>; body: string }[] = [];
    const provider = createStripePaymentProvider({
      secretKey: fixture.secretKey,
      webhookSecret: fixture.webhookSecret,
      environment: "local",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const headers = Object.fromEntries(request.headers.entries());
        seen.push({ url: request.url, headers, body: await request.clone().text() });
        return fixture.fetch(request);
      },
    });
    const created = await provider.createPayment(createInput());
    fixture.succeed(created.paymentRef);
    await provider.retrievePayment({ accountRef: harbor, paymentRef: created.paymentRef });
    await provider.refundPayment(refundInput(created.paymentRef));
    expect(seen).toHaveLength(4);
    for (const request of seen) {
      expect(request.headers.authorization).toBe(`Bearer ${fixture.secretKey}`);
      const { authorization: _, ...rest } = request.headers;
      const elsewhere = JSON.stringify([request.url, request.body, rest]);
      expect(elsewhere.includes(fixture.secretKey)).toBe(false);
      expect(elsewhere.includes(fixture.webhookSecret)).toBe(false);
    }
  });
});

describe("idempotent creation", () => {
  it("answers the same key with the same intent, replayed by Stripe", async () => {
    const { fixture, provider } = harness();
    const replayed: (string | null)[] = [];
    const watched = createStripePaymentProvider({
      secretKey: fixture.secretKey,
      webhookSecret: fixture.webhookSecret,
      environment: "local",
      fetch: async (input, init) => {
        const response = await fixture.fetch(input, init);
        replayed.push(response.headers.get("idempotent-replayed"));
        return response;
      },
    });
    const input = createInput();
    const first = await provider.createPayment(input);
    const second = await watched.createPayment(input);
    expect(second.paymentRef).toBe(first.paymentRef);
    expect(second.clientSecret).toBe(first.clientSecret);
    expect(replayed).toEqual(["true"]);
    expect(fixture.intentIds()).toEqual([first.paymentRef]);
  });

  it("finds the same intent after a lost answer or a front-door 500", async () => {
    const { fixture, provider } = harness();
    const input = createInput();
    fixture.timeoutNext({ afterExecution: true });
    expect(await unavailable(provider.createPayment(input))).toBe("stripe_unreachable");
    expect(fixture.intentIds()).toHaveLength(1);
    const retried = await provider.createPayment(input);
    expect(fixture.intentIds()).toEqual([retried.paymentRef]);

    const other = createInput();
    fixture.answerNext({ status: 500, body: stripeError("api_error") });
    expect(await unavailable(provider.createPayment(other))).toBe("stripe_server_error");
    const created = await provider.createPayment(other);
    expect(await provider.createPayment(other)).toEqual(created);
    expect(fixture.intentIds()).toEqual([retried.paymentRef, created.paymentRef]);
  });

  it("refuses the same key with other parameters", async () => {
    const { fixture, provider } = harness();
    const input = createInput();
    await provider.createPayment(input);
    expect(await rejectedCode(provider.createPayment({ ...input, amount: 6000 }))).toBe(
      "idempotency_key_reused",
    );
    expect(
      await rejectedCode(provider.createPayment({ ...input, clientReference: randomUUID() })),
    ).toBe("idempotency_key_reused");
    expect(fixture.intentIds()).toHaveLength(1);
  });

  it("lets a key refused by validation run again, as Stripe caches only executed requests", async () => {
    const fixture = createStripeFixture();
    const post = (body: string) =>
      fixture.fetch("https://api.stripe.com/v1/payment_intents", {
        method: "POST",
        headers: {
          authorization: `Bearer ${fixture.secretKey}`,
          "stripe-version": STRIPE_API_VERSION,
          "stripe-account": harbor,
          "idempotency-key": "checkout_payment:validation-then-fixed",
          "content-type": "application/x-www-form-urlencoded",
        },
        body,
      });
    const small = await post("amount=10&currency=usd");
    expect(small.status).toBe(400);
    const unknown = await post("amount=5000&currency=usd&application_fee_amount=1");
    expect(unknown.status).toBe(400);
    const fixed = await post("amount=5000&currency=usd");
    expect(fixed.status).toBe(200);
    expect(fixed.headers.get("idempotent-replayed")).toBeNull();
    const again = await post("amount=5000&currency=usd");
    expect(again.headers.get("idempotent-replayed")).toBe("true");
  });

  it("refuses what Stripe would refuse before asking it", async () => {
    const { fixture, provider } = harness();
    expect(await rejectedCode(provider.createPayment(createInput({ amount: 49 })))).toBe(
      "amount_invalid",
    );
    expect(await rejectedCode(provider.createPayment(createInput({ amount: 50.5 })))).toBe(
      "amount_invalid",
    );
    expect(await rejectedCode(provider.createPayment(createInput({ key: "short" })))).toBe(
      "idempotency_key_invalid",
    );
    expect(
      await rejectedCode(provider.createPayment({ ...createInput(), clientReference: "order-7" })),
    ).toBe("client_reference_invalid");
    expect(
      await unavailable(provider.createPayment(createInput({ account: "acct_fake_demo-harbor" }))),
    ).toBe("stripe_config");
    expect(fixture.requests).toHaveLength(0);
  });
});

describe("Stripe's errors", () => {
  const scripted = async (status: number, body: string, headers?: Record<string, string>) => {
    const { fixture, provider } = harness();
    fixture.answerNext({
      status,
      body,
      headers: { "content-type": "application/json", ...headers },
    });
    return caught(provider.createPayment(createInput()));
  };

  it("maps each status as the error mapping table says", async () => {
    const cases: [number, string, Record<string, string> | undefined, string, string][] = [
      [401, stripeError("invalid_request_error"), undefined, "unavailable", "stripe_auth"],
      [402, stripeError("card_error", "card_declined"), undefined, "rejected", "card_declined"],
      [403, stripeError("invalid_request_error"), undefined, "unavailable", "stripe_config"],
      [
        404,
        stripeError("invalid_request_error", "resource_missing"),
        undefined,
        "rejected",
        "resource_missing",
      ],
      [404, stripeError("invalid_request_error"), undefined, "rejected", "http_404"],
      [400, stripeError("invalid_request_error", "Not-A-Code"), undefined, "rejected", "http_400"],
      [409, stripeError("idempotency_error"), undefined, "unavailable", "stripe_conflict"],
      [424, stripeError("api_error"), undefined, "unavailable", "stripe_unexpected_status"],
      [
        429,
        stripeError("invalid_request_error", "rate_limit"),
        undefined,
        "unavailable",
        "stripe_rate_limited",
      ],
      [
        400,
        stripeError("invalid_request_error", "parameter_invalid_integer"),
        { "stripe-should-retry": "true" },
        "unavailable",
        "stripe_retry",
      ],
      [
        500,
        stripeError("api_error"),
        { "stripe-should-retry": "false" },
        "unavailable",
        "stripe_server_error",
      ],
      [
        503,
        "<html>unavailable</html>",
        { "content-type": "text/html" },
        "unavailable",
        "stripe_server_error",
      ],
      [418, "{}", undefined, "unavailable", "stripe_unexpected_status"],
      [302, "", undefined, "unavailable", "stripe_unexpected_status"],
      [200, "not json", undefined, "unavailable", "stripe_malformed_response"],
      [
        200,
        JSON.stringify({ object: "charge" }),
        undefined,
        "unavailable",
        "stripe_malformed_response",
      ],
      [200, "[]", undefined, "unavailable", "stripe_malformed_response"],
      [400, stripeError("idempotency_error"), undefined, "rejected", "idempotency_key_reused"],
    ];
    for (const [status, body, headers, kind, code] of cases) {
      const error = await scripted(status, body, headers);
      if (kind === "unavailable") {
        expect(error, `${status} ${body}`).toBeInstanceOf(ProviderUnavailableError);
        expect((error as Error).message).toBe(code);
      } else {
        expect(error, `${status} ${body}`).toBeInstanceOf(ProviderRejectedError);
        expect((error as ProviderRejectedError).code).toBe(code);
      }
    }
  });

  it("treats every configuration and transient code as an unknown outcome", async () => {
    for (const code of configurationCodes) {
      for (const status of [400, 402, 404]) {
        const error = await scripted(status, stripeError("invalid_request_error", code));
        expect(error, `${status} ${code}`).toBeInstanceOf(ProviderUnavailableError);
        expect((error as Error).message).toBe("stripe_config");
      }
    }
    for (const code of transientCodes) {
      const error = await scripted(400, stripeError("invalid_request_error", code));
      expect(error, code).toBeInstanceOf(ProviderUnavailableError);
      expect((error as Error).message).toBe("stripe_retry");
    }
    // A key still in flight is not a reused key.
    const inUse = await scripted(400, stripeError("idempotency_error", "idempotency_key_in_use"));
    expect(inUse).toBeInstanceOf(ProviderUnavailableError);
  });

  it("never echoes Stripe's words", async () => {
    const error = await scripted(
      402,
      stripeError("card_error", "card_declined", "Your card ending 4242 was declined"),
    );
    const text = [String(error), (error as Error).message, JSON.stringify(error)].join(" ");
    expect(text.includes("4242")).toBe(false);
    expect(text.includes("was declined")).toBe(false);
  });

  it("refuses an answer about another payment, and a live object under a test key", async () => {
    const { fixture, provider } = harness();
    const input = createInput();
    const created = await provider.createPayment(input);
    const intent = fixture.intent(created.paymentRef);
    fixture.answerNext({ status: 200, body: JSON.stringify(intent) });
    expect(await rejectedCode(provider.createPayment(createInput()))).toBe("malformed_response");
    fixture.answerNext({ status: 200, body: JSON.stringify({ ...intent, amount: 4000 }) });
    expect(await rejectedCode(provider.createPayment(input))).toBe("malformed_response");
    fixture.answerNext({ status: 200, body: JSON.stringify({ ...intent, livemode: true }) });
    expect(await unavailable(provider.createPayment(input))).toBe("stripe_malformed_response");
    fixture.answerNext({ status: 200, body: JSON.stringify({ ...intent, client_secret: null }) });
    expect(await unavailable(provider.createPayment(input))).toBe("stripe_malformed_response");
    fixture.answerNext({
      status: 200,
      body: JSON.stringify({ ...intent, client_secret: "pi_Other_secret_abc" }),
    });
    expect(await unavailable(provider.createPayment(input))).toBe("stripe_malformed_response");
  });
});

describe("no secret leaves through an error", () => {
  function leaks(error: unknown, secrets: string[]): boolean {
    const e = error as Error & Record<string, unknown>;
    const text = [String(error), e.message, e.stack, JSON.stringify(e), JSON.stringify({ ...e })];
    return text.some((t) => typeof t === "string" && secrets.some((s) => t.includes(s)));
  }

  it("carries no key, webhook secret, or cause on any error path", async () => {
    const { fixture, provider } = harness();
    const secrets = [fixture.secretKey, fixture.webhookSecret];
    const created = await paid(fixture, provider);
    const ref = created.paymentRef;
    const errors: unknown[] = [];
    // Create.
    fixture.answerNext({ status: 401, body: stripeError("invalid_request_error") });
    errors.push(await caught(provider.createPayment(createInput())));
    fixture.answerNext({ status: 500, body: stripeError("api_error") });
    errors.push(await caught(provider.createPayment(createInput())));
    fixture.answerNext({ status: 200, body: "{" });
    errors.push(await caught(provider.createPayment(createInput())));
    fixture.timeoutNext();
    errors.push(await caught(provider.createPayment(createInput())));
    // Retrieve.
    fixture.answerNext({ status: 500, body: stripeError("api_error") });
    errors.push(await caught(provider.retrievePayment({ accountRef: harbor, paymentRef: ref })));
    fixture.timeoutNext();
    errors.push(await caught(provider.retrievePayment({ accountRef: harbor, paymentRef: ref })));
    // Refund lookup.
    fixture.answerNext({ status: 500, body: stripeError("api_error") }, { method: "GET" });
    errors.push(await caught(provider.refundPayment(refundInput(ref))));
    fixture.answerNext(
      { status: 403, body: stripeError("invalid_request_error") },
      { method: "GET" },
    );
    errors.push(await caught(provider.refundPayment(refundInput(ref))));
    // Refund POST.
    fixture.answerNext({ status: 500, body: stripeError("api_error") }, { method: "POST" });
    errors.push(await caught(provider.refundPayment(refundInput(ref))));
    fixture.timeoutNext({ method: "POST" });
    errors.push(await caught(provider.refundPayment(refundInput(ref))));
    // A wrong key.
    const wrong = createStripePaymentProvider({
      secretKey: keyOf("rk", "test", "fixture", "WrongWrongWrong01"),
      webhookSecret: fixture.webhookSecret,
      environment: "local",
      fetch: fixture.fetch,
    });
    errors.push(await caught(wrong.createPayment(createInput())));
    // A fetch that puts the headers into its own message.
    const thrower = createStripePaymentProvider({
      secretKey: fixture.secretKey,
      webhookSecret: fixture.webhookSecret,
      environment: "local",
      fetch: async (_input, init) => {
        throw new Error(`refused: ${JSON.stringify(init?.headers)} ${String(init?.body)}`);
      },
    });
    errors.push(await caught(thrower.createPayment(createInput())));
    errors.push(await caught(thrower.retrievePayment({ accountRef: harbor, paymentRef: ref })));
    errors.push(await caught(thrower.refundPayment(refundInput(ref))));
    expect(errors).toHaveLength(14);
    for (const error of errors) {
      expect(error).toBeInstanceOf(Error);
      expect(leaks(error, secrets)).toBe(false);
      expect((error as Error).cause).toBeUndefined();
    }
  });

  it("names no key in a configuration refusal", () => {
    const key = keyOf("sk", "live", "LiveLiveLiveLiveLiveLive00");
    let error: unknown;
    try {
      createStripePaymentProvider({
        secretKey: key,
        webhookSecret: keyOf("whsec", "SyntheticSyntheticSynthetic01"),
        environment: "local",
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(TypeError);
    expect(leaks(error, [key])).toBe(false);
  });
});

describe("refunds", () => {
  it("reports succeeded, failed, and canceled refunds", async () => {
    const { fixture, provider } = harness();
    const created = await paid(fixture, provider);
    const ok = await provider.refundPayment(refundInput(created.paymentRef));
    expect(ok).toEqual({ refundRef: expect.stringMatching(/^re_/), status: "succeeded" });
    fixture.refundNext("failed", "expired_or_canceled_card");
    expect(await provider.refundPayment(refundInput(created.paymentRef))).toEqual({
      refundRef: expect.stringMatching(/^re_/),
      status: "failed",
      failureCode: "expired_or_canceled_card",
    });
    fixture.refundNext("canceled");
    expect(await provider.refundPayment(refundInput(created.paymentRef))).toEqual({
      refundRef: expect.stringMatching(/^re_/),
      status: "failed",
      failureCode: "refund_canceled",
    });
    fixture.refundNext("failed", "Something Odd");
    expect(await provider.refundPayment(refundInput(created.paymentRef))).toMatchObject({
      status: "failed",
      failureCode: "refund_failed",
    });
  });

  it("leaves a pending refund unknown, then reads it settled on the next call", async () => {
    const { fixture, provider } = harness();
    const created = await paid(fixture, provider);
    const input = refundInput(created.paymentRef);
    fixture.refundPending();
    expect(await unavailable(provider.refundPayment(input))).toBe("stripe_refund_pending");
    expect(await unavailable(provider.refundPayment(input))).toBe("stripe_refund_pending");
    const [refundRef] = fixture.refundIds(created.paymentRef);
    if (!refundRef) throw new Error("no refund");
    fixture.settleRefund(refundRef, "succeeded");
    const before = fixture.requests.length;
    expect(await provider.refundPayment(input)).toEqual({ refundRef, status: "succeeded" });
    // Found by the lookup: no second POST.
    expect(fixture.requests.slice(before).map((r) => r.method)).toEqual(["GET"]);
    expect(fixture.refundIds(created.paymentRef)).toEqual([refundRef]);
  });

  it("creates no second refund after Stripe forgets the key", async () => {
    const { fixture, provider } = harness();
    const created = await paid(fixture, provider);
    const input = refundInput(created.paymentRef);
    const first = await provider.refundPayment(input);
    fixture.pruneKeys();
    expect(await provider.refundPayment(input)).toEqual(first);
    expect(fixture.refundIds(created.paymentRef)).toEqual([first.refundRef]);

    // A lost answer, then a forgotten key.
    const other = refundInput(created.paymentRef, { amount: 500 });
    fixture.timeoutNext({ afterExecution: true, method: "POST" });
    expect(await unavailable(provider.refundPayment(other))).toBe("stripe_unreachable");
    fixture.pruneKeys();
    const found = await provider.refundPayment(other);
    expect(found.status).toBe("succeeded");
    expect(fixture.refundIds(created.paymentRef)).toEqual([first.refundRef, found.refundRef]);
  });

  it("pages past refunds made elsewhere, within a bound", async () => {
    const { fixture, provider } = harness();
    const created = await paid(fixture, provider);
    const input = refundInput(created.paymentRef);
    const first = await provider.refundPayment(input);
    fixture.addForeignRefunds(created.paymentRef, 150);
    fixture.pruneKeys();
    const before = fixture.requests.length;
    expect(await provider.refundPayment(input)).toEqual(first);
    const pages = fixture.requests.slice(before);
    expect(pages.map((r) => r.method)).toEqual(["GET", "GET"]);
    expect(pages[1]?.search).toContainEqual(["starting_after", expect.stringMatching(/^re_/)]);

    fixture.addForeignRefunds(created.paymentRef, 400);
    const after = fixture.requests.length;
    expect(await unavailable(provider.refundPayment(input))).toBe("stripe_refund_lookup_exhausted");
    const bounded = fixture.requests.slice(after);
    expect(bounded).toHaveLength(5);
    expect(bounded.every((r) => r.method === "GET")).toBe(true);
    // An unknown key behind a full bound is never created blind.
    expect(
      await unavailable(provider.refundPayment(refundInput(created.paymentRef, { amount: 1 }))),
    ).toBe("stripe_refund_lookup_exhausted");
    expect(fixture.refundIds(created.paymentRef)).toHaveLength(551);
  });

  it("reconciles charge_already_refunded through a second lookup", async () => {
    const { fixture, provider } = harness();
    const created = await paid(fixture, provider);
    const input = refundInput(created.paymentRef, { amount: 5000 });
    const first = await provider.refundPayment(input);
    // Another caller's lookup missed it and the key was forgotten.
    fixture.pruneKeys();
    fixture.answerNext(
      {
        status: 200,
        body: JSON.stringify({ object: "list", data: [], has_more: false, url: "/v1/refunds" }),
      },
      { method: "GET", path: "/v1/refunds" },
    );
    expect(await provider.refundPayment(input)).toEqual(first);
    expect(fixture.requests.slice(-3).map((r) => r.method)).toEqual(["GET", "POST", "GET"]);

    // Fully refunded by another key: not found, so never final.
    expect(
      await unavailable(provider.refundPayment(refundInput(created.paymentRef, { amount: 5000 }))),
    ).toBe("stripe_refund_unreconciled");
    expect(fixture.refundIds(created.paymentRef)).toEqual([first.refundRef]);
  });

  it("leaves a refund unknown on authentication, permission, and account faults", async () => {
    const { fixture, provider } = harness();
    const created = await paid(fixture, provider);
    const cases: [number, string | undefined, string][] = [
      [401, undefined, "stripe_auth"],
      [403, undefined, "stripe_config"],
      ...configurationCodes.map((code): [number, string, string] => [400, code, "stripe_config"]),
      ...transientCodes.map((code): [number, string, string] => [400, code, "stripe_retry"]),
    ];
    for (const [status, code, expected] of cases) {
      // The POST: the lookup runs for real and finds nothing.
      fixture.answerNext(
        { status, body: stripeError("invalid_request_error", code) },
        { method: "POST", path: "/v1/refunds" },
      );
      expect(
        await unavailable(provider.refundPayment(refundInput(created.paymentRef))),
        `POST ${status} ${code}`,
      ).toBe(expected);
    }
    expect(fixture.refundIds(created.paymentRef)).toHaveLength(0);
  });

  it("never settles a refund on a refused lookup, which is not an answer about the refund", async () => {
    const { fixture, provider } = harness();
    const created = await paid(fixture, provider);
    for (const [status, code] of [
      [401, undefined],
      [403, undefined],
      [400, "account_invalid"],
      [400, "capability_not_active"],
      [400, "parameter_unknown"],
      [404, "resource_missing"],
      [404, undefined],
      [402, "card_declined"],
    ] as const) {
      fixture.answerNext(
        { status, body: stripeError("invalid_request_error", code) },
        { method: "GET", path: "/v1/refunds" },
      );
      const error = await caught(provider.refundPayment(refundInput(created.paymentRef)));
      expect(error, `GET ${status} ${code}`).toBeInstanceOf(ProviderUnavailableError);
    }
    const posts = fixture.requests.filter((r) => r.method === "POST" && r.path === "/v1/refunds");
    expect(posts).toEqual([]);
  });

  it("refuses a reused key with another amount, and refunds that cannot happen", async () => {
    const { fixture, provider } = harness();
    const created = await paid(fixture, provider);
    const input = refundInput(created.paymentRef);
    await provider.refundPayment(input);
    expect(await rejectedCode(provider.refundPayment({ ...input, amount: 2000 }))).toBe(
      "idempotency_key_reused",
    );
    expect(
      await rejectedCode(provider.refundPayment(refundInput(created.paymentRef, { amount: 4001 }))),
    ).toBe("amount_too_large");
    const unpaid = await provider.createPayment(createInput());
    expect(await rejectedCode(provider.refundPayment(refundInput(unpaid.paymentRef)))).toBe(
      "payment_intent_unexpected_state",
    );
    expect(
      await rejectedCode(provider.refundPayment({ ...input, paymentRef: "fpay_notstripe" })),
    ).toBe("payment_ref_invalid");
    expect(await rejectedCode(provider.refundPayment({ ...input, amount: 0 }))).toBe(
      "amount_invalid",
    );
  });

  it("never trusts a refund answer about something else", async () => {
    const { fixture, provider } = harness();
    const created = await paid(fixture, provider);
    const input = refundInput(created.paymentRef);
    const refund = {
      id: "re_TestFixture9999999999999",
      object: "refund",
      amount: 1000,
      currency: "usd",
      metadata: { tidegrid_refund_key: input.idempotencyKey },
      payment_intent: "pi_TestFixture9999999999999",
      status: "succeeded",
      failure_reason: null,
    };
    fixture.answerNext({ status: 200, body: JSON.stringify(refund) }, { method: "POST" });
    expect(await unavailable(provider.refundPayment(input))).toBe("stripe_malformed_response");
    fixture.answerNext(
      {
        status: 200,
        body: JSON.stringify({ object: "list", data: [refund], has_more: false }),
      },
      { method: "GET" },
    );
    expect(await unavailable(provider.refundPayment(input))).toBe("stripe_malformed_response");
    fixture.answerNext(
      {
        status: 200,
        body: JSON.stringify({
          ...refund,
          payment_intent: created.paymentRef,
          status: "requires_review",
        }),
      },
      { method: "POST" },
    );
    expect(await unavailable(provider.refundPayment(input))).toBe("stripe_refund_status_unknown");
  });
});

describe("reading a payment", () => {
  it("follows the intent from pending to paid, refunded, and canceled", async () => {
    const { fixture, provider } = harness();
    const created = await provider.createPayment(createInput());
    const read = () =>
      provider.retrievePayment({ accountRef: harbor, paymentRef: created.paymentRef });
    expect(await read()).toEqual({
      paymentRef: created.paymentRef,
      status: "pending",
      amount: 5000,
      currency: "USD",
      amountRefunded: 0,
    });
    const declined = fixture.decline(created.paymentRef);
    // Stripe points latest_charge at the failed charge of a declined attempt.
    expect(declined.latest_charge).toMatch(/^ch_/);
    expect(await read()).toMatchObject({ status: "pending", amountRefunded: 0 });
    const paidIntent = fixture.succeed(created.paymentRef);
    expect(paidIntent.latest_charge).toMatch(/^ch_/);
    expect(paidIntent.latest_charge).not.toBe(declined.latest_charge);
    expect(await read()).toMatchObject({ status: "succeeded", amountRefunded: 0 });
    await provider.refundPayment(refundInput(created.paymentRef, { amount: 1200 }));
    expect(await read()).toMatchObject({ status: "succeeded", amountRefunded: 1200 });

    const other = await provider.createPayment(createInput());
    fixture.cancel(other.paymentRef);
    expect(
      await provider.retrievePayment({ accountRef: harbor, paymentRef: other.paymentRef }),
    ).toMatchObject({ status: "failed", amountRefunded: 0 });
  });

  it("answers null for a missing or malformed id", async () => {
    const { fixture, provider } = harness();
    expect(
      await provider.retrievePayment({
        accountRef: harbor,
        paymentRef: "pi_TestFixture0000000009999",
      }),
    ).toBeNull();
    const requests = fixture.requests.length;
    expect(
      await provider.retrievePayment({ accountRef: harbor, paymentRef: "pi_../../v1/refunds" }),
    ).toBeNull();
    expect(fixture.requests).toHaveLength(requests);
  });

  it("refuses a charge it did not expand", async () => {
    const { fixture, provider } = harness();
    const created = await paid(fixture, provider);
    fixture.answerNext({ status: 200, body: JSON.stringify(fixture.intent(created.paymentRef)) });
    expect(
      await unavailable(
        provider.retrievePayment({ accountRef: harbor, paymentRef: created.paymentRef }),
      ),
    ).toBe("stripe_malformed_response");
  });
});

describe("two tenants", () => {
  it("keeps each connected account's intents and refunds to itself", async () => {
    const { fixture, provider } = harness();
    const created = await paid(fixture, provider);
    expect(
      await provider.retrievePayment({ accountRef: reef, paymentRef: created.paymentRef }),
    ).toBeNull();
    expect(
      await provider.retrievePayment({ accountRef: harbor, paymentRef: created.paymentRef }),
    ).toMatchObject({ status: "succeeded" });
    // Another account's intent does not exist there. The lookup is refused, and
    // a refused lookup is never a final answer about the refund.
    expect(
      await unavailable(
        provider.refundPayment({ ...refundInput(created.paymentRef), accountRef: reef }),
      ),
    ).toBe("stripe_refund_lookup_refused");
    expect(fixture.refundIds(created.paymentRef)).toHaveLength(0);
    const theirs = await provider.createPayment(createInput({ account: reef }));
    expect(fixture.requests.at(-1)?.stripeAccount).toBe(reef);
    expect(
      await provider.retrievePayment({ accountRef: harbor, paymentRef: theirs.paymentRef }),
    ).toBeNull();
  });

  it("sends Stripe-Account on every call; the fixture trips on a missing one", async () => {
    // Real Stripe runs a call without the header on the platform account, as a
    // platform charge. The adapter's own check is the guard; the fixture's
    // refusal is a test tripwire, not Stripe's behavior.
    const { fixture, provider } = harness();
    const created = await paid(fixture, provider);
    await provider.retrievePayment({ accountRef: harbor, paymentRef: created.paymentRef });
    await provider.refundPayment(refundInput(created.paymentRef));
    await provider.createPayment(createInput({ account: reef }));
    expect(fixture.requests.length).toBeGreaterThan(4);
    for (const request of fixture.requests) {
      expect(request.stripeAccount === harbor || request.stripeAccount === reef).toBe(true);
    }
    const response = await fixture.fetch("https://api.stripe.com/v1/payment_intents", {
      method: "POST",
      headers: {
        authorization: `Bearer ${fixture.secretKey}`,
        "stripe-version": STRIPE_API_VERSION,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "amount=5000&currency=usd",
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "fixture_tripwire_stripe_account_missing",
    );
  });

  it("is refused 403 for an account the key cannot reach", async () => {
    const fixture = createStripeFixture();
    const response = await fixture.fetch("https://api.stripe.com/v1/payment_intents", {
      method: "POST",
      headers: {
        authorization: `Bearer ${fixture.secretKey}`,
        "stripe-version": STRIPE_API_VERSION,
        "stripe-account": "acct_1TestNobody0000",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "amount=5000&currency=usd",
    });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "account_invalid",
    );
    const provider = createStripePaymentProvider({
      secretKey: fixture.secretKey,
      webhookSecret: fixture.webhookSecret,
      environment: "local",
      fetch: fixture.fetch,
    });
    expect(
      await unavailable(provider.createPayment(createInput({ account: "acct_1TestNobody0000" }))),
    ).toBe("stripe_config");
    expect(fixture.intentIds()).toHaveLength(0);
  });
});

describe("configuration", () => {
  const webhookSecret = keyOf("whsec", "SyntheticSyntheticSynthetic01");
  const testKey = keyOf("sk", "test", "SyntheticSyntheticSynth01");
  const build = (options: Partial<StripeProviderOptions>) => () =>
    createStripePaymentProvider({
      secretKey: testKey,
      webhookSecret,
      environment: "local",
      fetch: async () => new Response("{}"),
      ...options,
    });

  it("refuses live keys everywhere, malformed keys, and test keys in production", () => {
    for (const prefix of ["sk", "rk", "pk"]) {
      const live = keyOf(prefix, "live", "LiveLiveLiveLiveLiveLive00");
      for (const environment of ["local", "preview", "staging", "production"]) {
        expect(build({ secretKey: live, environment })).toThrow(/live_key/);
      }
    }
    expect(build({ secretKey: keyOf("sk", "test", "short") })).toThrow(/key_malformed/);
    expect(build({ secretKey: keyOf("pk", "test", "SyntheticSyntheticSynth01") })).toThrow(
      /key_malformed/,
    );
    expect(build({ secretKey: `${testKey}\n` })).toThrow(/key_malformed/);
    expect(build({ secretKey: "" })).toThrow(/stripe_key_missing/);
    expect(build({ environment: "production" })).toThrow(/stripe_test_in_production/);
    expect(build({ webhookSecret: "" })).toThrow(/stripe_webhook_secret_missing/);
    expect(build({ webhookSecret: keyOf("whsec", "short") })).toThrow(/webhook_secret_malformed/);
    expect(build({ webhookSecret: testKey })).toThrow(/webhook_secret_malformed/);
    expect(build({ secretKey: keyOf("rk", "test", "SyntheticSyntheticSynth01") })).not.toThrow();
    expect(build({ environment: "staging" })).not.toThrow();
  });

  it("refuses the fixture's credentials anywhere but over an injected fetch", () => {
    const fixture = createStripeFixture();
    for (const environment of ["local", "preview", "staging", "production"]) {
      expect(
        checkStripeConfig({
          secretKey: fixture.secretKey,
          webhookSecret: webhookSecret,
          environment,
        }),
      ).toMatchObject({ kind: "refused" });
      expect(
        checkStripeConfig({
          secretKey: testKey,
          webhookSecret: fixture.webhookSecret,
          environment,
        }),
      ).toMatchObject({ kind: "refused" });
    }
    const real = () =>
      createStripePaymentProvider({
        secretKey: fixture.secretKey,
        webhookSecret: fixture.webhookSecret,
        environment: "staging",
      });
    expect(real).toThrow(/key_malformed/);
    expect(
      build({ secretKey: fixture.secretKey, webhookSecret: fixture.webhookSecret }),
    ).not.toThrow();
    // A fixture key never pairs with a real secret, or the other way round.
    expect(build({ secretKey: fixture.secretKey })).toThrow(/webhook_secret_malformed/);
    expect(build({ webhookSecret: fixture.webhookSecret })).toThrow(/webhook_secret_malformed/);
  });

  it("reports each settings branch", () => {
    const live = keyOf("rk", "live", "LiveLiveLiveLiveLiveLive00");
    const check = (
      secretKey: string | undefined,
      secret: string | undefined,
      environment = "dev",
    ) => checkStripeConfig({ secretKey, webhookSecret: secret, environment });
    expect(check(testKey, webhookSecret)).toBeNull();
    expect(check(undefined, webhookSecret)).toEqual({ kind: "off", reason: "stripe_key_missing" });
    expect(check(testKey, undefined)).toEqual({
      kind: "off",
      reason: "stripe_webhook_secret_missing",
    });
    expect(check(live, undefined)).toEqual({ kind: "refused", reason: "live_key" });
    expect(check("placeholder", webhookSecret)).toEqual({
      kind: "refused",
      reason: "key_malformed",
    });
    expect(check(testKey, webhookSecret, "production")).toEqual({
      kind: "refused",
      reason: "stripe_test_in_production",
    });
    expect(check(testKey, "whsec_placeholder")).toEqual({
      kind: "refused",
      reason: "webhook_secret_malformed",
    });
  });

  it("takes only an https Stripe origin, and another one only with an injected fetch", () => {
    expect(build({ apiBase: "http://api.stripe.com" })).toThrow(/https origin/);
    expect(build({ apiBase: "https://api.stripe.com/v1" })).toThrow(/https origin/);
    expect(build({ apiBase: "https://user:pw@api.stripe.com" })).toThrow(/https origin/);
    expect(build({ apiBase: "not a url" })).toThrow(/not a URL/);
    expect(() =>
      createStripePaymentProvider({
        secretKey: testKey,
        webhookSecret,
        environment: "local",
        apiBase: "https://stripe.example.test",
      }),
    ).toThrow(/injected fetch/);
    expect(build({ apiBase: "https://stripe.example.test" })).not.toThrow();
    expect(build({ apiBase: "https://api.stripe.com/" })).not.toThrow();
    expect(build({ requestTimeoutMs: 0 })).toThrow(RangeError);
  });

  it("clamps the signature tolerance to 1-300 seconds", () => {
    expect(build({ toleranceSeconds: 0 })().toleranceSeconds).toBe(1);
    expect(build({ toleranceSeconds: -5 })().toleranceSeconds).toBe(1);
    expect(build({ toleranceSeconds: 1000 })().toleranceSeconds).toBe(300);
    expect(build({ toleranceSeconds: 10.7 })().toleranceSeconds).toBe(10);
    expect(build({ toleranceSeconds: Number.NaN })().toleranceSeconds).toBe(300);
    expect(build({})().toleranceSeconds).toBe(300);
  });

  it("names itself and Stripe's minimum", () => {
    const provider = build({})();
    expect(provider.name).toBe("stripe");
    expect(provider.signatureHeader).toBe("stripe-signature");
    expect(provider.minimumAmount("USD")).toBe(50);
  });

  it("calls the global fetch, bound, when none is injected", async () => {
    const provider = createStripePaymentProvider({
      secretKey: testKey,
      webhookSecret,
      environment: "local",
    });
    expect(await unavailable(provider.createPayment(createInput()))).toBe("stripe_unreachable");
    // The guard fetch stood in for the network, and was the one reached.
    expect(realFetchCalls).toBe(1);
    realFetchCalls = 0;
  });
});
