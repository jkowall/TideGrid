# Nov 1, 2026: preview deploy and demo acceptance (runbook, proposed)

**Status.** Proposed, prepared, and dry-run only. Nothing in this file has run against Cloudflare, Neon, or Stripe. On Nov 1 the owner runs every live step from the owner's own terminal, after a go given at the time. Every decision below is a coordinator default until the owner confirms it. TideGrid stays exploratory; this runbook commits the owner to nothing.

**Where it comes from.** The [demo build plan](../v2/12-demo-build-plan.md) (its Demo acceptance section and the G2.14b-live and G2.16-live items), the [hosting plan](../v2/08-build-hosting-and-operations.md) (migration and rollback policy), and the [decision register](../v2/06-decision-register.md), which wins every conflict. The commands are `tools/release` ([README](../../tools/release/README.md)).

**Line references.** `12:N` is `docs/v2/12-demo-build-plan.md` line N, `08:N` is the hosting plan, and `cli.js:N` is `node_modules/.pnpm/wrangler@4.135.0_@types+node@24.13.6/node_modules/wrangler/wrangler-dist/cli.js` line N, read locally on 2026-10-28.

## Owner calls before anything else

Two decisions shape the whole day. Answer them before Oct 31.

- **D2. What is in the release SHA? (owner call, go/no-go at P0.1.)** Options: (a) main after #31 only; (b) main plus hardening #32 (merged 2026-10-28 as `e93f0aa`, migration `0013_sweep_fairness.sql`); (c) also wait for #26. Recommendation: **(b), frozen on Oct 31**, because #32 is already on main. Without #26 the cron's `accountFault` log and the hostname sweep budget fix are absent, and the G2.16-live checklist item for `scheduled.ts` is recorded as not shown. Prompt: *"Freeze main at `<sha>`, with or without #26? Go / no-go."*
- **D11. Does the external human review apply before P7 to P10? (owner call, go/no-go at the top of P7, P8, P9, and P10.)** The build execution and agent plan ([doc 10](../v2/10-build-execution-and-agent-plan.md)) asks for a qualified external human review before the first live use of money, tenancy, or security-sensitive production changes. Options: (a) not required for synthetic data and test mode; (b) required. Default: **(a) for test mode and synthetic data**, with (b) kept for the Core live gate. Prompt: *"External review waived for this synthetic, test-mode step? Go / no-go."*

## Rules for the day (repeated at the top of every phase)

1. `nov1` is the only deploy path today. Never run `pnpm --filter <app> run release` or `pnpm deploy:demo` directly.
2. Every `nov1` command is a dry run unless it gets `--live`. A live run also needs `--go <gate>`, a terminal on stdin and stdout, `CI` unset, and the target typed back.
3. Run in a fresh shell on `main` at an approved SHA. Never `export DATABASE_URL`. Source the env file only in the owner's own terminal; `nov1` reads names and strips `CLOUDFLARE_API_TOKEN` from every wrangler child (releases use the OAuth login).
4. Never run `app-role:password` or `test:integration` against Neon main. Either rotates `tidegrid_app` and breaks Hyperdrive.
5. Never use `hostnames disable` as a rollback for a preview or platform name. A disabled name is permanent (`0011_custom_hostname_lifecycle.sql:91-94`).
6. Feature off (a secret delete) comes before any code rollback.
7. Every booker and participant before P7 uses a synthetic `.test` address.

Set up once, in the owner's terminal:

```sh
alias nov1='pnpm --silent --filter @tidegrid/release nov1'
export NOV1_PRIVATE_DIR="$HOME/.config/tidegrid/nov1-private"   # outside the repo and ~/.claude
install -d -m 700 "$NOV1_PRIVATE_DIR"
# NOV1_STATE_DIR defaults to ~/.claude/projects/-Users-jkowall-TideGrid/handoff/nov1 (the journal; no secrets)
```

## Gates

Each gate is a go the owner gives at the time, for that step only.

| Gate | Authorizes | Phase |
|---|---|---|
| A0 | Read-only network: `wrangler whoami`, `deployments list`, `dig`, HTTP smoke | P1, P5 |
| A1 | Neon main: status, backup branch, migrate, seed, outbox summary | P2, P7 |
| A2 | Put `FAKE_PAYMENT_WEBHOOK_SECRET` on the API | P3 |
| A3 | Merge C1 | P3 |
| A4 | Release the API, console, and guest Workers; their rollbacks | P3, P4 |
| A5 | Test traffic on the preview (accept, last-seat, isolation) | P6 |
| A6 | Onboard the email sender domain (writes DNS) | P7 |
| A7 | Put `EMAIL_ALLOWED_RECIPIENTS` | P7 |
| A8 | Merge C2 and release the API | P7 |
| A9 | One real send | P7 |
| A10 | Cutover: platform row, merge C4 and C7, guest release, step 1 rerun | P8 |
| A11 | Real Stripe test-mode calls (`stripe-smoke`); waits on D15 | P9 |
| A12 | Stripe payment account rows | P9 |
| A13 | Merge C5, Stripe secrets, API release | P9 |
| A14 | The Stripe CLI `events resend` | P9 |
| A15 | Enter payment details to enable Custom Hostnames | P10 |
| A16 | Fallback origin record and `PUT fallback_origin` | P10 |
| A17 | Merge C3, put `CF_SAAS_API_TOKEN`, release the API | P10 |
| A18 | `hostnames request` and `activate`; the throwaway name's disable | P10 |
| A19 | Merge C6 (cron pause) and release the API | P11 |

## Decisions (coordinator defaults, pending the owner)

Build-time defaults, already applied: **D10(a)** step 9 by tree equality; **D12(a)** the upgrade proven by a CI test only, which narrows 08:190 ("Test each migration on a production-shaped Neon branch") for Nov 1; **D13(a)** this file's location; **D14(a)** `SEED_DEMO_BOOKINGS` off on main. Every other decision is a go/no-go prompt at the step where it applies; no script assumes an answer.

| # | Decision | Default and why | Asked at |
|---|---|---|---|
| D1 | Preview database: (a) Neon main; (b) a long-lived staging branch (12:27); (c) a branch per session | (a): Hyperdrive `0857f556` and `DATABASE_URL` already point at main, and the role password is set there | P2 top |
| D2 | Release SHA contents | (b), frozen Oct 31 | top, P0.1 |
| D3 | Fake payments on the public preview: (a) P3 to the end of P9; (b) never; (c) always | (a): steps 2, 4, 5, 6 and P7's steps 3 and 8 need it. Anyone holding a paymentRef can confirm a synthetic booking | P3.3, P9 end |
| D4 | Steps 5 and 7 identity: (a) a third Access-allowed address owning demo-harbor only; (b) an admin membership delete; (c) step 7 not shown | (a): reversible by removing the address from Access; keeps the owner's address out of the console | P2.4, P6 |
| D5 | The `*/15` cron on the free plan: (a) keep; (b) pause outside windows (C6); (c) hourly | (b): about 96 wakes a day, each holding compute for the 5-minute autosuspend. Since #32 each run also stamps `sweep_turns` per due tenant (same wakes, a few more writes). Check [Neon pricing](https://neon.com/pricing) | P3.2, P11 |
| D6 | Sender: (a) a subdomain address; (b) the apex default `bookings@tidegrid.us`; (c) defer | (a): keeps a new DMARC policy off all `tidegrid.us` mail. C2 carries `bookings@mail.tidegrid.us` as a placeholder | P7 top |
| D7 | Stripe-live placement: (a) a window after acceptance; (b) a staging Worker; (c) defer | (a): lowest setup cost; must not overlap P6 | P9 top |
| D8 | Cutover today: (a) after acceptance, demo-harbor; (b) defer | (a) only if P6 has no fail; the platform row is permanent | P8 top |
| D9 | GuestGateway opens one connection per call (12:169): (a) accept for owner-only traffic; (b) fix first | (a), with the P11 watch. SaaS stays deferred | P4.2, P10 |
| D11 | External human review | (a) for test mode | top, P7 to P10 |
| D15 | Webhook quick 2xx and IP allowlist (12:181): (a) accept inline, signature-only processing for the test-mode window; (b) land both first | (a) for synthetic test mode, risk recorded; (b) before any live-mode work | P9, before A11 |
| D16 | Stripe key: (a) the existing `sk_test_`; (b) a new `rk_test_` | (a) unless `rk_test_` is confirmed to act through `Stripe-Account` | P9 top |

## Config branches (prepared, pushed, not merged; no pull requests yet)

Each is one small commit. Its pull request targets `main` when the owner opens it on Nov 1. After a merge, record it with `nov1 approve-sha <merge sha> --go <gate>`. The revert is one line: `git revert -m 1 <merge sha>`, through a reviewed pull request, then the same `nov1 release`.

| Branch | Change | Phase and gate | Revert |
|---|---|---|---|
| `nov1/c1-preview` | `PUBLIC_CORS: "dynamic"`, `PAYMENT_PROVIDER: "fake"` in the API's top-level vars | P3, A3 | `git revert -m 1 <C1 merge>`; static CORS is the documented rollback (12:168) |
| `nov1/c2-email` | The `send_email` binding with one `allowed_sender_addresses` entry, `EMAIL_PROVIDER: "cloudflare"`, and `EMAIL_FROM_ADDRESS` equal to that entry (placeholder `bookings@mail.tidegrid.us`; amend to the D6 answer), top level only. Built on C1 | P7, A8 | `git revert -m 1 <C2 merge>` |
| `nov1/c3-saas` | `HOSTNAME_PROVIDER: "cloudflare_saas"`, `CF_SAAS_ZONE_ID` (placeholder; fill in before its pull request). Built on C1 | P10, A17 | `git revert -m 1 <C3 merge>` |
| `nov1/c4-cutover` | Guest route `demo.tidegrid.us`, `workers_dev: false`, and `apps/guest-site/src/static.test.ts` updated to match | P8, A10 | `git revert -m 1 <C4 merge>` |
| `nov1/c5-stripe` | `PAYMENT_PROVIDER: "stripe"`. Built on C1 | P9, A13 | `git revert -m 1 <C5 merge>` (back to fake) |
| `nov1/c6-cron-pause` | `triggers.crons: []`. Built on C1 | P11, A19 | `git revert -m 1 <C6 merge>` |
| `nov1/c7-prototype-release-demo` | Remove the `demo.tidegrid.us` route from `wrangler.prototype.jsonc` (repo root, not `prototypes/guest-flow`) | P8, A10 | `git revert -m 1 <C7 merge>` |

C2, C3, C5, and C6 sit on C1 because they edit the same block of `apps/api-worker/wrangler.jsonc`. After C1 merges, rebase each on `main` before its pull request, so its diff is its own lines only. Every branch passed `pnpm release:dry` and the phase guard for its phase on 2026-10-28 (C7: the JSONC parses; its own dry run needs `npx wrangler@4.125.0`, which would download, so it was not run).

## P0. Prep, Oct 29 to 31 (no live calls)

**P0.1 Freeze the release SHA (Oct 31).**
- Go/no-go: **D2**.
- Command: `git fetch origin && git rev-parse origin/main`, then `nov1 approve-sha <sha> --frozen` (it records the tree id and the last migration file, and asks for the first 12 characters back).
- Verify (**D10(a)**): the four CI jobs are green on the pull request whose merge produced the SHA, and that run's test merge commit has the same tree. Retrieve it (tried on run 40761591333 on 2026-10-28): `gh run view <run id> --log | grep -A1 "git log -1 --format=%H"` prints the merge commit; `git fetch origin <merge>`; then `git rev-parse <merge>^{tree}` must equal `git rev-parse <sha>^{tree}`. The integration, browser, and console-browser jobs run only on pull requests, so a merge commit on main is never itself the head of a run. Branch protection is absent, so merge only when the pull request's last run was against current main.
- Rollback: not applicable.

**P0.2 The upgrade path is green in CI.** `packages/database/src/migrate-upgrade.integration.test.ts`, in the existing integration job on PostgreSQL 17: a scratch database; 0001 and 0002; the b87e269-era seed (`packages/database/test-fixtures/seed-0002-era.sql`); the b87e269 query set (`b87e269-queries.sql`) as `tidegrid_app`; migrate to the tree's last file; the query set again; today's seed twice (the second changes no row count); the query set a third time; drop the scratch database. First green: run 40761591333. Required, because CI otherwise migrates only empty databases, 0011 adds UNIQUE and CHECK constraints over existing `tenant_hostnames` rows, 0003 creates `btree_gist`, and the P3 code rollback needs b87e269 to work on the upgraded schema (08:193).

**P0.3 Script dry runs are green.** `pnpm check` runs the `tools/release` unit tests and `pnpm release:dry`. CI Part B runs `apps/guest-site/e2e/full/release-scripts.spec.ts` (`nov1 smoke`, `last-seat`, `isolation` with `--profile local` against `wrangler dev` on :8961). The console-browser job runs `apps/operator-site/e2e/isolation.spec.ts` locally as a one-tenant identity.

**P0.4 Config branches prepared.** See the table above.

**P0.5 Owner checklist sent.** The [owner inputs](#owner-inputs) table, with the decisions marked.

## P1. Preflight (Nov 1)

Rules for the day apply (see above).

- Input: the frozen SHA; the Neon allowance reset confirmed, with its UTC time; the Mac kept awake (`caffeinate -dims` in a spare terminal; check `pmset -g`); `NOV1_PRIVATE_DIR` created 0700.
- Commands:

```sh
git switch main && git pull --ff-only
pnpm install --frozen-lockfile
nov1 preflight --offline --phase p3
nov1 preflight --network --go A0
```

- Expect: every check PASS; `CLOUDFLARE_API_TOKEN stripped` if the env file was sourced; the login type is OAuth; the pending migrations listed from the tree (0003 to 0013 on main at `894839e`; read from the tree, so a later migration shows up); the deployed version ids of the three Workers.
- Verify: `dig` shows no record for `demo-harbor.book.tidegrid.us` or `demo-reef.book.tidegrid.us`. A record on either is a hard stop for P4.2: a non-TTY deploy would override it (cli.js:153833-153836), and `nov1` always deploys on the terminal so wrangler would prompt.
- Rollback: not applicable.

## P2. Neon and migrations (A1, owner terminal)

Rules for the day apply. Go/no-go: **D1** (Neon main as the preview database). The owner sources the env file in this terminal only; `nov1 db` reads `--url-env NEON_DATABASE_URL` (the default) and maps it to `DATABASE_URL` in the child only. It refuses with `TIDEGRID_EPHEMERAL_DB`, `TIDEGRID_APP_PASSWORD`, `SEED_LOCAL_HOSTNAMES`, `E2E_ADMIN_DATABASE_URL`, an exported `DATABASE_URL`, or `SEED_DEMO_BOOKINGS` in the shell. Run P2, P3, and P4 back to back with no break: from P2.3 to P3.2 the deployed b87e269 serves against the upgraded schema, which P0.2 proved works.

**P2.1 Status.** `nov1 db status --live --go A1` (read-only, so no typed target).
- Expect: 0001 and 0002 applied, the rest pending. Stop if anything else is applied: nothing past 0002 is recorded, but it has not been checked live.

**P2.2 Restore point.** `nov1 db backup --live --go A1` (type the branch name back).
- Command it runs: `pnpm --filter @tidegrid/database neon:branch create pre-nov1-<sha7> --no-expiry --no-endpoint`, with `NEON_API_KEY` and `NEON_PROJECT_ID` passed to the child only.
- Expect: `{"branchId": ...}` and nothing else. A branch with no endpoint has no connection string, so none is fetched or printed. The journal records the branch id and the UTC time, the point-in-time restore anchor.
- Verify: the branch is listed in the Neon console with no compute.
- Rollback: deleting the branch later takes its own approval. This is the only branch create today.

**P2.3 Migrate.** `nov1 db migrate --live --go A1`.
- Expect: each file in its own transaction (`migrate.ts`), under the advisory lock, with `lock_timeout 5000 ms` and `statement_timeout 120000 ms` per file (08:190; override with `TIDEGRID_MIGRATE_LOCK_TIMEOUT_MS` and `TIDEGRID_MIGRATE_STATEMENT_TIMEOUT_MS`); the role assertions pass; `applied 11 migration(s)` on main at `894839e` (more if a later migration lands).
- Verify: `nov1 db status --live --go A1` shows every file applied.
- Rollback: there are no down migrations. A timeout rolls back that file only, and main stays at an intermediate version. Do not release the API until a forward fix lands, or restore from P2.2 (its own approval; it resets everything written after the restore point).

**P2.4 Seed.** Go/no-go: **D4** (the single-tenant identity) and **D14** (stays (a)). Prompt: *"Seed the D4 address as owner of demo-harbor only, with a synthetic display name? Go / no-go."*

```sh
export SEED_OWNER_EMAILS='<the owner addresses already on main>'      # in this terminal only
export SEED_SINGLE_TENANT_OWNER='<the D4 address>:demo-harbor'
export SEED_OWNER_DISPLAY_NAME='Harbor Desk Owner'
nov1 db seed --live --go A1
nov1 db seed --live --go A1   # the second run changes nothing
unset SEED_OWNER_EMAILS SEED_SINGLE_TENANT_OWNER SEED_OWNER_DISPLAY_NAME
```

- Expect: created and unchanged counts, `(N owner address(es) from SEED_OWNER_EMAILS, 1 single-tenant)`; the preview hostnames active and verified. The seed refuses a single-tenant address that is also in `SEED_OWNER_EMAILS`, or one that already belongs to the other operator, before it writes anything.
- Rollback: none needed; the data is synthetic. Memberships are never removed, which is why the overlap is refused.
- Not proven by CI: CI's admin role is a PostgreSQL superuser. On Neon the admin is `neondb_owner`. The seed's payment-account insert runs without tenant context under forced row-level security. It passed on Neon throwaway branches before 2026-10-20, and P2.4 is the first run on main.

## P3. API deploy and secrets (owner terminal)

Rules for the day apply. Run it right after P2.4.

**P3.1 Merge C1 (A3).** Go/no-go: **D3** (fake payments on the public preview until the end of P9). Open the `nov1/c1-preview` pull request to main, wait for its four jobs, merge, then `git pull --ff-only` and `nov1 approve-sha <merge sha> --go A3`.

**P3.2 Release the API.** Go/no-go: **D5** (this release brings the first `*/15` cron to Neon main; pause it in P11 if D5 says so). `nov1 release api --phase p3 --live --go A4` (type `tidegrid-api` back).
- Command it runs: `pnpm --filter @tidegrid/api-worker run release` (`wrangler deploy --var BUILD_ID:$(git describe --always --dirty)`), on the terminal, with an allowlisted environment. Version ids before and after come from `wrangler deployments list --json`, ids only; the listing's author emails are dropped.
- Expect: the API goes first, because the guest Worker binds `tidegrid-api#GuestGateway`.
- Verify: `GET https://api.tidegrid.us/v1/health` shows `version` = the build id, `environment` preview, `database` ok, `migrations.latest` = the tree's last file (memoized 10 s). `nov1` polls it as the release's postcondition.

**P3.3 Secrets (A2).** `nov1 secrets preview --generate FAKE_PAYMENT_WEBHOOK_SECRET --live --go A2`, then `nov1 secrets preview --list --live --go A2`.
- Command it runs: `sh -c 'openssl rand -hex 32 | pnpm exec wrangler secret put FAKE_PAYMENT_WEBHOOK_SECRET'` in `apps/api-worker`. The value goes from openssl into wrangler and never through `nov1`. At least 32 characters (`apps/api-worker/src/env.ts:27`).
- Expect: the list shows `DATABASE_URL` and `FAKE_PAYMENT_WEBHOOK_SECRET`, and nothing for Stripe, email, or SaaS. The journal records the new version id as the rollback anchor (a secret put deploys the running code).

**P3 rollback, in order.**
1. Feature off: `nov1 secrets preview --delete FAKE_PAYMENT_WEBHOOK_SECRET --live --go A2`. Checkout then answers 503.
2. Code: `nov1 release api --phase p3 --rollback --live --go A4`, to the version recorded before P3.2 (b87e269, which P0.2 proved schema-compatible).
3. Config: revert C1, then release. Static CORS is the documented rollback (12:168).
- After a code rollback, a secret change fails with error 10215 (cli.js:299145); `nov1 secrets` refuses and prints the `wrangler versions secret put` then `wrangler versions deploy` path.
- A rollback leaves bound resources unchanged (cli.js:349363). Whether it changes crons or secrets is not documented (unverified).

## P4. Console and guest deploy (A4, owner terminal)

Rules for the day apply.

**P4.1 Console.** `nov1 release console --phase p4 --live --go A4`.
- Command it runs: `vite build && wrangler deploy` (`apps/operator-site/package.json`).
- Verify: an unauthenticated `GET https://console.tidegrid.us/` redirects to `winter-feather-7169.cloudflareaccess.com` (the postcondition).

**P4.2 Guest.** Go/no-go: **D9** (accept one database connection per GuestGateway call for owner-only traffic). Precondition: P1's `dig` showed no record for either preview name. `nov1 release guest --phase p4 --live --go A4`.
- Command it runs: `vite build && node scripts/check-precache.mjs && wrangler deploy`, on the terminal, so any DNS or origin conflict prompts instead of overriding.
- Expect: both preview custom domains attach; DNS records and certificates are created (12:169).
- Verify: `nov1` polls each host until it answers 200 with a valid certificate, for up to 20 minutes. Issuance time for these names is unverified.

**P4 rollback.** `nov1 release guest --phase p4 --rollback --live --go A4`, then the console. Custom domains stay attached after a rollback (cli.js:349363): remove the routes and redeploy, or detach them in the dashboard. For a bad service worker, rebuild and release with `GUEST_SW_KILL_SWITCH=1` set and `--kill-switch` (the one allowed exception to the build-leak check).

## P5. Smoke (A0, read-only HTTP)

```sh
nov1 smoke --profile preview --base https://api.tidegrid.us \
  --hosts demo-harbor.book.tidegrid.us,demo-reef.book.tidegrid.us --build "$(git describe --always --dirty)" \
  --live --go A0
```

- Expect (preview profile): health as in P3.2; `GET /v1/public/tenant` with each host's Origin returns its slug and echoes the Origin in `Access-Control-Allow-Origin`; the shared 404 for the workers.dev origin, an unpublished host, the other host with a port, an http Origin, and a trailing dot; each host's `/manifest.webmanifest` names its own brand; each page carries the CSP from `apps/guest-site/public/_headers:2`; `GET /v1/me` on the public API answers 404 (`gateway.ts:23-35`).
- First exercised today (not provable in CI): the http and port negatives, the staff 404, the release CSP, and the 429 budget. CI's local profile runs the tenant echo, the trailing-dot and unpublished-host negatives, health, and the brand.
- Rollback: not applicable.

## P6. Acceptance on the fake (A5 authorizes test traffic)

Rules for the day apply. Run after 03:00 ET (Nov 1 is the end of US DST). Leave 61 s between suites on the same tenant: the public limiter allows 30 commands per 60 s per address per tenant (`apps/api-worker/wrangler.jsonc:66-70`). Quotes, checkouts, checkout cancels, manage commands, and fake pays all count. Every booker and participant is a synthetic `.test` address, so the P6 mail later fails as `recipient_not_allowed` with no provider call (12:199).

Before steps 5 and 7, go/no-go: **D4**. Prompt: *"Add the D4 address to the Access policy for console.tidegrid.us (an account change)? Go / no-go."* Then one headed one-time-PIN sign-in as the D4 identity, saving the storage state to `$NOV1_PRIVATE_DIR/access-state.json` with mode 0600.

| Step | Command (proposed) | Pass evidence |
|---|---|---|
| 1 | P5, then `E2E_BASE_URL='https://{slug}.book.tidegrid.us' nov1 accept guest --grep 'brand|CacheStorage' --live --go A5` (journey at 375 and 1280) | installability JSON lines; screenshots in `$NOV1_PRIVATE_DIR/traces` |
| 2 and 4 | `E2E_BASE_URL='https://{slug}.book.tidegrid.us' nov1 accept guest --grep 'Demo Reef|Demo Harbor' --project desktop --live --go A5`: a Demo Reef dive at least 3 days out with REEF25; a Demo Harbor charter at least 8 days out on a weekend; parties named through the from-checkout management session; the shim's "Simulate successful payment"; then the dive canceled within policy, asserting `full_refund` (dive cutoff 2880 min, charter 10 080 min, `tools/seed/src/pricing.ts`) | two booking JSON lines; the Reef line also carries `bookingId`, `tripId`, `localDate` for step 7 |
| 5 | `E2E_BASE_URL=https://console.tidegrid.us E2E_STORAGE_STATE="$NOV1_PRIVATE_DIR/access-state.json" E2E_OPERATOR='Demo Harbor Charters' E2E_STAFF_NAME='Harbor Desk Owner' nov1 accept console --grep walk-up --live --go A5` (plus the step 7 variables below, which the console suite reads at load): calendar, search, day CSV, control totals | totals match |
| 6 | `nov1 last-seat --profile preview --api https://api.tidegrid.us --hosts demo-harbor.book.tidegrid.us,demo-reef.book.tidegrid.us --live --go A5` | two JSON lines, each `pass` with `{"201 opened":1,"409 insufficient_capacity":7}` |
| 7 | `E2E_FOREIGN_TENANT_ID=7d1e5b3a-1c2f-4a8e-9b61-0a1c2e3f4a02 E2E_FOREIGN_BOOKING_ID=<Reef bookingId> E2E_FOREIGN_TRIP_ID=<Reef tripId> E2E_FOREIGN_REFERENCE=<Reef reference> E2E_FOREIGN_DATE=<Reef localDate> nov1 accept console --grep 'one-tenant identity' --live --go A5` (with the step 5 variables), then `nov1 isolation --profile preview --api https://api.tidegrid.us --hosts demo-harbor.book.tidegrid.us,demo-reef.book.tidegrid.us --live --go A5` | `memberships.length === 1`, then the probe table: one 403 or 404 shape, no tenant B data |
| 9 | The four job URLs and the tree check (P0.1) for each SHA deployed today | `nov1 evidence --ci <sha>=<merge>` |

Step 6 details (P6, last-seat). Demo Reef, Two-Tank Morning Dive (seat limit 12, party up to 6): two fillers of 6 and 5 are quoted, checked out, and **paid**, so one seat is left; then 8 one-seat quotes; then 8 checkouts at once. Fillers are paid, not left open, because one client address may hold at most 3 open checkouts per operator (`packages/domain-booking/src/checkout.ts:46`); open fillers would turn the racers into `too_many_checkouts` 429s, not capacity 409s. That is 23 limited calls on Reef. Demo Harbor, Private Half-Day Charter: 8 quotes, 8 racing checkouts, 1 pay, 17 calls on its own budget. The first 429 stops the run as `rate-limited`, never as `oversell` or `fail`. From one address the per-client advisory lock (`checkout.ts:177`) serializes the racers, so this shows no oversell through the deployed stack; the database race suites prove concurrent hold acquisition.

Step 4 conflict, resolved: the from-checkout management session (`apps/api-worker/src/routes/manage-public.ts:323-330`, open within an hour of confirmation) needs no email, so step 4 runs here. Steps 3 and 8 cannot: the signing session opens only with the emailed token (`apps/api-worker/src/routes/waivers-public.ts:190-196`).

Step 4's "then the console shows the change" is checked by hand in the console during step 5 (the canceled Reef booking is the D4 identity's tenant B, so the owner's own Access identity reads it). Recorded as a manual check.

Rollback: acceptance writes are permanent synthetic rows; the runtime has no DELETE. Unpaid holds expire after 15 minutes. After the run, delete `$NOV1_PRIVATE_DIR/access-state.json` and `$NOV1_PRIVATE_DIR/traces` together.

## P7. G2.16-live: email, then steps 3 and 8

Rules for the day apply. Go/no-go: **D11**, then **D6**. Prompt: *"Sender `<address>` on `<domain>`, onboarded with SPF, DKIM, and DMARC p=none? Go / no-go."*

- Input: the sender address itself (C2's `EMAIL_FROM_ADDRESS` and its one `allowed_sender_addresses` entry must both equal it; amend C2's placeholder if needed; `nov1 preflight --offline --phase p7` checks it); the DMARC `rua` mailbox; the exact allowlist (each booker and adult participant address, each plus-alias separately, `packages/domain-messaging/src/cloudflare.ts:126-128`); the dashboard settings "Drop suppressed recipients" off and "Email preview" off; whether destination verification is required (A9 settles it).
- Commands, in order:
  1. Onboard the domain in the dashboard (A6, owner; writes DNS).
  2. Merge C2 (rebased on main), then `nov1 approve-sha <merge> --go A8`.
  3. `nov1 release api --phase p7 --live --go A8`.
  4. `nov1 secrets email --put EMAIL_ALLOWED_RECIPIENTS --live --go A7` (the owner types the list at wrangler's prompt), while the new release is the deployed one. The journal records the new anchor.
- Expect: health ok; `nov1 db outbox-summary --live --go A1` shows the P6 backlog ending `failed recipient_not_allowed`, with no provider call (12:198-199), before any step 3 booking.
- **A9:** one booking from one allowlisted address. It settles whether non-verified destinations are accepted, before steps 3 and 8.
- Verify:
  - **Step 3:** a booking from an allowlisted address delivers a confirmation, and its management link opens the booking.
  - **Step 8:** waiver requests arrive, and a participant signs on the owner's phone at 375 px. The link is single-use: the phone or Playwright, not both.
  - SPF, DKIM, and DMARC results, recorded in P12.
- Rollback: first `nov1 secrets email --delete EMAIL_ALLOWED_RECIPIENTS --live --go A7`. An empty fence means email is off (`apps/api-worker/src/email.ts:114-126`), and mail stays queued. Then, if needed, revert C2 and release. Leave the DNS records.

G2.16-live checklist (12:206-212) on Nov 1:

| Checklist item | Nov 1 handling |
|---|---|
| `E_DELIVERY_FAILED` to Rejected with a specific code | Not taken: a code change. Record any observed failure code |
| `messageId` versus `payload.messageId` | Recorded in P12, from the A9 send |
| CR or LF probe in the display name and subject | Not taken by default: it needs a send outside the adapter, a separate owner go |
| Cron `accountFault` log and alert | Not shown: blocked on #26 (`scheduled.ts`) |
| The after-commit claim window | Recorded in P12: whether the step 3 confirmation left after commit or through the cron, from `outbox-summary` timing |
| An account-level stop as a page | Not taken: the owner watches the dashboard during P7. A follow-up |

## P8. Cutover of demo.tidegrid.us (A10, last on the acceptance track)

Rules for the day apply. Go/no-go: **D11**, then **D8**. Prompt: *"P6 had no fail. Cut demo.tidegrid.us over to demo-harbor, permanently? Go / no-go."* The tenant can never change later (`0011_custom_hostname_lifecycle.sql:91-94,104`).

1. Merge C4 and C7, then `nov1 approve-sha <each merge> --go A10`.
2. `nov1 db platform demo-harbor --live --go A10` (type the database host, `demo-harbor`, and `demo.tidegrid.us` back). It refuses unless the journal shows step 6 passed and a C4 merge approved under A10. One transaction: the active, verified `platform` row and its `hostname.platform_added` audit event.
3. Detach `demo.tidegrid.us` from `tidegrid-prototype` in the dashboard.
4. `nov1 release guest --phase p8 --live --go A10`, on the terminal, so any origin conflict prompts.
5. `nov1 smoke --profile preview --base https://api.tidegrid.us --hosts demo.tidegrid.us=demo-harbor --live --go A10`.
6. Rerun step 1: `E2E_BASE_URL=https://demo.tidegrid.us E2E_TENANT=demo-harbor nov1 accept guest --live --go A10`.

- Verify: `demo.tidegrid.us` shows the demo-harbor brand; the workers.dev host answers 404 (12:155); a docs pull request follows for the copy that depends on the cutover (`README.md:26`, `docs/customer/follow-up-message-drafts.md:14-20`).
- Rollback: revert C4 and C7, run `pnpm deploy:demo` on a terminal to reattach the domain to the prototype (wrangler 4.125.0; its non-TTY behavior is unverified), then `nov1 release guest`. Keep the platform row active: disabling it is permanent.

## P9. Stripe-live window

Rules for the day apply. Go/no-go: **D11**, **D7** (after acceptance, not overlapping P6), **D16** (which test key), then **D15** before A11. Prompt: *"Accept inline, signature-only webhook processing for this synthetic test-mode window? Go / no-go."* Under Stripe the fake and staff pay controls answer 404 (12:179), and no browser Element exists (12:173), so nothing from P6 can run in this window.

- Input: the test key in `STRIPE_SECRET_KEY` (`sk_test_` or `rk_test_`; whether `rk_test_` can act through `Stripe-Account` is unconfirmed); the two connected account ids as `STRIPE_ACCT_DEMO_HARBOR` and `STRIPE_ACCT_DEMO_REEF`, with `fees_collector=stripe` and `losses_collector=stripe` confirmed; a Connect-scope webhook endpoint at `https://api.tidegrid.us/v1/webhooks/payments/stripe` with snapshot payloads, API version `2026-09-30.endive`, and the five mapped `payment_intent.*` types; its signing secret.
- Commands:
  1. `nov1 payment-account set demo-harbor stripe --live --go A12`, and the same for demo-reef. The id is read from the environment and redacted in every line.
  2. Merge C5 (rebased on main), then `nov1 approve-sha <merge> --go A13`.
  3. `nov1 release api --phase p9 --live --go A13`.
  4. `nov1 secrets stripe --put STRIPE_SECRET_KEY --live --go A13`, then `--put STRIPE_WEBHOOK_SECRET` (typed at wrangler's prompt). The journal records the anchor.
  5. `nov1 stripe-smoke --tenant demo-harbor --live --go A11`.
- What `stripe-smoke` does: refuses any key not `sk_test_` or `rk_test_`; `GET /v1/account` first, to see the key belongs to the platform; a guest checkout with a preview Origin; confirm the PaymentIntent on the connected account with a declining card, then `pm_card_visa`; wait for the webhook to confirm the booking; cancel through the from-checkout management session and wait for the refund. It spawns nothing, so `--api-key` and `--live` never appear.
- **A14**, the owner's own command: `STRIPE_API_KEY="$STRIPE_SECRET_KEY" stripe events resend <evt_id printed by stripe-smoke> --account <the connected account id>`. Never `--api-key`, never `--live`. Whether the installed CLI honors `STRIPE_API_KEY` is unverified. Expect no `payload_mismatch`.
- Verify: one inbox row per event, the booking confirmed, the refund succeeded. Capture and scrub fixtures per `packages/domain-payments/README.md`.
- Rollback: delete the Stripe secrets if Stripe stays off; revert C5 and release with the fake. `FAKE_PAYMENT_WEBHOOK_SECRET` stays set until the end of P9 (D3). Leave the account rows.
- End of P9, go/no-go **D3**: *"Turn the fake off now? Go / no-go."* If yes, `nov1 secrets preview --delete FAKE_PAYMENT_WEBHOOK_SECRET --live --go A2`.

## P10. Cloudflare for SaaS (deferred by default, D9)

Rules for the day apply. Go/no-go: **D11** and **D9**. Default: not today.

- Input: a second domain the owner controls (a custom name has three or more labels and must not end in `tidegrid.us` or `test`, `0011:340-371`); payment details to enable Custom Hostnames (A15); a zone-scoped token typed only into `wrangler secret put`.
- Commands: fallback origin `saas-fallback.tidegrid.us`, AAAA `100::`, proxied, then `PUT fallback_origin` (A16); fill `CF_SAAS_ZONE_ID` in C3, merge it, `nov1 approve-sha <merge> --go A17`, `nov1 release api --phase p10 --live --go A17`, `nov1 secrets saas --put CF_SAAS_API_TOKEN --live --go A17`; then `hostnames request`, the owner publishes the records, `activate`, `status` (A18, `tools/hostnames/README.md`).
- Open: per-hostname routes versus `*/*`; a `*/*` route may shadow the api, console, and demo domains. No command creates per-hostname routes.
- Rollback: delete the custom hostname at Cloudflare; `nov1 hostname-disable <slug> <throwaway custom name> --live --go A18` (it refuses any preview or platform name, and any row that is not `custom`); revert C3.

## P11. Neon guard and cron pause (A19)

- The owner reads Neon consumption at +2 h and +24 h.
- Go/no-go **D5**: *"Pause the cron between windows? Go / no-go."* If yes: merge C6 (rebased on main), `nov1 approve-sha <merge> --go A19`, `nov1 release api --phase p11 --live --go A19`. The journal records the pause, and the phase guard warns if a later release from main brings the cron back. Whether `triggers.crons: []` removes the schedules is per the Cloudflare docs and unverified locally.
- Correctness does not depend on the sweeps (`apps/api-worker/src/scheduled.ts`), but hold expiry events, email retries, and refund resends lag while paused.
- Watch 15 idle minutes after P3 to see whether Hyperdrive's idle pool blocks autosuspend (unverified).

## P12. Evidence

```sh
nov1 evidence --ci <deployed sha>=<PR run merge sha>[,...] --out nov1-evidence.md
```

- It drafts "Demo acceptance on the preview deployment, November 1, 2026" for `docs/verification-log.md`, in `NOV1_STATE_DIR`, from the journal: each SHA and tree id, the version ids, each step and gate, and the step 9 tree check. It is redacted and holds no address outside the `.test` domains.
- The owner adds: per-step pass, fail, or not shown with its dependency; booking references; CSV totals; race counts; the isolation table; email authentication results; the `messageId` comparison; destination verification; the claim-window observation; the waiver hash; CI run URLs; Neon compute before and after.
- The verification-log pull request follows #26 and the hardening Part E docs.
- Traces and the storage state stay in `$NOV1_PRIVATE_DIR` and are deleted together.

## Unverified (labeled wherever they appear)

- Whether `wrangler rollback` changes crons or secrets. Observed: it does not roll back bound resources (cli.js:349363), and a secret edit after a rollback fails with 10215 (cli.js:299145).
- How wrangler 4.125.0 (`deploy:demo`) behaves without a TTY. Observed for 4.135.0 only (cli.js:153833-153836).
- Whether `triggers.crons: []` removes the schedule on deploy.
- Whether Hyperdrive's idle pool blocks Neon autosuspend.
- How long certificate issuance takes for `*.book.tidegrid.us`.
- What a certificate renewal reports for an active SaaS hostname.
- Whether the installed Stripe CLI honors `STRIPE_API_KEY`.
- Whether destinations must be verified for an unrestricted send binding.
- Whether `neondb_owner` writes the seed's payment accounts on main as the CI superuser does.

## Not taken on Nov 1

- A booted b87e269 Worker against the upgraded schema: replaced by the committed b87e269 query set (P0.2), because booting it needs its tree and toolchain in CI.
- `release` and `deploy:demo` refusing without `NOV1_GO`: outside the owned paths; Rule 1 stands in. A follow-up needs owner approval.
- Guards in `packages/database/src/testing.ts` and `app-role.ts` that refuse a host recorded as main: proposed as a separate goal; the `nov1 db` refusals are the mitigation.
- The G2.11 Stripe Element, bounce ingestion, the webhook quick 2xx and IP allowlist (D15), the GuestGateway connection fix (D9), and a per-hostname route command for SaaS.

## Owner inputs

None goes to an agent. The owner supplies each in the owner's own terminal or the dashboard.

| Input | Phase or gate | Needed by | Status |
|---|---|---|---|
| D1, D3 to D9, D11, D15, D16 answers | each prompt | Nov 1 | pending |
| D2: is #26 in the SHA | P0.1 | Oct 31 | pending (#32 is on main) |
| Neon allowance reset, with its UTC time | P1 | Nov 1 | unknown |
| Free-plan history window and branch limits | P2.2 | Nov 1 | unknown |
| `NEON_DATABASE_URL`, `NEON_API_KEY`, `NEON_PROJECT_ID` in the owner's shell | P2 | Nov 1 | in the env file (not read) |
| `SEED_OWNER_EMAILS`, `SEED_SINGLE_TENANT_OWNER`, `SEED_OWNER_DISPLAY_NAME` | P2.4, D4 | Nov 1 | pending |
| The D4 address added to the Access policy | P6 | before step 5 | account change, its own go |
| `FAKE_PAYMENT_WEBHOOK_SECRET`, generated and piped | P3.3 | Nov 1 | not set |
| Gates A0 to A19, each at the time | each phase | Nov 1 | pending |
| A wrangler OAuth login with Workers deploy rights | P3, P4 | Nov 1 | used for past deploys |
| A one-time-PIN sign-in as the D4 identity, saved to `$NOV1_PRIVATE_DIR` | P6 steps 5 and 7 | Nov 1 | pending |
| Workers Paid | P7 | before P7 | observed yes |
| The sender address, the DMARC `rua` mailbox, the dashboard settings | P7 | before P7 | pending |
| `EMAIL_ALLOWED_RECIPIENTS`, the exact list | P7 | before P7 | pending |
| Destination verification per address, if A9 shows it is needed | P7 | before steps 3 and 8 | unknown |
| A phone for step 8 | P7 | Nov 1 | owner |
| Cutover tenant | P8 | before P8 | default demo-harbor (12:148) |
| Stripe test key, `STRIPE_ACCT_DEMO_HARBOR`, `STRIPE_ACCT_DEMO_REEF`, the webhook signing secret, Accounts v1 or v2, collector settings | P9 | before P9 | reportedly in the env file (not verified) |
| Approval to use the installed Stripe CLI (`/opt/homebrew/bin/stripe`) for `events resend` | P9, A14 | before P9 | installed (observed) |
| A second domain, payment details, a zone-scoped SaaS token, `CF_SAAS_ZONE_ID` | P10 | deferred | the zone has no custom-hostname quota |
| Neon consumption at +2 h and +24 h | P11 | Nov 1 and 2 | owner |
