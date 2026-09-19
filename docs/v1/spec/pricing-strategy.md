# TideGrid V1 pricing strategy

**Status:** Historical commercial proposal; superseded by the [V2 commercial model](../../v2/03-commercial-model.md)
**Effective date:** July 15, 2026  
**Pricing schedule version:** `2026-07-15-us-pilot-v1`

> Do not quote or implement this pricing. It is preserved to explain the V1 assumptions and how the current model changed.

## Decision

TideGrid uses a tiered hybrid model: a monthly subscription plus a plan-specific platform fee on eligible TideGrid-processed value. Smaller operators receive a low fixed entry price and pay a higher variable rate. Larger fleets receive progressively lower rates in exchange for higher subscription commitments.

The original 1% concept is retained as a scale discount, not the default entry rate. This commercial decision supersedes the 1% assumption in the preserved source prompt without changing that source artifact.

## Published baseline

| Plan | Monthly subscription | Platform fee | Included footprint | Intended customer |
|---|---:|---:|---|---|
| Dock | $149 | 3.00% | 1 location, 2 active boats | Small and seasonal operators |
| Growth | $399 | 2.00% | 2 locations, 6 active boats | Growing multi-boat operators |
| Fleet | $999 | 1.25% | 5 locations, 15 active boats | Established multi-location fleets |
| Enterprise | Custom | 0.75% to 1.00% | Contracted footprint and volume | Large or strategically complex fleets |

All prices are USD. Stripe or other payment-processing charges are separate from TideGrid subscription and platform fees.

## Included usage and entitlements

Every paid plan includes unlimited:

- customers and participant profiles;
- bookings and booking channels;
- staff and crew users;
- products, schedules, and departures;
- waivers, manifests, check-in, disruptions, and core offline operations.

Plans do not include unlimited boats or locations. Those dimensions correlate with operational complexity, support load, migration effort, and product value more reliably than customer records or booking count.

An **active boat** is a vessel assigned to at least one departure during the billing period. Archived vessels and vessels that remain in maintenance-only status for the full period do not count. Active boats above the plan allowance cost $75 per boat per month. Additional locations require a plan upgrade or an Enterprise contract.

## Platform-fee policy

The applicable plan code, pricing schedule version, and rate are snapshotted on the order and repeated on each platform-fee entry. Later plan or price changes apply prospectively and never rewrite a historical order or fee.

The platform fee applies exactly once to eligible TideGrid-processed sale value:

| Transaction | Fee treatment |
|---|---|
| Standard booking or private charter | Apply the snapshotted plan rate to eligible new money |
| Package or gift-card purchase | Apply on purchase |
| Package or gift-card redemption | Exclude redeemed value to prevent double charging |
| Point-of-sale purchase | Apply to eligible sale lines processed through TideGrid |
| Mixed tender or imported booking | Apply only to incremental eligible value processed through TideGrid |
| Taxes and tips | Exclude |
| Cash or external payment record | Exclude |
| Imported OTA value | Exclude |
| Refund | Reverse the corresponding application fee proportionally |

TideGrid should not require the operator to add a surprise customer-facing service fee. Operators may incorporate platform economics into their published prices, subject to their own legal and disclosure obligations.

## Commercial policies

- Guided onboarding is $499 and is waived with an annual subscription purchase.
- Annual billing discounts the subscription component by 15%. It does not change the platform-fee rate unless contracted separately.
- Seasonal read-only mode is $49 per month. It blocks new commercial activity while preserving records, exports, safe refunds, and account reactivation.
- There is no separate minimum or cap on the variable platform fee in the pilot baseline. The monthly subscription is the minimum commercial commitment.
- Enterprise discounts require a contracted volume or footprint commitment and must never be applied retroactively.

## Unit economics for small operators

Illustrative Dock-plan economics, excluding payment processing:

| Monthly eligible TideGrid GMV | Subscription | 3% fee | Total TideGrid revenue | Effective take rate |
|---:|---:|---:|---:|---:|
| $5,000 | $149 | $150 | $299 | 6.0% |
| $10,000 | $149 | $300 | $449 | 4.5% |
| $25,000 | $149 | $750 | $899 | 3.6% |

This curve protects TideGrid's support and infrastructure economics at low volume while allowing the effective rate to decline as an operator grows. Plan upgrades reduce marginal fees when volume and fleet complexity justify a larger fixed commitment.

## Competitive context

Official published pricing establishes that materially higher transaction fees are already common in tour and activity software:

- [FareHarbor](https://fareharbor.com/aloha/boat-tours/) advertises no monthly fee, with up to 6% on direct bookings and 2% on API bookings, plus payment processing.
- [Xola](https://www.xola.com/join/) advertises a $199 implementation fee, no recurring subscription fee, and a 6% online booking fee.
- [Bókun](https://www.bokun.io/pricing) publishes subscription-plus-fee plans at $49 plus 1.5%, $149 plus 1.25%, and $499 plus 1.0%.

TideGrid should sell operational control, offline readiness, resource integrity, and departure closeout rather than competing only on price. The pricing is intentionally below high variable-fee offers at meaningful volume, while funding hands-on support for smaller operators.

## Validation before general availability

The commercial baseline remains a hypothesis until tested with design partners. Product and finance must measure:

- conversion and objection rate by tier;
- willingness to pay for maritime operations and offline workflows;
- monthly support and onboarding cost by operator size;
- eligible GMV, effective take rate, and gross margin by cohort;
- upgrade behavior near boat, location, and volume thresholds;
- seasonal-mode usage, churn, and reactivation;
- whether the active-boat definition creates understandable bills without gaming.

Pricing publication requires finance and counsel approval of subscription, application-fee, refund, disclosure, and connected-account terms.
