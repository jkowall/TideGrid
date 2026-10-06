# @tidegrid/domain-booking

Checkout, orders, and bookings for the demo build (goal G2.7 in the [demo build plan](../../docs/v2/12-demo-build-plan.md)): a checkout session turns an immutable quote into a held party and an immutable order, and a verified payment-success event turns that into a confirmed booking. The design authority is [the target architecture](../../docs/v2/04-architecture.md#checkout-booking-and-orders) (checkout, booking, and orders; payments; the [retained invariants](../../docs/v2/04-architecture.md#retained-invariants)) and [product scope: booking and payment](../../docs/v2/02-product-scope.md#booking-and-payment). Tables are in migration `0007_checkout_and_confirmation.sql` and follow the [tenancy contract](../database/README.md). Payments go through the provider-neutral adapter in [domain-payments](../domain-payments/README.md); holds through [domain-inventory](../domain-inventory/README.md).

The demo build plan names this package `domain-booking` (checkout, booking, order) beside `domain-payments` (direct charge, inbox, reconciliation seams). The split keeps the adapter that the Stripe adapter replaces free of any booking knowledge.

## The rule

Nothing marks anything paid or confirmed except a verified provider event. No success screen, redirect, or client call can. The database enforces the chain for every role, the owner included:

| A row may become | Only when |
|---|---|
| checkout session `confirmed` | a booking exists for it, its hold is confirmed, and its payment succeeded |
| booking (inserted) | its checkout's payment succeeded and its hold is confirmed and owned by the checkout |
| order `paid` | a booking exists for it |
| payment `succeeded` | it names a verified `payment.succeeded` inbox event for its provider payment id, connected account, amount, and currency |

The inbox row is written only after the webhook route verifies the provider's signature. The database cannot check an HMAC, so that one step is the service's; `recordProviderEvent` accepts only a `VerifiedProviderEvent`, which only an adapter's `verifyWebhook` builds.

## Model

- **Checkout session.** One guest's attempt to buy one quote. It holds the quote's party on the trip (owner reference `checkout_session:<id>`), records the booker's name and email and the policy version the guest accepted, and keeps the SHA-256 of the guest's capability secret. It expires with its hold. One per quote, ever: a new attempt starts from a new quote.
- **Order.** The immutable financial statement, copied from the quote at checkout: service lines (tickets or the charter price), paid add-ons, fees, the discount, and one tax line per tax rate version. The database checks at commit that the order equals its quote line for line. Only its status moves: `pending`, then `paid` with a booking, or `void` when the checkout can no longer confirm.
- **Payment.** One direct charge on the operator's connected account, for the order's total, with a provider idempotency key. Written with the checkout before the provider is called; the provider's payment id is recorded once, afterwards.
- **Booking.** One party on one trip, created `confirmed` with an eight-character reference (Crockford base32, no I, L, O, or U), only in the transaction that records a verified success. Append-only in this goal.
- **Refund.** The full amount of a payment that succeeded but could not be honored, one per payment, with its own idempotency key.
- **Finalization exception.** One per verified success that could not become a booking, for the operator: the reason, and the refund.

The booker's name and email are the only personal data. They are kept on the checkout session for the booking and its later messages, and never enter audit rows, events, logs, URLs, provider calls, or API responses other than the staff bookings read.

### Checkout states

States move one way; triggers refuse anything else, for every role.

| From | To | When |
|---|---|---|
| (new) | open | Created, with an active hold expiring when the session does |
| open | confirmed | A verified success confirmed the hold and created the booking |
| open | failed | A verified failure; the hold is released and the order void |
| open | expired | Past its instant (the sweep); the hold is marked expired, not released |
| open | canceled | The guest abandoned it; the hold is released and the order void |
| open | unfulfilled | A verified success could not be honored; refund and exception |
| expired | confirmed | A late success reacquired the capacity |
| expired | unfulfilled | A late success could not reacquire it; refund and exception |
| failed, canceled | unfulfilled | A success arrived after the hold was released; refund and exception |

`unfulfilled` means "the money arrived and is going back": the guest sees the refund's state. It is never a sale; an order is `paid` only with a booking. An open session past its instant reads as `expired` to the guest at once, before the sweep writes it.

## Commands

Every command takes the caller's tenant transaction and context, unless it calls a provider, in which case it takes the database and opens its own short transactions around the call. Each writes its audit rows and outbox events in the same transaction as its change. Results are unions; programmer errors throw.

```ts
createCheckoutSession(trx, ctx, {
  quoteId, acceptedPolicyVersion, booker: { name, email }, secret,
  clientAddress, provider, minimumAmount, ttlSeconds?,
}): Promise<
  | { kind: "created"; session: CheckoutSessionView }
  | { kind: "quote_not_found" } | { kind: "quote_expired" } | { kind: "quote_already_used" }
  | { kind: "policy_not_accepted"; policyVersion: number }
  | { kind: "amount_too_small"; minimum: number }
  | { kind: "payments_unavailable" }
  | { kind: "too_many_checkouts"; limit: number }
  | { kind: "not_bookable"; reason } | { kind: "insufficient_capacity"; remaining: number }
>
ensureProviderPayment(db, provider, ctx, sessionId)   // outside any transaction
getCheckoutSession(trx, tenantId, { sessionId, secret })
cancelCheckoutSession(trx, ctx, { sessionId, secret })
handleVerifiedEvent(db, provider, verifiedEvent, { requestId, sourceIp })   // the webhook path
processProviderEvent(trx, ctx, inboxId, { skipLocked? })
settleRefund(db, provider, ctx, refundId)             // outside any transaction
expireCheckoutSessions(trx, ctx, { limit })
sweepCheckouts(db, { runId, provider, ... })          // the cron
listTripBookings(trx, tenantId, tripId)               // staff
listFinalizationExceptions(trx, tenantId, { limit })  // staff
```

### Opening a checkout

In one transaction, in this order:

1. **The quote.** This tenant's, by id; a transaction-scoped advisory lock on the quote serializes concurrent attempts, so the second sees the first and answers `quote_already_used`. Holding a quote id is not authority: the checkout binds its own session and secret, and the charge is the quote's stored total, never an amount a client sends.
2. **Freshness on the database clock.** `now() < least(expires_at, created_at + interval '30 minutes')`, as the [pricing contract](../domain-pricing/README.md#quotes) requires. The insert trigger checks it again.
3. **The policy.** `acceptedPolicyVersion` must be the quote's: the guest accepts the policy before paying.
4. **The amount.** At least the provider's minimum (50 cents, Stripe's USD floor; the fake keeps it).
5. **The account.** The operator's active connected account at the configured provider.
6. **The per-client limit.** At most `MAX_OPEN_CHECKOUTS_PER_CLIENT` (3) open, unexpired checkouts per client address and tenant, serialized by an advisory lock on a SHA-256 of the tenant and the address; the address itself is not stored. With the per-minute rate limit on public commands, this bounds how many seats one address can hold. No limit applies when the request carries no address (Cloudflare always sets one on a deployed Worker).
7. **The hold.** `acquireHold` for the quote's party with a 15-minute life (never past departure). This is the party re-check: it refuses a party the product no longer allows (`party_size_out_of_range`) and one the trip cannot seat with every live hold counted (`insufficient_capacity`). Checkout collects no participants in this goal; participant records arrive with the guest journey and waivers.
8. **The writes.** The session (its expiry copied from the hold in SQL, at full precision), the order and its lines (copied from the quote in SQL), and the pending payment; audit `checkout.session_opened` and event `checkout.session.opened`.

Then, after commit and outside any transaction, `ensureProviderPayment` asks the provider for the payment with the row's idempotency key and records the provider's payment id once. A crash anywhere in between is repaired by calling it again: the same key returns the same provider payment. It offers no payment for a checkout that is no longer open or has passed its expiry.

### Processing a verified event

`handleVerifiedEvent` finds the tenant by the event's connected account (`app.resolve_payment_account`, a definer function that returns the tenant and the account's status only), records the event in that tenant's inbox and commits, then processes it in a second transaction, then sends any refund it requested.

Processing locks the inbox row first (an event already processed returns its recorded outcome and changes nothing), then the checkout session, then, inside the inventory calls, the trip and the hold, then the payment. It finds the payment by the id TideGrid gave the provider (the client reference) or by the provider's payment id, records a missing provider payment id (the webhook may beat the request that created the payment), and checks that the event's account, amount, and currency are the payment's.

| Event | Payment, checkout | Result | Outcome |
|---|---|---|---|
| success | pending; open or expired | `confirmHold`; confirmed, possibly reacquired: payment succeeded, booking created, order paid, checkout confirmed | `confirmed`, `confirmed_reacquired` |
| success | pending; open or expired | `confirmHold` reports `capacity_lost`: any capacity still held is released, payment succeeded, refund requested, exception raised, order void, checkout unfulfilled | `refund_required` |
| success | pending; canceled | refund and exception (`session_canceled`) | `refund_required` |
| success | failed | refund and exception (`session_failed`): the provider had said it failed | `refund_required` |
| success | succeeded | nothing | `already_succeeded` |
| success | amount, currency, account, or provider id differs | exception `payment_mismatch`, no automatic refund, nothing else | `payment_mismatch` |
| failure | pending; open | hold released, payment failed, order void, checkout failed | `released` |
| failure | pending; expired or canceled | payment failed, order void | `failure_recorded` |
| failure | succeeded | nothing: a failure delivered after a success | `ignored_after_success` |
| failure | failed | nothing | `already_failed` |
| either | no payment of this tenant matches | nothing | `unmatched_payment` |
| other kinds | | nothing | `ignored_event_type` |

`payment.failed` means the provider will not complete the payment. A success after it is an anomaly and is refunded, never booked: the hold was released, and a released hold is final.

A late success gets no priority over acquisitions already queued on the trip, as the inventory README notes: it reacquires only if the seats are still free. Otherwise the guest is refunded in full and the operator sees the exception.

### Refunds

The refund row is the intent, committed with the decision. `settleRefund` then calls the provider outside any transaction with the row's idempotency key and records `succeeded` or `failed` (with the provider's code). An unknown outcome (the provider did not answer) stays `requested`; the sweep sends it again with the same key, so it can never refund twice. A failed refund stays visible as an exception and never reads as completed to the guest.

### Guest cancellation

`cancelCheckoutSession` releases an open checkout's hold at once and voids its order, so the guest can re-quote a changed party without their own hold counting against them (the G2.6 follow-up). Repeating it changes nothing; a closed checkout answers `not_cancelable`. A payment that succeeds afterwards anyway is refunded.

### The sweep

The API Worker's cron runs `sweepCheckouts` after the hold sweep, every 15 minutes. Correctness never waits for it. For each tenant `app.checkout_sweep_tenants` names (tenant ids only, the same argument as the hold sweep's):

1. open checkouts past their instant expire, each hold first (`expireHold`, which locks the hold row only), idempotently;
2. inbox events received a minute ago or more and never processed (the request that recorded them failed) are processed;
3. refunds requested a minute ago or more and never settled are sent again with their keys.

Rows another transaction holds are skipped, so the sweep never waits on a request.

## Lock order

Inbox event, checkout session, trip, hold, then the payment and the rest. The quote and the client address are serialized by transaction-scoped advisory locks taken before any row lock. Expiring a checkout locks its session and then its hold row only, never the trip. External calls never run inside a transaction. Every command needs READ COMMITTED, as the inventory commands do.

## Audit and events

Events carry identifiers only.

| Change | Audit action | Outbox topic |
|---|---|---|
| checkout opened | `checkout.session_opened` | `checkout.session.opened` |
| booking confirmed | `booking.confirmed`, `checkout.session_confirmed` | `booking.confirmed` |
| payment succeeded or failed | `payment.succeeded`, `payment.failed` | `payment.succeeded`, `payment.failed` |
| checkout failed, expired, canceled | `checkout.session_failed`, `_expired`, `_canceled` | `checkout.session.failed`, `.expired`, `.canceled` |
| success not honored | `checkout.session_unfulfilled`, `payment_refund.requested`, `finalization_exception.raised` | `checkout.finalization_exception.raised` |
| refund settled | `payment_refund.succeeded`, `payment_refund.failed` | `payment.refund.succeeded`, `payment.refund.failed` |
| provider id recorded | `payment.provider_recorded` | |

Hold transitions keep their own `hold.*` audit rows and `inventory.hold.*` events.

## API

| Route | Answers |
|---|---|
| `POST /v1/public/checkout-sessions` | 201 checkout and what to pay with; 404 `quote_not_found`; 409 `quote_expired`, `quote_already_used`, `trip_not_bookable`, `insufficient_capacity`, `party_size_out_of_range`, `payments_unavailable`; 422 `policy_not_accepted`, `payment_amount_too_small`, `idempotency_key_reused`; 429 `rate_limited`, `too_many_checkouts`; 503 `payments_unavailable`, `payment_provider_unavailable` |
| `GET /v1/public/checkout-sessions/{id}` | 200 checkout; 401 `checkout_secret_required`; 404 `checkout_not_found` |
| `POST /v1/public/checkout-sessions/{id}/cancel` | 200 checkout; 401; 404; 409 `checkout_not_cancelable`; 429 |
| `POST /v1/webhooks/payments/{provider}` | 200 `{ received, duplicate, outcome }`; 400 `signature_invalid`, `payload_invalid`; 403 `origin_not_allowed`; 404; 413 `payload_too_large` |
| `GET /v1/staff/tenants/{tenantId}/trips/{tripId}/bookings` | owners and booking staff; the trip's bookings with booker contact |
| `GET /v1/staff/tenants/{tenantId}/finalization-exceptions` | every role; newest first |

What the guest checkout UI calls:

1. Generate a checkout secret (32 random bytes, base64url) and an idempotency key, and keep both for the session (session storage).
2. `POST /v1/public/checkout-sessions` with `{ quoteId, acceptedPolicyVersion, booker, checkoutSecret }` and the key. The response has the checkout (id, state, amount, expiry) and `payment: { provider, paymentRef, clientSecret }`. On 503 `payment_provider_unavailable`, or a lost response, send the same request again with the same key: it returns the same checkout and finishes creating the payment.
3. Pay at the provider with the client secret. With the fake provider: `POST /v1/fake-provider/payments/{paymentRef}/succeed` (or `/fail`) with `Authorization: Bearer <clientSecret>`.
4. Poll `GET /v1/public/checkout-sessions/{id}` with `Authorization: Bearer <checkoutSecret>` until the state is `confirmed` (show `booking.reference`), `failed`, `expired`, or `unfulfilled` (show the refund).
5. To change the party before paying, `POST .../cancel` first, then re-quote.

The checkout secret and the client secret travel in headers and bodies only, never in URLs. Every response is `Cache-Control: no-store` and `Vary: Origin`. Public routes resolve the tenant from the verified Origin, as `/v1/public/trips` does.

## Deferred and known gaps

- Deposits and balances (G2.8), refunds beyond this compensation and booking cancellation (G2.9, G2.11), participants (G2.11, G2.15), and the guest UI are not here.
- A late success gets no priority over acquisitions queued for the same seats.
- The booker's name and email stay on abandoned checkouts. A retention job should clear them after a set time before real guests use the system.
- Finalization exceptions have no resolution workflow yet; the console goal adds one.
- The staff bookings read has no pagination.
- A Stripe adapter must map Stripe's events onto the neutral kinds: a declined attempt the guest may retry is not `payment.failed`, and Stripe's pending refunds need refund events, which the inbox records as `other` today.
- Expired checkouts and their orders stay `expired` and `pending`: a late success may still confirm them.

## Tests

- `pnpm --filter @tidegrid/domain-booking test` runs unit tests.
- `pnpm --filter @tidegrid/domain-booking test:integration` runs against a throwaway Neon branch with `TIDEGRID_EPHEMERAL_DB=1`. `src/test-fixtures.ts` (exported as `@tidegrid/domain-booking/testing`) builds a tenant through the real services, adds a fake connected account, a tax rate, and a promotion, and produces events only by signing and verifying them.
