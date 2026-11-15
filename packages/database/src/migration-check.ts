/**
 * Migration safety check (W3-OPS-3; hosting plan, "Database migration and
 * rollback policy"). CI blocks a new migration that would rewrite or lock a
 * whole table, or quietly change or remove data, unless the file says why in
 * an allow comment:
 *
 *   -- migration-check: allow <rule> <reason>
 *
 * Applies to files numbered from `checkedFrom` on; earlier files are merged
 * and forward-only, so they are not re-judged. Function bodies (dollar-quoted
 * text) are skipped: they run later, row by row, under the application's own
 * limits. DO blocks run during the migration, so their bodies are checked.
 * Comments and string literals are skipped. A table is exempt from the
 * locking rules only when the same file created it earlier with a plain
 * CREATE TABLE (not IF NOT EXISTS), matched by schema and name.
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

/** Strip quotes and lower-case a (possibly schema-qualified) name; unqualified means public. */
export function qualifiedName(name: string): string {
  // Unquoted names fold to lower case; quoted ones keep their case, as in PostgreSQL.
  const parts = (name.match(/"[^"]+"|[^."]+/g) ?? []).map((p) =>
    p.startsWith('"') ? p.slice(1, -1) : p.toLowerCase(),
  );
  return parts.length > 1 ? parts.slice(-2).join(".") : `public.${parts[0]}`;
}

/** The table a statement alters or indexes, schema-qualified, quotes removed, lower case. */
export function targetTable(statement: string): string | null {
  const m =
    /\balter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?((?:"[^"]+"|[\w$]+)(?:\.(?:"[^"]+"|[\w$]+))?)/i.exec(
      statement,
    ) ??
    /\bcreate\s+(?:unique\s+)?index\b[\s\S]*?\bon\s+(?:only\s+)?((?:"[^"]+"|[\w$]+)(?:\.(?:"[^"]+"|[\w$]+))?)/i.exec(
      statement,
    );
  return m ? qualifiedName(m[1] as string) : null;
}

/**
 * Tables this statement creates. CREATE TABLE IF NOT EXISTS is not counted:
 * the table may already exist and hold rows.
 */
function createdTable(statement: string): string | null {
  const m =
    /^\s*create\s+(?:unlogged\s+)?table\s+(?!if\s+not\s+exists\b)((?:"[^"]+"|[\w$]+)(?:\.(?:"[^"]+"|[\w$]+))?)/i.exec(
      statement,
    );
  return m ? qualifiedName(m[1] as string) : null;
}

const largeSet = new Set(largeTables.map((t) => `public.${t}`));

/** Split on commas outside parentheses: the subcommands of one ALTER TABLE. */
function topLevelParts(statement: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of statement) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  parts.push(cur);
  return parts;
}

const alterCol = String.raw`\balter\s+(?:column\s+)?(?!constraint\b)[\w"]+\s+`;

const rules: Rule[] = [
  {
    rule: "column_type_change",
    skipNewTables: true,
    test: (s) =>
      /\balter\s+table\b/i.test(s) &&
      new RegExp(`${alterCol}(?:set\\s+data\\s+)?type\\b`, "i").test(s),
    message:
      "changing a column's type rewrites the table under an exclusive lock; add a new column, backfill, then switch (expand and contract)",
  },
  {
    rule: "volatile_default",
    test: (s) =>
      /\balter\s+table\b/i.test(s) &&
      topLevelParts(s).some(
        (p) =>
          /\badd\b/i.test(p) &&
          !/\badd\s+constraint\b/i.test(p) &&
          /\bdefault\s*[(\s]*(?:pg_catalog\.|public\.)?(?:now|clock_timestamp|random|gen_random_uuid|uuid_generate_v4|timeofday|statement_timestamp)\s*\(/i.test(
            p,
          ),
      ),
    message:
      "a new column with a volatile default rewrites every row; add it without a default, then backfill in batches",
  },
  {
    rule: "set_not_null",
    skipNewTables: true,
    test: (s) =>
      /\balter\s+table\b/i.test(s) && new RegExp(`${alterCol}set\\s+not\\s+null\\b`, "i").test(s),
    message:
      "SET NOT NULL scans the whole table under an exclusive lock; add a CHECK (...) NOT VALID, validate it, then set NOT NULL",
  },
  {
    rule: "constraint_without_not_valid",
    skipNewTables: true,
    test: (s) =>
      /\balter\s+table\b/i.test(s) &&
      topLevelParts(s).some((p) => {
        // ADD CONSTRAINT ... CHECK / FOREIGN KEY, or an unnamed one, each judged on its own.
        if (/\badd\s+(?:constraint\s+[\w"]+\s+)?(?:foreign\s+key|check)\b/i.test(p))
          return !/\bnot\s+valid\b/i.test(p);
        // A new column with an inline CHECK or REFERENCES checks every existing row.
        if (/\badd\b/i.test(p) && !/\badd\s+constraint\b/i.test(p))
          return /\b(?:check\s*\(|references\b)/i.test(p);
        return false;
      }),
    message:
      "adding a foreign key or check to an existing table scans it under lock; add it as its own constraint NOT VALID, then VALIDATE CONSTRAINT in a later file",
  },
  {
    rule: "index_not_concurrent",
    skipNewTables: true,
    test: (s) => {
      const t = targetTable(s);
      if (t === null || !largeSet.has(t)) return false;
      if (/^\s*create\s+(?:unique\s+)?index\b/i.test(s)) return !/\bconcurrently\b/i.test(s);
      // A UNIQUE or PRIMARY KEY constraint builds its index under the table lock,
      // unless it adopts one built concurrently first (USING INDEX).
      return (
        /\balter\s+table\b/i.test(s) &&
        topLevelParts(s).some(
          (p) =>
            (/\badd\s+(?:constraint\s+[\w"]+\s+)?(?:unique|primary\s+key|exclude)\b/i.test(p) &&
              !/\busing\s+index\s+[\w"]/i.test(p)) ||
            // A new column declared UNIQUE or PRIMARY KEY builds the same index.
            (/\badd\b/i.test(p) &&
              !/\badd\s+constraint\b/i.test(p) &&
              /\b(?:unique|primary\s+key)\b/i.test(p)),
        )
      );
    },
    message:
      "an index on a pilot-volume table blocks writes while it builds; use CREATE INDEX CONCURRENTLY in a file of its own (then ADD CONSTRAINT ... USING INDEX for a unique or primary key)",
  },
  {
    rule: "drop_or_rename",
    test: (s) =>
      /\bdrop\s+(?:table|column)\b/i.test(s) ||
      (/\balter\s+table\b/i.test(s) &&
        topLevelParts(s).some((p) =>
          /\bdrop\s+(?!constraint\b|default\b|not\s+null\b|identity\b|expression\b)[\w"]+/i.test(p),
        )) ||
      /\brename\s+(?:column\s+)?[\w"]+\s+to\b/i.test(s) ||
      /\brename\s+to\b/i.test(s),
    message:
      "dropping or renaming breaks code still running the old shape; this is a contract step, only after no released version uses it",
  },
  {
    rule: "data_change",
    test: (s) =>
      /^\s*(?:update|delete\s+from|truncate)\b/i.test(s) ||
      (/^\s*with\b/i.test(s) && /\b(?:update|delete\s+from|truncate)\b/i.test(s)),
    message:
      "a data change in a migration runs in one transaction over the whole table; backfill in bounded batches outside the migration, or say why it is small",
  },
];

/**
 * The SQL with comments and string literals blanked out. Dollar-quoted bodies
 * of functions are blanked (they run later, row by row); the body of a DO
 * block runs now, so it is kept, stripped the same way, with its PL/pgSQL
 * block words turned into statement breaks so each statement is judged.
 */
export function stripSql(sql: string, keepLineComments = false): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const rest = sql.slice(i);
    if (rest.startsWith("--")) {
      const end = sql.indexOf("\n", i);
      const stop = end < 0 ? sql.length : end;
      if (keepLineComments) out += sql.slice(i, stop);
      i = stop;
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
      const body = sql.slice(i + tag.length, end < 0 ? sql.length : end);
      i = end < 0 ? sql.length : end + tag.length;
      if (/\bdo(?:\s+language\s+[\w"]+)?\s*$/i.test(out)) {
        // A CREATE TABLE inside a DO block may be guarded (IF, EXCEPTION), so it
        // never proves a table new: rename it so the new-table exemption skips it.
        const inner = stripSql(body)
          .replace(/\bcreate(\s+unlogged)?\s+table\b/gi, "create$1 guarded_table")
          .replace(/\b(?:declare|begin|end\s+if|end\s+loop|end|then|else|elsif|loop)\b/gi, ";");
        out += ` $body$ ;${inner}; `;
      } else out += " $body$ ";
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
  // Only real line comments count, not text inside a string or a function body.
  const commentsOnly = stripSql(sql, true);
  for (const m of commentsOnly.matchAll(/--\s*migration-check:\s*allow\s+(\S+)(.*)$/gm)) {
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
  const hits = new Set<string>();
  // Only tables created earlier in this file, by exact schema-qualified name, are exempt.
  const fresh = new Set<string>();
  for (const s of statements) {
    for (const r of rules) {
      if (allowed.has(r.rule) || hits.has(r.rule) || !r.test(s)) continue;
      const t = r.skipNewTables ? targetTable(s) : null;
      if (t && fresh.has(t)) continue;
      hits.add(r.rule);
    }
    const created = createdTable(s);
    if (created) fresh.add(created);
  }
  for (const r of rules) {
    if (hits.has(r.rule)) findings.push({ rule: r.rule, message: r.message });
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
