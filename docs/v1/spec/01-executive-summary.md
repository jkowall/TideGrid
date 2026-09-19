# 1. Executive summary

## Product

TideGrid is the departure operations platform for passenger-vessel operators. It connects availability, checkout, participants, waivers, crew, vessels, finite equipment, check-in, trip execution, closeout, and financial reconciliation around one durable departure record.

The product serves dive, fishing, sightseeing, snorkel, sunset-cruise, excursion, and private-charter operators. It supports one-boat businesses and multi-brand, multi-location fleets without forcing vertical-specific fields into the shared booking core.

## Problem

Generic tour engines optimize conversion and distribution. Operators still coordinate the actual departure across booking records, spreadsheets, messages, paper manifests, crew calendars, equipment lists, payment reports, and weather decisions. That fragmentation creates:

- resource conflicts and capacity oversell;
- missing paperwork or qualifications at check-in;
- manual disruption and rebooking work;
- incomplete offline records offshore;
- inconsistent refund, credit, package, and tip handling;
- weak traceability from sale through trip closeout.

## Product thesis

A departure is the operational unit. It has a time window, product, vessel, capacity profile, resource requirements, crew, participants, documents, equipment, payments, readiness state, actual execution, and immutable closeout evidence. TideGrid becomes the system of record by keeping those facts connected.

## Commercial model

- Tiered monthly subscription: Dock at $149, Growth at $399, Fleet at $999, and contracted Enterprise pricing.
- Plan-specific platform fee: 3.00% for Dock, 2.00% for Growth, 1.25% for Fleet, and 0.75% to 1.00% for Enterprise.
- Unlimited customers, bookings, users, products, and departures. Boats and locations are explicit plan entitlements.
- Stripe Connect direct charges for customer payments, with each operator as merchant of record.
- Stripe Billing for the SaaS subscription, isolated from booking orders and connected-account payment flows.
- Payment-processing charges remain separate. Guided onboarding, annual discounts, seasonal read-only mode, and excess active-boat pricing follow the [pricing strategy](pricing-strategy.md).

### Canonical fee treatment

| Transaction | Platform fee | Rule |
|---|---:|---|
| Standard booking | Yes | Eligible non-tax, non-tip amount processed by TideGrid |
| Private charter | Yes | Eligible non-tax, non-tip amount processed by TideGrid |
| Package purchase | Yes | Fee applies on purchase, not redemption |
| Package redemption | No | Prevents double charging |
| Gift-card purchase | Yes | Fee applies on purchase, not redeemed value |
| Gift-card redemption | No | Fee only on incremental new money |
| POS purchase | Yes | Eligible non-tax, non-tip sale lines |
| Tips | No | Excluded from fee base |
| Taxes | No | Excluded from fee base |
| Refund | Reversal | Reverse the fee proportionally to refunded eligible value |
| Cash or external payment | No | Record only, no TideGrid-processed value |
| OTA import | No | Imported value excluded; incremental TideGrid charge is eligible |

## Architecture

The initial system is a TypeScript modular monolith deployed on Cloudflare Workers. Bounded contexts own their tables and expose application interfaces. PostgreSQL 17 on Neon Scale in Azure East US 2 is the authoritative transactional store. A cache-disabled Hyperdrive binding and Azure placement connect Workers to Neon, while Cloudflare Queues, Workflows, R2, WAF, API Shield, Turnstile, and observability provide supporting platform capabilities.

The captain client is cross-platform React Native with an encrypted SQLCipher database and deterministic command synchronization. It is not a PWA. Financial, capacity, identity, stored-value, and allocation truth remains server-authoritative.

## MVP outcome

An operator can configure a trip, publish availability, take payment, collect participant requirements, assign the required vessel and crew, prevent conflicting resource or equipment use, check passengers in, operate from an offline manifest, record departure and return, handle a disruption, and reconcile the trip and platform fee without losing auditability.

## Success measures

| Outcome | Initial measure |
|---|---|
| Reliable sales | At least 99.9% successful inventory finalization for valid paid checkouts, excluding provider declines |
| No oversell | Zero confirmed capacity, package, equipment, vessel, or captain invariant violations |
| Dock readiness | Median check-in under 20 seconds for a paperwork-complete participant |
| Offline trust | At least 99% of valid offline commands synchronize without manual intervention |
| Fast recovery | 95% of disruption communications queued within 60 seconds of approval |
| Reconciliation | 100% of Stripe charges, refunds, application fees, and disputes matched or placed in an exception queue |
| Auditability | Every override, sensitive-data access, financial mutation, and lifecycle transition attributable to an actor or system principal |

These are product targets. Final production SLOs require load testing and provider baselines.
