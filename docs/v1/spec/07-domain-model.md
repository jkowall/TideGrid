# 7. Domain model

## Bounded contexts and ownership

Only the owning context writes its tables. Cross-context changes use application interfaces and published domain events. Read projections may join across contexts but cannot become write paths.

| Context | Owns | Publishes |
|---|---|---|
| Identity and Tenancy | tenants, brands, locations, legal entities, users, roles, scopes, devices | TenantConfigured, UserRoleChanged, DeviceRevoked |
| Catalog and Pricing | products, variants, schedules, price/policy/requirement versions | ProductPublished, PriceRuleChanged |
| Scheduling and Availability | departures, resources, requirements, reservations, capacity profiles/buckets/holds | DepartureScheduled, CapacityHeld, ResourceReserved |
| Booking and Checkout | checkout sessions, bookings, parties, booking participants | CheckoutExpired, BookingConfirmed, BookingChanged |
| Orders and Payments | orders, lines, attempts, refunds, disputes, fees, payout reconciliation | PaymentSucceeded, RefundSucceeded, DisputeOpened |
| Stored Value | packages, package accounts/ledger, gift cards, credit ledgers | PackageHeld, PackageRedeemed, CreditIssued |
| Customers and Participants | customers, profiles, participants, guardians, emergency contacts, consent | ParticipantUpdated, ConsentChanged |
| Waivers and Documents | templates/versions, signatures, medical forms, certification documents | WaiverSigned, EvidenceAccepted |
| Manifests and Operations | manifests/snapshots, checklists, execution events, incidents | ParticipantBoarded, VesselDeparted, IncidentCreated |
| Equipment Inventory | pools, items, holds, allocations, conditions | EquipmentHeld, EquipmentReturned |
| Crew and Compliance | crew, credentials, availability, assignments, time, tip allocations | CrewAssigned, CredentialExpiring |
| Vessels and Maintenance | vessels, documents, defects, maintenance blocks | VesselBlocked, VesselReturnedToService |
| Disruptions and Rebooking | disruption cases/actions, waitlists/offers, remedy choices | DisruptionApproved, RebookingOffered |
| Messaging | templates, messages, deliveries, inbound replies | MessageDelivered, RecipientOptedOut |
| Offline Synchronization | device bundles, commands, cursors, conflicts | OfflineCommandApplied, SyncConflictOpened |
| Reporting and Reconciliation | read projections, close records, exceptions | ReconciliationExceptionOpened |
| Integrations | provider mappings, imports, outgoing subscriptions/deliveries | ImportCompleted, OutgoingWebhookFailed |
| Platform Administration | entitlements, subscriptions, feature flags, support sessions | TenantSuspended, SupportSessionStarted |

## Core aggregates

### Tenant

Root for brands, locations, legal sellers, entitlements, and policy defaults. Tenant identity is immutable. Offboarding changes status and retention, not identity.

### Product

Defines a sellable trip family. A published version owns passenger types, pricing input rules, required documents, eligibility, cancellation/reschedule policy, and resource requirement templates.

### Departure

Operational root for one scheduled occurrence. It owns local schedule snapshots, assigned resource requirements, capacity profile reference, lifecycle, readiness projection, actual times, and disruption linkage. It does not own payment, customer, crew, or equipment source records.

### CheckoutSession

Coordinates a quote, a set of holds, an order, and payment attempts. It is short-lived and idempotent. It does not become the long-term booking root.

### Booking

Commercial reservation root for one party on one departure/product. It owns source, primary booker relationship, party membership, policy snapshots, allocation references, lifecycle dimensions, price adjustments, and customer-visible/internal notes.

### Order

Immutable commercial statement. It owns seller, currency, order lines, fee eligibility, tax/tip classifications, totals, and financial status projection. Corrections use adjustment or refund lines.

### StoredValueAccount

Root for one package, gift card, or credit balance. It owns immutable ledger entries and a locked balance projection. Each entry declares unit/currency, causal command, original entry reference, and booking/order association.

### Participant

Person participating in service, separate from customer login and booker. Sensitive profile sections are independently authorized and encrypted.

### ManifestSnapshot

Immutable departure-time evidence. It contains copied display/evidence status required for offshore operation and references source versions. Amendments reference the snapshot.

### Resource

General schedulable object. Type-specific details live in the owning module. Exclusive reservations use occupied time ranges; capacity-based resources use buckets.

### DisruptionCase

Coordinates a human decision and independently retryable effects across departures, parties, money, stored value, messages, and waitlist priority.

## Shared value objects

| Type | Representation and invariant |
|---|---|
| TenantId and entity IDs | UUID, never client-assigned except offline command/device IDs where documented |
| Money | Integer minor units plus ISO 4217 currency |
| Quantity | Decimal with explicit unit; no floating-point financial or gas values |
| TimeWindow | `tstzrange`, half-open `[start,end)` |
| LocalSchedule | IANA zone, local date/time, resolved UTC instant, offset snapshot, DST resolution |
| Actor | user/service/device ID, role snapshot, support-session ID when applicable |
| Reason | controlled code plus optional/required explanation |
| Version | positive integer incremented on aggregate mutation |
| ProviderReference | provider, environment, account ID, object type, external ID |
| DocumentHash | SHA-256 hash plus rendering/template version |
| ConsentEvidence | subject, channel, sender, status, source, policy version, captured time |

## Vertical extension model

The shared core stores only cross-vertical concepts: product, departure, booking, participant, requirements, resources, capacity, order, evidence, manifest, and execution events.

Vertical modules attach through:

- `product.module_type` and module-owned product configuration;
- module-owned participant/departure records keyed by tenant and core ID;
- registered requirement evaluators;
- registered capacity dimensions and resource types;
- module-specific checklist, evidence, and report projections;
- versioned extension payloads at API boundaries only when a typed contract is unavailable.

Dive-specific medical, cylinder, gas, buddy, depth, and log fields do not enter the core booking table. Fishing and excursion fields follow the same rule.

## Relationship rules

- A booking targets one departure or private-charter proposal conversion.
- A booking has one current primary booker and one or more participants.
- A participant can appear in many bookings and may have zero customer account.
- A departure has many requirements; satisfying them creates reservations/assignments owned by the applicable context.
- An order may fund one booking initially; multi-booking carts are deferred.
- One booking can consume multiple payments and stored-value accounts.
- Provider IDs are scoped by provider environment and connected account.
- All tenant-owned foreign keys include `tenant_id`.

## Invariant enforcement map

| Invariant | Primary enforcement | Secondary detection |
|---|---|---|
| Exclusive resource overlap | PostgreSQL exclusion constraint | Reconciliation query and scheduling alert |
| Capacity oversell | Locked bucket update and transaction | Projection rebuild |
| Negative package/credit | Locked balance projection plus check | Ledger recomputation |
| Duplicate redemption/refund/import | Unique command/external key | Reconciliation |
| Cross-tenant reference | Composite foreign key and RLS | Security tests |
| Invalid state transition | Domain state machine | Audit anomaly monitor |
| Invalid crew qualification | Domain guard in locked assignment transaction | Daily credential scan |
| Payment truth | Verified webhook/provider retrieval | Scheduled Stripe reconciliation |
| Immutable evidence | Privileges, no update/delete path, hash | Periodic integrity verification |
