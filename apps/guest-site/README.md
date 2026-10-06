# @tidegrid/guest-site

The branded guest site for the demo build: one React and Vite build serves every operator, which the API names from the page's Origin, with that operator's validated brand. Pages: `/` (the operator's upcoming trips, G2.11a), `/book/<tripId>` (the checkout, G2.11b), and the placeholder legal pages. The site moves between its own pages in place, through the History API, so the brand stays on screen; Back and Forward work.

## The checkout (G2.11b)

The minimal guest checkout in the [demo build plan](../../docs/v2/12-demo-build-plan.md#goal-sequence). It consumes the pricing and checkout API unchanged ([pricing contract](../../packages/domain-pricing/README.md#api), [checkout contract](../../packages/domain-booking/README.md#api)).

1. **Party.** A trip's Book link carries the list's party size. The page loads the trip's offer and its listing (meeting point, seats left, cutoff), then asks for tickets per type or, for a charter, guests aboard, and any extras. It shows unit prices, fees, how tax is added, and the cancellation policy, but no totals: the server prices everything.
2. **Details.** `POST /v1/public/quotes` prices the party. The page shows the itemized quote (lines, subtotal, discount, fees, added taxes, total, and any tax already included) and when the price expires. A promotion code is applied as a new quote; a refused code marks its field and keeps the current price. The guest gives a name and email and accepts the policy version shown.
3. **Payment.** `POST /v1/public/checkout-sessions` opens the checkout and holds the seats. The demo pays through the fake provider: the page says plainly that this is a test payment and no real card is charged, and offers "Simulate successful payment" and "Simulate declined payment".
4. **Outcome.** The page reads `GET /v1/public/checkout-sessions/{id}` with a gentle backoff until the state is final. Confirmed shows the booking reference, trip, party, and total. Declined offers Try again (a new quote and a new checkout, keeping the details). Expired and canceled offer Start over with the same party. Unfulfilled says the payment arrived after the seats were gone and follows the refund. A cancel button abandons an open checkout and releases its seats at once.

**Only the server decides.** A payment button only asks the provider to settle; its answer is ignored except as "sent". The confirmation appears only when the checkout's own state says confirmed.

**Commands and keys.** Creating a quote and opening a checkout carry an `Idempotency-Key`. Sending the same request again after no answer, a 503 `payment_provider_unavailable`, or another error reuses the key (and, for a checkout, the same checkout secret, since the body must match); any request after a success, or with a different body, is a new command with a new key. A checkout whose answer was lost locks the details until the same request goes again, so a second checkout cannot open for the same quote. Canceling a checkout and settling a test payment take no key in the API: both are idempotent by their resource, so a retry sends the same request.

## Secrets and personal data

- **The booker's name and email** live in the page's memory and travel only in the body of `POST /v1/public/checkout-sessions`. They are never in an address, a log, analytics, or storage.
- **The checkout secret** (43 base64url characters from `crypto.getRandomValues`) and **the payment's client secret** are capabilities. They travel only in `Authorization: Bearer` headers and live in memory.
- **sessionStorage, one record.** While a checkout is open, `src/booking/resume.ts` keeps its id, its quote id, and the checkout secret under one key, so a reload can follow a payment that was already sent instead of leaving the guest without an outcome. It is justified because the alternative, a reload after paying, would leave a guest who paid with no booking reference until email arrives (G2.16). It is scoped and short-lived:
  - sessionStorage belongs to the tab, is never sent anywhere, and is gone when the tab closes;
  - one record for one checkout; a new checkout replaces it;
  - cleared when the checkout reaches any final state, is canceled, or is read more than 10 minutes past its expiry;
  - never the name, the email, or the client secret. A reloaded page therefore cannot pay: before payment it offers to start over, releasing the held seats first.
- **The address** carries only the trip, the party (`t.<code>`, `guests`, `a.<code>`), the step, and on the details step the quote id, which is not authority and holds no personal data. Never a secret, the promotion code, the booker, or the checkout's id.
- A reload during a checkout whose own hold took the trip off sale (a charter's whole boat, or the last seats) reads the trip from the checkout's quote, since the offer then answers 409.

## Content security policy

`public/_headers` keeps the guest policy strict: no inline script or style (React sets styles through the CSSOM), `connect-src` limited to the API origin and Cloudflare's beacon, and zod in jitless mode (`src/zod-jitless.ts`), so parsing a contract never compiles code. `src/static.test.ts` and `src/zod-jitless.test.ts` hold these.

## Local development

```sh
cp .env.example .env.local      # VITE_API_BASE, the local API origin
GUEST_DEV_PORT=5233 pnpm dev    # http://<slug>.book.localhost:5233
```

The API's `ALLOWED_ORIGINS` must list the guest origin, and the seed must run with `SEED_LOCAL_HOSTNAMES=1`. Payments need `PAYMENT_PROVIDER=fake` and a `FAKE_PAYMENT_WEBHOOK_SECRET` in the API's `.dev.vars`.

## Tests

`pnpm --filter @tidegrid/guest-site test`. The checkout's tests run the page in jsdom against a fake API (`src/booking/fixtures.ts`) with the guest in Tokyo and the marina in New York. They cover each step and state, the keys and their reuse, polling to every outcome, a reload at each step, and that no secret or personal data reaches an address.
