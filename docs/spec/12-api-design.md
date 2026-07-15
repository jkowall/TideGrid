# 12. API design

The normative contract is [`api/openapi.yaml`](../../api/openapi.yaml). It uses OpenAPI 3.0.3 so the same document can feed Hono validation, SDK generation, contract tests, documentation, and Cloudflare API Shield schema validation.

## Conventions

| Concern | Rule |
|---|---|
| Base path | `/v1` |
| Media type | `application/json`, with `application/problem+json` for errors |
| Naming | snake_case JSON, plural resource paths, UUID identifiers |
| Time | RFC 3339 UTC instants; schedules also expose IANA zone and local values |
| Money | integer minor units plus ISO 4217 currency |
| Pagination | Opaque cursor and bounded `limit`, stable sort by `(created_at,id)` or domain sequence |
| Correlation | Accept or create `X-Correlation-ID`; return it and propagate to events/providers |
| Tenant | `X-TideGrid-Tenant` must be authorized against the principal, never trusted alone |
| Commands | Mandatory UUID `Idempotency-Key` and optional expected aggregate version |
| Queries | Safe to repeat, cache only where authorization and freshness allow |

## Idempotency

The key scope is `tenant + operationId + authenticated subject + key`. The server stores request hash, state, status, and response for at least 24 hours, longer for payment, refund, import, and offline operations.

- Same key and same canonical request returns the original status and body.
- Same key and different request returns `409 idempotency_key_reused`.
- An in-flight duplicate returns `409 command_in_progress` with retry guidance.
- A provider timeout does not authorize a new payment/refund key until provider lookup resolves the first attempt.
- Internal child commands derive stable keys from the root command and target ID.

## Error model

Errors follow RFC 9457 and add stable `code`, `correlation_id`, `retryable`, and field errors. Security failures do not reveal whether a resource exists in another tenant.

| Status | Use |
|---|---|
| 400 | Malformed syntax, signature, or cursor |
| 401/403 | Missing identity or insufficient permission |
| 404 | Absent in authorized tenant scope |
| 409 | Version, state, inventory, or idempotency conflict |
| 410 | Offline cursor outside retained history |
| 422 | Valid syntax but invalid business input |
| 429 | Principal, tenant, device, or endpoint rate limit |
| 503 | Dependency unavailable before command acceptance |

## Endpoint catalog

| Capability | Endpoint |
|---|---|
| Availability search | `GET /v1/availability` |
| Atomic multidimensional hold | `POST /v1/holds` |
| Booking and order | `POST /v1/bookings`, `GET /v1/bookings/{id}` |
| Participant change | `POST /v1/bookings/{id}/participants` |
| Package redemption | `POST /v1/bookings/{id}/package-redemptions` |
| Waiver evidence | `POST /v1/waivers/submissions` |
| Check-in and boarding | `POST /v1/bookings/{id}/check-ins`, `/boardings` |
| Full/partial reschedule | `POST /v1/bookings/{id}/reschedules` |
| Human disruption workflow | `POST /v1/disruptions`, `POST /v1/disruptions/{id}/executions` |
| Refund | `POST /v1/refunds` |
| Offline upload/download | `POST /v1/offline/commands`, `GET /v1/offline/deltas` |
| Provider callbacks | `POST /v1/provider-webhooks/{provider}` |

Additional implementation endpoints follow the same conventions for checkout payment attempts, cancellations, waitlist, charter proposals, equipment, manifests, incidents, reconciliation, and outgoing-webhook subscriptions.

## Authentication profiles

- Operator web: short-lived OIDC access token, MFA and step-up for sensitive permissions.
- Captain app: OIDC token plus registered device key, assignment scope, and device attestation where available.
- Guest widget: origin-bound, tenant-scoped widget token plus Turnstile for abuse-sensitive commands.
- Participant link: short-lived, one-purpose signed token, participant and booking scope, revocable after use.
- Integration: OAuth client credentials or tenant API key with scopes, IP controls where appropriate.
- Provider callback: provider signature over the raw body, timestamp tolerance, and provider account mapping.

Cloudflare validates coarse token, body, schema, bot, and rate-limit controls. The Worker applies tenant, role, object, state, and field-level authorization.

## Compatibility

`/v1` additions are backward compatible: optional response fields, new enum values only where clients tolerate unknowns, and new endpoints. Breaking changes require `/v2`. Clients send a capability/app version header; unsupported mobile versions receive an upgrade deadline before access is blocked.

API examples must use test identifiers and synthetic PII. Logs exclude tokens, raw signatures, medical answers, waiver bodies, and payment method data.
