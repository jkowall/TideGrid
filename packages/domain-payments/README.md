# @tidegrid/domain-payments

The provider-neutral payment adapter, webhook signatures, the provider-event inbox, the fake payment provider, and the Stripe adapter, for the demo build (goal G2.7 in the [demo build plan](../../docs/v2/12-demo-build-plan.md)). The design authority is [the target architecture](../../docs/v2/04-architecture.md#payments-and-tips) (direct charges on the operator's connected account; the operator is merchant of record; TideGrid adds no processing spread or application fee and invoices its own fees separately) and the retained V1 decision on the [webhook inbox](../../docs/v1/adr/0009-webhook-inbox.md). Checkout, which uses this package, is in [domain-booking](../domain-booking/README.md). Tables are in migration `0007_checkout_and_confirmation.sql`.

This package knows nothing about bookings. It is the seam the Stripe adapter plugs into. The Stripe adapter is built and tested against recorded-shape fixtures only, and is off in every deployment (see [The Stripe adapter](#the-stripe-adapter-proposed-off-by-default)).

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

- **Exists only under `PAYMENT_PROVIDER=fake`.** Its constructor refuses `ENVIRONMENT=production` and a secret shorter than 32 characters, and the API's configuration refuses the fake in production before it is ever built.
- **Confirms bookings without money.** Anyone who opens a checkout holds the client secret and can "pay". That is the point of a demo shim, and the reason it belongs only on synthetic tenants: never turn it on where a real guest could reach it.
- **Creating** is idempotent by key per tenant. The client secret is derived, `<paymentRef>_secret_<HMAC>`, never stored, and checked in constant time.
- **Settling** (the demo's pay page) moves a pending payment to succeeded or failed, once; a second attempt keeps the first outcome. Its event is stored first, then delivered, or held back for a later, late, duplicate, or reordered delivery.
- **Refunding** is idempotent by key, refuses an unpaid payment and more than was paid, and succeeds at once.
- **Delivery** signs the stored body afresh and posts it to the real webhook route through the whole application, as the provider would. Redelivery is byte for byte the same event.
- **Minimum charge** is 50 cents, Stripe's USD floor, so the demo meets the real provider's.

The API's demo controls over it are listed in the [checkout contract](../domain-booking/README.md#api) and the OpenAPI document under the `fake-provider` tag.

## The Stripe adapter (proposed, off by default)

Standing goal item 3. Every design choice here is a coordinator default of 2026-10-28, pending the owner's confirmation; the decisions D1 to D12 are recorded in the [decision register](../../docs/v2/06-decision-register.md) and the [demo build plan](../../docs/v2/12-demo-build-plan.md). No live Stripe call has been made. The adapter was built and tested against recorded-shape fixtures only: modeled on Stripe's documentation, unverified against live.

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
- These are refused: a live key of any kind (`sk_live_`, `rk_live_`, `pk_live_`) in every environment until the Core live gate (`live_key`); a key that fails `^(sk|rk)_test_[A-Za-z0-9]{24,}$` (`key_malformed`); a test key with `ENVIRONMENT=production`, because test cards would confirm real bookings with no money moving (`stripe_test_in_production`); a `whsec_` that fails its shape check (`webhook_secret_malformed`).
- The API base is never read from the environment. It must be an `https` origin with no path or credentials, and anything but `https://api.stripe.com` needs an injected `fetch`.
- The key and the webhook secret are Worker secrets only, never vars and never in the repository.

### Requests

- Plain `fetch`, no SDK and no dependency (D7). Form-encoded bodies, JSON answers.
- Every call sends `Authorization: Bearer <key>`, `Stripe-Account: <the operator's account>`, and `Stripe-Version: 2026-09-30.endive` (D11). Every POST sends `Idempotency-Key` equal to the port's key.
- The key appears only in the Authorization header. Ids are checked against `^pi_[A-Za-z0-9]{1,250}$` before they go into a path.
- The adapter holds no database handle. Tenant resolution stays in `handleVerifiedEvent`.

| Port member | Stripe call | Mapping |
|---|---|---|
| `createPayment` | `POST /v1/payment_intents`: `amount`, `currency=usd`, `payment_method_types[]=card` (D5), `metadata[tidegrid_payment_id]` | `succeeded` is succeeded, `canceled` is failed, anything else pending. An answer for another payment, amount, or currency is refused as `malformed_response`. No `application_fee_amount`, ever. |
| `retrievePayment` | `GET /v1/payment_intents/{id}?expand[]=latest_charge` | The same status map; `amountRefunded` from the expanded charge. A 404 `resource_missing` is null. |
| `refundPayment` | `GET /v1/refunds?payment_intent=&limit=100`, up to 5 pages, then `POST /v1/refunds` with `metadata[tidegrid_refund_key]` | `succeeded` is succeeded; `failed` and `canceled` are failed with Stripe's `failure_reason`. `pending` and `requires_action` are an unknown outcome (D3). |
| `verifyWebhook` | none | Below. |

### Refunds are never issued twice

Stripe may forget an idempotency key after 24 hours and run a reused key as a new request, and the sweep retries a requested refund with no time limit. So the adapter looks for a refund carrying the key before it creates one:

- A match returns the refund's current status; a match with another amount is refused as `idempotency_key_reused`.
- If the five-page bound runs out with no match, the outcome is unknown, and nothing is created blind.
- A POST answered `charge_already_refunded` triggers a second lookup. It is never a final failure: the refund may be this one, created by an attempt whose answer was lost.
- Two callers inside 24 hours that both find nothing are deduplicated by the key; the second gets a replay or a 409, which is unknown.

### Errors

| Condition | Result |
|---|---|
| Network error, timeout, 5xx (even with `Stripe-Should-Retry: false`), 409, 429, `Stripe-Should-Retry: true`, an answer that does not parse | `ProviderUnavailableError` |
| 401; 403; `api_key_expired`, `platform_api_key_expired`, `secret_key_required`, `account_invalid`, `livemode_mismatch` | `ProviderUnavailableError` with the stable message `stripe_auth` (401) or `stripe_config` |
| `error.type` `idempotency_error` | `ProviderRejectedError("idempotency_key_reused")` |
| 400, 402, 404 with another code | `ProviderRejectedError(<code>)`, or `http_<status>` when the code is not snake case |
| Any other status | `ProviderUnavailableError` |

- A refund becomes `failed` only on Stripe's answer about that refund. Authentication, permission, account, and configuration faults leave it requested for the sweep.
- Error messages are stable codes. No error carries the key, the webhook secret, a signature, a client secret, Stripe's own message text, or a `cause`.
- The adapter does not retry inside a call. Callers retry with the same key.

### Webhooks

1. `verifySignature` over the raw bytes, with the endpoint secret, before anything is parsed. Its reason is returned unchanged. During a secret roll Stripe signs with both secrets, and any matching `v1` is enough.
2. A strict parse of a snapshot event: `evt_` id, `object: "event"`, a type, integer `created`, boolean `livemode`, `api_version`, and an object `data.object`. Thin events carry no `data.object` and are refused.
3. `livemode: true`, a missing or malformed `account`, and a non-USD TideGrid intent are `payload_invalid`, a deliberate 400.

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
- **Pending refunds can starve the sweep.** The sweep takes requested refunds oldest first in batches, and a refund stuck pending only counts as pending. A pending state, or an exception after some hours, is a proposed G2.9 follow-up, with fair ordering.
- **Inline processing.** The webhook route records and processes inline. Stripe advises a quick 2xx first. The inbox and the sweep make Stripe's retry safe.
- **Signature only.** The route trusts the signature alone. Allowlisting Stripe's webhook IPs is a proposed follow-up.
- **Restricted keys.** Whether an `rk_test_` key needs extra permission to act through `Stripe-Account` is unconfirmed. If it does, the 403 is unknown, so refunds wait rather than fail.
- **No logger.** The adapter adds no log site. Operator-visible logs for `refund.failed` and disputes are a G2.9 and G2.10 follow-up, and such a log never carries `data.object`.

### The fixture and its capture rules

`src/stripe-fixture.ts` is an in-memory server for the endpoints above: intents, charges, and refunds per connected account; idempotent POSTs with replays, key reuse, and `pruneKeys()`; scripted answers and timeouts; and signed snapshot events. Its bodies are recorded-shape: modeled on the API reference, unverified against live. Synthetic ids, keys, and the two accounts `acct_1TestHarbor0000` and `acct_1TestReef00000` only. Outside the package it is reachable only as `@tidegrid/domain-payments/testing`, which exports `createStripeFixture` and nothing else.

Replacing these bodies with sandbox captures is a later step, after the owner approves real test-mode calls. Raw captures stay in the owner's private location. Before anything is committed, scrub:

- from Charges: `billing_details`, `receipt_email`, `receipt_url`, `payment_method_details.card.{fingerprint,last4,exp_month,exp_year}`, and `outcome`;
- from PaymentIntents: `client_secret`;
- from Events: `request.id` and `request.idempotency_key`;
- everywhere: every `acct_`, `ch_`, `pi_`, `re_`, `evt_`, and `txn_` id, replaced with synthetic ids.

`stripe-fixture-hygiene.test.ts` enforces the scrub on every fixture file and every body the fixture serves or signs. Keep each event under the route's 64 KiB cap.

## Follow-ups for the Stripe adapter

Recorded from the G2.7 independent review. Both are now closed by the Stripe adapter, as follows.

- **Inbox provenance.** The database cannot tell where an inbox row came from; the `VerifiedProviderEvent` brand, which only an adapter's `verifyWebhook` sets, is the only guard on what reaches `recordProviderEvent`. The [checkout contract](../domain-booking/README.md#the-rule) says so too. Closed by `provenance.test.ts`: it scans `apps/`, `packages/`, and `tools/` and fails on any use of the minting function or a cast to the brand outside `adapter.ts` and the `verifyWebhook` bodies of the fake and Stripe adapters, on any relative import into this package's source from outside it, and on any runtime import of the Stripe fixture. A guard inside the database would still need the signing secret there, or a separate inbox-writer role; both remain outside the demo.
- **Stripe retries can change the body.** Stripe signs every delivery afresh, and `pending_webhooks` falls as other endpoints succeed ([the event object](https://docs.stripe.com/api/events/object)), so two deliveries of one event need not be byte for byte the same. With a raw-body hash such a retry would read as `samePayload: false` and stop at `payload_mismatch`. Closed by the canonical projection hash above (D2): a redelivery hashes the same, so the inbox records it as the same payload. Stripe also says it sometimes sends two separate events for one change; processing is already idempotent per payment (`already_succeeded`, `already_failed`), so a second event id for the same outcome changes nothing.

## Tests

- `pnpm --filter @tidegrid/domain-payments test` runs the unit tests, none of which touch a database or the network: signatures, the fake's parsing, the Stripe adapter over its fixture (`stripe.test.ts`, `stripe-webhook.test.ts`), the shared provider contract against Stripe (`stripe.contract.test.ts`), the brand and import guards (`provenance.test.ts`), and the fixture scrub guard (`stripe-fixture-hygiene.test.ts`). Every Stripe test replaces the global `fetch` with one that fails the test if it is reached.
- `payment-provider.contract.ts` is one suite for both providers. The fake runs it against a real database in `fake.contract.integration.test.ts`, with the inbox recording the redelivery. Known divergence: the fake treats a decline as final, so the decline-then-retry case is Stripe-only.
- Checkout's integration suites exercise the fake, the inbox, and the account lookup against a real database.
