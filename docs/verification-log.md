# Prototype verification log

This log records each dated verification pass over the throwaway guest workflow and operator concept prototype in [prototypes/guest-flow](../prototypes/guest-flow/README.md): the automated checks that ran, the browser paths exercised, the widths inspected, and what the independent reviewer found. Entries are newest first and are written by the verification pass after each slice lands, so a reader can see what was proven, by which method, and what was not (browser emulation is not a physical-device test, and none of these passes establish demand, price acceptance, or migration feasibility). Per-document change history is in git; ownership and review rules are in [the build execution and agent plan](v2/10-build-execution-and-agent-plan.md).

## 2026-09-19

### Customer deck terminology fix, September 19, 2026

- Replaced "Tip requests and trip packages" with "Tip requests and trip cards" on slide 2 of the customer deck PPTX (one text run in `ppt/slides/slide2.xml`; no other slide used the old term) and regenerated the PDF from the corrected PPTX with LibreOffice. Slide 2 was rendered and inspected; the replaced line fits its card and no other content moved. The repacked file opens in python-pptx with nine slides. Not done: the skill's OOXML validator needs Python 3.10 or later and the machine's interpreters lack its dependencies, so only a zip integrity check and a python-pptx load were run. The shared Drive PDF still holds the previous snapshot until the owner replaces it.

### Cloudflare deployment verification, September 19, 2026

- Deployed source commit `4970f37` as Worker `tidegrid-prototype`, version `07b413a0-100f-4edb-bf59-905c49dfa94f`, at [demo.tidegrid.us](https://demo.tidegrid.us); the workers.dev fallback also returned HTTPS 200. All 11 public runtime assets matched local SHA-256 hashes (the page is served at `/`; `/index.html` redirects there with 307). README, all four test files, `_headers`, `.assetsignore`, `package.json`, and the Wrangler configuration returned 404.
- The first deploy exposed a real Content-Security-Policy conflict: the Cloudflare zone injects its Web Analytics beacon from `static.cloudflareinsights.com` into every page, and `script-src 'self'` blocked it with a console error on each load. `_headers` now allows that script origin and `cloudflareinsights.com` for `connect-src`, the prototype README documents why, and version `869c6ee8-9749-490e-836c-f71a61f071e6` was deployed with the corrected policy.
- After the second deploy, a fresh request returned the corrected Content-Security-Policy, Strict-Transport-Security, Permissions-Policy, no-index, nosniff, and no-referrer headers. In the built-in browser the beacon loaded, no new policy violation was logged, the calendar opened on September 23, and the operator workspace rendered five sailing rows with capacity meters and the Roster, Marine conditions, Trip cards, and Guest tools views. Network interruptions on the reviewing machine caused some `ERR_NETWORK_CHANGED` entries during testing; they were not server errors and did not recur on reload.
- Not done: no physical-device test; the customer deck PDF and PPTX still say "trip packages" on one slide.

### Review application and verification, September 19, 2026

- Applied the September 19 design and documentation review across the repository: the production gate was split into the Core live gate, Staged Core modules, and Native pilot gate (canonical in the roadmap Gates section, logged in the decision register); customer-facing terminology settled on trip card, trip-count card, and dollar card; the interview gate, no-equity, and Stripe responsibility text were reduced to one canonical home each with links; per-document Date headers were removed; model and tool names now appear only in the build execution and agent plan; V1 material moved to `docs/v1` and source prompts to `docs/archive` with `git mv`; the root README and AGENTS.md were rewritten; the customer brief was rewritten in plain register with two hedges and one remaining conditional.
- Prototype changes: inventory dates are generated relative to today in America/New_York with an injected date for tests, past days render disabled, and zone labels come from Intl (EDT or EST) instead of literals; confirming a booking sends the booker's waiver request automatically and other guests start as "Needs details" until the booker adds them; the operator view renamed Manifest to Roster, removed demo check-in, and gained a three-per-guest "Resend request" for the session booking; calendar days use a roving tabindex with arrow, Home, and End keys; operator sailing rows carry an aria-label; the capacity bar is a `<meter>`; index.html dropped `?v=` query strings; the four stylesheets share one token set and one focus rule; `_headers` adds a self-only Content-Security-Policy with Windy as the only frame source, Strict-Transport-Security, and Permissions-Policy.
- Automated checks: 29 tests pass, including the new source lint for CSP-incompatible markup, out-of-scope vocabulary, and the asset allowlist; `node --check` passes for every runtime script; `git diff --check` is clean; `node scripts/check-links.cjs` resolves all relative links and heading anchors across 73 Markdown files; `wrangler deploy --dry-run` reads 18 files and exits cleanly; grep confirms no Date headers, no model names outside document 10, no em dashes in the edited prose, no inline styles or scripts, and one use of "would" in the brief.
- Independent review ran in two rounds (gate consistency across documents, adversarial prototype code review, before-and-after comparison of the customer brief). Fixed in those rounds: the goal map in document 10 realigned to the gates, the hosting acceptance gates mapped to the named gates, the brief's staged-module wording restored to one Booking Core offer, the sold-out day guaranteed in the month the calendar opens on, the resend button disabled after the third resend, and same-day departures marked past once they have started. Fixed after review: the brief's fee-base sentence now distinguishes trip-count card sales (counted at sale) from dollar cards (counted when redeemed), the Native pilot gate lists the trip-card journey only where that module is enabled, the delivery rule names two operator types, the spring-forward gap maps forward instead of back, and the CSS lint covers stylesheets.
- Browser walkthrough in the built-in browser at desktop width and the 375px mobile preset against a local static server: calendar opened on Wednesday, September 23 with 18 past days disabled and exactly one tabbable day, ArrowRight moved focus to September 24; a two-guest Coastal fishing booking confirmed at $212.00 with the booker's request already awaiting signature; adding Jamie Example sent the second request; the email preview, signature, and receipt completed with one guest still pending; the operator Roster showed the session booking, five sailing rows with meters and aria-labels, and "Sample request re-sent (1 of 3)" after one resend; no console errors and no horizontal overflow at 375px.
- Not done: the public demo at demo.tidegrid.us has not been redeployed, so the new headers and behavior are local only; no physical-device or screen-reader test was run; the customer deck PDF and PPTX still say "trip packages" on one slide; open minor findings are the frozen page-load clock for a tab left open past midnight, the operator resend fallback limit duplicated from waiver.js, and no automated test for the roving tabindex or the edit-then-reconfirm invalidation beyond this manual pass.

## September 10, 2026

### Cloudflare deployment verification, September 10, 2026

- Deployed source commit `3a8c753` as Worker `tidegrid-prototype`, version `aac88b58-c89b-4da1-b013-47b760cffc13`, at [demo.tidegrid.us](https://demo.tidegrid.us). The custom domain and Cloudflare-provided fallback returned HTTPS 200.
- All 11 public runtime assets matched local SHA-256 hashes. README, all three test files, `.assetsignore`, `_headers` and the Wrangler configuration returned 404. Verified no-index, nosniff and no-referrer response headers.
- All 16 automated tests passed. The public browser loaded guest discovery and operator sailings, switched to Marine conditions, and reported no browser errors during the smoke check. The deployed app assets are unchanged from the earlier desktop and phone workflow verification.

### Simplified navigation verification, September 10, 2026

- All 16 domain, waiver and card tests passed, with JavaScript syntax and whitespace checks. Independent navigation/state checks covered one-view rendering, selection context, empty days, active booking navigation and reset.
- Browser checks at 1280px and 390px confirmed compact guest and operator layouts without horizontal document overflow. The mobile journey completed booking at $212, waiver requests, one guest signature and navigation to that booking's manifest; the other guest remained pending.
- Switching views preserved a marine watch, unfinished arrival note, link label, card issue form and redemption amount. Card issuance starts collapsed and stays open while changing card type. A no-sailing date disabled the trip selector and recovered through the suggested date.
- Secondary disclosures were checked as native expandable controls. Required checkout and both sample-signature acknowledgments remain unchanged. This is browser emulation, not a physical-device accessibility audit.

### Trip cards and cancellation credit verification, September 10, 2026

- All 16 automated tests passed, including exact integer cents, fractional-trip rejection, experience eligibility, overdraw, full-use and immutable balance history. JavaScript syntax and whitespace checks passed.
- Browser testing required all four cancellation remedies before saving, then retained three credit choices and one refund, each for $318, in the pending proposal. No balance or booking mutation occurred.
- Browser testing issued a $250 card and a five-trip card; rejected fractional trips, ineligible experiences and overdraw; redeemed one trip and $25.29 correctly, leaving three trips and $174.71 on the respective seeded cards. Reset restored only the original sample balances.
- Inspected the card UI at 1280px and 390px with no horizontal document overflow. Independent source and event-harness review covered card isolation/reset, safe rendering, frozen remedies, stale-preview rejection and separation from real payment actions.

### Marine conditions verification, September 10, 2026

- All 12 existing domain/waiver tests, JavaScript syntax checks, and whitespace checks passed. Independent source and VM review found no unresolved actionable issues in map loading/layers, fixed public URLs, per-departure state/reset, data isolation, proposal validation, escaping, notice comparison, or proposal withdrawal.
- Browser inspection at 1365px verified the marine metrics and rendered Windy Wind and Waves maps. The Waves embed displayed its wave legend in feet. Map data remained independent of the sample departure and metrics.
- Browser execution covered stale/fresh simulation, setting a watch, impact preview for four bookings/eight guests, saving a pending proposal and explicitly saving its local guest notice. A delay overtaken by the simulation clock was rejected; a later time succeeded without changing the original departure.
- Responsive browser controls stalled during phone testing. After recovery, the document measured 354px with no horizontal document overflow, and the proposal/notice flow passed at that width. Phone visual inspection was limited by the browser's scaled screenshot output; this is not a physical-device test. Temporary viewport overrides and the test tab were cleared.

### Waiver and operator verification, September 10, 2026

- All 12 domain and waiver tests passed, along with JavaScript syntax and whitespace checks.
- Browser testing completed book → send requests → email preview → review and type a sample signature → receipt → booking status. Invalid recipient email, missing name, and missing acknowledgments blocked progression. Returning without signing preserved the pending request; signing the first guest left the second pending, and completing both changed preparation status to complete.
- The operator manifest displayed the session's booking and live waiver status. Only its signed participant could be marked checked in. Editing and reconfirming the same trip cleared both prior signatures and check-in.
- Added a custom Important link and saved a departure notice in the operator view, then verified both in guest preparation. Unsafe URL schemes were rejected. A no-sailing date showed an empty state, and the session booking remained discoverable across dates.
- Inspected desktop at 1365px and phone layouts at 390px and 320px, including signing and the operator manifest, without horizontal document overflow. Selecting a departure moves focus and scroll to its manifest.
- A fresh review by an independent reviewer found no unresolved actionable findings in state transitions, participant isolation, input escaping, resource URL validation, or guest/operator integration. Independent execution used Node tests and VM harnesses; rendered browser checks were performed by the coordinating agent, not on a physical phone.

### Discovery expansion verification, September 10, 2026

- All six domain tests, JavaScript syntax, and whitespace checks passed.
- Browser checks covered all three views, preserved departure selection when switching views, clearing selection when party or filters changed, September 21 sold-out departures, September 22 with no sailings, empty-result recovery, and October navigation with 31 calendar dates.
- A two-guest October 3 sunset booking showed $156.88 through review and confirmation, with arrival at 4:30 PM for its 5:00 PM departure. Required guest details, sample acknowledgment, and trip-specific preparation were exercised.
- Inspected desktop at 1365px and phones at 390px and 320px. Calendar, cards, trip-detail dialog, selection summary, and checkout fit without horizontal document overflow; phone metadata was enlarged after visual inspection. A six-person private charter completed at 320px with a $699.60 total and 12:30 PM arrival for a 1:00 PM departure.
- Source review by an independent reviewer found and verified a fix for the result banner on fully sold-out dates. No unresolved actionable source findings remained. Browser checks were performed by the coordinating agent, not on a physical phone; calendar buttons use ordinary Tab navigation.

### Initial checkout verification, September 10, 2026

- JavaScript syntax and `git diff --check` passed.
- Desktop browser checks covered the shared booking, blank name and malformed email, required simulation acknowledgment, waiver status, editing with retained guest details, and refresh clearing those details.
- Sold-out and over-capacity departures blocked progression and removed the invalid quote. The two-guest shared fixture totaled $212.00; a private charter remained $699.60 when its party changed from three to six.
- Browser checks at 390px completed the simulated booking and sample acknowledgment. Screens inspected at 390px and 320px had no horizontal document overflow. The 320px reset returned focus to the heading, and Tab advanced to the trip radio control.
- A fresh source review by an independent reviewer identified the mobile total appearing below the final action. The UI owner added it directly above the acknowledgment and confirmation controls; the coordinating agent verified the fix in the mobile browser.
- The independent reviewer's mobile browser operation stalled. The coordinating agent completed mobile execution and visual checks; this was not an independent device test or an exhaustive accessibility audit.

Use port 4287 for this repository. Port 4173 had a cached service worker from another local application during testing; its storage was left untouched.
