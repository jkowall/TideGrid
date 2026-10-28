/**
 * Sweep fairness (0013): the stamp table under row-level security, and the
 * order the four list functions return. Two tenants throughout; stamps are
 * never deleted, so every test uses tenants of its own.
 */
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDb, recordSweepTurn, type TenantContext } from "./index.ts";

type Sql = ReturnType<typeof postgres>;

const env = inject("integrationDb");

async function pgError(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    return (err as { code?: string }).code ?? "no-code";
  }
  return "no-error";
}

const ctxOf = (tenantId: string, requestId = `run-${randomUUID()}`): TenantContext => ({
  tenantId,
  actorType: "system",
  actorId: "sweep-test",
  requestId,
});

describe.skipIf(!env)("sweep turns (0013)", () => {
  let admin: Sql;
  let runtime: Sql;
  let handle: ReturnType<typeof createDb>;

  function asTenant<T>(tenantId: string | null, fn: (tx: Sql) => Promise<T>): Promise<T> {
    return runtime.begin(async (tx) => {
      if (tenantId) await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
      return fn(tx as unknown as Sql);
    }) as Promise<T>;
  }

  /** Fresh tenants, sorted by id so tests can name the lower one. */
  async function tenants(n: number): Promise<string[]> {
    const ids = Array.from({ length: n }, () => randomUUID()).sort();
    for (const id of ids) {
      await admin`insert into public.tenants (id, slug, display_name)
        values (${id}, ${`turns-${id.slice(0, 8)}`}, 'Sweep turns')`;
    }
    return ids;
  }

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 2, onnotice: () => {} });
    runtime = postgres(env.runtimeUrl, { max: 2, onnotice: () => {} });
    handle = createDb(env.runtimeUrl, { max: 2 });
  });

  afterAll(async () => {
    await handle?.end();
    await runtime?.end();
    await admin?.end();
  });

  describe("the stamp table as the runtime", () => {
    it("lets a tenant write and read only its own stamps", async () => {
      const [A, B] = (await tenants(2)) as [string, string];
      await recordSweepTurn(handle.db, ctxOf(A), "hold");
      await recordSweepTurn(handle.db, ctxOf(B), "hold");
      const seenByA = await asTenant(
        A,
        (tx) => tx`select tenant_id, sweep from public.sweep_turns`,
      );
      expect(seenByA.map((r) => ({ ...r }))).toEqual([{ tenant_id: A, sweep: "hold" }]);
      // A filter naming the other tenant finds nothing.
      const named = await asTenant(
        A,
        (tx) => tx`select 1 from public.sweep_turns where tenant_id = ${B}`,
      );
      expect(named).toHaveLength(0);
      // No context, no rows.
      expect(await asTenant(null, (tx) => tx`select 1 from public.sweep_turns`)).toHaveLength(0);
    });

    it("refuses another tenant's stamp, and any stamp without context", async () => {
      const [A, B] = (await tenants(2)) as [string, string];
      expect(
        await pgError(
          asTenant(
            A,
            (tx) => tx`insert into public.sweep_turns (tenant_id, sweep) values (${B}, 'hold')`,
          ),
        ),
      ).toBe("42501");
      expect(
        await pgError(
          asTenant(
            null,
            (tx) => tx`insert into public.sweep_turns (tenant_id, sweep) values (${A}, 'hold')`,
          ),
        ),
      ).toBe("42501");
      // An upsert from A that names B is refused too.
      expect(
        await pgError(
          asTenant(
            A,
            (tx) => tx`insert into public.sweep_turns (tenant_id, sweep) values (${B}, 'checkout')
              on conflict (tenant_id, sweep) do update set last_turn_at = now()`,
          ),
        ),
      ).toBe("42501");
      const [stored] = await admin<{ n: number }[]>`
        select count(*)::int as n from public.sweep_turns where tenant_id = ${B}`;
      expect(stored?.n).toBe(0);
    });

    it("moves only the time and the run id, and never deletes or truncates", async () => {
      const [A] = (await tenants(1)) as [string];
      await recordSweepTurn(handle.db, ctxOf(A), "checkout");
      expect(
        await pgError(
          asTenant(
            A,
            (tx) => tx`update public.sweep_turns set sweep = 'hold' where tenant_id = ${A}`,
          ),
        ),
      ).toBe("42501");
      expect(
        await pgError(
          asTenant(
            A,
            (tx) => tx`update public.sweep_turns set tenant_id = ${A} where tenant_id = ${A}`,
          ),
        ),
      ).toBe("42501");
      expect(
        await pgError(
          asTenant(A, (tx) => tx`delete from public.sweep_turns where tenant_id = ${A}`),
        ),
      ).toBe("42501");
      expect(await pgError(asTenant(A, (tx) => tx`truncate public.sweep_turns`))).toBe("42501");
      // The owner is refused by the triggers, in a transaction that rolls back.
      expect(
        await pgError(
          admin.begin((tx) => tx`delete from public.sweep_turns where tenant_id = ${A}`),
        ),
      ).toBe("55000");
      expect(await pgError(admin.begin((tx) => tx`truncate public.sweep_turns`))).toBe("55000");
      // An unknown sweep name is refused.
      expect(
        await pgError(
          asTenant(
            A,
            (tx) => tx`insert into public.sweep_turns (tenant_id, sweep) values (${A}, 'bogus')`,
          ),
        ),
      ).toBe("23514");
    });

    it("moves a stamp forward on each turn, keeping one row per tenant and sweep", async () => {
      const [A] = (await tenants(1)) as [string];
      await recordSweepTurn(handle.db, ctxOf(A, "first-run"), "hold");
      const [before] = await admin<{ at: Date; run: string }[]>`
        select last_turn_at as at, run_id as run from public.sweep_turns
         where tenant_id = ${A} and sweep = 'hold'`;
      await new Promise((resolve) => setTimeout(resolve, 20));
      await recordSweepTurn(handle.db, ctxOf(A, `r${"x".repeat(200)}`), "hold");
      await recordSweepTurn(handle.db, ctxOf(A), "checkout");
      const rows = await admin<{ sweep: string; at: Date; run: string }[]>`
        select sweep, last_turn_at as at, run_id as run from public.sweep_turns
         where tenant_id = ${A} order by sweep`;
      expect(rows.map((r) => r.sweep)).toEqual(["checkout", "hold"]);
      const hold = rows.find((r) => r.sweep === "hold");
      expect(before?.run).toBe("first-run");
      expect(hold?.run).toBe(`r${"x".repeat(127)}`);
      expect(hold?.at.getTime()).toBeGreaterThan(before?.at.getTime() ?? Number.POSITIVE_INFINITY);
      // A stamp writes no audit or outbox row.
      const [trail] = await admin<{ n: number }[]>`
        select (select count(*)::int from public.audit_events where tenant_id = ${A})
             + (select count(*)::int from public.outbox_events where tenant_id = ${A}) as n`;
      expect(trail?.n).toBe(0);
    });
  });

  describe("the list functions' order", () => {
    /**
     * Due work for every tenant in every list, written as the owner in one
     * transaction that always rolls back: triggers and foreign keys are off
     * (session_replication_role = replica), so nothing outside this test sees a
     * row that skipped them, and nothing is kept. The functions run as their
     * owner whoever calls them, so calling them here returns what the runtime
     * would get.
     */
    async function withDueWork(
      ids: readonly string[],
      check: (tx: postgres.TransactionSql) => Promise<void>,
    ): Promise<void> {
      const rollback = new Error("always roll back");
      await expect(
        admin.begin(async (tx) => {
          await tx`set local session_replication_role = replica`;
          for (const id of ids) {
            const tag = randomUUID().replaceAll("-", "");
            const host = `turns-${tag.slice(0, 12)}.example.test`;
            await tx`insert into public.capacity_holds
                (tenant_id, trip_id, owner_ref, kind, party_size, seats, expires_at)
              values (${id}, ${randomUUID()}, ${`test:${tag}`}, 'seats', 1, 1, now() - interval '1 hour')`;
            await tx`insert into public.provider_events
                (tenant_id, provider, event_id, event_type, provider_type, account_ref,
                 payload_sha256, verified_at)
              values (${id}, 'fake', ${`evt_${tag}`}, 'other', 'test.other', ${`acct_${tag}`},
                      ${"0".repeat(64)}, now() - interval '1 hour')`;
            await tx`insert into public.email_messages
                (tenant_id, dedupe_key, template, template_version, to_email, from_name, subject,
                 html_body, text_body, next_attempt_at)
              values (${id}, ${`test:${tag}`}, 'test', 1, 'guest@example.test', 'Test', 'Test',
                      'h', 't', now() - interval '1 hour')`;
            await tx`insert into public.tenant_hostnames (hostname, tenant_id, kind, status)
              values (${host}, ${id}, 'custom', 'pending')`;
            await tx`insert into public.tenant_hostname_provisioning
                (tenant_id, hostname, provider, provider_hostname_id, next_check_at, claim_expires_at)
              values (${id}, ${host}, 'fake', ${`h${tag.slice(0, 20)}`}, now() - interval '1 hour',
                      now() + interval '1 day')`;
          }
          await check(tx);
          throw rollback;
        }),
      ).rejects.toBe(rollback);
    }

    const lists = {
      hold: "select tenant_id from app.capacity_hold_sweep_tenants(1000)",
      checkout: "select tenant_id from app.checkout_sweep_tenants(1000, 0)",
      email: "select tenant_id from app.email_delivery_tenants(1000)",
      hostname: "select tenant_id from app.hostname_sweep_tenants(1000)",
    } as const;

    async function orderOf(
      tx: postgres.TransactionSql,
      sweep: keyof typeof lists,
      ids: readonly string[],
    ) {
      const rows = await tx.unsafe<{ tenant_id: string }[]>(lists[sweep]);
      return rows.map((r) => r.tenant_id).filter((id) => ids.includes(id));
    }

    it("returns never-served tenants in id order, as before 0013, ahead of every served one", async () => {
      const ids = await tenants(4);
      const [t1, t2, t3, t4] = ids as [string, string, string, string];
      await withDueWork(ids, async (tx) => {
        for (const sweep of Object.keys(lists) as (keyof typeof lists)[]) {
          expect({ sweep, order: await orderOf(tx, sweep, ids) }).toEqual({
            sweep,
            order: [t1, t2, t3, t4],
          });
        }
        // Serve t1 long ago and t3 just now, for every sweep.
        for (const sweep of Object.keys(lists)) {
          await tx`insert into public.sweep_turns (tenant_id, sweep, last_turn_at)
            values (${t1}, ${sweep}, now() - interval '1 hour'), (${t3}, ${sweep}, now())`;
        }
        for (const sweep of Object.keys(lists) as (keyof typeof lists)[]) {
          expect({ sweep, order: await orderOf(tx, sweep, ids) }).toEqual({
            sweep,
            order: [t2, t4, t1, t3],
          });
        }
      });
    });

    it("orders each list by its own sweep's stamps only", async () => {
      const ids = await tenants(2);
      const [low, high] = ids as [string, string];
      await withDueWork(ids, async (tx) => {
        // The low id was just served by the hold sweep only.
        await tx`insert into public.sweep_turns (tenant_id, sweep) values (${low}, 'hold')`;
        expect(await orderOf(tx, "hold", ids)).toEqual([high, low]);
        for (const sweep of ["checkout", "email", "hostname"] as const) {
          expect({ sweep, order: await orderOf(tx, sweep, ids) }).toEqual({
            sweep,
            order: [low, high],
          });
        }
      });
    });

    it("still returns tenant ids only, and clamps the limit", async () => {
      const ids = await tenants(2);
      await withDueWork(ids, async (tx) => {
        for (const [sweep, query] of Object.entries(lists)) {
          const rows = await tx.unsafe(query);
          expect({ sweep, columns: Object.keys(rows[0] ?? {}) }).toEqual({
            sweep,
            columns: ["tenant_id"],
          });
        }
        expect(await tx`select * from app.capacity_hold_sweep_tenants(-5)`).toHaveLength(1);
        expect(await tx`select * from app.checkout_sweep_tenants(0, 0)`).toHaveLength(1);
        expect(await tx`select * from app.email_delivery_tenants(null)`).not.toHaveLength(0);
        expect(
          (await tx`select * from app.hostname_sweep_tenants(1000000)`).length,
        ).toBeLessThanOrEqual(1000);
      });
    });
  });
});
