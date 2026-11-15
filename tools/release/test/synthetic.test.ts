import { describe, expect, it } from "vitest";
import {
  optionsFromEnv,
  runSynthetic,
  syntheticBooker,
} from "../src/synthetic.ts";

const now = Date.parse("2026-11-15T12:00:00Z");
const api = "https://api.example.test";
const origin = "https://synthetic.book.example.test";

interface Call {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

type Answer = { status: number; body: unknown };

function fakeApi(overrides: Record<string, Answer> = {}) {
  const calls: Call[] = [];
  const answers: Record<string, Answer> = {
    "GET /v1/health": { status: 200, body: { status: "ok", database: "ok" } },
    "GET /v1/public/trips": {
      status: 200,
      body: {
        trips: [
          // Closes too soon: skipped.
          {
            tripId: "t-soon",
            salesCloseAt: "2026-11-15T12:05:00Z",
            product: { kind: "shared_seat" },
          },
          {
            tripId: "t-charter",
            salesCloseAt: "2026-11-16T12:00:00Z",
            product: { kind: "private_charter" },
          },
          {
            tripId: "t-seat",
            salesCloseAt: "2026-11-17T12:00:00Z",
            product: { kind: "shared_seat" },
          },
        ],
      },
    },
    "GET /v1/public/trips/t-seat/offer": {
      status: 200,
      body: {
        offer: {
          tickets: [{ code: "ADULT" }],
          charter: null,
          product: { minPartySize: 1 },
          policy: { version: 3 },
        },
      },
    },
    "POST /v1/public/quotes": {
      status: 201,
      body: { quote: { quoteId: "q-1" } },
    },
    "POST /v1/public/checkout-sessions": {
      status: 201,
      body: {
        checkoutSession: { id: "c-1", state: "open" },
        payment: { provider: "fake" },
      },
    },
    "POST /v1/public/checkout-sessions/c-1/cancel": {
      status: 200,
      body: { checkoutSession: { id: "c-1", state: "canceled" } },
    },
    ...overrides,
  };
  const fetch = async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const method = init?.method ?? "GET";
    calls.push({
      method,
      path: url.pathname,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    const a = answers[`${method} ${url.pathname}`];
    if (!a) return new Response("", { status: 404 });
    return new Response(JSON.stringify(a.body), { status: a.status });
  };
  return { calls, fetch };
}

const run = (f: ReturnType<typeof fakeApi>) =>
  runSynthetic({ api, origin, days: 30, fetch: f.fetch, now: () => now });

describe("synthetic booking check", () => {
  it("holds seats on a shared trip, then cancels, sending the tenant's Origin", async () => {
    const f = fakeApi();
    const result = await run(f);
    expect(result).toMatchObject({
      outcome: "pass",
      failedStep: null,
      reason: null,
    });
    expect(Object.keys(result.ms)).toEqual([
      "health",
      "trips",
      "offer",
      "quote",
      "checkout",
      "cancel",
    ]);
    expect(f.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /v1/health",
      "GET /v1/public/trips",
      "GET /v1/public/trips/t-seat/offer",
      "POST /v1/public/quotes",
      "POST /v1/public/checkout-sessions",
      "POST /v1/public/checkout-sessions/c-1/cancel",
    ]);
    for (const c of f.calls.slice(1)) expect(c.headers.Origin).toBe(origin);
    expect(f.calls[3]?.body).toEqual({
      tripId: "t-seat",
      party: { kind: "tickets", tickets: [{ code: "ADULT", quantity: 1 }] },
      addOns: [],
    });
    const checkout = f.calls[4]?.body as Record<string, unknown>;
    expect(checkout.booker).toEqual(syntheticBooker);
    expect(checkout.acceptedPolicyVersion).toBe(3);
    const secret = checkout.checkoutSecret as string;
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(f.calls[5]?.headers.Authorization).toBe(`Bearer ${secret}`);
  });

  it("books only at example.test, which never receives mail", () => {
    expect(syntheticBooker.email.endsWith("@example.test")).toBe(true);
  });

  it("fails on a degraded database, naming the step, and opens nothing", async () => {
    const f = fakeApi({
      "GET /v1/health": {
        status: 200,
        body: { status: "degraded", database: "error" },
      },
    });
    const result = await run(f);
    expect(result).toMatchObject({
      outcome: "fail",
      failedStep: "health",
      reason: "database error",
    });
    expect(f.calls).toHaveLength(1);
  });

  it("reports the status and error code, never the message", async () => {
    const f = fakeApi({
      "POST /v1/public/quotes": {
        status: 409,
        body: {
          error: {
            code: "insufficient_capacity",
            message: "guest text could be here",
          },
        },
      },
    });
    const result = await run(f);
    expect(result).toMatchObject({
      failedStep: "quote",
      reason: "HTTP 409 insufficient_capacity",
    });
  });

  it("cancels a checkout it opened even when the check fails after opening", async () => {
    const f = fakeApi({
      "POST /v1/public/checkout-sessions": {
        status: 201,
        body: { checkoutSession: { id: "c-1", state: "open" }, payment: null },
      },
    });
    const result = await run(f);
    expect(result).toMatchObject({
      outcome: "fail",
      failedStep: "checkout",
      reason: "no provider payment",
    });
    expect(f.calls.at(-1)?.path).toBe(
      "/v1/public/checkout-sessions/c-1/cancel",
    );
  });

  it("finds and cancels a checkout kept behind a provider outage, by replaying its key", async () => {
    const f = fakeApi({
      "POST /v1/public/checkout-sessions": {
        status: 503,
        body: { error: { code: "payment_provider_unavailable", message: "x" } },
      },
    });
    let posts = 0;
    const fetch = async (input: string, init?: RequestInit) => {
      if (new URL(input).pathname === "/v1/public/checkout-sessions") {
        posts += 1;
        if (posts === 2) {
          // The replay: the provider answered this time.
          return new Response(
            JSON.stringify({
              checkoutSession: {
                id: "0b7f3a52-9c1e-4d2a-8f6b-1e2d3c4b5a69",
                state: "open",
              },
              payment: {},
            }),
            { status: 201 },
          );
        }
      }
      return f.fetch(input, init);
    };
    const keys: string[] = [];
    const watching = async (input: string, init?: RequestInit) => {
      const h = (init?.headers ?? {}) as Record<string, string>;
      if (new URL(input).pathname === "/v1/public/checkout-sessions")
        keys.push(h["Idempotency-Key"] ?? "");
      return fetch(input, init);
    };
    const result = await runSynthetic({
      api,
      origin,
      days: 30,
      fetch: watching,
      now: () => now,
    });
    expect(result).toMatchObject({ failedStep: "checkout" });
    expect(result.reason).toContain("payment_provider_unavailable");
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(f.calls.at(-1)?.path).toBe(
      "/v1/public/checkout-sessions/0b7f3a52-9c1e-4d2a-8f6b-1e2d3c4b5a69/cancel",
    );
  });

  it("says a checkout may remain when the replay cannot find it either", async () => {
    const f = fakeApi({
      "POST /v1/public/checkout-sessions": {
        status: 503,
        body: { error: { code: "payment_provider_unavailable", message: "x" } },
      },
    });
    const result = await run(f);
    expect(result.reason).toBe(
      "HTTP 503 payment_provider_unavailable; a held checkout may remain until it expires",
    );
  });

  it("never repeats free text from the server", async () => {
    const f = fakeApi({
      "POST /v1/public/checkout-sessions": {
        status: 201,
        body: {
          checkoutSession: { id: "c-1", state: "guest jane@real.example 4111" },
          payment: {},
        },
      },
    });
    const result = await run(f);
    expect(result.reason).toBe("state unexpected");
  });

  it("fails when the cancel does not release the hold", async () => {
    const f = fakeApi({
      "POST /v1/public/checkout-sessions/c-1/cancel": {
        status: 409,
        body: { error: { code: "checkout_not_cancelable", message: "x" } },
      },
    });
    const result = await run(f);
    expect(result).toMatchObject({
      failedStep: "cancel",
      reason: "HTTP 409 checkout_not_cancelable",
    });
  });

  it("fails when no trip is on sale long enough", async () => {
    const f = fakeApi({
      "GET /v1/public/trips": { status: 200, body: { trips: [] } },
    });
    expect(await run(f)).toMatchObject({
      failedStep: "trips",
      reason: "no bookable trip in range",
    });
  });

  it("checks its settings", () => {
    expect(
      optionsFromEnv({ SYNTHETIC_API: api, SYNTHETIC_ORIGIN: `${origin}/` }),
    ).toEqual({
      api,
      origin,
      days: 30,
      party: 1,
    });
    expect(() =>
      optionsFromEnv({
        SYNTHETIC_API: "http://api.example.test",
        SYNTHETIC_ORIGIN: origin,
      }),
    ).toThrow(/https/);
    expect(() =>
      optionsFromEnv({
        SYNTHETIC_API: api,
        SYNTHETIC_ORIGIN: `${origin}/book`,
      }),
    ).toThrow(/origin/);
    expect(() => optionsFromEnv({ SYNTHETIC_API: api })).toThrow(
      /SYNTHETIC_ORIGIN/,
    );
    expect(() =>
      optionsFromEnv({
        SYNTHETIC_API: api,
        SYNTHETIC_ORIGIN: origin,
        SYNTHETIC_DAYS: "100",
      }),
    ).toThrow(/DAYS/);
    expect(() =>
      optionsFromEnv({
        SYNTHETIC_API: api,
        SYNTHETIC_ORIGIN: origin,
        SYNTHETIC_PARTY: "0",
      }),
    ).toThrow(/PARTY/);
    expect(
      optionsFromEnv({
        SYNTHETIC_API: api,
        SYNTHETIC_ORIGIN: origin,
        SYNTHETIC_PARTY: "2",
      }).party,
    ).toBe(2);
    expect(
      optionsFromEnv({
        SYNTHETIC_API: "http://localhost:8961",
        SYNTHETIC_ORIGIN: "http://demo-harbor.book.localhost:8961",
      }).api,
    ).toBe("http://localhost:8961");
  });
});
