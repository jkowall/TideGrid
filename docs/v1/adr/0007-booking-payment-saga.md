# ADR 0007: PostgreSQL-canonical booking and payment saga

**Status:** Accepted  
**Date:** 2026-07-15

## Context

Inventory and Stripe cannot commit atomically.

## Decision

Persist saga state, holds, attempts, compensation, and exceptions in PostgreSQL. Use provider idempotency and verified webhooks. Use Cloudflare Workflows only as a durable coordinator.

## Alternatives

Browser-driven checkout; workflow-engine state as authority; long database transaction around Stripe.

## Benefits

Recoverable failure handling and auditable payment/inventory outcomes.

## Risks and consequences

Compensations and reconciliation are mandatory. Late success attempts one atomic reacquisition, then full refund if unavailable.

## Revisit when

Provider capabilities offer a stronger atomic reservation/payment primitive.
