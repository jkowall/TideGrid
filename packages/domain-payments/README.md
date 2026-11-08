# @tidegrid/domain-payments

The provider-neutral payment adapter, webhook signatures, the provider-event inbox, the fake payment provider, and the Stripe adapter, for the demo build (goal G2.7 in the [demo build plan](../../docs/v2/12-demo-build-plan.md)). The design authority is [the target architecture](../../docs/v2/04-architecture.md#payments-and-tips) (direct charges on the operator's connected account; the operator is merchant of record; TideGrid adds no processing spread or application fee and invoices its own fees separately) and the retained V1 decision on the [webhook inbox](../../docs/v1/adr/0009-webhook-inbox.md). Checkout, which uses this package, is in [domain-booking](../domain-booking/README.md). Tables are in migration `0007_checkout_and_confirmation.sql`.

This package knows nothing about bookings. It is the seam the Stripe adapter plugs into. The Stripe adapter is built and tested against recorded-shape fixtures, plus one test-mode smoke on the preview in the Nov 1 runbook's P9 window, and is off in every deployment (see [The Stripe adapter](#the-stripe-adapter-proposed-off-by-default)).

## The fake provider is the demo's provider

The owner decided on 2026-10-05 to shim the payment provider for the demo: payments run through a fake provider behind this adapter, and a Stripe adapter replaces it behind the same interface before any live booking. The narrowing is recorded in the [demo build plan](../../docs/v2/12-demo-build-plan.md#goal-sequence). The fake follows the path the real provider will: a signed HTTP webhook into the inbox, signature verified, deduplicated by event id, then processed.

## The adapter

```ts
interface PaymentProvider {
  name: "fake" | "stripe";
  signatureHeader: string;                       // lower case, e.g. "fake-signature"
  minimumAmount(currency): number;
  createPayment({ accountRef, amount, currency, idempotencyKey, clientReference }):
    Promise<{ paymentRef, status, amount, currency, amountRefunded, clientSecret }>;
  retrievePayment({ accountRef, paymentRef }): Promise<ProviderPayment | null>;
  refundPayment({ accountRef, paymentRef, amount, currency, idempotencyKey }):
    Promise<{ refundRef, status: "succeeded" | "failed", failureCode? }>;
  verifyWebhook({ rawBody, signatureHeader, nowMs }):
    Promise<{ kind: "verified"; event: VerifiedProviderEvent } | { kind: "rejected"; reason }>;
}
```

- **Amounts** are integer minor units with an explicit currency (USD in the pilot).
- **Idempotency.** Creating a payment or a refund takes a key; the same key always returns the first result, so a retry after an unknown outcome can never charge or refund twice. A key reused with other parameters is refused.
- **Errors.** `ProviderUnavailableError` means the outcome is unknown: retry with the same key, and never start a new attempt until the old one is reconciled. `ProviderRejectedError` carries the provider's code and means the request will not succeed as sent.
- **No method runs inside a database transaction.** Callers commit their intent first, call the provider, then record the answer.
- **Client reference.** TideGrid passes its own payment id; the provider echoes it on every event about the payment, so a webhook that arrives before TideGrid records the provider's payment id still finds the payment.
- **Neutral events.** `payment.succeeded` (the money was captured), `payment.failed` (the provider will not complete this payment; final), and `other` (recorded, ignored). A provider that lets a guest retry after a declined attempt must not report that attempt as `payment.failed`; the Stripe adapter decides its mapping.
- **Verified events.** `VerifiedProviderEvent` carries a type brand that only an adapter's `verifyWebhook` sets, frozen, with a SHA-256 for redelivery checks: the raw body for the fake; for Stripe, a canonical projection that leaves out per-delivery fields. The inbox accepts nothing else.

## Webhook signatures

Stripe's scheme: a header `t=<unix seconds>,v1=<hex>`, where v1 is HMAC-SHA256 over `<t>.<raw body>` with the endpoint secret.

- The signature is checked over the exact bytes received, before anything is parsed and before any database is touched. The comparison uses WebCrypto's HMAC verify, which is constant time.
- The timestamp must be within 300 seconds of the receiver's clock, either way, so a captured request cannot be replayed later; within the window the inbox's unique event id makes a replay change nothing.
- More than one v1 may be present while a secret rotates; any one matching is enough. Other schemes (Stripe's v0) are ignored.
- The API answers every signature problem with the same 400 `signature_invalid` and logs which one it was.

## The inbox

`provider_events` keeps every verified callback once, keyed by `(provider, event id)`, in the tenant that owns the event's connected account (a composite foreign key to `payment_accounts` makes that structural). It stores the payload's SHA-256, not the payload, and the fields processing needs: the neutral type, the provider's type string, the account, the payment, the client reference, the amount, and the currency.

- `recordProviderEvent` inserts once and commits on its own. A duplicate delivery returns the first row and whether its body hashes the same.
- Processing locks the row (`lockInboxEvent`), acts, and records an outcome with `markInboxProcessed`, once. The event's content never changes; only `processing_state` moves, from `received` to `processed`. A failed processing attempt leaves it `received` for the provider's retry and the sweep.
- The runtime may update `processing_state` and `outcome` only; a trigger stamps `verified_at` and `processed_at` from the database clock and refuses any other change, for every role.

## Connected accounts

`payment_accounts` holds each operator's account reference at each provider. The runtime may only read it, so no request can change where money goes; onboarding writes it (the seed in the demo, as `acct_fake_<slug>`). `resolvePaymentAccount` maps a callback's account to its tenant through the definer function `app.resolve_payment_account`, which returns the tenant id and the account's status only. Accounts are resolved whatever their status, because money that moved must still be recorded; only an active account takes new payments.

## The fake provider

`FakePaymentProvider` keeps its own append-only tables, tenant-owned under the tenancy contract like everything else: `fake_provider_payments`, `fake_provider_events` (one outcome per payment, stored as the exact text delivered), and `fake_provider_refunds`. It never reads or writes TideGrid's checkout tables.

- **Exists only under `PAYMENT_PROVIDER=fake`.** Its constructor refuses `ENVIRONMENT=production`, any environment but `local`, `preview`, or `staging` (an unset or misspelled one included; since the Stripe adapter's Phase B review), and a secret shorter than 32 characters. The API's configuration refuses the fake in production, and as `environment_unknown` anywhere else outside that list, before it is ever built.
- **Confirms bookings without money.** Anyone who opens a checkout holds the client secret and can "pay". That is the point of a demo shim, and the reason it belongs only on synthetic tenants: never turn it on where a real guest could reach it.
- **Creating** is idempotent by key per tenant. The client secret is derived, `<paymentRef>_secret_<HMAC>`, never stored, and checked in constant time.
- **Settling** (the demo's pay page) moves a pending payment to succeeded or failed, once; a second attempt keeps the first outcome. Its event is stored first, then delivered, or held back for a later, late, duplicate, or reordered delivery.
- **Refunding** is idempotent by key, refuses an unpaid payment and more than was paid, and succeeds at once.
- **Delivery** signs the stored body afresh and posts it to the real webhook route through the whole application, as the provider would. Redelivery is byte for byte the same event.
- **Minimum charge** is 50 cents, Stripe's USD floor, so the demo meets the real provider's.

The API's demo controls over it are listed in the [checkout contract](../domain-booking/README.md#api) and the OpenAPI document under the `fake-provider` tag.

## The Stripe adapter (proposed, off by default)

Standing goal item 3. Every design choice here is a coordinator default of 2026-10-28. The owner confirmed D1 to D12 and the Stripe-live replay method on 2026-11-08. The error codes that never settle a refund as failed, and this package as the adapter's home, were not asked and stay coordinator defaults. The decisions D1 to D12 are recorded in the [decision register](../../docs/v2/06-decision-register.md#decision-log) and the [demo build plan](../../docs/v2/12-demo-build-plan.md#goal-sequence), with the API wiring that lands with them. The adapter was built and tested against recorded-shape fixtures: modeled on Stripe's documentation. **Live observation, 2026-11-05 (one test-mode run, not a verification of the adapter):** under `2026-09-30.endive`, `POST /v1/payment_intents` with `payment_method_types[]=card` was refused with a 400 saying the parameter is no longer supported, and the same request with `allowed_payment_method_types[]=card` created an intent that answered `["card"]` for both `payment_method_types` and `allowed_payment_method_types`. Nothing else has been checked against live. **One end-to-end smoke, P9 of the Nov 1 runbook (2026-11-05 UTC):** create, decline, pay, webhook confirmation, cancel, and refund `succeeded` ran through the adapter on demo-harbor's test connected account, and one `stripe events resend` was read as a duplicate ([verification log](../../docs/verification-log.md#demo-acceptance-on-the-preview-deployment-the-november-1-runbook-november-4-2026)). That is smoke evidence, not a verification of the fixture's shapes.

`createStripePaymentProvider` in `src/stripe.ts` builds a Stripe Connect direct-charge adapter behind `PaymentProvider`. It lives in this package because only this package can mint the verified-event brand. That narrows the hosting plan's proposed `provider-*/` layout for the demo.

```ts
createStripePaymentProvider({
  secretKey,          // sk_test_ or rk_test_ only, full shape
  webhookSecret,      // whsec_, shape-checked; one secret (D10)
  environment,        // "production" is refused with a test key (D8)
  fetch?,             // bound to globalThis by default
  requestTimeoutMs?,  // default 15000
  apiBase?,           // default https://api.stripe.com; another origin only with an injected fetch
  toleranceSeconds?,  // default 300, clamped to 1-300
})
```

### Configuration fails closed

- `checkStripeConfig` and the constructor apply the same rules, so the API's settings and the adapter each refuse on their own.
- A missing key or webhook secret means off: `stripe_key_missing`, `stripe_webhook_secret_missing`.
- These are refused: a live key of any kind (`sk_live_`, `rk_live_`, `pk_live_`) in every environment until the Core live gate (`live_key`); a key that fails `^(sk|rk)_test_[A-Za-z0-9]{24,}$` (`key_malformed`); a test key with `ENVIRONMENT=production`, because test cards would confirm real bookings with no money moving (`stripe_test_in_production`); a test key with any `ENVIRONMENT` but `local`, `preview`, or `staging`, unset or misspelled included (`environment_unknown`), the same allowlist the fake uses; a `whsec_` that fails its shape check (`webhook_secret_malformed`).
- The fixture's credentials (`rk_test_fixture_...`, `whsec_fixture_...`) fail both shape checks on purpose, so they can never configure a deployment. The constructor takes them only as a pair, only with an injected `fetch`, which no deployment passes, and never in production.
- The API base is never read from the environment. It must be an `https` origin with no path or credentials, and anything but `https://api.stripe.com` needs an injected `fetch`.
- The key and the webhook secret are Worker secrets only, never vars and never in the repository.

### Requests

- Plain `fetch`, no SDK and no dependency (D7). Form-encoded bodies, JSON answers.
- Every call sends `Authorization: Bearer <key>`, `Stripe-Account: <the operator's account>`, and `Stripe-Version: 2026-09-30.endive` (D11). Every POST sends `Idempotency-Key` equal to the port's key.
- The key appears only in the Authorization header. Ids are checked against `^pi_[A-Za-z0-9]{1,250}$` before they go into a path.
- The adapter holds no database handle. Tenant resolution stays in `handleVerifiedEvent`.

| Port member | Stripe call | Mapping |
|---|---|---|
| `createPayment` | `POST /v1/payment_intents`: `amount`, `currency=usd`, `allowed_payment_method_types[]=card` (D5; `2026-09-30.endive` refuses `payment_method_types` with a 400), `metadata[tidegrid_payment_id]` | `succeeded` is succeeded, `canceled` is failed, anything else pending. An answer for another payment, amount, or currency is refused as `malformed_response`. An intent whose `payment_method_types` is not exactly `["card"]` is `stripe_malformed_response`, an unknown outcome (D5, checked on the answer). No `application_fee_amount`, ever. |
| `retrievePayment` | `GET /v1/payment_intents/{id}?expand[]=latest_charge` | The same status map; `amountRefunded` from the expanded charge. A 404 `resource_missing` is null. An intent that is not card only is `stripe_malformed_response`. |
| `refundPayment` | `GET /v1/refunds?payment_intent=&limit=100`, up to 5 pages, then `POST /v1/refunds` with `metadata[tidegrid_refund_key]` | `succeeded` is succeeded; `failed` and `canceled` are failed with Stripe's `failure_reason`. `pending` and `requires_action` are an unknown outcome (D3). |
| `verifyWebhook` | none | Below. |

### Refunds are never issued twice

Stripe may forget an idempotency key after 24 hours and run a reused key as a new request, and the sweep retries a requested refund with no time limit. So the adapter looks for a refund carrying the key before it creates one:

- A match returns the refund's current status; a match with another amount is refused as `idempotency_key_reused`.
- If the five-page bound runs out with no match, the outcome is unknown, and nothing is created blind.
- A refused lookup (any 4xx on the list call) is no answer about the refund. It is unknown (`stripe_refund_lookup_refused`), and the refund stays requested. That includes another account's intent, which reads as missing there.
- A POST answered `charge_already_refunded` triggers a second lookup. It is never a final failure: the refund may be this one, created by an attempt whose answer was lost.
- Two callers inside 24 hours that both find nothing are deduplicated by the key; the second gets a replay or a 409, which is unknown.

### Errors

| Condition | Result |
|---|---|
| Network error, timeout, 5xx (even with `Stripe-Should-Retry: false`), 409, 429, `Stripe-Should-Retry: true`, an answer that does not parse | `ProviderUnavailableError` |
| 401; 403; a key, platform, or account code from [Stripe's list](https://docs.stripe.com/error-codes): `api_key_expired`, `platform_api_key_expired`, `secret_key_required`, `account_invalid`, `livemode_mismatch`, `platform_account_required`, `capability_not_active`, `action_blocked`, `testmode_charges_only`, `tls_version_unsupported`, `anomalous_money_movement_request`, `account_country_invalid_address`, `progressive_onboarding_limit_exceeded` | `ProviderUnavailableError` with the stable message `stripe_auth` (401) or `stripe_config` |
| A "not now" code: `lock_timeout`, `rate_limit`, `idempotency_key_in_use`, `balance_insufficient`, `charge_exceeds_source_limit`, `payment_method_not_available` | `ProviderUnavailableError` (`stripe_retry`) |
| `error.type` `idempotency_error` with any other code | `ProviderRejectedError("idempotency_key_reused")` |
| 400, 402, 404 with another code | `ProviderRejectedError(<code>)`, or `http_<status>` when the code is not snake case |
| Any other status | `ProviderUnavailableError` |

- A refund becomes `failed` only on Stripe's answer about that refund. Authentication, permission, account, and configuration faults leave it requested for the sweep.
- Error messages are stable codes. No error carries the key, the webhook secret, a signature, a client secret, Stripe's own message text, or a `cause`.
- The adapter does not retry inside a call. Callers retry with the same key.

### Webhooks

1. `verifySignature` over the raw bytes, with the endpoint secret, before anything is parsed. Its reason is returned unchanged. During a secret roll Stripe signs with both secrets, and any matching `v1` is enough.
2. A strict parse of a snapshot event: `evt_` id, `object: "event"`, a type, integer `created`, boolean `livemode`, `api_version`, and an object `data.object`. Thin events carry no `data.object` and are refused.
3. `livemode: true`, a missing or malformed `account`, and a non-USD TideGrid intent are `payload_invalid`, a deliberate 400.
4. A TideGrid `payment_intent.succeeded` or `payment_intent.canceled` whose `payment_method_types` is not exactly `["card"]` (D5, card only) is `payload_invalid` too. A missing or empty list, a second method, or any other method counts.

Why a 400 and not `other`: TideGrid asks for card only on every intent it creates, so such an event is an anomaly, not a sale to ignore. An `other` event is recorded and processed as `ignored_event_type`, which is final: every redelivery is a duplicate of it, so a payment that may have taken money would be dropped silently, with nothing left to replay after a fix. A 400 records nothing, shows as a failed delivery in Stripe's dashboard, and Stripe retries it ([for up to three days in live mode, a few times over some hours in a sandbox](https://docs.stripe.com/webhooks#retries)). Like the non-USD rule, it applies only to a TideGrid intent. Processing the event as an ordinary payment, so the late-success refund settles it, was set aside: a non-card method such as a bank debit can be returned after it succeeds, and refunds differently. The hold expires meanwhile. The recovery is a person: fix the cause, then resend the event from the Stripe Dashboard or with `stripe events resend`. Proposed for G2.10: reconciliation should treat such an intent as an exception, not a provider outage, once `parseIntent` refuses it. The route logs this 400 at warn level with the same `payload_invalid` code as an unreadable body, so the failed delivery in Stripe is the only distinct alarm; a separate rejection reason would change the port, and is a proposed follow-up. The check covers only the two events that settle a payment. A TideGrid intent's other events, and any intent TideGrid did not make, stay `other` whatever their methods.

Mapping:

- Only an intent whose `metadata.tidegrid_payment_id` is a UUID is TideGrid's. Every intent TideGrid creates carries it. Any other intent on the account is a sale TideGrid did not make, recorded as `other` with no payment.
- `payment_intent.succeeded` is `payment.succeeded`, with `amount_received`.
- `payment_intent.canceled` is `payment.failed`, with the intent's `amount`, which is what the payment row holds.
- `payment_intent.payment_failed`, `.processing`, and `.requires_action` are `other`: a declined card can be retried and must not release the hold.
- Charges, refunds, disputes, accounts, and unknown types are `other`. An unknown type still verifies and is recorded, so Stripe does not retry it for days.

**Dedupe hash.** For Stripe, `payloadSha256` is the SHA-256 of `{id, type, account, livemode, created, api_version, data}` as JSON with keys sorted at every level. `pending_webhooks` and `request` change between deliveries and are left out. The inbox and `handleVerifiedEvent` are unchanged, and the fake keeps raw-body hashing.

### Known risks, recorded for the live step

- **Create replay after pruning.** `ensureProviderPayment` calls `createPayment` on every replay. After Stripe forgets the key, a replay could create a second intent. The 15-minute hold makes that unlikely, and checkout fails closed on a different payment id.
- **A cached 500.** Stripe replays a saved 500 for up to 24 hours. For refunds the lookup makes that safe. For a create it costs a 503 until the hold expires.
- **Pending refunds and refused lookups can starve the sweep.** The sweep takes requested refunds oldest first in batches, and a refund stuck pending only counts as pending. A refund whose lookup is refused for good (an account or payment id that no longer matches) stays requested the same way, forever, with no word to the guest or the operator. A pending state, or an exception after some hours that covers both cases, is a proposed G2.9 follow-up, with fair ordering.
- **Inline processing.** The webhook route records and processes inline. Stripe advises a quick 2xx first. The inbox and the sweep make Stripe's retry safe. Update, 2026-11-08: under Stripe the route now answers first and processes after the answer; see [Stripe webhook ingress](#stripe-webhook-ingress-proposed-w1-stripe-webhook).
- **Signature only.** The route trusts the signature alone. Allowlisting Stripe's webhook IPs is a proposed follow-up. Update, 2026-11-08: under Stripe the route now also refuses addresses not on a committed list; see [Stripe webhook ingress](#stripe-webhook-ingress-proposed-w1-stripe-webhook).
- **Restricted keys.** Whether an `rk_test_` key needs extra permission to act through `Stripe-Account` is unconfirmed. If it does, the 403 is unknown, so refunds wait rather than fail.
- **Metadata cleared in the Dashboard.** An intent without TideGrid's payment id is recorded as `other`, so if the account's owner clears that metadata, a late success is ignored rather than refunded. G2.10 reconciliation, reading pending payments past their hold through `retrievePayment`, is the recovery.
- **The card-only webhook check reads a field no live webhook has shown yet.** A TideGrid success without `data.object.payment_method_types` is refused. Only the create answer under `2026-09-30.endive` has been seen live, and a resent event in the Nov 1 run was stamped with the account's default version, `2026-08-26.dahlia` ([A14](../../docs/verification-log.md)). If any version an event is rendered in leaves the field out, every Stripe payment answers 400: the guest is charged, the booking is not confirmed, and nothing refunds. Before the next live window is accepted, check live that a delivered and a resent `payment_intent.succeeded` carry `payment_method_types: ["card"]`.
- **No logger.** The adapter adds no log site. Operator-visible logs for `refund.failed` and disputes are a G2.9 and G2.10 follow-up, and such a log never carries `data.object`.

### The fixture and its capture rules

`src/stripe-fixture.ts` is an in-memory server for the endpoints above: intents, charges, and refunds per connected account; idempotent POSTs with replays, key reuse, and `pruneKeys()`; scripted answers and timeouts; and signed snapshot events. Its bodies are recorded-shape: modeled on the API reference, and no body is a capture. Two answers are consistent with what one live test-mode run observed on 2026-11-05: the `2026-09-30.endive` 400 for `payment_method_types`, and `["card"]` for both lists on a card-only intent. Everything else is unverified against live, beyond the P9 smoke recorded above. Synthetic ids, keys, and the two accounts `acct_1TestHarbor0000` and `acct_1TestReef00000` only. Like Stripe, it saves an idempotent answer only once a request has executed, so a parameter-validation error is not replayed, and a declined attempt leaves a failed charge as the intent's latest charge. Two behaviors are test tripwires, not Stripe's. A call with no `Stripe-Account` header is refused, where Stripe would run it on the platform account. A create whose `allowed_payment_method_types` is missing or anything but exactly `["card"]` is refused as `fixture_tripwire_card_only`, whatever Stripe would answer, because TideGrid creates card-only intents only (D5). In both cases the adapter's own check is the real guard. The fixture renders both payment method lists from the list the create was given. An account the key cannot reach answers 403 `account_invalid`. Outside the package it is reachable only as `@tidegrid/domain-payments/testing`, which exports `createStripeFixture` and nothing else.

Replacing these bodies with sandbox captures is a later step, after the owner approves real test-mode calls. Raw captures stay in the owner's private location. Before anything is committed, scrub:

- from Charges: `billing_details`, `receipt_email`, `receipt_url`, `payment_method_details.card.{fingerprint,last4,exp_month,exp_year}`, and `outcome`;
- from PaymentIntents: `client_secret`;
- from Events: `request.id` and `request.idempotency_key`;
- everywhere: every `acct_`, `ch_`, `pi_`, `re_`, `evt_`, and `txn_` id, replaced with synthetic ids.

`stripe-fixture-hygiene.test.ts` enforces the scrub on every fixture file and every body the fixture serves or signs. It also refuses any `shipping` or `address` object with a value, and any `name`, `phone`, `customer`, `description`, or `network_transaction_id` that is set, wherever it appears. Keep each event under the route's 64 KiB cap.

## Follow-ups for the Stripe adapter

Recorded from the G2.7 independent review. Both are now closed by the Stripe adapter, as follows.

- **Inbox provenance.** The database cannot tell where an inbox row came from; the `VerifiedProviderEvent` brand, which only an adapter's `verifyWebhook` sets, is the only guard on what reaches `recordProviderEvent`. The [checkout contract](../domain-booking/README.md#the-rule) says so too. Closed by `provenance.test.ts`: it scans `apps/`, `packages/`, and `tools/` and fails on any use of the minting function or a cast to the brand outside `adapter.ts` and the `verifyWebhook` bodies of the fake and Stripe adapters, on any relative import into this package's source from outside it, and on any runtime import of the Stripe fixture, by package path or by relative path inside the package. It also catches the cast-free forgeries the compiler allows when they name the type: an object literal, a parse, or an `any` value given the type, `satisfies`, and a function typed to return the brand that returns a literal. An unannotated spread of a real verified event keeps the brand and is not caught by a text scan; a runtime brand checked by the inbox would close it, and is a proposed follow-up. A guard inside the database would still need the signing secret there, or a separate inbox-writer role; both remain outside the demo. Update, 2026-11-08: the inbox now checks a runtime brand, which refuses the spread; see [Runtime provenance brand](#runtime-provenance-brand-proposed-w1-provenance).
- **Stripe retries can change the body.** Stripe signs every delivery afresh, and `pending_webhooks` falls as other endpoints succeed ([the event object](https://docs.stripe.com/api/events/object)), so two deliveries of one event need not be byte for byte the same. With a raw-body hash such a retry would read as `samePayload: false` and stop at `payload_mismatch`. Closed by the canonical projection hash above (D2): a redelivery hashes the same, so the inbox records it as the same payload. Stripe also says it sometimes sends two separate events for one change; processing is already idempotent per payment (`already_succeeded`, `already_failed`), so a second event id for the same outcome changes nothing.

## Stripe webhook ingress (proposed, W1-STRIPE-WEBHOOK)

Coordinator defaults of 2026-11-08, pending owner confirmation ([decision register](../../docs/v2/06-decision-register.md#2026-11-08-w1-stripe-webhook-stripe-webhook-quick-2xx-and-source-address-list-owner-go-coordinator-defaults-pending-owner-confirmation)). They apply under `PAYMENT_PROVIDER=stripe` only, which no deployed configuration sets. For Stripe they replace two items under [Known risks](#known-risks-recorded-for-the-live-step): "Inline processing" and "Signature only". The fake's path is unchanged: no address check, and processing before the answer, so the shim replay evidence stands.

The route's order of work under Stripe (`apps/api-worker/src/routes/payment-webhooks.ts`):

1. A browser Origin answers 403 `origin_not_allowed`, and another provider's path 404, as before.
2. **Source address (D2, D3).** The client address is `CF-Connecting-IP`, which Cloudflare sets at its edge and overwrites. `X-Forwarded-For`, `X-Real-IP`, and every other header are never read. An address that is not exactly on the list, or a missing one, answers 403 `source_not_allowed` before the body is read: the API's global body cap runs this check first, so an unlisted sender costs no upload and never gets a 413. It logs `payment_webhook_source_refused` at warn, with `error.type` `source_address_missing` or `source_address_not_listed`. The log never carries the address.
3. The size cap and the signature, as before. A bad signature from a listed address answers 400 `signature_invalid`, and nothing is recorded.
4. **Record.** The account is resolved, and the event is recorded in its tenant's inbox in one transaction, the same steps `handleVerifiedEvent` takes. An unknown account, a changed body, and an event already processed answer as before.
5. **Answer (D1).** A new event, or a redelivery of one still received, answers 200 `{ received: true, duplicate, outcome: "received" }`. The log `payment_webhook_recorded` carries `duration_ms` from receipt to the answer.
6. **Process after the answer,** through `waitUntil`, on a database connection of its own. `tryLockInboxEvent` takes the row with `skip locked`, so it never waits on a sweep or another delivery that holds it, and a row already processed is left alone. Then `processProviderEvent`, then any refund through `settleRefund`, then, for a confirmed booking, the confirmation email, with the after-commit window counted from before the answer. The `payment_webhook` log carries `duration_ms` from receipt to the processing commit: the time to confirmation.
7. **Backstop.** A failure logs `payment_webhook_processing_failed` and leaves the event received. The checkout sweep processes it on its next run, after its 60 s grace. The sweep is the only automatic backstop: Stripe retries only a delivery that got a non-2xx answer or timed out, so once the route has answered 200 Stripe counts the event as delivered and does not send it again. A redelivery still schedules processing again when one arrives: a person resending the event from Stripe's dashboard, or a retry after a 200 that was lost on the way. Processing is idempotent per event and per payment, so replays and duplicates confirm a booking once.

### The address list

`src/stripe-webhook-ips.ts` holds `STRIPE_WEBHOOK_IPS`, a frozen list of IPv4 addresses. `isStripeWebhookIp` matches exactly: no trimming, no lists, no ranges, and no IPv4-mapped IPv6. `STRIPE_WEBHOOK_IPS_VERSION` is the date the list was last compared with Stripe's file, and `STRIPE_WEBHOOK_IPS_VERIFIED` says whether that comparison ran. Nothing fetches the list at runtime.

Version `2026-11-08` is **unverified**. Stripe's file (`STRIPE_WEBHOOK_IPS_SOURCE`) could not be read from the build container that day, because the network policy refused the host. The twelve addresses are the list as the coordinator knew it on that date. The owner verifies it with the check step below before any Stripe-live window.

### Refreshing the list (the check step)

1. Save Stripe's file outside the repository: `curl -sS https://stripe.com/files/ips/ips_webhooks.json -o <folder outside the repo>/ips_webhooks.json`. Compare it with the webhook section of [Stripe's IP addresses page](https://docs.stripe.com/ips) too.
2. Run `STRIPE_WEBHOOK_IPS_FILE=<that file> pnpm --filter @tidegrid/domain-payments test stripe-webhook-ips`. Its last case compares the copy with the committed list and fails with `missing` (published, not committed) and `extra` (committed, no longer published). Without the variable that case is skipped.
3. If they differ, change `STRIPE_WEBHOOK_IPS`. Either way, set `STRIPE_WEBHOOK_IPS_VERSION` to the date and `STRIPE_WEBHOOK_IPS_VERIFIED` to `true`, rerun step 2, and open a reviewed pull request with the step 2 output.
4. Run it before each Stripe-live window, and when Stripe announces a change. A new Stripe address that is not on the list makes deliveries fail with 403. Stripe's dashboard shows them as failed, and Stripe retries them; the warn log shows `source_address_not_listed`.

### Measured

The integration suite's timing case, 8 deliveries in one process against the local PostgreSQL 17 container on 2026-11-08: the 200 in a median of 17.3 ms (max 20.3 ms), and every background task, confirmation included, done in a median of 106.9 ms (max 116.6 ms). The second figure includes closing the request's connection. No network, Hyperdrive, or Neon is in the path, so these are not deployed figures. Deployed timing is unmeasured while Stripe is off; the two `duration_ms` logs measure it once a window runs.

### Risks and limits

- **The list is unverified** until the owner runs the check step.
- **Trust in `CF-Connecting-IP`.** The list is only as strong as Cloudflare's rule that it sets this header at its edge and overwrites a client's own, for every request that reaches the API, subrequests from other Workers included. That rule is not checked here against Cloudflare's documentation, and a service binding passes on whatever its caller set. The signature stays the credential; the list narrows who can reach it.
- **IPv4 only.** A Stripe delivery over IPv6, or from an address Stripe adds before the list is refreshed, is refused with 403 and retried by Stripe.
- **Local forwarding is refused.** The Stripe CLI's `stripe listen` forwards from a local address, so it gets 403 under Stripe. If the owner approves the CLI for a replay, that needs a proposed follow-up, never a bypass in the route.
- **Recovery after a crash is slower.** Before this change a processing failure answered 500, and Stripe retried it on its documented backoff schedule. Now a failure after the 200 waits for the checkout sweep: the cron runs every 15 minutes and the sweep skips events younger than its 60 s grace, so the worst case is about 16 minutes to confirmation, with the guest's checkout still `open`. If the hold expires in that time, the sweep's expiry step runs before its inbox step, so the event then confirms as `confirmed_reacquired` when the trip still has room, or is refunded when it does not, instead of a plain confirmation. A person can resend the event from Stripe's dashboard to recover sooner. A tighter sweep cadence for received inbox events during a Stripe-live window is a proposed follow-up, not built here.
- **The `waitUntil` budget.** Processing, any refund, and the email share the 30 s after the answer. A cut transaction rolls back and the event stays received; a cut refund stays requested for the sweep; the email keeps its own deadline.
- **Two connections** per new Stripe event: the request's, and the background task's.
- **Duplicated steps.** The route repeats `handleVerifiedEvent`'s account, record, and duplicate steps, because `packages/domain-booking` was read-only for this goal. Splitting that function into a record step and a process step is a proposed follow-up and a contract change.
- **Tests.** `stripe-webhook-ips.test.ts` covers the list and the check step. `apps/api-worker/test-integration/stripe-webhook.integration.test.ts` covers the answer before processing, a crash after the 200 recovered by the sweep and by a manual resend, concurrent and later duplicates, the address cases, a bad signature, the email, and the timing. `apps/api-worker/test/stripe-settings.test.ts` covers the 403 before any database in the Workers runtime.

## The guest card form (proposed, W1-STRIPE-ELEMENT)

Coordinator defaults of 2026-11-08, pending owner confirmation ([decision register](../../docs/v2/06-decision-register.md#2026-11-08-w1-stripe-element-the-stripe-card-form-in-guest-checkout-owner-go-coordinator-defaults-pending-owner-confirmation)). They apply under `PAYMENT_PROVIDER=stripe` only, which no deployed configuration sets. The fake provider's path is unchanged. The page side is in the [guest site README](../../apps/guest-site/README.md#the-stripe-card-form-w1-stripe-element).

- **Card only (D1).** The guest site mounts Stripe's Payment Element. The intent allows `card` and nothing else (D5 above), and the page turns wallets off. No other method can appear.
- **The publishable key (D2).** An API Worker secret, `STRIPE_PUBLISHABLE_KEY`, set by the owner with `wrangler secret put`, and locally in `.dev.vars`. Never in `wrangler.jsonc` or any committed file. The API accepts only `pk_test_` and 24 to 247 letters or digits, and only when `ENVIRONMENT` is `local`, `preview`, or `staging`; a live key, any other shape, or any other environment reads as no key.
- **Only the Bearer read carries it.** `GET /v1/public/checkout-sessions/{id}/payment`, with the checkout secret as the bearer token, adds `payment.stripe`: the publishable key and the connected account the payment was created on, read from the payment row under the tenant's row-level security. Stripe.js needs that account for a direct charge. The account is read before the checkout's last read, and nothing waits between that read and the answer, so a checkout that closes or lapses during any step answers its closed state with no client secret, key, or account. Opening the checkout and reading its state never carry either. Without a valid key, an open checkout answers 503 `payments_unavailable` before Stripe is asked.
- **Confirmation is unchanged.** The browser asks Stripe to confirm the card. The booking confirms only when a verified `payment_intent.succeeded` reaches the webhook, as above. A decline is `payment_intent.payment_failed`, which is `other`, so the hold stays and the guest can try another card.

### Owner check list for the Stripe window

Each item needs the owner's go for real test-mode calls. Nothing here runs in CI.

1. Set `STRIPE_PUBLISHABLE_KEY` on the API Worker with `wrangler secret put`, from the same Stripe test account as `STRIPE_SECRET_KEY`. Confirm it starts `pk_test_`. The release tool's secret list does not name it yet.
2. Run the checks above first: the webhook address list check step, and the live check that a delivered and a resent `payment_intent.succeeded` carry `payment_method_types: ["card"]`.
3. On the preview, as demo-harbor, open a checkout and check that the card form loads at 375 and desktop widths, with no CSP violation and no other error in the browser console.
4. Pay with `4242 4242 4242 4242`. The page says it is confirming, then shows the booking only once the webhook confirms it.
5. Pay with `4000 0000 0000 0002` (declined), then with `4242 4242 4242 4242` on the same checkout. The decline shows on the payment step, and the second card books once.
6. Pay with `4000 0025 0000 3155` (3D Secure). Stripe's check opens in its own frame, and the booking confirms after it.
7. Let a checkout's hold run out on the card form. The page shows the expired checkout.
8. Compare the guest CSP with the Content Security Policy section of [Stripe's security guide](https://docs.stripe.com/security/guide). If Stripe now lists an origin or a style hash the card form needs, record it and ask the owner before changing the policy. The owner approved the policy on 2026-11-08 without this comparison, so run it before the first Stripe window. The origins were written from the coordinator's knowledge on 2026-11-08, because the build container could not read Stripe's pages that day.
9. Check that Stripe.js works under the site's `Referrer-Policy: no-referrer` and `Permissions-Policy: payment=()`. If either blocks the card form, record it; changing a header is a proposed follow-up for the owner.
10. Check that `https://js.stripe.com/v3/` is still the address Stripe documents. A versioned Stripe.js address, if Stripe now requires one, is a one-line change in `apps/guest-site/src/booking/stripe-js.ts`.
11. Close the window as the runbook does: revert the provider, delete the Stripe secrets, `STRIPE_PUBLISHABLE_KEY` included, and disable the webhook endpoint.

### Card form risks and limits

- **The CSP origins are unverified against Stripe's page** until item 8 runs. The browser tests serve a double at Stripe.js's address, so they prove the policy admits that script, not that real Stripe.js needs nothing more.
- **A reload cannot pay yet.** After a reload the page still offers to start over, as under the fake. Paying after a reload through the Bearer read is a proposed follow-up.
- **The account goes to the browser.** Stripe.js needs the connected account id for a direct charge. It reaches only the checkout's holder, beside the client secret.
- **Staff checkout stays on the shim** (D9 above).

## Runtime provenance brand (proposed, W1-PROVENANCE)

D1 of 2026-11-08, a coordinator default the owner confirmed the same day ([decision register](../../docs/v2/06-decision-register.md#2026-11-08-w1-provenance-runtime-provenance-brand-checked-by-the-inbox-owner-go-coordinator-defaults-pending-owner-confirmation)). It closes the gap recorded under [Inbox provenance](#follow-ups-for-the-stripe-adapter): an unannotated spread of a verified event kept the type brand, and the text scan could not see it.

- **The marker.** `adapter.ts` keeps a module-private `WeakSet`. The minting function adds each event it returns. Nothing else can add to it: the set is not exported, and its `add` and `has` are bound when the module loads, so a later change to `WeakSet.prototype` does not reach them.
- **Who mints.** Unchanged: only `verifyWebhook` in the fake and Stripe adapters calls the minting function, after the signature and the parse pass. `provenance.test.ts` still enforces that by scan, and the package index exports neither the minting function nor the check. The minting function is still a named export of `adapter.ts`, because both adapters import it, so the scan also refuses the plain ways to reach it without its name: a namespace import or `export *` of `adapter.ts`, a dynamic `import()` or `require()` of it, and, in runtime code and anywhere in this package, a dynamic import whose specifier is not a plain string.
- **The check.** `recordProviderEvent` calls `isVerifiedProviderEvent` before any statement runs, and throws `UnverifiedProviderEventError` for anything not in the set. The brand is identity. A spread, `Object.assign`, `structuredClone`, a JSON round trip, `Object.create`, a `Proxy`, or parsed fields that skipped the signature is a new object, so it is refused, even when it changes nothing.
- **Content is fixed.** A minted event is frozen, and so is its `payment`. `occurredAt` is a getter that returns a new `Date` on each read. `Object.freeze`, `Date`, and `Date.prototype.getTime` are taken when `adapter.ts` loads, as the set's methods are, so replacing them later neither leaves a minted event open to change nor changes the time it reports. So code that holds a real event cannot change what the inbox records. The event carries only the port's eight fields; anything else given to the minting function is dropped.
- **Unchanged.** The webhook contract, the routes, `handleVerifiedEvent`, and the database. A refusal is a programming error, never a provider's: no adapter path produces one.

### Limits

- **One module instance.** The set lives in one instance of `adapter.ts`. If a bundle or a test runner ever loaded two copies of this package, an event minted by one copy would be refused by the other's inbox. That fails closed, with `UnverifiedProviderEventError` and a 500, never open. Today every runtime and test loads one copy, and every integration suite passed on 2026-11-08.
- **Not a sandbox.** Code that runs before this module loads could replace `WeakSet`, `Object.freeze`, `Date`, or `Function.prototype.bind`. Code that replaces globals the database driver uses, such as how it writes a `Date`, could change what reaches a row. `eval` or `new Function` could reach the minting function past the scan, and so could deliberately obfuscated source: a comment between the tokens of a namespace import, or a unicode escape in the minting function's name. The scan is a guard against mistakes, not against a hostile commit; review stays the guard for that. And code that holds a webhook secret can sign its own events. The brand stops a forged or copied event inside the codebase. The signature, the Stripe source address list, and review stay the defenses at the edge.
- **Still checked at the inbox only.** `handleVerifiedEvent` and the Stripe route resolve the account from the event before they record it, so a forged event would read one account row before it is refused. Nothing is written. A check at the top of those functions, and exporting the check and the error from the package index, are proposed follow-ups: `packages/domain-booking`, the API, and `index.ts` were outside this goal.
- **The database still cannot tell.** A guard inside the database would need the signing secret there, or a separate inbox-writer role, as before.
- **Tests.** `inbox-brand.test.ts`, a unit suite with no database: both adapters' events pass; the spread forgery and eight other copies are refused before the transaction is touched; patching `WeakSet.prototype` widens nothing; a minted event cannot be changed, even when it was minted while `Object.freeze` was replaced or is read while `Date` is replaced. `provenance.integration.test.ts`, on PostgreSQL 17: spread copies, under a new event id or the real one, write no row, and the real event records once. `provenance.test.ts` adds two scan cases: the check is the first statement of `recordProviderEvent`, and the set is named only in its declarations and used only by the minting function. Its mint scan also fails on any file that reaches `adapter.ts` as a whole, and its forgery case adds eleven samples that name neither the function nor the brand.

## Tests

- `pnpm --filter @tidegrid/domain-payments test` runs the unit tests, none of which touch a database or the network: signatures, the fake's parsing, the Stripe adapter over its fixture (`stripe.test.ts`, `stripe-webhook.test.ts`), the shared provider contract against Stripe (`stripe.contract.test.ts`), the brand and import guards (`provenance.test.ts`), and the fixture scrub guard (`stripe-fixture-hygiene.test.ts`). Every Stripe test replaces the global `fetch` with one that fails the test if it is reached.
- `payment-provider.contract.ts` is one suite for both providers. The fake runs it against a real database in `fake.contract.integration.test.ts`, with the inbox recording the redelivery. Known divergence: the fake treats a decline as final, so the decline-then-retry case is Stripe-only.
- Checkout's integration suites exercise the fake, the inbox, and the account lookup against a real database.
