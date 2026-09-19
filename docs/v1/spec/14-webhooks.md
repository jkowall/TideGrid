# 14. Webhook catalog

## Incoming provider webhooks

| Provider | Representative events | Authoritative use |
|---|---|---|
| Stripe Connect | PaymentIntent/charge, refund, dispute, payout, account/capability | Payment, refund, dispute, account, and reconciliation projections |
| Stripe Billing | Subscription/invoice/payment events | TideGrid SaaS entitlement only, never operator booking revenue |
| Twilio | SMS status and inbound message callbacks | Delivery history, opt-out commands, replies |
| Email provider | Delivery, bounce, complaint, unsubscribe | Delivery and suppression projection |
| OTA/import adapters | Booking create/change/cancel | External record and operator exception; no platform fee on imported value |

### Intake algorithm

1. Read the unmodified body with a strict size limit.
2. Verify provider signature and timestamp against the endpoint secret.
3. Resolve environment and, where possible, connected account to tenant.
4. Insert the full event into `webhook_inbox` using the unique provider event ID.
5. Return 2xx for a valid duplicate and after durable insert, not after all business effects.
6. Process asynchronously with row claim, current provider-object retrieval when needed, and idempotent state transitions.
7. Quarantine invalid, unmapped, or impossible events without exposing details to the sender.

Provider events may be duplicated and out of order. A browser redirect, client callback, or Terminal display is never sufficient evidence of payment success.

## Outgoing TideGrid webhooks

Initial subscribable event families:

- booking confirmed, changed, cancelled, rescheduled;
- participant readiness, check-in, boarding, no-show;
- departure scheduled, delayed, departed, returned, cancelled;
- refund succeeded or failed;
- package/credit balance entry;
- disruption approved or resolved;
- manifest snapshot created;
- incident created, with sensitive details omitted.

Outgoing payloads use the domain-event envelope. A subscription can select event types, but not request unrestricted sensitive fields.

## Signature

Headers:

```text
TideGrid-Webhook-ID: event UUID
TideGrid-Webhook-Timestamp: Unix seconds
TideGrid-Webhook-Signature: v1=<lowercase hex HMAC-SHA256>
```

The signed content is:

```text
<webhook-id>.<timestamp>.<exact-body-bytes>
```

Each subscription has an independently generated 256-bit secret stored with envelope encryption. Consumers should reject timestamps outside five minutes, compare signatures in constant time, and deduplicate by webhook ID. Secret rotation supports current and previous secrets during a bounded overlap.

## Delivery policy

- Connect timeout: 3 seconds; total attempt: 10 seconds.
- Success: any 2xx response.
- Retry: network errors, 408, 425, 429, and 5xx.
- No automatic retry: other 4xx after one confirmation attempt.
- Backoff: 1 minute, 5 minutes, 30 minutes, 2 hours, 8 hours, 24 hours.
- Final failure: dead-letter after seven attempts, alert subscriber/operator, retain replay evidence.

Replay creates a new delivery attempt for the same event and subscription. It never creates a new business event. Payload and response bodies are size limited and redacted in operator views.

## Security and privacy

Endpoints must use HTTPS, reject redirects, and block private/link-local destinations after DNS resolution to prevent SSRF. Subscription ownership and secret rotation require step-up authorization. Logs contain event type, IDs, latency, status, and response hash, not body secrets or participant medical data.
