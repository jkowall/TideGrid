import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  createDb,
  inTenantTransaction,
  snapshotRead,
  type TenantContext,
  type TenantTransaction,
} from "./index.ts";

type Sql = ReturnType<typeof postgres>;

const env = inject("integrationDb");

/**
 * The snapshot read (G2.12b) that the console's booking views use: every
 * statement sees the moment of the first, and nothing can be written. Runs as
 * the runtime role, so the tenant context and row-level security apply.
 */
describe.skipIf(!env)("snapshot reads", () => {
  let admin: Sql;
  let runtime: ReturnType<typeof createDb>;
  const tenant = { id: randomUUID(), slug: `snap-${randomUUID().slice(0, 8)}` };
  const ctx: TenantContext = { tenantId: tenant.id, actorType: "system", actorId: "snapshot-test" };

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 2, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 2 });
    await admin`insert into public.tenants (id, slug, display_name)
      values (${tenant.id}, ${tenant.slug}, ${`Snapshot ${tenant.slug}`})`;
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end({ timeout: 5 });
  });

  const locations = async (trx: TenantTransaction) =>
    (await trx.selectFrom("locations").select("id").where("tenant_id", "=", tenant.id).execute())
      .length;

  it("keeps every statement on the first statement's moment", async () => {
    const seen = await inTenantTransaction(
      runtime.db,
      ctx,
      async (trx) => {
        const before = await locations(trx);
        // Another connection commits a row in the middle of the read.
        await admin`insert into public.locations (tenant_id, name, time_zone)
          values (${tenant.id}, 'Mid-read dock', 'UTC')`;
        const after = await locations(trx);
        return { before, after };
      },
      snapshotRead,
    );
    expect(seen).toEqual({ before: 0, after: 0 });
    // Outside the snapshot the row is there.
    expect(await inTenantTransaction(runtime.db, ctx, locations)).toBe(1);
  });

  it("refuses to write", async () => {
    const attempt = inTenantTransaction(
      runtime.db,
      ctx,
      (trx) =>
        trx
          .insertInto("locations")
          .values({ tenant_id: tenant.id, name: "Never written", time_zone: "UTC" })
          .execute(),
      snapshotRead,
    );
    // 25006: cannot execute INSERT in a read-only transaction.
    await expect(attempt).rejects.toMatchObject({ code: "25006" });
    expect(await inTenantTransaction(runtime.db, ctx, locations)).toBe(1);
  });

  it("still binds the tenant: another tenant's rows stay invisible", async () => {
    const other: TenantContext = { ...ctx, tenantId: randomUUID() };
    await admin`insert into public.tenants (id, slug, display_name)
      values (${other.tenantId}, ${`snap-${other.tenantId.slice(0, 8)}`}, 'Snapshot other')`;
    const count = await inTenantTransaction(
      runtime.db,
      other,
      async (trx) => (await trx.selectFrom("locations").select("id").execute()).length,
      snapshotRead,
    );
    expect(count).toBe(0);
  });
});
