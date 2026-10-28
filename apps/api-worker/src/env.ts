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
   */
  PAYMENT_PROVIDER?: string;
  /** Secret. Signs and verifies the fake provider's webhooks; at least 32 characters. */
  FAKE_PAYMENT_WEBHOOK_SECRET?: string;
  /**
   * The email provider transactional email uses (lane 1, the G2.16 shim).
   * "fake" is the demo shim, refused in a production configuration; unset
   * means email stays queued and nothing is sent.
   */
  EMAIL_PROVIDER?: string;
  /** The sender address; the display name is the operator's brand. */
  EMAIL_FROM_ADDRESS?: string;
  /**
   * The guest site's origin for links in email, with {slug} for the tenant's
   * slug; default https://{slug}.book.tidegrid.us. Its hostname must be an
   * active, verified hostname of the tenant.
   */
  GUEST_LINK_ORIGIN?: string;
  /**
   * How public routes answer CORS (G2.14b). "static" keeps only
   * ALLOWED_ORIGINS, the rollback; anything else, unset included, also echoes
   * a verified tenant origin and lets any strictly parsed origin read the
   * bootstrap. The deployed configuration says "static" until the live step.
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
