# 3. Payments

Connecting an operator's Stripe account, rotating the webhook secret, and what to do when a payment, refund, or dispute does not look right.

**Status today.** The live preview uses the fake payment provider. The Stripe adapter is built and off by default ([payments README](../../../packages/domain-payments/README.md#the-stripe-adapter-proposed-off-by-default)); it has run only in Stripe test mode. Live mode is a separate owner window ([Nov 1 runbook](../2026-11-01-preview-deploy.md#p9-stripe-live-window) P9).

**The rule that keeps money safe.** PostgreSQL is the record of truth. Only a verified provider event confirms or fails a payment. A reading from the provider never changes a payment on its own; a disagreement is listed for staff ([decision register, 2026-11-10 reconciliation defaults](../../v2/06-decision-register.md)). Refunds carry an idempotency key, so sending one again can never refund twice. Never "fix" a payment by editing the database.

**Who decides money.** The operator owns their Stripe account, refunds, and disputes. TideGrid finds and explains; the operator owner decides what the guest gets.

## Where to look

| What | Where |
|---|---|
| A payment came in but no booking was made, or the reverse | Console, **Payment exceptions** (`/exceptions`) |
| A refund has no final answer after 24 hours, or changed after it settled | `GET /v1/staff/tenants/{tenantId}/refund-exceptions` (no console page yet) |
| A pending payment the provider reads differently | `GET .../payment-reconciliation-exceptions` (no console page yet) |
| Disputes | `GET .../disputes` (no console page yet) |
| Money in and out for a period | `GET .../money-report` and `.../money-export` (CSV) |
| One booking's payment, refunds, and timeline | Console, the booking page |

## Connecting an operator's Stripe account

| | |
|---|---|
| Owner | Operator owner (their account); TideGrid owner (the link) |
| Approval | Owner go for `nov1 payment-account set`, an admin write to production |
| Safe first action | Do it in Stripe test mode on staging first |
| Customer impact check | A test checkout on staging completes and the booking shows paid |
| Evidence | Change record: slug, account mode, time. No account id in the repository |
| Limit | Live keys never go through the release tool's file input; the owner types them |
| Communication | TideGrid owner tells the operator owner when online payments are on |
| Closed when | One real low-value booking pays, confirms, and appears in the operator's Stripe dashboard |

1. The operator completes Stripe's connected-account onboarding.
2. Put the account reference in the shell as `STRIPE_ACCT_<SLUG>`, then `nov1 payment-account set <slug> stripe`.
3. Run `nov1 stripe-smoke` in test mode before any live step.

## Rotating the webhook secret

Do this on a schedule, and at once if the secret may have leaked ([guide 9](09-security-incidents.md#leaked-secret)).

| | |
|---|---|
| Owner | TideGrid owner |
| Approval | Owner go for the secret put |
| Safe first action | In Stripe, add a second signing secret to the endpoint and keep the old one active |
| Customer impact check | Stripe's endpoint page shows recent deliveries succeeding |
| Evidence | Change record with the time of each step; the release tool's journal |
| Limit | Events Stripe could not deliver while the secret was wrong are retried by Stripe for a few days, not forever |
| Communication | None unless deliveries failed |
| Closed when | Deliveries succeed with the new secret and the old one is removed in Stripe |

1. In Stripe, roll the endpoint's signing secret with an overlap period. While both are active, Stripe signs with both, and the API accepts any matching signature ([payments README](../../../packages/domain-payments/README.md#webhook-signatures)).
2. Put the new value: `nov1 secrets <set> --put STRIPE_WEBHOOK_SECRET`. Type it at the prompt; never into a file for live mode.
3. Send a test event from Stripe and check it is accepted.
4. End the overlap in Stripe.

If deliveries failed while the secret was wrong, Stripe retries them. The checkout sweep also processes any event that was received but not finished.

## A guest paid, but has no booking ("payment uncertainty")

The guest says they were charged but got no confirmation, or the Payment exceptions page lists one.

| | |
|---|---|
| Owner | TideGrid owner investigates; operator owner decides the remedy |
| Approval | No approval to read. Any refund outside the automatic one is the operator's decision |
| Safe first action | Ask for the booking reference or the time and amount. Do not take a second payment |
| Customer impact check | Count of open payment exceptions per operator; the money report for the day |
| Evidence | The exception, its resolution, the payment's events |
| Limit | Seats released when the checkout expired may have sold to someone else |
| Communication | Operator contacts the guest |
| Closed when | The exception is resolved in the console with a reason, and the guest has a booking or their money back |

This is a **Critical** incident if TideGrid shows a succeeded payment with no booking and no automatic refund.

1. Open **Payment exceptions** in the console. Each row says in plain words what happened: usually the payment arrived after the checkout ran out.
2. TideGrid refunds a late payment on its own. Check the refund on the booking or the exception. While that refund is still requested, the exception cannot be resolved yet.
3. If seats are still free and the guest wants to go, staff book them again from the console and the guest pays again; the first payment is refunded.
4. Mark the exception followed up with a reason: contacted guest, refunded outside, no action needed, or other with a note.
5. If no exception exists but the guest shows a charge, search by email or time. If nothing matches, check the operator's Stripe dashboard; the charge may belong to another system.

## A refund is stuck or wrong

| | |
|---|---|
| Owner | TideGrid owner |
| Approval | Owner go before any external refund or credit adjustment is entered for the operator |
| Safe first action | Read the refund exceptions list. Do not press refund again |
| Customer impact check | Refunds in `requested` or `pending` older than a day, per operator |
| Evidence | The refund row, its exception, the provider's refund id (masked in notes) |
| Limit | A refund marked failed stays failed. Money settled outside TideGrid is recorded, never pushed back through the card |
| Communication | Operator tells the guest when the money will arrive |
| Closed when | The refund reads `succeeded`, or staff recorded how it was settled outside TideGrid |

1. Read `GET .../refund-exceptions`. The reasons: `unsettled` (no final answer 24 hours after asking), `lookup_refused`, `failed_after_success`, `succeeded_after_failure`.
2. `unsettled`: the sweep asks the provider again every hour with the same key. Check the operator's Stripe dashboard for the refund. If Stripe shows it done, wait for the event; Stripe resends it.
3. `failed_after_success` or `succeeded_after_failure`: the guest may have been told the wrong thing. The operator tells the guest what actually happened.
4. If the operator refunds by cash or check instead, staff record it as an external settlement on the booking.

## A dispute (chargeback) opens

| | |
|---|---|
| Owner | Operator owner (it is their merchant account) |
| Approval | Operator owner answers Stripe; TideGrid does not |
| Safe first action | Read the dispute and the booking, and send the operator the booking's facts |
| Customer impact check | `GET .../disputes` for open ones |
| Evidence | The dispute row and its events |
| Limit | A lost dispute counts as money out; later refunds are capped by it |
| Communication | Operator answers Stripe and the guest |
| Closed when | Stripe shows it won, lost, or closed, and TideGrid's row says the same |

1. TideGrid records disputes from Stripe's events. It does not answer them.
2. Give the operator owner the booking's timeline, the waiver status, and whether the trip ran.
3. Check the dispute row moves to its final state after Stripe decides.

## Reconciliation disagrees

The sweep reads Stripe about pending payments past their checkout's hold. A disagreement becomes a reconciliation exception. It never changes the payment.

1. Read `GET .../payment-reconciliation-exceptions`.
2. Look the payment up in the operator's Stripe dashboard.
3. If Stripe shows it succeeded and TideGrid shows pending, Stripe's event has not arrived. Check the webhook endpoint's recent deliveries ([rotating the secret](#rotating-the-webhook-secret) if they fail). The event, when it lands, confirms or refunds it.
4. If it stays wrong for more than a day, open a **High** incident and ask an agent session to trace the event through the inbox.

## Fee invoices

TideGrid drafts its monthly fee invoice per operator once the month ends. If an amount looks wrong, compare `GET .../fee-invoices` with the money report for the month. A draft is never edited; a correction is a reviewed change with the owner's go.
