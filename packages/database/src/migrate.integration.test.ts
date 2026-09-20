import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { loadMigrations, migrate, status } from "./migrate.ts";

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
      const [role] = await sql<
        { rolbypassrls: boolean; rolcreaterole: boolean; groups: string[] }[]
      >`
        SELECT r.rolbypassrls, r.rolcreaterole,
               array(SELECT b.rolname FROM pg_auth_members m JOIN pg_roles b ON b.oid = m.roleid
                     WHERE m.member = r.oid) AS groups
        FROM pg_roles r WHERE r.rolname = 'tidegrid_app'`;
      expect(role).toBeDefined();
      expect(role?.rolbypassrls).toBe(false);
      expect(role?.rolcreaterole).toBe(false);
      expect(role?.groups ?? []).not.toContain("neon_superuser");
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
});
