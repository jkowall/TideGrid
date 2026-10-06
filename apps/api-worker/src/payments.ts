import type { Database } from "@tidegrid/database";
import {
  createFakePaymentProvider,
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
 * provider, the owner's decision of 2026-10-05; a Stripe adapter replaces it
 * behind the same interface before any live booking. The fake is refused
 * outright in a production configuration, whatever else is set.
 */
export type PaymentSettings =
  | { kind: "fake"; secret: string }
  | { kind: "off"; reason: "unset" | "secret_missing" | "not_built" }
  | { kind: "refused"; reason: "fake_in_production" | "unknown_provider" };

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
  if (name === "stripe") return { kind: "off", reason: "not_built" };
  return { kind: "refused", reason: "unknown_provider" };
}

type DbSource = Kysely<Database> | (() => Kysely<Database>);

/** The configured provider, or null when payments are off. */
export function paymentProvider(env: Bindings, db: DbSource): PaymentProvider | null {
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
