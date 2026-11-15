# 7. Background jobs and queues

The scheduled sweeps, the outbox and its queue, retries, dead letters, replay, and duplicate handling.

**How it works.** The API Worker runs one cron every 15 minutes. It runs its jobs in order on one connection ([`scheduled.ts`](../../../apps/api-worker/src/scheduled.ts)):

1. Hold sweep: expires capacity holds past their time.
2. Checkout sweep: expires old checkouts, finishes provider events a failed request left behind, resends refunds whose outcome is unknown with the same key. Then the reconciliation sweep: TideGrid's fee, fee invoices, and provider readings of pending payments.
3. Waiver reminders, import waiver email, then the email sweep (skipped while email is off).
4. Custom hostname readings (skipped while custom hostnames are off).
5. Outbox publisher (skipped while no outbox queue is bound, which today is every deployed setup).
6. Cleanup of old idempotency keys and unused quotes.
7. Retention: redacts the booker on checkouts abandoned more than 30 days.
8. Dock QR lookups older than 30 days.

**The safety rule.** No booking, payment, or refund is ever correct only because a sweep ran. Requests do their own work; sweeps write the facts down and finish interrupted work. A failed job is logged and fails that cron run. The next run 15 minutes later starts over. Every job is safe to run twice.

**Where to look.** Workers Logs, last seven days only. Each job logs one summary line named after it (`hold_sweep`, `checkout_sweep`, `reconciliation_sweep`, `email_sweep`, and so on) with counts and `duration_ms`, and a `..._failed` line on errors.

## The cron stopped or keeps failing

| | |
|---|---|
| Owner | TideGrid owner |
| Approval | None to read; owner go for any release or Cloudflare change |
| Safe first action | Search the logs for the last summary line of each job |
| Customer impact check | Holds not expiring (trips look full); refunds not retried; email not going out |
| Evidence | Incident record with the last good run's time and the failing job's error type |
| Limit | Nothing is lost while the cron is down; work waits. Email reminders that become too late cancel themselves |
| Communication | TideGrid owner tells operators if trips show fewer free seats than they should |
| Closed when | Two runs in a row log, for every job, either its summary line with no failures or its expected `..._skipped` line (for example `outbox_publish_skipped` with `queue_unconfigured`) |

**High** if holds stop expiring (trips look full when they are not).

1. Find the job that fails first. Later jobs do not run after a failure, so one broken job stops the rest.
2. `database_unconfigured` or connection errors: check `/v1/health`. A database problem is [guide 6](06-database-changes.md).
3. One tenant failing (`..._tenant_failed`): the other tenants still run. Note the tenant and error type and ask an agent session to trace it in a pull request.
4. A job that runs out of its time budget logs `complete: false` and picks up next run. That is normal after a backlog. Repeated for hours, it is not: open a **High** incident.
5. The cron trigger itself: check the Worker's triggers in Cloudflare show `*/15 * * * *`. A rollback may or may not keep crons; the release runbook marks that unverified.
6. A code fix ships as a normal release ([guide 5](05-releases-and-rollback.md)).

## A checkout or hold looks stuck

The sweep never waits on a lock. A checkout another request is holding is skipped and tried next run. A checkout whose hold is missing is reported every run as `InconsistentCheckoutError` with its id, and left open. That should not happen without someone bypassing the database's checks. Treat it as a **High** incident and ask an agent session to explain the row before changing anything.

## The outbox and dead letters

The outbox holds events other parts of the system need, written in the same transaction as the change. When a queue is bound, the cron publishes due events to it and the consumer runs each handler once. Handler results are recorded per event, so a duplicate, a retry, or a replay never runs a handler twice. Delivery is at least once: an effect outside the database may repeat if the Worker dies before its commit. Details: [database README, delivery foundation](../../../packages/database/README.md#delivery-foundation-0023).

**Today no deployed setup binds the outbox queue**, so this section applies once one is created (Terraform plans it). Until then, events wait in the outbox and nothing is lost.

### An event keeps failing (dead letter)

| | |
|---|---|
| Owner | TideGrid owner |
| Approval | Owner go for each replay (`--go`) |
| Safe first action | `pnpm --filter @tidegrid/database outbox:dlq list`, read-only |
| Customer impact check | The dead letter's tenant, topic, and failing handler |
| Evidence | The dead letter row; the replay's audit row with its reason |
| Limit | Rows are never deleted. A replay runs only handlers that have no result yet |
| Communication | Operator only if a guest-visible effect was missed |
| Closed when | The replayed event shows delivered, and no new dead letter opens for it |

1. `outbox:dlq list` prints each open dead letter: event, topic, handler, error code, attempts, and source (`consumer`, `queue`, or `publisher`). Never a payload.
2. Find why the handler failed. Usually a code bug. Fix it and release first. Replaying before the fix only fails again.
3. `outbox:dlq replay --tenant <uuid> --id <id> --operator "<role>" --reason "<why it is safe now>"` prints what it would do. Add `--go` to run it, with the owner's approval.
4. While a dead letter is open, later hints for that event are parked, not run. Only a replay reopens it.

### The queue is down

The publisher marks an event published only after the queue accepts it. A refused send leaves the batch as it was, due again in five minutes, so a queue outage never makes dead letters. An event published but not delivered in 15 minutes is sent again; after 10 sends it becomes a dead letter. Wait for the queue to recover, then check `outbox:dlq list`.

## Duplicates

Things that look like duplicates, and why they are safe:

- **A guest pressed pay twice.** Checkouts use idempotency keys; a repeat returns the first answer.
- **Stripe sent the same event twice.** The payment inbox keeps one row per provider event id.
- **A refund was retried.** Every retry uses the refund's own key, so the provider refunds once.
- **The same email twice.** Each message has a key that names its purpose, once per tenant, for good. Two copies in an inbox usually means a staff resend, which the Email card shows.

If something truly happened twice (two bookings for one payment, two refunds), it is a **Critical** incident: stop and follow [guide 3](03-payments.md) and [guide 9](09-security-incidents.md) as needed, and keep every row as evidence.

## Recovering after a provider outage

When Stripe or Cloudflare Email was down:

1. Payments need no replay by hand: the checkout sweep finishes received events and retries refunds. Email needs a look: the email sweep retries temporary failures and gives back attempts lost to account faults.
   An email whose send timed out or had an unknown result is marked `outcome_unknown` and is never sent again, because Cloudflare does not deduplicate. After an email outage, open Email exceptions for each operator and have staff send those again or contact the guests.
2. Watch two cron runs. Check the refund and payment exception lists ([guide 3](03-payments.md#where-to-look)) and Email exceptions ([guide 4](04-guest-messages.md#where-to-look)).
3. Stripe resends undelivered webhook events for a few days. If the outage was longer, compare the operator's Stripe dashboard with the money report for the gap.
