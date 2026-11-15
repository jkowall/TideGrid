# Shared pieces of TideGrid's backup tooling. Sourced, never run.
#
# Every query here is read-only. Output never carries a row's contents: only
# table names, row counts, and digests of the rows.

# psql with no startup file, quiet, unaligned, failing on the first error.
# Times read in UTC so a row's text form is the same on every server.
tg_psql() {
  PGOPTIONS="${PGOPTIONS:-} -c TimeZone=UTC -c default_transaction_read_only=on" \
    psql -X -A -t -q -v ON_ERROR_STOP=1 "$@"
}

# One line per table in the public and app schemas:
#   <schema.table>|<row count>|<digest>|<row level security forced: t or f>
# The digest is an md5 over the sorted md5 of each row's text form, so it does
# not depend on the server's collation or on physical row order. Two databases
# with the same rows give the same line. At pilot volume this reads every row
# in well under a minute.
TG_TABLE_FACTS_SQL="
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
"

# The applied migrations, one name per line, in order.
TG_MIGRATIONS_SQL="select name from public.schema_migrations order by name;"

# Prints a duration in whole seconds between two epoch-second values.
tg_seconds() { echo $(( $2 - $1 )); }

tg_die() { echo "backup: $*" >&2; exit 1; }

tg_need() {
  local tool
  for tool in "$@"; do
    command -v "$tool" >/dev/null 2>&1 || tg_die "$tool is not installed"
  done
}

# sha256 of a file, the hex only. Works with GNU coreutils and macOS.
tg_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

tg_size() { wc -c < "$1" | tr -d ' '; }

# In a GitHub Actions log (public for this repository), hide a connection
# URL's host. GitHub masks a secret's whole value but not a part of it, and a
# libpq error names the host it failed to reach.
tg_mask_url() {
  local host
  host=$(printf '%s' "$1" | sed -E 's#^[a-z]+://([^@/]*@)?([^:/?]+).*#\2#')
  if [ -n "${GITHUB_ACTIONS:-}" ] && [ -n "$host" ]; then
    echo "::add-mask::$host"
    # The endpoint id alone also identifies the database.
    echo "::add-mask::${host%%.*}"
  fi
}
