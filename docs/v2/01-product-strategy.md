# TideGrid V2 product strategy

**Status:** Canonical strategy for discovery and paid pilot validation
**Date:** September 4, 2026

## Product direction

TideGrid will sell a productized branded booking service to passenger-vessel operators. Guests book, pay, manage participants, sign waivers, reserve rental equipment, receive trip updates, tip, and use trip packages through the operator's brand.

The operator works from a shared TideGrid web console. TideGrid maintains one product and configures branding, boats, products, policies, and enabled modules for each operator. Customer-specific source forks are outside the business model.

TideGrid remains exploratory. Paid validation determines whether the company should fund the build.

Before the next operator outreach, approve the validation materials and form a bare-bones single-member Florida LLC after resolving the private filing inputs. Formation is administrative preparation and does not validate demand or authorize contracts, deposits, production accounts, live customer data, or a production build. After the 12-interview and direct-first-profile gate passes, three written conditional pilot-operator commitments across at least two operator types and an approved, funded build budget trigger the separate paid-pilot readiness work. The [pre-customer plan](11-pre-customer-formation-and-validation.md) and [company formation plan](07-company-formation-and-costs.md) define the sequence and cost boundaries.

## First customer segment

Start with direct-first US operators that:

- run one to five boats;
- sell scheduled shared-seat trips or private charters;
- receive at least 80% of bookings through direct channels;
- maintain a returning-customer base;
- reconcile booking, payment, waiver, and participant data across several tools;
- can supply approved policies, waiver language, business records, and clean migration data.

Dive charters form the first discovery segment because the current interview shows payment-independent waiver, participant, gear, and repeat-customer problems. Fishing, sightseeing, and private-charter operators remain part of the 12-interview validation set.

Operators that depend on live OTA distribution, need full dockside operations, or require custom software do not fit the pilot.

## Jobs to be done

### Operator

When I sell a trip, I want one accurate booking record across direct and staff-assisted channels so I can manage capacity, money, participants, waivers, rental equipment, and customer changes without reconciling several systems.

When weather or another operator decision changes a trip, I want to identify affected bookings, apply one refund or credit remedy, and contact each customer without creating conflicting records.

When a customer returns, I want my brand and customer history to drive the next booking rather than sending that customer into a marketplace.

### Guest

When I book a boat trip, I want to complete payment, participant details, waivers, rentals, and later changes from one operator-branded experience.

When plans change, I want one reliable source for the trip status, balance, refund or credit, and messages from the operator.

## Value proposition

TideGrid gives the operator a direct branded channel and connects the commercial records that most affect a booking. The product reduces duplicate entry and makes incomplete payment, waiver, participant, equipment, and customer-notification work visible.

The native add-on serves operators that can earn repeat use. Saved profiles, upcoming trips, waiver status, package balances, booking management, and push notifications give the app utility beyond a wrapped website.

TideGrid competes through maritime-specific workflow fit and hands-on launch service. It does not compete on the lowest booking fee or an OTA distribution network.

## Business model

Booking Core combines a fixed subscription with a percentage of net managed booking value. The native add-on uses a larger fixed fee because store operations and customer-specific support do not scale with booking value.

Setup work and software access stay separate:

- self-setup Booking Core has no setup fee;
- operators can purchase Managed Launch for configuration, import, training, and cutover;
- native customers pay a setup fee for the iOS and Android launch;
- provider and store costs pass through at cost;
- custom migration and integration work requires a separate statement of work.

The [commercial model](03-commercial-model.md) defines prices, calculations, and margin gates.

## Ownership and operating model

TideGrid has one human founder and no cofounders or equity partners. The plan is to form a single-member, member-managed Florida LLC owned 100% by that founder before customer-validation outreach. The first three pilot operators are paying customers. They receive no membership interest, governance right, profit share, intellectual-property right, exclusivity, or authority to act for TideGrid.

The owner performs product management, sales, delivery, support, and company operations during the pilot. Attorneys, accountants, brokers, registered agents, security reviewers, and other contractors are scoped vendors rather than owners. Codex agents are implementation tools, not company personnel, legal reviewers, segregation of duties, or production coverage.

The initial pilot remains capped at three operators and launches them sequentially. Only one operator may be in active configuration, acceptance, review-response, or production cutover at a time. TideGrid offers documented business-hours support during the pilot, not continuous human coverage or a 24-hour service commitment.

Before accepting a fourth customer, the owner must approve a monthly TideGrid time budget and reconcile it to measured support, release, finance, incident, and platform work. The current sensitivity assumes as much as three support hours per Core-plus-Native operator each month. At that rate, 85 operators require 255 support hours per month before shared operations or new launches, so the $1 million recurring-revenue scenario is not a permanently solo business under the current assumptions. TideGrid must automate further, pause growth, or deliberately buy non-equity operating capacity when measured work exceeds the owner's approved limit.

## Product tradeoffs

V2 owns a narrow transactional booking core because capacity, payment confirmation, equipment, and package units must reconcile. It does not recreate the V1 departure-operations platform.

The pilot excludes:

- live OTA inventory and price synchronization;
- check-in, boarding, regulatory manifests, and offline captain workflows;
- crew scheduling, payroll, tip distribution, vessel readiness, and maintenance;
- medical or certification evidence review;
- serialized equipment custody, damage, cleaning, or tank-fill operations;
- loyalty points, tiers, memberships, gift cards, or transferable value;
- marketing campaigns, WhatsApp, and autonomous weather or safety decisions;
- TideGrid control of processing prices, operator funds, or merchant-of-record duties.

## Go-to-market

Use owner-led sales and a paid pilot-customer program. The first three native customers receive a visible pilot credit on setup work while paying the full recurring price and provider costs.

Use the customer-facing [validation brief](../customer/tidegrid-validation-brief.md) only after the past-behavior section of the internal [operator validation guide](../customer/operator-validation-guide.md). The brief is a research artifact, not a released-product claim or binding offer.

The sales process uses each prospect's trailing booking value, booking-channel mix, repeat-customer rate, waiver volume, and current software costs. A paid setup invoice and signed recurring agreement count as demand evidence. Stated interest does not.

The three-customer pilot may test Native with an operator at or above $25,000 in average monthly booking value when repeat usage provides a clear learning case. Until measured service cost proves the 75% recurring-margin gate below that level, standard Native sales should target operators near $50,000 or more. Quote operators above $100,000, with five or more active boats, several locations, or several brands.

## Measures

**North Star:** completed participant bookings managed per live operator each month.

Track these supporting measures:

- net managed booking value and recurring revenue per operator;
- direct booking conversion and repeat-booking rate;
- waiver completion before the operator cutoff;
- payment, refund, equipment, and package reconciliation exceptions;
- message delivery and response rate;
- onboarding and native-launch hours;
- monthly support hours and gross margin;
- total owner operating hours, support backlog, and remaining monthly capacity;
- native install, active-use, and booking-management rates.

**Current proof target:** three paid native pilot operators across at least two operator types.

## Capabilities TideGrid must build

- A safe booking, payment, resource-hold, refund, and stored-unit transaction model.
- A configuration system that creates distinct brands without source forks.
- Repeatable migration, waiver, messaging-registration, app-store, and launch procedures.
- Customer support and exception tooling that exposes failed payments, messages, refunds, and imports.
- Release automation that updates the app fleet without customer-specific branches.
- Company, contract, insurance, provider-account, and recovery controls that can support live booking and waiver data.

## Defensibility

TideGrid has no proven network effect or durable technical moat. Its potential advantage comes from an operator-owned customer channel, connected booking records, maritime workflow fit, migration knowledge, and a repeatable launch operation.

These advantages only matter if operators switch, guests return through the branded experience, and support cost stays within the commercial gates.

## Load-bearing hypotheses

1. Three operators will pay the pilot setup fee and full recurring price before TideGrid builds the production system.
2. At least five of 12 interviewed operators receive 80% or more of bookings through direct channels.
3. Operators accept a fee on all TideGrid-managed booking value, including externally paid bookings.
4. Native apps increase repeat booking or reduce customer-service work enough to justify their price.
5. One configuration model covers at least 90% of customer requests.
6. Core support falls below one hour per operator per month and native support falls below two hours after the first 90 days.
7. Apple and Google accept distinct operator-owned applications built from the shared source line.
8. At least 95% of native variants build automatically and a shared release requires less than 15 minutes of customer-specific handling per operator.
9. The company can fund the $8,000 to $18,000 pilot-readiness authorization ceiling and the separate product build without treating pilot-customer setup payments as sufficient capital.
10. Measured customer and platform work fits the sole owner's approved monthly capacity before TideGrid accepts a fourth customer.

The [roadmap and validation plan](05-roadmap-validation.md) turns these hypotheses into tests and stop criteria.
