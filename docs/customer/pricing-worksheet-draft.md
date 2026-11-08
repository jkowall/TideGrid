# TideGrid pricing worksheet (draft)

**Status:** Proposed, not adopted. A Stage 0 draft for the owner's review. The owner has not approved the formula layout or the full-price-then-pilot-credit presentation. Both are pending that approval.

**Data:** Synthetic examples only. No real prospect, operator, or customer value appears here. Fill in a copy for a named prospect only in the owner's private location, never in this repository.

**Currency and period:** USD. Every value covers one trailing 12-month period unless a line says otherwise.

This worksheet is the price calculator that [Stage 0](../v2/05-roadmap-validation.md#stage-0-validation-materials-and-bare-bones-company) asks for. It applies the prices and fee base already defined in the [commercial model](../v2/03-commercial-model.md) and the [decision register](../v2/06-decision-register.md#v2-product-and-commercial-decisions). It changes no price and no commercial decision. If this worksheet and those documents differ, those documents win and this worksheet gets corrected.

## Evidence and hypotheses

- **Observed evidence:** none in this worksheet. It holds no interview, prototype, or primary-source data.
- **Hypotheses:** every price, the annual minimum, and the fee rates are the unvalidated pilot pricing hypothesis in the [commercial model](../v2/03-commercial-model.md). They are terms TideGrid will test, not evidence of willingness to pay.
- **Proposed:** this layout, the step order, and the checks in Step 6. The examples are synthetic illustrations, not forecasts.

A completed worksheet is a discussion aid. It is not a quote, an offer, an invoice, or a contract.

## How to use it

1. Get the prospect's aggregate trailing 12-month volume and channel evidence. Use no guest-level data.
2. Fill in Steps 1 to 3. Steps 4 and 5 then follow from the formulas.
3. Show the full price (Step 4) first. Show any pilot credit (Step 5) after it, as a separate line. Never net the credit into the full price.
4. Run the Step 6 checks before the worksheet is shown.

## Inputs

| Input | Value | Unit |
|---|---:|---|
| Trailing period (start and end month) | | months |
| Active boats | | boats |
| Booking Core self-setup | Yes | |
| Managed Launch requested | | yes or no |
| Estimated TideGrid Managed Launch labor, if requested | | hours |
| Native add-on requested | | yes or no |
| Estimated customer-specific Native delivery, if requested | | hours |
| Estimated Native direct cost, if requested | | USD |
| Pilot Native offer applies (first three qualified pilot operators only) | | yes or no |

## Step 1: Channel mix

List every booking channel. A channel counts toward the fee base when the booking is managed in TideGrid. Payment rail and import origin do not change fee treatment.

Enter each channel's eligible booking value for trips completed in the period: trip fares and private-charter value, mandatory operator fees, and eligible booking-linked add-ons and equipment rentals. Enter it before discounts and refunds, which Step 2 subtracts. Exclude taxes and tips. Count each booking once, never its deposit and balance separately. A cancelled or no-show booking enters only Step 2 line C, for the amount retained. A cancellation fully refunded before its value was assessed enters nowhere. A refund or chargeback in the period of value already assessed (a completed trip, or an amount retained at an earlier closed outcome, in this period or an earlier one) enters Step 2 line E. Line C also leaves out any part of a retained amount that trip-count units or a value-preserving credit paid, because that value was already counted.

Dollar card redemptions from a purchased lot enter here, inside the booking lines they paid for. Promotional credit stays inside the booking line, and Step 2 line F subtracts it. Leave these out of the channel values, and record them in Step 3:

- complimentary value;
- the trip entitlement that trip-count card units cover, because Step 2 line B already counted the card sale. Only the covered entitlement stays out: mandatory fees, add-ons, equipment rentals, and uncovered party members paid separately on the same booking stay in the channel values;
- the part of a booking paid from a credit that preserves value already counted on an earlier booking, in this period or an earlier one. A cancellation-credit lot is the usual case: its value was already counted, for example in line C.

| Channel | Bookings (count) | Eligible booking value (USD) | In fee base |
|---|---:|---:|:---:|
| Guest online checkout | | | Yes |
| Staff-assisted (phone, desk, walk-up) | | | Yes |
| Imported future direct or staff-assisted reservation | | | Yes |
| Cash, check, or external point-of-sale, recorded in TideGrid | | | Yes |
| Imported OTA reservation (capacity and roster shadow) | | | No |
| **Included channels subtotal (A)** | | | |

Every imported OTA reservation is excluded during the pilot. It stays managed in its source system.

## Step 2: Net managed booking value

The calculation follows [Net managed booking value](../v2/03-commercial-model.md#net-managed-booking-value) line for line.

| Line | Sign | USD |
|---|:---:|---:|
| A. Included channels subtotal (fares, charter value, mandatory fees, eligible add-ons and rentals) | + | |
| B. Trip-count card sales (assessed at sale) | + | |
| C. Retained cancellation and no-show amounts, less any part paid by trip-count units or value-preserving credits | + | |
| D. Discounts | minus | |
| E. Refunded or charged-back eligible value, including value assessed in an earlier period | minus | |
| F. Promotional credit applied | minus | |
| **N. Net managed booking value = A + B + C - D - E - F** | | |
| Average monthly net managed booking value = N / 12 | | |

## Step 3: Values kept out of the fee base

Record these so the prospect can see what was left out. None of them enters N.

| Excluded value | USD | Reason |
|---|---:|---|
| Taxes | | Excluded from the fee base |
| Tips | | Operator-settled and excluded |
| Complimentary value | | Contributes zero |
| Trip-count card redemptions (the covered trip entitlement only) | | The card sale was already counted in B |
| Redemptions of value-preserving credits (cancellation-credit lots) | | Value already counted on the original booking |
| Dollar card purchases at issue | | Prepaid value; its purchased-lot redemption counts in Step 1 |
| Imported OTA reservation value | | Excluded during the pilot |
| Unrelated retail sales | | Not booking value |
| Payment-processing fees | | Not booking value |

## Step 4: Full price

Show this step first. The formulas are the annual forms of the [billing formulas](../v2/03-commercial-model.md#billing-formulas) for one 12-month contract year.

```text
Core subscription             = $149 x 12 = $1,788
Core variable fee             = 1.5% x N
Core annual charge            = max($3,000, $1,788 + 1.5% x N)
Core minimum shortfall        = Core annual charge - ($1,788 + 1.5% x N)
Extra-boat fees               = $75 x 12 x max(active boats - 2, 0)
Native recurring (if chosen)  = ($399 x 12) + (0.25% x N) = $4,788 + (0.25% x N)
Annual recurring              = Core annual charge + extra-boat fees + Native recurring
Native setup (if chosen)      = the delivery band's price:
                                $4,500 for up to 22 hours and direct cost below $500,
                                $7,500 for 23 to 40 hours
Managed Launch (if chosen)    = $1,000
Year-one full price           = annual recurring + Native setup + Managed Launch
```

| Line | USD |
|---|---:|
| Core subscription | |
| Core variable fee | |
| Core minimum shortfall (invoiced after month 12) | |
| **Core annual charge** | |
| Extra-boat fees | |
| Native recurring | |
| **Annual recurring** | |
| Native setup | |
| Managed Launch | |
| **Year-one full price** | |

Billing timing: the subscriptions bill monthly, the variable fees bill in arrears, and any Core minimum shortfall is invoiced after month 12. The $3,000 minimum counts only the $149 subscription and the 1.5% Core fee. Native fees, extra-boat fees, Managed Launch, taxes, pass-through costs, and custom work do not count toward it. The minimum stops affecting price above $80,800 of N.

Not included in any line: Stripe processing, app-store memberships, domains, messaging registration and usage, other provider pass-throughs at cost, taxes, and custom work.

## Step 5: Pilot credit, shown separately

Show this step only after Step 4. The credit applies only under the Pilot Native offer: the first three qualified pilot operators, with Booking Core and Native both signed. Recurring prices are never discounted. See [Pilot Native offer controls](../v2/03-commercial-model.md#pilot-native-offer-controls).

```text
Native setup credit    = $4,500 - $2,250 = $2,250 (the $4,500 band only)
Managed Launch credit  = $1,000 if Managed Launch appears in Step 4, else $0
Pilot credit           = Native setup credit + Managed Launch credit (at most $3,250)
Year-one pilot price   = year-one full price - pilot credit
```

| Line | USD |
|---|---:|
| Year-one full price (from Step 4) | |
| Pilot credit: Native setup | |
| Pilot credit: Managed Launch | |
| **Year-one pilot price** | |

The commercial model defines the Native setup credit only against the $4,500 band. If a pilot prospect's estimate falls in a higher band, do not show a pilot price; that case goes to the owner (see Pending before use). The Managed Launch credit only offsets a Managed Launch charge that Step 4 shows. When the offer applies but the operator does not take Managed Launch, the Managed Launch credit is $0. When the Pilot Native offer does not apply, enter $0 for both credit lines and say why.

## Step 6: Checks before showing the worksheet (proposed)

| Check | Rule | Source |
|---|---|---|
| Custom quote | Any trigger in Custom work needs a custom quote: average monthly N above $100,000; five or more active boats; more than one location, brand, legal operator, or native app pair; non-US entities, currencies, taxes, or payment methods; enterprise security, procurement, support, or service-level terms; or requirements outside the published V2 product scope. Do not show this worksheet's price. | [Custom work](../v2/03-commercial-model.md#pass-through-costs-and-custom-work) |
| Native setup band | Estimate customer-specific delivery hours and direct cost before showing a Native price. Up to 22 hours with direct cost below $500 is $4,500; 23 to 40 hours is $7,500. Above 40 hours, or a prospect expected to cross a band, needs a quote or a signed change order. Do not show this worksheet's price. The $4,500 band is provisional. | [Native setup](../v2/03-commercial-model.md#native-setup) |
| Native setup margin | Every band targets at least 40% setup gross margin: (setup price - loaded labor - direct cost) / setup price, before any pilot credit, at the model's illustrative $100 loaded hourly cost unless a measured cost replaces it. Below 40%, refer the case to the owner before showing a price. | [Native setup](../v2/03-commercial-model.md#native-setup) |
| Managed Launch scope | The $1,000 price covers up to eight TideGrid labor hours for one operator, one brand, and one location, with the standard contents only. Above eight hours, or with data repair, repeated imports, custom reports, on-site work, or provider remediation, it needs a written custom quote first. Five to eight hours is allowed only inside the three-customer pilot. Otherwise narrow the scope or quote it. | [Managed Launch](../v2/03-commercial-model.md#managed-launch) |
| Direct-first share | At least 80% of trailing booking count through direct or staff-assisted channels. Use counts from Step 1, not value. | [Direct-first profile](operator-validation-guide.md#direct-first-discovery-profile) |
| Native fit | Average monthly N of at least $25,000 for a pilot Native learning case. Standard Native sales target about $50,000 or more. | [Native pilot qualification](operator-validation-guide.md#native-pilot-qualification) |
| Fee base explained | The prospect can restate which channels and values count, and that externally paid bookings managed in TideGrid count. | [Price reveal](operator-validation-guide.md#039-to-043-price-reveal-and-commitment-tests) |

## Example A: synthetic dive shop

All values are synthetic. Trailing 12 months. Three active boats. Requests Booking Core, Native, and Managed Launch. Assumed to qualify for the Pilot Native offer. Native delivery is estimated at 18 customer-specific hours and $300 of direct cost, inside the $4,500 band. Managed Launch is estimated at six TideGrid hours.

### A1. Channel mix

| Channel | Bookings (count) | Eligible booking value (USD) | In fee base |
|---|---:|---:|:---:|
| Guest online checkout | 2,100 | 210,000 | Yes |
| Staff-assisted | 950 | 95,000 | Yes |
| Imported future direct reservation | 0 | 0 | Yes |
| Cash, check, or external point-of-sale | 300 | 25,000 | Yes |
| Imported OTA reservation | 600 | 60,000 | No |
| **Included channels subtotal (A)** | 3,350 | **330,000** | |

The channel values leave out the 15,000 of trip entitlement that trip-count card units covered (see A3). Fees and rentals paid separately on those bookings are inside the channel values. This example has no cancellation-credit redemptions, and no retained amount was paid by card units or credits.

### A2. Net managed booking value

| Line | Sign | USD |
|---|:---:|---:|
| A. Included channels subtotal | + | 330,000 |
| B. Trip-count card sales | + | 18,000 |
| C. Retained cancellation and no-show amounts | + | 4,500 |
| D. Discounts | minus | 9,000 |
| E. Refunded or charged-back eligible value | minus | 6,500 |
| F. Promotional credit applied | minus | 2,000 |
| **N = 330,000 + 18,000 + 4,500 - 9,000 - 6,500 - 2,000** | | **335,000** |
| Average monthly N = 335,000 / 12 | | 27,916.67 |

### A3. Kept out of the fee base

| Excluded value | USD |
|---|---:|
| Taxes | 21,000 |
| Tips | 7,800 |
| Trip-count card redemptions (covered trip entitlement) | 15,000 |
| Dollar card purchases at issue | 3,000 |
| Imported OTA reservation value | 60,000 |
| Unrelated retail sales | 12,000 |

### A4. Full price

| Line | Calculation | USD |
|---|---|---:|
| Core subscription | $149 x 12 | 1,788.00 |
| Core variable fee | 1.5% x 335,000 | 5,025.00 |
| Core minimum shortfall | max(3,000, 6,813) - 6,813 | 0.00 |
| **Core annual charge** | | **6,813.00** |
| Extra-boat fees | $75 x 12 x max(3 - 2, 0) | 900.00 |
| Native recurring | $4,788 + 0.25% x 335,000 = 4,788 + 837.50 | 5,625.50 |
| **Annual recurring** | 6,813.00 + 900.00 + 5,625.50 | **13,338.50** |
| Native setup | | 4,500.00 |
| Managed Launch | | 1,000.00 |
| **Year-one full price** | 13,338.50 + 4,500.00 + 1,000.00 | **18,838.50** |

### A5. Pilot credit, shown separately

| Line | USD |
|---|---:|
| Year-one full price | 18,838.50 |
| Pilot credit: Native setup ($4,500 - $2,250) | minus 2,250.00 |
| Pilot credit: Managed Launch | minus 1,000.00 |
| **Year-one pilot price** | **15,588.50** |

The annual recurring price, $13,338.50, is the same with or without the pilot credit.

### A6. Checks

- Custom quote: not needed. Average monthly N is $27,916.67, below $100,000, with three active boats. Assumed: one US location and no other Custom work trigger.
- Direct-first share by count: 3,350 / 3,950 = 84.8%. OTA is 600 / 3,950 = 15.2%. Passes the 80% rule.
- Native setup band: 18 hours and $300 of direct cost, inside the $4,500 band.
- Native setup margin: (4,500 - 18 x 100 - 300) / 4,500 = 2,400 / 4,500 = 53.3%, above 40%.
- Managed Launch scope: six hours, inside the eight-hour ceiling. Five to eight hours is allowed because this is a pilot operator.
- Native fit: average monthly N of $27,916.67 meets the $25,000 pilot learning-case floor. It is below the about-$50,000 standard Native target, so it fits only as a pilot learning case with an evidenced repeat-use reason.

## Example B: synthetic private charter

All values are synthetic. Trailing 12 months, with trips in seven months. One active boat. Requests Booking Core and Managed Launch, estimated at three TideGrid hours. No Native add-on.

### B1. Channel mix

| Channel | Bookings (count) | Eligible booking value (USD) | In fee base |
|---|---:|---:|:---:|
| Guest online checkout | 38 | 38,000 | Yes |
| Staff-assisted | 24 | 24,000 | Yes |
| Imported future direct reservation | 0 | 0 | Yes |
| Cash, check, or external point-of-sale | 9 | 9,000 | Yes |
| Imported OTA reservation | 6 | 6,000 | No |
| **Included channels subtotal (A)** | 71 | **71,000** | |

Each charter is entered once, not as a deposit plus a balance.

### B2. Net managed booking value

| Line | Sign | USD |
|---|:---:|---:|
| A. Included channels subtotal | + | 71,000 |
| B. Trip-count card sales | + | 0 |
| C. Retained cancellation and no-show amounts | + | 2,400 |
| D. Discounts | minus | 1,200 |
| E. Refunded or charged-back eligible value | minus | 1,800 |
| F. Promotional credit applied | minus | 400 |
| **N = 71,000 + 0 + 2,400 - 1,200 - 1,800 - 400** | | **70,000** |
| Average monthly N = 70,000 / 12 | | 5,833.33 |

### B3. Kept out of the fee base

| Excluded value | USD |
|---|---:|
| Taxes | 4,300 |
| Tips | 6,500 |
| Imported OTA reservation value | 6,000 |

### B4. Full price

| Line | Calculation | USD |
|---|---|---:|
| Core subscription | $149 x 12 | 1,788.00 |
| Core variable fee | 1.5% x 70,000 | 1,050.00 |
| Core minimum shortfall | max(3,000, 2,838) - 2,838 | 162.00 |
| **Core annual charge** | | **3,000.00** |
| Extra-boat fees | $75 x 12 x max(1 - 2, 0) | 0.00 |
| Native recurring | Not requested | 0.00 |
| **Annual recurring** | | **3,000.00** |
| Native setup | Not requested | 0.00 |
| Managed Launch | | 1,000.00 |
| **Year-one full price** | 3,000.00 + 1,000.00 | **4,000.00** |

N is below $80,800, so the $3,000 annual minimum sets the Core charge. The $162 shortfall is invoiced after month 12. Seasonal operators pay the subscription in months with no trips.

### B5. Pilot credit, shown separately

| Line | USD |
|---|---:|
| Year-one full price | 4,000.00 |
| Pilot credit: Native setup | 0.00 |
| Pilot credit: Managed Launch | 0.00 |
| **Year-one pilot price** | **4,000.00** |

No pilot credit applies. The Pilot Native offer requires the Native add-on, and this example does not request it. Under the adopted terms, Managed Launch is free only inside that offer.

### B6. Checks

- Custom quote: not needed. Average monthly N is $5,833.33 with one active boat. Assumed: one US location and no other Custom work trigger.
- Direct-first share by count: 71 / 77 = 92.2%. OTA is 6 / 77 = 7.8%. Passes the 80% rule.
- Managed Launch scope: three hours, within four, so no pilot exception is needed.
- Native fit: average monthly N of $5,833.33 is below the $25,000 pilot learning-case floor. Do not offer Native from this worksheet.

## Pending before use

- The owner approves or replaces the formula layout and the full-price-then-pilot-credit presentation.
- The owner decides how the pilot Native setup credit applies to a pilot prospect whose Native estimate falls above the $4,500 band. The commercial model defines the credit only against that band.
- The owner decides whether [Stage 0](../v2/05-roadmap-validation.md#stage-0-validation-materials-and-bare-bones-company) links to this draft.
- A fresh reviewer re-derives every number in both examples against the [commercial model](../v2/03-commercial-model.md).
