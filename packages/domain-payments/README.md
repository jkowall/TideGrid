# @tidegrid/domain-payments

The provider-neutral payment adapter, webhook signatures, the provider-event inbox, and the fake payment provider, for the demo build (goal G2.7 in the [demo build plan](../../docs/v2/12-demo-build-plan.md)). The design authority is [the target architecture](../../docs/v2/04-architecture.md#payments-and-tips) (direct charges on the operator's connected account; the operator is merchant of record; TideGrid adds no processing spread or application fee and invoices its own fees separately) and the retained V1 decision on the [webhook inbox](../../docs/v1/adr/0009-webhook-inbox.md). Checkout, which uses this package, is in [domain-booking](../domain-booking/README.md). Tables are in migration `0007_checkout_and_confirmation.sql`.

This package knows nothing about bookings. It is the seam a Stripe adapter replaces.

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
- **Verified events.** `VerifiedProviderEvent` carries a type brand that only an adapter's `verifyWebhook` sets, frozen, with the SHA-256 of the raw body. The inbox accepts nothing else.

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

## Follow-ups for the Stripe adapter

Recorded from the G2.7 independent review. They are notes for the goal that builds the Stripe adapter, and nothing here changes until then.

- **Inbox provenance.** The database cannot tell where an inbox row came from. The owner and the runtime role can both insert a `provider_events` row directly; the runtime needs INSERT to record events at all. A `payment.succeeded` row for a payment's provider id, account, amount, and currency is all the evidence the payment trigger asks for before the payment may become `succeeded`. The signature is checked in the service, not the database: the `VerifiedProviderEvent` brand, which only an adapter's `verifyWebhook` sets, is the only guard on what reaches `recordProviderEvent`. The [checkout contract](../domain-booking/README.md#the-rule) says so too. The Stripe adapter must keep `verifyWebhook` the only producer of that brand, and nothing but `recordProviderEvent` may insert into the inbox. A guard inside the database would need the signing secret there, or a separate inbox-writer role; both are outside the demo.
- **Stripe retries can change the body.** Stripe signs every delivery afresh, and an event's `pending_webhooks` counts the endpoints that have not yet received it, so it falls as other endpoints succeed ([the event object](https://docs.stripe.com/api/events/object)). Two deliveries of one event need not be byte for byte the same. Today the inbox compares the SHA-256 of the raw body, so such a retry:
  - is recorded as `samePayload: false`, and the webhook route logs `payment_webhook_payload_mismatch` as an error on every one;
  - answers `payload_mismatch` without processing, even when the first delivery's processing failed and the event is still `received`, so only the sweep finishes it.

  The Stripe adapter must deduplicate on the event id, as [Stripe advises](https://docs.stripe.com/webhooks#handle-duplicate-events), or hash a normalized body that leaves out per-delivery fields. Stripe never changes an event's `data`. The fake's redeliveries are identical bytes, so the demo cannot show this. Stripe also says it sometimes sends two separate events for one change. Processing is already idempotent per payment (`already_succeeded`, `already_failed`), so a second event id for the same outcome changes nothing.

## Tests

- `pnpm --filter @tidegrid/domain-payments test` runs the signature and fake-provider unit tests, none of which touch a database.
- Checkout's integration suites exercise the fake, the inbox, and the account lookup against a real database.
