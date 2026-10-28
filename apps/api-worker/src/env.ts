export interface Bindings {
  ENVIRONMENT: "local" | "preview" | "staging" | "production";
  BUILD_ID: string;
  /** Comma-separated browser origins allowed to call the API (CORS). */
  ALLOWED_ORIGINS?: string;
  /** Comma-separated console origins allowed to send state-changing staff requests. */
  STAFF_ORIGINS?: string;
  /** Cloudflare Access team domain and application audience for the console. */
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
  /** Secret. Direct connection string for the runtime role. */
  DATABASE_URL?: string;
  /** Optional Hyperdrive binding; preferred when present. */
  HYPERDRIVE?: { connectionString: string };
  /** Optional per-IP limiter for the sign-in endpoints. */
  AUTH_RATE_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> };
  /** Optional limiter for public commands, per client address and tenant. */
  PUBLIC_RATE_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> };
  /**
   * The payment provider checkout uses (G2.7). "fake" is the demo shim and is
   * refused in a production configuration; unset means payments are off.
   * "stripe" selects the Stripe adapter, which no deployed configuration sets
   * yet (standing goal item 3, off until the owner approves the live step).
   */
  PAYMENT_PROVIDER?: string;
  /** Secret. Signs and verifies the fake provider's webhooks; at least 32 characters. */
  FAKE_PAYMENT_WEBHOOK_SECRET?: string;
  /**
   * Secret, never a var. A Stripe test key, sk_test_ or rk_test_; live keys are
   * refused everywhere, and test keys in production.
   */
  STRIPE_SECRET_KEY?: string;
  /** Secret, never a var. The Stripe webhook endpoint's signing secret, whsec_. */
  STRIPE_WEBHOOK_SECRET?: string;
  /**
   * The email provider transactional email uses (src/email.ts). Unset means
   * email stays queued and nothing is sent. "fake" is the demo shim, accepted
   * only when ENVIRONMENT is "local" and no EMAIL binding is set.
   * "cloudflare" (G2.16a) needs the EMAIL binding and, outside production, a
   * non-empty EMAIL_ALLOWED_RECIPIENTS.
   */
  EMAIL_PROVIDER?: string;
  /**
   * The Cloudflare Email Service `send_email` binding (G2.16a). No
   * configuration in the repository declares it; the live step adds it with
   * `allowed_sender_addresses` only.
   */
  EMAIL?: SendEmail;
  /**
   * Secret. Comma-separated exact addresses Cloudflare email may go to
   * outside production; never in the repository. Unset or empty keeps
   * Cloudflare email off there.
   */
  EMAIL_ALLOWED_RECIPIENTS?: string;
  /**
   * The sender address; the display name is the operator's brand. A value
   * that is not one address refuses email (from_address_invalid).
   */
  EMAIL_FROM_ADDRESS?: string;
  /**
   * The guest site's origin for links in email, with {slug} for the tenant's
   * slug; default https://{slug}.book.tidegrid.us. Its hostname must be an
   * active, verified hostname of the tenant.
   */
  GUEST_LINK_ORIGIN?: string;
  /**
   * How public routes answer CORS (G2.14b). "dynamic" also echoes a verified
   * tenant origin and lets any strictly parsed origin read the bootstrap; it
   * is set in env.dev and env.test. Unset or anything else keeps only
   * ALLOWED_ORIGINS: the deployed default until the live step, and the
   * rollback.
   */
  PUBLIC_CORS?: string;
  /**
   * The custom-hostname provider the cron's sweep reads (G2.14b). Unset means
   * custom hostnames are off. "fake" is accepted only when ENVIRONMENT is
   * "local" and no CF_SAAS_ZONE_ID is set; "cloudflare_saas" needs the zone
   * and the token.
   */
  HOSTNAME_PROVIDER?: string;
  /** The Cloudflare for SaaS zone id (a var, not a secret). */
  CF_SAAS_ZONE_ID?: string;
  /** Secret. A zone-scoped token for custom hostnames; never in the repository. */
  CF_SAAS_API_TOKEN?: string;
  /** The CNAME target operators point at; default customers.tidegrid.us. */
  CF_SAAS_ROUTING_TARGET?: string;
}

export function databaseUrl(env: Bindings): string | undefined {
  return env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL;
}

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
}

export function allowedOrigins(env: Bindings): string[] {
  return list(env.ALLOWED_ORIGINS);
}

export function staffOrigins(env: Bindings): string[] {
  return list(env.STAFF_ORIGINS);
}
