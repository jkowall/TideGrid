# ADR 0014: REST with OpenAPI 3.0

**Status:** Accepted  
**Date:** 2026-07-15

## Context

Guest, operator, mobile, widget, and partner clients need stable, securable contracts.

## Decision

Use resource-oriented reads and explicit command endpoints under `/v1`, documented in OpenAPI 3.0. Use RFC 9457 problems, cursor pagination, ETags/versions, and idempotency keys.

## Alternatives

GraphQL; RPC-only API.

## Benefits

Clear authorization, code generation, API Shield compatibility, and partner usability.

## Risks and consequences

Some workflows require purpose-built command endpoints rather than pure CRUD.

## Revisit when

Read composition complexity proves GraphQL’s additional operational model worthwhile.
