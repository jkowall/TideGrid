#!/usr/bin/env bash
# Restore one TideGrid logical backup into an empty, throwaway database, then
# check it against its manifest (hosting plan: restore to a new standard
# PostgreSQL target and pass tenant, ledger, and checkout checks).
#
#   TARGET_DATABASE_URL=<admin URL of an EMPTY database> \
#   tools/backup/restore.sh --backup <file.dump.age> --manifest <file.json> \
#     --identity <age private key file> --throwaway
#
# Refuses unless --throwaway is given and the target has no tables in public
# or app, so it can never restore over a live database. The plaintext dump
# lives in a private temporary directory and is removed on exit.
#
# Roles: pg_dump leaves roles out. Each role the manifest lists that the target
# lacks is created without login, so ownership and grants come back as they
# were. tidegrid_app gets no password here; give it one only if an app will
# connect (pnpm --filter @tidegrid/database app-role:password).
set -euo pipefail
umask 077

here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=tools/backup/lib.sh
. "$here/lib.sh"

backup=""
manifest=""
identity=""
throwaway=0
no_owner=0
while [ $# -gt 0 ]; do
  case "$1" in
    --backup) backup=${2:-}; shift 2 ;;
    --manifest) manifest=${2:-}; shift 2 ;;
    --identity) identity=${2:-}; shift 2 ;;
    --throwaway) throwaway=1; shift ;;
    # For a target where the restoring role cannot own objects as another
    # role (a managed database without superuser). Ownership then goes to the
    # restoring role, and FORCE row-level security still applies to
    # tidegrid_app, which never owns tables.
    --no-owner) no_owner=1; shift ;;
    *) tg_die "unknown argument $1" ;;
  esac
done
[ "$throwaway" = 1 ] || tg_die "add --throwaway: a restore goes only into a new, empty database, never over a live one"
[ -f "$backup" ] || tg_die "--backup <file.dump.age> is required"
[ -f "$manifest" ] || tg_die "--manifest <file.json> is required"
[ -f "$identity" ] || tg_die "--identity <age private key file> is required"
[ -n "${TARGET_DATABASE_URL:-}" ] || tg_die "TARGET_DATABASE_URL is not set"
tg_need psql pg_restore age python3

manifest_value() {
  python3 -I -c 'import json,sys; v=json.load(open(sys.argv[1]))[sys.argv[2]]; print("\n".join(v) if isinstance(v, list) else v)' "$manifest" "$1"
}

started=$(date -u +%s)

# The target must be empty.
existing=$(tg_psql "$TARGET_DATABASE_URL" -c "select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('public', 'app') and c.relkind in ('r', 'p')")
[ "$existing" = 0 ] || tg_die "the target already has $existing tables in public or app; restore only into an empty database"

want=$(manifest_value encryptedSha256)
got=$(tg_sha256 "$backup")
[ "$want" = "$got" ] || tg_die "the backup file's sha256 does not match its manifest"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
age --decrypt --identity "$identity" --output "$work/backup.dump" "$backup"
[ "$(manifest_value dumpSha256)" = "$(tg_sha256 "$work/backup.dump")" ] || tg_die "the decrypted dump's sha256 does not match its manifest"
decrypted=$(date -u +%s)

# Roles first.
while read -r role; do
  [ -n "$role" ] || continue
  [[ "$role" =~ ^[a-z_][a-z0-9_]*$ ]] || tg_die "unexpected role name in the manifest"
  psql -X -q -v ON_ERROR_STOP=1 "$TARGET_DATABASE_URL" -v role="$role" <<'SQL'
select format('create role %I nologin', :'role')
 where not exists (select 1 from pg_roles where rolname = :'role') \gexec
SQL
done < <(manifest_value roles)

# Leave out extensions TideGrid does not use (a managed provider's own), so a
# plain PostgreSQL target accepts the rest. The schema's own extension,
# btree_gist, and plpgsql stay.
pg_restore --list "$work/backup.dump" > "$work/toc.full"
awk '
  / EXTENSION / || / COMMENT - EXTENSION / {
    keep = ($0 ~ / EXTENSION - (btree_gist|plpgsql) / || $0 ~ / COMMENT - EXTENSION (btree_gist|plpgsql) /)
    if (!keep) { print ";" $0; next }
  }
  { print }
' "$work/toc.full" > "$work/toc.list"
skipped=$(grep -c '^;[0-9]' "$work/toc.list" || true)

owner_flag=()
[ "$no_owner" = 1 ] && owner_flag=(--no-owner)
pg_restore --dbname="$TARGET_DATABASE_URL" --use-list="$work/toc.list" --exit-on-error \
  --single-transaction ${owner_flag[@]+"${owner_flag[@]}"} "$work/backup.dump"
restored=$(date -u +%s)

# Database-level settings live outside pg_dump. Migration 0002 revokes
# TEMPORARY from PUBLIC so the runtime role cannot make temporary tables.
psql -X -q -v ON_ERROR_STOP=1 "$TARGET_DATABASE_URL" \
  -c "do \$\$ begin execute format('revoke temporary on database %I from public', current_database()); end \$\$;"

echo "restored $(manifest_value file): decrypt $(tg_seconds "$started" "$decrypted") s, restore $(tg_seconds "$decrypted" "$restored") s; left out $skipped provider extension entries"
TARGET_DATABASE_URL="$TARGET_DATABASE_URL" python3 -I "$here/verify.py" --manifest "$manifest" --expect-exact
finished=$(date -u +%s)
echo "restore drill total $(tg_seconds "$started" "$finished") s"
