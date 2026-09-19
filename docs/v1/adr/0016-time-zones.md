# ADR 0016: UTC instants plus local schedule snapshots

**Status:** Accepted  
**Date:** 2026-07-15

## Context

Departures are understood locally, but DST creates ambiguous or nonexistent local times.

## Decision

Store IANA zone, departure-local date/time, resolved UTC start/end, and offset snapshot. Scheduling rejects ambiguity or requires an explicit earlier/later offset choice.

## Alternatives

UTC only; fixed offsets; naive local timestamps.

## Benefits

Correct display, recurrence generation, audit, and DST handling.

## Risks and consequences

Future timezone-database changes require explicit regeneration policy, never silent mutation of sold departures.

## Revisit when

Never for naive time; multi-region features may extend the model.
