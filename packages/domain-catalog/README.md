# @tidegrid/domain-catalog

Locations, boats, products, seasonal schedules, scheduled trips, blackouts, and the availability query for the demo build (goal G2.4 in the [demo build plan](../../docs/v2/12-demo-build-plan.md)). The design authority is [product scope: catalog, schedules, and availability](../../docs/v2/02-product-scope.md#catalog-schedules-and-availability), [the target architecture](../../docs/v2/04-architecture.md#catalog-boats-schedules-and-availability), and [ADR 0016](../../docs/v1/adr/0016-time-zones.md). Tables are in migration `0003_catalog_and_schedule.sql` and follow the [tenancy contract](../database/README.md).

## Time

- A trip stores its IANA zone, local date and start time, resolved UTC start and end, and the offset at each end. The database refuses a row whose local time, UTC instant, and offsets disagree under its own zone data, or whose zone is not its location's.
- `time.ts` resolves a local time against the runtime's zone data. A time in a spring-forward gap does not exist and is never shifted. A time in a fall-back overlap is ambiguous and needs an explicit `earlier` or `later` choice on the schedule; the default, `reject`, skips it.
- A trip's end is its start plus its duration in elapsed minutes, so a trip that crosses a clock change keeps its real length.
- Local dates are the operator's calendar at the trip's location. Queries filter on them, so a guest asking for November 1 gets the trips that depart on November 1 locally.
- The booking cutoff is elapsed minutes before departure. Sales close at `startsAt - cutoff`, an exact instant, on either side of a clock change.
- Time columns are a snapshot. The runtime cannot update them; retiming a trip means a new trip. A change to the zone database never silently moves a sold departure.

## Schedules and generation

- A schedule is a seasonal pattern: listed weekdays between two dates, at one or more local departure times, in the zone of the product's location, captured when the schedule is created.
- `expandSchedule` is pure. `generateTrips` stores its output for an inclusive range of at most 93 days. It is idempotent: one departure exists per product, boat, and instant, and an existing departure is never changed, so a canceled departure is not revived.
- Generation skips, and lists, departures that do not exist, departures that are ambiguous with no choice, and departures that overlap a blackout.

## Sales states

- Stored states are draft, published, closed, canceled, and completed. Draft can become published or canceled. Published and closed can move to each other, to canceled, or to completed after departure. Canceled and completed are final. The service and a database trigger enforce the same rules.
- Sold out is not stored. It is capacity reaching zero, which the availability response reports. Delayed belongs to trip changes, which the demo defers.

## Availability

A trip is bookable when:

- it and its product are published, and its location and boat are active;
- sales have not closed;
- the party size is within the product's limits and the trip's capacity;
- and no blackout overlaps it.

A blackout is whole local days for the tenant, a location, a product, or a boat; the last is an operator block. Generation skips blackout days, and availability hides existing trips a later blackout covers without canceling them. Staff see every trip with a `blackedOut` flag.

Capacity is the trip's seat count until holds and bookings exist. G2.6 subtracts held and confirmed seats and treats a private charter as taking the whole boat; `capacityOf` in `catalog.ts` is the seam it replaces.

## Deferred

- Ticket types, prices, fees, taxes, and cancellation policy, including the change cutoff, arrive with G2.5, and the publish check grows with them.
- Partial-day operator blocks are deferred. A single departure is blocked by closing it.
- Staff endpoints that create locations, boats, products, schedules, and blackouts arrive with the console goal. Until then the seed and tests use the setup commands in `setup.ts`, which apply the same validation and audit.
