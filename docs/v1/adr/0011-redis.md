# ADR 0011: No Redis in the MVP critical path

**Status:** Accepted  
**Date:** 2026-07-15

## Context

Availability, holds, balances, and idempotency require transactional authority.

## Decision

Do not use Redis for authoritative inventory, locks, sessions, or queues. Use PostgreSQL and Cloudflare platform services. Optional cache entries must be disposable and bounded by short TTLs.

## Alternatives

Redis locks and counters; Redis-backed jobs.

## Benefits

One source of truth and fewer split-brain failure modes.

## Risks and consequences

PostgreSQL and read projections must meet latency targets.

## Revisit when

Measured cacheable read load justifies Redis without weakening correctness.
