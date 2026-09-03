# TideGrid V2 roadmap and validation

**Status:** Canonical delivery and evidence plan
**Date:** September 4, 2026

## Delivery rule

TideGrid remains an exploratory product until three pilot operators pay the native setup fee and sign the recurring agreement. The TideGrid owner may build prototypes and conduct research before that gate. TideGrid should not start the full production system, provider onboarding, or schema replacement before the gate passes.

The first production pilot includes the complete scope in [Pilot product scope](02-product-scope.md). Pilot operators receive staging access during development. TideGrid will not process their live bookings until every pilot acceptance area passes.

## Stage 0: Validation materials and bare-bones company

**Outcome:** TideGrid can approach prospects through a real company using one clearly labeled concept and one evidence plan.

- Adopt the V2 documents as the authority for new work.
- Preserve the V1 specification, ADRs, schema, OpenAPI contract, diagrams, and tests as historical design evidence.
- Approve the customer-facing [validation brief](../customer/tidegrid-validation-brief.md) and internal [operator validation guide](../customer/operator-validation-guide.md) before filing or outreach. Keep proposed features, pricing, and timing visibly nonbinding.
- Clear the working name through current Sunbiz, USPTO, and domain screens. Resolve the legal name, public addresses, registered agent, correspondence email, effective date, and other private filing inputs.
- File a bare-bones single-member, member-managed Florida LLC, obtain its EIN, execute the basic company records, separate banking and bookkeeping, establish company email, and record the local-registration decision. Follow the [pre-customer formation and validation plan](11-pre-customer-formation-and-validation.md).
- Prepare one pricing worksheet using each prospect's trailing booking value and channel mix.
- Record the required pilot agreement, data, service, payment, and app-store terms, but do not commission the full legal and insurance readiness package until the interview gate supports continuing.
- Define the standard CSV import and the boundaries of Managed Launch.
- Approve the goal map, model-routing policy, context packet, file-ownership rules, token telemetry, and review gates in [Build execution and agent plan](10-build-execution-and-agent-plan.md). Recheck model availability, pricing, and concurrency before each implementation goal.

**Exit:** The brief, interview guide, price calculator, standard import, and draft commercial requirements describe the same scope and fee base. The bare-bones company is active and its entity, EIN, company records, bank separation, company email, compliance calendar, and required local-registration decision are documented. Name and domain risks are recorded. Formation itself does not count as customer evidence, and no clickable product prototype is required before the first interviews.

## Stage 1: Interview, qualify, and complete paid-pilot readiness

**Outcome:** Customer evidence supports the readiness spend, and paid demand supports the production investment.

- Interview 12 operators across dive, fishing, sightseeing, and private-charter businesses.
- Record monthly booking value, active boats, direct and OTA mix, repeat-customer rate, waiver volume, equipment needs, software costs, support expectations, and switching window.
- Test the full recurring price. Show the pilot discount as a separate credit.
- Qualify pilot operators that receive at least 80% of bookings through direct channels.
- After the first three interviews, build a bounded, low-fidelity workflow prototype only when it would answer a specific usability or comprehension question that the brief cannot answer. Do not begin production architecture or use a polished prototype to substitute for demand evidence.
- After all 12 interviews are complete, require at least five operators to meet the direct-first profile and at least three provisionally Native-qualified prospects across two operator types to accept a commercial follow-up. Only then run bounded feasibility spikes for the custom-hostname flow, database transaction path, environment isolation, and second-brand native configuration described in [Build, hosting, and operations](08-build-hosting-and-operations.md) and [Native app factory and store submission](09-native-app-factory-and-store-submission.md). Record a bottom-up engineering and delivery estimate, contingency, funding source, and contract refund or long-stop treatment.
- Obtain three written, conditional commitments from qualified native pilot operators across at least two operator types that are ready to sign and fund the pilot.
- If at least five operators meet the direct-first profile and three qualified operators across at least two operator types give written conditional commitments, approve the funding source and complete the separate paid-pilot legal, insurance, accounting, security, continuity, provider, and contract readiness gate in [Company formation and costs](07-company-formation-and-costs.md). The already-formed bare-bones LLC does not satisfy this gate.
- Before a pilot operator's setup payment becomes non-refundable or counts toward the build gate, verify its legal entity, D-U-N-S record, public website, domain email, authorized representative, and Apple and Google organization accounts. If a store cannot verify the operator, the agreement must define the refund or exit instead of treating it as a qualified pilot customer.
- Obtain Stripe confirmation that pilot connected accounts use Stripe-set and Stripe-collected processing fees and Stripe negative-balance loss responsibility. Record the exact account configuration in the contract and acceptance evidence.
- Collect $2,250 from each of three native pilot operators and obtain signed 12-month recurring agreements with the company.
- Confirm that at least two pilot operators accept the platform fee on TideGrid-managed bookings paid outside Stripe.

**Exit:** At least five of the 12 interviewees fit the direct-first profile, three qualified operators across at least two operator types have provided written conditional commitments, the paid-pilot-readiness gate passes, three payments have settled, and all three contracts are signed.

## Stage 2: Booking foundation

**Outcome:** TideGrid can configure, sell, confirm, change, and reconcile a booking in a branded PWA.

- Implement tenant and brand configuration, custom domains, catalog, pricing, taxes, fees, policies, schedules, boats, shared-seat capacity, and private-charter exclusivity.
- Implement atomic checkout holds, full payment, private-charter deposit and balance, manual bookings, external-payment records, cancellations, whole-booking rescheduling, refunds, and service credit.
- Implement guest magic links, customer and participant profiles, participant invitations, operator calendar, departure roster, basic roles, notes, and reporting exports.
- Implement Stripe Connect direct charges, signed webhooks, payment projections, TideGrid fee-assessment records, proportional fee reversal, monthly invoicing, annual minimum true-up, and reconciliation exceptions.
- Implement standard imports with preview, duplicate detection, control totals, rehearsal, and rollback criteria.

**Exit:** Booking, payment, refund, migration, tenant-isolation, and final-capacity race tests pass in a production-shaped test environment.

## Stage 3: Complete pilot workflows

**Outcome:** Every selected pilot feature works through the same booking record.

- Add versioned TideGrid-hosted liability waivers, guardian signing, approved non-medical intake questions, consent evidence, and signed PDFs.
- Add branded email, dedicated Twilio senders, transactional SMS, consent records, delivery callbacks, STOP/START/HELP, email fallback, and booking-scoped replies.
- Add pooled rental inventory, participant allocation, holds, release, rescheduling, and manual blocks.
- Add NOAA/NWS evidence, operator watch/delay/cancel actions, frozen affected bookings, refund or credit remedies, and customer notifications.
- Add checkout and post-trip tips without crew allocation.
- Add named-customer fixed-unit packages with purchase, hold, redemption, release, restoration, and import reconciliation.
- Complete operational and financial dashboards and exports.

**Exit:** Cross-domain cancellation, disruption, refund, message, waiver, rental, package, and fee tests pass without manual database repair.

## Stage 4: Native apps and launch rehearsal

**Outcome:** Each pilot operator can launch one branded iOS and Android pair from the shared product.

- Implement one native guest shell with upcoming trips, booking management, saved profiles, waiver status, package balance, deep links, and push notifications.
- Generate app identity, assets, bundle identifiers, store metadata, screenshots, association files, signing configuration, and branded smoke tests from one validated operator manifest.
- Require each operator to own verified Apple and Google organization accounts and invite TideGrid with least privilege. Record customer-controlled verification lead time separately from TideGrid delivery time.
- Produce an immutable release packet for each platform containing the approved manifest, source and dependency hashes, signed binary, SBOM, privacy declarations, screenshots, listing content, reviewer access, test evidence, submission receipt, and review correspondence.
- Have the operator approve both release packets and perform the final Apple App Review submission. TideGrid may submit Google only after recorded operator approval.
- Rehearse each migration, provider setup, app release, customer communication, rollback, and support handoff.
- Record customer-specific time apart from shared product-development time.

**Exit:** Each pilot operator's iOS and Android binaries build without source edits, all three data rehearsals reconcile, all three operators approve their content and release packets, the operator-controlled Apple submissions are recorded, and the complete acceptance suite passes.

## Stage 5: Pilot launches and review

**Outcome:** Live evidence determines whether TideGrid can sell beyond three operators.

- Launch pilot operators one at a time. Only one operator may be in active configuration, acceptance, review-response, or production cutover at once.
- Before each pilot operator's live cutover, confirm its iOS and Android applications are approved for public distribution and verify the published store records, links, tenant identity, and production backend.
- After a launch, require 14 consecutive operating days with reconciled booking and payment totals, no unresolved critical defect, no overdue support response, and owner workload inside the approved budget before scheduling the next cutover. External store waiting may overlap when it creates no active response or release work.
- Review booking, payment, message, waiver, refund, package, and support exceptions each day during the launch window.
- Measure conversion, completed managed value, repeat use, app adoption, waiver completion, support hours, launch hours, and direct cost.
- Reprice setup before the fourth customer using measured delivery time.
- Stop broad selling until the commercial gates pass.

## Product acceptance matrix

| Area | Required proof |
|---|---|
| Capacity | Concurrent final-seat, whole-boat, equipment, and package-unit races cannot oversell or double-spend |
| Checkout | A late payment reacquires all required resources or creates one complete refund |
| Pricing | Ticket, charter, paid add-on, mandatory-fee, tax, promotion, and policy snapshots reproduce the accepted quote and allocate later changes correctly |
| Deposits | Deposit, balance, cancellation, refund, external payment, and platform-fee entries reconcile |
| Waivers | Every booking source assigns the required waiver; evidence binds the correct participant, guardian, immutable version, consent, hash, and booking |
| Messaging | Consent, sender identity, callback replay, opt-out, replies, failure, and email fallback pass |
| Weather | Provider data cannot change a trip without an authorized operator command |
| Remedies | Each affected booking receives one refund or credit, including after retries and partial provider failure |
| Tips | Tips reach the operator, remain outside the fee base, and refund once |
| Packages | Purchase is charged once, redemption carries no second fee, and cancellation restores eligible units once |
| Migration | Booking counts, package balances, and money control totals match before cutover |
| Tenancy | Domains, app identity, data, documents, messages, and provider context cannot cross tenants |
| Native | Both binaries build from configuration without customer-specific source changes and complete the promised booking, balance, waiver, profile, package, credit, deep-link, and push journeys |
| Export | Operators can reconcile bookings, payments, tax, refunds, tips, packages, and TideGrid fees |

## Commercial and operating gates

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
