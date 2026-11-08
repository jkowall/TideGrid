import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  defaultMigrationTimeouts,
  invalidIndexMessage,
  loadMigrations,
  migrationTimeouts,
  noTransactionMarker,
  planMigration,
  sessionTimeoutResets,
  sessionTimeoutStatements,
  timeoutStatements,
} from "./migrate.ts";

describe("migration files", () => {
  it("are named NNNN_description.sql, ordered, and unique", async () => {
    const files = await loadMigrations();
    expect(files.length).toBeGreaterThan(0);
    const numbers = files.map((f) => Number(f.name.slice(0, 4)));
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
    expect(new Set(numbers).size).toBe(numbers.length);
    expect(numbers[0]).toBe(1);
  });

  it("have stable checksums", async () => {
    const [a, b] = await Promise.all([loadMigrations(), loadMigrations()]);
    expect(a.map((f) => f.checksum)).toEqual(b.map((f) => f.checksum));
  });
});

describe("migration loader strictness", () => {
  async function dirWith(names: string[]) {
    const dir = await mkdtemp(join(tmpdir(), "tg-mig-"));
    for (const n of names) await writeFile(join(dir, n), "SELECT 1;");
    return dir;
  }

  it("rejects a file that does not match the naming rule", async () => {
    const dir = await dirWith(["0001_ok.sql", "0002_AddTenants.sql"]);
    await expect(loadMigrations(dir)).rejects.toThrow(/rejected: 0002_AddTenants.sql/);
  });

  it("rejects a gap in numbering", async () => {
    const dir = await dirWith(["0001_ok.sql", "0003_gap.sql"]);
    await expect(loadMigrations(dir)).rejects.toThrow(/contiguous/);
  });

  it("accepts a contiguous, well-named set", async () => {
    const dir = await dirWith(["0001_ok.sql", "0002_also_ok.sql"]);
    const files = await loadMigrations(dir);
    expect(files.map((f) => f.name)).toEqual(["0001_ok.sql", "0002_also_ok.sql"]);
  });
});

describe("per-file timeouts (08: lock and statement timeouts for migrations)", () => {
  it("default to 5 s for locks and 120 s per statement", () => {
    expect(migrationTimeouts({})).toEqual({ lockTimeoutMs: 5_000, statementTimeoutMs: 120_000 });
    expect(defaultMigrationTimeouts).toEqual(migrationTimeouts({}));
  });

  it("take overrides from the environment", () => {
    expect(
      migrationTimeouts({
        TIDEGRID_MIGRATE_LOCK_TIMEOUT_MS: "2500",
        TIDEGRID_MIGRATE_STATEMENT_TIMEOUT_MS: "600000",
      }),
    ).toEqual({ lockTimeoutMs: 2_500, statementTimeoutMs: 600_000 });
  });

  it("refuse anything but a whole number of milliseconds", () => {
    for (const bad of ["5s", "-1", "0", "99", "1.5", "1e4", " 5000", "99999999"]) {
      expect(() => migrationTimeouts({ TIDEGRID_MIGRATE_LOCK_TIMEOUT_MS: bad })).toThrow(
        /TIDEGRID_MIGRATE_LOCK_TIMEOUT_MS/,
      );
    }
  });

  it("open each file's transaction with SET LOCAL, so they end with it", () => {
    expect(timeoutStatements({ lockTimeoutMs: 5_000, statementTimeoutMs: 120_000 })).toBe(
      "SET LOCAL lock_timeout = 5000; SET LOCAL statement_timeout = 120000",
    );
  });
});

describe("no-transaction files (D6 A: CREATE INDEX CONCURRENTLY)", () => {
  const plan = (sql: string) => planMigration({ name: "0099_fixture.sql", sql });
  const marked = (body: string) => `${noTransactionMarker}\n${body}`;

  it("leave every file in the tree transactional, except the named index files", async () => {
    // The first marked file (W1-EMAIL-EVENTS): its one concurrent unique index.
    const indexFiles = new Set(["0022_email_events_index.sql", "0025_refunds_pending_index.sql"]);
    for (const file of await loadMigrations()) {
      const mode = planMigration(file).mode;
      expect({ file: file.name, mode }).toEqual({
        file: file.name,
        mode: indexFiles.has(file.name) ? "no-transaction" : "transaction",
      });
    }
  });

  it("plan an unmarked file as one transaction, whatever it holds", () => {
    expect(plan("CREATE TABLE t (id int);\nCREATE INDEX t_id ON t (id);")).toEqual({
      mode: "transaction",
    });
    expect(plan("")).toEqual({ mode: "transaction" });
  });

  it("run a marked file's one statement, with its comments blanked and its semicolon dropped", () => {
    const result = plan(
      marked(
        "-- Why: bookings by trip.\nCREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS t_code_key\n  ON public.t (code) /* note; with a semicolon */ WHERE state = 'a;b''c';\n-- trailing comment\n",
      ),
    );
    expect(result.mode).toBe("no-transaction");
    if (result.mode !== "no-transaction") return;
    expect(result.statement).toMatch(/^CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS t_code_key/);
    expect(result.statement).toMatch(/WHERE state = 'a;b''c'$/);
    expect(result.statement).not.toContain("note");
    expect(result.statement).not.toContain("--");
  });

  it("accept a marked statement without a closing semicolon, and CRLF line ends", () => {
    expect(plan(`${noTransactionMarker}\r\nCREATE INDEX CONCURRENTLY t_id ON t (id)\r\n`)).toEqual({
      mode: "no-transaction",
      statement: "CREATE INDEX CONCURRENTLY t_id ON t (id)",
    });
  });

  it("refuse a marked file with more or fewer than one statement (D2)", () => {
    for (const body of [
      "CREATE INDEX CONCURRENTLY a ON t (x); CREATE INDEX CONCURRENTLY b ON t (y);",
      "CREATE INDEX CONCURRENTLY a ON t (x);;",
      "CREATE INDEX CONCURRENTLY a ON t (x); SELECT 1",
      "",
      "-- only a comment\n",
      ";",
    ]) {
      expect(() => plan(marked(body)), body).toThrow(/exactly one statement/);
    }
  });

  it("refuse a marked file whose statement is not a concurrent index build", () => {
    for (const body of [
      "CREATE INDEX a ON t (x);",
      "DROP INDEX CONCURRENTLY a;",
      "REINDEX INDEX CONCURRENTLY a;",
      "ALTER TABLE t ADD COLUMN y int;",
      "SELECT 'CREATE INDEX CONCURRENTLY a ON t (x)';",
    ]) {
      expect(() => plan(marked(body)), body).toThrow(/CREATE \[UNIQUE\] INDEX CONCURRENTLY/);
    }
  });

  it("refuse what the scanner does not parse rather than guess", () => {
    expect(() => plan(marked("CREATE INDEX CONCURRENTLY a ON t (x) WHERE y = $$a$$;"))).toThrow(
      /dollar quotes/,
    );
    expect(() => plan(marked("CREATE INDEX CONCURRENTLY a ON t (x) WHERE y = E'\\';"))).toThrow(
      /escape strings/,
    );
    expect(() => plan(marked("CREATE INDEX CONCURRENTLY a ON t (x) WHERE y = 'open;"))).toThrow(
      /unterminated quote/,
    );
    expect(() => plan(marked("CREATE INDEX CONCURRENTLY a ON t (x); /* open"))).toThrow(
      /unterminated comment/,
    );
    // A semicolon inside a quoted identifier does not end the statement.
    expect(plan(marked('CREATE INDEX CONCURRENTLY "a;e" ON t (x);')).mode).toBe("no-transaction");
  });

  it("allow nested block comments", () => {
    expect(
      plan(marked("/* outer /* inner; */ still; */ CREATE INDEX CONCURRENTLY a ON t (x);")),
    ).toEqual({ mode: "no-transaction", statement: "CREATE INDEX CONCURRENTLY a ON t (x)" });
  });

  it("refuse the marker anywhere but exactly the first line (D1)", () => {
    for (const sql of [
      `-- header\n${noTransactionMarker}\nCREATE INDEX CONCURRENTLY a ON t (x);`,
      `${noTransactionMarker} \nCREATE INDEX CONCURRENTLY a ON t (x);`,
      "--tidegrid:no-transaction\nCREATE INDEX CONCURRENTLY a ON t (x);",
      "-- TideGrid:No-Transaction\nCREATE INDEX CONCURRENTLY a ON t (x);",
      `${noTransactionMarker}\n${noTransactionMarker}\nCREATE INDEX CONCURRENTLY a ON t (x);`,
      // A misspelled value on the first line must not fall back to a transaction.
      "-- tidegrid:no_transaction\nCREATE INDEX CONCURRENTLY a ON t (x);",
      "-- tidegrid:no-transacton\nCREATE INDEX CONCURRENTLY a ON t (x);",
      "-- tidegrid: notransaction\nCREATE INDEX CONCURRENTLY a ON t (x);",
      "CREATE TABLE t (x int);\n-- tidegrid:no-transaction\n",
      // After a statement on the same line, or as a block comment.
      "CREATE INDEX CONCURRENTLY t_id ON t (id); -- tidegrid:no-transaction\n",
      "/* tidegrid:no-transaction */\nCREATE INDEX CONCURRENTLY a ON t (x);",
      "CREATE TABLE t (x int); /* tidegrid: no-transaction */",
    ]) {
      expect(() => plan(sql), sql).toThrow(/must be the file's first line/);
    }
  });

  it("refuse a backslash inside a string, whatever standard_conforming_strings is", () => {
    for (const sql of [
      "CREATE INDEX CONCURRENTLY i ON t (x) WHERE y = 'a\\'b';",
      "CREATE INDEX CONCURRENTLY i ON t (x) WHERE y = 'a\\' -- c\nb';",
    ]) {
      expect(() => plan(marked(sql)), sql).toThrow(/may not use a backslash inside a string/);
    }
    // A doubled quote is still fine.
    expect(plan(marked("CREATE INDEX CONCURRENTLY i ON t (x) WHERE y = 'it''s';"))).toMatchObject({
      mode: "no-transaction",
    });
  });

  it("end a line comment at a bare carriage return, as PostgreSQL does", () => {
    expect(plan(marked("CREATE INDEX CONCURRENTLY i ON t (x) -- note\rWHERE x > 0;"))).toEqual({
      mode: "no-transaction",
      statement: "CREATE INDEX CONCURRENTLY i ON t (x)        \rWHERE x > 0",
    });
  });

  it("set session timeouts for a marked file, and reset them after", () => {
    expect(sessionTimeoutStatements({ lockTimeoutMs: 5_000, statementTimeoutMs: 120_000 })).toEqual(
      ["SET lock_timeout = 5000", "SET statement_timeout = 120000"],
    );
    expect(sessionTimeoutResets).toEqual(["RESET lock_timeout", "RESET statement_timeout"]);
  });

  it("name a repair command for each invalid index and promise nothing was dropped (D3)", () => {
    const message = invalidIndexMessage([
      { index: "public.t_code_key", table: "public.t" },
      { index: 'public."Odd Name"', table: "public.t" },
    ]);
    expect(message).toMatch(/^Migrations refused: 2 invalid index\(es\)/);
    expect(message).toContain("Nothing was dropped and nothing was applied.");
    expect(message).toContain("  DROP INDEX CONCURRENTLY IF EXISTS public.t_code_key;");
    expect(message).toContain('  DROP INDEX CONCURRENTLY IF EXISTS public."Odd Name";');
    expect(message).toContain("The failed file was not recorded, so it runs again.");
    const failure = invalidIndexMessage(
      [{ index: "public.t_code_key", table: "public.t" }],
      "failure",
    );
    expect(failure).toMatch(
      /^The failed build left 1 invalid index\(es\): public.t_code_key on public.t\./,
    );
    expect(failure).toContain("Nothing was dropped. Every run refuses until each one is.");
    expect(failure).toContain("  DROP INDEX CONCURRENTLY IF EXISTS public.t_code_key;");
  });
});
