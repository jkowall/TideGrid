/**
 * Sweep fairness for the hold sweep (pre-pilot hardening, item 5, Part A).
 * The shared test database holds other suites' tenants with due holds, so
 * these tests assert relative facts among their own tenants only: the order
 * their turns start and the order their expiries were written. Each test
 * builds fresh tenants, because stamps outlive a test.
 */
import { randomUUID } from "node:crypto";
import { createDb, inTenantTransaction } from "@tidegrid/database";
import type {} from "@tidegrid/database/global-setup";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { acquireHold, sweepExpiredHolds } from "./index.ts";
import {
  backdateHold,
  createTenantFixture,
  systemContext,
  type TenantFixture,
} from "./test-fixtures.ts";

type Sql = ReturnType<typeof postgres>;

const env = inject("integrationDb");

describe.skipIf(!env)("the hold sweep takes fair turns across tenants", () => {
  let admin: Sql;
  let rt: Sql;
  let runtime: ReturnType<typeof createDb>;

  /** Two fresh tenants, the lower id first: the order before 0013 served it first. */
  async function pair(label: string): Promise<[TenantFixture, TenantFixture]> {
    const one = await createTenantFixture(admin, runtime.db, `${label}-1`, { days: 4 });
    const two = await createTenantFixture(admin, runtime.db, `${label}-2`, { days: 4 });
    return one.id < two.id ? [one, two] : [two, one];
  }

  /** `n` due holds on the tenant's first shared trip. */
  async function dueHolds(tenant: TenantFixture, n: number): Promise<string[]> {
    const ids: string[] = [];
    const tripId = tenant.trips.shared[0] ?? "";
    for (let i = 0; i < n; i++) {
      const ctx = systemContext(tenant.id);
      const result = await inTenantTransaction(runtime.db, ctx, (trx) =>
        acquireHold(trx, ctx, {
          ownerRef: `checkout_session:${randomUUID()}`,
          tripId,
          partySize: 1,
          ttlSeconds: 600,
        }),
      );
      if (result.kind !== "acquired") throw new Error(`expected acquired, got ${result.kind}`);
      await backdateHold(admin, result.hold.id);
      ids.push(result.hold.id);
    }
    return ids;
  }

  /** The run's hold.expired audit rows for these holds, in the order they were written. */
  const expiryOrder = async (runId: string, holdIds: readonly string[]) =>
    (
      await admin<{ subject_id: string }[]>`
        select subject_id from public.audit_events
         where action = 'hold.expired' and request_id = ${runId}
           and subject_id in ${admin(holdIds)}
         order by id`
    ).map((r) => r.subject_id);

  /** A sweep over every due tenant in the database, with each turn's start recorded. */
  async function sweep(ours: readonly string[], options: { batchSize?: number } = {}) {
    const runId = `fair-${randomUUID()}`;
    const turns: string[] = [];
    const report = await sweepExpiredHolds(runtime.db, {
      runId,
      tenantLimit: 1000,
      budgetMs: 60_000,
      ...options,
      onTurnStart: (tenantId, pass) => {
        if (ours.includes(tenantId)) turns.push(`${tenantId}@${pass}`);
      },
    });
    return { runId, turns, report };
  }

  const listed = async (ours: readonly string[]) =>
    (await rt<{ tenant_id: string }[]>`select tenant_id from app.capacity_hold_sweep_tenants(1000)`)
      .map((r) => r.tenant_id)
      .filter((id) => ours.includes(id));

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 2, onnotice: () => {} });
    rt = postgres(env.runtimeUrl, { max: 2, onnotice: () => {} });
    runtime = createDb(env.runtimeUrl, { max: 4 });
  });

  afterAll(async () => {
    await runtime?.end();
    await rt?.end({ timeout: 5 });
    await admin?.end({ timeout: 5 });
  });

  it("expires the high-id tenant's hold before the low-id tenant's second batch", async () => {
    const [hog, victim] = await pair("fair-hold");
    const hogHolds = await dueHolds(hog, 3);
    const [victimHold] = await dueHolds(victim, 1);
    const ours = [hog.id, victim.id];
    const { runId, turns, report } = await sweep(ours, { batchSize: 1 });
    expect(report.failedTenants).toBe(0);
    // The writes, whatever ran them: before 0013 the hog's three holds were
    // all expired first.
    expect(await expiryOrder(runId, [...hogHolds, victimHold ?? ""])).toEqual([
      hogHolds[0],
      victimHold,
      hogHolds[1],
      hogHolds[2],
    ]);
    // Pass 1 gives each one batch; pass 2 goes back to the hog.
    expect(turns.slice(0, 3)).toEqual([`${hog.id}@1`, `${victim.id}@1`, `${hog.id}@2`]);
    expect(turns.filter((t) => t.startsWith(hog.id))).toHaveLength(4);
    expect(await listed(ours)).toEqual([]);
  });

  it("lists a tenant it has never served first, and a tenant after its turn behind the others", async () => {
    const [low, high] = await pair("fair-hold-order");
    await dueHolds(low, 1);
    expect(await listed([low.id, high.id])).toEqual([low.id]);
    await sweep([low.id, high.id]);
    // The low id has had its turn; the high id never has, so it now goes first.
    await dueHolds(low, 1);
    await dueHolds(high, 1);
    expect(await listed([low.id, high.id])).toEqual([high.id, low.id]);
    // Tenants never served tie, and fall back to id order, as before 0013.
    const fresh = await createTenantFixture(admin, runtime.db, "fair-hold-fresh", { days: 4 });
    await dueHolds(fresh, 1);
    const ours = [low.id, high.id, fresh.id];
    const order = [...[high.id, fresh.id].sort(), low.id];
    expect(await listed(ours)).toEqual(order);
    const { turns } = await sweep(ours);
    expect(turns).toEqual(order.map((id) => `${id}@1`));
    // Each was served once, in that order, so that is the order they wait in.
    for (const t of [low, high, fresh]) await dueHolds(t, 1);
    expect(await listed(ours)).toEqual(order);
  });

  it("starts no batch and writes no stamp with a zero budget", async () => {
    const [low, high] = await pair("fair-hold-zero");
    await dueHolds(low, 1);
    await dueHolds(high, 1);
    const spent = await sweepExpiredHolds(runtime.db, {
      runId: `fair-${randomUUID()}`,
      budgetMs: 0,
    });
    expect(spent).toMatchObject({ tenants: 0, turns: 0, expired: 0, complete: false });
    const [stamps] = await admin<{ n: number }[]>`
      select count(*)::int as n from public.sweep_turns where tenant_id in (${low.id}, ${high.id})`;
    expect(stamps?.n).toBe(0);
  });
});
