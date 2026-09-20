# TideGrid V2 build execution and agent plan

**Status:** Proposed execution baseline. The Codex route below is retained as written. The [Claude Code execution route](#claude-code-execution-route) is the active route for the demo build authorized on 2026-09-20 in the [decision register](06-decision-register.md#2026-09-20); production goals still wait for the applicable roadmap gate

Model and tool names in this document are operational choices with a short shelf life. They carry no product authority; the decision register records only the tool-agnostic principles.

## Recommendation

Use Astra as the hands-on lead for difficult TideGrid slices, with a fresh reviewer and optional specialists. Have the lead own the contract, critical implementation, and integration together. Routine slices can stay on Terra or Sol. This replaces the previous default of a Sol coordinator handing implementation to Terra.

Use Astra for original UI design and implementation as well. Establishing the guest experience, operator console, design system, and native screens involves product and visual judgment even when the underlying API is simple. Keep design, code, browser or device inspection, and refinement with the same lead. Delegate repetition once the interaction and visual patterns have been accepted.

Keep one bounded goal per accepted vertical slice, with a clean integration point and recorded acceptance evidence between goals. A longer run is appropriate for one cohesive slice, such as booking concurrency or payment reconciliation. It is too broad for Stages 2 through 5 together.

This keeps product and architecture decisions reviewable, prevents a failed native or provider assumption from contaminating unrelated work, and makes token and delivery cost measurable. Continuity comes from the V2 documents, implementation contracts, ADRs, tests, and goal handoffs rather than one agent retaining a very long conversation.

The model names and capabilities below reflect the models exposed in the current Codex environment. Availability, model behavior, concurrency limits, and pricing must be rechecked when a build goal starts. This plan makes no token-savings claim. It defines measurements for choosing the least expensive route that still passes acceptance.

Current [OpenAI model guidance](https://learn.chatgpt.com/docs/models) recommends Astra for the hardest end-to-end work, Sol for complex work, Terra for everyday work, and Luna for clear, repeatable tasks. Our inference is that Astra should reduce contract-to-implementation handoffs on TideGrid's coupled transaction paths. That is a routing hypothesis, not a measured TideGrid quality, speed, or savings claim.

Astra changes who owns a slice, not the [Validation gate](05-roadmap-validation.md#validation-gate), product scope, independent review, or human production authority. Do not enlarge the roadmap or shorten a delivery estimate solely because a stronger model is available.

## Sole-owner authority

The operating baseline assumes one human founder and owner. That person retains business decisions, customer commitments, provider authorization, and production authority. Codex subagents are implementation tools; they are not founders, employees, production on-call coverage, or legal segregation of duties.

Before the first live use of each area (money, tenancy, recovery, security-sensitive production changes, and, when the Native add-on goes live, native signing), that area requires review by a qualified external human. The order in which areas go live follows [Gates](05-roadmap-validation.md#gates): native signing is Native pilot gate work and may not exist at an operator's first live booking. No production goal may overlap an active pilot launch or incident. Incident response and recovery take priority, and planned production work resumes only after the launch or incident closes with recorded evidence.

## Goal map

No production goal may cross the [Validation gate](05-roadmap-validation.md#validation-gate). Each row below is a separate goal. Combine adjacent rows only after the coordinator proves that the combined change still has one contract, one end-to-end outcome, and one independently reviewable diff.

The Gate column names the gate in [Gates](05-roadmap-validation.md#gates) that the goal feeds. The G2 series is Core live gate work and must be complete before an operator's first real booking. The G3 series is Staged Core module work; an operator may already be live while it is built, and each module is enabled per operator only after its own acceptance. The G4 series is Native pilot gate work and does not block the PWA or the Core live gate. The G0 series is pre-build evidence inside the Validation gate.

| Goal | Gate | Outcome | Principal proof |
|---|---|---|---|
| G0.1 Domain and infrastructure spikes | Validation gate (feasibility spike) | Validate transaction seams, tenant manifest, hosting topology, and database connection behavior | Recorded spike results and accepted decisions; no production provisioning |
| G0.2 Native factory dry run | Validation gate (feasibility spike) | Generate two branded development variants from one source without manual native edits | Reproducible manifests, builds, timing, and gap report |
| G0.3 Pilot harness | Validation gate (feasibility spike) | Build the standard import prototype, deterministic provider fixtures, and acceptance-test skeleton | Stage 0 technical evidence; no live customer data |
| G2.1 Workspace foundation | Core live gate | Establish the monorepo, pinned toolchain, contract generation, migration runner, environment configuration, and CI baseline | Clean bootstrap plus repeatable build, migration, and test commands |
| G2.2 Tenant access and audit | Core live gate | Implement tenant identity, request context, roles, row-level security, and immutable audit records | Two-tenant escape tests and role-denial tests |
| G2.3 Idempotent delivery foundation | Core live gate | Implement command idempotency, webhook inbox, transactional outbox, queue publication, retry, and DLQ evidence | Duplicate, out-of-order, crash, replay, and recovery tests |
| G2.4 Catalog and schedule | Core live gate | Implement products, boats, departures, recurring schedules, blackouts, cutoffs, buffers, and sales states | Schedule-boundary and availability tests |
| G2.5 Pricing, add-ons, fees, and policies | Core live gate | Implement ticket and charter prices, paid add-ons, taxes, mandatory fees, promotion codes, deposits, and versioned policies | Quote snapshot, add-on eligibility, tax, discount, and policy-version tests |
| G2.6 Capacity and holds | Core live gate | Implement seat and exclusive-boat capacity, atomic holds, expiry, and confirmation transitions | Concurrent final-seat and whole-boat tests |
| G2.7 Charge to confirmation | Core live gate | Implement immutable quote and order, Stripe direct charge, verified callbacks, booking confirmation, safe hold release, and late-success compensation | Success, failure, expiry, replay, and late-callback tests |
| G2.8 Deposits and balances | Core live gate | Add one private-charter deposit, one balance deadline, reminders, staff collection, and overdue state | Deposit, reminder, collection, and deadline tests |
| G2.9 Refunds, credits, and fee reversal | Core live gate | Implement policy-driven refund, noncash service credit, manager override, and proportional TideGrid fee reversal | Partial and full refund, retry, credit, and ledger tests |
| G2.10 External payment and reconciliation | Core live gate | Add externally paid records, monthly fee assessment, dispute visibility, provider reconciliation, and control totals | Missing, duplicate, changed, and mismatched settlement tests |
| G2.11 Guest booking management | Core live gate | Implement secure accountless access, receipts, participant invitations, profile changes, cancellation, and whole-booking rescheduling | End-to-end browser journeys and authorization tests |
| G2.12 Operator console and roster | Core live gate | Implement calendar, search, booking detail, manual booking, roles, roster, notes, and basic reports | Staff journeys, role tests, printable roster, and CSV control totals |
| G2.13 Standard migration | Core live gate | Implement mapping preview, deduplication, rehearsal, signed controls, final delta, and rollback criteria | Repeatable import and financial-count reconciliation |
| G2.14 Branded PWA and hostname | Core live gate | Deliver brand configuration, tenant-safe custom-hostname resolution, deep links, support pages, and PWA installability | Two-brand browser, hostname, and tenant-boundary tests |
| G2.15 Waiver evidence | Core live gate | Implement immutable templates, source-independent automatic assignment, email verification and participant matching, scoped QR and staff-assisted no-email entry, participant and guardian signing, hashes, signed PDFs, status, and reuse rules | Booking-source matrix, shared-email ambiguity, cross-participant and tenant denial, token replay/revocation, shared-device cleanup, guardian, version, and evidence tests |
| G2.16 Transactional email and waiver delivery | Core live gate | Implement branded email templates, sender-domain authentication, automatic initial waiver delivery after booking, audited resend, delivery state, reminders, and delivery-failure exceptions | Confirmation/retry deduplication, corrected recipient, completion/cancellation races, migration suppression, delivery-failure, and silent-failure tests |
| G3.1 Transactional SMS, replies, and opt-out | Staged Core module (transactional SMS and replies) | Implement dedicated Twilio senders, SMS templates, consent evidence, delivery callbacks, email fallback, dedicated-number routing, booking-scoped replies, ambiguous inbox, STOP, START, and HELP | Consent, callback replay, failure, fallback, routing, authorization, opt-out, restart, and replay tests |
| G3.2 Pooled equipment | Staged Core module (pooled equipment) | Implement inventory pools, participant allocation, buffers, blocks, holds, and release | Concurrent last-unit and overlapping-window tests |
| G3.3 Marine conditions, disruption and remedies | Staged Core module (marine conditions and operator-directed disruptions) | Implement wind/sea/swell evidence, provenance and freshness, separate Windy exploration, authorized actions, frozen impact sets, one remedy, and notifications | Missing components, units, observation/forecast separation, map failure and forecast horizon, stale-data, authorization, retry, and one-remedy tests |
| G3.4 Tips | Staged Core module (tips) | Implement checkout and post-trip tips, exclusions, requests, refunds, and reporting | Timing, duplicate, fee-exclusion, and refund tests |
| G3.5 Trip cards | Staged Core module (trip cards) | Implement trip-count and USD cards, sale, source lots, append-only balances, holds, partial redemption, original-tender restoration, expiration, and adjustment | Last-unit/cent races, customer and tenant isolation, mixed tender, cancellation credit/refund replay, restoration, and fee-provenance tests |
| G3.6 Cross-domain reporting | Each Staged Core module for its own lines (the Core live gate exports ship in G2.12) | Extend the revenue, occupancy, tax, refund, fee, and reconciliation exports with tip, equipment, trip-card, and disruption lines | Ledger-to-report and export control totals |
| G4.1 Native shell and manifest | Native pilot gate | Implement the shared Expo shell, validated manifest, identity, assets, navigation, authentication, and branded tests | Two variants build and authenticate without source edits |
| G4.2 Native guest journeys | Native pilot gate | Implement upcoming trips, booking management, balance payment, saved profiles, waiver completion and status, and package and credit balances | Device-level parity tests against the accepted PWA and API contracts |
| G4.3 Native deep links, push, and privacy | Native pilot gate | Add tenant-safe links, push routing, account deletion, privacy manifests, and supported-version behavior | Device-level link, notification, deletion, and upgrade tests |
| G4.4 iOS release factory | Native pilot gate | Generate iOS signing inputs, metadata, screenshots, privacy answers, signed artifacts, TestFlight upload, and release packet | One internally rehearsed, submission-ready iOS packet with immutable evidence |
| G4.5 Android release factory | Native pilot gate | Generate Android signing inputs, metadata, screenshots, Data safety answers, signed artifacts, internal-track upload, and release packet | One internally rehearsed, submission-ready Android packet with immutable evidence |
| G4.6 Second-brand reproduction | Native pilot gate | Reproduce both factories for another operator and isolate a failed tenant from the release train | Timing, touch-time, automated-pass, and failure-isolation evidence |
| G4.7.`operator` Pilot operator readiness | Core live gate for the migration rehearsal, acceptance evidence, rollback plan, and support handoff; Native pilot gate for the configured applications | Generate one pilot operator's migration rehearsal, configured applications, acceptance evidence, rollback plan, and support handoff | Complete internally approved packet for one pilot operator; no claim of operator or store approval |
| G4.8 Engineering cohort gate | Commercial gate input (Stage 5 pilot cohort review) | Compare the three completed pilot-operator packets, shared acceptance suite, delivery time, and unresolved cross-customer risks | Recorded go, change, or stop recommendation; no customer-specific implementation |

G2.1 establishes the integration harness before parallel feature work begins. G2.7 proves only charge-to-confirmation; deposits, post-confirmation refunds, and monthly reconciliation remain separate. G2.15 and G2.16 are Core live gate work because native waivers and transactional email are required before the first real booking; SMS templates, consent, callbacks, and replies belong to G3.1 and stay disabled for an operator until that module passes. G4.4 and G4.5 stop at an internally rehearsed submission-ready state.

Human-controlled work uses separately authorized operational goals after the applicable engineering evidence exists:

| Operational goal | Authorized outcome | Completion boundary |
|---|---|---|
| O4.`operator`.1 Account and content readiness | Assist one operator with verified accounts, public pages, content approval, and delegated access | Required operator-controlled evidence is recorded; waiting does not become engineering completion |
| O4.`operator`.2 Store submission | Prepare the final packets, support the operator's Apple submission, and submit Google only with recorded approval | Both authorized submission receipts are recorded; approval remains a store-controlled outcome |
| O4.`operator`.3 Store review response | Monitor one review cycle and prepare the included correction or appeal with operator approval | The review decision and any authorized response are recorded; an unresolved external wait follows the goal blocked-status rule |
| O5.`operator` Launch and stabilization | Perform an approved cutover, verify live surfaces, monitor reconciliation, and record support and cost | Live acceptance passes; an unresolved external dependency follows the goal blocked-status rule and retains recovery evidence |
| O6.`operator` Native go-live | After both stores approve, verify the published store records, links, tenant identity, push, deep links, and production backend, then release the Native add-on for that operator | The Native pilot gate passes and the attended go-live evidence is recorded |

The O5 cutover is gated by the Core live gate and may run before the O4 store goals; an operator can be live on the PWA while its apps wait for verification, submission, or review. O6 is gated by the Native pilot gate and never blocks O5. Each cutover or Native go-live starts its own 14-day stabilization window under the serialization rule in [Stage 5](05-roadmap-validation.md#stage-5-pilot-launches-and-review).

These operational goals require explicit authority for provider changes, submissions, customer communication, or production deployment. An engineering goal cannot mark itself complete based on an unsigned operator approval, an unperformed store action, or an assumed future launch.

## Agent topology

The default topology is one hands-on lead, followed by one fresh reviewer. The lead implements as well as coordinates. Add at most one implementation specialist initially, and only after its interface is accepted and it can progress independently. A separate architecture agent is an exception for a bounded investigation, not a standing role.

The current environment exposes four concurrent slots including the lead. That is a ceiling, not a staffing target; recheck it at run time. Expand to three active subagents only when disjoint work and saved elapsed time justify the handoff and integration cost. Review can run after implementation, so the normal workflow needs only one or two active slots.

| Role | Accountable for | Typical model | Writes |
|---|---|---|---|
| Hands-on goal lead | Scope, contract, invariants, critical code, narrow tests, integration, and goal status | `gpt-6-astra`, medium; high for transactional or release-critical slices | Core slice and integration paths; excludes delegated paths |
| UI lead | Design and build original screens, shared components, responsive states, accessibility, and visual refinement | `gpt-6-astra`, medium; high for complex interaction design | Assigned UI slice and design-system paths |
| Routine slice lead or specialist | Extend accepted UI patterns, implement an accepted non-UI contract, or build a provider adapter | `gpt-5.6-terra`, medium; `gpt-5.6-sol`, medium for complex but stable work | One explicitly owned path set |
| Independent reviewer | Challenge contracts, inspect the diff, reproduce failures, and verify acceptance evidence | Fresh `gpt-6-astra`, high for high-risk slices; `gpt-5.6-sol`, medium for routine slices | Read-only first; explicitly assigned regression tests if needed |
| Test and evidence specialist | Design independent race/failure scenarios and verify fixtures against the contract | `gpt-5.6-sol`, medium or high for transaction scenarios; `gpt-5.6-terra`, medium for ordinary acceptance coverage | Test and evidence paths only |
| Mechanical worker | Generated fixtures, repetitive adapters, documentation synchronization, and low-risk cleanup from an accepted pattern | `gpt-5.6-luna`, low or medium | Narrow, enumerated files |
| Defensive security reviewer | Threat model, authorization review, secret exposure review, abuse cases, and defensive findings or fixes | `gpt-daybreak-blue-latest`, high when explicitly authorized | Review artifact first; fixes only when authorized |

Do not route the hardest code to a cheaper model merely because Astra has written its plan. Keep contract design, transaction code, and diagnosis with Astra when they depend on the same invariants. A stable API alone does not make UI work routine: retain Astra until the interaction design and rendered result are accepted. Delegate extensions of accepted UI patterns, adapters, and mechanical work. Luna may expand an accepted fixture pattern; it must not decide which money, tenancy, or concurrency cases are sufficient. Daybreak remains an optional authorized defensive specialist, not a required general coding stage.

Record the intended model and reasoning effort in every agent assignment. Set both explicitly when the fork supports an override. A full-history fork inherits the lead's model and effort, so use it only when that inherited route is intentional. Start at medium for substantive implementation and high for transaction or release risks. Use low for deterministic mechanical work. Escalate to extra high only for a named unresolved problem after a focused attempt. Max and Ultra are not defaults; explicit parallel assignments make ownership and usage easier to inspect.

### Routing by TideGrid risk

| Work | Initial route | Delegation boundary |
|---|---|---|
| Authorized feasibility spikes: G0.1 transaction seams, G0.2 native factory | Astra medium, high for an unresolved transaction or signing problem | Delegate an independent fixture or second-brand check after the hypothesis is explicit |
| G2.2 tenancy, G2.3 delivery, G2.6 holds, G2.7 confirmation, G2.9 refunds, G2.10 reconciliation, G2.13 migration | Astra high owns the critical path; fresh Astra high reviews | Sol may develop adversarial scenarios; Terra may implement stable peripheral adapters |
| G2.1 tooling and G2.4 catalog implementation against accepted contracts | Terra medium; Sol medium for complex integration | Route new UI design and authorization, schedule, or capacity invariants to Astra |
| G2.11/G2.12 guest and operator UI, G2.14 brand presentation, and original UI across G3/G4 | Astra medium owns design, implementation, and visual refinement; high for complex interaction design | Terra may extend accepted components and screen patterns; API stability alone is insufficient for delegation |
| G2.5 price/fee rules, G2.8 deposits, G2.15 waivers, and G2.16 email delivery; G3 SMS consent/routing, equipment, remedies, tips, trip cards, and financial reports | Astra high for new invariants; Sol or Terra for accepted templates and views | Treat ledger, consent, evidence, and retry behavior as core work, even when the UI looks simple |
| G4 native journeys and release factory | Astra medium for original native UI; Astra high for signing, tenant routing, privacy, recovery, and release integration | Sol or Terra may extend accepted UI patterns; mechanical assets and listings can use Luna; external actions retain their authorization boundaries |

If a routine assignment discovers a contract change, security boundary, or repeated failure, stop dependent writes, preserve the reproduction, and route the problem to Astra. If Astra is unavailable, use Sol high with the same proof and review requirements and record the fallback. Model availability in this local environment does not establish access on another host, API project, or cloud task.

For UI acceptance, Astra should inspect rendered screens at representative mobile and desktop sizes and exercise the main journey, including loading, empty, error, and success states. Check hierarchy, spacing, typography, keyboard navigation, and focus behavior against the accepted design. Native UI requires device-level inspection. Use a fresh Astra reviewer for the first core screens and shared design system; routine pattern extensions may use Sol review. Better UI from this route is an expectation to validate on TideGrid, not a measured model comparison.

### RACI for a goal

| Activity | Coordinator | Contract lead | Implementer | Test or security reviewer |
|---|---|---|---|---|
| Scope and exit criteria | A/R | C | C | C |
| Contract and invariant changes | A | R | C | C |
| Feature code | A | C | R | C |
| Narrow tests | A | C | R | C |
| Adversarial and acceptance tests | A | C | C | R |
| Integration and release evidence | A/R | C | C | C |

These are responsibilities, not mandatory separate agents. The hands-on lead normally fills the coordinator, contract lead, and implementer columns. It cannot also count as its own independent reviewer for money, tenancy, waiver evidence, migration, or native signing changes.

## Work allocation rules

Parallelize only workstreams with stable interfaces and disjoint files. Good examples are an API adapter and its independent provider fixture suite, or a guest UI and an operator UI consuming an already accepted contract. Keep a coupled state transition with one owner even if its files could be split. Do not parallelize two agents that both need to design the same schema, edit the same migration, or redefine the same domain invariant.

For every assignment, record:

- one outcome and one explicit non-goal;
- the exact files or directories the agent owns;
- authoritative V2 sections and accepted contracts to read;
- invariants it must preserve;
- commands that prove completion;
- required handoff fields; and
- actions that require coordinator approval.

Agents in the current collaboration environment share a filesystem. Treat path ownership as a write lock. Only the named owner edits a path until handoff. The coordinator owns shared indexes, lockfiles, root configuration, migrations that span domains, and conflict resolution. Separate worktrees are appropriate for a genuinely independent spike or risky upgrade, but routine feature agents should not create merge work that costs more than the parallelism saves.

Use one milestone branch or worktree from a known clean integration commit. Preserve unrelated changes. Create small reviewed commits only when the build workflow authorizes commits; an agent completing a task is not by itself authorization to commit, push, provision, submit, or publish.

## Context packet

Start each subagent with a compact packet instead of the full planning history:

```text
Goal: <one accepted outcome>
Why now: <roadmap gate and dependency>
Workspace: <absolute active worktree path>
Repository instructions: <Workspace>/AGENTS.md and any applicable nested AGENTS.md
Command directory: <set every command to Workspace; never fall back to another checkout>
Baseline: <integration SHA>
Initial dirty paths: <recorded git status; preserve and do not overwrite>
Authority: <specific V2 sections, ADRs, schema/API versions>
Ownership ledger: <active agents and their exact write-locked paths>
Owned paths: <exact paths>
Read-only dependencies: <exact paths>
Forbidden writes: <all paths outside Owned paths unless the coordinator reassigns them>
Delegation: <none, or one level with named purpose and slot limit>
Model and effort: <explicit model ID and supported reasoning effort>
Routing reason: <risk, independent work, or accepted mechanical pattern>
Fork mode: <none or bounded recent-turn count; required for model/effort override>
Invariants: <tenant, money, capacity, evidence, retry rules>
Non-goals: <excluded features and provider actions>
Acceptance: <commands and observable results>
Handoff: <files changed, tests run, decisions, risks, next action>
```

Use a context-free agent with this packet for mechanical work. Preserve recent turns only when the task depends on an active design discussion. Reuse a warmed agent for a closely related follow-up within the same goal instead of making another agent relearn the same domain. End that assignment when path ownership or domain responsibility changes.

In the current collaboration environment, a model or reasoning-effort override requires a context-free or bounded recent-turn fork. Use `fork_turns: "none"` with the complete packet for Terra or Luna work that does not need the coordinator's discussion, or pass only the few recent turns that contain an unresolved design decision. A full-history fork inherits the coordinator's model and effort and defeats both model routing and context reduction. Recheck this behavior when the goal starts.

The durable context for every goal is:

1. the V2 plan and decision register;
2. accepted ADRs and domain invariants;
3. versioned schema, OpenAPI, event, and manifest contracts;
4. deterministic fixtures and executable acceptance tests;
5. the integration commit and release ledger; and
6. a short goal handoff with unresolved risks.

Do not use raw transcripts as the implementation authority. If a discussion changes an invariant, update the decision record or ADR before dependent agents proceed.

## Token and execution controls

Track allowance or billed cost separately from raw tokens. The [published Codex credit table](https://learn.chatgpt.com/docs/pricing), checked September 5, 2026, lists Astra at 250/25/1,250 credits per million input/cached-input/output tokens and Sol at 100/10/500. Astra therefore costs 2.5 times as many standard credits for an identical token mix. This is not a per-task cost or subscription-allowance multiplier; actual consumption, caching, retries, speed settings, and account terms differ. Use standard speed initially and recheck rates before each goal.

The economic hypothesis is that keeping difficult work with Astra avoids enough failed attempts, handoffs, and owner intervention to justify its higher rate. Record total accepted-slice cost, elapsed time, owner review minutes, and defects. Fewer tokens alone cannot establish savings across models. If billing detail is unavailable, report token usage and the attribution gap rather than inventing a dollar cost or treating shared account usage as this goal's consumption.

The user should set an explicit token budget for each goal after reviewing its slice. Do not assign one budget to the full roadmap. Establish the first budget from the accepted contract and file surface, then use observed consumption and rework to calibrate later goals.

Create the goal only after its roadmap gate, outcome, integration commit, budget, and proof are explicit. Budget exhaustion does not make a goal complete and must not weaken its acceptance criteria. If remaining budget cannot support the required review, stop adding scope and produce the recovery handoff so the user can authorize a narrower continuation.

Reserve the goal budget approximately as follows. These are planning allocations, not predicted savings:

| Use | Share |
|---|---:|
| Read, contract check, and plan | 15% |
| Implementation and narrow tests | 55% |
| Independent review and integration tests | 20% |
| Recovery, documentation, and handoff | 10% |

The current goal interface provides goal-level token usage, elapsed time, remaining budget, and status. The coordinator calls `get_goal` and records a checkpoint after contract acceptance, the first green end-to-end path, before independent review, and at final handoff. Marking a budgeted goal complete must include the final usage returned by the goal interface.

Record these items at the goal level:

- token and elapsed-time usage plus remaining budget at each checkpoint;
- attributable credits or billed cost when available, model mix, speed settings, and owner review minutes;
- files and lines changed;
- narrow and integration test results;
- defects found during independent review or after integration;
- retries, abandoned approaches, and manual interventions; and
- provider waits and unresolved risk.

Record model, reasoning effort, task, and outcome for each assignment. Attribute tokens to a model or subagent only when the environment exposes that data. Otherwise label any workstream allocation as an estimate; do not present goal-level usage as measured per-agent usage.

Compare cost per accepted vertical slice, not tokens per line of code. A lower-token run that omits race, reconciliation, or store evidence is not cheaper. Recheck model pricing and availability at the start of each goal before using cost estimates.

Use these controls to reduce avoidable context and tool use:

- search for exact symbols and read targeted files before broad repository scans;
- give command output a bounded token limit and retain only the relevant evidence;
- run narrow tests inside feature assignments and the complete relevant suite once during integration;
- send one task per agent and avoid duplicated investigations;
- require an agent to report evidence after one repeated failed approach instead of looping;
- prefer generated contracts and fixtures over repeating prose requirements; and
- trigger the `get_goal` checkpoint when a slice consumes half its budget without a green end-to-end path or a resolved blocker.

At that checkpoint, report the evidence, remaining work, and projected review need. An active goal cannot pause itself, replace itself, change its token budget, or mark incomplete work complete. If the original scope no longer fits, ask the user to cancel or replace the goal with a narrower objective; otherwise continue only within the original outcome and budget. Use blocked status only after the same external blocking condition meets the goal system's repeated-blocker rule.

## Review and test gates

Every goal passes these gates in order:

1. **Contract:** Scope, invariants, file ownership, API/schema effects, and rollback behavior are accepted.
2. **Narrow proof:** Each implementation assignment passes its focused tests and returns a complete handoff.
3. **Independent review:** A fresh agent checks the diff against the contract, failure modes, and excluded scope. Give it the baseline, final diff or SHA, original acceptance criteria, authoritative contracts, and test evidence, without the implementer's persuasive summary. It must independently inspect the code and evidence.
4. **Integration:** The coordinator resolves seams and runs the complete tests relevant to the goal.
5. **Artifact:** Contracts, ADRs, generated clients, migration evidence, SBOM, or release packet are updated when applicable.
6. **Goal acceptance:** The observable roadmap exit condition passes with no required work left.

Money, capacity, equipment, packages, webhooks, and remedies require retry, replay, duplicate, concurrency, and partial-failure tests. Tenant-facing work requires at least two-tenant escape tests. Native work requires builds from manifests without source edits and device-level deep-link, push, account, privacy, and update checks. A build, upload, or green unit suite alone does not complete the goal.

Fresh context separates the review from the implementation conversation; using the same model does not eliminate correlated mistakes. High-risk slices receive fresh Astra review plus executable adversarial evidence. Routine slices may use Sol review. The qualified external human review before the first live use of each area remains mandatory under the sole-owner rule. Recheck affected findings after fixes, and tie final review evidence to the final diff or SHA.

## Failure and recovery

When an assignment fails, preserve the failing command, smallest reproduction, relevant logs, current diff, and last known good commit. The coordinator then chooses one action: narrow the task, replace an assumption, assign a focused investigator, revert the unaccepted patch through a safe reviewed change, or stop at the roadmap gate.

Do not keep adding agents to an unstable interface. Freeze dependent work while a contract or migration is unresolved. Do not solve repeated failures by weakening an invariant, skipping an acceptance test, editing production data, introducing a customer fork, or making an undocumented console change.

An interrupted goal remains recoverable when its handoff states:

- accepted and unaccepted changes;
- exact integration commit and dirty paths;
- tests that passed, failed, or did not run;
- provider or user-controlled state;
- decisions still required; and
- the smallest safe next action.

## Claude Code execution route

This section maps the topology above onto Claude Code in the Claude desktop app. The roles, gates, context packet, ownership rules, and telemetry requirements are unchanged; only the mechanics and model names differ. Recheck model availability and pricing at the start of each goal.

### Role to model mapping

| Role | Claude Code mechanism | Model and effort | Writes |
|---|---|---|---|
| Hands-on goal lead and UI lead | The root session | `claude-fable-5-1`; high effort for transaction, tenancy, evidence, and release slices; medium for accepted-pattern work | Core slice, design system, and integration paths |
| Independent reviewer | `independent-reviewer` agent in `.claude/agents`, fresh context, read-only tools | `claude-opus-5`; the lead may run a second review on `claude-fable-5-1` for money, tenancy, waiver evidence, and migration slices | None; findings only |
| UI reviewer | `ui-reviewer` agent with the built-in browser, fresh context | `claude-opus-5` | None; findings with screenshots |
| Test and evidence specialist | `test-specialist` agent, optional worktree | `claude-opus-5` for race and failure scenarios; `claude-sonnet-5` for ordinary acceptance coverage | Test and fixture paths only |
| Routine slice implementer | `routine-implementer` agent, worktree isolation when its paths could collide | `claude-sonnet-5`, medium | One enumerated path set |
| Mechanical worker | General-purpose agent with `model: haiku` | `claude-haiku-4-5-20251001`, low | Narrow, enumerated files |
| Defensive security reviewer | `security-reviewer` agent, read-only | `claude-opus-5`, high, when explicitly authorized | Review artifact; fixes only when authorized |

The lead implements as well as coordinates. It cannot count as its own independent reviewer for money, tenancy, waiver evidence, migration, or native signing changes; those use a fresh agent with the baseline, final diff, acceptance criteria, and contracts, and without the lead's summary.

### Mechanics

- **Spawning.** Use the Agent tool with the context packet as the prompt. Give every agent exact owned paths, forbidden writes, invariants, non-goals, and proof commands. Continue a warmed agent with SendMessage for a closely related follow-up inside the same goal; start a fresh agent when path ownership or domain changes.
- **Isolation.** Agents share the working tree by default. Use `isolation: worktree` for an independent specialist whose paths could collide with the lead, for a risky upgrade, or for a spike. Routine agents on disjoint paths do not need a worktree.
- **Concurrency.** Treat the ceiling as two active writing agents plus the lead. Review runs after implementation and does not need a slot. Expand only when disjoint work saves elapsed time.
- **Orchestration.** The Workflow tool runs many agents from one script and is used only when the owner opts in explicitly for a goal (for example, "use a workflow"). The default is the Agent tool with one or two agents.
- **Branches and commits.** Each goal runs on its own branch from the recorded integration commit. The lead commits only when the owner authorizes commits for that goal, one reviewed commit or a small series per goal, and opens a pull request that carries the reviewer's findings and the acceptance evidence. Merge is the owner's action.
- **Telemetry.** Claude Code exposes session-level usage, not per-goal or per-agent attribution. Record session usage at the four checkpoints (contract accepted, first green end-to-end path, before independent review, final handoff) in the goal handoff, label per-agent splits as estimates, and record elapsed time, retries, defects found in review, and owner review minutes.
- **Budgets.** The owner sets a token budget per goal at goal start. The checkpoint rule (report when half the budget is spent without a green end-to-end path) and the rule that budget exhaustion never weakens acceptance are unchanged.

### Agent definitions

The agent files in `.claude/agents` carry the standing role instructions. The goal packet supplies everything goal-specific. Do not put goal scope, paths, or invariants in the agent files.

## Example goal request

The user selects `gpt-6-astra` at high effort when creating the root task. A goal request cannot change the current root model. Replace the bracketed values and recheck model availability, pricing, and concurrency before use:

```text
Create a bounded Codex goal to implement TideGrid G2.7 Charge to confirmation
with a token budget of <TOKEN_BUDGET>. The Validation gate has passed and
the integration commit is <SHA>. The root task is already running on
gpt-6-astra at high effort and standard speed.

Use docs/v2/02-product-scope.md, docs/v2/04-architecture.md,
docs/v2/05-roadmap-validation.md, docs/v2/06-decision-register.md, and the
accepted payment ADR and contracts as authority. Approved Stripe sandbox
accounts, webhook endpoints, and deterministic provider fixtures are in scope.
Do not expand pilot scope, provision live or unapproved provider resources,
use live customer data, push, or publish.

Keep the root agent as hands-on lead: own the contract, payment state machine,
critical implementation, and integration. Add at most one specialist initially,
only for disjoint work after contract acceptance. Use gpt-5.6-sol for independent
failure scenarios, gpt-5.6-terra for stable peripheral adapters, and gpt-5.6-luna
only for accepted mechanical fixtures. Use context-free or bounded-turn forks
for overrides. After implementation, use a fresh gpt-6-astra reviewer at high
effort with the original contract, final diff, and executable evidence.

Give every agent exact path ownership, non-goals, invariants, and commands.
Complete only when an immutable quote and order, atomic resource holds, one
Stripe direct charge, verified callback, booking confirmation, expiry release,
callback replay, and late-success reacquisition or full compensation pass.
Deposits, balance collection, post-confirmation policy refunds, credits,
external payments, and monthly fee reconciliation are non-goals. Update the
required contracts and evidence, record all get_goal checkpoints, and return
goal-level token, time, retry, test, and rework telemetry with the handoff.
Record attributable credit cost and owner review time when available; label
missing attribution explicitly. Do not infer savings from token counts alone.
```

## Process acceptance

The build method is working when:

- every active assignment has one owner, disjoint write paths, and an executable acceptance check;
- every completed subagent handoff identifies its diff, tests, decisions, risks, and next action;
- every milestone starts from and ends at a recorded integration commit;
- no dependent work proceeds on an unaccepted contract;
- every high-risk change receives independent review;
- the complete relevant acceptance suite passes before a goal is marked complete;
- goal telemetry is recorded consistently enough to compare model routes and slice sizes; and
- TideGrid maintains one source tree, zero customer forks, and the commercial and operating gates in the roadmap.

Calibrate during the first authorized technical work, then revisit after the first three production goals. Use three representative tasks: a synthetic hold/late-payment failure case, an ordinary client workflow against a fixed contract, and a mechanical fixture transformation. Each must fit an already authorized spike or goal; this plan does not authorize a new benchmark or production build.

Where an approved budget allows a comparison, run the same baseline, acceptance criteria, and fixed failure cases in isolated worktrees using Astra lead plus fresh review and the previous Sol lead/Terra implementation route. Count all implementation, review, repair, and integration work. Prefer comparable completed work when available; do not duplicate every goal merely to benchmark it.

Retain Astra where it improves acceptance quality, reduces owner intervention, or justifies its total cost through less rework or elapsed time. Retain Terra and Luna where they pass the same relevant checks with lower cost. Three tasks provide an initial routing signal, not a reliable forecast for the entire build. Preserve the existing goal boundaries until actual integration evidence supports changing them.
