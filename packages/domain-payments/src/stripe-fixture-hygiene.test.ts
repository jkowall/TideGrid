/**
 * The capture scrub guard. Every Stripe fixture file and every body the
 * fixture serves or signs must be synthetic: no real account, key, client
 * secret, email, card detail, or receipt. When doc-modeled bodies are later
 * replaced with sandbox captures, this test is what stops an unscrubbed one.
 */
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createStripePaymentProvider,
  stripeSecretKeyPattern,
  stripeWebhookSecretPattern,
} from "./stripe.ts";
import {
  createStripeFixture,
  STRIPE_FIXTURE_ACCOUNTS,
  STRIPE_FIXTURE_CLIENT_SECRET_INFIX,
  STRIPE_FIXTURE_ID_MARKER,
  STRIPE_FIXTURE_RECEIPT_URL,
  STRIPE_FIXTURE_SECRET_KEY,
  STRIPE_FIXTURE_WEBHOOK_SECRET,
} from "./stripe-fixture.ts";

const here = dirname(fileURLToPath(import.meta.url));
/** Every Stripe fixture file. A new one must be added here. */
const fixtureFiles = ["stripe-fixture.ts", "testing.ts"];

/** Every test source that could hold a Stripe credential: this package's and the API's. */
function testSources(): string[] {
  const own = readdirSync(here)
    .filter((f) => /\.(?:test|contract)\.ts$/.test(f))
    .map((f) => join(here, f));
  const api = [
    "../../../apps/api-worker/test",
    "../../../apps/api-worker/test-integration",
  ].flatMap((dir) =>
    readdirSync(resolve(here, dir))
      .filter((f) => f.endsWith(".ts"))
      .map((f) => resolve(here, dir, f)),
  );
  return [...own, ...api];
}

/**
 * Every value a deployment would accept as a Stripe key or webhook secret
 * that a text spells out, alone or as adjacent string literals joined with
 * "_" or with nothing, the way a test splits one to dodge a scanner.
 */
function deployableCredentials(text: string): string[] {
  const out: string[] = [];
  const literal = /"((?:[^"\\\n]|\\.)*)"/g;
  const run = /"(?:[^"\\\n]|\\.)*"(?:\s*,\s*"(?:[^"\\\n]|\\.)*")*/g;
  for (const [sequence] of text.matchAll(run)) {
    const parts = [...sequence.matchAll(literal)].map((m) => m[1] ?? "");
    for (let i = 0; i < parts.length; i++) {
      for (let j = i + 1; j <= parts.length; j++) {
        for (const separator of ["_", ""]) {
          const value = parts.slice(i, j).join(separator);
          if (stripeSecretKeyPattern.test(value) || stripeWebhookSecretPattern.test(value)) {
            out.push(value);
          }
        }
      }
    }
  }
  return out;
}

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

const syntheticAccounts = new Set<string>(Object.values(STRIPE_FIXTURE_ACCOUNTS));
const syntheticKeys = new Set([STRIPE_FIXTURE_SECRET_KEY, STRIPE_FIXTURE_WEBHOOK_SECRET]);
const scrubbedCard = ["fingerprint", "last4", "exp_month", "exp_year", "network_transaction_id"];
/** Fields that name or describe a guest, wherever they appear: always null in a fixture. */
const guestFields = ["name", "phone", "customer", "description", "receipt_email", "outcome"];
/** Objects that hold a guest's details, wherever they appear: every leaf null. */
const guestObjects = ["billing_details", "shipping", "address"];

/** What is wrong with one text, as a fixture file or a body. */
function textFindings(text: string): string[] {
  const problems: string[] = [];
  for (const [id] of text.matchAll(/acct_[A-Za-z0-9_-]+/g)) {
    if (!syntheticAccounts.has(id)) problems.push(`a non-synthetic account ${id}`);
  }
  const infix = STRIPE_FIXTURE_CLIENT_SECRET_INFIX.slice("_secret_".length);
  for (const match of text.matchAll(/_secret_/g)) {
    if (!text.startsWith(infix, match.index + "_secret_".length)) {
      problems.push("a client secret that is not synthetic");
    }
  }
  for (const [key] of text.matchAll(/\b(?:(?:sk|rk|pk)_(?:test|live)|whsec)_[A-Za-z0-9_]*/g)) {
    if (!syntheticKeys.has(key)) problems.push(`a key that is not a synthetic constant`);
  }
  if (/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(text))
    problems.push("an email address");
  for (const [id, prefix] of text.matchAll(/\b(ch|pi|re|evt|txn|pm|req|cus)_[A-Za-z0-9]+/g)) {
    if (!id.startsWith(`${prefix}_${STRIPE_FIXTURE_ID_MARKER}`)) {
      problems.push(`a non-synthetic id ${id}`);
    }
  }
  return problems;
}

function allNull(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value === "object") return Object.values(value as object).every(allNull);
  return false;
}

/** What is wrong with one parsed body. */
function jsonFindings(value: unknown, path = "$"): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => jsonFindings(v, `${path}[${i}]`));
  if (typeof value !== "object" || value === null) return [];
  const problems: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    const at = `${path}.${key}`;
    if (guestObjects.includes(key) && !allNull(child)) problems.push(`${at} is not empty`);
    if (key === "receipt_url" && child !== null && child !== STRIPE_FIXTURE_RECEIPT_URL) {
      problems.push(`${at} is not the placeholder`);
    }
    if (guestFields.includes(key) && child !== null && child !== undefined) {
      problems.push(`${at} is set`);
    }
    if (key === "card" && typeof child === "object" && child !== null) {
      for (const field of scrubbedCard) {
        const v = (child as Record<string, unknown>)[field];
        if (v !== undefined && v !== null) problems.push(`${at}.${field} is set`);
      }
    }
    if (key === "request" && typeof child === "object" && child !== null) {
      const r = child as Record<string, unknown>;
      if ((r.id ?? null) !== null || (r.idempotency_key ?? null) !== null) {
        problems.push(`${at} names a request`);
      }
    }
    problems.push(...jsonFindings(child, at));
  }
  return problems;
}

function bodyFindings(body: string): string[] {
  const problems = textFindings(body);
  try {
    problems.push(...jsonFindings(JSON.parse(body)));
  } catch {
    // Not every answer is JSON; the text checks still apply.
  }
  return problems;
}

/** Drive the fixture through every endpoint and event type, keeping every body. */
async function servedBodies(): Promise<string[]> {
  const fixture = createStripeFixture();
  const bodies: string[] = [];
  const provider = createStripePaymentProvider({
    secretKey: fixture.secretKey,
    webhookSecret: fixture.webhookSecret,
    environment: "local",
    fetch: async (input, init) => {
      const response = await fixture.fetch(input, init);
      bodies.push(await response.clone().text());
      return response;
    },
  });
  const keep = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch {
      // Error answers are bodies too.
    }
  };
  const create = (account: string, amount = 5000) =>
    provider.createPayment({
      accountRef: account,
      amount,
      currency: "USD",
      idempotencyKey: `checkout_payment:${randomUUID()}`,
      clientReference: randomUUID(),
    });
  const refund = (paymentRef: string, amount: number) =>
    provider.refundPayment({
      accountRef: STRIPE_FIXTURE_ACCOUNTS.harbor,
      paymentRef,
      amount,
      currency: "USD",
      idempotencyKey: `checkout_refund:${randomUUID()}`,
    });
  const paid = await create(STRIPE_FIXTURE_ACCOUNTS.harbor);
  const declined = await create(STRIPE_FIXTURE_ACCOUNTS.harbor);
  const canceled = await create(STRIPE_FIXTURE_ACCOUNTS.reef);
  const read = (ref: string, account: string = STRIPE_FIXTURE_ACCOUNTS.harbor) =>
    keep(provider.retrievePayment({ accountRef: account, paymentRef: ref }));
  await read(paid.paymentRef);
  const events: [string, Record<string, unknown>][] = [];
  events.push(["payment_intent.payment_failed", fixture.decline(declined.paymentRef)]);
  events.push(["payment_intent.succeeded", fixture.succeed(paid.paymentRef)]);
  events.push(["payment_intent.canceled", fixture.cancel(canceled.paymentRef)]);
  await read(paid.paymentRef);
  await read(paid.paymentRef, STRIPE_FIXTURE_ACCOUNTS.reef);
  await keep(refund(paid.paymentRef, 1000));
  fixture.refundPending();
  await keep(refund(paid.paymentRef, 1000));
  fixture.refundNext("failed", "expired_or_canceled_card");
  await keep(refund(paid.paymentRef, 500));
  await keep(refund(paid.paymentRef, 9000));
  await keep(refund(declined.paymentRef, 100));
  fixture.addForeignRefunds(paid.paymentRef, 120);
  await keep(refund(paid.paymentRef, 1));
  const [first] = fixture.refundIds(paid.paymentRef);
  if (!first) throw new Error("no refund");
  events.push(["charge.refunded", fixture.charge(paid.paymentRef)]);
  events.push(["refund.created", fixture.refund(first)]);
  events.push([
    "payment_intent.succeeded",
    fixture.addForeignIntent(STRIPE_FIXTURE_ACCOUNTS.reef, 900),
  ]);
  for (const [type, object] of events) {
    const delivery = await fixture.event(type, object);
    bodies.push(delivery.body, (await fixture.redeliver(delivery)).body);
  }
  // A refused key and an unknown route.
  const wrong = await fixture.fetch("https://api.stripe.com/v1/payment_intents", {
    method: "GET",
  });
  bodies.push(await wrong.text());
  expect(bodies.length).toBeGreaterThan(20);
  return bodies;
}

describe("Stripe credentials in test sources", () => {
  it("spells out no key or webhook secret a deployment would accept", () => {
    const sources = testSources();
    expect(sources.length).toBeGreaterThan(10);
    expect(sources.some((s) => s.endsWith("stripe-settings.test.ts"))).toBe(true);
    for (const source of sources) {
      expect(deployableCredentials(readFileSync(source, "utf8")), source).toEqual([]);
    }
  });

  it("catches one split into literals", () => {
    const tail = "A".repeat(28);
    const quoted = (...parts: string[]) => parts.map((p) => `"${p}"`).join(", ");
    for (const text of [
      `const k = keyOf(${quoted("sk", "test", tail)});`,
      `const s = [${quoted("whsec", tail)}].join("_");`,
      `const k = ${quoted(["rk", "test", tail].join("_"))};`,
      `const k = [${quoted("rk_test", "_", tail)}].join("");`,
    ]) {
      expect(deployableCredentials(text), text).not.toEqual([]);
    }
    for (const text of [
      `keyOf(${quoted("sk", "test", "short")})`,
      `keyOf(${quoted("sk", "live", tail)})`,
      `[${quoted("rk", "test", "fixture", tail)}].join("_")`,
    ]) {
      expect(deployableCredentials(text), text).toEqual([]);
    }
  });
});

describe("Stripe fixture hygiene", () => {
  it("keeps every fixture file synthetic", () => {
    for (const file of fixtureFiles) {
      const text = readFileSync(join(here, file), "utf8");
      expect(textFindings(text), file).toEqual([]);
    }
  });

  it("serves and signs only synthetic, scrubbed bodies", async () => {
    const bodies = await servedBodies();
    const problems = bodies.flatMap(bodyFindings);
    expect(problems).toEqual([]);
    // The checks saw what they guard.
    const all = bodies.join("\n");
    expect(all).toContain("billing_details");
    expect(all).toContain("receipt_url");
    expect(all).toContain(STRIPE_FIXTURE_CLIENT_SECRET_INFIX);
    expect(all).toContain(STRIPE_FIXTURE_ACCOUNTS.reef);
  });

  it("catches an unscrubbed capture", () => {
    const capture = {
      id: "ch_3QxLiveLooking0000000000",
      object: "charge",
      account: "acct_1RealLooking00000",
      billing_details: { email: null, name: "A Guest", address: { city: null } },
      receipt_email: "guest@example.com",
      receipt_url: "https://pay.stripe.com/receipts/payment/CAcaFwoVYWNjdF8x",
      outcome: { network_status: "approved_by_network" },
      payment_method_details: { card: { last4: "4242", exp_month: 12 } },
      payment_intent: "pi_3QxLiveLooking0000000000",
      client_secret: "pi_3QxLiveLooking0000000000_secret_RealLookingSecret",
      request: { id: "req_RealLooking", idempotency_key: "key" },
      key: ["sk", "live", "RealLookingRealLooking0000"].join("_"),
      shipping: {
        name: "A Guest",
        phone: "+1 555 0100",
        address: { line1: "1 Harbor Way", city: null },
      },
      customer: "cus_RealLooking000000",
      description: "Charter for A Guest",
      latest_charge: {
        payment_method_details: { card: { network_transaction_id: "123456789012345" } },
      },
      account_holder: { name: "A Guest", phone: null, address: { postal_code: "33062" } },
    };
    const problems = bodyFindings(JSON.stringify(capture));
    for (const expected of [
      "a non-synthetic account",
      "a client secret that is not synthetic",
      "a key that is not a synthetic constant",
      "an email address",
      "a non-synthetic id ch_",
      "a non-synthetic id pi_",
      "$.billing_details is not empty",
      "$.receipt_url is not the placeholder",
      "$.receipt_email is set",
      "$.outcome is set",
      "$.payment_method_details.card.last4 is set",
      "$.payment_method_details.card.exp_month is set",
      "$.request names a request",
      "$.shipping is not empty",
      "$.customer is set",
      "$.description is set",
      "$.latest_charge.payment_method_details.card.network_transaction_id is set",
      "$.account_holder.name is set",
      "$.account_holder.address is not empty",
    ]) {
      expect(
        problems.some((p) => p.startsWith(expected)),
        expected,
      ).toBe(true);
    }
  });
});
