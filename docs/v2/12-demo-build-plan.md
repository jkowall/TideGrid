# TideGrid demo build plan

**Status:** Authorized demo build baseline (see the [decision register, 2026-09-20](06-decision-register.md#2026-09-20)); not a production build and not evidence for any [gate](05-roadmap-validation.md#gates)

This plan is the canonical scope, sequence, and acceptance for the demo-grade Core build. The [build execution and agent plan](10-build-execution-and-agent-plan.md) defines the method. The [target architecture](04-architecture.md), [product scope](02-product-scope.md), and [hosting plan](08-build-hosting-and-operations.md) remain the design authority; where this plan narrows them for the demo, it says so.

## What this build is

A real implementation of the Core booking happy path, on the target stack, with synthetic tenants and data, deployable to Cloudflare, that a guest can use end to end and an operator can watch from the console. It is demo-oriented in what it leaves out, not in how it is built. Code written here is intended to survive into the pilot.

Boundaries:

- Synthetic tenants and data only. No customer data, no real guest details, no pilot agreement.
- Stripe in test mode with test connected accounts. No live charges. Since 2026-10-05 the demo runs a fake payment provider instead (see the [payment narrowing](#goal-sequence)).
- No Twilio and no SMS. Transactional SMS remains a Staged Core module and is out of scope.
- No production Cloudflare account, no production Neon project, no live custom hostname on an operator's domain.
- Nothing here passes the Core live gate. It produces the code that will be taken through that gate later.

## Provider and environment choices

| Layer | Demo choice | Note |
|---|---|---|
| Repository | This repository, pnpm monorepo at the root | `prototypes/guest-flow` stays until the guest PWA replaces the public demo, then is deleted in a reviewed change |
| Runtime | Cloudflare Workers on the existing account, Workers Paid | Hyperdrive requires Workers Paid |
| API | TypeScript and Hono on a Worker | One modular monolith, one versioned API |
| Data access | Kysely over the postgres.js driver, with reviewed SQL migrations | postgres.js is ESM and runs in Workers and Node; node-postgres could not be bundled for the Workers test runtime. Migrations are hand-written SQL applied by a repo script |
| Database | PostgreSQL 17 on a Neon nonproduction project, through Hyperdrive with query caching disabled | Direct, unpooled Neon endpoint behind Hyperdrive; one branch per pull request, one long-lived staging branch. The Hyperdrive binding is in place since September 22; the `DATABASE_URL` secret remains the fallback |
| Guest web | React and Vite PWA on Workers Static Assets | One build serves every tenant from server-provided brand configuration |
| Operator web | React and Vite on a separate Workers Static Assets deployment | Different CSP and release cadence from the guest surface |
| Contracts | Zod schemas generating OpenAPI, shared through `packages/contracts` | Generated client for both web apps |
| Email | Cloudflare Email Service behind the provider-neutral email adapter | Sender domain on `tidegrid.us`; guest email is branded per tenant in content, sent from a TideGrid-controlled address during the demo |
| Operator sign-in | Cloudflare Access on deployed environments; built-in magic link for local and as fallback | Both resolve to the same principal and tenant role mapping. Access is the perimeter, the application still checks tenant and role. The console calls the API same-origin under `/api`, forwarded by the console Worker to the API's `ConsoleGateway` entrypoint over a service binding. Staff and sign-in routes answer only there, so on deployed environments both sign-in paths sit inside the Access perimeter; the public `api.tidegrid.us` entry answers them with 404, and the API has no workers.dev or preview URLs. Deployed environments cannot deliver magic links until transactional email lands in G2.16 |
| Guest access | Accountless, short-lived, single-purpose links and tokens | As the architecture requires |
| Payments | Stripe Connect direct charges in test mode, Stripe-hosted or embedded payment element | Operator remains merchant of record; test connected account per synthetic tenant. The demo runs a fake provider behind the same adapter until a Stripe adapter replaces it ([payment narrowing](#goal-sequence)) |
| Async work | Idempotency keys and a PostgreSQL outbox table from the first migration; a cron-triggered sweep on the API Worker for hold expiry and outbox delivery | Cloudflare Queues and a dedicated async Worker are deferred with G2.3 |
| Object storage | Private R2 bucket | Needed from G2.15 for waiver evidence |
| Infrastructure as code | Wrangler configuration checked in; no Terraform for the demo | Terraform enters with the pilot readiness gate |
| CI | GitHub Actions: typecheck, lint, unit, integration against a Neon branch, browser journeys | Preview deploys per pull request |
| Telemetry | Workers Logs plus structured request logs with tenant and request identifiers; OpenTelemetry export destination open | Attribute naming follows OpenTelemetry semantic conventions |

Hostnames on `tidegrid.us`:

- `api.tidegrid.us` for the API Worker.
- `console.tidegrid.us` for the operator console, behind Cloudflare Access.
- `<tenant>.book.tidegrid.us` as the preview subdomain pattern for synthetic tenants. Customer-owned hostnames through Cloudflare for SaaS are configured and tested in G2.14 but no operator domain is attached during the demo.
- `demo.tidegrid.us` keeps serving the throwaway prototype until the guest PWA is accepted, then points at the PWA for the first synthetic tenant.

## Repository shape

The subset of the [proposed repository shape](08-build-hosting-and-operations.md#proposed-repository-shape) that the demo needs:

```text
apps/
  api-worker/         HTTP API, Stripe callbacks, cron sweep
  guest-site/         guest PWA and hostname bootstrap
  operator-site/      operator console
packages/
  contracts/          Zod schemas, generated OpenAPI and client
  database/           Kysely types, migrations, migration runner, seed
  domain-identity/    staff roles and permissions, memberships, hostname normalization, audit history
  domain-catalog/     products, boats, scheduled trips, availability
  domain-pricing/     price lists, add-ons, fees, taxes, promotion codes, policies, quotes (G2.5)
  domain-inventory/   seat and whole-boat capacity, holds, the expiry sweep (G2.6)
  domain-booking/     checkout, booking, order
  domain-payments/    Stripe direct charge, inbox, reconciliation seams
  domain-waivers/     enters at G2.15
  domain-messaging/   email adapter and templates, enters at G2.16
  design-system/      tokens, fonts, components, brand input schema
  tenant-config/      tenant and brand configuration, hostname mapping
  observability/      logging, request context, redaction
config/
  tenants/            synthetic tenant manifests
tools/
  seed/               deterministic synthetic data
```

`prototypes/`, `docs/`, `database/` (V1), `api/` (V1), and `research/` are unchanged by the build until a reviewed change retires them.

## Design direction

The prototype was built to test workflow comprehension, not to be good. The demo build replaces its visual system. The identity inputs are the ones the archived brand strategy selected; they are inputs, not a naming decision, and the tenant brand always wins on guest surfaces.

**Tokens.** TideGrid palette: Deep Forest `#0E2B1F`, Pine Green `#143F2E`, Tide Lime `#A7D129`, Mist `#E8ECE8`, Foam `#F6F7F6`, Harbor `#1A1F1D`. Functional status colors stay separate from the brand palette and are paired with an icon and a label: ready `#2E7D32`, warning `#9A5200`, blocked `#B42318`, information `#00639B`, pending `#6941C6`, with their light-surface variants for dark backgrounds. Tide Lime is an accent for rules, marks, selection, and calls to action on dark surfaces. It is never body text on a light surface.

**Type.** Sora for display and headings, Inter for interface text, self-hosted from `packages/design-system` so the CSP stays self-only. A type scale of 12, 14, 16, 18, 22, 28, 36, 48 with line lengths capped near 65 characters.

**Guest surface.** Light-led: Foam page, Mist separators, Deep Forest text, the tenant's primary color for the single primary action on each screen. Per-tenant brand inputs are limited to what `BrandConfigVersion` allows: logo, primary and accent color (validated for contrast), display and body font from a supported set, and copy. Tenant content cannot inject markup or style.

**Operator console.** Dark shell as the theme board shows: Deep Forest navigation rail, Harbor content surface, Mist for data grouping, Tide Lime for selected scope and ready states. Dense but legible; a calendar and a booking list are the two anchor screens.

**Rules that fix the prototype's weaknesses.** One primary action per screen. Body text no smaller than 14 CSS pixels; eyebrows and captions no smaller than 12. Touch targets at least 44 by 44. Visible focus on everything interactive. Loading, empty, error, and success states designed, not improvised. No status by color alone. Reduced motion respected. WCAG 2.2 AA as the floor. The lead designs and builds the design system and the first core screens, inspects them in the browser at 375 and desktop widths, and takes a fresh UI review before delegating pattern extensions.

## Goal sequence

Goal identifiers keep the [goal map](10-build-execution-and-agent-plan.md#goal-map) numbering so the demo work maps onto the Core live gate later. Each goal starts from a recorded integration commit, has an owner-set token budget, and ends with a handoff and an independent review. Routes name the roles in the active execution route of the [build execution and agent plan](10-build-execution-and-agent-plan.md#claude-code-execution-route).

| Order | Goal | Outcome for the demo | Route | Proof |
|---|---|---|---|---|
| 1 | G2.1 Workspace foundation | pnpm workspace, pinned toolchain, `packages/contracts` generation, migration runner, seed, environment files, CI, one deployable hello Worker and two static sites | Lead; routine implementer for CI and lint configuration | Clean bootstrap on a fresh clone: install, typecheck, migrate against a Neon branch, seed, test, deploy preview |
| 2 | G2.2 Tenant access and audit | Tenants, hostname mapping, request context, the pilot roles (owner, booking staff, read-only finance), forced row-level security, append-only audit, idempotency table, outbox table; Cloudflare Access JWT verification and magic-link session. Support access (time-bound, reason-bound, masked) is deferred to the first goal that needs it | Lead at high effort; independent reviewer plus security reviewer | Two-tenant escape tests on every query path; role-denial tests; replayed idempotency key returns the first result |
| 3 | G2.4 Catalog and schedule | Products, boats, scheduled trips with local time and IANA zone, recurring schedules, blackouts, cutoffs, sales states, availability query | Lead for invariants; routine implementer for recurrence expansion against the accepted contract | Schedule-boundary, DST, cutoff, and availability tests |
| 3, parallel | G2.14a Design system and brand bootstrap | `packages/design-system` tokens, fonts, components with states; guest shell that loads a tenant's brand configuration by hostname; operator shell | Lead as UI lead; UI reviewer on the shells | Two synthetic brands render from configuration; contrast and focus checks pass. Status 2026-09-30: built and verified locally on its goal branch ([verification log](../verification-log.md#g214a-design-system-and-brand-bootstrap-verification-september-30-2026)); code and UI review fixes applied; merges after G2.4, with its migration renumbered |
| 3, after G2.14a | G2.11a and G2.12a trips slice (owner-requested on 2026-10-05) | The first, thinnest pieces of G2.11 and G2.12, pulled forward so the demo can be tested end to end. Guest: upcoming trips on each branded site, four weeks at a time for a party size, grouped by the marina's local date, with no booking or checkout. Console: a week calendar of the selected operator's trips; owners and booking staff publish, close, reopen, cancel, and complete trips, each change with a reason and an idempotency key, and finance can only look. Uses the G2.4 catalog API unchanged. G2.11 and G2.12 keep their full scope | Lead as UI lead; UI reviewer and independent reviewer | Unit tests for grouping by local date, party changes, empty and error states, role gating, the reason requirement, the idempotency header, and the 409 codes. Browser walkthrough at 375 and 1280 on production builds under their content security policies, including the Nov 1 to 7, 2026 week and a close and reopen seen from the guest side. Status 2026-10-05: built and verified locally on its goal branch; the independent and UI reviews accepted it with fixes, and the fixes were verified on the same branch ([verification log](../verification-log.md#g211a-and-g212a-trips-slice-verification-october-5-2026)) |
| 6, after G2.7 and the trips slice | G2.11b Minimal guest checkout (pulled forward on 2026-10-06) | The second thin piece of G2.11, so the owner can make the first test booking end to end. On each branded site, a trip's Book link opens its checkout: tickets per type or a charter's guests and paid extras; the server's itemized quote with one promotion code and its expiry; the booker's name and email and the policy version accepted; the payment shim's test payment, which says that no real card is charged; and a confirmation with the booking reference only once the checkout's own state is confirmed. Declined, expired, refunded (unfulfilled), and canceled checkouts and the API's errors each have a designed screen. Uses the G2.5 and G2.7 APIs unchanged. Participants, the management link, receipts, email, and cancellation stay with G2.11 | Lead as UI lead; routine implementer for unit tests; UI reviewer and independent reviewer | Unit tests for every step and state, the idempotency keys and their reuse, polling to each outcome, a reload at each step, and no secret or personal data in an address. Browser journeys at 375 and 1280 for both brands on a throwaway branch with the fake provider: a shared-seat booking with a promotion code, a private charter, a declined payment then a successful retry, and an expired and an abandoned checkout, each confirmed in the database and the console. Status 2026-10-06: built and verified locally on its goal branch from `integrate/demo-checkout`, which merges the trips slice into the G2.7 branch and now G2.7's reviewed tip; the code and UI reviews accepted it with fixes, and the fixes were verified on the same branch with a second browser pass ([verification log](../verification-log.md#g211b-minimal-guest-checkout-verification-october-6-2026)) |
| 4 | G2.5 Pricing, add-ons, fees, and policies | Ticket and charter prices, paid add-ons, taxes, mandatory fees, one promotion code, versioned policies, immutable quote snapshot | Lead at high effort; test specialist | Quote snapshot, eligibility, tax, discount, and policy-version tests. Status 2026-10-05: built and verified locally on its goal branch ([verification log](../verification-log.md#g25-pricing-add-ons-fees-and-policies-verification-october-5-2026)); the independent review accepted it with listed fixes, which are applied. Quotes live in `packages/domain-pricing`; checkout and the order in `domain-booking` build on them |
| 5 | G2.6 Capacity and holds | Seat and whole-boat capacity, atomic holds with expiry, confirmation transitions, cron sweep releasing expired holds | Lead at high effort; test specialist for races; independent reviewer | Concurrent final-seat and whole-boat races against PostgreSQL show no oversell. Status 2026-10-05: built and verified locally on its goal branch ([verification log](../verification-log.md#g26-capacity-and-holds-verification-october-5-2026)), with the contract in [packages/domain-inventory](../../packages/domain-inventory/README.md); the independent review accepted it with listed fixes, which are applied. The boat rule stays at scheduling time, as narrowed above. Its migration is 0006, after G2.5's 0005 |
| 6 | G2.7 Charge to confirmation | Checkout session, immutable order, Stripe direct charge on a test connected account, signed webhook through the inbox, booking confirmation, safe hold release, late-success handling | Lead at high effort; test specialist; independent reviewer on a second model | Success, failure, expiry, replay, and late-callback tests; Stripe CLI replay evidence. Status 2026-10-06: built and verified locally on its goal branch against the payment shim, as narrowed below, with shim replay evidence in place of Stripe CLI replay evidence ([verification log](../verification-log.md#g27-charge-to-confirmation-verification-october-6-2026)). The contract is in [packages/domain-booking](../../packages/domain-booking/README.md) and [packages/domain-payments](../../packages/domain-payments/README.md). Its migration is 0007, after G2.6's 0006. The independent review, on a second model, accepted it with listed fixes, which are applied |
| 7, parallel | G2.11 Guest booking journey and self-service | Discovery, trip detail, party and participants, checkout with the Stripe element, confirmation, accountless management link, receipt, cancellation within policy | Lead as UI lead; UI reviewer; routine implementer for pattern extensions | Browser journeys at 375 and desktop; link authorization tests; two-tenant link escape test |
| 7, parallel | G2.12 Operator console | Sign-in, calendar, search, booking detail, manual booking, roles, roster, notes, CSV export with control totals | Lead as UI lead; routine implementer against accepted components; UI reviewer | Staff journeys; role tests; export totals match the ledger |
| 8 | G2.14b Hostnames and PWA | Cloudflare for SaaS custom hostname flow with validation and fail-closed resolution, preview subdomains, PWA manifest and service worker, support pages, `demo.tidegrid.us` cutover | Lead; security reviewer on hostname resolution | Two-brand hostname and tenant-boundary tests; installability check; production-like preview deploy |
| 9 | G2.16 Transactional email | Cloudflare Email Service adapter, branded templates, outbox-driven delivery, delivery state, failure visibility, resend with audit | Lead; routine implementer for templates | Confirmation and retry deduplication; failure surfaces in the console |
| 10 | G2.15 Waiver evidence | Immutable templates, automatic assignment on confirmation, email verification and participant matching, participant and guardian signing, hashes, rendered PDF in R2, status | Lead at high effort; independent reviewer; security reviewer | Booking-source matrix, token replay and revocation, guardian, version, and evidence tests |

Deferred from the Core live gate list and not in the demo: G2.3 queues and DLQ (the outbox and cron sweep stand in), G2.8 deposits and balances, G2.9 refunds and credits, G2.10 external payment and reconciliation, G2.13 migration. Every Staged Core module and every G4 native goal is out of scope.

**Boat inventory in the demo (narrowing confirmed by the owner on 2026-10-01).** A boat runs one departure at a time, counting each trip's turnaround buffer, so a slot is scheduled either as shared seats or as a private charter, never offered both ways at once. The [product scope](02-product-scope.md#catalog-schedules-and-availability) says shared-seat and private inventory cannot overlap on an exclusive boat; the demo enforces that at scheduling time with a database constraint (G2.4). If operators need a slot offered either way until one sells, G2.6 moves the rule to booking time instead.

**Payments in the demo (narrowing decided by the owner on 2026-10-05).** The owner said: "You can just shim stripe or others." The demo therefore takes payments through a fake provider behind a provider-neutral payment adapter, and does not wait on Stripe accounts, keys, the Stripe CLI, or Stripe webhooks.

- The shim follows the path the real provider will: a signed HTTP webhook into the provider-event inbox, signature verified, deduplicated by provider event id, then processed. A booking confirms only through a verified payment-success event; no success screen, redirect, or client call marks anything paid.
- A Stripe adapter replaces the shim behind the same interface before any live booking. The shim is refused in a production configuration.
- The Stripe test account with Connect and the Stripe CLI move out of the demo's owner inputs below; the Stripe adapter needs them later.
- "Shim replay evidence" stands in for "Stripe CLI replay evidence" in G2.7's proof: a scripted run against `wrangler dev` that delivers, replays, and reorders signed events, with the state before and after each step.
- Demo acceptance step 2 pays through the shim's pay control until the Stripe adapter brings back the Stripe test card.

The adapter and the shim are in [packages/domain-payments](../../packages/domain-payments/README.md).

Parallel work runs only on accepted interfaces and disjoint paths: the design system beside the catalog after G2.2 is accepted, and the two UI goals beside each other after G2.7 is accepted. Coupled state transitions (holds, charge, confirmation, waiver assignment) keep one owner.

## Demo acceptance

The build is demo-complete when, on a preview deployment with two synthetic tenants:

1. A guest opens each tenant's preview hostname and sees that tenant's brand only.
2. The guest browses upcoming trips, picks a shared-seat trip and a private charter, adds participants, applies a promotion code, and pays with a Stripe test card (through the payment shim's pay control until the Stripe adapter lands, per the [payment narrowing](#goal-sequence)).
3. The confirmation email arrives, and the management link opens the booking without an account.
4. The guest cancels within policy and the console shows the change.
5. The operator signs in through Cloudflare Access, sees the booking on the calendar and in search, exports the day, and the totals match.
6. A concurrent last-seat test run against the deployment shows no oversell.
7. A signed-in operator of tenant A cannot reach any tenant B booking, link, search result, or export.
8. Waiver requests go out automatically after confirmation and a participant signs on a phone-width screen.
9. All checks run green in CI on a fresh Neon branch.

None of this is a gate. It is the point at which the code can be shown to an operator and taken toward the Core live gate when the [Validation gate](05-roadmap-validation.md#validation-gate) or the proposed Core pilot gate passes.

## Owner-provided inputs

These exist outside the repository and only the owner can create them. Values go into `wrangler` secrets and local `.dev.vars`, never into source.

| Input | Needed by | Detail |
|---|---|---|
| Neon nonproduction project | G2.1 | Project in the Neon account, PostgreSQL 17; a Neon API key for branch creation in CI, and the direct connection string for staging |
| Cloudflare Workers Paid and Hyperdrive | G2.1 | Confirm the plan on the existing account; an API token scoped to Workers, Hyperdrive, DNS for `tidegrid.us`, Access, and Email Service |
| Cloudflare Access application | G2.2 | Application for `console.tidegrid.us` with the owner's identity provider; the application audience tag |
| Cloudflare Email Service | G2.16 | Enabled on the account with `tidegrid.us` as an authenticated sender domain |
| Stripe test account with Connect | The Stripe adapter, before any live booking | Test-mode secret key, webhook signing secret, and one test connected account per synthetic tenant; Stripe CLI installed locally for webhook forwarding. Moved out of the demo's inputs by the 2026-10-05 [payment narrowing](#goal-sequence): G2.7 runs on the payment shim |
| Token budget per goal | Each goal | Set at goal start; the lead reports at the four checkpoints |
| Commit and pull request authorization | Each goal | One reviewed pull request per goal; merge is the owner's action |

Local tooling on the build machine: Node 24 and pnpm are present. Docker, the Stripe CLI, and `psql` are not installed; the Stripe CLI is needed for the Stripe adapter (no longer for G2.7, which runs on the payment shim) and `psql` is convenient for migrations.

## What this build does not prove

It does not prove demand, price acceptance, switching intent, or the delivery hours behind any setup price. It does not pass any gate. It produces a working system and the evidence needed to take that system through the Core live gate when a commercial gate passes.
