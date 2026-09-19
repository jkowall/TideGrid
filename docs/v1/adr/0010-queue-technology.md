# ADR 0010: Cloudflare Queues

**Status:** Accepted  
**Date:** 2026-07-15

## Context

The Cloudflare-first runtime needs asynchronous delivery, retries, batching, and DLQs.

## Decision

Use Cloudflare Queues with JSON envelopes, per-message error handling, bounded retries, explicit acknowledgments, DLQs, and database consumer deduplication.

## Alternatives

Google Cloud Pub/Sub; Kafka; database-only job table.

## Benefits

Native Worker integration and simple operational model.

## Risks and consequences

Delivery is at least once and queue retention is not audit retention. PostgreSQL remains authoritative.

## Revisit when

Ordering, replay horizon, throughput, or ecosystem requirements exceed Queues.
