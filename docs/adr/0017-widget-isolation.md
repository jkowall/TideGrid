# ADR 0017: Isolated web-component booking widget

**Status:** Accepted  
**Date:** 2026-07-15

## Context

The widget runs inside untrusted operator websites with conflicting CSS, scripts, and security policies.

## Decision

Ship a versioned web component using Shadow DOM, TideGrid-owned assets/API, strict CSP, allowlisted postMessage events, and Stripe-hosted fields.

## Alternatives

Copied JavaScript form; iframe-only hosted page; framework-specific SDK.

## Benefits

Branding flexibility with CSS isolation and controlled integration surface.

## Risks and consequences

Host-page compromise can still alter surrounding content. Sensitive actions require server-side validation and origin checks.

## Revisit when

Security testing shows iframe isolation is required for all deployments.
