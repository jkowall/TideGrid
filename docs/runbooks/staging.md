# Staging: migrate, deploy, and gather evidence

Staging is the rehearsal copy of TideGrid: the `staging` branch of the Neon project, the `tidegrid-api-staging` Worker on `api-staging.tidegrid.us`, and the `tidegrid-console-staging` Worker on `console-staging.tidegrid.us`. Terraform built its storage, queues, and alerts (docs/runbooks/terraform-apply.md). This runbook covers what runs on it. It holds synthetic data only.

Everything here runs from GitHub, through the `staging` workflow (`.github/workflows/staging.yml`). Start it from main with a full SHA that is on main. Each run waits for the owner's approval on the `infra-staging` environment, then does one of three things.

## What each action does

**deploy**

1. Finds staging with `tools/staging/resolve.sh`. It refuses unless there is exactly one branch named `staging`, that branch is not the project's default branch, and its host differs from main's and is not a pooled endpoint.
2. Applies every pending migration in the SHA's tree to staging, then runs the synthetic seed (idempotent).
3. Deploys the staging API with `wrangler deploy --env staging`.
4. Runs `tools/staging/configure.sh`. The first time, or with `rotate`, it gives `tidegrid_app` a new random password and writes it into the database, the `tidegrid-staging` Hyperdrive config, and the Worker's `DATABASE_URL` secret in one go. Nobody sees it. The Hyperdrive config points at staging's direct host with query caching disabled. It also sets `FIELD_ENCRYPTION_KEYS` and `FAKE_PAYMENT_WEBHOOK_SECRET` when they are missing, and always sets `EMAIL_ALLOWED_RECIPIENTS` to the `ALERT_EMAIL` variable, so staging email reaches only the owner's inbox.
5. Builds and deploys the staging console.
6. Waits until `https://api-staging.tidegrid.us/v1/health` shows the SHA and the last migration.

The Hyperdrive config's id is printed in the run summary. The API's `env.staging` binds it by id in `apps/api-worker/wrangler.jsonc`. Until that binding is committed, staging connects through `DATABASE_URL` directly, and the Hyperdrive probes do not count.

**probes** (needs a deploy first)

- `latency`: 30 timed public reads (trips and tenant) through the Worker, with p50, p95, and max, and the `cf-placement` header Cloudflare adds when Smart Placement runs the Worker away from the visitor.
- `raw` (read-after-write): 20 pairs of "write a quote, read it straight back by id". Any pair that cannot read its own write fails. Pairs are paced to stay under the public write limit (30 a minute per client).
- `restart`: checks that the compute is on the staging branch, restarts it through the Neon API, reads trips once a second until the database answers again, then runs 8 read-after-write pairs on the new connection.

**integration**

Creates a throwaway branch of staging (4-hour expiry, deleted at the end), runs every integration suite on it with the search benchmark on (`TIDEGRID_SEARCH_BENCH=1`, about 50,000 bookings in one tenant), and puts the test totals, the benchmark lines, and the sweep fairness lines in the run summary. The full log is kept as a run artifact for 90 days.

## What staging does not have yet

- No guest booking site. Preview hostnames (`*.book.tidegrid.us`) belong to production, so a staging guest site needs its own host design. The probes send a demo tenant's production origin, which the staging database also knows, straight to the staging API.
- No Turnstile secret, so staging checkout, waiver link renewal, and the dock lookup answer 503 `human_check_unavailable` (they fail closed). A Turnstile widget for a staging guest host comes with the guest site.
- Staff sign-in on `console-staging.tidegrid.us` needs the owner to add that host to the console's Cloudflare Access application.
- Payments use the fake provider.

## If a run fails

Read the failing step's log. The scripts print a short reason and never a connection string or secret. A deploy that fails before the connect step leaves the previous Worker version serving; rerun deploy for the same or a newer SHA. A deploy that fails during the connect step, after the password changed, leaves staging unable to reach its database: rerun deploy with `rotate` checked. Do the same whenever the Hyperdrive config or the database password is in doubt.
