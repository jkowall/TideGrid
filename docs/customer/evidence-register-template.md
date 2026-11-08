# Evidence register template

**Status:** Blank template. Internal research only.

> **Keep filled copies private.** Copy this file to access-controlled private storage outside this repository before you write in it. Never commit a filled copy. Use only anonymous IDs (for example `OP-01`). The [research-data handling rules](operator-validation-guide.md#research-data-handling) list what must stay out.

This register is the structured record that the roadmap's [evidence register](../v2/05-roadmap-validation.md#evidence-register) requires for each prospect and pilot operator. It also tallies the [validation gate](../v2/05-roadmap-validation.md#validation-gate) counts across the 12 interviews. Each row comes from one filled [interview record](interview-record-template.md). The roadmap defines the gate. If this file ever differs from it, the roadmap wins and this file gets corrected.

Keep evidence and hypotheses apart. Section 1 and section 2 hold only observed or reported facts with an A or B grade. Section 4 holds hypotheses, which never count toward a gate.

## 1. Operators

One row per operator. Several people from one business count as one operator.

| ID | Category | Interview date | Period measured | Active boats | Direct % (W+S)/T | Direct % grade | Avg monthly value V/12 | Value grade | Direct-first result | Native result | Follow-up accepted | Written commitment | Blocked only by OTA |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| OP-01 | | | | | | | | | | | | | |
| OP-02 | | | | | | | | | | | | | |
| OP-03 | | | | | | | | | | | | | |
| OP-04 | | | | | | | | | | | | | |
| OP-05 | | | | | | | | | | | | | |
| OP-06 | | | | | | | | | | | | | |
| OP-07 | | | | | | | | | | | | | |
| OP-08 | | | | | | | | | | | | | |
| OP-09 | | | | | | | | | | | | | |
| OP-10 | | | | | | | | | | | | | |
| OP-11 | | | | | | | | | | | | | |
| OP-12 | | | | | | | | | | | | | |

Allowed values. Category: dive, fishing, sightseeing, or private charter. Results: qualified, not qualified, or provisional. Follow-up accepted, written commitment, and blocked only by OTA: yes or no. Follow-up accepted is yes once the participant has agreed to the commercial follow-up meeting; the meeting itself comes later. Written commitment is yes only once the dated written record that meets the guide's [written conditional commitment](operator-validation-guide.md#written-conditional-commitment) rules has been received.

## 2. Per-operator record

The roadmap asks for these fields for each prospect and pilot operator. Add one block per operator.

```text
ID: OP-__
Evidence source and date:
Observed workflow and current workaround:
Monthly value and channel mix (with period and source):
Price presented and objection:
Paid or unpaid outcome:
Requested variation, and whether standard configuration covers it:
Setup, support, provider, and release time (pilot operators only):
Product result and remaining risk:
```

## 3. Gate tally

Fill this in only after all 12 interviews are complete. The direct-first and conditional-demand counts take only qualified results. The feasibility-spike count is the one exception: it takes provisionally Native-qualified prospects, as step 3 of the validation gate says.

```text
Completed interviews with distinct operators (needs 12):            ____
Operator types covered:                                             ____

Direct-first gate
  Operators with direct-first result = qualified (needs 5 or more): ____
  Passes: yes / no

Feasibility-spike gate (needs the direct-first gate first)
  Native qualified or provisional AND follow-up accepted:           ____  (needs 3 or more)
  Operator types among them:                                        ____  (needs 2 or more)
  Passes: yes / no

Conditional-demand gate (fill only after the commercial follow-ups conclude)
  Qualified Native operators with a written commitment:             ____  (needs 3 or more)
  Operator types among them:                                        ____  (needs 2 or more)
  All from one operator type: yes / no  (yes means the gate fails)
  Passes: yes / no

OTA check
  Otherwise qualified operators blocked only by OTA dependency:     ____
  5 or more means: evaluate a one-way intake adapter first.

Change or stop check (any yes means change or stop)
  After interview 12:
    Fewer than 5 of 12 meet the direct-first profile: yes / no
  Only after the commercial follow-ups conclude:
    Fewer than 3 qualified written commitments: yes / no
    Qualified commitments all from one operator type: yes / no
```

Passing these counts does not authorize spending, contracts, deposits, or the production build. The later steps of the [validation gate](../v2/05-roadmap-validation.md#validation-gate) still apply.

## 4. Hypotheses and open questions

Write interpretations here, not in sections 1 to 3. A hypothesis never counts toward a gate.

| Date | Hypothesis or question | Raised by (interview IDs) | Evidence that would confirm or refute it | Status |
|---|---|---|---|---|
| | | | | |

## 5. Interview quality reviews

Run after interviews 3, 9, and 12, as the guide's [post-interview discipline](operator-validation-guide.md#post-interview-discipline) requires. Keep quality and favorable answers as separate measures.

| After interview | Missing past-event detail | Unavailable economic data | Interviewer talk time | Leading questions | Uncompleted follow-ups | Concrete commercial actions | Guide or concept change (versioned) |
|---|---|---|---|---|---|---|---|
| 3 | | | | | | | |
| 9 | | | | | | | |
| 12 | | | | | | | |
