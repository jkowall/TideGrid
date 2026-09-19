# 9. Architecture decision records

The authoritative decisions are individual records in the [ADR catalog](../adr/README.md). The 19 prompt-required topics and the subsequent Neon provider decision are accepted for the MVP baseline.

| ADR | Decision |
|---|---|
| 0001 | Modular monolith, not independently deployed microservices |
| 0002 | React Native native build, not PWA |
| 0003 | Shared-schema PostgreSQL tenancy with tenant-aware keys |
| 0004 | PostgreSQL RLS as defense in depth |
| 0005 | Stripe Connect direct charges |
| 0006 | Separate immutable ledgers for packages, gift cards, and credits |
| 0007 | PostgreSQL-canonical booking/payment saga |
| 0008 | Transactional outbox |
| 0009 | Provider-neutral webhook inbox |
| 0010 | Cloudflare Queues with DLQ and idempotent consumers |
| 0011 | No Redis in the MVP critical path |
| 0012 | Command-based offline synchronization |
| 0013 | Private R2 document storage with immutable evidence |
| 0014 | REST and OpenAPI 3.0 |
| 0015 | Transactional projections first, warehouse later |
| 0016 | UTC instants plus IANA zone and local schedule snapshot |
| 0017 | Isolated web-component booking widget |
| 0018 | Append-only audit events |
| 0019 | Envelope encryption for designated sensitive fields |
| 0020 | Neon Scale PostgreSQL 17 in Azure East US 2 |

Changing an accepted decision requires a superseding ADR and updates to the schema, API, diagrams, tests, and traceability matrix.
