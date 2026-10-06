# @tidegrid/database

PostgreSQL access for the TideGrid demo build: Kysely over postgres.js, reviewed SQL migrations, and the tenancy primitives every domain module uses. This file is the working contract for tenant isolation. The design authority is the [target architecture](../../docs/v2/04-architecture.md) and the retained V1 decisions on [tenancy](../../docs/v1/adr/0003-postgresql-tenancy.md), [row-level security](../../docs/v1/adr/0004-row-level-security.md), [outbox](../../docs/v1/adr/0008-transactional-outbox.md), and [audit](../../docs/v1/adr/0018-audit-log.md).

## Roles

- **Admin (the Neon owner role).** Runs migrations and seeds. Bypasses row-level security. Never used by a Worker.
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

`app.capacity_hold_sweep_tenants(limit)` lets the cron sweep find the tenants with holds past their expiry instant. It is the one cross-tenant read the runtime has beyond sign-in and hostname resolution. The argument for it:

- It returns tenant ids and nothing else: no hold, trip, owner, or count. An id grants nothing. Every read and write that follows runs in `inTenantTransaction` under forced row-level security, and tenant ids already appear in staff URLs.
- What it reveals is that some tenant has at least one stale hold. That is a weaker activity signal than the shared audit and outbox id sequences already give (see the known gaps above).
- It is read-only and STABLE, a SECURITY DEFINER function with `search_path` pinned, every relation qualified, explicit predicates, and at most 1,000 rows. EXECUTE is granted to `tidegrid_app` only.
- The alternatives are worse. A row-level-security bypass for the cron's connection would expose every tenant's rows to one session. A tenant list in configuration drifts from the database and would silently skip new tenants. One definer function that expired holds across tenants would write audit and outbox rows outside any tenant's transaction.

## Checkout, payments, and bookings

The checkout migration (0007) adds twelve tenant-owned tables under rules 1 to 10, described in the [checkout contract](../domain-booking/README.md) and the [payments contract](../domain-payments/README.md): `checkout_sessions`, `orders` and `order_lines`, `payments`, `payment_refunds`, `provider_events` (the inbox), `bookings`, `finalization_exceptions`, `payment_accounts`, and the fake provider's `fake_provider_payments`, `fake_provider_events`, and `fake_provider_refunds`.

- **Privileges.** The runtime keeps the default SELECT and INSERT, except on `payment_accounts`, which it may only read: onboarding (the seed) writes where money goes, never a request. UPDATE is granted only on the columns that carry a transition: `checkout_sessions.state`, `orders.status`, `payments` (`state`, `provider_payment_id`, and the two evidence columns), `payment_refunds` (`state`, `provider_refund_id`, `failure_code`), and `provider_events` (`processing_state`, `outcome`). Triggers stamp every time from the database clock.
- **No deletes.** DELETE and TRUNCATE raise on every table here for every role, the owner included. Order lines, bookings, exceptions, and the fake provider's tables refuse UPDATE too.
- **States and evidence for every role.** Triggers run as the writer, under its row-level security, and filter by tenant explicitly. They enforce the one-way states and the chain of custody: a checkout confirms only with a booking, a booking needs a succeeded payment and a confirmed hold, an order is paid only with a booking, and a payment succeeds only with a verified inbox event for its provider id, account, amount, and currency. The owner role cannot skip a link either.
- **Sealed and self-checking orders.** Order lines can be written only in their order's transaction, and a deferred check refuses at commit an order that does not equal its quote, line for line and tax rate for tax rate.
- **Composite keys.** Every reference carries `tenant_id`, including the inbox's reference to the connected account, so an event can be recorded only in the tenant that owns the account it names.
- **Trips with bookings.** A trigger on `scheduled_trips` refuses canceling a trip that has confirmed holds, under READ COMMITTED only, until cancellation with remedies exists.

Two more cross-tenant reads join `app.resolve_hostname` and `app.capacity_hold_sweep_tenants`. Both are read-only, STABLE, SECURITY DEFINER with `search_path` pinned, every relation qualified, and EXECUTE granted to `tidegrid_app` only:

- `app.resolve_payment_account(provider, account_ref)` returns the tenant id and the account's status for a connected account. A provider callback names an account, not a tenant, and the webhook must record the event inside the owning tenant's transaction. It runs only after the provider's signature verifies, an id grants nothing, and everything that follows runs under row-level security. It returns accounts whatever their status, because money that moved must be recorded.
- `app.checkout_sweep_tenants(limit)` returns, at most 1,000, the tenant ids with an open checkout past its instant, a refund requested a minute ago or more, or an inbox event received a minute ago or more and never processed. It reveals that some tenant has such work, a weaker signal than the shared id sequences already give, and the sweep then works inside each tenant's own transaction, for the reasons the hold sweep's argument gives.

## Tests

- `pnpm test` runs unit tests.
- `pnpm test:integration` runs against a throwaway Neon branch. Set `DATABASE_URL` to the branch's admin URL and `TIDEGRID_EPHEMERAL_DB=1`; the shared global setup migrates the branch and rotates the runtime password on it. Never point it at the main branch. In CI a missing database is an error, never a skip.
