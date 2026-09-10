# TideGrid V2 target architecture

**Status:** Canonical architecture direction; not an implementation contract

**Date:** September 3, 2026

This document defines the approved V2 architecture direction. It is a product and system design baseline, not an implementation contract.

The existing [`database/schema.sql`](../../database/schema.sql) and [`api/openapi.yaml`](../../api/openapi.yaml) remain V1 artifacts. They have not been revised for V2. No V2 database migration, generated API contract, client SDK, or production application has been created yet.

## Architecture decision

V2 is a booking-centered, multi-tenant service with one branded guest experience per operator. An operator is the tenant, and its boats are bookable resources inside that tenant. A boat is not an application, deployment, database, or security boundary.

The system uses one TypeScript modular monolith, one shared versioned API, one PostgreSQL system of record, and explicit module ownership. Tenant-owned rows carry `tenant_id`, tenant-aware foreign keys, and forced row-level security. Application services set tenant context inside each database transaction. Modules may call declared application interfaces and publish domain events, but they may not write another module's tables directly.

V2 has three client surfaces:

1. A branded guest PWA on an operator-owned custom domain for discovery, booking, payment, participant details, waivers, packages, trip changes, and tips.
2. A shared configurable native shell built from one codebase. Each operator build has its own app identity, store listing, icons, and immutable operator application identifier. Business configuration and waiver content are loaded from versioned server state.
3. A TideGrid operator web console for catalog, schedules, bookings, pooled equipment, packages, waiver templates, trip changes, messaging status, imports, and exceptions.

The PWA is the universal fallback. A guest or invited participant must be able to book, manage a booking, and sign a waiver without installing the native app. Neither guest client is an offline booking or operational authority. Capacity, payments, equipment, package balances, waiver acceptance, and booking changes require a server-confirmed command.

## Runtime topology

Cloudflare provides DNS, custom-hostname routing, TLS, static delivery, WAF controls, Workers, queues, and private object storage. The application Worker hosts the HTTP API and modular domain application. An async Worker handles outbox delivery, provider callbacks, imports, scheduled expiry, and reconciliation. PostgreSQL remains the transactional authority.

The request path is:

1. Cloudflare validates the public request envelope, rate limit, origin, and abuse controls.
2. The Worker resolves a verified custom hostname or immutable native application identifier to one tenant and brand configuration.
3. Authentication and authorization establish guest, participant, operator, support, or provider scope.
4. The application service opens a short tenant-scoped transaction.
5. Domain state, audit history, idempotency result, and outbox events commit together.
6. Stripe, messaging, weather, storage, and other network effects run after commit through provider adapters.

Queues and provider objects are delivery mechanisms or projections, not business truth. A scheduled outbox sweep recovers missed queue hints. Consumers are idempotent and record their outcome before acknowledgement.

## Tenant, brand, and release boundaries

Each operator tenant owns its guest brand, custom hostname, public content, legal links, messaging identity, Stripe connected account, catalog, boats, schedules, customers, and booking data. Booking Core includes one guest brand, custom domain, and PWA. The Native add-on includes one store-app pair. An additional operator brand or store-app pair requires another native setup and recurring fee, a custom quote, and its own isolated application identity. It still uses the shared source tree and release train.

Custom hostnames must pass ownership and certificate validation before activation. Host headers do not grant tenant access. A verified hostname mapping selects the public experience, and a short-lived scoped token carries that context to the API. CORS, CSP, cookies, cache keys, and rate limits are bound to the verified origin and tenant.

The native shell has one source tree and one release line. Per-operator variants may change only supported application metadata, approved assets, immutable application identity, and server-driven configuration. There are no customer code forks. Operator developer accounts own their Apple and Google store records, signing authority, and published identity. TideGrid may receive delegated release access and automate generation, build, testing, upload, and listing preparation. Under Apple's current commercial-template rule, the operator's authorized representative performs the final App Review submission. TideGrid may submit a Google release only after recorded operator approval. Store review remains an external gate.

Brand, catalog, policy, waiver, and messaging changes are versioned server configuration whenever platform rules allow. Native-code, entitlement, bundle identifier, application name, and icon changes require a new store build. The API accepts an application identity, semantic version, runtime capability set, and configuration version so unsupported clients can receive a defined upgrade deadline.

## Core modules and aggregates

### Identity, tenancy, and branding

`Tenant` is the isolation and operator ownership boundary. `BrandConfigVersion` owns approved theme tokens, logos, application copy, contact details, legal links, custom hostname, locale, and enabled guest capabilities. Publishing creates an immutable version and an auditable activation record. Tenant content cannot inject executable code.

### Catalog, boats, schedules, and availability

`Product` defines a sellable shared-seat or private trip and snapshots its pricing, cancellation, participant, waiver, equipment, and package eligibility rules. `PromotionRuleVersion` supports only one fixed or percentage code discount with an eligibility window and records the applied version on the quote. `Boat` is a schedulable resource with the minimum capacity facts required to sell the trip. `ScheduledTrip` is the bookable occurrence with local time, IANA time zone, resolved UTC instants, sales state, capacity, and minimal completion state.

V2 does not model full vessel readiness, maintenance, navigation, crew qualification, check-in, boarding, manifest, departure execution, return, or closeout.

### Checkout, booking, and orders

`CheckoutSession` owns an immutable quote and coordinates short-lived capacity, pooled-equipment, and package holds. `Booking` is the commercial reservation for one party on one scheduled trip. `Order` is an immutable financial statement whose lines distinguish service, paid add-on, equipment rental, mandatory fee, tax, discount, tip, package value, adjustment, and refund allocations.

Commands use an idempotency key and, where needed, an expected aggregate version. A browser or native success screen never marks a booking paid. Only a verified provider event or an explicit provider reconciliation can finalize payment state.

### Payments and tips

Stripe Connect direct charges place each guest payment on the operator's connected account. The operator is merchant of record. TideGrid records the provider references, states, amounts, refunds, and disputes needed for booking support. It assesses its subscription and managed-booking fees separately for monthly invoicing instead of adding a payment-processing spread. Stripe-hosted or embedded components keep payment method data out of TideGrid.

The pilot account contract requires `defaults.responsibilities.fees_collector = stripe` and `defaults.responsibilities.losses_collector = stripe`, or a written Managed Risk equivalent. TideGrid stores the accepted responsibility configuration with the connected-account record and blocks live payment activation when it differs. A direct charge and operator merchant-of-record label do not, by themselves, prevent TideGrid from carrying negative-balance liability.

Tips are optional order lines or a later booking-linked tip order. A tip is paid to the operator, excluded from TideGrid's platform-fee base, and refunded only through an explicit line allocation. V2 does not allocate tips to crew, calculate payroll, or pay workers.

### Pooled equipment

`EquipmentPool` represents bookable rental capacity by operator, location, type, and optional size. `EquipmentHold` reserves a quantity for the full scheduled interval and configured turnaround buffer. `EquipmentAllocation` associates the confirmed quantity with a booking and, when required, a participant.

V2 supports pooled quantity, pricing, checkout selection, manual availability blocks, cancellation release, and reschedule reacquisition. It does not support serial numbers, item custody, issue or return, condition, cleaning, maintenance, loss, damage, cylinders, gas, or inspection workflows.

### Packages

`PackageDefinition` describes a supported prepaid unit product with versioned eligibility, consumption, validity, and cancellation-reinstatement rules. `PackageAccount` is tenant-scoped and associated with a known customer. `PackageLedgerEntry` is append-only and records purchase, hold, redemption, release, reinstatement, expiration, and approved correction.

The locked balance projection must remain nonnegative. A package purchase may contribute to net managed booking value once. Redemption never incurs a second TideGrid platform fee. V2 does not include points, status tiers, automatic earning, partner rewards, anonymous gift cards, transfer, family sharing, or arbitrary customer-specific loyalty formulas.

### Service credits

`CreditAccount` is denominated in USD, tenant-scoped, and owned by one verified customer. `CreditLedgerEntry` is append-only and records issue, hold, redemption, release, reinstatement, expiration, and approved correction. Credit cannot be transferred, shared, or converted to cash through TideGrid.

The locked credit balance remains nonnegative. Checkout holds credit atomically with capacity, equipment, and package units. Expiry or failed payment releases it with the other resources. Credit that preserves value already assessed on an earlier booking does not enter net managed booking value again when redeemed.

The guest-facing `TripCard` identifies either a trip-count `PackageAccount` or a USD `CreditAccount`; denomination is immutable. Purchased dollar cards extend the credit ledger with source lots for purchased value, cancellation value and promotional value, each retaining eligibility, validity, payment/issue references and fee provenance. Money uses integer cents; trip units use integers. Card identifiers alone do not authorize access. One displayed balance may aggregate compatible lots, but holds and redemptions record the specific lots consumed. Pending purchases cannot create spendable value before payment or an authorized external-payment record confirms.

Cancellation plans allocate remedies against the booking's original tenders: eligible money-paid amounts choose refund or new credit, USD-card amounts restore to their source lots, and unit-card amounts restore eligible units. Store the frozen per-tender amounts, customer/account, policy and cause. Idempotency and balance constraints prevent returning the same portion through both a refund and a card entry. Card issue, hold, spend, release, restoration, expiration and adjustment remain append-only and auditable.

### Waivers

`WaiverTemplateVersion` owns immutable operator-approved text, rendering version, effective dates, hash, required signer relationship, and re-sign policy. `WaiverRequest` links the required version to a booking participant. `WaiverEvidence` records the participant, signer or guardian, template version, content hash, consent evidence, signature result, and recorded time.

Booking confirmation and participant addition atomically create applicable waiver assignments and outbox work. Use a unique tenant/booking/participant/version assignment key and a delivery-generation idempotency key. Retry a delivery without creating another assignment; an intentional resend creates an audited, rate-limited delivery generation. Workers recheck cancellation, participant membership, current assignment, recipient, and completed evidence before sending. Record delivery attempts separately from verification, matching, and signature status. Provider callbacks cannot change signed evidence. Migration records an explicit initial-notification policy rather than mailing historical imports.

Email and QR entry points exchange an opaque, short-lived token for a restricted session bound to tenant, booking, participant or guardian, assignment, and purpose. Store token hashes, support revocation, and consume tokens atomically on explicit redemption; an email scanner's GET or link preview does not consume them. Recipient correction revokes old access. Public QR lookup never grants roster access or reveals whether unrelated guests have bookings. A staff-issued QR or shared-device session records the staff-assisted participant match and clears guest access on completion, expiry, or the next handoff.

Record mailbox verification separately from participant-match method and signature evidence. A verified email may suggest same-tenant customer candidates but never authorizes a merge or another adult's signature by itself. Require participant confirmation or staff resolution of ambiguous matches; do not block a new participant's waiver on a historical profile merge. Keep raw email/QR tokens, lookup inputs, and waiver contents out of URLs beyond the opaque entry token, analytics, and application logs.

The native shell and PWA render the server-provided version and submit evidence online. Accepted evidence is never edited. A correction or material text change creates a new version or evidence record. TideGrid implements the approved template and evidence contract but does not draft legal terms or certify legal sufficiency.

V2 does not collect medical questionnaires, certification documents, physician clearances, or safety-readiness determinations.

### Weather and trip changes

`WeatherEvidence` is advisory marine data translated through a provider-neutral weather port. The initial adapter uses NOAA and records source, provider/model/station identifiers where available, location, units, issue time, fetched time, valid or observed time, displayed values, and stale state. Typed optional fields cover wind speed/direction/gusts, significant wave height, swell height/period/direction, wind waves, visibility, and marine alerts. Preserve observation versus forecast provenance; absent values stay unavailable. Weather data cannot automatically delay, cancel, or declare a trip safe or unsafe.

Windy's embedded map is a separate visualization, with a direct-link fallback and explicit model/time context. Its browsing state is not captured as `WeatherEvidence`, does not drive commands, and must not silently stand in for unavailable trip-date forecasts. Map URLs contain only public area coordinates and display options. Production embedding and any API use require verification of current provider terms, coverage, and credentials handling; no private API key belongs in a client bundle.

`TripChange` records an authorized human decision for one scheduled trip. The initial actions are watch, sales closure, delay, and pre-service cancellation. A watch records concern without changing sales or bookings. The other approved actions close affected sales when applicable and freeze the affected booking set. Cancellation creates one idempotent remedy task per booking. The operator selects one remedy per affected booking: refund to the original payment method or noncash service credit. Package-funded bookings restore eligible units under the snapshotted policy. Messages report the operator's decision and each customer's result.

V2 does not include automated safety decisions, at-sea aborts, vessel or crew substitution, partial-party moves, waitlist priority, multi-trip disruption plans, or incident workflows.

### Messaging

Email uses a provider-neutral adapter. SMS uses a dedicated Twilio subaccount, Messaging Service, and sending number for each operator. Tenant configuration stores provider identifiers and server-side credential references, never provider secrets in a client or public configuration.

Transactional and marketing consent remain separate. Provider callbacks enter an idempotent inbox before changing delivery state. Booking confirmation, participant invitation, waiver reminder, trip change, refund, package, and tip messages use versioned templates and record delivery outcome. A Twilio failure can fall back to email only when the message policy and consent allow it.

Native push uses a provider-neutral adapter over Apple and Google delivery services. Device registrations bind a token to one tenant, application identity, authenticated guest, device, and permission state. Sign-out, account deletion, token rotation, or permission revocation disables the registration. Notifications contain no sensitive booking or waiver detail; they open a scoped deep link and require current authorization before showing protected data. Push sends originate from the transactional outbox, record provider outcome when available, and remain best effort. A push failure is visible and does not replace required email or consented SMS delivery.

### Imports

V2 is direct-first. TideGrid owns direct web, native, phone, and staff-created bookings after operator cutover. The import boundary supports controlled, one-way ingestion of future bookings, customers, and approved package balances. Every imported object records source system, external identifier, mapping version, import batch, and reconciliation status.

Imports do not create a live synchronization contract. TideGrid is the booking and inventory system of record for direct and staff-created bookings after cutover. An imported OTA reservation remains a labeled capacity and roster shadow of the incumbent record. The incumbent continues to control its price, availability, cancellation, payment, and channel communication, and operator staff record changes in TideGrid. TideGrid does not dual-write with an incumbent, publish inventory to an OTA, or accept live OTA booking updates in V2.

## Retained invariants

The V2 implementation must retain these invariants:

- Every tenant-owned row and reference preserves tenant scope. Forced RLS is defense in depth, not a substitute for application authorization.
- Capacity, all required pooled equipment, all package units, and applied service credit are held atomically or none are held.
- Checkout hold expiry releases every capacity, equipment, package, and credit hold idempotently.
- Payment success after hold expiry either reacquires every requirement atomically or creates a full refund and operator exception.
- Package-unit and service-credit balances never become negative. Corrections and reinstatements append compensating entries and reference their cause.
- Booking confirmation depends on verified payment state or an explicitly authorized external-payment record.
- Order, policy, price, package, waiver, and platform-fee versions are snapshotted. Later configuration changes do not rewrite history.
- Payment rail and import origin do not by themselves remove a TideGrid-managed booking from the platform-fee base. Taxes, tips, complimentary value, promotional credit, refunded value, and later package-unit redemption remain excluded under the approved commercial schedule.
- Trip changes that affect customers require an authorized human decision. Weather evidence alone has no command authority.
- Each command and provider callback is idempotent. Domain state and required outbox records commit together.
- External calls never hold a database lock. Unknown external outcomes are reconciled before a new non-idempotent attempt.
- Local schedules preserve IANA time zone, local values, resolved UTC instants, and offset snapshots.
- Imported data cannot silently replace or duplicate direct booking truth.

## Public API implications

V2 requires a new generated OpenAPI contract before implementation. The target public contract families are:

- experience bootstrap by verified hostname or native application identity;
- public catalog, scheduled-trip availability, quote, and atomic checkout hold;
- booking creation, retrieval, cancellation, and management-link flows;
- participant details and versioned waiver request, rendering, submission, and status;
- pooled-equipment selection and availability within quote and hold commands;
- package balance, eligibility, hold, purchase, redemption, release, and reinstatement;
- service-credit balance, issue, hold, redemption, release, reinstatement, expiration, and correction;
- booking payment, booking-linked tip payment, refund, and provider status;
- customer-visible trip-change outcome and operator trip-change approval and execution status;
- operator brand publication, catalog, schedule, equipment, package, waiver, messaging, import, and exception management;
- native device registration, revocation, push permission, and notification deep-link resolution;
- Stripe, Twilio, email, and other provider callback intake;
- application version, capability, and configuration compatibility metadata.

All state-changing endpoints require authorization, tenant context, idempotency, validation, correlation ID, and audit classification. Guest and participant routes use scoped, expiring credentials. Public experience context does not grant operator permissions.

The target event catalog includes versioned events for brand publication, hold acquisition and expiry, booking confirmation and cancellation, payment and tip outcome, equipment allocation and release, package and service-credit ledger entries, waiver signature, trip-change approval and remedy completion, message delivery, push registration, and import completion or exception. Events contain identifiers and minimum operational data, not provider secrets, payment methods, device tokens, waiver bodies, or unnecessary personal information.

These endpoint and event families describe intent only. Their exact paths, schemas, enums, compatibility policy, and generated types are not yet defined.

## Security and privacy

- Operator web users authenticate through managed OIDC with MFA and role scope. Guest and participant access uses short-lived, single-purpose links or tokens.
- Native application identity and custom-domain routing select an experience but do not replace authentication or authorization.
- PostgreSQL RLS, tenant-aware foreign keys, explicit query predicates, tenant-scoped cache keys, and automated tenant-escape tests protect isolation.
- Stripe-hosted components keep PAN and sensitive payment authentication data outside TideGrid.
- Waiver evidence, customer identity, guardian relationships, contact details, device tokens, and messaging consent receive field-appropriate authorization, encryption, retention, export, and deletion handling.
- Native and web clients store no provider credentials. Client logs, analytics, crash reports, queues, and events exclude tokens, waiver bodies, payment method data, and unnecessary personal information.
- Custom brand assets and content are type checked, size limited, sanitized, and served under a strict CSP. Operators cannot upload executable extensions.
- Twilio sender registration, consent claims, waiver language, tax settings, package policy, and physical equipment counts require operator approval and remain operator responsibilities.
- Support access is time-bound, reason-bound, audited, and masked by default.

## Reliability and operational behavior

PostgreSQL is authoritative for bookings, holds, orders, payment projections, package balances, service-credit balances, waiver evidence, trip changes, imports, and idempotency. Cache or client state may improve display performance but may never confirm inventory, money, or stored value.

The critical reliability journeys are availability, atomic hold, payment-to-booking finalization, waiver submission, cancellation remedy, and provider callback processing. Monitoring must expose hold expiry, finalization exceptions, payment and refund reconciliation, package or credit invariant attempts, equipment conflicts, stale weather data, message and push delivery failures, import mismatches, and app-version adoption.

Provider degradation is explicit:

- Stripe failure preserves checkout and idempotency state and never claims payment success.
- Twilio failure queues within the retry budget, displays delivery state, and uses approved email fallback when available.
- Email failure remains visible and retryable without duplicating a successful SMS.
- Push failure remains visible and does not suppress the required email or consented SMS path.
- NOAA failure or stale data displays source age and leaves the decision with the operator.
- Queue failure leaves the committed outbox as recoverable truth.
- Native store delay does not block the PWA or operator console.

Database migrations use expand, migrate, and contract sequencing. App and API changes remain backward compatible across the defined native support window. A release pipeline must build and test every enabled operator configuration, but a failure in one store account or listing must not block web deployment or other operators' submissions.

The implementation topology, environment separation, deployment controls, recovery plan, and cost envelope are defined in [Build, hosting, and operations](08-build-hosting-and-operations.md). The operator manifest, release artifacts, signing custody, and submission workflow are defined in [Native app factory and store submission](09-native-app-factory-and-store-submission.md).

## Deferred architecture

The following capabilities are outside V2:

- full offline departure operations;
- captain or crew operational workflows;
- crew scheduling, credentials, time, payroll, or tip allocation;
- medical questionnaires, certification evidence, or readiness decisions;
- manifests, check-in, boarding, departure, return, closeout, or incidents;
- vessel maintenance, documents, safety checks, navigation, or control;
- serialized equipment, custody, condition, cleaning, maintenance, damage, or loss;
- points, tiers, automatic loyalty earning, or arbitrary loyalty programs;
- live OTA inventory or booking synchronization;
- automated weather, seaworthiness, or trip-safety decisions;
- generalized ERP, payroll processing, accounting ledger, or tax filing.

Adding a deferred capability requires evidence, an explicit product decision, and an architecture review. A tenant feature flag is not approval to bypass these boundaries.
