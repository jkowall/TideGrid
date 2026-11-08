import { randomUUID } from "node:crypto";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import {
  defaultMigrationTimeouts,
  loadMigrations,
  type MigrationFile,
  migrate,
  status,
} from "./migrate.ts";
import { runtimeRoleFindings } from "./role.ts";

const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is required in CI; the integration suite must not skip silently.");
}

describe.skipIf(!url)("migrate against a live PostgreSQL branch", () => {
  it("applies every migration once, then is a no-op, and the app role can read", async () => {
    const first = await migrate(url as string);
    const files = await loadMigrations();
    const rows = await status(url as string);
    expect(rows.every((r) => r.applied)).toBe(true);
    expect(rows.length).toBe(files.length);

    const second = await migrate(url as string);
    expect(second.applied).toEqual([]);
    expect(second.skipped.length).toBe(files.length);
    expect(first.applied.length + first.skipped.length).toBe(files.length);

    const sql = postgres(url as string, { max: 1, prepare: false });
    try {
      expect(await runtimeRoleFindings(sql)).toEqual([]);
      const [grant] = await sql<{ ok: boolean }[]>`
        SELECT has_table_privilege('tidegrid_app', 'schema_migrations', 'SELECT') AS ok`;
      expect(grant?.ok).toBe(true);
      const [write] = await sql<{ ok: boolean }[]>`
        SELECT has_table_privilege('tidegrid_app', 'schema_migrations', 'INSERT') AS ok`;
      expect(write?.ok).toBe(false);
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 60_000);

  // Sweep fairness (0013) replaces the four sweep list functions in place.
  it("keeps the sweep list functions' signatures, grants, and definer settings after 0013", async () => {
    const sql = postgres(url as string, { max: 1, prepare: false });
    try {
      const [applied] = await sql<{ ok: boolean }[]>`
        SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE name = '0013_sweep_fairness.sql') AS ok`;
      expect(applied?.ok).toBe(true);
      const rows = await sql<
        {
          name: string;
          args: string;
          result: string;
          volatility: string;
          definer: boolean;
          config: string[];
          runtime: boolean;
          public_execute: boolean;
          reads_stamps: boolean;
        }[]
      >`
        SELECT p.proname AS name,
               pg_get_function_identity_arguments(p.oid) AS args,
               pg_get_function_result(p.oid) AS result,
               p.provolatile::text AS volatility,
               p.prosecdef AS definer,
               p.proconfig AS config,
               has_function_privilege('tidegrid_app', p.oid, 'EXECUTE') AS runtime,
               EXISTS (SELECT 1 FROM aclexplode(p.proacl) x WHERE x.grantee = 0) AS public_execute,
               p.prosrc LIKE '%public.sweep_turns%' AS reads_stamps
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'app'
           AND p.proname IN ('capacity_hold_sweep_tenants', 'checkout_sweep_tenants',
                             'email_delivery_tenants', 'hostname_sweep_tenants')
         ORDER BY p.proname`;
      const common = {
        result: "TABLE(tenant_id uuid)",
        volatility: "s",
        definer: true,
        config: ["search_path=pg_catalog, pg_temp"],
        runtime: true,
        public_execute: false,
        reads_stamps: true,
      };
      expect(rows.map((r) => ({ ...r }))).toEqual([
        { name: "capacity_hold_sweep_tenants", args: "p_limit integer", ...common },
        {
          name: "checkout_sweep_tenants",
          args: "p_limit integer, p_grace_seconds integer",
          ...common,
        },
        { name: "email_delivery_tenants", args: "p_limit integer", ...common },
        { name: "hostname_sweep_tenants", args: "p_limit integer", ...common },
      ]);
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 30_000);

  // Email account faults (0015) replace the email message trigger function in place.
  it("keeps the email message trigger's settings and binding after 0015, with the give-back", async () => {
    const sql = postgres(url as string, { max: 1, prepare: false });
    try {
      const [applied] = await sql<{ ok: boolean }[]>`
        SELECT EXISTS (SELECT 1 FROM schema_migrations
                        WHERE name = '0015_email_account_fault_retry.sql') AS ok`;
      expect(applied?.ok).toBe(true);
      const [fn] = await sql<
        {
          definer: boolean;
          config: string[];
          runtime: boolean;
          public_execute: boolean;
          gives_back: boolean;
          counts_claims: boolean;
          bound: boolean;
        }[]
      >`
        SELECT p.prosecdef AS definer,
               p.proconfig AS config,
               has_function_privilege('tidegrid_app', p.oid, 'EXECUTE') AS runtime,
               EXISTS (SELECT 1 FROM aclexplode(p.proacl) x WHERE x.grantee = 0) AS public_execute,
               p.prosrc LIKE '%only an account-level fault gives its attempt back%' AS gives_back,
               p.prosrc LIKE '%attempts count claims only%' AS counts_claims,
               EXISTS (SELECT 1 FROM pg_trigger t
                        WHERE t.tgname = 'email_messages_rules'
                          AND t.tgrelid = 'public.email_messages'::regclass
                          AND t.tgfoid = p.oid) AS bound
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'app' AND p.proname = 'check_email_message'`;
      expect(fn).toEqual({
        definer: false,
        config: ["search_path=pg_catalog, pg_temp"],
        runtime: false,
        public_execute: false,
        gives_back: true,
        counts_claims: true,
        bound: true,
      });
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 30_000);

  it("rejects a changed checksum on an applied migration", async () => {
    const files = await loadMigrations();
    const tampered = files.map((f, i) => (i === 0 ? { ...f, checksum: "0".repeat(64) } : f));
    await expect(migrate(url as string, tampered)).rejects.toThrow(/different checksum/);
  }, 30_000);

  // Suites run one file at a time, so borrowing tidegrid_app here cannot race
  // another suite. Dropping the group also revokes the membership.
  it("refuses a runtime role with any membership, before pending migrations and on no-op runs", async () => {
    const run = randomUUID().slice(0, 8);
    const group = `adv_group_${run}`;
    const probe = `adv_probe_${run}`;
    const pending = {
      name: "9999_probe.sql",
      sql: `CREATE TABLE public.${probe} (id int)`,
      checksum: "f".repeat(64),
    };
    const admin = postgres(url as string, { max: 1, prepare: false, onnotice: () => {} });
    try {
      // An ordinary group, not neon_superuser: membership alone is refused.
      await admin.unsafe(`CREATE ROLE ${group} NOLOGIN`);
      try {
        await admin.unsafe(`GRANT ${group} TO tidegrid_app`);
        const refused = new RegExp(`member of ${group}`);
        await expect(migrate(url as string)).rejects.toThrow(refused);
        await expect(
          migrate(url as string, [...(await loadMigrations()), pending]),
        ).rejects.toThrow(refused);
        const [after] = await admin<{ probe: string | null; recorded: boolean }[]>`
          SELECT to_regclass(${`public.${probe}`})::text AS probe,
                 EXISTS (SELECT 1 FROM schema_migrations WHERE name = ${pending.name}) AS recorded`;
        expect(after).toEqual({ probe: null, recorded: false });
      } finally {
        await admin.unsafe(`DROP ROLE ${group}`);
      }
    } finally {
      await admin.end({ timeout: 5 });
    }
    expect((await migrate(url as string)).applied).toEqual([]);
  }, 60_000);

  it("names each way a role exceeds the plain runtime role", async () => {
    const run = randomUUID().slice(0, 8);
    const role = `adv_runtime_${run}`;
    const group = `adv_group_${run}`;
    const schema = `adv_schema_${run}`;
    const admin = postgres(url as string, { max: 1, prepare: false, onnotice: () => {} });
    try {
      expect(await runtimeRoleFindings(admin, role)).toBeNull();
      // Let this session act as and inherit from the roles it creates, so it can
      // hand one a schema and drop the schema afterward.
      await admin.unsafe(`SET createrole_self_grant = 'set, inherit'`);
      await admin.unsafe(`CREATE ROLE ${role} LOGIN NOINHERIT`);
      await admin.unsafe(`CREATE ROLE ${group} NOLOGIN`);
      try {
        expect(await runtimeRoleFindings(admin, role)).toEqual([]);
        await admin.unsafe(`ALTER ROLE ${role} CREATEDB REPLICATION`);
        await admin.unsafe(`GRANT ${group} TO ${role}`);
        await admin.unsafe(`CREATE SCHEMA ${schema} AUTHORIZATION ${role}`);
        expect(await runtimeRoleFindings(admin, role)).toEqual([
          "has CREATEDB, REPLICATION",
          `is a member of ${group}`,
          "owns a schema",
        ]);
      } finally {
        await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema}`);
        await admin.unsafe(`DROP ROLE ${role}`);
        await admin.unsafe(`DROP ROLE ${group}`);
      }
    } finally {
      await admin.end({ timeout: 5 });
    }
  }, 60_000);
});

/**
 * The no-transaction mode for CREATE INDEX CONCURRENTLY (the D6 A standing
 * rule), proved with test-only fixture migrations, each test on a scratch
 * database it creates and drops. The fixtures never reach the job's own
 * database, so its schema_migrations keeps only the real files.
 */
describe.skipIf(!url)("no-transaction files on a scratch database", () => {
  const fixtureDir = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "test-fixtures",
    "no-transaction-migrations",
  );
  type Sql = ReturnType<typeof postgres>;

  /** Create a scratch database, run the body against it, and always drop it. */
  async function onScratch(
    body: (scratchUrl: string, scratch: Sql, files: MigrationFile[]) => Promise<void>,
  ): Promise<void> {
    const name = `noxact_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const admin = postgres(url as string, { max: 1, onnotice: () => {} });
    try {
      // The name is generated here, lowercase letters, digits, and underscore only.
      await admin.unsafe(`CREATE DATABASE ${name}`);
      const u = new URL(url as string);
      u.pathname = `/${name}`;
      const scratchUrl = u.toString();
      const scratch = postgres(scratchUrl, { max: 2, onnotice: () => {} });
      try {
        await body(scratchUrl, scratch, await loadMigrations(fixtureDir));
      } finally {
        await scratch.end({ timeout: 5 });
      }
    } finally {
      try {
        await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await admin.end({ timeout: 5 });
      }
    }
  }

  async function indexState(sql: Sql, index: string) {
    const [row] = await sql<{ valid: boolean | null }[]>`
      SELECT (SELECT x.indisvalid FROM pg_index x
               WHERE x.indexrelid = to_regclass(${`public.${index}`})) AS valid`;
    return row?.valid ?? null;
  }

  async function recorded(sql: Sql): Promise<string[]> {
    const rows = await sql<{ name: string }[]>`SELECT name FROM schema_migrations ORDER BY name`;
    return rows.map((r) => r.name);
  }

  const pick = (files: MigrationFile[], ...numbers: number[]) =>
    files.filter((f) => numbers.includes(Number(f.name.slice(0, 4))));

  it("runs a marked file outside a transaction, records it after success, and is then a no-op", async () => {
    await onScratch(async (scratchUrl, scratch, files) => {
      const first = await migrate(scratchUrl, pick(files, 1, 2));
      expect(first.applied).toEqual(["0001_fixture_items.sql", "0002_fixture_items_code_key.sql"]);
      expect(await indexState(scratch, "fixture_items_code_key")).toBe(true);
      expect(await recorded(scratch)).toEqual([
        "0001_fixture_items.sql",
        "0002_fixture_items_code_key.sql",
      ]);
      const again = await migrate(scratchUrl, pick(files, 1, 2));
      expect(again).toEqual({ applied: [], skipped: first.applied });

      // The same statement without the marker runs in a transaction, as every
      // unmarked file does, and PostgreSQL refuses it there.
      const [marked] = pick(files, 2);
      const unmarked = {
        name: "0003_unmarked.sql",
        sql: (marked as MigrationFile).sql
          .replace("-- tidegrid:no-transaction\n", "")
          .replace("fixture_items_code_key", "fixture_items_code_again"),
        checksum: "e".repeat(64),
      };
      await expect(migrate(scratchUrl, [...pick(files, 1, 2), unmarked])).rejects.toThrow(
        /0003_unmarked\.sql failed: CREATE INDEX CONCURRENTLY cannot run inside a transaction block/,
      );
      expect(await indexState(scratch, "fixture_items_code_again")).toBeNull();
      expect(await recorded(scratch)).not.toContain("0003_unmarked.sql");
    });
  }, 60_000);

  it("leaves a failed build unrecorded, refuses every later run with the repair, and never drops the index", async () => {
    await onScratch(async (scratchUrl, scratch, files) => {
      await migrate(scratchUrl, pick(files, 1));
      await scratch`INSERT INTO public.fixture_items (id, code) VALUES (1001, 'code-1')`;

      const repair = "DROP INDEX CONCURRENTLY IF EXISTS public.fixture_items_code_key;";
      const failed = migrate(scratchUrl, pick(files, 1, 2));
      await expect(failed).rejects.toThrow(
        /0002_fixture_items_code_key\.sql failed: could not create unique index/,
      );
      await expect(failed).rejects.toThrow(/The failed build left 1 invalid index/);
      await expect(failed).rejects.toThrow(repair);
      expect(await indexState(scratch, "fixture_items_code_key")).toBe(false);
      expect(await recorded(scratch)).toEqual(["0001_fixture_items.sql"]);

      // The next run refuses before it applies anything, pending files or not.
      for (const run of [pick(files, 1, 2), pick(files, 1)]) {
        const refused = migrate(scratchUrl, run);
        await expect(refused).rejects.toThrow(/^Migrations refused: 1 invalid index\(es\)/);
        await expect(refused).rejects.toThrow(repair);
        await expect(refused).rejects.toThrow(/Nothing was dropped and nothing was applied/);
      }
      expect(await indexState(scratch, "fixture_items_code_key")).toBe(false);
      expect(await recorded(scratch)).toEqual(["0001_fixture_items.sql"]);

      // The repair the message names, then the cause, then the same file again.
      await scratch.unsafe(repair);
      await scratch`DELETE FROM public.fixture_items WHERE id = 1001`;
      const fixed = await migrate(scratchUrl, pick(files, 1, 2));
      expect(fixed.applied).toEqual(["0002_fixture_items_code_key.sql"]);
      expect(await indexState(scratch, "fixture_items_code_key")).toBe(true);
    });
  }, 60_000);

  it("holds a marked file to the session-level lock_timeout", async () => {
    await onScratch(async (scratchUrl, scratch, files) => {
      await migrate(scratchUrl, pick(files, 1));
      // An open transaction that wrote to the table: the build waits for it.
      const writer = postgres(scratchUrl, { max: 1, onnotice: () => {} });
      try {
        let release: () => void = () => {};
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        let ready: () => void = () => {};
        const writing = new Promise<void>((resolve) => {
          ready = resolve;
        });
        const tx = writer.begin(async (t) => {
          await t`INSERT INTO public.fixture_items (id, code) VALUES (2001, 'code-2001')`;
          ready();
          await held;
          throw new Error("roll back");
        });
        await writing;
        const timeouts = { lockTimeoutMs: 300, statementTimeoutMs: 60_000 };
        const started = Date.now();
        await expect(migrate(scratchUrl, pick(files, 1, 2), timeouts)).rejects.toThrow(
          /0002_fixture_items_code_key\.sql failed: canceling statement due to lock timeout/,
        );
        expect(Date.now() - started).toBeLessThan(10_000);
        release();
        await expect(tx).rejects.toThrow("roll back");
      } finally {
        await writer.end({ timeout: 5 });
      }
      expect(await indexState(scratch, "fixture_items_code_key")).toBe(false);
      expect(await recorded(scratch)).toEqual(["0001_fixture_items.sql"]);
      await expect(migrate(scratchUrl, pick(files, 1, 2))).rejects.toThrow(
        /Migrations refused: 1 invalid index/,
      );
    });
  }, 60_000);

  it("ends the build's wait for an older snapshot on another table at the lock_timeout", async () => {
    await onScratch(async (scratchUrl, scratch, files) => {
      await migrate(scratchUrl, pick(files, 1));
      // A reader of another table only, holding its snapshot open.
      const reader = postgres(scratchUrl, { max: 1, onnotice: () => {} });
      try {
        let release: () => void = () => {};
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        let ready: () => void = () => {};
        const reading = new Promise<void>((resolve) => {
          ready = resolve;
        });
        const tx = reader.begin("isolation level repeatable read", async (t) => {
          await t`SELECT count(*) FROM schema_migrations`;
          ready();
          await held;
        });
        await reading;
        const timeouts = { lockTimeoutMs: 300, statementTimeoutMs: 60_000 };
        await expect(migrate(scratchUrl, pick(files, 1, 2), timeouts)).rejects.toThrow(
          /0002_fixture_items_code_key\.sql failed: canceling statement due to lock timeout/,
        );
        release();
        await tx;
      } finally {
        await reader.end({ timeout: 5 });
      }
      expect(await indexState(scratch, "fixture_items_code_key")).toBe(false);
      expect(await recorded(scratch)).toEqual(["0001_fixture_items.sql"]);
    });
  }, 60_000);

  it("holds a marked file to the session-level statement_timeout", async () => {
    await onScratch(async (scratchUrl, scratch, files) => {
      await migrate(scratchUrl, pick(files, 1));
      const timeouts = { lockTimeoutMs: 5_000, statementTimeoutMs: 300 };
      await expect(migrate(scratchUrl, pick(files, 1, 3), timeouts)).rejects.toThrow(
        /0003_fixture_items_slow\.sql failed: canceling statement due to statement timeout[\s\S]*DROP INDEX CONCURRENTLY IF EXISTS public\.fixture_items_slow;/,
      );
      expect(await indexState(scratch, "fixture_items_slow")).toBe(false);
      expect(await recorded(scratch)).toEqual(["0001_fixture_items.sql"]);
    });
  }, 60_000);

  it("lets a second runner wait for the lock without stalling a concurrent build", async () => {
    await onScratch(async (scratchUrl, scratch, files) => {
      await migrate(scratchUrl, pick(files, 1));
      const run = pick(files, 1, 3);
      const first = migrate(scratchUrl, run, defaultMigrationTimeouts);
      // Start the second runner once the first holds the lock and is building.
      for (;;) {
        const [row] = await scratch<{ building: boolean }[]>`
          SELECT EXISTS (SELECT 1 FROM pg_stat_activity
                          WHERE datname = current_database()
                            AND query LIKE 'CREATE INDEX CONCURRENTLY fixture_items_slow%') AS building`;
        if (row?.building) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const second = migrate(scratchUrl, run, defaultMigrationTimeouts);
      const [a, b] = await Promise.all([first, second]);
      expect(a.applied).toEqual(["0003_fixture_items_slow.sql"]);
      expect(b).toEqual({
        applied: [],
        skipped: ["0001_fixture_items.sql", "0003_fixture_items_slow.sql"],
      });
      expect(await indexState(scratch, "fixture_items_slow")).toBe(true);
    });
  }, 60_000);

  /**
   * A TCP relay that cuts the runner's connection the instant the server
   * answers its session `SET statement_timeout`: the reply and the close go
   * out together. postgres.js reconnects silently when a connection closes
   * while idle, and a build sent on that new session would run with no
   * timeouts and without the runners' lock. The runner never idles there: the
   * build is handed to the connection in the same turn the reply arrives, so
   * the close fails the build instead. This guards that ordering.
   */
  async function cutAfterSessionTimeouts(target: URL) {
    let cuts = 0;
    const sockets = new Set<net.Socket>();
    const server = net.createServer((client) => {
      const upstream = net.connect({ port: Number(target.port || 5432), host: target.hostname });
      let armed = false;
      for (const s of [client, upstream]) {
        sockets.add(s);
        s.on("error", () => {});
        s.on("close", () => sockets.delete(s));
      }
      client.on("close", () => upstream.destroy());
      upstream.on("close", () => client.destroy());
      client.on("data", (chunk) => {
        if (chunk.toString("utf8").includes("SET statement_timeout")) armed = true;
        upstream.write(chunk);
      });
      upstream.on("data", (chunk) => {
        // 0x5a is ReadyForQuery: the SET is done and the session is idle.
        if (armed && cuts === 0 && chunk.includes(0x5a)) {
          cuts++;
          client.end(chunk);
          upstream.destroy();
          return;
        }
        client.write(chunk);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const relayed = new URL(target);
    relayed.hostname = "127.0.0.1";
    relayed.port = String((server.address() as net.AddressInfo).port);
    return {
      url: relayed.toString(),
      cuts: () => cuts,
      close: async () => {
        for (const s of sockets) s.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    };
  }

  // The relay rewrites the host, so TLS with SNI (Neon) cannot pass through it.
  const local = url ? ["127.0.0.1", "localhost"].includes(new URL(url).hostname) : false;

  it.skipIf(!local)(
    "fails a marked file whose connection drops after its session timeouts, and never sends the build on a new session",
    async () => {
      await onScratch(async (scratchUrl, scratch, files) => {
        await migrate(scratchUrl, pick(files, 1));
        // A writer holds the table, so a build on a session without
        // lock_timeout would wait for it with no limit.
        const writer = postgres(scratchUrl, { max: 1, onnotice: () => {} });
        const relay = await cutAfterSessionTimeouts(new URL(scratchUrl));
        try {
          let release: () => void = () => {};
          const held = new Promise<void>((resolve) => {
            release = resolve;
          });
          let ready: () => void = () => {};
          const writing = new Promise<void>((resolve) => {
            ready = resolve;
          });
          const tx = writer.begin(async (t) => {
            await t`INSERT INTO public.fixture_items (id, code) VALUES (3001, 'code-3001')`;
            ready();
            await held;
            throw new Error("roll back");
          });
          await writing;
          const timeouts = { lockTimeoutMs: 300, statementTimeoutMs: 60_000 };
          const outcome = await Promise.race([
            migrate(relay.url, pick(files, 1, 2), timeouts).then(
              () => "applied",
              (err: Error) => err.message,
            ),
            new Promise<string>((resolve) =>
              setTimeout(() => resolve("still running after 10 s"), 10_000),
            ),
          ]);
          release();
          await expect(tx).rejects.toThrow("roll back");
          expect(relay.cuts()).toBe(1);
          expect(outcome).toMatch(
            /^Migration 0002_fixture_items_code_key\.sql failed: .*CONNECTION_CLOSED/,
          );
        } finally {
          await relay.close();
          await writer.end({ timeout: 5 });
        }
        // The build never ran anywhere: no index, no record, no lock left.
        expect(await indexState(scratch, "fixture_items_code_key")).toBeNull();
        expect(await recorded(scratch)).toEqual(["0001_fixture_items.sql"]);
        const [locks] = await scratch<{ n: number }[]>`
          SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'`;
        expect(locks?.n).toBe(0);
        const rerun = await migrate(scratchUrl, pick(files, 1, 2));
        expect(rerun.applied).toEqual(["0002_fixture_items_code_key.sql"]);
      });
    },
    60_000,
  );
});
