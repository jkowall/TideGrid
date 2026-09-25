import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { loadMigrations, migrate, status } from "./migrate.ts";
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
      await sql.end();
    }
  }, 60_000);

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
      await admin.end();
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
      await admin.end();
    }
  }, 60_000);
});
