# TideGrid Stage 0 commercial requirements (draft)

**Status:** Proposed, not adopted; no authority until the owner records approval in the register.
**Drafted:** 2026-11-08, goal W1-COMM-REQ, for the Stage 0 item "Record the required pilot agreement, data, service, payment, and app-store terms" in the [roadmap](../05-roadmap-validation.md#stage-0-validation-materials-and-bare-bones-company).
**Placement:** a draft, not a numbered V2 document. It is not part of the [authority order](../00-index.md#authority-and-historical-artifacts). Where it differs from the [decision register](../06-decision-register.md) or a numbered document, they win and this draft gets corrected.
**Not legal advice.** This is a list of requirements for a later agreement set. It contains no contract language and is not a contract, an offer, or a counsel engagement. It names no counsel. Counsel review waits for the [Validation gate](../05-roadmap-validation.md#validation-gate) to support the paid-pilot readiness spend.
**Data:** no customer data, personal filing details, or operator values appear here.

## How to read this draft

Each requirement has four parts:

- **Requirement.** What the pilot agreement set must cover. It restates a V2 decision unless it is labeled **(proposed)**.
- **Source.** The V2 document or register row it traces to. A requirement with no V2 source says so and is labeled proposed.
- **Open question for counsel.** What counsel must answer before the requirement becomes agreement terms. These are questions, not answers.
- **Gate.** Every requirement here belongs to [paid-pilot readiness](../07-company-formation-and-costs.md#paid-pilot-readiness-exit-gate), which is step 6 of the [Validation gate](../05-roadmap-validation.md#validation-gate). The readiness gate needs "counsel has approved the pilot agreement set and the operator-as-merchant-of-record presentation." No requirement here passes or claims any gate.

Some requirements are also checked again later, per operator, at the [Core live gate](../05-roadmap-validation.md#core-live-gate) or the [Native pilot gate](../05-roadmap-validation.md#native-pilot-gate). Those later checks are noted where a V2 source states them. They do not change the gate of the requirement itself.

## Evidence and hypotheses

- **Observed evidence.** One operator interview is on file ([discovery call](../../../research/interviews/oceans-eight-dive-company-discovery-call.md)). It records that a prior platform account transfer took months and led to at least one refunded booking. It records no view on contract, data, support, or payment terms. No operator has reviewed any term in this draft.
- **Hypotheses.** The prices, the fee base, the support targets, and the store model in the V2 documents are planning hypotheses. The [commercial model](../03-commercial-model.md) states its prices are unvalidated. This draft inherits that status.
- **Proposed.** The grouping, the requirement IDs, the open questions, and every item labeled **(proposed)**.

## Related Stage 0 drafts

The Stage 0 exit asks that "the brief, interview guide, price calculator, standard import, and draft commercial requirements describe the same scope and fee base." This draft links the two other Stage 0 drafts:

- the [pricing worksheet draft](../../customer/pricing-worksheet-draft.md), the price calculator. Payment terms PT-1 to PT-3 rest on the same prices and fee base it applies.
- the [standard CSV import draft](standard-csv-import.md), the standard import and the Managed Launch boundary. Requirements PA-9, DH-10, and ST-4 rest on the same boundary.

Neither draft is adopted. If either changes before approval, the matching requirement here follows it.

Observed on 2026-11-08, reading `main` at `1f748eb`: the worksheet, the CSV draft, and the [validation brief](../../customer/tidegrid-validation-brief.md) state the fee base of the [commercial model](../03-commercial-model.md#net-managed-booking-value) where they state it. In all three, imported OTA reservations stay out and TideGrid-managed direct bookings paid outside Stripe stay in. The worksheet and the brief also keep taxes, tips, complimentary value, and refunded value out. This draft adds no fee base rule.

## Pilot agreement

### PA-1. The agreement set

- **Requirement.** A master services agreement, an order form, a Pilot Native offer addendum, a Managed Launch statement of work, and a pass-through-cost schedule.
- **Source.** [Customer and guest terms](../07-company-formation-and-costs.md#customer-and-guest-terms).
- **Open question for counsel.** Does one master agreement with addenda carry both 12-month commitments, or do Booking Core and Native need separate agreements? The commercial model says "sign 12-month Booking Core and Native agreements."
- **Gate.** Paid-pilot readiness.

### PA-2. Term and commitment

- **Requirement.** A 12-month initial term for Booking Core and for Native. Native requires Booking Core. No monthly, seasonal, or usage pause in the initial term. A seasonal operator pays the fixed subscription in months with no trips.
- **Source.** [Pilot offer](../03-commercial-model.md#pilot-offer); the register rows Core price and Native price ([register](../06-decision-register.md#v2-product-and-commercial-decisions)).
- **Open question for counsel.** V2 sets no renewal mechanism. What renewal, notice, and price terms should follow month 12? The commercial model only asks whether two of three pilot operators "would renew at the full recurring price."
- **Gate.** Paid-pilot readiness.

### PA-3. Pilot Native offer conditions

- **Requirement.** The operator fits the pilot segment and standard scope. It signs both 12-month agreements, pays the $2,250 setup invoice before the Validation gate passes, and pays full recurring, extra-boat, pass-through, and custom-work charges. It uses one legal operator, one brand, one location, and one app pair. It supplies approvals, records, clean data, and provider accounts on schedule, joins weekly design reviews, completes acceptance testing on schedule, and accepts shared configuration with no source fork or exclusive feature. The offer ends after three paid, qualified operators. It cannot be stacked, transferred, converted to cash, extended to another brand, or used to fund custom work.
- **Source.** [Pilot Native offer controls](../03-commercial-model.md#pilot-native-offer-controls); the register row Pilot Native offer.
- **Open question for counsel.** What follows when the operator misses a schedule obligation: a delay, a change order, loss of the credit, or termination? V2 states the obligations but no consequence.
- **Gate.** Paid-pilot readiness.

### PA-4. Full price first, pilot credit separate

- **Requirement.** The order form shows the full price, then the pilot discount as a separate credit. Recurring prices are not discounted.
- **Source.** [Validation gate](../05-roadmap-validation.md#validation-gate) step 2; [Pilot Native offer controls](../03-commercial-model.md#pilot-native-offer-controls); Step 5 of the [pricing worksheet draft](../../customer/pricing-worksheet-draft.md#step-5-pilot-credit-shown-separately).
- **Open question for counsel.** Is any part of the credit repaid on early termination? V2 is silent.
- **Gate.** Paid-pilot readiness.

### PA-5. No ownership or control right

- **Requirement.** Pilot status gives the operator no equity, governance, board, profit-share, intellectual-property, exclusivity, partnership, or agency right.
- **Source.** The register row Ownership and control; [Company and ownership](../07-company-formation-and-costs.md#company-and-ownership); [Pilot offer](../03-commercial-model.md#pilot-offer).
- **Open question for counsel.** Weekly design reviews invite operator suggestions. Is a feedback clause needed so a suggestion creates no ownership or joint-development claim?
- **Gate.** Paid-pilot readiness.

### PA-6. Public reference consent

- **Requirement.** Public reference or case-study rights need the operator's separate consent.
- **Source.** [Pilot Native offer controls](../03-commercial-model.md#pilot-native-offer-controls).
- **Open question for counsel.** What form should that consent take, and can the operator withdraw it?
- **Gate.** Paid-pilot readiness.

### PA-7. Refund and long-stop treatment

- **Requirement.** The agreement defines refund or long-stop treatment for the setup payment. Pilot payments are collected before the full production build starts, so the agreement covers the case where the build does not go ahead.
- **Source.** [Validation gate](../05-roadmap-validation.md#validation-gate) steps 4 and 9; the readiness item "customer refund or long-stop treatment" in the [paid-pilot readiness exit gate](../07-company-formation-and-costs.md#paid-pilot-readiness-exit-gate); [Change or stop criteria](../05-roadmap-validation.md#change-or-stop-criteria).
- **Open question for counsel.** When does the setup payment become non-refundable? What long-stop date applies, and what is refunded if TideGrid stops under the change or stop criteria?
- **Gate.** Paid-pilot readiness.

### PA-8. Operator verification and store-verification exit

- **Requirement.** Before a setup payment becomes non-refundable or counts toward the build gate, TideGrid verifies the operator's legal entity, D-U-N-S record, public website, domain email, authorized representative, and Apple and Google organization accounts. If a store cannot verify the operator, the agreement defines the refund or exit.
- **Source.** [Validation gate](../05-roadmap-validation.md#validation-gate) step 7; [Native setup](../03-commercial-model.md#native-setup); [Operator account prerequisites](../09-native-app-factory-and-store-submission.md#operator-account-prerequisites).
- **Open question for counsel.** What verification evidence may the agreement require, and what may TideGrid keep? The native plan says to record status "without copying unnecessary identity documents."
- **Gate.** Paid-pilot readiness. Also checked per operator before the setup payment counts.

### PA-9. Scope, custom work, and change orders

- **Requirement.** Work outside published configuration needs a fixed-price statement of work or $175 an hour under a written scope and budget. Complex migration or trip-card reconciliation starts at $2,500. A custom quote applies to the operators the commercial model lists. A custom quote is not a commitment to accept the work. A source fork, a per-boat app, live OTA synchronization, and TideGrid control of merchant funds are declined in the pilot. The Managed Launch statement of work covers up to eight TideGrid hours for one operator, one brand, and one location. Work expected to exceed eight hours needs a written quote before it starts.
- **Source.** [Pass-through costs and custom work](../03-commercial-model.md#pass-through-costs-and-custom-work); [Managed Launch](../03-commercial-model.md#managed-launch); the register rows Managed Launch boundary, Custom work, Custom quote boundary, and Customization; [What counts as custom work](standard-csv-import.md#what-counts-as-custom-work) in the CSV draft.
- **Open question for counsel.** How is a change order accepted in writing, and what happens to work in progress when the operator declines one?
- **Gate.** Paid-pilot readiness.

### PA-10. Contract authority

- **Requirement.** Only the sole member signs customer contracts for TideGrid. No contractor, vendor, agent, or pilot operator has authority to act for TideGrid.
- **Source.** The register rows Sole-owner authority and Ownership and control.
- **Open question for counsel.** What signature and authority evidence does a single-member LLC give a counterparty?
- **Gate.** Paid-pilot readiness.

### PA-11. Termination and contract end

- **Requirement.** The agreement says what happens to the store listing, the domain, and the customer export at contract end. Store-account and listing ownership does not convey TideGrid's shared source or a perpetual right to the hosted service.
- **Source.** [Native launch](../02-product-scope.md#native-launch); [Offboarding and transfer](../09-native-app-factory-and-store-submission.md#offboarding-and-transfer); [Customer and guest terms](../07-company-formation-and-costs.md#customer-and-guest-terms).
- **Open question for counsel.** V2 sets no termination rights inside the 12-month term. Which events let either party end early, and what fees stay due?
- **Gate.** Paid-pilot readiness.

### PA-12. Continuity and safe shutdown

- **Requirement.** Procedures for customer notification, data export, billing suspension, refund handling, safe service shutdown, and native-app unpublishing or transfer if the sole owner is unavailable for an extended time.
- **Source.** [Sole-owner continuity](../07-company-formation-and-costs.md#sole-owner-continuity); the register row Sole-owner continuity.
- **Open question for counsel.** Should the agreement describe the emergency custodian's narrow role to operators, and what may the custodian do under it?
- **Gate.** Paid-pilot readiness. The continuity evidence is also a readiness item in its own right.

## Data handling

### DH-1. Privacy and data documents

- **Requirement.** A data processing agreement, a privacy policy, guest terms, a security schedule, a subprocessor list, retention rules, and incident duties.
- **Source.** [Customer and guest terms](../07-company-formation-and-costs.md#customer-and-guest-terms); the TideGrid legal paths in [Public website and domain topology](../07-company-formation-and-costs.md#public-website-and-domain-topology).
- **Open question for counsel.** Which privacy-law role does each party hold for guest data, and which state privacy laws apply to a US operator's guests?
- **Gate.** Paid-pilot readiness.

### DH-2. Data kept out

- **Requirement.** No raw card data: Stripe-hosted components keep card data outside TideGrid. No medical or certification documents. Intake questions are non-medical.
- **Source.** [Security and privacy](../04-architecture.md#security-and-privacy); [Native liability waivers and intake](../02-product-scope.md#native-liability-waivers-and-intake); [Migration and launch data](../02-product-scope.md#migration-and-launch-data); the register's ADR 0019 row.
- **Open question for counsel.** Do emergency contacts and non-medical intake answers need their own notice or consent?
- **Gate.** Paid-pilot readiness.

### DH-3. Handling by data class

- **Requirement.** Waiver evidence, customer identity, guardian relationships, contact details, device tokens, and messaging consent get field-appropriate authorization, encryption, retention, export, and deletion handling.
- **Source.** [Security and privacy](../04-architecture.md#security-and-privacy).
- **Open question for counsel.** V2 sets no retention period for any class. What period applies to each, and does the operator or TideGrid set it?
- **Gate.** Paid-pilot readiness.

### DH-4. Account deletion

- **Requirement.** Guests can request deletion in the PWA and native apps, with an in-app path and a web path. TideGrid deletes or de-identifies data not required for financial, fraud, waiver-evidence, or other legal retention, and explains any records it keeps.
- **Source.** [Guest, party, and account self-service](../02-product-scope.md#guest-party-and-account-self-service); [Privacy and declaration packet](../09-native-app-factory-and-store-submission.md#privacy-and-declaration-packet).
- **Open question for counsel.** Who decides a deletion request: the operator, TideGrid, or both? How long may retained waiver evidence and financial records be kept?
- **Gate.** Paid-pilot readiness. Also verified per operator at the Core live gate (data export and account-deletion request) and the Native pilot gate.

### DH-5. Operator privacy page

- **Requirement.** Each operator has a public privacy page on its verified domain. It identifies the operator or named app and explains TideGrid and other processors, data collected, purposes, sharing, retention, consent, and deletion. It is not a placeholder.
- **Source.** [Required public websites and deep links](../09-native-app-factory-and-store-submission.md#required-public-websites-and-deep-links); [Public website and domain topology](../07-company-formation-and-costs.md#public-website-and-domain-topology).
- **Open question for counsel.** TideGrid "may render these from managed templates," while legal-policy preparation is custom work under the [commercial model](../03-commercial-model.md#pass-through-costs-and-custom-work). Who authors and approves the operator's policy text, so that TideGrid gives no legal advice?
- **Gate.** Paid-pilot readiness.

### DH-6. Minors and guardians

- **Requirement.** The intended audience is an adult booker or guardian. A guardian signing for a linked minor does not make the app child-directed. Store copy, account creation, SDKs, and audience declarations stay consistent with that position.
- **Source.** [Privacy and declaration packet](../09-native-app-factory-and-store-submission.md#privacy-and-declaration-packet); [Native liability waivers and intake](../02-product-scope.md#native-liability-waivers-and-intake).
- **Open question for counsel.** What notice and consent apply to a minor participant's name and details that a guardian enters?
- **Gate.** Paid-pilot readiness.

### DH-7. Production data boundary

- **Requirement.** Production customer data never populates local, pull-request, or staging environments. Those use synthetic or sanitized data.
- **Source.** The register row Environment boundary.
- **Open question for counsel.** Should the security schedule state this boundary as a commitment to operators?
- **Gate.** Paid-pilot readiness.

### DH-8. Support access

- **Requirement.** TideGrid support access to operator data is time-bound, reason-bound, audited, and masked by default.
- **Source.** [Security and privacy](../04-architecture.md#security-and-privacy).
- **Open question for counsel.** Is a standing authorization in the agreement enough, or does each access need the operator's consent?
- **Gate.** Paid-pilot readiness.

### DH-9. Incident duties

- **Requirement.** The agreement sets incident duties. Incident contacts are verified per operator.
- **Source.** [Customer and guest terms](../07-company-formation-and-costs.md#customer-and-guest-terms); [Core live gate](../05-roadmap-validation.md#core-live-gate) item 9.
- **Open question for counsel.** V2 sets no notification timing. What timing and content do the applicable breach-notice laws require, and which party notifies guests?
- **Gate.** Paid-pilot readiness. Contacts are also verified per operator at the Core live gate.

### DH-10. Imported data

- **Requirement.** The operator supplies its own import data. Raw card data, medical data, certification documents, old message threads, and bulk legacy waiver evidence stay out. TideGrid does not claim an imported legacy waiver remains valid. Imported money is labeled as opening or external records, never as TideGrid-processed charges.
- **Source.** [Migration and launch data](../02-product-scope.md#migration-and-launch-data); the [standard CSV import draft](standard-csv-import.md).
- **Open question for counsel.** What should the operator confirm about its right to share imported customer data with TideGrid?
- **Gate.** Paid-pilot readiness.

### DH-11. Export at termination

- **Requirement.** At offboarding TideGrid exports the contractually required customer, booking, financial, waiver, trip-card, and configuration data. Retention and deletion actions are completed separately from removing a store listing. The operator confirms the final data state in writing.
- **Source.** [Offboarding and transfer](../09-native-app-factory-and-store-submission.md#offboarding-and-transfer); "termination data export" in [Customer and guest terms](../07-company-formation-and-costs.md#customer-and-guest-terms).
- **Open question for counsel.** What export format and window apply, and when does TideGrid delete its copy after export?
- **Gate.** Paid-pilot readiness.

### DH-12. Transactional messaging consent

- **Requirement.** Checkout shows the transactional SMS disclosure apart from policy and waiver acceptance. TideGrid records the phone number, disclosure version, channel, time, and source of consent. STOP, START, and HELP update consent. Marketing consent is never inferred and marketing messages are not sent. The operator is responsible for consent claims and lawful customer communications.
- **Source.** [Consent and delivery](../02-product-scope.md#consent-and-delivery); [Security and privacy](../04-architecture.md#security-and-privacy); the register row Messaging; [Customer and guest terms](../07-company-formation-and-costs.md#customer-and-guest-terms).
- **Open question for counsel.** Do the disclosure and the consent record meet the current federal and carrier rules for transactional text messages? SMS is a staged Core module, so this applies when the module is enabled.
- **Gate.** Paid-pilot readiness.

## Service terms

### ST-1. Support hours and targets

- **Requirement.** Email or ticket support from 9:00 a.m. to 5:00 p.m. Eastern Time on US business days. Severity targets measure acknowledgement and initial triage: critical 1 business hour, high 4 business hours, normal 2 business days. No guaranteed resolution time, continuous human coverage, service-level agreement, or uptime credit. Monitoring frequency and recovery objectives are internal, not customer-facing.
- **Source.** The register row Pilot support; [Solo-owner operating boundary](../08-build-hosting-and-operations.md#solo-owner-operating-boundary); the last item of [Commercial and operating gates](../05-roadmap-validation.md#commercial-and-operating-gates).
- **Open question for counsel.** How are the targets stated so they stay targets, and what remedy, if any, applies when one is missed?
- **Gate.** Paid-pilot readiness.

### ST-2. Scheduled maintenance and operator fallback

- **Requirement.** Support terms cover scheduled maintenance. Each pilot operator keeps and rehearses a manual fallback for closing sales, using the latest exported roster, recording manual changes and external payments, and contacting guests while TideGrid is unavailable.
- **Source.** The last item of [Commercial and operating gates](../05-roadmap-validation.md#commercial-and-operating-gates); [Solo-owner operating boundary](../08-build-hosting-and-operations.md#solo-owner-operating-boundary).
- **Open question for counsel.** Does making the fallback an operator duty allocate outage risk as intended?
- **Gate.** Paid-pilot readiness.

### ST-3. Operator responsibilities

- **Requirement.** The operator is responsible for approved waiver text, policies, prices, tax settings, business records, messaging consent, brand rights, customer remedies, and lawful customer communications. The operator supplies counsel-approved waiver text.
- **Source.** [Customer and guest terms](../07-company-formation-and-costs.md#customer-and-guest-terms); [Security and privacy](../04-architecture.md#security-and-privacy); [Native liability waivers and intake](../02-product-scope.md#native-liability-waivers-and-intake).
- **Open question for counsel.** What indemnity, if any, should cover operator-supplied content and settings?
- **Gate.** Paid-pilot readiness. The operator's approval of its configuration is also a Core live gate item.

### ST-4. TideGrid's waiver role

- **Requirement.** TideGrid renders the approved immutable waiver version and preserves the signing evidence. It does not represent that it drafted or certified the waiver, and it does not claim an imported legacy waiver is valid.
- **Source.** [Customer and guest terms](../07-company-formation-and-costs.md#customer-and-guest-terms); [Migration and launch data](../02-product-scope.md#migration-and-launch-data); the register rows Waivers and Waiver access and matching.
- **Open question for counsel.** Does the recorded evidence (consent, signer, time, IP address, device, version, and hash) support electronic signature under the applicable law, and who bears the risk if it does not?
- **Gate.** Paid-pilot readiness.

### ST-5. Weather information is advisory

- **Requirement.** Marine data is timestamped evidence for a human decision. TideGrid gives no safety recommendation and changes no trip on its own. The operator decides every weather-related trip action.
- **Source.** The register row Marine conditions; [Weather and trip changes](../04-architecture.md#weather-and-trip-changes).
- **Open question for counsel.** What disclaimer covers third-party weather data and a stale or missing feed?
- **Gate.** Paid-pilot readiness.

### ST-6. Liability allocation

- **Requirement.** The agreement allocates liability between TideGrid and the operator. The chosen insurance must not exclude the contractual indemnities.
- **Source.** "liability allocation" in [Customer and guest terms](../07-company-formation-and-costs.md#customer-and-guest-terms); [Insurance and finance controls](../07-company-formation-and-costs.md#insurance-and-finance-controls).
- **Open question for counsel.** V2 sets no cap or exclusions. What cap and exclusions fit the insurance limits once they are quoted?
- **Gate.** Paid-pilot readiness.

### ST-7. Shared product and staged modules

- **Requirement.** One shared product and configuration, with no customer source fork and no feature promise that breaks the shared model. An operator may go live at the Core live gate with staged Core modules disabled. Each module is enabled per operator only after it passes its own acceptance.
- **Source.** The register rows Customization and Pilot scope; [Staged Core modules](../05-roadmap-validation.md#staged-core-modules); [Before full production build](../03-commercial-model.md#before-full-production-build).
- **Open question for counsel.** Do recurring fees start at signature, at the Core live gate, or at Native go-live? V2 is silent, and modules and native apps may arrive after go-live.
- **Gate.** Paid-pilot readiness.

### ST-8. Launch sequencing and timing

- **Requirement.** Pilot operators launch one at a time. App-store approval and timing are controlled by the stores. Setup buys a defined launch service, not approval by a date. Customer-controlled account verification and store review do not count as TideGrid delivery time.
- **Source.** [Stage 5](../05-roadmap-validation.md#stage-5-pilot-launches-and-review); [Native setup](../03-commercial-model.md#native-setup); [Review and timing rules](../09-native-app-factory-and-store-submission.md#review-and-timing-rules).
- **Open question for counsel.** How should target dates and operator-caused delays be stated so neither reads as a delivery guarantee?
- **Gate.** Paid-pilot readiness.

### ST-9. Acceptance and cutover sign-off

- **Requirement.** The operator approves its catalog, price, tax, fee, policy, waiver, intake, brand, email, and support configuration. It signs the launch totals and cutover plan after the migration dry run and final import reconcile.
- **Source.** [Core live gate](../05-roadmap-validation.md#core-live-gate) items 5 and 7; [Migration and launch data](../02-product-scope.md#migration-and-launch-data).
- **Open question for counsel.** Should acceptance be deemed given after a set period with no response?
- **Gate.** Paid-pilot readiness. The sign-offs themselves happen per operator at the Core live gate.

### ST-10. Domains

- **Requirement.** The operator owns its booking subdomain and maintains the DNS record. An apex domain is outside the standard offer. A domain TideGrid buys for an operator passes through at cost, and its transfer at termination is defined.
- **Source.** The register row Customer domains; [Public website and domain topology](../07-company-formation-and-costs.md#public-website-and-domain-topology); [Provider responsibility matrix](../08-build-hosting-and-operations.md#provider-responsibility-matrix).
- **Open question for counsel.** What happens to a TideGrid-bought domain if the operator has unpaid fees at termination?
- **Gate.** Paid-pilot readiness.

## Payment terms

### PT-1. Prices and billing

- **Requirement.** Booking Core at $149 a month plus 1.5% of net managed booking value, with two active boats and $75 a month for each more. Native at $399 a month plus 0.25%. A $3,000 Core annual minimum per contract year, counting only the Core subscription and the 1.5% fee. Subscription billed monthly, variable fee in arrears, any minimum shortfall invoiced after month 12. Negative fee adjustments carry forward against later variable fees or the contract-end reconciliation.
- **Source.** [Pilot offer](../03-commercial-model.md#pilot-offer) and [Billing formulas](../03-commercial-model.md#billing-formulas); the register rows Core price, Native price, and Fleet entitlement; the [pricing worksheet draft](../../customer/pricing-worksheet-draft.md).
- **Open question for counsel.** V2 sets no payment due period, late fee, or suspension right for unpaid invoices. What should apply?
- **Gate.** Paid-pilot readiness.

### PT-2. Fee base definition and audit

- **Requirement.** A precise definition of net managed booking value, with its timing, inclusions, exclusions, reversals, and audit evidence. The fee applies whatever the payment rail.
- **Source.** [Net managed booking value](../03-commercial-model.md#net-managed-booking-value); "precise definition of net managed booking value, audit evidence, invoicing, annual minimum, reversals, refunds, taxes, and termination data export" in [Customer and guest terms](../07-company-formation-and-costs.md#customer-and-guest-terms); the register row Fee base.
- **Open question for counsel.** What records must the operator keep, and how long does it have to dispute a fee statement? The fee treatment of imported opening balances stays an open owner question in the [CSV draft](standard-csv-import.md#open-questions-for-the-owner) (question 8).
- **Gate.** Paid-pilot readiness.

### PT-3. Externally paid bookings

- **Requirement.** The operator records external payments and refunds against the TideGrid booking. The fee applies to TideGrid-managed bookings paid outside Stripe. At least two pilot operators must accept this.
- **Source.** [Net managed booking value](../03-commercial-model.md#net-managed-booking-value); [Validation gate](../05-roadmap-validation.md#validation-gate) step 10.
- **Open question for counsel.** What remedy applies when the operator does not record an external payment? The commercial model calls that revenue leakage and a product-control failure.
- **Gate.** Paid-pilot readiness.

### PT-4. Operator as merchant of record

- **Requirement.** The operator is merchant of record through Stripe Connect direct charges. The language covers disputes, chargebacks, reserves, statement descriptors, Stripe-set processing fees, and Stripe negative-balance loss responsibility. TideGrid does not receive, hold, or commingle operator booking funds, and earns no processing spread.
- **Source.** [Payment economics](../03-commercial-model.md#payment-economics); [Customer and guest terms](../07-company-formation-and-costs.md#customer-and-guest-terms); [Insurance and finance controls](../07-company-formation-and-costs.md#insurance-and-finance-controls); the register row Payment model.
- **Open question for counsel.** How must the guest-facing flow present the operator as seller? Counsel approval of this presentation is a named readiness item.
- **Gate.** Paid-pilot readiness.

### PT-5. Stripe responsibility configuration

- **Requirement.** Before TideGrid signs a pilot contract, Stripe confirms the connected-account configuration with Stripe as fees collector and losses collector, or a written Managed Risk equivalent. The contract language matches the test account before onboarding. If Stripe will not approve that structure, the price is invalid and the offer is repriced.
- **Source.** [Payment economics](../03-commercial-model.md#payment-economics); [Validation gate](../05-roadmap-validation.md#validation-gate) step 8.
- **Open question for counsel.** How does the agreement handle a change Stripe makes to that configuration during the term?
- **Gate.** Paid-pilot readiness.

### PT-6. Pass-through costs

- **Requirement.** Stripe processing, store memberships, domains, Twilio registration, numbers, carrier fees, message usage, operator-attributable taxes and provider charges, and requested dedicated services pass through at cost. They do not count toward any minimum. TideGrid shows the source charge and billing period and hides no margin. Provider price changes pass through prospectively.
- **Source.** [Pass-through costs and custom work](../03-commercial-model.md#pass-through-costs-and-custom-work); the register row Pass-through costs.
- **Open question for counsel.** How should the schedule separate costs the operator pays a provider directly, such as Apple and Google memberships, from costs TideGrid re-bills?
- **Gate.** Paid-pilot readiness.

### PT-7. Setup fee and Native delivery bands

- **Requirement.** The Pilot Native setup is $2,250, invoiced and paid before the Validation gate passes. Standard Native setup follows the delivery bands: $4,500 up to 22 hours, $7,500 for 23 to 40 hours, a quote of at least $10,000 above 40 hours. A customer expected to cross a band needs the higher price or a signed change order before work starts. The $4,500 band is provisional.
- **Source.** [Native setup](../03-commercial-model.md#native-setup); [Pilot Native offer controls](../03-commercial-model.md#pilot-native-offer-controls); the register rows Native setup bands and Native price evidence.
- **Open question for counsel.** How is the pilot credit applied if a pilot operator's delivery crosses the $4,500 band? The [register entry for the pricing worksheet](../06-decision-register.md#2026-11-08-w1-pricing-ws-stage-0-pricing-worksheet-draft-proposed-pending-owner-approval) leaves this open for the owner.
- **Gate.** Paid-pilot readiness.

### PT-8. Taxes on TideGrid's fees

- **Requirement.** Required Florida tax registrations and the W-9 are complete before invoicing. A multistate SaaS nexus review is complete before invoicing customers outside Florida. Taxes are excluded from the minimum.
- **Source.** [Establish operations](../07-company-formation-and-costs.md#establish-operations) step 4; [Paid-pilot readiness exit gate](../07-company-formation-and-costs.md#paid-pilot-readiness-exit-gate); [Billing formulas](../03-commercial-model.md#billing-formulas).
- **Open question for counsel.** Which party bears sales tax on TideGrid's fees where the operator is, and how does the invoice show it? This is shared with the CPA.
- **Gate.** Paid-pilot readiness.

### PT-9. Trip cards

- **Requirement.** Trip cards are named-customer balances sold by the operator. They cannot be transferred or shared, and are not anonymous or transferable gift cards. Refunds of card purchases follow the operator-approved policy.
- **Source.** The register row Trip cards; [Trip cards](../02-product-scope.md#trip-cards-trip-counts-and-dollar-balances).
- **Open question for counsel.** Do state gift-card, stored-value, expiration, or unclaimed-property rules reach these cards? If so, does the operator as seller bear them?
- **Gate.** Paid-pilot readiness. Trip cards are a staged Core module, so this applies when the module is enabled.

## App-store responsibilities

### AS-1. Operator-owned accounts

- **Requirement.** The operator owns its Apple and Google organization accounts, app records, and published identity. It pays Apple and Google directly and owns renewal. Account Holder passwords and multifactor tokens are never shared with TideGrid.
- **Source.** [Operator account prerequisites](../09-native-app-factory-and-store-submission.md#operator-account-prerequisites); the register row Store ownership.
- **Open question for counsel.** What follows if the operator lets a membership lapse during the term and releases stop?
- **Gate.** Paid-pilot readiness. Account standing is also a Native pilot gate check.

### AS-2. Account prerequisites

- **Requirement.** Native setup does not start until the operator has a legal entity able to contract with Apple, a matching D-U-N-S number, an authorized representative, a domain email, a public website, and verified Google identity and contact details. An individual or sole proprietor publishing under a personal name is an exception that needs written operator acceptance.
- **Source.** [Apple organization account](../09-native-app-factory-and-store-submission.md#apple-organization-account); [Operator account prerequisites](../09-native-app-factory-and-store-submission.md#operator-account-prerequisites).
- **Open question for counsel.** What should the written acceptance of a personal seller name contain?
- **Gate.** Paid-pilot readiness.

### AS-3. Delegated, least-privilege access

- **Requirement.** TideGrid gets the least access needed to sign, list, test, prepare, and release. No financial permissions. Access expires or is reviewed quarterly, and is revoked at offboarding.
- **Source.** [Identifier, signing, and credential custody](../09-native-app-factory-and-store-submission.md#identifier-signing-and-credential-custody); [Native launch](../02-product-scope.md#native-launch).
- **Open question for counsel.** Should the scope of delegated access be recorded in the agreement or in a separate access authorization?
- **Gate.** Paid-pilot readiness.

### AS-4. Submission authority

- **Requirement.** The operator approves both release packets. Its Account Holder or App Manager performs the final Apple App Review submission. TideGrid may submit to Google only after recorded operator approval. The operator approves every store-review response before it is sent.
- **Source.** [Store-policy boundary](../09-native-app-factory-and-store-submission.md#store-policy-boundary); [Solo release authority and launch capacity](../09-native-app-factory-and-store-submission.md#solo-release-authority-and-launch-capacity); [Review response and appeal](../09-native-app-factory-and-store-submission.md#review-response-and-appeal); the register row Store submission.
- **Open question for counsel.** How does the agreement record each approval so the operator stays the publisher and content provider?
- **Gate.** Paid-pilot readiness.

### AS-5. Review cycles and rejection

- **Requirement.** Standard setup includes one review-response cycle per store: one corrected resubmission or one evidence-based appeal. Further cycles need a written custom scope, unless the sole owner approves one as pilot research within the subsidy limits. No approval or approval date is guaranteed.
- **Source.** [Native setup](../03-commercial-model.md#native-setup); [Review response and appeal](../09-native-app-factory-and-store-submission.md#review-response-and-appeal); the register row Native review response.
- **Open question for counsel.** If a store rejects the app after the included cycle and TideGrid pauses Native sales, what happens to the setup fee and the Native recurring commitment?
- **Gate.** Paid-pilot readiness.

### AS-6. Brand assets and content rights

- **Requirement.** The operator authorizes its trademarks, logos, photographs, and other content, supplies legal publisher and copyright text, and signs off every public asset.
- **Source.** [Brand and rights packet](../09-native-app-factory-and-store-submission.md#brand-and-rights-packet).
- **Open question for counsel.** What license does the operator grant TideGrid to use its brand assets during the term and for the release record after it?
- **Gate.** Paid-pilot readiness.

### AS-7. Store declarations

- **Requirement.** The operator owns and approves the privacy, data-safety, audience, financial-features, export-compliance, and trader declarations. TideGrid prepares them. Review notes explain that guests pay for physical services outside in-app purchase.
- **Source.** [Privacy and declaration packet](../09-native-app-factory-and-store-submission.md#privacy-and-declaration-packet); [Physical-service payments](../09-native-app-factory-and-store-submission.md#physical-service-payments); [Provider responsibility matrix](../08-build-hosting-and-operations.md#provider-responsibility-matrix).
- **Open question for counsel.** Who bears the risk of an inaccurate declaration that TideGrid prepared and the operator approved?
- **Gate.** Paid-pilot readiness.

### AS-8. Offboarding and app transfer

- **Requirement.** The contract defines whether the operator unpublishes, keeps the last binary for a transition, or appoints a successor developer. App transfer is outside standard setup. Store history and credentials are archived or revoked as the offboarding steps list.
- **Source.** [Offboarding and transfer](../09-native-app-factory-and-store-submission.md#offboarding-and-transfer).
- **Open question for counsel.** How long is the transition period, and what support, if any, does TideGrid owe during it?
- **Gate.** Paid-pilot readiness.

## Items outside this draft

- **Insurance, formation, accounting, and continuity documents.** The [paid-pilot legal, insurance, and accounting package](../07-company-formation-and-costs.md#paid-pilot-legal-insurance-and-accounting-package) lists them. This draft covers only the five term areas Stage 0 names. Formation steps are a non-goal.
- **Prices.** This draft restates prices and changes none.
- **Contract language.** None is drafted here. Legal drafting is a non-goal.

## Open questions for the owner

1. Approve, change, or reject this requirement list, then record the decision in the register.
2. Whether Stage 0 should link this draft. No numbered document links it today.
3. Whether to promote it to a numbered V2 document after approval. That is a later goal.
