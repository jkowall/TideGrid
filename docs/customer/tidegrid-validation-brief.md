# A simpler direct-booking workflow for passenger-vessel operators

**TideGrid concept brief for customer validation**

**September 2026**

**Validation version:** 0.2

TideGrid is a concept under validation. This brief is not an offer, a contract, or a promise to build or deliver the product by a particular date, and it asks for no commitment from you. We are testing the concept, its features, pricing, delivery sequence, and timing with operators before deciding what to build.

## The workflow we want to understand

A trip can touch several systems before anyone leaves the dock. Booking software shows the seats or the boat. A payment processor shows the money. Waivers live elsewhere. Text threads carry arrival details and weather changes. Rental equipment often sits in a spreadsheet or in someone's head. When a guest changes plans, the operator has to work out which records, people, and amounts need attention.

We want to learn whether that reflects your operation and whether a more connected, operator-controlled workflow is valuable to you.

Guests book and manage their trip through your brand. Your staff see the booking, payment, participants, waivers, equipment, messages, and any refund or credit in one place.

## Who we are designing for

The first concept focuses on US passenger-vessel operators that:

- run one to five boats with scheduled shared-seat trips, private charters, or both;
- receive at least 80% of bookings through direct or staff-assisted channels;
- have returning customers they want to serve through their own brand; and
- currently have to reconcile booking details across several tools or manual processes.

Dive, fishing, sightseeing, and private-charter operators are all relevant to this validation. Operators whose online travel agencies supply more than 20% of bookings fall outside the first version.

## What the concept includes

### A branded direct-booking home

Each operator gets a mobile-first booking experience on its own web domain. The progressive web app, or PWA, works in a browser and can be installed on a guest's phone without an app-store download.

An optional Native add-on provides one operator-branded iOS app and one Android app. All of the operator's boats appear inside the same app. The native experience focuses on repeat use: upcoming trips, saved guest profiles, booking changes, waiver status, trip-card balances, deep links, and push notifications.

An **Important links** section in the web experience and optional native app lets you add and update resources guests need before a trip, such as where to get a fishing license. Guests also find the relevant links alongside their arrival instructions.

### One connected booking record

The proposed Booking Core supports shared-seat trips and exclusive private charters, schedules and blackouts, boat capacity, passenger categories, add-ons, taxes, mandatory fees, and simple promotion codes. It also supports direct, phone, walk-up, imported, complimentary, and externally paid bookings.

Guests pay in full for shared-seat trips. A private charter uses full payment or one deposit with one later balance deadline. Guests use a secure link to view a receipt, pay a balance, invite participants, update details, cancel, or reschedule when the operator's policy permits. Staff have a web console for the calendar, roster, customer history, booking changes, payments, refunds, credits, and basic reconciliation reports.

### The surrounding work that makes a booking complete

- **Waivers:** TideGrid uses operator-supplied, versioned waiver templates with participant and guardian signing, consent evidence, and a signed PDF tied to the booking.
- **Transactional messages:** TideGrid sends branded email and SMS for confirmations, waiver and balance reminders, arrival instructions, disruptions, refunds, and tip requests. SMS uses a registered sender for each operator, supports replies and opt-outs, and falls back to email when delivery fails.
- **Equipment:** Staff track pooled rental inventory by type, size, location, quantity, price, and turnaround buffer, with participant allocation and inventory blocks.
- **Weather support:** TideGrid displays current NOAA or National Weather Service evidence with its source and freshness. An authorized person, not the software, decides whether to watch, close sales, delay, or cancel a trip and whether affected guests receive a refund or service credit.
- **Tips:** Guests can leave an optional tip during checkout or after the trip. TideGrid reports tips apart from sales and excludes them from its platform-fee calculation.
- **Trip cards:** TideGrid tracks prepaid trip cards for a named customer. A trip-count card holds a number of trips; a dollar card holds a dollar balance. Each card shows its balance and keeps an auditable purchase and redemption history. A card belongs to one named customer and cannot be transferred or cashed out. TideGrid does not award loyalty points.

Bookings, payments, waivers, and transactional email are part of the core from the first live booking. SMS, equipment, weather support, tips, and trip cards are staged Core modules within the same Booking Core offer. Each becomes available to an operator after it passes its own acceptance.

## The operator stays in control

The operator remains the seller and merchant of record. Online payments are direct charges in the operator's Stripe account. TideGrid provides the booking and payment-management interface but does not hold operator funds, set card-processing prices, or take a processing spread.

The operator approves its prices, taxes, booking policies, waiver language, customer remedies, and every weather-related trip action. It also owns its Apple and Google organization accounts and remains the publisher of its native apps. TideGrid prepares the shared product, configured branding, builds, and submission materials without creating a separate source-code fork for each customer.

## Deliberate first-version boundaries

The first version does not include:

- live availability, price, booking, cancellation, or message synchronization with Viator, GetYourGuide, Expedia, or other online travel agencies;
- marketing campaigns, WhatsApp, social messaging, or review automation;
- check-in, boarding, regulatory manifests, trip logs, crew scheduling, payroll, tip allocation, vessel maintenance, or other full vessel and crew operations;
- automated weather or safety decisions;
- points, tiers, memberships, gift cards, or transferable stored value; or
- serialized equipment custody, cleaning, damage, return, or maintenance records.

Minority OTA bookings can be entered or imported so they consume capacity and appear on the roster, but changes and payments stay in the source system.

## Pricing discussion draft

These prices are proposed and unvalidated by paid use, and this table is neither a quote nor an offer.

| Proposed option | Setup | Recurring | Proposed commitment |
|---|---:|---:|---|
| Booking Core, self-setup | $0 | $149/month + 1.5% of net managed booking value | 12 months and $3,000 annual minimum |
| Managed Launch | $1,000 | None | Optional, standard scope only |
| Native add-on | $4,500 | $399/month + 0.25% of net managed booking value | 12 months; Booking Core required |
| Pilot Native offer | $2,250 | Full Booking Core and Native recurring price | First three qualified pilot operators only; Managed Launch free |

Booking Core includes two active boats; each additional active boat costs $75 per month. With two boats, Booking Core plus Native is $548 per month plus 1.75% of net managed booking value, subject to the Core annual minimum.

The proposed Native pilot is aimed at a direct-first operator averaging at least $25,000 per month in trailing net managed booking value with a demonstrated repeat-customer or customer-service use case for an app. The first pilot covers one legal operator, one brand, one location, and one iOS and Android pair. Until TideGrid measures delivery and support costs, standard Native sales target operators closer to $50,000 or more per month. Operators with five or more active boats, above $100,000 per month, or with several locations or brands need a custom quote.

Net managed booking value includes completed trip and charter value, mandatory fees, eligible paid add-ons and equipment, retained cancellation amounts, and trip-count card sales managed in TideGrid. A trip-count card counts once, when it is sold, and not again when a trip is redeemed. A dollar card is not counted when it is bought; the booking it later pays for counts at the normal point. Taxes, tips, complimentary value, promotional credit, and refunded or charged-back value are excluded. Direct bookings managed in TideGrid count even when the operator records an external payment. OTA reservations kept as capacity and roster records during the pilot do not count.

Stripe processing, app-store memberships, domains, Twilio registration and phone numbers, carrier fees, and message usage pass through at cost. Complex migration, or reconciliation of existing prepaid trip-card balances, starts at $2,500. Other agreed work outside standard configuration uses a fixed statement of work or a $175 hourly rate.

## Help us test the concept

We want candid feedback. A 45-minute validation conversation and concept review covers:

- how a booking moves through your operation today;
- where payment, waiver, participant, equipment, and message handoffs break down;
- how often guests return and whether a branded web or native experience would matter to them;
- which proposed capabilities are essential, unnecessary, or missing;
- whether the operating boundaries fit your channel mix; and
- whether the proposed pricing reflects enough value to justify switching.
