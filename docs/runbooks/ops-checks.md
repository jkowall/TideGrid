# Ops checks runbook (W3-OPS-5)

**Status.** Written on 2026-11-15. The check, its workflow, and this runbook are on main. Nothing is switched on: it runs on a schedule only after the setup below. The owner chose no paging and no long-term logs for the paid pilots ([decision register](../v2/06-decision-register.md), 2026-11-08), so this is the whole alerting setup for now: a GitHub issue, which GitHub emails to the repository's watchers.

## What it checks, every hour

[`.github/workflows/ops-check.yml`](../../.github/workflows/ops-check.yml) runs at 41 minutes past each hour once `OPS_CHECK_ENABLED` is `true`, and by hand any time.

| Line | What it means when it fails | Limit |
|---|---|---|
| Synthetic booking (`{"synthetic": ...}`) | A guest on the synthetic tenant's booking site could not get from the trip list to a held checkout. The `failedStep` says where: `health` (the API or its database), `trips`, `offer`, `quote`, `checkout` (holding seats or creating the Stripe payment), or `cancel` (the hold did not release) | Any failure |
| `payment_events_stuck` | Stripe told TideGrid about a payment more than 15 minutes ago and TideGrid has not processed it. Guests may have paid with no booking. The most serious line | More than 0 |
| `paid_without_event` | TideGrid's reconciliation asked Stripe, Stripe says paid, and the payment event never arrived (a webhook that is broken or lost). Guests paid with no booking | More than 0 |
| `outbox_stuck_minutes` | Background jobs handed to the queue have not been delivered for this long. Reads 0 until an API binds the outbox queue, which none does yet | 30 minutes |
| `dead_letters_open` | A background job failed for good and waits for a reviewed replay (`pnpm --filter @tidegrid/database outbox:dlq list`) | More than 0 |
| `email_account_fault` | The email provider refused for the whole account in the last hour: a daily limit or a suspended account. No email goes out until it is fixed in the Cloudflare dashboard | More than 0 |
| `database_unreadable` | The check could not read the database at all. The run's log (not the issue) has the reason | Any |
| `malformed_output`, `missing_signals` | The check's own output was not what it expects; treat as broken until looked at | Any |
| `backup-age` | The newest daily backup is older than 26 hours (only once backups are on) | 26 hours |

The synthetic booking walks the guest's path the way a browser on that tenant's site does: health, trips, the trip's offer, a quote, a checkout that holds one seat and creates the provider payment, then a cancel that releases the seat at once. Nothing is paid, so no booking is made and nobody gets email. The booker is `synthetic-check@example.test`, a domain that never receives mail. Each run leaves one canceled checkout, one voided order, and one unpaid Stripe test payment on the synthetic tenant.

The signals are counts and ages only. No tenant, booking, guest, address, or provider id leaves the database, because the report can land in a public issue.

## When it fails

The workflow opens one issue labeled `ops-alert`, titled with what failed, and comments on it (and retitles it) whenever the set of failing lines changes, so a new failure under an open issue still emails you. When a later run is clean it closes the issue. So an open `ops-alert` issue means "something is wrong now". The issue shows the report lines; the run linked from it has the full log.

The repository is public, so the issue is too. It carries counts and step names, never guest data, but anyone can see that a check failed.

Under the [support hours](../v2/08-build-hosting-and-operations.md#solo-owner-operating-boundary), `payment_events_stuck`, `paid_without_event`, or `database_unreadable` is Critical, the rest High. There is no 24-hour coverage in the pilot.

## One-time setup (owner)

1. **A synthetic tenant with test payments.** The check needs an operator whose trips are synthetic and which no real guest uses. Until there is a dedicated one, `demo-harbor` works: its data is all synthetic. Set the repository variable `SYNTHETIC_ORIGIN` to its booking site origin, for example `https://demo-harbor.book.tidegrid.us`, and optionally `SYNTHETIC_API` (default `https://api.tidegrid.us`) and `SYNTHETIC_PARTY` (default 1; set it to the tenant's smallest party if every product needs more guests, or the trip search finds nothing). Its environment needs Stripe test mode and the tenant a connected test account, or the checkout step fails with `payments_unavailable`. Leave `SYNTHETIC_ORIGIN` unset to skip the synthetic booking.
2. **The `backup` environment.** The check reuses it for `BACKUP_DATABASE_URL` and the backup bucket's token. See the [backup and restore runbook](backup-and-restore.md#one-time-setup-owner). The signals work without backups turned on; the backup age line runs only when `BACKUP_ENABLED` is `true`.
3. **Watch the repository** (GitHub's default for your own repository) so a new issue emails you.
4. **One manual run.** Actions, ops-check, Run workflow, from `main`. Every line should read `ok` and the synthetic line `"pass"`.
5. **Turn the schedule on.** Repository variable `OPS_CHECK_ENABLED` = `true`.

Cost: GitHub Actions minutes are free for a public repository. The database is already woken every 15 minutes by the API's cron, so an hourly check adds next to nothing on Neon. The synthetic booking calls Stripe in test mode once an hour.

## Not covered yet

- **The cron stopping.** No signal: the cron writes nothing on a run with no work, so a quiet night and a dead cron look the same in the database. It needs a heartbeat the cron writes on every run (a migration and an API change).
- **Email backlogs.** No signal for old queued email: mail is held on purpose (an operator whose own sender domain is not verified, staff resends waiting out their limits), so age alone would cry wolf. An operator's unverified sender is also left out of `email_account_fault`, since it holds only that operator. The same error from TideGrid's shared sender stops every operator's email, but a message row cannot tell the two apart, so that case is not alerted either; the provider's own dashboard shows it.
- **Balance payments.** The payment lines cover checkout payments; a balance payment that the provider took without a booking update is not checked yet.
- **The check stopping.** GitHub turns off scheduled workflows in a public repository after 60 days without any repository activity, which would stop the backup and this check together, silently. A commit or a manual run resets the clock. An outside dead-man's switch is a follow-up.
- **Least privilege.** The check uses the owner database URL and the backup bucket's read and write token, the same as the daily backup but hourly. Sessions are read-only, but that is a setting the script chooses. A dedicated role that can only read the signals, and a read-only bucket token in their own environment, are a follow-up.

- **Tenant escape.** No hourly signal. Tenant isolation is proven by the two-tenant tests in CI on every change and by `nov1 isolation` at each release. A runtime signal needs a design (for example, counting refused cross-tenant reads) and is a follow-up.
- **Paging and long-term logs.** Not for the paid pilots (owner, 2026-11-08). Workers Logs keeps seven days. Both return before the pilots end; the hosting plan's every-5-minutes synthetic check and paging come with them.
- **A paid booking.** The synthetic check stops before payment. Proving payment to confirmation needs a Stripe test card from outside the browser and is a follow-up.
