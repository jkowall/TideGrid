# ADR 0008: Transactional outbox

**Status:** Accepted  
**Date:** 2026-07-15

## Context

Business state and asynchronous side effects must not diverge after process failure.

## Decision

Write versioned outbox events in the same PostgreSQL transaction as domain state. Publish through queue hints plus a scheduled `SKIP LOCKED` sweeper.

## Alternatives

Publish directly after commit with no recovery; PostgreSQL `LISTEN`/`NOTIFY`; distributed transaction.

## Benefits

At-least-once recoverability without unsupported Hyperdrive session features.

## Risks and consequences

Consumers must be idempotent; sweeper lag must be monitored.

## Revisit when

The database platform supplies a transactional, durable change stream compatible with the runtime.
