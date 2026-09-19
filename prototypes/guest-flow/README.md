# Guest booking workflow prototype

**Status:** Bounded, throwaway prototype authorized September 10, 2026, with public demo hosting authorized the same day. Interview evidence supports the booking, payment, and waiver problem; price acceptance and switching commitments remain unverified, and nothing here is an implementation contract.

## Run locally

From the repository root, with no dependencies, build step, account, or provider credentials:

```sh
python3 -m http.server 4287 --bind 127.0.0.1 --directory prototypes/guest-flow
```

Open [the local prototype](http://127.0.0.1:4287) and use fictional guest details. Inputs live in page memory; refreshing or resetting starts over. Use port 4287 for this repository; port 4173 carried a cached service worker from another local application during testing. Python's `http.server` sends no `Cache-Control` header, so a browser that loaded the same port earlier may serve stale CSS or JavaScript; use a cache-bypassing reload after edits. Production is unaffected because Workers Static Assets sets ETags, which is why `index.html` carries no `?v=` query strings.

## Public demo and deployment

The public demo is [demo.tidegrid.us](https://demo.tidegrid.us). Cloudflare Workers serves the static assets using [the deployment configuration](../../wrangler.prototype.jsonc); the main `tidegrid.us` site is separate. Deploy from the repository root with an authenticated Cloudflare account, and only when the owner asks:

```sh
npx --yes wrangler@4.125.0 deploy --config wrangler.prototype.jsonc --dry-run
npx --yes wrangler@4.125.0 deploy --config wrangler.prototype.jsonc
```

The `.assetsignore` allowlist publishes only `index.html`, the runtime JavaScript, and the CSS. Tests, documentation, `_headers` itself, and provider configuration return 404; a new runtime asset must be added to the allowlist explicitly. Pushing Git does not publish; every update needs an explicit deploy. `_headers` sets these response headers on every path:

- `X-Robots-Tag: noindex, nofollow`, `X-Content-Type-Options: nosniff`, and `Referrer-Policy: no-referrer`.
- `Content-Security-Policy`: every source is `'self'`, with three exceptions. `frame-src` allows only `https://embed.windy.com`. `script-src` also allows `https://static.cloudflareinsights.com` and `connect-src` also allows `https://cloudflareinsights.com`, because the Cloudflare zone injects its Web Analytics beacon into every page; without those two entries the beacon is blocked and logs a console error on each load. `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, and `frame-ancestors 'none'` mean the demo cannot be embedded in an iframe anywhere. No asset uses `data:` URIs or web fonts, so `img-src` is `'self'` only and `font-src` falls back to `default-src`; widen the policy only when an asset needs it.
- `Strict-Transport-Security: max-age=31536000` (this host only; no `includeSubDomains` or `preload`).
- `Permissions-Policy`: camera, microphone, geolocation, payment, and USB are disabled.

The CSP forbids inline `style=` attributes, inline `<script>`, `on*=` handler attributes, and `javascript:` URLs. The capacity bar in the operator view is a `<meter>` styled in `operator.css` for that reason; any future runtime asset must follow the same rule or the page breaks in production only. `source.test.cjs` greps `index.html` and the six runtime scripts for those patterns, for `?v=` query strings, and for out-of-scope vocabulary, so `npm test` fails before a deploy would. Cloudflare serves a managed `robots.txt` at HTTP 200 for the zone; it is not in the repository, and the `X-Robots-Tag` noindex header still applies. Neither is access control; the demo is publicly reachable.

After each deploy, verify HTTPS on the custom domain, the guest and operator views, matching local and public asset hashes, HTTP 404 for excluded files, and the six response headers above. Hosting the demo does not implement the production system or pass any [production gate](../../docs/v2/05-roadmap-validation.md#gates).

### Sharing the demo

The owner approves sharing the link with operators after approving the session scripts below. Customer communication stays separate and follows [the follow-up drafts](../../docs/customer/follow-up-message-drafts.md); any message that links the demo must say it is a clickable concept with sample data, not a product.

## What this tests

Can a guest complete one booking journey on a phone, understand the price and next steps, and find trip preparation information without staff help?

- **Inventory** is generated relative to today in `America/New_York`: the window is the current month and the next month, on a fixed weekly sailing pattern. Inside the next 14 days there is exactly one fully sold-out sailing day and one weekday with no sailings; the default selected day is three or more days ahead with availability, and the sold-out day is in the month the calendar opens on, even near a month end. Past days show as "Past" and are disabled; a departure earlier today whose start time has passed in `America/New_York` also shows "Past" and cannot be quoted, and today's day is disabled once every matching departure has started. Time labels compute EDT or EST per date. Calendar days use a roving tabindex with arrow-key, Home, and End navigation.
- **Discovery**: monthly calendar, chronological departure list, or experience cards for coastal fishing, reef diving, sunset cruises, and private charters. Date, experience, charter type, and party filters; sold-out, no-sailing, and insufficient-capacity states are distinct.
- **Booking**: guest details, simulated checkout with the total shown before confirmation, and a booking dashboard.
- **Waivers**: confirming the booking automatically sends the booker's own waiver request (status "Awaiting signature"). Other party members start as "Needs details" with no name or email. The booker adds each guest's details from the dashboard, and each added guest is sent a request automatically; there is no manual send step and no operator role badge on the guest side. Opening a guest's email preview shows the nonbinding sample waiver, which that guest signs by typing a fictional name and accepting two acknowledgments. Signing one request leaves the others pending.
- **Preparation**: arrival instructions with the operator's trip notice, a trip checklist, and Important links, including the [Florida saltwater fishing license](https://myfwc.com/license/recreational/saltwater-fishing/) resource. The link does not decide whether a particular guest or charter needs a license.

Simulated: the operator, boats, availability, prices, booking reference, payment, confirmation, email delivery, signatures, and the meeting point. Nothing is reserved, charged, sent, verified, or persisted.

## What the operator concept shows

The workspace opens on **Sailings** and shows one view at a time. A shared date and sailing selector keeps trip-specific views in context; notes, link drafts, card forms, and marine proposals survive view changes. Reset returns to Sailings and clears the demo.

- **Sailings**: daily departure overview with sample totals and a capacity meter per sailing.
- **Roster**: the "Departure roster" heading, with the selected sailing's trip, date, time, and boat beneath it, and each participant's waiver status ("Signed", "Awaiting signature", or "Needs details"). For the booking made in this session, "Resend request" re-sends an awaiting-signature guest's request, limited to three resends per guest; after the third the button reads "Resend limit reached" and is disabled. A resend never changes a signature and nothing is emailed. Roster is a booking-management view. Check-in and manifests are out of scope, and the view is not a check-in, boarding, or manifest record.
- **Marine conditions**: fictional wind, seas, swell, and visibility with forecast validity and fresh or stale states; a click-to-load [Windy map embed](https://embed.windy.com/config/map) with Wind and Waves layers for an example Pompano Beach area, independent of the sample metrics. Operators can set a watch, prepare a delay or cancellation proposal with a credit or refund remedy per booking, and save a local guest notice. Proposals stay pending; nothing changes departures, closes sales, cancels bookings, or issues refunds or credits.
- **Trip cards**: named customers holding trip-count cards or dollar cards; operators issue samples, pick eligible experiences, simulate partial redemption, and inspect balance history. No checkout payment, authentication, or purchase.
- **Guest tools**: the trip notice for the selected sailing and the Important links list, both read by the guest preparation screen. Notices are typed by the operator, not generated, and saving one sends nothing.

Marine conditions, trip cards, SMS, pooled equipment, and tips are [staged Core modules](../../docs/v2/05-roadmap-validation.md#staged-core-modules); an operator can go live without them. The operator prototype avoids out-of-scope vocabulary; the only mention of check-in or manifests is the roster footnote that rules them out.

## Session A: guest journey (five minutes, unmoderated)

Ask the operator to use fictional details and complete these tasks on a phone without a walkthrough:

1. Find an outing for two guests using the calendar, then compare the list and experience-card views. Explain which view helps you decide.
2. Try another date or party size, find the sold-out day, and recover to an available departure. Explain the total price before checkout.
3. Complete the simulated booking and say what still needs attention.
4. Add one guest from the booking dashboard, open that guest's email preview, and sign the sample waiver as the guest. Return to the booking and explain who still needs to sign. Find the arrival instructions and the fishing-license link.

## Session B: operator concept walkthrough (moderated, separate)

Run this in a separate, moderated session after Session A. Narrate the concept and ask the operator to react:

5. Open the operator workspace, locate the Session A booking in Roster, and resend one waiver request. Add an Important link and a trip notice in Guest tools, then find both in the guest preparation screen.
6. Inspect Marine conditions, compare Windy's wind and wave layers, then simulate stale trip evidence. Set a local watch, preview a trip-change proposal, and explain what still needs operator approval before guests are affected.
7. Propose a cancellation and choose credit for one booking and refund for another. Then compare a five-trip card with a dollar card, issue a sample of each, and try a partial redemption. Explain which actions are only demonstrations.

Close by asking where the real workflow differs, which task would still need another tool or a staff message, and about the most recent real booking that would not fit this flow.

## What to record

Record where the operator hesitates, needs help, misreads a status, or cannot find information. Separate observed behavior from requested features. Completion proves nothing about demand, price acceptance, or migration; those come from the [interview guide](../../docs/customer/operator-validation-guide.md), not this prototype.

## Automated checks

```sh
npm test
npm run check
node scripts/check-links.cjs
```

`npm test` runs the domain, waiver, trip-card, and source-lint tests. The domain tests inject the date and, where the clock matters, the instant, so the relative inventory stays deterministic. `npm run check` runs the syntax checks and the link checker. Node 22 or later.

## Known gaps

Guardian signing, email verification and participant matching, QR entry and staff-assisted signing, real email or SMS delivery, persistence, authentication, live NOAA evidence, payment and other provider integrations, and a physical-device accessibility audit. Browser checks used emulated phone widths, not a physical phone. The production obligations are in the [product scope](../../docs/v2/02-product-scope.md).

## History

Dated verification records, including independent review of each slice, are in the [prototype verification log](../../docs/verification-log.md). Ownership and review rules are in [the build execution and agent plan](../../docs/v2/10-build-execution-and-agent-plan.md).
