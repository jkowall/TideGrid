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
 * - A file whose first line is exactly `-- tidegrid:no-transaction` runs
 *   outside a transaction, for `CREATE INDEX CONCURRENTLY` (the D6 A standing
 *   rule). It holds exactly one `CREATE [UNIQUE] INDEX CONCURRENTLY` statement,
 *   runs under session-level `SET lock_timeout` and `statement_timeout` (reset
 *   afterward), and is recorded only after the statement succeeds. Every run
 *   first refuses, naming the repair command, while any invalid index exists;
 *   it never drops one.
 * - Runners take the advisory lock by polling, never by waiting inside a
 *   statement: a waiting statement holds a snapshot, and a concurrent index
 *   build waits for every older snapshot, so a blocked runner would deadlock
 *   with the build that holds the lock.
 */

const here = dirname(fileURLToPath(import.meta.url));
export const migrationsDir = join(here, "..", "migrations");
const lockKey = 7211001;
/** Milliseconds between tries of the runners' advisory lock. */
const lockPollMs = 250;

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

/** Session-level timeouts for a file that runs outside a transaction. Integers only. */
export function sessionTimeoutStatements(t: MigrationTimeouts): string[] {
  return [
    `SET lock_timeout = ${Math.trunc(t.lockTimeoutMs)}`,
    `SET statement_timeout = ${Math.trunc(t.statementTimeoutMs)}`,
  ];
}

/** The statements that end a non-transactional file's session timeouts. */
export const sessionTimeoutResets = ["RESET lock_timeout", "RESET statement_timeout"];

/** The first line that marks a file to run outside a transaction (D1). */
export const noTransactionMarker = "-- tidegrid:no-transaction";

export type MigrationPlan = { mode: "transaction" } | { mode: "no-transaction"; statement: string };

const looseMarker = /^[ \t]*--[ \t]*tidegrid:[ \t]*no-transaction\b/im;
const concurrentIndex = /^create\s+(unique\s+)?index\s+concurrently\s/i;

/**
 * How a file runs. An unmarked file runs in one transaction, as before. A file
 * whose first line is exactly the marker runs outside a transaction and must
 * hold one `CREATE [UNIQUE] INDEX CONCURRENTLY` statement (D2). The marker
 * anywhere else, or misspelled on the first line, is refused, so a file meant
 * to run outside a transaction never runs inside one by accident.
 */
export function planMigration(m: Pick<MigrationFile, "name" | "sql">): MigrationPlan {
  const newline = m.sql.indexOf("\n");
  const firstLine = (newline === -1 ? m.sql : m.sql.slice(0, newline)).replace(/\r$/, "");
  const marked = firstLine === noTransactionMarker;
  const rest = marked ? (newline === -1 ? "" : m.sql.slice(newline + 1)) : m.sql;
  if (looseMarker.test(rest)) {
    throw new Error(
      `Migration ${m.name}: the no-transaction marker must be the file's first line, exactly "${noTransactionMarker}"`,
    );
  }
  if (!marked) return { mode: "transaction" };
  const statement = singleStatement(m.name, rest);
  if (!concurrentIndex.test(statement)) {
    throw new Error(
      `Migration ${m.name}: a no-transaction file must hold one CREATE [UNIQUE] INDEX CONCURRENTLY statement`,
    );
  }
  return { mode: "no-transaction", statement };
}

const identifierChar = /[A-Za-z0-9_$]/;

/**
 * The one statement in a marked file, with its comments blanked and without
 * its closing semicolon. Conservative on purpose: it refuses dollar quotes,
 * parameters, escape strings, and anything unterminated, which an index
 * statement never needs, rather than parse them.
 */
function singleStatement(name: string, text: string): string {
  const out = text.split("");
  const semicolons: number[] = [];
  const refuse = (why: string): never => {
    throw new Error(`Migration ${name}: a no-transaction file ${why}`);
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (c === "-" && next === "-") {
      while (i < text.length && text[i] !== "\n") out[i++] = " ";
    } else if (c === "/" && next === "*") {
      let depth = 0;
      while (i < text.length) {
        if (text[i] === "/" && text[i + 1] === "*") {
          depth++;
          out[i++] = " ";
          out[i++] = " ";
        } else if (text[i] === "*" && text[i + 1] === "/") {
          depth--;
          out[i++] = " ";
          out[i++] = " ";
          if (depth === 0) break;
        } else {
          if (text[i] !== "\n") out[i] = " ";
          i++;
        }
      }
      if (depth !== 0) refuse("has an unterminated comment");
    } else if (c === "'" || c === '"') {
      if (c === "'" && /[eE]/.test(text[i - 1] ?? "") && !identifierChar.test(text[i - 2] ?? "")) {
        refuse("may not use escape strings");
      }
      i++;
      for (;;) {
        if (i >= text.length) refuse("has an unterminated quote");
        if (text[i] === c) {
          if (text[i + 1] === c) {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
    } else if (c === "$") {
      refuse("may not use dollar quotes or parameters");
    } else {
      if (c === ";") semicolons.push(i);
      i++;
    }
  }
  const code = out.join("");
  const end = semicolons[0] ?? code.length;
  if (semicolons.length > 1 || code.slice(end + 1).trim() !== "") {
    refuse("must hold exactly one statement");
  }
  const statement = code.slice(0, end).trim();
  if (statement === "") refuse("must hold exactly one statement");
  return statement;
}

export interface InvalidIndex {
  /** The index, schema-qualified and quoted as an identifier where needed. */
  index: string;
  /** Its table, the same way. */
  table: string;
}

/**
 * Every invalid index outside the system catalogs and temporary schemas. A
 * failed or canceled concurrent build leaves one behind. Partitioned indexes
 * are left out: they cannot be built concurrently, and one created ON ONLY a
 * parent is invalid by design until its partitions attach.
 */
export async function invalidIndexes(sql: postgres.Sql): Promise<InvalidIndex[]> {
  return sql<InvalidIndex[]>`
    SELECT format('%I.%I', n.nspname, c.relname) AS index,
           format('%I.%I', tn.nspname, t.relname) AS table
      FROM pg_index x
      JOIN pg_class c ON c.oid = x.indexrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_class t ON t.oid = x.indrelid
      JOIN pg_namespace tn ON tn.oid = t.relnamespace
     WHERE NOT x.indisvalid
       AND c.relkind = 'i'
       AND n.nspname NOT IN ('pg_catalog', 'information_schema')
       AND n.nspname !~ '^pg_(toast_)?temp_[0-9]+$'
     ORDER BY 1`;
}

/**
 * The refusal for invalid indexes, with the repair command for each (D3).
 * `after: "failure"` words it for the run whose build just failed.
 */
export function invalidIndexMessage(
  found: InvalidIndex[],
  after: "refusal" | "failure" = "refusal",
): string {
  const list = found.map((f) => `${f.index} on ${f.table}`).join(", ");
  const drops = found.map((f) => `  DROP INDEX CONCURRENTLY IF EXISTS ${f.index};`).join("\n");
  const head =
    after === "refusal"
      ? [
          `Migrations refused: ${found.length} invalid index(es), left by a failed or canceled concurrent build, or one still building: ${list}.`,
          "Nothing was dropped and nothing was applied.",
        ]
      : [
          `The failed build left ${found.length} invalid index(es): ${list}.`,
          "Nothing was dropped. Every run refuses until each one is.",
        ];
  return [
    ...head,
    "Repair as the admin role, each statement on its own and outside a transaction:",
    drops,
    "Then fix what failed the build and run the migrations again. The failed file was not recorded, so it runs again.",
  ].join("\n");
}

/** Take the runners' advisory lock by polling, so no waiting statement holds a snapshot. */
async function acquireRunnerLock(sql: postgres.Sql): Promise<void> {
  for (;;) {
    const [row] = await sql<{ ok: boolean }[]>`SELECT pg_try_advisory_lock(${lockKey}) AS ok`;
    if (row?.ok) return;
    await new Promise((resolve) => setTimeout(resolve, lockPollMs));
  }
}

/**
 * Run a marked file's one statement outside a transaction, under session-level
 * timeouts, and record it only after the statement succeeded.
 */
async function applyWithoutTransaction(
  sql: postgres.Sql,
  m: MigrationFile,
  statement: string,
  timeouts: MigrationTimeouts,
): Promise<void> {
  try {
    for (const set of sessionTimeoutStatements(timeouts)) await sql.unsafe(set);
    await sql.unsafe(statement);
    await sql`INSERT INTO schema_migrations (name, checksum) VALUES (${m.name}, ${m.checksum})`;
  } catch (err) {
    // Name the repair now when the failure left an invalid index behind. The
    // lookup and the reset are best effort: the connection may be what failed.
    const message = (err as Error).message;
    const left = await invalidIndexes(sql).catch(() => []);
    await resetSessionTimeouts(sql).catch(() => {});
    throw new Error(
      left.length > 0 ? `${message}\n${invalidIndexMessage(left, "failure")}` : message,
    );
  }
  await resetSessionTimeouts(sql);
}

async function resetSessionTimeouts(sql: postgres.Sql): Promise<void> {
  for (const reset of sessionTimeoutResets) await sql.unsafe(reset);
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
  // Every file is planned before the connection opens, so a malformed marked
  // file fails the run before anything is applied.
  const plans = new Map(migrations.map((m) => [m.name, planMigration(m)]));
  const opening = timeoutStatements(timeouts);
  const sql = postgres(connectionString, { max: 1, prepare: false, onnotice: () => {} });
  const applied: string[] = [];
  const skipped: string[] = [];
  try {
    // Serialize concurrent runners (CI and a developer) on one advisory lock,
    // taken before the table exists because CREATE TABLE IF NOT EXISTS races.
    await acquireRunnerLock(sql);
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
      // A failed concurrent build leaves an invalid index. Refuse every run
      // until it is repaired, and never drop it here (D3).
      const invalid = await invalidIndexes(sql);
      if (invalid.length > 0) throw new Error(invalidIndexMessage(invalid));
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
        const plan = plans.get(m.name);
        try {
          if (plan?.mode === "no-transaction") {
            await applyWithoutTransaction(sql, m, plan.statement, timeouts);
          } else {
            await sql.begin(async (tx) => {
              await tx.unsafe(opening);
              await tx.unsafe(m.sql);
              await tx`INSERT INTO schema_migrations (name, checksum) VALUES (${m.name}, ${m.checksum})`;
            });
          }
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
