# Guest booking workflow prototype

**Status:** Bounded prototype authorized September 10, 2026. Customer agreement on the problem supports testing this flow; price acceptance and switching commitments remain unverified.

## Run locally

From the repository root:

```sh
python3 -m http.server 4287 --bind 127.0.0.1 --directory prototypes/guest-flow
```

Open [the local prototype](http://127.0.0.1:4287). No dependencies, build step, account, or provider credentials are required. Use fictional guest details. The prototype keeps inputs in page memory; refreshing or resetting starts over.

## What this tests

Can a guest complete one booking journey on a phone, understand the price and next steps, and find trip preparation information without staff help?

Guests can browse a monthly calendar, chronological departure list, or experience cards. Coastal fishing, reef diving, sunset cruises, and private charters share one fictional September–October 2026 inventory. Date, experience, charter type, and party filters help guests find a departure; sold-out days, days with no sailings, and insufficient capacity have distinct states. Selecting a departure leads into guest details, simulated checkout, a booking dashboard, participant waiver requests, guest signing, arrival instructions, and Important links.

The post-booking journey separates booking confirmation from waiver completion. In the operator demo, enter fictional participant names and email addresses and simulate sending their requests. Open a participant's email preview, review the nonbinding sample waiver as that guest, and type a fictional signature. Returning to the booking shows each participant's status; signing one request leaves the others pending. This demonstrates adult participant interactions only. Guardian signing, legal waiver documents, identity verification, actual delivery, and durable signature evidence are not implemented.

**Plan correction after prototype feedback:** The intended product sends initial waiver requests automatically after booking confirmation. Manual controls are for resend and exceptions. The [current product scope](../../docs/v2/02-product-scope.md#automatic-requests-and-resend) also specifies email verification and participant matching, QR entry, and staff-assisted signing without email. The prototype's manual initial send illustrates the steps but does not implement that intended automation or those verification and QR paths.

The operator workspace adds a daily departure overview, fictional booking manifests, waiver status, and simulated check-in for signed participants. The guest booking created in this session appears alongside explicitly seeded examples. Operators can edit Important links and save a local trip notice; the guest preparation screen reads those settings. Notices are entered by the operator, not generated weather or safety decisions, and saving one sends no messages.

Marine conditions show fictional wind, gusts, combined seas, swell height/period/direction, wind waves, and visibility. The trip-date demo clock exposes forecast validity, retrieval time, and fresh/stale states. A separate click-to-load [Windy map embed](https://embed.windy.com/config/map) offers Wind and Waves layers for an example Pompano Beach coastal area. Windy's current/available forecasts are independent of the fictional September–October trip dates and do not populate the sample metrics. Only public area coordinates and display options enter the external map URL.

Operators can set or clear a marine watch, prepare a delay or cancellation proposal, inspect affected bookings, and save a previewed local guest notice. Proposals remain pending approval; this prototype does not change departure times, close sales, cancel bookings, or execute refunds or credits. Live NOAA evidence and the production trip-change workflow remain in the [product plan](../../docs/v2/02-product-scope.md#advisory-weather-and-operator-directed-disruptions).

Cancellation proposals now require a credit or original-payment refund choice for every affected sample booking. The saved proposal shows each customer, amount and remedy. These examples assume full payment in money; mixed payments and original trip-card restoration are specified in the plan. Saving a proposal does not issue credit or change the Trip cards section.

The operator's Trip cards section demonstrates named customers holding whole trips or USD balances. Operators can issue sample cards, select eligible experiences for trip-count cards, simulate partial redemption and inspect balance history. Whole-trip cards reject fractional or ineligible use; USD cards use integer cents; neither can overdraw. This is a separate balance demonstration, without checkout payment, customer authentication, actual card purchases or cancellation issuance. The [trip-card plan](../../docs/v2/02-product-scope.md#trip-cards-trip-counts-and-dollar-balances) covers those connections, source lots, split tender, original-denomination restoration and fee treatment.

The operator identity, trips, availability, prices, booking reference, and confirmation are illustrative. An external fishing-license information link points to the [Florida Fish and Wildlife Conservation Commission](https://myfwc.com/license/recreational/saltwater-fishing/); it does not determine whether a license is required for a particular guest or charter.

This prototype does not create reservations, take payments, collect a legal signature, verify licenses, send messages, or persist guest data. The operator workspace is a local demonstration with an optional external Windy map. It does not implement production capacity controls, authentication, transactional provider integrations, or native apps. Those production obligations remain in the V2 plan.

## Five-minute customer session

Ask the operator to use sample details and complete these tasks without a walkthrough:

1. Find an outing for two guests using the calendar, then compare the list and trip-card views. Explain which view helps you decide.
2. Try another date or party size, find a sold-out day, and recover to an available departure. Explain the total price before checkout.
3. Complete the simulated booking and identify what still needs attention.
4. Send sample waiver requests, open one as the guest, and sign the sample. Return to the booking and explain who still needs to sign. Find arrival instructions and the fishing-license resource.
5. Switch to the operator workspace, locate the same booking, and inspect waiver and check-in status. Add an Important link or trip notice and find it in the guest preparation screen.
6. Inspect Marine conditions, compare Windy's wind and wave layers, then simulate stale trip evidence. Set a local watch, preview a trip-change proposal, and explain what still needs operator approval before guests are affected.
7. Propose a cancellation and choose credit for one booking and refund for another. Then compare a five-trip card with a dollar card, issue a sample of each and try a partial redemption. Explain which actions are only demonstrations.

Then explain where the real workflow differs and which task would still require another tool or a staff message.

Record where they hesitate, need help, misread a status, or cannot find information. Separate observed behavior from requested features. Ask about the most recent real booking that would not fit this flow. Completion here does not establish demand, migration feasibility, willingness to pay, or acceptance of the native add-on.

## Acceptance and agent ownership

- Astra owns the original UI and implementation. Waiver and operator work use separate file owners; the coordinating agent integrates their shared booking snapshot.
- The coordinating agent owns this brief, repository documentation, integration, and verification.
- A fresh Astra reviewer checks the initial UI, keyboard behavior, mobile fit, and workflow correctness before handoff.
- Verify discovery view switching, month and date navigation, combined filters, empty results, shared and private bookings, invalid guest details, sold-out or over-capacity choices, back/edit behavior, quote consistency, waiver status, Important links, and reset behavior.
- Inspect the main path at representative phone and desktop widths. Any missing or simulated behavior must be clear to a test participant.

The fanout follows [the saved agent plan](../../docs/v2/10-build-execution-and-agent-plan.md). This is a local prototype exception permitted by [the roadmap](../../docs/v2/05-roadmap-validation.md), not completion of a production goal. No deployment or customer communication is part of this slice.

## Automated checks

```sh
node --test prototypes/guest-flow/*.test.cjs
node --check prototypes/guest-flow/app.js
git diff --check
```

The domain tests cover shared inventory consistency, combined date/type/experience filters, sold-out versus no-sailing states, party capacity, explicit departure selection, shared versus flat charter pricing, and arrival/date labels. Waiver tests cover send-before-sign, recipient validation, individual participant transitions, required acknowledgments, booking binding, and complete-party status.

## Trip cards and cancellation credit verification, September 10, 2026

- All 16 automated tests passed, including exact integer cents, fractional-trip rejection, experience eligibility, overdraw, full-use and immutable balance history. JavaScript syntax and whitespace checks passed.
- Browser testing required all four cancellation remedies before saving, then retained three credit choices and one refund, each for $318, in the pending proposal. No balance or booking mutation occurred.
- Browser testing issued a $250 card and a five-trip card; rejected fractional trips, ineligible experiences and overdraw; redeemed one trip and $25.29 correctly, leaving three trips and $174.71 on the respective seeded cards. Reset restored only the original sample balances.
- Inspected the card UI at 1280px and 390px with no horizontal document overflow. Independent source and event-harness review covered card isolation/reset, safe rendering, frozen remedies, stale-preview rejection and separation from real payment actions.

## Marine conditions verification, September 10, 2026

- All 12 existing domain/waiver tests, JavaScript syntax checks, and whitespace checks passed. Independent source and VM review found no unresolved actionable issues in map loading/layers, fixed public URLs, per-departure state/reset, data isolation, proposal validation, escaping, notice comparison, or proposal withdrawal.
- Browser inspection at 1365px verified the marine metrics and rendered Windy Wind and Waves maps. The Waves embed displayed its wave legend in feet. Map data remained independent of the sample departure and metrics.
- Browser execution covered stale/fresh simulation, setting a watch, impact preview for four bookings/eight guests, saving a pending proposal and explicitly saving its local guest notice. A delay overtaken by the simulation clock was rejected; a later time succeeded without changing the original departure.
- Responsive browser controls stalled during phone testing. After recovery, the document measured 354px with no horizontal document overflow, and the proposal/notice flow passed at that width. Phone visual inspection was limited by the browser's scaled screenshot output; this is not a physical-device test. Temporary viewport overrides and the test tab were cleared.

## Waiver and operator verification, September 10, 2026

- All 12 domain and waiver tests passed, along with JavaScript syntax and whitespace checks.
- Browser testing completed book → send requests → email preview → review and type a sample signature → receipt → booking status. Invalid recipient email, missing name, and missing acknowledgments blocked progression. Returning without signing preserved the pending request; signing the first guest left the second pending, and completing both changed preparation status to complete.
- The operator manifest displayed the session's booking and live waiver status. Only its signed participant could be marked checked in. Editing and reconfirming the same trip cleared both prior signatures and check-in.
- Added a custom Important link and saved a departure notice in the operator view, then verified both in guest preparation. Unsafe URL schemes were rejected. A no-sailing date showed an empty state, and the session booking remained discoverable across dates.
- Inspected desktop at 1365px and phone layouts at 390px and 320px, including signing and the operator manifest, without horizontal document overflow. Selecting a departure moves focus and scroll to its manifest.
- Fresh Astra review found no unresolved actionable findings in state transitions, participant isolation, input escaping, resource URL validation, or guest/operator integration. Independent execution used Node tests and VM harnesses; rendered browser checks were performed by the coordinating agent, not on a physical phone.

## Discovery expansion verification, September 10, 2026

- All six domain tests, JavaScript syntax, and whitespace checks passed.
- Browser checks covered all three views, preserved departure selection when switching views, clearing selection when party or filters changed, September 21 sold-out departures, September 22 with no sailings, empty-result recovery, and October navigation with 31 calendar dates.
- A two-guest October 3 sunset booking showed $156.88 through review and confirmation, with arrival at 4:30 PM for its 5:00 PM departure. Required guest details, sample acknowledgment, and trip-specific preparation were exercised.
- Inspected desktop at 1365px and phones at 390px and 320px. Calendar, cards, trip-detail dialog, selection summary, and checkout fit without horizontal document overflow; phone metadata was enlarged after visual inspection. A six-person private charter completed at 320px with a $699.60 total and 12:30 PM arrival for a 1:00 PM departure.
- Independent Astra source review found and verified a fix for the result banner on fully sold-out dates. No unresolved actionable source findings remained. Browser checks were performed by the coordinating agent, not on a physical phone; calendar buttons use ordinary Tab navigation.

## Initial checkout verification, September 10, 2026

- JavaScript syntax and `git diff --check` passed.
- Desktop browser checks covered the shared booking, blank name and malformed email, required simulation acknowledgment, waiver status, editing with retained guest details, and refresh clearing those details.
- Sold-out and over-capacity departures blocked progression and removed the invalid quote. The two-guest shared fixture totaled $212.00; a private charter remained $699.60 when its party changed from three to six.
- Browser checks at 390px completed the simulated booking and sample acknowledgment. Screens inspected at 390px and 320px had no horizontal document overflow. The 320px reset returned focus to the heading, and Tab advanced to the trip radio control.
- A fresh Astra source review identified the mobile total appearing below the final action. The UI owner added it directly above the acknowledgment and confirmation controls; the coordinating agent verified the fix in the mobile browser.
- The independent reviewer's mobile browser operation stalled. The coordinating agent completed mobile execution and visual checks; this was not an independent device test or an exhaustive accessibility audit.

Use port 4287 for this repository. Port 4173 had a cached service worker from another local application during testing; its storage was left untouched.
