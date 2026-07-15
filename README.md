# TideGrid

TideGrid is a US-first passenger-vessel booking and departure-operations platform. This repository currently contains the decision package for the product and architecture. It does not contain production application code.

## Architecture package

- [Source architecture prompt](TIDEGRID_PLATFORM_ARCHITECTURE_PROMPT.md), preserved byte-for-byte from the supplied attachment
- [Specification index](docs/spec/00-index.md), the canonical reading order for all 21 requested sections
- [Requirements traceability](docs/spec/requirements-traceability.md)
- [Pricing strategy](docs/spec/pricing-strategy.md)
- [Architecture decision records](docs/adr/README.md)
- [Diagram catalog](docs/diagrams/README.md)
- [PostgreSQL schema](database/schema.sql)
- [Database implementation notes](database/README.md)
- [Database acceptance tests](database/acceptance-tests.sql) and [concurrency race harness](database/concurrency-tests.sh)
- [OpenAPI contract](api/openapi.yaml)
- [Primary-source register](research/source-register.md)

## Naming status

The architecture package uses **TideGrid**, as directed. The existing theme board says **Tideline Grid**, and the separate brand strategy records a possible naming conflict. Those artifacts are preserved unchanged. Trademark clearance and a final naming decision remain launch gates, not architecture blockers.

## Fixed product decisions

- US-first, USD and English at MVP
- Tiered subscription from $149 per month plus a plan-specific 0.75% to 3.00% platform fee
- Unlimited customers, bookings, users, products, and departures; boats and locations are plan entitlements
- Platform fee assessed once on TideGrid-processed, non-tax, non-tip eligible value, with the plan and rate version snapshotted
- Stripe Connect direct charges, with operators as merchants of record
- TypeScript modular monolith on Cloudflare Workers
- PostgreSQL 17 on Neon Scale in Azure East US 2 as the authoritative store
- Cross-platform native captain app with encrypted offline storage
- Human-approved weather and safety decisions

## Document authority

When artifacts conflict, use this order:

1. Accepted ADR
2. PostgreSQL constraints and API contract
3. Numbered specification
4. Source prompt
5. Research notes

An ADR must be amended or superseded before changing an accepted decision.
