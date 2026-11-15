# 4. Guest messages

Booking confirmations, management links, waiver requests, reminders, and balance emails. Today all guest messages are email, through Cloudflare Email Service.

**Status today.** Email is live on the preview behind a recipient allowlist (`EMAIL_ALLOWED_RECIPIENTS`), so only listed addresses receive mail. Bounce and spam reports are built but their live queue is not set up yet, so a bounced email still reads "Sent". Per-operator sending domains and suppression lifting are admin CLI commands ([tools/email](../../../tools/email/README.md)).

**SMS is not built.** Transactional SMS (Twilio sender registration, consent, opt-out, replies) is a Staged Core module. An operator can go live without it ([decision register, production gate split](../../v2/06-decision-register.md)). This guide gets an SMS section when that module is built. Until then, email is the only channel and the operator's own phone is the fallback.

**How sending works.** A message is written in the same transaction as the booking change that needs it, then the cron's email sweep sends due messages every 15 minutes. A temporary failure is retried with a later attempt. A message never sends twice for the same purpose. Details: [messaging README](../../../packages/domain-messaging/README.md#delivery).

## Where to look

| What | Where |
|---|---|
| One booking's email and what happened to each | Console, the booking page, Email card |
| Every email that stopped as failed, per operator | Console, **Email exceptions** (`/email-exceptions`) |
| Totals by state, across the system | `nov1 db outbox-summary --live --go A1` (owner terminal) |
| Account-level faults | Workers Logs, search `tidegrid.email_sweep.account_fault` (seven days only) |

## No email is going out for anyone

Guests report no confirmation; the Email card shows messages stuck as "Queued" past their time.

| | |
|---|---|
| Owner | TideGrid owner |
| Approval | Owner go for any secret change or release |
| Safe first action | Read `outbox-summary` and the logs. Change nothing yet |
| Customer impact check | Count of queued messages past due, per operator |
| Evidence | Incident record with counts and times; log extracts within seven days |
| Limit | Messages wait and go when sending works again. A reminder that would arrive too late (trip leaving within 2 hours) cancels itself |
| Communication | TideGrid owner tells operators; operators phone guests leaving soon |
| Closed when | The backlog drains and a new booking's confirmation arrives in an owner inbox |

**High** severity; **Critical** if trips leave today and guests have no links.

1. Check `/v1/health`. If the database is down, see [guide 6](06-database-changes.md).
2. Search the logs for `account_fault`. The codes: `provider_quota_exceeded` (daily sending quota), `sender_not_verified`, `provider_account_suspended`. On these the sweep stops, gives the attempt back, and tries again later, so nothing is lost.
3. Quota: raise the daily quota in Cloudflare, or wait for it to reset. The owner decided the quota is raised before the first operator launches ([decision register, Stage 0 providers](../../v2/06-decision-register.md#2026-11-08-stage-0-providers-for-the-paid-pilots-owner-decisions)).
4. Suspended or not verified: open the Cloudflare dashboard's Email Sending page and fix what it says. Do not change DNS records without reading them first.
5. If the cron itself is failing (no `email_sweep` log lines at all), see [guide 7](07-background-jobs.md).
6. Tell operators to send confirmations by hand to guests leaving in the next day, from the roster.

## Email is going to the wrong people, or the wrong content

| | |
|---|---|
| Owner | TideGrid owner |
| Approval | Owner go for the switch |
| Safe first action | **The switch:** narrow the allowlist to the owner's own inbox: `nov1 secrets email --put EMAIL_ALLOWED_RECIPIENTS --phase <current> --live --go A7`, typing that one address. Every other message then fails unsent as `recipient_not_allowed`. Never delete the secret in production: there an empty list means "send to anyone". Outside production, deleting it turns email off |
| Customer impact check | The affected message ids and booking references from the Email cards |
| Evidence | Incident record; audit rows |
| Limit | Sent email cannot be recalled. Links in it can be closed |
| Communication | Operator contacts affected guests; TideGrid owner writes the wording with them |
| Closed when | The cause is fixed in a release, the allowlist or production setting is back, and a test send is right |

**Critical** if one operator's guests got another operator's email or data: also open [guide 9](09-security-incidents.md#suspected-tenant-escape).

1. Use the switch first.
2. Find what was sent: the Email cards of affected bookings.
3. If links went to the wrong person, close them: correcting the booker's email on the booking closes the old links and sends new ones to the right address. That works only for a confirmed booking whose trip has not left (see [guide 9](09-security-incidents.md#lost-device-or-token) for the gap).
4. Fix the cause in a pull request, release it, then put the full allowlist back under the owner's go. Messages that failed while narrowed are resent from each booking's Email card.

## One guest did not get an email

| | |
|---|---|
| Owner | Operator staff, with TideGrid owner for help |
| Approval | None for a resend within the limits |
| Safe first action | Open the booking's Email card |
| Customer impact check | One booking |
| Evidence | The Email card and the resend ledger |
| Limit | Staff resends are capped per booking. A suppressed address will not send until lifted |
| Communication | Operator tells the guest |
| Closed when | The guest confirms they have it, or staff gave the details another way |

1. The Email card shows the state. "Scheduled" means not due yet. "Sent" means Cloudflare accepted it: ask the guest to check spam.
2. "Bounced" or "Marked as spam" (once the event queue is live): the address is suppressed for that operator. Check the address with the guest and correct it on the booking.
3. "Failed": open Email exceptions for the reason. A wrong address is corrected on the booking. Then use **Send again**.
4. If the guest asks to receive mail again after a complaint, the owner lifts the suppression with the email CLI's `suppression-lift`, with the reason the guest gave. Cloudflare's own suppression list is separate and is managed in the Cloudflare dashboard.

## An operator's own sending domain is refused

Only that operator's mail waits; everyone else's keeps going.

1. `email domain-status <slug>` (email CLI, admin connection).
2. Check Cloudflare shows SPF, DKIM, and DMARC verified, and that the address is in the API Worker's `allowed_sender_addresses`.
3. If it cannot be fixed today, `email domain-retire <slug> <domain> "<reason>"`. What happens next depends on the sender policy: under `shared` the operator's mail goes from the shared sender again; under `operator_only`, the production default, the mail keeps waiting until a domain is verified. Switching production to `shared` affects every operator and needs the owner's go and a reviewed release. Adding it back later is the onboarding order in the [email CLI README](../../../tools/email/README.md).

## Setting up the bounce and spam event queue

Owner steps, not yet done. Create the Cloudflare queue with a retry limit and a dead-letter queue, subscribe it to Email Sending events, bind it to the API Worker, and put the `EMAIL_EVENTS_ACCOUNT_ID` secret. No `nov1` secret set includes that name yet, so it needs adding to the release tool or a reviewed wrangler step. The [messaging README](../../../packages/domain-messaging/README.md#email-events-w1-email-events) lists what the consumer checks. Until it runs, staff cannot see bounces, and the product scope counts that as a Core live gate blocker.
