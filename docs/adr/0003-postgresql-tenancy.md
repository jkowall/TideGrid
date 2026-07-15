# ADR 0003: Shared-schema PostgreSQL tenancy

**Status:** Accepted  
**Date:** 2026-07-15

## Context

MVP needs strong isolation without per-tenant database operational cost.

## Decision

Use one schema with `tenant_id` on every tenant-owned row, composite unique keys, tenant-aware foreign keys, and application tenant context.

## Alternatives

Schema per tenant; database per tenant.

## Benefits

Efficient migrations, pooled compute, fleet-wide platform operations, and straightforward onboarding.

## Risks and consequences

Every query and key design must preserve tenant scope. Large tenants may create noisy-neighbor pressure.

## Revisit when

Residency, contractual isolation, tenant scale, or restore requirements justify dedicated databases.
