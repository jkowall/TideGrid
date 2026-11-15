#!/usr/bin/env bash
# Finds the staging Neon branch and its database (goal W3-PREPILOT), and
# refuses anything that could be Neon main. Staging is the one branch named
# "staging" that is not the project's default branch.
#
#   NEON_API_KEY=... NEON_PROJECT_ID=... tools/staging/resolve.sh >> "$GITHUB_ENV"
#
# Prints KEY=VALUE lines: STAGING_BRANCH_ID, STAGING_ENDPOINT_ID,
# STAGING_HOST, STAGING_DB, NEON_MAIN_HOST, and STAGING_ADMIN_URL (the
# owner role's direct, unpooled connection string). Under GitHub Actions the
# URL and hosts are masked first, so they never reach a log.
set -euo pipefail

: "${NEON_API_KEY:?NEON_API_KEY is required}"
: "${NEON_PROJECT_ID:?NEON_PROJECT_ID is required}"
api="https://console.neon.tech/api/v2/projects/$NEON_PROJECT_ID"

neon() {
  curl -fsS --retry 3 --retry-all-errors -H "Authorization: Bearer $NEON_API_KEY" \
    -H 'Accept: application/json' "$api$1"
}
mask() { if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::add-mask::$1" >&2; fi; }
die() { echo "resolve: $*" >&2; exit 1; }

branches=$(neon /branches)
count=$(jq '[.branches[] | select(.name == "staging")] | length' <<<"$branches")
[ "$count" = 1 ] || die "expected one branch named staging, found $count"
staging=$(jq -r '.branches[] | select(.name == "staging") | .id' <<<"$branches")
is_default=$(jq -r '.branches[] | select(.name == "staging") | (.default // false) or (.primary // false)' <<<"$branches")
[ "$is_default" = false ] || die "the branch named staging is the default branch; refusing"
main=$(jq -r '[.branches[] | select((.default // false) or (.primary // false))][0].id // empty' <<<"$branches")
[ -n "$main" ] || die "no default branch found, so Neon main cannot be told apart"
[ "$main" != "$staging" ] || die "staging is main; refusing"

rw() { neon "/branches/$1/endpoints" | jq -r '[.endpoints[] | select(.type == "read_write")][0] | "\(.id) \(.host)"'; }
read -r endpoint host <<<"$(rw "$staging")"
read -r _ main_host <<<"$(rw "$main")"
[ -n "$host" ] && [ "$host" != null ] || die "staging has no read-write compute"
[ -n "$main_host" ] && [ "$main_host" != null ] || die "main has no read-write compute to record"
[ "$host" != "$main_host" ] || die "staging and main share a host; refusing"
case "$host" in *-pooler.*) die "staging's host is a pooled endpoint" ;; esac

dbs=$(neon "/branches/$staging/databases")
db=$(jq -r '[.databases[] | select(.name != "postgres")] | if length == 1 then .[0].name else empty end' <<<"$dbs")
[ -n "$db" ] || die "expected one application database on staging"
owner=$(jq -r --arg d "$db" '.databases[] | select(.name == $d) | .owner_name' <<<"$dbs")
url=$(neon "/connection_uri?branch_id=$staging&database_name=$db&role_name=$owner&pooled=false" | jq -r .uri)
case "$url" in postgres://* | postgresql://*) ;; *) die "Neon gave no connection string" ;; esac
case "$url" in *"$main_host"*) die "the connection string names main's host; refusing" ;; esac

mask "$url"
mask "$host"
mask "$main_host"
printf 'STAGING_BRANCH_ID=%s\nSTAGING_ENDPOINT_ID=%s\nSTAGING_HOST=%s\nSTAGING_DB=%s\nNEON_MAIN_HOST=%s\nSTAGING_ADMIN_URL=%s\n' \
  "$staging" "$endpoint" "$host" "$db" "$main_host" "$url"
