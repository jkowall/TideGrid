# ADR 0001: Modular monolith

**Status:** Accepted  
**Date:** 2026-07-15

## Context

The domain has many bounded contexts but one initial team and tightly coordinated transactions.

## Decision

Deploy one TypeScript domain application with explicit module ownership, ports, domain events, and no cross-module repository writes.

## Alternatives

Independent microservices; unstructured monolith.

## Benefits

Atomic PostgreSQL transactions, simpler operations, lower latency, and testable boundaries.

## Risks and consequences

Weak discipline could create coupling. CI must enforce imports and table ownership. Scale is initially shared.

## Revisit when

A module has stable contracts plus materially different scaling, availability, security, or team ownership needs.
