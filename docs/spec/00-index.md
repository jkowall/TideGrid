# TideGrid V1 product and architecture specification

**Version:** 1.0 design baseline  
**Date:** July 15, 2026  
**Market:** United States first  
**Status:** Historical design package; superseded for current planning by [TideGrid V2](../v2/00-index.md)

> This specification describes the broader July 2026 departure-operations concept. Preserve it as design evidence, but do not use it to define current product scope, pricing, or implementation commitments. The [V2 decision register](../v2/06-decision-register.md) records which decisions remain applicable.

## Required reading order

1. [Executive summary](01-executive-summary.md)
2. [Product positioning and differentiation](02-positioning.md)
3. [Personas and jobs to be done](03-personas.md)
4. [MVP, post-MVP, and non-goal matrix](04-scope-matrix.md)
5. [Detailed functional requirements](05-functional-requirements.md)
6. [State machines](06-state-machines.md)
7. [Domain model](07-domain-model.md)
8. [Recommended software architecture](08-software-architecture.md)
9. [Architecture decision records](09-architecture-decisions.md)
10. [Diagrams](10-diagrams.md)
11. [PostgreSQL schema](11-postgresql-schema.md)
12. [API design](12-api-design.md)
13. [Domain event catalog](13-domain-events.md)
14. [Webhook catalog](14-webhooks.md)
15. [Offline synchronization protocol](15-offline-sync.md)
16. [Security and privacy architecture](16-security-privacy.md)
17. [Reliability and observability plan](17-reliability-observability.md)
18. [Testing strategy](18-testing-strategy.md)
19. [Risk analysis](19-risk-analysis.md)
20. [Phased implementation roadmap](20-roadmap.md)
21. [Open questions and assumptions](21-open-questions.md)

## Supporting artifacts

- [Requirements traceability matrix](requirements-traceability.md)
- [Pricing strategy](pricing-strategy.md)
- [ADR catalog](../adr/README.md)
- [Diagram catalog](../diagrams/README.md)
- [Production-oriented DDL](../../database/schema.sql)
- [Database implementation guide](../../database/README.md)
- [Database acceptance tests](../../database/acceptance-tests.sql) and [concurrency race harness](../../database/concurrency-tests.sh)
- [OpenAPI 3.0 contract](../../api/openapi.yaml)
- [Primary-source register](../../research/source-register.md)

## Architecture at a glance

| Concern | Decision |
|---|---|
| Delivery shape | TypeScript modular monolith with explicit bounded contexts |
| Edge/runtime | Cloudflare Workers with Hono |
| Transactional authority | PostgreSQL 17 on Neon Scale in Azure East US 2 |
| Database access | Cache-disabled Hyperdrive plus Azure placement; direct unpooled Neon endpoint for migrations and recovery |
| Async | Transactional outbox, Cloudflare Queues, scheduled sweeper, idempotent consumers |
| Durable orchestration | Cloudflare Workflows, with PostgreSQL as canonical state |
| Documents | Private R2 objects, hashes and access metadata in PostgreSQL |
| Web clients | React and Vite |
| Field client | React Native with SQLCipher-backed local database |
| Payments | Stripe Connect direct charges; Stripe Terminal for card-present |
| Commercial model | Tiered subscription plus plan-specific platform fee; unlimited usage with boat/location entitlements |
| Messaging | Twilio SMS and provider-neutral email adapter |
| Public interfaces | REST/OpenAPI 3.0, versioned domain events, HMAC webhooks |
| Infrastructure | Terraform for Cloudflare and Azure; pinned Neon provider with API fallback |

## Global invariants

1. Every tenant-owned row is scoped by `tenant_id`, and every cross-tenant reference is impossible through composite foreign keys.
2. PostgreSQL, not cache, queue, workflow, Stripe, or offline storage, is authoritative for capacity, resources, stored value, bookings, and financial ledgers.
3. An exclusive resource cannot have overlapping active reservations.
4. A capacity bucket, equipment pool, or stored-value account cannot become negative.
5. A provider event, command, refund, import, or redemption cannot apply twice.
6. External calls never occur while a database transaction holds business locks.
7. Financial entries, signed evidence, manifest snapshots, audit events, and incidents are append-only.
8. Payment success is established only by a verified provider event or provider reconciliation.
9. Safety and weather data inform a human decision; TideGrid never autonomously authorizes or cancels a departure.
10. Offline commands are merged by command-specific rules, never blind last-write-wins.

## Naming note

The package uses TideGrid. The existing theme board’s “Tideline Grid” wording is treated as superseded for architecture purposes. The separate brand strategy’s naming-clearance warning remains a pre-launch risk.

## Package validation

Validated July 15, 2026:

| Check | Result |
|---|---|
| Source prompt | Byte-identical; SHA-256 `100389aff11673dc8839e275302c25c18781c3e9a6df10b34fd79de395da1772` |
| Artifact counts | 21 numbered sections plus index, 20 ADRs, 15 diagrams, 36 named risks |
| PostgreSQL | Clean apply on PostgreSQL 17.10; 90 tables; all 89 tenant-scoped tables use forced RLS |
| Tenant keys | Zero tenant-to-tenant foreign keys missing `tenant_id` |
| Database invariants | Acceptance SQL passed |
| Concurrency | Capacity, package, equipment, vessel, captain, duplicate webhook, duplicate offline command, and late-payment rollback passed |
| OpenAPI | Redocly recommended lint passed with no warnings |
| Mermaid | All 15 files parsed and rendered |
| Documentation | All local Markdown links resolve |

Neon account provisioning, live provider schema application, connection-reset tests, and restore drills remain Phase 0 execution gates. The package records those checks as designed, not executed.
