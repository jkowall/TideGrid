# ADR 0012: Command-based offline synchronization

**Status:** Accepted  
**Date:** 2026-07-15

## Context

Two devices and online users can modify trip operations while connectivity is absent.

## Decision

Synchronize immutable, device-scoped commands against versioned server records. Apply deterministic command rules, server-authoritative fields, cursors, tombstones, and explicit conflicts. Never replace records with last-write-wins.

## Alternatives

Record replication; CRDT for every field; online-only client.

## Benefits

Auditable intent, safe deduplication, and domain-specific conflict handling.

## Risks and consequences

Each offline command requires a versioned merge policy and compatibility tests.

## Revisit when

New command classes prove commutative enough for targeted CRDT use.
