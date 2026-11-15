#!/usr/bin/env bash
# Read TideGrid's ops signals and fail when any is over its limit (W3-OPS-5).
#
#   DATABASE_URL=<owner URL> tools/ops/check-signals.sh
#
# Read-only session; prints one line per signal (counts and ages only) and
# exits 1 when any signal is over its limit, 2 when the database cannot be read.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
: "${DATABASE_URL:?DATABASE_URL is not set}"

if ! out=$(PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=30000" \
  psql -X -A -t -q -v ON_ERROR_STOP=1 "$DATABASE_URL" -f "$here/signals.sql" 2>&1); then
  # The reason goes to stderr only (the workflow masks the host there); the
  # report line, which can reach a public issue, stays generic.
  printf '%s\n' "$out" | tail -1 >&2
  echo "signals: ALERT database_unreadable"
  exit 2
fi

alerts=0
while IFS='|' read -r name value limit; do
  [ -n "$name" ] || continue
  if [ "$value" -gt "$limit" ]; then
    echo "signals: ALERT $name $value (limit $limit)"
    alerts=$((alerts + 1))
  else
    echo "signals: ok $name $value (limit $limit)"
  fi
done <<< "$out"
[ "$alerts" = 0 ]
