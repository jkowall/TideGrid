# 17. Reliability, observability, and operations

## Service-level objectives

Initial targets are measured monthly and exclude announced maintenance only where contracts allow.

| User journey | SLI | MVP objective |
|---|---|---|
| Public booking availability | Successful non-5xx responses | 99.95% |
| Checkout command availability | Accepted or deterministic business response | 99.9% |
| Availability search latency | Edge-to-response latency | p95 < 750 ms, p99 < 1.5 s |
| Checkout hold latency | Edge-to-durable-hold latency | p95 < 1.5 s |
| Provider webhook processing | Durable intake to domain projection | 99% < 60 s, 99.9% < 10 min |
| Message dispatch | Eligible outbox event to provider acceptance | 99% < 2 min |
| Offline synchronization | Valid command batches accepted when online | 99.5%; p95 < 10 s for 100 commands |
| Data recovery | RPO | 5 minutes maximum target |
| Service recovery | RTO | 60 minutes for booking core, 4 hours for noncritical reporting |

Provider outage time is visible separately and is not silently removed from user-journey SLIs. Error budgets drive release pace and reliability work.

## Runtime topology and failure domains

Cloudflare serves static clients, widget assets, Workers, R2, Queues, and Workflows across its network. PostgreSQL 17 runs on Neon Scale in Azure East US 2. The production root branch is protected, its compute stays active, and its instant-restore window retains 30 days. Hyperdrive pools direct Neon connections near the database, while the Worker uses the `azure:eastus2` placement hint for database-heavy request paths.

The database is canonical. Queues, workflow instances, caches, clients, provider objects, and analytics are rebuildable or reconcilable projections. No design claims exactly-once delivery across network boundaries.

## Telemetry

### Logs

Structured JSON includes timestamp, severity, service, environment, deployment, route/operation, tenant hash, principal type, correlation/trace IDs, aggregate ID, outcome, latency, dependency, retry count, and stable error code. It excludes tokens, secrets, raw webhook signatures/bodies, medical answers, waiver bodies, document URLs, and payment method data.

### Traces

W3C trace context propagates from edge through Worker modules, Hyperdrive queries, queue/workflow steps, R2, and provider adapters. OpenTelemetry semantic conventions are used where applicable. Financial and PII attributes use identifiers or redacted classifications, not values.

### Metrics

- request rate, errors, duration by operation and client;
- database connection wait, query latency, lock wait, deadlock, serialization retry, storage, vacuum, and replica/failover status;
- active/expired holds, finalization exceptions, negative-invariant attempts;
- outbox oldest age, publish rate, queue depth, retries, DLQ depth;
- webhook intake signature failures, unmapped accounts, processing age, duplicates;
- message acceptance/delivery/failure by provider and journey;
- offline active devices, sequence gaps, conflict rate, stale snapshots, purge completion;
- reconciliation exceptions, unmatched payouts, fee/refund differences;
- R2 errors, signed-URL issuance, document scan backlog;
- third-party latency, errors, rate limits, and circuit state.

High-cardinality IDs stay in logs/traces, not metric labels.

## Dashboards and alerts

Dashboards align to user journeys: browse-to-hold, hold-to-pay, provider-success-to-confirmation, departure operations, message delivery, offline sync, and financial reconciliation. Each panel links to a runbook and correlated traces.

Page immediately for booking error-budget burn, database unavailable/failover, payment success not finalized, suspected tenant leakage, RPO threat, or critical DLQ. Ticket or business-hours alerts cover moderate queue growth, delivery degradation, expiring credentials, stale devices, and reporting lag.

Multi-window burn-rate alerts prevent both slow and fast SLO exhaustion. Alert messages state customer impact, affected tenants/regions, first evidence, and safe first action.

## Resilience patterns

- Timeouts are shorter than caller deadlines and explicitly configured per provider.
- Retries apply only to idempotent reads or commands with stable idempotency keys.
- Exponential backoff, jitter, attempt limits, and circuit breakers prevent retry storms.
- Bulkheads separate provider adapters, tenants with abusive load, queue consumers, reporting, and document processing.
- Queue consumers checkpoint in PostgreSQL before acknowledgement.
- Scheduled reconcilers compare Stripe payments/refunds/disputes/payouts, Twilio status, outbox publication, hold expiry, device purge, and document lifecycle.
- Feature flags are tenant/environment scoped, default safe, owner/date documented, and removable.
- Degraded modes preserve read-only manifests and operational data while disabling unsafe financial or inventory commands.

## Dependency recovery

| Failure | Behavior |
|---|---|
| Stripe unavailable | Preserve checkout and idempotency state; do not claim success; allow cash/external only by operator policy |
| Twilio/email unavailable | Queue within retention, show delivery state, use alternate transactional channel where consent permits |
| Weather provider unavailable | Show stale timestamp/source; operators use alternate evidence and retain human decision |
| Queue unavailable | Domain commit and outbox remain; scheduled publisher recovers |
| Workflow unavailable | PostgreSQL task state remains; start/restart workflow idempotently |
| R2 unavailable | Block document completion but preserve metadata/upload command for retry |
| Hyperdrive issue | Fail safely; controlled direct-DB fallback only through predesigned restricted path |
| Neon compute restart or endpoint interruption | Reconnect, retry safe transactions, and reconcile uncertain external effects; never retry a non-idempotent external effect without its recorded key |
| Azure region or Neon service loss | Escalate to Neon, preserve Cloudflare degraded modes, and restore the latest verified logical backup to an approved PostgreSQL recovery target if the recovery-time gate expires |

## Deployments and migrations

Workers and web assets deploy by immutable version with gradual traffic, synthetic checks, and one-command rollback. Mobile releases use server-side capability flags and backward-compatible APIs.

Database changes use expand, backfill, verify, contract. Lock impact is tested on production-scale copies. Migrations set lock and statement timeouts, expose progress, and have a rehearsed forward recovery. Rolling application versions tolerate both schema shapes. A database rollback never discards committed business data.

## Backup, restore, and continuity

Neon instant-restore coverage and the independent daily logical-backup job are monitored separately. Restore drills at least quarterly create isolated branches or databases from both sources, restore configuration, validate RLS, decrypt selected records, verify ledger projections and R2 hashes, and run synthetic checkout/offline tests.

Runbooks cover Neon connection resets, compute restart, regional recovery, accidental delete, corrupt migration, provider duplication, queue replay, leaked secret, lost device, stale manifest, payout mismatch, and tenant-isolation incident. Every drill records actual RTO/RPO and remediation owner.
