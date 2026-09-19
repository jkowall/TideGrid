# 5. Detailed functional requirements

Requirements use stable IDs for traceability. “Must” is acceptance-critical. “Should” is a default that can be changed only through an ADR or product decision.

## FR-TEN: tenancy and configuration

- **FR-TEN-001:** Every operator record must belong to one tenant organization.
- **FR-TEN-002:** A tenant must support multiple brands, locations, legal entities, docks, marinas, vessels, operating time zones, and connected Stripe accounts.
- **FR-TEN-003:** A location must have one IANA time zone. A departure must retain local date, UTC instants, and the offset used when scheduled.
- **FR-TEN-004:** Roles must be scoped by tenant and optionally location. Crew-facing access must also be assignment-scoped.
- **FR-TEN-005:** Legal entity and Stripe account selection must be explicit for every sellable product.
- **FR-TEN-006:** Tenant suspension must block new commercial commands while preserving read access, refunds, exports, and support recovery.
- **FR-TEN-007:** Every tenant subscription must resolve to a versioned pricing plan, subscription state, location allowance, active-boat allowance, and add-on entitlements. Customer, booking, user, product, and departure counts must not impose usage limits.

## FR-CAT: catalog, scheduling, and pricing

- **FR-CAT-001:** Operators must configure trip templates, vertical module, variants, shared-seat or private inventory, passenger types, add-ons, requirements, and policies.
- **FR-CAT-002:** Schedules must support recurrence, seasons, one-time departures, blackouts, lead times, online cutoffs, check-in, boarding, departure, return, preparation, and cleanup.
- **FR-CAT-003:** Pricing must support passenger-specific prices, private flat rates, time-bounded seasonal rules, mandatory fees, taxes, optional tips, promotions, staff discounts, complimentary lines, and affiliate attribution.
- **FR-CAT-004:** Price calculation must return an immutable quote snapshot with currency, line-level quantities, taxes, fees, discounts, eligibility, and expiry.
- **FR-CAT-005:** Published departures must reference a versioned product and policy snapshot. Later catalog edits must not silently change sold bookings.
- **FR-CAT-006:** Manual bookings must record source as phone, walk-up, concierge, affiliate, staff, import, complimentary, or promotion.

## FR-RES: generalized resource booking

- **FR-RES-001:** A trip template or departure must declare required resource type, quantity, qualification, occupied interval, buffers, exclusivity, substitution rule, and approval rule.
- **FR-RES-002:** Resources must include vessels, crew members, docks, slips, permits, locations, vehicles, trailers, rental pools/items, cylinders, cameras, compressors, and safety equipment.
- **FR-RES-003:** Active holds and reservations for exclusive resources must not overlap.
- **FR-RES-004:** Blocks must support maintenance, unavailability, training, cleaning, fueling, dock closure, out-of-service, option, and administrative reasons.
- **FR-RES-005:** Substitution must revalidate capacity, qualifications, route, equipment, and timing before commitment.
- **FR-RES-006:** An authorized override must capture actor, reason code, explanation, affected rule, and expiration when temporary.

## FR-CAP: multidimensional capacity

- **FR-CAP-001:** Capacity profiles must support passengers, total persons, crew seats, diver, snorkeler, observer, child, gear, tank, weight/configuration, certificate, route, and ratio dimensions.
- **FR-CAP-002:** A profile may vary by vessel, product, crew complement, passenger mix, route, configuration, and regulatory classification.
- **FR-CAP-003:** A booking mutation must atomically reserve every affected bucket or reserve none.
- **FR-CAP-004:** The effective limit is the minimum applicable product, departure, vessel-profile, and rule-derived limit.
- **FR-CAP-005:** Capacity must count active holds and confirmed allocations. Expired, cancelled, and released records must not block.
- **FR-CAP-006:** A crew or vessel substitution must recompute capacity and enter an exception state if current load exceeds the new profile.

## FR-HLD: checkout holds and concurrency

- **FR-HLD-001:** Checkout must hold seats, whole-vessel inventory, equipment, package units, finite add-ons, and charter options under one checkout session.
- **FR-HLD-002:** The default hold is 15 minutes. The server may grant one five-minute extension before payment confirmation if all resources remain held.
- **FR-HLD-003:** Payment initiation may extend the hold to a configurable payment-pending deadline, capped at 30 minutes total without manager override.
- **FR-HLD-004:** Expiration must release every hold idempotently and append release ledger entries where applicable.
- **FR-HLD-005:** PostgreSQL is authoritative. Caches may accelerate search but may never confirm inventory.
- **FR-HLD-006:** Serialization failure or deadlock retries must restart the entire command, use bounded exponential jitter, and stop after three attempts.
- **FR-HLD-007:** Payment success after expiry must attempt atomic reacquisition once. Failure must trigger full refund, fee reversal, exception case, and customer/operator notification.

## FR-CUS: customers, parties, and participants

- **FR-CUS-001:** Customer account, primary booker, booking party, participant, guardian, emergency contact, crew, affiliate, and operator user must remain distinct.
- **FR-CUS-002:** A participant must not require an account. Booker and participant links must be scoped, expiring, revocable, and single-purpose.
- **FR-CUS-003:** Booker changes, guest replacement, participant transfer, partial-party move, and profile merge must retain audit history.
- **FR-CUS-004:** Duplicate detection may suggest matches but must not merge automatically.
- **FR-CUS-005:** Profiles may store certification metadata, sizes, accessibility needs, dietary restrictions, allergies, mobility needs, emergency information, and preferences with field-specific authorization.
- **FR-CUS-006:** Transactional and marketing consent must be separate by channel, subject, sender, evidence, and current status.

## FR-STV: packages, gift cards, and credits

- **FR-STV-001:** Unit packages, dollar gift cards, promotional credits, refund credits, and service credits must use distinct account types and rules.
- **FR-STV-002:** Package rules must include unit type, original units, eligible products/locations/passenger types, per-product consumption, blackout, validity, ownership, transfer, sharing, and reinstatement.
- **FR-STV-003:** The ledger must be append-only with purchase, hold, redemption, release, reinstatement, expiration, manual credit/debit, refund, and transfer entries.
- **FR-STV-004:** Multiple packages may fund one booking. Consumption may exceed one unit per participant or product.
- **FR-STV-005:** Balance projection updates and ledger append must share one locked transaction and must never create a negative balance.
- **FR-STV-006:** Secure codes must be high entropy, stored as hashes, rate limited, and reveal neither owner identity nor balance before authorization.
- **FR-STV-007:** Cancellation must apply the snapshotted reinstatement rule and reference the original redemption.

## FR-PAY: payments and financial operations

- **FR-PAY-001:** Every commercial transaction must have one internal order, immutable order lines, and one or more payment attempts.
- **FR-PAY-002:** Online, Terminal, customer-authorized saved card, cash/external record, gift card, credit, package, refund, dispute, SaaS subscription, fee, payout, and tip flows must remain distinguishable.
- **FR-PAY-003:** Customer booking payments must use Connect direct charges on the operator account. SaaS billing must use a separate platform subscription context.
- **FR-PAY-004:** All provider commands must use a unique internal idempotency key and persist request/result metadata.
- **FR-PAY-005:** A browser success page must not mark an order paid.
- **FR-PAY-006:** Verified webhooks must enter the provider-neutral inbox before asynchronous business processing.
- **FR-PAY-007:** The plan-specific platform-fee base must exclude tax, tip, redeemed stored value, cash/external value, and imported OTA value.
- **FR-PAY-008:** Refund allocation must identify order lines, tax, tip, stored value, equipment, package reinstatement, cash amount, and proportional application-fee reversal.
- **FR-PAY-009:** Daily close must reconcile internal attempts, Stripe PaymentIntents/charges, refunds, application fees, disputes, balance transactions, and payouts.
- **FR-PAY-010:** Restricted connected accounts must block new payment collection and enter an operator action queue without blocking safe refunds or exports.
- **FR-PAY-011:** Every platform-fee entry must snapshot the pricing plan code, pricing schedule version, eligible base, and rate basis points. Plan changes apply prospectively and must not rewrite historical orders or fees.

## FR-CHR: private charter

- **FR-CHR-001:** The workflow must support inquiry, lead, requested and alternate dates, option hold, itinerary, passenger count, custom lines, internal review, proposal, acceptance, and full payment.
- **FR-CHR-002:** Option holds must participate in the same exclusive vessel and resource constraints.
- **FR-CHR-003:** Proposals must be versioned, expire, and snapshot cancellation terms.
- **FR-CHR-004:** Acceptance must fail safely if the option expired or resources changed.
- **FR-CHR-005:** Change orders must preserve original and revised values and require renewed acceptance when price or material terms change.

## FR-DOC: waivers, medical forms, and credentials

- **FR-DOC-001:** Templates and immutable versions must support operator, activity, jurisdiction, effective dates, hash, and required re-signing.
- **FR-DOC-002:** Signature evidence must include version, signer, participant, guardian relationship, timestamp, consent statement, IP/device metadata, and document hash.
- **FR-DOC-003:** One guardian may sign for multiple minors, but each minor must retain a separate signature relationship.
- **FR-DOC-004:** Medical, physician-clearance, and certification uploads must support status, verifier, rejection, resubmission, expiry, and access classification.
- **FR-DOC-005:** “Complete” is derived from current required evidence, not stored as an unqualified boolean.
- **FR-DOC-006:** Offline bundles may contain a rendered snapshot and readiness result, not unrestricted source medical answers unless explicitly required and authorized.

## FR-MAN: manifest and check-in

- **FR-MAN-001:** Readiness must separately represent booking, confirmation, payment, paperwork, certification, medical review, equipment, check-in, boarding, no-show, and ashore state.
- **FR-MAN-002:** The dockside UI must use large targets, high contrast, text plus icons, and must not rely on red/green alone.
- **FR-MAN-003:** Check-in and boarding must identify participant, actor/device, timestamp, source, and command ID.
- **FR-MAN-004:** Departing must create an immutable manifest snapshot containing participant, crew, emergency, evidence status, payment status, equipment, vessel, captain, location, and planned/actual time data.
- **FR-MAN-005:** A participant boarded after snapshot creation requires an authorized manifest amendment linked to the original snapshot.
- **FR-MAN-006:** Return cannot close until every boarded participant is marked ashore or an incident/exception is open.

## FR-OFF: offline captain application

- **FR-OFF-001:** Assigned trip bundles must be downloadable, encrypted locally, versioned, integrity checked, and explicitly marked complete or incomplete.
- **FR-OFF-002:** Each command must include device ID, command ID, local sequence, base version, local occurrence time, and payload version.
- **FR-OFF-003:** Offline-operable commands are check-in, boarded, no-show, disembarked, operational note, checklist, actual departure/return, equipment return, and incident creation.
- **FR-OFF-004:** Payments, refunds, package balances, resource allocation, final capacity, and customer identity mutations are server-only.
- **FR-OFF-005:** Participant replacement, capacity changes, equipment reassignment, identity changes, and conflicting boarding state require server validation or manual conflict resolution.
- **FR-OFF-006:** The app must display last sync, pending, failed, conflict, stale-bundle, revocation, and offline-ready status.
- **FR-OFF-007:** Logout, revocation, inactivity expiry, jailbreak/root signal, and retention expiry must lock or purge local data.

## FR-DIS: disruptions and weather

- **FR-DIS-001:** Reasons must include weather, sea condition, mechanical, crew illness, port/site closure, visibility, minimum count, substitution, regulation, and operator decision.
- **FR-DIS-002:** Actions must support watch, delay, location/vessel change, shorten, selected/date cancellation, crew-only or all notification, partial/full move, credit, package restoration, refund, and priority pool.
- **FR-DIS-003:** Weather evidence must record provider, observation/forecast/alert identifiers, fetched time, values shown, and source link.
- **FR-DIS-004:** Only authorized humans may approve a safety-affecting action.
- **FR-DIS-005:** A disruption case must show affected departures, parties, chosen remedies, financial outcomes, messages, unresolved exceptions, and actor history.
- **FR-DIS-006:** Batch actions must be individually idempotent and resumable.

## FR-WAI: waitlist and standby

- **FR-WAI-001:** Entries must capture party size, flexibility, product/location, package/membership status, priority basis, and opt-out.
- **FR-WAI-002:** Offers may be automatic or manual, must expire, and may allow partial-party matching if opted in.
- **FR-WAI-003:** Only one offer may claim a specific capacity grant. Acceptance must use the normal hold transaction.
- **FR-WAI-004:** Failed payment or expiry must release the grant and promote the next eligible entry.

## FR-EQP: equipment and dive logistics

- **FR-EQP-001:** Equipment must support serialized items and pooled inventory by type, size, location, condition, inspection, maintenance, and availability.
- **FR-EQP-002:** Holds and allocations must cover the full occupied interval including cleaning or turnaround buffers.
- **FR-EQP-003:** Pooled availability must use locked bucket projections. Serialized active allocation must be unique/nonoverlapping.
- **FR-EQP-004:** Checkout, participant assignment, issue, return, damage, loss, cleaning, and maintenance must be separate states/events.
- **FR-EQP-005:** Dive records must support certification requirements, logged-dive attestations, buddy/group, ratios, dive site/plan, depth/time, gas, cylinder, analyzer confirmation, and inspection dates.
- **FR-EQP-006:** Tank-fill, compressor, oxygen, first-aid, and digital dive-log depth may expand after MVP without changing the core equipment contract.

## FR-SAF: no-fly and surface interval

- **FR-SAF-001:** Operators must configure warning rules by profile and version.
- **FR-SAF-002:** Inputs may include number of dives/days, decompression status, planned final surfacing time, flight time, and safety margin.
- **FR-SAF-003:** The system must show a warning and collect acknowledgment; it must not claim medical clearance.
- **FR-SAF-004:** Overrides require an authorized role, reason, versioned warning text, and audit event.

## FR-CRW: crew and compliance

- **FR-CRW-001:** Roles must include captain, relief captain, divemaster, instructor, guide, deckhand, mate, photographer, and trainee.
- **FR-CRW-002:** Crew records must support availability, planned/actual hours, pay metadata, worker classification, qualifications, restrictions, expiries, documents, and verification.
- **FR-CRW-003:** Assignment must validate overlap, availability, role qualification, credential dates, route/product restrictions, and ratio rules.
- **FR-CRW-004:** An authorized override must identify failed rules and cannot suppress future expiry alerts.
- **FR-CRW-005:** MVP exports time and tip allocations; it does not calculate payroll tax or pay crew.

## FR-VSL: vessel readiness and maintenance

- **FR-VSL-001:** Store registration, insurance, inspection/capacity documents, permitted route, restrictions, safety equipment, required crew, and expiry.
- **FR-VSL-002:** Defects and maintenance blocks must prevent assignment when out of service.
- **FR-VSL-003:** Pre/post checklists must be versioned and record item-level completion, actor, time, note, and attachment.
- **FR-VSL-004:** Return to service requires manager approval and must retain defect/work history.
- **FR-VSL-005:** Vessel substitution must record old/new vessel, reason, revalidation result, capacity effect, customer impact, and notifications.

## FR-TRP: trip execution and closeout

- **FR-TRP-001:** Dispatch must show readiness, exceptions, watch/delay, crew, vessel, capacity, and deadlines for every departure.
- **FR-TRP-002:** Execution must record briefing, all-aboard, actual departure, overdue alert, actual return, all-ashore, equipment return, fuel/maintenance note, and closeout.
- **FR-TRP-003:** Incident types must include near miss, injury, first aid, customer issue, equipment loss/damage, and operational event.
- **FR-TRP-004:** Incident exports must bind the manifest snapshot, crew, waiver versions, emergency contacts, chronology, communications, photos, and review.
- **FR-TRP-005:** A departure closes only when operational exceptions and financial reconciliation status are explicit.

## FR-MSG: communications

- **FR-MSG-001:** Support transactional SMS and email, provider-neutral templates, locale, product/location overrides, quiet hours, deduplication, and idempotency.
- **FR-MSG-002:** Track provider ID, attempts, delivery history, timestamps, errors, sender, recipient, consent evidence, and content version.
- **FR-MSG-003:** Inbound replies and opt-out callbacks must enter the webhook inbox and update conversation/consent state idempotently.
- **FR-MSG-004:** Booking confirmation, management link, participant invitation, waiver reminder, arrival instructions, disruption, tip, and review are standard journeys.
- **FR-MSG-005:** An unhappy or open-incident customer must enter service recovery before public-review solicitation.
- **FR-MSG-006:** Delivery failure must use configured fallback or operator alert without duplicating successful delivery.

## FR-TIP: tips and reviews

- **FR-TIP-001:** Tips are collected on the operator account and excluded from TideGrid's platform-fee base.
- **FR-TIP-002:** Allocation must snapshot the applicable crew roster and support fixed percentage, role, hours, equal split, and manager override.
- **FR-TIP-003:** Adjustments and refunds append compensating entries; prior allocations are not overwritten.
- **FR-TIP-004:** Export is for payroll/accounting. TideGrid does not pay individual crew in MVP.
- **FR-TIP-005:** Review links must support Google, TripAdvisor, and operator feedback with service-recovery suppression.

## FR-INT: distribution and integrations

- **FR-INT-001:** Provide hosted booking, embeddable widget, product/departure deep links, UTM and booking-source attribution.
- **FR-INT-002:** Provide public REST APIs, HMAC-signed outgoing webhooks, and documented idempotency/versioning.
- **FR-INT-003:** Imports must retain source system, external ID, raw record reference, mapping version, and deduplication key.
- **FR-INT-004:** OTA adapters must translate external status without leaking provider objects into the domain model.
- **FR-INT-005:** Full two-way OTA inventory synchronization is not MVP, but availability and booking ports must support later connectors.

## FR-REP: reporting and analytics

- **FR-REP-001:** Operational reporting must cover departures, readiness, occupancy/load, source, cancellations, reschedules, no-shows, equipment, crew, and document completion.
- **FR-REP-002:** Financial reporting must separate gross sale, tax, tip, Stripe fees, TideGrid fees, refunds, disputes, credits, package liability, payouts, and net operator proceeds.
- **FR-REP-003:** Reports must use tenant/location time zone for business grouping while retaining UTC event time.
- **FR-REP-004:** Expensive reports must use projections or replica queries and must not endanger checkout latency.
- **FR-REP-005:** Every financial aggregate must drill to immutable source entries and expose reconciliation exceptions.

## FR-ADM: platform administration

- **FR-ADM-001:** Support onboarding, Stripe/Twilio status, subscriptions, entitlements, feature flags, import/export, deletion requests, suspension, and offboarding.
- **FR-ADM-002:** Support impersonation must require ticket/reason, approval for sensitive scope, short expiry, persistent banner, and immutable audit.
- **FR-ADM-003:** Operators must be able to inspect webhook failures, replay safe events, and export tenant data subject to role.
- **FR-ADM-004:** Platform admins must not view medical or minor data by default.
- **FR-ADM-005:** Administrative deletion must respect immutable evidence and legal retention, using tombstones or de-identification where deletion is prohibited.

## Cross-cutting acceptance rules

- All command endpoints require authorization, tenant context, idempotency, validation, correlation ID, and audit classification.
- State changes and required outbox events commit atomically.
- External side effects are retried asynchronously and never hold database locks.
- Dates shown to users include the location time zone. Ambiguous or nonexistent local departure times require explicit operator resolution.
- Money uses integer minor units plus ISO currency. Quantities use explicit units and bounded precision.
- All destructive or override actions expose a dry summary before confirmation and retain reason/evidence afterward.
