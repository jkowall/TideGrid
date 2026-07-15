# Database implementation guide

The authoritative DDL is [schema.sql](schema.sql). It targets PostgreSQL 17 and uses `btree_gist`, `pgcrypto`, range types, exclusion constraints, generated identities, forced row-level security, deferrable constraint triggers, and immutable ledgers.

## Migration order

Split the baseline into forward-only migrations at implementation time:

1. Extensions and the `app` schema.
2. Tenant, identity, customer, and catalog tables.
3. Departure, requirement, resource, and capacity tables.
4. Checkout, booking, order, payment, refund, fee, and stored-value tables.
5. Disruption, communication, webhook, outbox, audit, and offline tables.
6. Documents, vessels, crew, equipment, manifests, checklists, and incidents.
7. Deferred foreign keys, exclusion constraints, indexes, functions, triggers, and RLS policies.
8. Runtime grants and reference data in an environment-specific migration.

Migrations run through Neon’s direct, unpooled TLS endpoint, not Hyperdrive. Each migration records checksum, deployment ID, actor, start/end time, and result. Destructive changes require expand, migrate, contract sequencing. The migration role cannot serve application traffic.

## Transaction wrapper

Every request transaction begins with:

```sql
BEGIN;
SET LOCAL app.tenant_id = 'tenant-uuid';
SET LOCAL statement_timeout = '5s';
SET LOCAL lock_timeout = '750ms';
SET TRANSACTION ISOLATION LEVEL READ COMMITTED;
```

The service derives `tenant_id` from the authenticated principal and route context. It never accepts a database tenant context directly from a client. Hyperdrive connections must use `SET LOCAL` inside the transaction so pooled sessions cannot leak context. MVP domain traffic uses a cache-disabled Hyperdrive configuration because authorization, inventory, payments, and reads after writes require current data.

Use `SERIALIZABLE` only for bounded workflows that cannot express their invariant with a row lock or constraint. Retry SQLSTATE `40001` and `40P01` at most three times with jitter. Do not retry business errors such as unavailable capacity.

## Enforced invariants

| Invariant | Database mechanism |
|---|---|
| Tenant references cannot cross | Composite primary and foreign keys include `tenant_id` |
| Tenant rows cannot be read or changed across contexts | Forced RLS and `app.current_tenant_id()` |
| Exclusive resources do not overlap | Partial GiST exclusion on `resource_reservations` |
| Serialized equipment does not overlap | Partial GiST exclusions plus mandatory resource reservation |
| Capacity never oversells | Conditional update of locked `capacity_buckets` projection |
| Pooled equipment never oversells | Conditional update of locked `equipment_pools` projection |
| Package/credit balances never go negative | Locked account projection, nonnegative check, immutable entry |
| Commands and provider events apply once | Unique command, provider-event, external-record, and idempotency keys |
| Signed and operational evidence is not rewritten | Append-only triggers |
| Required qualifications are current | Deferred qualification and crew-assignment constraint triggers |
| Fee pricing is historical and deterministic | Plan code, schedule version, eligible minor units, and basis points are snapshotted; fee uses integer half-up calculation |

## Booking finalization and late payment

Finalization uses one database transaction:

1. Lock the checkout session and payment attempt.
2. Return the recorded result if finalization already completed.
3. Lock every capacity bucket, stored-value account, and pooled equipment row in ascending primary-key order.
4. Confirm active holds. For expired holds, attempt conditional reacquisition of every requirement.
5. Insert or confirm exclusive reservations. Let exclusion constraints arbitrate races.
6. If any requirement fails, roll back the transaction.
7. If all succeed, confirm booking, order, reservations, redemption entries, fee entry, audit event, and outbox events, then commit.

After rollback on a late-payment failure, a separate idempotent compensation command submits a full Stripe refund, including the proportional application-fee reversal, creates a reconciliation exception, and queues customer/operator notices. External calls never occur inside the locked transaction.

## Representative concurrency tests

Run each with 20 or more concurrent sessions and randomized ordering:

- final seat, one success and all other attempts receive capacity unavailable;
- package last unit, one debit and a nonnegative projection;
- pooled equipment last unit;
- overlapping vessel, captain, and serialized rental intervals;
- duplicate Stripe event and Twilio callback;
- same offline command on concurrent sync requests;
- late payment competing with a new checkout;
- refund retry and proportional fee reversal.

Every test also verifies the outbox count, audit record, ledger projection, and absence of orphaned holds.

The disposable-database harnesses are [`acceptance-tests.sql`](acceptance-tests.sql) and [`concurrency-tests.sh`](concurrency-tests.sh). Apply the schema and acceptance SQL first, then run:

```sh
DATABASE_URL=postgresql://postgres:tidegrid@localhost:5432/tidegrid \
  sh database/concurrency-tests.sh
```

## RLS verification

Create two tenants and records under both. Set one tenant using `SET LOCAL app.tenant_id` and verify:

- direct reads expose only that tenant;
- cross-tenant insert/update and composite foreign keys fail;
- a missing tenant context returns no tenant rows;
- table owners are subject to `FORCE ROW LEVEL SECURITY`;
- global `permissions` reference rows remain read-only through runtime grants.

Webhook intake can initially store an unresolved event with a null tenant only through a narrowly privileged ingestion path. Normal runtime policies cannot see unresolved rows. The processor resolves connected-account identity to a tenant before business handling.

## Representative queries

Availability capacity is a candidate filter only. The hold transaction remains authoritative:

```sql
SELECT d.id AS departure_id,
       b.dimension_code,
       b.limit_quantity - b.held_quantity - b.confirmed_quantity AS available
FROM departure_instances d
JOIN capacity_buckets b
  ON b.tenant_id = d.tenant_id AND b.departure_id = d.id
WHERE d.tenant_id = app.current_tenant_id()
  AND d.location_id = $1
  AND d.starts_at >= $2
  AND d.starts_at < $3
  AND d.status IN ('scheduled','minimum_not_met','confirmed_to_run')
  AND b.limit_quantity - b.held_quantity - b.confirmed_quantity >= $4
ORDER BY d.starts_at, d.id, b.dimension_code;
```

Outbox publishers claim bounded work without advisory locks:

```sql
WITH claimed AS (
  SELECT tenant_id, id
  FROM transactional_outbox
  WHERE state IN ('pending','failed')
    AND available_after <= transaction_timestamp()
  ORDER BY available_after, occurred_at
  FOR UPDATE SKIP LOCKED
  LIMIT 100
)
UPDATE transactional_outbox o
SET state = 'publishing',
    attempt_count = attempt_count + 1
FROM claimed
WHERE o.tenant_id = claimed.tenant_id AND o.id = claimed.id
RETURNING o.*;
```

Expired holds are claimed in small batches, then each release function updates the projection and hold in one transaction:

```sql
SELECT tenant_id, id
FROM capacity_holds
WHERE status = 'held' AND expires_at <= transaction_timestamp()
ORDER BY expires_at
FOR UPDATE SKIP LOCKED
LIMIT 100;
```

## Operations

- Production uses Neon Scale on PostgreSQL 17 in Azure East US 2. The production compute stays active, starts at 0.25 to 2 CU autoscaling, and increases its minimum after load tests or working-set metrics justify it.
- Neon instant restore retains 30 days of history. A restricted scheduled runner creates an encrypted daily `pg_dump` through the direct, unpooled endpoint and stores it in a separate R2 backup bucket for provider-independent recovery.
- Restore drills validate both Neon point-in-time restore and an isolated restore from the R2 logical backup. A backup does not count as successful until the restore test passes.
- Runtime traffic uses a dedicated Neon role through Hyperdrive. Migration, backup, and emergency roles have separate credentials, network policy, and audit trails.
- Ledger, audit, waiver, snapshot, and incident retention follows the tenant retention schedule and legal holds.
- Monitor deadlocks, serialization retries, connection saturation, compute restarts, autoscaling, local-file-cache hit rate, storage growth, restore-window consumption, autovacuum debt, index bloat, long transactions, outbox age, and reconciliation exceptions.
- Partition `audit_events`, `transactional_outbox`, `webhook_inbox`, and `offline_commands` by time only after measured volume justifies it.
- Restore drills must rebuild projections from immutable ledgers and verify document hashes against R2.

## Local validation

```sh
podman run --rm --name tidegrid-postgres \
  -e POSTGRES_PASSWORD=tidegrid \
  -e POSTGRES_DB=tidegrid \
  -p 5432:5432 postgres:17-alpine

psql postgresql://postgres:tidegrid@localhost:5432/tidegrid \
  -v ON_ERROR_STOP=1 -f database/schema.sql
```

The baseline is intentionally a single reviewable file. The application repository should convert it into numbered migrations without changing constraints or names.
