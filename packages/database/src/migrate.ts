import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

/**
 * Forward-only SQL migration runner.
 *
 * - Files in `migrations/` named `NNNN_description.sql`, applied in name order.
 * - Each file runs inside one transaction and is recorded in `schema_migrations`
 *   with a SHA-256 checksum. A changed checksum on an applied file is an error;
 *   write a new migration instead.
 * - Uses the admin connection (`DATABASE_URL`). Runtime code uses the app role.
 */

const here = dirname(fileURLToPath(import.meta.url));
export const migrationsDir = join(here, "..", "migrations");
const lockKey = 7211001;

export interface MigrationFile {
  name: string;
  sql: string;
  checksum: string;
}

export async function loadMigrations(dir = migrationsDir): Promise<MigrationFile[]> {
  const entries = (await readdir(dir)).filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort();
  return Promise.all(
    entries.map(async (name) => {
      const sql = await readFile(join(dir, name), "utf8");
      return { name, sql, checksum: createHash("sha256").update(sql).digest("hex") };
    }),
  );
}

export interface MigrateResult {
  applied: string[];
  skipped: string[];
}

export async function migrate(
  connectionString: string,
  files?: MigrationFile[],
): Promise<MigrateResult> {
  const migrations = files ?? (await loadMigrations());
  const sql = postgres(connectionString, { max: 1, prepare: false });
  const applied: string[] = [];
  const skipped: string[] = [];
  try {
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    // Serialize concurrent runners (CI and a developer) on one advisory lock.
    await sql`SELECT pg_advisory_lock(${lockKey})`;
    try {
      const rows = await sql<{ name: string; checksum: string }[]>`
        SELECT name, checksum FROM schema_migrations`;
      const done = new Map(rows.map((r) => [r.name, r.checksum]));
      for (const m of migrations) {
        const existing = done.get(m.name);
        if (existing !== undefined) {
          if (existing !== m.checksum) {
            throw new Error(
              `Migration ${m.name} was already applied with a different checksum. Write a new migration instead of editing an applied one.`,
            );
          }
          skipped.push(m.name);
          continue;
        }
        try {
          await sql.begin(async (tx) => {
            await tx.unsafe(m.sql);
            await tx`INSERT INTO schema_migrations (name, checksum) VALUES (${m.name}, ${m.checksum})`;
          });
        } catch (err) {
          throw new Error(`Migration ${m.name} failed: ${(err as Error).message}`);
        }
        applied.push(m.name);
      }
    } finally {
      await sql`SELECT pg_advisory_unlock(${lockKey})`;
    }
  } finally {
    await sql.end();
  }
  return { applied, skipped };
}

export async function status(connectionString: string) {
  const migrations = await loadMigrations();
  const sql = postgres(connectionString, { max: 1, prepare: false });
  try {
    const rows = await sql<
      { name: string }[]
    >`SELECT name FROM schema_migrations ORDER BY name`.catch(() => [] as { name: string }[]);
    const done = new Set(rows.map((r) => r.name));
    return migrations.map((m) => ({ name: m.name, applied: done.has(m.name) }));
  } finally {
    await sql.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is required (admin connection string).");
    process.exit(2);
  }
  if (process.argv.includes("--status")) {
    for (const row of await status(url)) {
      console.log(`${row.applied ? "applied" : "pending"}  ${row.name}`);
    }
  } else {
    const result = await migrate(url);
    const names = result.applied.length ? `: ${result.applied.join(", ")}` : "";
    console.log(
      `applied ${result.applied.length} migration(s)${names}; ${result.skipped.length} already applied`,
    );
  }
}
