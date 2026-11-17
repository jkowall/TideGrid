# Staging rehearsal and Core live gate proof, November 15, 2026

Goals **W3-PREPILOT** (pre-pilot evidence on staging) and **W3-CLG-1** (the Core live gate proof in staging). Staging only: the Neon `staging` branch, the `tidegrid-api-staging` and `tidegrid-console-staging` Workers, and synthetic data. Nothing here touched Neon main or a production Worker.

This page records what staging proves today, what it cannot prove, and what only the owner can set up before real data. A check passing in staging never passes the Core live gate itself. Per [Gates](../v2/05-roadmap-validation.md#core-live-gate), the gate passes per operator, in production, before that operator's first real booking. Staging proves the shared parts ahead of time, as [Stage 2's exit](../v2/05-roadmap-validation.md#stage-2-booking-foundation) asks: "every Core live gate area passes in a production-shaped test environment".

## Runs

All runs went through `.github/workflows/staging.yml` ([runbook](../runbooks/staging.md)), each with one owner approval on the `infra-staging` environment.

| Run | Commit | What it did | Result |
|---|---|---|---|
| [43751150410](https://github.com/jkowall/TideGrid/actions/runs/43751150410) | `6a5e6bd` | First deploy: migrations 0001 to 0058 on staging, synthetic seed, API and console deployed, Hyperdrive config `tidegrid-staging` created with caching off, secrets set | Passed. Health: `version 6a5e6bd, environment staging, database ok, 58 migrations, latest 0058` |
| [43754193470](https://github.com/jkowall/TideGrid/actions/runs/43754193470) attempt 1 | `2e50f58` | Redeploy with the Hyperdrive binding (PR 191) | Failed before upload, because the email-events queue (PR 190) did not exist yet. Staging kept serving `6a5e6bd` |
| [43751820554](https://github.com/jkowall/TideGrid/actions/runs/43751820554) | `0a41b5d` | Staging infra apply: the email-events queue and its dead letter queue | Passed |
| [43754193470](https://github.com/jkowall/TideGrid/actions/runs/43754193470) attempt 2 | `2e50f58` | The same redeploy | Passed. The API connects through Hyperdrive |
| [43757658467](https://github.com/jkowall/TideGrid/actions/runs/43757658467) | `4b711b0` | First `rehearse`: deploy, probes, integration in one run | Deploy and every probe passed. Integration failed 5 tests in 2 database suites, because it ran on a copy of seeded staging; fixed by PR 194 |
| [43770709282](https://github.com/jkowall/TideGrid/actions/runs/43770709282) | `18dfc17` | Second `rehearse`, integration on an emptied copy | Deploy and every probe passed. Integration ran for 83 minutes and failed. Its filtered results went only to the run summary, which could not be read from here; the next integration run repeated it with readable results |
| [43794507058](https://github.com/jkowall/TideGrid/actions/runs/43794507058) | `4a7e86e` | `deploy-and-probe` with the API pinned next to the database (PR 195) | Passed. Placement `remote-ORD`; reads and writes 2 to 3 times faster (below) |
| [43871800993](https://github.com/jkowall/TideGrid/actions/runs/43871800993) | `4a7e86e` | `integration`: every suite on an emptied Neon branch of staging | Stopped at the 95-minute limit before the waiver, booking, and API suites. Of what ran: hostname and inventory sweep fairness passed; four suites failed because Neon gives no superuser; two failures were test assumptions, fixed in PR 196 (below) |
| [44100529925](https://github.com/jkowall/TideGrid/actions/runs/44100529925) | `249f9af` | `integration`: the focused set (PR 196) | Finished in 20 minutes. All 4 fairness suites, the race, expiry, and chain-and-tenancy suites, capacity override, and the API's capacity, capacity-adversarial, and tenant-access suites passed. 1 recovery test failed; the likely cause is timing, and a proposed fix in this page's pull request waits on a Neon re-run (below) |

Four workflow fixes came out of these runs. PR 193 put deploy, probes, and integration under one approval (they had been three runs, each asking separately). PR 194 empties the throwaway branch before the suites, runs every package even when one fails, keeps error lines in the filtered log, and reports the compute region. PR 195 pins the staging API next to the database, adds the `deploy-and-probe` action (about 6 minutes), stops the suites at 95 minutes so their results are always written, and copies the filtered results into the job log. PR 196 runs a focused set of suites on staging (fairness, races, capacity, tenant isolation), because the whole suite cannot finish in time over the network and some suites need a superuser, and fixes the two test assumptions the full run found.

## Pre-pilot evidence

### Hyperdrive, compute restart, and read-after-write: passed

The [database connection gate](../v2/08-build-hosting-and-operations.md#architecture-acceptance-gates) asks that Hyperdrive reach the direct Neon endpoint, avoid Neon's pooled endpoint, survive a compute restart, and preserve read-after-write with query caching disabled.

- **Direct endpoint, caching off.** `tools/staging/configure.sh` points the `tidegrid-staging` config (`9c9970c1c7fd4433813445cbbfdf3ad1`) at staging's read-write host, refuses a `-pooler` host, and verifies after every deploy that caching is disabled and the host is staging's. The deploy log lists `env.HYPERDRIVE (9c9970c1c7fd4433813445cbbfdf3ad1)`.
- **Read-after-write.** 20 pairs through the deployed Worker: write a quote, then read it straight back by id. 20 of 20 read their own write, with 0 stale and 0 refused writes. Writes took p50 2,986 ms and p95 3,675 ms; reads took p50 1,301 ms and p95 1,579 ms.
- **Compute restart.** The probe checked that the compute belongs to the staging branch, then restarted it through the Neon API and read trips once a second. All 12 reads during the restart answered 200, with no failure seen, and the database answered fully again after 21 s. Then 8 more read-after-write pairs on the new connection: 8 of 8, 0 stale. A second restart after the pin (run 43794507058) was quicker but not clean: of 3 reads, 1 answered 500 at 1.8 s and the database answered again at 3.3 s; the next 8 pairs were 8 of 8, 0 stale. The API survived the restart and kept read-after-write, but a guest reading at that moment saw a server error rather than a "try again" answer (follow-up).

### Placement latency: found, fixed in staging

30 timed public reads of each kind through `api-staging.tidegrid.us` from a GitHub runner, before and after pinning the API next to the database:

| Read | Smart Placement (run 43770709282) | Pinned to `aws:us-east-2` (run 43794507058) |
|---|---|---|
| Trips list | p50 771 ms, p95 1,018 ms, max 1,168 ms | p50 304 ms, p95 1,117 ms, max 1,510 ms |
| Tenant (brand) | p50 251 ms, p95 372 ms, max 469 ms | p50 160 ms, p95 537 ms, max 572 ms |
| Read-after-write, write | p50 2,986 ms, p95 3,675 ms | p50 949 ms, p95 1,219 ms |
| Read-after-write, read | p50 1,301 ms, p95 1,579 ms | p50 517 ms, p95 603 ms |

Under Smart Placement every response came from `local-PDX`: the Worker ran near the runner, and the database is in `aws-us-east-2` (Ohio), so each query crossed the country, several times per trips list. [Build, hosting, and operations](../v2/08-build-hosting-and-operations.md#postgresql-and-hyperdrive-plan) already says to apply a placement hint "after a latency test confirms the supported Azure region value". This was that test; the value is an AWS region, because the Neon project is on AWS. PR 195 set `"placement": { "region": "aws:us-east-2" }` in `env.staging`, and every response then came from `remote-ORD` (Chicago). Typical reads got 2 to 3 times faster and writes 3 times faster. The slowest few reads did not improve: their p95 and max rose, which fits a few cold starts at the new location in a sample of 30; a longer probe should confirm it. Production keeps Smart Placement until the production database exists; its region decides the production hint (follow-up).

### Search p95: not proven on staging

The search benchmark (`packages/domain-booking/src/search-benchmark.integration.test.ts`) grows one tenant to about 50,000 bookings by cloning rows with triggers and foreign keys off (`session_replication_role = replica`). Only a PostgreSQL superuser can do that, and Neon gives none: in run 43871800993 the suites that need it failed with `permission denied to set parameter "session_replication_role"`. So the 300 ms p95 target (D-E8) stays proven in CI only: the target was adopted once two CI runs showed every case at 225 ms or under, on CI's PostgreSQL rather than Neon. Proving it on Neon needs a loader that works without a superuser, such as cloning the quotes and holds as well, or loading through the API (follow-up).

### Sweep fairness: passed

The four sweep fairness suites passed on a Neon branch of staging in run 44100529925. They cover the checkout sweep (5 tests), the inventory hold sweep (3), the email sweep (5), and the hostname sweep (19). Each one checks that a tenant with a large backlog cannot use up a run and that every listed tenant gets its turn. The email suite first failed in run 43871800993 because of a test assumption: its helper moved a message's next try to "one second ago", which over a slow link was later than the message's own time, and the delivery guard refused the change. PR 196 fixed the helper. The suites took 1 to 3 minutes each on Neon, against seconds in CI.

### Tests on Neon

Run 44100529925 also ran the last-unit race suites, booking chain and tenancy, hold expiry, capacity override, and the API's capacity, capacity-adversarial, and tenant-access suites. All passed except one recovery test. That test, "sends a refund whose answer was lost again with the same key, once", saw the second sweep settle 0 refunds where it expected 2. The likely cause is the sweep's 20-second budget. Earlier suites leave other tenants listed, the tenant just served goes last, and over the network the budget may have run out before that tenant's turn, leaving the refunds for the next run. The run recorded only the count (0), and the test stopped before checking the refunds' state, so this explanation, and that nothing was sent twice or lost, is **not yet verified**. This page's pull request is a proposed fix: each of that test's sweeps gets a 50-second budget, the test gets its own 300-second limit, and the failure message names the deferred tenants. It passes in CI; a diagnostic re-run on Neon is owed (follow-up).

What this means in production: a sweep run serves fewer tenants when each database round trip is slow, and the rest wait for the next run, in fair order. The sweeps run from the Worker's scheduled (cron) handler, and Cloudflare applies placement hints to fetch handlers only, not cron, queue, or RPC handlers ([Build, hosting, and operations](../v2/08-build-hosting-and-operations.md#postgresql-and-hyperdrive-plan)). So the placement pin above does not shorten the sweeps' round trips, and **cron latency to the database is unmeasured** (follow-up).

## Core live gate in staging

Status words: **Staging** means proven on the deployed staging Workers or on a Neon branch of staging in the runs above. **CI** means proven by the integration suites on every pull request (a disposable PostgreSQL container), not yet in staging. **Not met** means no proof exists yet, usually because it needs the owner, a live provider, or a real operator.

### The ten conditions ([Core live gate](../v2/05-roadmap-validation.md#core-live-gate))

| # | Condition | Status | Evidence or what is missing |
|---|---|---|---|
| 1 | Every Core live workflow passes end-to-end acceptance for shared-seat and private-charter bookings | **Not met** | Separate API integration suites in CI cover checkout, deposits and balances, refunds and credits, reschedules, party changes, invitations, imports, waivers, and the console, but that is per-feature coverage, not end-to-end journeys. One Core journey is missing outright: guests cannot apply booking credit at checkout yet (`packages/domain-booking/README.md`: credit redemption at checkout is not wired). Staging cannot run a guest checkout end to end: it has no guest site and no Turnstile secret, so checkout answers 503 `human_check_unavailable` (it fails closed). **Not met** in staging for a browser journey |
| 2 | No overbooking or negative credit balance under last-unit races and retries | **Overbooking: CI and staging. Credit: partly CI, races not met** | Overbooking: `capacity-adversarial`, `capacity`, capacity override, and the booking race, expiry, and chain-and-tenancy suites (race rounds with an oversell check after each) passed on Neon in run 44100529925. Credit: the CI credit tests cover insufficient balance and same-key retries; no test races competing redemptions against the last balance (follow-up) |
| 3 | Stripe direct-charge, deposit, balance, refund, fee-reversal, webhook-retry, and reconciliation cases pass in the operator's connected-account test environment and a controlled production verification | **Not met** | Staging uses the fake payment provider. Stripe test-mode cases pass in CI (`stripe-webhook`, `stripe-element`); the connected-account and production verification need a real operator account (O-STRIPE2, parked by the owner) |
| 4 | Two-tenant isolation for guest links, accounts, console search, exports, messages, media, and support access | **CI; staging for `tenant-access`** | `tenant-access` passed on Neon in run 44100529925; `bookings-console`, the adversarial suites, and the sealed-contact suites. Staging holds two synthetic operators (`demo-harbor`, `demo-reef`) |
| 5 | The operator approves catalog, price, tax, fee, policy, waiver, intake, brand, email, and support configuration | **Not met** | Needs a real operator |
| 6 | Sender-domain authentication, delivery, delivery-failure visibility, and automatic waiver-request tests pass | CI; partly live | Email is live behind an allow-list (O-P7). Staging sends only to the owner's address (`EMAIL_ALLOWED_RECIPIENTS`). Bounce and complaint events need the owner's Email Sending event subscription (PR 190) |
| 7 | Migration dry run and final import reconcile; the operator signs launch totals and the cutover plan | CI; **not met** for an operator | `imports` suites. Needs a real operator's data |
| 8 | Branded PWA passes production domain, payment, accessibility, responsive, link, receipt, and analytics checks | **Not met** | No staging guest site; production custom hostnames need Cloudflare for SaaS |
| 9 | Roles, exports, roster, exception queues, audit, data export, deletion request, backups, support runbook, incident contacts verified | CI; partly ready | Runbooks merged (W3-OPS-7). Backups, restore drills, and the hourly ops check are built but switched off until the owner sets them up (W3-OPS-5/6). The staging console needs its host added to Cloudflare Access before staff can sign in |
| 10 | No open defect that can cause cross-tenant access, oversell, duplicate value, lost waiver evidence, missing consent, silent message failure, or a wrong remedy | **Not met** | One known silent message failure is open: a bounce that arrives before the provider's message id is stored is recorded as unmatched and never joined, so staff keep seeing "Sent" (`packages/domain-messaging/README.md`, late joins; follow-up). The staging runs found no new defect: failures traced to the test environment (no superuser, slower round trips) or a test assumption. The recovery failure's cause is not yet verified (above) |

### Architecture gates ([Build, hosting, and operations](../v2/08-build-hosting-and-operations.md#architecture-acceptance-gates))

| Gate | Status | Evidence or what is missing |
|---|---|---|
| Shared web build | **Not met** in staging | Proven locally for two brands (G2.14b); needs a staging guest site |
| Custom hostname | **Not met** | Needs Cloudflare for SaaS and an operator-owned DNS zone |
| Tenant isolation | CI; staging for `tenant-access` | As condition 4. R2 objects and queues are per environment; staging's are its own (Terraform) |
| Database connection | **Staging, passed** | Hyperdrive to the direct endpoint, caching off, restart survived, read-after-write held (above) |
| Transaction correctness (Core) | **CI and staging** for races and final seat; credit races not met | Final-seat, exclusive-boat, service-credit, late-payment, and duplicate-callback suites. Competing credit redemptions against the last balance are untested (as condition 2) |
| Async recovery | CI | Outbox, inbox, retry, and dead letter suites (`delivery`, `after-commit-delivery`). Staging's queues and dead letter queues exist and the Worker consumes them |
| Deployment | Partly | Staging deploys from CI with retained evidence (these runs). Production promotion runs from the GitHub release workflow (W3-OPS-3), which has not run live yet |
| Migration | CI; **staging, passed** for forward | All 58 migrations applied to staging from CI; the expand-contract rehearsal runs in CI |
| Recovery | **Not met** | Restore drills are built; the first Neon drill needs the owner's approval and the backup key set up |
| Observability | **Not met** | The hourly ops check is built and switched off (`OPS_CHECK_ENABLED`) |

## Owner-only setup still owed before real data

Only the owner can do these. Each one names where it lives.

1. **Staging console sign-in.** Add `console-staging.tidegrid.us` to the console's Cloudflare Access application ([staff sign-in runbook](../runbooks/staff-sign-in-access.md)).
2. **Turnstile and a staging guest site.** A staging guest host and its Turnstile widget and secret; until then staging refuses checkout, waiver link renewal, and the dock lookup.
3. **Email events.** Turn on Cloudflare's Email Sending event subscription to the email-events queues (PR 190), so bounces and complaints are recorded.
4. **Backups and alerts** (W3-OPS-5/6, [backup runbook](../runbooks/backup-and-restore.md), [ops checks](../runbooks/ops-checks.md)): the age key pair kept off Neon and Cloudflare, the backups R2 bucket and its token, the `backup` environment, the repository variables `BACKUP_ENABLED`, `OPS_CHECK_ENABLED` and `SYNTHETIC_ORIGIN` (repository variables, not environment variables: the workflows check them before entering the environment), approval of the first Neon restore drill, and sign-off on the RPO draft.
5. **Production security** (W3-OPS-4): the production waiver evidence bucket, `FIELD_ENCRYPTION_KEYS` for production (bookings refuse without it), the production Turnstile widget and secrets, and the first production plan's zone and API host.
6. **Production environment** (W3-OPS-2): the production Neon project and Hyperdrive config, created only when a pilot is about to sign.
7. **Payments.** Stripe live mode and each operator's connected account (O-STRIPE2, parked).
8. **Custom domains.** Cloudflare for SaaS for operator hostnames.
9. **Pending decisions.** Coordinator defaults recorded since 2026-11-15 in the [decision register](../v2/06-decision-register.md) (W3-OPS-3 R1 to R11, W3-OPS-4 D1 to D6, sealed contact details D1 to D7, W3-OPS-5/6, the runbook register entries) await the owner.

Already done by the owner today: the `infra-staging` Cloudflare token can now deploy Workers and Hyperdrive (Workers Scripts, Hyperdrive, Workers Routes, DNS), and every staging run above was approved.

## Follow-ups

- Production placement: set the production API's hint from the production database's region when W3-OPS-2 creates it, and run a longer latency probe to check the slowest reads.
- During a compute restart, answer a dropped database connection with a retryable 503 instead of a 500 (seen once in run 43794507058).
- A search benchmark loader that works without a superuser, so search p95 can be measured on Neon.
- Re-run the recovery suite on Neon at the next staging `integration` run to verify the proposed fix and the refunds' final state.
- Measure the cron sweeps' database latency, since placement hints do not apply to cron handlers; if it is too slow, route sweep work through a placed fetch service (per the hosting plan).
- Test competing credit redemptions against the last balance.
- Join late email bounces and complaints to their message, so staff never see "Sent" for a bounced message.
- Build guest credit redemption at checkout.
- Watch how many tenants one sweep run covers once production traffic exists (the sweep reports `deferredTenants`).
