# Interview record template

**Status:** Blank template. Internal research only.

> **Keep filled copies private.** Copy this file to access-controlled private storage outside this repository before you write in it. Never commit a filled copy. Use only the anonymous ID (for example `OP-01`) in anything that comes back to the repository. The [research-data handling rules](operator-validation-guide.md#research-data-handling) list what must stay out.

Use one copy per operator interview. The fields follow the structured note template in the [operator validation guide](operator-validation-guide.md#structured-note-template). If the two ever differ, the guide wins and this file gets corrected. This version adds two things the guide asks for in its rules:

1. Each section splits **evidence** (what was observed or reported) from **interpretation** (what the interviewer thinks it means). Only evidence feeds the gate.
2. The qualification section shows the arithmetic, so the gate fields can be checked from the numbers.

Grade every evidence line A, B, C, or D, using the guide's [evidence grading](operator-validation-guide.md#evidence-grading). Only A and B evidence can support a qualification result.

```text
INTERVIEW
Interview ID: OP-__
Date and time:
Interviewer:
Guide version and concept artifact version shown:
Recording permission: yes / no
Recording location and retention date: private record only / not recorded
Operator category: dive / fishing / sightseeing / private charter
Participant role:
Buying authority: yes / no / shared / unknown
Other decision-makers:

OPERATING CONTEXT
Evidence (grade, source):
  Active boats:
  Trip types:
  Operating months and seasonality:
  Staff touching a booking:
Interpretation:

LAST BOOKING
Evidence (grade, source):
  Date or recency:
  Origin channel:
  Steps and systems used:
  Capacity and equipment handling:
  Payment and reconciliation:
  Participants and waivers:
  Time, money, customer, or risk consequence:
Interpretation:

RECENT EXCEPTIONS
Evidence (grade, source for each):
  Last change, cancellation, or refund:
  Last waiver issue:
  Last weather or operator disruption:
  Last equipment, trip card, or returning-customer event:
  Most consequential event, in the participant's words:
  Workaround or attempted solution:
Interpretation:

TRAILING PERIOD AND ECONOMICS
Measurement period (start and end dates):
Source of the figures: report / invoice / memory / estimate / forecast
Evidence (grade, source for each):
  Total eligible managed booking value (V):
  Total booking count (T):
  Direct web booking count (W):
  Phone, walk-up, or staff-assisted count (S):
  OTA or externally controlled count, by channel (O):
  Check: W + S + O = T: yes / no
  Repeat-customer measure and source:
  Waiver, change, refund, disruption, and equipment volumes:
  Current tools and annual costs:
  Monthly staff time spent on workarounds:
Interpretation:

PROBLEM RANKING BEFORE CONCEPT (participant's words)
1.
2.
3.
Existing attempts and spending:
Consequence of no change:

CONCEPT WALKTHROUGH
Evidence (grade, source):
  Initial interpretation:
  Scenario attempted:
  Where expectation matched:
  Confusion or failure:
  Current work it could replace:
  Current work it would not replace:
  Native repeat-use evidence from past behavior:
Feature requests, recorded as requests only:
Interpretation:

COMMERCIAL TEST
Full standard price shown before the pilot credit: yes / no
Calculated price using the disclosed volume:
Participant's explanation of the fee base:
Comparison with current cost or problem:
Specific objection:
Decision process and switching window:
Externally paid booking fee accepted: yes / no / unresolved
Standard scope accepted: yes / no / unresolved
Requested variation, and whether standard configuration covers it:
Concrete next action, owner, and date:
Action completed: yes / no (count it only once it is done)
Commercial follow-up accepted: yes / no
Written conditional commitment received: yes / no
Evidence grade:

QUALIFICATION (use A or B evidence only; otherwise mark unknown or provisional)
Direct percentage = (W + S) / T = ____ / ____ = ____ %
  Passes when 80 % or more, by booking count, not value.
Average monthly value = V / 12 = ____ (include zero-revenue months)
  Active-month average, recorded separately, not used for the gate: ____
  Passes the Native threshold when 25,000 or more.

US passenger-vessel operator: pass / fail / unknown
One to five active boats: pass / fail / custom quote / unknown
Shared-seat or private-charter product: pass / fail / unknown
At least 80 % direct or staff-assisted booking count: pass / fail / provisional
Returning-customer base: pass / fail / unknown
Multi-tool reconciliation problem: pass / fail / unknown
Can supply required policy, business, and clean-data inputs: pass / fail / unknown
No dependence on excluded capability: pass / fail / unknown
Direct-first profile result: qualified / not qualified / provisional
  Qualified only when each of the eight lines above is pass, or custom quote
  for exactly five active boats (the guide allows five with a custom quote).
Blocked only by OTA dependency (diagnostic, not a profile check): yes / no

At least 25,000 average monthly managed value: pass / fail / forecast only
Specific evidenced Native repeat-use case: pass / fail
One legal operator, one brand, one location, one iOS and Android pair, no fork: pass / fail / unknown
Accepts full recurring price, external-booking fee, pass-through charges,
  12-month term, customer-owned store accounts, weekly design reviews,
  and acceptance testing: pass / fail / unresolved
Can supply branding, waiver language, legal pages, business records, clean data,
  provider accounts, and approvals on schedule: pass / fail / unknown
Authorized decision-maker prepared to sign and fund after paid-pilot readiness: pass / fail / unknown
Native pilot result: qualified / not qualified / provisional
  Qualified only when the direct-first result is qualified and all six lines above pass.
  Provisional when none fails but some are still unknown, unresolved, or forecast only.
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

After the interview, copy the qualification results and the counts into the [evidence register template](evidence-register-template.md), which tallies the gate across all 12 interviews.
