# Releasing the Workers from GitHub (proposed)

**Status.** Proposed on 2026-11-15 as part of W3-OPS-3 (CI/CD to pilot standard). It has never run: it waits on the one-time setup below. Its choices (R1 to R8) are coordinator defaults pending owner confirmation ([decision register](../v2/06-decision-register.md#2026-11-15-w3-ops-3-releases-from-github-and-pilot-standard-cicd-coordinator-defaults-pending-owner-confirmation)). TideGrid stays exploratory; this commits the owner to nothing.

**Why.** Today a release runs only from the owner's Mac through `nov1`, with the local journal, an approval step, and a typed confirmation for each Worker. The owner asked on 2026-11-11 to stop typing things back and to move releases into GitHub. The [hosting plan](../v2/08-build-hosting-and-operations.md#cicd-ownership-and-flow) already gives GitHub Actions the release flow, with the owner approving the production environment.

## What the workflow does

[`.github/workflows/release.yml`](../../.github/workflows/release.yml), started by hand from `main`.

1. **Gate job, no secrets.** Checks the inputs and that the SHA is a full SHA on `main`. Runs `nov1 ci-check <sha>`: the newest `ci.yml` run on `main` for that SHA is green on all four jobs. For an API release it also reads the API's public health and refuses unless the live database already holds the SHA's last migration file. Migrations go through [neon-migrate](neon-migrate-ci.md) first. A refusal ends the run before anyone is asked to approve.
2. **Release job, on the `production` environment.** Waits for the owner's one approval. Its tooling comes from the workflow's own commit on `main`, so an older SHA is released with today's checks; the SHA itself is checked out beside it, and only its apps are built and uploaded. The job re-checks the SHA, installs dependencies before any secret is in the environment, and releases each chosen Worker in order: API, console, guest site. It stops at the first failure. For each Worker:
   - **Reads what is live.** The current deployment must be one version at 100%. The Worker's custom domains, cron schedules, and workers.dev settings, read from the Cloudflare API, must equal its `wrangler.jsonc`. If they differ, the run refuses before uploading, because the commands below never change them. A change to a domain or a schedule still goes out through `nov1` on the Mac.
   - **Uploads a new version** with `wrangler versions upload --strict`, tagged with the SHA's first 12 characters and a message naming the full SHA and the run. The API gets `BUILD_ID` set to the short SHA, which is what `nov1`'s `git describe` gives while the repository has no tags. Nothing serves the new version yet. The build steps never see the Cloudflare token. With `--strict`, the upload stops, and nothing moves, if the Worker was changed in the dashboard since its last upload; reconcile that change first.
   - **Moves traffic.** `all-at-once` (the default) moves 100% at once. `ten-percent-first` sends 10%, checks the new version directly with Cloudflare's version override header, waits `soak_minutes` (default 10, at most 30, and at most 45 across all the Workers in one run so the job never times out mid-soak) checking every 30 seconds, then moves to 100%.
   - **Checks the result.** The deployment shows the new version alone at 100%. The API's health reports this build with the database ok. The console still sends a signed-out visitor to Cloudflare Access; that answer comes from Access, in front of the Worker, so it shows the host is up, not that the new console version works. Each guest host answers 200.
   - **Rolls back on its own.** If any step fails after traffic moved, it puts the earlier version back at 100%, confirms that, and fails the run. The run says plainly if the rollback did not take.
3. **The release ledger.** Each Worker that got as far as building has one JSON line: kind, Worker, SHA, build, traffic mode, the versions before and after, the outcome (released, rolled back, rollback failed, or failed before traffic), the run's link, and the time. A refusal before the build writes no line; the run log says why. The run summary shows each line in words, and the JSON is kept as the `release-ledger-<run>` artifact for 90 days. GitHub also keeps the run, its approval, and the `production` environment's deployment history, and Cloudflare keeps each version with its tag and message. That replaces the local journal for releases made this way.

Only one release runs at a time, and a running one is never cancelled by a newer one.

No wrangler question is left to a default. `versions deploy` gets every version, every percentage, and `--yes`. `versions upload` gets `--strict`, so where wrangler would otherwise silently override a change made in the dashboard, it stops instead. `versions upload` and `versions deploy` never publish custom domains, DNS records, or cron schedules (wrangler 4.152.0, `cli.js:182059-182066`). That is why the [`nov1` rule](../../tools/release/README.md#safety-model) about running wrangler on a terminal does not apply here: that rule exists because `wrangler deploy` without a terminal overrides DNS records and custom-domain origins.

## One-time setup (owner, about 10 minutes)

1. **A Cloudflare API token.** Cloudflare dashboard, My Profile, API Tokens, Create Token, the "Edit Cloudflare Workers" template. Account resources: the TideGrid account only. Zone resources: `tidegrid.us` only. Copy the token once.
2. **The GitHub environment.** Repository Settings, Environments, New environment, named `production`.
   - Required reviewers: the owner.
   - Deployment branches and tags: selected branches, `main` only.
   - Environment secret `CLOUDFLARE_API_TOKEN`: the token from step 1.
   - Environment variable `CLOUDFLARE_ACCOUNT_ID`: the same account id the `infra-staging` environment already has.
3. Nothing else. The Mac keeps `nov1` as the fallback.

If the first run refuses with "the Cloudflare API refused a read", the token lacks a permission the domain or schedule read needs. Add "Workers Scripts Read" for the account and "Workers Routes Read" for the zone, then run again. Nothing was uploaded.

## A release

1. Merge to `main` and let `ci.yml` finish green on all four jobs.
2. If the merge added migrations, run [neon-migrate](neon-migrate-ci.md) for the same SHA first and approve it.
3. Actions, `release`, Run workflow, branch `main`: action `release`, the full SHA, workers `all`, traffic `all-at-once`. Or `gh workflow run release.yml --ref main -f sha=<full sha>`.
4. GitHub asks the owner to review the `production` deployment. Approve it. That is the only step for the owner.
5. Read the summary: one "released" line per Worker.

## A rollback

Actions, `release`, Run workflow: action `rollback`, one Worker, `rollback_to` either `previous` (the version that served alone at 100% before the current version first went live, so never a 10% split or a release that was just rolled back automatically) or a version id from an earlier ledger line. Approve it. The earlier version comes back with its code, its variables, and the secrets it was made with. The database is not touched: migrations are forward-only and add things, so earlier code still runs on it.

## If it fails

- **Gate refused.** Nothing ran and nobody was asked. Fix what it names (wait for CI, run neon-migrate) and start again.
- **Refused in the release job before upload** (a split deployment, a domain or schedule difference, the Cloudflare API refused a read). Nothing changed.
- **Failed and rolled back.** The earlier version serves again. Read the run log for the failed check.
- **Rollback did not take.** Look at the Worker in the Cloudflare dashboard (Deployments) and put the version from the ledger's `before` back at 100%, or run the rollback action with that version id.
- **The API released but the console or guest failed.** The run stops there. The API runs the new build, the others the old one. That works because the console and guest site talk to the API through stable contracts. Fix and run again for the remaining Workers.

## Not changed

- `nov1` on the Mac stays as the fallback, with its gates, and is still the path for a commit that changes custom domains or cron schedules, for secrets, and for the Nov 1 runbook phases.
- `nov1`'s rule that live steps never run in CI is unchanged: this workflow does not call `nov1 release`, only the read-only `nov1 ci-check`. Its own commands are in [`tools/release/src/gh-release`](../../tools/release/src/gh-release/cli.ts).
- Do not release the same Worker from the Mac while this workflow runs. Its automatic rollback puts back what it saw before it started.
- After a release from GitHub, roll back from GitHub too. `nov1 release --rollback` on the Mac reads its own journal, which does not see GitHub releases.
- Migrations still go through [neon-migrate](neon-migrate-ci.md), with their own approval.
