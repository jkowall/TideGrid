import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { loadMigrations, migrate } from "./migrate.ts";

/**
 * The Nov 1 upgrade path, rehearsed on a scratch database (the Nov 1 runbook,
 * P0.2; decision D12(a), a coordinator default pending owner confirmation).
 * Neon main holds migrations 0001 and 0002 and a seed from the deployed build
 * b87e269. CI otherwise migrates only empty databases, so nothing else proves
 * that the later files apply over rows, or that b87e269 still works against the
 * upgraded schema, which the runbook's code rollback relies on.
 *
 * In order: create a uniquely named database from the admin URL; apply 0001 and
 * 0002; load the 0002-era seed; run b87e269's query set as tidegrid_app; migrate
 * to the latest file; run the query set again; run today's seed twice and check
 * the second run changes nothing; run the query set a third time; drop the
 * database. It never resets or migrates the job's own database, and it drops
 * only the database it created.
 */

const env = inject("integrationDb");
const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "..", "test-fixtures");
const repoRoot = join(here, "..", "..", "..");
const run = promisify(execFile);

type Sql = ReturnType<typeof postgres>;

const harbor = "7d1e5b3a-1c2f-4a8e-9b61-0a1c2e3f4a01";
const reef = "7d1e5b3a-1c2f-4a8e-9b61-0a1c2e3f4a02";
const singleOwner = "solo.owner@nov1-upgrade.test";
const syntheticName = "Upgrade Desk Owner";

function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

/** The fixture's steps, split on its `-- step: ` marker lines. */
async function querySteps(): Promise<{ label: string; sql: string }[]> {
  const text = await readFile(join(fixtures, "b87e269-queries.sql"), "utf8");
  const steps: { label: string; sql: string }[] = [];
  for (const chunk of text.split(/^-- step: /m).slice(1)) {
    const newline = chunk.indexOf("\n");
    steps.push({ label: chunk.slice(0, newline).trim(), sql: chunk.slice(newline + 1) });
  }
  return steps;
}

/** Row counts of every table in public, so a rerun can be shown to change nothing. */
async function tableCounts(sql: Sql): Promise<Record<string, number>> {
  const tables = await sql<{ name: string }[]>`
    select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p') order by 1`;
  const counts: Record<string, number> = {};
  for (const { name } of tables) {
    // A catalog name, quoted as an identifier.
    const [row] = await sql.unsafe<{ n: number }[]>(
      `select count(*)::int as n from public."${name.replaceAll('"', '""')}"`,
    );
    counts[name] = row?.n ?? -1;
  }
  return counts;
}

describe.skipIf(!env)("upgrade from the b87e269 schema and seed to the latest migration", () => {
  const scratch = `upgrade_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  let admin: Sql;
  let scratchAdminUrl: string;
  let scratchRuntimeUrl: string;
  let steps: { label: string; sql: string }[];

  beforeAll(async () => {
    if (!env) return;
    admin = postgres(env.adminUrl, { max: 1, onnotice: () => {} });
    // The name is generated here, lowercase letters, digits, and underscore only.
    await admin.unsafe(`create database ${scratch}`);
    scratchAdminUrl = withDatabase(env.adminUrl, scratch);
    scratchRuntimeUrl = withDatabase(env.runtimeUrl, scratch);
    steps = await querySteps();
  });

  afterAll(async () => {
    if (!env) return;
    try {
      await admin.unsafe(`drop database if exists ${scratch} with (force)`);
    } finally {
      await admin.end({ timeout: 5 });
    }
  });

  /** Run b87e269's query set as tidegrid_app, one step at a time, naming a failing step. */
  async function runQuerySet(when: string): Promise<void> {
    const runtime = postgres(scratchRuntimeUrl, { max: 1, prepare: false, onnotice: () => {} });
    try {
      const [who] = await runtime<{ role: string }[]>`select current_user as role`;
      expect(who?.role).toBe("tidegrid_app");
      for (const step of steps) {
        try {
          await runtime.unsafe(step.sql);
        } catch (err) {
          throw new Error(`b87e269 step "${step.label}" failed ${when}: ${(err as Error).message}`);
        }
      }
    } finally {
      await runtime.end({ timeout: 5 });
    }
  }

  async function seed(): Promise<string> {
    const { stdout } = await run("pnpm", ["--filter", "@tidegrid/seed", "seed"], {
      cwd: repoRoot,
      // An explicit environment: no stray SEED_LOCAL_HOSTNAMES or SEED_DEMO_BOOKINGS.
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        DATABASE_URL: scratchAdminUrl,
        SEED_OWNER_EMAILS: "owner.one@nov1-upgrade.test,owner.two@nov1-upgrade.test",
        SEED_SINGLE_TENANT_OWNER: `${singleOwner}:demo-harbor`,
        SEED_OWNER_DISPLAY_NAME: syntheticName,
      },
      timeout: 240_000,
    });
    return stdout;
  }

  it("applies every later file over 0002-era rows, keeps b87e269 working, and reseeds idempotently", async () => {
    const files = await loadMigrations();
    expect(files.length).toBeGreaterThan(2);
    const first = await migrate(scratchAdminUrl, files.slice(0, 2));
    expect(first.applied).toEqual(["0001_foundation.sql", "0002_tenancy_access_audit.sql"]);

    const sql = postgres(scratchAdminUrl, { max: 1, onnotice: () => {} });
    try {
      await sql.unsafe(await readFile(join(fixtures, "seed-0002-era.sql"), "utf8"));
      const [era] = await sql<{ tenants: number; hosts: number; members: number }[]>`
        select (select count(*)::int from public.tenants) as tenants,
               (select count(*)::int from public.tenant_hostnames) as hosts,
               (select count(*)::int from public.tenant_memberships) as members`;
      expect(era).toEqual({ tenants: 2, hosts: 2, members: 8 });

      // The fixture must be faithful to b87e269 first: it runs on the 0002 schema.
      await runQuerySet("on the 0002 schema");

      const upgraded = await migrate(scratchAdminUrl);
      expect(upgraded.applied).toEqual(files.slice(2).map((f) => f.name));
      // P2.3 to P3.2: b87e269 serves against the upgraded schema before the API release.
      await runQuerySet("after migrating to the latest file");

      const firstSeed = await seed();
      expect(firstSeed).toContain("seeded 2 demo operators");
      const before = await tableCounts(sql);
      const secondSeed = await seed();
      expect(secondSeed).toContain("seeded fake payment accounts: 0 new");
      expect(secondSeed).toContain("0 new templates, 0 new versions");
      expect(await tableCounts(sql)).toEqual(before);

      const [applied] = await sql<{ n: number; latest: string }[]>`
        select count(*)::int as n, max(name) as latest from schema_migrations`;
      expect(applied).toEqual({ n: files.length, latest: files.at(-1)?.name });

      // The single-tenant owner (D4) owns exactly one operator, under the synthetic name.
      const solo = await sql<{ tenant_id: string; role: string; display_name: string }[]>`
        select m.tenant_id, m.role, m.display_name from public.tenant_memberships m
          join public.staff_users u on u.id = m.user_id where u.email = ${singleOwner}`;
      expect(solo).toEqual([{ tenant_id: harbor, role: "owner", display_name: syntheticName }]);
      // Existing owner rows keep their 0002-era names; the seed never overwrites.
      const [kept] = await sql<{ display_name: string }[]>`
        select m.display_name from public.tenant_memberships m
          join public.staff_users u on u.id = m.user_id
         where u.email = 'owner.one@nov1-upgrade.test' and m.tenant_id = ${reef}`;
      expect(kept?.display_name).toBe("owner.one");
      // The preview hostnames stay active and verified through 0011's new constraints.
      const hosts = await sql<{ hostname: string; status: string; verified: boolean }[]>`
        select hostname, status, verified_at is not null as verified
          from public.tenant_hostnames order by hostname`;
      expect(hosts).toEqual([
        { hostname: "demo-harbor.book.tidegrid.us", status: "active", verified: true },
        { hostname: "demo-reef.book.tidegrid.us", status: "active", verified: true },
      ]);

      // A code rollback to b87e269 after the seed (P3 rollback) still works.
      await runQuerySet("after today's seed");
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 600_000);
});
