/**
 * Integration-test harness (Node only). Integration suites run against a
 * throwaway Neon branch: they migrate it, rotate the runtime role's password
 * on that branch, and connect twice, once as the admin role for fixtures and
 * once as tidegrid_app so row-level security is exercised for real.
 */
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
  await migrate(adminUrl);
  const password = newRuntimePassword();
  await setRuntimeRolePassword(adminUrl, password);
  return { adminUrl, runtimeUrl: runtimeUrlFrom(adminUrl, password) };
}
