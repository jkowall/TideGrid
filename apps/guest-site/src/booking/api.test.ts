import { CheckoutSecret, IdempotencyKey } from "@tidegrid/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiBase } from "../bootstrap.ts";
import {
  CheckoutAttempt,
  type CheckoutBody,
  CommandKey,
  cancelCheckout,
  commandTimeoutMs,
  createQuote,
  type Failure,
  getListing,
  getOffer,
  getQuote,
  newCheckoutSecret,
  newIdempotencyKey,
  openCheckout,
  outcomeUnknown,
  type QuoteBody,
  type Result,
  readCheckout,
  readTimeoutMs,
  settleTestPayment,
} from "./api.ts";
import {
  charterListing,
  checkout,
  json,
  listing,
  offer,
  refusal,
  routeOf,
  sharedQuote,
  stubApi,
  testNow,
  tripId,
} from "./fixtures.ts";

const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const secretPattern = /^[A-Za-z0-9_-]{43}$/;

const quoteId = "0b7f3a52-9c1e-4d2a-8f6b-000000000001";
const sessionId = "5d0c4a1e-2b3c-4d5e-8f60-000000000001";
/** The shape of a checkout secret (43 base64url characters), made up for these tests. */
const secret = "test_secret_".padEnd(43, "x");
const payment = {
  provider: "fake",
  paymentRef: "fpay_test_1",
  clientSecret: "fpay_test_1_secret_abc123",
} as const;
const quoteRequest: QuoteBody = {
  tripId,
  party: { kind: "tickets", tickets: [{ code: "adult", quantity: 2 }] },
  addOns: [],
};
const checkoutRequest: CheckoutBody = {
  quoteId,
  acceptedPolicyVersion: 1,
  booker: { name: "Ava Guest", email: "ava@example.test" },
  checkoutSecret: secret,
};
const settled = {
  event: { id: "evt_1", type: "payment.succeeded", createdAt: testNow.toISOString() },
  alreadySettled: false,
  delivery: { status: 200, outcome: "confirmed", duplicate: false },
};

// Stubs --------------------------------------------------------------------------------------

/** One request, as fetch received it. */
interface Sent {
  url: string;
  init: RequestInit;
  headers: Headers;
}

const record = (input: RequestInfo | URL, init: RequestInit = {}): Sent => ({
  url: String(input),
  init,
  headers: new Headers(init.headers),
});

const aborted = () => new DOMException("This operation was aborted", "AbortError");

/** Stub fetch: record each request, and fail as fetch does when the signal is already aborted. */
function stubFetch(answer: (sent: Sent) => Response | Promise<Response>): Sent[] {
  const sent: Sent[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = record(input, init);
      sent.push(request);
      if (request.init.signal?.aborted) throw aborted();
      return answer(request);
    }),
  );
  return sent;
}

/** Stub a fetch that never answers, and fails only when its signal aborts. */
function stubHungFetch(): Sent[] {
  const sent: Sent[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const request = record(input, init);
          sent.push(request);
          if (request.init.signal?.aborted) reject(aborted());
          else
            request.init.signal?.addEventListener("abort", () => reject(aborted()), { once: true });
        }),
    ),
  );
  return sent;
}

/** The one request that was sent. */
function only(sent: Sent[]): Sent {
  expect(sent).toHaveLength(1);
  const [call] = sent;
  if (!call) throw new Error("no request was sent");
  return call;
}

/** Replace crypto with one whose random bytes the test chooses, and note how many were asked for. */
function stubRandom(fill: (bytes: Uint8Array) => void): number[] {
  const sizes: number[] = [];
  vi.stubGlobal("crypto", {
    getRandomValues: (bytes: Uint8Array) => {
      sizes.push(bytes.length);
      fill(bytes);
      return bytes;
    },
  });
  return sizes;
}

/** What every call sends: no credentials, nothing cached, no referrer, JSON wanted. */
function expectGuarded(call: Sent) {
  expect(call.init.credentials).toBe("omit");
  expect(call.init.cache).toBe("no-store");
  expect(call.init.referrerPolicy).toBe("no-referrer");
  expect(call.headers.get("accept")).toBe("application/json");
  expect(call.init.signal).toBeInstanceOf(AbortSignal);
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// Requests -------------------------------------------------------------------------------------

describe("getOffer", () => {
  it("sends a plain GET that carries nothing private", async () => {
    const sent = stubFetch(() => json({ offer }));
    expect(await getOffer(tripId)).toEqual({ kind: "ok", value: offer, replayed: false });
    const call = only(sent);
    expect(call.url).toBe(`${apiBase}/v1/public/trips/${tripId}/offer`);
    expect(call.init.method).toBe("GET");
    expect(call.init.body).toBeUndefined();
    expectGuarded(call);
    expect(call.headers.has("authorization")).toBe(false);
    expect(call.headers.has("idempotency-key")).toBe(false);
    expect(call.headers.has("content-type")).toBe(false);
  });

  it("encodes the trip id into one path segment", async () => {
    const sent = stubFetch(() => json({ offer }));
    await getOffer("a/b?c#d");
    expect(only(sent).url).toBe(`${apiBase}/v1/public/trips/a%2Fb%3Fc%23d/offer`);
  });
});

describe("getListing", () => {
  it("asks for the trip's own date and product, for its smallest party", async () => {
    const sent = stubFetch(() => json({ trips: [listing] }));
    expect(await getListing(offer)).toEqual({ kind: "ok", value: listing, replayed: false });
    const call = only(sent);
    const url = new URL(call.url);
    expect(`${url.origin}${url.pathname}`).toBe(`${apiBase}/v1/public/trips`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      from: "2026-10-07",
      to: "2026-10-07",
      party: "1",
      product: offer.product.id,
    });
    expect(call.init.method).toBe("GET");
    expectGuarded(call);
    expect(call.headers.has("authorization")).toBe(false);
    expect(call.headers.has("idempotency-key")).toBe(false);
  });

  it("asks for the product's smallest party, and for at least one", async () => {
    const sent = stubFetch(() => json({ trips: [] }));
    const partyOf = (minPartySize: number) => ({
      ...offer,
      product: { ...offer.product, minPartySize },
    });
    await getListing(partyOf(4));
    await getListing(partyOf(0));
    expect(sent.map((c) => new URL(c.url).searchParams.get("party"))).toEqual(["4", "1"]);
  });

  it("picks this trip from the list", async () => {
    stubFetch(() => json({ trips: [charterListing, listing] }));
    expect(await getListing(offer)).toEqual({ kind: "ok", value: listing, replayed: false });
  });

  it("answers null when the trip is not in the list", async () => {
    stubFetch(() => json({ trips: [charterListing] }));
    expect(await getListing(offer)).toEqual({ kind: "ok", value: null, replayed: false });
    stubFetch(() => json({ trips: [] }));
    expect(await getListing(offer)).toEqual({ kind: "ok", value: null, replayed: false });
  });
});

describe("createQuote", () => {
  it("posts the body as JSON under the idempotency key, with no authorization", async () => {
    const quote = sharedQuote();
    const sent = stubFetch(() => json({ quote }, 201));
    const key = newIdempotencyKey();
    expect(await createQuote(quoteRequest, key)).toEqual({
      kind: "ok",
      value: quote,
      replayed: false,
    });
    const call = only(sent);
    expect(call.url).toBe(`${apiBase}/v1/public/quotes`);
    expect(call.init.method).toBe("POST");
    expect(call.init.body).toBe(JSON.stringify(quoteRequest));
    expectGuarded(call);
    expect(call.headers.get("content-type")).toBe("application/json");
    expect(call.headers.get("idempotency-key")).toBe(key);
    expect(call.headers.has("authorization")).toBe(false);
  });
});

describe("getQuote", () => {
  it("reads a quote by id with a plain GET", async () => {
    const quote = sharedQuote({ quoteId });
    const sent = stubFetch(() => json({ quote }));
    expect(await getQuote(quoteId)).toEqual({ kind: "ok", value: quote, replayed: false });
    const call = only(sent);
    expect(call.url).toBe(`${apiBase}/v1/public/quotes/${quoteId}`);
    expect(call.init.method).toBe("GET");
    expect(call.init.body).toBeUndefined();
    expectGuarded(call);
    expect(call.headers.has("authorization")).toBe(false);
    expect(call.headers.has("idempotency-key")).toBe(false);
  });

  it("encodes the quote id into one path segment", async () => {
    const sent = stubFetch(() => json({ quote: sharedQuote() }));
    await getQuote("a/b?c");
    expect(only(sent).url).toBe(`${apiBase}/v1/public/quotes/a%2Fb%3Fc`);
  });
});

describe("openCheckout", () => {
  const session = checkout("open", { quoteId });

  it("posts the booker and the secret in the body, under the idempotency key", async () => {
    const sent = stubFetch(() => json({ checkoutSession: session, payment }, 201));
    const key = newIdempotencyKey();
    expect(await openCheckout(checkoutRequest, key)).toEqual({
      kind: "ok",
      value: { session, payment },
      replayed: false,
    });
    const call = only(sent);
    expect(call.url).toBe(`${apiBase}/v1/public/checkout-sessions`);
    expect(call.init.method).toBe("POST");
    expect(call.init.body).toBe(JSON.stringify(checkoutRequest));
    expectGuarded(call);
    expect(call.headers.get("content-type")).toBe("application/json");
    expect(call.headers.get("idempotency-key")).toBe(key);
    expect(call.headers.has("authorization")).toBe(false);
    expect(call.url).not.toContain(secret);
    expect(call.url).not.toContain("ava@example.test");
  });

  it("passes on a checkout that has no payment to make", async () => {
    // One snapshot: a second would read the clock again and could differ by a millisecond.
    const session = checkout("expired", { quoteId });
    stubFetch(() => json({ checkoutSession: session, payment: null }, 201));
    expect(await openCheckout(checkoutRequest, newIdempotencyKey())).toEqual({
      kind: "ok",
      value: { session, payment: null },
      replayed: false,
    });
  });
});

describe("readCheckout", () => {
  it("reads the checkout with the secret as a bearer token, never in the URL", async () => {
    const session = checkout("confirmed", { id: sessionId });
    const sent = stubFetch(() => json({ checkoutSession: session }));
    expect(await readCheckout(sessionId, secret)).toEqual({
      kind: "ok",
      value: session,
      replayed: false,
    });
    const call = only(sent);
    expect(call.url).toBe(`${apiBase}/v1/public/checkout-sessions/${sessionId}`);
    expect(call.init.method).toBe("GET");
    expect(call.init.body).toBeUndefined();
    expectGuarded(call);
    expect(call.headers.get("authorization")).toBe(`Bearer ${secret}`);
    expect(call.headers.has("idempotency-key")).toBe(false);
    expect(call.url).not.toContain(secret);
  });

  it("encodes the checkout id into one path segment", async () => {
    const sent = stubFetch(() => json({ checkoutSession: checkout("open") }));
    await readCheckout("a/b?c", secret);
    expect(only(sent).url).toBe(`${apiBase}/v1/public/checkout-sessions/a%2Fb%3Fc`);
  });
});

describe("cancelCheckout", () => {
  it("posts to cancel with the secret as a bearer token, and no body or key", async () => {
    const session = checkout("canceled", { id: sessionId });
    const sent = stubFetch(() => json({ checkoutSession: session }));
    expect(await cancelCheckout(sessionId, secret)).toEqual({
      kind: "ok",
      value: session,
      replayed: false,
    });
    const call = only(sent);
    expect(call.url).toBe(`${apiBase}/v1/public/checkout-sessions/${sessionId}/cancel`);
    expect(call.init.method).toBe("POST");
    expect(call.init.body).toBeUndefined();
    expectGuarded(call);
    expect(call.headers.get("authorization")).toBe(`Bearer ${secret}`);
    expect(call.headers.has("idempotency-key")).toBe(false);
    expect(call.headers.has("content-type")).toBe(false);
    expect(call.url).not.toContain(secret);
  });

  it("encodes the checkout id into one path segment", async () => {
    const sent = stubFetch(() => json({ checkoutSession: checkout("canceled") }));
    await cancelCheckout("a/b?c", secret);
    expect(only(sent).url).toBe(`${apiBase}/v1/public/checkout-sessions/a%2Fb%3Fc/cancel`);
  });
});

describe("settleTestPayment", () => {
  it.each(["succeed", "fail"] as const)(
    "posts to %s with the payment's client secret as a bearer token",
    async (outcome) => {
      const sent = stubFetch(() => json(settled));
      expect(await settleTestPayment(payment, outcome)).toEqual({
        kind: "ok",
        value: settled,
        replayed: false,
      });
      const call = only(sent);
      expect(call.url).toBe(`${apiBase}/v1/fake-provider/payments/fpay_test_1/${outcome}`);
      expect(call.init.method).toBe("POST");
      expect(call.init.body).toBe("{}");
      expectGuarded(call);
      expect(call.headers.get("content-type")).toBe("application/json");
      expect(call.headers.get("authorization")).toBe(`Bearer ${payment.clientSecret}`);
      expect(call.headers.has("idempotency-key")).toBe(false);
      expect(call.url).not.toContain(payment.clientSecret);
    },
  );

  it("encodes the payment reference into one path segment", async () => {
    const sent = stubFetch(() => json(settled));
    await settleTestPayment({ ...payment, paymentRef: "fpay/1 x" }, "succeed");
    expect(only(sent).url).toBe(`${apiBase}/v1/fake-provider/payments/fpay%2F1%20x/succeed`);
  });
});

describe("what the requests carry", () => {
  it("keeps every secret and personal detail out of every URL", async () => {
    const calls = stubApi();
    const key = newIdempotencyKey();
    await getOffer(tripId);
    await getListing(offer);
    await createQuote(quoteRequest, key);
    await getQuote(quoteId);
    await openCheckout(checkoutRequest, key);
    await readCheckout(sessionId, secret);
    await cancelCheckout(sessionId, secret);
    await settleTestPayment(payment, "succeed");
    await settleTestPayment(payment, "fail");
    expect(calls).toHaveLength(9);
    const hidden = [secret, payment.clientSecret, "Ava", "ava@example.test", "example"];
    for (const call of calls) {
      for (const text of hidden) expect(call.url).not.toContain(text);
    }
  });

  it("sends a secret only where it belongs", async () => {
    const calls = stubApi();
    const key = newIdempotencyKey();
    await getOffer(tripId);
    await getListing(offer);
    await createQuote(quoteRequest, key);
    await getQuote(quoteId);
    await openCheckout(checkoutRequest, key);
    await readCheckout(sessionId, secret);
    await cancelCheckout(sessionId, secret);
    await settleTestPayment(payment, "succeed");
    const authorized = calls.filter((c) => c.headers.has("authorization"));
    expect(authorized.map(routeOf)).toEqual(["readCheckout", "cancel", "succeed"]);
    // The booker's details and the checkout secret travel in the opening POST's body only.
    const inBody = (text: string) =>
      calls.filter((c) => JSON.stringify(c.body ?? "").includes(text)).map(routeOf);
    expect(inBody("ava@example.test")).toEqual(["openCheckout"]);
    expect(inBody(secret)).toEqual(["openCheckout"]);
    expect(inBody(payment.clientSecret)).toEqual([]);
  });

  it("does not use AbortSignal.any or AbortSignal.timeout, which older Safari lacks", async () => {
    const any = vi.spyOn(AbortSignal, "any");
    const timeout = vi.spyOn(AbortSignal, "timeout");
    stubFetch(() => json({ offer }));
    await getOffer(tripId, new AbortController().signal);
    expect(any).not.toHaveBeenCalled();
    expect(timeout).not.toHaveBeenCalled();
  });
});

// Answers ------------------------------------------------------------------------------------------

const requests: Array<[string, () => Promise<Result<unknown>>]> = [
  ["getOffer", () => getOffer(tripId)],
  ["getListing", () => getListing(offer)],
  ["createQuote", () => createQuote(quoteRequest, newIdempotencyKey())],
  ["getQuote", () => getQuote(quoteId)],
  ["openCheckout", () => openCheckout(checkoutRequest, newIdempotencyKey())],
  ["readCheckout", () => readCheckout(sessionId, secret)],
  ["cancelCheckout", () => cancelCheckout(sessionId, secret)],
  ["settleTestPayment", () => settleTestPayment(payment, "succeed")],
];

describe("failures, for every request", () => {
  it.each(requests)("%s turns the API's error body into a refusal", async (_name, send) => {
    stubFetch(() => refusal(409, "trip_not_bookable", "This trip is not on sale now"));
    expect(await send()).toEqual({
      kind: "refused",
      status: 409,
      code: "trip_not_bookable",
      message: "This trip is not on sale now",
    });
  });

  it.each(requests)("%s reads a rejected fetch as no answer", async (_name, send) => {
    stubFetch(() => Promise.reject(new TypeError("Failed to fetch")));
    expect(await send()).toEqual({ kind: "network" });
  });

  it.each(requests)(
    "%s reads a success that breaks the contract as unreadable",
    async (_name, send) => {
      stubFetch(() => json({ unexpected: true }));
      expect(await send()).toEqual({ kind: "unreadable" });
    },
  );
});

describe("error bodies", () => {
  it("keeps the status, the code, and the message", async () => {
    stubFetch(() => refusal(422, "promotion_not_applicable", "No such code"));
    expect(await getOffer(tripId)).toEqual({
      kind: "refused",
      status: 422,
      code: "promotion_not_applicable",
      message: "No such code",
    });
  });

  it.each([
    ["HTML", () => new Response("<h1>Bad gateway</h1>", { status: 502 }), 502],
    ["JSON of another shape", () => json({ message: "oops" }, 500), 500],
    ["JSON with no code", () => json({ error: { message: "x", requestId: "r" } }, 400), 400],
    ["empty", () => new Response(null, { status: 503 }), 503],
  ])("gives the code unknown when the body is %s", async (_name, answer, status) => {
    stubFetch(answer);
    expect(await getOffer(tripId)).toEqual({
      kind: "refused",
      status,
      code: "unknown",
      message: "",
    });
  });
});

describe("a success that breaks the contract", () => {
  it.each([
    ["a field of the wrong type", () => json({ offer: { ...offer, tickets: "none" } })],
    ["the wrong shape", () => json({})],
    ["JSON null", () => json(null)],
    ["a body that is not JSON", () => new Response("<html>ok</html>", { status: 200 })],
    ["no body", () => new Response(null, { status: 204 })],
  ])("is unreadable: %s", async (_name, answer) => {
    stubFetch(answer);
    expect(await getOffer(tripId)).toEqual({ kind: "unreadable" });
  });
});

describe("no answer", () => {
  it("is network when fetch rejects, or throws", async () => {
    stubFetch(() => Promise.reject(new TypeError("Failed to fetch")));
    expect(await getOffer(tripId)).toEqual({ kind: "network" });
    vi.stubGlobal("fetch", () => {
      throw new TypeError("fetch is not available");
    });
    expect(await getOffer(tripId)).toEqual({ kind: "network" });
  });

  it("is network when the signal was already aborted, and no answer is waited for", async () => {
    const sent = stubFetch(() => json({ offer }));
    const controller = new AbortController();
    controller.abort();
    expect(await getOffer(tripId, controller.signal)).toEqual({ kind: "network" });
    expect(only(sent).init.signal?.aborted).toBe(true);
  });

  it.each([
    ["getOffer", (signal: AbortSignal) => getOffer(tripId, signal)],
    ["getListing", (signal: AbortSignal) => getListing(offer, signal)],
    ["getQuote", (signal: AbortSignal) => getQuote(quoteId, signal)],
    ["readCheckout", (signal: AbortSignal) => readCheckout(sessionId, secret, signal)],
  ])("is network when the caller aborts %s while it waits", async (_name, send) => {
    const sent = stubHungFetch();
    const controller = new AbortController();
    const pending = send(controller.signal);
    expect(only(sent).init.signal?.aborted).toBe(false);
    controller.abort();
    expect(await pending).toEqual({ kind: "network" });
    expect(only(sent).init.signal?.aborted).toBe(true);
  });

  it("stops listening to the caller's signal once the call ends", async () => {
    const sent = stubFetch(() => json({ offer }));
    const controller = new AbortController();
    await getOffer(tripId, controller.signal);
    controller.abort();
    expect(only(sent).init.signal?.aborted).toBe(false);
  });
});

describe("timeouts", () => {
  it("gives a command longer than a read", () => {
    expect(readTimeoutMs).toBeGreaterThan(0);
    expect(commandTimeoutMs).toBeGreaterThan(readTimeoutMs);
  });

  it("gives up on a read after its timeout, as no answer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const sent = stubHungFetch();
    const pending = getOffer(tripId);
    await vi.advanceTimersByTimeAsync(readTimeoutMs - 1);
    expect(only(sent).init.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(only(sent).init.signal?.aborted).toBe(true);
    expect(await pending).toEqual({ kind: "network" });
  });

  it.each([
    ["createQuote", () => createQuote(quoteRequest, newIdempotencyKey())],
    ["openCheckout", () => openCheckout(checkoutRequest, newIdempotencyKey())],
    ["cancelCheckout", () => cancelCheckout(sessionId, secret)],
    ["settleTestPayment", () => settleTestPayment(payment, "succeed")],
  ])("gives %s the longer timeout of a command", async (_name, send) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const sent = stubHungFetch();
    const pending = send();
    await vi.advanceTimersByTimeAsync(commandTimeoutMs - 1);
    expect(only(sent).init.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(only(sent).init.signal?.aborted).toBe(true);
    expect(await pending).toEqual({ kind: "network" });
  });

  it("clears its timer when the answer arrives", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    stubFetch(() => json({ offer }));
    await getOffer(tripId);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("the replay header", () => {
  const replay = (header: string | null) => () => {
    const headers = new Headers({ "content-type": "application/json" });
    if (header !== null) headers.set("Idempotent-Replayed", header);
    return new Response(JSON.stringify({ quote: sharedQuote() }), { status: 201, headers });
  };

  it("sets replayed when the API says the answer is a replay", async () => {
    stubFetch(replay("true"));
    const result = await createQuote(quoteRequest, newIdempotencyKey());
    expect(result.kind === "ok" && result.replayed).toBe(true);
  });

  it.each([
    ["is absent", null],
    ["is false", "false"],
    ["is anything else", "1"],
  ])("leaves replayed false when the header %s", async (_name, header) => {
    stubFetch(replay(header));
    const result = await createQuote(quoteRequest, newIdempotencyKey());
    expect(result.kind === "ok" && result.replayed).toBe(false);
  });

  it("reads a replayed checkout, too", async () => {
    const headers = { "content-type": "application/json", "Idempotent-Replayed": "true" };
    const body = { checkoutSession: checkout("open", { quoteId }), payment };
    stubFetch(() => new Response(JSON.stringify(body), { status: 201, headers }));
    const result = await openCheckout(checkoutRequest, newIdempotencyKey());
    expect(result).toMatchObject({ kind: "ok", replayed: true });
  });
});

// Secrets and keys -----------------------------------------------------------------------------------

describe("newCheckoutSecret", () => {
  it("is 43 base64url characters the contract accepts", () => {
    const made = newCheckoutSecret();
    expect(made).toMatch(secretPattern);
    expect(CheckoutSecret.safeParse(made).success).toBe(true);
  });

  it("is different on each call", () => {
    const made = new Set(Array.from({ length: 50 }, newCheckoutSecret));
    expect(made.size).toBe(50);
  });

  it("encodes 32 random bytes as base64url, without padding", () => {
    const sizes = stubRandom((bytes) => bytes.fill(0xff));
    // 32 bytes of 0xff are "/" 42 times and "8" in base64; base64url writes "_".
    expect(newCheckoutSecret()).toBe(`${"_".repeat(42)}8`);
    expect(sizes).toEqual([32]);
    stubRandom(() => {});
    expect(newCheckoutSecret()).toBe("A".repeat(43));
  });

  it("writes + as - and / as _", () => {
    // 0xfb 0xef 0xbe is "++++" in base64, and 0xff 0xff 0xff is "////".
    stubRandom((bytes) => bytes.set([0xfb, 0xef, 0xbe, 0xff, 0xff, 0xff]));
    const made = newCheckoutSecret();
    expect(made).toBe(`----____${"A".repeat(35)}`);
    expect(made).not.toMatch(/[+/=]/);
  });
});

describe("newIdempotencyKey", () => {
  it("is a version 4 UUID the contract's IdempotencyKey accepts", () => {
    const key = newIdempotencyKey();
    expect(key).toMatch(uuidV4);
    expect(IdempotencyKey.safeParse(key).success).toBe(true);
  });

  it("is different on each call", () => {
    const keys = new Set(Array.from({ length: 50 }, newIdempotencyKey));
    expect(keys.size).toBe(50);
  });

  it("sets the version and variant bits whatever the random bytes", () => {
    const sizes = stubRandom((bytes) => bytes.fill(0xff));
    expect(newIdempotencyKey()).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
    expect(sizes).toEqual([16]);
    stubRandom(() => {});
    expect(newIdempotencyKey()).toBe("00000000-0000-4000-8000-000000000000");
  });

  it("needs only getRandomValues, as in a page that is not a secure context", () => {
    stubRandom((bytes) => bytes.fill(0x12));
    expect(newIdempotencyKey()).toMatch(uuidV4);
  });
});

describe("CommandKey", () => {
  it("gives the same key for the same fingerprint until the command is done", () => {
    const command = new CommandKey();
    const first = command.for("adult=2");
    expect(first).toMatch(uuidV4);
    expect(command.for("adult=2")).toBe(first);
    expect(command.for("adult=2")).toBe(first);
  });

  it("gives a new key for another fingerprint", () => {
    const command = new CommandKey();
    const first = command.for("adult=2");
    const second = command.for("adult=3");
    expect(second).not.toBe(first);
    expect(command.for("adult=3")).toBe(second);
  });

  it("gives a new key for a fingerprint that follows another, even one used before", () => {
    const command = new CommandKey();
    const first = command.for("adult=2");
    command.for("adult=3");
    expect(command.for("adult=2")).not.toBe(first);
  });

  it("gives a new key for the same fingerprint after the command is done", () => {
    const command = new CommandKey();
    const first = command.for("adult=2");
    command.done();
    const second = command.for("adult=2");
    expect(second).not.toBe(first);
    expect(second).toMatch(uuidV4);
  });

  it("can be done with nothing pending, and keeps each instance's keys apart", () => {
    const command = new CommandKey();
    expect(() => command.done()).not.toThrow();
    expect(new CommandKey().for("same")).not.toBe(new CommandKey().for("same"));
  });
});

describe("CheckoutAttempt", () => {
  it("has nothing pending before the first request", () => {
    expect(new CheckoutAttempt().pending).toBe(false);
  });

  it("keeps the key and the secret for the same fingerprint, and is pending", () => {
    const attempt = new CheckoutAttempt();
    const first = attempt.for("quote-1");
    expect(first.key).toMatch(uuidV4);
    expect(first.secret).toMatch(secretPattern);
    expect(attempt.pending).toBe(true);
    expect(attempt.for("quote-1")).toEqual(first);
    expect(attempt.pending).toBe(true);
  });

  it("makes a new key and a new secret for another fingerprint", () => {
    const attempt = new CheckoutAttempt();
    const first = attempt.for("quote-1");
    const second = attempt.for("quote-2");
    expect(second.key).not.toBe(first.key);
    expect(second.secret).not.toBe(first.secret);
    expect(attempt.for("quote-2")).toEqual(second);
  });

  it("is no longer pending once done, and starts over for the same fingerprint", () => {
    const attempt = new CheckoutAttempt();
    const first = attempt.for("quote-1");
    attempt.done();
    expect(attempt.pending).toBe(false);
    const second = attempt.for("quote-1");
    expect(second.key).not.toBe(first.key);
    expect(second.secret).not.toBe(first.secret);
    expect(attempt.pending).toBe(true);
  });

  it("makes keys and secrets the contract accepts", () => {
    const { key, secret: made } = new CheckoutAttempt().for("quote-1");
    expect(IdempotencyKey.safeParse(key).success).toBe(true);
    expect(CheckoutSecret.safeParse(made).success).toBe(true);
  });
});

describe("outcomeUnknown", () => {
  const refused = (status: number, code: string): Failure => ({
    kind: "refused",
    status,
    code,
    message: "",
  });

  const cases: Array<[string, Failure, boolean]> = [
    ["no answer", { kind: "network" }, true],
    ["an unreadable answer", { kind: "unreadable" }, true],
    ["a 500", refused(500, "internal_error"), true],
    ["a 502 with no code", refused(502, "unknown"), true],
    ["503 payment_provider_unavailable", refused(503, "payment_provider_unavailable"), true],
    ["503 payments_unavailable", refused(503, "payments_unavailable"), false],
    ["409 payments_unavailable", refused(409, "payments_unavailable"), false],
    ["a 409", refused(409, "quote_expired"), false],
    ["a 422", refused(422, "policy_not_accepted"), false],
    ["a 404", refused(404, "quote_not_found"), false],
    ["a 429", refused(429, "rate_limited"), false],
  ];

  it.each(cases)("%s: outcome unknown is %s", (_name, failure, unknown) => {
    expect(outcomeUnknown(failure)).toBe(unknown);
  });
});
