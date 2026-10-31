# @tidegrid/domain-hostnames

Custom hostnames and tenant selection by hostname for the demo build (G2.14b, local-first pass). A hostname selects one tenant's public experience and grants nothing. The database schema, the grants, and the lifecycle functions are in the [database README](../database/README.md#custom-hostname-lifecycle-g214b); the API's use of them is in the [API README](../../apps/api-worker/README.md). Scope and the coordinator defaults behind it are in the [hostnames and PWA narrowing](../../docs/v2/12-demo-build-plan.md#goal-sequence).

Safe in a Worker: nothing here imports Node.

## The strict origin parser (`src/origin.ts`)

One parser for every caller: each public route, the bootstrap included, CORS, the guest Worker's gateway, and email links. `parseBrowserOrigin(value, { environment })` returns `{ origin, host }` or null. It refuses:

- no Origin, or the opaque origin `null`;
- userinfo, a query, a fragment, or a path other than empty or `/`;
- a trailing dot (a separate browser origin for storage and service workers);
- any scheme but `https:`; `http:` only when `environment` is `local` and the host ends in `.localhost`;
- an explicit port outside local development, and a default port such as `:443` everywhere, since it is not canonical;
- uppercase, Unicode, and anything else a browser never sends (the value must equal its own serialization);
- a punycode label (D13(a));
- IP literals, single labels such as `localhost`, and malformed hosts, through `normalizeHostname`;
- outside local development, any loopback-only name, so a `*.localhost` row is inert wherever the seed wrote it.

`parseRequestHost(url, policy)` reads only a request URL's hostname (the guest Worker's case) and `parseHostname(value, policy)` checks a bare hostname handed across a boundary, by the same rules.

## The adapter (`src/provider.ts`)

`CustomHostnameProvider` has `routingTarget()`, `create`, `get(id, expectedHostname)`, `findByHostname` (exact match only), `refreshValidation`, and `remove`. Readings carry the mapped `hostnameState` (`pending`, `active`, `moved`, `blocked`, `deleted`, `unknown`) and `certificateState` (`pending`, `active`, `expiring`, `failed`, `unknown`), the provider's raw strings, the DNS instructions, and error codes. `isServable` wants ownership `active` and a certificate `active` or `expiring` (D10(a)); `isActivatable` wants both `active`. Errors are `HostnameProviderUnavailableError` (429, 5xx, timeouts, with `retryAfterSeconds`) and `HostnameProviderRejectedError` (a lowercase code such as `already_exists` or `hostname_mismatch`). No method may be called inside a database transaction.

- **Status mapping** (`src/status.ts`) covers every value in the Cloudflare API reference and maps anything else to `unknown`, which never serves or activates. A table-driven test pins every row.
- **The fake** (`src/fake.ts`) is in memory, with deterministic ids under a prefix, an injectable clock, a call log, and scripted cases: a lost answer, a timeout, a CNAME already present (active at once), near-match and foreign records, 429 and 5xx with `retry-after`. Its state does not cross processes.
- **The Cloudflare client** (`src/cloudflare.ts`) calls `/zones/{zone_id}/custom_hostnames` with `fetch`, parses the envelope with zod, does a delayed GET after a create because the POST answer may omit validation records, looks up names with `hostname.exact` only, and never puts the token in an error. It is tested only against a recorded-shape fixture (`src/cloudflare-fixture.ts`). One contract suite (`src/provider.contract.ts`) runs against both.

## The lifecycle (`src/lifecycle.ts`)

- **Admin connection only:** `requestCustomHostname` reserves the name in the database first, then creates the provider's record and stores its id once. **Adoption rule:** after a lost create answer, an exact-name lookup may find the record this same request created; it is adopted only then, before any id is stored, and audited. Any other record of that name is `already_exists`, because nothing marks a record in the zone as TideGrid's without Enterprise custom metadata. `activateCustomHostname` re-reads the provider at call time; `disableHostname` turns any hostname off.
- **Runtime:** `sweepHostnames` lists due tenants with `app.hostname_sweep_tenants`, reads each due hostname from the provider between short tenant transactions, and records the reading with `app.hostname_record_check`, which may demote and never promotes. Only a reading the provider actually gave changes anything:
  - a record that names another hostname, or no record by id confirmed by an exact-name lookup, reads as deleted, which demotes;
  - an account-level refusal (any HTTP 401 or 403, whatever code it carries, a few Cloudflare authentication codes in addition, or an exact-name lookup that answers 404 because the zone is missing or outside the token's reach) records nothing for the hostname it was reading and ends the provider reads for the run as `providerFault`, with the code and the opaque provider record id in the log;
  - a refusal about one record (a malformed answer for it, an ambiguous name, another 4xx for its id) is recorded with no change: the states stay, the code is kept, the next check is scheduled as usual (backing off while pending, an hour later while active), and the run goes on, so one odd record never blocks the checks after it;
  - a pending hostname whose claim has run out expires without a provider read, before any read in its tenant, and even after an account-level refusal, a throttle, or the call limit has ended the provider reads;
  - limit: if the token can reach another real zone and the zone id names it, the lookup answers normally with no match and every hostname reads as missing, which demotes. The token is scoped to the one SaaS zone (a G2.14b-live check);
  - a 429 or 5xx records nothing for the hostname it was reading and ends the provider reads for the run as `throttled`; the next cron run is 15 minutes away, past Cloudflare's `retry-after`.

  Readings recorded before any of these stops stand, so a run can report `providerFault` or `throttled` together with demotions and expiries. At most 200 provider calls a run (one more in the worst case, below), far below the account's 1,200 requests per 5 minutes. The budget (20 seconds by default) ends the whole run: no hostname read and no expiry starts after it, and an ended claim it did not reach expires on a later run. A read already under way finishes: its provider call, its exact-name lookup when the record is missing, and its recorded check. So a run can end later than the budget, by up to two of the client's 15-second request timeouts and one database write. The database demotes only on a definitive negative, so a pending or unknown reading, such as a renewing certificate, keeps an active hostname serving.
- **Fair turns** (pre-pilot hardening, Part D; coordinator defaults D-E1 A to D-E4 A, D-E11 A, and D-E12 A, pending owner confirmation). The sweep runs on `runFairSweep` from `@tidegrid/database`, as the hold, checkout, and email sweeps do. A turn reads up to five of one tenant's due rows (`turnHostnames`) in one tenant transaction and handles them, ended claims included. The first pass gives each listed tenant one turn; later passes go round the tenants whose read was full, up to `perTenantLimit` (20) rows handled a tenant a run, ended claims included. Each hostname is handled at most once a run. The budget check before each hostname stays (D-E2 A).
  - **Stamps.** A tenant is stamped before its first turn and its first extra turn, but only while the run may still read the provider. After a throttle, an account-level refusal, or the call limit, the remaining turns only expire ended claims and stamp nobody. So a tenant reached after the stop keeps its place and goes first for reads on the next run. The tenant whose own read was throttled or refused was already stamped, so it moves back.
  - **Report.** It adds `turns`, `passes`, `deferredTenants`, `stampFailures`, `expiryOnlyTurns` (turns that started after the reads stopped), and `providerCalls`. Here `deferredTenants` means the budget only: the hostname sweep never ends a run through the scheduler's `stop`.
  - **Observers.** An `onTenantError` or `onStampError` that throws is dropped, so it no longer ends the run. Before Part D a throwing `onTenantError` escaped the sweep, and the cron logged `hostname_sweep_failed`. An `onTurnStart` that throws fails that tenant's turn. A stamp failure goes to `onStampError`, or to `onTenantError` without it, and counts in `stampFailures`, not `failedTenants`.
  - **Call limit.** It is checked before each read. A read that finds no record adds its exact-name lookup unchecked, so a run makes at most `maxProviderCalls + 1` calls (D-E12 A).
  - **`complete`** is also false when the unfiltered list filled the tenant limit, because `onlyTenants` still applies after the limit (D-E11 A).
  - **Residuals, inferred, not tested.** With more than 100 due tenants and a stop that lasts many runs (a rotated token, a long 429 storm), each run stamps only the tenants served before the stop, so tenants past position 100 of the list move up about one place a run. And at most one tenant a run can be stamped at the budget edge and get no service: the budget ran out after its stamp and before its first row. A stamp never moves back.

## Known gaps

- Provider truth is whatever the adapter reports; the database guards tenant scope, the provider id, and the transitions only.
- A disabled name stays reserved; reuse needs TXT pre-validation, a kill-switch window on the host, and a removal runbook first (D4).
- A pending row whose provider record was never attached is not swept; the admin disables it.
- The Cloudflare client has never called the real API. G2.14b-live proves it on a test domain the owner controls, including what a routine certificate renewal reports: the fixture case for an active hostname with `ssl.status` `pending_validation` is unverified against live Cloudflare.
