/**
 * The email provider contract over the fake (G2.16a). The fake files every
 * answer in the database, so its half of the shared suite runs here, against
 * a throwaway PostgreSQL 17, as tidegrid_app.
 */
import { randomUUID } from "node:crypto";
import { createDb } from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import postgres from "postgres";
import { afterAll, beforeAll, describe, inject } from "vitest";
import { FakeEmailProvider } from "./fake.ts";
import { describeEmailProviderContract } from "./provider.contract.ts";

const env = inject("integrationDb");

describe.skipIf(!env)("the fake email provider against a real database", () => {
  let admin: ReturnType<typeof postgres>;
  let runtime: ReturnType<typeof createDb>;
  let fake: FakeEmailProvider;
  const tenantId = randomUUID();

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 1, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 2 });
    fake = new FakeEmailProvider({ db: runtime.db, environment: "local" });
    const slug = `fake-contract-${tenantId.slice(0, 8)}`;
    await admin`insert into public.tenants (id, slug, display_name)
      values (${tenantId}, ${slug}, ${`Contract ${slug}`})`;
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end({ timeout: 5 });
  });

  describeEmailProviderContract("fake", () => ({
    provider: fake,
    tenantId,
    run: randomUUID().slice(0, 8),
  }));
});
