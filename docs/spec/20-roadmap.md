# 20. Phased implementation roadmap

The roadmap delivers vertical operational slices while preserving the shared maritime core. Dates depend on team size and provider/legal lead times, so gates are evidence based rather than calendar promises.

## Phase 0: Foundation and validation

**Outcome:** The architecture, product assumptions, and critical integrations are proven before broad feature work.

- Naming/trademark decision, commercial packaging, design partner selection, and legal/privacy review.
- Terraform account foundations for Cloudflare and Azure Key Vault, pinned Neon provisioning, environments, CI/CD, secrets, observability, and incident process.
- TypeScript monorepo, Hono modular-monolith boundaries, OpenAPI generation, React/Vite shells, and React Native native shell.
- PostgreSQL migrations, tenant context wrapper, RLS/FK test harness, outbox/inbox, audit, idempotency, R2 adapter.
- Stripe Connect direct-charge and Terminal spikes, Twilio signed callback, NOAA adapter, SQLCipher/background-sync spike.
- Synthetic booking and provider sandbox path.

**Exit:** Clean PostgreSQL 17 migration on Neon, two-tenant isolation proof, Hyperdrive direct-endpoint and cache-disabled read proof, Neon connection-reset and dual-source restore drills, provider spikes, mobile offline proof on physical devices, threat model, primary SLO dashboards, and resolved launch-blocking open questions.

## Phase 1: Sell and confirm the shared maritime core

**Outcome:** A generic excursion/private-charter operator can publish, sell, and confirm inventory safely.

- Tenant/location/legal entity, catalog, schedules, pricing/policies.
- Multidimensional availability, atomic holds, widget search/checkout.
- Customer/participant profiles, bookings/orders, Stripe online payment, receipts.
- Fee ledger and refund foundations, transactional outbox/inbox, messaging journeys.
- Operator calendar, booking detail, manual cash/external/OTA record with correct fee exclusion.
- Basic waitlist and operator exception queues.

**Exit:** Final-seat/resource races pass, fee examples reconcile with Stripe, checkout meets SLO under target load, and a design partner completes sandbox end to end.

## Phase 2: Departure and safety operations

**Outcome:** Staff can prepare, board, operate, and close a departure with durable evidence.

- Vessel/resources/maintenance, crew roles/qualifications/credentials.
- Waiver versions/signature evidence, participant readiness, certification and medical review status.
- Manifest/check-in/boarding/no-show/disembark, checklists, immutable snapshots, incidents.
- React Native captain app, assigned snapshot/delta sync, command merge/conflict queue, device revocation/purge.
- NOAA evidence display and human-approved delay/cancel/abort disruption workflows.

**Exit:** Offline scenario matrix passes, vessel/captain overlap is impossible, stale-manifest controls are accepted by pilots, and restore plus evidence-hash drills pass.

## Phase 3: Dive, fishing, equipment, stored value, and private charter

**Outcome:** The MVP supports the vertical workflows that differentiate TideGrid.

- Dive certification/medical/waiver requirements and equipment sizing/allocation.
- Fishing configuration, captain/mate/guide roles, charter-specific policy.
- Pooled and serialized equipment holds, checkout, return, cleaning, maintenance, damage/loss.
- Packages, gift cards, credits, secure lookup/redemption, cancellation reinstatement.
- Charter inquiry, versioned proposal, option hold, deposit, conversion.
- Stripe Terminal/card-present and tip allocation records.

**Exit:** Last-unit and partial-cancellation races pass, stored-value projection rebuild is exact, Terminal reconciliation works per connected account, and design partners run live shadow operations.

## Phase 4: Pilot hardening and US GA

**Outcome:** TideGrid is supportable, secure, auditable, and commercially ready.

- Payout/dispute/refund/fee reconciliation, support JIT controls, data export/deletion/legal hold.
- Operational dashboards, alert tuning, DLQ/replay, provider/runbook automation, backup/restore drills.
- Accessibility, performance, cross-browser/device, localization/time-zone hardening.
- Penetration test, PCI scope confirmation, privacy/messaging terms, incident tabletop.
- Controlled migration/import tooling, operator onboarding, training, support, status communication.

**Exit:** Error-budget readiness, no unresolved critical security findings, RTO/RPO drill pass, pilot acceptance, support capacity, and executive GA approval.

## Phase 5: Post-MVP expansion

Prioritize using measured customer value and operational risk:

- advanced OTA bidirectional synchronization and channel inventory;
- flexible payment plans and richer deposit schedules;
- payroll exports, tax reporting integrations, then direct payouts only after legal/compliance work;
- advanced marketing segmentation and lifecycle automation;
- full retail inventory/POS;
- read replica and analytical warehouse;
- additional countries, currencies, languages, tax regimes, residency controls;
- second payment/messaging/weather providers when outage or market evidence justifies cost.

Automated safety/cancellation decisions, generalized ERP, tax filing, and acting as employer remain non-goals unless separately approved.

## Cross-phase gates

Every phase requires updated traceability, ADRs, threat model, data inventory, migrations, API/events, load model, accessibility, SLOs, runbooks, recovery tests, and residual-risk acceptance. A feature flag is not a substitute for an incomplete invariant.
