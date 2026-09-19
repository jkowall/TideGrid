# ADR 0004: PostgreSQL row-level security

**Status:** Accepted  
**Date:** 2026-07-15

## Context

Application authorization mistakes must not expose another tenant’s rows.

## Decision

Enable and force RLS on tenant tables using transaction-local `app.tenant_id`. Use a non-owner runtime role without `BYPASSRLS`.

## Alternatives

Application filtering only; separate databases.

## Benefits

Database defense in depth and default-deny access.

## Risks and consequences

Connection reuse requires setting tenant context inside every transaction. Maintenance roles need tightly controlled bypass.

## Revisit when

The tenancy strategy moves to dedicated databases.
