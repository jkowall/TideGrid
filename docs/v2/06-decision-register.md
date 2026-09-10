# TideGrid V2 decision register

**Status:** Canonical conflict-resolution record
**Date:** September 10, 2026

Use this register when V2 conflicts with the V1 specification, schema, API, diagrams, tests, or ADR wording. The V1 files remain unchanged design evidence unless their indexes carry a historical-status notice.

## V2 product and commercial decisions

| Topic | V2 decision |
|---|---|
| Product shape | Productized branded booking service with one guest experience per operator brand |
| Validation materials | Approve the customer-facing concept brief and internal interview guide before filing or outreach. Lead interviews with recent operator behavior, show the concept later, and label the product, features, price, and timing as proposed |
| Company timing | Form a bare-bones single-member, member-managed Florida LLC before the next customer-validation outreach. Entity formation does not authorize customer contracts, deposits, production accounts, live customer data, or a production build. Those remain gated by validated demand and paid-pilot readiness |
| Ownership and control | TideGrid has one human founder. Form a single-member, member-managed Florida LLC owned 100% by that founder; issue no customer, adviser, contractor, or vendor equity, profit interest, governance right, or authority. Adding a member is a deliberate later decision with legal and tax review |
| Operating model | The sole owner operates TideGrid through the pilot. Contractors, vendors, and automated agents may perform approved scoped services but are not founders, corporate officers, employees, independent approvers, or continuous operational coverage |
| Federal tax treatment | Start with the default single-member disregarded-entity treatment unless the CPA recommends and the sole owner approves an election. Do not assume an S-corporation election or tax savings before revenue, profit, payroll, and reasonable compensation are modeled |
| Sole-owner authority | Only the sole member has standing authority to sign customer contracts, borrow, change bank or Stripe payout details, grant production administration, issue ownership, or approve material spending. High-risk actions require written sole-member approval and audit evidence rather than a fictitious second-person approval |
| Sole-owner continuity | Company-owned accounts, tested recovery material, a non-equity emergency custodian, succession and incapacity documents, customer export and safe-shutdown procedures, and an independent recovery drill are required before live bookings |
| Company structure | Use that Florida LLC for the bootstrap pilot; reconsider a Delaware C corporation only when institutional financing, preferred equity, or a formal option plan becomes a near-term requirement |
| Boat model | Boats are inventory inside the operator experience; no per-boat codebase or binary |
| Customer surfaces | Custom-domain PWA for all operators; guest-facing iOS and Android pair as a paid add-on |
| Staff surface | Shared TideGrid operator web console |
| Pilot scope | All capabilities in `02-product-scope.md` must pass before the first production pilot |
| Core price | $149/month plus 1.5% of net managed booking value; 12 months; $3,000 annual minimum |
| Core setup | $0 for self-setup; optional $1,000 Managed Launch |
| Managed Launch boundary | Target four or fewer TideGrid hours for catalog and policy configuration, standard CSV import, waiver setup, staff training, and cutover assistance. Eight hours is the pilot ceiling; before customer four, narrow or reprice the service if the pilot median exceeds four hours |
| Native price | $4,500 setup plus $399/month and 0.25%; 12 months |
| Pilot Native offer | The first three qualified pilot operators pay $2,250 native setup, receive Managed Launch at no charge, and pay full recurring and provider fees. Pilot status creates no equity, governance, profit-share, intellectual-property, exclusivity, partnership, or agency right |
| Pilot cohort evidence | Require three qualified conditional commitments and then three paid operators across at least two operator types so one narrow workflow does not validate the shared product by itself |
| Pilot-customer subsidy | Apply the per-operator delivery limits and $500 Native direct-cost ceiling first. Treat $25,000 across all three pilot operators as an absolute stop, not an authorized budget, and track shared product development separately |
| Native setup bands | Keep $4,500 only at 22 or fewer median customer-specific hours and below $500 direct cost; charge $7,500 for 23 to 40 hours; quote at least $10,000 or discontinue above 40 hours |
| Native price evidence | Treat the $4,500 and 22-hour band as provisional until one public-store launch is reproduced for a second operator without source edits |
| Native customer target | The pilot may test Native at $25,000 or more in average monthly managed booking value when repeat usage creates a specific learning case. Standard sales target operators near $50,000 or more until measured service cost proves the 75% recurring-margin gate at lower volume |
| Fleet entitlement | Two active boats included; $75/month per additional active boat |
| Custom quote boundary | Above $100,000 average monthly value, five or more active boats, multiple locations, or multiple brands |
| Custom work | Complex migration or package reconciliation starts at $2,500; other unsupported work uses a fixed statement of work or $175 hourly rate |
| Pass-through costs | Stripe processing, store memberships, domains, Twilio registration, numbers, carrier fees, and message usage pass through at cost |
| Payment model | Stripe Connect direct charges; operator remains merchant of record; Stripe sets and collects processing fees; pilot accounts require Stripe, not TideGrid, as negative-balance loss collector or a written Managed Risk equivalent |
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
| Application stack | If the paid-validation gate passes, use a pnpm TypeScript monorepo with Hono Workers, React and Vite web clients, Expo React Native, shared generated contracts, and a configuration-driven app factory |
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
| Agent topology | Default to one hands-on lead followed by a fresh reviewer; add one independent specialist when useful. Four concurrent slots are the current ceiling, not a target. Parallel writes require accepted interfaces and disjoint paths; keep coupled state transitions with one owner |
| Model routing | Proposed Astra revision: select GPT-6 Astra for difficult slices, owning contracts, critical implementation, and integration together; use fresh Astra review for high-risk work, Sol for complex stable work and routine review, Terra for accepted routine contracts, Luna for mechanical patterns, and Daybreak Blue only for authorized defensive security work. Recheck model access and rates; use Sol high as the Astra fallback |
| UI model routing | Astra owns original UI design, implementation, rendered inspection, and refinement across web and native, including the shared design system. Terra and Sol may extend accepted visual and interaction patterns; a stable API alone does not make UI work routine. Review first core screens with fresh Astra and inspect browser or device behavior |
| External-action goals | Engineering goals end at internally proven artifacts; account changes, store submission, customer communication, deployment, and live cutover require separately authorized operational goals |
| Token control | Set and measure a token budget per goal, use `get_goal` checkpoints, and retain compact context packets and durable artifacts. Compare accepted-slice cost, elapsed time, owner review minutes, rework, and defects; distinguish raw tokens from attributable credits or billed cost. Calibrate Astra routing within authorized work; do not assume model savings |
| Solo operating scale | Launch pilot operators sequentially. Before customer four, approve a monthly owner-hours budget and measure all support, release, reconciliation, finance, incident, and launch work. Pause growth, automate, or buy non-equity capacity when total workload exceeds that budget |
| Pilot launch cadence | Keep only one pilot operator in active initial configuration, acceptance, store-review response, or production cutover. Require 14 consecutive operating days with reconciled totals, no unresolved critical defect, no overdue support response, and owner workload inside budget before the next cutover |
| Pilot support | Use email or ticket support from 9:00 a.m. to 5:00 p.m. Eastern Time on US business days, with severity-based acknowledgement targets. Promise no guaranteed resolution time, continuous human coverage, SLA, or uptime credit without contracted backup and revised pricing |
| Commercial acceptance | Core support below one hour monthly, Native support below two hours monthly after 90 days, 75% recurring gross margin, at least 90% of requests through supported configuration, and zero source forks |

## V1 ADR disposition

| ADR | V2 disposition | V2 interpretation |
|---|---|---|
| 0001 Modular monolith | Retained | One TypeScript domain application remains the default if TideGrid proceeds to implementation |
| 0002 Native captain client | Superseded | V2 uses a custom-domain guest PWA and an optional shared native guest shell; the offline captain client is out of scope |
| 0003 PostgreSQL tenancy | Retained | Shared-schema tenant-aware keys support one product serving many operator brands |
| 0004 Row-level security | Retained | PostgreSQL RLS remains defense in depth for tenant isolation |
| 0005 Stripe Connect | Retained with commercial update | Direct charges and operator merchant-of-record status remain; V2 rates and the net managed booking fee base replace V1 rates |
| 0006 Stored-value ledgers | Revised | Append-only trip-count and USD trip-card ledgers, including purchased dollar value and cancellation credit; defer anonymous/transferable gift cards and points |
| 0007 Booking/payment saga | Retained | Booking confirmation coordinates capacity, pooled equipment, package units, payment, and compensating refund behavior |
| 0008 Transactional outbox | Retained | Publish booking, payment, message, waiver, and remedy effects after commit |
| 0009 Webhook inbox | Retained | Deduplicate and order Stripe, Twilio, email, and other provider callbacks through a canonical inbox |
| 0010 Cloudflare Queues | Provisionally retained | Use queues if implementation needs asynchronous delivery; PostgreSQL remains authoritative |
| 0011 No Redis in critical path | Retained | V2 adds no Redis dependency to booking correctness |
| 0012 Offline synchronization | Deferred | V2 has no offline captain or departure-command workflow |
| 0013 Private document storage | Retained and narrowed | Apply immutable private storage to waiver versions, signatures, and rendered evidence; medical and incident files are out of scope |
| 0014 REST and OpenAPI | Retained | V2 will extend the REST contract after paid validation rather than changing the V1 contract now |
| 0015 Reporting architecture | Retained | Transactional projections and CSV exports precede a warehouse |
| 0016 Time zones | Retained | Store UTC instants with IANA zone and local schedule snapshots |
| 0017 Booking widget isolation | Modified | V2 leads with a branded PWA and custom domain; origin isolation, server validation, and Stripe-hosted payment controls remain |
| 0018 Audit log | Retained | Sensitive commercial, waiver, consent, configuration, and operator actions require append-only audit evidence |
| 0019 Sensitive encryption | Retained and narrowed | Encrypt designated contact, waiver, and guardian data; V2 does not collect medical or certification documents |
| 0020 Neon PostgreSQL | Provisionally retained | Neon remains the V1 deployment default; revalidate price, region, recovery, and provider fit before production provisioning |

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
