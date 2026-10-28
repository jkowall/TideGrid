# @tidegrid/domain-messaging

Transactional email for the demo build: a provider-neutral email adapter, a fake provider, a Cloudflare Email Service adapter that is built but switched off (G2.16a), branded templates, and outbox-driven delivery (the G2.16 demo shim, lane 1). The design authority is [product scope: transactional email](../../docs/v2/02-product-scope.md#transactional-email-sms-and-replies), [the target architecture](../../docs/v2/04-architecture.md#messaging) (provider-neutral adapter, versioned templates, recorded delivery outcome) and its [retained invariants](../../docs/v2/04-architecture.md#retained-invariants) (domain state and outbox records commit together; external calls never hold a database lock). Tables are in migration `0009_self_service_and_email.sql` and follow the [tenancy contract](../database/README.md).

## The email shim is the demo's email

The owner decided on 2026-10-05, "You can just shim stripe or others". The demo therefore sends email through a fake provider behind this adapter, as payments run through the payment shim, and does not wait on Cloudflare Email Service. The narrowing is recorded in the [demo build plan](../../docs/v2/12-demo-build-plan.md#goal-sequence) beside the payment narrowing. The fake follows the path a real provider will: TideGrid enqueues a message in the transaction that causes it, a delivery job sends it after commit with an idempotency key, and the outcome is recorded. The Cloudflare Email Service adapter (G2.16a, [below](#the-cloudflare-adapter-g216a)) is built behind the same interface and stays off in every deployed configuration until the owner authorizes the live step. The API accepts the fake only in local development (coordinator default D6 A, 2026-10-28, pending owner confirmation; the fake itself still refuses only `ENVIRONMENT=production`). No real email is delivered.

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
- **Rendered now, branded.** The content is rendered when it is enqueued, into the tenant's branded HTML and plain text, with the tenant's active brand (its name, colors, and contact email as the reply-to address). The footer names the operator's contact email and phone, a North American number written as the booking site writes it, (305) 555-0142 (`displayPhone` in `src/render.ts`). The rendered subject and bodies are stored with the template version, so what was sent is what the record says. Callers give structured blocks, never markup: every text is escaped, so tenant and guest content cannot inject HTML.
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

- The link's origin is the operator's guest site, from `GUEST_LINK_ORIGIN` (default `https://{slug}.book.tidegrid.us`; locally `http://{slug}.book.localhost:<port>`), and the delivery job checks that its hostname is an active, verified hostname of the message's tenant before sending. A message whose link host does not resolve to its tenant fails as `link_host_unmapped`. Since G2.14b the origin goes through the same strict origin parser as a browser Origin, with the deployment environment the API passes (`environment`): https only, no port, no path, no trailing dot, and no `*.localhost` name outside local development. A caller that passes no environment gets the strict deployed rules; local tests on `*.localhost` say `environment: "local"`.
- The issued link keeps the message's booking, participant, and `subjectRef`, and the message's id.
- Issuing a link for a message revokes, as `superseded`, the unused links of the same booking, purpose, participant, and subject that older messages carried (written before it), so the newest email's link is the one that works. A retry of an older message never supersedes a newer message's link: a confirmation whose answer was lost, retried after the guest asked for a new link, leaves the new link working. Retries of one message revoke nothing of their own. On a provider that deduplicates (the fake), the idempotency key keeps the first accepted email, and a token issued for an attempt the provider never accepted is never delivered and expires. On one that does not (Cloudflare), an attempt whose outcome is unknown is never repeated (see Delivery), so a message's delivered copy holds its only link. Superseding skips a link another transaction holds at that moment (it is being used or revoked), so a claim never waits on a lock.
- Closing a subject's access closes its pending email too. `revokeAccessLinks` with `recipient_changed`, `completed`, `withdrawn`, or `booking_canceled` first takes the row locks of every link-carrying message of that booking, purpose, participant, and subject written before its transaction and not yet sent (queued or being sent), cancels them (`failureCode` `recipient_changed` or `access_withdrawn`), and only then revokes the links. Because it waits for a delivery claim in progress, the link that claim issued is revoked with the rest; a message no delivery has claimed yet, which has no link, is canceled before one is ever minted; and a claim that comes while the revocation is open skips the locked message. So no email goes to an address that was corrected away from, or asks to sign a waiver already signed, with a link that works. `staff` and `superseded` revocations close no email.
- The claim keeps a backstop for links revoked some other way (an operator's statement, a future caller): before it issues a link, under the message's row lock, it cancels a message whose own link was revoked for any reason but `superseded`, or whose subject saw a link revoked as one of those four reasons after the message was written. That backstop sees only revocations committed before the claim began; the guarantee above is the one to rely on.

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
cancelMessage(trx, ctx, messageId, options?: {
  linkReason?: AccessRevocationReason; // why its links stop working; withdrawn by default
  code?: string;                       // why it was canceled, such as recipient_changed
  revokeLinks?: boolean;               // false keeps its links working; true by default
}): Promise<
  | { kind: "canceled"; inFlight: boolean; revokedLinks: number }
  | { kind: "not_cancelable"; state } // already sent, failed, or canceled
  | { kind: "not_found" }>
getMessageStatus(trx, tenantId, messageId): Promise<MessageStatus | null>
listBookingMessages(trx, tenantId, bookingId): Promise<MessageStatus[]>

interface MessageStatus {
  id; template; templateVersion;
  state: "queued" | "sending" | "sent" | "failed" | "canceled";
  attempts; lastAttemptAt; nextAttemptAt; sentAt; failedAt; canceledAt;
  failureCode;   // the last attempt's error: provider_unavailable, bounced, retries_exhausted, link_host_unmapped, send_error,
                 // and from the Cloudflare adapter outcome_unknown, invalid_message, recipient_suppressed, recipient_not_allowed,
                 // provider_rate_limited, provider_quota_exceeded, sender_not_verified, provider_account_suspended; null once sent;
                 // for a canceled message, the cancellation's own reason (recipient_changed, access_withdrawn, booking_canceled) or null
  provider; createdAt;
}
```

`cancelMessage` cancels a message that has not gone out, queued or being sent, and in the same transaction revokes the unused links it carried (with `linkReason`). Once the caller commits, no email of that message opens anything and the delivery job never claims it again. It waits for a delivery claim in progress, so the link that claim issued is revoked too; the claim is a short transaction that never waits on another's lock. A message canceled mid-send (`inFlight: true`) may still arrive, with a link that opens nothing; its attempt records nothing and is never retried. Correcting an address: in one transaction, revoke the old address's links as `recipient_changed` (which closes the old address's pending email, as above), and enqueue the new one. Calling `cancelMessage` on the old message as well is harmless: it answers `not_cancelable` with state `canceled`. A message with no link, which no revocation reaches, is canceled with `cancelMessage` alone.

**Locks for callers.** A transaction that may call `cancelMessage` or `revokeAccessLinks` must not hold `FOR UPDATE` on a row a link references (the booking, the participant): the claim's foreign key checks take `KEY SHARE` on them, and would wait while those functions wait for the claim. Lock those rows `FOR NO KEY UPDATE`, as domain-booking does.

Status reads carry no recipient or content. Provider acceptance is not proof that a guest read a message or used its link.

## Delivery

A delivery job sends due messages after commit and records each outcome. It runs from the API Worker's cron, after the checkout sweep, and right after a request commits a message (in the background, so the guest sees the email at once). Correctness never waits for it.

- **States, one way.** `queued`, then `sending` (claimed for a short lease), then `sent`, or back to `queued` with a later attempt after a temporary failure, or `failed`. A queued or sending message may be `canceled` (a waiver request made obsolete, an address corrected); a sending one's attempt then records nothing. The database refuses every other move, for every role.
- **Idempotency is the provider's to state.** The provider receives the message id as its idempotency key, and says in `deduplicates` whether a repeat returns the first email. Only `true` counts: a provider that leaves it unset is treated as one that does not, so a new provider fails safe. A crash after the provider accepted a message and before the outcome was recorded leaves the message `sending` until its lease lapses. Then:
  - **A provider that deduplicates** (the fake): the job claims it again and sends with the same key, and the provider answers with the first message instead of sending twice. An unknown outcome is retried the same way.
  - **A provider that does not** (Cloudflare, `deduplicates: false`): at most once (coordinator default D1 B, 2026-10-28, pending owner confirmation). The lapsed message fails as `outcome_unknown` with no second send. So does an attempt whose outcome is unknown: an `EmailProviderUnavailableError` with `outcome: "unknown"` (the default), or a throw that is not the provider's answer once the provider was called. A throw before the call (filling the link into the bodies) sent nothing, so it retries as `send_error` on every provider. Only a temporary failure the provider says was not sent (`outcome: "not_sent"`) is retried. This keeps product scope's rule that a retry never sends the same message twice through one channel. The cost is a missed email: a guest recovers a management link by asking for a new one, a waiver request has its audited resend, and the rest wait for staff resend (G2.16b).
- **Account-level faults stop the run.** An `EmailProviderUnavailableError` with `scope: "account"` (a sender not verified, a suspended account, a daily limit) is retried for its message, and stops the tenant's run and the sweep (D2 B): every other email would meet it too. A rate limit is not one: Cloudflare limits per account, domain, and recipient under one code, so a rate-limited message retries on its own and the run goes on.
- **A deadline.** `deadline` (epoch ms) claims a message only while the provider's `sendTimeoutMs` and a 2 s margin still fit before it. After-commit delivery passes 18 s from the request, inside the 30 s `waitUntil` budget, and leaves the rest to the cron. The cron passes none of its own, but the sweep now derives one from its budget: the run's start plus `budgetMs` (20 s), or the caller's deadline if earlier (pre-pilot hardening item 5, D9 B, a coordinator default pending owner confirmation). A run's sends therefore end within its budget, so the email job no longer delays the hostname job behind it on the cron's one connection by up to 25 sends of 10 s a tenant. A scheduled handler may run for 15 minutes of wall time ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/)); the budget, not that limit, bounds the job.
- **Fair turns across tenants (Part C).** `app.email_delivery_tenants` names due tenants least recently served first, from the `sweep_turns` stamps of migration 0013, and `runFairSweep` (database package) gives each listed tenant a turn of up to five messages (`turnMessages`), stamping it first, then goes round the tenants whose turn was full until the budget runs out. `limit` (25) stays the cap for one tenant's run. Turns start only while a claim still fits before the deadline (`sweepWindow`): with a 20 s budget and Cloudflare's 10 s send bound plus the 2 s margin, that is the first 8 s, so a tenant is never stamped or counted for a turn that could send nothing. A tenant's link origin is read once a run, at its first turn. An account-level fault or the deadline ends the whole run, as before. The report adds `turns`, `passes`, `deferredTenants`, and `stampFailures`.
- **Retries.** A temporary failure (`EmailProviderUnavailableError`) retries after 1, 5, 15, and 60 minutes, then 4 hours, and fails after six attempts as `retries_exhausted`. A refusal (`EmailProviderRejectedError`, such as a bounced address) fails at once with the provider's code. Failures stay visible on the message and in staff reads.
- **No duplicate claims.** Claims take due rows with `FOR UPDATE SKIP LOCKED`, so concurrent jobs never send one message at once; recording an outcome checks that the attempt it ran is still the message's latest.

## The adapter

```ts
interface EmailProvider {
  name: "fake" | "cloudflare";
  deduplicates?: boolean;   // only true promises a repeat with the same key returns the first email; unset means it does not
  sendTimeoutMs?: number;   // the longest one send can take, when the provider bounds it
  send(message: {
    idempotencyKey, tenantId,
    from: { email, name }, replyTo, to: { email, name },
    subject, html, text,
  }): Promise<{ providerMessageId: string }>;   // throws EmailProviderUnavailableError or EmailProviderRejectedError
}
new EmailProviderUnavailableError(code?, message?, { outcome?: "not_sent" | "unknown", scope?: "message" | "account" })
```

No method runs inside a database transaction. `tenantId` is metadata, as a provider tag would be; the fake files messages by it.

## The fake provider

`FakeEmailProvider` keeps what it "sends" in its own append-only, tenant-owned table, `fake_email_deliveries`, and never reads or writes TideGrid's message table.

- **Exists only under `EMAIL_PROVIDER=fake`,** and refuses `ENVIRONMENT=production`. The API builds it only when `ENVIRONMENT=local` and no `EMAIL` binding is set: it stores full bodies, raw link tokens included, so it must never run on a deployed database.
- **Idempotent by key.** The first accepted delivery for a key is the only one; a repeat answers with it.
- **Scripted failures for the demo.** A recipient whose local part ends in `+fail-once` gets one temporary failure per message before it is accepted; one ending in `+bounce` is refused as `bounced`. Everything else is accepted.
- **The mailbox.** With `EMAIL_PROVIDER=fake` and `ENVIRONMENT=local` only, the API serves a mailbox at `/v1/fake-email/mailbox`: each local guest site's accepted messages, newest first, and each message's HTML, so the demo can open the management link. Elsewhere the routes answer 404.

## The Cloudflare adapter (G2.16a)

`createCloudflareEmailProvider({ binding, recipients, environment, timeoutMs?, log? })` sends through the Workers `send_email` binding with the structured builder ([Workers API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/)). It holds no secret and makes no `fetch` call: the binding is authorized by the account and the Worker's deploy. It is switched off in every deployed configuration (see the API Worker's `src/email.ts`).

- **Mapping.** `from` as `{ email, name }` with the brand name; `to` as `{ email, name }`, or the bare address when there is no name; `replyTo` only when set; both bodies. Two headers only: `X-TideGrid-Message-Id` (the message id, opaque, for correlation; D5 A) and `Auto-Submitted: auto-generated`. The tenant id is never sent. `From`, `To`, `Subject` and `Reply-To` never go as headers ([headers](https://developers.cloudflare.com/email-service/reference/headers/)).
- **Not idempotent.** Cloudflare documents no idempotency key and sets `Message-ID` itself, so the adapter says `deduplicates: false` and delivery is at most once (see Delivery).
- **A recipient fence.** `recipients` is required: `{ kind: "only", addresses }`, compared lowercased and trimmed, or `{ kind: "any" }`, which the constructor refuses outside `environment: "production"`. A recipient off the list fails as `recipient_not_allowed` with no provider call. The API passes the `EMAIL_ALLOWED_RECIPIENTS` secret's addresses, so no address enters the repository (D3 B). At switch-on, queued mail to synthetic `.test` addresses fails the same way and never reaches Cloudflare (D4 A).
- **Bounded.** Each send races `timeoutMs` (the API passes 10 s). A timeout is an unknown outcome. Handlers go on the call before the race: a rejection after the timeout is swallowed and logged as `email_send_late_reject` with its documented code only; an acceptance after it is logged as `email_send_late_accept` with the message id and the provider id normalized as it would have been stored, the join key for a future events consumer. That copy went out, but its message ends `outcome_unknown` with no stored provider id.
- **Errors.** All 21 documented codes are mapped by name in `src/cloudflare-errors.ts`. This is TideGrid policy, since Cloudflare does not say which are retryable. Validation and header codes fail as `invalid_message`; `E_RECIPIENT_SUPPRESSED` as `recipient_suppressed`; `E_RECIPIENT_NOT_ALLOWED` as `recipient_not_allowed`. A rate limit (`provider_rate_limited`) is known not sent and retries its message. A daily limit, an unverified or unavailable sender, and a suspended account are temporary account-level faults (`provider_quota_exceeded`, `sender_not_verified`, `provider_account_suspended`), known not sent. `E_DELIVERY_FAILED`, `E_INTERNAL_SERVER_ERROR`, an unknown code, a throw without a code, and a timeout are unknown outcomes (`provider_unavailable`, `outcome: "unknown"`), so they end `outcome_unknown`. The page gives `E_DELIVERY_FAILED` the description "Could not deliver the email" and the common causes "SMTP delivery failure, recipient server rejection". A rejection by the recipient's server means something was sent and refused, which points toward Rejected. The mapping stays ambiguous, the side that never sends twice (coordinator default for D1), and G2.16-live asks whether a Rejected code would serve staff better.
- **Fields checked first.** A control character (C0, C1, or DEL, so CR and LF too) in a display name or the subject, or a sender, recipient, or reply-to that is not one address, fails as `invalid_message` with no provider call. This does not lean on the message table's CHECKs, since the adapter is exported.
- **No personal data.** A provider error's message is never read and never becomes a `cause`; port errors carry TideGrid's code. Log lines carry event names, documented codes, the message id, hashes and flags (`tidegrid.email.*`), never an address, a name, a subject or a body.
- **Provider ids.** An id that fits `email_messages.provider_message_id` is kept. Anything else is stored as `cfh_` and the first 40 hex characters of its SHA-256 (`normalizeCloudflareMessageId`), and logged as normalized. An acceptance with no id is stored as `cf_no_id.<message id>`. The adapter never throws once Cloudflare accepted.
- **Tests.** A recorded-shape fixture (`src/cloudflare-fixture.ts`, not exported) stands in for the binding, built from the public docs: the header allowlist and `X-` rule, the API-field and platform headers, `allowed_sender_addresses`, 50 recipients, 5 MiB, 16 KB of headers, 998-character subjects, every documented code, a hang, a late answer either way, and odd ids. Its errors carry the recipient, names, subject and tenant id, so the no-leak tests test something. `src/provider.contract.ts` runs over it and over the fake (`src/fake.contract.integration.test.ts`).

### Known gaps

- **The adapter has never called the real service.** The result and error shapes, the `messageId` format, the code for a sender outside `allowed_sender_addresses`, and the error wording are unverified against live Cloudflare. G2.16-live settles them with a first authorized send to an owner inbox. The fixture answers ids in the shape of the [event-subscriptions](https://developers.cloudflare.com/email-service/reference/event-subscriptions/) examples (`0101018f7d0c4d9a-msg-deadbeef`); the headers page says `Message-ID` is generated on a Cloudflare domain, and the local simulation answers `<36 alphanumerics@sender domain>`. G2.16-live compares the id `send()` returns with `payload.messageId` on a delivered event before the join rule is settled.
- **`sent` means accepted.** Bounces and complaints after acceptance are not ingested, so they stay invisible to staff. That is a Core live gate blocker under "silent message failure" ([product scope](../../docs/v2/02-product-scope.md)), not only a follow-up. The proposed follow-up consumer of Cloudflare's Email Sending event subscriptions needs four things. A forward-only migration adding a unique index on `(provider, provider_message_id)`; only a CHECK exists today. An `app`-schema resolver such as `app.resolve_email_message(provider, id)`, because events arrive without a tenant and no RLS bypass is allowed. The adapter's normalization, applied before joining. The canonical inbox, deduplicating by event id and refusing events from another account or sending domain ([event subscriptions](https://developers.cloudflare.com/email-service/reference/event-subscriptions/)).
- **Suppression crosses tenants.** Cloudflare suppresses an address per account or sending domain ([suppressions](https://developers.cloudflare.com/email-service/concepts/suppressions/)), and every tenant sends from the same TideGrid domain. A hard bounce or complaint on one operator's mail makes another operator's mail to that address fail as `recipient_suppressed`. Console wording stays neutral ("The provider will not deliver to this address"). Revisit with per-operator sending domains at the pilot gate. A soft-bounce suppression lasts 24 hours, longer than the retry budget, so such mail fails at once and staff resend is the recovery.
- **Provider revalidation.** Stage 0 must choose an email provider that supports US customer data, deletion, export and audit ([build, hosting and operations](../../docs/v2/08-build-hosting-and-operations.md)). Cloudflare keeps recipient addresses in its suppression list and Activity log.
- **Sender identity.** The display name is the brand name and the reply-to the brand's contact email, sent from the shared TideGrid sender. Before any production configuration, a guard on tenant-controlled sender identity is needed (proposed: a "via TideGrid" suffix, reserved-name refusal, or verified reply-to ownership).
