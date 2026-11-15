# Backup and restore runbook (W3-OPS-6)

**Status.** Written on 2026-11-15. The tooling, the workflows, and the Terraform change are on main. Nothing is switched on: the daily backup needs the one-time setup below, and no live database has been backed up by it yet. The [hosting plan](../v2/08-build-hosting-and-operations.md#backup-and-disaster-recovery) sets the targets; the [decision register](../v2/06-decision-register.md) records the choices.

## What protects the data

Two separate controls, for two different failures.

| Failure | What brings the data back | How much can be lost | Where it lives |
|---|---|---|---|
| A bad change by the app, an operator, or a migration | Neon's point-in-time restore: a new branch of the database as it was at any moment in the history window | Up to about 5 minutes of work, in practice none | Inside Neon. Production keeps 30 days of history (Terraform `history_retention_seconds`); the free plan keeps far less |
| Neon itself is lost: the project, the account, or the region | The daily encrypted logical backup in the backups R2 bucket | Up to one day of work (24-hour planning target) | Cloudflare R2, encrypted with a key that is not in Neon or Cloudflare |

A daily backup cannot get back the last day after a total Neon loss. The [RPO acceptance](../v2/drafts/rpo-acceptance.md) asks each pilot operator to accept that in writing before launch.

## The pieces

- [`tools/backup/`](../../tools/backup/README.md): `backup.sh`, `restore.sh`, `verify.py`, `backup-age.sh`.
- [`.github/workflows/backup.yml`](../../.github/workflows/backup.yml): the daily backup at 07:17 UTC, off until `BACKUP_ENABLED` is `true`.
- [`.github/workflows/restore-drill.yml`](../../.github/workflows/restore-drill.yml): a round trip on every change to the tooling, and the Neon drills by hand.
- Terraform ([environment module](../../infra/terraform/modules/environment/main.tf)): the backups bucket expires objects after 35 days in production and, new here, locks each one for 7 days so the token that writes backups cannot delete recent ones.

## One-time setup (owner)

Do this once for the environment to back up. Nothing here costs money on the current plans except R2 storage, which is a few cents a month at pilot size.

1. **Make the key pair, offline.** On your Mac: `brew install age`, then `age-keygen -o tidegrid-backup.key`. It prints the public key (`age1...`). Keep the private key file in two places outside Neon and Cloudflare, for example your password manager and an encrypted USB stick. Never commit it, paste it into a chat, or add it to GitHub. Losing it means losing every backup made with it.
2. **The bucket.** The Terraform backups bucket (`tidegrid-<environment>-backups`) through the [apply runbook](terraform-apply.md). Until production exists, a bucket in the existing account is enough for staging or the demo database.
3. **A write token for that bucket only.** Cloudflare dashboard, R2, Manage API tokens, Create: permission Object Read and Write, applied to the backups bucket only. Note the access key id, the secret, and the S3 endpoint (`https://<account id>.r2.cloudflarestorage.com`).
4. **The GitHub environment.** Settings, Environments, New environment `backup`. Deployment branches: `main` only. No required reviewer (a scheduled run cannot wait for one). Secrets: `BACKUP_DATABASE_URL` (the direct, unpooled owner URL of the database to back up; the host must not contain `-pooler`), `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT`, `R2_BUCKET`. Variables: `BACKUP_AGE_RECIPIENT` (the public key from step 1) and `BACKUP_LABEL` (for example `production`).
5. **One manual run.** Actions, backup, Run workflow, from `main`. It should end green with a summary line naming the tables, rows, and last migration.
6. **Turn the schedule on.** Settings, Variables, Actions, repository variable `BACKUP_ENABLED` = `true`.
7. **One real restore.** Do the "Restore a real backup" steps below once, with an independent person watching (the hosting plan asks for that before launch and yearly).

The owner URL in a no-reviewer environment is a known risk: any workflow file on `main` could read it. `main` takes changes only through pull requests, and every workflow here opens its database sessions read-only. A dedicated read-only role with `BYPASSRLS` would be narrower; it is a follow-up because Neon creates such roles only through its console or API.

## Drills

### Every change to the tooling (automatic)

`restore-drill.yml` runs on any pull request that touches `tools/backup/`. It migrates and seeds a throwaway PostgreSQL 17, backs it up, restores into a second empty database, and checks it. It restores twice, as a superuser and as a plain role with `--no-owner` (the managed-provider case), and proves the guards: a restore over a database with tables is refused, and five tampered copies, each changed one way (a changed row, row-level security turned off, a policy that leaks reads, one that leaks writes, a grant removed), each fail the check.

### On Neon branches (by hand, owner approves)

Actions, restore-drill, Run workflow from `main`, kind `both` (or `logical` alone). It waits for your approval on the `neon-main` environment, because it uses that environment's Neon API key. It never reads Neon main's URL and never writes to main.

- **Logical drill.** Makes a branch of main now, backs it up with a key made for this run only, restores it into a fresh PostgreSQL 17 in the runner (the "Neon is gone" case), and checks every table's rows match exactly.
- **Point-in-time drill** (with `both`). Makes a branch of main as it was `minutes_ago` minutes back, then checks it against the logical drill's manifest: migrations, every table present, row-level security, policies, grants, and tenant isolation. Row counts differ by design.

Both branches are deleted at the end and expire after 2 hours anyway. Each costs a few minutes of the smallest compute. The run summary records the timings.

Run it before the first live booking and once a quarter after that. Copy the summary into the [verification log](../verification-log.md) with the date and who watched.

### Restore a real backup (owner, or the independent observer)

This is the drill that proves the real key opens a real backup. On your Mac, with the private key:

1. Pick a backup: in the Cloudflare dashboard, R2, the backups bucket, `daily/<year>/<month>/`. Download a `.dump.age` file and the `.json` manifest with the same name.
2. Start an empty PostgreSQL 17 that is not production. Simplest: `tools/local-db/local-db.sh up`, then `psql "<printed DATABASE_URL>" -c "create database restored"`.
3. Run:

   ```sh
   TARGET_DATABASE_URL='<that URL, ending in /restored>' \
   tools/backup/restore.sh --backup <file>.dump.age --manifest <file>.json \
     --identity /path/to/tidegrid-backup.key --throwaway
   ```

4. Every line should start with `ok`, ending with `{"verify": "pass", ...}`. Note the timings it prints.
5. `tools/local-db/local-db.sh down`, and delete the downloaded files.

## Recovering for real

### A bad change (point-in-time)

1. Stop new writes so nothing lands on top. TideGrid has no maintenance switch yet (a follow-up), so for now, in the Cloudflare dashboard: remove the API Worker's custom domain and its cron trigger; remove the staff console's custom domain too, because the console reaches the API through a direct Worker link, not the domain; and pause any queue consumer on the API Worker. Then wait five minutes so work already running finishes. Put everything back after the cutover.
2. In the Neon console, Branches, main, Restore, choose a moment just before the bad change, restore to a **new branch** (never in place first).
3. Check the new branch: `TARGET_DATABASE_URL='<new branch URL>' python3 -I tools/backup/verify.py --manifest <the latest backup's manifest>`. Then look at the rows the bad change touched.
4. Reconcile against Stripe and the email provider for the window between the restore moment and now: payments taken, refunds made, and emails sent in that window exist outside the database. List them before cutting over.
5. Cut over only with the owner's go: Neon's restore of main from that branch, or point Hyperdrive at the new branch. Then reopen writes.

### Neon is gone (logical backup)

1. Create a new PostgreSQL 17 (a new Neon project, or another provider).
2. Restore the newest backup with `restore.sh` as in "Restore a real backup". On a managed provider without superuser, add `--no-owner`: the restoring role then owns every table and gets migrations 0001 and 0002's default privileges. If `tidegrid_app` already exists there, the restoring role needs `ADMIN` on it for the tenant checks.
3. Give `tidegrid_app` a password (`pnpm --filter @tidegrid/database app-role:password`), point Hyperdrive and the release tooling at the new database, and run `pnpm --filter @tidegrid/database migrate:status`: it should list every migration as applied.
4. Reconcile the gap since the backup's `startedAt` against Stripe, email, and import records before reopening writes. Bookings and payments made in that gap must be re-entered from the provider records.

## Watching backup age

GitHub turns off scheduled workflows in a public repository after 60 days without repository activity. That would stop the daily backup and the hourly ops check together, without a sound. A commit or a manual run resets the clock.


`backup-age.sh` fails when the newest backup is more than 26 hours old. The backup workflow runs it after each upload (limit 1 hour), and the [ops check](ops-checks.md) runs it every hour. A red run emails whoever GitHub notifies for this repository's workflow failures; the ops check also opens an issue.
