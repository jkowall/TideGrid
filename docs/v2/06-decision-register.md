# TideGrid V2 decision register

**Status:** Canonical conflict-resolution record

Use this register when V2 conflicts with the V1 specification, schema, API, diagrams, tests, or ADR wording. The V1 files remain unchanged design evidence unless their indexes carry a historical-status notice.

## Decision log

Dated decisions that changed scope, wording, or process. Each entry records the reason and points to the canonical document.

### 2026-09-20

- **Demo-grade Core build authorized before the Validation gate.** The sole owner authorizes a real, demo-oriented implementation of the Core booking happy path in this repository before the Validation gate passes. Boundaries: synthetic tenants and data only; Stripe in test mode with test connected accounts; no Twilio and no SMS; no live payments, no customer data, no pilot agreement, no production account, and no claim that any [gate](05-roadmap-validation.md#gates) has passed. The build follows the [demo build plan](12-demo-build-plan.md), which is the canonical scope and sequence for this work, and the [build execution and agent plan](10-build-execution-and-agent-plan.md) for method. The delivery rule in the roadmap is unchanged for the full production system, provider onboarding with live credentials, and customer cutover. Reason: nothing in the paperwork gates code on staging; the code is a better artifact for the post-season operator conversations than the throwaway prototype; and the transaction, waiver, and migration paths teach more than further interviews about product risk. This decision does not weaken the interview thresholds and does not authorize skipping the readiness gate before a live booking.
- **Demo build provider choices.** Codebase in this repository as a pnpm monorepo at the root, with `prototypes/guest-flow` retained until the guest PWA replaces the public demo. PostgreSQL on a Neon nonproduction project reached through Hyperdrive; until the Cloudflare token or Wrangler login carries a Hyperdrive scope, the API connects to Neon directly over TLS and prefers the Hyperdrive binding as soon as it exists (recorded 2026-09-20 during G2.1). Transactional email through Cloudflare Email Service behind the provider-neutral email adapter. Operator console sign-in through Cloudflare Access on deployed environments, with a built-in magic-link session as the local and fallback path; both resolve to the same application session and tenant role mapping. These are demo choices and are revalidated at the paid-pilot readiness gate.

### 2026-09-19

- **Production gate split.** The single rule that every in-scope capability passes before the first production pilot is replaced by three named gates. The Core live gate passes before an operator takes its first real booking. Staged Core modules (transactional SMS and replies, pooled equipment, marine conditions and operator-directed disruptions, tips, trip cards) are each required for pilot completion, but an operator may go live with a module disabled and enable it after that module passes its own acceptance; a module enabled for one operator does not have to be enabled for another. The Native pilot gate covers the operator-owned iOS and Android apps, push, deep links, and native guest journeys; it gates the Native add-on for that operator and does not block the PWA or the Core live gate. The commercial gates are unchanged: three paid Native pilot operators across two operator types before the full build, and all three pilot operators pass all three gates before the Stage 5 pilot cohort review counts as complete. Reason: the evidence on file (one interview) supports booking, payment, and waiver pain; nothing yet supports native apps, SMS, trip cards, marine conditions, or equipment; a solo founder should not ship roughly thirty goals before any live signal. Canonical definition: [Gates](05-roadmap-validation.md#gates).
- **Terminology.** The customer-facing term is "trip card", with two kinds, "trip-count card" and "dollar card". Internal aggregates keep their names (`PackageAccount`, `CreditAccount`, the `TripCard` facade, package units, credit lots). Customer-facing and strategy prose no longer uses "trip package", "prepaid trip units", or "packages" as a product name; "package" remains where it names the internal unit ledger. Definitions live in the [index glossary](00-index.md#glossary).
- **Model and tool names.** Only the [build execution and agent plan](10-build-execution-and-agent-plan.md) names specific models, model routes, or agent tooling. Every other document, including this register, states the tool-agnostic principle (one hands-on lead, fresh independent review, explicit effort and budget per goal) and links to that plan.

### Proposed, not adopted: Core pilot gate (drafted 2026-09-19)

**Status:** Draft for sole-owner review. This entry has no authority until the owner moves it into the dated decision log above and updates the documents listed at the end. Until then, the [Validation gate](05-roadmap-validation.md#validation-gate) and the three-paid-Native rule remain the only path to a production build.

- **Problem.** The production build is gated on three paid Native pilot operators. The only evidence on file (one dive-operator interview) supports booking, payment, and waiver pain. Nothing supports native apps. If interviews 2 through 12 confirm Core demand and no Native demand, the current gate cannot pass, and the company has no authorized way to build the part of the product that customers want.
- **Proposed decision.** Add a second commercial gate, the Core pilot gate, that authorizes the Core build without Native commitments. The Native rule is unchanged for the Native add-on: TideGrid does not start the native app factory, store accounts, or the [Native pilot gate](05-roadmap-validation.md#native-pilot-gate) work for any operator until three paid Native operators exist, or until the owner records a separate decision to fund Native from Core revenue.
- **Core pilot gate.** Passes when all of the following hold:
  1. The interview thresholds in Validation gate steps 1 through 3 pass unchanged (12 interviews, five direct-first fits). The Native-qualified prospect count in step 3 is not required for this gate.
  2. The feasibility spikes in step 4 pass for the custom-hostname flow, the database transaction path, and environment isolation. The second-brand native configuration spike is not required.
  3. Three operators across at least two operator types sign a 12-month Booking Core agreement at the full recurring price ($149/month plus 1.5% of net managed booking value, $3,000 annual minimum) and pay $1,000 for Managed Launch. Managed Launch is not free under this gate; it is the settled, non-refundable commitment that replaces the $2,250 Native setup payment. Refund and long-stop treatment follow step 4.
  4. Each operator passes step 7 verification for its legal entity, public website, domain email, and authorized representative. D-U-N-S records and Apple and Google organization accounts are not required.
  5. Stripe confirms the connected-account responsibility configuration (step 8), and at least two of the three operators accept the platform fee on TideGrid-managed bookings paid outside Stripe (step 10).
  6. The paid-pilot readiness gate in [Company formation and costs](07-company-formation-and-costs.md) passes (step 6), with the native-store, app-store-responsibility, and Native-insurance items removed from that gate's scope for a Core-only pilot.
- **What it authorizes.** The [Core live gate](05-roadmap-validation.md#core-live-gate) scope and the [Staged Core modules](05-roadmap-validation.md#staged-core-modules) for the three Core pilot operators, under the existing one-operator-at-a-time [pilot launch cadence](#v2-product-and-commercial-decisions). It authorizes no native factory work, no operator store accounts, and no evidence claim about the $4,500 Native setup price or the 22-hour band.
- **Cash and evidence trade-off.** Three Core commitments total $3,000 in settled setup fees against $6,750 under the Native rule, and Core recurring revenue is $149/month per operator against $548/month with Native. The evidence is weaker in cash terms and stronger in fit terms, because it tests the part of the product the interview supports. The owner should decide whether to require a prepaid first quarter of the subscription ($447 per operator, credited against invoices) to raise the commitment without changing list price.
- **Subsidy limits.** The $25,000 absolute stop and the $500 Native direct-cost ceiling do not apply to a Core-only pilot. Per-operator limits are the Managed Launch four-hour target and eight-hour ceiling in the [commercial model](03-commercial-model.md#managed-launch). The owner should set a separate, smaller absolute stop for Core-only customer-specific work before accepting the first payment.
- **Pilot completion.** For a Core-only cohort, Stage 5 counts as complete when all three operators pass the Core live gate and every staged module's acceptance. The Native pilot gate is not required. If Native is sold later to any of these operators, that operator passes the Native pilot gate before its apps go live, and the Native price-evidence rules apply from that point.
- **Reason.** A gate that can only pass on the least-validated feature forces either building without a gate or refusing customers who want the validated product. Separating Core demand from Native demand keeps the gate honest without lowering the interview thresholds.
- **Documents to update if adopted.** The delivery rule, Validation gate steps 3, 5, 7, 9, and 10, the commercial and operating gates, and Stage 1 exit in [the roadmap](05-roadmap-validation.md#gates); the product direction order and business model in [the product strategy](01-product-strategy.md#product-direction); the pilot offer table and validation gates in [the commercial model](03-commercial-model.md#validation-gates); Step 6 of [the pre-customer plan](11-pre-customer-formation-and-validation.md#step-6-fund-and-complete-paid-pilot-readiness); the goal map in the build execution and agent plan so native goals are conditional; the status paragraph in the root README; and a customer-facing Core pilot offer in [the validation brief](../customer/tidegrid-validation-brief.md) and the customer deck, which today present only the Native pilot offer.

## V2 product and commercial decisions

| Topic | V2 decision |
|---|---|
| Product shape | Productized branded booking service with one guest experience per operator brand |
| Validation materials | Approve the customer-facing concept brief and internal interview guide before filing or outreach. Lead interviews with recent operator behavior, show the concept later, and label the product, features, price, and timing as proposed |
| Company timing | Form a bare-bones single-member, member-managed Florida LLC before the next customer-validation outreach. Entity formation does not authorize customer contracts, deposits, production accounts, live customer data, or a production build. Those remain gated by validated demand and paid-pilot readiness |
| Ownership and control | TideGrid has one human founder. Form a single-member, member-managed Florida LLC owned 100% by that founder. Pilot operators, customers, advisers, contractors, vendors, and automated agents receive no equity, membership interest, profit share, governance right, board seat, intellectual-property right, exclusivity, partnership, agency, or authority to act for TideGrid. Adding a member is a deliberate later decision with legal and tax review. This row is the canonical statement; the [company formation plan](07-company-formation-and-costs.md#company-and-ownership) carries the matching contract requirement |
| Operating model | The sole owner operates TideGrid through the pilot. Contractors, vendors, and automated agents may perform approved scoped services but are not founders, corporate officers, employees, independent approvers, or continuous operational coverage |
| Federal tax treatment | Start with the default single-member disregarded-entity treatment unless the CPA recommends and the sole owner approves an election. Do not assume an S-corporation election or tax savings before revenue, profit, payroll, and reasonable compensation are modeled |
| Sole-owner authority | Only the sole member has standing authority to sign customer contracts, borrow, change bank or Stripe payout details, grant production administration, issue ownership, or approve material spending. High-risk actions require written sole-member approval and audit evidence rather than a fictitious second-person approval |
| Sole-owner continuity | Company-owned accounts, tested recovery material, a non-equity emergency custodian, succession and incapacity documents, customer export and safe-shutdown procedures, and an independent recovery drill are required before live bookings |
| Company structure | Use that Florida LLC for the bootstrap pilot; reconsider a Delaware C corporation only when institutional financing, preferred equity, or a formal option plan becomes a near-term requirement |
| Boat model | Boats are inventory inside the operator experience; no per-boat codebase or binary |
| Customer surfaces | Custom-domain PWA for all operators; guest-facing iOS and Android pair as a paid add-on |
| Staff surface | Shared TideGrid operator web console |
| Pilot scope | Three named gates replace the single pre-pilot rule: the Core live gate before an operator's first real booking; Staged Core modules that an operator may enable after each passes its own acceptance, all required for pilot completion; and the Native pilot gate for the operator-owned apps, which does not block the PWA. Each pilot operator passes all three before Stage 5 counts as complete. Scope detail stays in [`02-product-scope.md`](02-product-scope.md); the gate definitions live in [Gates](05-roadmap-validation.md#gates) |
| Core price | $149/month plus 1.5% of net managed booking value; 12 months; $3,000 annual minimum |
| Core setup | $0 for self-setup; optional $1,000 Managed Launch |
| Managed Launch boundary | Target four or fewer TideGrid hours for catalog and policy configuration, standard CSV import, waiver setup, staff training, and cutover assistance. Eight hours is the pilot ceiling; before customer four, narrow or reprice the service if the pilot median exceeds four hours |
| Native price | $4,500 setup plus $399/month and 0.25%; 12 months |
| Pilot Native offer | The first three qualified pilot operators pay $2,250 native setup, receive Managed Launch at no charge, and pay full recurring and provider fees. Pilot status creates no ownership or control right; see the Ownership and control row |
| Pilot cohort evidence | Require three qualified conditional commitments and then three paid operators across at least two operator types so one narrow workflow does not validate the shared product by itself |
| Pilot-customer subsidy | Apply the per-operator delivery limits and $500 Native direct-cost ceiling first. Treat $25,000 across all three pilot operators as an absolute stop, not an authorized budget, and track shared product development separately |
| Native setup bands | Keep $4,500 only at 22 or fewer median customer-specific hours and below $500 direct cost; charge $7,500 for 23 to 40 hours; quote at least $10,000 or discontinue above 40 hours |
| Native price evidence | Treat the $4,500 and 22-hour band as provisional until one public-store launch is reproduced for a second operator without source edits |
| Native customer target | The pilot may test Native at $25,000 or more in average monthly managed booking value when repeat usage creates a specific learning case. Standard sales target operators near $50,000 or more until measured service cost proves the 75% recurring-margin gate at lower volume |
| Fleet entitlement | Two active boats included; $75/month per additional active boat |
| Custom quote boundary | Above $100,000 average monthly value, five or more active boats, multiple locations, or multiple brands |
| Custom work | Complex migration or trip-card reconciliation starts at $2,500; other unsupported work uses a fixed statement of work or $175 hourly rate |
| Pass-through costs | Stripe processing, store memberships, domains, Twilio registration, numbers, carrier fees, and message usage pass through at cost |
| Payment model | Stripe Connect direct charges; operator remains merchant of record; Stripe sets and collects processing fees; pilot accounts require Stripe, not TideGrid, as negative-balance loss collector or a written Managed Risk equivalent. The required configuration lives in [Payment economics](03-commercial-model.md#payment-economics) and [Payments and tips](04-architecture.md#payments-and-tips) |
| Fee base | Net managed booking value across approved payment rails; exclusions and timing live in `03-commercial-model.md` |
| Tips | Operator-settled, separately refundable, excluded from TideGrid's fee base, no crew allocation |
| Waivers | Automatically assign and send required waivers after booking; retain audited resend and reminders, participant and guardian signing, and immutable evidence |
| Waiver access and matching | Verify mailbox access and confirm the intended participant; a shared email does not establish identity or authorize an automatic customer merge. Support scoped participant QR, generic dock lookup without roster exposure, and staff-assisted signing without email; record the matching method |
| Messaging | Branded email plus a dedicated, metered transactional SMS sender with consent, replies, and opt-out handling |
| Equipment | Pooled bookable rental quantities; no serialized or custody lifecycle |
| Marine conditions | Timestamped wind, wave, swell and alert evidence for a human operator decision, with separate Windy map exploration; no safety recommendation or automatic trip change |
| Trip cards | Named-customer cards hold whole trip units or USD cents; explicit cancellation credit and restoration preserve tender and fee provenance. No points, memberships, anonymous gift cards, sharing or transfers |
| OTA | Direct-first pilot; import known reservations without live two-way synchronization |
| Customization | Configuration and shared product modules only; custom work requires a statement of work and cannot create a customer fork |
| Application stack | If the [Validation gate](05-roadmap-validation.md#validation-gate) passes, use a pnpm TypeScript monorepo with Hono Workers, React and Vite web clients, Expo React Native, shared generated contracts, and a configuration-driven app factory |
| Hosting | Use separate Cloudflare Workers for guest static assets, operator static assets, API, and async work; PostgreSQL on Neon remains business truth; private evidence lives in R2; queues carry only recoverable delivery work |
| Customer domains | Use Cloudflare for SaaS with a verified customer-owned booking subdomain during the pilot; an apex domain is outside the standard offer |
| Delivery ownership | Terraform owns provider resources and stable routing; Wrangler owns Worker code, assets, compatibility settings, and version bindings that reference Terraform outputs; GitHub Actions orchestrates both without allowing the tools to manage the same object |
| Environment boundary | Local, pull-request, staging, and production environments use separate databases, buckets, queues, credentials, and synthetic or sanitized data; production customer data never populates previews |
| Native factory | One Expo source application and validated per-operator manifests generate identifiers, assets, entitlements, listings, tests, and immutable release packets; generated native projects do not become customer branches |
| Store ownership | Each operator owns verified organization accounts, app records, and published identity; credentials remain operator-owned and TideGrid receives least-privilege delegated access |
| Store submission | TideGrid may generate, sign, test, upload, and prepare listings; the operator performs final Apple App Review submission under the current commercial-template rule; Google submission requires recorded operator approval |
| Native operating scale | At least 95% of variants build automatically; routine fleet-release handling remains below 15 minutes per operator; one failed account or review cannot block the fleet |
| Native review response | Standard setup includes one corrected resubmission or one evidence-based appeal per store; additional cycles require custom scope unless the sole owner approves them as pilot research within the pilot-customer subsidy limits |
| Build goal boundary | Use one bounded goal per accepted vertical slice; do not place Stages 2 through 5 in one long-running goal |
| Agent topology | Default to one hands-on lead that owns contracts, critical code, and integration, followed by a fresh independent reviewer; add one independent specialist when useful. Concurrency is a ceiling, not a staffing target. Parallel writes require accepted interfaces and disjoint paths; keep coupled state transitions with one owner. Roles and limits are in the [build execution and agent plan](10-build-execution-and-agent-plan.md#agent-topology) |
| Model routing | Route each slice by risk, not by tool. Difficult slices keep contract, critical implementation, and integration with one hands-on lead and receive a fresh independent review; routine work on accepted contracts may use a lower-cost route. Specific models, rates, and fallbacks are named only in the [build execution and agent plan](10-build-execution-and-agent-plan.md#routing-by-tidegrid-risk) and are rechecked before each goal |
| UI model routing | The hands-on lead that designs an original screen also implements it, inspects the rendered result, and refines it across web and native, including the shared design system. Extensions of accepted visual and interaction patterns may be delegated; a stable API alone does not make UI work routine. The first core screens receive a fresh independent review with browser or device inspection; see the [build execution and agent plan](10-build-execution-and-agent-plan.md#agent-topology) |
| External-action goals | Engineering goals end at internally proven artifacts; account changes, store submission, customer communication, deployment, and live cutover require separately authorized operational goals |
| Token control | Set an explicit effort level and token budget per goal, record checkpoints, and retain compact context packets and durable artifacts. Compare accepted-slice cost, elapsed time, owner review minutes, rework, and defects; distinguish raw tokens from attributable credits or billed cost. Calibrate routing within authorized work and do not assume tool savings; the measurement rules are in the [build execution and agent plan](10-build-execution-and-agent-plan.md#token-and-execution-controls) |
| Solo operating scale | Launch pilot operators sequentially. Before customer four, approve a monthly owner-hours budget and measure all support, release, reconciliation, finance, incident, and launch work. Pause growth, automate, or buy non-equity capacity when total workload exceeds that budget |
| Pilot launch cadence | Keep only one pilot operator in active initial configuration, acceptance, store-review response, production cutover, or Native go-live (see [Stage 5](05-roadmap-validation.md#stage-5-pilot-launches-and-review)). After each cutover or Native go-live, require 14 consecutive operating days with reconciled totals, no unresolved critical defect, no overdue support response, and owner workload inside budget before the next cutover |
| Pilot support | Use email or ticket support from 9:00 a.m. to 5:00 p.m. Eastern Time on US business days, with severity-based acknowledgement targets. Promise no guaranteed resolution time, continuous human coverage, SLA, or uptime credit without contracted backup and revised pricing |
| Commercial acceptance | Core support below one hour monthly, Native support below two hours monthly after 90 days, 75% recurring gross margin, at least 90% of requests through supported configuration, and zero source forks |

## V1 ADR disposition

The V1 records live in the [V1 ADR catalog](../v1/adr/README.md).

| ADR | V2 disposition | V2 interpretation |
|---|---|---|
| [0001 Modular monolith](../v1/adr/0001-modular-monolith.md) | Retained | One TypeScript domain application remains the default if TideGrid proceeds to implementation |
| [0002 Native captain client](../v1/adr/0002-mobile-client.md) | Superseded | V2 uses a custom-domain guest PWA and an optional shared native guest shell; the offline captain client is out of scope |
| [0003 PostgreSQL tenancy](../v1/adr/0003-postgresql-tenancy.md) | Retained | Shared-schema tenant-aware keys support one product serving many operator brands |
| [0004 Row-level security](../v1/adr/0004-row-level-security.md) | Retained | PostgreSQL RLS remains defense in depth for tenant isolation |
| [0005 Stripe Connect](../v1/adr/0005-stripe-connect.md) | Retained with commercial update | Direct charges and operator merchant-of-record status remain; V2 rates and the net managed booking fee base replace V1 rates |
| [0006 Stored-value ledgers](../v1/adr/0006-stored-value-ledgers.md) | Revised | Append-only trip-count and USD trip-card ledgers, including purchased dollar value and cancellation credit; defer anonymous/transferable gift cards and points |
| [0007 Booking/payment saga](../v1/adr/0007-booking-payment-saga.md) | Retained | Booking confirmation coordinates capacity, pooled equipment, package units, payment, and compensating refund behavior |
| [0008 Transactional outbox](../v1/adr/0008-transactional-outbox.md) | Retained | Publish booking, payment, message, waiver, and remedy effects after commit |
| [0009 Webhook inbox](../v1/adr/0009-webhook-inbox.md) | Retained | Deduplicate and order Stripe, Twilio, email, and other provider callbacks through a canonical inbox |
| [0010 Cloudflare Queues](../v1/adr/0010-queue-technology.md) | Provisionally retained | Use queues if implementation needs asynchronous delivery; PostgreSQL remains authoritative |
| [0011 No Redis in critical path](../v1/adr/0011-redis.md) | Retained | V2 adds no Redis dependency to booking correctness |
| [0012 Offline synchronization](../v1/adr/0012-offline-sync.md) | Deferred | V2 has no offline captain or departure-command workflow |
| [0013 Private document storage](../v1/adr/0013-document-storage.md) | Retained and narrowed | Apply immutable private storage to waiver versions, signatures, and rendered evidence; medical and incident files are out of scope |
| [0014 REST and OpenAPI](../v1/adr/0014-api-style.md) | Retained | V2 will extend the REST contract after paid validation rather than changing the V1 contract now |
| [0015 Reporting architecture](../v1/adr/0015-reporting.md) | Retained | Transactional projections and CSV exports precede a warehouse |
| [0016 Time zones](../v1/adr/0016-time-zones.md) | Retained | Store UTC instants with IANA zone and local schedule snapshots |
| [0017 Booking widget isolation](../v1/adr/0017-widget-isolation.md) | Modified | V2 leads with a branded PWA and custom domain; origin isolation, server validation, and Stripe-hosted payment controls remain |
| [0018 Audit log](../v1/adr/0018-audit-log.md) | Retained | Sensitive commercial, waiver, consent, configuration, and operator actions require append-only audit evidence |
| [0019 Sensitive encryption](../v1/adr/0019-sensitive-encryption.md) | Retained and narrowed | Encrypt designated contact, waiver, and guardian data; V2 does not collect medical or certification documents |
| [0020 Neon PostgreSQL](../v1/adr/0020-neon-postgresql.md) | Provisionally retained | Neon remains the V1 deployment default; revalidate price, region, recovery, and provider fit before production provisioning |

## V1 scope replaced by V2

The V2 package replaces these V1 directions:

- broad departure operations as the primary product;
- the Dock, Growth, Fleet, and Enterprise pricing schedule;
- a 0.75% to 3% fee limited to TideGrid-processed payments;
- bundled guided onboarding that is waived with annual purchase;
- native offline captain operations in the initial roadmap;
- manifests, boarding, vessel readiness, crew management, medical review, incident management, and serialized equipment in MVP;
- packages, gift cards, points, and several stored-value types at launch;
- Terminal, POS, live OTA synchronization, waitlists, and broad accounting integrations in the pilot.

V1 database tables, API paths, diagrams, tests, and traceability entries describe the historical design. They are not implementation instructions for V2.

## Contracts to define after paid validation

Before production implementation, create or revise contracts for:

- brand configuration, custom hostnames, native app identity, and app releases;
- product, scheduled trip, boat, capacity hold, booking, participant, and order lines;
- deposits, payment attempts, external payments, refunds, service credits, tips, and platform-fee assessments;
- waiver template, immutable version, requirement, signature, guardian relationship, and rendered evidence;
- consent, message, delivery, booking-scoped reply, and provider callback;
- pooled equipment, holds, participant allocations, and manual blocks;
- weather evidence, trip changes, affected-booking snapshots, and remedies;
- package accounts, unit holds, redemption, release, restoration, and import entries.

The V2 architecture document defines behavioral boundaries. The current schema and OpenAPI file remain V1 until this contract work passes review.

## Decision process

Record a dated V2 decision when new evidence changes product scope, price, fee treatment, or an architecture invariant. Update the affected V2 documents in the same change.

Create a new ADR before implementation changes a retained technical decision. Do not edit a V1 ADR to make history appear consistent with V2.
