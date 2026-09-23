/**
 * Independent adversarial checks for G2.2 at the database layer. Fixtures use
 * the admin connection. Every isolation assertion runs as tidegrid_app, so
 * row-level security and the privileged functions are exercised for real.
 * Tests whose names start with "documents" pin behavior that is by design
 * today. Change them only with a recorded decision.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { sql } from "kysely";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  claimIdempotencyKey,
  completeIdempotencyKey,
  createDb,
  enqueueOutbox,
  type IdempotencyClaim,
  inTenantTransaction,
  recordAudit,
  type TenantContext,
} from "./index.ts";

type Sql = ReturnType<typeof postgres>;

const env = inject("integrationDb");
const uuidShape = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function pgError(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    return (err as { code?: string }).code ?? "no-code";
  }
  return "no-error";
}

const sha = (label: string) => createHash("sha256").update(label).digest("hex");
const hex64 = () => randomBytes(32).toString("hex");
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

describe.skipIf(!env)("adversarial tenancy, privileged-function, and credential checks", () => {
  let admin: Sql;
  let runtime: Sql;
  const runtimeUrl = env?.runtimeUrl ?? "";
  const run = randomUUID().slice(0, 8);
  const A = { id: randomUUID(), slug: `adv-a-${run}` };
  const B = { id: randomUUID(), slug: `adv-b-${run}` };
  const person = (label: string) => ({
    id: randomUUID(),
    email: `adv-${label}-${run}@example.test`,
  });
  const ownerA = person("owner-a");
  const ownerB = person("owner-b");
  const shared = person("shared"); // finance in A, booking staff in B
  const onlyB = person("only-b"); // booking staff in B only
  const racer = person("racer");
  const burst = person("burst");
  const ttlUser = person("ttl");
  const consumer = person("consumer");

  /** One runtime transaction whose tenant setting is exactly `tenantId`. */
  function asTenant<T>(
    client: Sql,
    tenantId: string | null,
    fn: (tx: Sql) => Promise<T>,
  ): Promise<T> {
    return client.begin(async (tx) => {
      if (tenantId !== null) await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
      return fn(tx as unknown as Sql);
    }) as Promise<T>;
  }

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 2, onnotice: () => {} });
    runtime = postgres(env.runtimeUrl, { max: 4, onnotice: () => {} });
    await admin`insert into public.tenants (id, slug, display_name) values
      (${A.id}, ${A.slug}, 'Adversarial A'),
      (${B.id}, ${B.slug}, 'Adversarial B')`;
    for (const p of [ownerA, ownerB, shared, onlyB, racer, burst, ttlUser, consumer]) {
      await admin`insert into public.staff_users (id, email, display_name)
        values (${p.id}, ${p.email}, ${p.email.split("@")[0] ?? "person"})`;
    }
    await admin`insert into public.tenant_memberships (tenant_id, user_id, role, display_name) values
      (${A.id}, ${ownerA.id}, 'owner', 'Fixture member'),
      (${A.id}, ${shared.id}, 'finance', 'Fixture member'),
      (${B.id}, ${ownerB.id}, 'owner', 'Fixture member'),
      (${B.id}, ${shared.id}, 'booking_staff', 'Fixture member'),
      (${B.id}, ${onlyB.id}, 'booking_staff', 'Fixture member')`;
    await admin`insert into public.audit_events (tenant_id, action, subject_type, subject_id) values
      (${A.id}, 'fixture.created', 'fixture', ${A.slug}),
      (${B.id}, 'fixture.created', 'fixture', ${B.slug})`;
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end();
  });

  describe("tenant context", () => {
    it("never carries a transaction-local tenant past commit or rollback on a reused connection", async () => {
      const handle = createDb(runtimeUrl, { max: 1 });
      const ctxA: TenantContext = { tenantId: A.id, actorType: "system", actorId: "adversarial" };
      const probe = async () => {
        const { rows } = await sql<{
          pid: number;
          setting: string | null;
          tenants: number;
          members: number;
        }>`select pg_backend_pid() as pid,
                  current_setting('app.tenant_id', true) as setting,
                  (select count(*)::int from public.tenants) as tenants,
                  (select count(*)::int from public.tenant_memberships) as members`.execute(
          handle.db,
        );
        const row = rows[0];
        return {
          pid: row?.pid,
          setting: row?.setting ?? "",
          tenants: row?.tenants,
          members: row?.members,
        };
      };
      try {
        const inside = await inTenantTransaction(handle.db, ctxA, async (trx) => {
          const { rows } = await sql<{ pid: number; tenants: number }>`
            select pg_backend_pid() as pid, (select count(*)::int from public.tenants) as tenants`.execute(
            trx,
          );
          return rows[0];
        });
        expect(inside?.tenants).toBe(1);
        const pid = inside?.pid;

        const afterCommit = await probe();
        await expect(
          inTenantTransaction(handle.db, ctxA, async () => {
            throw new Error("abort after binding tenant A");
          }),
        ).rejects.toThrow("abort after binding tenant A");
        const afterRollback = await probe();
        // set_config(..., true) outside an explicit transaction lasts one statement.
        await sql`select set_config('app.tenant_id', ${A.id}, true)`.execute(handle.db);
        const afterAutocommit = await probe();

        const empty = { pid, setting: "", tenants: 0, members: 0 };
        expect({ afterCommit, afterRollback, afterAutocommit }).toEqual({
          afterCommit: empty,
          afterRollback: empty,
          afterAutocommit: empty,
        });
      } finally {
        await handle.end();
      }
    });

    it("re-reads the tenant on every execution of a cached generic plan", async () => {
      const conn = postgres(runtimeUrl, { max: 1, onnotice: () => {} });
      try {
        await conn`set plan_cache_mode = force_generic_plan`;
        const pids = new Set<number>();
        const seen: Array<{ i: number; tenants: string[] }> = [];
        for (let i = 0; i < 8; i++) {
          const tenant = i % 2 === 0 ? A : B;
          const rows = await asTenant(
            conn,
            tenant.id,
            (tx) => tx`select m.tenant_id, pg_backend_pid() as pid
              from public.tenant_memberships m join public.staff_users u on u.id = m.user_id
             where u.email like ${`%-${run}@example.test`}`,
          );
          for (const r of rows) pids.add(r.pid);
          seen.push({ i, tenants: [...new Set(rows.map((r) => String(r.tenant_id)))] });
        }
        // Non-vacuous: one cached statement ran every time, always as a generic plan.
        const [plans] = await conn`select coalesce(sum(generic_plans), 0)::int as generic,
                                          coalesce(sum(custom_plans), 0)::int as custom
                                     from pg_prepared_statements
                                    where statement like ${"%from public.tenant_memberships m join%"}`;
        expect(seen).toEqual(
          Array.from({ length: 8 }, (_, i) => ({ i, tenants: [i % 2 === 0 ? A.id : B.id] })),
        );
        expect({ pids: pids.size, plans }).toEqual({ pids: 1, plans: { generic: 8, custom: 0 } });
      } finally {
        await conn.end();
      }
    });

    it("documents that a session-level tenant set by the runtime survives into later transactions", async () => {
      // By design: the database cannot tell set_config(..., false) from a request
      // bug. Only transaction-local context is safe on a pooled connection.
      const conn = postgres(runtimeUrl, { max: 1, onnotice: () => {} });
      try {
        await conn`select set_config('app.tenant_id', ${A.id}, false)`;
        const later = await conn.begin((tx) => tx`select id from public.tenants`);
        const inB = await asTenant(conn, B.id, (tx) => tx`select id from public.tenants`);
        const afterB = await conn`select id from public.tenants`;
        const email = `adv-session-context-${run}@example.test`;
        const [made] =
          await conn`select app.ensure_staff_user(${email}, ${`session-${run}`}) as id`;
        await conn`reset app.tenant_id`;
        const [cleared] = await conn`select count(*)::int as n from public.tenants`;
        expect({
          later: later.map((r) => r.id),
          inB: inB.map((r) => r.id),
          afterB: afterB.map((r) => r.id),
          createdOutsideTransaction: uuidShape.test(String(made?.id)),
          afterReset: cleared?.n,
        }).toEqual({
          later: [A.id],
          inB: [B.id],
          afterB: [A.id],
          createdOutsideTransaction: true,
          afterReset: 0,
        });
      } finally {
        await conn.end();
      }
    });

    it("fails closed after RESET or SET DEFAULT mid-transaction and never shows two tenants at once", async () => {
      const marker = `switch-${run}`;
      const seen = await runtime.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${A.id}, true)`;
        await tx`insert into public.audit_events (tenant_id, action, subject_type, subject_id)
          values (${A.id}, 'test.switched', 'test', ${marker})`;
        const [own] =
          await tx`select count(*)::int as n from public.audit_events where subject_id = ${marker}`;

        await tx`reset app.tenant_id`;
        const [afterReset] = await tx`select
            (select count(*)::int from public.tenants) as tenants,
            (select count(*)::int from public.audit_events) as audits,
            (select count(*)::int from public.staff_users) as users`;
        const writeAfterReset = await pgError(
          tx.savepoint(
            (sp) => sp`insert into public.audit_events (tenant_id, action, subject_type, subject_id)
              values (${A.id}, 'test.after_reset', 'test', ${marker})`,
          ),
        );

        await tx`select set_config('app.tenant_id', ${A.id}, true)`;
        await tx`set local app.tenant_id to default`;
        const [afterDefault] = await tx`select count(*)::int as n from public.tenants`;

        // The database trusts whoever holds the connection, so a second
        // set_config switches tenants. Even this transaction's own tenant A row
        // then disappears: one transaction never sees two tenants at once.
        await tx`select set_config('app.tenant_id', ${B.id}, true)`;
        const [afterSwitch] = await tx`select
            (select count(*)::int from public.audit_events where subject_id = ${marker}) as own,
            array(select distinct tenant_id from public.audit_events) as tenants`;
        return {
          own: own?.n,
          afterReset,
          writeAfterReset,
          afterDefault: afterDefault?.n,
          afterSwitch,
        };
      });
      expect(seen).toEqual({
        own: 1,
        afterReset: { tenants: 0, audits: 0, users: 0 },
        writeAfterReset: "42501",
        afterDefault: 0,
        afterSwitch: { own: 0, tenants: [B.id] },
      });
    });

    it("maps every accepted UUID spelling to the same tenant and raises on padded or joined values", async () => {
      const acceptedSpellings = [A.id.toUpperCase(), `{${A.id}}`, A.id.replaceAll("-", "")];
      const accepted: Array<{ spelling: string; ids: string[] }> = [];
      for (const spelling of acceptedSpellings) {
        const rows = await asTenant(runtime, spelling, (tx) => tx`select id from public.tenants`);
        accepted.push({ spelling, ids: rows.map((r) => String(r.id)) });
      }
      expect(accepted).toEqual(acceptedSpellings.map((spelling) => ({ spelling, ids: [A.id] })));

      const rejectedSpellings = [
        ` ${A.id}`,
        `${A.id} `,
        `${A.id}\n`,
        `${A.id},${B.id}`,
        `${A.id}' or '1'='1`,
      ];
      const rejected: Array<{ spelling: string; code: string }> = [];
      for (const spelling of rejectedSpellings) {
        rejected.push({
          spelling,
          code: await pgError(
            asTenant(runtime, spelling, (tx) => tx`select id from public.tenants`),
          ),
        });
      }
      expect(rejected).toEqual(rejectedSpellings.map((spelling) => ({ spelling, code: "22P02" })));

      const [empty] = await asTenant(
        runtime,
        "",
        (tx) => tx`select count(*)::int as n from public.tenants`,
      );
      expect(empty?.n).toBe(0);

      // The application refuses non-canonical ids before any SQL runs.
      const handle = createDb(runtimeUrl, { max: 1 });
      try {
        for (const tenantId of [A.id.toUpperCase(), ` ${A.id}`, `{${A.id}}`]) {
          await expect(
            inTenantTransaction(handle.db, { tenantId, actorType: "staff" }, async () => "ran"),
          ).rejects.toBeInstanceOf(TypeError);
        }
      } finally {
        await handle.end();
      }
    });

    it("keeps other tenants' identities out of joins, subqueries, lateral queries, and leaky functions", async () => {
      const notices: string[] = [];
      const conn = postgres(runtimeUrl, {
        max: 1,
        onnotice: (n) => notices.push(String(n.message)),
      });
      try {
        // A cheap, non-leakproof function the planner would love to run first. The
        // runtime cannot create functions (no CREATE, no TEMP), so the admin plants
        // it, as a careless future migration might.
        await admin.unsafe(`create function public.adv_leak_${run}(v text) returns boolean
          language plpgsql cost 0.001 as $$ begin raise notice 'adv-leak %', v; return true; end $$`);
        await admin.unsafe(
          `grant execute on function public.adv_leak_${run}(text) to tidegrid_app`,
        );
        const seen = await asTenant(conn, A.id, async (tx) => {
          const [direct] = await tx`select count(*)::int as n from public.staff_users
            where id = ${onlyB.id} or email = ${ownerB.email}`;
          const [probe] = await tx`select exists (
            select 1 from public.staff_users where email = ${onlyB.email}) as found`;
          const [viaOtherTenant] = await tx`select count(*)::int as n from public.staff_users u
            where u.id in (select m.user_id from public.tenant_memberships m where m.tenant_id = ${B.id})`;
          const joined = await tx`select u.email from public.tenant_memberships m
            right join public.staff_users u on u.id = m.user_id order by u.email`;
          const lateral = await tx`select l.tenant_id from public.staff_users u
            cross join lateral (select tenant_id from public.tenant_memberships where user_id = u.id) l
            where u.id = ${shared.id}`;
          const [leakyUsers] = await tx`select count(*)::int as n from public.staff_users u
            where ${tx(`public.adv_leak_${run}`)}(u.email || ' ' || u.id::text)`;
          const [leakyMembers] = await tx`select count(*)::int as n from public.tenant_memberships m
            where ${tx(`public.adv_leak_${run}`)}(m.tenant_id::text || ' ' || m.user_id::text)`;
          const [leakyJoin] = await tx`select count(*)::int as n from public.staff_users u
            join public.tenant_memberships m
              on m.user_id = u.id and ${tx(`public.adv_leak_${run}`)}(u.email || ' ' || m.tenant_id::text)`;
          return {
            direct: direct?.n,
            found: probe?.found,
            viaOtherTenant: viaOtherTenant?.n,
            joined: joined.map((r) => String(r.email)),
            lateral: lateral.map((r) => String(r.tenant_id)),
            leaky: [leakyUsers?.n, leakyMembers?.n, leakyJoin?.n],
          };
        });
        expect(seen).toEqual({
          direct: 0,
          found: false,
          viaOtherTenant: 0,
          joined: [ownerA.email, shared.email].sort(),
          lateral: [A.id],
          leaky: [2, 2, 2],
        });
        // The leaky function ran (non-vacuous) but never received a tenant B value.
        expect(notices.some((n) => n.includes(ownerA.email))).toBe(true);
        const forbidden = [ownerB.email, onlyB.email, onlyB.id, ownerB.id, B.id];
        expect(notices.filter((n) => forbidden.some((f) => n.includes(f)))).toEqual([]);
      } finally {
        await admin.unsafe(`drop function if exists public.adv_leak_${run}(text)`);
        await conn.end();
      }
    });
  });

  describe("privileged functions", () => {
    it("cannot plant tables or functions anywhere, including pg_temp", async () => {
      const conn = postgres(runtimeUrl, { max: 1, onnotice: () => {} });
      try {
        const denied = {
          publicTable: await pgError(conn`create table public.adv_evil (id int)`),
          appFunction: await pgError(
            conn.unsafe(
              "create function app.adv_evil() returns int language sql as $$ select 1 $$",
            ),
          ),
          schema: await pgError(conn.unsafe(`create schema adv_evil_${run}`)),
          tempTable: await pgError(
            conn.unsafe("create temp table staff_users (id uuid, email text, display_name text)"),
          ),
          tempFunction: await pgError(
            conn.unsafe(
              "create function pg_temp.lower(text) returns text language sql as $$ select $1 $$",
            ),
          ),
        };
        expect(denied).toEqual({
          publicTable: "42501",
          appFunction: "42501",
          schema: "42501",
          tempTable: "42501",
          tempFunction: "42501",
        });
      } finally {
        await conn.end();
      }
    });

    it("treats SQL-injection-shaped arguments as data in every privileged function", async () => {
      const payloads = [
        `' or '1'='1`,
        `${ownerA.email}' --`,
        `x'); delete from public.staff_users; --`,
        "%",
        "\\x27 or true",
        "$$ select 1 $$",
      ];
      const [before] = await admin`select count(*)::int as n from public.staff_users`;
      const outcomes: unknown[] = [];
      for (const p of payloads) {
        outcomes.push({
          p,
          find: (await runtime`select * from app.auth_find_staff_by_email(${p})`).length,
          host: (await runtime`select * from app.resolve_hostname(${p})`).length,
          session: (await runtime`select * from app.auth_resolve_session(${p})`).length,
          revoke: (await runtime`select app.auth_revoke_session(${p}, ${p}) as ok`)[0]?.ok,
          issue: (
            await runtime`select app.auth_issue_login_token(${p}, ${hex64()}, 900, ${p}) as outcome`
          )[0]?.outcome,
          consume: (
            await runtime`select * from app.auth_consume_login_token(${p}, ${hex64()}, 3600, ${p})`
          ).length,
        });
      }
      expect(outcomes).toEqual(
        payloads.map((p) => ({
          p,
          find: 0,
          host: 0,
          session: 0,
          revoke: false,
          issue: "unknown",
          consume: 0,
        })),
      );
      const [after] = await admin`select count(*)::int as n from public.staff_users`;
      expect(after?.n).toBe(before?.n);
    });

    it("requires an existing active tenant for ensure_staff_user, and auth_list_memberships trusts its caller", async () => {
      // ensure_staff_user now refuses a missing, malformed, unknown, or suspended
      // tenant. auth_list_memberships still takes any user id by design: the API
      // passes only the authenticated principal's own id.
      const ghostEmail = `adv-ghost-${run}@example.test`;
      const junkEmail = `adv-junk-${run}@example.test`;
      const req = `by-design-${run}`;
      const ghost = await pgError(
        asTenant(
          runtime,
          randomUUID(),
          (tx) => tx`select app.ensure_staff_user(${ghostEmail}, ${req})`,
        ),
      );
      const junk = await pgError(
        asTenant(
          runtime,
          "not-a-uuid",
          (tx) => tx`select app.ensure_staff_user(${junkEmail}, ${req})`,
        ),
      );
      const [crossed] = await asTenant(
        runtime,
        A.id,
        (tx) => tx`select app.ensure_staff_user(${onlyB.email.toUpperCase()}, ${req}) as id`,
      );
      const listed =
        await runtime`select tenant_id, role from app.auth_list_memberships(${onlyB.id})`;
      const [stored] = await admin`select
          (select count(*)::int from public.staff_users where email in (${ghostEmail}, ${junkEmail})) as created,
          (select count(*)::int from public.security_events
            where request_id = ${req} and kind = 'staff_user_created') as events`;
      expect({
        ghost,
        junk,
        crossed: crossed?.id,
        listed: listed.map((r) => [String(r.tenant_id), String(r.role)]),
        stored,
      }).toEqual({
        ghost: "42501",
        junk: "22P02",
        crossed: onlyB.id,
        listed: [[B.id, "booking_staff"]],
        stored: { created: 0, events: 0 },
      });
    });
  });

  describe("credentials", () => {
    it("opens one session when two connections race for one login token, and a rolled-back redemption does not burn it", async () => {
      const c1 = postgres(runtimeUrl, { max: 1, onnotice: () => {} });
      const c2 = postgres(runtimeUrl, { max: 1, onnotice: () => {} });
      const issue = async (hash: string) =>
        (
          await runtime`select app.auth_issue_login_token(${racer.email}, ${hash}, 900, ${`race-${run}`}) as outcome`
        )[0]?.outcome;
      const consume = (client: Sql, token: string, session: string, req: string) =>
        client`select user_id from app.auth_consume_login_token(${token}, ${session}, 3600, ${req})`;
      try {
        // Race one: the first redemption commits.
        const token = hex64();
        expect(await issue(token)).toBe("issued");
        const [s1, s2] = [hex64(), hex64()];
        const holding = gate();
        const release = gate();
        const first = c1.begin(async (tx) => {
          const rows = await consume(tx as unknown as Sql, token, s1, `race-a1-${run}`);
          holding.open();
          await release.opened;
          return rows.map((r) => String(r.user_id));
        });
        await Promise.race([holding.opened, first]);
        let secondSettled = false;
        const second = consume(c2, token, s2, `race-a2-${run}`).then((rows) => {
          secondSettled = true;
          return rows.map((r) => String(r.user_id));
        });
        await sleep(750);
        const blocked = !secondSettled;
        release.open();
        const raceOne = { blocked, first: await first, second: await second };

        // Race two: the first redemption consumes, then rolls back.
        const token2 = hex64();
        expect(await issue(token2)).toBe("issued");
        const [s3, s4] = [hex64(), hex64()];
        const holding2 = gate();
        const release2 = gate();
        const aborted = c1.begin(async (tx) => {
          await consume(tx as unknown as Sql, token2, s3, `race-b1-${run}`);
          holding2.open();
          await release2.opened;
          throw new Error("abort after consuming");
        });
        await Promise.race([holding2.opened, aborted.catch(() => undefined)]);
        const waiting = consume(c2, token2, s4, `race-b2-${run}`).then((rows) =>
          rows.map((r) => String(r.user_id)),
        );
        await sleep(300);
        release2.open();
        await expect(aborted).rejects.toThrow("abort after consuming");
        const raceTwo = { second: await waiting };

        const sessions = await admin`select session_hash from public.staff_sessions
          where session_hash in (${s1}, ${s2}, ${s3}, ${s4}) order by session_hash`;
        const events = await admin`select request_id, kind from public.security_events
          where request_id like ${`race-__-${run}`} order by request_id`;
        expect({
          raceOne,
          raceTwo,
          sessions: sessions.map((r) => String(r.session_hash)),
          events: events.map((r) => [String(r.request_id), String(r.kind)]),
        }).toEqual({
          raceOne: { blocked: true, first: [racer.id], second: [] },
          raceTwo: { second: [racer.id] },
          sessions: [s1, s4].sort(),
          events: [
            [`race-a1-${run}`, "login_link_consumed"],
            [`race-a2-${run}`, "login_link_rejected"],
            [`race-b2-${run}`, "login_link_consumed"],
          ],
        });
      } finally {
        await c1.end();
        await c2.end();
      }
    });

    it("holds the five-link limit when ten requests for one address arrive together", async () => {
      const pool = postgres(runtimeUrl, { max: 10, onnotice: () => {} });
      try {
        const results = await Promise.all(
          Array.from({ length: 10 }, async (_, i) => {
            const [row] = await pool`select
                app.auth_issue_login_token(${burst.email}, ${hex64()}, 900, ${`burst-${run}-${i}`}) as outcome,
                pg_backend_pid() as pid`;
            return { outcome: String(row?.outcome), pid: Number(row?.pid) };
          }),
        );
        const tally: Record<string, number> = {};
        for (const r of results) tally[r.outcome] = (tally[r.outcome] ?? 0) + 1;
        const [stored] =
          await admin`select count(*)::int as n from public.staff_login_tokens where user_id = ${burst.id}`;
        expect({ tally, stored: stored?.n }).toEqual({
          tally: { issued: 5, rate_limited: 5 },
          stored: 5,
        });
        // More than one backend took part, so the limit held under real concurrency.
        expect(new Set(results.map((r) => r.pid)).size).toBeGreaterThan(1);
      } finally {
        await pool.end();
      }
    });

    it("enforces login and session TTL bounds at both edges and never burns a token on a failed call", async () => {
      const req = `ttl-${run}`;
      const issue = async (email: string, hash: string, ttl: number | null) =>
        (
          await runtime`select app.auth_issue_login_token(${email}, ${hash}, ${ttl}::int, ${req}) as outcome`
        )[0]?.outcome;
      const consume = async (token: string, session: string, ttl: number | null) =>
        (
          await runtime`select user_id from app.auth_consume_login_token(${token}, ${session}, ${ttl}::int, ${req})`
        ).map((r) => String(r.user_id));

      const issueEdges: Record<string, string> = {};
      for (const ttl of [59, 3601, -1, null]) {
        issueEdges[String(ttl)] = await pgError(issue(ttlUser.email, hex64(), ttl));
      }
      expect(issueEdges).toEqual({ "59": "22023", "3601": "22023", "-1": "22023", null: "22023" });
      expect([
        await issue(ttlUser.email, hex64(), 60),
        await issue(ttlUser.email, hex64(), 3600),
      ]).toEqual(["issued", "issued"]);
      const [ttlTokens] =
        await admin`select count(*)::int as n from public.staff_login_tokens where user_id = ${ttlUser.id}`;
      expect(ttlTokens?.n).toBe(2);

      // A live session that belongs to someone else.
      const otherToken = hex64();
      const otherSession = hex64();
      expect(await issue(ownerB.email, otherToken, 900)).toBe("issued");
      expect(await consume(otherToken, otherSession, 3600)).toEqual([ownerB.id]);

      const token = hex64();
      expect(await issue(consumer.email, token, 900)).toBe("issued");
      const failures = {
        tooShort: await pgError(consume(token, hex64(), 299)),
        tooLong: await pgError(consume(token, hex64(), 604801)),
        missing: await pgError(consume(token, hex64(), null)),
        uppercaseHash: await pgError(consume(token, hex64().toUpperCase(), 3600)),
        shortHash: await pgError(consume(token, "ab", 3600)),
        stolenSessionHash: await pgError(consume(token, otherSession, 3600)),
      };
      expect(failures).toEqual({
        tooShort: "22023",
        tooLong: "22023",
        missing: "22023",
        uppercaseHash: "23514",
        shortHash: "23514",
        stolenSessionHash: "23505",
      });
      const [victim] =
        await admin`select user_id, revoked_at from public.staff_sessions where session_hash = ${otherSession}`;
      expect(victim).toEqual({ user_id: ownerB.id, revoked_at: null });
      // Every failure rolled back, so the token still opens exactly one session.
      expect(await consume(token, hex64(), 300)).toEqual([consumer.id]);
      const token2 = hex64();
      expect(await issue(consumer.email, token2, 900)).toBe("issued");
      expect(await consume(token2, hex64(), 604800)).toEqual([consumer.id]);

      const oversized = {
        resolve: (await runtime`select * from app.auth_resolve_session(${"f".repeat(100_000)})`)
          .length,
        find: (
          await runtime`select * from app.auth_find_staff_by_email(${`${"a".repeat(100_000)}@example.test`})`
        ).length,
        revoke: (await runtime`select app.auth_revoke_session(${"f".repeat(64)}, ${req}) as ok`)[0]
          ?.ok,
      };
      expect(oversized).toEqual({ resolve: 0, find: 0, revoke: false });
    });
  });

  describe("rollback and idempotency", () => {
    const ctx = (tenantId: string, requestId: string): TenantContext => ({
      tenantId,
      actorType: "staff",
      actorId: shared.id,
      requestId,
    });

    it("rolls back identities and security events that a privileged function wrote in the transaction", async () => {
      const handle = createDb(runtimeUrl, { max: 1 });
      const requestId = `rollback-${run}`;
      const context = ctx(A.id, requestId);
      const email = `adv-rolled-back-${run}@example.test`;
      const claim: IdempotencyClaim = {
        scope: "members.create",
        principal: `staff:${shared.id}`,
        key: `rollback-${run}`,
        requestHash: sha("rollback"),
      };
      try {
        await expect(
          inTenantTransaction(handle.db, context, async (trx) => {
            await claimIdempotencyKey(trx, context, claim);
            const { rows } = await sql<{ id: string }>`
              select app.ensure_staff_user(${email}, ${requestId}) as id`.execute(trx);
            const id = rows[0]?.id ?? "";
            await trx
              .insertInto("tenant_memberships")
              .values({ tenant_id: A.id, user_id: id, role: "owner", display_name: "Rolled Back" })
              .execute();
            await recordAudit(trx, context, {
              action: "membership.created",
              subjectType: "staff_user",
              subjectId: id,
              reason: "about to fail",
              after: { role: "owner" },
            });
            await enqueueOutbox(trx, context, {
              topic: "tenant.membership.created",
              aggregateType: "tenant_membership",
              aggregateId: id,
              payload: { tenantId: A.id, userId: id },
            });
            await completeIdempotencyKey(trx, context, claim, { status: 201, body: { id } });
            throw new Error("fail after every write");
          }),
        ).rejects.toThrow("fail after every write");

        const [left] = await admin`select
            (select count(*)::int from public.staff_users where email = ${email}) as identities,
            (select count(*)::int from public.security_events where request_id = ${requestId}) as security,
            (select count(*)::int from public.audit_events where request_id = ${requestId}) as audits,
            (select count(*)::int from public.outbox_events where request_id = ${requestId}) as events,
            (select count(*)::int from public.idempotency_keys where key = ${claim.key}) as keys`;
        expect(left).toEqual({ identities: 0, security: 0, audits: 0, events: 0, keys: 0 });
        // The key was released with the rest. Probe it, then roll back again.
        let reclaimed: unknown;
        await expect(
          inTenantTransaction(handle.db, context, async (trx) => {
            reclaimed = await claimIdempotencyKey(trx, context, claim);
            throw new Error("probe only");
          }),
        ).rejects.toThrow("probe only");
        expect(reclaimed).toEqual({ kind: "new" });
      } finally {
        await handle.end();
      }
    });

    it("never blocks or replays across tenants when one principal reuses a key concurrently", async () => {
      const first = createDb(runtimeUrl, { max: 1 });
      const second = createDb(runtimeUrl, { max: 1 });
      const claim: IdempotencyClaim = {
        scope: "members.create",
        principal: `staff:${shared.id}`,
        key: `cross-tenant-${run}`,
        requestHash: sha("same request in two tenants"),
      };
      const inA = ctx(A.id, `cross-a-${run}`);
      const inB = ctx(B.id, `cross-b-${run}`);
      const holding = gate();
      const release = gate();
      try {
        const tA = inTenantTransaction(first.db, inA, async (trx) => {
          const result = await claimIdempotencyKey(trx, inA, claim);
          holding.open();
          await release.opened;
          await completeIdempotencyKey(trx, inA, claim, { status: 201, body: { tenant: A.id } });
          return result;
        });
        await Promise.race([holding.opened, tA]);
        // Tenant A's claim is in flight and uncommitted. Tenant B must not wait on it.
        const tB = inTenantTransaction(second.db, inB, async (trx) => {
          const result = await claimIdempotencyKey(trx, inB, claim);
          await completeIdempotencyKey(trx, inB, claim, { status: 201, body: { tenant: B.id } });
          return result;
        });
        const bWhileAOpen = await Promise.race([tB, sleep(10_000).then(() => "blocked" as const)]);
        release.open();
        const aResult = await tA;
        await tB;

        const replay = (context: TenantContext) =>
          inTenantTransaction(first.db, context, (trx) => claimIdempotencyKey(trx, context, claim));
        expect({
          bWhileAOpen,
          aResult,
          replayA: await replay(inA),
          replayB: await replay(inB),
        }).toEqual({
          bWhileAOpen: { kind: "new" },
          aResult: { kind: "new" },
          replayA: { kind: "replay", status: 201, body: { tenant: A.id } },
          replayB: { kind: "replay", status: 201, body: { tenant: B.id } },
        });
      } finally {
        release.open();
        await first.end();
        await second.end();
      }
    });
  });
});
