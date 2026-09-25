import type { TestProject } from "vitest/node";
import {
  type IntegrationDatabase,
  integrationAdminUrl,
  prepareIntegrationDatabase,
} from "./testing.ts";

declare module "vitest" {
  export interface ProvidedContext {
    integrationDb: IntegrationDatabase | null;
  }
}

/** Vitest global setup shared by every package's integration suite. */
export default async function setup(project: TestProject): Promise<void> {
  const adminUrl = integrationAdminUrl();
  project.provide("integrationDb", adminUrl ? await prepareIntegrationDatabase(adminUrl) : null);
}
