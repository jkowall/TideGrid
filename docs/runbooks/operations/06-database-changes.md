# 6. Database changes

Schema migrations, bounded backfills, checking them, forward fixes, and restoring Neon to a point in time.

**Status today.** Migrations run from GitHub through the `neon-migrate` workflow, which makes a 7-day restore branch before it applies anything ([Neon migrations from CI](../neon-migrate-ci.md)). The Mac's `nov1 db migrate` is the fallback. Neon main is the preview database; there is no separate production database yet. Point-in-time restore drills and the daily logical backup belong to the backups work and [guide 8](08-backup-and-restore.md).

**The rules that do not bend** ([hosting plan](../../v2/08-build-hosting-and-operations.md#database-migration-and-rollback-policy)):

- Migrations only add or widen: expand first, contract much later, after nothing uses the old shape.
- Never edit a migration that has run. A fix is a new migration.
- No restore or rollback may throw away confirmed bookings, provider events, payments, refunds, waivers, or audit records. So a bad change is usually fixed forward, not restored away.
- Every migration on Neon main needs the owner's approval of that run.
- Each file runs under a 5 second lock timeout and a 120 second statement timeout. A migration that would rewrite a big table is redesigned, not given more time.

## A normal migration

| | |
|---|---|
| Owner | TideGrid owner |
| Approval | Owner approval on the `neon-main` environment for the run |
| Safe first action | Read the migration's README section, especially "Applying it" |
| Customer impact check | None expected; check health after |
| Evidence | The GitHub run: restore branch name, its UTC time, the last applied file |
| Limit | The restore branch lasts 7 days |
| Communication | None, unless a maintenance window was agreed with operators |
| Closed when | The run says "pending 0" and the API release that needs it is out |

1. Merge to `main`; wait for CI green on all four jobs.
2. Dispatch `neon-migrate` with the full SHA. Approve it when GitHub asks.
3. Read the summary. Then release the API ([guide 5](05-releases-and-rollback.md)).

## A bounded backfill

A backfill fills a new column or table from old data. There is no shared backfill tool yet. Data a migration fills on a small table happens inside that migration.

When one is needed:

1. Write it as a script or migration that works in batches (for example 500 rows), records progress, can stop and restart, and is safe to run twice.
2. Run it on a throwaway Neon branch with production-shaped volume first. Record how long a batch takes.
3. Write down the control totals to check after: row counts and sums that must match between old and new.
4. Run it on Neon main under the owner's go, in a quiet hour.
5. Check the control totals. Keep the numbers in the verification log.

## A migration failed

| | |
|---|---|
| Owner | TideGrid owner |
| Approval | Owner go for any repair command or restore on Neon main |
| Safe first action | **Do not release the API.** The running API keeps working on the database as it is |
| Customer impact check | Health: `database` should still be `ok` |
| Evidence | The failed run's log; incident record |
| Limit | Files before the failed one stay applied |
| Communication | None unless customers were affected |
| Closed when | A forward fix applies cleanly and the release that needed it is out |

1. The failed file rolled back; earlier files in the same run stayed applied. The database may be at an in-between version. That is fine for the running API.
2. Read the error. A lock timeout means something held the table: run again in a quieter moment. A constraint or data error means the migration was wrong: write a new migration that fixes it (a forward fix), merge it, and run again.
3. **An invalid index** from a failed concurrent index build blocks every later run until it is removed. Follow [repair after a failed concurrent build](../../../packages/database/README.md#repair-after-a-failed-concurrent-build). On Neon main, each `DROP INDEX CONCURRENTLY` is a live step with the owner's go.
4. Only restore from the run's restore branch if a forward fix cannot work. That loses data written since.

## A migration succeeded but broke something

| | |
|---|---|
| Owner | TideGrid owner |
| Approval | Owner go for the fix, and separately for any restore |
| Safe first action | Decide: does the old API work with the new schema? If yes, roll the API back first ([guide 5](05-releases-and-rollback.md)) |
| Customer impact check | Errors in Workers Logs; failing bookings or payments |
| Evidence | Incident record with times; the run's restore point |
| Limit | A restore loses every write after its point. Payments and provider events in that window must be reconciled |
| Communication | TideGrid owner tells operators what to do meanwhile (usually the manual fallback) |
| Closed when | The forward fix is applied, the API is on a release that works, and no data was lost, or the loss is reconciled |

Prefer a forward fix, every time. A restore is the last choice because it discards real bookings and payments made since.

## Point-in-time restore

For a bad change to data, from the app, an operator, or a migration, inside Neon's history window.

| | |
|---|---|
| Owner | TideGrid owner |
| Approval | Owner go for the restore and for the cutover, separately |
| Safe first action | Restore to a **new branch**, never over main. Look before switching |
| Customer impact check | List what changed since the chosen point: bookings, payments, refunds, waivers, email |
| Evidence | Incident record: chosen time, branch, checks run, cutover time |
| Limit | Writes after the chosen point are not on the restored branch. They must be re-entered or reconciled. Check Neon's history window for the current plan before relying on it (the hosting plan targets 30 days in production) |
| Communication | TideGrid owner tells operators sales are paused and to use the manual fallback |
| Closed when | The checks below pass on the restored data, the API points at it, and every write in the gap is accounted for |

1. Pick the time just before the bad change. The `neon-migrate` summary gives the exact time for a migration.
2. In the Neon console, create a branch from main at that time. Do not touch main yet.
3. Check the branch: health query, the migration list, one known booking per operator, and the day's control totals.
4. List the writes on main after that time (new bookings, payments, refunds, signed waivers). These are what the restore would lose.
5. Decide with the operator owners: re-enter them by hand after cutover, or fix forward on main instead. If payments are in the gap, reconcile against Stripe after cutover ([guide 8](08-backup-and-restore.md#reconciling-after-any-restore)).
6. Cutover, with the owner's go: close sales, then use Neon's restore on main to the same time. Check in Neon's documentation that main's state from before the restore is kept as a backup branch, so the gap's writes can still be read. Release nothing new. Check health.
7. Run the [reconciliation](08-backup-and-restore.md#reconciling-after-any-restore) and re-enter the gap.
8. Reopen sales.

## Things never to do on Neon main

- Run an integration test suite against it, or `app-role:password` except on purpose with `--neon-main` during a planned rotation ([guide 9](09-security-incidents.md#leaked-secret)). Rotating the runtime role's password breaks the API's database connection until Hyperdrive is updated.
- Create `tidegrid_app` from the Neon console. It must only come from migration 0001.
- Delete rows by hand. The runtime has no DELETE for a reason; state changes are appends.
- Run `nov1 db migrate` and the `neon-migrate` workflow at the same time.
