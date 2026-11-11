# @tidegrid/domain-waivers

Waiver evidence for the demo build (goal G2.15 in the [demo build plan](../../docs/v2/12-demo-build-plan.md)): immutable waiver templates, a waiver request for each participant of a confirmed booking, the email that carries a single-use link, the signing session that link opens, and append-only evidence with the PDF of what was signed. The design authority is [the target architecture: waivers](../../docs/v2/04-architecture.md#waivers) and its [retained invariants](../../docs/v2/04-architecture.md#retained-invariants), and [product scope: native liability waivers](../../docs/v2/02-product-scope.md#native-liability-waivers-and-intake). Tables are in the waiver migration (`*_waivers.sql`) and follow the [tenancy contract](../database/README.md). Participants come from the [booking module](../domain-booking/README.md#guest-self-service-lane-1-g211c); email and its links from the [messaging module](../domain-messaging/README.md).

TideGrid renders the operator's approved text and records the signature. It does not draft legal terms or certify that a waiver is sufficient. The seeded texts are synthetic.

## The rule

Nothing becomes signed on a client's say. The database enforces the chain for every role, the owner included:

| A row may be written | Only when |
|---|---|
| request `signed` | its evidence row exists, written in the same transaction (and evidence commits only beside a signed request) |
| evidence | the request is pending; an open signing session of that request wrote it, for the signer the request requires; it carries the request's exact version, content hash, and acknowledgments; and the SHA-256 of its PDF is the one it carries |
| signing session | the messaging module's waiver link for that request's booking, participant, and subject was consumed in this same transaction, for a pending request |
| delivery generation | it is the request's next generation, for a pending request, naming the waiver message queued for exactly this request, generation, and address, within the resend limits |

Evidence, versions, templates, and deliveries never change for any role. A request moves one way: `pending` to `signed`, `revoked`, or `superseded`, and `signed` to `revoked`. Nothing moves a request back to pending, so a late or repeated email callback can never undo a signature.

## Model

- **Template.** A waiver an operator requires: for every product (`operator`) or for one product (`product`, which takes precedence). One of each, ever.
- **Version.** Immutable text: a title, a plain-text body (paragraphs separated by blank lines), one to ten acknowledgments the signer checks, a rendering version (1), effective dates, the signer rule (an adult signs for themselves; a parent or legal guardian signs for a minor), the re-sign policy (`every_booking`), and a content hash the database computes. Every character must be one the PDF shows exactly (WinAnsi), so the signed copy never differs from what the signer read.
- **Request.** The assignment: one participant of one confirmed booking must sign one version, as the participant or, for a minor, as their guardian. The assignment key (tenant, booking, participant, version) holds over live requests (pending or signed), and at most one request per participant and booking is live.
- **Delivery generation.** One intentional send: generation 1 when the request is assigned, then each audited resend. It names its message and the address it went to.
- **Signing session.** What a redeemed link opens: bound to the tenant, booking, participant, request, and purpose, for the request's signer, for 60 minutes (the database allows at most two hours). Only the SHA-256 of its secret is stored.
- **Evidence.** One per request: the participant (name and whether a minor, as the booking had them), the signer (their name as the booking gives it, their role, and a guardian's declared relationship), the version and its content hash, the acknowledgments and the electronic-signature consent text accepted (`esign-v1`), the typed signature (method `typed_name`), how the signer got there (`email_link` to the recorded address, with the signer confirming who they are: `signer_confirmed`), the source address and user agent, the time by the database clock, and the PDF with its SHA-256.

### The content hash

`app.check_waiver_template_version` computes it when a version is written, so no writer chooses it: SHA-256 of UTF-8 text made of a format line, then the title, the body, and each acknowledgment, each as `<label>:<UTF-8 byte length>:<text>` on its own line. `canonicalWaiverContent` in `src/content.ts` builds the same text, and a test checks that the two agree.

### Which version applies

The highest version in effect now, by the database clock, of the product's template, or else of the operator's. A version takes effect no earlier than the moment it is written. A request keeps the version it was assigned: publishing a new version (`publishWaiverTemplateVersion`) changes nothing already assigned. To move unsigned work as well, the publisher calls `reassignUnsignedRequests` once the publish has committed. It supersedes each pending request on an older version, for a booking whose trip has not started, with a request for the new version, and sends it at once. Signed requests and their evidence never change. At most 500 requests move in one call.

The move runs in transactions of its own, so an assignment racing the publish cannot keep the older version. Each assignment holds the tenant's assignment key shared, from just before it reads the applicable version until it commits. The move first checks the version is in effect now, then takes the key exclusive for a moment, in a transaction of its own, which waits for every assignment that may have read the older version. Only then does it read its candidates, booking by booking under each booking's lock. Holding the key through the move would deadlock: an assignment holds its booking's lock while it waits for the key.

## Assignment through the booking hooks

The booking module runs [lifecycle hooks](../domain-booking/src/hooks.ts) inside the transaction that confirms a booking or changes its party, after its own locks. `createWaiverHooks(deps)` returns them; the API wires them once, in `apps/api-worker/src/booking-hooks.ts`, for the webhook route, the checkout sweep, and the guest's participant and cancellation routes.

| Hook | What waivers do, in that transaction |
|---|---|
| `bookingConfirmed` | Assign every participant named so far. Usually there is none yet: the guest names the party afterwards through the management link. |
| `participantAdded` | Assign the new participant and queue their email. |
| `participantUpdated` | A change of whether they are a minor (who must sign), or, on a signed waiver, a new name for the participant or for the guardian who signed for a minor, revokes the request (`participant_changed`) and assigns a new one. On a pending request, a new name for the signer ends its staff-assisted codes and sessions (the staff member confirmed the old name); the emailed link stays. A corrected address on a pending request sends it there at once. Nothing else changes a request. |
| `bookingCanceled` | Revoke every live request on the booking (`booking_canceled`). |

None of them refuses: confirmation and party changes never wait on waivers. Assignment is idempotent: the booking row lock serializes it per booking, a participant with a live request is skipped, and the assignment key refuses a duplicate at the database. A retried confirmation or addition creates nothing and sends nothing. Payment and confirmation never depend on a waiver.

An adult's request goes to their own address; a minor's to the guardian's. A participant without an address gets a request that waits, shown as missing a contact, and goes out as soon as an address is added.

**No booker fallback (owner decision, 2026-10-19).** An adult participant without their own email gets no waiver email until one is added. The request never falls back to the booker's address, so no adult can sign another adult's waiver from their own inbox. The booker sees "Needs an email address" for that person on the management page, and staff see `no_address` in the console.

## Email and links

The request email is a messaging-module message (template `waiver_request`, version 1) queued in the same transaction, deduplicated by `waiver.request:<request>:<generation>`, with subject `waiver_request:<request>` and a `waiver_sign` access link to `/waiver`. The messaging module's delivery job issues the link when it sends: the raw token travels only in the email, in the URL's fragment, and only its hash is stored. The link lasts 7 days from sending, never past the trip's end; a request whose trip ends within 15 minutes is not sent.

- **Resend.** Staff send a request again with a reason (`waivers.manage`), as a new generation with a new link; the earlier unused link is superseded when the new one is issued, and an earlier generation still queued is canceled. At most 5 generations per request. A corrected address revokes the old address's links (`recipient_changed`), ends any session it opened, and goes out at once unless a sending limit holds it.
- **Sending limits, across requests (from the review of 2026-10-20).** The database holds every writer to `app.waiver_send_refusal`, counted over every request a participant has had, so neither alternating addresses nor flipping a participant between adult and minor (which starts a new request) sends more:
  - 10 minutes between sends of one participant's waiver to one address (a request the operator's version move superseded is left out, so its replacement goes at once);
  - 8 sends a day per participant, 10 an hour to one address across the operator, 40 a day per booking, and 1000 an hour per operator.

  It counts sends that may have reached a mailbox; an email canceled before any attempt never did. The service asks first, so a booking hook never fails on a limit: a send no one waits on (a hook, a version move) that only the interval holds is queued for when it is allowed (`send_after`, and the message is never due earlier), and the status says when it goes out; a cap leaves the waiver `email_held` until staff can send it. A staff resend answers `waiver_resend_too_soon` or `waiver_resend_rate_limited`. The same address removed and added back counts as a change: it is sent when the interval allows.
- **Email content never fails the caller.** The participant, guardian, product, and operator names each allow 120 characters; the subject, preview, and heading bound them (`elide`), so the email always fits the messaging module's limits. The message and its delivery row are queued under a savepoint, and content the messaging module refuses answers `email_invalid` instead of throwing, so a guest's party change or a version move never rolls back on email. After the fifth generation, or too near the trip's end to send, a corrected address gets no email, but the old address still loses its links and sessions; staff see the limit. An address removed from the booking ends the same way: its unsent email is canceled, its links and sessions end, and the status reads `no_address` until a new one is added.
- **Every recipient change cancels the old message.** A corrected address, a removed one, a resend, and every revocation call the messaging module's `cancelMessage` on each earlier generation in the same transaction, not only `revokeAccessLinks`, so an email still queued (which has no link yet) never goes out to an address that is no longer the signer's.
- **No duplicates.** A retry of a command finds its generation; a repeated hook finds the live request. Neither queues a second email.
- **Delivery is not signature.** The status shows the latest email's state (queued, sending, sent, failed, canceled) beside the request's own state. A sent or delivered email never marks anything signed, and a failed one leaves the request pending with a visible exception.

## Links and sessions

1. The guest page reads the token from the fragment and shows a start screen. Only the guest's tap sends it, in a POST body, so a mail scanner's GET or a link preview consumes nothing.
2. `redeemWaiverToken` reads which request the link names, locks that request, then consumes the link once (`redeemAccessLink`) and opens a signing session for the request's signer. Another operator's token, an unknown one, or another purpose's is `invalid`; a link already opened is `used`; a replaced one is `replaced`; a staff-assisted code that is used, lapsed, or replaced while its waiver still waits is `code_ended` (the API's `waiver_code_ended`), so the page sends that guest back to the crew rather than offering an emailed link; a link to a waiver that was signed, superseded, or ended is `closed`.
3. The session's secret goes back once, in the response body, and is sent afterwards as `Authorization: Bearer`. It is never in a URL.
4. The session shows exactly its own request; the routes take no request id, so a session cannot reach another participant's waiver.

What ends access:

| Event | Links (messaging module) | Sessions | Queued emails |
|---|---|---|---|
| Signed | revoked `completed` | the signer's stays open for the signed copy | canceled |
| Request revoked (participant changed, booking canceled) | revoked `withdrawn` or `booking_canceled` | revoked | canceled |
| Request superseded by a new version | revoked `withdrawn` | revoked | canceled |
| Address corrected | revoked `recipient_changed` | revoked | canceled, then the new address's email is queued |
| Resend to the same address | superseded when the new link is issued | stay open | the earlier one canceled, and the link it carried withdrawn |

Every cancellation here reaches an email in flight too: the messaging module's `cancelMessage` waits for a send in progress, records nothing for it, never retries it, and revokes the unused links it carried with the waiver's reason. Its delivery job also rechecks under the message's lock before issuing a link, so a retry never sends a live link to an address corrected away, or for a request already signed.

## Signing

`signWaiver` locks the request, then checks, in order: the request is pending (a second submission from the session that signed returns the same evidence); the session is still open (a correction that committed while the signature waited for the lock ends it, and the signature answers as an ended session); the trip has not ended (`trip_over`, which the API answers as `waiver_trip_over`; the evidence trigger refuses it too); the content hash the signer was shown is the request's; the participant still requires this signer; every acknowledgment is checked; electronic-signature consent is given; the signer confirms who they are; and the typed signature matches the name the booking gives the signer (the participant's own, or a minor's guardian's), ignoring case and spacing. A guardian also declares whether they are the parent or the legal guardian. Each problem comes back by field. Then, in one transaction: the evidence with its PDF, the request signed, and the request's other access closed.

### The PDF

`renderWaiverPdf` (rendering version 1) writes a small PDF 1.4 in the standard Helvetica faces, with no embedded fonts and nothing compressed: the operator, the title and version, the trip, the booking, the participant, the full text, each acknowledgment checked, the consent, the typed signature over a signature line with the signer's name and capacity, and a signing record (evidence and request ids, the content hash, how the signer arrived with the address masked, the time in UTC, the source address, and the device). Every page carries a footer with the page number. The same evidence always gives the same bytes. Text outside WinAnsi cannot reach a version; a typed signature with such a character shows a question mark there in the PDF, and the evidence keeps the exact text.

### Where the PDF lives: Postgres, for the demo

The decision register puts private evidence in R2, and the demo plan names a private bucket for G2.15. The demo keeps the PDF in Postgres, in the evidence row (`document bytea`, checked against `document_sha256` by a CHECK on `sha256()`), because:

- **It commits with the evidence.** The PDF and the evidence are one row in one transaction, so there is never evidence without its document or an orphaned document. With R2 the write happens outside the transaction and needs repair logic.
- **The database guards it.** The same triggers that refuse any change to evidence, for every role, refuse a change to the PDF, and the CHECK refuses bytes that do not match their hash. R2 would need object lock or a retention rule configured on the bucket.
- **No new provider resource.** A bucket is an account change, which this goal is not authorized to make, and a Worker bound to a missing bucket does not deploy.
- **It is small.** A signed waiver is about 10 to 20 KB.

Before real evidence, the pilot moves documents to a private R2 bucket with object lock: write the PDF under a content-addressed key before the transaction, record the key and hash in the evidence row, and keep the database's hash as the check. The API reads documents only through `loadEvidenceDocument`, so the move changes one function.

`loadEvidenceDocument` hashes the bytes again on every read and throws `WaiverDocumentMismatchError` when they no longer match the recorded SHA-256, so bytes changed under the database's check (storage, a restore, or a dropped check) are never served; the API answers 500 and logs the error's name. The same check carries over to R2, where the database no longer guards the bytes.

## Staff-assisted and QR signing (W1-G215-SIGNING)

Pulled forward into the demo by the owner on 2026-11-08 ([decision register](../../docs/v2/06-decision-register.md#2026-11-08-w1-g215-signing-staff-assisted-and-qr-waiver-signing-owner-pull-forward-coordinator-defaults-pending-owner-confirmation)). Migration `0020_waiver_staff_assisted.sql` (provisional number, claimed at merge) and `src/assisted.ts`. At the dock, a guest without the email, or a participant without an address, signs on the staff member's device or by scanning a QR code with their own phone.

- **Staff start it, after checking who signs.** `startAssistedSigning` (`waivers.manage`, so owners and booking staff) takes one pending request, a mode (`staff_device` or `participant_qr`), and a ticked box that the staff member checked who signs (D2), with the participant's name as the console showed it: a booking that names someone else now is refused, so a dialog left open across a rename never vouches for a person nobody checked. It refuses a request that is not pending, a trip that is over, and a participant who left the booking or now needs another signer. Only a staff actor may start one; the database refuses any other.
- **The link.** A `waiver_sign` link in the messaging module's `guest_access_links`, with no message: single-use, 15 minutes (D1), bound to the request's booking, participant, and subject like an emailed link. `waiver_assisted_links` records the mode, the staff member, the request id, and the tick, append-only for every role. The raw token goes back once, in the staff response, as `https://<guest site>/waiver#t=<token>`; only its hash is stored, and the audit row carries the link id, never the token. A new start supersedes the request's earlier unused assisted link and ends any session an earlier code opened, so one code at most works per request. It never touches the emailed link: a guest who signs from their email later is fine. A newer email's link supersedes an older assisted one.
- **The QR code carries only that address.** The console draws it with no dependency (D4): byte mode, level M, versions 1 to 10, checked module by module against a reference encoder. No name, booking, or request id is in it.
- **Redemption is unchanged.** The same explicit POST as an email link. A link with no message and no assisted record opens nothing. The session lasts at most 15 minutes, and its waiver says how the signer arrived (`access`).
- **The evidence.** The database holds the access method and the match method to the session's link, for every writer: an emailed link must record `email_link`, `signer_confirmed`, and the address its delivery went to; an assisted link must record its mode, `staff_confirmed`, and its staff member in `assisted_by`, with no address. Anything else is refused (`waiver_evidence_method`). The PDF's signing record says how the signer arrived and adds an "Assisted by" line with the staff member's display name; an emailed waiver's PDF is unchanged. Staff reads show the method beside a signed waiver.
- **Shared-device cleanup (D3).** On an assisted session the signing page keeps the session secret in memory only, never in `sessionStorage`. After 1 minute 40 seconds with no tap, key, or scroll it warns that it will clear in 20 seconds, and a tap keeps it; after 2 minutes it ends the session (`DELETE /v1/public/waiver-sessions/current`) and clears the page. After signing on the staff device it offers no download, only Done, which ends the session and says to hand the device back; on the participant's own phone the download stays until Done. Ending a session never touches the evidence or the PDF.

## Reminders (W1-G215-REMINDERS)

Pulled forward into the demo by the owner on 2026-11-08 ([decision register](../../docs/v2/06-decision-register.md#2026-11-08-w1-g215-reminders-waiver-reminders-up-to-a-completion-cutoff-coordinator-defaults-pending-owner-confirmation)). Migration `0025_waiver_reminders.sql` and `src/reminders.ts`.

- **The schedule (D1).** An unsigned waiver gets at most two reminder emails: one from 72 hours before the trip leaves (`72h`) and one from 24 hours before (`24h`). None is queued from 2 hours before departure, the completion cutoff. A slot is skipped when a waiver email or reminder for the request went out after it opened, or in the 12 hours before (`REMINDER_GRACE_HOURS`), so a booking made 40 hours ahead gets its first email and then only the 24 hour reminder, while one made 30 hours ahead gets its first email and no reminder (that email went out within 12 hours of the 24 hour slot). Only a confirmed booking's request is reminded. A reminder still goes to an address whose last email failed, as a later try; bounce handling waits for the pilot. A request that never had an email (no address), or whose address changed since its last email, gets none; the status already shows that to staff.
- **Not a resend (D2).** A reminder is not a delivery generation. It never counts against the five generations or the sending limits that hold staff resends, and those limits never count it. It still waits when the participant's address had a delivery generation less than 10 minutes ago (the database's interval), and the next sweep tries again. That interval counts generations only, so reminders for two minors with the same guardian address can go in the same sweep.
- **The sweep.** The cron runs `sweepWaiverReminders` before the email sweep, and skips it when email is off. Tenants come from `app.waiver_reminder_tenants`, least recently served first (sweep name `waiver_reminder`). Each reminder is its own transaction, which locks the request first, as every waiver command does.
- **Deduplicated.** The database holds one reminder per request and slot (`waiver_reminders_once`), and the message's key is `waiver.reminder:<request>:<slot>`, so concurrent sweeps and retries queue one email, and the messaging module sends a message at most once.
- **The email.** Template `waiver_reminder`, version 1: the request email's blocks with a reminder subject and heading. Its single-use link is issued when it is sent, lasts 7 days and never past the trip's end, and replaces the earlier email's unused link, as a resend's does.
- **What stops one.** A signature, a revocation (participant changed or removed, booking canceled), a version supersede, and a corrected address each cancel a queued reminder through `cancelQueuedMessages`, and the delivery job drops one whose access was withdrawn before it went out. A staff resend cancels a queued reminder too, so only the newest email goes out.
- **Staff see it.** The booking's waivers read carries `reminders`: the reminders queued, with their email's state, and the next one while nothing changes. The console's Waivers card shows "Reminder emailed ... Next reminder ...".
- **Known gap.** The cutoff holds when a reminder is queued. A reminder queued before the cutoff and delayed by an email outage of more than about 22 hours could still go out inside it.

## Renewal and the send count (W1-WAIVER-RENEWAL)

Pulled forward into the demo by the owner on 2026-11-08 ([decision register](../../docs/v2/06-decision-register.md#2026-11-08-w1-waiver-renewal-guest-link-renewal-a-staff-reset-of-the-five-sends-and-a-shared-address-flag-coordinator-defaults-pending-owner-confirmation)). Migration `0028_waiver_renewal.sql` (provisional number, claimed at merge) and `src/renewal.ts`.

- **A guest asks for a new link (D1).** When an emailed link answers used, expired, or replaced, the signing page offers "Email me a new link", which sends that link's token back (`POST /v1/public/waiver-links/renewal`, the token in the body only). `renewWaiverLink` reads the spent link's subject, locks its request, and sends a new generation when the request still waits for a signature, the trip is not over, no invitation or reminder of the request is still queued or sending (it locks those messages, so a send in progress finishes first and its link counts), and none of the request's emailed links still works (so an old token cannot spend the guest's sends while their newest link waits in their inbox). It goes only to the address the latest generation went to, and only for a link that went to that address: after a corrected address, a link the old address held, opened or not, renews nothing (the new address had its own email). It is a delivery generation like a staff resend, marked `guest_renewal`, within the usual sending limits and the five sends, at most 3 a day for the participant. A staff-assisted code is not renewed; one that no longer opens answers `waiver_code_ended`, before or after the trip, and the page sends the guest to the crew.
- **One answer, whatever happened.** The route answers 202 `{ accepted: true }` for any well-formed token: unknown, another operator's, still working, a crew code, over a limit, or sent. Nothing in the answer says whether an address or booking exists, and delivery starts after the response. The route is rate limited per client address and operator like other public commands.
- **The database holds it for every writer.** A `guest_renewal` generation must be the guest's, a resend, to the address the latest generation went to (`waiver_deliveries_guest`), and the fourth in 24 hours for a participant is refused (`waiver_deliveries_guest_limit`).
- **Five more sends (D2).** Once a request has had 5 generations since its last reset, staff (`waivers.manage`) may allow 5 more with a reason (`resetWaiverSendCount`, `POST .../waiver-requests/{requestId}/send-count-reset`). The reset is an append-only `waiver_send_resets` row naming the generation it was at and the staff member, and the audit history records the reason. The delivery trigger allows 5 generations after the latest reset (`waiver_deliveries_generations`), and 20 in all. A reset comes only once the 5 are used, so a retry answers `waiver_reset_not_needed`.
- **A shared family address (D3).** The staff read flags a pending guardian request whose address is also another participant's own address on the booking (`sharedAddress`; a minor's own email does not count), and the console asks staff to check who signs at the dock. It does not block the email. Minors who share one guardian are not flagged. Following the emailed link stays the only mailbox signal.
- **The staff read** adds `sendsLeft` and `canResetSends` beside `resendAvailableAt`.
- **The booker sends it again (W3-G2.15-rest).** On the management page, a "Send again" button beside each named person whose email went out and who hasn't signed (`POST /v1/public/manage/waivers/resend`, the person's place in the body, in lane 1's booking session). `resendWaiverForBooker` locks the booking (as party edits do), finds the person by place and name on it, locks the request, and refuses when the booking is not confirmed, the request is not pending, the trip is over, or an email of the request is still queued or sending (the same locked check as a renewal). It then sends a `guest_renewal` generation, so the database's rules above hold it: the address the latest generation went to only, sharing the 3 a day with the person's own renewals, within the five sends and the sending limits. Unlike a renewal it may go while the last link still works (the booker can't see the inbox), and the new link replaces the old one, as any resend does. The booker is signed in to the booking, so the answer names the reason it did not go; the audit records `waiver_request.resent_by_booker` with the reason "The booker asked to send it again", apart from the person's own `waiver_request.renewed`. The page sends the person's name with their place, so a party changed since it loaded sends nothing (`waiver_participant_changed`). Defaults in the [decision register](../../docs/v2/06-decision-register.md#decision-log).

## Status

`listBookingWaivers` and `listTripWaivers` give each named participant one status, which the console shows as an icon and a label, never color alone:

| Status | Meaning |
|---|---|
| `signed` | Evidence recorded for this booking |
| `waiting` | Sent, or about to be (the latest delivery's `sendAfter` says when, if a limit held it); not signed yet |
| `email_failed` | The latest email failed; staff can resend |
| `no_address` | The booking has no address for this person yet, or the one it had was removed |
| `email_held` | The booking has an address, but no working email went to it: a sending limit held it, or its email could not be built. Staff can send it again once the limits allow |
| `not_assigned` | A waiver applies, but this participant has no request (named before the waiver applied) |
| `not_required` | No waiver applies to the trip |
| `not_needed` | The booking was canceled |

Each also carries the request (state, signer, version, when assigned), the evidence summary, the latest delivery (generation, masked address, the email's state), and when staff may resend. The trip view adds totals: signed, waiting, needing attention, and places nobody has been named for.

**The booker's view.** `listGuestBookingWaivers` gives the management page (lane 1's `/manage`, in its booking session) each named person's status, who signs, the signing day, and where the latest email went, masked. It leaves out ids, evidence, the text, the typed signature and the guardian's name, and the delivery history: the booker named the party but signs only for themselves. `applies` is false when no waiver applies or the booking is canceled, and the page then shows nothing.

**Who sees what.** Waiver status names people, so the staff reads need `bookings.read` (owners and booking staff), as the roster does; finance is refused. Resending needs `waivers.manage` (owners and booking staff). The signed PDF is for owners and booking staff, and for the signer within their session; never for the booker. Audit rows and events carry ids, versions, and hashes only: never a name, an address, a signature, or the waiver's text.

## API

| Route | Answers |
|---|---|
| `POST /v1/public/waiver-sessions` | `{ token }` from the link's fragment. 201 `{ sessionSecret, waiver }`; 404 `waiver_link_invalid`; 409 `waiver_link_expired`, `waiver_link_used`, `waiver_link_replaced`, `waiver_signed`, `waiver_superseded`, `waiver_not_needed`; 429 |
| `GET /v1/public/waiver-sessions/current` | Bearer session. 200 `{ waiver }`; 401 `waiver_session_required`, `waiver_session_invalid`; 409 `waiver_signed`, `waiver_superseded`, `waiver_not_needed` when the session ended because its waiver did |
| `POST /v1/public/waiver-sessions/current/signature` | Bearer session. 201 signed, 200 the same evidence again; 401 `waiver_session_invalid`, also when the session ended while the signature waited; 409 `waiver_changed`, `waiver_signed`, `waiver_superseded`, `waiver_not_needed`, `waiver_participant_changed`, `waiver_trip_over`; 422 `signature_invalid` with `problems` by field; 429 |
| `GET /v1/public/waiver-sessions/current/document` | Bearer session. 200 `application/pdf`; 404 `waiver_document_not_found`; 409 as the read; 500 if the stored bytes no longer match their hash |
| `GET /v1/public/manage/waivers` | Lane 1's booking session (`manageSession`) as the bearer. 200 `{ waivers: { applies, unnamedPlaces, participants } }`, the booker's view above; 401 `session_required`, `session_expired`; 404 `booking_not_found` |
| `GET /v1/staff/tenants/{tenantId}/bookings/{bookingId}/waivers` | Owners and booking staff. 404 `booking_not_found` |
| `GET /v1/staff/tenants/{tenantId}/trips/{tripId}/waivers` | Owners and booking staff, for the roster. 404 `trip_not_found` |
| `POST /v1/staff/tenants/{tenantId}/waiver-requests/{requestId}/resend` | Owners and booking staff; `Idempotency-Key`; `{ reason }`. 201; 404 `waiver_request_not_found`; 409 `waiver_not_pending`, `waiver_no_address`, `waiver_resend_too_soon`, `waiver_resend_limit`, `waiver_resend_rate_limited`, `waiver_email_invalid`, `waiver_trip_over`; a refusal still commits what the send closed |
| `GET /v1/staff/tenants/{tenantId}/waiver-evidence/{evidenceId}/document` | Owners and booking staff. 200 `application/pdf`; 404 `waiver_evidence_not_found`; 500 if the stored bytes no longer match their hash |
| `POST /v1/staff/tenants/{tenantId}/waiver-requests/{requestId}/assisted-signing` | Owners and booking staff; `{ mode, identityChecked: true, participantName }`; no `Idempotency-Key`, since the answer holds a token that must not be stored. 201 `{ signing: { mode, url, expiresAt } }`; 400 when the box is not ticked; 404 `waiver_request_not_found`; 409 `waiver_not_pending`, `waiver_trip_over`, `waiver_participant_changed`, `waiver_guest_site_unavailable` (nothing is issued) |
| `DELETE /v1/public/waiver-sessions/current` | Bearer session. 204, also for a session already ended or unknown, so a retry is safe. Ends the session; a signed waiver stays signed |
| `POST /v1/public/waiver-links/renewal` | `{ token }` of an emailed link. 202 `{ accepted: true }` whatever happened; 400 a malformed body; 429 |
| `POST /v1/staff/tenants/{tenantId}/waiver-requests/{requestId}/send-count-reset` | Owners and booking staff; `{ reason }`; no `Idempotency-Key`, since a second reset is refused. 201 `{ reset: { afterGeneration, sendsLeft } }`; 404 `waiver_request_not_found`; 409 `waiver_not_pending`, `waiver_reset_not_needed` |

Public routes resolve the tenant from the verified Origin, as `/v1/public/trips` does, and are rate limited per client address and operator. Every response is `Cache-Control: no-store`. Another tenant's id, an unknown one, and a malformed one answer the same 404 on staff routes. The contract is [packages/contracts/src/waivers.ts](../contracts/src/waivers.ts).

## Audit and events

| Change | Audit action | Outbox topic |
|---|---|---|
| template created | `waiver_template.created` | |
| version published | `waiver_template.version_published` | `waiver.template.version_published` |
| request assigned | `waiver_request.assigned` | `waiver.request.assigned` |
| generation sent | `waiver_request.sent`, `waiver_request.resent` (with the reason) | the messaging module's |
| link redeemed | `waiver_access.redeemed` | |
| reminder queued | `waiver_request.reminded` (slot, message id) | the messaging module's |
| assisted signing started | `waiver_access.assisted_started` (link id, mode) | |
| session ended from the page | `waiver_access.signed_out` | |
| guest renewal sent | `waiver_request.renewed` (generation, message id; no address) | the messaging module's |
| booker resend sent | `waiver_request.resent_by_booker` (generation, message id; no address) | the messaging module's |
| send count reset | `waiver_request.send_count_reset` (reason, generation) | |
| signed | `waiver_request.signed` | `waiver.signed` |
| revoked | `waiver_request.revoked` | `waiver.request.revoked` |
| superseded | `waiver_request.superseded` | `waiver.request.superseded` |

## Lock order

The booking row (`FOR NO KEY UPDATE`, for assignment, revocation, and version moves; inside a booking hook the caller already holds it), then, for an assignment, the tenant's assignment key shared (`pg_advisory_xact_lock_shared`; a version move takes it exclusive only in a transaction that holds nothing else), then the request (`FOR NO KEY UPDATE`), then the messaging module's message and link rows, then the request's sessions. Redemption reads which request a link names without a lock, locks the request, and only then consumes the link, so redemption and revocation take the same order. Signing locks only the request. Every command needs READ COMMITTED.

## Deferred and known gaps

Recorded as follow-ups; the demo leaves them out:

- **The generic dock QR with staff lookup.** One printed code at the dock that finds a guest's waiver by lookup is not built; participant QR and staff-device signing are (above).
- **Migration suppression.** Imported bookings do not exist yet, so there is no initial-notification policy.
- **Removing a participant.** When a shared-seat party gives up a place (W3-G2.11-rest), the booking module's `participantRemoved` hook calls `revokeParticipantWaivers` with `participant_removed`: the request, its links, sessions, and queued email end, and a signature already given stays as evidence. The removed participant is no longer listed by the booking module, so nothing is assigned to them again.
- **Reuse across bookings.** The re-sign policy is `every_booking`; reusing a signature needs verified customer identity.
- **Mailbox verification beyond the link.** Following the emailed link is the mailbox signal; there is no separate code. A guardian address shared with a participant is flagged to staff (above), not verified.
- **Typed signatures outside WinAnsi** show a question mark in the PDF (the evidence keeps the exact text). An embedded font fixes it.
- **R2.** Above.
- **Field encryption.** ADR 0019 (retained; docs/v2/06) and docs/v2/08 require personal fields to be encrypted with versioned keys before real data. Waiver evidence stores the participant's and signer's names, the typed signature, the relationship, the recipient address, the source address, the user agent, and the PDF in plain columns; lane 1's participant emails and guardian names are the same. Synthetic demo data only until the pilot adds field encryption.
- **`send_after` held for every writer (W1-0014-RESIDUALS).** Closed by migration `0019`: a queued waiver email's `next_attempt_at` no longer moves earlier than its delivery's `send_after` while that time is ahead, so a direct writer cannot bring a send the interval holds forward. The service never moved it. Tests that make time pass move the delivery's `send_after` first.

## Tests

- `pnpm --filter @tidegrid/domain-waivers test`: the PDF writer, wrapping and escaping, the canonical content, validation, and secrets.
- `pnpm --filter @tidegrid/domain-waivers test:integration` (the throwaway PostgreSQL 17 from `tools/local-db/local-db.sh` (`pnpm test:local-db integration` runs every suite; see the [database README](../database/README.md#tests)), `TIDEGRID_EPHEMERAL_DB=1`): versions and their hashes, assignment through the real hooks, racing assignments, one-time redemption and two-tenant denial, signing and evidence immutability for every role, the guardian flow, corrections, resend limits, cancellation, and a version change mid-flight. `src/test-fixtures.ts` (exported as `@tidegrid/domain-waivers/testing`) books through the real checkout, names participants through the booking module, and reads links from the messaging module's fake mailbox.
- `src/adversarial/` (the test specialist's suites, same command): assignment under racing hooks and party changes, webhook and sweep confirmations, and a participant added during a version move; links and sessions (one session per link, concurrent redemption, a redemption racing a correction, cancellation and supersede); email delivery (failures, in-flight emails at a correction or a signature, the resend limits at the database, a correction after the fifth generation); signing and evidence (guardians, a guardian renamed after signing, a signature racing a correction, versions and stale hashes, concurrent signatures, immutability for every role, forged evidence).
- `src/adversarial/renewal.integration.test.ts`: a spent link renewed to the same address and the new link opening; a working link, an unknown token, a crew code, another operator, and a changed address renewing nothing; three renewals a day, held by the database for a direct writer, with another address refused; five sends, a staff-only reset with a reason and its audit, five more, and the database's count; and the shared-address flag.
- `src/adversarial/reminders.integration.test.ts`: the 72 and 24 hour slots and the 2 hour cutoff, a slot an email covered, no address or a changed one, one reminder across concurrent sweeps and retries with one send in the fake mailbox, the reminder's link replacing the earlier one, signature and participant change stopping a queued reminder, a staff resend at once after a reminder, the staff read, two tenants, and the database rules.
- `src/adversarial/assisted-signing.integration.test.ts`: staff-assisted and QR signing across online and staff-assisted bookings through the webhook and the sweep, adults and guardians; replay, supersede, the 15 minutes, cancellation, participant change, and version supersede; a signer's new name ending assisted access; the identity tick, a non-staff actor, and two tenants; sign-out keeping the evidence; and the database rules for every writer.
- `apps/api-worker/test-integration/waivers.integration.test.ts`: every route from two tenants and each role, and the booker's view in the booking session. `waivers-adversarial.integration.test.ts`: link consumption only by POST, cross-session and cross-operator reach, the PDF's bytes, staff role and 404 rules, and no personal data in audit or outbox rows.
