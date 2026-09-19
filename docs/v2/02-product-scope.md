# TideGrid V2 pilot product scope

**Status:** Canonical scope for paid pilot validation

**Market:** United States, USD, and English first

## Purpose and product boundary

TideGrid V2 is a productized branded booking service for small passenger-vessel operators. Each operator gets one guest experience containing all of its boats, products, and scheduled trips. TideGrid runs one multi-tenant product, one shared API, one source tree, and one release train. Branding and approved behavior vary through configuration, not customer-specific code forks.

The pilot owns the commercial booking record from availability through payment, participant completion, customer changes, operator remedies, and reporting. It does not own departure operations, crew work, vessel maintenance, or regulatory records.

Every capability marked in scope in this document is required for pilot completion, but not all of it before the first live booking. Each pilot operator passes three named gates: the Core live gate before its first real booking, each Staged Core module's own acceptance before that module is enabled for it, and the Native pilot gate before its branded apps go live. The canonical definition is [Gates](05-roadmap-validation.md#gates) in the roadmap; the [acceptance gates](#production-pilot-acceptance-gates) section at the end of this document maps each area here to those gates. Pilot operators and research participants may test incomplete workflows in staging with test payments and non-production data. Staging use, TestFlight use, internal Android distribution, or an operator-run shadow workflow does not pass any gate.

## Target users and jobs

| User | Job TideGrid must support | Pilot access |
|---|---|---|
| Operator owner or manager | Configure what can be sold, understand booking and financial status, approve customer remedies, and control staff access | Full operator console for the operator tenant |
| Booking staff | Create and change bookings, collect or record payment, resolve incomplete participant work, and answer booking-scoped replies | Restricted operator console |
| Finance user | Reconcile sales, taxes, fees, tips, refunds, credits, trip cards, and payment exceptions | Read-only financial views and exports |
| Primary booker | Find a trip, reserve capacity, pay, manage the party, complete requirements, and change the booking within policy | Public checkout, secure booking link, and optional guest account |
| Participant | Provide their own details, sign the applicable waiver, and reserve equipment without seeing another participant's private data | Participant-specific secure link or signed-in guest experience |
| Parent or legal guardian | Review the applicable waiver and sign for a linked minor | Guardian-specific secure flow |
| TideGrid support | Diagnose configuration, import, payment, message, and release exceptions without becoming an operator user | Audited, time-limited support access |

The pilot does not include captain, crew, guide, maintenance, payroll, or check-in roles. Staff may appear as the sender of a booking message, but TideGrid does not schedule or manage them.

## Product surfaces

### Branded guest PWA

Every live operator receives a mobile-first progressive web app on an approved custom domain. It includes discovery, availability, checkout, booking management, participant invitations, waivers, balance payment, and receipts. Equipment, trip-card purchase and redemption, and tips appear only when the operator has enabled that [staged Core module](05-roadmap-validation.md#staged-core-modules).

Guests can book and manage a booking through a secure email link without first creating an account. A guest may create a passwordless account to see upcoming bookings, saved profile data, waiver status, trip-card balances, and credits. Transactional changes require a live connection. Offline booking or offline mutation is not supported.

### Branded native apps

The premium native add-on provides one operator-branded iOS app and one operator-branded Android app. Both use the same services and configuration model as the PWA. They add a persistent signed-in experience, saved profiles, upcoming trips, trip-card and credit balances, waiver completion, and transactional push notifications.

All of an operator's boats appear inside the same app. TideGrid does not create an app per boat or a source-code fork per operator.

Native remains an optional commercial add-on after the pilot cohort. Every pilot operator buys Native, and the pilot cohort review counts as complete only when all three pass the [Native pilot gate](05-roadmap-validation.md#native-pilot-gate). That gate covers the operator-owned iOS and Android apps approved for public distribution, push notifications, deep links, and the native guest journeys. It controls when the Native add-on goes live for that operator; it does not block the PWA or the Core live gate, so an operator may take live bookings through the PWA before its apps are approved.

### Operator web console

Operators use one responsive TideGrid web console. The console is not a native staff app. It provides catalog setup, trip scheduling, a booking calendar and list, booking and customer detail, a participant roster, financial actions, booking-scoped messages, imports, and reports.

## Shared acceptance rules

These rules apply to every in-scope workflow:

- One operator can never read, search, export, message, or mutate another operator's data.
- Server-side records are authoritative for capacity, payment state, equipment availability, package units, credits, and booking status.
- A held resource is unavailable to another checkout until the hold expires, is released, or becomes a confirmed booking.
- Confirmation requires successful payment or an explicit staff-recorded external-payment state. Opening checkout or returning from Stripe is not confirmation.
- Repeated browser submissions, provider callbacks, message callbacks, and operator actions must not create duplicate bookings, charges, refunds, credits, package entries, or messages.
- Every price, tax, fee, deposit rule, policy, waiver version, and trip-card rule used by a booking is snapshotted. Later configuration changes do not rewrite prior bookings.
- Money is stored in integer minor units with an explicit currency. Pilot sales use USD.
- Every trip displays the operator's local time zone. The stored event time remains unambiguous across daylight-saving changes.
- Financial changes, policy overrides, trip-card and credit adjustments, imports, account merges, support access, and role changes record the actor, time, reason, and before-and-after values.
- A failed external side effect appears as an actionable exception. It must not silently leave TideGrid and the provider in conflicting states.

## Catalog, schedules, and availability

### Required behavior

An operator can configure:

- boats used as bookable inventory within the operator brand;
- locations, local time zones, meeting instructions, and customer contact details;
- shared-seat products and instant-book private-charter products;
- eligible boats for each product;
- passenger or ticket types, minimum and maximum party size, and guest capacity;
- duration, booking cutoff, change cutoff, turnaround buffer, and sales status;
- recurring seasonal schedules, one-time scheduled trips, blackouts, and operator blocks;
- pooled equipment requirements and availability windows;
- ticket and charter prices, optional paid add-ons, mandatory fees, taxes, one simple promotion code rule, deposit terms, cancellation policy, waiver, and intake form assigned to the product.

A shared-seat booking consumes only the confirmed or held guest count. A private-charter booking consumes the whole configured boat or exclusive capacity for the trip window. Shared-seat and private inventory cannot overlap when they require the same exclusive boat.

Each scheduled trip can be draft, published, closed, sold out, delayed, canceled, or completed. Completion is an operator action used for reporting and post-trip tipping. It is not an operational closeout record.

### Acceptance behavior

- Publishing a product with missing price, capacity, policy, location, or eligible boat data is blocked with a specific error.
- Search returns only published trips inside the sales window with enough guest and equipment capacity for the request.
- Concurrent attempts for the last seat, the same private boat, the last equipment unit, or the last package unit cannot both confirm.
- An expired or abandoned hold restores every held seat, exclusive boat, equipment quantity, and package unit together.
- Closing or blocking a trip prevents new checkout while preserving existing bookings and customer access.
- A staff-created or imported external booking reduces the same availability used by direct checkout.

## Pricing, taxes, fees, and quotes

### Required behavior

The pilot supports fixed shared-seat prices by ticket type and fixed private-charter prices. An operator can configure named mandatory fees per booking or per participant, and can mark each product, ticket, fee, paid add-on, equipment rental, or other sale line as taxable or non-taxable.

An operator can configure a simple optional paid add-on with a name, applicable products, fixed USD price, per-booking or per-participant quantity rule, maximum quantity, tax treatment, and active date range. Add-ons have no independent inventory or fulfillment lifecycle; a limited physical item belongs in pooled equipment. Checkout validates eligibility and quantity on the server. The accepted add-on definition, quantity, unit price, tax treatment, and extended amount are snapshotted as distinct order lines. A later booking change allocates any additional charge or refund to those lines instead of rewriting the original order.

Simple promotion codes may apply one fixed-amount or percentage discount to eligible products during a configured date range. Checkout validates the code on the server, shows the discount explicitly, and snapshots the applied rule. The pilot does not include stacking, customer segmentation, referral attribution, automatic campaigns, or complex usage rules.

The operator supplies the applicable tax names, rates, and inclusive or exclusive treatment. TideGrid calculates and displays them but does not determine nexus, classify an operator's legal tax obligation, file returns, or remit operator taxes.

Before payment, checkout shows:

- product and trip;
- participant and ticket quantities;
- each selected paid add-on and quantity;
- equipment rentals;
- subtotal;
- each mandatory fee;
- tax included in or added to the price;
- trip card or credit applied;
- optional tip;
- amount due now; and
- any later private-charter balance and due date.

The accepted quote is stored on the booking and order. Changes create a revised quote and explicit charge, refund, credit, or balance adjustment. TideGrid's own platform fee is not added as an undisclosed guest fee.

### Acceptance behavior

- An ineligible, inactive, or over-limit paid add-on cannot enter an accepted quote.
- Add-on quantity, unit price, tax, and total remain auditable after the configuration changes.
- Removing or reducing an add-on creates the correct line-level refund, credit, or remaining balance without changing unrelated booking value.
- The amount sent to Stripe exactly matches the final amount shown to the guest for that payment.
- Reopening an old booking reproduces its accepted price and tax lines even after catalog prices change.
- The operator can preview the financial result of a change before confirming it.
- Reports separate product sales, mandatory fees, tax, equipment, tips, trip-card or credit tender, refunds, and outstanding balances.

Promotional campaigns, advanced coupon engines, negotiated proposals, bidding, demand pricing, and multi-currency pricing are outside the pilot.

## Booking and payment

### Booking types and sources

The pilot supports:

- guest-booked shared seats;
- guest-booked private charters with published availability and price;
- staff-assisted phone, email, and walk-up bookings;
- complimentary bookings with an operator reason;
- cash or other external payment recorded by staff; and
- manually entered or imported OTA bookings used to protect capacity and maintain the roster.

Every booking records its source. Direct, staff-assisted, complimentary, external-payment, and OTA states remain distinguishable in reports.

### Stripe payment boundary

Online payments use Stripe Connect direct charges in the operator's connected account. The operator is the seller and merchant of record. TideGrid provides checkout, payment-status, refund, and reconciliation workflows but does not hold operator funds or store raw card details.

Pilot onboarding requires the Stripe-confirmed connected-account responsibility configuration defined in [Payment economics](03-commercial-model.md#payment-economics); if Stripe will not confirm it for the proposed accounts, TideGrid must stop and reprice before contracting or processing payments.

TideGrid confirms a paid booking only after it receives authoritative payment success from Stripe. A delayed, failed, expired, or abandoned payment releases its hold safely. Provider callbacks can arrive late or more than once without duplicating the result.

For a cash or externally paid booking, staff records the amount, tender label, reference, and actor. TideGrid does not move or refund that money. It records later external refunds or adjustments for reporting only.

### Private-charter deposit and balance

Each private-charter product can require either full payment or one deposit at booking. The deposit can be a fixed amount or a percentage of the charter price. The operator sets one balance due date relative to the trip start.

The primary booker sees the full charter price, deposit, remaining balance, and due date before paying. TideGrid sends reminders and provides a secure link for the remaining payment. Staff can also resend the link or record an external balance payment. The pilot does not charge a stored card automatically.

An unpaid balance becomes due and then overdue. TideGrid does not automatically cancel the booking. Authorized staff choose whether to cancel, reschedule, waive an amount, collect payment, or issue credit under the snapshotted policy. Each override requires a reason.

### Acceptance behavior

- A shared-seat booking cannot confirm more seats than remain available.
- A private charter cannot confirm unless the exclusive boat and any required equipment remain available for the whole buffered window.
- A failed deposit does not leave a confirmed charter or consume permanent inventory.
- Deposit, balance, paid, due, overdue, refunded, credited, and external-payment amounts reconcile to the booking total.
- The guest and operator see the same current balance and due date.
- Staff can correct a booking only through an audited action, not by rewriting prior payment history.

Private-charter inquiries, custom proposals, installment plans beyond one deposit and one balance, card-present terminals, and buy-now-pay-later methods are outside the pilot.

## Policies, cancellation, rescheduling, refunds, and credits

### Policy model

Each product has versioned cancellation, no-show, reschedule, operator-cancellation, and weather-policy text. The pilot policy template defines:

- the guest cancellation and reschedule cutoff;
- the allowed remedy before the cutoff;
- the allowed remedy at or after the cutoff;
- no-show treatment;
- whether a private-charter deposit is refundable; and
- the customer-facing policy text.

The allowed remedy can be a full refund, a configured percentage refund, a named-customer booking credit, or no value. The operator approves its policy text and tax treatment before publishing.

An operator cancellation or weather disruption is a separate action. Authorized staff choose either a refund to the original payment method or named-customer service credit for each affected booking. TideGrid never makes that safety or remedy decision from a forecast.

### Customer and staff changes

Within policy and before the applicable cutoff, the primary booker can:

- cancel the whole booking;
- remove shared-seat participants;
- move the booking to an eligible trip with sufficient capacity; and
- accept and pay a price increase or choose the configured remedy for a price decrease.

Changing the party size on a private charter does not change its fixed charter price. Staff can apply a permitted change, but only an owner or manager can override policy with an explicit reason. Every change reacquires capacity, equipment, and package units atomically before releasing the old reservation.

### Refunds and booking credits

Stripe refunds are created against the original operator charge. TideGrid records pending, succeeded, and failed refund states and reverses its related fee proportionally according to the commercial policy. An external-payment refund is recorded, not executed.

A booking credit is USD-denominated, belongs to one verified customer, and is not transferable. It has an immutable issue, redemption, expiration, reinstatement, and adjustment ledger. An operator may set an expiration date and remains responsible for applicable stored-value law. Credit used on a later canceled booking is restored as credit according to the applicable policy, not converted silently to cash.

Cancellation previews offer **customer credit** as an explicit alternative to an original-payment refund for each eligible booking, with customer, amount, policy and resulting balance shown before confirmation. Credit appears in the customer's dollar-card balance, with its cancellation source retained. A trip-count card restores the eligible trip units instead of creating their cash equivalent. Dollar-card tender restores dollars to the original card. For mixed funding, preview each portion separately and prevent refund, credit and trip restoration from returning the same value twice. A refund/credit choice applies to the eligible money-paid portion; restoration preserves the original card's denomination and ownership.

### Acceptance behavior

- The guest sees the applicable policy and must accept it before payment.
- The exact accepted policy version remains available from the booking.
- Cancellation and reschedule previews show released capacity, package units, equipment, refund, credit, additional charge, and remaining balance before confirmation.
- A repeated refund or credit command cannot duplicate value.
- A failed Stripe refund remains visible as an exception and does not appear as completed to the guest.
- Policy overrides appear in the audit trail and reports.

## Guest, party, and account self-service

### Required behavior

The primary booker receives a scoped, expiring management link after booking. From the link or a verified account, the booker can:

- view trip status, local time, meeting details, policy, receipts, payment state, and balance;
- invite participants through participant-specific links;
- add or remove shared-seat participants within capacity and policy;
- correct permitted contact and participant details;
- pay a private-charter balance;
- reserve or release available pooled equipment;
- see who has completed a waiver without viewing another adult's answers;
- cancel or reschedule when policy allows;
- view and apply their own trip cards and credits; and
- manage transactional contact preferences.

A participant can manage only their own profile, intake answers, equipment, and waiver. A guardian can manage only the linked minor records for which they are acting. The primary booker cannot sign another adult's waiver.

Guest accounts use verified, passwordless sign-in. Booking does not require account creation. A one-time email link or code verifies access to that mailbox; it does not prove a person's identity or authorize signing for everyone using that address. TideGrid can propose a same-tenant customer match using the verified address and participant details, then require confirmation of the intended participant. Shared family addresses, conflicting names, changed contacts, and multiple candidate records require resolution rather than an automatic merge. A new participant can complete their own waiver without first merging historical customer records.

Native and PWA accounts support sign-out and a deletion request. TideGrid deletes or de-identifies data that is not required for financial, fraud, waiver-evidence, or other legal retention and explains any retained records.

### Acceptance behavior

- A booking or participant link exposes only its allowed record and expires or can be revoked.
- Every self-service change rechecks capacity, policy, price, and identity on the server.
- A participant invitation cannot be used to see another participant's answers or the booker's full payment method data.
- Removing a participant releases their seat and equipment and applies the booking policy once.
- Account linking and duplicate merge actions never combine customers on email or phone similarity alone.

## Native liability waivers and intake

"Native waiver" means the waiver is completed and stored inside TideGrid's guest workflow. It does not require a third-party waiver site and is available in the PWA and native apps.

### Required behavior

The operator supplies counsel-approved waiver text. TideGrid supports:

- versioned liability waiver templates by product or location;
- post-booking participant and guardian signing;
- electronic-signature consent, signer name, signature or attestation, date and time, IP address, device or user-agent evidence, document version, and content hash;
- an immutable signed rendering that the signer can download;
- guardian name, declared relationship, and signature for a linked minor;
- one guardian completing waivers for more than one linked minor;
- emergency contact; and
- operator-configured, non-medical intake questions needed for the booking.

Waiver assignment depends on the booked product, location, participant, and applicable version, not on booking source or payment rail. Stripe-paid, externally paid, staff-entered, complimentary, and imported bookings receive the same waiver assignment and evidence workflow when the configured product requires one.

Payment and booking confirmation do not depend on waiver completion. The guest sees the waiver immediately after booking and in reminders. The operator sets a completion cutoff and sees complete, incomplete, expired, and superseded status for each participant.

### Automatic requests and resend

The normal journey is **confirm booking → automatically send the required waiver request → guest verifies their email access and participant match → review and sign → update the booking roster**. Sending the first request is not a manual operator step. Each confirmed booking creates the applicable participant or guardian requests and queues transactional delivery after the booking commits, regardless of payment rail. Participants added later receive the same workflow. A guest may also open the assigned waiver immediately from their authorized booking journey.

Send to each participant's supplied email address. If a participant or contact is missing, show that exception on the roster and prompt the booker to invite or identify the remaining guests. Do not treat the booker's email as verified contact information for every adult in the party. A failed email leaves the booking confirmed and the waiver outstanding, with a visible delivery exception. Imported history does not trigger a mass email: record an explicit notification policy during migration and cutover for active future bookings.

Operators can resend an outstanding request or correct its recipient and send a replacement. Scheduled reminders use the configured completion cutoff and stop once the requirement is satisfied, the participant is removed, or the booking is canceled. Resend is rate-limited and audited, uses the existing assignment, and cannot duplicate a request, reset a signature, or overwrite signed evidence. Correcting the recipient or replacing a link revokes prior access; an expired access link can be renewed without creating a new waiver version. Keep delivery status, email verification, participant matching, and signature completion separate on the roster. Provider acceptance or delivery is not proof that a guest verified an email or signed.

### QR and guests without email

The operator can show a participant-specific QR code from the booking roster. Scanning opens the branded PWA and the same assigned waiver, without requiring an app installation. The QR represents a short-lived, revocable signing entry point; it does not expose the booking roster, payment details, or another guest's answers. It is not proof of the scanner's identity.

A generic QR displayed at the dock opens an operator-branded lookup or staff-assistance start page, not a public list of bookings. Booking lookup details alone do not grant access to private participant records. When lookup is ambiguous, or a guest has no email, staff locate the booking, confirm the intended participant with the guest, and issue a scoped QR session. A guest without a phone can use a staff device in a separate signing session that clears before the next person. Record staff-assisted matching as its own method; never label it email-verified. The guest still reviews and signs for themselves, or uses the existing linked-guardian flow. This path does not require identity-document collection.

### Verification and matching

Email entry and syntax validation are not verification. Use a short-lived, single-use link or code to verify mailbox access, then have the guest confirm the named participant and trip. An already authenticated, authorized guest with a verified address can use the same participant flow without redundant verification. Reverify a changed address before using it to link a customer record. Do not automatically merge people based on email similarity, name similarity, a shared mailbox, QR possession, or the booker's assertion.

Record how email access and participant matching were established, including a staff actor when applicable, alongside the signer and waiver evidence. These signals support matching and auditability; they are not a claim of government-ID verification. Reuse of an earlier signed waiver still requires the correct participant, applicable immutable version, and approved validity rule.

A signed waiver never changes when the operator publishes a new version. A participant must sign again when the assigned waiver version changes. A rescheduled booking can reuse a signature only when the same waiver version remains applicable and the operator's approved validity rule permits reuse.

### Acceptance behavior

- Each adult signs for themselves. A booker cannot attest for another adult.
- A minor cannot complete an adult signature flow.
- The guardian flow captures the minor, guardian, relationship declaration, exact waiver version, and signature evidence together.
- A completed signature produces immutable evidence and a downloadable copy.
- A changed waiver version marks affected unsigned work correctly and never rewrites existing evidence.
- Booking staff can see status and allowed intake answers but cannot edit a signed waiver.
- A source-matrix test proves that Stripe-paid, externally paid, staff-entered, complimentary, and imported bookings assign the same required participant and guardian waiver versions and produce the same evidence fields.
- Booking confirmation and later participant addition queue the initial request automatically; duplicate events and retries cannot create duplicate assignments or sends. Missing contacts, bounces, and suppressed migration notifications remain visible exceptions.
- Resend, reminder, corrected-recipient, cancellation, and signature races preserve signed evidence and stop obsolete work. A late delivery callback cannot regress a signed requirement to pending.
- Email verification, participant confirmation, and signing remain distinct. Shared mailboxes and conflicting matches cannot expose or merge another adult's records; changed addresses and forwarded, expired, revoked, or already-used links are tested.
- Participant QR, generic dock QR, and staff-device journeys work without requiring email. Cross-tenant access, participant swapping, repeated redemption, roster enumeration, and leftover shared-device sessions are rejected.

Medical questionnaires, medical clearance, health-readiness decisions, certification capture or verification, identity-document collection, and legal advice are outside the pilot.

## Transactional email, SMS, and replies

### Channels and journeys

Each operator receives branded transactional email. The operator approves its email sender identity, reply address, templates, customer support details, and required sending-domain records. Transactional SMS and replies are a [staged Core module](05-roadmap-validation.md#staged-core-modules): when the module is enabled for the operator, it also receives a dedicated US SMS-capable Twilio sender and number, and SMS launch requires the applicable Twilio business and campaign registration. An operator may go live with email only and enable SMS after the module passes its acceptance.

The pilot includes transactional messages for:

- booking confirmation and receipt;
- participant invitation;
- automatic initial waiver request, operator resend, and scheduled waiver reminder;
- private-charter balance reminder;
- customer or operator cancellation and reschedule;
- delay, weather disruption, and meeting-detail change;
- refund or credit status;
- trip-card purchase and balance;
- arrival reminder; and
- post-trip tip request.

SMS replies are booking-scoped. TideGrid attaches an inbound reply to the matching operator, customer, and active booking when the match is unambiguous. Ambiguous replies enter an operator inbox for manual assignment. Authorized staff reply from the operator's dedicated number, and the complete thread appears on the booking.

### Consent and delivery

Checkout presents the transactional SMS disclosure separately from policy and waiver acceptance. TideGrid records the phone number, disclosure version, channel, time, and source of consent. STOP, START, HELP, and carrier callbacks update consent and delivery state. Marketing consent is not inferred and marketing messages are not sent.

Guests can opt out of SMS without losing email access to the booking. Essential booking changes use branded email when SMS is unavailable or opted out. Message sends record template version, recipient, provider identifier, attempts, delivery status, and error.

### Acceptance behavior

- A retry cannot send the same event message more than once through the same channel.
- An SMS opt-out blocks later non-required SMS until valid opt-in while leaving booking access intact.
- Replies from one operator's number cannot appear in another operator's tenant.
- A delivery failure appears in the console and invokes the configured email fallback without duplicating a delivered message.
- Staff can see whether a customer received, failed to receive, replied to, or opted out of each booking message.

Marketing campaigns, bulk promotions, newsletters, WhatsApp, social messaging, and a general-purpose team inbox are outside the pilot.

## Operator console, roster, roles, and reporting

### Daily console

The operator console includes:

- calendar and list views by date, product, boat, location, source, and booking status;
- sold, held, and currently available seat, boat, and pooled-equipment capacity for each trip;
- booking and customer search;
- booking detail with price, payment, balance, policy, participants, waiver status, equipment, trip cards, credits, tips, messages, and audit history;
- manual booking and external or OTA record creation;
- cancel, reschedule, refund, credit, balance-link, and policy-override actions;
- customer profile, booking history, trip-card balances, credit balance, consent, and duplicate review;
- catalog, schedule, price, tax, fee, policy, waiver, equipment, trip-card, and template configuration; and
- payment, message, refund, import, and reconciliation exception queues.

### Participant roster

Each scheduled trip has an on-screen, printable, and CSV roster containing booking reference, primary booker, participants, contact details allowed for the role, payment or balance status, waiver status, and reserved equipment. It also shows aggregate guest and equipment counts.

The roster is a booking-management view. It is not a Coast Guard manifest, check-in record, boarding record, crew roster, emergency plan, or offline captain manifest.

### Roles

The pilot supports owner or administrator, booking staff, and read-only finance roles. Owners manage configuration, staff, Stripe connection, exports, and policy overrides. Booking staff manage bookings and messages but cannot change tenant billing, Stripe ownership, or user roles. Finance users can view and export financial records but cannot change bookings or customer data.

### Reports and exports

The console provides date-range summaries and CSV exports for:

- bookings, guests, occupancy, products, boats, and source;
- gross sales, product revenue, paid add-ons, mandatory fees, taxes, equipment, and tips;
- deposits, outstanding balances, refunds, booking credits, and external payments;
- trip-card sales, units issued, units redeemed, remaining units and dollar balances, and expirations;
- Stripe charge and refund references, TideGrid fee, and reconciliation exceptions; and
- waiver completion and message delivery status.

Reports group business dates in the operator's local time zone and retain exact event timestamps. Financial totals drill to source bookings and ledger entries.

### Acceptance behavior

- Role checks protect direct links, exports, API calls, and the corresponding interface controls.
- A trip roster matches confirmed and explicitly recorded external bookings at the time it is generated.
- Financial report totals reconcile to the underlying order, payment, refund, credit, tip, and package entries.
- CSV exports use stable columns and include operator, date range, time zone, and generation time.
- An operator can diagnose each failed payment, refund, message, or import without TideGrid exposing raw card data.

Custom dashboards, data warehouses, accounting-system integrations, payroll exports, regulatory reports, and arbitrary report builders are outside the pilot.

## Pooled equipment

### Required behavior

An operator can define pooled rental categories, sizes or variants, quantity, price, tax treatment, eligible products or locations, and unavailable windows. Equipment is selected per participant where relevant and held in the same checkout transaction as trip capacity and package units.

Pooled equipment is a [staged Core module](05-roadmap-validation.md#staged-core-modules): an operator may go live without it and enable it after the module passes its acceptance, and until then no product may require equipment.

Confirmed equipment reduces availability for the trip and its configured buffer. Cancellation, participant removal, reschedule, failed payment, or expired hold releases the appropriate quantity. A reschedule must acquire equipment on the new trip before releasing the old reservation.

The trip roster shows each participant's selections and aggregate quantities needed.

### Acceptance behavior

- Two checkouts cannot confirm the last pooled unit.
- A booking cannot show confirmed equipment that was not successfully reserved.
- Staff and guests see the same remaining quantity after a confirmed change.
- Equipment revenue and tax remain separate sale lines and reconcile after cancellation or refund.

Serial numbers, physical checkout and return, cleaning, damage, loss, repair, maintenance, tank fills, and warehouse management are outside the pilot.

## Advisory weather and operator-directed disruptions

### Required behavior

The operator workspace presents **Marine conditions** for the trip area and time: sustained wind and direction, gusts, significant wave height, swell height/period/direction, and wind waves where the provider supplies them. Visibility and relevant marine alerts supplement that sea-state picture. Missing measurements remain unavailable rather than being inferred from another field. NOAA is the initial planned evidence adapter. Marine conditions and operator-directed disruptions are a [staged Core module](05-roadmap-validation.md#staged-core-modules): an operator may go live without it and enable it after the module passes its acceptance, and until then it changes bookings one at a time through the Core cancellation, reschedule, refund, and credit workflow.

Each forecast or observation identifies its source, model or station where available, location, units, issue or observation time, valid time, last successful retrieval, and stale or unavailable state. Observations and forecasts remain distinct; wave components are not added together into an invented total. Marine data is advisory and does not produce a safety score, recommendation, delay, cancellation, or refund automatically.

An embedded Windy map provides visual wind and wave exploration, with an external-map fallback. The map's selected model and time belong to Windy; the workspace must not imply that a current map describes a future departure outside the provider's forecast window. Windy visualization is separate from the recorded evidence used in a trip-change review. The prototype uses Windy's [official map embed](https://embed.windy.com/config/map) for a fixed example coastal area, alongside clearly fictional trip-date metrics. Production location mapping, provider coverage, usage terms, and any paid API requirements must be verified before integration. Guest, booking, and waiver data never enter map URLs.

An authorized operator can place a trip on watch, close sales, delay it, cancel it, or mark it completed. A watch records the concern without changing availability. A sales closure blocks new bookings but does not change existing ones. For a delay or material detail change, the operator previews and sends one branded update to affected bookings. For a cancellation, the operator selects one remedy per affected booking: refund to the original payment method or named-customer service credit.

### Acceptance behavior

- Missing or stale weather data is visible and does not block booking or operator action.
- Wind, combined seas, swell, and wind-wave fields retain their units and provenance. Missing components, conflicting sources, an unavailable map, and a trip outside forecast coverage have explicit states.
- Loading or changing a Windy layer never changes recorded trip evidence, inventory, customer notices, or operator decisions.
- Only an authorized human action changes the trip or starts a customer remedy.
- The disruption preview shows affected bookings, amounts, package units, equipment, and message recipients before confirmation.
- Retrying a disruption does not repeat a refund, credit, unit reinstatement, reschedule, or message.
- Each booking shows its remedy and message status until every exception is resolved.

Automated go or no-go decisions, route planning, marine navigation, emergency alerts, safety guarantees, and autonomous cancellations are outside the pilot.

## Checkout and post-trip tips

### Required behavior

An operator may enable tips at checkout, after the trip, or both. It can configure suggested percentages and allow a custom amount. Tips are optional, clearly labeled, processed on the operator's Stripe account, reported separately from sales and taxes, and excluded from TideGrid's platform-fee base. Tips are a [staged Core module](05-roadmap-validation.md#staged-core-modules): an operator may go live without them and enable them after the module passes its acceptance.

Checkout tips are part of the initial payment. Post-trip tipping becomes available only after authorized staff mark the trip completed. TideGrid sends a secure branded link to the primary booker and records the resulting direct charge against the booking.

### Acceptance behavior

- Removing or changing a checkout tip updates the shown and charged total exactly.
- A post-trip tip request cannot send before operator completion or more than once for the same configured journey.
- A tip refund is linked to the original tip payment and appears separately in reports.
- No workflow assigns a tip to an individual worker or represents TideGrid as paying staff.

Crew splits, tip pools, individual payouts, payroll, cash-tip tracking, and tip-based staff performance reporting are outside the pilot.

## Trip cards: trip counts and dollar balances

### Required behavior

An operator can sell two kinds of named-customer **trip cards**: a **trip-count card**, a fixed whole-number trip entitlement (for example, five reef dives), or a **dollar card**, a USD balance (for example, $250 toward eligible bookings). Trip cards are reusable customer balances, distinct from the trip listings used in discovery. The card kind is fixed after issue; a trip is never silently converted into a dollar amount. These are operator-specific customer accounts, not anonymous or transferable gift cards. Trip cards are a [staged Core module](05-roadmap-validation.md#staged-core-modules): an operator may go live without them and enable them after the module passes its acceptance, and until then no card can be sold, imported, or redeemed.

A trip-count card uses the package model: eligible products, units consumed per eligible booking item, sale price, tax treatment, sale window, and optional expiration date. Each eligible participant or booking item consumes the configured number of units, rather than treating one group booking as one trip automatically.

Trip cards belong to one verified customer and cannot be transferred or shared. A package unit covers only the configured trip entitlement. Taxes, equipment, mandatory fees, tips, and other uncovered party members can be paid separately at checkout.

The package ledger records purchase, issue, hold, release, redemption, cancellation reinstatement, expiration, refund adjustment, and authorized manual adjustment. Purchase uses a Stripe direct charge or an explicitly recorded external payment. TideGrid's platform fee applies at purchase and not again at unit redemption, as defined by the commercial model.

A unit is held atomically with capacity and equipment during checkout. It is redeemed only when the booking confirms. Cancellation or reschedule restores or moves the unit according to the booking's snapshotted policy.

A dollar card holds integer USD cents and supports partial redemption, with any remaining amount due shown before checkout. Track purchased value, cancellation credit, and promotional credit as separate source lots even when the customer sees one dollar balance. Each lot retains its applicable eligibility, validity, issue cause, and fee-assessment history. Authorized staff can issue or adjust value with a recorded source and reason; recording a card is never proof of receiving payment. The guest and operator see card type, eligible trips or charges, available and held value, remaining balance, applicable expiration, and transaction history. Purchased dollar value uses the fee timing in the commercial model; returning or reusing previously assessed value cannot create a second fee.

### Acceptance behavior

- A customer cannot hold or redeem more units than remain available.
- Concurrent redemptions cannot create a negative unit balance.
- An expired checkout releases package units with all other held resources.
- Trip-card purchase, unit balance, redemption, and reinstatement can be rebuilt from immutable ledger entries.
- Staff adjustments require a reason and never edit a prior ledger entry.
- A guest sees eligible products, expiration, remaining whole units, and any additional amount due before confirmation.
- Dollar-card holds and redemptions use integer cents, support partial use and split tender, and never overdraw or mix currencies. Failed checkout releases both card types with the other held resources.
- Cancellation previews and receipts distinguish money refunded, dollar credit issued or restored, and trip units restored. Replaying a cancellation cannot issue value twice.
- Card issuance, redemption and restoration remain tenant- and customer-scoped. Type, ownership, eligibility and source history survive import and cannot be bypassed by entering another person's card number.

Points, status tiers, recurring memberships, anonymous or transferable gift cards, automatic cash conversion, fractional trip units, card sharing, and card transfers are outside the pilot. Refunds of card purchases follow the operator-approved policy and retain their original purchase reference.

## Migration and launch data

### In-scope migration

TideGrid provides documented CSV templates and a repeatable import process for:

- customer identity and contact data;
- future direct, staff-assisted, and OTA bookings;
- participant names and allowed non-medical booking details;
- outstanding private-charter balances and external-payment references;
- active named-customer booking-credit balances; and
- active named-customer trip-card balances and expiration dates, once the trip cards module is enabled for the operator.

The import records source system, external identifier, mapping version, import batch, and deduplication key. A dry run validates required fields, dates, time zones, product and boat mapping, customer matches, capacity, trip-card totals, and credit totals. It produces a row-level error report before any live commit.

The operator reviews mapped products, boats, bookings, customer counts, future guest counts, outstanding balances, package units, credits, and rejected rows. Launch requires signed reconciliation and a cutover plan covering the legacy booking freeze, final delta, DNS and message activation, and rollback owner.

Imported bookings that require a waiver receive the applicable TideGrid waiver workflow. TideGrid does not claim that an imported legacy waiver remains valid.

### Acceptance behavior

- Re-running the same import batch does not duplicate customers, bookings, credits, or package units.
- An import cannot silently overbook a trip or equipment pool.
- Ambiguous customer matches remain separate until operator review.
- Imported financial values are labeled as opening or external records and are not represented as TideGrid-processed Stripe charges.
- The operator can reconcile every accepted and rejected row before production cutover.

Raw card data, medical data, certification documents, full accounting history, old message threads, and bulk migration of legacy waiver evidence are outside the standard pilot. Nonstandard cleanup or integration requires a separate statement of work.

## Branded app configuration and release ownership

### Configuration boundary

The supported brand configuration includes operator name, logo, approved color tokens, imagery, contact details, legal links, support links, custom web domain, app icons, splash assets, store copy, and enabled in-scope modules, including which staged Core modules are enabled for the operator. Configuration must meet accessibility, security, and store-policy constraints.

Operators can manage an **Important links** section from the web console, adding, editing, ordering, or removing named HTTPS links with optional short descriptions. Links may apply to all trips or selected products, such as a fishing-license purchase page for fishing trips. Guests can find them in the branded PWA and optional native app, including alongside the relevant booking's arrival instructions. These are operator-supplied external resources; TideGrid does not issue licenses or verify license eligibility or completion.

Content blocks and approved settings may vary. Navigation, data model, transactional rules, component behavior, and release code do not vary by operator. A request that needs a source fork or operator-only business logic is custom software and is outside the offer.

### PWA launch

The operator supplies or delegates control of the custom domain and required DNS records. TideGrid provisions TLS, validates links, installs the correct web manifest and icons, verifies email sender records, and provides production analytics and error monitoring. Every operator's custom domain resolves only to that operator's brand and data.

### Native launch

The operator owns its Apple Developer and Google Play developer accounts and remains the named app publisher. TideGrid receives the least access needed to manage signing, store listings, TestFlight or internal testing, release preparation, approved production releases, and urgent fixes. The operator supplies approved legal entity, privacy, support, and store metadata. Under Apple's current commercial-template rule, the operator's authorized representative performs the final App Review submission; TideGrid may prepare and upload the build and listing. TideGrid may submit the Google release only after recorded operator approval.

TideGrid assigns stable bundle and package identifiers, manages signing through documented controls, and releases all operator apps from the shared source line. The release process tracks app version, configuration version, store state, supported backend range, staged rollout, minimum supported version, and rollback or emergency-update action per operator.

The contract and launch runbook define who pays store fees, who performs account-holder actions and final submissions, who answers store review questions, who owns each asset, and what happens to the listing, domain, and customer export at contract end. The full account, artifact, and submission contract is defined in [Native app factory and store submission](09-native-app-factory-and-store-submission.md).

### Acceptance behavior

- Branding changes cannot expose another operator's content or alter shared transactional rules.
- Important links show only the current operator's resources and respect product applicability. Authorized configuration changes appear in the PWA and native app without a source change or new store release; invalid URLs are rejected, and external destinations are clearly identified before opening.
- The PWA passes installability, responsive layout, accessibility, custom-domain, deep-link, and production payment tests.
- The Native add-on for an operator cannot go live until it passes the Native pilot gate: public store approval in both stores, push notifications and deep links working in production, and the native guest journeys passing on physical devices. Store approval is one condition of that gate, not the whole gate. Store approval does not block the Core live gate or the PWA, and a native app cannot take a booking for an operator that has not passed the Core live gate.
- A native deep link opens the correct operator, booking, participant, waiver, balance, or tip destination after authentication.
- Account creation, sign-in, sign-out, deletion request, privacy links, support links, and consent work in both stores.
- TideGrid can identify which app and configuration versions each live operator uses and can issue a shared security fix without creating a customer-specific branch.

Custom navigation, one-off native features, operator-specific integrations, per-boat binaries, side-loaded production apps, and indefinite support for old app versions are outside the pilot.

## Direct-first and OTA boundary

Pilot operators must receive at least 80% of bookings through their direct or staff-assisted channels. OTA and other externally controlled bookings must be 20% or less of trailing booking volume. This is a customer-qualification and operating-model boundary, not a software-enforced booking cap.

TideGrid can import or let staff record the minority OTA bookings so they reserve capacity, appear on the booking roster, and receive permitted operational messages when contact data and source terms allow. OTA payment, refunds, commissions, customer ownership, and booking changes remain controlled by the OTA. Staff must update TideGrid when an external booking changes.

### Acceptance behavior

- Every external booking is visibly labeled with source and external reference.
- External bookings reduce availability but cannot be mistaken for TideGrid-processed revenue.
- TideGrid does not send a refund, modify the OTA record, or promise synchronization back to the source.
- Qualification captures the operator's trailing direct and OTA mix and reassesses it before renewal or scope expansion.
- The operator acknowledges that delayed manual entry can cause oversell and owns the external-system update procedure.

Live OTA availability, price, booking, customer-message, and cancellation synchronization is outside the pilot. Operators above the 20% boundary are not pilot candidates until a separate channel-management strategy is approved.

## Explicit pilot exclusions

The following are not part of the production pilot:

- customer-specific source forks or bespoke workflows;
- multiple operator brands in one guest app or multi-operator carts;
- live OTA or global-distribution integrations;
- operator merchant services beyond Stripe Connect direct charges;
- TideGrid acting as merchant of record, reseller, tax filer, or holder of operator funds;
- card-present point of sale and retail inventory;
- waitlists, promotional campaigns, advanced coupon engines, and dynamic pricing;
- medical intake, health decisions, certification evidence, or identity documents;
- check-in, boarding, attendance, regulatory manifests, incident records, and trip logs;
- crew scheduling, time tracking, payroll, tip allocation, or individual payouts;
- vessel readiness, maintenance, defects, fuel, or compliance records;
- offline booking, offline staff operations, or an offline captain app;
- serialized equipment, custody, return, cleaning, damage, and maintenance;
- automated weather or safety decisions;
- loyalty points, memberships, anonymous gift cards, or transferable stored value;
- marketing automation, reviews, social messaging, and WhatsApp;
- public APIs, custom accounting integrations, and a generalized integration marketplace; and
- international currencies, languages, tax regimes, data residency, or non-US messaging registration.

## Production pilot acceptance gates

The canonical gate definitions are [Gates](05-roadmap-validation.md#gates) in the roadmap. This section maps the areas of this document to those gates. Every item is verified for the production environment; staging, TestFlight, internal Android distribution, or a shadow workflow does not pass any gate.

### Core live gate

No operator may take a real customer booking or live payment until every item below is complete:

1. All Core live workflows in this document pass end-to-end acceptance for shared-seat and private-charter bookings: catalog, schedules, availability, pricing, taxes, fees, quotes, promotion codes, add-ons, booking, deposits and balances, policies, cancellation, rescheduling, refunds, booking credits, guest self-service, waivers, transactional email, operator console, roster, roles, reports, exports, migration, and the branded PWA.
2. Concurrency tests prove no overbooking or negative credit balance under last-unit races and retries.
3. Stripe direct-charge, deposit, balance, refund, fee-reversal, webhook-retry, and reconciliation cases pass in the operator's connected-account test environment and a controlled production verification.
4. Two-tenant security tests prove isolation for guest links, accounts, console search, exports, messages, media, and support access.
5. The operator approves catalog, price, tax, fee, policy, waiver, intake, brand, email, and customer-support configuration.
6. Sender-domain authentication, transactional email delivery, delivery-failure visibility, and automatic waiver-request tests pass.
7. The migration dry run and final import reconcile, and the operator signs the launch totals and cutover plan.
8. The branded PWA passes production domain, payment, accessibility, responsive, link, receipt, and analytics checks.
9. Operator roles, financial exports, roster, exception queues, audit history, data export, account-deletion request, backups, support runbook, and incident contacts are verified.
10. No open defect can cause cross-tenant access, oversell, duplicate financial value, lost waiver evidence, missing consent, silent message failure, or an incorrect customer remedy.

### Staged Core modules

Each module below is required for pilot completion. An operator may go live at the Core live gate with a module disabled and enable it only after that module passes its own acceptance. A module enabled for one operator does not have to be enabled for another.

1. Transactional SMS and replies: SMS registration, dedicated-number routing, consent, opt-out, reply, delivery-failure, and email-fallback tests pass, and the operator approves its SMS configuration.
2. Pooled equipment: concurrency tests prove no negative pooled-equipment balance under last-unit races and retries; hold and release with capacity, reschedule reacquisition, and separate equipment revenue and tax lines pass.
3. Marine conditions and operator-directed disruptions: provenance, units, missing-data, and forecast-coverage states are correct; only an authorized human action changes a trip; disruption remedies and messages cannot repeat on retry.
4. Tips: checkout and post-trip tip payment, refund, and reconciliation cases pass; tips reach the operator, stay outside the fee base, and refund once.
5. Trip cards: concurrency tests prove no negative package-unit balance; purchase is charged once, holds and redemptions cannot overdraw, cancellation restores eligible units or dollars once, and imported balances reconcile.

### Native pilot gate

The Native add-on for an operator goes live only when every item below is complete. This gate does not block the PWA or the Core live gate.

1. The operator-owned iOS and Android apps pass device acceptance and public store approval. Internal distribution alone is insufficient.
2. Push notifications, deep links, sign-in, sign-out, and deletion request work in production for that operator's tenant.
3. The native guest journeys (booking, balance, waiver, profile, trip card, credit, deep link, and push) pass on physical devices without customer-specific source changes.
4. The operator-level checklist in [Native app factory and store submission](09-native-app-factory-and-store-submission.md#acceptance-gates) is complete.

The pilot cohort review counts as complete only when all three pilot operators have passed all three gates. The pilot is a product validation, not proof that TideGrid should proceed to general availability. Renewal, broader sales, OTA work, and any return to departure operations require evidence from paid use and the gates in the [roadmap and validation plan](05-roadmap-validation.md#gates).
