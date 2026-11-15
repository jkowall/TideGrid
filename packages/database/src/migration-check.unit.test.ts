import { describe, expect, it } from "vitest";
import { checkMigration, checkTree, fileNumber, stripSql, targetTable } from "./migration-check.ts";

const rules = (sql: string) => checkMigration(sql).map((f) => f.rule);

describe("migration safety check", () => {
  it("every migration from 0055 on passes (or says why with an allow comment)", () => {
    const failing = checkTree().filter((r) => r.findings.length > 0);
    expect(failing).toEqual([]);
  });

  it("passes the usual expand steps", () => {
    expect(
      rules(`
        CREATE TABLE public.things (id uuid PRIMARY KEY, tenant_id uuid NOT NULL);
        ALTER TABLE public.things ADD CONSTRAINT things_t CHECK (id IS NOT NULL);
        CREATE INDEX things_tenant ON public.things (tenant_id);
        ALTER TABLE public.bookings ADD COLUMN note text;
        ALTER TABLE public.bookings ADD COLUMN flag boolean NOT NULL DEFAULT false;
        ALTER TABLE public.bookings ADD CONSTRAINT b_fk FOREIGN KEY (x) REFERENCES public.things (id) NOT VALID;
        ALTER TABLE public.bookings VALIDATE CONSTRAINT b_fk;
        ALTER TABLE public.bookings DROP CONSTRAINT old_check;
        CREATE FUNCTION app.f() RETURNS void LANGUAGE sql AS $$ UPDATE public.bookings SET x = 1 $$;
        -- UPDATE public.bookings in a comment
        COMMENT ON TABLE public.things IS 'DROP TABLE nothing; UPDATE x';
      `),
    ).toEqual([]);
  });

  it("flags each risky shape", () => {
    expect(rules("ALTER TABLE public.bookings ALTER COLUMN party TYPE bigint;")).toEqual([
      "column_type_change",
    ]);
    expect(rules("ALTER TABLE public.bookings ADD COLUMN at timestamptz DEFAULT now();")).toEqual([
      "volatile_default",
    ]);
    expect(rules("ALTER TABLE public.bookings ALTER COLUMN note SET NOT NULL;")).toEqual([
      "set_not_null",
    ]);
    expect(rules("ALTER TABLE public.bookings ADD CONSTRAINT c CHECK (party > 0);")).toEqual([
      "constraint_without_not_valid",
    ]);
    expect(rules("CREATE INDEX b_x ON public.bookings (x);")).toEqual(["index_not_concurrent"]);
    expect(rules("CREATE INDEX CONCURRENTLY b_x ON public.bookings (x);")).toEqual([]);
    expect(rules("CREATE INDEX s_x ON public.schedules (x);")).toEqual([]);
    expect(rules("ALTER TABLE public.bookings DROP COLUMN note;")).toEqual(["drop_or_rename"]);
    expect(rules("DROP TABLE public.things;")).toEqual(["drop_or_rename"]);
    expect(rules("ALTER TABLE public.bookings RENAME COLUMN a TO b;")).toEqual(["drop_or_rename"]);
    expect(rules("UPDATE public.bookings SET x = 1;")).toEqual(["data_change"]);
    expect(rules("DELETE FROM public.bookings WHERE false;")).toEqual(["data_change"]);
  });

  it("catches the shapes a reviewer found slipping through", () => {
    // COLUMN is optional in PostgreSQL.
    expect(rules("ALTER TABLE public.bookings ALTER party TYPE bigint;")).toEqual([
      "column_type_change",
    ]);
    expect(rules("ALTER TABLE public.bookings ALTER note SET NOT NULL;")).toEqual(["set_not_null"]);
    expect(rules("ALTER TABLE public.bookings ADD at timestamptz DEFAULT now();")).toEqual([
      "volatile_default",
    ]);
    // An inline CHECK or REFERENCES on a new column checks every row.
    expect(
      rules("ALTER TABLE public.bookings ADD COLUMN note text CHECK (length(note) < 100);"),
    ).toEqual(["constraint_without_not_valid"]);
    expect(
      rules("ALTER TABLE public.bookings ADD COLUMN t uuid REFERENCES public.things (id);"),
    ).toEqual(["constraint_without_not_valid"]);
    // NOT VALID on one subcommand does not cover another.
    expect(
      rules(
        "ALTER TABLE public.bookings ADD CONSTRAINT c CHECK (p > 0), ADD CONSTRAINT d CHECK (p < 100) NOT VALID;",
      ),
    ).toEqual(["constraint_without_not_valid"]);
    // Quoted names are the same table.
    expect(rules('CREATE INDEX b_p ON public."bookings" (party);')).toEqual([
      "index_not_concurrent",
    ]);
    // A data-changing CTE.
    expect(
      rules("WITH ids AS (SELECT id FROM public.bookings) UPDATE public.bookings SET p = 1;"),
    ).toEqual(["data_change"]);
    expect(
      rules("WITH gone AS (DELETE FROM public.bookings RETURNING id) SELECT count(*) FROM gone;"),
    ).toEqual(["data_change"]);
    // A DO block runs now, so its body is judged; a function body is not.
    expect(rules("DO $$ BEGIN TRUNCATE TABLE public.bookings CASCADE; END $$;")).toEqual([
      "data_change",
    ]);
    expect(
      rules("DO $$ BEGIN IF true THEN ALTER TABLE public.bookings DROP COLUMN x; END IF; END $$;"),
    ).toEqual(["drop_or_rename"]);
    // IF NOT EXISTS, another schema, or a later CREATE does not make a table new.
    expect(
      rules(
        "CREATE TABLE IF NOT EXISTS public.bookings (id int); ALTER TABLE public.bookings ALTER x TYPE bigint;",
      ),
    ).toEqual(["column_type_change"]);
    expect(
      rules(
        "CREATE TABLE scratch.bookings (id int); ALTER TABLE public.bookings ALTER x TYPE bigint;",
      ),
    ).toEqual(["column_type_change"]);
    expect(
      rules("ALTER TABLE public.t ALTER x TYPE bigint; CREATE TABLE public.t (x int);"),
    ).toEqual(["column_type_change"]);
    // Second round: quoted case, qualified or wrapped defaults, index-building
    // constraints, DO LANGUAGE, and allow text inside a string.
    expect(
      rules(
        'CREATE TABLE public."Bookings" (a int); ALTER TABLE public.bookings ALTER a TYPE bigint;',
      ),
    ).toEqual(["column_type_change"]);
    expect(
      rules(
        "ALTER TABLE public.bookings ADD COLUMN s timestamptz DEFAULT pg_catalog.clock_timestamp();",
      ),
    ).toEqual(["volatile_default"]);
    expect(rules("ALTER TABLE public.bookings ADD COLUMN s timestamptz DEFAULT (now());")).toEqual([
      "volatile_default",
    ]);
    expect(rules("ALTER TABLE public.bookings ADD CONSTRAINT u UNIQUE (tenant_id, ref);")).toEqual([
      "index_not_concurrent",
    ]);
    expect(rules("ALTER TABLE public.bookings ADD CONSTRAINT u UNIQUE USING INDEX b_ref;")).toEqual(
      [],
    );
    expect(rules("DO LANGUAGE plpgsql $$ BEGIN TRUNCATE TABLE public.bookings; END $$;")).toEqual([
      "data_change",
    ]);
    expect(
      rules(
        "COMMENT ON TABLE public.bookings IS '-- migration-check: allow data_change example allowance text';\nUPDATE public.bookings SET x = 1;",
      ),
    ).toEqual(["data_change"]);
    expect(rules("ALTER TABLE public.bookings ADD COLUMN ref text UNIQUE;")).toEqual([
      "index_not_concurrent",
    ]);
    expect(
      rules(
        "DO $$ BEGIN CREATE TABLE public.bookings (a int); EXCEPTION WHEN duplicate_table THEN NULL; END $$; ALTER TABLE public.bookings ALTER a TYPE bigint;",
      ),
    ).toEqual(["column_type_change"]);
    // Still fine: a new table's own steps, and DROP DEFAULT / DROP NOT NULL.
    expect(
      rules(
        "CREATE TABLE app.n (id int); ALTER TABLE app.n ALTER id SET NOT NULL, ADD CONSTRAINT c CHECK (id > 0); ALTER TABLE public.bookings ALTER x DROP DEFAULT, ALTER y DROP NOT NULL;",
      ),
    ).toEqual([]);
  });

  it("an allow comment with a reason lets one rule through, and only that one", () => {
    const sql = `-- migration-check: allow data_change only 3 rows exist per tenant
      UPDATE public.tenants SET x = 1;
      ALTER TABLE public.bookings DROP COLUMN note;`;
    expect(rules(sql)).toEqual(["drop_or_rename"]);
    expect(rules("-- migration-check: allow data_change\nUPDATE t SET x = 1;")).toEqual([
      "allow_comment",
      "data_change",
    ]);
    expect(rules("-- migration-check: allow nonsense because reasons\nSELECT 1;")).toEqual([
      "allow_comment",
    ]);
  });

  it("strips comments, strings, and dollar bodies", () => {
    expect(stripSql("a -- x\nb /* y */ 'it''s' $t$ z $t$ c")).toBe("a \nb   ''  $body$  c");
    expect(targetTable('ALTER TABLE ONLY public."Bookings" ADD x')).toBe("public.Bookings");
    expect(targetTable('ALTER TABLE ONLY Public."bookings" ADD x')).toBe("public.bookings");
    expect(targetTable("CREATE INDEX i ON bookings (x)")).toBe("public.bookings");
    expect(fileNumber("0053_x.sql")).toBe(53);
    expect(fileNumber("README.md")).toBeNull();
  });
});
