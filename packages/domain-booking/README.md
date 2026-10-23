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

The booker's name and email are the only personal data. They are kept on the checkout session for the booking and its later messages, and never enter audit rows, events, logs, URLs, provider calls, or API responses other than the staff reads for roles that hold `bookings.read` (see [console reads](#console-reads-g212b)).

### Checkout states

States move one way; triggers refuse anything else, for every role.

| From | To | When |
|---|---|---|
| (new) | open | Created, with an active hold expiring when the session does |
| open | confirmed | A verified success confirmed the hold and created the booking |
| open | failed | A verified failure; the hold is released, or stays expired if it already was, and the order void |
| open | expired | Past its instant (the sweep); the hold is marked expired, not released |
| open | canceled | The guest abandoned it; the hold is released, or stays expired if it already was, and the order void |
| open | unfulfilled | A verified success could not be honored; refund and exception |
| expired | confirmed | A late success reacquired the capacity |
| expired | unfulfilled | A late success could not reacquire it; refund and exception |
| failed, canceled | unfulfilled | A success arrived after the checkout failed or was canceled; refund and exception |

`unfulfilled` means "the money arrived and is going back": the guest sees the refund's state. It is never a sale; an order is `paid` only with a booking. An open session past its instant reads as `expired` to the guest at once, before the sweep writes it.

A lapsed checkout's hold can be marked expired before the checkout is: acquisition and late confirmation expire every due hold on their trip, and the cron's hold sweep runs before the checkout sweep. Such a checkout can still fail or be canceled. Its hold stays expired, because an expired hold is never released, and its seats are free either way. The database accepts a released or an expired hold as the evidence for `failed`, `canceled`, and `unfulfilled`.

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
listFinalizationExceptions(trx, tenantId, { limit })  // staff, no personal data
// Console reads (G2.12b), below
listDayBookings(trx, tenantId, { date, tripId?, limit, after?, withBooker })
getBookingDetail(trx, tenantId, bookingId, { withBooker })
findBookingByReference(trx, tenantId, reference)
getTripRoster(trx, tenantId, tripId)
listExceptionsPage(trx, tenantId, { limit, before?, withBooker })
```

### Opening a checkout

In one transaction, in this order:

1. **The quote.** This tenant's, by id; a transaction-scoped advisory lock on the quote serializes concurrent attempts, so the second sees the first and answers `quote_already_used`. Holding a quote id is not authority: the checkout binds its own session and secret, and the charge is the quote's stored total, never an amount a client sends.
2. **Freshness on the database clock.** `now() < least(expires_at, created_at + interval '30 minutes')`, as the [pricing contract](../domain-pricing/README.md#quotes) requires. The insert trigger checks it again.
3. **The policy.** `acceptedPolicyVersion` must be the quote's: the guest accepts the policy before paying.
4. **The amount.** At least the provider's minimum (50 cents, Stripe's USD floor; the fake keeps it).
5. **The account.** The operator's active connected account at the configured provider.
6. **The per-client limit.** At most `MAX_OPEN_CHECKOUTS_PER_CLIENT` (3) open, unexpired checkouts per client address and tenant, serialized by an advisory lock on a SHA-256 of the tenant and the address; the address itself is not stored. With the per-minute rate limit on public commands, this bounds how many seats one address can hold. No limit applies when the request carries no address (Cloudflare always sets one on a deployed Worker).
7. **The hold.** `acquireHold` for the quote's party, for 15 minutes or until the quote stops holding its price, whichever is sooner, and never past departure. The checkout expires with its hold, so a checkout always ends inside its quote's validity; with less than a minute left the answer is `quote_expired`. The insert trigger refuses a checkout that would outlive its quote, for every writer. The hold is also the party re-check: it refuses a party the product no longer allows (`party_size_out_of_range`) and one the trip cannot seat with every live hold counted (`insufficient_capacity`). Checkout collects no participants in this goal; participant records arrive with the guest journey and waivers.
8. **The writes.** The session (its expiry copied from the hold in SQL, at full precision), the order and its lines (copied from the quote in SQL), and the pending payment; audit `checkout.session_opened` and event `checkout.session.opened`.

Then, after commit and outside any transaction, `ensureProviderPayment` asks the provider for the payment with the row's idempotency key and records the provider's payment id once. A crash anywhere in between is repaired by calling it again: the same key returns the same provider payment. It offers no payment for a checkout that is no longer open or has passed its expiry.

### Processing a verified event

`handleVerifiedEvent` finds the tenant by the event's connected account (`app.resolve_payment_account`, a definer function that returns the tenant and the account's status only), records the event in that tenant's inbox and commits, then processes it in a second transaction, then sends any refund it requested.

Processing locks the inbox row first (an event already processed returns its recorded outcome and changes nothing), then the checkout session, then the payment, then, inside the inventory calls, the trip and the hold. It finds the payment by the id TideGrid gave the provider (the client reference) or by the provider's payment id, and checks that the event's account, amount, and currency are the payment's before it records anything from the event. Only then does it record a missing provider payment id (the webhook may beat the request that created the payment).

An event id the inbox already holds with a different body, in this tenant or another, answers `payload_mismatch`: nothing is recorded or processed, the route acknowledges it (a retry cannot help), and the log raises an error.

| Event | Payment, checkout | Result | Outcome |
|---|---|---|---|
| success | pending; open or expired | `confirmHold`; confirmed, possibly reacquired: payment succeeded, booking created, order paid, checkout confirmed | `confirmed`, `confirmed_reacquired` |
| success | pending; open or expired | `confirmHold` reports `capacity_lost`: any capacity still held is released, payment succeeded, refund requested, exception raised, order void, checkout unfulfilled | `refund_required` |
| success | pending; canceled | refund and exception (`session_canceled`) | `refund_required` |
| success | failed | refund and exception (`session_failed`): the provider had said it failed | `refund_required` |
| success | succeeded | nothing | `already_succeeded` |
| success | amount, currency, account, or provider id differs | exception `payment_mismatch`, no automatic refund, nothing else | `payment_mismatch` |
| failure | pending; open | hold released (or left expired), payment failed, order void, checkout failed | `released` |
| failure | pending; expired or canceled | payment failed, order void | `failure_recorded` |
| failure | succeeded | nothing: a failure delivered after a success | `ignored_after_success` |
| failure | failed | nothing | `already_failed` |
| either | no payment of this tenant matches | nothing | `unmatched_payment` |
| other kinds | | nothing | `ignored_event_type` |

`payment.failed` means the provider will not complete the payment. A success after it is an anomaly and is refunded, never booked: the checkout closed when the failure arrived, and its hold no longer takes seats.

A late success gets no priority over acquisitions already queued on the trip, as the inventory README notes: it reacquires only if the seats are still free. Otherwise the guest is refunded in full and the operator sees the exception.

### Refunds

The refund row is the intent, committed with the decision. `settleRefund` then calls the provider outside any transaction with the row's idempotency key and records `succeeded` or `failed` (with the provider's code). An unknown outcome (the provider did not answer) stays `requested`; the sweep sends it again with the same key, so it can never refund twice. A failed refund stays visible as an exception and never reads as completed to the guest.

### Guest cancellation

`cancelCheckoutSession` releases an open checkout's hold at once and voids its order, so the guest can re-quote a changed party without their own hold counting against them (the G2.6 follow-up). Repeating it changes nothing; a closed checkout answers `not_cancelable`. A payment that succeeds afterwards anyway is refunded.

An open checkout past its instant, which the guest already sees as `expired`, can still be canceled until the checkout sweep writes its expiry down, and becomes `canceled`. That holds whether its hold is still stored active or has already been marked expired by another checkout on its trip, a late confirmation, or the hold sweep; an expired hold stays expired. That respects what the guest asked for: a payment that succeeds afterwards is refunded rather than reacquiring seats the guest gave up.

### The sweep

The API Worker's cron runs `sweepCheckouts` after the hold sweep, every 15 minutes. Correctness never waits for it. For each tenant `app.checkout_sweep_tenants(limit, graceSeconds)` names (tenant ids only, the same argument as the hold sweep's):

1. open checkouts past their instant expire, each hold first (`expireHold`), idempotently;
2. inbox events received at least the grace period ago (60 seconds by default) and never processed (the request that recorded them failed) are processed;
3. refunds requested at least the grace period ago and never settled are sent again with their keys.

The expiry never waits on a lock. It takes checkouts and then their holds with SKIP LOCKED, and leaves a checkout whose row or hold another transaction holds for the next run (reported as `skipped`). Acquisition and late confirmation lock a trip and then expire its due holds in their own scan order, so a sweep that waited for one hold while holding another could deadlock with them; the test specialist found exactly that (PostgreSQL 40P01) before this rule. Each batch either expires something or ends, so skipped checkouts cannot keep it turning. Steps 2 and 3 take the same locks in the same order as the request that would have done the work, one event or refund per transaction. An event or a refund that keeps failing is reported (`failedEvents`, `failedRefunds`) and skipped, so it never blocks the rest of its tenant's work.

An open checkout whose hold is missing, released, or confirmed cannot commit: the hold's foreign key and owner, and `capacity_holds_checkout`, refuse it. Only a writer that bypassed a trigger could leave one. If one exists, the expiry leaves it open, counts it as `skipped`, and reports it through `onError` as an `InconsistentCheckoutError` with the checkout's id, every run, for an operator. The cron logs it as an error. It never fails the rest of its tenant's batch.

### Console reads (G2.12b)

The operator console's booking views read through `src/console.ts`, under the caller's tenant transaction, with the tenant named in every query. The contract is [packages/contracts/src/bookings.ts](../contracts/src/bookings.ts); the console's side is in the [console README](../../apps/operator-site/README.md#booking-views-g212b).

- **Who sees the booker.** Every read takes `withBooker`, which the API sets from the role: true only with `bookings.read` (owners and booking staff). When it is false the query does not select the booker's name or email at all, so a view for finance never holds them. The roster always names the booker and its route needs `bookings.read`.
- **What never leaves.** No checkout secret or its hash, client key, idempotency key, payload hash, raw provider payload, or account reference. A provider payment id leaves only masked, `maskProviderReference`: its prefix up to the first underscore and, when at least twelve characters follow, the last four (`fpay_••••a1B2`).
- **A day.** `listDayBookings` reads the date's trips with their booking and guest counts and a page of bookings ordered by departure, trip, confirmation, and booking id. The cursor is the previous page's last booking id; the position is read in SQL, so the database's own timestamp precision orders the page, and the same cursor always returns the same page while nothing new is booked before it. A cursor that names no booking in the listing (this tenant, this date, and the trip when one is given) answers `cursor_invalid`. The API runs it in one snapshot (`snapshotRead` in the [database contract](../database/README.md#commands-audit-idempotency-and-outbox)), so the counts and the page agree even while bookings confirm; the test specialist's suite caught them disagreeing before that.
- **Every console read runs in a snapshot** for the same reason, and the routes answer `Cache-Control: no-store` on refusals as well as on success.
- **Limits.** A day lists its first 200 trips by departure. A booking on a later trip would have no trip to show under; no marina runs that many departures in a day, so the list has no truncation flag yet. A roster holds at most a trip's capacity.
- **Ids are lowercase.** The contract accepts a UUID in either case, but ids are matched as the API writes them, in lowercase, as everywhere else in the API (`isUuid` in `@tidegrid/database`): an uppercase booking or trip id is not found, and an uppercase cursor is `cursor_invalid`. The console sends ids as it received them.
- **Party and extras** come from the immutable order: one service line per ticket type on a shared-seat trip, or the charter line and the booking's party size on a charter, and the add-on lines.
- **A booking** carries its order's lines with each tax line's rate, the payment, any refund, and a timeline: checkout opened, paid, confirmed, and the refund's request and outcome.
- **By reference.** `findBookingByReference` takes the issued form; the API normalizes what was typed first.
- **Exceptions.** `listExceptionsPage` adds the trip, the checkout's state and expiry, and what the provider's event reported (when it arrived, the amount, the currency) to G2.7's read, newest first by creation and id, with a `before` cursor. G2.7's `listFinalizationExceptions` now delegates to it with no booker.

### Console completion (G2.12c)

Search, a day's report and its CSV, and internal notes, in `src/search.ts`, `src/day-report.ts`, `src/csv.ts`, and `src/notes.ts`. The contract is [packages/contracts/src/console.ts](../contracts/src/console.ts); the console's side is in the [console README](../../apps/operator-site/README.md#console-completion-g212c).

- **Search.** `searchBookings` finds bookings by departure date range and by text, a page at a time, ordered and keyed like the day list (departure, trip, confirmation, id), with a count of every match. The text matches a booking reference from its start for every role, read as a guest quotes it (`bookingReferencePrefix` from `@tidegrid/contracts/references`, which the console's form also runs: case, spaces, and hyphens ignored; O, I, and L as 0, 1, and 1; two to eight characters). With `withBooker` (owners and booking staff) it also matches a booker whose name holds every word of the text (`ILIKE`, at most six words) or whose email holds the text, and selects the name and email. Without it the query never joins `checkout_sessions`, so finance's results and counts cannot depend on a name or an address. LIKE's own characters are escaped. A cursor must name a booking this same search finds, or it answers `cursor_invalid`. The API runs it in one snapshot, so the count and the page agree.
- **A day's report.** `buildDayReport` reads every booking on the trips departing one local date, with its order's subtotal (gross), discount, fees, added taxes, included taxes, and total, its payment's state, and its refunds: succeeded refunds count in `refunds` and come off `net`; a refund still requested is reported as pending and counted nowhere else until it settles. The rows come from one statement, so they are one moment even under READ COMMITTED. `totalsOf` sums every column; the totals route and the CSV's total row are that sum, so the two cannot disagree. A day with more than 5,000 bookings is refused (`too_large`) rather than cut short, since control totals must be whole; a caller may pass a lower `limit` (the API's tests do, to reach the refusal), never a higher one.
- **The CSV.** `renderDayExport` writes the contract's stable columns (`bookingDayExportColumns`) and, only with `withBooker`, the booker's name and email after them; one row per booking, then a total row equal to the control totals. UTF-8 with a byte order mark, RFC 4180 quoting, CRLF lines. Money is a plain decimal ("123.45"), never negative: discounts and refunds have their own columns. Taxes added on top of the prices are `Added taxes`; tax already in them is `Included tax`. `Pending refunds` follows `Refunds`: a refund still requested, per row and in the total row, which equals the control totals' pending amount, so the file and the screen list the same figures. Instants are UTC as "2026-10-06 18:17:00". Each row gives its departure's local date, time, and zone, and its instant (`Departure at (UTC)`), so two departures at 01:30 on the night the clocks go back stay apart. Text a person typed (and the operator's, trip's, and boat's names) that starts with =, +, -, @, a tab, or a carriage return gets a leading apostrophe, so a spreadsheet shows it rather than running it (CSV injection). `dayExportFileName` names the file by the operator's slug and the date only.
- **Notes.** `addBookingNote` checks the booking is the tenant's, inserts the note (the database stamps its author, request, and time from the transaction, [migration 0008](../database/README.md#booking-notes)), and records `booking.note_added` with the note's id; the text never enters the audit row. The API answers an added note with its id, author, and time, not its text; that answer is what the idempotency store keeps for a replay, so no second copy of the text sits in `idempotency_keys` (the writer already holds the text it sent). A body is 1 to 500 code points after trimming, with at least one visible character; line breaks are kept, and every other C0 or C1 control character is refused, in the contract and in the table's CHECK. Owners and booking staff read and write notes; finance does neither (owner decision, 2026-10-19), since a note can name a guest. `listBookingNotes` returns the newest 200 with each author's membership name, and how many there are. Both answer an unknown and another tenant's booking alike.

## Guest self-service (lane 1, G2.11c)

After a booking confirms, its guest names the party and may cancel within the booking's own policy, through an accountless management link (G2.11). Tables are in migration `0009_self_service_and_email.sql`; the guest routes and the email that carries the link follow in [domain-messaging](../domain-messaging/README.md) and the API section below.

### Participants

- **One per place.** A participant fills one place in the party, `position` 1 to the booking's party size, so a party never holds more people than it bought. The database checks the place against the booking (`booking_participants_party_size`) and keeps one participant per place (`booking_participants_position_key`).
- **What is recorded.** The full name; whether a minor; for a minor, the guardian's name and email; for anyone, an optional email of their own. A minor without a guardian, or an adult with one, never reaches the table (`booking_participants_guardian`). Addresses are stored lowercased and ASCII, as the booker's are.
- **Edited in place, never removed.** The guest corrects a place's details; the participant keeps its id, booking, and place for good (`booking_participants_immutable`). Removing a shared-seat participant releases a seat and is a later goal. No role deletes a participant.
- **Only while the booking stands.** A participant joins or changes only on a confirmed booking, and the service refuses it once the trip has departed. The booking's row lock orders a participant change against a cancellation, so whichever commits second sees the other.
- **Personal data.** Names and addresses live in the participant rows and the responses that read them. Audit rows and events record which place changed and which fields (`changed: ["name", "email"]`), never the values. Finance never reads them.

```ts
listParticipants(trx, tenantId, bookingId): Promise<{ partySize, participants: ParticipantView[] } | null>
putParticipant(trx, ctx, { bookingId, position, details: { name, isMinor, email?, guardian? } }, hooks?):
  Promise<
    | { kind: "created"; participant } | { kind: "updated"; participant; changed: ParticipantField[] }
    | { kind: "unchanged"; participant }
    | { kind: "booking_not_found" } | { kind: "booking_canceled" } | { kind: "trip_departed" }
    | { kind: "position_out_of_range"; partySize }
  >
```

`putParticipant` is idempotent by place: the same details again change nothing and record nothing. It locks the booking row, then the participant at the place, so concurrent writes to one place serialize: one creates, the rest update or find it unchanged. The contract is [packages/contracts/src/participants.ts](../contracts/src/participants.ts).

| Change | Audit action | Outbox topic |
|---|---|---|
| participant named | `participant.added` | `booking.participant.added` `{ bookingId, participantId, position }` |
| participant corrected | `participant.updated` | `booking.participant.updated` `{ bookingId, participantId, position, changed }` |

### Lifecycle hooks: how waivers attach

Waivers (G2.15) must be assigned atomically when a booking confirms and when a participant is added ([architecture: waivers](../../docs/v2/04-architecture.md#waivers)). This package does not depend on the waiver module; instead it runs hooks the API passes in, inside the transaction that makes the change, after the change's rows are written and before commit. The interface and its rules are in [src/hooks.ts](src/hooks.ts):

```ts
interface BookingHooks {
  bookingConfirmed?(trx, ctx, { bookingId, checkoutSessionId, tripId, productId, partySize, reacquired }): Promise<void>;
  participantAdded?(trx, ctx, { bookingId, participantId, position }): Promise<void>;
  participantUpdated?(trx, ctx, { bookingId, participantId, position, changed }): Promise<void>;
  bookingCanceled?(trx, ctx, { bookingId, cancellationId, refundId }): Promise<void>;
}
```

- **Where they run.** `bookingConfirmed` in `book()`, on every path that confirms: the webhook route (`handleVerifiedEvent(db, provider, event, { hooks })`), which the fake provider's delivery also goes through, and the checkout sweep's reprocessing (`sweepCheckouts(db, { hooks })`, `processProviderEvent(trx, ctx, id, { hooks })`). `participantAdded` and `participantUpdated` in `putParticipant`. `bookingCanceled` in the cancellation, after the booking is canceled and its seats released.
- **One wiring point.** The API builds the hooks once, in [apps/api-worker/src/booking-hooks.ts](../../apps/api-worker/src/booking-hooks.ts), and passes them on every path above. The waiver module returns its hooks there; nothing else in the API changes. Tests pass their own (`AppDeps.bookingHooks` in the API).
- **Atomic both ways.** Whatever a hook writes, assignments and `enqueueMessage` rows included, commits or rolls back with the change. A throw rolls the change back.
- **Who may refuse.** Only `participantAdded` and `participantUpdated`, by throwing `BookingHookRefusal(code, message)`; the API answers 409 with that code. `bookingConfirmed` and `bookingCanceled` must not refuse: payment and confirmation never wait on waivers, and a throw in `bookingConfirmed` rolls back a confirmation whose money has moved, leaving the event received for the sweep's retry.
- **Ids only.** Events carry ids; a hook reads what else it needs through the transaction, such as `listParticipants`. It locks only its own module's rows, after the change's locks.
- **Also as events.** The same changes are outbox events (`booking.confirmed`, `booking.participant.added`, `booking.participant.updated`, `booking.canceled`) for work that may happen after commit.

### Cancellation within policy

A guest cancels a confirmed booking whose trip has not departed, once. The remedy comes from the booking's own policy version (its order's), on the database clock:

1. **The cutoff.** `cutoff = departure - change_cutoff_minutes`. Before it, the policy's before-cutoff remedy applies; at or after it, the after-cutoff remedy.
2. **The refund.** `full_refund` returns the whole payment, `percent_refund` its basis points of the payment rounded half up to the cent, `none` nothing. The percentage applies to everything paid, taxes and fees included.
3. **Credit is not self-service.** A remedy of `credit` is refused (`remedy_requires_operator`): credits are G2.9, and the operator issues them. The guest is told to contact the operator.
4. **What happens, in one transaction:** the cancellation row with the terms as applied; the booking moves to `canceled`; the refund row (reason `booking_canceled`) for the computed amount when it is above zero; the booking's confirmed hold is released, so the seats return to sale; the booking's confirmation or link email still waiting to go out (a confirmation in its retry backoff) is canceled, so it never arrives after the cancellation, while the links it carried keep working for the canceled booking's page; audit, events, the cancellation email, and the `bookingCanceled` hook. After commit, `settleRefund` sends the refund through the payment adapter with the refund row's idempotency key, as G2.7's refunds do; an unknown outcome stays requested for the checkout sweep. The cancellation email says the refund is on its way, not that it has arrived. If the provider refuses it, the transaction that records the refusal also writes one follow-up email (`booking_refund_failed`) telling the guest the money has not been returned yet and that the operator will be in touch; it is written under a savepoint, so an email problem never undoes the recorded refusal. The order stays `paid`: it is the immutable statement of the sale, and the refund records the money going back.
5. **Say the amount first.** A preview returns the remedy, the amount, the cutoff, and the policy text; the cancel command carries the amount the guest was shown and is refused (`cancellation_terms_changed`) if the terms moved since, for instance because the cutoff passed in between.

The database is the judge, for every role, the owner included:

- `booking_cancellations` (one per booking, append-only): its trigger reads the booking, its order's policy version, its trip, and its payment, and refuses a row whose cutoff, side of the cutoff (the database clock), remedy, basis points, paid amount, or refund amount is not what the policy gives (`booking_cancellations_terms`), a credit remedy (`booking_cancellations_credit`), a departed trip (`booking_cancellations_departed`), or a booking that is not confirmed.
- `bookings`: the only change is `confirmed` to `canceled`, with its cancellation row (`bookings_evidence`); everything else about a booking is fixed (`bookings_immutable`). At commit, a canceled booking's hold must be released (`bookings_canceled_released`).
- `payment_refunds`: a `booking_canceled` refund needs its booking canceled and the cancellation naming this refund for exactly this amount, up to what was paid. At commit, a cancellation with money to return has its refund row (a deferred foreign key). One refund per payment stays, so a booking is refunded at most once.

**Lock order:** checkout session, booking, payment, trip, hold: the confirmation path's order with the booking after the session. Booking and participant rows are locked FOR NO KEY UPDATE, never FOR UPDATE, so the email delivery job's foreign key checks (a link names its booking and participant) never wait behind a transaction that may wait for that job; `cancelMessage` and `revokeAccessLinks` wait for a claim in progress. Code that may cancel a message, such as a lifecycle hook, keeps to the same rule. A late or duplicate payment event for a canceled booking's checkout finds its payment already succeeded and changes nothing (`already_succeeded`); a late failure is `ignored_after_success`.

## Lock order

Inbox event, checkout session, payment, trip, hold, then the order and the rest. Opening a checkout takes transaction-scoped advisory locks on the quote and the client address before any row lock, then the trip and its holds. The database's own checks lock the payment row before inserting a booking or a refund for it, so the two can never both be written. Expiring a checkout takes its session and then its hold row with SKIP LOCKED, never waiting and never touching the trip. External calls never run inside a transaction. Every command needs READ COMMITTED, as the inventory commands do.

## What the database adds

Beyond the chain of custody above, triggers in the checkout migration hold these for every role:

- A hold that backs a confirmed booking keeps its seats: releasing it is refused while the booking stands (`capacity_holds_booked`).
- At commit, a hold a checkout owns is confirmed only with its booking, and is not released while its checkout is open (`capacity_holds_checkout`).
- A payment is booked or refunded, never both: a refund is refused for a payment with a booking, and a booking for a payment with a refund.
- A checkout cannot outlive its quote's validity.
- A trip with confirmed bookings cannot be canceled.

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
| booking note added (G2.12c) | `booking.note_added`, by the note's id | |
| a day exported as CSV (G2.12c) | `booking_day.exported`, with the row count and whether guests' details were included | |
| confirmation email not written (lane 1) | `booking.confirmation_email_failed` | `booking.confirmation_email_failed` |

The confirmation email is written in the confirming transaction under a savepoint (lane 1, review F2). A failure writing it, such as a stored value the email cannot carry, rolls back only the email: the booking confirms, its money and seats stay with it, and the audit row and event above tell staff that no email went out. Subjects, previews, and recipients' names are made single-line from stored data (`singleLine`), so a product name with a tab or a newline no longer fails.

Hold transitions keep their own `hold.*` audit rows and `inventory.hold.*` events.

## API

| Route | Answers |
|---|---|
| `POST /v1/public/checkout-sessions` | 201 checkout and what to pay with; 404 `quote_not_found`; 409 `quote_expired`, `quote_already_used`, `trip_not_bookable`, `insufficient_capacity`, `party_size_out_of_range`, `payments_unavailable`; 422 `policy_not_accepted`, `payment_amount_too_small`, `idempotency_key_reused`; 429 `rate_limited`, `too_many_checkouts`; 503 `payments_unavailable`, `payment_provider_unavailable` |
| `GET /v1/public/checkout-sessions/{id}` | 200 checkout; 401 `checkout_secret_required`; 404 `checkout_not_found` |
| `POST /v1/public/checkout-sessions/{id}/cancel` | 200 checkout; 401; 404; 409 `checkout_not_cancelable`; 429 |
| `POST /v1/webhooks/payments/{provider}` | 200 `{ received, duplicate, outcome }`; 400 `signature_invalid`, `payload_invalid`; 403 `origin_not_allowed`; 404; 413 `payload_too_large` |
| `GET /v1/staff/tenants/{tenantId}/trips/{tripId}/bookings` | owners and booking staff; the trip's bookings with booker contact |
| `GET /v1/staff/tenants/{tenantId}/finalization-exceptions?limit=&before=` | every role; newest first, a page at a time; who paid only with `bookings.read`; 400 `cursor_invalid` |
| `GET /v1/staff/tenants/{tenantId}/bookings?date=&tripId=&limit=&after=` | every role (G2.12b); a local date's trips and a page of its bookings; 400 `cursor_invalid` |
| `GET /v1/staff/tenants/{tenantId}/bookings/{bookingId}` | every role (G2.12b); 404 `booking_not_found` |
| `GET /v1/staff/tenants/{tenantId}/booking-references/{reference}` | every role (G2.12b); 404 `booking_not_found` |
| `GET /v1/staff/tenants/{tenantId}/trips/{tripId}/roster` | owners and booking staff (G2.12b); 403 for finance; 404 `trip_not_found` |
| `POST /v1/staff/tenants/{tenantId}/booking-searches` | every role (G2.12c); `{ q?, from?, to?, limit?, after? }`, at least one of the first three; name and email matching for `bookings.read` only; 400 `validation_failed`, `invalid_range`, `cursor_invalid`; 403 `origin_not_allowed` |
| `GET /v1/staff/tenants/{tenantId}/booking-day-totals?date=` | every role (G2.12c); the day's control totals; 422 `day_too_large` |
| `GET /v1/staff/tenants/{tenantId}/booking-day-export?date=` | every role (G2.12c); `text/csv` attachment, booker columns for `bookings.read` only; audited; 422 `day_too_large` |
| `GET /v1/staff/tenants/{tenantId}/bookings/{bookingId}/notes` | owners and booking staff (`notes.read`, G2.12c); 403 for finance; 404 `booking_not_found` |
| `POST /v1/staff/tenants/{tenantId}/bookings/{bookingId}/notes` | owners and booking staff (`notes.write`, G2.12c); `{ body }` with an `Idempotency-Key`; 201 `{ note: { id, author, createdAt } }`, without the text; 403 for finance; 404 `booking_not_found`; 422 `idempotency_key_reused` |
| `GET /v1/staff/tenants/{tenantId}/bookings/{bookingId}/participants` | owners and booking staff (lane 1, G2.11c); the party as named so far; 403 for finance; 404 `booking_not_found` |
| `GET /v1/staff/tenants/{tenantId}/bookings/{bookingId}/messages` | owners and booking staff (lane 1, G2.11c); each email's delivery state, with no recipient or content; 403 for finance; 404 `booking_not_found` |
| `POST /v1/public/booking-access` | the management link's explicit redemption, `{ token }` in the body; 201 a booking session; 404 `link_not_found`; 410 `link_expired`, `link_used`, `link_superseded`, `link_revoked`; 429 |
| `POST /v1/public/booking-access/renewals` | `{ token }` of any earlier link; 202 for every token alike, and mails a new link to the booker on file, at most three an hour; 429 |
| `POST /v1/public/checkout-sessions/{id}/manage-session` | the checkout secret as a bearer token, within an hour of confirmation; 201 a booking session; 401 `checkout_secret_required`; 404; 409 `checkout_not_confirmed`; 410 `manage_window_closed` |
| `GET /v1/public/manage/booking` | the booking session as a bearer token; 200 the booking, its receipt, its party, and what canceling now gives; 401 `session_required`, `session_expired` |
| `PUT /v1/public/manage/participants/{position}` | the session and an idempotency key; 200 `{ participant, created }`; 409 `booking_canceled`, `trip_departed`, or a waiver hook's code; 422 `position_out_of_range`, `idempotency_key_reused` |
| `GET /v1/public/manage/cancellation` | the session; 200 the terms on the database clock |
| `POST /v1/public/manage/cancellation` | the session, an idempotency key, and `{ expectedRefundAmount }`; 200 the canceled booking with its refund; 409 `cancellation_terms_changed`, `trip_departed`, `remedy_requires_operator`; 422 `idempotency_key_reused` |
| `POST /v1/public/manage/link-email` | the session; 202, a new link to the booker's address; 429 `link_email_rate_limited` after three an hour |
| `POST /v1/public/manage/session/end` | the session; 200, and the session stays ended |

Every guest route resolves the operator from the verified Origin, as the checkout does; another operator's link, session, or checkout answers as unknown. Tokens travel in bodies and `Authorization` headers only, never in a URL, and every answer is `no-store`.

What the guest checkout UI calls:

1. Generate a checkout secret (32 random bytes, base64url) and an idempotency key, and keep both for the session (session storage).
2. `POST /v1/public/checkout-sessions` with `{ quoteId, acceptedPolicyVersion, booker, checkoutSecret }` and the key. The response has the checkout (id, state, amount, expiry) and `payment: { provider, paymentRef, clientSecret }`. On 503 `payment_provider_unavailable`, or a lost response, send the same request again with the same key: it returns the same checkout and finishes creating the payment.
3. Pay at the provider with the client secret. With the fake provider: `POST /v1/fake-provider/payments/{paymentRef}/succeed` (or `/fail`) with `Authorization: Bearer <clientSecret>`.
4. Poll `GET /v1/public/checkout-sessions/{id}` with `Authorization: Bearer <checkoutSecret>` until the state is `confirmed` (show `booking.reference`), `failed`, `expired`, or `unfulfilled` (show the refund).
5. To change the party before paying, `POST .../cancel` first, then re-quote.

The checkout secret and the client secret travel in headers and bodies only, never in URLs. Every response is `Cache-Control: no-store` and `Vary: Origin`. Public routes resolve the tenant from the verified Origin, as `/v1/public/trips` does.

## Deferred and known gaps

- Deposits and balances (G2.8), credits (G2.9), rescheduling, removing a participant, and staff cancellation are not here. Participants and guest cancellation within policy arrived with lane 1 (G2.11c, above).
- **A late success gets no priority (the owner kept this on 2026-10-19).** It reacquires only if its seats are still free, and new checkouts queued for the same trip usually take them first: in the test specialist's race with no sweep, 1 of 10 late payments reacquired and 9 were refunded. Every one was handled correctly: a guest who paid after the seats were gone is refunded in full, with an exception for the operator. The owner confirmed there is no grace period ([owner confirmations](../../docs/v2/12-demo-build-plan.md#goal-sequence)).
- Nothing reconciles a payment whose webhook never arrives, other than the provider's own retries (Stripe retries for days; the fake can redeliver). The adapter's `retrievePayment` is the seam for the reconciliation goal (G2.10).
- The booker's name and email stay on abandoned checkouts. A retention job should clear them after a set time before real guests use the system.
- Finalization exceptions are listed in the console (G2.12b) but have no resolution workflow yet; G2.12 adds one.
- A trip's bookings read (G2.7) has no pagination; the console's day list pages with a cursor, and a roster is complete because a trip seats at most 500.
- A Stripe adapter must map Stripe's events onto the neutral kinds: a declined attempt the guest may retry is not `payment.failed`, and Stripe's pending refunds need refund events, which the inbox records as `other` today.
- Expired checkouts and their orders stay `expired` and `pending`: a late success may still confirm them.
- **Console completion (G2.12c).** Search scans the tenant's bookings with `ILIKE`; a trigram index on the booker's name and email belongs before a pilot operator's history grows large. A booking reference that a spreadsheet guessing types reads as a number loses its form: one made only of digits (about one in 11,000) or of digits around a single E, read as scientific notation such as 12345E67 (about one in 18,000); together about one in 6,900. A spreadsheet's text import keeps it whole. Whatever fix is chosen should treat every reference that `Number()` reads as finite alike. The formula guard's apostrophe is visible in some spreadsheets, and changes the rare email or name that starts with one of those characters. A canceled booking (lane 1) stays on the day's report and its CSV, with its state: its order and its refunds stay in the money columns, and it counts 0 in the bookings and guests columns, as its seats went back on sale. The day list's counts and the roster follow the same rule; search finds canceled bookings, as canceled. Notes return the newest 200.

## Tests

- `pnpm --filter @tidegrid/domain-booking test` runs unit tests.
- `pnpm --filter @tidegrid/domain-booking test:integration` runs against a throwaway Neon branch with `TIDEGRID_EPHEMERAL_DB=1`. `src/test-fixtures.ts` (exported as `@tidegrid/domain-booking/testing`) builds a tenant through the real services, adds a fake connected account, a tax rate, and a promotion, and produces events only by signing and verifying them.
