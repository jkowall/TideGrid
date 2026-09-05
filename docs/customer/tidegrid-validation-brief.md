# A simpler direct-booking workflow for passenger-vessel operators

**TideGrid concept brief for customer validation**

**September 2026**

**Validation version:** 0.1

## The workflow we want to understand

A trip can touch several systems before anyone leaves the dock. Booking software may show the seats or boat. A payment processor shows the money. Waivers live elsewhere. Text threads carry arrival details and weather changes. Rental equipment may be tracked in a spreadsheet or by staff. When a guest changes plans, the operator has to work out which records, people, and amounts need attention.

We want to learn whether that reflects your operation and whether a more connected, operator-controlled workflow would be valuable.

Guests would book and manage their trip through your brand. Your staff would see the booking, payment, participants, waivers, equipment, messages, and any refund or credit in one place.

## Who we are designing for

The first concept focuses on US passenger-vessel operators that:

- run one to five boats with scheduled shared-seat trips, private charters, or both;
- receive at least 80% of bookings through direct or staff-assisted channels;
- have returning customers they want to serve through their own brand; and
- currently have to reconcile booking details across several tools or manual processes.

Dive, fishing, sightseeing, and private-charter operators are all relevant to this validation. Operators whose online travel agencies supply more than 20% of bookings fall outside the first version.

## What we are considering

### A branded direct-booking home

Each operator would receive a mobile-first booking experience on its own web domain. The progressive web app, or PWA, would work in a browser and could be installed on a guest's phone without an app-store download.

An optional Native add-on would provide one operator-branded iOS app and one Android app. All of the operator's boats would appear inside the same app. The native experience would focus on repeat use: upcoming trips, saved guest profiles, booking changes, waiver status, package balances, deep links, and push notifications.

An **Important links** section in the web experience and optional native app would let you add and update resources guests need before a trip, such as where to get a fishing license. Guests could also find the relevant links alongside their arrival instructions.

### One connected booking record

The proposed Booking Core would support shared-seat trips and exclusive private charters, schedules and blackouts, boat capacity, passenger categories, add-ons, taxes, mandatory fees, and simple promotion codes. It would also support direct, phone, walk-up, imported, complimentary, and externally paid bookings.

Guests could pay in full for shared-seat trips. A private charter could use full payment or one deposit with one later balance deadline. Guests could use a secure link to view a receipt, pay a balance, invite participants, update details, cancel, or reschedule when the operator's policy permits. Staff would have a web console for the calendar, roster, customer history, booking changes, payments, refunds, credits, and basic reconciliation reports.

### The surrounding work that makes a booking complete

- **Waivers:** TideGrid would use operator-supplied, versioned waiver templates with participant and guardian signing, consent evidence, and a signed PDF tied to the booking.
- **Transactional messages:** TideGrid would send branded email and SMS for confirmations, waiver and balance reminders, arrival instructions, disruptions, refunds, and tip requests. SMS would use a registered sender for each operator, support replies and opt-outs, and fall back to email when delivery fails.
- **Equipment:** Staff would track pooled rental inventory by type, size, location, quantity, price, and turnaround buffer, with participant allocation and inventory blocks.
- **Weather support:** TideGrid would display current NOAA or National Weather Service evidence with its source and freshness. An authorized person, not the software, would decide whether to watch, close sales, delay, or cancel a trip and whether affected guests receive a refund or service credit.
- **Tips:** Guests could leave an optional tip during checkout or after the trip. TideGrid would report tips apart from sales and exclude them from its platform-fee calculation.
- **Trip packages:** TideGrid would track prepaid trip units for a named customer, with a visible balance and an auditable purchase and redemption history. It would not award loyalty points.

## The operator stays in control

The operator would remain the seller and merchant of record. Online payments would be direct charges in the operator's Stripe account. TideGrid would provide the booking and payment-management interface but would not hold operator funds, set card-processing prices, or take a processing spread.

The operator would approve its prices, taxes, booking policies, waiver language, customer remedies, and every weather-related trip action. It would also own its Apple and Google organization accounts and remain the publisher of its native apps. TideGrid would prepare the shared product, configured branding, builds, and submission materials without creating a separate source-code fork for each customer.

## Deliberate first-version boundaries

The first version would not include:

- live availability, price, booking, cancellation, or message synchronization with Viator, GetYourGuide, Expedia, or other online travel agencies;
- marketing campaigns, WhatsApp, social messaging, or review automation;
- check-in, boarding, regulatory manifests, trip logs, crew scheduling, payroll, tip allocation, vessel maintenance, or other full vessel and crew operations;
- automated weather or safety decisions;
- points, tiers, memberships, gift cards, or transferable stored value; or
- serialized equipment custody, cleaning, damage, return, or maintenance records.

Minority OTA bookings could be entered or imported so they consume capacity and appear on the roster, but changes and payments would remain in the source system.

## Pricing discussion draft

We are testing these proposed prices. Paid use has not validated them, and this table is neither a quote nor an offer.

| Proposed option | Setup | Recurring | Proposed commitment |
|---|---:|---:|---|
| Booking Core, self-setup | $0 | $149/month + 1.5% of net managed booking value | 12 months and $3,000 annual minimum |
| Managed Launch | $1,000 | None | Optional, standard scope only |
| Native add-on | $4,500 | $399/month + 0.25% of net managed booking value | 12 months; Booking Core required |
| Pilot Native offer | $2,250 | Full Booking Core and Native recurring price | First three qualified pilot operators only; Managed Launch free |

Booking Core includes two active boats; each additional active boat would cost $75 per month. With two boats, Booking Core plus Native would be $548 per month plus 1.75% of net managed booking value, subject to the Core annual minimum.

The proposed Native pilot is intended for a direct-first operator averaging at least $25,000 per month in trailing net managed booking value with a demonstrated repeat-customer or customer-service use case for an app. The first pilot would cover one legal operator, one brand, one location, and one iOS and Android pair. Until TideGrid measures delivery and support costs, standard Native sales would target operators closer to $50,000 or more per month. Operators with five or more active boats, above $100,000 per month, or with several locations or brands would need a custom quote.

Net managed booking value would include completed trip and charter value, mandatory fees, eligible paid add-ons and equipment, retained cancellation amounts, and trip-package sales managed in TideGrid. Taxes, tips, complimentary value, promotional credit, refunded or charged-back value, and later package-unit redemption would be excluded. Direct bookings managed in TideGrid would count even when the operator records an external payment. OTA reservations kept as capacity and roster records during the pilot would not count.

Stripe processing, app-store memberships, domains, Twilio registration and phone numbers, carrier fees, and message usage would pass through at cost. Complex migration or stored-package reconciliation would start at $2,500. Other agreed work outside standard configuration would use a fixed statement of work or a $175 hourly rate.

## Help us test the concept

We want candid feedback. A 45-minute validation conversation and concept review would cover:

- how a booking moves through your operation today;
- where payment, waiver, participant, equipment, and message handoffs break down;
- how often guests return and whether a branded web or native experience would matter;
- which proposed capabilities are essential, unnecessary, or missing;
- whether the operating boundaries fit your channel mix; and
- whether the proposed pricing reflects enough value to justify switching.

You do not need to make a commitment. TideGrid is validating the concept, features, pricing, delivery sequence, and timing. This document creates no offer, contract, or promise to build or deliver the product by a particular date.
