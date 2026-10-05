# @tidegrid/domain-pricing

Prices, paid add-ons, mandatory fees, taxes, one promotion code rule, versioned policies, and immutable quotes for the demo build (goal G2.5 in the [demo build plan](../../docs/v2/12-demo-build-plan.md)). The design authority is [product scope: pricing, taxes, fees, and quotes](../../docs/v2/02-product-scope.md#pricing-taxes-fees-and-quotes), [policies](../../docs/v2/02-product-scope.md#policies-cancellation-rescheduling-refunds-and-credits), and [the target architecture](../../docs/v2/04-architecture.md#checkout-booking-and-orders) (Product snapshots, `PromotionRuleVersion`, the immutable checkout quote). Tables are in migration `0005_pricing_and_policies.sql` and follow the [tenancy contract](../database/README.md).

## Units

- Money is integer US cents, with an explicit `USD` currency on price lists, promotions, and quotes.
- Tax rates are parts per million: 70000 is 7%, 47120 is 4.712%.
- Discounts and refunds are basis points: 1000 is 10%.
- Every division rounds half up. Products of two integers are formed in BigInt, so nothing loses precision.

## Terms

Terms change by appending a version. Nothing is edited, and the highest version is current.

| Terms | Owner | Holds |
|---|---|---|
| Price list | Product | Ticket types (shared seats) or the charter price, mandatory fees, paid add-ons |
| Policy | Product | Change cutoff, the remedy before and after it, no-show remedy, and the cancellation, reschedule, no-show, operator-cancellation, and weather text |
| Tax rate | Tenant | Name, rate, inclusive or exclusive, active |
| Promotion | Tenant | One code, fixed amount or percentage, redemption window, products or all products, active |

- **Ticket types.** Each has an operator code (`adult`), a name, a price, and taxability. Each ticket is one participant and one seat. A price list for a shared-seat product has at least one.
- **Charter price.** A private charter has exactly one, for the whole boat. Party size never changes it.
- **Fees.** Mandatory, at least one cent, charged once per booking or once per participant.
- **Add-ons.** Optional, with a code, price, taxability, and a limit: up to `maxQuantity` per booking, or up to `maxQuantity` for each participant. An add-on can carry an inclusive range of local dates; it is offered only for trips on those dates. An add-on lives in a product's price list, so offering one add-on on several products means listing it in each, each with its own price. Add-ons have no inventory; limited physical items belong in pooled equipment (G3.2).
- **Codes** are stable across versions, so a guest's selection survives a price change. Codes are unique within ticket types, within fees, and within add-ons of one price list.
- **Policy remedies** are `full_refund`, `percent_refund` (with basis points), `credit`, or `none`. The cutoff is elapsed minutes before departure. A guest change before `trip start - cutoff` gets the before-cutoff remedy; at or after it, the after-cutoff remedy. This goal records the terms. Applying them is G2.9 and G2.11.
- **Tax rates** apply to every taxable line while their current version is active. TideGrid calculates and displays them; it does not decide what is owed.
- **Promotions.** A code is stored upper case, compared trimmed and in any case, and never changes. A version applies while the quote instant is in `[startsAt, endsAt)`.

Commands in `setup.ts` append versions: `createPriceListVersion`, `createPolicyVersion`, `createTaxRate`, `createTaxRateVersion` (`active: false` retires a rate), `createPromotion`, and `createPromotionVersion` (`active: false` retires a code). Each validates its input, takes a per-aggregate transaction lock before choosing the next version number so concurrent writers get consecutive versions, and records an audit event. Staff endpoints for them arrive with the console goal; the seed and tests use them directly.

## Quote computation

`priceQuote` in `compute.ts` is pure. It takes the trip's facts, the current price list, the active tax rates, the promotion the entered code names, the selection, and the quote instant, and returns a priced quote or every problem it found.

1. **Structure.** The price list must describe the trip's product and be complete, and the party must match the product: ticket quantities for shared seats, a guest count for a charter. Otherwise `pricing_unavailable` or `party_kind_mismatch`, and nothing else is checked.
2. **Party.** Each ticket type at most once (`duplicate_ticket_type`), known (`unknown_ticket_type`), with a positive whole quantity (`invalid_quantity`). The party size must be within the product's limits (`party_size_out_of_range`) and the trip's remaining capacity (`insufficient_capacity`).
3. **Add-ons.** Each at most once (`duplicate_add_on`), known (`unknown_add_on`), with a positive whole quantity, offered on the trip's local date (`add_on_unavailable`), and within its limit (`add_on_quantity_exceeded`).
4. **Promotion.** An entered code must name an active promotion whose window contains the quote instant and which covers the product. Otherwise `promotion_not_applicable`, with an internal reason: `unknown`, `inactive`, `not_started`, `expired`, or `product_ineligible`.
5. **Lines.** Tickets or the charter price, then add-ons, then fees, each in price list order. A per-participant fee is charged once per participant.
6. **Discount.** Off the trip price only (ticket and charter lines), never off add-ons, fees, or tax. A percentage rounds half up; a fixed amount is capped at the trip price. The discount is allocated to the trip-price lines in proportion to their amounts by the largest remainder method, ties to the earlier line, so the shares sum exactly.
7. **Tax.** Per taxable line, on the line's amount after its discount share, rounded half up per line. Every rate applies to the same pre-tax amount, never to another tax. Inclusive rates are extracted together, `base = round(net / (1 + sum of inclusive rates))`, and the extracted tax is split across them by the largest remainder. Exclusive rates are added: `round(base x rate)` each.
8. **Totals.** `subtotal` is the trip price and add-ons before the discount. `total = subtotal - discount + fees + tax`, where `tax` is the added tax; `includedTax` is reported, not added. `amountDueNow` equals `total` until deposits (G2.8).

Independent problems are all reported, in the order above. Checks that depend on a party size that could not be counted are skipped rather than reported as consequences. A line or total above $1,000,000 is refused as `quote_amount_too_large`, so no amount can overflow its column.

## Quotes

`createQuote` prices a party on a trip that is on sale now and stores an immutable quote.

- **On sale** means exactly what the public availability query means: the trip is listed by `findAvailableTrips` for the product's smallest party. The quote then checks the real party against the product's limits and the trip's remaining capacity. G2.6 makes that capacity hold-aware; a quote never reserves anything.
- **Snapshot.** A quote stores the trip it prices (product name, zone, local date and time, start instant, offset), the price list, policy, and promotion versions it used, every line with its code, name, quantity, unit price, amount, discount share, and taxability, one row per taxable line and tax rate, and the totals. Reading a quote uses only the snapshot and the immutable versions it names, so later price, tax, promotion, policy, or catalog changes never alter it.
- **Validity.** `quotedAt` is the pricing instant; `expiresAt` is 30 minutes later. Checkout (G2.6 and G2.7) must start before then or ask for a new quote.
- **Audit classification.** A quote records its actor and request id on its own row and writes no audit event or outbox event: it changes no booking, money, or configuration. Every command that appends terms records an audit event.
- **Immutable.** Quotes, lines, and line taxes are append-only for every role. Lines and taxes can be written only in the quote's own transaction.
- **Self-checking.** The database refuses a quote that its trip and versions do not produce, whoever writes it:
  - when it is written, its trip snapshot must equal the trip and product it names;
  - at commit, the header totals must equal the lines, only taxable lines carry tax, the discount is fully allocated, there is a trip-price line, and a discount line exists exactly when a promotion is named;
  - at commit, every priced line must be an item of the named price list version copied exactly, with a quantity its rule allows on the trip's date; each item appears once, every fee is charged, and the tickets are the party;
  - at commit, a named promotion must have been redeemable for the product at `quotedAt`, and the discount must be its rule applied to the trip price;
  - at commit, every taxable line carries the same rate versions on one pre-tax amount, with inclusive tax extracted and added tax rounded exactly as above.
- `getTripOffer` returns what a guest can choose for one trip: ticket types or the charter price, the add-ons offered on its date, fees, active tax rates, and the policy with its cutoff instant.

## Publishing

A product publishes only with a price list and a policy. `publishProduct` in the catalog reports `product_missing_price` and `product_missing_policy` after the G2.4 problems; a trigger in migration 0005 refuses the same transition for every writer. Versions cannot be deleted, so a published product keeps its terms. A price list version is complete at commit: a shared-seat list has a ticket type and a charter list has its price.

## API

Public routes resolve the tenant from the verified browser Origin, as `/v1/public/trips` does, and answer an unknown origin with the same 404.

| Route | Answers |
|---|---|
| `GET /v1/public/trips/{tripId}/offer` | 200 offer; 404 `trip_not_found`; 409 `trip_not_bookable` or `pricing_unavailable` |
| `POST /v1/public/quotes` | 201 quote; 400 contract; 404 `trip_not_found`; 409 `trip_not_bookable`, `pricing_unavailable`, `insufficient_capacity`; 422 the first quote problem, or `idempotency_key_reused` |
| `GET /v1/public/quotes/{quoteId}` | 200 quote; 404 `quote_not_found` for another tenant's quote, an unknown id, or a malformed one |

- `POST /v1/public/quotes` needs an `Idempotency-Key`. A retry with the same key and body replays the first response with `Idempotent-Replayed: true`; the same key with another body answers 422. Guests are anonymous until checkout issues scoped credentials, so all of one tenant's guests share the principal `guest:public`. Keys are random and client-generated, and a quote holds no personal data, so a guessed key could only replay a price.
- The error message lists every problem with the ticket type or add-on it is about. Every promotion problem answers `promotion_not_applicable`, so codes cannot be probed.
- Responses are `Cache-Control: no-store` and `Vary: Origin`.

## Seed

`tools/seed/src/pricing.ts` gives every demo product a price list and a policy before the catalog seed publishes it, and gives each operator its tax rates and one promotion code. Demo Harbor adds a state and a county tax and offers `HARBOR10`, 10% off any trip. Demo Reef's prices include a general excise tax and it offers `REEF25`, $25 off its dive and its snorkel sail. Reruns add nothing.

## Deferred and known gaps

- Deposits and balances (G2.8), refunds, credits, and applying policy remedies (G2.9 and G2.11), equipment rentals (G3.2), trip cards and credit as tender (G3.5), and tips (G3.4) are not in a quote yet. The order (G2.7) copies a quote's lines.
- Tax rates are tenant-wide. An operator with locations in different tax jurisdictions needs per-location rates.
- `POST /v1/public/quotes` writes a row per request and has no per-client rate limit yet; G2.14b adds origin-bound throttling with verified-origin CORS. Expired quotes are kept; a cleanup job arrives with the outbox sweeper.
- There are no staff endpoints for terms or quotes yet; the console goal adds them on the commands above.
- Quote creation reads `scheduled_trips` and `products` directly for a trip's product and local date before asking the catalog's availability query, which owns bookability.
