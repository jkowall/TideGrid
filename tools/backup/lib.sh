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

# The facts queries live in table-facts.sql and security-facts.sql, shared
# with verify.py so the two can never drift.

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
