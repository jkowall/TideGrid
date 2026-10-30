# TideGrid V2 decision register

**Status:** Canonical conflict-resolution record

Use this register when V2 conflicts with the V1 specification, schema, API, diagrams, tests, or ADR wording. The V1 files remain unchanged design evidence unless their indexes carry a historical-status notice.

## Decision log

Dated decisions that changed scope, wording, or process. Each entry records the reason and points to the canonical document.

### 2026-10-29: G2.16b staff email resend, owner decisions

The owner accepted the recommended defaults of the G2.16b goal packet (failure surfaces on booking detail and staff resend with audit) for D1 to D9 and D11, as relayed by the coordinator on 2026-10-29. For D10 the owner chose the packet's option C instead: hold the merge until after the Nov 1 deploy. These are owner decisions, not coordinator defaults. Details are in the [staff resend narrowing](12-demo-build-plan.md#goal-sequence) of the demo build plan and the [booking README](../../packages/domain-booking/README.md#staff-resend-of-a-bookings-email-g216b).

- **D1 A: two kinds.** The confirmation, with a new management link, for a confirmed booking before its trip ends. The cancellation notice, for a canceled booking, refused as `booking_email_refund_failed` when the cancellation's refund failed, since the notice says the refund is on its way. Not the management-link email (the guest asks for one), not the refund-failed follow-up, and not waiver requests (they keep their own resend).
- **D2 A: a `messages.resend` permission** for owners and booking staff. Finance is refused.
- **D3 A: a new message, its token minted at send time.** Earlier unused links of the booking's management purpose are superseded when the new link is issued, so they still renew. A stored token cannot be sent again: only hashes are stored. This narrows the [product scope](02-product-scope.md)'s rule that a fallback must not duplicate a delivered message, for staff resends only. After `outcome_unknown`, a staff resend may deliver a second copy if the first arrived. It is a new, audited message a person chose, not the automatic fallback. When TideGrid starts sending it, its link supersedes the links earlier emails carried; a link email the guest asked for that goes out later supersedes it in turn, so the link in the email sent last is the one that opens the booking. The rule that a retry never sends the same message twice still holds.
- **D4 A: limits held by the service, no migration.** At most 5 deliverable resends per booking for ever (attempted, or still waiting), at least 10 minutes after the booking's newest resend of any state, and 50 resends an hour per operator. The service counts committed `email_messages` rows under a per-operator advisory lock and the booking's row lock, so the limits hold exactly across requests, addresses, staff members, and bookings. (The packet said the hourly cap "may pass by one" under concurrent resends of different bookings. The review of 2026-10-30 showed it could pass by as many resends as ran at once; the advisory lock, taken within D4 A with no migration, makes it exact. A coordinator fix, not an owner question.) They do not bind a writer that bypasses the service; the uniqueness of each resend's key is the database's either way. Follow-up, before any pilot tenant (the same gate as G2.16-live): migration `0014` with an append-only resend table and a trigger that decides the limits, as `waiver_deliveries` does.
- **D5 A: an earlier email still pending.** An earlier email of the same template still queued is canceled with code `resent` once every check has passed, its links superseded. One being sent refuses the resend as `booking_email_in_progress`.
- **D6 A: the reason is a code**: `guest_did_not_receive`, `delivery_failed`, `delivery_unknown`, `guest_asked_again`, or `other`. Finance reads audit history, and the owner kept guest-naming free text from finance (2026-10-19). The waiver resend's free-text reason in audit is the same exposure; it is recorded here, not fixed.
- **D7 A: finance gets no card** and makes no messages request.
- **D8 A: email off.** The read says `emailDelivery: "off"`; a resend answers `booking_email_off` after authentication, membership, permission, and an idempotent replay, and stores nothing.
- **D9 A: booking detail only.** A tenant-wide email exceptions list is a proposed follow-up.
- **D10: merge after the Nov 1 deploy** (after P11). This replaces the packet's D10 B.
- **D11 A: booking-level emails only** on the card; waiver requests stay on the Waivers card.

### 2026-10-29: pre-pilot hardening, owner decisions

The owner decided the two questions the hardening goal left open (standing goal item 5). Both are owner decisions, not coordinator defaults. Details are in the [pre-pilot hardening narrowing](12-demo-build-plan.md#goal-sequence) of the demo build plan.

- **D-E7: the cron's email sweep keeps its 20 s budget.** Bound, inferred and not tested: with Cloudflare's 10 s send bound and the 2 s margin, claims happen only in the first 8 s of a run (D9 B below). No sends-per-run figure was measured.
- **D-E8: a console search latency target of 300 ms p95** for the large tenant (about 50,000 bookings), common fragments included. When the target was set, the observed number was above it: about 320 ms, max 355 ms, at 20,000 matches, on CI PostgreSQL 17, not Neon (run 40765472082). So the deferred search follow-up became required work, as a goal and pull request of its own: order and limit the matching booking ids before the joins, not an index. Built in pull request 41: search is now one statement that collects the matches once and orders and limits them before any detail join, with no new index. It meets the 300 ms p95 target on CI PostgreSQL 17; Neon is not yet shown. The measurements are in the [booking README](../../packages/domain-booking/README.md#deferred-and-known-gaps). The owner decided on 2026-10-29 to merge it when green, not after the Nov 1 deploy.

### Pending owner confirmation: pre-pilot hardening (coordinator defaults, 2026-10-28 and 2026-10-29)

**Status:** Standing goal item 5. D1 to D9 were taken under the owner's standing goal of 2026-10-28, "go, include the Stripe and email adapters", whose Authority section takes each packet's recommended decisions as coordinator defaults. D-E1 to D-E12 were taken on 2026-10-29 under the owner's request "keep going, hardening parts D and E, merge when green"; the owner then decided D-E7 and D-E8 (above). The defaults bind the demo build only, until the owner confirms or replaces them. Details are in the [pre-pilot hardening narrowing](12-demo-build-plan.md#goal-sequence) of the demo build plan.

- **D1 A:** least-recently-served stamps per tenant and sweep (`sweep_turns`, 0013).
- **D2 A:** quanta of 1 hold batch, checkout steps of 1 batch and 10 items, 5 emails within the cap of 25, and 5 hostname rows within the cap of 20.
- **D3 A:** no audit or outbox row for a stamp.
- **D4 B:** pg_trgm deferred with evidence. Observed on CI PostgreSQL 17 (runs 40759514375 and 40765472082); Neon is unchecked. `textlike` and `texticlike` are not leakproof, and the runtime's custom, generic, and unfiltered plans never used the trigram index under forced row-level security. `search.integration.test.ts` asserts the block, so a planner change reopens D4. This defers the standing goal's item 5 bullet "a trigram index for console search". D4 A, a definer matcher over booker personal data, was a hard stop and was not taken. Details are in the [booking README](../../packages/domain-booking/README.md#deferred-and-known-gaps).
- **D5 A, D6 A, D7 A:** not exercised, because D4 B deferred the index. D5 A keeps its precondition: an integration test of the booking-to-confirmed invariant before a partial index relies on `state = 'confirmed'`.
- **Standing rule from D6 A.** A non-transactional runner mode for `CREATE INDEX CONCURRENTLY` must land before any pilot-volume table gets a new index. Today each migration file runs in one transaction (`packages/database/src/migrate.ts`).
- **D8 C:** the first pull request to merge took 0013.
- **D9 B:** the email sweep's deadline comes from its budget. Bound, inferred and not tested: with a 20 s budget, Cloudflare's 10 s send bound, and a 2 s margin, claims happen only in the first 8 s of the run. No sends-per-run figure was measured.
- **Parts D and E, 2026-10-29:**
  - D-E1 A: a hostname turn reads up to 5 due rows, ended claims included; `perTenantLimit` (20) stays the per-tenant run cap.
  - D-E2 A: the hostname sweep keeps its budget check before each hostname.
  - D-E3 A: a throttle, an account-level refusal, or the call limit ends the run's provider reads; later turns only expire ended claims and stamp nobody. Two residuals are recorded, inferred and not tested.
  - D-E4 A: the hostname report adds `turns`, `passes`, `deferredTenants`, `stampFailures`, `expiryOnlyTurns`, and `providerCalls`.
  - D-E5 B: no email stop field. The cron logs `tidegrid.email_sweep.account_fault` on every summary, with the deferred-tenant count. A deadline stop and a spent budget are one condition.
  - D-E6 A: the new log keys join the logger's allowlist.
  - D-E9 A: a new dated verification-log entry; older entries are not edited.
  - D-E10 A: tests-first commits in the pull request.
  - D-E11 A: `onlyTenants` still applies after the tenant limit, and `complete` stays honest through the unfiltered count. Follow-up.
  - D-E12 A: one exact-name lookup can pass the call cap, so a run makes at most `maxProviderCalls + 1` calls. Follow-up.

### Pending owner confirmation: Nov 1 runbook (coordinator defaults, 2026-10-28)

**Status:** Coordinator defaults for the [Nov 1 runbook](../runbooks/2026-11-01-preview-deploy.md), standing goal item 6, pending owner confirmation. The runbook is prepared and dry-run only. Every live step on Nov 1 is the owner's own, after a go given at the time, under the external-action rule below.

Build-time defaults, applied to the prepared scripts:

- **D10 (a): step 9 evidence by tree equality.** The deployed SHA's tree must equal the tree of the green pull request run's test merge commit, because the repository merges with merge commits and the integration, browser, and console-browser jobs run only on pull requests. Adding `workflow_dispatch` (D10 (b)) is the only route to a run on the exact SHA, after #26 releases `ci.yml`.
- **D12 (a): the upgrade is proven by a CI test only.** This narrows the hosting plan's rule "Test each migration on a production-shaped Neon branch" ([08](08-build-hosting-and-operations.md#database-migration-and-rollback-policy)) for Nov 1: `migrate-upgrade.integration.test.ts` applies 0001 and 0002, a b87e269-era seed, and the b87e269 query set, then migrates to the tree's last file on PostgreSQL 17. A 10-minute copy-on-write Neon branch (D12 (b)) stays an option if that test surprises.
- **D13 (a): the runbook lives in `docs/runbooks/`,** outside the numbered authority documents.
- **D14 (a): `SEED_DEMO_BOOKINGS` stays off on Neon main.**

Run-time decisions, each asked as a go/no-go prompt at its step with the default shown: D1 (a) Neon main as the preview database; D2 (b) the release SHA frozen on Oct 31 with #32, with #26 an owner call; D3 (a) fake payments on the public preview from P3 to the end of P9; D4 (a) a third Access-allowed address owning demo-harbor only; D5 (b) pause the `*/15` cron between windows; D6 (a) a subdomain sender; D7 (a) a Stripe-live window after acceptance; D8 (a) the cutover after a clean acceptance, to demo-harbor; D9 (a) accept one database connection per GuestGateway call for owner-only traffic, with Cloudflare for SaaS deferred; D11 (a) no external human review for synthetic test mode, with (b) kept for the Core live gate; D15 (a) accept inline, signature-only webhook processing for the test-mode window; D16 (a) the existing `sk_test_` key unless `rk_test_` is confirmed to act through `Stripe-Account`.

### Pending owner confirmation: G2.16a email adapter (coordinator defaults, 2026-10-28)

**Status:** Coordinator defaults for G2.16a, the Cloudflare Email Service adapter, pending owner confirmation. The owner's standing goal of 2026-10-28 said "go, include the Stripe and email adapters" and did not answer the goal packet's decisions. They bind the demo build only, and only until the owner confirms or replaces them. The full list, with the reasons, is the [email adapter narrowing](12-demo-build-plan.md#goal-sequence) in the demo build plan. The adapter stays off in every deployed configuration; switching it on is a separately authorized operational goal, G2.16-live (proposed), under the external-action rule below.

- **D1 B: at most once without provider idempotency.** Cloudflare Email Service documents no idempotency key. On a provider that does not say it deduplicates (an unset flag counts as not), a lapsed lease and an attempt whose outcome is unknown fail as `outcome_unknown` and are never sent again. This keeps the [product scope](02-product-scope.md)'s rule that a retry cannot send the same message twice through one channel, so it needs no exception. Residual cost: a guest can miss an email; a new management link, a waiver's audited resend, and staff resend (G2.16b) are the recovery. `E_INTERNAL_SERVER_ERROR` and `E_DELIVERY_FAILED` count as unknown outcomes. The provider page lists "SMTP delivery failure, recipient server rejection" as `E_DELIVERY_FAILED`'s common causes, which points toward Rejected; it stays ambiguous, the side that never sends twice, and G2.16-live revisits it.
- **D2 B: an account-level fault stops the run and the sweep,** as an account-level refusal stops the hostname sweep. A rate limit is not one: Cloudflare limits per account, domain, and recipient under one code, so a rate-limited message retries on its own and the run goes on.
- **D3 B: the recipient fence is a Wrangler secret, `EMAIL_ALLOWED_RECIPIENTS`,** and the binding carries `allowed_sender_addresses` only. Reason: a destination list in the committed `wrangler.jsonc` would put owner addresses in the repository.
- **D6 A: the email fake only in local development,** and never beside an `EMAIL` binding. Reason: the fake stores full bodies, raw access-link tokens included, so a deployed database must never hold its rows. This replaces "refused in a production configuration" and gives up the proposed preview route of the mailbox behind Cloudflare Access.
- **Also taken by default:** the allowlist decides the queued backlog at switch-on (D4 A); the message id travels as the `X-TideGrid-Message-Id` header (D5 A); specific failure codes in staff reads (D7 A); and the defensive security reviewer runs for this goal (D8).
- **Open for the pilot gate, not decided here:** post-acceptance bounces are not ingested, so `sent` means accepted, which the Core live gate's "silent message failure" item blocks; Cloudflare keeps recipient addresses in its suppression list and Activity log, so the provider's US data, deletion, export and audit support is revalidated with the provider choice below; and suppression is shared by every tenant on the one TideGrid sending domain.

### Pending owner confirmation: G2.12d manual booking narrowings (coordinator defaults, 2026-10-28)

**Status:** Coordinator defaults for G2.12d, manual staff booking, pending owner confirmation. The owner said "keep going, G2.12 manual staff booking, merge when green" and did not answer the goal packet's decisions one by one. They bind the demo build only, and only until the owner confirms or replaces them. The full list, with the reasons, is the [manual booking narrowing](12-demo-build-plan.md#goal-sequence) in the demo build plan.

- **D1: what "manual booking" means in the demo.** Staff-assisted only: an owner or booking staff member books a guest who phoned, emailed, or walked up, and the payment goes through the payment shim's test control and its verified event, like a guest's. Cash, check, and other external tender (G2.10), complimentary bookings, and imported or OTA records stay open. This narrows the [product scope](02-product-scope.md)'s staff booking list. Reason: every other kind relaxes the chain of custody, under which a booking confirms only from a verified payment event.
- **D2: no overrides.** Staff follow the guest's sales rules: no booking after the cutoff, on a closed trip, or past capacity, and no price override. This narrows the product scope's owner or manager override with a reason. Reason: an override changes the capacity hold trigger, the most reviewed rule in the build.
- **D3: the booker's email is required.** Staff read it back to the guest and attest that they did. The confirmation, the management link, and waiver requests go to it. Residual risk: a mistyped address sends the management link to a stranger, and staff cannot correct it after booking.
- **D5: the policy is staff-attested.** Staff tell the guest the policy of the quote's version and check a box saying so; the audit row records it as staff-attested. The guest first sees the policy text in the confirmation email. This narrows the product scope's rule that the guest sees and accepts the policy before payment. The accepted version is still snapshotted on the booking.
- **D7: the day's CSV gains a Source column.** `Source` (`direct` or `staff_assisted`) follows Generated at, before the booker's columns. A contract change to columns the product scope calls stable; every earlier column keeps its place.
- **D10: the console's browser proof runs in CI.** A console browser job of its own runs the journey at 375 and 1280 on both synthetic operators, under the console Worker's CSP, against a disposable PostgreSQL 17.
- **Also taken by default:** a channel column (phone, email, or walk-up; D4), participants named by the guest through the management link (D6), a limit of three open checkouts per staff member (D8), the confirmation email unchanged (D9), one combined independent review on the stronger configuration plus a UI review (D11), merge when green covering migration `0012` once the review is accepted (D12), one promotion code and no manual discount (D13), the staff member's name on a booking visible to every role that reads it, finance included (D14), and no staff bookings in the demo seed (D15).

### Pending owner confirmation: Stripe adapter (coordinator defaults, 2026-10-28)

**Status:** Coordinator defaults for the Stripe adapter, standing goal item 3, pending owner confirmation. The owner's standing goal of 2026-10-28 said "go, include the Stripe and email adapters" and did not answer the goal packet's decisions. They bind the demo build only, and only until the owner confirms or replaces them. The full list, with the reasons, is the [Stripe adapter narrowing](12-demo-build-plan.md#goal-sequence) in the demo build plan. The adapter stays off in every deployed configuration; Stripe-live, with real test-mode calls, needs the owner's inputs and approval under the external-action rule below.

- **D1 (a): local first.** The adapter, its recorded-shape fixture, and the API wiring are built and tested with no Stripe account, call, CLI, or install. The wiring is off.
- **D2 (a): Stripe redelivery dedupe by a canonical projection hash** that leaves out `pending_webhooks` and `request`, in the adapter. No inbox or finalize change.
- **D3 (a): refunds are looked up by key before they are created,** and a pending refund is an unknown outcome. This defers the [product scope](02-product-scope.md)'s pending, succeeded, and failed refund states and its actionable failed side effects to G2.9. Known risk: refunds stuck pending, and refunds whose lookup is refused for good (an account or payment id that no longer matches), stay requested and can fill the front of each sweep batch, with no word to the guest or the operator; fair ordering and an exception after some hours that covers both are proposed G2.9 follow-ups. Cross-tenant fair ordering and a per-run attempted set landed in pull request 32 (0013). A stuck refund is still retried first each run at one provider call. The exception after some hours stays a G2.9 follow-up.
- **D4 (a): no `cancelPayment` on the port** until G2.9 or G2.10. A late success on an intent that could have been canceled is refunded, and the operator loses its processing fee.
- **D5 (a) card only; D6 (a) PaymentIntents; D7 (a) `fetch` and hand parsers, no SDK.**
- **D8 (a): live keys and live events refused everywhere** until the Core live gate, and test keys refused in production. This adds a production refusal for the Stripe adapter like the fake's. Both fail closed: a test key and the fake run only when `ENVIRONMENT` is `local`, `preview`, or `staging`, and anything else, unset included, is refused as `environment_unknown`.
- **D9 (a): staff bookings stay on the shim.** Under Stripe the staff test payment answers 404, and a staff checkout opens an intent nothing can pay until a follow-up.
- **D10 (a) one webhook secret; D11 (a) API version `2026-09-30.endive` pinned; D12 (a) a restricted `rk_test_` key.** Open for the live step: whether a restricted key may act through `Stripe-Account`.
- **Also taken by default:** configuration and account error codes (13 from Stripe's list), six transient codes ([the adapter's error table](../../packages/domain-payments/README.md#errors)), a 401, a 403, and any refused refund lookup never settle a refund as failed; G2.7's Stripe proof line is met for Stripe-local by the CI integration suite over the recorded fixture, and for Stripe-live by a sandbox replay after the owner's approval; the adapter lives in `packages/domain-payments`, narrowing the [hosting plan](08-build-hosting-and-operations.md)'s proposed `provider-*/` layout for the demo.

### Pending owner confirmation: G2.14b demo narrowings (coordinator defaults, 2026-10-27)

**Status:** Coordinator defaults for the G2.14b local-first pass, pending owner confirmation. They bind the demo build only, and only until the owner confirms or replaces them. The full list, with the reasons, is the [hostnames and PWA narrowing](12-demo-build-plan.md#goal-sequence) in the demo build plan.

- **Tenant selection by verified Origin.** In the demo, the API selects the public experience from the browser Origin through one strict origin parser and an active, verified hostname, and the guest page loads its own bootstrap. The [target architecture](04-architecture.md)'s short-lived scoped token issued by a guest Worker is not built for the demo.
- **Hostname ownership.** Hostnames live in `tenant_hostnames` and its provisioning table, not in the brand configuration version.
- **Generated icons.** The guest Worker composes PWA icons from the published brand, with no approved asset hash in the tenant manifest.
- **Unsigned in-isolate projection.** The hosting plan's "signed, short-lived projection" is read as applying to a cache that crosses a process, network, or storage boundary. The demo's CORS projection stays in one isolate's memory for at most 30 seconds and is not signed; preflights and simple requests share it and its per-address limiter. A shared cache needs the signature. Consequence: a host just disabled can keep its CORS grant in one isolate for up to 30 seconds, though its data routes answer the shared 404 at once. That relaxes the goal packet's test invariant that a disabled host's origin never gets a CORS grant except on the bootstrap.
- **Only a definitive negative demotes an active custom hostname.** The hosting plan says unknown, inactive, moved, and validation-pending hostnames fail closed ([08](08-build-hosting-and-operations.md)). For the demo, that holds for resolution and activation: an unknown, pending, or disabled hostname never resolves, and nothing activates without both provider states active. Once a hostname is active, the sweep disables it only on a definitive negative (ownership moved, blocked, or deleted, or a failed certificate); an unknown or pending reading, such as a renewing certificate or a status the mapping does not know, is recorded and keeps it serving. Reason: disabled is terminal and the name stays reserved, so a non-reading, such as a rotated token or a provider change, must never burn an operator's domain. Revisit with the owner before any operator domain.
- **Live cutover unchanged.** The `demo.tidegrid.us` cutover stays a G2.14b-live acceptance item, run as a separately authorized operational step under the external-action rule below.

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
