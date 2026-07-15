# ADR 0015: Transactional projections before a warehouse

**Status:** Accepted  
**Date:** 2026-07-15

## Context

MVP needs operational and financial reports without harming checkout.

## Decision

Maintain idempotent PostgreSQL read projections from domain events, use a read replica for expensive queries when needed, and export accounting files. Add CDC and a warehouse only after measured demand.

## Alternatives

Query normalized tables for every report; warehouse from day one.

## Benefits

Lower initial complexity with drill-through to source entries.

## Risks and consequences

Projection lag and rebuild procedures must be visible.

## Revisit when

Analytical concurrency, retention, or cross-tenant product analytics exceed replica capacity.
