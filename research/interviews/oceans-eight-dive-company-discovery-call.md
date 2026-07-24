# Oceans Eight Dive Company discovery interview

## Interview record

- **Interview date:** Not provided
- **Imported:** July 24, 2026
- **Participants:** Jonah Kowall; Oceans Eight Dive Company operator, name not present in the transcript
- **Segment:** Small dive-charter operator
- **Location context:** Boynton Beach, Florida
- **Research stage:** Problem and workflow discovery
- **Source:** User-provided transcript and meeting summary

## Evidence quality

This is a single operator interview, so it should shape hypotheses rather than set priority by itself. Pricing, integration behavior, and vendor capabilities below are operator-reported unless explicitly linked to a verified source.

The transcript contains crosstalk and likely transcription errors. Weather automation, AI support, and multi-channel messaging were proposed by Jonah during the call. The operator reacted positively, but those reactions are weaker evidence than problems the operator raised without prompting.

## Background

Oceans Eight Dive Company runs dive charters. The operator is in peak summer operations and is not actively trying to replace the current system. They are willing to evaluate an alternative after the season and to act as a sounding board while TideGrid develops.

Construction at the operator's usual slip has temporarily moved customer pickup to Harvey E. Oyer Park. This was operational context, not a booking-system problem raised for TideGrid.

## Current solution

The operator uses three systems:

1. **FareHarbor** for website bookings and as the availability placeholder that prevents overbooking.
2. **Square** for many phone and in-person payments because its reported processing cost is lower.
3. **Smartwaiver** for liability waivers.

They previously used Peek Pro and described the support and account-transfer experience as poor.

## Jobs to be done

1. **Keep one accurate view of capacity across booking channels.** The operator needs online, phone, and in-person reservations to reserve the same boat capacity without overbooking.
2. **Accept bookings without unnecessary transaction cost.** They route some sales through Square to avoid the higher fee they associate with FareHarbor.
3. **Keep booking, payment, refund, and waiver status consistent.** They want a change in one workflow to be reflected everywhere it matters.
4. **Reuse known customer information.** Returning customers should not have to re-enter information that can safely and lawfully be reused.
5. **Collect dive-specific readiness information.** A booking must account for waivers, tanks, gear, certification, liability, and other dive-specific details.
6. **Handle weather disruptions with less manual coordination.** The operator needs to contact affected customers, offer supported remedies, and record the result.
7. **Get help after initial setup.** The operator needs reliable assistance when changing a live configuration, not only during onboarding.

## What works today

- FareHarbor prevents online overbooking and provides 24/7 support availability.
- FareHarbor's lack of a monthly subscription is easier for the operator to accept than a recurring charge with unclear ongoing value.
- Square gives the operator a lower-cost path for phone and in-person payments.
- The current setup works well enough that the operator will not accept migration risk during peak season.

## Problems and observed behavior

### Fragmented booking and payment state

- The operator intentionally routes most phone and in-person payments through Square while using FareHarbor to hold the inventory.
- The systems were described as communicating in only one direction.
- A refund or other change made in Square does not update FareHarbor, leaving the operator to reconcile state manually.
- FareHarbor is therefore used partly as a placeholder rather than as the complete commercial record.

**Evidence strength:** High. This is a current workaround tied to fees and daily operations.

### Waivers depend on the payment path

- Smartwaiver is a separate subscription and workflow.
- The operator said the available FareHarbor waiver integration does not solve their problem when payment is processed outside FareHarbor.
- They want the waiver tied to the booking and participant regardless of how payment was taken.

**Evidence strength:** High. This is an existing gap caused by the current multi-system workflow.

### Returning-customer data is not reused well

- The operator asked for customer information to populate from a previous booking.
- They extended the idea to waiver information, where legally and operationally appropriate.

**Evidence strength:** Medium to high. The request was direct, but the interview did not quantify time saved, repeat-customer volume, or which fields can be reused.

### Dive workflows need vertical-specific data

- A normal reservation model does not fully represent tanks, gear, liability requirements, and other dive-booking specifics.
- The operator values a system that can express those details without custom support work for each change.

**Evidence strength:** Medium to high. The need was directly described, but individual fields and rules still require workflow observation.

### Support is most valuable after onboarding

- FareHarbor is reachable 24/7, which the operator values.
- Specific configuration changes can still be slow or difficult to resolve.
- The operator is reluctant to change a live configuration without confidence that it will behave correctly.
- Their prior Peek Pro account transfer took months to resolve and led to refunding at least one booking during the transition.

**Evidence strength:** High for the need, low for any particular support solution. AI support and outsourced coverage were proposed solutions, not validated requirements.

### Crew scheduling is not a strong wedge for this operator

- The operator said crew scheduling is useful in theory but hard to plan because staffing can change after the boat is booked.
- This suggests that lightweight assignment and late change handling may matter more than detailed advance scheduling for a small operator.

**Evidence strength:** Medium. This is useful negative evidence against treating crew scheduling as an early adoption driver for this segment.

## Solution reactions

| Concept | Reaction | Interpretation |
|---|---|---|
| Customer profile and booking-field prefill | Positive, described as making life easier | Worth testing with a workflow prototype and measurable time-to-book outcome |
| Waiver attached to the booking regardless of payment method | Strong agreement | Directly addresses a current workaround |
| Weather prompts followed by customer outreach, credit, or refund workflows | Strong positive reaction | Promising, but the concept was proposed by Jonah and needs unprompted validation |
| Email, SMS, and WhatsApp with preferences and opt-out | Generally positive | Channel demand and compliance details remain unvalidated |
| AI agent for configuration and support | Positive in principle | Validate trust, escalation, permissions, and willingness to pay before prioritizing |
| Detailed crew scheduling | Low importance for this operator | Do not treat as an early wedge for small dive-charter operators |

## Pricing evidence

- The operator reported paying roughly 6% when a booking is processed through FareHarbor versus roughly 2% to 3% through Square.
- They prefer no monthly fee to a recurring fee whose ongoing value is unclear, even though the higher percentage remains painful.
- They suggested flexible packaging, such as a higher percentage with no subscription or a subscription with a lower percentage.
- They suggested describing onboarding as a one-time charge and making optional services explicit add-ons.
- The transcript reported Smartwaiver prices of approximately $55 per month for 300 waivers and $155 per month for 1,000.
- The Peek Pro pricing discussion was uncertain and included an apparent live lookup or transcription error. Do not use it as verified pricing evidence.

**Buying signal:** Interest exists, but urgency is low during peak season. No willingness-to-pay threshold or switching commitment was established.

## Switching conditions

- **Current status:** Satisfied enough to continue with the current setup.
- **Near-term blocker:** Peak summer season makes migration too risky.
- **Evaluation window:** Later in the year, after operations settle.
- **Likely adoption requirements:** Low-risk data migration, uninterrupted booking continuity, reliable post-onboarding support, and clear economic value.
- **Design-partner signal:** Willing to review progress and provide further feedback.

## Implications for TideGrid

The call validates several existing requirements:

- A single record must connect customer, participant, booking, external or processed payment, refund, waiver, equipment, and departure state.
- Waiver and readiness workflows must not depend on TideGrid processing the payment.
- Customer and participant profiles should support safe reuse without collapsing the distinct roles defined in `FR-CUS`.
- Cash and external payment records in `FR-PAY-002` are important for mixed-channel operators.
- Dive capacity and equipment requirements in `FR-CAP` and `FR-EQP` match an expressed vertical need.
- Human-approved weather, disruption, credit, refund, and messaging workflows in `FR-DIS` match the operator's positive reaction.
- Consent evidence and idempotent opt-out handling in `FR-MSG` remain necessary.
- Controlled migration, previewable configuration changes, and strong post-onboarding support are adoption requirements, not only launch-readiness work.

The call also suggests caution:

- Do not require a Square integration based on this interview alone. First test whether TideGrid's external-payment record and reconciliation workflow solves enough of the problem.
- Do not elevate WhatsApp or an AI support agent into MVP scope from a prompted reaction.
- Do not lead this segment with crew scheduling. Lead with connected booking, payment, waiver, customer, equipment, and disruption state.
- Do not infer that the operator accepts TideGrid's current subscription-plus-platform-fee model. The interview exposes pricing tension but does not validate a package.

## Follow-up questions

1. What share of bookings arrives online, by phone, in person, through affiliates, or through other channels?
2. How many times per week does the operator duplicate a booking or reconcile a refund across systems?
3. What errors, missed waivers, customer complaints, or lost revenue have resulted from the current workflow?
4. Which returning-customer and participant fields should be reusable, and which must be reconfirmed or re-signed?
5. What exact tank, gear, certification, medical, and liability data is required for each dive product?
6. Who decides on a weather disruption, what evidence is reviewed, and how are customers segmented into delay, rebook, credit, or refund paths?
7. Which communication channels do customers actually use, and what consent is captured today?
8. What would make a post-season migration safe enough to attempt?
9. What data must be imported from FareHarbor, Square, Smartwaiver, and Peek Pro?
10. At the operator's actual booking volume, how would each TideGrid pricing option compare with the current total cost?

## Action items

- [ ] Jonah to continue interviews across dive, fishing, tour, and private-charter operators before setting feature priority.
- [ ] Jonah to keep the Oceans Eight Dive Company operator informed and use them as a design-partner sounding board.
- [ ] Quantify the operator's booking mix, duplicate work, exception rate, and current total software and transaction cost.
- [ ] Validate notification consent, opt-out, and unsubscribe requirements with counsel before production.
- [ ] Verify current vendor pricing and integration behavior from primary sources before using it in commercial positioning.
- [ ] Schedule a post-season follow-up focused on switching triggers, migration risk, and willingness to pay.
