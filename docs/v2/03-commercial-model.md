# TideGrid V2 commercial model

**Status:** Unvalidated pilot pricing hypothesis

**Date:** September 4, 2026

**Currency:** USD

None of the prices, conversion assumptions, cost assumptions, or margin targets in this document has been validated through paid use. They are the terms TideGrid will test, not evidence of willingness to pay or a scalable business.

## Pilot offer

| Offer | Setup | Recurring | Commitment |
|---|---:|---:|---|
| Booking Core, self-setup | $0 | $149/month + 1.5% of net managed booking value | 12 months and $3,000 annual minimum |
| Managed Launch | $1,000 | None | Optional, standard scope only |
| Native add-on | $4,500 | $399/month + 0.25% of net managed booking value | 12 months; Booking Core required |
| Pilot Native offer | $2,250 | Full Booking Core and Native recurring price | First three qualified pilot operators only; Managed Launch free |

Booking Core includes two active boats. Each additional active boat costs $75 per month. The Native add-on covers one operator-branded iOS and Android app pair. Boats are inventory inside that app, not separate apps. Each additional operator brand or store-app pair carries another applicable Native setup and recurring fee and requires a custom quote.

The Pilot Native offer is a customer discount and research program. It grants no membership interest, equity, governance right, profit share, intellectual-property right, exclusivity, or authority to act for TideGrid.

There is no monthly, seasonal, or usage pause during the initial 12-month term. A seasonal operator continues to pay the fixed subscription when no trips run.

## Billing formulas

For contract month `m`:

```text
Core monthly charge before annual true-up
  = $149
  + (1.5% x monthly net managed booking value)
  + ($75 x max(active boats - 2, 0))

Native monthly charge
  = $399
  + (0.25% x monthly net managed booking value)

Core + Native recurring charge, with two active boats
  = $548
  + (1.75% x monthly net managed booking value)
```

The Booking Core minimum is calculated over each 12-month contract year:

```text
Core annual charge before boat fees
  = max(
      $3,000,
      ($149 x 12) + (1.5% x annual net managed booking value)
    )
```

The $149 monthly subscription and the 1.5% Core fee count toward the $3,000 annual minimum. Managed Launch, Native fees, extra-boat fees, taxes, pass-through costs, and custom work do not. TideGrid bills the subscription monthly, bills the variable fee in arrears, and invoices any Core minimum shortfall after month 12. The minimum stops affecting price above $80,800 in annual net managed booking value because `$1,788 + (1.5% x $80,800) = $3,000`.

Negative fee adjustments carry forward against later variable fees or the contract-end reconciliation. They do not reduce fixed subscriptions or third-party costs.

## Net managed booking value

The fee applies to all value TideGrid manages, including bookings paid outside TideGrid's card flow. Payment rail does not change the fee.

For a trip booking, TideGrid assesses net managed booking value when the trip completes. A retained cancellation or no-show amount is assessed when that booking reaches a final closed outcome. For a fixed-unit trip package, TideGrid recognizes value when the package is sold. The billing-period calculation is:

```text
eligible trip fares and private-charter value
+ mandatory operator fees
+ eligible booking-linked add-ons and equipment rentals
+ fixed-unit trip-package sales
+ retained cancellation and no-show amounts
- discounts
- refunded or charged-back eligible value
- promotional credit applied
= net managed booking value
```

The following rules apply:

- Guest checkout, staff-assisted, imported direct, cash, check, external point-of-sale, and Stripe records count when the booking is managed in TideGrid. Payment rail and import origin do not determine fee treatment.
- Deposits and balances are not charged twice. The closed booking contributes only its final retained eligible value.
- Taxes, tips, complimentary value, promotional credit, refunded value, and later package-unit redemption are excluded from the fee base.
- Payment-processing fees, TideGrid fees, and unrelated retail sales are not booking value and do not enter the fee base.
- Package redemption is excluded because TideGrid charges the package sale. A refunded package creates a reversing adjustment.
- A credit that preserves value already counted on the original booking is not charged again when redeemed.
- A future direct or staff-assisted reservation imported for TideGrid to manage is included on the same basis as a TideGrid-created booking.
- During the pilot, every imported OTA reservation is a capacity and roster shadow managed in its source system and is excluded from the fee base. Converting an OTA record into a TideGrid-managed booking is not supported. Live OTA synchronization remains outside the pilot.
- Complimentary bookings and fully refunded cancellations contribute zero. Retained cancellation and no-show amounts remain included.

The operator must record external payments and refunds against the TideGrid booking. TideGrid should reconcile final eligible booking value, recorded settlements, refunds, and the invoiced fee base. Unrecorded external payments are revenue leakage and a product-control failure, not a free payment channel.

## Revenue sensitivity

The first table assumes one operator, two active boats, the same net managed booking value in all 12 months, and no pass-through or custom charges.

| Monthly net managed booking value | Core monthly | Native monthly | Combined monthly | Combined annual recurring | Standard Native year one, including $4,500 setup | Pilot Native year one, including $2,250 setup |
|---:|---:|---:|---:|---:|---:|---:|
| $10,000 | $299.00 | $424.00 | $723.00 | $8,676 | $13,176 | $10,926 |
| $25,000 | $524.00 | $461.50 | $985.50 | $11,826 | $16,326 | $14,076 |
| $50,000 | $899.00 | $524.00 | $1,423.00 | $17,076 | $21,576 | $19,326 |
| $100,000 | $1,649.00 | $649.00 | $2,298.00 | $27,576 | $32,076 | $29,826 |

Each pilot first-year total is $2,250 below the corresponding standard total because recurring pricing is not discounted. Managed Launch adds $1,000 to the standard first-year total when purchased and is included at no charge in the Pilot Native offer. The standard first-year column assumes Native delivery remains in the $4,500 setup band. The table does not include additional boats.

For a seasonal operator with six active revenue months and six zero-revenue months, the 12-month subscriptions still apply:

| Net managed booking value per active month | Annual value | Core annual after minimum | Native annual recurring | Combined annual recurring |
|---:|---:|---:|---:|---:|
| $10,000 | $60,000 | $3,000 | $4,938 | $7,938 |
| $25,000 | $150,000 | $4,038 | $5,163 | $9,201 |
| $50,000 | $300,000 | $6,288 | $5,538 | $11,826 |
| $100,000 | $600,000 | $10,788 | $6,288 | $17,076 |

The three-customer pilot may test Native with an operator at or above $25,000 in average monthly booking value when repeat usage provides a specific learning case. Until measured customer cost proves the 75% recurring-margin gate at a lower volume, standard Native sales should target operators near $50,000 or more. Operators above $100,000 in average monthly value require a custom quote.

### Portfolio revenue milestone

The recurring-revenue scale implied by the user-supplied target is:

| Monthly net managed booking value per operator | Core + Native MRR | Annual recurring revenue per operator | Operators for about $1 million annual recurring revenue |
|---:|---:|---:|---:|
| $25,000 | $985.50, displayed as $986 | $11,826 | 84.56, or about 85 |
| $50,000 | $1,423 | $17,076 | 58.56, or about 59 |

The calculations are `$1,000,000 / $11,826 = 84.56` and `$1,000,000 / $17,076 = 58.56`. Setup, Managed Launch, extra boats, pass-through charges, and custom work are excluded. These are portfolio arithmetic milestones, not demand forecasts.

They are also not solo-owner capacity forecasts. At the current sensitivity of three monthly support hours for one Core-plus-Native operator, 59 operators require 177 support hours and 85 require 255 support hours each month, before releases, incidents, finance, shared platform work, or new launches. Before customer four, TideGrid must replace the per-customer-only view with an approved monthly owner-hours budget and measured total operating load.

## Unit-economics test

These are planning assumptions, not observed costs:

- fully loaded launch labor: $100 per hour;
- ongoing support labor: $75 per hour;
- Core service cost: $30 infrastructure plus one support hour per month, or $105;
- incremental Native service cost: $50 in tooling and release cost plus two support hours per month, or $200;
- combined Core and Native service cost: $305 per month;
- customer-acquisition cost: no more than $1,500 for the owner-led pilot;
- standard Native setup: at most 22 hours plus a $500 direct-cost ceiling, or $2,700 for sensitivity modeling;
- Managed Launch: eight hours, or $800.

Under those assumptions:

| Monthly net managed booking value | Combined monthly revenue | Monthly contribution before central overhead | Illustrative recurring gross margin | Passes 75% gate | Standard Native year-one contribution, excluding Managed Launch | Pilot Native year-one contribution |
|---:|---:|---:|---:|:---:|---:|---:|
| $10,000 | $723.00 | $418.00 | 58% | No | $5,316 | $2,266 |
| $25,000 | $985.50 | $680.50 | 69% | No | $8,466 | $5,416 |
| $50,000 | $1,423.00 | $1,118.00 | 79% | Yes | $13,716 | $10,666 |
| $100,000 | $2,298.00 | $1,993.00 | 87% | Yes | $24,216 | $21,166 |

The year-one contribution calculation deducts 12 months of customer-level service cost, $1,500 of acquisition cost, and the illustrative $2,700 Native setup cost. It assumes the standard customer completes Core self-setup without separate launch labor. The pilot calculation also deducts $800 for the included Managed Launch. It excludes shared product engineering, general company overhead, taxes, and legal costs. These figures therefore test customer-level viability, not company profitability.

At the assumed cost, the Pilot Native offer leaves `$2,700 + $800 + $1,500 - $2,250 = $2,750` to recover from recurring contribution. Payback is about 6.6 months at $10,000 monthly value, 4.0 months at $25,000, 2.5 months at $50,000, and 1.4 months at $100,000. This is why low-volume Native sales are a poor fit even when first-year contribution remains positive.

The recurring commercial acceptance gate is 75% gross margin using loaded support labor and direct provider cost. At $25,000 monthly value, the illustrative margin is only 69%, so the offer fails the gate under these assumptions. It would need combined monthly service cost at or below $246.38, or monthly net managed booking value of about $38,400 at the stated $305 service cost, to reach 75%. Actual measured cost, not this sensitivity, controls the decision.

At the same $100 loaded hourly cost, a $1,000 Managed Launch consuming the full eight-hour limit costs $800 and leaves only 20% setup gross margin. The owner-operated standard should target four or fewer TideGrid hours. A five-to-eight-hour launch is permitted inside the three-customer pilot as measured research; beyond the pilot it requires a narrower scope, a higher price, or a separate statement of work.

## Company and shared-platform cash requirement

Customer-level contribution is not startup cash flow. The current planning allowances are:

| Cost before or during the pilot | Planning amount | Treatment |
|---|---:|---|
| Bare-bones Florida formation | $125 required state filing, plus any selected agent or required local receipts | Administrative preparation before outreach; not demand evidence or live-customer readiness |
| Contract, privacy, CPA, insurance, security, and continuity readiness | $8,000 to $18,000 all-in authorization ceiling, including formation costs already incurred | Staged live-customer readiness; not setup delivery or recurring cost of service |
| Shared hosting and operating services for three pilot operators | $150 to $310 per month | Shared product cost to allocate across active customers |
| Three Pilot Native setup payments | $6,750 collected | Validation revenue; restricted by the pilot-customer subsidy and delivery obligations |

The detailed readiness plan itemizes an all-in, unquoted estimate of $6,405 to $17,100 and retains $8,000 to $18,000 as the conservative authorization ceiling. After paying the $125 state filing, the remaining itemized range is about $6,280 to $16,975 before any other formation or readiness costs already paid. Against the all-in ceiling, the three pilot-customer payments leave a pre-build cash gap of about $1,250 to $11,250 before shared product engineering or a full launch. This is a planning reserve comparison, not an invoice or proof that setup revenue funds readiness. TideGrid must identify the funding source and a total engineering budget before it completes paid-pilot readiness or accepts the pilot contracts.

The current unit-economics model assigns $80 per Core-plus-Native customer per month to infrastructure and native tooling. Across three pilot operators that is $240 per month, which falls inside the shared-pilot operating allowance but does not validate it. Track fixed platform cost, variable customer cost, operator pass-throughs, setup delivery, support labor, owner operating time, and shared engineering in separate ledgers. Pass-through reimbursement is not product revenue.

[Company formation and costs](07-company-formation-and-costs.md) defines the formation sequence and budget boundary. [Build, hosting, and operations](08-build-hosting-and-operations.md) defines the shared operating envelope. Both are planning estimates that require quotes or metered evidence before commitment.

## Standard setup boundaries

### Booking Core self-setup

The $0 setup path provides the configuration workflow, import template, documentation, and ordinary product support. An operator that completes configuration itself or supplies a clean standard import pays no setup fee. TideGrid does not clean data, configure the account, train the team, or run cutover under self-setup. If self-setup repeatedly requires more than four TideGrid labor hours, the workflow has failed its scalability test and must be simplified or moved to Managed Launch.

### Managed Launch

Managed Launch covers up to eight TideGrid labor hours for one operator, one brand, and one location. It includes catalog and policy configuration, waiver setup, one standard CSV import, one staff training session, and cutover assistance. Data repair, repeated imports, custom reports, on-site work, and provider remediation are separate work.

Work expected to exceed eight hours requires a written custom quote before it starts. Reprice or narrow Managed Launch before customer four if the median pilot launch exceeds four hours. The eight-hour figure is a pilot ceiling, not the sustainable owner-operated target.

### Native setup

The standard $4,500 setup covers one operator brand, one iOS app, one Android app, standard TideGrid configuration, one store listing per platform, release preparation, and one standard review-response cycle per store. That response cycle is one corrected resubmission or one evidence-based appeal, selected from the rejection cause. A further resubmission or appeal is custom work. The customer supplies approved brand assets, copy, policies, support details, and access to customer-owned developer accounts on schedule.

The operator must meet the legal-entity, business-website, D-U-N-S, verified organization-account, account-ownership, and content-approval prerequisites in [Native app factory and store submission](09-native-app-factory-and-store-submission.md) before its non-refundable setup payment counts toward the production-build gate. Customer-controlled account verification and store review do not count as TideGrid delivery hours, but TideGrid assistance, remediation, and appeal preparation do. The operator performs the final Apple App Review submission; TideGrid may submit Google only after recorded operator approval.

Native setup must target at least 40% gross margin using loaded customer-specific labor and direct cost. Price each delivery band from measured or credibly estimated customer-specific work:

| Median customer-specific Native delivery | Direct-cost condition | Setup price | Commercial action |
|---:|---:|---:|---|
| Up to 22 hours | Below $500 | $4,500 | Keep the standard price |
| 23 to 40 hours | Included in margin calculation | $7,500 | Raise the setup price |
| Above 40 hours | Included in margin calculation | At least $10,000 | Quote only if setup gross margin remains at least 40%; otherwise discontinue Native for that segment |

At the illustrative $100 loaded hourly cost and a $500 direct-cost ceiling, 22 hours costs $2,700 and produces 40% setup gross margin at $4,500. Forty hours costs $4,500 and produces 40% at $7,500. Direct cost must remain below $500 to keep the $4,500 price. Reprice before customer four using the pilot cohort's median delivery time. Any customer expected to cross a band requires the higher price or a signed change order before work starts.

App-store approval and timing are controlled by the stores. Setup purchases a defined launch service, not guaranteed approval by a particular date.

The $4,500 and 22-hour band remain provisional until TideGrid completes one public-store launch and reproduces the factory for a second operator without source changes. Until then, the price is a paid validation hypothesis, not demonstrated delivery economics.

## Pilot Native offer controls

The pilot discount is a deliberately capped validation expense:

```text
Native setup credit per pilot operator = $4,500 - $2,250 = $2,250
Managed Launch credit per pilot operator = $1,000
Maximum list-price credit per pilot operator = $3,250
Maximum list-price credit across three pilot operators = $9,750
Maximum total customer-specific pilot subsidy stop = $25,000
```

The $9,750 figure is only the contractual list-price credit. The $25,000 figure is an absolute stop, not an authorized spending budget. Track list-price credits, waived customer-specific work, unreimbursed customer-specific provider cost, migration or reconciliation overruns, release remediation, and launch support in one pilot-customer subsidy ledger. Do not double count labor already represented by a fixed-price credit. Shared product development that benefits the common product is tracked separately. Each operator remains limited to the defined Native and Managed Launch hours and the $500 Native direct-cost ceiling. Do not incur or promise customer-specific work that would cross any of these limits. Continuing under different limits requires an explicit revision of this commercial model and the decision register before TideGrid accepts the obligation.

To receive it, each pilot operator must:

- fit the pilot segment and standard product scope;
- sign 12-month Booking Core and Native agreements;
- pay the $2,250 Native setup invoice before the production-build gate;
- pay the full recurring, extra-boat, pass-through, and custom-work charges;
- use one legal operator, one brand, one operating location, and one app pair;
- supply approved branding, waiver language, legal URLs, business records, clean data, provider accounts, and approvals on the agreed schedule;
- participate in weekly design reviews during delivery and complete agreed acceptance testing on schedule; and
- accept shared product configuration with no source fork or exclusive feature commitment.

The offer ends after three paid, qualified pilot operators. It cannot be stacked, transferred, converted to cash, extended to another brand, or used to fund custom work. It creates no ownership, partnership, governance, profit-sharing, or agency relationship. Public reference or case-study rights require separate consent.

## Pass-through costs and custom work

The following costs pass through at cost and do not count toward any minimum:

- Stripe processing and connected-account charges paid by the operator;
- Apple and Google developer-program memberships;
- domain registration or a dedicated domain service;
- Twilio registration, campaigns, dedicated numbers, carrier fees, and message usage;
- taxes and other provider charges attributable to one operator; and
- dedicated infrastructure, security, or delivery services requested by the operator.

Routine shared hosting is included in the subscription. Provider price changes pass through prospectively. TideGrid must show the source charge and billing period and may not hide margin in a pass-through line.

Complex migration or stored-package reconciliation starts at $2,500. Other work outside published configuration requires a fixed-price statement of work or is billed at $175 per hour under a written scope and budget. This includes custom data cleanup, integrations, design, workflows, reports, legal-policy preparation, on-site work, and extra store cycles. No custom work is included in recurring fees or the pilot credit.

A custom quote is also required for any operator with:

- more than $100,000 in average monthly net managed booking value, measured over the trailing 12 months or a contracted forecast when history is unavailable;
- five or more active boats;
- more than one operating location, legal operator, brand, or native app pair;
- non-US entities, currencies, taxes, or payment methods;
- enterprise security, procurement, support, or service-level terms; or
- requirements outside the published V2 product scope.

A custom quote is not a commitment to accept bespoke work. Requests that require a customer-specific source fork, a separate app for each boat, live OTA synchronization, or TideGrid control of merchant funds should be declined during the pilot.

## Payment economics

The operator remains merchant of record. Stripe Connect direct charges place the guest charge on the connected operator account. TideGrid calculates proportional reversals in its own managed-booking fee ledger when eligible value is refunded. See [Stripe Connect direct charges](https://docs.stripe.com/connect/direct-charges).

For the pilot, Stripe sets and collects processing fees from the operator. TideGrid does not set processing prices, hold operator funds, or earn a hidden processing spread. Before TideGrid signs a pilot contract, Stripe must confirm a SaaS connected-account configuration with `defaults.responsibilities.fees_collector = stripe` and `defaults.responsibilities.losses_collector = stripe`, or a written Managed Risk equivalent. The operator remains responsible to its guests for refunds and disputes, while Stripe, rather than TideGrid, assumes unrecoverable connected-account negative-balance loss under that configuration. These responsibility values can constrain account behavior and may not be changeable later, so the test account and contract language must match before onboarding. If Stripe will not approve that structure, this price is invalid and the offer must be repriced before launch. See [connected-account configuration](https://docs.stripe.com/connect/accounts-v2/connected-account-configuration) and [Stripe Managed Risk](https://docs.stripe.com/connect/risk-management/managed-risk).

TideGrid bills its subscription and net-managed-value fee separately so Stripe, cash, check, and external point-of-sale bookings use the same fee rule. Stripe documents separate SaaS subscription billing for connected platforms in [Billing and Connect](https://docs.stripe.com/connect/integrate-billing-connect).

This choice preserves lower backend and financial risk, but it does not eliminate payment engineering. TideGrid still needs idempotent booking-payment state, verified webhooks, refunds, dispute visibility, reconciliation, access control, and auditable fee adjustments. Production requires payments counsel and Stripe review, as recorded in the [primary-source register](../../research/source-register.md).

## Competitive context

Vendor-published pricing shows that both subscription-plus-usage and high transaction-fee models exist:

- [Bókun](https://www.bokun.io/pricing) publishes plans at $49 plus 1.5%, $149 plus 1.25%, and $499 plus 1.0%.
- [Xola](https://www.xola.com/join/) advertises a $199 implementation fee, no recurring subscription fee, and a 6% online booking fee.
- [FareHarbor](https://fareharbor.com/aloha/boat-tours/) advertises no monthly fee, with up to 6% on direct bookings and 2% on API bookings, plus payment processing.

These vendor claims are pricing anchors, not TideGrid demand evidence. TideGrid's Core price is not defensible through price alone. Operators must pay for the connected booking record, their branded channel, migration help, and reduced reconciliation work.

## Validation gates

### Before full production build

- Complete 12 problem and pricing interviews across at least two operator types.
- Confirm that at least five interviewees fit the direct-first profile and that three qualified pilot operators across at least two operator types provide written conditional commitments.
- Verify trailing booking value, direct-channel mix, seasonality, current software cost, and external-payment share for each serious prospect.
- Complete the paid-pilot-readiness gate with a funded bottom-up build and delivery budget, contingency, runway limit, and contract refund or long-stop treatment. The bare-bones LLC already exists but does not satisfy this gate.
- Verify each pilot operator's legal entity, D-U-N-S record, public website, domain email, authorized representative, and Apple and Google organization accounts.
- Obtain Stripe confirmation of Stripe-set processing fees and Stripe negative-balance loss responsibility for the exact pilot connected-account configuration.
- Obtain three signed 12-month Booking Core and Native agreements at the Pilot Native terms.
- Collect all three $2,250 setup payments. Interest, letters of intent, refundable placeholders, and negotiated recurring discounts do not pass the gate.
- Accept no feature promise that breaks the shared configuration model or the V2 scope.

### During the pilot cohort

- Keep self-setup assistance below four hours and target Managed Launch at or below four hours, with eight hours as the pilot ceiling.
- Keep the $4,500 Native setup price only when median customer-specific delivery is at or below 22 hours and direct cost is below $500. Charge $7,500 for 23 to 40 hours. Quote at least $10,000 or discontinue above 40 hours. Every band must target at least 40% setup gross margin.
- Reduce ongoing support below one Core hour and two incremental Native hours per operator per month after day 90.
- Reconcile at least 98% of eligible booking value to the invoiced fee base. Investigate any unexplained external-payment gap above 2% before the next invoice.
- Achieve at least 75% recurring gross margin using loaded labor and direct provider costs. The illustrative $25,000 case reaches only 69% and fails this gate.
- Keep fully loaded acquisition cost at or below $1,500 and pilot-cohort payback below nine months.
- Deliver at least 90% of customer requirements through shared configuration with no customer source forks.
- Keep total customer-specific pilot subsidy across all three operators below the $25,000 stop and within the per-operator delivery limits.
- Launch pilot operators sequentially and accept no fourth customer until the sole owner approves a monthly capacity budget covering support, releases, reconciliation, finance, incidents, and platform operations.

### Before standard sales

- Have at least two of the next five qualified Native prospects accept the applicable full setup price, full recurring price, and provider pass-throughs without an extra discount. The setup price is $4,500 only in the up-to-22-hour band, $7,500 in the 23-to-40-hour band, and at least $10,000 above 40 hours if TideGrid does not discontinue the offer.
- Confirm that at least two of the three pilot operators would renew at the full recurring price after the initial term.
- Stop, narrow, or reprice the offer if setup, support, owner capacity, reconciliation, margin, or renewal gates fail. Do not cover a failed model with additional pilot discounts.

Pricing becomes an operating baseline only after these gates pass. It still requires finance, tax, payments, privacy, and contract review before general availability.
