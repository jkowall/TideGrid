# @tidegrid/domain-catalog

Locations, boats, products, seasonal schedules, scheduled trips, blackouts, and the availability query for the demo build (goal G2.4 in the [demo build plan](../../docs/v2/12-demo-build-plan.md)). The design authority is [product scope: catalog, schedules, and availability](../../docs/v2/02-product-scope.md#catalog-schedules-and-availability), [the target architecture](../../docs/v2/04-architecture.md#catalog-boats-schedules-and-availability), and [ADR 0016](../../docs/v1/adr/0016-time-zones.md). Tables are in migration `0003_catalog_and_schedule.sql` and follow the [tenancy contract](../database/README.md).

## Time

- A trip stores its IANA zone, local date and start time, resolved UTC start and end, and the offset at each end. The database refuses a row whose local time, UTC instant, and offsets disagree under its own zone data, or whose zone is not its location's.
- Zones are geographic IANA names such as `America/New_York`, plus `UTC`, spelled exactly as the zone database lists them. POSIX forms and the `Etc/GMT` zones, in any case, are refused because they invert their sign.
- `time.ts` resolves a local time against the runtime's zone data. A time in a spring-forward gap does not exist and is never shifted. A time in a fall-back overlap is ambiguous and needs an explicit `earlier` or `later` choice on the schedule; the default, `reject`, skips it.
- A trip's end is its start plus its duration in elapsed minutes, so a trip that crosses a clock change keeps its real length.
- Local dates are the operator's calendar at the trip's location. Queries filter on them, so a guest asking for November 1 gets the trips that depart on November 1 locally.
- The booking cutoff is elapsed minutes before departure, read from the product when availability is asked. Sales close at `startsAt - cutoff`, an exact instant, on either side of a clock change. A later cutoff change applies to the remaining sales window of existing trips.
- Time columns are a snapshot. The runtime cannot update them; retiming a trip means a new trip.

### Two sources of zone data

The runtime (the ICU data in V8) resolves local times, and PostgreSQL checks them with its own zone data. The two ship separately and disagree for a while after a zone changes its rules. On 2026-09-30 they disagreed about Vancouver, Edmonton, Casablanca, and El Aaiun.

- Generation asks PostgreSQL about every departure before writing. A departure the two read differently is skipped and reported as `zone_data_mismatch`, and the rest of the range is written.
- Gap and overlap decisions come from the runtime first. When the sources disagree, a departure PostgreSQL considers ordinary can be skipped as `nonexistent_local_time` or `ambiguous_local_time` instead. Nothing wrong is stored either way.
- Blackout creation raises `ZoneDataMismatchError` instead of writing.
- Nothing is guessed. The fix is to update whichever side is behind.
- `zone-data.integration.test.ts` compares both sources for every accepted zone, daily for three years, including day boundaries on transition days. It fails on any drift outside its known list.
- Known gap: nothing re-checks stored trips after a zone data update, and ADR 0016 asks for an explicit regeneration policy. Until one exists, a stored trip keeps its snapshot, and a trip whose snapshot no longer matches current rules stays sellable.

## Schedules and generation

- A schedule is a seasonal pattern: listed weekdays between two dates, at one or more local departure times, in the zone of the product's location, captured when the schedule is created. A one-time trip is a one-day schedule, so every trip takes the same verified path.
- `expandSchedule` is pure. `generateTrips` stores its output for an inclusive range of at most 93 days. It is idempotent: one departure exists per product, boat, and instant, and an existing departure is never changed, so a canceled departure is not revived.
- Generation skips, and lists, departures that do not exist, departures that are ambiguous with no choice, departures that overlap a blackout, departures the two zone data sources read differently, and departures that would overlap another live trip on the boat.
- A run that creates nothing records no audit event.

### One departure per boat

A boat runs one departure at a time. Each trip holds its boat from departure until its end plus its product's turnaround buffer (`boat_free_at`). No two live trips on one boat may overlap, whatever their products. So a shared-seat trip and a private charter cannot both be scheduled on the same boat at the same time, and an operator schedules one product per slot. This is a demo narrowing recorded in the [demo build plan](../../docs/v2/12-demo-build-plan.md#goal-sequence), confirmed by the owner on 2026-10-01.

- Schedule creation refuses a day's departures that are closer than the trip plus its buffer (`departures_too_close`). It checks one day's clock times; departures that collide across midnight are skipped at generation instead.
- Generation skips a departure that would overlap another live trip on the boat (`boat_conflict`).
- A PostgreSQL exclusion constraint enforces the rule for every writer. If two requests race, the loser gets SQLSTATE 23P01, which the API returns as a retryable 409 `boat_schedule_conflict`.
- A canceled trip frees its boat.

## Sales states

- A trip starts as draft or published.
- Draft can become published or canceled.
- Published and closed can move to each other, to canceled, or to completed after departure.
- Canceled and completed are final.
- The service and a database trigger both enforce these rules, on insert and on update.
- Sold out is not stored. It is capacity reaching zero, which the availability response reports.
- Delayed belongs to trip changes, which the demo defers.

Publishing a product is checked by the service: an active location, an eligible active boat, a party size the boat can seat, and, since G2.5, a price list (`product_missing_price`) and a policy (`product_missing_policy`). The runtime can change a product's sales status, so the database does not repeat the location, boat, and capacity checks. It does repeat the last two: a trigger from migration 0005 refuses publishing without sale terms for every writer, and sale terms are append-only, so a published product keeps them.

## Availability

A trip is bookable when:

- it and its product are published, and its location and boat are active;
- sales have not closed;
- the party size is within the product's limits and the trip's capacity;
- and no blackout overlaps it.

A blackout is whole local days for the tenant, a location, a product, or a boat; the last is an operator block. Generation skips blackout days, and availability hides existing trips a later blackout covers without canceling them. Staff see every trip with a `blackedOut` flag.

Capacity left is the trip's seat count minus seats held by holds still within their time and confirmed seats, read from `app.trip_capacity_usage` by the database clock (G2.6, [inventory README](../domain-inventory/README.md#availability)). A whole-boat hold takes every seat. A guest listing leaves out a trip without room for the party; staff see every trip with `soldOut`, `held`, and `confirmed`. Only acquiring a hold decides; the listing is advisory.

## Deferred and not yet reachable

- Ticket types, prices, add-ons, fees, taxes, the promotion code, and the policy with its change cutoff live in [domain-pricing](../domain-pricing/README.md) since G2.5. Quotes price a trip only when the availability query above lists it.
- Partial-day operator blocks are deferred. A single departure is blocked by closing it.
- Browser access from tenant hostnames is deferred to G2.14b. `/v1/public/trips` resolves the tenant from the verified Origin, but the API's CORS allowlist is static configuration until G2.14b adds verified-origin CORS with its preflights. Until then a browser can call it only from a configured origin.
- Location contact details are deferred. A tenant's contact details belong to its brand configuration (G2.14a).
- Staff endpoints that create or change locations, boats, products, schedules, and blackouts arrive with the console goal. Until then the seed and tests use the setup commands in `setup.ts`, which apply the same validation and audit.
- The runtime has no UPDATE grant on locations, boats, schedules, or blackouts yet. Pausing a schedule, archiving a location, retiring a boat, or lifting a blackout therefore arrives with those endpoints. The code paths that honor those states are tested by changing them as the admin.
- Canceling a trip with bookings is refused since G2.7: `changeTripSalesState` answers `has_bookings` (409 `trip_has_bookings`) when the trip has confirmed holds, and a trigger in the checkout migration refuses the same change for every writer, until cancellation with remedies (G2.9, G2.11) routes it. Booking staff hold `trips.manage`. A trip with only active holds can still be canceled; a payment that succeeds for one of them is refunded.
