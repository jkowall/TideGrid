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

The integration suite enforces rules 1, 5, 6, 7, 8, and the column limits in rule 9 from the catalog, so a later migration that forgets them fails CI.

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
2. `claimIdempotencyKey` before any domain write. A concurrent duplicate blocks on the key until the first commits, then replays its stored response. A failed command rolls back its claim.
3. Write domain state.
4. `recordAudit` with the action, subject, reason, and before and after values. Audit rows are append-only for every role, including the owner.
5. `enqueueOutbox` for any event other modules or providers need. The row exists only if the command commits.
6. `completeIdempotencyKey` with the successful response.

Keys are scoped by tenant, operation, and principal. Only successful responses are stored.

## Tests

- `pnpm test` runs unit tests.
- `pnpm test:integration` runs against a throwaway Neon branch. Set `DATABASE_URL` to the branch's admin URL and `TIDEGRID_EPHEMERAL_DB=1`; the shared global setup migrates the branch and rotates the runtime password on it. Never point it at the main branch. In CI a missing database is an error, never a skip.
