"""Check a restored TideGrid database against its backup manifest.

    python3 -I tools/backup/verify.py --manifest <file.json> [--expect-exact]

Reads the target from TARGET_DATABASE_URL. Read-only: every check runs in
transactions that are rolled back. Prints one line per check and a final
summary as one JSON line; exits 1 if any check fails.

Checks:
  migrations   the applied migrations equal the manifest's list
  tables       every table is present with the manifest's row count and row
               digest (with --expect-exact), or at least present (without it,
               for a point-in-time branch whose instant differs from the
               manifest's)
  rls          every table that forced row-level security still does
  no-tenant    the runtime role tidegrid_app, with no tenant set, sees no row
               in any table the manifest says forced row-level security
  two-tenant   with one tenant set, the runtime role sees only that tenant's
               rows, and sees at least one of them

Nothing printed carries a row's contents, a host, or a connection string.
"""

import argparse
import json
import os
import subprocess
import sys

TABLE_FACTS_SQL = """
select format('%s.%s|%s|%s|%s',
         n.nspname, c.relname,
         (xpath('/row/n/text()', x))[1]::text,
         coalesce((xpath('/row/d/text()', x))[1]::text, ''),
         case when c.relforcerowsecurity then 't' else 'f' end)
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  cross join lateral query_to_xml(
    format('select count(*) as n, md5(string_agg(h, '''' order by h)) as d
              from (select md5(t::text) as h from %I.%I t) s', n.nspname, c.relname),
    false, true, '') as x
 where n.nspname in ('public', 'app')
   and c.relkind in ('r', 'p')
 order by 1;
"""

# Runs as the runtime role inside a transaction that is always rolled back.
# The GRANT gives the connecting admin the right to SET ROLE for this
# transaction only; on a fresh target it is undone by the rollback.
TENANT_PROBE_SQL = """
begin;
do $$
begin
  if not pg_has_role(current_user, 'tidegrid_app', 'SET') then
    execute 'grant tidegrid_app to ' || quote_ident(current_user);
  end if;
end
$$;
set local role tidegrid_app;
select format('no-tenant|%s', coalesce(sum((xpath('/row/n/text()', query_to_xml(
         format('select count(*) as n from %I.%I', n.nspname, c.relname), false, true, '')))[1]::text::bigint), 0))
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname in ('public', 'app') and c.relkind in ('r', 'p')
   and format('%s.%s', n.nspname, c.relname) = any(:'forced'::text[])
   and has_table_privilege('tidegrid_app', c.oid, 'SELECT');
reset role;
rollback;
"""

TENANTS_SQL = "select id from public.tenants order by created_at, id limit 2;"

TWO_TENANT_SQL = """
begin;
do $$
begin
  if not pg_has_role(current_user, 'tidegrid_app', 'SET') then
    execute 'grant tidegrid_app to ' || quote_ident(current_user);
  end if;
end
$$;
select set_config('app.tenant_id', :'tenant', true);
set local role tidegrid_app;
with t as materialized (
  select n.nspname, c.relname
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname in ('public', 'app') and c.relkind in ('r', 'p')
   and format('%s.%s', n.nspname, c.relname) = any(:'forced'::text[])
     and has_table_privilege('tidegrid_app', c.oid, 'SELECT')
     and exists (select 1 from pg_attribute a
                  where a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped)
)
select format('two-tenant|%s|%s',
         coalesce(sum((xpath('/row/o/text()', x))[1]::text::bigint), 0),
         coalesce(sum((xpath('/row/m/text()', x))[1]::text::bigint), 0))
  from t
  cross join lateral query_to_xml(format(
    'select count(*) filter (where tenant_id::text <> %L) as o, count(*) filter (where tenant_id::text = %L) as m from %I.%I',
    current_setting('app.tenant_id'), current_setting('app.tenant_id'), t.nspname, t.relname), false, true, '') as x;
reset role;
rollback;
"""


def psql(url, sql, variables=None):
    cmd = ["psql", "-X", "-A", "-t", "-q", "-v", "ON_ERROR_STOP=1", "-d", url]
    for key, value in (variables or {}).items():
        cmd += ["-v", f"{key}={value}"]
    env = dict(os.environ)
    env["PGOPTIONS"] = (env.get("PGOPTIONS", "") + " -c TimeZone=UTC").strip()
    done = subprocess.run(cmd, input=sql, capture_output=True, text=True, env=env, check=False)
    if done.returncode != 0:
        # psql's own message names the failing statement, never a password.
        raise RuntimeError(done.stderr.strip().splitlines()[-1] if done.stderr.strip() else "psql failed")
    return [line for line in done.stdout.splitlines() if line.strip()]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--expect-exact", action="store_true")
    args = parser.parse_args()
    url = os.environ.get("TARGET_DATABASE_URL")
    if not url:
        sys.exit("verify: TARGET_DATABASE_URL is not set")
    with open(args.manifest, encoding="utf-8") as f:
        manifest = json.load(f)
    if manifest.get("format") != "tidegrid-backup-1":
        sys.exit("verify: not a TideGrid backup manifest")

    results = []

    def check(name, ok, detail):
        results.append({"check": name, "ok": bool(ok), "detail": detail})
        print(f"{'ok  ' if ok else 'FAIL'} {name}: {detail}")

    migrations = psql(url, "select name from public.schema_migrations order by name;")
    check(
        "migrations",
        migrations == manifest["migrations"],
        f"{len(migrations)} applied, last {migrations[-1] if migrations else 'none'}"
        f" (manifest {len(manifest['migrations'])}, last {manifest['lastMigration']})",
    )

    facts = {}
    for line in psql(url, TABLE_FACTS_SQL):
        name, rows, digest, force = line.split("|")
        facts[name] = {"rows": int(rows), "digest": digest, "forceRls": force == "t"}
    expected = {t["name"]: t for t in manifest["tables"]}
    missing = sorted(set(expected) - set(facts))
    extra = sorted(set(facts) - set(expected))
    differ = sorted(
        name
        for name in set(expected) & set(facts)
        if facts[name]["rows"] != expected[name]["rows"]
        or facts[name]["digest"] != expected[name]["digest"]
    )
    total = sum(f["rows"] for f in facts.values())
    if args.expect_exact:
        check(
            "tables",
            not missing and not extra and not differ,
            f"{len(facts)} tables, {total} rows; missing {missing or 'none'}, extra {extra or 'none'},"
            f" different rows {differ or 'none'}",
        )
    else:
        check(
            "tables",
            not missing,
            f"{len(facts)} tables, {total} rows; missing {missing or 'none'};"
            f" {len(differ)} differ from the manifest (expected at another instant)",
        )

    lost = sorted(n for n, t in expected.items() if t["forceRls"] and not facts.get(n, {}).get("forceRls"))
    forced = sum(1 for t in facts.values() if t["forceRls"])
    check("rls", not lost, f"{forced} tables force row-level security; lost on {lost or 'none'}")

    # The probes cover every table the manifest says forced row-level
    # security, so a table that lost it on restore shows its rows here.
    forced_names = sorted(n for n, t in expected.items() if t["forceRls"])
    if not all(part.replace("_", "").isalnum() for n in forced_names for part in n.split(".")):
        sys.exit("verify: unexpected table name in the manifest")
    forced_array = "{" + ",".join(forced_names) + "}"
    probe = psql(url, TENANT_PROBE_SQL, {"forced": forced_array})
    lines = [l for l in probe if l.startswith("no-tenant|")]
    seen = int(lines[0].split("|")[1]) if lines else -1
    check("no-tenant", seen == 0, f"the runtime role sees {seen} rows with no tenant set")

    tenants = psql(url, TENANTS_SQL)
    if not tenants:
        check("two-tenant", False, "no tenants to probe")
    else:
        others = 0
        mine = 0
        for tenant in tenants:
            out = psql(url, TWO_TENANT_SQL, {"tenant": tenant, "forced": forced_array})
            line = next(l for l in out if l.startswith("two-tenant|")).split("|")
            others += int(line[1])
            mine += int(line[2])
        check(
            "two-tenant",
            others == 0 and mine > 0,
            f"{len(tenants)} tenants probed; rows of another tenant seen {others}, own rows seen {mine}",
        )

    failed = [r["check"] for r in results if not r["ok"]]
    print(json.dumps({"verify": "pass" if not failed else "fail", "failed": failed, "tables": len(facts), "rows": total}))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
