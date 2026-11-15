#!/usr/bin/env bash
# Connects the staging Workers to the staging database and sets their
# secrets (goal W3-PREPILOT). Run after tools/staging/resolve.sh and after
# migrations, with the staging API Worker already deployed once.
#
#   tools/staging/configure.sh [--rotate]
#
# Needs CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, ALERT_EMAIL, and the
# STAGING_* values resolve.sh prints. Writes HYPERDRIVE_ID=<id> to stdout.
#
# - Runtime role. tidegrid_app gets a new random password only when staging
#   has no Hyperdrive config yet, the Worker has no DATABASE_URL secret, or
#   --rotate is given. Nobody sees the password: it goes into the database,
#   the Hyperdrive config, and the Worker secret in one run.
# - Hyperdrive. One config named tidegrid-staging, pointing at staging's
#   direct (unpooled) host, with query caching disabled (hosting plan).
# - Secrets, set only when missing so sealed data stays readable:
#   FIELD_ENCRYPTION_KEYS (a fresh keyring), FAKE_PAYMENT_WEBHOOK_SECRET (32
#   random bytes). Always set:
#   EMAIL_ALLOWED_RECIPIENTS = ALERT_EMAIL, so staging mail reaches only the
#   owner's inbox.
# - Not set: TURNSTILE_SECRET_KEY. Staging has no guest site, so no page can
#   run the widget, and a test secret answers for example.com, which the API
#   refuses. Without it staging's checkout answers 503 human_check_unavailable
#   (fails closed), which the proof records as a gap.
set -euo pipefail

for v in CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID ALERT_EMAIL STAGING_ADMIN_URL STAGING_HOST STAGING_DB NEON_MAIN_HOST; do
  [ -n "${!v:-}" ] || { echo "configure: $v is required" >&2; exit 1; }
done
rotate=false
[ "${1:-}" = --rotate ] && rotate=true

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cf="https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID"
api_script=tidegrid-api-staging
hd_name=tidegrid-staging
die() { echo "configure: $*" >&2; exit 1; }
mask() { if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::add-mask::$1" >&2; fi; }
cfapi() {
  local method=$1 path=$2 body=${3:-}
  local out
  if [ -n "$body" ]; then
    out=$(curl -sS -X "$method" -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
      -H 'Content-Type: application/json' --data-binary @- "$cf$path" <<<"$body")
  else
    out=$(curl -sS -X "$method" -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "$cf$path")
  fi
  if [ "$(jq -r '.success // false' <<<"$out")" != true ]; then
    # Error codes and messages only; Cloudflare never echoes a password back.
    die "Cloudflare $method $path failed: $(jq -c '[.errors[]? | {code, message}]' <<<"$out" 2>/dev/null || echo unreadable)"
  fi
  printf '%s' "$out"
}
case "$STAGING_HOST" in "$NEON_MAIN_HOST" | *-pooler.*) die "refusing: not staging's direct host" ;; esac

hd_id=$(cfapi GET /hyperdrive/configs | jq -r --arg n "$hd_name" '[.result[] | select(.name == $n)][0].id // empty')
secrets=$(curl -sS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "$cf/workers/scripts/$api_script/secrets" |
  jq -r 'if .success then [.result[].name] | join(" ") else "" end')
has() { [[ " $secrets " == *" $1 "* ]]; }

if [ -z "$hd_id" ] || ! has DATABASE_URL; then rotate=true; fi

declare -A put=()
if [ "$rotate" = true ]; then
  password=$(openssl rand -hex 32)
  mask "$password"
  DATABASE_URL="$STAGING_ADMIN_URL" TIDEGRID_APP_PASSWORD="$password" \
    pnpm --silent --dir "$root" --filter @tidegrid/database app-role:password >&2
  body=$(jq -n --arg n "$hd_name" --arg h "$STAGING_HOST" --arg d "$STAGING_DB" --arg p "$password" \
    '{name: $n, origin: {scheme: "postgres", host: $h, port: 5432, database: $d, user: "tidegrid_app", password: $p}, caching: {disabled: true}}')
  if [ -z "$hd_id" ]; then
    hd_id=$(cfapi POST /hyperdrive/configs "$body" | jq -r .result.id)
    echo "configure: created Hyperdrive config $hd_id" >&2
  else
    cfapi PUT "/hyperdrive/configs/$hd_id" "$body" >/dev/null
    echo "configure: updated Hyperdrive config $hd_id" >&2
  fi
  app_url="postgresql://tidegrid_app:$password@$STAGING_HOST/$STAGING_DB?sslmode=require"
  mask "$app_url"
  put[DATABASE_URL]=$app_url
fi

# The config as Cloudflare holds it: caching off, the direct host.
cfg=$(cfapi GET "/hyperdrive/configs/$hd_id")
[ "$(jq -r '.result.caching.disabled' <<<"$cfg")" = true ] || die "Hyperdrive caching is not disabled"
[ "$(jq -r '.result.origin.host' <<<"$cfg")" = "$STAGING_HOST" ] || die "Hyperdrive does not point at staging's direct host"

if ! has FIELD_ENCRYPTION_KEYS; then
  keys=$(cd "$root/packages/database" && pnpm --silent exec tsx -e 'import { newFieldKeyringSecret } from "./src/field-crypto.ts"; process.stdout.write(newFieldKeyringSecret());')
  mask "$keys"
  put[FIELD_ENCRYPTION_KEYS]=$keys
fi
if ! has FAKE_PAYMENT_WEBHOOK_SECRET; then
  hook=$(openssl rand -hex 32)
  mask "$hook"
  put[FAKE_PAYMENT_WEBHOOK_SECRET]=$hook
fi
put[EMAIL_ALLOWED_RECIPIENTS]=$ALERT_EMAIL

file=$(mktemp "${RUNNER_TEMP:-/tmp}/staging-secrets.XXXXXX")
trap 'rm -f "$file"' EXIT
chmod 600 "$file"
json='{}'
for k in "${!put[@]}"; do json=$(jq --arg k "$k" --arg v "${put[$k]}" '. + {($k): $v}' <<<"$json"); done
printf '%s' "$json" > "$file"
(cd "$root/apps/api-worker" && pnpm --silent exec wrangler secret bulk "$file" --env staging >/dev/null)
echo "configure: set $(jq -r 'keys | join(", ")' <<<"$json") on $api_script" >&2
echo "HYPERDRIVE_ID=$hd_id"
