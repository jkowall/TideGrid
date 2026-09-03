# Requirements traceability matrix

**Status:** Historical V1 traceability. Its use of “canonical” applies only inside the preserved V1 package. Current scope and authority begin with the [V2 planning index](../v2/00-index.md).

This matrix maps the supplied prompt to specification, delivery phase, executable surface, and validation. Functional ID ranges mean every individual requirement in that inclusive range inherits the mapping. Detailed wording is canonical in [section 5](05-functional-requirements.md).

## Product and functional requirements

| Requirement ID | Prompt requirement | Specification | Phase | Schema/API coverage | Validation |
|---|---|---|---|---|---|
| PRM-001 | Preserve supplied prompt verbatim | Source prompt, `README` | Package | `TIDEGRID_PLATFORM_ARCHITECTURE_PROMPT.md` | Byte comparison and SHA-256 |
| PRM-002 | US-first assumptions and current primary research | 1, 2, 16, 21; source register | 0 | Provider ports and policy metadata | Dated primary-link check, legal review |
| PRM-003 | TideGrid canonical; theme board unchanged; superseded Tideline Grid copy | 00, 1, 21 | 0/GA | No runtime dependency | File-diff and launch gate |
| PRM-004 | Original 1% assumption superseded by approved 0.75% to 3.00% plan rates; fee still assessed once on eligible non-tax/non-tip TideGrid value | 1, 4, 5, 7, 11; pricing strategy | 1 | `orders`, `order_lines`, `platform_fees`, refund API | Per-plan fee, order/fee snapshot, property, and reconciliation tests |
| PRM-005 | Stripe direct charges, operator merchant of record; SaaS Billing separate | 5, 7, ADR-0005 | 0/1 | Provider/order/payment/account tables | Stripe sandbox and ledger reconciliation |
| COM-001 | Tiered subscriptions; unlimited usage dimensions; boat/location entitlements; active-boat add-on; annual, onboarding, and seasonal policies | Pricing strategy, 1, 4, 5, 21 | 0/1 | Stripe Billing catalog, entitlement service, versioned fee snapshot | Billing sandbox, entitlement boundary, invoice, and cohort-margin tests |
| FR-TEN-001..007 | Multi-tenant organization, legal entities, locations, roles, suspension, and subscription entitlements | 5, 7, 16 | 0/1 | Tenant/identity tables; tenant header/auth; Billing entitlement projection | Two-tenant RLS/FK, authorization, and plan-boundary tests |
| FR-CAT-001..006 | Catalog, schedule, pricing, quote snapshots, sources | 5, 7 | 1 | Product/template/instance/order-line tables; availability/booking API | Rule, quote, DST, snapshot tests |
| FR-RES-001..006 | General resources, blocks, qualification, substitution, overrides | 5, 6, 7, 11 | 1/2 | Resource/reservation/qualification/maintenance tables | GiST, qualification, substitution race tests |
| FR-CAP-001..006 | Multidimensional capacity and revalidation | 5, 7, 11 | 1 | Capacity profile/bucket/hold; availability/hold API | Final-seat and profile property tests |
| FR-HLD-001..007 | Atomic checkout holds, expiry, retry, late payment | 5, 6, 7, 11 | 1 | Checkout/hold tables and SQL functions; hold API | Expiry, deadlock, late-success concurrency tests |
| FR-CUS-001..006 | Distinct customer/party/participant, scoped access, consent | 5, 7, 16 | 1/2 | Customer/participant/guardian/consent tables; booking/participant API | Access, merge, token, consent tests |
| FR-STV-001..007 | Package/gift/credit rules, immutable ledgers, secure codes | 5, 6, 7, 11 | 3 | Stored-value tables/functions; redemption API | Last-unit, projection rebuild, code-abuse tests |
| FR-PAY-001..011 | Orders, payment modes, Connect, versioned plan fee, refund, and reconciliation | 5, 6, 7, 11 | 1/3/4 | Commerce tables; booking/refund/provider webhook API | Sandbox, replay, per-plan fee, historical snapshot, payout reconciliation tests |
| FR-CHR-001..005 | Inquiry, option, proposal, acceptance, change order | 5, 6, 7 | 1/3 | Charter/resource/order tables; booking extension | Quote expiry and vessel-option races |
| FR-DOC-001..006 | Waiver, medical, certification, guardian, offline evidence | 5, 6, 7, 16 | 2 | Document/evidence tables; waiver API | Hash/version/access/offline-minimization tests |
| FR-MAN-001..006 | Readiness, check-in, manifest, all-ashore | 5, 6, 7, 15 | 2 | Booking participant/manifest/snapshot; operations API | Monotonic state and snapshot tests |
| FR-OFF-001..007 | Encrypted assigned bundles, command sync, conflicts, purge | 5, 6, 7, 15 | 2 | Offline tables; command/delta API | Device lab, two-device, revoke/purge tests |
| FR-DIS-001..006 | Human disruption decisions, evidence, actions, remedies | 5, 6, 7 | 2 | Disruption/action/outbox; disruption API | Authorization, batch retry, compensation tests |
| FR-WAI-001..004 | Waitlist matching, expiring offers, normal holds | 5, 7 | 1 | Waitlist/offer/capacity tables | Concurrent claim and expiry tests |
| FR-EQP-001..006 | Pooled/serialized equipment and dive logistics | 5, 6, 7, 11 | 3 | Equipment/resource tables and hold functions | Final-item, interval, lifecycle tests |
| FR-SAF-001..004 | No-fly/surface warnings, acknowledgment, no clearance claim | 5, 16 | 3 | Versioned policies/evidence JSON; participant workflow | Rule/version/wording and override tests |
| FR-CRW-001..005 | Crew roles, credentials, overlap, hours/tips, no payroll | 5, 6, 7, 11 | 2/3 | Crew/resource/tip tables and constraint trigger | Credential expiry/overlap/override tests |
| FR-VSL-001..005 | Vessel documents, readiness, maintenance, substitution | 5, 6, 7, 11 | 2 | Vessel/document/block/checklist/resource tables | Out-of-service and substitution tests |
| FR-TRP-001..005 | Dispatch, execution, incidents, closeout | 5, 6, 7, 15 | 2 | Departure/manifest/checklist/incident tables | State, all-ashore, export/hash tests |
| FR-MSG-001..006 | SMS/email journeys, consent, callbacks, dedup/fallback | 5, 7, 14 | 1/2 | Message/consent/inbox tables; Twilio endpoint | Signature, duplicate, opt-out, outage tests |
| FR-TIP-001..005 | Tips, allocation/export, reviews and recovery suppression | 5, 7 | 3 | Order lines/tip allocations/message journey | Fee exclusion and compensating-entry tests |
| FR-INT-001..005 | Hosted/widget/API/webhooks/import/OTA ports | 5, 8, 12, 14 | 1/post-MVP | OpenAPI, external records, webhook tables | Contract, signature, import dedup tests |
| FR-REP-001..005 | Operational/financial reporting and drill-down | 5, 7, ADR-0015 | 1/4/later | Transactional projections and ledgers | Query budget and source-total reconciliation |
| FR-ADM-001..005 | Platform admin, support JIT, replay/export/deletion | 5, 16, 17 | 0/4 | Audit/inbox/provider/reconciliation tables | Permission, support, replay, deletion tests |
| FR-X-001 | All commands: auth, tenant, idempotency, correlation, audit | 5, 12, 16 | 0+ | OpenAPI parameters, idempotency/audit tables | Cross-endpoint policy test |
| FR-X-002 | State and outbox commit atomically; external calls outside locks | 5, 8, 13 | 0+ | Outbox and transaction boundaries | Crash/failure injection |
| FR-X-003 | Time, money, quantity, override conventions | 5, 11, 12 | 0+ | Typed columns and API schemas | Boundary/property/time-zone tests |

## Architecture and delivery requirements

| Requirement ID | Prompt requirement | Specification/decision | Phase | Artifact coverage | Validation |
|---|---|---|---|---|---|
| ARC-001 | TypeScript modular monolith; assess JVM | 8, ADR-0001 | 0 | Component boundaries and alternative analysis | Dependency-rule architecture tests |
| ARC-002 | Workers/Hono and React/Vite web clients | 8 | 0/1 | Container/deployment/component diagrams | Worker best-practice and bundle tests |
| ARC-003 | Isolated booking widget | 8, ADR-0017 | 1 | Widget API/security model | Host-page integration/CSP tests |
| ARC-004 | React Native plus SQLCipher; reject PWA | 8, 15, ADR-0002 | 0/2 | Mobile container and offline protocol | Physical-device offline/security spike |
| ARC-005 | User-approved override: Neon Scale PostgreSQL 17 in Azure East US 2 via cache-disabled Hyperdrive and Azure placement | 8, 11, ADR-0003, ADR-0020 | 0 | DDL, deployment diagram, database guide | Clean Neon PG17 apply, direct-endpoint, connection-reset, restore, and load tests |
| ARC-006 | Kysely/pg with hand-authored SQL migrations | 8, 11 | 0 | Schema and database guide | Generated type drift and migration tests |
| ARC-007 | R2, Queues, Workflows, scheduled Workers, Terraform | 8, 13, 17 | 0+ | Deployment and async diagrams | IaC plan, queue/workflow failure tests |
| ARC-008 | No advisory locks or LISTEN/NOTIFY through Hyperdrive | 8, ADR-0008 | 0 | Row locks, exclusions, polling outbox | Static architecture rule and integration tests |
| ARC-009 | Independent lifecycle state machines and transition metadata | 6 | 1+ | State tables, events, audit | Model-based transition suite |
| ARC-010 | PostgreSQL concurrency and tenant invariants | 7, 11 | 0+ | DDL constraints/functions/RLS | Database constraint and race suite |
| ARC-011 | At-least-once queues, consumer dedup, DLQ | 8, 13, ADR-0010 | 0+ | Outbox/consumption/DLQ design | Duplicate/crash/replay tests |
| ARC-012 | Payment success after hold expiry compensation | 6, 11, 17 | 1 | Finalization algorithm, refund/event surfaces | Required late-payment race |
| ARC-013 | REST `/v1`, RFC 9457, cursors, idempotency | 12, ADR-0014 | 1 | OpenAPI 3.0.3 | OpenAPI lint and contract tests |
| ARC-014 | Versioned events and HMAC outgoing webhooks | 13, 14 | 1+ | Event and webhook catalogs | Schema compatibility/signature/replay tests |
| ARC-015 | Server-authoritative offline commands/deltas | 15, ADR-0012 | 2 | Offline tables and OpenAPI | Offline matrix and conflict tests |
| SEC-001 | Auth, MFA, authorization, least privilege, support controls | 16 | 0+ | Role/audit/session design | Authorization and JIT abuse tests |
| SEC-002 | Encryption, object security, secrets, rotation, webhook verification | 16 | 0+ | Cipher/object/webhook schema | Key rotation, signed URL, signature tests |
| SEC-003 | Retention, deletion, backups, vulnerabilities, incident response | 16, 17 | 0/4 | Data lifecycle and runbooks | Deletion, restore, scanning, tabletop |
| REL-001 | Required SLOs and RTO/RPO | 17 | 0+ | SLI table and dashboards | Synthetic tests and error-budget review |
| REL-002 | Logs, traces, metrics, alerts, reconciliation and provider health | 17 | 0+ | Telemetry catalog | Observability acceptance and alert drills |
| TST-001 | Complete unit/integration/concurrency/security/offline test set | 18 | 0+ | Test matrix | CI reports and release evidence |
| ADR-001..020 | Nineteen prompt-required decisions plus the Neon provider decision | 9 and `docs/adr` | Package/0 | 20 accepted ADR files | File count and required-heading check |
| DIA-001..015 | Fifteen required Mermaid diagrams | 10 and `docs/diagrams` | Package | 15 `.mmd` files | Mermaid parse |
| DB-001 | Production PostgreSQL DDL, constraints, indexes, RLS, transactions | 11 and `database` | Package/0 | `schema.sql` and guide | Clean PG17 apply and catalog assertions |
| RSK-001..036 | Every named risk with seven required attributes | 19 | All | Risk table | Row/column completeness check |
| RDM-001 | MVP, post-MVP, non-goals and phased roadmap | 4, 20 | All | Scope matrix and exit gates | Product/architecture gate review |
| OPN-001 | Explicit assumptions and unresolved choices | 21 | 0+ | Question/owner/gate tables | No launch gate left unowned |
| SRC-001 | Dated primary citations for provider, regulatory, safety claims | Source register | Package/continuous | `research/source-register.md` | URL/date/primary-source review |

## Validation status legend

- **Designed:** acceptance method and authoritative artifact exist.
- **Executed:** command/test ran against the stated environment.
- **Blocked:** safe execution was attempted and the environmental blocker is recorded.

The package index is published only when each row is designed and all artifact-level checks are executed. Product implementation tests become executable as their delivery phases start.
