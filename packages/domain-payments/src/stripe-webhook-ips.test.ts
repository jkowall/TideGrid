import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  compareStripeWebhookIps,
  isStripeWebhookIp,
  STRIPE_WEBHOOK_IPS,
  STRIPE_WEBHOOK_IPS_SOURCE,
  STRIPE_WEBHOOK_IPS_VERSION,
} from "./stripe-webhook-ips.ts";

const ipv4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

describe("Stripe's webhook address list", () => {
  it("is a frozen, versioned list of distinct canonical IPv4 addresses", () => {
    expect(Object.isFrozen(STRIPE_WEBHOOK_IPS)).toBe(true);
    expect(STRIPE_WEBHOOK_IPS.length).toBeGreaterThan(0);
    expect(new Set(STRIPE_WEBHOOK_IPS).size).toBe(STRIPE_WEBHOOK_IPS.length);
    for (const ip of STRIPE_WEBHOOK_IPS) expect(ip).toMatch(ipv4);
    expect(STRIPE_WEBHOOK_IPS_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(STRIPE_WEBHOOK_IPS_SOURCE).toMatch(/^https:\/\/stripe\.com\//);
  });

  it("matches a listed address exactly, and nothing else", () => {
    const [first] = STRIPE_WEBHOOK_IPS;
    if (!first) throw new Error("empty list");
    expect(isStripeWebhookIp(first)).toBe(true);
    for (const near of [
      null,
      undefined,
      "",
      ` ${first}`,
      `${first} `,
      `${first},${first}`,
      `${first}, 203.0.113.9`,
      `::ffff:${first}`,
      `${first}/32`,
      first.replace(/^(\d+)/, "0$1"),
      "203.0.113.9",
      "127.0.0.1",
      "::1",
    ]) {
      expect(isStripeWebhookIp(near), String(near)).toBe(false);
    }
  });

  it("compares a published copy with the committed list", () => {
    expect(compareStripeWebhookIps({ WEBHOOKS: [...STRIPE_WEBHOOK_IPS].reverse() })).toEqual({
      kind: "same",
      count: STRIPE_WEBHOOK_IPS.length,
    });
    const [dropped, ...kept] = STRIPE_WEBHOOK_IPS;
    expect(compareStripeWebhookIps({ WEBHOOKS: [...kept, "198.51.100.7"] })).toEqual({
      kind: "different",
      missing: ["198.51.100.7"],
      extra: [dropped],
    });
    for (const bad of [null, {}, { WEBHOOKS: [] }, { WEBHOOKS: "3.18.12.63" }, { WEBHOOKS: [1] }]) {
      expect(compareStripeWebhookIps(bad).kind).toBe("unreadable");
    }
  });

  // The refresh check step (README, "Refreshing the list"). Skipped unless a
  // person points it at a copy of Stripe's file, saved outside the repository.
  const published = process.env.STRIPE_WEBHOOK_IPS_FILE;
  it.skipIf(!published)("equals the copy of Stripe's file in STRIPE_WEBHOOK_IPS_FILE", () => {
    const parsed: unknown = JSON.parse(readFileSync(published ?? "", "utf8"));
    expect(compareStripeWebhookIps(parsed)).toEqual({
      kind: "same",
      count: STRIPE_WEBHOOK_IPS.length,
    });
  });
});
