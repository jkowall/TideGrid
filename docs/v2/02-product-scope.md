# TideGrid V2 pilot product scope

**Status:** Canonical scope for paid pilot validation

**Date:** September 4, 2026

**Market:** United States, USD, and English first

## Purpose and product boundary

TideGrid V2 is a productized branded booking service for small passenger-vessel operators. Each operator gets one guest experience containing all of its boats, products, and scheduled trips. TideGrid runs one multi-tenant product, one shared API, one source tree, and one release train. Branding and approved behavior vary through configuration, not customer-specific code forks.

The pilot owns the commercial booking record from availability through payment, participant completion, customer changes, operator remedies, and reporting. It does not own departure operations, crew work, vessel maintenance, or regulatory records.

Every capability marked in scope in this document is required before the first production pilot. Pilot operators and research participants may test incomplete workflows in staging with test payments and non-production data. Staging use, TestFlight use, internal Android distribution, or an operator-run shadow workflow does not satisfy the production gate.

## Target users and jobs

| User | Job TideGrid must support | Pilot access |
|---|---|---|
| Operator owner or manager | Configure what can be sold, understand booking and financial status, approve customer remedies, and control staff access | Full operator console for the operator tenant |
| Booking staff | Create and change bookings, collect or record payment, resolve incomplete participant work, and answer booking-scoped replies | Restricted operator console |
| Finance user | Reconcile sales, taxes, fees, tips, refunds, credits, packages, and payment exceptions | Read-only financial views and exports |
| Primary booker | Find a trip, reserve capacity, pay, manage the party, complete requirements, and change the booking within policy | Public checkout, secure booking link, and optional guest account |
| Participant | Provide their own details, sign the applicable waiver, and reserve equipment without seeing another participant's private data | Participant-specific secure link or signed-in guest experience |
| Parent or legal guardian | Review the applicable waiver and sign for a linked minor | Guardian-specific secure flow |
| TideGrid support | Diagnose configuration, import, payment, message, and release exceptions without becoming an operator user | Audited, time-limited support access |

The pilot does not include captain, crew, guide, maintenance, payroll, or check-in roles. Staff may appear as the sender of a booking message, but TideGrid does not schedule or manage them.

## Product surfaces

### Branded guest PWA

Every live operator receives a mobile-first progressive web app on an approved custom domain. It includes discovery, availability, checkout, booking management, participant invitations, waivers, equipment, package purchase and redemption, balance payment, receipts, and tips.

Guests can book and manage a booking through a secure email link without first creating an account. A guest may create a passwordless account to see upcoming bookings, saved profile data, waiver status, package units, and credits. Transactional changes require a live connection. Offline booking or offline mutation is not supported.

### Branded native apps

The premium native add-on provides one operator-branded iOS app and one operator-branded Android app. Both use the same services and configuration model as the PWA. They add a persistent signed-in experience, saved profiles, upcoming trips, package and credit balances, waiver completion, and transactional push notifications.

All of an operator's boats appear inside the same app. TideGrid does not create an app per boat or a source-code fork per operator.

Native remains an optional commercial add-on after the pilot cohort. The first production pilot includes Native, so the shared native capability and that operator's public iOS and Android releases are part of the first production gate.

### Operator web console

Operators use one responsive TideGrid web console. The console is not a native staff app. It provides catalog setup, trip scheduling, a booking calendar and list, booking and customer detail, a participant roster, financial actions, booking-scoped messages, imports, and reports.

## Shared acceptance rules

These rules apply to every in-scope workflow:

- One operator can never read, search, export, message, or mutate another operator's data.
- Server-side records are authoritative for capacity, payment state, equipment availability, package units, credits, and booking status.
- A held resource is unavailable to another checkout until the hold expires, is released, or becomes a confirmed booking.
- Confirmation requires successful payment or an explicit staff-recorded external-payment state. Opening checkout or returning from Stripe is not confirmation.
- Repeated browser submissions, provider callbacks, message callbacks, and operator actions must not create duplicate bookings, charges, refunds, credits, package entries, or messages.
- Every price, tax, fee, deposit rule, policy, waiver version, and package rule used by a booking is snapshotted. Later configuration changes do not rewrite prior bookings.
- Money is stored in integer minor units with an explicit currency. Pilot sales use USD.
- Every trip displays the operator's local time zone. The stored event time remains unambiguous across daylight-saving changes.
- Financial changes, policy overrides, package and credit adjustments, imports, account merges, support access, and role changes record the actor, time, reason, and before-and-after values.
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
- package or credit applied;
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
- Reports separate product sales, mandatory fees, tax, equipment, tips, package or credit tender, refunds, and outstanding balances.

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

Pilot onboarding requires a Stripe-confirmed SaaS configuration in which `defaults.responsibilities.fees_collector = stripe` and `defaults.responsibilities.losses_collector = stripe`, or a written Managed Risk equivalent. Merchant-of-record status does not by itself assign unrecoverable negative-balance loss. If Stripe will not accept that responsibility for the proposed accounts, TideGrid must stop and reprice before contracting or processing payments.

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
- view and apply their own credits and package units; and
- manage transactional contact preferences.

A participant can manage only their own profile, intake answers, equipment, and waiver. A guardian can manage only the linked minor records for which they are acting. The primary booker cannot sign another adult's waiver.

Guest accounts use verified, passwordless sign-in. Booking does not require account creation. When a guest verifies the same email used on an existing booking, TideGrid can link it after identity checks. Suspected duplicate customers enter an operator review flow rather than merging automatically.

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

A signed waiver never changes when the operator publishes a new version. A participant must sign again when the assigned waiver version changes. A rescheduled booking can reuse a signature only when the same waiver version remains applicable and the operator's approved validity rule permits reuse.

### Acceptance behavior

- Each adult signs for themselves. A booker cannot attest for another adult.
- A minor cannot complete an adult signature flow.
- The guardian flow captures the minor, guardian, relationship declaration, exact waiver version, and signature evidence together.
- A completed signature produces immutable evidence and a downloadable copy.
- A changed waiver version marks affected unsigned work correctly and never rewrites existing evidence.
- Booking staff can see status and allowed intake answers but cannot edit a signed waiver.
- A source-matrix test proves that Stripe-paid, externally paid, staff-entered, complimentary, and imported bookings assign the same required participant and guardian waiver versions and produce the same evidence fields.

Medical questionnaires, medical clearance, health-readiness decisions, certification capture or verification, identity-document collection, and legal advice are outside the pilot.

## Transactional email, SMS, and replies

### Channels and journeys

Each operator receives branded transactional email and a dedicated US SMS-capable Twilio sender and number. The operator approves its email sender identity, reply address, templates, customer support details, and required sending-domain records. SMS launch requires the applicable Twilio business and campaign registration.

The pilot includes transactional messages for:

- booking confirmation and receipt;
- participant invitation;
- waiver reminder;
- private-charter balance reminder;
- customer or operator cancellation and reschedule;
- delay, weather disruption, and meeting-detail change;
- refund or credit status;
- package purchase and balance;
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
- booking detail with price, payment, balance, policy, participants, waiver status, equipment, packages, credits, tips, messages, and audit history;
- manual booking and external or OTA record creation;
- cancel, reschedule, refund, credit, balance-link, and policy-override actions;
- customer profile, booking history, package units, credit balance, consent, and duplicate review;
- catalog, schedule, price, tax, fee, policy, waiver, equipment, package, and template configuration; and
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
- package sales, units issued, units redeemed, remaining units, and expirations;
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

TideGrid shows available NOAA forecast and alert data for the trip location and time. The display identifies the source, issue time, last successful retrieval, and stale or unavailable state. Weather data is advisory and does not produce a safety score, recommendation, delay, cancellation, or refund automatically.

An authorized operator can place a trip on watch, close sales, delay it, cancel it, or mark it completed. A watch records the concern without changing availability. A sales closure blocks new bookings but does not change existing ones. For a delay or material detail change, the operator previews and sends one branded update to affected bookings. For a cancellation, the operator selects one remedy per affected booking: refund to the original payment method or named-customer service credit.

### Acceptance behavior

- Missing or stale weather data is visible and does not block booking or operator action.
- Only an authorized human action changes the trip or starts a customer remedy.
- The disruption preview shows affected bookings, amounts, package units, equipment, and message recipients before confirmation.
- Retrying a disruption does not repeat a refund, credit, unit reinstatement, reschedule, or message.
- Each booking shows its remedy and message status until every exception is resolved.

Automated go or no-go decisions, route planning, marine navigation, emergency alerts, safety guarantees, and autonomous cancellations are outside the pilot.

## Checkout and post-trip tips

### Required behavior

An operator may enable tips at checkout, after the trip, or both. It can configure suggested percentages and allow a custom amount. Tips are optional, clearly labeled, processed on the operator's Stripe account, reported separately from sales and taxes, and excluded from TideGrid's platform-fee base.

Checkout tips are part of the initial payment. Post-trip tipping becomes available only after authorized staff mark the trip completed. TideGrid sends a secure branded link to the primary booker and records the resulting direct charge against the booking.

### Acceptance behavior

- Removing or changing a checkout tip updates the shown and charged total exactly.
- A post-trip tip request cannot send before operator completion or more than once for the same configured journey.
- A tip refund is linked to the original tip payment and appears separately in reports.
- No workflow assigns a tip to an individual worker or represents TideGrid as paying staff.

Crew splits, tip pools, individual payouts, payroll, cash-tip tracking, and tip-based staff performance reporting are outside the pilot.

## Fixed-unit trip packages

### Required behavior

An operator can sell a named-customer package containing a fixed whole-number quantity of trip units. The package defines eligible products, units consumed per eligible booking item, sale price, tax treatment, sale window, and optional expiration date.

Packages belong to one verified customer and cannot be transferred or shared. A package unit covers only the configured trip entitlement. Taxes, equipment, mandatory fees, tips, and other uncovered party members can be paid separately at checkout.

The package ledger records purchase, issue, hold, release, redemption, cancellation reinstatement, expiration, refund adjustment, and authorized manual adjustment. Purchase uses a Stripe direct charge or an explicitly recorded external payment. TideGrid's platform fee applies at purchase and not again at unit redemption, as defined by the commercial model.

A unit is held atomically with capacity and equipment during checkout. It is redeemed only when the booking confirms. Cancellation or reschedule restores or moves the unit according to the booking's snapshotted policy.

### Acceptance behavior

- A customer cannot hold or redeem more units than remain available.
- Concurrent redemptions cannot create a negative unit balance.
- An expired checkout releases package units with all other held resources.
- Package purchase, unit balance, redemption, and reinstatement can be rebuilt from immutable ledger entries.
- Staff adjustments require a reason and never edit a prior ledger entry.
- A guest sees eligible products, expiration, remaining whole units, and any additional amount due before confirmation.

Points, status tiers, recurring memberships, gift cards, cash conversion, fractional units, package sharing, and package transfers are outside the pilot.

## Migration and launch data

### In-scope migration

TideGrid provides documented CSV templates and a repeatable import process for:

- customer identity and contact data;
- future direct, staff-assisted, and OTA bookings;
- participant names and allowed non-medical booking details;
- outstanding private-charter balances and external-payment references;
- active named-customer booking-credit balances; and
- active named-customer package balances and expiration dates.

The import records source system, external identifier, mapping version, import batch, and deduplication key. A dry run validates required fields, dates, time zones, product and boat mapping, customer matches, capacity, package totals, and credit totals. It produces a row-level error report before any live commit.

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

The supported brand configuration includes operator name, logo, approved color tokens, imagery, contact details, legal links, support links, custom web domain, app icons, splash assets, store copy, and enabled in-scope modules. Configuration must meet accessibility, security, and store-policy constraints.

Content blocks and approved settings may vary. Navigation, data model, transactional rules, component behavior, and release code do not vary by operator. A request that needs a source fork or operator-only business logic is custom software and is outside the offer.

### PWA launch

The operator supplies or delegates control of the custom domain and required DNS records. TideGrid provisions TLS, validates links, installs the correct web manifest and icons, verifies email sender records, and provides production analytics and error monitoring. Every operator's custom domain resolves only to that operator's brand and data.

### Native launch

The operator owns its Apple Developer and Google Play developer accounts and remains the named app publisher. TideGrid receives the least access needed to manage signing, store listings, TestFlight or internal testing, release preparation, approved production releases, and urgent fixes. The operator supplies approved legal entity, privacy, support, and store metadata. Under Apple's current commercial-template rule, the operator's authorized representative performs the final App Review submission; TideGrid may prepare and upload the build and listing. TideGrid may submit the Google release only after recorded operator approval.

TideGrid assigns stable bundle and package identifiers, manages signing through documented controls, and releases all operator apps from the shared source line. The release process tracks app version, configuration version, store state, supported backend range, staged rollout, minimum supported version, and rollback or emergency-update action per operator.

The contract and launch runbook define who pays store fees, who performs account-holder actions and final submissions, who answers store review questions, who owns each asset, and what happens to the listing, domain, and customer export at contract end. The full account, artifact, and submission contract is defined in [Native app factory and store submission](09-native-app-factory-and-store-submission.md).

### Acceptance behavior

- Branding changes cannot expose another operator's content or alter shared transactional rules.
- The PWA passes installability, responsive layout, accessibility, custom-domain, deep-link, and production payment tests.
- The first production pilot cannot start until its operator apps are approved for public distribution in both stores.
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
- loyalty points, memberships, gift cards, or transferable stored value;
- marketing automation, reviews, social messaging, and WhatsApp;
- public APIs, custom accounting integrations, and a generalized integration marketplace; and
- international currencies, languages, tax regimes, data residency, or non-US messaging registration.

## Production pilot acceptance gate

No operator may take a real customer booking or live payment until every item below is complete for the production environment:

1. All in-scope workflows in this document pass end-to-end acceptance for shared-seat and private-charter bookings.
2. Concurrency tests prove no overbooking or negative pooled-equipment, package-unit, or credit balance under last-unit races and retries.
3. Stripe direct-charge, deposit, balance, tip, refund, fee-reversal, webhook-retry, and reconciliation cases pass in the operator's connected-account test environment and a controlled production verification.
4. Two-tenant security tests prove isolation for guest links, accounts, console search, exports, messages, media, and support access.
5. The operator approves catalog, price, tax, fee, policy, waiver, intake, brand, email, SMS, and customer-support configuration.
6. SMS registration, dedicated-number routing, sender-domain authentication, consent, opt-out, reply, delivery-failure, and email-fallback tests pass.
7. The migration dry run and final import reconcile, and the operator signs the launch totals and cutover plan.
8. The branded PWA passes production domain, payment, accessibility, responsive, link, receipt, and analytics checks.
9. The operator-owned iOS and Android apps pass device acceptance and public store approval. Internal distribution alone is insufficient.
10. Operator roles, financial exports, roster, exception queues, audit history, data export, account-deletion request, support runbook, and incident contacts are verified.
11. No open defect can cause cross-tenant access, oversell, duplicate financial value, lost waiver evidence, missing consent, silent message failure, or an incorrect customer remedy.

The pilot is a product validation, not proof that TideGrid should proceed to general availability. Renewal, broader sales, OTA work, and any return to departure operations require evidence from paid use and the gates in the [roadmap and validation plan](05-roadmap-validation.md).
