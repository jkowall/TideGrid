/**
 * Integration-test harness (Node only). Integration suites run against a
 * throwaway Neon branch: they migrate it, rotate the runtime role's password
 * on that branch, and connect twice, once as the admin role for fixtures and
 * once as tidegrid_app so row-level security is exercised for real.
 */
import postgres from "postgres";
import { migrate } from "./migrate.ts";
import { newRuntimePassword, runtimeUrlFrom, setRuntimeRolePassword } from "./role.ts";

export interface IntegrationDatabase {
  /** Owner connection: bypasses row-level security. Fixtures only. */
  adminUrl: string;
  /** tidegrid_app connection: the role every Worker request uses. */
  runtimeUrl: string;
}

/**
 * The admin URL for integration tests, or null to skip locally. In CI a missing
 * URL is an error so the suite can never pass by not running.
 */
export function integrationAdminUrl(): string | null {
  const url = process.env.DATABASE_URL;
  if (!url) {
    if (process.env.CI) {
      throw new Error("DATABASE_URL is required in CI; integration suites must not skip silently.");
    }
    return null;
  }
  if (process.env.TIDEGRID_EPHEMERAL_DB !== "1") {
    throw new Error(
      "Integration suites rotate the runtime role password. Point DATABASE_URL at a throwaway Neon branch and set TIDEGRID_EPHEMERAL_DB=1.",
    );
  }
  return url;
}

export async function prepareIntegrationDatabase(adminUrl: string): Promise<IntegrationDatabase> {
  await step("migrate the branch", 120_000, () => migrate(adminUrl));
  const password = newRuntimePassword();
  await step("rotate the runtime password", 60_000, () =>
    setRuntimeRolePassword(adminUrl, password),
  );
  const runtimeUrl = runtimeUrlFrom(adminUrl, password);
  // Neon applies a role change through its control plane; give it a moment.
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  await waitUntilReachable([adminUrl, runtimeUrl]);
  return { adminUrl, runtimeUrl };
}

/**
 * Vitest gives global setup no timeout, so a stalled await would hang the run
 * with no output. Every setup step fails with its name instead.
 */
async function step<T>(name: string, ms: number, run: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Integration setup could not ${name} within ${ms} ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Integration runs on Neon have occasionally stalled on connect, or failed
 * their first queries, just after this setup rotated the runtime password.
 * Wait until both roles answer. Each attempt has a hard limit and its client is
 * torn down when it expires, so a stalled login cannot hang the run.
 */
async function waitUntilReachable(urls: readonly string[], deadlineMs = 120_000): Promise<void> {
  const started = Date.now();
  for (const url of urls) {
    for (let attempt = 1; ; attempt++) {
      const sql = postgres(url, { max: 1, connect_timeout: 10, onnotice: () => {} });
      try {
        await step("reach the database", 15_000, () => sql`select 1`);
        break;
      } catch (err) {
        if (Date.now() - started > deadlineMs) throw err;
        await new Promise((resolve) => setTimeout(resolve, Math.min(1_000 * attempt, 5_000)));
      } finally {
        await sql.end({ timeout: 0 });
      }
    }
  }
}
