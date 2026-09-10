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

The flow covers a sample shared trip or private charter, departure and party selection, guest details, simulated checkout, a demo confirmation, a nonbinding waiver interaction, arrival instructions, and Important links. The operator identity, trips, availability, prices, booking reference, and confirmation are illustrative. An external fishing-license information link points to the [Florida Fish and Wildlife Conservation Commission](https://myfwc.com/license/recreational/saltwater-fishing/); it does not determine whether a license is required for a particular guest or charter.

This prototype does not create reservations, take payments, collect a legal signature, verify licenses, send messages, or persist guest data. It does not implement production capacity controls, authentication, a provider integration, native apps, or an operator console. Those production obligations remain in the V2 plan.

## Five-minute customer session

Ask the operator to use sample details and complete these tasks without a walkthrough:

1. Choose a trip for two guests and explain the total price before checkout.
2. Change the departure or party size and check what changed.
3. Complete the simulated booking and identify what still needs attention.
4. Complete the sample waiver interaction and find arrival instructions and the fishing-license resource.
5. Explain where their real workflow differs and which task would still require another tool or a staff message.

Record where they hesitate, need help, misread a status, or cannot find information. Separate observed behavior from requested features. Ask about the most recent real booking that would not fit this flow. Completion here does not establish demand, migration feasibility, willingness to pay, or acceptance of the native add-on.

## Acceptance and agent ownership

- Astra medium owns the original UI and implementation in `index.html`, `styles.css`, and `app.js`.
- The coordinating agent owns this brief, repository documentation, integration, and verification.
- A fresh Astra reviewer checks the initial UI, keyboard behavior, mobile fit, and workflow correctness before handoff.
- Verify shared and private bookings, invalid guest details, sold-out or over-capacity choices, back/edit behavior, quote consistency, waiver status, Important links, and reset behavior.
- Inspect the main path at representative phone and desktop widths. Any missing or simulated behavior must be clear to a test participant.

The fanout follows [the saved agent plan](../../docs/v2/10-build-execution-and-agent-plan.md). This is a local prototype exception permitted by [the roadmap](../../docs/v2/05-roadmap-validation.md), not completion of a production goal. No deployment or customer communication is part of this slice.

## Verification, September 10, 2026

- JavaScript syntax and `git diff --check` passed.
- Desktop browser checks covered the shared booking, blank name and malformed email, required simulation acknowledgment, waiver status, editing with retained guest details, and refresh clearing those details.
- Sold-out and over-capacity departures blocked progression and removed the invalid quote. The two-guest shared fixture totaled $212.00; a private charter remained $699.60 when its party changed from three to six.
- Browser checks at 390px completed the simulated booking and sample acknowledgment. Screens inspected at 390px and 320px had no horizontal document overflow. The 320px reset returned focus to the heading, and Tab advanced to the trip radio control.
- A fresh Astra source review identified the mobile total appearing below the final action. The UI owner added it directly above the acknowledgment and confirmation controls; the coordinating agent verified the fix in the mobile browser.
- The independent reviewer's mobile browser operation stalled. The coordinating agent completed mobile execution and visual checks; this was not an independent device test or an exhaustive accessibility audit.

Use port 4287 for this repository. Port 4173 had a cached service worker from another local application during testing; its storage was left untouched.
