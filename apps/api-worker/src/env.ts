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
