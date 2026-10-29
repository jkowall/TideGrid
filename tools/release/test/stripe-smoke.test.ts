import { randomBytes } from "node:crypto";
import { createStripeFixture } from "@tidegrid/domain-payments/testing";
import { describe, expect, it } from "vitest";
import { runStripeSmoke, stripeVersion } from "../src/commands/stripe-smoke.ts";
import { parseHosts, profileFor } from "../src/http.ts";
import { type FetchCall, fakeDeps, json } from "./helpers.ts";

/**
 * stripe-smoke over an injected fetch: Stripe calls go to the PR #31 recorded
 * fixture, extended here (tests only) with GET /v1/account, a confirm route,
 * and an events listing; TideGrid's public API is a stand-in whose checkout
 * creates the PaymentIntent on the fixture, as the adapter does.
 */
describe("stripe-smoke against the Stripe fixture", () => {
  it("declines, pays, confirms by webhook, cancels, and refunds, with no CLI and no live key", async () => {
    const stripe = createStripeFixture();
    const harbor = stripe.syntheticAccounts.harbor;
    let pi = "";
    let refunded = false;
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

    const api = async (c: FetchCall): Promise<Response> => {
      const path = new URL(c.url).pathname;
      if (path === "/v1/public/trips") {
        return json(200, {
          trips: [
            {
              tripId: "11111111-1111-4111-8111-111111111111",
              localDate: "2026-11-06",
              product: { name: "Sunset Harbor Cruise", kind: "shared_seat" },
              capacity: { total: 20, remaining: 20 },
            },
          ],
        });
      }
      if (path.endsWith("/offer")) return json(200, { offer: { tickets: [{ code: "adult" }] } });
      if (path === "/v1/public/quotes")
        return json(201, {
          quote: { quoteId: "22222222-2222-4222-8222-222222222222", policy: { version: 1 } },
        });
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
            ["payment_method_types[]", "card"],
          ]).toString(),
        });
        const intent = (await created.json()) as { id: string; client_secret: string };
        pi = intent.id;
        sessionSecret.s = body.checkoutSecret;
        return json(201, {
          checkoutSession: { id: "33333333-3333-4333-8333-333333333333" },
          payment: {
            provider: "stripe",
            paymentRef: intent.id,
            clientSecret: intent.client_secret,
          },
        });
      }
      if (path === "/v1/public/checkout-sessions/33333333-3333-4333-8333-333333333333") {
        const status = (stripe.intent(pi) as { status: string }).status;
        return json(200, {
          checkoutSession: { state: status === "succeeded" ? "confirmed" : "open" },
        });
      }
      if (path.endsWith("/manage-session")) {
        expect(c.headers.authorization).toBe(`Bearer ${sessionSecret.s}`);
        return json(201, {
          session: { token: "m".repeat(43) },
          booking: { reference: "ABCD2345" },
        });
      }
      if (path === "/v1/public/manage/cancellation" && c.method === "GET")
        return json(200, { terms: { refundAmount: 6500 } });
      if (path === "/v1/public/manage/cancellation") {
        refunded = true;
        return json(200, { booking: { state: "canceled" } });
      }
      if (path === "/v1/public/manage/booking")
        return json(200, { refund: refunded ? { state: "succeeded" } : null });
      return json(404, {});
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
});
