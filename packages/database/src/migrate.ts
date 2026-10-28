import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { assertRuntimeRoleIsPlain } from "./role.ts";

/**
 * Forward-only SQL migration runner.
 *
 * - Files in `migrations/` named `NNNN_description.sql`, applied in name order.
 * - Each file runs inside one transaction and is recorded in `schema_migrations`
 *   with a SHA-256 checksum. A changed checksum on an applied file is an error;
 *   write a new migration instead.
 * - Uses the admin connection (`DATABASE_URL`). Runtime code uses the app role.
 * - Each file runs under `SET LOCAL lock_timeout` and `statement_timeout`
 *   (the hosting plan's migration rule), so a file that waits on a lock held
 *   by a serving Worker fails and rolls back instead of blocking it. Defaults
 *   are 5 s and 120 s; TIDEGRID_MIGRATE_LOCK_TIMEOUT_MS and
 *   TIDEGRID_MIGRATE_STATEMENT_TIMEOUT_MS override them.
 * - Every connection close is bounded, so a compute that restarts mid-run
 *   cannot hang the command (postgres.js `end()` waits forever otherwise).
 */

const here = dirname(fileURLToPath(import.meta.url));
export const migrationsDir = join(here, "..", "migrations");
const lockKey = 7211001;

export interface MigrationFile {
  name: string;
  sql: string;
  checksum: string;
}

const namePattern = /^(\d{4})_[a-z0-9_]+\.sql$/;

export async function loadMigrations(dir = migrationsDir): Promise<MigrationFile[]> {
  const all = (await readdir(dir)).filter((f) => !f.startsWith(".")).sort();
  const bad = all.filter((f) => !namePattern.test(f));
  if (bad.length > 0) {
    throw new Error(
      `Migration files must be named NNNN_lower_snake_case.sql; rejected: ${bad.join(", ")}`,
    );
  }
  const entries = all;
  entries.forEach((name, i) => {
    const n = Number(name.slice(0, 4));
    if (n !== i + 1) {
      throw new Error(
        `Migration numbering must be contiguous from 0001; ${name} is out of sequence`,
      );
    }
  });
  return Promise.all(
    entries.map(async (name) => {
      const sql = await readFile(join(dir, name), "utf8");
      return { name, sql, checksum: createHash("sha256").update(sql).digest("hex") };
    }),
  );
}

export interface MigrationTimeouts {
  lockTimeoutMs: number;
  statementTimeoutMs: number;
}

export const defaultMigrationTimeouts: MigrationTimeouts = {
  lockTimeoutMs: 5_000,
  statementTimeoutMs: 120_000,
};

/** Seconds postgres.js waits for queries to finish before it closes the socket. */
export const endTimeoutSeconds = 5;

function timeoutFrom(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d{1,7}$/.test(raw) || Number(raw) < 100) {
    throw new Error(`${name} must be a whole number of milliseconds from 100 to 9999999`);
  }
  return Number(raw);
}

/** The per-file timeouts, from the environment or the defaults. */
export function migrationTimeouts(env: NodeJS.ProcessEnv = process.env): MigrationTimeouts {
  return {
    lockTimeoutMs: timeoutFrom(
      env,
      "TIDEGRID_MIGRATE_LOCK_TIMEOUT_MS",
      defaultMigrationTimeouts.lockTimeoutMs,
    ),
    statementTimeoutMs: timeoutFrom(
      env,
      "TIDEGRID_MIGRATE_STATEMENT_TIMEOUT_MS",
      defaultMigrationTimeouts.statementTimeoutMs,
    ),
  };
}

/** The statements that open each migration's transaction. Integers only, so no quoting. */
export function timeoutStatements(t: MigrationTimeouts): string {
  return `SET LOCAL lock_timeout = ${Math.trunc(t.lockTimeoutMs)}; SET LOCAL statement_timeout = ${Math.trunc(t.statementTimeoutMs)}`;
}

export interface MigrateResult {
  applied: string[];
  skipped: string[];
}

export async function migrate(
  connectionString: string,
  files?: MigrationFile[],
  timeouts: MigrationTimeouts = migrationTimeouts(),
): Promise<MigrateResult> {
  const migrations = files ?? (await loadMigrations());
  const opening = timeoutStatements(timeouts);
  const sql = postgres(connectionString, { max: 1, prepare: false, onnotice: () => {} });
  const applied: string[] = [];
  const skipped: string[] = [];
  try {
    // Serialize concurrent runners (CI and a developer) on one advisory lock,
    // taken before the table exists because CREATE TABLE IF NOT EXISTS races.
    await sql`SELECT pg_advisory_lock(${lockKey})`;
    try {
      await sql.unsafe(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          name text PRIMARY KEY,
          checksum text NOT NULL,
          applied_at timestamptz NOT NULL DEFAULT now()
        )`);
      const rows = await sql<{ name: string; checksum: string }[]>`
        SELECT name, checksum FROM schema_migrations`;
      const done = new Map(rows.map((r) => [r.name, r.checksum]));
      // Migrations grant privileges to tidegrid_app. A role that already exists
      // must be the plain one 0001 would create before anything is granted to
      // it; checking again afterward makes drift fail every run, including runs
      // with nothing pending.
      await assertRuntimeRoleIsPlain(sql, { mustExist: false });
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
            await tx.unsafe(opening);
            await tx.unsafe(m.sql);
            await tx`INSERT INTO schema_migrations (name, checksum) VALUES (${m.name}, ${m.checksum})`;
          });
        } catch (err) {
          throw new Error(`Migration ${m.name} failed: ${(err as Error).message}`);
        }
        applied.push(m.name);
      }
      await assertRuntimeRoleIsPlain(sql, { mustExist: false });
    } finally {
      await sql`SELECT pg_advisory_unlock(${lockKey})`;
    }
  } finally {
    await sql.end({ timeout: endTimeoutSeconds });
  }
  return { applied, skipped };
}

export async function status(connectionString: string) {
  const migrations = await loadMigrations();
  const sql = postgres(connectionString, { max: 1, prepare: false, onnotice: () => {} });
  try {
    const rows = await sql<
      { name: string }[]
    >`SELECT name FROM schema_migrations ORDER BY name`.catch((err: { code?: string }) => {
      // 42P01 undefined_table means no migration has run yet; anything else is real.
      if (err.code === "42P01") return [] as { name: string }[];
      throw err;
    });
    const done = new Set(rows.map((r) => r.name));
    return migrations.map((m) => ({ name: m.name, applied: done.has(m.name) }));
  } finally {
    await sql.end({ timeout: endTimeoutSeconds });
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
    const timeouts = migrationTimeouts();
    const result = await migrate(url, undefined, timeouts);
    const names = result.applied.length ? `: ${result.applied.join(", ")}` : "";
    console.log(
      `applied ${result.applied.length} migration(s)${names}; ${result.skipped.length} already applied` +
        ` (per file: lock_timeout ${timeouts.lockTimeoutMs} ms, statement_timeout ${timeouts.statementTimeoutMs} ms)`,
    );
  }
}
