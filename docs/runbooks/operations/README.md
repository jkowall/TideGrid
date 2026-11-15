# When something breaks: operating runbooks

**Status.** Drafted on 2026-11-15 for goal W3-OPS-7, the Core live gate's runbook item. Not yet approved or rehearsed. The [hosting plan](../../v2/08-build-hosting-and-operations.md#required-operating-runbooks) says TideGrid must approve and rehearse these before the first live booking. The owner runs the rehearsals; nothing here has been tried on a live system.

These guides say what to do when a part of TideGrid breaks or needs a routine change during the paid pilots. They are written for the sole TideGrid owner, working alone, in ET business hours. They point to the existing step-by-step runbooks and tools rather than repeat them.

## The ten guides

The hosting plan names ten required runbooks. Each one is a file here.

| # | Guide | Covers |
|---|---|---|
| 1 | [Custom hostnames](01-custom-hostnames.md) | Request, pre-validation, cutover, failure, move, removal |
| 2 | [Operators, staff, and support access](02-operators-and-access.md) | Tenant creation, brand publication, role assignment, support-access expiry |
| 3 | [Payments](03-payments.md) | Stripe onboarding, webhook secret rotation, payment uncertainty, refunds, disputes |
| 4 | [Guest messages](04-guest-messages.md) | Email failures, bounces and suppression, sender domains; SMS (not built) |
| 5 | [Releases and rollback](05-releases-and-rollback.md) | Worker and web deploys, the check after a release, traffic, rollback |
| 6 | [Database changes](06-database-changes.md) | Migrations, backfills, forward fixes, point-in-time restore |
| 7 | [Background jobs and queues](07-background-jobs.md) | The cron sweeps, the outbox, retries, dead letters, replay, duplicates |
| 8 | [Backup and full restore](08-backup-and-restore.md) | Logical backup, key recovery, restore elsewhere, reconciling providers |
| 9 | [Security incidents](09-security-incidents.md) | Tenant escape, leaked secret, lost device, bad upload, waiver evidence access |
| 10 | [Native apps](10-native-apps.md) | Builds, internal testing, store submission and review, phased release, urgent blocks |

Two other pieces of work are in progress at the same time and own their own runbooks: moving releases into GitHub, and backups, restore drills, and alerts. Guides 5 and 8 link to what exists today and say where those runbooks take over. When they land, update the links here rather than copy their steps.

## How each guide is laid out

The hosting plan asks every runbook to name eight things. Each scenario in a guide has a short table with them:

- **Owner.** Who leads. A role, never a person's name or contact.
- **Approval.** What needs the TideGrid owner's explicit go before it runs.
- **Safe first action.** The one step that cannot make things worse.
- **Customer impact check.** How to tell who is affected.
- **Evidence.** Where the record of what happened goes.
- **Limit.** What rollback or recovery cannot undo.
- **Communication.** Who tells the operator, and who tells guests.
- **Closed when.** The test that says the incident is over.

## Roles

Roles only. Names, phone numbers, and addresses live in the owner's private location, never in this repository.

| Role | Who | Does |
|---|---|---|
| Incident lead | The TideGrid owner | Decides severity, approves every live step, writes the record |
| Operator owner | The pilot operator's owner | Runs the manual fallback, tells their own guests, approves refunds and money decisions for their business |
| Operator staff | The operator's booking staff | Follow the operator owner's fallback steps |
| Emergency custodian | Not yet named | Narrow break-glass and safe-shutdown authority if the owner cannot act. The hosting plan requires one before the first live booking |
| Independent observer | Not yet named | Watches at least one full logical-backup restore before launch |
| Agent session | An agent working in the repository | Reads code and logs, drafts fixes and pull requests. Never approves a live step, never touches secrets |

## Severity and response times

Support runs 9:00 a.m. to 5:00 p.m. Eastern Time, Monday to Friday, except US federal holidays. Targets are for acknowledgement and first triage, not for a fix ([hosting plan](../../v2/08-build-hosting-and-operations.md#solo-owner-operating-boundary)).

| Severity | Examples | Response target |
|---|---|---:|
| Critical | Confirmed tenant escape; production database down; a confirmed payment with no booking | 1 business hour |
| High | A booking, waiver, refund, email, or staff workflow is degraded and has no safe normal path | 4 business hours |
| Normal | Settings, reports, docs, or bugs that do not block work | 2 business days |

When unsure, pick the higher severity. It can be lowered later; the record says when and why.

## No paging during the paid pilots

The owner decided on 2026-11-08 that the paid pilots have no paging provider and no long-term log storage ([decision register](../../v2/06-decision-register.md#2026-11-08-stage-0-providers-for-the-paid-pilots-owner-decisions)). What that means in practice:

- Nobody is woken up. Problems are found by the operator, by a guest, by the owner checking in, or by a free uptime alert if the owner adds one.
- Workers Logs keep **seven days**. Anything worth keeping from the logs goes into the incident record within that week, or it is gone.
- Business facts (bookings, payments, refunds, waivers, email, audit rows) live in PostgreSQL for good. Read those first; logs only help with timing.
- The operator's manual fallback (below) is what keeps a business running while TideGrid is down outside support hours.

Both slots come back before the pilots end. When they do, add the alert names to each guide's "Customer impact check".

## The first fifteen minutes, for any incident

1. **Write down the time** (UTC) and what was reported, by whom (role), and the booking references involved. Start the record now; see [Evidence](#evidence-and-the-incident-record).
2. **Check health.** Open `https://api.tidegrid.us/v1/health`. It answers the release version, `database` (`ok`, `error`, or `unconfigured`), and the last applied migration. A `degraded` answer with `database: error` is a database incident (guide 6 or 8).
3. **Pick a severity** from the table above.
4. **Stop the harm, not the cause.** Use the smallest switch from the table below that stops more people being affected. Fix the cause after.
5. **Tell the operator owner** what you know, what they should do now (usually: "use the manual fallback for new sales"), and when you will update them next.
6. **Open the guide** for the area and follow its scenario.

### Switches that stop harm

Each of these needs the owner's go. Each is undone by doing the opposite.

| Problem | Switch | Guide |
|---|---|---|
| Email is going to the wrong people | Put `EMAIL_ALLOWED_RECIPIENTS` to the owner's own inbox only. Everyone else's mail then fails unsent. Do not delete it: in production an empty list means "send to anyone" | [4](04-guest-messages.md) |
| One operator's sending domain is refused | Nothing to switch: only that operator's mail waits | [4](04-guest-messages.md) |
| A bad release | Roll the Worker back to the last good version | [5](05-releases-and-rollback.md) |
| The guest site's offline cache serves a broken page | Release the guest site with the service worker kill switch | [5](05-releases-and-rollback.md) |
| One custom hostname is wrong or hijacked | `nov1 hostname-disable` for that name | [1](01-custom-hostnames.md) |
| Sales on one trip must stop | Close the trip's sales from the console Calendar | [2](02-operators-and-access.md) |
| A staff member must lose access now | Remove them from the Access policy, then disable their membership | [2](02-operators-and-access.md) |
| A secret has leaked | Rotate it (guide 9). Rotation is the switch | [9](09-security-incidents.md) |
| A migration is failing | Do not release the API. Leave the database as it is and forward-fix | [6](06-database-changes.md) |

**Gap:** there is no single verified switch that takes all of TideGrid offline. Removing the API's public domain would not do it: the console and guest site reach the API through Worker bindings, and the cron does not use the domain. A tested safe-shutdown procedure is needed before the first live booking (the emergency custodian's authority depends on it).

## The operator's manual fallback

Every pilot operator keeps a paper-and-phone way to run the day when TideGrid is down ([hosting plan](../../v2/08-build-hosting-and-operations.md#solo-owner-operating-boundary)). TideGrid's part is to make it possible; the operator runs it.

**Before the first live booking**, the operator owner and the TideGrid owner set up together:

1. **Close sales.** Who closes online sales on a trip, and how (the trip's actions on the console Calendar page), and what the operator's website or phone message says instead.
2. **The latest roster.** Each evening, booking staff save the next day's rosters and day export from the console (Roster page, and the Bookings page's day export). Keep the files where the dock can reach them without TideGrid.
3. **Manual changes.** A paper or spreadsheet log for walk-ups, cancellations, and changes taken while TideGrid is down: time, booking reference if any, guest name, party size, what changed, and money taken.
4. **Money.** Take cash, check, or the operator's own card terminal. Record each in the log. **Gap:** the console has no way yet to enter a booking paid outside TideGrid (staff bookings take a card checkout, and the external payments route has no screen). Until one exists, these stay in the operator's log. Closing sales closes a whole trip, not single seats, so any trip that took paper walk-ups stays closed online through recovery until departure.
5. **Waivers.** Paper waivers for anyone who could not sign online. The operator keeps the paper. TideGrid records a legacy waiver status later only if the operator asks.
6. **Contacting guests.** The operator's own phone and email, using the roster file.

**Rehearsal.** Once before the first live booking, then every quarter. The TideGrid owner says "TideGrid is down" at a chosen time on a quiet day. The operator runs one departure's check-in from the saved roster and takes one test walk-up on paper. Write down how long each step took and what was missing. The rehearsal passes when the departure could have left on time.

**After an outage**, staff enter changes the console can take (cancellations, corrected contacts, closed sales) from the manual log, oldest first. The TideGrid owner compares the day's control totals on the Bookings page with the log and lists the difference that stays on paper.

## Talking to people

- **The operator** hears from the TideGrid owner, by the channel agreed at onboarding. Say what is affected, what they should do now, and when the next update comes. Do not guess at a cause until it is known.
- **Guests** hear from the operator, not from TideGrid. TideGrid sends nothing extra to guests during an incident unless the operator asks and the owner approves it.
- **Updates** go at least at the response target interval for the severity, and when anything changes.
- **Never** put a guest's name, email, a payment id, or a link with a secret in a chat, ticket, or the repository. Use booking references.

## Evidence and the incident record

Each incident gets one record, kept in the owner's private incident folder (not this repository, because records can name operators and guests). It holds:

- times in UTC: reported, acknowledged, harm stopped, fixed, closed;
- severity, and any change to it with the reason;
- the operators and booking references affected (no guest names);
- every live step taken, who approved it, and its result;
- links to GitHub runs, pull requests, and audit rows by id;
- log extracts copied within seven days, with personal data removed;
- what went wrong, what fixed it, and the follow-up work.

When an incident changes code, configuration, or a decision, the pull request and the [verification log](../../verification-log.md) get a short entry with ids and times only, and the [decision register](../../v2/06-decision-register.md) gets an entry for any new decision.

## Closing an incident

An incident is closed when all of these are true:

1. The guide's "Closed when" test passes.
2. Every booking reference in the record has been checked and is right.
3. The operator owner has been told it is over and has entered what the console can take from the manual log.
4. Follow-up work is written down (an issue or a tracker item), with an owner.
5. For Critical incidents: a short written review within five business days. What happened, why, and what changes.

## Keeping these guides current

- When a feature changes how something is fixed, the pull request that changes it updates the guide.
- After every incident and every rehearsal, fix what the guide got wrong.
- Review all ten every quarter, at the same time as the restore drill.
