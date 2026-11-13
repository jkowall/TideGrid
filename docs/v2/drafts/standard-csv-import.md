# Standard CSV import and Managed Launch boundaries (draft)

**Status:** Approved by the owner on 2026-11-13 ([decision register](../06-decision-register.md#2026-11-13-the-owner-approves-the-standard-csv-import-draft-and-its-twelve-open-questions)), with the answers to its open questions recorded there. Still a draft in placement until promoted to a numbered document.
**Drafted:** 2026-11-08, goal W1-CSV-DEF, for the Stage 0 item "Define the standard CSV import and the boundaries of Managed Launch" in the [roadmap](../05-roadmap-validation.md#stage-0-validation-materials-and-bare-bones-company).
**Placement:** a draft, not a numbered V2 document. It is not part of the [authority order](../00-index.md#authority-and-historical-artifacts). Where it differs from the [decision register](../06-decision-register.md) or a numbered document, they win. Promotion to a numbered document is a later goal, after a dated owner approval entry.
**Data:** every example is synthetic. No real operator export was read or used.

Every column, required field, deduplication key, control total, error code, and custom-work boundary below was approved by the owner on 2026-11-13, including the two coordinator defaults D1 and D2. The open questions at the end are answered in the register entry linked above.

## What this draft rests on

Observed in the repository (2026-11-08, `main` at `8f2d485`):

- The [product scope](../02-product-scope.md#migration-and-launch-data) lists the in-scope migration data: customer identity and contact data; future direct, staff-assisted, and OTA bookings; participant names and allowed non-medical details; outstanding private-charter balances and external-payment references; active named-customer booking credits; and active trip-card balances once that module is enabled. It requires a source system, external identifier, mapping version, import batch, and deduplication key on every import, and a dry run with a row-level error report before any live commit.
- The scope's acceptance rules: a re-run batch duplicates nothing; an import cannot silently overbook; ambiguous customer matches stay separate until operator review; imported money is labeled as opening or external records, never as TideGrid-processed Stripe charges; every accepted and rejected row reconciles before cutover. Legacy waiver evidence is not migrated in bulk, and TideGrid does not claim an imported legacy waiver is valid.
- The [commercial model](../03-commercial-model.md#managed-launch) defines Managed Launch: up to eight TideGrid hours for one operator, one brand, and one location, including one standard CSV import. Data repair, repeated imports, custom reports, on-site work, and provider remediation are separate work. [Custom work](../03-commercial-model.md#pass-through-costs-and-custom-work): complex migration or trip-card reconciliation starts at $2,500; other work is a fixed statement of work or $175 an hour. The register's Managed Launch boundary row sets a four-hour target and an eight-hour pilot ceiling.
- The [fee base](../03-commercial-model.md#net-managed-booking-value) counts imported direct and staff-assisted bookings that TideGrid manages, and excludes imported OTA reservations, which stay capacity and roster shadows.
- The current schema in [packages/database/migrations](../../../packages/database/migrations) and the [database README](../../../packages/database/README.md): money is integer cents in USD; trips carry an IANA zone, a local date and start time, and UTC instants; participants have a position, a name, a minor flag, an optional email, and a guardian name and email for a minor. See [Schema gaps](#schema-gaps-observed) for what the schema cannot hold yet.

Not observed: no operator has shared an export, and the one interview on file says nothing about legacy file formats. Every column choice below is a hypothesis to test against real exports during validation.

## Files in one batch

One import batch is one set of UTF-8 CSV files, exported from one source system for one operator, one brand, and one location (proposed).

| File | Purpose | Required in a batch |
|---|---|---|
| `manifest.csv` | Batch identity, mode, and the operator's declared control totals | Yes |
| `products.csv` | Maps legacy products to TideGrid products configured during catalog setup | Yes |
| `trips.csv` | Future departures the bookings belong to | Yes, when `bookings.csv` is present |
| `customers.csv` | Named customers: bookers and balance holders | Yes, when bookings or balances are present |
| `bookings.csv` | Future confirmed bookings | No |
| `participants.csv` | Named people in each booking's party | No |
| `payments.csv` | External payment and refund records | No |
| `opening_balances.csv` | Booking credits and trip-card balances | No |
| `waivers.csv` | Legacy waiver status, for information only | No |

The goal named seven files. `customers.csv` is added because the scope lists customer identity first and both bookings and balances need a named customer. `manifest.csv` carries the control totals. Both additions are proposed.

## Rules for every file

All proposed.

**Format.** UTF-8, with or without a byte order mark. RFC 4180 quoting, comma separated, CRLF or LF line ends. The first record is a header with the exact column names below, in any order. A missing required column, an unknown column, or a repeated column is a file-level error. Unknown columns are refused, not ignored, so no data is dropped silently and no medical or other out-of-scope field slips in.

**Empty values.** An empty field means no value. A required field must not be empty. Surrounding spaces are trimmed. Control characters are refused.

**Types.**

| Type | Format | Example |
|---|---|---|
| `text(n)` | Up to n characters after trimming | `Two-tank reef dive` |
| `id` | 1 to 64 characters: letters, digits, `.`, `_`, `-` | `LB-5001` |
| `uuid` | A TideGrid id copied from the console | `00000000-0000-4000-8000-000000000101` |
| `int` | Base-10 integer, no separators | `12` |
| `cents` | Integer USD cents, 0 to 100000000, no decimal point, symbol, or separator | `33100` is $331.00 |
| `date` | `YYYY-MM-DD` | `2027-04-12` |
| `time` | `HH:MM`, 24-hour, local | `08:00` |
| `timestamp` | ISO 8601 with seconds and an explicit offset or `Z` | `2027-01-05T14:22:00-05:00` |
| `offset` | `+HH:MM` or `-HH:MM` | `-04:00` |
| `zone` | An IANA time zone name | `America/New_York` |
| `bool` | `true` or `false` | `false` |
| `email` | One address, stored lowercase | `avery.sample@example.test` |
| `phone` | E.164 | `+15555550142` |
| `enum` | One listed value, lowercase | `staff_assisted` |

**Money as integer cents.** Every amount is a `cents` value in USD. A decimal amount such as `331.00` is refused, so the import never guesses at rounding. The console's day export writes plain decimals for people to read; the import takes cents so that totals add exactly. No other currency is accepted.

**Time zone rules.**

1. A trip's local date and start time are read in the time zone of the mapped product's location. The `time_zone` column must name that same zone, as the schema already requires of trips and schedules. A different zone is an error, not a conversion.
2. A local start time that does not exist, inside the spring-forward gap, is an error.
3. A local start time that happens twice, inside the fall-back hour, is an error unless `utc_offset` says which one. This mirrors the schedule rule that rejects ambiguous times by default.
4. Every `timestamp` carries its own offset. A timestamp without one is an error.
5. Business dates, such as a balance due date, an expiry date, and a trip date in a deduplication key, are local dates in the operator's zone, as reports use them.
6. The manifest names the operator's zone. Every location in the batch must use it; a second zone means a second location, which is outside Managed Launch.

**Identity and references.** Every row carries the source system's own id for the record. Files refer to each other by those ids, never by row number. TideGrid stores the source system, the external id, the mapping version, and the batch id on every imported record.

**Deduplication and re-runs.**

- Within a batch, two rows with the same deduplication key are both refused (`duplicate_key_in_batch`).
- Re-running a batch, or a later batch from the same source system, finds rows by their deduplication key. An identical row is a no-op. An unchanged row still counts as accepted for the control totals, so a file that repeats earlier rows declares the same totals the legacy system shows. An unchanged row repeated in a re-run or in the final delta batch takes nothing again: its booking's seats are already in that booking's own confirmed hold, and its payment is already on the booking. It is not counted a second time against capacity, the one-booking rule for a private charter, or the balance checks. A row whose key exists but whose content changed is refused as `changed_since_import`, listed for the operator, and corrected only through an audited console action. Re-imports never overwrite.
- A dry run writes nothing. A commit is allowed only for a batch whose last dry run had no error rows and matched every declared control total, and only when every file has the same content hash as in that dry run. The manifest's `batch_mode` and `run_number` rows are left out of the hash.
- The commit re-runs every row check and every control-total check inside its own transaction. It does not trust the dry run's result, because seats, holds, and customers can change between the two. A row check that reads the clock uses the commit time, not the export time or the dry run's time. So a trip that departs between the dry run and the commit is refused as `trip_departed`, with its bookings as `parent_rejected`. It takes capacity through the proposed import capacity path in [bookings.csv](#bookingscsv), which locks each trip the way checkout's hold path does and counts the same live holds. If any check now fails, it refuses the whole batch with the same error codes and commits nothing.
- There is no partial commit: the operator fixes the source or removes rows, then runs the dry run again.
- Balance checks read the whole record for a booking or customer, including records from earlier batches of the same source system. A final delta batch that adds one payment is checked against the payments already imported.
- A row that depends on a refused row is refused too, as `parent_rejected`, so a rejected trip takes its bookings, participants, payments, and waiver rows with it.

**Customer matching.** A customer whose email exactly matches an existing TideGrid customer is a match candidate, shown for operator review. It is never merged automatically. Name similarity, a shared mailbox, or a booker's assertion never merges records, as the [waiver matching rules](../02-product-scope.md#verification-and-matching) require. An unreviewed candidate stays a separate customer.

**Out-of-scope data.** Raw card numbers, medical data, certification documents, full accounting history, past or canceled bookings, old message threads, and legacy waiver documents are not imported. A `reference` or text field that looks like a card number (13 to 19 digits that pass the Luhn check, with or without spaces or hyphens) is refused as `possible_card_number`.

## Row-level error format

All proposed. The dry run writes one `errors.csv` per batch.

| Column | Type | Meaning |
|---|---|---|
| `batch_id` | id | The manifest's batch id |
| `run_number` | int | The manifest's run number |
| `file` | text | The file name, or `manifest.csv` for a control total |
| `line` | int | The record number, counting the header as 1, so it matches a spreadsheet row when no field contains a line break. Empty for a file-level error |
| `record_key` | text | The row's deduplication key as text, or empty |
| `column` | text | The column at fault, or empty |
| `code` | enum | A stable code from the list below |
| `severity` | enum | `error` blocks the commit; `warning` needs operator review but does not block |
| `message` | text | A plain sentence, safe to show the operator. It quotes only values that passed their type check |
| `value` | text | The offending value, for non-personal columns only. Names, emails, phones, and references show as `[withheld]` |

Every cell of `errors.csv` gets the same formula guard as the console's day export: a cell that starts with `=`, `+`, `-`, `@`, a tab, or a carriage return is written with a leading `'`, so a spreadsheet shows it as text. Rejected values come from the legacy file, so the report treats them as untrusted. A value refused as `invalid_type` or `invalid_enum` appears only in `value`, never in `message`.

Proposed codes: `missing_column`, `batch_changed_since_dry_run`, `later_than_export`, `unknown_column`, `missing_required`, `invalid_type`, `invalid_enum`, `staff_channel_required`, `staff_channel_not_allowed`, `out_of_range`, `duplicate_key_in_batch`, `changed_since_import`, `unknown_reference`, `parent_rejected`, `product_not_found`, `product_kind_mismatch`, `boat_not_linked`, `zone_mismatch`, `nonexistent_local_time`, `ambiguous_local_time`, `trip_in_past`, `trip_departed`, `boat_overlap`, `trip_date_mismatch`, `over_capacity`, `charter_already_booked`, `amounts_do_not_add_up`, `ota_amounts_present`, `payment_on_ota_booking`, `overpaid`, `refund_exceeds_payments`, `refunds_exceed_total`, `unexpected_balance`, `balance_due_date_missing`, `balance_due_after_trip`, `refund_with_balance`, `position_out_of_range`, `guardian_required`, `guardian_not_allowed`, `module_disabled`, `balance_expired`, `credit_needs_email`, `credit_restriction_unsupported`, `credit_never_expires` (warning), `possible_card_number`, `customer_match_candidate` (warning), `participant_email_missing` (warning), `control_total_mismatch`.

The report also has a summary: accepted and refused rows per file, and each declared control total beside the computed one.

## The manifest

`manifest.csv` has three columns: `item`, `file`, `value`. Batch fields leave `file` empty.

| Item | Required | Rule |
|---|---|---|
| `batch_id` | Yes | `id`; unique per operator. One batch keeps the same id across its dry runs and its commit |
| `run_number` | Yes | `int`; 1 for the first dry run, one higher for each later dry run and for the commit |
| `source_system` | Yes | `id`; names the legacy system. Part of every deduplication key |
| `mapping_version` | Yes | `std-csv-v0` while this draft stands |
| `batch_mode` | Yes | `dry_run` or `commit`. A commit carries the last clean dry run's files with the same content hash, apart from this row and `run_number` (`batch_changed_since_dry_run` otherwise). The commit still re-runs every check |
| `operator_time_zone` | Yes | `zone` |
| `exported_at` | Yes | `timestamp` of the legacy export. No `booked_at` or `received_at` may be later (`later_than_export`) |
| `waiver_notifications` | Yes, when bookings are present | `send_at_cutover` or `hold_until_staff_release`. The scope requires an explicit notification policy for imported future bookings; no mass email on import |

**Control totals.** Every other row declares one total for one file: `item` is the metric, `file` is the file, `value` is the number the operator read from the legacy system. The dry run, and again the commit, computes the same metric from accepted rows, unchanged rows included. Any difference is a `control_total_mismatch` error. The metrics for each file are listed with the file below. A batch must declare every listed metric for every file it includes.

## products.csv

Maps each legacy product to a TideGrid product the operator, or TideGrid under Managed Launch, configured during catalog setup. The import does not create products, prices, fees, taxes, or policies.

| Column | Type | Required | Rule |
|---|---|---|---|
| `source_product_id` | id | Yes | The legacy product id |
| `source_product_name` | text(120) | Yes | For the operator's review only |
| `tidegrid_product_id` | uuid | Yes | An existing product in this operator |
| `tidegrid_product_name` | text(120) | Yes | Must equal the product's current name, a check against a mistyped id |
| `product_kind` | enum | Yes | `shared_seat` or `private_charter`; must equal the product's kind |

- **Deduplication key:** `source_system` + `source_product_id`.
- **Control totals:** `row_count`.

```csv
source_product_id,source_product_name,tidegrid_product_id,tidegrid_product_name,product_kind
P-REEF2,Two-tank reef dive,00000000-0000-4000-8000-000000000101,Morning two-tank reef dive,shared_seat
P-CHARTER4,Half-day private charter,00000000-0000-4000-8000-000000000102,Half-day private charter,private_charter
```

## trips.csv

Future departures. A row maps to an existing TideGrid trip with the same product, boat, and start instant, or creates one in the `draft` sales state so it does not appear for sale until the operator publishes it (proposed). The schema lets a new trip start only as `draft` or `published`. Under the current schema a `draft` trip cannot take a capacity hold at all, so imported bookings on it need the proposed import capacity path in [bookings.csv](#bookingscsv). That path amends the shared hold trigger.

| Column | Type | Required | Rule |
|---|---|---|---|
| `source_trip_id` | id | Yes | The legacy departure id |
| `source_product_id` | id | Yes | A row in `products.csv` |
| `tidegrid_boat_id` | uuid | Yes | A boat linked to the mapped product (`boat_not_linked` otherwise) |
| `local_date` | date | Yes | The trip's start instant (this date and the start time, in the operator's time zone) must be after the batch's `exported_at` (`trip_in_past` otherwise), so a departure later on the export day is accepted. The start instant must also be after the time of the check: the dry run's time, and again the commit's time (`trip_departed` otherwise) |
| `local_start_time` | time | Yes | See the time zone rules |
| `time_zone` | zone | Yes | Must equal the product location's zone |
| `utc_offset` | offset | Only for a fall-back time | Picks one of the two instants |
| `seat_capacity` | int | No | Shared seats only; defaults to the product's seat limit, or the boat's capacity; never above the boat's capacity |

The duration comes from the product. A trip that overlaps another live trip on the same boat, including its turnaround buffer, is refused as `boat_overlap`, as the schema refuses it.

- **Deduplication key:** `source_system` + `source_trip_id`. A second source id for the same product, boat, and instant is `duplicate_key_in_batch`.
- **Control totals:** `row_count`, `sum_seat_capacity` (shared seats, after defaults).

```csv
source_trip_id,source_product_id,tidegrid_boat_id,local_date,local_start_time,time_zone,utc_offset,seat_capacity
T-0412-AM,P-REEF2,00000000-0000-4000-8000-000000000201,2027-04-12,08:00,America/New_York,,12
T-0412-PM,P-CHARTER4,00000000-0000-4000-8000-000000000202,2027-04-12,13:00,America/New_York,,
T-0413-AM,P-REEF2,00000000-0000-4000-8000-000000000201,2027-04-13,08:00,America/New_York,,12
```

## customers.csv

Named customers who book or hold a balance. Personal data: shown to the operator, never written to audit rows, events, logs, or the error report's `value` column.

| Column | Type | Required | Rule |
|---|---|---|---|
| `source_customer_id` | id | Yes | The legacy customer id |
| `full_name` | text(120) | Yes | |
| `email` | email | No | Needed for confirmations and the management link. A customer with no email can be imported but gets no email |
| `phone` | phone | No | Contact data only. No SMS consent is imported; consent is collected in TideGrid |

- **Deduplication key:** `source_system` + `source_customer_id`.
- **Matching:** see [customer matching](#rules-for-every-file). Two rows in one batch with the same email are both imported and both flagged `customer_match_candidate`.
- **Control totals:** `row_count`, `rows_with_email`.

```csv
source_customer_id,full_name,email,phone
C-1001,Avery Sample,avery.sample@example.test,
C-1002,Blake Synthetic,blake.synthetic@example.test,+15555550142
C-1003,Casey Placeholder,,
C-1004,Devon Fixture,devon.fixture@example.test,
```

## bookings.csv

Future confirmed bookings only. Canceled and past bookings are not imported.

| Column | Type | Required | Rule |
|---|---|---|---|
| `source_booking_ref` | id | Yes | The legacy confirmation reference |
| `trip_date` | date | Yes | Must equal the trip's `local_date` (`trip_date_mismatch`) |
| `source_trip_id` | id | Yes | A row in `trips.csv` |
| `source_customer_id` | id | Yes | The booker, a row in `customers.csv` |
| `booking_source` | enum | Yes | `direct`, `staff_assisted`, or `ota` |
| `staff_channel` | enum | With `staff_assisted` | `phone`, `email`, or `walk_up`. Required for `staff_assisted` and refused for any other source (`staff_channel_required`, `staff_channel_not_allowed`), as the schema requires a channel exactly when the source is staff-assisted |
| `ota_channel` | text(80) | With `ota` | The OTA's name, shown with the external reference |
| `party_size` | int | Yes | 1 to 500, within the product's party limits |
| `subtotal_cents` | cents | Not with `ota` | Trip price and add-ons before discounts |
| `discount_cents` | cents | Not with `ota` | Not above the subtotal |
| `fee_cents` | cents | Not with `ota` | Mandatory operator fees |
| `tax_cents` | cents | Not with `ota` | Taxes added to the price |
| `included_tax_cents` | cents | Not with `ota` | Tax already inside a tax-inclusive price; `0` when none. Not above subtotal minus discount. It does not change the total |
| `total_cents` | cents | Not with `ota` | Must equal subtotal minus discount plus fee plus tax (`amounts_do_not_add_up`), as the schema's order check does |
| `balance_due_date` | date | When a balance is outstanding | Private charters only |
| `booked_at` | timestamp | No | When the legacy system took the booking; not after `exported_at` (`later_than_export`) |

- **OTA rows** carry no amounts (`ota_amounts_present` otherwise). OTA money, refunds, and changes stay with the OTA, and the booking is a capacity and roster shadow outside the fee base.
- **Direct and staff-assisted rows** enter the fee base on the same terms as a TideGrid-created booking. Every amount is labeled as an imported opening record, never as a TideGrid Stripe charge.
- **Capacity.** For each trip, confirmed TideGrid seats plus seats in open capacity holds plus newly imported party sizes must fit the seat capacity (`over_capacity`). A private-charter trip takes one booking (`charter_already_booked`), counting open holds too. A booking already imported by an earlier batch is in those confirmed seats once and is never added again. An import never overbooks; the operator resolves an overbooked legacy trip before cutover.
- **Import capacity path (proposed; amends the shared hold trigger).** Checkout's path cannot carry an import. The trigger `capacity_holds_rules` runs `app.check_capacity_hold` (`0006`) before every insert and update on a hold, for every role. On insert it refuses any state but `active`. It always runs the on-sale checks: the trip and product are published, the booking cutoff has not passed, and the party fits the product's minimum and maximum and the trip's seat capacity. It also requires the hold to expire after now, within an hour, and no later than departure. A trip the batch creates starts in `draft`, and an imported booking may sit inside its trip's cutoff, because it was sold before cutover. So a new function in schema `app` is not enough. The G2.13 migration must amend `app.check_capacity_hold`, or replace it, with an import-only branch. That is a change to the shared capacity invariant, which the register calls [the most reviewed rule in the build](../06-decision-register.md#owner-decision-2026-11-08-g212d-manual-booking-narrowings-coordinator-defaults-2026-10-28). Proposed rules for the branch:
  - It is reachable only through an import function in schema `app` during a batch commit. Checkout cannot take it by naming an import owner.
  - It takes the same trip row lock as the hold trigger (`FOR NO KEY UPDATE`), so imports and guest checkouts on one trip queue behind each other.
  - It counts the same active and confirmed holds and applies the same capacity, kind, and whole-boat rules.
  - It refuses a canceled trip, and a trip whose start instant is at or before the commit time (`trip_departed`).
  - It inserts each imported booking's seats directly as a confirmed hold owned by the import.
  - It skips the on-sale checks (published state and booking cutoff) and checkout's one-hour expiry window. The hold's expiry is set to the departure instant, which still falls after now and no later than departure.
  - It keeps the party check: the product's minimum and maximum and the trip's seat capacity. The same check is also a row check in the dry run and the commit.

  Until that migration exists, nothing can commit an imported booking.
- **Deduplication key (D1, coordinator default):** `source_system` + `source_booking_ref` + `trip_date`. The trip date guards against legacy systems that reuse short references across seasons.
- **Control totals:** `row_count`, `sum_party_size`, `rows_direct`, `rows_staff_assisted`, `rows_ota`, `sum_total_cents`, `sum_included_tax_cents` (both direct and staff-assisted only).

```csv
source_booking_ref,trip_date,source_trip_id,source_customer_id,booking_source,staff_channel,ota_channel,party_size,subtotal_cents,discount_cents,fee_cents,tax_cents,included_tax_cents,total_cents,balance_due_date,booked_at
LB-5001,2027-04-12,T-0412-AM,C-1001,direct,,,2,30000,0,1000,2100,0,33100,,2027-01-05T14:22:00-05:00
LB-5002,2027-04-12,T-0412-AM,C-1002,staff_assisted,phone,,3,45000,4500,1500,2835,0,44835,,2027-01-19T11:05:00-05:00
LB-5003,2027-04-12,T-0412-PM,C-1004,direct,,,6,120000,0,0,8400,0,128400,2027-04-05,2027-02-10T09:00:00-05:00
LB-5004,2027-04-13,T-0413-AM,C-1003,ota,,Example OTA,2,,,,,,,,2027-02-20T18:30:00-05:00
```

## participants.csv

Named people in a booking's party, with allowed non-medical details only. The columns mirror the schema's participant row.

| Column | Type | Required | Rule |
|---|---|---|---|
| `source_booking_ref` | id | Yes | With `trip_date`, a row in `bookings.csv` |
| `trip_date` | date | Yes | |
| `position` | int | Yes | 1 to the booking's party size (`position_out_of_range`) |
| `full_name` | text(120) | Yes | |
| `is_minor` | bool | Yes | |
| `email` | email | No | The participant's own address. Never copied from the booker |
| `guardian_name` | text(120) | With a minor | Required for a minor, refused for an adult (`guardian_required`, `guardian_not_allowed`) |
| `guardian_email` | email | With a minor | Same rule |

A booking may have fewer participant rows than its party size. Missing positions show as roster exceptions after import, as they do for a new booking. An adult without an email is a `participant_email_missing` warning, because the waiver request cannot reach them by email.

- **Deduplication key:** `source_system` + `source_booking_ref` + `trip_date` + `position`.
- **Control totals:** `row_count`, `rows_minor`.

```csv
source_booking_ref,trip_date,position,full_name,is_minor,email,guardian_name,guardian_email
LB-5001,2027-04-12,1,Avery Sample,false,avery.sample@example.test,,
LB-5001,2027-04-12,2,Riley Sample,true,,Avery Sample,avery.sample@example.test
LB-5002,2027-04-12,1,Blake Synthetic,false,blake.synthetic@example.test,,
LB-5002,2027-04-12,2,Jordan Synthetic,false,,,
LB-5003,2027-04-12,1,Devon Fixture,false,devon.fixture@example.test,,
```

## payments.csv

External payment and refund records against imported direct and staff-assisted bookings. **D2, coordinator default:** each row is recorded as external tender, the way staff record cash or a check. The import creates no Stripe object, calls no provider, and moves or refunds no money. A legacy card payment is `card_outside_tidegrid`.

| Column | Type | Required | Rule |
|---|---|---|---|
| `source_payment_id` | id | Yes | The legacy payment or refund id |
| `source_booking_ref` | id | Yes | With `trip_date`, a non-OTA row in `bookings.csv` (`payment_on_ota_booking`) |
| `trip_date` | date | Yes | |
| `entry_kind` | enum | Yes | `payment` or `refund` |
| `amount_cents` | cents | Yes | At least 1 |
| `tender` | enum | Yes | `cash`, `check`, `card_outside_tidegrid`, `bank_transfer`, or `other` |
| `reference` | text(64) | No | The external reference shown to staff. Never a card number |
| `received_at` | timestamp | Yes | When the money moved; not after `exported_at` (`later_than_export`) |

For each booking, payments minus refunds must not exceed the total (`overpaid`), and must not be negative: a refund can never exceed the payments recorded for that booking (`refund_exceeds_payments`). Refunds may not exceed the booking's total either (`refunds_exceed_total`), because TideGrid caps a booking's refunds at what it cost; an overpayment and its refund are netted out of the export instead. Both sums count this batch's rows and the rows imported for that booking in earlier batches. What remains is the outstanding balance. A private charter with a balance needs a `balance_due_date`, before the trip's date (`balance_due_after_trip`); the balance falls due at the end of that local date. A charter that still owes may not carry a refund (`refund_with_balance`): net the refund out of its payments in the export. Money staff have recorded in TideGrid since an earlier batch counts toward these checks too. A shared-seat booking with a balance is refused as `unexpected_balance`, because the scope's deposit and balance flow belongs to private charters (proposed; see [open questions](#open-questions-for-the-owner)).

- **Deduplication key:** `source_system` + `source_payment_id`.
- **Control totals:** `row_count`, `sum_payment_cents`, `sum_refund_cents`, `sum_outstanding_cents` (over every non-OTA booking in the batch, after payments from earlier batches). The dry run and the commit also check, per booking, that total equals payments minus refunds plus outstanding.

```csv
source_payment_id,source_booking_ref,trip_date,entry_kind,amount_cents,tender,reference,received_at
PAY-9001,LB-5001,2027-04-12,payment,33100,card_outside_tidegrid,LEGACY-AUTH-7781,2027-01-05T14:23:10-05:00
PAY-9002,LB-5002,2027-04-12,payment,44835,cash,,2027-02-25T10:00:00-05:00
PAY-9003,LB-5003,2027-04-12,payment,40000,check,CHK-1042,2027-02-10T09:05:00-05:00
```

`LB-5003` keeps an outstanding balance of 88400 cents, due 2027-04-05.

## opening_balances.csv

Active named-customer balances, one row per lot. Each row is an opening record, labeled as imported, with no payment attached.

| Column | Type | Required | Rule |
|---|---|---|---|
| `source_balance_id` | id | Yes | The legacy balance or lot id |
| `source_customer_id` | id | Yes | A row in `customers.csv` |
| `balance_kind` | enum | Yes | `booking_credit`, `dollar_card`, or `trip_count_card` |
| `lot_kind` | enum | With `dollar_card` | `purchased`, `cancellation_credit`, or `promotional`, kept as separate source lots |
| `amount_cents` | cents | Not with `trip_count_card` | At least 1 |
| `units` | int | With `trip_count_card` | Whole trips, 1 to 100 |
| `eligible_source_product_ids` | text | No | Legacy product ids from `products.csv`, separated by `\|`; empty means every product |
| `expires_on` | date | No | Empty means no expiry, which the scope allows for every balance kind. A given date must be a valid date, and not earlier than the operator-local date of the check: the dry run's date, and again the commit's date (`balance_expired` otherwise). A balance that expires on the commit date itself is still imported |
| `source_card_ref` | id | No | The legacy card code, kept as a reference. TideGrid issues its own card; the legacy code redeems nothing |

- Trip-card rows are refused as `module_disabled` unless the trip cards module is enabled for the operator.
- A booking credit is kept under the email its customer books with, so its customer needs an email (`credit_needs_email`). TideGrid credit applies to every trip and never expires during the pilot: a credit limited to some products is refused (`credit_restriction_unsupported`), and a future expiry date is dropped with a warning (`credit_never_expires`).
- A balance that must be rebuilt from transaction history, rather than read as a current lot, is not standard import. See [custom work](#what-counts-as-custom-work).
- **Deduplication key:** `source_system` + `source_balance_id`.
- **Control totals:** `row_count`, `sum_booking_credit_cents`, `sum_dollar_card_cents`, `sum_trip_count_units`.

```csv
source_balance_id,source_customer_id,balance_kind,lot_kind,amount_cents,units,eligible_source_product_ids,expires_on,source_card_ref
OB-0001,C-1001,booking_credit,,5000,,,2027-12-31,
OB-0002,C-1002,dollar_card,purchased,25000,,,2028-01-31,GC-LEG-3301
OB-0003,C-1004,trip_count_card,,,5,P-REEF2,2027-12-31,TC-LEG-0207
```

## waivers.csv

Legacy waiver status, for information only. A status row never marks a TideGrid waiver signed, creates evidence, or skips a request. Each imported booking whose product requires a waiver gets the normal TideGrid waiver requests, as every booking source does. The manifest's `waiver_notifications` decides whether those requests are emailed at cutover or held until staff release them. (Built in part D2: the cron sends that email after the save, at most 100 per operator a run, and an owner releases a held batch through `POST /v1/staff/tenants/{tenantId}/import-runs/{runId}/waiver-email`.) The legacy status shows to staff beside the TideGrid status, labeled as legacy (built in part D1: owners and booking staff see it on the booking's Waivers card; guests never do).

| Column | Type | Required | Rule |
|---|---|---|---|
| `source_booking_ref` | id | Yes | With `trip_date` and `position`, a row in `participants.csv` |
| `trip_date` | date | Yes | |
| `position` | int | Yes | |
| `legacy_status` | enum | Yes | `signed`, `unsigned`, or `unknown` |
| `legacy_signed_on` | date | No | Only with `signed` |
| `legacy_system` | text(80) | No | The legacy waiver tool's name |

- **Deduplication key:** `source_system` + `source_booking_ref` + `trip_date` + `position`.
- **Control totals:** `row_count`, `rows_signed`, `rows_unsigned`, `rows_unknown`.

```csv
source_booking_ref,trip_date,position,legacy_status,legacy_signed_on,legacy_system
LB-5001,2027-04-12,1,signed,2027-01-06,Example Waiver Tool
LB-5001,2027-04-12,2,signed,2027-01-06,Example Waiver Tool
LB-5002,2027-04-12,1,unsigned,,
LB-5003,2027-04-12,1,unknown,,
```

## Sample manifest and error report

The manifest for the synthetic batch above. Its totals match the samples.

```csv
item,file,value
batch_id,,DH-2027-03-A
run_number,,1
source_system,,legacy-booker
mapping_version,,std-csv-v0
batch_mode,,dry_run
operator_time_zone,,America/New_York
exported_at,,2027-03-01T17:00:00-05:00
waiver_notifications,,hold_until_staff_release
row_count,products.csv,2
row_count,trips.csv,3
sum_seat_capacity,trips.csv,24
row_count,customers.csv,4
rows_with_email,customers.csv,3
row_count,bookings.csv,4
sum_party_size,bookings.csv,13
rows_direct,bookings.csv,2
rows_staff_assisted,bookings.csv,1
rows_ota,bookings.csv,1
sum_total_cents,bookings.csv,206335
sum_included_tax_cents,bookings.csv,0
row_count,participants.csv,5
rows_minor,participants.csv,1
row_count,payments.csv,3
sum_payment_cents,payments.csv,117935
sum_refund_cents,payments.csv,0
sum_outstanding_cents,payments.csv,88400
row_count,opening_balances.csv,3
sum_booking_credit_cents,opening_balances.csv,5000
sum_dollar_card_cents,opening_balances.csv,25000
sum_trip_count_units,opening_balances.csv,5
row_count,waivers.csv,4
rows_signed,waivers.csv,2
rows_unsigned,waivers.csv,1
rows_unknown,waivers.csv,1
```

A synthetic error report for a different, faulty batch:

```csv
batch_id,run_number,file,line,record_key,column,code,severity,message,value
DH-2027-03-B,2,trips.csv,5,legacy-booker|T-0314-EARLY,local_start_time,nonexistent_local_time,error,02:30 does not exist on 2027-03-14 in America/New_York.,02:30
DH-2027-03-B,2,bookings.csv,7,legacy-booker|LB-5010|2027-04-12,party_size,over_capacity,error,Trip T-0412-AM would hold 14 guests against 12 seats.,9
DH-2027-03-B,2,payments.csv,3,legacy-booker|PAY-9010,reference,possible_card_number,error,The reference looks like a card number and was not stored.,[withheld]
DH-2027-03-B,2,participants.csv,5,legacy-booker|LB-5002|2027-04-12|2,email,participant_email_missing,warning,This adult has no email for the waiver request.,[withheld]
DH-2027-03-B,2,manifest.csv,,,sum_total_cents,control_total_mismatch,error,Declared 206335; accepted rows total 173235.,206335
```

## What counts as custom work

Proposed boundaries, pending the owner's approval. They narrow the [Managed Launch](../03-commercial-model.md#managed-launch) and [custom work](../03-commercial-model.md#pass-through-costs-and-custom-work) rules already adopted; they change no price.

**Self-setup ($0).** The operator gets these templates, this definition, the dry run, and its error report. An operator who supplies a clean batch pays nothing. TideGrid does not clean or reshape data.

**Inside Managed Launch (one standard CSV import).**

- One source system, one brand, one location, one time zone.
- Walking the operator through the templates and reviewing one mapping of legacy products to TideGrid products.
- Renaming columns and changing formats on the operator's own export, when that is mechanical: dates to `YYYY-MM-DD`, dollars to cents, enum labels to the listed values.
- Up to three dry runs of the same batch, the commit, and one final delta batch at cutover for bookings and payments taken during the freeze. Three dry runs is a proposed number.
- Explaining the error report and the control totals, and recording the operator's signed reconciliation.
- Proposed budget: the import's share of Managed Launch targets two of the four target hours. Time beyond the eight-hour ceiling needs a written quote first, as the commercial model already says.

**Custom work (statement of work or $175 an hour; complex migration or trip-card reconciliation from $2,500).**

- Cleaning data: merging duplicate customers, fixing wrong amounts, splitting combined name fields, inventing missing references.
- Reconstructing balances, outstanding amounts, or trip-card units from transaction history instead of reading current values.
- Reconciling trip cards or credits whose legacy totals do not match the declared control totals.
- A second full batch after the commit, other than the one final delta. This is the commercial model's "repeated imports".
- Exports that are not CSV (spreadsheets with several sheets, PDFs, screenshots), or data pulled from a legacy system's API.
- More than one source system, location, brand, or time zone.
- Past or canceled bookings, full accounting history, old message threads, and legacy waiver documents or signatures. Bulk migration of waiver evidence is outside the standard pilot.
- Resolving legacy overbookings beyond reporting them.
- Custom reports, extra columns, or a mapping that keeps legacy-only fields.

**Not offered at any price during the pilot.** Live two-way OTA synchronization, raw card data, medical or certification data, and any import that needs a customer-specific code path.

## Schema gaps observed

The import must map to the current schema, which cannot yet hold most of it. These are inputs to the G2.13 build, not changes made here. Observed at `8f2d485`:

- A booking requires a checkout session, an order, a payment, and a capacity hold, all non-null (`0007`). An imported booking has none of them.
- A booking's source is `direct` or `staff_assisted` (`0012`). There is no `ota` or imported source, and no external reference column.
- A payment's provider is `fake` or `stripe` (`0007`). There is no external-tender record.
- There is no customer table. The booker's name and email live on the checkout session.
- There are no tables for booking credits, dollar cards, or trip-count cards.
- There is no import batch, source system, external id, mapping version, or deduplication key on any table.
- There is no place for a legacy waiver status.
- A new trip can start only as `draft` or `published` (`0003`). The import creates unpublished trips in `draft`, and the hold trigger refuses any hold on a `draft` trip (`0006`).
- A staff-assisted booking must carry a channel, and only a staff-assisted booking may (`0012`). The import requires `staff_channel` on exactly those rows.
- An order carries `included_tax_amount` (`0007`). The import fills it from `included_tax_cents`.
- A capacity hold's owner is an opaque reference (`0006`), so an import could own a hold. But the trigger `capacity_holds_rules` runs `app.check_capacity_hold` before every insert and update, for every role. On insert it refuses any state but `active`. It always checks that the trip and product are published, that the booking cutoff has not passed, and that the party fits the product's limits and the trip's seat capacity. It requires the hold to expire after now, within an hour, and no later than departure. An import of a `draft` trip, or of a booking inside its trip's cutoff, cannot take a hold today. A new function in schema `app` alone cannot change that. The proposed [import capacity path](#bookingscsv) needs a G2.13 migration that amends `app.check_capacity_hold`, or replaces it, with an import-only branch. The branch keeps the trip lock, the capacity count, and the party check. It skips the on-sale checks and checkout's one-hour expiry window, only for a batch commit. This changes the shared capacity invariant. The link from a hold to an imported booking is covered by the first gap above.
- The console's day export writes money as decimals; the import takes cents. The two never meet, but staff will see both.

## Open questions for the owner

Each needs an owner decision recorded in the register before this draft can be promoted.

1. Approve, change, or reject the files, columns, types, and required fields.
2. Confirm D1: the booking deduplication key is the source system reference plus the trip date.
3. Confirm D2: imported payments are external tender, with no Stripe objects.
4. Approve the control totals and the rule that any mismatch blocks the commit.
5. Approve the custom-work boundary, including the proposed three dry runs, one final delta, and the two-hour import share of the Managed Launch target.
6. Complimentary future bookings are not in the scope's import list. Keep them out of the standard import, so staff enter them after cutover, or add them?
7. Shared-seat bookings with an outstanding balance are refused. Keep that, or allow them?
8. Fee treatment of imported opening balances. An imported trip-count card or dollar-card balance was sold before TideGrid; whether its later redemption enters the fee base is a commercial question the [fee base](../03-commercial-model.md#net-managed-booking-value) does not answer for imported lots.
9. The default for `waiver_notifications`, and whether it may differ by booking.
10. Whether the error report may ever show personal values to the operator, or always withholds them.
11. Whether a trip card or dollar card must carry an expiry date on import. The draft makes it optional, as the scope does.
12. Approve the proposed import capacity path. It amends the shared hold trigger, `app.check_capacity_hold`, with an import-only branch, so it changes the capacity invariant every booking path relies on. A commit may then confirm imported seats on a `draft` trip or inside a trip's booking cutoff, without checkout's one-hour expiry window. It keeps checkout's trip lock, the capacity count, the party check against the product's limits and the trip's seat capacity, and the refusal of a canceled or departed trip. The alternative leaves the trigger alone and requires every trip to be published and outside its cutoff at commit. That refuses bookings for the next day's departures at cutover, and still needs a way to insert a confirmed hold.
