#!/usr/bin/env bash
# How old is the newest backup in the backup bucket? Fails when it is older
# than the limit, so a missed or broken daily backup turns a check red.
#
#   R2_ENDPOINT=... R2_BUCKET=... AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... \
#   tools/backup/backup-age.sh [--max-hours 26] [--prefix daily/]
#
# Read-only: it lists object names and times, never downloads one. Prints one
# line: the newest manifest's name and age in hours.
set -euo pipefail

max_hours=26
prefix="daily/"
while [ $# -gt 0 ]; do
  case "$1" in
    --max-hours) max_hours=${2:-}; shift 2 ;;
    --prefix) prefix=${2:-}; shift 2 ;;
    *) echo "backup-age: unknown argument $1" >&2; exit 2 ;;
  esac
done
[[ "$max_hours" =~ ^[0-9]{1,4}$ ]] || { echo "backup-age: --max-hours takes whole hours" >&2; exit 2; }
: "${R2_ENDPOINT:?R2_ENDPOINT is not set}" "${R2_BUCKET:?R2_BUCKET is not set}"
export AWS_DEFAULT_REGION=auto AWS_REQUEST_CHECKSUM_CALCULATION=when_required AWS_RESPONSE_CHECKSUM_VALIDATION=when_required

# Manifests only: a manifest is written after its dump, so it marks a
# finished backup.
# A listing error (credentials, endpoint) is its own failure, not "no backup".
if ! newest=$(aws s3api list-objects-v2 --endpoint-url "$R2_ENDPOINT" --bucket "$R2_BUCKET" --prefix "$prefix" \
  --query 'sort_by(Contents[?ends_with(Key, `.json`)] || `[]`, &LastModified)[-1].[Key, LastModified]' --output text 2> /tmp/backup-age.err.$$); then
  echo "backup-age: FAIL could not list the backup bucket ($(grep -o 'An error occurred ([A-Za-z]*)' /tmp/backup-age.err.$$ | head -1))"
  rm -f /tmp/backup-age.err.$$
  exit 1
fi
rm -f /tmp/backup-age.err.$$
if [ -z "$newest" ] || [ "$newest" = "None" ]; then
  echo "backup-age: FAIL no backup manifest under $prefix"
  exit 1
fi
key=$(printf '%s' "$newest" | awk '{print $1}')
when=$(printf '%s' "$newest" | awk '{print $2}')
then_s=$(date -u -d "$when" +%s)
age_s=$(( $(date -u +%s) - then_s ))
age_h=$(( age_s / 3600 ))
if [ "$age_s" -gt $(( max_hours * 3600 )) ]; then
  echo "backup-age: FAIL newest backup $(basename "$key") is ${age_h} h old (limit ${max_hours} h)"
  exit 1
fi
echo "backup-age: ok newest backup $(basename "$key") is ${age_h} h old (limit ${max_hours} h)"
