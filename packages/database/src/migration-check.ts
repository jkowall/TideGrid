/**
 * Migration safety check (W3-OPS-3; hosting plan, "Database migration and
 * rollback policy"). CI blocks a new migration that would rewrite or lock a
 * whole table, or quietly change or remove data, unless the file says why in
 * an allow comment:
 *
 *   -- migration-check: allow <rule> <reason>
 *
 * Applies to files numbered from `checkedFrom` on; earlier files are merged
 * and forward-only, so they are not re-judged. Function bodies and DO blocks
 * (dollar-quoted text) are skipped: they run later, row by row, under the
 * application's own limits. Comments and string literals are skipped too.
 *
 *   pnpm --filter @tidegrid/database migration:check [file ...]
 */
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The first file the check applies to. 0054 was the last merged file when the check merged (2026-11-15). */
export const checkedFrom = 55;

/** Tables expected to be large at pilot volume (shared rule 4 of the roadmap prompts). */
export const largeTables = [
  "email_messages",
  "payments",
  "payment_refunds",
  "bookings",
  "booking_participants",
  "waiver_requests",
  "waiver_evidence",
  "audit_events",
  "outbox_events",
  "outbox_deliveries",
];

export interface Finding {
  rule: string;
  message: string;
}

interface Rule {
  rule: string;
  test: (statement: string) => boolean;
  message: string;
  /** A table created earlier in the same file is empty, so locking it is harmless. */
  skipNewTables?: boolean;
}

/** The table a statement alters or indexes, without schema, lower case. */
export function targetTable(statement: string): string | null {
  const m =
    /\balter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?([\w."]+)/i.exec(statement) ??
    /\bcreate\s+(?:unique\s+)?index\b[\s\S]*?\bon\s+(?:only\s+)?([\w."]+)/i.exec(statement);
  return m ? bareName(m[1] as string) : null;
}

function bareName(name: string): string {
  return (name.split(".").at(-1) ?? name).replace(/"/g, "").toLowerCase();
}

function createdTables(statements: string[]): Set<string> {
  const names = new Set<string>();
  for (const s of statements) {
    const m = /^\s*create\s+(?:unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?([\w."]+)/i.exec(s);
    if (m) names.add(bareName(m[1] as string));
  }
  return names;
}

const large = `(?:\\w+\\.)?(?:${largeTables.join("|")})\\b`;

const rules: Rule[] = [
  {
    rule: "column_type_change",
    skipNewTables: true,
    test: (s) => /\balter\s+table\b[\s\S]*\balter\s+column\b[\s\S]*\btype\b/i.test(s),
    message:
      "changing a column's type rewrites the table under an exclusive lock; add a new column, backfill, then switch (expand and contract)",
  },
  {
    rule: "volatile_default",
    test: (s) =>
      /\badd\s+column\b[\s\S]*\bdefault\s+(?:now|clock_timestamp|random|gen_random_uuid|uuid_generate_v4)\s*\(/i.test(
        s,
      ),
    message:
      "a new column with a volatile default rewrites every row; add it without a default, then backfill in batches",
  },
  {
    rule: "set_not_null",
    skipNewTables: true,
    test: (s) => /\balter\s+column\b[\s\S]*\bset\s+not\s+null\b/i.test(s),
    message:
      "SET NOT NULL scans the whole table under an exclusive lock; add a CHECK (...) NOT VALID, validate it, then set NOT NULL",
  },
  {
    rule: "constraint_without_not_valid",
    skipNewTables: true,
    test: (s) =>
      /\badd\s+(?:constraint\s+\w+\s+)?(?:foreign\s+key|check)\b/i.test(s) &&
      /\balter\s+table\b/i.test(s) &&
      !/\bnot\s+valid\b/i.test(s),
    message:
      "adding a foreign key or check to an existing table scans it under lock; add it NOT VALID, then VALIDATE CONSTRAINT in a later file",
  },
  {
    rule: "index_not_concurrent",
    skipNewTables: true,
    test: (s) =>
      new RegExp(
        `\\bcreate\\s+(?:unique\\s+)?index\\b(?![\\s\\S]*\\bconcurrently\\b)[\\s\\S]*\\bon\\s+(?:only\\s+)?${large}`,
        "i",
      ).test(s),
    message:
      "an index on a pilot-volume table blocks writes while it builds; use CREATE INDEX CONCURRENTLY in a file of its own",
  },
  {
    rule: "drop_or_rename",
    test: (s) =>
      /\bdrop\s+(?:table|column)\b/i.test(s) ||
      /\balter\s+table\b[\s\S]*\bdrop\s+(?!constraint\b|default\b|not\s+null\b)\w+/i.test(s) ||
      /\brename\s+(?:column\s+)?\w+\s+to\b/i.test(s) ||
      /\brename\s+to\b/i.test(s),
    message:
      "dropping or renaming breaks code still running the old shape; this is a contract step, only after no released version uses it",
  },
  {
    rule: "data_change",
    test: (s) => /^\s*(?:update|delete\s+from|truncate)\b/i.test(s),
    message:
      "a data change in a migration runs in one transaction over the whole table; backfill in bounded batches outside the migration, or say why it is small",
  },
];

/** The SQL with comments, string literals, and dollar-quoted bodies blanked out. */
export function stripSql(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const rest = sql.slice(i);
    if (rest.startsWith("--")) {
      const end = sql.indexOf("\n", i);
      i = end < 0 ? sql.length : end;
      continue;
    }
    if (rest.startsWith("/*")) {
      const end = sql.indexOf("*/", i + 2);
      i = end < 0 ? sql.length : end + 2;
      out += " ";
      continue;
    }
    const dollar = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(rest);
    if (dollar) {
      const tag = dollar[0];
      const end = sql.indexOf(tag, i + tag.length);
      i = end < 0 ? sql.length : end + tag.length;
      out += " $body$ ";
      continue;
    }
    if (sql[i] === "'") {
      i++;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") i += 2;
        else if (sql[i] === "'") break;
        else i++;
      }
      i++;
      out += "''";
      continue;
    }
    out += sql[i];
    i++;
  }
  return out;
}

/** Rules a file allows, from `-- migration-check: allow <rule> <reason>`. A reason is required. */
export function allowedRules(sql: string): { allowed: Set<string>; bad: string[] } {
  const allowed = new Set<string>();
  const bad: string[] = [];
  for (const m of sql.matchAll(/--\s*migration-check:\s*allow\s+(\S+)(.*)$/gm)) {
    const rule = m[1] as string;
    if (!rules.some((r) => r.rule === rule)) bad.push(`unknown rule ${rule}`);
    else if ((m[2] ?? "").trim().length < 10) bad.push(`allow ${rule} needs a reason`);
    else allowed.add(rule);
  }
  return { allowed, bad };
}

export function checkMigration(sql: string): Finding[] {
  const { allowed, bad } = allowedRules(sql);
  const findings: Finding[] = bad.map((message) => ({ rule: "allow_comment", message }));
  const statements = stripSql(sql)
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  const fresh = createdTables(statements);
  for (const r of rules) {
    if (allowed.has(r.rule)) continue;
    const hit = statements.some((s) => {
      if (!r.test(s)) return false;
      const t = r.skipNewTables ? targetTable(s) : null;
      return !(t && fresh.has(t));
    });
    if (hit) findings.push({ rule: r.rule, message: r.message });
  }
  return findings;
}

export function fileNumber(name: string): number | null {
  const m = /^(\d{4})_[a-z0-9_]+\.sql$/.exec(name);
  return m ? Number(m[1]) : null;
}

export const migrationsDir = join(import.meta.dirname, "..", "migrations");

/** Every checked file in the tree with its findings. */
export function checkTree(dir = migrationsDir): { file: string; findings: Finding[] }[] {
  return readdirSync(dir)
    .filter((f) => (fileNumber(f) ?? -1) >= checkedFrom)
    .sort()
    .map((file) => ({ file, findings: checkMigration(readFileSync(join(dir, file), "utf8")) }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const named = process.argv.slice(2);
  const results = named.length
    ? named.map((p) => ({ file: basename(p), findings: checkMigration(readFileSync(p, "utf8")) }))
    : checkTree();
  let failed = 0;
  for (const { file, findings } of results) {
    for (const f of findings) {
      console.log(`${file}: ${f.rule}: ${f.message}`);
      failed++;
    }
  }
  console.log(`${results.length} file(s) checked, ${failed} finding(s)`);
  process.exitCode = failed ? 1 : 0;
}
