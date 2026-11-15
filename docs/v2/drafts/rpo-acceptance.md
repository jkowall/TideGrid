# How much booking data could be lost: acceptance for pilot operators (draft)

**Status.** Draft for sign-off, written on 2026-11-15 for W3-OPS-6. Nobody has signed it. The [hosting plan](../08-build-hosting-and-operations.md#backup-and-disaster-recovery) says the pilot accepts a 24-hour loss in the worst case only after the TideGrid owner and each affected pilot operator approve that risk in writing. This is that page. The numbers below are internal targets, not a service-level agreement.

## What TideGrid keeps, in plain words

TideGrid stores your trips, bookings, guests, payments records, and signed waivers in one database, run by a company called Neon. Two things protect it.

1. **Undo history.** Neon keeps a running history of the database for the last 30 days. If something goes wrong inside TideGrid (a bug, a mistaken bulk change, a bad update), TideGrid can bring the data back as it was a few minutes before the problem. You would lose little or nothing.
2. **A daily copy somewhere else.** Once a day TideGrid makes a full copy of the database, locks it with a key that only the TideGrid owner holds, and stores it with a different company (Cloudflare). Copies are kept for 35 days. This is for the rare case where Neon itself loses the database.

## What could be lost

| What happens | What you could lose | How long to get back |
|---|---|---|
| A TideGrid bug or a mistaken change | A few minutes of changes at most | About an hour (target) |
| Neon loses the database entirely | Up to one day of changes: bookings, edits, and check-ins made since the last daily copy | About four hours (target) |

Card payments are recorded by Stripe as well, so money taken in a lost window is not lost. TideGrid would use Stripe's records to rebuild those bookings, and would contact you about anything it cannot rebuild. Bookings taken by phone, cash, or check in that window would need to be entered again from your own notes.

## What you keep doing

Keep the manual fallback the pilot agreement describes: the latest exported departure roster, a way to record changes and payments by hand, and a way to reach guests while TideGrid is down.

## If one day is too much

If you cannot accept losing up to a day of changes in the worst case, say so before you launch. TideGrid would then add a continuous copy to a second provider before your launch, which shrinks the worst case to minutes, and the cost model changes.

## Sign-off

| | Name | Accepts the one-day worst case | Date |
|---|---|---|---|
| TideGrid owner | | | |
| Pilot operator | | | |
