# 4. MVP, post-MVP, and non-goal matrix

## MVP

| Capability | MVP boundary |
|---|---|
| Tenancy | Organizations, brands, locations, legal entities, docks, time zones, roles, location scope, feature entitlements |
| Catalog | Shared-seat and private products, variants, schedules, seasonal rules, blackouts, cutoffs, prices, fees, taxes, policies, requirements |
| Availability | Vessels, crew roles, docks, permits, exclusive resources, multidimensional capacity, buffers, maintenance and admin blocks |
| Checkout | Temporary holds for seats, whole vessel, equipment, add-ons, and package units; 100% payment |
| Booking | Online, phone, walk-up, concierge, affiliate, imported, complimentary; party edits and partial cancellation/reschedule |
| Customer | Booker, party, participant, guardian, emergency contact, preferences, duplicate review, scoped magic links |
| Payments | Stripe Connect direct charges, card-not-present, Terminal, saved-card authorization, cash/external recording, refunds, disputes, fees, reconciliation |
| Commercial | Dock, Growth, Fleet, and Enterprise plans; Stripe Billing subscription state; boat/location entitlements; active-boat add-ons; annual discount; seasonal read-only mode; versioned rate snapshots |
| Stored value | Unit packages, gift cards, service and refund credits, immutable ledgers, secure codes, concurrency control |
| Documents | Versioned waivers, guardian linkage, medical and certification uploads, verification state, hashes, PDF export |
| Operations | Dispatch board, manifest, sunlight-ready check-in, boarding, departure snapshot, return, closeout, incidents |
| Offline | Pre-downloaded trip bundles, encrypted device database, operational command log, deterministic sync and conflicts |
| Disruption | Human-approved watch, delay, vessel/location change, cancellation, partial/full rebooking, refund or credit, notifications |
| Equipment | Serialized and pooled finite rental inventory, holds, participant allocation, checkout, return, damage and maintenance state |
| Dive | Certification/medical readiness, buddy/group assignment, ratios, cylinder/gas allocation, no-fly warning and acknowledgment |
| Fishing | Fishing trip configuration, guide qualifications, shared/private capacity, equipment assignment, operational notes |
| Crew | Availability, credentials, assignments, planned/actual hours, payroll export, tip allocation ledger |
| Vessel | Documents, capacity profiles, readiness checklists, defects, maintenance blocks, manager return-to-service |
| Communications | Transactional SMS and email, templates, consent evidence, opt-out, delivery callbacks, replies, reminders |
| Reporting | Daily operations, occupancy, revenue, refunds, fees, packages, equipment, crew, tips, reconciliation exceptions |
| Integrations | Hosted page, widget, public REST foundations, outgoing webhooks, CSV imports/exports, accounting export |

## Near-term after MVP

- Private-charter inquiry, proposal, acceptance, option-hold, payment-link, and change-order workspace.
- Waitlist and standby offers with priority policy and atomic acceptance.
- Deeper tank-fill, compressor, dive-log, maintenance-work-order, and incident-package workflows.
- Affiliate commission settlement and richer concierge portal.
- Read-optimized reporting projections and scheduled report delivery.
- Broader accounting adapters, migration tooling, and selected one-way OTA imports.
- Multilingual templates and customer-facing localization.
- Advanced pricing rules and operator-configured promotion experiments.

## Long-term platform

- Full two-way OTA channel management.
- Multi-region data topology and jurisdiction-specific residency.
- Flexible deposits, split payments, and installments.
- Direct crew payouts with onboarding, tax, dispute, and negative-balance controls.
- Warehouse or lakehouse analytics with change-data capture.
- Full retail stock, purchasing, and cost-of-goods workflows, only if validated as a separate bounded context.
- Additional vertical modules using extension-owned records and policies.

## Intentional non-goals

- Autonomous weather, seaworthiness, medical, or departure-safety decisions.
- Navigation, vessel control, AIS, or electronic-chart replacement.
- Generalized ERP, general ledger, tax filing, or payroll processor.
- Clinical medical record or diagnostic system.
- Regulatory certification or substitute for records that law requires elsewhere.
- Unrestricted marketplace involving multiple operators in one customer charge.

## Release gates

MVP does not launch until:

1. payment, refund, and application-fee reconciliation passes sandbox and failure tests;
2. database invariant tests demonstrate no oversell or duplicate redemption;
3. offline loss, theft, revocation, stale-data, and conflict scenarios pass;
4. tenant-isolation and sensitive-data authorization tests pass;
5. Neon connection-reset, point-in-time restore, and independent logical-backup restore drills meet provisional RTO/RPO;
6. legal reviews listed in the source register are closed or explicitly accepted.
