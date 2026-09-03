# TideGrid operator validation guide

**Status:** Internal research guide, not customer-facing
**Date:** September 4, 2026
**Interview length:** 45 minutes

## Purpose

Use this guide for the 12-operator validation round before TideGrid forms customer obligations or starts the production build. The interview must establish what the operator did, what it cost, and what it displaced before TideGrid shows a concept or discusses price.

The interview is not a product demonstration, sales presentation, requirements session, or request for feature approval. A compliment, stated interest, or answer to "would you use this?" is not demand evidence.

## Research objectives

The interviews must answer:

1. How do operators currently sell and change bookings across their booking system, payment tools, waivers, equipment records, weather decisions, messaging, and repeat-customer programs?
2. Which failures recur, how recently they occurred, and what time, money, customer impact, or operational risk they created?
3. How many bookings are direct or staff-assisted rather than OTA-controlled, and does the operator fit TideGrid's direct-first boundary?
4. Does a branded PWA or native application address a demonstrated repeat-use or customer-service problem rather than a preference for having an app?
5. Does the standard V2 boundary cover the operator without live OTA synchronization, a customer source fork, full departure operations, serialized equipment, or custom loyalty rules?
6. How does the full recurring price compare with the operator's actual booking value, current software expense, and cost of workarounds?
7. Will a qualified operator take a concrete next step toward the Pilot Native offer under the disclosed scope and price?

The results determine whether to continue with the current segment, offer, scope, and pricing; change one of them and repeat validation; or stop before paid-pilot-readiness and production spending.

## Interview rules

- Ask about the operator's work, not TideGrid's idea.
- Ask for the most recent specific event before asking for a general pattern.
- Keep the conversation about past behavior until the concept walkthrough.
- Ask one question at a time. Use silence and follow the operator's language.
- Aim for the operator to speak at least 80% of the time.
- Do not suggest the problem, name a TideGrid feature, or complete the answer for the operator.
- Separate observed facts, reported facts, interpretations, and proposed solutions in the notes.
- Do not negotiate scope or promise a feature, integration, price exception, launch date, store approval, or custom work during the interview.
- Show the same dated concept and price structure to every participant so results remain comparable.
- Count a promised follow-up only after the participant completes it.
- Give compliments zero evidentiary weight.

Useful neutral probes:

- "Can you walk me through a specific example?"
- "When did that last happen?"
- "What happened next?"
- "Who was involved?"
- "What did you use to resolve it?"
- "How long did that take?"
- "Where could I see that in the current system?"
- "What did that cost or prevent?"
- "How often did this happen in the last month or season?"
- "What have you already tried to change?"

Avoid leading or hypothetical prompts:

| Avoid | Ask instead |
|---|---|
| Would you use one booking system for everything? | Walk me through the last booking that required more than one system. |
| Would reminders help? | What happened the last time a waiver or balance was incomplete? |
| Do weather cancellations cause problems? | Tell me about the most recent trip you changed because of weather. |
| Would your customers download an app? | What do returning customers do today, and what evidence do you have that they return digitally? |
| Is this price reasonable? | What did you spend on the current workflow in the last 12 months, and how would this price be evaluated? |
| What features do you want? | What was hardest in the last real example, and what did you do about it? |

## Recruiting and interview order

Recruit 12 distinct US operating businesses across dive, fishing, sightseeing, and private-charter services. Target six dive operators and two from each adjacent category. This gives the declared dive beachhead half of the sample while testing whether the standard product generalizes. Alternate operator types through the schedule instead of interviewing one category as a block.

Use this order:

1. Interviews 1 to 3 test whether the questions produce specific events and usable economic data. Adjust only wording or timing.
2. Interviews 4 to 9 use the stabilized guide and the same customer-facing concept version. Do not add features to the concept in response to one request.
3. After interview 9, identify missing operator types and qualification ranges. Recruit interviews 10 to 12 to fill those declared gaps, not to manufacture favorable results.
4. Evaluate the gate only after all 12 are complete.

Interview an owner, general manager, reservations manager, or another person who directly performs or owns the workflow. A second employee can add operational evidence, but multiple people from one business count as one operator toward the 12-operator gate. Record whether the participant can approve software and who else participates in the decision.

Do not recruit only operators already known to dislike their current system. Include at least some operators satisfied with their current tools and some that will likely fail the direct-first boundary.

### Suggested recruitment message

Send this only after the bare-bones formation gate passes and from the company-controlled email address. Personalize the first sentence without implying that TideGrid is released.

**Subject:** Research on passenger-vessel booking workflows

> Hi [name],
>
> I am researching how passenger-vessel operators handle bookings, payments, waivers, equipment, customer changes, and repeat business across their current tools. TideGrid is an early concept under validation.
>
> Would you be willing to spend 45 minutes walking me through a few recent examples from your operation and then reacting to the concept and proposed pricing? I do not need guest records or confidential customer data. Candid criticism is more useful than encouragement.
>
> If you are open to it, I can send a few times that work.
>
> Jonah<br>
> TideGrid LLC

If the legal name differs from `TideGrid LLC`, use the filed name and approved public brand. Do not attach the concept brief before the meeting; showing it early would bias the past-behavior interview.

## Before each interview

- Assign an anonymous participant ID such as `OP-01`.
- Record the operator category and participant role, but keep names and contact details out of this repository.
- Prepare the same dated customer-facing concept artifact and a pricing worksheet.
- Leave the concept hidden until the discovery section is complete.
- Prepare a timer and the structured note template below.
- Invite the participant to have only aggregate figures available: trailing booking value, total booking count, direct and OTA split, current tool spend, and active boats. Do not require preparation or send the concept in advance. Missing figures can become an agreed follow-up instead of consuming the interview.
- If recording is useful, select an access-controlled location outside this public repository and obtain explicit permission before recording.
- Do not request guest-level booking exports, signed waivers, payment credentials, or other customer personal data.

## 45-minute interview

### 0:00 to 0:03: Opening and permission

Suggested opening:

> Thanks for taking the time. I am researching how passenger-vessel operators manage bookings and customer follow-up. TideGrid is still being validated, and I am not asking you to buy anything today. I want to understand recent examples from your operation before I show a concept and proposed pricing. If there appears to be a fit, I may ask whether a separate pilot-intent discussion would be useful. I will keep us to 45 minutes.

Ask:

1. "Is 45 minutes still workable?"
2. "May I take notes?"
3. If recording: "May I record this for my private research notes? It will not be published or shared without separate permission."

If permission to record is denied, do not record. Continue with notes. Permission for research recording is not permission to publish a quote, company name, logo, or case study.

### 0:03 to 0:07: Role and operating context

- "Tell me about your role and the parts of booking or customer operations you handle personally."
- "What kinds of trips did you run in the last full season?"
- "How many boats were active, and how did a typical week differ between peak and slow periods?"
- "Who else touches a booking from purchase through trip completion?"

Do not qualify the operator aloud or reveal TideGrid's thresholds yet.

### 0:07 to 0:15: The last booking

- "Please open or recall the last completed booking you handled and walk me through it from the first customer contact through the completed trip."
- "Where did it originate?"
- "Which systems, spreadsheets, messages, or paper records did you touch?"
- "How were capacity, payment, participants, waivers, and any rental equipment recorded?"
- "Where did someone re-enter or reconcile information?"
- "What, if anything, was incomplete when the customer arrived?"
- "How did you know the booking was financially complete?"

Probe for elapsed staff time, handoffs, corrections, and the consequence of an error. Do not introduce TideGrid's feature names.

### 0:15 to 0:25: Recent exception events

Ask which category produced the most consequential recent exception and probe that event. Sample another category only when time remains. Missing categories can become later questions; depth on one real event is more useful than four general answers.

**Change, cancellation, or refund**

- "Tell me about the last time a customer changed or cancelled a booking."
- "Was money refunded, retained, moved to credit, or collected another way?"
- "What records had to change, and how did you confirm they agreed?"

**Waiver**

- "Tell me about the last booking where a waiver was late, missing, incorrect, or signed by a guardian."
- "When did you discover it, and what did staff do next?"

**Weather or operator disruption**

- "Tell me about the most recent departure you watched, delayed, changed, or cancelled because of weather or another operator decision."
- "Who made the decision, what evidence did they use, and how were affected customers, payments, and credits handled?"

**Equipment, packages, or returning customers**

- "Tell me about the last time rental availability, a prepaid package, or a returning customer's history affected a booking."
- "Where was the quantity or balance recorded, and did anyone have to correct it?"

For each event, capture when it happened, frequency, people involved, systems touched, staff time, money affected, customer consequence, workaround, and whether the operator has already paid or tried to fix it.

### 0:25 to 0:31: Current stack and operating numbers

Ask for the most recent complete trailing 12 months, or the most recent full operating season when the business has less history. Record the period and source for every number.

- "Which booking, payment, waiver, messaging, equipment, accounting, package, and customer tools did you pay for or use during that period?"
- "What did each cost, including fixed fees, booking percentages, processing, texting, and staff or contractor work?"
- "What was total eligible booking value for trips, charters, required fees, rentals, and paid add-ons, excluding taxes, tips, refunds, complimentary value, and promotional credit?"
- "How many total bookings were completed? How many came through your direct website, phone, walk-up, or staff? How many came through each OTA?"
- "What percentage of customers or bookings were repeats, and how do you currently measure that?"
- "How many waivers, changes, refunds, weather disruptions, and equipment allocations did staff handle?"
- "How much staff time goes to reconciliation, reminders, changes, and customer questions in an ordinary month?"

Ask how the participant obtained each figure. If the number is an estimate, record it as an estimate. Request a later redacted summary report only if the participant is comfortable sharing one. Do not accept or store guest-level data.

### 0:31 to 0:34: Problem ranking before the concept

- "Of the situations we discussed, which three consumed the most time, money, or customer trust during that period?"
- "Please rank those three. What makes the first one more important than the second?"
- "What did you already try for the top problem?"
- "What budget or project lost priority to it?"
- "If nothing changed for another season, what would happen?"

Record the participant's wording. Do not translate the answer into a TideGrid feature during the interview.

### 0:34 to 0:39: Concept review

Only now show the dated customer-facing concept. Say:

> This is an early description, not a released product or a delivery promise. Please react based on the real examples you just described.

Use the dated brief to test comprehension and workflow fit rather than presenting every planned feature:

1. Show the title and opening sections without explaining them. Ask, "What do you think this is describing, and what seems most relevant or irrelevant to your operation?"
2. Give one scenario that matches an event already described. Ask the participant to explain what they expect to happen next.
3. Ask, "Which part of your current process, if any, would this replace in that example?"
4. Ask, "What in this concept would not have handled the example correctly?"
5. Ask, "What would still require the current system or a manual step?"
6. For Native, ask, "What have returning customers done through your website or existing app in the last season that supports or contradicts this repeat-use case?"

Do not ask whether the participant likes the design or would use the product. Record confusion, task completion, missing evidence, and conflicts with real workflow. A request is not automatically a roadmap commitment.

If a later interview uses a low-fidelity prototype, keep the same discovery-first order, record the prototype version, and distinguish observed interaction problems from reactions to the written concept. A prototype is not required for the first interviews.

### 0:39 to 0:43: Price reveal and commitment tests

Show the standard price before the pilot credit:

- Booking Core self-setup: $0 setup, $149 per month plus 1.5% of net managed booking value, with a 12-month commitment and $3,000 annual Core minimum.
- Managed Launch: optional $1,000 for the defined configuration, standard import, waiver setup, training, and cutover scope.
- Native add-on: $4,500 setup plus $399 per month and 0.25% of net managed booking value, with a 12-month commitment.
- Two active boats are included. Additional active boats are $75 per month. Provider, registration, domain, messaging, payment-processing, and app-store costs pass through at cost.
- Pilot Native offer: the first three qualified pilot operators pay $2,250 Native setup, receive Managed Launch at no charge, and pay the full recurring and pass-through charges.

Explain that the operator remains merchant of record and that TideGrid's percentage applies to TideGrid-managed booking value, including approved externally paid bookings. Taxes, tips, complimentary value, promotional credit, and refunded value are excluded under the current plan.

Then ask:

- "Please explain how you understand the price and fee base in your own words."
- "Which line, if any, changes how you evaluate this?"
- "How does it compare with what you spent and the problems you described from the last 12 months?"
- "Who would approve this, what information would they require, and when is the next real switching window?"
- "What existing contract, migration, store account, or internal decision could prevent a change?"

Ask for the smallest relevant follow-up rather than an opinion:

- a redacted trailing-volume and channel-mix summary by a specific date;
- an introduction to the operational or financial decision-maker;
- or, for a potentially qualified Native prospect, a separate commercial-validation meeting to review the standard scope, calculated price, conditions, and nonbinding pilot intent.

TideGrid is not yet accepting money or signing recurring customer agreements during this validation round. Do not ask for a written conditional commitment in the initial interview or draft custom terms during it.

Record what the participant completes. "Send me the report tomorrow" remains an uncompleted intention until the report arrives. "I love it" counts as no commitment.

### 0:43 to 0:45: Wrap-up and referrals

- "What important part of the workflow did I fail to ask about?"
- "Who runs a materially different operation that I should learn from?"
- "May I contact you about the specific next step we recorded?"

Thank the participant and state only the agreed follow-up. Do not imply selection for the pilot.

## Qualified-prospect commercial follow-up

Conduct the separate 30-minute discussions only after all 12 initial interviews are complete, at least five operators meet the direct-first profile, and at least three provisionally Native-qualified prospects across two operator types accept the follow-up. Each participant's record must support the Native qualification criteria. The initial interview may secure agreement to this follow-up, but it does not include the commitment ask. Include the other financial or operational decision-maker when approval is shared.

Before the meeting:

- obtain the agreed aggregate volume and channel evidence, without guest-level data;
- calculate the standard recurring price and show the pilot credit separately;
- list unresolved qualifications, excluded-capability dependencies, switching constraints, and customer-owned store-account responsibilities; and
- use the same dated scope and fee-base definition used with other prospects.

During the meeting, ask the buyer to explain the scope, fee base, full recurring price, pass-through charges, store responsibilities, and conditions in their own words. Resolve misunderstandings without negotiating a source fork, unpriced feature, guaranteed store approval, or undisclosed concession.

For a qualified prospect, ask whether the authorized buyer will provide a dated written conditional commitment to enter the 12-month arrangement and pay the $2,250 setup fee after TideGrid completes paid-pilot readiness and presents a final agreement matching the reviewed scope and economics. The commitment is demand evidence, not a deposit, contract, reservation, or promise by TideGrid to build.

## Qualification rules

Apply these rules after the interview. Do not bend them to count a promising conversation.

### Direct-first discovery profile

An operator counts toward the five-of-12 gate only when all of the following are supported:

- It is a US passenger-vessel operator running one to five active boats.
- It sells scheduled shared-seat trips or private charters.
- At least 80% of trailing booking count comes through its direct website, phone, walk-up, or staff-assisted channels. OTA and other externally controlled bookings are 20% or less.
- It has a returning-customer base.
- It currently reconciles booking, payment, waiver, participant, equipment, or customer information across several tools or manual records.
- It can supply approved policies, waiver language, business records, and clean migration data.
- Adoption does not depend on live OTA synchronization, full dockside or departure operations, serialized equipment, custom loyalty rules, customer-specific source code, or another capability outside the published V2 boundary.

Use booking count, not booking value, for the 80/20 channel threshold. Use a trailing 12-month period where available and record both numerator, denominator, source, and period. An unsupported estimate is provisional and does not count toward the gate until it is credibly corroborated.

An operator with five active boats can fit the discovery profile but requires a custom quote. More than five active boats is outside the initial profile.

### Native pilot qualification

A Native pilot candidate must meet the direct-first profile and every standard Pilot Native condition. In addition:

- Average trailing-12-month net managed booking value is at least $25,000 per month.
- The interview identifies a specific, evidenced repeat-customer or customer-service use case for Native.
- The operator is prepared to use one legal operator, one brand, one location, and one iOS and Android pair with no source fork or exclusive feature commitment.
- The operator accepts the full recurring price, the fee on TideGrid-managed externally paid bookings, pass-through provider charges, the 12-month term, customer-owned store accounts, weekly design reviews, and acceptance testing.
- The operator can supply approved branding, waiver language, legal pages, business records, clean data, provider accounts, and approvals on schedule.
- An authorized decision-maker is prepared to sign and fund the pilot after TideGrid's paid-pilot-readiness gate and final agreement are complete.

Calculate average trailing-12-month value as eligible value for the period divided by 12, including zero-revenue months. Record active-month average separately for seasonality, but do not substitute it for the gate. When history is unavailable, label a forecast as unverified and do not silently treat it as observed value.

The $25,000 threshold is a pilot learning exception, not the standard Native sales target. Until measured service cost proves a 75% recurring gross margin at lower volume, standard Native sales should target operators near $50,000 or more in average monthly managed booking value. Operators above $100,000, with five or more active boats, multiple locations, or multiple brands require a custom quote.

### Written conditional commitment

Count a conditional commitment only when TideGrid has a dated private written record from an authorized buyer that:

- identifies the operator and reviewed concept version;
- confirms that the operator meets the direct-first and Native pilot qualifications;
- states readiness to enter a 12-month Booking Core and Native agreement after TideGrid completes the disclosed paid-pilot-readiness gate;
- acknowledges the $2,250 Pilot Native setup fee, full recurring price, managed-booking fee definition, pass-through costs, store-account responsibilities, and standard product boundary;
- identifies any explicit condition and a real decision or switching window; and
- is not contingent on a source fork, unpriced custom feature, live OTA synchronization, guaranteed store approval, or an undisclosed price concession.

Verbal enthusiasm, a survey checkbox, permission to follow up, a referral, a letter drafted only by TideGrid, or a conditional statement from someone without buying authority does not satisfy this gate.

## Decision thresholds

| Decision | Evidence required | Action |
|---|---|---|
| Complete the validation round | 12 completed interviews with 12 distinct operators across the declared segment mix | Do not make the paid-pilot-readiness or build decision from an early favorable subset |
| Direct-first gate passes | At least five of 12 meet every direct-first discovery-profile rule | Continue evaluating the three-customer pilot |
| Feasibility-spike gate passes | At least three provisionally Native-qualified prospects across two operator types accept a commercial follow-up, in addition to the five direct-first operators | Run only the bounded technical and cost spikes required before the commercial follow-ups |
| Conditional-demand gate passes | Three distinct, qualified Native pilot operators across at least two operator types provide written conditional commitments | Proceed to the separately approved paid-pilot-readiness and funding decision; do not count this as a signed sale |
| Gate fails | Fewer than five of 12 fit, fewer than three qualified written commitments result, or all three come from one operator type | Do not form customer obligations or start the production build; change the segment, scope, offer, or price and run a new declared test |
| OTA dependency is systematic | Five otherwise qualified prospects are blocked by OTA dependency | Evaluate a one-way intake adapter before considering full channel management |

Passing the interview gates does not authorize paid-pilot-readiness spending, customer contracts, deposits, provider production accounts, or the production build. Those require the funding, legal, insurance, account-readiness, and paid-contract gates in the V2 roadmap. The earlier bare-bones entity filing is administrative preparation and does not satisfy any of those gates.

## Evidence grading

Grade each important claim and action:

| Grade | Evidence | Examples |
|---|---|---|
| A: observed or completed | A dated artifact, direct observation, completed follow-up, or written commitment corroborates the claim | Redacted aggregate booking report; current invoice total; observed workflow; decision-maker introduction completed; qualifying written commitment received |
| B: specific reported behavior | A concrete past event or number includes time, context, workflow, and consequence but has not been independently corroborated | Detailed account of last refund; participant reports exact trailing volume and identifies the report used |
| C: general claim or intention | The statement lacks a specific event, source, or completed action | "Waivers are a pain"; "we would probably switch"; promise to send data later |
| D: opinion, compliment, or prompted answer | The statement concerns the idea, repeats the question, or offers no behavioral evidence | "Great idea"; "I like the app"; affirmative answer to "would you use it?" |

Use only A or B evidence to establish a problem or workflow pattern. Require A evidence for a completed conditional commitment. C and D items may suggest a future question but do not support a gate.

An absence of pain is evidence when it is based on a specific smooth event or established workflow. Do not reinterpret satisfaction with an incumbent as failure to understand TideGrid.

## Structured note template

```text
Interview ID: OP-__
Date and time:
Interviewer:
Recording permission: yes / no
Recording location and retention date: private record only / not recorded
Operator category: dive / fishing / sightseeing / private charter
Participant role:
Buying authority: yes / no / shared / unknown
Other decision-makers:

OPERATING CONTEXT
Active boats:
Trip types:
Operating months and seasonality:
Staff touching a booking:

LAST BOOKING
Date or recency:
Origin channel:
Steps and systems used:
Capacity and equipment handling:
Payment and reconciliation:
Participants and waivers:
Time, money, customer, or risk consequence:
Evidence grade and source:

RECENT EXCEPTIONS
Last change, cancellation, or refund:
Last waiver issue:
Last weather or operator disruption:
Last equipment, package, or return-customer event:
Most consequential event and why:
Workaround or attempted solution:
Evidence grade and source for each:

TRAILING PERIOD AND ECONOMICS
Measurement period:
Total eligible managed booking value:
Average monthly value, trailing total / 12:
Active-month average, recorded separately:
Total booking count:
Direct web booking count:
Phone, walk-up, or staff-assisted count:
OTA or externally controlled count by channel:
Direct percentage = direct and staff-assisted / total:
Repeat-customer measure and source:
Waiver, change, refund, disruption, and equipment volumes:
Current tools and annual costs:
Monthly staff time spent on workarounds:
Observed, reported, estimated, or forecast:
Evidence grade and source:

PROBLEM RANKING BEFORE CONCEPT
1.
2.
3.
Existing attempts and spending:
Consequence of no change:

CONCEPT WALKTHROUGH
Artifact version and date:
Initial interpretation:
Scenario attempted:
Where expectation matched:
Confusion or failure:
Current work that it could replace:
Current work it would not replace:
Native repeat-use evidence from past behavior:
Feature requests, recorded as requests only:

COMMERCIAL TEST
Full standard price shown: yes / no
Calculated price using disclosed volume:
Participant's explanation of fee base:
Comparison with current cost or problem:
Specific objection:
Decision process and switching window:
Externally paid booking fee accepted: yes / no / unresolved
Standard scope accepted: yes / no / unresolved
Concrete next action, owner, and date:
Action completed: yes / no
Written conditional commitment received: yes / no
Evidence grade:

QUALIFICATION
US passenger-vessel operator: pass / fail / unknown
One to five active boats: pass / fail / custom quote / unknown
Shared-seat or private-charter product: pass / fail / unknown
At least 80% direct or staff-assisted booking count: pass / fail / provisional
Returning-customer base: pass / fail / unknown
Multi-tool reconciliation problem: pass / fail / unknown
Can supply required policy, business, and clean-data inputs: pass / fail / unknown
No dependence on excluded capability: pass / fail / unknown
Direct-first profile result: qualified / not qualified / provisional
At least $25,000 average monthly managed value: pass / fail / forecast only
Specific evidenced Native repeat-use case: pass / fail
Native pilot result: qualified / not qualified / provisional
Reason:

TOP EVIDENCE
A-grade:
B-grade:
C-grade follow-up questions:
Compliments or hypothetical interest, excluded from decisions:

FOLLOW-UP
Agreed action:
Owner:
Due date:
Referral:
Permission to recontact: yes / no
Private artifacts and retention location:
Anonymized facts permitted in aggregate repository analysis:
```

## Research-data handling

This repository may contain the guide, empty templates, anonymous counts, and aggregated findings only. Do not commit:

- operator or participant names, contact details, identifiable quotations, or unpublished business information;
- recordings, transcripts, screenshots, contracts, invoices, exports, or pricing worksheets tied to a named operator;
- guest names, contact details, booking identifiers, signed waivers, payment details, medical or certification information, or other customer data; or
- credentials, provider-account identifiers, tax records, or store-account evidence.

Keep raw notes and artifacts in approved access-controlled private storage with a retention date. Use only participant IDs in repository summaries. Obtain separate written permission before publishing a name, logo, quote, reference, or case study.

## Post-interview discipline

Within 24 hours:

1. Complete the notes without improving or translating the participant's words.
2. Grade the evidence and mark qualification fields as pass, fail, provisional, or unknown.
3. Send only the follow-up agreed during the interview.
4. Update anonymous aggregate counts. Do not adjust the denominator or qualification rule.
5. Record new questions separately. Change the shared interview guide or concept only at the declared review points, and version any change.

After interviews 3, 9, and 12, review interview quality and favorable answers as separate measures. Track missing past-event detail, unavailable economic data, interviewer talk time, leading questions, uncompleted follow-ups, qualification outcomes, and concrete commercial actions. Do not count compliments.
