import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { checkMigration } from "./migration-check.ts";

/**
 * The expand, backfill, verify, contract rehearsal (W3-OPS-3; hosting plan,
 * "Database migration and rollback policy"; the Migration row of its
 * acceptance table). It changes a column's shape the way a pilot migration
 * must: while old and new application code both run, without a table rewrite
 * or a long lock, and with control totals before the old shape goes.
 *
 * It runs in a uniquely named scratch schema on the integration database and
 * drops only that schema. The table stands in for a pilot table: an amount
 * kept as text by "old code" moves to integer cents for "new code".
 *
 *   1. Expand: add the new column (nullable, no default) and a trigger that
 *      keeps it in step with writes from old code. Each DDL file passes the
 *      migration safety check.
 *   2. Backfill in bounded batches, stopped part way and restarted.
 *   3. Verify: control totals agree, no row is missing, old and new code both
 *      read and write.
 *   4. Tighten: CHECK ... NOT VALID, VALIDATE, then SET NOT NULL, each under
 *      a short lock timeout.
 *   5. Forward fix: a wrong conversion found by the verify step is corrected
 *      by a new forward step, never by editing the earlier one.
 *   6. Contract: only once old code is gone, drop the trigger and old column.
 */

const env = inject("integrationDb");
const rows = 5_000;
const batch = 400;

describe.skipIf(!env)("expand, backfill, verify, contract rehearsal", () => {
  if (!env) return;
  const schema = `rehearsal_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const t = `${schema}.charges`;
  let sql: ReturnType<typeof postgres>;

  /** Old code: knows only amount_text. */
  const oldWrite = (amount: string) =>
    sql.unsafe(`INSERT INTO ${t} (amount_text) VALUES ($1)`, [amount]);
  const oldReadTotal = async () =>
    Number(
      (await sql.unsafe(`SELECT coalesce(sum(amount_text::numeric), 0) AS s FROM ${t}`))[0]?.s,
    );
  /** New code: writes both shapes while the old one exists, reads the new one. */
  const newReadTotalCents = async () =>
    Number((await sql.unsafe(`SELECT coalesce(sum(amount_cents), 0) AS s FROM ${t}`))[0]?.s);

  /** One migration step: checked like a real file, run under the migrator's timeouts. */
  async function step(file: string) {
    expect(checkMigration(file)).toEqual([]);
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL lock_timeout = 5000; SET LOCAL statement_timeout = 120000");
      await tx.unsafe(file);
    });
  }

  /** One bounded backfill batch; returns how many rows it filled. */
  async function backfillBatch(convert: string): Promise<number> {
    const r = await sql.unsafe(
      `UPDATE ${t} SET amount_cents = ${convert}
         WHERE id IN (SELECT id FROM ${t} WHERE amount_cents IS NULL ORDER BY id LIMIT ${batch} FOR UPDATE SKIP LOCKED)`,
    );
    return r.count;
  }

  beforeAll(async () => {
    sql = postgres(env.adminUrl, { max: 2, onnotice: () => {} });
    await sql.unsafe(`CREATE SCHEMA ${schema}`);
    await sql.unsafe(
      `CREATE TABLE ${t} (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, amount_text text NOT NULL)`,
    );
    await sql.unsafe(
      `INSERT INTO ${t} (amount_text)
         SELECT to_char((g % 997) + (g % 100) / 100.0, 'FM999990.00') FROM generate_series(1, ${rows}) g`,
    );
  });

  afterAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await sql.end();
  });

  it("rehearses every step and keeps old and new code working throughout", async () => {
    const before = await oldReadTotal();

    // 1. Expand. Nullable, no default: a catalog change, no rewrite.
    await step(`ALTER TABLE ${t} ADD COLUMN amount_cents bigint`);
    // A deliberately wrong conversion (truncates the cents) so step 5 has a bug to fix.
    await step(`
      CREATE FUNCTION ${schema}.charges_sync() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN
        IF NEW.amount_cents IS NULL OR NEW.amount_text IS DISTINCT FROM OLD.amount_text THEN
          NEW.amount_cents := trunc(NEW.amount_text::numeric) * 100;
        END IF;
        RETURN NEW;
      END $f$;
      CREATE TRIGGER charges_sync BEFORE INSERT OR UPDATE ON ${t}
        FOR EACH ROW EXECUTE FUNCTION ${schema}.charges_sync()`);
    // Old code keeps writing during the expand; the trigger fills the new column.
    await oldWrite("12.34");

    // 2. Backfill in bounded batches. Stop after three, as a crash would.
    let filled = 0;
    for (let i = 0; i < 3; i++) filled += await backfillBatch("trunc(amount_text::numeric) * 100");
    expect(filled).toBe(3 * batch);
    const remaining = async () =>
      Number((await sql.unsafe(`SELECT count(*) AS n FROM ${t} WHERE amount_cents IS NULL`))[0]?.n);
    expect(await remaining()).toBe(rows - filled);
    // Restart: the batch query only picks rows still to do, so a restart is safe.
    let n: number;
    let batches = 0;
    do {
      n = await backfillBatch("trunc(amount_text::numeric) * 100");
      batches++;
      expect(n).toBeLessThanOrEqual(batch);
    } while (n > 0);
    expect(await remaining()).toBe(0);
    expect(batches).toBeGreaterThan(1);

    // 3. Verify with control totals. The truncating conversion is caught here.
    const controls = async () =>
      (
        await sql.unsafe(
          `SELECT count(*)::int AS n,
                  sum(round(amount_text::numeric * 100))::bigint AS want,
                  sum(amount_cents)::bigint AS got,
                  count(*) FILTER (WHERE round(amount_text::numeric * 100) <> amount_cents)::int AS off
             FROM ${t}`,
        )
      )[0] as unknown as { n: number; want: string; got: string; off: number };
    const first = await controls();
    expect(first.n).toBe(rows + 1);
    expect(first.off).toBeGreaterThan(0);
    expect(first.want).not.toBe(first.got);

    // 5. Forward fix: a new trigger function and a corrective bounded pass.
    // The earlier step is never edited.
    await step(`
      CREATE OR REPLACE FUNCTION ${schema}.charges_sync() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN
        IF NEW.amount_cents IS NULL OR NEW.amount_text IS DISTINCT FROM OLD.amount_text THEN
          NEW.amount_cents := round(NEW.amount_text::numeric * 100);
        END IF;
        RETURN NEW;
      END $f$`);
    for (;;) {
      const r = await sql.unsafe(
        `UPDATE ${t} SET amount_cents = round(amount_text::numeric * 100)
           WHERE id IN (SELECT id FROM ${t}
                         WHERE amount_cents IS DISTINCT FROM round(amount_text::numeric * 100)
                         ORDER BY id LIMIT ${batch})`,
      );
      if (r.count === 0) break;
    }
    const fixed = await controls();
    expect(fixed.off).toBe(0);
    expect(fixed.want).toBe(fixed.got);
    // Old and new readers agree, and old code's writes stay in step.
    expect(Math.round((await oldReadTotal()) * 100)).toBe(await newReadTotalCents());
    expect(Math.round(before * 100) + 1234).toBe(await newReadTotalCents());
    await oldWrite("0.99");
    await sql.unsafe(`INSERT INTO ${t} (amount_text, amount_cents) VALUES ('5.00', 500)`);
    expect(Math.round((await oldReadTotal()) * 100)).toBe(await newReadTotalCents());

    // 4. Tighten without a long lock: NOT VALID, VALIDATE, then SET NOT NULL
    // (PostgreSQL 12 and later skip the scan when a valid check proves it).
    await step(
      `ALTER TABLE ${t} ADD CONSTRAINT charges_cents_present CHECK (amount_cents IS NOT NULL) NOT VALID`,
    );
    await step(`ALTER TABLE ${t} VALIDATE CONSTRAINT charges_cents_present`);
    const notNull = `-- migration-check: allow set_not_null a validated CHECK proves it, so no scan runs
      ALTER TABLE ${t} ALTER COLUMN amount_cents SET NOT NULL`;
    await step(notNull);

    // 6. Contract, only after old code is gone. Old code then fails loudly
    // rather than writing to a column nobody reads.
    const contract = `-- migration-check: allow drop_or_rename contract step after every reader moved to amount_cents
      DROP TRIGGER charges_sync ON ${t};
      DROP FUNCTION ${schema}.charges_sync();
      ALTER TABLE ${t} DROP COLUMN amount_text`;
    expect(
      checkMigration(contract.replace(/^.*migration-check.*$/m, "")).map((f) => f.rule),
    ).toEqual(["drop_or_rename"]);
    await step(contract);
    await expect(oldWrite("1.00")).rejects.toThrow(/amount_text/);
    const after = Number((await sql.unsafe(`SELECT sum(amount_cents) AS s FROM ${t}`))[0]?.s);
    expect(after).toBe(Math.round(before * 100) + 1234 + 99 + 500);
  });
});
