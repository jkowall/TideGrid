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
    expect(targetTable('ALTER TABLE ONLY public."Bookings" ADD x')).toBe("bookings");
    expect(fileNumber("0053_x.sql")).toBe(53);
    expect(fileNumber("README.md")).toBeNull();
  });
});
