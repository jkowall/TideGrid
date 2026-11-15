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
  rls          every table that had row-level security on and forced still does
  definers     every SECURITY DEFINER function belongs to a role that bypasses
               row-level security (they read tables the runtime role cannot)
  policies     every row-level security policy is the same, word for word
  grants       the runtime role holds exactly the same table privileges
  no-tenant    the runtime role tidegrid_app, with no tenant set, sees no row
               in any table the manifest says forced row-level security and
               it can read (whole table or any column)
  two-tenant   with one tenant set, the runtime role sees only that tenant's
               rows (the tenants table by id, the rest by tenant_id), and
               sees at least one of them

Nothing printed carries a row's contents, a host, or a connection string.
"""

import argparse
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def read_sql(name):
    with open(os.path.join(HERE, name), encoding="utf-8") as f:
        return f.read()


# Shared with backup.sh, so the two read the same facts.
TABLE_FACTS_SQL = read_sql("table-facts.sql")
SECURITY_FACTS_SQL = read_sql("security-facts.sql")

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
   and has_any_column_privilege('tidegrid_app', c.oid, 'SELECT');
reset role;
rollback;
"""

# SECURITY DEFINER functions whose owner cannot bypass row-level security.
# Migration 0002's hostname and sign-in lookups need a bypassing owner.
DEFINERS_SQL = """
select format('definers|%s|%s', count(*),
         count(*) filter (where not (r.rolsuper or r.rolbypassrls)))
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  join pg_roles r on r.oid = p.proowner
 where n.nspname in ('public', 'app') and p.prosecdef;
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
  select n.nspname, c.relname,
         case when c.oid = 'public.tenants'::regclass then 'id' else 'tenant_id' end as col
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname in ('public', 'app') and c.relkind in ('r', 'p')
   and format('%s.%s', n.nspname, c.relname) = any(:'forced'::text[])
     and has_any_column_privilege('tidegrid_app', c.oid, 'SELECT')
     and exists (select 1 from pg_attribute a
                  where a.attrelid = c.oid and not a.attisdropped
                    and (a.attname = 'tenant_id' or (c.oid = 'public.tenants'::regclass and a.attname = 'id')))
)
select format('two-tenant|%s|%s',
         coalesce(sum((xpath('/row/o/text()', x))[1]::text::bigint), 0),
         coalesce(sum((xpath('/row/m/text()', x))[1]::text::bigint), 0))
  from t
  cross join lateral query_to_xml(format(
    'select count(*) filter (where %I::text <> %L) as o, count(*) filter (where %I::text = %L) as m from %I.%I',
    t.col, current_setting('app.tenant_id'), t.col, current_setting('app.tenant_id'), t.nspname, t.relname), false, true, '') as x;
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
        lines = done.stderr.strip().splitlines()
        errors = [l for l in lines if "ERROR" in l or "FATAL" in l]
        raise RuntimeError((errors or lines or ["psql failed"])[0][:300])
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

    definers = psql(url, DEFINERS_SQL)[0].split("|")
    check(
        "definers",
        int(definers[1]) > 0 and definers[2] == "0",
        f"{definers[1]} SECURITY DEFINER functions, {definers[2]} owned by a role that cannot bypass row-level security",
    )

    security = {}
    for line in psql(url, SECURITY_FACTS_SQL):
        name, count, digest = line.split("|")
        security[name] = {"count": int(count), "digest": digest}
    for name in ("policies", "grants"):
        want = manifest.get(name)
        got = security.get(name)
        check(
            name,
            want is not None and got == want,
            f"{got['count'] if got else 0} on the restore, {want['count'] if want else 'none'} in the manifest;"
            f" {'same' if got == want else 'DIFFERENT'} definitions",
        )

    # The probes cover every table the manifest says forced row-level
    # security, so a table that lost it on restore shows its rows here.
    forced_names = sorted(n for n, t in expected.items() if t["forceRls"])
    if not all(part.replace("_", "").isalnum() for n in forced_names for part in n.split(".")):
        sys.exit("verify: unexpected table name in the manifest")
    forced_array = "{" + ",".join(forced_names) + "}"
    try:
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

    except RuntimeError as err:
        # The connecting role must be able to act as tidegrid_app (superuser,
        # or holding ADMIN on it, as the role that created it does).
        for name in ("no-tenant", "two-tenant"):
            check(name, False, f"could not run the probe as tidegrid_app: {err}")

    failed = [r["check"] for r in results if not r["ok"]]
    print(json.dumps({"verify": "pass" if not failed else "fail", "failed": failed, "tables": len(facts), "rows": total}))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
