# ADR 0006: Separate immutable stored-value ledgers

**Status:** Accepted  
**Date:** 2026-07-15

## Context

Trip units, gift-card currency, promotional credit, and refund credit have different accounting and eligibility semantics.

## Decision

Use typed accounts with append-only ledgers and locked balance projections. Holds and releases are ledger entries. A redemption converts a hold without decrementing twice.

## Alternatives

One generic balance; mutable remaining-unit fields.

## Benefits

Auditability, concurrency safety, explicit liability, and correct multi-unit consumption.

## Risks and consequences

Corrections require compensating entries and projection rebuild tooling.

## Revisit when

Never for mutability; new stored-value types may add new account policies.
