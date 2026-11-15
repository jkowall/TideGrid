#!/usr/bin/env bash
# TideGrid logical backup (hosting plan, backup and disaster recovery).
#
#   DATABASE_URL=<direct, unpooled admin URL> \
#   BACKUP_AGE_RECIPIENT=<age public key> \
#   tools/backup/backup.sh --label <environment> --out <directory>
#
# Writes two files to --out:
#   tidegrid-<label>-<UTC stamp>.dump.age   the pg_dump custom-format file,
#                                           encrypted to the age public key
#   tidegrid-<label>-<UTC stamp>.json       the manifest: migrations, every
#                                           table's row count and row digest,
#                                           checksums, sizes, and timings
#
# The dump and the manifest's counts come from one exported snapshot, so a
# restore that matches the manifest matches the database at one instant.
# The snapshot needs a direct connection; a pooled (PgBouncer) URL fails.
#
# Only the public key is needed here. The private key that decrypts a backup
# never comes near this script, the database, or the Cloudflare account. The
# plaintext dump lives in a private temporary directory and is removed on
# exit. Nothing here prints a row's contents, a host, or a connection string.
set -euo pipefail
umask 077

here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=tools/backup/lib.sh
. "$here/lib.sh"

label=""
out=""
while [ $# -gt 0 ]; do
  case "$1" in
    --label) label=${2:-}; shift 2 ;;
    --out) out=${2:-}; shift 2 ;;
    *) tg_die "unknown argument $1" ;;
  esac
done
[[ "$label" =~ ^[a-z0-9-]{1,40}$ ]] || tg_die "--label must be lower-case letters, digits, and dashes"
[ -n "$out" ] || tg_die "--out <directory> is required"
[ -n "${DATABASE_URL:-}" ] || tg_die "DATABASE_URL is not set"
[[ "${BACKUP_AGE_RECIPIENT:-}" =~ ^age1[a-z0-9]{58}$ ]] || tg_die "BACKUP_AGE_RECIPIENT must be one age public key (age1...)"
case "$DATABASE_URL" in
  *-pooler.*) tg_die "use the direct endpoint, not the pooled one: a pooled connection cannot share its snapshot with pg_dump" ;;
esac
tg_need psql pg_dump pg_restore age awk
mkdir -p "$out"

work=$(mktemp -d)
cleanup() {
  # The plaintext dump never outlives the run.
  rm -rf "$work"
  [ -n "${snap_pid:-}" ] && kill "$snap_pid" 2>/dev/null || true
}
trap cleanup EXIT

started=$(date -u +%s)
stamp=$(date -u -d "@$started" +%Y%m%dT%H%M%SZ 2>/dev/null || date -u -r "$started" +%Y%m%dT%H%M%SZ)
base="tidegrid-$label-$stamp"

# The dumping role must read every row. Tables force row-level security:
# pg_dump refuses such a role, and the manifest's counts would read nothing.
bypass=$(tg_psql "$DATABASE_URL" -c "select rolsuper or rolbypassrls from pg_roles where rolname = current_user")
[ "$bypass" = t ] || tg_die "the connecting role cannot bypass row-level security, so the dump would miss rows; use the owner role"

# One repeatable-read transaction holds the snapshot open while pg_dump and the
# table facts read from it. Its session stays open in the background.
mkfifo "$work/in" "$work/snap-out"
PGOPTIONS="-c TimeZone=UTC" psql -X -A -t -q -v ON_ERROR_STOP=1 "$DATABASE_URL" < "$work/in" > "$work/snap-out" &
snap_pid=$!
exec 3> "$work/in" 4< "$work/snap-out"
printf '%s\n' "begin isolation level repeatable read read only;" "select pg_export_snapshot();" >&3
read -r -t 60 snapshot <&4 || tg_die "could not export a snapshot"
[[ "$snapshot" =~ ^[0-9A-F-]+$ ]] || tg_die "unexpected snapshot id"

# Facts in the same snapshot, ended by a marker line.
printf '%s\n' "$TG_MIGRATIONS_SQL" "select '--end-migrations--';" "$(cat "$here/table-facts.sql")" "select '--end-tables--';" \
  "$(cat "$here/security-facts.sql")" "select '--end-security--';" >&3
: > "$work/migrations.txt"
while read -r -t 600 line <&4; do
  [ "$line" = "--end-migrations--" ] && break
  printf '%s\n' "$line" >> "$work/migrations.txt"
done
: > "$work/tables.txt"
while read -r -t 600 line <&4; do
  [ "$line" = "--end-tables--" ] && break
  printf '%s\n' "$line" >> "$work/tables.txt"
done
: > "$work/security.txt"
while read -r -t 600 line <&4; do
  [ "$line" = "--end-security--" ] && break
  printf '%s\n' "$line" >> "$work/security.txt"
done
[ "$(wc -l < "$work/security.txt" | tr -d ' ')" = 2 ] || tg_die "could not read the policy and grant facts"
[ -s "$work/migrations.txt" ] || tg_die "no applied migrations found"
[ -s "$work/tables.txt" ] || tg_die "no tables found"

server_version=$(tg_psql "$DATABASE_URL" -c "show server_version_num")
# Roles are cluster objects that pg_dump leaves out. A restore creates any that
# are missing, without login, so ownership and grants come back as they were.
tg_psql "$DATABASE_URL" -c "select rolname from pg_roles where rolname !~ '^pg_' order by 1" > "$work/roles.txt"
grep -Eqx 'tidegrid_app' "$work/roles.txt" || tg_die "the runtime role tidegrid_app is missing"
grep -Evqx '[a-z_][a-z0-9_]*' "$work/roles.txt" && tg_die "a role name has characters the manifest does not allow"
# Roles that bypass row-level security. A restore recreates them with that
# right, because SECURITY DEFINER functions they own depend on it.
tg_psql "$DATABASE_URL" -c "select rolname from pg_roles where rolname !~ '^pg_' and (rolsuper or rolbypassrls) order by 1" > "$work/bypass.txt"
dump_started=$(date -u +%s)
pg_dump --dbname="$DATABASE_URL" --snapshot="$snapshot" --format=custom --compress=6 \
  --file="$work/$base.dump"
dump_finished=$(date -u +%s)

# Release the snapshot.
printf '%s\n' "commit;" "\\q" >&3
exec 3>&- 4<&-
wait "$snap_pid" 2>/dev/null || true
snap_pid=""

# The dump must read back: pg_restore lists its table of contents.
toc_entries=$(pg_restore --list "$work/$base.dump" | grep -vc '^;' || true)
[ "$toc_entries" -gt 0 ] || tg_die "the dump's table of contents is empty"
table_data=$(pg_restore --list "$work/$base.dump" | grep -c ' TABLE DATA ' || true)
dump_sha=$(tg_sha256 "$work/$base.dump")
dump_bytes=$(tg_size "$work/$base.dump")

age --encrypt --recipient "$BACKUP_AGE_RECIPIENT" --output "$out/$base.dump.age" "$work/$base.dump"
enc_sha=$(tg_sha256 "$out/$base.dump.age")
enc_bytes=$(tg_size "$out/$base.dump.age")
finished=$(date -u +%s)

table_count=$(wc -l < "$work/tables.txt" | tr -d ' ')
[ "$table_data" -le "$table_count" ] || tg_die "the dump has more table data entries ($table_data) than tables ($table_count)"

{
  printf '{\n'
  printf '  "format": "tidegrid-backup-1",\n'
  printf '  "label": "%s",\n' "$label"
  printf '  "file": "%s.dump.age",\n' "$base"
  printf '  "startedAt": "%s",\n' "$(date -u -d "@$started" +%FT%TZ 2>/dev/null || date -u -r "$started" +%FT%TZ)"
  printf '  "dumpSeconds": %s,\n' "$(tg_seconds "$dump_started" "$dump_finished")"
  printf '  "totalSeconds": %s,\n' "$(tg_seconds "$started" "$finished")"
  printf '  "serverVersionNum": %s,\n' "$server_version"
  printf '  "pgDumpVersion": "%s",\n' "$(pg_dump --version | awk '{print $3}')"
  printf '  "encryptedSha256": "%s",\n' "$enc_sha"
  printf '  "encryptedBytes": %s,\n' "$enc_bytes"
  printf '  "dumpSha256": "%s",\n' "$dump_sha"
  printf '  "dumpBytes": %s,\n' "$dump_bytes"
  printf '  "tocEntries": %s,\n' "$toc_entries"
  printf '  "lastMigration": "%s",\n' "$(tail -1 "$work/migrations.txt")"
  awk -F'|' '{printf "  \"%s\": {\"count\": %s, \"digest\": \"%s\"},\n", $1, $2, $3}' "$work/security.txt"
  printf '  "roles": [%s],\n' "$(awk 'NR>1{printf ", "} {printf "\"%s\"", $0}' "$work/roles.txt")"
  printf '  "bypassRoles": [%s],\n' "$(awk 'NR>1{printf ", "} {printf "\"%s\"", $0}' "$work/bypass.txt")"
  printf '  "migrations": [\n'
  awk 'NR>1{printf ",\n"} {printf "    \"%s\"", $0} END{printf "\n"}' "$work/migrations.txt"
  printf '  ],\n'
  printf '  "tables": [\n'
  awk -F'|' 'NR>1{printf ",\n"} {printf "    {\"name\": \"%s\", \"rows\": %s, \"digest\": \"%s\", \"forceRls\": %s}", $1, $2, $3, ($4=="t"?"true":"false")} END{printf "\n"}' "$work/tables.txt"
  printf '  ]\n'
  printf '}\n'
} > "$out/$base.json"

rows=$(awk -F'|' '{s+=$2} END{print s+0}' "$work/tables.txt")
echo "backup $base: $table_count tables, $rows rows, last migration $(tail -1 "$work/migrations.txt"), dump ${dump_bytes} bytes in $(tg_seconds "$dump_started" "$dump_finished") s, encrypted ${enc_bytes} bytes"
echo "files: $out/$base.dump.age $out/$base.json"
