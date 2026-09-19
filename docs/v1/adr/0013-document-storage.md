# ADR 0013: Private R2 storage and immutable evidence

**Status:** Accepted  
**Date:** 2026-07-15

## Context

Waivers, medical forms, credentials, and incidents include sensitive and immutable evidence.

## Decision

Store objects in private R2 buckets. PostgreSQL owns metadata, tenant, classification, hash, retention, signer/evidence relationships, and access history. Use short signed URLs and malware scanning before acceptance.

## Alternatives

Database blobs; public object URLs; Azure Blob Storage.

## Benefits

Scalable object storage with explicit evidence and access controls.

## Risks and consequences

R2 encryption is not field authorization. Sensitive content needs application-layer encryption or encrypted object envelopes.

## Revisit when

Residency, compliance, or scanning integrations require another object provider.
