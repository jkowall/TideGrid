# Staging: migrate, deploy, and gather evidence

Staging is the rehearsal copy of TideGrid: the `staging` branch of the Neon project, the `tidegrid-api-staging` Worker on `api-staging.tidegrid.us`, and the `tidegrid-console-staging` Worker on `console-staging.tidegrid.us`. Terraform built its storage, queues, and alerts (docs/runbooks/terraform-apply.md). This runbook covers what runs on it. It holds synthetic data only.

Everything here runs from GitHub, through the `staging` workflow (`.github/workflows/staging.yml`). Start it from main with a full SHA that is on main. Each run waits for the owner's approval on the `infra-staging` environment, then does one of three things.

## Owner setup before the first deploy

The `CLOUDFLARE_API_TOKEN` on `infra-staging` was made for Terraform. Deploying Workers needs more. Edit that token in the Cloudflare dashboard (My Profile, API Tokens) and add:

- Account: Workers Scripts Edit, Hyperdrive Edit.
- Zone `tidegrid.us`: Workers Routes Edit and DNS Edit (the staging hosts are Worker custom domains).

The deploy's preflight step checks that the token can read Workers and Hyperdrive before anything changes, and stops with this page's name if it cannot.

## What each action does

**deploy**

1. Finds staging with `tools/staging/resolve.sh`. It refuses unless there is exactly one branch named `staging`, that branch is not the project's default branch, and its host differs from main's and is not a pooled endpoint.
2. Preflight: the token can read Workers and Hyperdrive, and staging has no migration the SHA lacks (deploy a newer SHA instead).
3. Applies every pending migration in the SHA's tree to staging, then runs the synthetic seed (idempotent).
4. Deploys the staging API with `wrangler deploy --env staging`.
5. Runs `tools/staging/configure.sh`. The first time, or with `rotate`, it gives `tidegrid_app` a new random password and writes it into the database, the `tidegrid-staging` Hyperdrive config, and the Worker's `DATABASE_URL` secret in one go. Nobody sees it. The Hyperdrive config points at staging's direct host with query caching disabled. It also sets `FIELD_ENCRYPTION_KEYS` and `FAKE_PAYMENT_WEBHOOK_SECRET` when they are missing, and always sets `EMAIL_ALLOWED_RECIPIENTS` to the `ALERT_EMAIL` variable, so staging email reaches only the owner's inbox.
6. Builds and deploys the staging console.
7. Waits until `https://api-staging.tidegrid.us/v1/health` shows the SHA and the last migration.

The Hyperdrive config's id is printed in the run summary. The API's `env.staging` binds it by id (`9c9970c1c7fd4433813445cbbfdf3ad1`) in `apps/api-worker/wrangler.jsonc`, so the Worker connects through Hyperdrive and keeps `DATABASE_URL` only as a fallback. If the config is ever deleted and recreated, update that id.

**probes** (needs a deploy first)

- `latency`: 30 timed public reads (trips and tenant) through the Worker, with p50, p95, and max, and the `cf-placement` header Cloudflare adds when Smart Placement runs the Worker away from the visitor.
- `raw` (read-after-write): 20 pairs of "write a quote, read it straight back by id". Any pair that cannot read its own write fails. Pairs are paced to stay under the public write limit (30 a minute per client).
- `restart`: checks that the compute is on the staging branch, restarts it through the Neon API, reads trips once a second until the database answers again, then runs 8 read-after-write pairs on the new connection.

**integration**

Creates a throwaway branch of staging (4-hour expiry, deleted at the end), runs every integration suite on it with the search benchmark on (`TIDEGRID_SEARCH_BENCH=1`, about 50,000 bookings in one tenant), and puts the test totals, the benchmark lines, and the sweep fairness lines in the run summary. Only those filtered lines (totals, failures, benchmark, fairness) are kept, as a run artifact for 90 days. The full log is never stored, because GitHub masks secrets only in the live log; to see a failing test in full, run that suite on a local throwaway database.

## What staging does not have yet

- No guest booking site. Preview hostnames (`*.book.tidegrid.us`) belong to production, so a staging guest site needs its own host design. The probes send a demo tenant's production origin, which the staging database also knows, straight to the staging API.
- No Turnstile secret, so staging checkout, waiver link renewal, and the dock lookup answer 503 `human_check_unavailable` (they fail closed). A Turnstile widget for a staging guest host comes with the guest site.
- Staff sign-in on `console-staging.tidegrid.us` needs the owner to add that host to the console's Cloudflare Access application.
- Payments use the fake provider.

## If a run fails

Read the failing step's log. The scripts print a short reason and never a connection string or secret. Where it stopped decides what to do:

- **Before "Deploy the staging API"** (preflight, migrate, seed): the previous Workers keep serving. Fix the cause and rerun deploy.
- **After the API deploy, before or during "Connect"**: the new API is live, and if the password had already changed, staging cannot reach its database. Rerun deploy with `rotate` checked.
- **At the console deploy or the health check**: the API is connected. Rerun deploy; the console is redeployed and health is checked again.

Rerun with `rotate` checked whenever the Hyperdrive config or the database password is in doubt.
