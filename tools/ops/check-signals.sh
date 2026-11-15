#!/usr/bin/env bash
# Read TideGrid's ops signals and fail when any is over its limit (W3-OPS-5).
#
#   DATABASE_URL=<owner URL> tools/ops/check-signals.sh
#
# Read-only session. Prints one line per signal (counts and ages only) and
# exits 1 when any signal is over its limit or the output is not what
# signals.sql produces, 2 when the database cannot be read. Only these fixed
# lines reach stdout, which can land in a public issue; psql's own messages go
# to stderr (the workflow masks the host there).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
: "${DATABASE_URL:?DATABASE_URL is not set}"

expected="payment_events_stuck paid_without_event outbox_stuck_minutes dead_letters_open email_account_fault"
err=$(mktemp)
trap 'rm -f "$err"' EXIT

if ! out=$(PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=30000" \
  psql -X -A -t -q -v ON_ERROR_STOP=1 "$DATABASE_URL" -f "$here/signals.sql" 2> "$err"); then
  grep -E 'ERROR|FATAL|error:' "$err" | head -3 | cut -c1-200 >&2 || true
  echo "signals: ALERT database_unreadable"
  exit 2
fi

alerts=0
seen=""
while IFS= read -r line; do
  [ -n "$line" ] || continue
  if ! [[ "$line" =~ ^([a-z_]{1,40})\|([0-9]{1,12})\|([0-9]{1,12})$ ]]; then
    echo "signals: ALERT malformed_output"
    alerts=$((alerts + 1))
    continue
  fi
  name=${BASH_REMATCH[1]}
  value=${BASH_REMATCH[2]}
  limit=${BASH_REMATCH[3]}
  seen="$seen $name"
  if [ "$value" -gt "$limit" ]; then
    echo "signals: ALERT $name $value (limit $limit)"
    alerts=$((alerts + 1))
  else
    echo "signals: ok $name $value (limit $limit)"
  fi
done <<< "$out"

if [ "$(echo $seen)" != "$expected" ]; then
  echo "signals: ALERT missing_signals"
  alerts=$((alerts + 1))
fi
[ "$alerts" = 0 ]
