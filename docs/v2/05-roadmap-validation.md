# TideGrid V2 roadmap and validation

**Status:** Canonical delivery and evidence plan

## Delivery rule

TideGrid remains an exploratory product until three pilot operators across at least two operator types pay the native setup fee and sign the recurring agreement. The TideGrid owner may build prototypes and conduct research before that gate. TideGrid should not start the full production system, provider onboarding, or schema replacement before the gate passes.

Production readiness is not one gate. Each pilot operator passes three named gates, defined in [Gates](#gates): the Core live gate before its first real booking, each Staged Core module's own acceptance before that module is enabled for it, and the Native pilot gate before its branded apps go live. An operator may take its first live booking at the Core live gate with staged modules disabled and before its native apps are approved. Pilot operators receive staging access during development. Staging use, TestFlight use, internal Android distribution, or an operator-run shadow workflow does not pass any gate.

The pilot scope in [Pilot product scope](02-product-scope.md) is still required in full for pilot completion. The split changes the order in which the scope must be proven, not its size.

## Gates

This section is the single definitive statement of every gate. Other documents summarize it in one or two sentences and link here. The stage narrative later in this document says "see Gates" where a gate is authoritative.

### Validation gate

The validation gate is the customer-evidence and paid-demand sequence before the full production build. It replaces enthusiasm, prototype reactions, and unsigned agreements with paid commitments.

1. Interview 12 operators across dive, fishing, sightseeing, and private-charter businesses. Record monthly booking value, active boats, direct and OTA mix, repeat-customer rate, waiver volume, equipment needs, software costs, support expectations, and switching window.
2. Test the full recurring price and show the pilot discount as a separate credit. Qualify only operators that receive at least 80% of bookings through direct channels.
3. After all 12 interviews are complete, require at least five operators to meet the direct-first profile and at least three provisionally Native-qualified prospects across two operator types to accept a commercial follow-up.
4. Only then run bounded feasibility spikes for the custom-hostname flow, database transaction path, environment isolation, and second-brand native configuration described in [Build, hosting, and operations](08-build-hosting-and-operations.md) and [Native app factory and store submission](09-native-app-factory-and-store-submission.md). Record a bottom-up engineering and delivery estimate, contingency, funding source, and contract refund or long-stop treatment.
5. Obtain three written, conditional commitments from qualified native pilot operators across at least two operator types that are ready to sign and fund the pilot.
6. Approve the funding source and complete the separate paid-pilot legal, insurance, accounting, security, continuity, provider, and contract readiness gate in [Company formation and costs](07-company-formation-and-costs.md). The already-formed bare-bones LLC does not satisfy this gate.
7. Before a pilot operator's setup payment becomes non-refundable or counts toward the build gate, verify its legal entity, D-U-N-S record, public website, domain email, authorized representative, and Apple and Google organization accounts. If a store cannot verify the operator, the agreement must define the refund or exit instead of treating it as a qualified pilot customer.
8. Obtain Stripe confirmation of the connected-account responsibility configuration defined in [Payment economics](03-commercial-model.md#payment-economics) and record it in the contract and acceptance evidence.
9. Collect $2,250 from each of three native pilot operators and obtain signed 12-month recurring agreements with the company.
10. Confirm that at least two pilot operators accept the platform fee on TideGrid-managed bookings paid outside Stripe.

The validation gate passes when at least five of the 12 interviewees fit the direct-first profile, three qualified operators across at least two operator types have provided written conditional commitments, the paid-pilot-readiness gate passes, three payments have settled, and all three contracts are signed. Formation, interest, letters of intent, refundable placeholders, and negotiated recurring discounts do not pass it.

### Core live gate

The Core live gate passes per operator before that operator takes its first real booking or live payment. It covers:

- tenant isolation and security;
- catalog, boats, schedules, and availability;
- pricing, taxes, fees, quotes, promotion codes, and add-ons;
- booking and payment through Stripe Connect direct charges, including deposits and balances;
- policies, cancellation, rescheduling, refunds, and booking credits;
- guest self-service and accountless links;
- native waivers with email delivery, guardian signing, and evidence;
- transactional email;
- operator console, roster, roles, reports, and exports;
- standard migration;
- branded PWA and custom domain; and
- audit, backups, and runbooks.

The gate passes for the production environment when:

1. Every Core live workflow in [Pilot product scope](02-product-scope.md) passes end-to-end acceptance for shared-seat and private-charter bookings.
2. Concurrency tests prove no overbooking or negative credit balance under last-unit races and retries.
3. Stripe direct-charge, deposit, balance, refund, fee-reversal, webhook-retry, and reconciliation cases pass in the operator's connected-account test environment and a controlled production verification.
4. Two-tenant security tests prove isolation for guest links, accounts, console search, exports, messages, media, and support access.
5. The operator approves catalog, price, tax, fee, policy, waiver, intake, brand, email, and customer-support configuration.
6. Sender-domain authentication, transactional email delivery, delivery-failure visibility, and automatic waiver-request tests pass.
7. The migration dry run and final import reconcile, and the operator signs the launch totals and cutover plan.
8. The branded PWA passes production domain, payment, accessibility, responsive, link, receipt, and analytics checks.
9. Operator roles, financial exports, roster, exception queues, audit history, data export, account-deletion request, backups, support runbook, and incident contacts are verified.
10. No open defect can cause cross-tenant access, oversell, duplicate financial value, lost waiver evidence, missing consent, silent message failure, or an incorrect customer remedy.

Staged Core modules and native apps are not part of this gate. An operator goes live with every staged module disabled unless that module has already passed its own acceptance.

### Staged Core modules

The staged Core modules are:

- transactional SMS and replies;
- pooled equipment;
- marine conditions and operator-directed disruptions;
- tips; and
- trip cards.

Rules:

- Each module is required for pilot completion. The pilot cohort review is not complete until every module has passed its acceptance.
- An operator may go live at the Core live gate with a module disabled. TideGrid enables a module for that operator only after the module passes its own acceptance in the [product acceptance matrix](#product-acceptance-matrix) and in the module's section of the product scope.
- A module enabled for one operator does not have to be enabled for another. Enablement is per-operator configuration and is recorded with the actor, time, and acceptance evidence.
- A disabled module leaves no partial behavior. With SMS disabled, every transactional message uses branded email and checkout shows no SMS disclosure. With pooled equipment disabled, no product may require equipment. With marine conditions and disruptions disabled, the operator changes bookings one at a time through the Core cancellation, reschedule, refund, and credit workflow, and no marine data or Windy map appears. With tips disabled, checkout shows no tip line and no post-trip request is sent. With trip cards disabled, no card can be sold, imported, or redeemed.
- Enabling a module never changes a prior booking's snapshot, price, or policy.

### Native pilot gate

The Native pilot gate passes per operator when its operator-owned iOS and Android apps are approved for public distribution, push notifications and deep links work in production, and the native guest journeys (booking, balance, waiver, profile, credit, deep link, push, and trip card where that module is enabled for the operator) pass on physical devices. The operator-level checklist is the [acceptance gates](09-native-app-factory-and-store-submission.md#acceptance-gates) section of the native app factory plan.

The gate controls when the Native add-on goes live for that operator. It does not block the PWA or the Core live gate. An operator can be live on the PWA while its apps are in store review, and a native app cannot take a booking for an operator that has not passed the Core live gate. TestFlight, internal Play distribution, and a local build do not pass the gate.

### Commercial and operating gates

The commercial gates are unchanged by the split. Three paid Native pilot operators across two operator types are required before the full build. All three pilot operators must pass the Core live gate, every staged Core module's acceptance, and the Native pilot gate before the pilot cohort review in Stage 5 counts as complete.

TideGrid may sell beyond the pilot cohort when:

- Core support averages less than one hour per operator each month.
- Native support averages less than two hours per operator each month after the first 90 days.
- Recurring gross margin reaches 75% using loaded labor and direct provider costs.
- At least 90% of requests fit published configuration.
- One source tree and release train serve every customer.
- At least 95% of enabled native variants build and pass automatically on a shared release candidate.
- Routine customer-specific handling for a shared native release averages less than 15 minutes per operator, excluding documented store-review exceptions.
- Standard imports reconcile without custom repair scripts.
- Customer-specific launch work produces a positive contribution at the current setup price.
- Total owner support, release, reconciliation, finance, incident, and platform work fits the approved monthly TideGrid capacity budget with room for the next launch.
- Pilot support terms specify Eastern Time business hours, ticket or email channels, severity-based response targets, scheduled maintenance, and operator fallback procedures without promising continuous human coverage or uptime credits.

Keep the $4,500 native setup price when median delivery stays at or below 22 hours and direct cost stays below $500. Raise it to $7,500 for 23 to 40 hours. Quote at least $10,000 or discontinue native for that segment above 40 hours.

The $4,500 price and 22-hour ceiling remain provisional until TideGrid completes one end-to-end public-store submission and reproduces the same process for a second operator without source changes. A successful local build, TestFlight upload, or internal Play release does not prove the setup economics.

Treat $25,000 as the absolute stop for customer-specific subsidy across the three pilot operators, not an authorized spending budget. Enforce the per-operator hour and direct-cost limits first, and record approved subsidy as product research or acquisition cost rather than profitable setup revenue.

## Stage 0: Validation materials and bare-bones company

**Outcome:** TideGrid can approach prospects through a real company using one clearly labeled concept and one evidence plan.

- Adopt the V2 documents as the authority for new work.
- Preserve the V1 specification, ADRs, schema, OpenAPI contract, diagrams, and tests as historical design evidence.
- Approve the customer-facing [validation brief](../customer/tidegrid-validation-brief.md) and internal [operator validation guide](../customer/operator-validation-guide.md) before filing or outreach. Keep proposed features, pricing, and timing visibly nonbinding.
- Clear the working name through current Sunbiz, USPTO, and domain screens. Resolve the legal name, public addresses, registered agent, correspondence email, effective date, and other private filing inputs.
- File a bare-bones single-member, member-managed Florida LLC, obtain its EIN, execute the basic company records, separate banking and bookkeeping, establish company email, and record the local-registration decision. Follow the [pre-customer formation and validation plan](11-pre-customer-formation-and-validation.md).
- Prepare one pricing worksheet using each prospect's trailing booking value and channel mix.
- Record the required pilot agreement, data, service, payment, and app-store terms, but do not commission the full legal and insurance readiness package until the validation gate supports continuing.
- Define the standard CSV import and the boundaries of Managed Launch.
- Approve the goal map, model-routing policy, context packet, file-ownership rules, token telemetry, and review gates in [Build execution and agent plan](10-build-execution-and-agent-plan.md). Recheck model availability, pricing, and concurrency before each implementation goal.

**Exit:** The brief, interview guide, price calculator, standard import, and draft commercial requirements describe the same scope and fee base. The bare-bones company is active and its entity, EIN, company records, bank separation, company email, compliance calendar, and required local-registration decision are documented. Name and domain risks are recorded. Formation itself does not count as customer evidence, and no clickable product prototype is required before the first interviews.

## Stage 1: Interview, qualify, and complete paid-pilot readiness

**Outcome:** Customer evidence supports the readiness spend, and paid demand supports the production investment.

The sequence, thresholds, and exit for this stage are the [Validation gate](#validation-gate). Stage-specific working rules:

- Run the 12 interviews with the approved brief and guide, and record every result in the evidence register.
- After the first three interviews, build a bounded, low-fidelity workflow prototype only when it would answer a specific usability or comprehension question that the brief cannot answer. Do not begin production architecture or use a polished prototype to substitute for demand evidence.
- Run the qualification thresholds, feasibility spikes, readiness gate, operator verification, Stripe confirmation, payments, and contracts in the order the Validation gate defines. Do not reorder them to shorten the calendar.

**Exit:** The Validation gate passes (see Gates).

## Stage 2: Booking foundation

**Outcome:** TideGrid can configure, sell, confirm, change, and reconcile a booking in a branded PWA, and every Core live gate area is proven.

- Implement tenant and brand configuration, custom domains, catalog, pricing, taxes, fees, paid add-ons, promotion codes, policies, schedules, boats, shared-seat capacity, and private-charter exclusivity.
- Implement atomic checkout holds, full payment, private-charter deposit and balance, manual bookings, external-payment records, cancellations, whole-booking rescheduling, refunds, and booking credit.
- Implement guest magic links, customer and participant profiles, participant invitations, operator calendar, departure roster, basic roles, notes, and reporting exports.
- Implement Stripe Connect direct charges, signed webhooks, payment projections, TideGrid fee-assessment records, proportional fee reversal, monthly invoicing, annual minimum true-up, and reconciliation exceptions.
- Implement versioned TideGrid-hosted liability waivers, automatic requests after booking, resend and reminders, participant QR and staff-assisted no-email signing, verified-email participant matching, guardian signing, approved non-medical intake questions, consent evidence, and signed PDFs.
- Implement branded transactional email with sender-domain authentication, delivery status, and failure exceptions.
- Implement standard imports with preview, duplicate detection, control totals, rehearsal, and rollback criteria.
- Implement the branded PWA on a custom domain, plus audit history, backups, and the support and incident runbooks.

**Exit:** Every Core live gate area passes in a production-shaped test environment, including booking, payment, refund, credit, waiver, email, migration, tenant-isolation, and final-capacity race tests. This proves the shared Core live gate areas; each operator still passes the Core live gate in production before its own cutover (see Gates).

## Stage 3: Complete pilot workflows

**Outcome:** Each staged Core module works through the same booking record and passes its own acceptance. Operators may already be live at the Core live gate while these modules are built.

- Add dedicated Twilio senders, transactional SMS, consent records, delivery callbacks, STOP/START/HELP, email fallback, and booking-scoped replies.
- Add pooled rental inventory, participant allocation, holds, release, rescheduling, and manual blocks.
- Add NOAA/NWS marine evidence (wind, gusts, combined seas, swell and wind waves where available), separate Windy map exploration, operator watch/delay/cancel actions, frozen affected bookings, refund or credit remedies, and customer notifications. Verify provenance, units, missing components, and trip dates outside forecast coverage.
- Add checkout and post-trip tips without crew allocation.
- Add named-customer trip-count and dollar trip cards with purchase, hold, partial redemption, release, original-tender cancellation restoration, source-lot and fee provenance, and import reconciliation. Cancellation previews allow credit or refund for each eligible money-paid booking portion.
- Extend the operational and financial dashboards and exports with each module's lines.
- Enable each module per operator only after that module passes its acceptance (see Gates).

**Exit:** Each staged module's cross-domain tests pass without manual database repair: disruption, message, rental, tip, and trip-card tests, plus the cancellation, refund, waiver, and fee interactions each module adds.

## Stage 4: Native apps and launch rehearsal

**Outcome:** Each pilot operator can launch one branded iOS and Android pair from the shared product. An operator's first live cutover happens at its Core live gate and may precede native approval; this stage does not block its PWA launch.

- Implement one native guest shell with upcoming trips, booking management, saved profiles, waiver status, trip-card balance, deep links, and push notifications.
- Generate app identity, assets, bundle identifiers, store metadata, screenshots, association files, signing configuration, and branded smoke tests from one validated operator manifest.
- Require each operator to own verified Apple and Google organization accounts and invite TideGrid with least privilege. Record customer-controlled verification lead time separately from TideGrid delivery time.
- Produce an immutable release packet for each platform containing the approved manifest, source and dependency hashes, signed binary, SBOM, privacy declarations, screenshots, listing content, reviewer access, test evidence, submission receipt, and review correspondence.
- Have the operator approve both release packets and perform the final Apple App Review submission. TideGrid may submit Google only after recorded operator approval.
- Rehearse each migration, provider setup, app release, customer communication, rollback, and support handoff.
- Record customer-specific time apart from shared product-development time.

**Exit:** Each pilot operator's iOS and Android binaries build without source edits, all three data rehearsals reconcile, all three operators approve their content and release packets, the operator-controlled Apple submissions are recorded, and the pre-submission items of each operator's Native pilot gate checklist pass; store approval and production verification complete that gate in Stage 5 (see Gates).

## Stage 5: Pilot launches and review

**Outcome:** Live evidence determines whether TideGrid can sell beyond three operators.

- Launch pilot operators one at a time. Only one operator may be in active configuration, acceptance, review-response, production cutover, or Native go-live at once.
- An operator's live cutover happens when it passes the Core live gate. The cutover may precede native approval.
- The Native add-on for an operator goes live only after that operator passes the Native pilot gate: confirm its iOS and Android applications are approved for public distribution and verify the published store records, links, tenant identity, and production backend.
- Enable each staged Core module for an operator only after that module passes its acceptance (see Gates).
- After each cutover or Native go-live, require 14 consecutive operating days with reconciled booking and payment totals, no unresolved critical defect, no overdue support response, and owner workload inside the approved budget before scheduling the next cutover. External store waiting may overlap when it creates no active response or release work.
- Review booking, payment, message, waiver, refund, trip-card, and support exceptions each day during the launch window.
- Measure conversion, completed managed value, repeat use, app adoption, waiver completion, support hours, launch hours, and direct cost.
- Reprice setup before the fourth customer using measured delivery time.
- Stop broad selling until the commercial gates pass.

**Exit:** All three pilot operators have passed the Core live gate, every staged Core module's acceptance, and the Native pilot gate, and the pilot cohort review is recorded against the commercial and operating gates (see Gates).

## Product acceptance matrix

The Gate column names the gate each area belongs to, using the names defined in [Gates](#gates): the Core live gate, a Staged Core module, or the Native pilot gate. Where an area spans gates, the note says which part belongs where.

| Area | Gate | Required proof |
|---|---|---|
| Capacity | Core live gate (equipment and trip-card unit races with their Staged Core modules) | Concurrent final-seat, whole-boat, equipment, and package-unit races cannot oversell or double-spend |
| Checkout | Core live gate | A late payment reacquires all required resources or creates one complete refund |
| Pricing | Core live gate | Ticket, charter, paid add-on, mandatory-fee, tax, promotion, and policy snapshots reproduce the accepted quote and allocate later changes correctly |
| Deposits | Core live gate | Deposit, balance, cancellation, refund, external payment, and platform-fee entries reconcile |
| Waivers | Core live gate | Every booking source assigns the required waiver; evidence binds the correct participant, guardian, immutable version, consent, hash, and booking |
| Messaging | Core live gate for transactional email; Staged Core module (transactional SMS and replies) for consent, sender identity, callbacks, opt-out, replies, and email fallback | Consent, sender identity, callback replay, opt-out, replies, failure, and email fallback pass |
| Weather | Staged Core module (marine conditions and operator-directed disruptions) | Provider data cannot change a trip without an authorized operator command |
| Remedies | Core live gate for booking-level refund and credit; Staged Core module (marine conditions and operator-directed disruptions) for trip-level remedies | Each affected booking receives one refund or credit, including after retries and partial provider failure |
| Tips | Staged Core module (tips) | Tips reach the operator, remain outside the fee base, and refund once |
| Trip cards | Staged Core module (trip cards) | Purchase is charged once, redemption carries no second fee, and cancellation restores eligible units once |
| Migration | Core live gate (trip-card balances with the trip cards Staged Core module) | Booking counts, trip-card balances, and money control totals match before cutover |
| Tenancy | Core live gate | Domains, app identity, data, documents, messages, and provider context cannot cross tenants |
| Native | Native pilot gate | Both binaries build from configuration without customer-specific source changes and complete the promised booking, balance, waiver, profile, trip-card, credit, deep-link, and push journeys |
| Export | Core live gate (tips and trip cards with their Staged Core modules) | Operators can reconcile bookings, payments, tax, refunds, tips, trip cards, and TideGrid fees |

## Change or stop criteria

Change or stop the plan when any condition occurs:

- Fewer than three operators pay the pilot fee and sign the recurring agreement.
- Fewer than five of 12 prospects meet the direct-first profile.
- Two of the three pilot operators reject the fee on externally paid TideGrid bookings.
- Median native delivery exceeds 40 customer-specific hours.
- Native use does not improve repeat booking or reduce customer-service work.
- One Apple app receives an unresolved commercial-template or spam-policy rejection. Pause new Native sales while the issue is resolved. If two otherwise compliant pilot applications are rejected for the same model, pivot the offer to the PWA or test one aggregated TideGrid app.
- Core support exceeds one hour or native support exceeds two hours per operator per month after the stabilization window.
- Any customer source fork is introduced, more than 10% of requests fall outside supported configuration, or qualified customers require custom loyalty rules, serialized equipment, live OTA synchronization, or V1 departure operations for adoption.
- The sole owner's total monthly TideGrid workload exceeds the approved capacity budget, support backlog breaches the pilot response targets, or a new launch would overlap an unresolved incident or active customer cutover.

If OTA dependency blocks five otherwise qualified prospects, evaluate a one-way intake adapter before considering full channel management.

## Evidence register

For each prospect and pilot operator, keep a structured record of:

- evidence source and date;
- observed workflow and current workaround;
- monthly value and channel mix;
- price presented and objection;
- paid or unpaid outcome;
- requested variation and whether standard configuration covers it;
- setup, support, provider, and release time;
- product result and remaining risk.

Do not publish a pricing or product claim from prompted enthusiasm, a prototype reaction, or an unsigned agreement.
