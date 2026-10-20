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
| `participantUpdated` | A change of whether they are a minor (who must sign), or, on a signed waiver, a new name for the participant or for the guardian who signed for a minor, revokes the request (`participant_changed`) and assigns a new one. A corrected address on a pending request sends it there at once. Nothing else changes a request. |
| `bookingCanceled` | Revoke every live request on the booking (`booking_canceled`). |

None of them refuses: confirmation and party changes never wait on waivers. Assignment is idempotent: the booking row lock serializes it per booking, a participant with a live request is skipped, and the assignment key refuses a duplicate at the database. A retried confirmation or addition creates nothing and sends nothing. Payment and confirmation never depend on a waiver.

An adult's request goes to their own address; a minor's to the guardian's. A participant without an address gets a request that waits, shown as missing a contact, and goes out as soon as an address is added.

**No booker fallback (owner decision, 2026-10-19).** An adult participant without their own email gets no waiver email until one is added. The request never falls back to the booker's address, so no adult can sign another adult's waiver from their own inbox. The booker sees "Needs an email address" for that person on the management page, and staff see `no_address` in the console.

## Email and links

The request email is a messaging-module message (template `waiver_request`, version 1) queued in the same transaction, deduplicated by `waiver.request:<request>:<generation>`, with subject `waiver_request:<request>` and a `waiver_sign` access link to `/waiver`. The messaging module's delivery job issues the link when it sends: the raw token travels only in the email, in the URL's fragment, and only its hash is stored. The link lasts 7 days from sending, never past the trip's end; a request whose trip ends within 15 minutes is not sent.

- **Resend.** Staff send a request again with a reason (`waivers.manage`), as a new generation with a new link; the earlier unused link is superseded when the new one is issued, and an earlier generation still queued is canceled. At most 5 generations per request, and to the same address at least 10 minutes apart; the database enforces both. A corrected address goes at once, revokes the old address's links (`recipient_changed`), and ends any session it opened. After the fifth generation, or too near the trip's end to send, a corrected address gets no email, but the old address still loses its links and sessions; staff see the limit.
- **No duplicates.** A retry of a command finds its generation; a repeated hook finds the live request. Neither queues a second email.
- **Delivery is not signature.** The status shows the latest email's state (queued, sending, sent, failed, canceled) beside the request's own state. A sent or delivered email never marks anything signed, and a failed one leaves the request pending with a visible exception.

## Links and sessions

1. The guest page reads the token from the fragment and shows a start screen. Only the guest's tap sends it, in a POST body, so a mail scanner's GET or a link preview consumes nothing.
2. `redeemWaiverToken` reads which request the link names, locks that request, then consumes the link once (`redeemAccessLink`) and opens a signing session for the request's signer. Another operator's token, an unknown one, or another purpose's is `invalid`; a link already opened is `used`; a replaced one is `replaced`; a link to a waiver that was signed, superseded, or ended is `closed`.
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

`signWaiver` locks the request, then checks, in order: the request is pending (a second submission from the session that signed returns the same evidence); the session is still open (a correction that committed while the signature waited for the lock ends it, and the signature answers as an ended session); the content hash the signer was shown is the request's; the participant still requires this signer; every acknowledgment is checked; electronic-signature consent is given; the signer confirms who they are; and the typed signature matches the name the booking gives the signer (the participant's own, or a minor's guardian's), ignoring case and spacing. A guardian also declares whether they are the parent or the legal guardian. Each problem comes back by field. Then, in one transaction: the evidence with its PDF, the request signed, and the request's other access closed.

### The PDF

`renderWaiverPdf` (rendering version 1) writes a small PDF 1.4 in the standard Helvetica faces, with no embedded fonts and nothing compressed: the operator, the title and version, the trip, the booking, the participant, the full text, each acknowledgment checked, the consent, the typed signature over a signature line with the signer's name and capacity, and a signing record (evidence and request ids, the content hash, how the signer arrived with the address masked, the time in UTC, the source address, and the device). Every page carries a footer with the page number. The same evidence always gives the same bytes. Text outside WinAnsi cannot reach a version; a typed signature with such a character shows a question mark there in the PDF, and the evidence keeps the exact text.

### Where the PDF lives: Postgres, for the demo

The decision register puts private evidence in R2, and the demo plan names a private bucket for G2.15. The demo keeps the PDF in Postgres, in the evidence row (`document bytea`, checked against `document_sha256` by a CHECK on `sha256()`), because:

- **It commits with the evidence.** The PDF and the evidence are one row in one transaction, so there is never evidence without its document or an orphaned document. With R2 the write happens outside the transaction and needs repair logic.
- **The database guards it.** The same triggers that refuse any change to evidence, for every role, refuse a change to the PDF, and the CHECK refuses bytes that do not match their hash. R2 would need object lock or a retention rule configured on the bucket.
- **No new provider resource.** A bucket is an account change, which this goal is not authorized to make, and a Worker bound to a missing bucket does not deploy.
- **It is small.** A signed waiver is about 10 to 20 KB.

Before real evidence, the pilot moves documents to a private R2 bucket with object lock: write the PDF under a content-addressed key before the transaction, record the key and hash in the evidence row, and keep the database's hash as the check. The API reads documents only through `loadEvidenceDocument`, so the move changes one function.

## Status

`listBookingWaivers` and `listTripWaivers` give each named participant one status, which the console shows as an icon and a label, never color alone:

| Status | Meaning |
|---|---|
| `signed` | Evidence recorded for this booking |
| `waiting` | Sent, or about to be; not signed yet |
| `email_failed` | The latest email failed; staff can resend |
| `no_address` | The booking has no address for this person yet |
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
| `GET /v1/public/waiver-sessions/current` | Bearer session. 200 `{ waiver }`; 401 `waiver_session_required`, `waiver_session_invalid` |
| `POST /v1/public/waiver-sessions/current/signature` | Bearer session. 201 signed, 200 the same evidence again; 401 `waiver_session_invalid`, also when the session ended while the signature waited; 409 `waiver_changed`, `waiver_signed`, `waiver_superseded`, `waiver_not_needed`, `waiver_participant_changed`; 422 `signature_invalid` with `problems` by field; 429 |
| `GET /v1/public/waiver-sessions/current/document` | Bearer session. 200 `application/pdf`; 404 `waiver_document_not_found` |
| `GET /v1/public/manage/waivers` | Lane 1's booking session (`manageSession`) as the bearer. 200 `{ waivers: { applies, unnamedPlaces, participants } }`, the booker's view above; 401 `session_required`, `session_expired`; 404 `booking_not_found` |
| `GET /v1/staff/tenants/{tenantId}/bookings/{bookingId}/waivers` | Owners and booking staff. 404 `booking_not_found` |
| `GET /v1/staff/tenants/{tenantId}/trips/{tripId}/waivers` | Owners and booking staff, for the roster. 404 `trip_not_found` |
| `POST /v1/staff/tenants/{tenantId}/waiver-requests/{requestId}/resend` | Owners and booking staff; `Idempotency-Key`; `{ reason }`. 201; 404 `waiver_request_not_found`; 409 `waiver_not_pending`, `waiver_no_address`, `waiver_resend_too_soon`, `waiver_resend_limit`, `waiver_trip_over` |
| `GET /v1/staff/tenants/{tenantId}/waiver-evidence/{evidenceId}/document` | Owners and booking staff. 200 `application/pdf`; 404 `waiver_evidence_not_found` |

Public routes resolve the tenant from the verified Origin, as `/v1/public/trips` does, and are rate limited per client address and operator. Every response is `Cache-Control: no-store`. Another tenant's id, an unknown one, and a malformed one answer the same 404 on staff routes. The contract is [packages/contracts/src/waivers.ts](../contracts/src/waivers.ts).

## Audit and events

| Change | Audit action | Outbox topic |
|---|---|---|
| template created | `waiver_template.created` | |
| version published | `waiver_template.version_published` | `waiver.template.version_published` |
| request assigned | `waiver_request.assigned` | `waiver.request.assigned` |
| generation sent | `waiver_request.sent`, `waiver_request.resent` (with the reason) | the messaging module's |
| link redeemed | `waiver_access.redeemed` | |
| signed | `waiver_request.signed` | `waiver.signed` |
| revoked | `waiver_request.revoked` | `waiver.request.revoked` |
| superseded | `waiver_request.superseded` | `waiver.request.superseded` |

## Lock order

The booking row (`FOR NO KEY UPDATE`, for assignment, revocation, and version moves; inside a booking hook the caller already holds it), then, for an assignment, the tenant's assignment key shared (`pg_advisory_xact_lock_shared`; a version move takes it exclusive only in a transaction that holds nothing else), then the request (`FOR NO KEY UPDATE`), then the messaging module's message and link rows, then the request's sessions. Redemption reads which request a link names without a lock, locks the request, and only then consumes the link, so redemption and revocation take the same order. Signing locks only the request. Every command needs READ COMMITTED.

## Deferred and known gaps

Recorded as follow-ups; the demo leaves them out:

- **Staff-assisted entry and QR.** Participant QR, the generic dock QR with staff lookup, staff-device signing and its shared-device cleanup, and recording the staff-assisted match method are G2.15 scope beyond the demo. Only `email_link` and `signer_confirmed` exist today.
- **Reminders.** Scheduled reminders against a completion cutoff are not built; staff resend is the one follow-up send. The messaging module's `notBefore` is the seam.
- **Guest self-service renewal.** A guest whose link expired or was used asks the operator to resend; a guest-initiated "email me a new link" needs the messaging module to say which subject a spent link named. The management page shows status but offers no resend; a corrected address there sends at once.
- **A sixth address.** After five generations a corrected address gets no email (the old address's access still ends). Staff see the limit, and nothing resets the count.
- **Migration suppression.** Imported bookings do not exist yet, so there is no initial-notification policy.
- **Removing a participant.** The booking module does not remove participants yet. `revokeParticipantWaivers` is ready for the hook that will.
- **Reuse across bookings.** The re-sign policy is `every_booking`; reusing a signature needs verified customer identity.
- **Mailbox verification beyond the link.** Following the emailed link is the mailbox signal; there is no separate code, and a shared family address is not detected.
- **Typed signatures outside WinAnsi** show a question mark in the PDF (the evidence keeps the exact text). An embedded font fixes it.
- **R2.** Above.

## Tests

- `pnpm --filter @tidegrid/domain-waivers test`: the PDF writer, wrapping and escaping, the canonical content, validation, and secrets.
- `pnpm --filter @tidegrid/domain-waivers test:integration` (a throwaway Neon branch, `TIDEGRID_EPHEMERAL_DB=1`): versions and their hashes, assignment through the real hooks, racing assignments, one-time redemption and two-tenant denial, signing and evidence immutability for every role, the guardian flow, corrections, resend limits, cancellation, and a version change mid-flight. `src/test-fixtures.ts` (exported as `@tidegrid/domain-waivers/testing`) books through the real checkout, names participants through the booking module, and reads links from the messaging module's fake mailbox.
- `src/adversarial/` (the test specialist's suites, same command): assignment under racing hooks and party changes, webhook and sweep confirmations, and a participant added during a version move; links and sessions (one session per link, concurrent redemption, a redemption racing a correction, cancellation and supersede); email delivery (failures, in-flight emails at a correction or a signature, the resend limits at the database, a correction after the fifth generation); signing and evidence (guardians, a guardian renamed after signing, a signature racing a correction, versions and stale hashes, concurrent signatures, immutability for every role, forged evidence).
- `apps/api-worker/test-integration/waivers.integration.test.ts`: every route from two tenants and each role, and the booker's view in the booking session. `waivers-adversarial.integration.test.ts`: link consumption only by POST, cross-session and cross-operator reach, the PDF's bytes, staff role and 404 rules, and no personal data in audit or outbox rows.
