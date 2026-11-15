# 8. Backup and full restore

What to do when Neon itself is lost or unusable: restoring the daily logical backup to another PostgreSQL, recovering the key that decrypts it, and reconciling with Stripe and email afterwards.

**Status today.** The daily encrypted logical backup, its bucket, the restore tooling, and the restore drills are being built in separate work ("backups, restore drills, and alerts"). Its runbook will hold the exact commands. This guide covers when to use a full restore, who decides, and how to check the result and bring the business back. When the backup runbook lands, link it here and keep the commands there only.

**Which restore?**

| What went wrong | Use | Planning recovery point | Planning time to recover |
|---|---|---:|---:|
| Bad data from the app, staff, or a migration | Neon point-in-time restore ([guide 6](06-database-changes.md#point-in-time-restore)) | 5 minutes | 60 minutes |
| A migration went wrong | The migration's restore branch, then a forward fix ([guide 6](06-database-changes.md#a-migration-failed)) | 5 minutes | 60 minutes |
| Neon project, account, or region lost | Logical backup to a new PostgreSQL (this guide) | 24 hours | 4 hours |
| Waiver PDFs lost or damaged | Object inventory and hashes (not built yet) | Not chosen | Not chosen |

These are internal targets from the [hosting plan](../../v2/08-build-hosting-and-operations.md#backup-and-disaster-recovery), not promises to customers. A 24-hour recovery point after losing Neon is accepted for the pilots only once the TideGrid owner and each pilot operator agree in writing.

## Neon is gone or unusable

| | |
|---|---|
| Owner | TideGrid owner |
| Approval | Owner go for each step. The emergency custodian may act only on safe shutdown |
| Safe first action | Confirm it is not a short outage: Neon's status page, `/v1/health`, and a direct connection test |
| Customer impact check | Every operator: no bookings, no console. Count departures today and tomorrow |
| Evidence | Incident record with times of each step; the restore log; the reconciliation results |
| Limit | Up to a day of data may be missing: everything after the last backup |
| Communication | TideGrid owner tells every operator at once to switch to the manual fallback |
| Closed when | The checks below pass on the new database, the API points at it, the gap is reconciled, and sales reopen |

**Critical.**

1. **Tell operators first.** Manual fallback for all sales and check-ins ([README](README.md#the-operators-manual-fallback)).
2. **Wait or restore?** If Neon says it will be back within the 4-hour target and data is intact, wait. Otherwise restore.
3. **Get the key.** The decryption key and recovery steps are kept outside Neon and outside the Worker's Cloudflare account. The owner fetches them from the private recovery location. If the owner cannot, the emergency custodian hands over the recovery material under the break-glass process.
4. **Restore** the newest verified backup to a new standard PostgreSQL target, following the backup runbook. Check the dump's checksum and schema version before loading it.
5. **Check** before anything connects:
   - the migration list matches the last applied file in the backup's record;
   - the runtime role `tidegrid_app` exists as a plain role with no extra rights;
   - row counts per tenant for bookings, payments, refunds, and waiver evidence match the backup's record;
   - the tenant isolation checks pass (two operators, nothing crosses);
   - one known booking per operator reads correctly.
6. **Pause before connecting.** **Gap:** there is no single verified pause for guest and staff requests, the cron, and email. Proposed until one exists, untested: close sales on every trip, and release an API build with the cron trigger removed and `EMAIL_PROVIDER` unset (a reviewed configuration change), so restored rows are not processed or emailed. Narrowing the email allowlist is not enough here, because it fails messages instead of keeping them.
7. **Point the API at it**: update Hyperdrive's origin to the new database, set the runtime role's password there, then check `/v1/health`. This is a live change with the owner's go.
8. **Reconcile** (next section). Turn the cron and email back on only after it, with the owner's go.
9. **Reopen** one operator at a time. Staff enter their manual logs.

## Reconciling after any restore

Run this after a point-in-time restore or a full restore, before sales reopen. The goal is that TideGrid's records match what really happened at Stripe and in guests' inboxes during the gap.

| | |
|---|---|
| Owner | TideGrid owner |
| Approval | Owner go before entering anything that moves money or sends email |
| Safe first action | Write down the gap: from the restored point to the time sales closed |
| Customer impact check | Each booking, payment, refund, and dispute in the gap |
| Evidence | A reconciliation sheet per operator in the incident folder |
| Limit | TideGrid cannot recreate a guest's signature. A waiver signed in the gap is asked for again |
| Communication | Operator contacts guests whose bookings or waivers must be redone |
| Closed when | Every item in the gap is matched, re-entered, refunded, or written off with the operator's agreement |

1. **Payments.** In each operator's Stripe dashboard, list payments, refunds, and disputes in the gap. For each, find the TideGrid booking. Where the payment or refund row survived the restore, replaying Stripe's event from its dashboard lets the inbox record what was missed. Where the row itself was lost, a replay does nothing (it answers `unmatched_payment` or `unmatched_refund`). Those need the operator's decision (refund in Stripe, or book the guest again) and a reviewed reconstruction of the record, with the accounting outcome written in the reconciliation sheet.
2. **Bookings.** Compare the operator's manual log and the money report. Re-enter missing bookings from the console where it can take them. Bookings paid outside TideGrid have no console path yet and stay on the log.
3. **Email.** Guests may have received email for bookings that no longer exist. The operator tells them. Messages that were queued but not sent before the restore point will send again; check the email backlog before turning email back on.
4. **Waivers.** Signed waivers in the gap are gone from TideGrid. Send new requests for those guests.
5. **Imports and hostnames.** Check any import batch saved in the gap, and any hostname change.
6. **Control totals.** For each operator, the Bookings page's day totals for each affected day match the manual log plus Stripe.

## Restore drills

Run both a Neon point-in-time drill and a logical backup drill before the first live booking and once a quarter, on throwaway targets only. An independent qualified person watches one full logical restore before launch and once a year. Record times against the targets above. The drill steps live in the backup runbook.
