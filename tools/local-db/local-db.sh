#!/usr/bin/env bash
# A throwaway PostgreSQL 17 for TideGrid's database-backed tests, on this
# machine or in CI, with no Neon and no cloud service. CI runs the same
# commands, so a local run and a CI run use the same image and the same steps.
#
#   local-db.sh up             start a fresh container, wait for it, print the
#                              DATABASE_URL and TIDEGRID_EPHEMERAL_DB lines
#   local-db.sh env            print those lines again (KEY=VALUE)
#   local-db.sh prepare <kind> migrate and seed for one job:
#                                integration  migrate and seed
#                                guest-e2e    plus local hostnames, the runtime
#                                             role, a third host for the second
#                                             tenant, and the API's .dev.vars
#                                console-e2e  plus local hostnames, the runtime
#                                             role, a booking staff member at the
#                                             second operator, and .dev.vars
#   local-db.sh api <port> <log> [wrangler dev args...]
#                              start the API in `wrangler dev --env dev` in the
#                              background and wait until its database answers
#   local-db.sh api-stop <port> stop the API that `api` started on that port
#   local-db.sh psql [args]    psql inside the container, as the admin
#   local-db.sh down           remove the container and restore .dev.vars
#   local-db.sh test [part...] the local one command (`pnpm test:local-db`):
#                              integration, guest, console, or all (default).
#                              Each part gets a fresh container, as each CI job
#                              gets a fresh database.
#
# Parallel lanes: integration runs in two checkouts at once need distinct
# TIDEGRID_LOCAL_DB_NAME (starting tidegrid-local-db) and
# TIDEGRID_LOCAL_DB_PORT values. The browser parts use fixed ports (8961,
# 8981, 5361, 5382), so only one checkout at a time can run them.
#
# The container engine is podman, or docker when podman is absent; set
# TIDEGRID_LOCAL_DB_ENGINE to choose. On a Mac, podman needs a running machine
# (`podman machine start`). The container listens on 127.0.0.1 only.
#
# The admin password below is a fixed throwaway test value for a container
# that lives for one run on the loopback interface. It is not a credential for
# anything else. The runtime role's password is random for every prepare.
# Integration suites rotate the runtime role's password, so this script points
# them only at its own container, never at Neon.

set -euo pipefail

# postgres 17.11 on Debian trixie, the multi-architecture index digest, so
# arm64 Macs and amd64 runners resolve the same release. Change it on purpose:
# the zone-data suite compares the image's tzdata with Node's.
IMAGE="docker.io/library/postgres:17.11@sha256:31ba9c94a03ada9988f2bb493a22a75eef3a185884533e5cdbcd498ea835b08f"
NAME="${TIDEGRID_LOCAL_DB_NAME:-tidegrid-local-db}"
PORT="${TIDEGRID_LOCAL_DB_PORT:-55432}"
ADMIN_USER="postgres"
ADMIN_PASSWORD="postgres"
DB_NAME="tidegrid"
LABEL="io.tidegrid.local-db=1"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEV_VARS="$ROOT/apps/api-worker/.dev.vars"
DEV_VARS_ENV="$ROOT/apps/api-worker/.dev.vars.dev"
MARKER="# Written by tools/local-db/local-db.sh for a throwaway local database."
STATE_DIR="$ROOT/node_modules/.cache/tidegrid-local-db"

ADMIN_URL="postgresql://$ADMIN_USER:$ADMIN_PASSWORD@127.0.0.1:$PORT/$DB_NAME"

log() { printf 'local-db: %s\n' "$*" >&2; }
die() {
  log "$*"
  exit 1
}

case "$NAME" in
tidegrid-local-db*) ;;
*) die "TIDEGRID_LOCAL_DB_NAME must start with tidegrid-local-db (got $NAME)." ;;
esac

engine() {
  if [ -n "${TIDEGRID_LOCAL_DB_ENGINE:-}" ]; then
    printf '%s' "$TIDEGRID_LOCAL_DB_ENGINE"
  elif command -v podman >/dev/null 2>&1; then
    printf 'podman'
  elif command -v docker >/dev/null 2>&1; then
    printf 'docker'
  fi
}

ENGINE="$(engine)"

check_engine() {
  [ -n "$ENGINE" ] || die "Neither podman nor docker is on PATH. Install one (owner decision) or set TIDEGRID_LOCAL_DB_ENGINE."
  if ! "$ENGINE" info >/dev/null 2>&1; then
    if [ "$ENGINE" = podman ] && [ "$(uname -s)" = Darwin ]; then
      die "podman cannot reach its machine. Start it with: podman machine start"
    fi
    die "$ENGINE is not running or not reachable."
  fi
}

container_exists() {
  "$ENGINE" container inspect "$NAME" >/dev/null 2>&1
}

# Removes this checkout's container. Refuses one this script did not create,
# and one another checkout created, so a second lane cannot drop the first
# lane's database mid-run. Returns 1 when there was nothing to remove.
remove_container() {
  container_exists || return 1
  local label root
  label="$("$ENGINE" container inspect --format '{{ index .Config.Labels "io.tidegrid.local-db" }}' "$NAME" 2>/dev/null || true)"
  if [ "$label" != "1" ]; then
    die "A container named $NAME exists but this script did not create it; remove or rename it first."
  fi
  root="$("$ENGINE" container inspect --format '{{ index .Config.Labels "io.tidegrid.local-db.root" }}' "$NAME" 2>/dev/null || true)"
  if [ "$root" != "$ROOT" ]; then
    die "$NAME belongs to the checkout at $root. For a parallel lane set TIDEGRID_LOCAL_DB_NAME and TIDEGRID_LOCAL_DB_PORT; if that checkout is gone, run: $ENGINE rm -f -v $NAME"
  fi
  "$ENGINE" rm -f -v "$NAME" >/dev/null
}

print_env() {
  printf 'DATABASE_URL=%s\n' "$ADMIN_URL"
  printf 'TIDEGRID_EPHEMERAL_DB=1\n'
}

cmd_up() {
  check_engine
  remove_container || true
  log "starting $NAME from $IMAGE on 127.0.0.1:$PORT"
  "$ENGINE" run -d --name "$NAME" --label "$LABEL" --label "io.tidegrid.local-db.root=$ROOT" \
    -e POSTGRES_USER="$ADMIN_USER" -e POSTGRES_PASSWORD="$ADMIN_PASSWORD" -e POSTGRES_DB="$DB_NAME" \
    -p "127.0.0.1:$PORT:5432" "$IMAGE" >/dev/null
  local i
  # pg_isready over TCP inside the container: the image's first-boot server
  # listens on the socket only, so this answers once the real server is up.
  for i in $(seq 1 90); do
    if "$ENGINE" exec "$NAME" pg_isready -q -h 127.0.0.1 -U "$ADMIN_USER" -d "$DB_NAME" >/dev/null 2>&1; then
      break
    fi
    if [ "$i" = 90 ]; then
      "$ENGINE" logs "$NAME" >&2 || true
      die "PostgreSQL did not become ready in 90 s."
    fi
    sleep 1
  done
  # The host side of the port forward (gvproxy on a Mac) can lag the server.
  for i in $(seq 1 30); do
    if (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then
      break
    fi
    if [ "$i" = 30 ]; then die "127.0.0.1:$PORT did not accept connections in 30 s."; fi
    sleep 1
  done
  log "ready: $("$ENGINE" exec "$NAME" psql -U "$ADMIN_USER" -d "$DB_NAME" -Atc 'show server_version')"
  print_env
}

cmd_down() {
  restore_dev_vars
  if [ -n "$ENGINE" ] && "$ENGINE" info >/dev/null 2>&1 && remove_container; then
    log "removed $NAME"
  fi
}

cmd_psql() {
  "$ENGINE" exec -i "$NAME" psql -U "$ADMIN_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 "$@"
}

# A .dev.vars or .dev.vars.dev this script did not write is moved aside, so a
# local run never overwrites the owner's own values, and `down` puts it back.
set_aside() {
  local file="$1"
  if [ -f "$file" ] && ! grep -qxF "$MARKER" "$file"; then
    if [ -e "$file.local-db-backup" ]; then
      die "$file.local-db-backup exists from an earlier run; restore or remove it first."
    fi
    mv "$file" "$file.local-db-backup"
    log "moved your $(basename "$file") aside; local-db.sh down restores it"
  fi
}

restore_dev_vars() {
  local file
  for file in "$DEV_VARS" "$DEV_VARS_ENV"; do
    if [ -f "$file" ] && grep -qxF "$MARKER" "$file"; then rm -f "$file"; fi
    if [ -f "$file.local-db-backup" ]; then
      if [ -e "$file" ]; then
        # A newer file of the owner's own: never overwrite it with the backup.
        log "kept both $(basename "$file") and $(basename "$file").local-db-backup; merge them by hand"
      else
        mv "$file.local-db-backup" "$file"
        log "restored $(basename "$file")"
      fi
    fi
  done
}

runtime_role_and_dev_vars() {
  local password
  password="$(openssl rand -hex 24)"
  TIDEGRID_APP_PASSWORD="$password" pnpm --filter @tidegrid/database app-role:password
  set_aside "$DEV_VARS"
  set_aside "$DEV_VARS_ENV"
  (
    umask 077
    printf '%s\nDATABASE_URL=postgresql://tidegrid_app:%s@127.0.0.1:%s/%s\nFAKE_PAYMENT_WEBHOOK_SECRET=%s\n' \
      "$MARKER" "$password" "$PORT" "$DB_NAME" "$(openssl rand -hex 32)" >"$DEV_VARS"
  )
}

cmd_prepare() {
  local kind="${1:-}"
  export DATABASE_URL="$ADMIN_URL" TIDEGRID_EPHEMERAL_DB=1
  cd "$ROOT"
  case "$kind" in
  integration)
    pnpm db:migrate
    pnpm db:seed
    ;;
  guest-e2e)
    pnpm db:migrate
    SEED_LOCAL_HOSTNAMES=1 pnpm db:seed
    # A third host for the second tenant, which the journey disables.
    cmd_psql -c "insert into public.tenant_hostnames (hostname, tenant_id, kind, status, verified_at) select 'reef-e2e.book.localhost', id, 'preview', 'active', now() from public.tenants where slug = 'demo-reef'"
    runtime_role_and_dev_vars
    ;;
  console-e2e)
    pnpm db:migrate
    # Local guest hosts, so the confirmation email's link has a verified host.
    SEED_LOCAL_HOSTNAMES=1 pnpm db:seed
    # A booking staff member at the second operator, for its journey. The
    # identity comes from app.ensure_staff_user, the one path 0002 gives,
    # inside that operator's tenant context.
    cmd_psql -c "begin; select set_config('app.tenant_id', (select id::text from public.tenants where slug = 'demo-reef'), true); insert into public.tenant_memberships (tenant_id, user_id, role, display_name) select t.id, app.ensure_staff_user('dan.desk@demo-reef.test', 'ci-console-browser'), 'booking_staff', 'Dan Desk' from public.tenants t where t.slug = 'demo-reef' on conflict do nothing; commit;"
    runtime_role_and_dev_vars
    ;;
  *) die "prepare needs one of: integration, guest-e2e, console-e2e" ;;
  esac
}

cmd_api() {
  local port="${1:?api needs a port}" logfile="${2:?api needs a log file}"
  shift 2
  cd "$ROOT"
  mkdir -p "$STATE_DIR"
  if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
    die "port $port is already in use; stop that server first (another checkout's API?)"
  fi
  # Inspector on 9000 + the last three digits, as CI had it (8961 -> 9961).
  nohup pnpm --filter @tidegrid/api-worker exec wrangler dev --env dev --port "$port" \
    --inspector-port "$((9000 + port % 1000))" "$@" >"$logfile" 2>&1 &
  local pid=$! i
  echo "$pid" >"$STATE_DIR/api-$port.pid"
  for i in $(seq 1 90); do
    if ! kill -0 "$pid" 2>/dev/null; then
      cat "$logfile" >&2
      die "the API on $port exited before it reported its database"
    fi
    if curl -fsS --max-time 5 "http://localhost:$port/v1/health" 2>/dev/null | grep -q '"database":"ok"'; then
      log "API on $port is up with its database"
      return 0
    fi
    sleep 1
  done
  cat "$logfile" >&2
  die "the API on $port did not report its database within 90 s"
}

kill_tree() {
  local pid="$1" child
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do kill_tree "$child"; done
  kill "$pid" 2>/dev/null || true
}

cmd_api_stop() {
  local port="${1:?api-stop needs a port}" pidfile="$STATE_DIR/api-${1}.pid"
  if [ -f "$pidfile" ]; then
    local pid
    pid="$(cat "$pidfile")"
    # Only the API this script started: a stale file can name a reused PID.
    if ps -o command= -p "$pid" 2>/dev/null | grep -q -- "wrangler dev --env dev --port $port"; then
      kill_tree "$pid"
    fi
    rm -f "$pidfile"
  fi
}

# --- the local one command -------------------------------------------------

part_integration() {
  cmd_up >/dev/null
  cmd_prepare integration
  pnpm test:integration
}

part_guest() {
  VITE_API_BASE=http://localhost:8961 GUEST_LOCAL_API=http://localhost:8961 \
    pnpm --filter @tidegrid/guest-site build
  log "guest Part A, stub gateway, no database"
  pnpm --filter @tidegrid/guest-site e2e
  cmd_up >/dev/null
  cmd_prepare guest-e2e
  cmd_api 8961 "$LOG_DIR/api-8961.log" --var "GUEST_LINK_ORIGIN:http://{slug}.book.localhost:5361"
  log "guest Part B, two brands against the API and the database"
  E2E_MODE=full E2E_DISABLE_HOST=reef-e2e.book.localhost E2E_ADMIN_DATABASE_URL="$ADMIN_URL" \
    pnpm --filter @tidegrid/guest-site e2e
  cmd_api_stop 8961
}

part_console() {
  pnpm --filter @tidegrid/operator-site build
  cmd_up >/dev/null
  cmd_prepare console-e2e
  cmd_api 8981 "$LOG_DIR/api-8981.log" \
    --var "STAFF_ORIGINS:http://localhost:5382" --var "ALLOWED_ORIGINS:http://localhost:5382" \
    --var "GUEST_LINK_ORIGIN:http://{slug}.book.localhost:5361"
  log "console journeys at 375 and 1280, both operators"
  pnpm --filter @tidegrid/operator-site e2e
  cmd_api_stop 8981
}

cleanup_test() {
  local status=$?
  cmd_api_stop 8961 || true
  cmd_api_stop 8981 || true
  cmd_down || true
  if [ "$status" != 0 ]; then log "failed; API logs are in $LOG_DIR"; fi
  exit "$status"
}

cmd_test() {
  local parts="" part started
  [ $# -gt 0 ] || set -- all
  for part in "$@"; do
    case "$part" in
    all) parts="integration guest console" ;;
    integration | guest | console) parts="$parts $part" ;;
    *) die "test parts are integration, guest, console, or all (got $part)" ;;
    esac
  done
  if [ -n "${DATABASE_URL:-}" ] && [ "$DATABASE_URL" != "$ADMIN_URL" ]; then
    log "ignoring the DATABASE_URL in this shell; this run uses only its own container"
  fi
  export DATABASE_URL="$ADMIN_URL" TIDEGRID_EPHEMERAL_DB=1
  check_engine
  cd "$ROOT"
  mkdir -p "$STATE_DIR"
  LOG_DIR="$(mktemp -d "${TMPDIR:-/tmp}/tidegrid-local-db.XXXXXX")"
  trap cleanup_test EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  started=$(date +%s)
  for part in $parts; do
    log "=== $part ==="
    "part_$part"
  done
  log "all parts passed ($(echo $parts)) in $(($(date +%s) - started)) s"
}

main() {
  local cmd="${1:-}"
  [ $# -gt 0 ] && shift
  case "$cmd" in
  up) cmd_up ;;
  down) cmd_down ;;
  env) print_env ;;
  prepare) cmd_prepare "$@" ;;
  api) cmd_api "$@" ;;
  api-stop) cmd_api_stop "$@" ;;
  psql) cmd_psql "$@" ;;
  test) cmd_test "$@" ;;
  *)
    awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "${BASH_SOURCE[0]}" >&2
    exit 2
    ;;
  esac
}

main "$@"
