import { randomBytes } from "node:crypto";
import { ManagedBookingResponse } from "@tidegrid/contracts";
import { createStripeFixture } from "@tidegrid/domain-payments/testing";
import { describe, expect, it } from "vitest";
import { runStripeSmoke, stripeVersion } from "../src/commands/stripe-smoke.ts";
import { parseHosts, profileFor } from "../src/http.ts";
import {
  cancelBookingResponse,
  cancellationTermsResponse,
  checkoutCreateResponse,
  checkoutSessionResponse,
  ids,
  managedBookingResponse,
  manageSessionResponse,
  offerResponse,
  quoteResponse,
  syntheticSessionToken,
  tripsResponse,
} from "./contract-fixtures.ts";
import { type FetchCall, fakeDeps, json } from "./helpers.ts";

/**
 * stripe-smoke over an injected fetch: Stripe calls go to the PR #31 recorded
 * fixture, extended here (tests only) with GET /v1/account, a confirm route,
 * and an events listing; TideGrid's public API is a stand-in whose checkout
 * creates the PaymentIntent on the fixture, as the adapter does.
 *
 * Every public API body comes from contract-fixtures.ts, which parses it with
 * its @tidegrid/contracts schema. A hand-written mock once put the refund at
 * the top level instead of under booking and hid a real bug (PR #64); a body
 * that drifts from the contract now throws before the smoke reads it.
 */
type RefundOutcome = "succeeded" | "failed";

function harness(outcome: RefundOutcome) {
  const stripe = createStripeFixture();
  const harbor = stripe.syntheticAccounts.harbor;
  let pi = "";
  let canceled = false;
  let bookingReads = 0;
  const sessionSecret: Record<string, string> = {};

  const stripeCall = async (c: FetchCall): Promise<Response> => {
    const url = new URL(c.url);
    if (url.pathname === "/v1/account") return json(200, { id: "acct_1PlatformFixture" });
    if (url.pathname === "/v1/events") return json(200, { data: [{ id: "evt_1Fixture" }] });
    const m = /^\/v1\/payment_intents\/([^/]+)\/confirm$/.exec(url.pathname);
    if (m) {
      expect(c.headers["stripe-account"]).toBe(harbor);
      expect(c.headers["stripe-version"]).toBe(stripeVersion);
      const pm = new URLSearchParams(c.body ?? "").get("payment_method");
      if (pm === "pm_card_chargeDeclined") {
        stripe.decline(m[1] as string);
        return json(402, { error: { type: "card_error", code: "card_declined" } });
      }
      const intent = stripe.succeed(m[1] as string);
      return json(200, intent);
    }
    return stripe.fetch(c.url, {
      method: c.method,
      headers: c.headers,
      ...(c.body ? { body: c.body } : {}),
    });
  };

  const refund = (state: "requested" | RefundOutcome) => ({
    state,
    amount: 6500,
    failureCode: state === "failed" ? "charge_disputed" : null,
    requestedAt: "2026-11-04T16:00:00.000Z",
    settledAt: state === "requested" ? null : "2026-11-04T16:00:05.000Z",
  });

  const api = async (c: FetchCall): Promise<Response> => {
    const path = new URL(c.url).pathname;
    if (path === "/v1/public/trips")
      return json(200, tripsResponse({ localDate: "2026-11-06", capacity: 20 }));
    if (path === `/v1/public/trips/${ids.trip}/offer`) return json(200, offerResponse());
    if (path === "/v1/public/quotes") return json(201, quoteResponse());
    if (path === "/v1/public/checkout-sessions") {
      const body = JSON.parse(c.body ?? "{}") as {
        checkoutSecret: string;
        booker: { email: string };
      };
      expect(body.booker.email).toMatch(/\.test$/);
      const created = await stripe.fetch("https://api.stripe.com/v1/payment_intents", {
        method: "POST",
        headers: {
          authorization: `Bearer ${stripe.secretKey}`,
          "stripe-version": stripeVersion,
          "stripe-account": harbor,
          "content-type": "application/x-www-form-urlencoded",
          "idempotency-key": randomBytes(8).toString("hex"),
        },
        body: new URLSearchParams([
          ["amount", "6500"],
          ["currency", "usd"],
          ["allowed_payment_method_types[]", "card"],
        ]).toString(),
      });
      const intent = (await created.json()) as { id: string; client_secret: string };
      pi = intent.id;
      sessionSecret.s = body.checkoutSecret;
      return json(
        201,
        checkoutCreateResponse({
          payment: {
            provider: "stripe",
            paymentRef: intent.id,
            clientSecret: intent.client_secret,
          },
        }),
      );
    }
    if (path === `/v1/public/checkout-sessions/${ids.checkout}`) {
      const status = (stripe.intent(pi) as { status: string }).status;
      return json(
        200,
        checkoutSessionResponse({ state: status === "succeeded" ? "confirmed" : "open" }),
      );
    }
    if (path === `/v1/public/checkout-sessions/${ids.checkout}/manage-session`) {
      expect(c.headers.authorization).toBe(`Bearer ${sessionSecret.s}`);
      return json(201, manageSessionResponse());
    }
    if (path === "/v1/public/manage/cancellation" && c.method === "GET") {
      expect(c.headers.authorization).toBe(`Bearer ${syntheticSessionToken}`);
      return json(200, cancellationTermsResponse({ refundAmount: 6500 }));
    }
    if (path === "/v1/public/manage/cancellation" && c.method === "POST") {
      expect(JSON.parse(c.body ?? "{}")).toEqual({ expectedRefundAmount: 6500 });
      canceled = true;
      return json(200, cancelBookingResponse({ refundAmount: 6500 }));
    }
    if (path === "/v1/public/manage/booking") {
      bookingReads++;
      if (!canceled) return json(200, managedBookingResponse());
      // The refund is requested on the first read after the cancel, then settles.
      const settled = bookingReads > 1;
      return json(
        200,
        managedBookingResponse({
          state: "canceled",
          refundAmount: 6500,
          refund: refund(settled ? outcome : "requested"),
        }),
      );
    }
    return json(404, { error: { code: "not_found" } });
  };

  const { deps, fetches, execs } = fakeDeps({
    env: { STRIPE_SECRET_KEY: stripe.secretKey, STRIPE_ACCT_DEMO_HARBOR: harbor },
  });
  // The handlers are async, so route around the helper's synchronous fetch.
  deps.fetch = async (input, init = {}) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const call = {
      url: input,
      method: init.method ?? "GET",
      headers,
      body: init.body ? String(init.body) : null,
    };
    fetches.push(call);
    return input.startsWith("https://api.stripe.com") ? stripeCall(call) : api(call);
  };

  const profile = profileFor(
    "preview",
    "https://api.tidegrid.us",
    parseHosts("demo-harbor.book.tidegrid.us"),
  );
  return { stripe, deps, fetches, execs, profile, reads: () => bookingReads };
}

describe("stripe-smoke against the Stripe fixture", () => {
  it("declines, pays, confirms by webhook, cancels, and refunds, with no CLI and no live key", async () => {
    const { stripe, deps, fetches, execs, profile } = harness("succeeded");
    const result = await runStripeSmoke(deps, profile, "demo-harbor");
    expect(result.steps.map((s) => s.step)).toEqual([
      "account",
      "quote",
      "checkout",
      "decline",
      "pay",
      "webhook confirmed the booking",
      "manage session",
      "cancel",
      "refund",
    ]);
    expect(result.eventHint).toBe("evt_1Fixture");
    expect(execs).toEqual([]);
    const stripeCalls = fetches.filter((f) => f.url.startsWith("https://api.stripe.com"));
    expect(stripeCalls.every((f) => f.headers.authorization === `Bearer ${stripe.secretKey}`)).toBe(
      true,
    );
    expect(stripeCalls.some((f) => f.url.includes("live"))).toBe(false);
  });

  it("fails fast when the refund settles as failed, instead of waiting out the 90 s poll", async () => {
    const { deps, profile, reads } = harness("failed");
    const started = deps.now().getTime();
    await expect(runStripeSmoke(deps, profile, "demo-harbor")).rejects.toThrow(
      /stripe-smoke refund: failed \(charge_disputed\)/,
    );
    // One read sees "requested", the next sees "failed": one 3 s poll interval, not 90 s.
    expect(reads()).toBe(2);
    expect(deps.now().getTime() - started).toBeLessThan(10_000);
  });
});

describe("the public API mocks are bound to the contract", () => {
  it("refuses the hand-written shape that hid the PR #64 bug: refund at the top level", () => {
    const { booking, session } = managedBookingResponse();
    const drifted = {
      booking: { ...booking, refund: undefined },
      session,
      refund: { state: "succeeded", amount: 6500 },
    };
    expect(ManagedBookingResponse.safeParse(drifted).success).toBe(false);
  });

  it("refuses an incomplete booking object", () => {
    expect(
      ManagedBookingResponse.safeParse({
        booking: { refund: { state: "succeeded", amount: 6500 } },
      }).success,
    ).toBe(false);
  });
});
