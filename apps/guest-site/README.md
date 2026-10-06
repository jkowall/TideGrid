# @tidegrid/guest-site

The branded guest site for the demo build: one React and Vite build serves every operator, which the API names from the page's Origin, with that operator's validated brand. Pages: `/` (the operator's upcoming trips, G2.11a), `/book/<tripId>` (the checkout, G2.11b), and the placeholder legal pages. The site moves between its own pages in place, through the History API, so the brand stays on screen; Back and Forward work.

## The checkout (G2.11b)

The minimal guest checkout in the [demo build plan](../../docs/v2/12-demo-build-plan.md#goal-sequence). It consumes the pricing and checkout API unchanged ([pricing contract](../../packages/domain-pricing/README.md#api), [checkout contract](../../packages/domain-booking/README.md#api)).

1. **Party.** A trip's Book link carries the list's party size. The page loads the trip's offer and its listing (meeting point, seats left, cutoff), then asks for tickets per type or, for a charter, guests aboard, and any extras. It shows unit prices, fees, how tax is added, and the cancellation policy, but no totals: the server prices everything. A count past a limit stays as typed, with the reason beside it ("Only 4 seats are left, and your party is 6"); the page never lowers a party by itself, and says aloud when a smaller party lowers an extra. Sending the form prices exactly the counts the fields show.
2. **Details.** `POST /v1/public/quotes` prices the party. The page shows the itemized quote (lines, subtotal, discount, fees, added taxes, total, and any tax already included) and when the price expires. The discount row says it comes off the trip price, not extras. A promotion code is applied as a new quote; a refused code marks its field and keeps the current price. The guest gives a name and email and accepts the policy version shown.
3. **Payment.** `POST /v1/public/checkout-sessions` opens the checkout and holds the seats; the trip's facts then say so ("Your 3 seats are held"). The demo pays through the fake provider: the page says plainly that this is a test payment and no real card is charged, and offers "Simulate successful payment" and "Simulate declined payment". Cancel checkout asks first, in a dialog, then releases the seats at once.
4. **Outcome.** The page reads `GET /v1/public/checkout-sessions/{id}` with a gentle backoff until the state is final. Confirmed shows the booking reference, trip, place, party, extras, and total. Declined offers Try again (a new quote and a new checkout, keeping the details). Expired and canceled offer Start over with the same party. Unfulfilled says the payment came after the checkout could no longer become a booking, gives a short checkout reference to quote, and follows the refund.

**Only the server decides.** A payment button only asks the provider to settle; its answer is ignored except as "sent". The confirmation appears only when the checkout's own state says confirmed. Once a payment was sent, or may have been, no screen says that nothing was charged: an expired checkout is read for a short grace in case a late success books it, and the copy says that such a payment is booked or refunded in full.

**The server's clock.** Every deadline on the page is an instant on the server's clock. The page learns the offset between the device and the server from a new quote's `quotedAt` and a new checkout's `createdAt` (never from a replayed answer), so a device clock that is minutes or hours off neither expires a fresh price nor says a live hold has run out (`src/booking/clock.ts`).

**Commands and keys.** Creating a quote and opening a checkout carry an `Idempotency-Key`. Sending the same request again after no answer, a 503 `payment_provider_unavailable`, or another error reuses the key (and, for a checkout, the same checkout secret, since the body must match); any request after a success, or with a different body, is a new command with a new key. A checkout whose answer was lost locks the page until the same request goes again: the price, the code, and the party can't change, Back stays, and a link away asks first, so a second checkout cannot open beside the first. Canceling a checkout and settling a test payment take no key in the API: both are idempotent by their resource, so a retry sends the same request.

**Back, Forward, and leaving.** Moving on from the party and from the details adds a history entry, so Back returns one step and Forward comes back to a price that still holds. Back from the payment asks to cancel the checkout first, as Cancel checkout does; Back while a payment is being confirmed stays and says why. A link away from an open, unpaid checkout asks first and cancels it on the way out. If the page goes anyway, it releases the checkout with a request that outlives the page (`keepalive`), and every answer that arrives after the page has gone is dropped.

## Secrets and personal data

- **The booker's name and email** live in the page's memory and travel only in the body of `POST /v1/public/checkout-sessions`. They are never in an address, a log, analytics, or storage.
- **The checkout secret** (43 base64url characters from `crypto.getRandomValues`) and **the payment's client secret** are capabilities. They travel only in `Authorization: Bearer` headers and live in memory.
- **sessionStorage, two records**, both in `src/booking/resume.ts`:
  - **The open checkout.** While a checkout is open, its id, its quote id, the checkout secret, whether a payment was sent or tried, and the clock offset, under one key, so a reload can follow a payment that was already sent instead of leaving the guest without an outcome. It is justified because the alternative, a reload after paying, would leave a guest who paid with no booking reference until email arrives (G2.16). It is scoped and short-lived: sessionStorage belongs to the tab, is never sent anywhere, and is gone when the tab closes; one record for one checkout, which a new checkout replaces; cleared when the checkout reaches any final state, is canceled, or is read more than 10 minutes past its expiry. Never the name, the email, or the client secret. A reloaded page therefore cannot pay: before payment it offers to start over, releasing the held seats first.
  - **The last confirmation.** What the confirmation screen said: the booking reference, the trip, the place, the party, the extras, and the total. No secret, no name, no email. It exists because the demo sends no confirmation email and the console has no booking list yet, so a reload of the confirmation would otherwise lose the reference. The next confirmation in the tab replaces it, and it goes when the tab closes.
- **The address** carries only the trip, the party (`t.<code>`, `guests`, `a.<code>`), the step, and on the details step the quote id, which is not authority and holds no personal data. Never a secret, the promotion code, the booker, or the checkout's id.
- A reload during a checkout whose own hold took the trip off sale (a charter's whole boat, or the last seats) reads the trip from the checkout's quote, since the offer then answers 409.

## Content security policy

`public/_headers` keeps the guest policy strict: no inline script or style (React and the design system set styles only through the CSSOM), and zod in jitless mode (`src/zod-jitless.ts`), so parsing a contract never compiles code. `connect-src` names the API origin, `https://cloudflareinsights.com` for Cloudflare Web Analytics' manually added beacon, and `'self'`, because the automatically injected beacon reports to the site's own `/cdn-cgi/rum` ([Cloudflare's Web Analytics FAQ](https://developers.cloudflare.com/web-analytics/faq/)). The page's own code fetches only from the API. `src/static.test.ts` and `src/zod-jitless.test.ts` hold these.

## API follow-ups

Found while building the checkout, ranked by the code review. None blocks the demo; the page works around each one. The API is unchanged here; each is a proposal for the goal that owns the API.

1. **A Bearer-authorized read of the payment's client secret** while a checkout is open, with the checkout secret. Today a reload cannot pay, and a lost answer to opening a checkout can be recovered only by resending the same body, which needs the booker's details in memory.
2. **Structured 422 problems**, such as `problems: [{ code, subject }]`. Today the page parses the problem codes and their subjects out of the message text, and falls back to the error's code.
3. **The offer answering 409 because of the guest's own hold.** When a checkout's own hold takes the last seats or the whole boat, the offer refuses the trip, so a reload shows the checkout from its quote instead.
4. **A `remaining` field** on a capacity refusal. A quote's 409 `insufficient_capacity` gives no count, and a checkout's gives it only in the message.

## Local development

```sh
cp .env.example .env.local      # VITE_API_BASE, the local API origin
GUEST_DEV_PORT=5233 pnpm dev    # http://<slug>.book.localhost:5233
```

The API's `ALLOWED_ORIGINS` must list the guest origin, and the seed must run with `SEED_LOCAL_HOSTNAMES=1`. Payments need `PAYMENT_PROVIDER=fake` and a `FAKE_PAYMENT_WEBHOOK_SECRET` in the API's `.dev.vars`.

## Tests

`pnpm --filter @tidegrid/guest-site test`. The checkout's tests run the page in jsdom against a fake API (`src/booking/fixtures.ts`) with the guest in Tokyo and the marina in New York. They cover each step and state, the keys and their reuse, polling to every outcome, a reload at each step, Back and Forward, leaving an open checkout, a device clock that is off, and that no secret or personal data reaches an address. `src/design-system-dom.test.tsx` covers the design system's behavior that needs a DOM.
