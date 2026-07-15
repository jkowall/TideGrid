# ADR 0020: Neon PostgreSQL on Azure

**Status:** Accepted  
**Date:** 2026-07-15

## Context

TideGrid needs PostgreSQL 17 semantics for row-level security, range types, GiST exclusion constraints, triggers, and immutable ledgers. The application runs on Cloudflare Workers and does not need a general-purpose cloud account for database compute. The selected database must keep operating cost low without weakening transaction or recovery requirements.

## Decision

Use Neon Scale PostgreSQL 17 in Azure East US 2 as the production system of record.

- Protect the production root branch and disable scale-to-zero on its read-write compute.
- Start production autoscaling at 0.25 to 2 CU. Load tests, working-set size, and connection metrics determine any higher minimum or maximum.
- Enable a 30-day instant-restore window. Create an encrypted daily logical backup with `pg_dump` and store it in a separate R2 backup bucket.
- Connect Workers through a dedicated Neon runtime role and the direct, unpooled Neon endpoint behind Cloudflare Hyperdrive.
- Disable Hyperdrive query caching for all MVP domain traffic. A later cache-enabled binding may serve public catalog or availability candidate reads that tolerate documented staleness.
- Use `pg` through Kysely. Do not use the Neon serverless driver or Neon’s PgBouncer endpoint in the Hyperdrive path.
- Run migrations, logical backups, and emergency repair through separate restricted roles on the direct, unpooled TLS endpoint.
- Place database-bound Workers near `azure:eastus2`. Allow Neon access only from Cloudflare egress ranges and restricted operational runners.
- Use Neon branches with expiry for migration rehearsals, pull-request tests, and restore validation. Production data copied into non-production branches must follow masking and access policy.
- Provision Cloudflare and Azure resources with Terraform. Pin and review the community Neon Terraform provider, with the Neon API as the fallback provisioning interface.

## Alternatives

Aiven Business on Google Cloud; Crunchy Bridge on Google Cloud; Google Cloud SQL; Azure Database for PostgreSQL Flexible Server.

## Benefits

The design retains PostgreSQL compatibility, lowers the initial compute floor, and gives developers isolated branches for migration and recovery tests. Hyperdrive handles Worker connection pooling without a second pooler.

## Risks and consequences

Neon’s Scale SLA covers compute endpoints rather than every platform function. The application must retry safe transactions after connection resets and monitor Neon separately from Cloudflare. Autoscaling can create cost or latency surprises if the minimum compute does not hold the active working set. The community Terraform provider adds supply-chain and compatibility risk. Independent logical backups and a rehearsed restore to standard PostgreSQL preserve an exit path.

## Revisit when

Measured availability, latency, restore time, compliance, regional coverage, support, or cost misses a production gate; a tenant contract requires dedicated infrastructure; or sustained load favors provisioned PostgreSQL.
