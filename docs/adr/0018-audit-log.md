# ADR 0018: Append-only audit events

**Status:** Accepted  
**Date:** 2026-07-15

## Context

Overrides, financial changes, medical access, support actions, and lifecycle transitions require durable attribution.

## Decision

Append audit events in the same transaction as business changes. Store actor, support session, action, target, before/after hashes or redacted diff, reason, correlation, source IP/device, and timestamps. Deny update/delete to runtime roles.

## Alternatives

Application logs; mutable history tables.

## Benefits

Tenant-visible accountability and reliable incident investigation.

## Risks and consequences

Audit payloads can leak sensitive data, so use classifications, redaction, retention, and separate access.

## Revisit when

External immutable storage or cryptographic chaining is required by contract or threat model.
