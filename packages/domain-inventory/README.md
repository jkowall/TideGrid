# @tidegrid/domain-inventory

Seat and whole-boat capacity, and the holds that reserve it, for the demo build (goal G2.6 in the [demo build plan](../../docs/v2/12-demo-build-plan.md)). The design authority is [product scope: catalog, schedules, and availability](../../docs/v2/02-product-scope.md#catalog-schedules-and-availability), the [shared acceptance rules](../../docs/v2/02-product-scope.md#shared-acceptance-rules), and the retained invariants in [the target architecture](../../docs/v2/04-architecture.md#retained-invariants). The table and its rules are in the capacity and holds migration (`migrations/*_capacity_and_holds.sql`) and follow the [tenancy contract](../database/README.md).

The name is inventory, not booking, because a hold reserves inventory for whoever needs it: a checkout session now, a staff booking or a reschedule later. Checkout, orders, payments, and bookings belong to G2.7 and call this module. Pooled-equipment holds, a staged module, share the same lifecycle and can join this package when they arrive.

## Model

- A **capacity hold** reserves capacity on one scheduled trip for one **owner**.
- The owner is an opaque reference, `<owner type>:<id>`, such as `checkout_session:<uuid>`. This module never interprets it. One owner has at most one hold per trip, ever.
- On a shared-seat trip a hold is kind `seats` and takes seats equal to its party size.
- On a private charter a hold is kind `whole_boat` and takes every seat on the trip, whatever its party size. One live charter hold leaves nothing for anyone else, so a charter trip takes exactly one whole-boat hold. The demo schedules a slot as shared seats or as a charter, never both ([boat inventory narrowing](../../docs/v2/12-demo-build-plan.md#goal-sequence)), so the two kinds never compete for one trip.
- The database sets the kind and the seats taken from the trip's product. The caller gives the party size.

States move one way:

| From | To | When |
|---|---|---|
| (new) | active | Acquired, with an expiry instant |
| active | confirmed | Confirmed within its time |
| active | released | Released by its owner |
| active | expired | Its expiry instant passed (sweep or lazy expiry) |
| expired | confirmed | Reacquired: a late payment, with room and the trip still on sale |
| confirmed | released | A confirmed booking gives its capacity back |

Released is final. Nothing returns to active.

## Invariants

The database enforces these for every role, the table owner included, in the capacity and holds migration:

1. For every trip, the seats of its holds in state active or confirmed never exceed the trip's seat capacity. This is a rule over stored states, not over time.
2. At most one active or confirmed whole-boat hold per trip. A partial unique index enforces this even without the trigger.
3. A new hold starts active, on a published trip of a published product, before the booking cutoff, with a party the product allows and the trip can seat. It expires after now, within one hour, and no later than departure.
4. A reacquired hold (expired to confirmed) passes rule 3's sales checks again, still has the kind and seats a new hold on the trip would take, and passes rule 1. A hold whose charter was resized, or whose trip's product or product kind changed, while it was expired is refused, because its seats never change.
5. Nothing moves into a counted state on a canceled trip.
6. A hold is marked expired only once its expiry instant has passed. An active hold past its instant is never confirmed directly; it is reacquired.
7. Trip, owner, kind, party size, seats, and creation time never change. The expiry instant can move earlier, never later, so it stays within the hour after acquisition and no later than the departure rule 3 checked it against. The trigger sets the kind, the seats, and every timestamp but the expiry instant, which the writer gives at insert.
8. No role deletes or truncates holds. The runtime may update `state` only.
9. Tenancy: forced row-level security, a composite foreign key to the trip, and explicit tenant filters.
10. The trip side of rule 1: no role can shrink a trip below the seats its holds take, change the product its holds came from, or resize a charter that a whole-boat hold has taken. The runtime cannot change either column at all.

The service adds what availability checks and the database does not: an active location and boat, and no blackout over the trip.

A hold whose expiry instant has passed stops counting at once for every read, and the service marks it expired before it counts capacity. So an expired hold never blocks a new one, and correctness never depends on the sweep.

## Why a row lock and a count

Three designs were weighed.

- **Counter columns guarded by a CHECK.** A `seats_taken` counter on the trip with `CHECK (seats_taken <= seat_capacity)` is declarative and safe under any isolation level. But it is a second copy of the truth that every transition must keep in step, the runtime would need UPDATE on it or a definer trigger to maintain it, and a hold that passed its instant would keep counting until something decremented it. Expiry would then have to be written down before every count anyway.
- **An exclusion or unique constraint.** It cannot sum seats, and its predicate cannot mention the clock, so it cannot tell a hold past its instant from a live one. It fits the whole-boat rule only, and is used there as a backstop.
- **A per-trip row lock and a count (chosen).** A trigger on the holds table locks the trip's row (`FOR NO KEY UPDATE`), then counts the active and confirmed holds and refuses an insert or reacquisition that does not fit. Writers to one trip queue on the lock. The trigger function is VOLATILE, so under READ COMMITTED each of its statements takes a fresh snapshot and the count sees every hold committed while it waited. The holds themselves are the only source of truth. The cost is one indexed sum per acquisition over at most a few hundred live rows.

Rules the choice depends on:

- **READ COMMITTED only.** Under REPEATABLE READ or SERIALIZABLE the count would use the transaction's first snapshot: it could miss a hold committed while it waited, or still see seats released a moment ago. So every command refuses any other level before it decides anything, with `IsolationLevelError` (code 25000), and the trigger refuses a new or reacquired hold (SQLSTATE 25000) for writers that skip the service. Kysely and the API use the default, READ COMMITTED.
- **Expiry is written down before anyone relies on it.** The count is over stored states. The service marks a trip's due holds expired, under the trip lock, before it counts. Once one transaction has decided a hold expired, every later one sees the stored state, so no two transactions can disagree about a hold, whatever their clocks read.
- **The trigger takes the lock itself.** A writer that skips the service still queues and still counts. Such a writer changing a hold's state locks the hold row before the trigger locks the trip, the reverse of the service's order, so it can deadlock with a command; PostgreSQL then aborts one of them (40P01) and the invariant holds. Use the service.

## Clock

The database clock decides every expiry question: `now()`, the start of the transaction. Every statement in one command, and the trigger, read the same instant, so a check and the write it guards never straddle the expiry instant. Worker isolates never compare their own clocks. A transaction that waited for the lock reads an earlier instant, which only makes it slower to expire someone else's hold, never faster. Tests make time pass by moving a hold's `expires_at` earlier through the admin connection; the database refuses to move it later.

The availability listing keeps the request clock for its booking cutoff, as G2.4 built it, and the database clock for holds. They can disagree by the skew between a Worker and the database at the cutoff instant; acquisition, which uses the database clock for both, decides.

## Interface for checkout (G2.7)

Every command takes the caller's tenant transaction and context, writes its domain change, audit row, and outbox event in that transaction, and returns a result union instead of throwing for business outcomes. Programmer errors throw: a malformed owner reference (`TypeError`), a non-integer party size (`TypeError`), a lifetime outside 60 to 3600 seconds (`RangeError`), a malformed reason (`RangeError`), and a transaction above READ COMMITTED (`IsolationLevelError`, code 25000). A database refusal that the service did not predict propagates and rolls the caller back.

```ts
acquireHold(trx, ctx, { ownerRef, tripId, partySize, ttlSeconds }): Promise<
  | { kind: "acquired"; hold: Hold }
  | { kind: "existing"; hold: Hold }        // this owner already holds this trip; any state
  | { kind: "owner_conflict"; hold: Hold }  // same owner and trip, another party size
  | { kind: "trip_not_found" }
  | { kind: "not_bookable"; reason: "trip_canceled" | "trip_unavailable" | "sales_closed" | "party_size_out_of_range" }
  | { kind: "insufficient_capacity"; remaining: number }
>

confirmHold(trx, ctx, { holdId, ownerRef }): Promise<
  | { kind: "confirmed"; hold: Hold; reacquired: boolean }
  | { kind: "already_confirmed"; hold: Hold }
  | { kind: "capacity_lost"; hold: Hold; reason: "no_capacity" | "trip_canceled" | "trip_unavailable" | "sales_closed" | "party_size_out_of_range" }
  | { kind: "released"; hold: Hold }
  | { kind: "not_found" }
>

releaseHold(trx, ctx, { holdId, ownerRef, reason? }): Promise<
  | { kind: "released"; hold: Hold; from: "active" | "confirmed" }
  | { kind: "unchanged"; hold: Hold }       // already released or expired
  | { kind: "not_found" }
>

getTripCapacity(trx, tenantId, tripId)   // { kind, total, held, confirmed, remaining, soldOut } or null
getHold(trx, tenantId, holdId)           // Hold or null
findHoldsByOwner(trx, tenantId, ownerRef)
listTripHolds(trx, tenantId, tripId)
expireDueHolds(trx, ctx, { limit })      // one tenant, for the sweep
sweepExpiredHolds(db, { runId, ... })    // every tenant, for the cron
```

`Hold` is `{ id, tripId, ownerRef, kind, partySize, seats, state, expiresAt, createdAt, confirmedAt, releasedAt, expiredAt }`, with instants as RFC 3339 strings.

Semantics checkout relies on:

- **Acquire is idempotent per owner and trip.** A replay returns the first hold in its current state, even if it has since been confirmed, released, or expired. Acquisition marks the trip's due holds expired before it looks, so a replay after the hold's instant reports `expired`, never a stale `active`. It never creates a second hold. A new attempt after an abandoned checkout needs a new owner reference.
- **The expiry is the database's:** now plus `ttlSeconds`, but never past departure. Read it from `hold.expiresAt` and give the checkout session the same instant.
- **Confirm within the hold's time** succeeds without counting again, because the hold was counted all along, unless the trip was canceled (`capacity_lost`, `trip_canceled`). A closed trip does not stop it: the checkout began before sales closed.
- **Confirm after the hold's time**, swept or not, reacquires: the hold is marked expired, then must find room on a trip still on sale, exactly like a new hold. If it does, the result is `confirmed` with `reacquired: true`. If not, the result is `capacity_lost` with the reason and nothing is confirmed. Checkout then refunds in full and raises an operator exception, as the architecture requires.
- **A changed trip loses a late payment.** The trip must still sell what the hold reserved. If the owner resized a charter, or changed the trip's product or that product's kind, while the hold was expired, the result is `capacity_lost` with `trip_unavailable`: the hold's seats never change, so it cannot become the hold the trip now takes.
- **Several holds all or nothing.** Confirm each in one transaction and roll the transaction back when any result is not `confirmed`, then record the exception and refund in a new transaction.
- **A late payment gets no priority.** Confirm reads the hold before it queues for the trip lock, so in a burst, acquisitions already queued go first and can take the seats a late payment needed. The test specialist saw late confirmations lose every race until the starts were staggered. If checkout wants paid guests to win, it needs its own policy, such as a shorter checkout window than the hold or a grace period before others may take the seats.
- **Release** gives back the capacity of an active or confirmed hold. Releasing a confirmed hold is how a canceled booking returns its seats.
- **Not found is opaque.** Another owner's hold, another tenant's hold, and a malformed id all answer `not_found`.

Lock order and isolation:

- A trip's row before any of its hold rows. Acquire, confirm, and release lock the trip first. The sweep locks hold rows only and skips locked ones, so it never waits on a checkout.
- A command that touches several trips should take them in a stable order, such as by trip id, or two checkouts can deadlock (PostgreSQL then aborts one with 40P01).
- Never hold a database lock across a provider call. Acquire, commit, then call the payment provider.
- The trip lock lasts until the caller commits, and every other checkout for that trip waits behind it. Acquire late in the transaction and commit promptly.
- READ COMMITTED, the default.

## Audit and events

Each transition appends one audit row (subject `capacity_hold`) and one outbox event in the same transaction. Events carry identifiers only: `{ holdId, tripId, ownerRef }`.

| Transition | Audit action | Outbox topic | Actor |
|---|---|---|---|
| acquire | `hold.acquired` | `inventory.hold.acquired` | the caller |
| confirm, including reacquisition | `hold.confirmed` (after state names `reacquired`) | `inventory.hold.confirmed` | the caller |
| release | `hold.released` (with the caller's reason) | `inventory.hold.released` | the caller |
| expire, lazily during a command | `hold.expired` | `inventory.hold.expired` | system `hold-expiry`, with the command's request id |
| expire, by the sweep | `hold.expired` | `inventory.hold.expired` | system `hold-sweep`, with the run id |

## Sweep

The API Worker's cron runs `sweepExpiredHolds` every 15 minutes. It asks `app.capacity_hold_sweep_tenants` for the tenants with due holds, a definer function that returns tenant ids and nothing else, then expires each tenant's holds inside that tenant's own transaction, in batches of 100, under row-level security. Concurrent or repeated runs are safe: `FOR UPDATE SKIP LOCKED` keeps runs from waiting on each other or on checkouts, and a hold moves to expired once. A tenant whose batch fails is reported and skipped; the next run retries it. The run stops starting batches after 20 seconds. The cron handler awaits the run, so a run that fails, after logging why, fails the cron invocation itself; a skipped tenant is logged and counted but does not. The security argument for the definer function is in the [database README](../database/README.md#capacity-holds).

The sweep is housekeeping and events, not correctness. Fifteen minutes keeps the Neon compute from waking every minute; G2.7 or the outbox delivery goal can shorten it when something needs prompt expiry events.

## Availability

`app.trip_capacity_usage(tenant, trip)` returns the seats held by holds still within their time and the seats confirmed. The catalog's availability query and `getTripCapacity` both read it, so the rule lives in one place.

- The public listing subtracts both from the trip's capacity and leaves out a trip without room for the party, sold out included. Its `capacity` gains `soldOut`, which is therefore false there.
- The staff listing shows every trip with `soldOut`, `held`, and `confirmed`.
- The new fields are optional in the contract only so earlier clients and test fixtures keep validating; the API always sends them.

## Not in this goal

- No public or staff endpoint acquires, confirms, or releases a hold. Checkout (G2.7) owns those commands and their idempotency keys.
- Canceling a trip leaves its holds as they are. Confirmation refuses a canceled trip, but a trip with confirmed holds can still be canceled; G2.7 or the cancellation goal must refuse that or route it through remedies, as the [catalog README](../domain-catalog/README.md#deferred-and-not-yet-reachable) already notes.
- No rate limit on holds per guest. A script could hold every seat for an hour at a time; checkout creation needs a limit before any public exposure.
- Holds are never deleted, so expired and released rows accumulate as history. The live indexes cover only active and confirmed rows.
- Creating a blackout or changing a product's sales status takes no trip lock, so a hold can be acquired at the same moment a blackout lands. It then behaves like any checkout already in progress: it confirms within its time. Sales-state changes on the trip itself do queue on the lock.

## Follow-ups

The independent review on 2026-10-05 accepted this goal with fixes, which are applied. It also noted these, which are not fixed here:

- **A product's kind can change under its holds.** Only the owner role can change `products.kind`; the runtime has no UPDATE on it. Nothing stops the owner from turning a shared-seat product into a charter, or back, while its trips have active or confirmed holds, and those holds keep the kind they were taken with. Reacquisition refuses the mismatch (rule 4); nothing else does. A later migration should refuse a kind change once a product has trips.
- **The staff holds read has no pagination.** `GET /v1/staff/tenants/{tenantId}/trips/{tripId}/holds` returns every hold of the trip in any state. Holds are never deleted, so a busy trip's list only grows. It needs a page size and a cursor before the console shows it.
- **Usage per listed trip.** Both trip listings call `app.trip_capacity_usage` once per trip through a lateral join. Each call is an indexed sum over one trip's live holds, but a listing can span 92 days. Watch its cost as tenants and holds grow; one grouped sum over the listed trips could replace the per-trip calls.
- **Quotes for a trip without room, once G2.5 lands.** Quote creation finds its trip through the availability listing for the product's smallest party. A trip with fewer seats left than that drops out of the listing: sold out, fully held, or any held charter. A quote for it answers 409 `trip_not_bookable`, not `insufficient_capacity`. A larger party on a trip that still has room for the smallest party gets `insufficient_capacity`. Checkout and the guest site should treat both as no longer available.

## Tests

- `pnpm --filter @tidegrid/domain-inventory test` runs unit tests.
- `pnpm --filter @tidegrid/domain-inventory test:integration` runs against a throwaway Neon branch with `TIDEGRID_EPHEMERAL_DB=1`, like every integration suite. `src/test-fixtures.ts` builds a tenant through the real catalog services and hands out unused trips.
