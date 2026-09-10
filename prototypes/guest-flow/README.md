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

Guests can browse a monthly calendar, chronological departure list, or experience cards. Coastal fishing, reef diving, sunset cruises, and private charters share one fictional September–October 2026 inventory. Date, experience, charter type, and party filters help guests find a departure; sold-out days, days with no sailings, and insufficient capacity have distinct states. Selecting a departure leads into guest details, simulated checkout, a demo confirmation, a nonbinding waiver interaction, arrival instructions, and Important links.

The operator identity, trips, availability, prices, booking reference, and confirmation are illustrative. An external fishing-license information link points to the [Florida Fish and Wildlife Conservation Commission](https://myfwc.com/license/recreational/saltwater-fishing/); it does not determine whether a license is required for a particular guest or charter.

This prototype does not create reservations, take payments, collect a legal signature, verify licenses, send messages, or persist guest data. It does not implement production capacity controls, authentication, a provider integration, native apps, or an operator console. Those production obligations remain in the V2 plan.

## Five-minute customer session

Ask the operator to use sample details and complete these tasks without a walkthrough:

1. Find an outing for two guests using the calendar, then compare the list and trip-card views. Explain which view helps you decide.
2. Try another date or party size, find a sold-out day, and recover to an available departure. Explain the total price before checkout.
3. Complete the simulated booking and identify what still needs attention.
4. Complete the sample waiver interaction and find arrival instructions and the fishing-license resource.
5. Explain where their real workflow differs and which task would still require another tool or a staff message.

Record where they hesitate, need help, misread a status, or cannot find information. Separate observed behavior from requested features. Ask about the most recent real booking that would not fit this flow. Completion here does not establish demand, migration feasibility, willingness to pay, or acceptance of the native add-on.

## Acceptance and agent ownership

- Astra owns the original UI and implementation in `index.html`, `styles.css`, `app.js`, and `domain.js`.
- The coordinating agent owns this brief, repository documentation, integration, and verification.
- A fresh Astra reviewer checks the initial UI, keyboard behavior, mobile fit, and workflow correctness before handoff.
- Verify discovery view switching, month and date navigation, combined filters, empty results, shared and private bookings, invalid guest details, sold-out or over-capacity choices, back/edit behavior, quote consistency, waiver status, Important links, and reset behavior.
- Inspect the main path at representative phone and desktop widths. Any missing or simulated behavior must be clear to a test participant.

The fanout follows [the saved agent plan](../../docs/v2/10-build-execution-and-agent-plan.md). This is a local prototype exception permitted by [the roadmap](../../docs/v2/05-roadmap-validation.md), not completion of a production goal. No deployment or customer communication is part of this slice.

## Automated checks

```sh
node --test prototypes/guest-flow/domain.test.cjs
node --check prototypes/guest-flow/app.js
git diff --check
```

The domain tests cover shared inventory consistency, combined date/type/experience filters, sold-out versus no-sailing states, party capacity, explicit departure selection, shared versus flat charter pricing, and arrival/date labels.

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
