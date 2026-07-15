#!/bin/sh
set -eu

DATABASE_URL=$(printenv DATABASE_URL || true)
if [ -z "$DATABASE_URL" ]; then
  printf '%s\n' "Set DATABASE_URL to a disposable database with schema.sql and acceptance-tests.sql applied"
  exit 2
fi

PSQL="psql -X -q -v ON_ERROR_STOP=1 $DATABASE_URL"
TMP_DIR=$(mktemp -d /tmp/tidegrid-concurrency.XXXXXX)
TENANT=00000000-0000-0000-0000-000000000001

assert_one_success() {
  label=$1
  first=$2
  second=$3
  successes=0
  [ "$first" -eq 0 ] && successes=$((successes + 1))
  [ "$second" -eq 0 ] && successes=$((successes + 1))
  if [ "$successes" -ne 1 ]; then
    printf '%s\n' "$label expected exactly one success, got $successes"
    sed -n '1,80p' "$TMP_DIR/$label.1"
    sed -n '1,80p' "$TMP_DIR/$label.2"
    exit 1
  fi
  printf '%s\n' "$label: one winner, one deterministic rejection"
}

run_pair() {
  label=$1
  sql_one=$2
  sql_two=$3
  set +e
  $PSQL -c "$sql_one" >"$TMP_DIR/$label.1" 2>&1 &
  pid_one=$!
  $PSQL -c "$sql_two" >"$TMP_DIR/$label.2" 2>&1 &
  pid_two=$!
  wait "$pid_one"
  status_one=$?
  wait "$pid_two"
  status_two=$?
  set -e
  assert_one_success "$label" "$status_one" "$status_two"
}

$PSQL <<SQL
DELETE FROM capacity_holds WHERE tenant_id = '$TENANT';
UPDATE capacity_buckets
   SET held_quantity = 0, confirmed_quantity = 0
 WHERE tenant_id = '$TENANT'
   AND id = '00000000-0000-0000-0000-000000000081';
DELETE FROM equipment_holds WHERE tenant_id = '$TENANT';
UPDATE equipment_pools
   SET held_quantity = 0, allocated_quantity = 0,
       cleaning_quantity = 0, maintenance_quantity = 0
 WHERE tenant_id = '$TENANT'
   AND id = '00000000-0000-0000-0000-0000000000a1';

INSERT INTO package_accounts (
  tenant_id, id, package_id, ownership_type, unit_code,
  available_balance, secure_code_hash
) VALUES (
  '$TENANT', '00000000-0000-0000-0000-000000000093',
  '00000000-0000-0000-0000-000000000091',
  'named', 'trip', 1, digest('concurrent-package-code', 'sha256')
);

INSERT INTO resources (
  tenant_id, id, location_id, resource_type, name
) VALUES
  ('$TENANT', '00000000-0000-0000-0000-0000000000d3',
   '00000000-0000-0000-0000-000000000021', 'vessel', 'Concurrent Vessel'),
  ('$TENANT', '00000000-0000-0000-0000-0000000000d4',
   '00000000-0000-0000-0000-000000000021', 'crew', 'Concurrent Captain');
SQL

run_pair capacity \
"BEGIN; SET LOCAL app.tenant_id = '$TENANT';
 SELECT app.acquire_capacity_hold(
  '$TENANT','00000000-0000-0000-0000-000000000081',
  '00000000-0000-0000-0000-000000000071',1,
  transaction_timestamp()+interval '15 minutes',
  '00000000-0000-0000-0000-000000000281');
 SELECT pg_sleep(1); COMMIT;" \
"BEGIN; SET LOCAL app.tenant_id = '$TENANT';
 SELECT app.acquire_capacity_hold(
  '$TENANT','00000000-0000-0000-0000-000000000081',
  '00000000-0000-0000-0000-000000000072',1,
  transaction_timestamp()+interval '15 minutes',
  '00000000-0000-0000-0000-000000000282');
 SELECT pg_sleep(1); COMMIT;"

run_pair package \
"BEGIN; SET LOCAL app.tenant_id = '$TENANT';
 SELECT app.append_package_entry(
  '$TENANT','00000000-0000-0000-0000-000000000093',
  'manual_debit',-1,'00000000-0000-0000-0000-000000000291');
 SELECT pg_sleep(1); COMMIT;" \
"BEGIN; SET LOCAL app.tenant_id = '$TENANT';
 SELECT app.append_package_entry(
  '$TENANT','00000000-0000-0000-0000-000000000093',
  'manual_debit',-1,'00000000-0000-0000-0000-000000000292');
 SELECT pg_sleep(1); COMMIT;"

run_pair equipment \
"BEGIN; SET LOCAL app.tenant_id = '$TENANT';
 SELECT app.acquire_pooled_equipment_hold(
  '$TENANT','00000000-0000-0000-0000-000000000071',
  '00000000-0000-0000-0000-0000000000a1',1,
  '[2030-07-15 12:30Z,2030-07-15 16:00Z)'::tstzrange,
  transaction_timestamp()+interval '15 minutes',
  '00000000-0000-0000-0000-0000000002a1');
 SELECT pg_sleep(1); COMMIT;" \
"BEGIN; SET LOCAL app.tenant_id = '$TENANT';
 SELECT app.acquire_pooled_equipment_hold(
  '$TENANT','00000000-0000-0000-0000-000000000072',
  '00000000-0000-0000-0000-0000000000a1',1,
  '[2030-07-15 12:30Z,2030-07-15 16:00Z)'::tstzrange,
  transaction_timestamp()+interval '15 minutes',
  '00000000-0000-0000-0000-0000000002a2');
 SELECT pg_sleep(1); COMMIT;"

run_pair vessel \
"BEGIN; INSERT INTO resource_reservations (
 tenant_id,id,resource_id,departure_id,reservation_kind,status,
 occupied_range,idempotency_key
) VALUES (
 '$TENANT','00000000-0000-0000-0000-0000000002d1',
 '00000000-0000-0000-0000-0000000000d3',
 '00000000-0000-0000-0000-000000000051','confirmed','confirmed',
 '[2030-07-15 12:00Z,2030-07-15 16:00Z)','concurrent-vessel-one');
 SELECT pg_sleep(1); COMMIT;" \
"BEGIN; INSERT INTO resource_reservations (
 tenant_id,id,resource_id,departure_id,reservation_kind,status,
 occupied_range,idempotency_key
) VALUES (
 '$TENANT','00000000-0000-0000-0000-0000000002d2',
 '00000000-0000-0000-0000-0000000000d3',
 '00000000-0000-0000-0000-000000000051','confirmed','confirmed',
 '[2030-07-15 13:00Z,2030-07-15 17:00Z)','concurrent-vessel-two');
 SELECT pg_sleep(1); COMMIT;"

run_pair captain \
"BEGIN; INSERT INTO resource_reservations (
 tenant_id,id,resource_id,departure_id,reservation_kind,status,
 occupied_range,idempotency_key
) VALUES (
 '$TENANT','00000000-0000-0000-0000-0000000002e1',
 '00000000-0000-0000-0000-0000000000d4',
 '00000000-0000-0000-0000-000000000051','confirmed','confirmed',
 '[2030-07-15 12:00Z,2030-07-15 16:00Z)','concurrent-captain-one');
 SELECT pg_sleep(1); COMMIT;" \
"BEGIN; INSERT INTO resource_reservations (
 tenant_id,id,resource_id,departure_id,reservation_kind,status,
 occupied_range,idempotency_key
) VALUES (
 '$TENANT','00000000-0000-0000-0000-0000000002e2',
 '00000000-0000-0000-0000-0000000000d4',
 '00000000-0000-0000-0000-000000000051','confirmed','confirmed',
 '[2030-07-15 13:00Z,2030-07-15 17:00Z)','concurrent-captain-two');
 SELECT pg_sleep(1); COMMIT;"

run_pair webhook \
"INSERT INTO webhook_inbox (
 tenant_id,provider,environment,provider_event_id,event_type,
 signature_valid,raw_payload
) VALUES (
 '$TENANT','stripe','test','evt_concurrent','payment_intent.succeeded',true,'{}');" \
"INSERT INTO webhook_inbox (
 tenant_id,provider,environment,provider_event_id,event_type,
 signature_valid,raw_payload
) VALUES (
 '$TENANT','stripe','test','evt_concurrent','payment_intent.succeeded',true,'{}');"

run_pair offline \
"INSERT INTO offline_commands (
 tenant_id,id,device_id,local_sequence,command_type,payload_version,payload,
 aggregate_type,aggregate_id,occurred_at_local
) VALUES (
 '$TENANT','00000000-0000-0000-0000-0000000002c2',
 '00000000-0000-0000-0000-0000000000c1',2,'participant.check_in',1,'{}',
 'booking_participant','00000000-0000-0000-0000-000000000061',
 transaction_timestamp());" \
"INSERT INTO offline_commands (
 tenant_id,id,device_id,local_sequence,command_type,payload_version,payload,
 aggregate_type,aggregate_id,occurred_at_local
) VALUES (
 '$TENANT','00000000-0000-0000-0000-0000000002c2',
 '00000000-0000-0000-0000-0000000000c1',2,'participant.check_in',1,'{}',
 'booking_participant','00000000-0000-0000-0000-000000000061',
 transaction_timestamp());"

$PSQL <<SQL
INSERT INTO capacity_buckets (
 tenant_id,id,departure_id,dimension_code,limit_quantity
) VALUES (
 '$TENANT','00000000-0000-0000-0000-000000000082',
 '00000000-0000-0000-0000-000000000051','late-payment-test',1
);
SQL

set +e
$PSQL -c "BEGIN; SET LOCAL app.tenant_id = '$TENANT';
 SELECT app.acquire_capacity_hold(
  '$TENANT','00000000-0000-0000-0000-000000000082',
  '00000000-0000-0000-0000-000000000072',1,
  transaction_timestamp()+interval '15 minutes',
  '00000000-0000-0000-0000-000000000283');
 INSERT INTO resource_reservations (
  tenant_id,id,resource_id,departure_id,reservation_kind,status,
  occupied_range,idempotency_key
 ) VALUES (
  '$TENANT','00000000-0000-0000-0000-0000000002f1',
  '00000000-0000-0000-0000-0000000000d1',
  '00000000-0000-0000-0000-000000000051','confirmed','confirmed',
  '[2030-07-15 13:00Z,2030-07-15 14:00Z)','late-payment-conflict');
 COMMIT;" >"$TMP_DIR/late-payment" 2>&1
late_status=$?
set -e
if [ "$late_status" -eq 0 ]; then
  printf '%s\n' "late-payment transaction unexpectedly succeeded"
  exit 1
fi

remaining=$($PSQL -At -c "SELECT held_quantity FROM capacity_buckets
 WHERE tenant_id='$TENANT'
   AND id='00000000-0000-0000-0000-000000000082';")
if [ "$remaining" != "0.000" ]; then
  printf '%s\n' "late-payment failed reacquisition left partial capacity: $remaining"
  exit 1
fi
printf '%s\n' "late-payment: failed multidimensional reacquisition rolled back atomically"

printf '%s\n' "TideGrid concurrency tests passed"
