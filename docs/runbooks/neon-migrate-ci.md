# Neon migrations from CI (proposed)

**Status.** Proposed on 2026-11-08 at the owner's request ("can we push to neon from CI instead of from laptops in the future?"). It has never run. Its choices (N1 to N5) are coordinator defaults the owner confirmed on 2026-11-08 ([decision register](../v2/06-decision-register.md#2026-11-08-neon-migrations-from-ci-owner-request-owner-decision-2026-11-08)). TideGrid stays exploratory; this commits the owner to nothing.

**Why.** Migrations to Neon main run today only from the owner's Mac, through `nov1 db backup` and `nov1 db migrate` in the [Nov 1 runbook](2026-11-01-preview-deploy.md)'s P2. That needs the owner's local env file, the Neon main URL on a laptop, and the local `nov1` journal. The journal drifts between machines: on 2026-11-08 the Mac's journal still recorded a deleted backup branch, so `nov1 db backup` would not make a new restore point. The [hosting plan](../v2/08-build-hosting-and-operations.md#infrastructure-and-configuration-ownership) already puts migration and backup credentials in GitHub environment secrets, and has GitHub Actions own the database flow. This is the first step toward that, for migrations only.

## What the workflow does

[`.github/workflows/neon-migrate.yml`](../../.github/workflows/neon-migrate.yml), started by hand with one input, a full SHA on `main`.

1. **Gate job, no secrets.** Checks that the run started from `main` and that the SHA is a full SHA on `main`. Then, with tooling from the workflow's own commit on `main` (so an older SHA is checked by today's rule), runs `nov1 ci-check <sha>`, the same rule `approve-sha` and `release` use: the newest `ci.yml` run on `main` for that SHA is complete and green on all four jobs. It reads GitHub with the job's read-only token through a throwaway `gh` login. A refusal ends the run before anyone is asked to approve.
2. **Migrate job, on the `neon-main` environment.** Waits for the owner's approval. Then re-checks the SHA, installs dependencies before any secret is in the environment, and:
   - prints `migrate:status`, then reads the whole `schema_migrations` catalog with `psql` and refuses if Neon main has a migration the SHA's tree lacks (the SHA is older than the database), or if a pending file sorts before an applied one;
   - with something pending, creates a restore point: a Neon branch of main named `pre-migrate-<sha7>-r<run id>-<attempt>`, with no compute, expiring after 7 days (restore within that week, or not at all from this branch);
   - runs `migrate` every time (each file in its own transaction under the advisory lock, with the usual lock and statement timeouts). With nothing pending it applies nothing, but its checksum, runtime-role, and invalid-index checks still fail the run on drift;
   - prints `migrate:status` again and fails if anything is still pending.
3. **The record.** The run's summary names the restore point, its UTC time (the point-in-time restore anchor), and the last applied file. GitHub keeps the run, its approval, and the environment's deployment history. That replaces the local journal's `db-backup` and `db-migrate` entries for runs made this way.

Only one run against Neon main goes at a time, and a running one is never cancelled by a newer one. Nothing in the workflow deploys a Worker, puts a secret, or seeds.

## One-time setup (owner, in GitHub settings)

1. **Environment.** Settings, Environments, New environment, named `neon-main`.
   - Required reviewers: the owner.
   - Deployment branches and tags: selected branches, `main` only.
2. **Environment secrets** on `neon-main` (not repository secrets, so only an approved run of a job on that environment can read them):
   - `NEON_DATABASE_URL`: the admin connection string of Neon main, the same value as `NEON_DATABASE_URL` in the owner's demo env file. A direct (unpooled) host.
   - `NEON_API_KEY`: a Neon API key that can create branches in the project. A project-scoped key is preferred where the plan offers one.
   - `NEON_PROJECT_ID`.
3. Merge the pull request that adds the workflow.

## A migrating release

1. Merge to `main` and let `ci.yml` finish green on all four jobs for the SHA.
2. Actions, `neon-migrate`, Run workflow, branch `main`, with the full SHA. Or `gh workflow run neon-migrate.yml --ref main -f sha=<full sha>`.
3. When the gate job passes, GitHub asks the owner to review the `neon-main` deployment. Approve it.
4. Read the summary: the restore point and "pending 0".
5. Release the API from the Mac as before (`nov1 release api`). It still checks `/v1/health` reports the tree's last migration before it deploys.

## If it fails

- **Gate refused.** Nothing touched Neon. Fix what it names (wait for CI, dispatch `ci.yml` for the SHA) and run again.
- **Migrate failed.** The failed file rolled back; earlier files in the run stay applied, so main may be at an intermediate version. Do not release the API. Land a forward fix and run again, or restore from the run's restore point, which takes its own owner approval.
- **Invalid index.** A failed `CREATE INDEX CONCURRENTLY` file leaves an invalid index behind, and the migrator then refuses every run, a forward fix included, until it is repaired. Follow the database README's [repair after a failed concurrent build](../../packages/database/README.md#repair-after-a-failed-concurrent-build), which on Neon main takes the owner's approval.
- **Neon ahead of the SHA after the run.** Another runner (the Mac fallback) migrated while this run went. Do not release the API from this SHA; migrate the newer SHA instead. Do not run `nov1 db migrate` and this workflow at the same time.
- **Restore.** In the Neon console, restore main from the `pre-migrate-...` branch, or to the summary's UTC time. Data written after that point is lost.

## Not changed

- `nov1 db status|backup|migrate` stay available on the Mac as the fallback, with their gates. `nov1`'s rule that live steps never run in CI is unchanged: the workflow does not run `nov1 db`, only the read-only `nov1 ci-check`.
- Worker releases, secrets, and seeds stay on the Mac. Moving them is a proposed follow-up and needs a scoped Cloudflare token.
- The Mac journal's stale `db-backup` entry still blocks `nov1 db backup` there. The workflow names each restore point by run, so it is not affected.
