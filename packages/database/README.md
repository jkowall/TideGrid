# @tidegrid/database

PostgreSQL access for the TideGrid demo build: Kysely over postgres.js, reviewed SQL migrations, and the tenancy primitives every domain module uses. This file is the working contract for tenant isolation. The design authority is the [target architecture](../../docs/v2/04-architecture.md) and the retained V1 decisions on [tenancy](../../docs/v1/adr/0003-postgresql-tenancy.md), [row-level security](../../docs/v1/adr/0004-row-level-security.md), [outbox](../../docs/v1/adr/0008-transactional-outbox.md), and [audit](../../docs/v1/adr/0018-audit-log.md).

## Roles

- **Admin (the database owner; on Neon, the owner role).** Runs migrations and seeds. Bypasses row-level security. Never used by a Worker.
- **`tidegrid_app`.** The only role a Worker uses. Created in SQL by migration 0001 with no elevated attributes; never create it through the Neon console or API, because those roles join `neon_superuser` and bypass row-level security. It gets privileges only from migrations. The migration runner, before and after every run, and the password command (`pnpm --filter @tidegrid/database app-role:password`) refuse a `tidegrid_app` that is more than that plain role: any elevated attribute including REPLICATION, membership in any role (SET ROLE through a chain can reach one that bypasses row-level security), or ownership of any object. Neon accepts only plaintext passwords over its control plane, so the password is sent once over TLS.

## Tenant isolation rules

1. Every tenant-owned table has a `tenant_id` column, row-level security enabled and forced, and a `tenant_isolation` policy on `app.current_tenant_id()` for both reads and writes.
2. Every read or write of a tenant-owned table runs inside `inTenantTransaction`, which sets `app.tenant_id`, the actor, the request id, and the source address with `set_config(..., true)`. The settings are transaction-local, so a pooled connection never carries one request's tenant into the next.
3. Queries also filter by tenant explicitly. Row-level security is the backstop, not the mechanism.
4. Without context the runtime sees no tenant rows and can write none. A malformed tenant id raises instead of matching.
5. The runtime holds SELECT and INSERT by default. UPDATE is granted column by column in the migration that needs it. DELETE and TRUNCATE are never granted; state changes are appends or status updates.
6. Platform credential tables (`staff_login_tokens`, `staff_sessions`, `security_events`) grant the runtime nothing. It reaches them only through the SECURITY DEFINER functions in schema `app`.
7. Every function in schema `app` has EXECUTE revoked from PUBLIC. Every SECURITY DEFINER function pins `search_path = pg_catalog, pg_temp`, qualifies every relation, and filters explicitly because its owner bypasses row-level security.
8. The runtime cannot create objects anywhere: no CREATE on any schema and no TEMPORARY on the database.
9. Staff identities are global and their addresses are ASCII, so case folding cannot turn a lookalike character into someone else's address. A tenant reads an identity's id, email, status, and creation time only; the name a tenant shows lives on its own membership row, so no tenant can read or set what another tenant sees.
10. A reference from one tenant row to another includes `tenant_id` in a composite foreign key, as the catalog tables in 0003 do, so a row cannot point at another tenant's row even when application code passes the wrong id.

The integration suite enforces rules 1, 5, 6, 7, 8, and the column limits in rule 9 from the catalog, so a later migration that forgets them fails CI. The catalog suite checks rule 10 by trying cross-tenant references.

## Behavior by design, and known gaps

- `app.auth_list_memberships` returns the memberships of whatever user id it is given. The API passes only the authenticated principal's own id.
- A session-level `set_config(..., false)` would survive on a pooled connection. Nothing in the codebase does that, and `setTenantContext` refuses a connection that already carries a tenant.
- Disabling an identity hides its sessions while it stays disabled; re-enabling revives unexpired sessions. The disable flow, when it exists, must revoke them.
- Replayed idempotent responses are equal field for field, not byte for byte, because `jsonb` reorders keys. Keys are kept past `expires_at` until the outbox sweeper goal adds cleanup.
- Audit and outbox ids come from one sequence per table, so a tenant can infer overall platform volume from gaps. Acceptable for the demo; revisit before the pilot.
- A person added to a tenant becomes an active member without accepting an invitation. Acceptance is required before transactional email (G2.16) lets owners add real people.

## Commands, audit, idempotency, and outbox

A state-changing command follows one shape, all inside one tenant transaction:

1. Authorize (the API checks membership and permission first).
2. `claimIdempotencyKey` before any domain write. A concurrent duplicate blocks on the key until the first commits, then replays its stored response. A failed command rolls back its claim. The request hash covers the method, route template, every path id, and the body, so the same key sent for another resource is refused, never replayed.
3. Write domain state.
4. `recordAudit` with the action, subject, reason, and before and after values. Audit rows are append-only for every role, including the owner.
5. `enqueueOutbox` for any event other modules or providers need. The row exists only if the command commits.
6. `completeIdempotencyKey` with the successful response.

Keys are scoped by tenant, operation, and principal. Only successful responses are stored.

A read whose statements must agree with each other, such as a page and the counts beside it, passes `snapshotRead` as `inTenantTransaction`'s last argument (G2.12b): the transaction runs REPEATABLE READ and READ ONLY, so every statement sees the moment of the first and nothing can be written. The level is set before the tenant context, because PostgreSQL fixes it at the first statement. Commands keep the default READ COMMITTED, which their locking needs. `src/snapshot.integration.test.ts` holds this.

## Brand configuration

Migration 0004 adds two tenant-owned, append-only tables under rules 1 to 8:

- `brand_config_versions`: one row per published brand, keyed by tenant and a per-tenant version number, holding the brand contract's `BrandConfig` (`packages/contracts/src/brand.ts`) as bounded JSON with its schema version. Writers validate the config against the contract before insert.
- `brand_activations`: who made which version live, when, and why. Its foreign key includes `tenant_id`, so an activation can only name its own tenant's version. The tenant's latest activation (highest id) is its active brand.

The runtime holds SELECT and INSERT on both. UPDATE, DELETE, and TRUNCATE raise for every role, the owner included, so an old version never changes; returning to an earlier brand is a new activation. Publishing is one tenant transaction: insert the next version, insert its activation with a reason, and record an audit event.

The active brand is simply the highest activation id, and nothing in the schema serializes two publishes for the same tenant. Any publish command, today's seed or a future staff command, must therefore first take the per-tenant transaction lock the seed takes, `pg_advisory_xact_lock(hashtextextended('tidegrid.brand:' || tenant_id, 0))`, before reading the current version. Without it, two concurrent publishes can compute the same next version number (one fails on the unique key) or activate in the opposite order from the one their callers saw.

`app.resolve_public_brand(hostname)` is the public bootstrap. It resolves the hostname through `app.resolve_hostname`, so only active, verified hostnames of active tenants return a row, and joins that tenant's active brand, filtering by the resolved tenant explicitly. The brand columns are NULL until the tenant publishes one. The API validates the stored config against the contract again before serving it, and fails closed if it does not validate.

## Pricing, policies, and quotes

Migration 0005 adds ten tenant-owned tables under rules 1 to 10, described in the [pricing contract](../domain-pricing/README.md): `price_list_versions` and `price_list_items`, `policy_versions`, `tax_rate_versions`, `promotions`, `promotion_versions` and `promotion_version_products`, and `quotes`, `quote_lines`, and `quote_line_taxes`.

- **Append-only for every role.** The runtime holds SELECT and INSERT. UPDATE, DELETE, and TRUNCATE raise for everyone, the owner included. A change is a new version; the highest version is current.
- **Sealed children.** A price list version, promotion version, or quote records the transaction that created it (`created_txid`) and the database time it was written (`created_at`). A trigger stamps both, so no writer can choose them. Its items, products, lines, or line taxes can be written only by that transaction, savepoints included, so nothing grows after commit.
- **Checked when written and at commit.** When a quote is written, its trip snapshot must equal the trip it names, its party must be within the product's limits and the trip's seats, and it must be dated before the trip departs. Deferred constraint triggers, owner-run with explicit tenant filters, refuse at commit a shared-seat price list with no ticket type, a charter price list without its price, a quote whose header totals differ from its lines, and a quote its named versions do not produce: lines not copied from the price list version, missing fees, a promotion outside its window or rule or without its label, a discount split other than by the largest remainder, or taxes that do not follow their rates. `app.discount_label` gives the label the check expects; like every function in schema `app`, the runtime cannot call it.
- **Quote validity.** `quoted_at` and `expires_at` come from the writer, so they bound an honest quote only. Checkout must accept a quote only while `now() < least(expires_at, created_at + interval '30 minutes')` on the database clock, as the [pricing contract](../domain-pricing/README.md#quotes) says.
- **Kinds in keys.** `products` gains `UNIQUE (tenant_id, id, kind)` and `scheduled_trips` gains `UNIQUE (tenant_id, id, product_id)`, so a price list cannot carry the wrong product kind and a quote cannot pair a trip with another product.
- **Publishing.** A trigger on `products` refuses publishing a product without a price list and a policy, for every writer.
- **Actors.** A trigger stamps `actor_type`, `actor_id`, and `request_id` from the transaction's context on every version, promotion, and quote row, so no writer can name another actor. Version and promotion rows refuse the guest actor type through their `actor_type` check, so a guest may create quotes only.
- **Numbering.** Commands that append a version take a per-aggregate transaction lock, such as `tidegrid.price_list:<tenant>:<product>`, before reading the current version, as brand publishing does.

## Capacity holds

The capacity and holds migration adds `capacity_holds` under rules 1 to 10. The contract, the concurrency design, and the clock decision are in the [inventory README](../domain-inventory/README.md); what matters for tenancy:

- The runtime keeps the default SELECT and INSERT and may UPDATE `state` only. A trigger sets the kind, the seats taken, and every timestamp but the expiry instant, which can only move earlier. It enforces the one-way states and the capacity rule for every role, and refuses DELETE and TRUNCATE for every role, the owner included. A second trigger, on `scheduled_trips`, keeps a trip's capacity and product from changing under its holds.
- The trigger runs as the caller. It reads the trip under the caller's row-level security and filters by the hold's tenant, so a hold can never name another tenant's trip; the composite foreign key backs that up.
- `app.trip_capacity_usage(tenant, trip)` is an invoker function. Row-level security applies inside it, and it filters by tenant explicitly.

`app.capacity_hold_sweep_tenants(limit)` lets the cron sweep find the tenants with holds past their expiry instant. It was the first of the runtime's cross-tenant sweep reads, beside sign-in and hostname resolution; `app.checkout_sweep_tenants` (0007), `app.email_delivery_tenants` (0009), and `app.hostname_sweep_tenants` (0011) follow the same argument:

- It returns tenant ids and nothing else: no hold, trip, owner, or count. An id grants nothing. Every read and write that follows runs in `inTenantTransaction` under forced row-level security, and tenant ids already appear in staff URLs.
- What it reveals is that some tenant has at least one stale hold. That is a weaker activity signal than the shared audit and outbox id sequences already give (see the known gaps above).
- It is read-only and STABLE, a SECURITY DEFINER function with `search_path` pinned, every relation qualified, explicit predicates, and at most 1,000 rows. EXECUTE is granted to `tidegrid_app` only.
- The alternatives are worse. A row-level-security bypass for the cron's connection would expose every tenant's rows to one session. A tenant list in configuration drifts from the database and would silently skip new tenants. One definer function that expired holds across tenants would write audit and outbox rows outside any tenant's transaction.
- **Order.** Since 0013 each orders by its sweep's stamps (see [Sweep turns](#sweep-turns-0013)).

## Checkout, payments, and bookings

The checkout migration (0007) adds twelve tenant-owned tables under rules 1 to 10, described in the [checkout contract](../domain-booking/README.md) and the [payments contract](../domain-payments/README.md): `checkout_sessions`, `orders` and `order_lines`, `payments`, `payment_refunds`, `provider_events` (the inbox), `bookings`, `finalization_exceptions`, `payment_accounts`, and the fake provider's `fake_provider_payments`, `fake_provider_events`, and `fake_provider_refunds`.

- **Privileges.** The runtime keeps the default SELECT and INSERT, except on `payment_accounts`, which it may only read: onboarding (the seed) writes where money goes, never a request. UPDATE is granted only on the columns that carry a transition: `checkout_sessions.state`, `orders.status`, `payments` (`state`, `provider_payment_id`, and the two evidence columns), `payment_refunds` (`state`, `provider_refund_id`, `failure_code`), and `provider_events` (`processing_state`, `outcome`). Triggers stamp every time from the database clock.
- **No deletes.** DELETE and TRUNCATE raise on every table here for every role, the owner included. Order lines, bookings, exceptions, and the fake provider's tables refuse UPDATE too.
- **States and evidence for every role.** Triggers run as the writer, under its row-level security, and filter by tenant explicitly. They enforce the one-way states and the chain of custody: a checkout confirms only with a booking, a booking needs a succeeded payment and a confirmed hold, an order is paid only with a booking, and a payment succeeds only with a verified inbox event for its provider id, account, amount, and currency. The owner role cannot skip a link either.
- **Sealed and self-checking orders.** Order lines can be written only in their order's transaction, and a deferred check refuses at commit an order that does not equal its quote, line for line and tax rate for tax rate.
- **Composite keys.** Every reference carries `tenant_id`, including the inbox's reference to the connected account, so an event can be recorded only in the tenant that owns the account it names.
- **Trips with bookings.** A trigger on `scheduled_trips` refuses canceling a trip that has confirmed holds, under READ COMMITTED only, until cancellation with remedies exists.
- **Holds behind checkouts.** Two triggers on `capacity_holds` keep holds and checkouts in step: a hold that backs a confirmed booking cannot be released while the booking stands, and, at commit, a checkout's hold is confirmed only with its booking and is not released while its checkout is open.
- **Booked or refunded, never both.** Inserting a booking or a refund locks the payment's row and refuses the one when the other exists.

Two more cross-tenant reads join `app.resolve_hostname` and `app.capacity_hold_sweep_tenants`. Both are read-only, STABLE, SECURITY DEFINER with `search_path` pinned, every relation qualified, and EXECUTE granted to `tidegrid_app` only:

- `app.resolve_payment_account(provider, account_ref)` returns the tenant id and the account's status for a connected account. A provider callback names an account, not a tenant, and the webhook must record the event inside the owning tenant's transaction. It runs only after the provider's signature verifies, an id grants nothing, and everything that follows runs under row-level security. It returns accounts whatever their status, because money that moved must be recorded.
- `app.checkout_sweep_tenants(limit, grace_seconds)` returns, at most 1,000, the tenant ids with an open checkout past its instant, or a refund requested or an inbox event received at least the grace period ago (0 to 3,600 seconds) and never settled or processed. It reveals that some tenant has such work, a weaker signal than the shared id sequences already give, and the sweep then works inside each tenant's own transaction, for the reasons the hold sweep's argument gives.

## Guest self-service and email (lane 1)

The self-service and email migration (`0009_self_service_and_email.sql`, after the console completion's 0008) adds tenant-owned tables under rules 1 to 10, described in the [booking contract](../domain-booking/README.md#guest-self-service-lane-1-g211c) and the [messaging contract](../domain-messaging/README.md):

- `booking_participants`: one person per place in a booking's party. The runtime may UPDATE the details only (name, minor, emails, guardian); a trigger keeps the booking and place fixed and refuses a place past the party size or a booking that is not confirmed. No role deletes one.
- `booking_cancellations`: one per booking, append-only for every role. A trigger recomputes the remedy from the booking's policy version on the database clock and refuses any other.
- `bookings` gains `canceled_at`, and the runtime may UPDATE `state`, from `confirmed` to `canceled` only, with its cancellation; the 0007 append-only trigger is replaced by `bookings_lifecycle`, which keeps every other column fixed for every role.
- `payment_refunds` gains the reason `booking_canceled`, for exactly what the booking's cancellation computed.

## Booking notes

The console completion migration (G2.12c, numbered 0008 on its branch) adds one tenant-owned table, `booking_notes`, under rules 1 to 10. The commands are in the [checkout contract](../domain-booking/README.md#console-completion-g212c).

- **Append-only for every role.** The runtime keeps the default SELECT and INSERT and receives nothing more. UPDATE, DELETE, and TRUNCATE raise for every role, the owner included (`app.reject_mutation`).
- **The author is the transaction's.** A trigger (`app.stamp_booking_note`, an invoker function with `search_path` pinned and no EXECUTE for anyone) sets the author from `app.actor_id`, and the request id and the time from the transaction, whatever the insert names. It refuses a note unless the actor is staff with a UUID id (SQLSTATE 42501, `booking_notes_staff_author`), so a guest, the system, or an admin connection without context cannot write one.
- **Composite keys.** The note names its booking and its author through foreign keys that carry `tenant_id`: a note can name only its own tenant's booking, and only a member of that tenant as its author.
- **The body** is 1 to 500 characters with at least one visible character; line breaks are allowed and other control characters are not. The CHECK refuses every C0 control but the line break, DEL, and the C1 controls (U+0080 to U+009F), and wants one character outside white space, those controls, and the Unicode spaces, joiners, marks, fillers, and variation selectors that show nothing (the same set as the contract's `invisibleCharacters`). It is text a person typed: it never enters an audit row, an event, a log, or the idempotency store, whose kept answer to an added note holds the note's id, author, and time only.
- **Who reads it.** Owners and booking staff hold `notes.read` and `notes.write`; finance holds neither (owner decision, 2026-10-19), as a note can name a guest. Row-level security keeps notes to their tenant; the role check is the API's.

## Waiver evidence (G2.15)

The waiver migration (`*_waivers.sql`, after the self-service migration) adds six tenant-owned tables under rules 1 to 10, described in the [waiver contract](../domain-waivers/README.md):

- `waiver_templates` and `waiver_template_versions`: append-only for every role. A trigger numbers each version after the template's highest, keeps its effective start no earlier than now, and computes its content hash from the canonical text, so no writer chooses it.
- `waiver_requests`: one per participant and version, live (pending or signed) at most once per participant and booking. Its participant is named with the booking in a composite key to `booking_participants`, so a request cannot pair one booking with another's guest. The runtime may UPDATE `state`, `revoked_reason`, and `superseded_by` only; a trigger enforces the one-way states and stamps their times, and a request becomes signed only with its evidence.
- `waiver_deliveries`: append-only. A trigger numbers generations, holds the sending limits (5 generations per request, and `app.waiver_send_refusal`: 10 minutes between sends of one participant's waiver to one address, and caps per participant, address, booking, and tenant), keeps `send_after` no earlier than the insert, and requires the generation's own waiver message in `email_messages`, due no earlier than `send_after`.
- `waiver_signing_sessions`: opened only by the redemption that consumed a waiver link in `guest_access_links` in the same transaction; afterwards the runtime may only revoke one (`revoked_at`, `revoked_reason`).
- `waiver_evidence`: append-only for every role, the owner included. A trigger checks the request, session, signer, version, hash, and acknowledgments; a CHECK holds the PDF to its SHA-256; and at commit evidence stands only beside a signed request.

One new function in schema `app` is callable by the runtime: `app.waiver_send_refusal`, a STABLE invoker function (`search_path` pinned, EXECUTE revoked from PUBLIC and granted to `tidegrid_app` only) that answers whether a waiver email may go now and, if not, when; the service asks it before sending, and the deliveries trigger calls it for every writer. It runs under the caller's row-level security. The waiver triggers run as the writer, under its row-level security, and filter by tenant explicitly.

## Custom hostname lifecycle (G2.14b)

Migration `0011_custom_hostname_lifecycle.sql` adds the lifecycle of a custom hostname. Resolution still reads only `tenant_hostnames.status`; the provider's detail lives beside it. The adapter and the service are in [packages/domain-hostnames](../domain-hostnames/README.md).

- **`tenant_hostname_provisioning`**, tenant-owned, under rules 1 to 10: one row per custom hostname, with the provider (`fake` or `cloudflare_saas`), the provider's record id (unique per provider, stored once), the mapped ownership and certificate states, the public DNS instructions, the last error code, when it was checked and is next due, and the claim's end (seven days, the provider's validation window). It names its hostname with its tenant in a composite foreign key to a new unique key on `tenant_hostnames (hostname, tenant_id)`. The runtime holds SELECT only: 0001's default INSERT is revoked, and no UPDATE is granted. DELETE and TRUNCATE raise for every role, the owner included. A trigger refuses a row for anything but a pending custom hostname of the same tenant, keeps the tenant, name, provider, claim, and a stored provider id fixed, and stamps the times.
- **Transitions on `tenant_hostnames`**, for every role, by trigger: a hostname keeps its name, tenant, kind, and creation time; pending moves to active only for a custom hostname, with its verification time, while its provisioning row holds both provider states `active`; pending or active moves to disabled; a disabled name never moves again, so it stays reserved. No existing fixture updates these rows, so none changed.
- **The `platform` kind**, for an explicit allowlist (`demo.tidegrid.us`) only, written by the admin connection, never swept (G2.14b D19(b), a coordinator default pending owner confirmation).
- **`app.resolve_hostname`** keeps its signature and also requires `verified_at IS NOT NULL` for an active row, a second guard on the CHECK in 0002.
- **Name rules.** There is no name-shape trigger on insert, so every existing fixture stays valid. `app.hostname_request`, the only writer of new custom rows, refuses a name that is not normalized, is over 200 characters (an audit subject holds 200), has fewer than three labels, carries a punycode label, or equals or ends on a label boundary in `tidegrid.us`, `workers.dev`, `pages.dev`, `localhost`, `test`, `example`, `invalid`, `onion`, `local`, `internal`, `arpa`, or `alt`. `packages/tenant-config` holds the same rules for the CLI.

Functions, all SECURITY DEFINER under rule 7, with explicit tenant predicates:

| Function | Effect | Runtime EXECUTE |
|---|---|---|
| `app.hostname_sweep_tenants(limit)` | Tenant ids with a provisioned custom hostname whose check is due, or whose pending claim ran out. At most 1,000. STABLE | Yes |
| `app.hostname_record_check(tenant, hostname, provider_id, hostname_state, certificate_state, error_code)` | Records a reading for the transaction's own tenant, only when the provider id equals the stored one. May demote and never promotes: an active hostname is disabled only on a definitive negative (ownership `moved`, `blocked`, or `deleted`, or the certificate `failed`), and a pending one past its claim expires. A `pending` or `unknown` reading, such as a certificate renewing, is recorded and changes nothing. With both states NULL and an error code it records that the provider gave no reading for this one record: the stored states stay, the code is kept, nothing is demoted, and an ended claim still expires; one state NULL, or both with no code, raises 22023. The next check backs off from 60 seconds to 4 hours while pending and comes an hour later while active | Yes |
| `app.hostname_request(tenant, hostname, provider)` | A pending custom row and its provisioning row, after the name rules; refuses a name any tenant holds in any status | No |
| `app.hostname_attach_provider(tenant, hostname, provider_id, instructions)` | Stores the provider's record id and DNS instructions once, for a pending row | No |
| `app.hostname_activate(tenant, hostname, provider_id, hostname_state, certificate_state)` | Pending to active, with both states `active`, a matching provider id, and the claim still open | No |
| `app.hostname_disable(tenant, hostname, reason)` | Any kind to disabled; false when already disabled | No |

Every transition writes an `audit_events` row in the same transaction. Activation is admin-only: if the runtime both wrote provider states and activated, the "both active" check would only repeat what the runtime itself wrote.

**Residual trust.** Provider truth is whatever the adapter reports to the admin CLI or the sweep. The database guards tenant scope, the provider id match, and the transitions; it cannot prove a reading.

**Disabled is terminal, by design.** No function moves a disabled hostname back, and the name stays reserved, so a false demotion cannot be undone from the runtime or the CLI. That is why only a definitive negative demotes, and why the sweep records no reading for a hostname when the provider refuses to answer about it (a rotated token, another 4xx, a malformed answer, a missing zone). Expiring a pending claim that ran out is not a reading: the sweep still does it after such a refusal, and it disables only a name that never went live. If a disabled hostname ever has to come back, the recovery path is a reviewed migration `0012` with an admin-only re-enable function and its audit, not a manual update, which the trigger refuses for every role.

`app.hostname_sweep_tenants` has the same argument as the hold sweep's: it returns tenant ids only, capped at 1,000, read-only and STABLE, and every read and write that follows runs in `inTenantTransaction` under forced row-level security. It reveals that some tenant has a custom hostname with a check due, a weaker signal than the shared id sequences already give. Since 0013 it orders by the `hostname` stamps, which the sweep writes only for tenants it may read the provider for.

## Staff-assisted bookings (G2.12d)

Migration `0012_staff_bookings.sql` records where a checkout and its booking came from. It adds no table and changes no grant. The commands are in the [checkout contract](../domain-booking/README.md#staff-assisted-booking-g212d). The number `0012` went to this migration, so the hostname recovery path named above takes a later one.

- **`checkout_sessions` gains `source`, `channel`, and `opened_by`.** A trigger (`app.stamp_checkout_source`, an invoker function with `search_path` pinned) stamps `source` and `opened_by` from `app.actor_type` and `app.actor_id` on insert, whatever the insert names: a staff actor with a UUID id opens a `staff_assisted` checkout as its opener, and a guest, the system, or a connection without context opens a `direct` one, with no channel and no opener. The channel (`phone`, `email`, or `walk_up`) is the staff member's input, required on a staff-assisted checkout and null otherwise (CHECK constraints). The opener names a member of the checkout's own tenant in a composite foreign key to `tenant_memberships`. On update the trigger refuses any change to the three, for every role (`checkout_sessions_source_immutable`); the runtime's UPDATE stays on `state` only.
- **`bookings.source` widens to `staff_assisted`.** A trigger (`app.stamp_booking_source`, named `bookings_a_source` to fire before `bookings_evidence` and `bookings_lifecycle`) sets each new booking's source from its checkout, so the confirmation code inserts the default and cannot forge it. `app.check_booking` is not replaced and does not read the source; an integration test holds that. The source stays immutable under `bookings_lifecycle` (0009).
- **Rules unchanged.** The runtime's table-level INSERT on `checkout_sessions` covers the new columns. Forced row-level security, the no-DELETE rule, and the chain of custody stand as they were. Both trigger functions have EXECUTE revoked from PUBLIC.
- **Tests.** `packages/domain-booking/src/staff-source.integration.test.ts` proves the stamping as the runtime and the admin, the immutability, and the booking's source after a verified event.

## Sweep turns (0013)

Migration `0013_sweep_fairness.sql` adds `sweep_turns`, a tenant-owned table under rules 1 to 10. It has forced row-level security with the `tenant_isolation` policy, the default SELECT and INSERT, and UPDATE on `last_turn_at` and `run_id` only. Triggers refuse DELETE and TRUNCATE for every role, the owner included.

- **Stamps.** A sweep stamps a tenant in that tenant's own `inTenantTransaction` (`recordSweepTurn` in `src/fair-sweep.ts`), before its first turn and again at its first extra turn. A sweep may decline a stamp (`stampWhen`); the hostname sweep does so once it reads the provider no more. A stamp never moves back: of two overlapping runs, the later time stays. A stamp writes no audit or outbox row.
- **The list functions.** The four sweep list functions read the stamps only to order due tenants least recently served first, then by tenant id. They still return tenant ids only. Each joins on its own tenant and its own sweep name explicitly (`t.tenant_id = d.tenant_id AND t.sweep = ...`), because the definer bypasses row-level security (rule 7). The order reveals the relative recency of the platform's own turns to platform code; no tenant reads another's stamp.
- **Tests.** `src/sweep-turns.integration.test.ts` proves the grants, the guards, and the order.
- Coordinator defaults D1 A and D3 A of the pre-pilot hardening goal, pending owner confirmation.

## Tests

- `pnpm test` runs unit tests.
- `pnpm test:integration` runs against a throwaway database. Set `DATABASE_URL` to its admin URL and `TIDEGRID_EPHEMERAL_DB=1`; the shared global setup migrates it and rotates the runtime password on it. Never point it at the main branch. With `DATABASE_URL` unset the suites skip locally; in CI a missing database is an error, never a skip.
- `tools/local-db/local-db.sh` is the throwaway database, on a Mac and in CI alike. It runs the official `postgres` 17 image, pinned by digest, on `127.0.0.1:55432` with podman (CI uses Docker; set `TIDEGRID_LOCAL_DB_ENGINE` to choose). `up` starts a fresh container and prints `DATABASE_URL` and `TIDEGRID_EPHEMERAL_DB=1`; `prepare integration|guest-e2e|console-e2e` migrates and seeds for one CI job; `down` removes it. `pnpm test:local-db` runs every integration suite, the guest browser parts A and B, and the console browser tests, each part on a fresh container, as each CI job has a fresh database. It moves an existing `apps/api-worker/.dev.vars` aside and restores it at the end. On a Mac the podman machine must be running (`podman machine start`); keep the Mac awake while it runs. `eval "$(tools/local-db/local-db.sh env)"` exports the two variables into the shell, after it checks that the container on that port is this checkout's.
- Clock check: `up`, once the server is ready, and `test`, before its first part, refuse a container clock more than 5 s away from the host's. A quote's `expires_at` comes from the writer's clock (Node, in the tests) while checkout compares it with the database's `now()`, so a container clock that lags makes a back-dated quote look fresh. A podman machine on a Mac can lag by many minutes after the Mac sleeps; its time daemon corrects that only once it reaches a time source. Fix it at once with `podman machine ssh sudo chronyc makestep`, or restart the machine; for Docker, the engine's VM clock is off and restarting the engine resyncs it. Docker on a Linux runner shares the host clock, so in CI the check passes. The integration tests that back-date a quote, or compare a database timestamp with the current time, read `now()` from the database rather than `Date.now()`; product code still mixes the two clocks in places (waiver send times), which the check guards.
- Parallel lanes: two checkouts can run integration suites at once with distinct `TIDEGRID_LOCAL_DB_NAME` (starting `tidegrid-local-db`) and `TIDEGRID_LOCAL_DB_PORT` values. The script refuses to remove a container that another checkout started. The browser parts use fixed ports, so only one checkout at a time runs them.
- The container's admin is a true superuser, while Neon's owner is not, so a permission that only Neon refuses can pass locally and in CI.
- `pnpm --filter @tidegrid/database neon:branch create <name>` makes an optional throwaway Neon branch, when the Neon project has quota. It expires after six hours, and its compute autoscales from 0.25 to 1 CU. The project default is a fixed 0.25 CU, which the race suites ran out of memory. It prints only the branch id. Pass `--out <file>` to receive the admin connection string in a new file with mode 0600; it is never printed. `--ttl <hours>`, `--no-expiry`, and `--no-endpoint` shape a backup branch, such as the release runbook's restore point.
