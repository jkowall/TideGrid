# TideGrid V2 build execution and agent plan

**Status:** Proposed execution baseline; use only after the applicable roadmap gate passes
**Date:** September 4, 2026

## Recommendation

Do not use one goal run for the entire TideGrid build. Use one bounded goal per accepted vertical slice, with a clean integration point and recorded acceptance evidence between goals. A longer run is appropriate for one cohesive slice, such as booking concurrency or payment reconciliation. It is too broad for Stages 2 through 5 together.

This keeps product and architecture decisions reviewable, prevents a failed native or provider assumption from contaminating unrelated work, and makes token and delivery cost measurable. Continuity comes from the V2 documents, implementation contracts, ADRs, tests, and goal handoffs rather than one agent retaining a very long conversation.

The model names and capabilities below reflect the models exposed in the current Codex environment. Availability, model behavior, concurrency limits, and pricing must be rechecked when a build goal starts. This plan makes no token-savings claim. It defines measurements for choosing the least expensive route that still passes acceptance.

This follows [OpenAI's long-running-work guidance](https://learn.chatgpt.com/docs/long-running-work), which recommends one clear outcome, constraints, verification, and separate parallel work only when sources do not overlap. Current [OpenAI model guidance](https://developers.openai.com/api/docs/guides/latest-model) describes Sol as the flagship choice, Terra as the intelligence-and-cost balance, Luna as the cost-sensitive high-volume choice, deliberate reasoning-effort selection, and multi-agent use for workstreams that divide cleanly.

## Sole-owner authority

The operating baseline assumes one human founder and owner. That person retains business decisions, customer commitments, provider authorization, and production authority. Codex subagents are implementation tools; they are not founders, employees, production on-call coverage, or legal segregation of duties.

Before the first live use, money, tenancy, native signing, recovery, and security-sensitive production changes require review by a qualified external human. No production goal may overlap an active pilot launch or incident. Incident response and recovery take priority, and planned production work resumes only after the launch or incident closes with recorded evidence.

## Goal map

No production goal may cross the paid-validation gate in [`05-roadmap-validation.md`](05-roadmap-validation.md). Each row below is a separate goal. Combine adjacent rows only after the coordinator proves that the combined change still has one contract, one end-to-end outcome, and one independently reviewable diff.

| Goal | Outcome | Principal proof |
|---|---|---|
| G0.1 Domain and infrastructure spikes | Validate transaction seams, tenant manifest, hosting topology, and database connection behavior | Recorded spike results and accepted decisions; no production provisioning |
| G0.2 Native factory dry run | Generate two branded development variants from one source without manual native edits | Reproducible manifests, builds, timing, and gap report |
| G0.3 Pilot harness | Build the standard import prototype, deterministic provider fixtures, and acceptance-test skeleton | Stage 0 technical evidence; no live customer data |
| G2.1 Workspace foundation | Establish the monorepo, pinned toolchain, contract generation, migration runner, environment configuration, and CI baseline | Clean bootstrap plus repeatable build, migration, and test commands |
| G2.2 Tenant access and audit | Implement tenant identity, request context, roles, row-level security, and immutable audit records | Two-tenant escape tests and role-denial tests |
| G2.3 Idempotent delivery foundation | Implement command idempotency, webhook inbox, transactional outbox, queue publication, retry, and DLQ evidence | Duplicate, out-of-order, crash, replay, and recovery tests |
| G2.4 Catalog and schedule | Implement products, boats, departures, recurring schedules, blackouts, cutoffs, buffers, and sales states | Schedule-boundary and availability tests |
| G2.5 Pricing, add-ons, fees, and policies | Implement ticket and charter prices, paid add-ons, taxes, mandatory fees, promotion codes, deposits, and versioned policies | Quote snapshot, add-on eligibility, tax, discount, and policy-version tests |
| G2.6 Capacity and holds | Implement seat and exclusive-boat capacity, atomic holds, expiry, and confirmation transitions | Concurrent final-seat and whole-boat tests |
| G2.7 Charge to confirmation | Implement immutable quote and order, Stripe direct charge, verified callbacks, booking confirmation, safe hold release, and late-success compensation | Success, failure, expiry, replay, and late-callback tests |
| G2.8 Deposits and balances | Add one private-charter deposit, one balance deadline, reminders, staff collection, and overdue state | Deposit, reminder, collection, and deadline tests |
| G2.9 Refunds, credits, and fee reversal | Implement policy-driven refund, noncash service credit, manager override, and proportional TideGrid fee reversal | Partial and full refund, retry, credit, and ledger tests |
| G2.10 External payment and reconciliation | Add externally paid records, monthly fee assessment, dispute visibility, provider reconciliation, and control totals | Missing, duplicate, changed, and mismatched settlement tests |
| G2.11 Guest booking management | Implement secure accountless access, receipts, participant invitations, profile changes, cancellation, and whole-booking rescheduling | End-to-end browser journeys and authorization tests |
| G2.12 Operator console and roster | Implement calendar, search, booking detail, manual booking, roles, roster, notes, and basic reports | Staff journeys, role tests, printable roster, and CSV control totals |
| G2.13 Standard migration | Implement mapping preview, deduplication, rehearsal, signed controls, final delta, and rollback criteria | Repeatable import and financial-count reconciliation |
| G2.14 Branded PWA and hostname | Deliver brand configuration, tenant-safe custom-hostname resolution, deep links, support pages, and PWA installability | Two-brand browser, hostname, and tenant-boundary tests |
| G3.1 Waiver evidence | Implement immutable templates, source-independent assignment, participant and guardian signing, hashes, signed PDFs, status, and reuse rules | Booking-source matrix, cross-participant, guardian, version, and evidence tests |
| G3.2 Outbound transactional messaging | Implement branded email and SMS templates, consent evidence, delivery state, reminders, and email fallback | Consent, send, callback, failure, and fallback tests |
| G3.3 SMS replies and opt-out | Implement dedicated-number routing, booking-scoped replies, ambiguous inbox, STOP, START, and HELP | Routing, authorization, opt-out, restart, and replay tests |
| G3.4 Pooled equipment | Implement inventory pools, participant allocation, buffers, blocks, holds, and release | Concurrent last-unit and overlapping-window tests |
| G3.5 Weather disruption and remedies | Implement weather evidence, freshness, authorized actions, frozen impact sets, one remedy, and notifications | Stale-data, authorization, retry, and one-remedy tests |
| G3.6 Tips | Implement checkout and post-trip tips, exclusions, requests, refunds, and reporting | Timing, duplicate, fee-exclusion, and refund tests |
| G3.7 Fixed-unit packages | Implement sale, append-only units, holds, redemption, restoration, expiration, and adjustment | Last-unit race, replay, restoration, and fee-timing tests |
| G3.8 Cross-domain reporting | Complete revenue, occupancy, tax, tip, refund, package, fee, and reconciliation exports | Ledger-to-report and export control totals |
| G4.1 Native shell and manifest | Implement the shared Expo shell, validated manifest, identity, assets, navigation, authentication, and branded tests | Two variants build and authenticate without source edits |
| G4.2 Native guest journeys | Implement upcoming trips, booking management, balance payment, saved profiles, waiver completion and status, and package and credit balances | Device-level parity tests against the accepted PWA and API contracts |
| G4.3 Native deep links, push, and privacy | Add tenant-safe links, push routing, account deletion, privacy manifests, and supported-version behavior | Device-level link, notification, deletion, and upgrade tests |
| G4.4 iOS release factory | Generate iOS signing inputs, metadata, screenshots, privacy answers, signed artifacts, TestFlight upload, and release packet | One internally rehearsed, submission-ready iOS packet with immutable evidence |
| G4.5 Android release factory | Generate Android signing inputs, metadata, screenshots, Data safety answers, signed artifacts, internal-track upload, and release packet | One internally rehearsed, submission-ready Android packet with immutable evidence |
| G4.6 Second-brand reproduction | Reproduce both factories for another operator and isolate a failed tenant from the release train | Timing, touch-time, automated-pass, and failure-isolation evidence |
| G4.7.`operator` Pilot operator readiness | Generate one pilot operator's migration rehearsal, configured applications, acceptance evidence, rollback plan, and support handoff | Complete internally approved packet for one pilot operator; no claim of operator or store approval |
| G4.8 Engineering cohort gate | Compare the three completed pilot-operator packets, shared acceptance suite, delivery time, and unresolved cross-customer risks | Recorded go, change, or stop recommendation; no customer-specific implementation |

G2.1 establishes the integration harness before parallel feature work begins. G2.7 proves only charge-to-confirmation; deposits, post-confirmation refunds, and monthly reconciliation remain separate. G4.4 and G4.5 stop at an internally rehearsed submission-ready state.

Human-controlled work uses separately authorized operational goals after the applicable engineering evidence exists:

| Operational goal | Authorized outcome | Completion boundary |
|---|---|---|
| O4.`operator`.1 Account and content readiness | Assist one operator with verified accounts, public pages, content approval, and delegated access | Required operator-controlled evidence is recorded; waiting does not become engineering completion |
| O4.`operator`.2 Store submission | Prepare the final packets, support the operator's Apple submission, and submit Google only with recorded approval | Both authorized submission receipts are recorded; approval remains a store-controlled outcome |
| O4.`operator`.3 Store review response | Monitor one review cycle and prepare the included correction or appeal with operator approval | The review decision and any authorized response are recorded; an unresolved external wait follows the goal blocked-status rule |
| O5.`operator` Launch and stabilization | Perform an approved cutover, verify live surfaces, monitor reconciliation, and record support and cost | Live acceptance passes; an unresolved external dependency follows the goal blocked-status rule and retains recovery evidence |

These operational goals require explicit authority for provider changes, submissions, customer communication, or production deployment. An engineering goal cannot mark itself complete based on an unsigned operator approval, an unperformed store action, or an assumed future launch.

## Agent topology

The default topology is one coordinating agent and no more than three active subagents. The current environment exposes four concurrent slots including the coordinator; recheck this limit at run time. Use fewer agents when tasks share contracts, migrations, or files.

| Role | Accountable for | Typical model | Writes |
|---|---|---|---|
| Goal coordinator | Scope, plan, ownership, decisions, integration, final review, and goal status | `gpt-5.6-sol`, medium; high for transactional or release-critical goals | Integration files and final conflict resolution |
| Contract or architecture lead | Domain contract, migration/API seams, invariants, ADR proposal, and difficult diagnosis | `gpt-5.6-sol`, medium or high | Assigned contract and design paths only |
| Feature implementer | A bounded domain or client vertical slice with narrow tests | `gpt-5.6-terra`, medium by default | One explicitly owned path set |
| Test and evidence owner | Independent scenario review, fixtures, race/failure tests, and acceptance report | `gpt-5.6-terra`, medium; `gpt-5.6-luna`, low or medium for mechanical test expansion | Test and evidence paths only |
| Mechanical worker | Generated fixtures, repetitive adapters, documentation synchronization, and low-risk cleanup from an accepted pattern | `gpt-5.6-luna`, low or medium | Narrow, enumerated files |
| Defensive security reviewer | Threat model, authorization review, secret exposure review, abuse cases, and defensive findings or fixes | `gpt-daybreak-blue-latest`, high when explicitly authorized | Review artifact first; fixes only when authorized |

`gpt-5.6-terra` is the default implementation model. Escalate to `gpt-5.6-sol` for ambiguous contracts, concurrency and money invariants, cross-cutting integration, or a failure that survived a focused investigation. Use `gpt-5.6-luna` only after the coordinator supplies an accepted pattern and tight acceptance criteria. Use `gpt-daybreak-blue-latest` only for authorized defensive security work, not general implementation.

Record the intended model and reasoning effort in every agent assignment. Set both explicitly when the fork supports an override. A full-history fork inherits the coordinator's model and effort, so use it only when that inherited route is intentional. Low effort is suitable for deterministic mechanical changes. Medium is the default for implementation and tests. High is reserved for architecture, transactions, provider failure modes, release security, and root-cause work. Do not use higher effort merely because a goal is large; split the goal first.

### RACI for a goal

| Activity | Coordinator | Contract lead | Implementer | Test or security reviewer |
|---|---|---|---|---|
| Scope and exit criteria | A/R | C | C | C |
| Contract and invariant changes | A | R | C | C |
| Feature code | A | C | R | C |
| Narrow tests | A | C | R | C |
| Adversarial and acceptance tests | A | C | C | R |
| Integration and release evidence | A/R | C | C | C |

One person may fill more than one role, but the implementer should not be the only reviewer for money, tenancy, waiver evidence, migration, or native signing changes.

## Work allocation rules

Parallelize only workstreams with stable interfaces and disjoint files. Good examples are an API adapter and its independent provider fixture suite, or a guest UI and an operator UI consuming an already accepted contract. Do not parallelize two agents that both need to design the same schema, edit the same migration, or redefine the same domain invariant.

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
3. **Independent review:** Another agent checks the diff against the contract, failure modes, and excluded scope.
4. **Integration:** The coordinator resolves seams and runs the complete tests relevant to the goal.
5. **Artifact:** Contracts, ADRs, generated clients, migration evidence, SBOM, or release packet are updated when applicable.
6. **Goal acceptance:** The observable roadmap exit condition passes with no required work left.

Money, capacity, equipment, packages, webhooks, and remedies require retry, replay, duplicate, concurrency, and partial-failure tests. Tenant-facing work requires at least two-tenant escape tests. Native work requires builds from manifests without source edits and device-level deep-link, push, account, privacy, and update checks. A build, upload, or green unit suite alone does not complete the goal.

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

## Example goal request

The user selects `gpt-5.6-sol` at high effort when creating the root task. A goal request cannot change the current root model. Replace the bracketed values and recheck model availability, pricing, and concurrency before use:

```text
Create a bounded Codex goal to implement TideGrid G2.7 Charge to confirmation
with a token budget of <TOKEN_BUDGET>. The paid-validation gate has passed and
the integration commit is <SHA>. The root task is already running on
gpt-5.6-sol at high effort.

Use docs/v2/02-product-scope.md, docs/v2/04-architecture.md,
docs/v2/05-roadmap-validation.md, docs/v2/06-decision-register.md, and the
accepted payment ADR and contracts as authority. Approved Stripe sandbox
accounts, webhook endpoints, and deterministic provider fixtures are in scope.
Do not expand pilot scope, provision live or unapproved provider resources,
use live customer data, push, or publish.

Keep the root agent as coordinator and contract owner. Delegate bounded
implementation work to gpt-5.6-terra at medium effort. Use gpt-5.6-luna only
for mechanical fixtures or repetitive tests after the contract is accepted.
Use context-free or bounded-turn forks for those overrides. Assign an
independent reviewer before integration.

Give every agent exact path ownership, non-goals, invariants, and commands.
Complete only when an immutable quote and order, atomic resource holds, one
Stripe direct charge, verified callback, booking confirmation, expiry release,
callback replay, and late-success reacquisition or full compensation pass.
Deposits, balance collection, post-confirmation policy refunds, credits,
external payments, and monthly fee reconciliation are non-goals. Update the
required contracts and evidence, record all get_goal checkpoints, and return
goal-level token, time, retry, test, and rework telemetry with the handoff.
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

After the first three production goals, review token use, rework, escaped defects, and elapsed time by task type. Keep model and effort routes that produce accepted results with less rework. Change routes that repeatedly require escalation or independent repair. That evidence, rather than a speculative long-run estimate, should determine how the remaining build is staffed.
