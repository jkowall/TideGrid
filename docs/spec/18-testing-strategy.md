# 18. Testing strategy

## Test layers

| Layer | Scope | Release gate |
|---|---|---|
| Unit | Money/fee math, policy, validation, merge rules, provider translation | Every change |
| State machine | Every allowed/forbidden transition, guard, permission, compensation, event | Every domain change |
| Property based | Ledger conservation, nonnegative balance, fee proportionality, time/range properties | Core domain CI |
| PostgreSQL integration | DDL, RLS, FKs, checks, triggers, range exclusions, functions | Every migration |
| Concurrency | Real PostgreSQL 17 sessions racing scarce resources and idempotent commands | Core domain CI/nightly load |
| API contract | OpenAPI request/response, RFC 9457, auth, idempotency, compatibility | Every API change |
| Provider contract | Stripe/Twilio signatures, fixtures, replay, out-of-order states, sandbox smoke | Adapter CI and pre-release |
| Queue/workflow | Retry, duplicate, poison, DLQ, replay, crash between effect and ack | Async CI |
| Offline/mobile | SQLCipher, command sequencing, merge/conflict, revocation, purge, dockside UX | Mobile CI and device lab |
| Security | Tenant escape, object auth, injection, SSRF, XSS/CSRF, brute force, secret/PII logging | CI plus periodic external test |
| Performance | Availability, checkout, sync, webhook, migration, reporting isolation | Release candidate |
| Recovery | Backup restore, projection rebuild, queue replay, dependency outage | Scheduled drill |

## State-machine test contract

Each transition has table-driven tests for:

- every valid source and target;
- actor permission and object/assignment scope;
- stale expected version;
- missing guard or override evidence;
- database changes and invariant checks;
- exact event/audit/outbox records;
- notification decision;
- provider call idempotency;
- compensation and reversal;
- duplicate command and retry after unknown outcome.

Model-based tests generate command sequences and assert terminal-state, monotonicity, and conservation rules.

## Required concurrency scenarios

All scenarios run against PostgreSQL 17 with independent connections and synchronized barriers.

| Race | Expected proof |
|---|---|
| Two users buy final seat | One confirmed unit, one deterministic unavailable result, no leaked hold |
| Two users redeem final package unit | One debit, other fails/noops, balance remains zero or positive |
| Two users reserve final rental item | One active range, exclusion conflict translated to 409 |
| Captain on overlapping departures | One active reservation; invalid assignment cannot commit |
| Vessel on overlapping departures | One active reservation; maintenance block also conflicts |
| Payment succeeds after hold expiry | All requirements reacquired and confirmed, or full refund plus fee reversal and exception |
| Duplicate Stripe event | One inbox row/effect; duplicate returns 2xx |
| Out-of-order Stripe event | No state regression; provider lookup/reconciliation if ambiguous |
| Duplicate Twilio callback | One status transition/history item |
| Two devices check in same participant | One applied, one no-op, monotonic participant state |
| Participant removed while captain offline | Offline command conflicts/rejects; server removal remains |
| Vessel substitution while captain offline | Assignment delta/tombstone replaces stale vessel; no local authority to revert |
| Partial cancellation with package/equipment | Correct unit reinstatement, equipment release, refund allocation, fee reversal |

Run each race repeatedly under `READ COMMITTED` and selected flows under `SERIALIZABLE`. Assert final rows, event counts, ledger sums, and reconciliation exceptions, not only HTTP responses.

## Time testing

Use a controllable clock. Cover leap day, month/year boundaries, hold expiry, credential/document expiry, cutoff calculations, long trips crossing midnight, and clock skew. For every supported US zone test spring-forward nonexistent local times, fall-back ambiguous times, changed UTC offsets, and schedule edits after tzdata updates.

Stored departures preserve local date/time, IANA zone, resolved offset, and UTC instant. Tests verify the same departure does not move when future tzdata changes unless an authorized reschedule occurs.

## Provider and failure injection

- Verify signatures using exact raw bytes and reject altered timestamp/body.
- Replay production-shaped sanitized Stripe and Twilio fixtures.
- Inject timeout before provider acceptance, after provider acceptance, before database commit, and after commit before response.
- Kill queue consumers between dedup insert/effect/ack boundaries.
- Delay and reorder events, exhaust rate limits, corrupt payload versions, and route poison messages to DLQ.
- Simulate Stripe, Twilio, email, weather, R2, Hyperdrive, queue, workflow, Neon connection reset, compute restart, and database outages.
- Apply the full DDL to a Neon PostgreSQL 17 branch, run the race suite through independent connections, and verify `btree_gist`, `pgcrypto`, RLS, triggers, and exclusion constraints.
- Test a cache-disabled Hyperdrive binding against Neon’s direct endpoint. Assert current authorization and inventory reads after writes and confirm no runtime path uses Neon’s pooled endpoint.
- Restore from Neon history and from the encrypted R2 logical backup into isolated targets, then rerun tenant, ledger, and synthetic checkout checks.
- Verify circuit breaker, retry budget, degraded UI, operator alert, and reconciliation.

## Offline/mobile matrix

Test iOS and Android supported versions on physical low/mid-range devices with airplane mode, intermittent LTE/Wi-Fi, app kill, OS kill, background limits, reboot, low storage, clock changes, expired tokens, revoked assignment, lost device, reinstall, and two-device use.

Validate SQLCipher database encryption, hardware key wrapping, screen/background privacy, attachment resume, snapshot hash, sequence gaps, conflict UX, and post-trip cryptographic purge.

## Security and privacy tests

- Automated cross-tenant API and direct-database RLS matrix for every tenant table.
- Authorization tests for each sensitive data category and support JIT path.
- Static/dynamic injection, XSS, CSRF, SSRF, path traversal, file polyglot/decompression, and webhook forgery.
- Package-code entropy and rate-limit simulation.
- PII/secret canary scan across logs, traces, analytics, crash reports, queues, and DLQs.
- Session/device revocation and refresh-token reuse.
- Dependency, container, IaC, secret, license, and provenance checks.
- External penetration test before GA and after material auth/tenant changes.

## Artifact acceptance

CI verifies:

1. the source prompt hash and byte equivalence;
2. all 21 numbered sections, 20 ADRs, and 15 Mermaid files;
3. Mermaid parse and OpenAPI lint;
4. internal Markdown links;
5. schema application to clean PostgreSQL 17;
6. RLS policy and tenant-aware FK coverage;
7. consistent table, endpoint, state, and event names;
8. traceability coverage and dated primary citations;
9. every risk column is populated.

Release evidence records command, environment, version/commit, timestamp, result, and retained test report.
