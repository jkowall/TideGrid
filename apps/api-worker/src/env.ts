export interface Bindings {
  ENVIRONMENT: "local" | "preview" | "staging" | "production";
  BUILD_ID: string;
  /** Secret. Direct connection string for the runtime role. */
  DATABASE_URL?: string;
  /** Optional Hyperdrive binding; preferred when present. */
  HYPERDRIVE?: { connectionString: string };
}

export function databaseUrl(env: Bindings): string | undefined {
  return env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL;
}
