# ADR 0009: Provider-neutral webhook inbox

**Status:** Accepted  
**Date:** 2026-07-15

## Context

Stripe, Twilio, email, weather, accounting, and OTA providers duplicate, retry, reorder, and version events differently.

## Decision

Verify at ingress, store provider/environment/event ID, selected headers and raw payload, acknowledge quickly, then process asynchronously and idempotently.

## Alternatives

Synchronous provider-specific handlers; queue without durable raw receipt.

## Benefits

Replay, audit, poison-event quarantine, and common operations.

## Risks and consequences

Raw payloads need encryption, retention, redaction, and access controls.

## Revisit when

No planned condition removes the need; provider-specific validation stays behind adapters.
