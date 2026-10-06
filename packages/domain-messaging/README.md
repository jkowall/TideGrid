# @tidegrid/domain-messaging

Transactional email for the demo build: a provider-neutral email adapter, a fake provider, branded templates, and outbox-driven delivery (the G2.16 demo shim, lane 1). The design authority is [product scope: transactional email](../../docs/v2/02-product-scope.md#transactional-email-sms-and-replies), [the target architecture](../../docs/v2/04-architecture.md#messaging) (provider-neutral adapter, versioned templates, recorded delivery outcome) and its [retained invariants](../../docs/v2/04-architecture.md#retained-invariants) (domain state and outbox records commit together; external calls never hold a database lock). Tables are in migration `0008_self_service_and_email.sql` and follow the [tenancy contract](../database/README.md).

## The email shim is the demo's email

The owner decided on 2026-10-05, "You can just shim stripe or others". The demo therefore sends email through a fake provider behind this adapter, as payments run through the payment shim, and does not wait on Cloudflare Email Service. The narrowing is recorded in the [demo build plan](../../docs/v2/12-demo-build-plan.md#goal-sequence) beside the payment narrowing. The fake follows the path a real provider will: TideGrid enqueues a message in the transaction that causes it, a delivery job sends it after commit with an idempotency key, and the outcome is recorded. A Cloudflare Email Service adapter replaces the fake behind the same interface before any live booking; the fake is refused in a production configuration. No real email is delivered.

## Enqueueing a message

```ts
enqueueMessage(trx, ctx, {
  dedupeKey,          // "<topic>:<ids>", e.g. "booking.confirmation:<bookingId>"
  template,           // "booking_confirmation", "waiver_request", ...
  templateVersion,    // the template's version, recorded with the message
  to: { email, name? },
  bookingId?, participantId?, subjectRef?,   // what the message is about
  content: { subject, preview?, blocks: EmailBlock[] },
  accessLink?: { purpose, path, ttlSeconds? }, // a link issued at send time, see below
  notBefore?,         // send no earlier than this (a reminder); default now
}): Promise<{ kind: "enqueued"; messageId } | { kind: "duplicate"; messageId }>
```

- **In the caller's transaction.** The message row commits or rolls back with the change that causes it: a booking's confirmation, its cancellation, a participant's waiver request. Nothing is sent inside a transaction.
- **Once per key.** `dedupeKey` is unique per tenant, for ever. A retried command, a replayed webhook, or a hook that runs twice enqueues nothing new and answers `duplicate` with the first message's id. Choose keys that name the logical message: one confirmation per booking, one waiver request per assignment and delivery generation.
- **Rendered now, branded.** The content is rendered when it is enqueued, into the tenant's branded HTML and plain text, with the tenant's active brand (its name, colors, and contact email as the reply-to address). The rendered subject and bodies are stored with the template version, so what was sent is what the record says. Callers give structured blocks, never markup: every text is escaped, so tenant and guest content cannot inject HTML.
- **Personal data.** The recipient, the rendered bodies, and the names in them are personal data. They stay in the message row and the provider call. Audit rows and events carry ids only.

```ts
type EmailBlock =
  | { kind: "heading"; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "details"; rows: { label: string; value: string }[] }        // a label and value table
  | { kind: "lines"; rows: { label: string; amount: string; strong?: boolean }[] }  // a receipt
  | { kind: "action"; label: string; href: "access_link" | `https://${string}` }   // the one button
  | { kind: "note"; text: string };
```

### Access links in email

A link that grants access (the booking's management link, and a waiver signing link for G2.15) is never stored in a message. The message names its purpose and path; the delivery job issues the link when it sends, stores only the token's SHA-256, and writes the URL into the body at that moment, in the action's `href` and as visible text. The raw token travels only in the email, in the URL's fragment (`https://<operator site><path>#t=<token>`), so it never reaches a server log, a `Referer` header, or a link scanner's GET. The guest page exchanges it for a restricted session with an explicit POST (the [booking contract](../domain-booking/README.md#guest-self-service-lane-1-g211c)).

- The link's origin is the operator's guest site, from `GUEST_LINK_ORIGIN` (default `https://{slug}.book.tidegrid.us`; locally `http://{slug}.book.localhost:<port>`), and the delivery job checks that its hostname is an active, verified hostname of the message's tenant before sending. A message whose link host does not resolve to its tenant fails as `link_host_unmapped`.
- The issued link keeps the message's booking, participant, and `subjectRef`, and the message's id.
- Issuing a link for a message revokes, as `superseded`, the unused links of the same booking, purpose, participant, and subject that other messages carried, so only the newest email's link works. Retries of one message revoke nothing of their own: the provider's idempotency key keeps the first accepted email, and a token issued for an attempt the provider never accepted is never delivered and expires.

## Access links and guest sessions

Every function takes the caller's tenant transaction, so it commits or rolls back with the caller's change. Tokens are 32 random bytes, base64url (43 characters); only SHA-256 hashes with a purpose prefix are stored. Purposes are `booking_manage` (the booking's management page, lane 1) and `waiver_sign` (a participant's waiver, G2.15, which needs a participant).

```ts
redeemAccessLink(trx, ctx, { token, purpose }): Promise<
  | { kind: "redeemed"; link: { linkId, bookingId, participantId, messageId, subjectRef, purpose } }
  | { kind: "invalid" }    // malformed, unknown, another tenant's, or another purpose's
  | { kind: "expired" } | { kind: "used" }
  | { kind: "superseded" } // a newer email's link replaced it
  | { kind: "revoked"; reason: "completed" | "withdrawn" | "recipient_changed" | "booking_canceled" | "staff" }
>
revokeAccessLinks(trx, ctx, { bookingId, purpose, participantId?, subjectRef?, reason }): Promise<number>
openGuestSession(trx, ctx, { link, ttlSeconds? } | { checkout: { checkoutSessionId, bookingId }, ttlSeconds? }):
  Promise<{ sessionId, token, bookingId, participantId, purpose, subjectRef, expiresAt }>
resolveGuestSession(trx, tenantId, token, purpose): Promise<GuestSession | null>
revokeGuestSession(trx, ctx, sessionId): Promise<boolean>
revokeGuestSessions(trx, ctx, { bookingId, purpose, participantId?, subjectRef? }): Promise<number>
issueAccessLink(trx, ctx, { bookingId, participantId?, purpose, subjectRef?, messageId?, ttlSeconds }) // the delivery job's
```

- **Redeem only on an explicit POST.** A link is consumed once, atomically: concurrent redemptions of one token serialize on its row, one wins and the rest answer `used`. A page that receives a link reads the token from its URL fragment and redeems it only when the guest acts, so an email scanner's GET or a link preview consumes nothing.
- **Open the session in the same transaction.** The database opens a session only from a link consumed in that very transaction (`guest_sessions_evidence`), or, for the guest who just paid, from the checkout that made the booking within an hour of confirmation. A session lasts at most 12 hours (one hour by default) and returns its raw token once.
- **Revocation reasons.** `completed`: the purpose is done (a waiver signed). `withdrawn`: no longer needed (a participant or requirement removed). `recipient_changed`, `booking_canceled`, `staff`: as named. `superseded` is set by issuing a newer link. Without `participantId` or `subjectRef`, every participant's or subject's links of that booking and purpose are revoked; pass `null` to mean "the booking-level ones".
- **Times.** The database clock decides expiry. A link's or session's expiry can move earlier, never later, as holds' can; tests make time pass that way.

## Message status

```ts
cancelMessage(trx, ctx, messageId): Promise<
  { kind: "canceled" } | { kind: "not_cancelable"; state } | { kind: "not_found" }>
getMessageStatus(trx, tenantId, messageId): Promise<MessageStatus | null>
listBookingMessages(trx, tenantId, bookingId): Promise<MessageStatus[]>

interface MessageStatus {
  id; template; templateVersion;
  state: "queued" | "sending" | "sent" | "failed" | "canceled";
  attempts; lastAttemptAt; nextAttemptAt; sentAt; failedAt; canceledAt;
  failureCode;   // the last attempt's error: provider_unavailable, bounced, retries_exhausted, link_host_unmapped, send_error
  provider; createdAt;
}
```

`cancelMessage` cancels only a queued message. A message the delivery job is claiming right now answers `not_cancelable` with state `sending`: it goes out. Status reads carry no recipient or content. Provider acceptance is not proof that a guest read a message or used its link.

## Delivery

A delivery job sends due messages after commit and records each outcome. It runs from the API Worker's cron, after the checkout sweep, and right after a request commits a message (in the background, so the guest sees the email at once). Correctness never waits for it.

- **States, one way.** `queued`, then `sending` (claimed for a short lease), then `sent`, or back to `queued` with a later attempt after a temporary failure, or `failed`. A queued message may be `canceled` (a waiver request made obsolete). The database refuses every other move, for every role.
- **Idempotent sends.** The provider receives the message id as its idempotency key. A crash after the provider accepted a message and before the outcome was recorded leaves the message `sending`; once the lease lapses the job claims it again and sends with the same key, and the provider answers with the first message instead of sending twice.
- **Retries.** A temporary failure (`EmailProviderUnavailableError`) retries after 1, 5, 15, and 60 minutes, then 4 hours, and fails after six attempts as `retries_exhausted`. A refusal (`EmailProviderRejectedError`, such as a bounced address) fails at once with the provider's code. Failures stay visible on the message and in staff reads.
- **No duplicate claims.** Claims take due rows with `FOR UPDATE SKIP LOCKED`, so concurrent jobs never send one message at once; recording an outcome checks that the attempt it ran is still the message's latest.

## The adapter

```ts
interface EmailProvider {
  name: "fake" | "cloudflare";
  send(message: {
    idempotencyKey, tenantId,
    from: { email, name }, replyTo, to: { email, name },
    subject, html, text,
  }): Promise<{ providerMessageId: string }>;   // throws EmailProviderUnavailableError or EmailProviderRejectedError
}
```

No method runs inside a database transaction. `tenantId` is metadata, as a provider tag would be; the fake files messages by it.

## The fake provider

`FakeEmailProvider` keeps what it "sends" in its own append-only, tenant-owned table, `fake_email_deliveries`, and never reads or writes TideGrid's message table.

- **Exists only under `EMAIL_PROVIDER=fake`,** and refuses `ENVIRONMENT=production`.
- **Idempotent by key.** The first accepted delivery for a key is the only one; a repeat answers with it.
- **Scripted failures for the demo.** A recipient whose local part ends in `+fail-once` gets one temporary failure per message before it is accepted; one ending in `+bounce` is refused as `bounced`. Everything else is accepted.
- **The mailbox.** With `EMAIL_PROVIDER=fake` and `ENVIRONMENT=local` only, the API serves a mailbox at `/v1/fake-email/mailbox`: each local guest site's accepted messages, newest first, and each message's HTML, so the demo can open the management link. Elsewhere the routes answer 404.
