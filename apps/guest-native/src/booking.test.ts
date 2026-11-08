import { webcrypto } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CheckoutSessionCreateRequest, QuoteCreateRequest, TripOffer } from "@tidegrid/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import {
  cancelCheckout,
  createQuote,
  openCheckout,
  openFromCheckout,
  openWithLink,
  readBooking,
  readCheckout,
  readPartyWaivers,
  settleTestPayment,
} from "./booking-api.ts";
import {
  bookerProblems,
  checkoutTrouble,
  initialSelection,
  linkTokenFrom,
  partyLimits,
  partyProblem,
  quoteBody,
  quoteTrouble,
} from "./booking-model.ts";
import { call, outcomeUnknown } from "./http.ts";
import {
  base64Url,
  CheckoutAttempt,
  CommandKey,
  newCheckoutSecret,
  newIdempotencyKey,
  setRandomSource,
} from "./random.ts";
import { type KeyValueStore, maxSessions, SessionStore, storageKey } from "./sessions.ts";
import type { Endpoint } from "./variant.ts";

const endpoint: Endpoint = {
  apiBase: "https://api.example.test",
  origin: "https://demo-harbor.book.tidegrid.us",
};

beforeAll(() => {
  setRandomSource((bytes) => {
    webcrypto.getRandomValues(bytes);
  });
});

const tripId = "11111111-1111-4111-8111-111111111111";

function offer(kind: "shared_seat" | "private_charter" = "shared_seat"): TripOffer {
  const charter = kind === "private_charter";
  return TripOffer.parse({
    tripId,
    product: {
      id: "22222222-2222-4222-8222-222222222222",
      name: "Sunset cruise",
      kind,
      minPartySize: 1,
      maxPartySize: 12,
    },
    trip: {
      timeZone: "America/New_York",
      localDate: "2026-12-01",
      localStartTime: "17:00",
      startsAt: "2026-12-01T22:00:00Z",
      startsAtLocal: "2026-12-01T17:00:00-05:00",
    },
    currency: "USD",
    priceListVersion: 1,
    tickets: charter
      ? []
      : [
          { code: "adult", name: "Adult", unitAmount: 4500, taxable: true },
          { code: "child", name: "Child", unitAmount: 2500, taxable: true },
        ],
    charter: charter ? { name: "Whole boat", amount: 90000, taxable: true } : null,
    addOns: [
      {
        code: "drinks",
        name: "Drink voucher",
        unitAmount: 800,
        quantityRule: "per_participant",
        maxQuantity: 2,
        taxable: true,
      },
    ],
    fees: [],
    taxes: [],
    policy: {
      version: 3,
      changeCutoffMinutes: 1440,
      changeCutoffAt: "2026-11-30T22:00:00Z",
      beforeCutoff: { remedy: "full_refund", refundBp: null },
      afterCutoff: { remedy: "none", refundBp: null },
      noShow: { remedy: "none", refundBp: null },
      text: {
        cancellation: "c",
        reschedule: "r",
        noShow: "n",
        operatorCancellation: "o",
        weather: "w",
      },
    },
  });
}

/** A fetch that records each request and answers with one JSON body. */
function recorder(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const headersOf = (init: RequestInit) => init.headers as Record<string, string>;

describe("calls", () => {
  it("send the variant's origin, no credentials, and no cache", async () => {
    const { calls, fetchImpl } = recorder(200, { ok: true });
    await call(endpoint, "/v1/x", { schema: QuoteCreateRequest.partial(), fetchImpl });
    const init = calls[0]?.init as RequestInit;
    expect(headersOf(init).origin).toBe(endpoint.origin);
    expect(init.credentials).toBe("omit");
    expect(init.cache).toBe("no-store");
  });

  it("read a refusal's code and problems, and a network failure", async () => {
    const refused = recorder(409, {
      error: { code: "insufficient_capacity", message: "Only 2 seats left", requestId: "r" },
      type: "about:blank",
      title: "Conflict",
      status: 409,
      detail: "Only 2 seats left",
      code: "insufficient_capacity",
      problems: [{ code: "insufficient_capacity", subject: null }],
      remaining: 2,
    });
    const r = await createQuote(
      endpoint,
      { tripId, party: { kind: "charter", guests: 1 } },
      "k",
      refused.fetchImpl,
    );
    expect(r).toMatchObject({
      kind: "refused",
      status: 409,
      code: "insufficient_capacity",
      remaining: 2,
    });
    const down = (async () => {
      throw new TypeError("offline");
    }) as unknown as typeof fetch;
    expect(await readCheckout(endpoint, tripId, "s", down)).toEqual({ kind: "network" });
  });

  it("call an answer that breaks the contract unreadable", async () => {
    const { fetchImpl } = recorder(200, { quote: { nope: true } });
    const r = await createQuote(
      endpoint,
      { tripId, party: { kind: "charter", guests: 1 } },
      "k",
      fetchImpl,
    );
    expect(r).toEqual({ kind: "unreadable" });
    expect(outcomeUnknown({ kind: "unreadable" })).toBe(true);
    expect(
      outcomeUnknown({ kind: "refused", status: 503, code: "payments_unavailable", message: "" }),
    ).toBe(false);
  });

  it("never put a secret, token, name, or email in a path or query", async () => {
    const secret = newCheckoutSecret();
    const token = newCheckoutSecret();
    const { calls, fetchImpl } = recorder(500, {});
    const booker = { name: "Pat Example", email: "pat@example.com" };
    await openCheckout(
      endpoint,
      { quoteId: tripId, acceptedPolicyVersion: 1, booker, checkoutSecret: secret },
      "key",
      fetchImpl,
    );
    await readCheckout(endpoint, tripId, secret, fetchImpl);
    await cancelCheckout(endpoint, tripId, secret, fetchImpl);
    await settleTestPayment(
      endpoint,
      { paymentRef: "pay_1", clientSecret: secret },
      "succeed",
      fetchImpl,
    );
    await openFromCheckout(endpoint, tripId, secret, fetchImpl);
    await openWithLink(endpoint, token, fetchImpl);
    await readBooking(endpoint, token, fetchImpl);
    await readPartyWaivers(endpoint, token, fetchImpl);
    expect(calls).toHaveLength(8);
    for (const { url } of calls) {
      for (const s of [
        secret,
        token,
        booker.name,
        booker.email,
        encodeURIComponent(booker.email),
      ]) {
        expect(url).not.toContain(s);
      }
    }
    // The secrets went where the API reads them: a bearer header or the body.
    expect(headersOf(calls[1]?.init as RequestInit).authorization).toBe(`Bearer ${secret}`);
    expect(String(calls[5]?.init.body)).toContain(token);
    expect(headersOf(calls[0]?.init as RequestInit)["idempotency-key"]).toBe("key");
  });

  it("use the same paths as the guest web app", async () => {
    const { calls, fetchImpl } = recorder(500, {});
    await createQuote(endpoint, { tripId, party: { kind: "charter", guests: 1 } }, "k", fetchImpl);
    await settleTestPayment(
      endpoint,
      { paymentRef: "pay_1", clientSecret: "c" },
      "fail",
      fetchImpl,
    );
    await openFromCheckout(endpoint, tripId, "s", fetchImpl);
    await readPartyWaivers(endpoint, "t", fetchImpl);
    expect(
      calls.map((c) => `${c.init.method ?? "GET"} ${c.url.replace(endpoint.apiBase, "")}`),
    ).toEqual([
      "POST /v1/public/quotes",
      "POST /v1/fake-provider/payments/pay_1/fail",
      `POST /v1/public/checkout-sessions/${tripId}/manage-session`,
      "GET /v1/public/manage/waivers",
    ]);
  });
});

describe("parity with the contracts", () => {
  it("builds quote requests the API's schema accepts, without zero counts", () => {
    const o = offer();
    const limits = partyLimits(o, null);
    const sel = initialSelection(o, limits);
    expect(sel.tickets).toEqual({ adult: 1, child: 0 });
    const body = quoteBody(o, { ...sel, tickets: { adult: 2, child: 1 }, addOns: { drinks: 3 } });
    expect(QuoteCreateRequest.parse(body)).toMatchObject({
      party: {
        kind: "tickets",
        tickets: [
          { code: "adult", quantity: 2 },
          { code: "child", quantity: 1 },
        ],
      },
      addOns: [{ code: "drinks", quantity: 3 }],
    });
    const charter = offer("private_charter");
    const cBody = quoteBody(charter, {
      ...initialSelection(charter, partyLimits(charter, null)),
      guests: 6,
    });
    expect(QuoteCreateRequest.parse(cBody).party).toEqual({ kind: "charter", guests: 6 });
  });

  it("builds checkout requests the API's schema accepts", () => {
    const req = {
      quoteId: tripId,
      acceptedPolicyVersion: 3,
      booker: { name: "Pat Example", email: "pat@example.com" },
      checkoutSecret: newCheckoutSecret(),
    };
    expect(CheckoutSessionCreateRequest.safeParse(req).success).toBe(true);
  });

  it("checks the booker as the contract does", () => {
    expect(bookerProblems("Pat", "pat@example.com")).toEqual({});
    expect(bookerProblems(" ", "pat@example.com").name).toBeDefined();
    expect(bookerProblems("Pat\u0007", "pat@example.com").name).toBeDefined();
    expect(bookerProblems("Pat", "not an email").email).toBeDefined();
    expect(bookerProblems("Pat", "pat@@example.com").email).toBeDefined();
    expect(bookerProblems("Pat", "pät@example.com").email).toBeDefined();
  });
});

describe("the journey's states", () => {
  it("says when a party is too big for the seats left", () => {
    const o = offer();
    const listing = {
      capacity: { kind: "seats", total: 12, remaining: 2 },
    } as Parameters<typeof partyLimits>[1];
    const limits = partyLimits(o, listing);
    const sel = { tickets: { adult: 3, child: 0 }, guests: 1, addOns: {} };
    expect(partyProblem(o, sel, limits)).toBe(
      "Only 2 seats are left, and your party is 3. Choose fewer guests.",
    );
  });

  it("calls a trip with no seats, or a taken charter, sold out", () => {
    const refused = (remaining: number) => ({
      kind: "refused" as const,
      status: 409,
      code: "insufficient_capacity",
      message: "",
      remaining,
    });
    const o = offer();
    expect(quoteTrouble(refused(0), o, partyLimits(o, null))).toEqual({
      kind: "stop",
      stop: "sold_out",
    });
    expect(quoteTrouble(refused(2), o, partyLimits(o, null))).toMatchObject({ kind: "party" });
    expect(checkoutTrouble(refused(3), "Harbor", true)).toEqual({ kind: "stop", stop: "sold_out" });
  });

  it("asks for a new price when the quote expired", () => {
    const r = { kind: "refused" as const, status: 409, code: "quote_expired", message: "" };
    expect(checkoutTrouble(r, "Harbor", false)).toEqual({ kind: "requote" });
  });

  it("reads a link's token from the pasted link or the token alone", () => {
    const token = newCheckoutSecret();
    expect(linkTokenFrom(`https://demo-harbor.book.tidegrid.us/manage#t=${token}`)).toBe(token);
    expect(linkTokenFrom(`  ${token} `)).toBe(token);
    expect(linkTokenFrom("https://demo-harbor.book.tidegrid.us/manage")).toBeNull();
    expect(linkTokenFrom(`${token}x`)).toBeNull();
  });
});

describe("secrets and keys", () => {
  it("makes 43-character checkout secrets and version 4 UUIDs", () => {
    expect(newCheckoutSecret()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newIdempotencyKey()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("encodes base64url as Node does", () => {
    for (let n = 0; n < 40; n++) {
      const bytes = new Uint8Array(n);
      webcrypto.getRandomValues(bytes);
      expect(base64Url(bytes)).toBe(Buffer.from(bytes).toString("base64url"));
    }
  });

  it("reuses a key only for the same request until it took effect", () => {
    const keys = new CommandKey();
    const a = keys.for("a");
    expect(keys.for("a")).toBe(a);
    expect(keys.for("b")).not.toBe(a);
    keys.done();
    const attempt = new CheckoutAttempt();
    const first = attempt.for("x");
    expect(attempt.for("x")).toEqual(first);
    attempt.done();
    expect(attempt.for("x").secret).not.toBe(first.secret);
  });
});

describe("stored booking sessions", () => {
  function memory(): KeyValueStore & { data: Map<string, string> } {
    const data = new Map<string, string>();
    return {
      data,
      get: async (k) => data.get(k) ?? null,
      set: async (k, v) => {
        data.set(k, v);
      },
      remove: async (k) => {
        data.delete(k);
      },
    };
  }
  const now = Date.parse("2026-11-08T12:00:00Z");
  const session = (reference: string, minutes = 60) => ({
    token: newCheckoutSecret(),
    expiresAt: new Date(now + minutes * 60_000).toISOString(),
    reference,
  });

  it("keeps only the token, expiry, and reference, per operator", async () => {
    const kv = memory();
    const store = new SessionStore(kv, "demo-harbor");
    await store.add({ ...session("ABCDEFGH"), name: "Pat", email: "p@example.com" } as never, now);
    const raw = kv.data.get(storageKey("demo-harbor")) ?? "";
    expect(Object.keys(JSON.parse(raw)[0]).sort()).toEqual(["expiresAt", "reference", "token"]);
    expect(raw).not.toContain("Pat");
    expect(await new SessionStore(kv, "demo-reef").list(now)).toEqual([]);
  });

  it("runs a removal and an addition in order, so neither is lost", async () => {
    const kv = memory();
    const store = new SessionStore(kv, "demo-harbor");
    await store.add(session("ABCDEFGH"), now);
    await Promise.all([store.remove("ABCDEFGH", now), store.add(session("ABCDEFGJ"), now)]);
    expect((await store.list(now)).map((s) => s.reference)).toEqual(["ABCDEFGJ"]);
  });

  it("drops expired and malformed records, and keeps the newest few", async () => {
    const kv = memory();
    const store = new SessionStore(kv, "demo-harbor");
    await store.add(session("ABCDEFGH", 5), now);
    await store.add(session("ABCDEFGJ"), now);
    expect((await store.list(now + 10 * 60_000)).map((s) => s.reference)).toEqual(["ABCDEFGJ"]);
    kv.data.set(storageKey("demo-harbor"), "not json");
    expect(await store.list(now)).toEqual([]);
    for (let i = 0; i < maxSessions + 3; i++) {
      await store.add(session(`ABCDEF${"0123456789ABCDEFG"[i]}0`), now);
    }
    expect(await store.list(now)).toHaveLength(maxSessions);
    await store.remove("ABCDEFG0", now);
    expect((await store.list(now)).some((s) => s.reference === "ABCDEFG0")).toBe(false);
  });

  it("never throws when secure storage fails", async () => {
    const broken: KeyValueStore = {
      get: async () => {
        throw new Error("locked");
      },
      set: async () => {
        throw new Error("locked");
      },
      remove: async () => {
        throw new Error("locked");
      },
    };
    const store = new SessionStore(broken, "demo-harbor");
    const opened = session("ABCDEFGH");
    await expect(store.add(opened, now)).resolves.toBeUndefined();
    // Kept in memory while the app runs, so a booking whose link was used still shows.
    await expect(store.list(now)).resolves.toEqual([opened]);
    await expect(store.remove("ABCDEFGH", now)).resolves.toBeUndefined();
    await expect(store.list(now)).resolves.toEqual([]);
  });
});

describe("the app's source", () => {
  it("never logs", () => {
    const dirs = [join(import.meta.dirname), join(import.meta.dirname, "..")];
    const files = dirs.flatMap((d) =>
      readdirSync(d)
        .filter((f) => /\.tsx?$/.test(f) && !f.endsWith(".test.ts"))
        .map((f) => join(d, f)),
    );
    expect(files.length).toBeGreaterThan(8);
    for (const file of files) expect(readFileSync(file, "utf8")).not.toMatch(/console\.|debugger/);
  });
});
