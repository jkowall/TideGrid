# Ops checks runbook (W3-OPS-5)

**Status.** Written on 2026-11-15. The check, its workflow, and this runbook are on main. Nothing is switched on: it runs on a schedule only after the setup below. The owner chose no paging and no long-term logs for the paid pilots ([decision register](../v2/06-decision-register.md), 2026-11-08), so this is the whole alerting setup for now: a GitHub issue, which GitHub emails to the repository's watchers.

## What it checks, every hour

[`.github/workflows/ops-check.yml`](../../.github/workflows/ops-check.yml) runs at 41 minutes past each hour once `OPS_CHECK_ENABLED` is `true`, and by hand any time.

| Line | What it means when it fails | Limit |
|---|---|---|
| Synthetic booking (`{"synthetic": ...}`) | A guest on the synthetic tenant's booking site could not get from the trip list to a held checkout. The `failedStep` says where: `health` (the API or its database), `trips`, `offer`, `quote`, `checkout` (holding seats or creating the Stripe payment), or `cancel` (the hold did not release) | Any failure |
| `finalization_gap` | A guest paid more than 15 minutes ago and has neither a booking nor a refund under way. The most serious line: money taken with nothing to show for it | More than 0 |
| `outbox_oldest_minutes` | Background jobs are stuck: the oldest due job has waited this long | 30 minutes |
| `dead_letters_open` | A background job failed for good and waits for a reviewed replay (`pnpm --filter @tidegrid/database outbox:dlq list`) | More than 0 |
| `email_account_fault` | The email provider refused for the whole account in the last hour: a daily limit, an unverified sender, or a suspended account. No email goes out until it is fixed in the Cloudflare dashboard | More than 0 |
| `email_oldest_due_minutes` | Email is backing up: the oldest due email has waited this long | 60 minutes |
| `cron_quiet_minutes` | The API's 15-minute cron has not run its sweeps for this long | 45 minutes |
| `database_unreadable` | The check could not read the database at all. The run's log (not the issue) has the reason | Any |
| `backup-age` | The newest daily backup is older than 26 hours (only once backups are on) | 26 hours |

The synthetic booking walks the guest's path the way a browser on that tenant's site does: health, trips, the trip's offer, a quote, a checkout that holds one seat and creates the provider payment, then a cancel that releases the seat at once. Nothing is paid, so no booking is made and nobody gets email. The booker is `synthetic-check@example.test`, a domain that never receives mail. Each run leaves one canceled checkout, one voided order, and one unpaid Stripe test payment on the synthetic tenant.

The signals are counts and ages only. No tenant, booking, guest, address, or provider id leaves the database, because the report can land in a public issue.

## When it fails

The workflow opens one issue labeled `ops-alert`, titled with what failed, and comments on it only when what fails changes. When a later run is clean it closes the issue. So an open `ops-alert` issue means "something is wrong now". The issue shows the report lines; the run linked from it has the full log.

The repository is public, so the issue is too. It carries counts and step names, never guest data, but anyone can see that a check failed.

Under the [support hours](../v2/08-build-hosting-and-operations.md#solo-owner-operating-boundary), a `finalization_gap` or `database_unreadable` is Critical, the rest High. There is no 24-hour coverage in the pilot.

## One-time setup (owner)

1. **A synthetic tenant.** The check needs an operator whose trips are synthetic and which no real guest uses. Until there is a dedicated one, `demo-harbor` works: its data is all synthetic. Set the repository variable `SYNTHETIC_ORIGIN` to its booking site origin, for example `https://demo-harbor.book.tidegrid.us`, and optionally `SYNTHETIC_API` (default `https://api.tidegrid.us`). Leave `SYNTHETIC_ORIGIN` unset to skip the synthetic booking.
2. **The `backup` environment.** The check reuses it for `BACKUP_DATABASE_URL` and the backup bucket's token. See the [backup and restore runbook](backup-and-restore.md#one-time-setup-owner). The signals work without backups turned on; the backup age line runs only when `BACKUP_ENABLED` is `true`.
3. **Watch the repository** (GitHub's default for your own repository) so a new issue emails you.
4. **One manual run.** Actions, ops-check, Run workflow, from `main`. Every line should read `ok` and the synthetic line `"pass"`.
5. **Turn the schedule on.** Repository variable `OPS_CHECK_ENABLED` = `true`.

Cost: GitHub Actions minutes are free for a public repository. The database is already woken every 15 minutes by the API's cron, so an hourly check adds next to nothing on Neon. The synthetic booking calls Stripe in test mode once an hour.

## Not covered yet

- **Tenant escape.** No hourly signal. Tenant isolation is proven by the two-tenant tests in CI on every change and by `nov1 isolation` at each release. A runtime signal needs a design (for example, counting refused cross-tenant reads) and is a follow-up.
- **Paging and long-term logs.** Not for the paid pilots (owner, 2026-11-08). Workers Logs keeps seven days. Both return before the pilots end; the hosting plan's every-5-minutes synthetic check and paging come with them.
- **A paid booking.** The synthetic check stops before payment. Proving payment to confirmation needs a Stripe test card from outside the browser and is a follow-up.
