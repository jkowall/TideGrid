import type { Database } from "@tidegrid/database";
import {
  checkStripeConfig,
  createFakePaymentProvider,
  createStripePaymentProvider,
  FAKE_SECRET_MIN_LENGTH,
  type FakePaymentProvider,
  type PaymentProvider,
} from "@tidegrid/domain-payments";
import type { Context } from "hono";
import type { Kysely } from "kysely";
import type { AppDeps, AppEnv } from "./context.ts";
import { getDb } from "./db.ts";
import type { Bindings } from "./env.ts";

/**
 * Which payment provider this deployment uses (G2.7). The demo runs the fake
 * provider, the owner's decision of 2026-10-05. The fake is refused outright
 * in a production configuration, whatever else is set.
 *
 * The Stripe adapter (standing goal item 3, a coordinator default of
 * 2026-10-28 pending the owner) is built but off: no deployed configuration
 * sets PAYMENT_PROVIDER=stripe. When it is set, both secrets must be present
 * and well formed; a live key is refused everywhere until the Core live gate,
 * and a test key is refused in production, so test cards can never confirm a
 * real booking. The adapter's constructor applies the same refusals again.
 * Staff bookings stay on the shim (D9): their test-payment control is the
 * fake's, so it answers 404 under Stripe.
 */
export type PaymentSettings =
  | { kind: "fake"; secret: string }
  | { kind: "stripe"; secretKey: string; webhookSecret: string }
  | {
      kind: "off";
      reason: "unset" | "secret_missing" | "stripe_key_missing" | "stripe_webhook_secret_missing";
    }
  | {
      kind: "refused";
      reason:
        | "fake_in_production"
        | "unknown_provider"
        | "live_key"
        | "stripe_test_in_production"
        | "key_malformed"
        | "webhook_secret_malformed";
    };

export function paymentSettings(env: Bindings): PaymentSettings {
  const name = env.PAYMENT_PROVIDER;
  if (!name) return { kind: "off", reason: "unset" };
  if (name === "fake") {
    if (env.ENVIRONMENT === "production") return { kind: "refused", reason: "fake_in_production" };
    const secret = env.FAKE_PAYMENT_WEBHOOK_SECRET;
    if (!secret || secret.length < FAKE_SECRET_MIN_LENGTH) {
      return { kind: "off", reason: "secret_missing" };
    }
    return { kind: "fake", secret };
  }
  if (name === "stripe") {
    const secretKey = env.STRIPE_SECRET_KEY;
    const webhookSecret = env.STRIPE_WEBHOOK_SECRET;
    const problem = checkStripeConfig({ secretKey, webhookSecret, environment: env.ENVIRONMENT });
    if (problem) return problem;
    if (!secretKey || !webhookSecret) return { kind: "off", reason: "stripe_key_missing" };
    return { kind: "stripe", secretKey, webhookSecret };
  }
  return { kind: "refused", reason: "unknown_provider" };
}

type DbSource = Kysely<Database> | (() => Kysely<Database>);

/** The configured provider, or null when payments are off. */
export function paymentProvider(env: Bindings, db: DbSource): PaymentProvider | null {
  const settings = paymentSettings(env);
  if (settings.kind === "stripe") {
    // No fetch and no API base are passed: a deployment speaks only to
    // https://api.stripe.com. The constructor refuses production again.
    return createStripePaymentProvider({
      secretKey: settings.secretKey,
      webhookSecret: settings.webhookSecret,
      environment: env.ENVIRONMENT,
    });
  }
  return fakeProvider(env, db);
}

/** The fake provider with its demo controls, or null unless the fake is configured. */
export function fakeProvider(env: Bindings, db: DbSource): FakePaymentProvider | null {
  const settings = paymentSettings(env);
  if (settings.kind !== "fake") return null;
  return createFakePaymentProvider({ db, secret: settings.secret, environment: env.ENVIRONMENT });
}

/**
 * The provider for this request: a test's override, or the configured one.
 * The request's database opens only when the provider first needs it, so a
 * webhook with a bad signature never reaches the database.
 */
export function providerFor(c: Context<AppEnv>, deps: AppDeps): PaymentProvider | null {
  if (deps.paymentProvider) return deps.paymentProvider(getDb(c), c.env);
  return paymentProvider(c.env, () => getDb(c));
}

/** The configured fake provider for its demo controls, or null. */
export function fakeProviderFor(c: Context<AppEnv>): FakePaymentProvider | null {
  return fakeProvider(c.env, () => getDb(c));
}
