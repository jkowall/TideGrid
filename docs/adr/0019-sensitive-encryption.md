# ADR 0019: Envelope encryption for sensitive fields

**Status:** Accepted  
**Date:** 2026-07-15

## Context

Medical responses, emergency details, minors, identity documents, and credentials require protection beyond disk encryption.

## Decision

Classify fields and encrypt designated values with per-tenant data-encryption keys wrapped by a managed key-encryption key. Store ciphertext, key version, algorithm, and classification. Decrypt only after field authorization and audit.

## Alternatives

Provider storage encryption only; application-wide single key; tokenization service.

## Benefits

Limits database snapshot exposure and supports key rotation and cryptographic erasure.

## Risks and consequences

Search/reporting on encrypted fields is limited. Key loss is irreversible. Rotation and break-glass access require drills.

## Revisit when

Dedicated HSM, regional keys, or external tokenization is contractually required.
