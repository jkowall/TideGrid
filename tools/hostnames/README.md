# @tidegrid/hostnames-cli

The admin CLI for custom hostnames (G2.14b). It runs on the admin connection, the only one that may request, activate, or disable a hostname: the runtime role holds no EXECUTE on those functions (see the [database README](../../packages/database/README.md#custom-hostname-lifecycle-g214b)). Every command names one tenant by slug and writes its audit rows as actor `support` / `hostname-cli`.

```sh
DATABASE_URL=<admin url> pnpm --filter @tidegrid/hostnames-cli hostnames status demo-harbor
DATABASE_URL=<admin url> pnpm --filter @tidegrid/hostnames-cli hostnames disable demo-reef reef-e2e.book.localhost "Reason"
# Cloudflare for SaaS (G2.14b-live, once the owner enables it):
DATABASE_URL=... CF_SAAS_ZONE_ID=... CF_SAAS_API_TOKEN=... pnpm --filter @tidegrid/hostnames-cli hostnames request demo-harbor book.example.com
DATABASE_URL=... CF_SAAS_ZONE_ID=... CF_SAAS_API_TOKEN=... pnpm --filter @tidegrid/hostnames-cli hostnames activate demo-harbor book.example.com
# Proposed (W1-SAAS-PREP): a dry run unless --apply is given.
DATABASE_URL=... pnpm --filter @tidegrid/hostnames-cli hostnames route demo-harbor book.example.com
DATABASE_URL=... CF_SAAS_ZONE_ID=... CF_SAAS_API_TOKEN=... pnpm --filter @tidegrid/hostnames-cli hostnames route demo-harbor book.example.com --apply
DATABASE_URL=... CF_SAAS_ZONE_ID=... CF_SAAS_API_TOKEN=... pnpm --filter @tidegrid/hostnames-cli hostnames route demo-harbor book.example.com --remove --apply
DATABASE_URL=... CF_SAAS_ZONE_ID=... CF_SAAS_API_TOKEN=... pnpm --filter @tidegrid/hostnames-cli hostnames release demo-harbor book.example.com
DATABASE_URL=... CF_SAAS_ZONE_ID=... CF_SAAS_API_TOKEN=... pnpm --filter @tidegrid/hostnames-cli hostnames release demo-harbor book.example.com --apply --provider-id <id>
# The scripted fake, in one process, on a throwaway database only:
DATABASE_URL=... TIDEGRID_EPHEMERAL_DB=1 pnpm --filter @tidegrid/hostnames-cli hostnames fake-lifecycle demo-harbor book.example.com
```

- `status` prints one line per hostname: kind, status, the provider's last states, and for a custom name its stored `provider id`, or `no provider id, reserved at <time>`. A disabled name also shows `disabled at <time> (<action>)` from the audit row that disabled it, so the removal runbook can tell whether the kill switch's 24-hour window has passed.
- `request` checks the name rules, reserves the name, creates the provider's record, and prints the DNS records the operator publishes.
- `activate` reads the provider again and activates only when ownership and certificate are both active.
- `disable` turns any hostname off; a disabled name stays reserved.
- `route` (proposed) adds or, with `--remove`, removes the per-hostname Workers route `<hostname>/*` to the guest Worker in the SaaS zone. See below.
- `release` (proposed) recovers a request interrupted between the provider and the database. See below.
- `fake-lifecycle` runs request, a refused early activation, validation, activation, a demotion after the CNAME moves, and disable, because the fake's records live in memory and cannot outlive one process.

## Per-hostname routes: `route` (proposed, W1-SAAS-PREP)

A custom hostname reaches the guest Worker through a Workers route in the SaaS zone whose pattern is exactly `<hostname>/*`. A `*/*` route could shadow the API, the console, and `demo.tidegrid.us`, so the runbook's P10 question "per-hostname routes versus `*/*`" gets this command as its proposed answer.

- **A dry run by default (D3).** Without `--apply` it checks the database, prints the calls it would make, and makes none. It needs no token. The zone id is never printed; the path names `$CF_SAAS_ZONE_ID`.
- **Who may be routed.** Adding needs an active custom hostname of the named tenant. Removing needs a custom hostname of the named tenant in any status, so a disabled name's route can go during removal. Preview and platform names are refused by the name rules.
- **With `--apply`** it lists the zone's routes first. A route with the same pattern and script is left alone (`already routed`). A route with the same pattern and any other script, or none, is refused: never replaced, never deleted. `--remove` deletes only routes with that exact pattern on the guest Worker's script. Wildcard routes are never touched.
- **Script.** The guest Worker, `tidegrid-guest` (`apps/guest-site/wrangler.jsonc`), or `CF_SAAS_ROUTE_SCRIPT`.
- **Token.** Workers Routes Write on the SaaS zone, in addition to the custom hostname permissions. Proposed: only the admin's token carries it, never the API Worker's secret. See the [package README's token scope](../../packages/domain-hostnames/README.md#token-scope).
- **Proof.** Dry-run and apply tests against a recorded-shape routes endpoint and against a throwaway database (`src/routes.test.ts`, `src/commands.integration.test.ts`). It has never called the real API: the first `--apply` is at P10, under the owner's go.

## Recovering an interrupted request: `release` (proposed, W1-SAAS-PREP)

`request` reserves the name in the database, creates the provider's record, then stores its id. If the process dies after the provider created the record and before the id is stored, the row stays pending with no provider id. Running `request` again finds the reservation and tries to create again; the provider answers `already_exists`, and the adoption rule refuses to adopt a record it cannot prove this request made. The sweep never reads a row without an id, so the row waits. Its seven-day claim still runs: a resumed request keeps its original claim, and once that claim has ended the next sweep would expire a resumed request to `disabled`, which is final.

1. Run `release <slug> <hostname>`, a dry run. It refuses any row that is not this tenant's pending or disabled custom hostname with no stored provider id. It looks the name up at the provider by exact match and prints the record's id and states, the time the database reserved the name, and when the claim ends or ended. It changes nothing.
2. In the Cloudflare dashboard, find the custom hostname by its exact name and confirm it was created after that reservation time, by the interrupted run.
3. Run `release <slug> <hostname> --apply --provider-id <id>` with the id from step 1. It refuses if the id does not match the record found. Otherwise it writes a `hostname.provider_release_started` audit row, deletes exactly that record, and writes a `hostname.provider_released` audit row before it reads the provider again, so a delete is audited whatever happens next. It then checks that no record holds the name any more and resumes the request: a fresh record is created, its id stored, and the DNS records printed as `request` prints them. A started row with no released row after it means the delete may or may not have happened: run the dry run again.
4. If no record holds the name (the process died before the provider acted), `--apply` without `--provider-id` simply resumes the request.
5. If the claim has ended, `release` never resumes the request. `--apply --provider-id <id>` still deletes the record, audited as above, and the output says the request was not resumed. Run `disable` with a reason and follow the [removal runbook](../../docs/runbooks/hostname-removal.md); using the name again needs a migration (D2).
6. If the name should not be retried, run `disable` with a reason instead. A disabled name stays reserved, and `release` never resumes it. For a disabled name with no stored id, `release` still shows and, with `--apply --provider-id <id>`, deletes the record left behind, audited as above: the removal runbook's H5b. A disabled name with a stored id is refused; its record goes by H5a.

**The per-hostname guard (recheck Q1).** `request` holds a guard on the hostname from its reservation check through storing the provider id, and `release` holds the same guard from its first read through the delete, its audit rows, and any resumed request. So a request never attaches a record between release's check and its delete: whichever comes second waits, up to two minutes, then gives up with `HostnameGuardBusyError`. Release also checks the row again under the guard, in the transaction that writes the started audit row, right before the delete. The guard is a PostgreSQL session advisory lock keyed on the hostname alone, taken by polling, on one pinned connection; no migration and no database function. Each guarded write first checks that its session still holds the lock, so the CLI needs a direct admin connection: through a transaction-mode pooler it refuses before any provider call. No other path attaches or deletes a provider record: `activate` and the sweep only read and record, and the runbook's dashboard delete (H5a) acts on a disabled name, which nothing can attach.

## Removing a hostname

Proposed: [docs/runbooks/hostname-removal.md](../../docs/runbooks/hostname-removal.md) covers the order (disable, keep the kill switch on the host, the operator deletes the CNAME, remove the route and the provider record) and what any future reuse would need.

## Deploying (G2.14b-live)

Release the API before the guest site: the guest Worker binds to the API's `GuestGateway` entrypoint, and a guest release before it exists fails on that binding. A guest release attaches every route in `apps/guest-site/wrangler.jsonc` as a Workers Custom Domain, which creates DNS records for `<slug>.book.tidegrid.us` in the `tidegrid.us` zone.

Secrets come from the environment only. The token is never printed; errors print their type and code. An account-level refusal (any 401 or 403, and the Cloudflare authentication codes in `@tidegrid/domain-hostnames`'s `refusals.ts`, unverified until the first real request at P10) adds a line naming `CF_SAAS_API_TOKEN`'s scope and `CF_SAAS_ZONE_ID`. The token is scoped to one zone: see the [package README](../../packages/domain-hostnames/README.md#token-scope).
