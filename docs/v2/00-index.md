# TideGrid V2 planning package

**Version:** 2.0 planning baseline
**Baseline:** September 2026 planning package. Per-document change history is in git.
**Status:** Canonical product and pilot plan; implementation remains gated by paid validation
**Market:** United States first

TideGrid V2 is a productized branded booking service for small passenger-vessel operators. Each operator receives one branded guest experience, with its boats managed inside that experience. TideGrid uses one multi-tenant product, one shared API, one source tree, and one release train.

This package replaces the V1 product direction for new planning work. It does not claim that TideGrid has committed funding, started the application build, signed a pilot, or validated willingness to pay.

## Reading order

1. [Pre-customer formation and validation plan](11-pre-customer-formation-and-validation.md)
2. [Customer validation deck, PowerPoint](../customer/TideGrid-Customer-Validation-Deck.pptx) or [PDF](../customer/TideGrid-Customer-Validation-Deck.pdf)
3. [Customer-facing validation brief](../customer/tidegrid-validation-brief.md)
4. [Internal operator validation guide](../customer/operator-validation-guide.md)
5. [Product strategy](01-product-strategy.md)
6. [Pilot product scope](02-product-scope.md)
7. [Commercial model](03-commercial-model.md)
8. [Company formation and costs](07-company-formation-and-costs.md)
9. [Target architecture](04-architecture.md)
10. [Build, hosting, and operations](08-build-hosting-and-operations.md)
11. [Native app factory and store submission](09-native-app-factory-and-store-submission.md)
12. [Build execution and agent plan](10-build-execution-and-agent-plan.md)
13. [Roadmap and validation](05-roadmap-validation.md)
14. [Decision register](06-decision-register.md)

## Product decisions

- Start with direct-first US operators with one to five boats, using dive charters as the initial discovery segment.
- Give every operator a branded PWA and custom domain. Sell a guest-facing iOS and Android pair as a premium add-on.
- Put all boats for one operator brand inside one app. Do not create a binary or code fork for each boat.
- Build every operator app from one Expo source line and a validated tenant manifest. Each operator owns its organization developer accounts and published identity.
- Prepare and upload Apple releases through delegated access, but require the operator's authorized representative to perform the final App Review submission under Apple's current commercial-template rule.
- Keep the operator as merchant of record. TideGrid owns the booking and payment-management experience through Stripe Connect direct charges. Pilot pricing also requires Stripe to set and collect processing fees and accept connected-account negative-balance loss; merchant-of-record status alone is insufficient. The [commercial model](03-commercial-model.md#payment-economics) and [architecture](04-architecture.md#payments-and-tips) hold the required Stripe configuration.
- Include shared-seat and private-charter booking, deposits, customer self-service, native waivers, transactional email and SMS, pooled equipment, advisory marine conditions, tipping, and named-customer trip-count and dollar trip cards in the paid pilot.
- Split production readiness into three gates: the Core live gate before an operator's first real booking, Staged Core modules (transactional SMS and replies, pooled equipment, marine conditions and operator-directed disruptions, tips, trip cards) that an operator may enable after each passes its own acceptance, and the Native pilot gate for the operator-owned iOS and Android apps. Each pilot operator passes all three before the pilot cohort review counts as complete, and pilot operators may use staging builds during development; see [Gates](05-roadmap-validation.md#gates).
- Exclude medical and certification review, points, anonymous or transferable gift cards, serialized equipment, crew and vessel operations, offline departure workflows, marketing campaigns, and live OTA synchronization.

## Company and delivery decisions

- Approve the validation materials, resolve the private filing inputs, and form a bare-bones single-member, member-managed Florida LLC owned 100% by TideGrid's sole founder before the next operator outreach. Formation does not count as demand evidence or authorize contracts, deposits, production accounts, live data, or the production build.
- Follow the interview, written-commitment, and paid-pilot readiness sequence in [Gates](05-roadmap-validation.md#gates) before accepting deposits or signing recurring contracts.
- Operate TideGrid through the pilot with one human owner; attorneys, accountants, contractors, vendors, automated coding agents, and pilot operators receive no ownership, governance, or independent commercial authority, as recorded in the [decision register](06-decision-register.md#v2-product-and-commercial-decisions) and the [company formation plan](07-company-formation-and-costs.md#company-and-ownership).
- Reconsider a Delaware C corporation only when institutional financing, preferred stock, or a formal employee option plan becomes a near-term requirement.
- If paid validation passes, use one TypeScript monorepo, shared Cloudflare deployments, PostgreSQL on Neon as business truth, private R2 storage, and a PostgreSQL outbox with recoverable queue delivery.
- Require customer-owned booking subdomains during the pilot. Apex domains are custom work because the proposed Cloudflare path does not include apex proxying on self-service plans.
- Treat the $4,500 Native setup price and 22-hour ceiling as provisional until one public-store launch is reproduced for a second operator without source changes.
- Execute the build as bounded, roadmap-aligned goals with explicit token budgets, disjoint subagent path ownership, independent review, and durable contract and test handoffs. Do not put Stages 2 through 5 into one goal run.
- Run each difficult build slice with one hands-on lead that owns contracts, critical code, and integration, followed by a fresh independent review; add specialists only for independent work. Set an explicit effort level and token budget per goal, and measure accepted-slice cost and owner effort before claiming savings. Tool and model selection lives only in the [build execution and agent plan](10-build-execution-and-agent-plan.md).
- Keep original UI design, implementation, and visual refinement across web and native with the same hands-on lead. Delegate UI extensions only after the visual and interaction patterns are accepted.

## Commercial decisions

| Offer | Setup | Recurring | Commitment |
|---|---:|---:|---:|
| Booking Core, self-setup | $0 | $149/month + 1.5% of net managed booking value | 12 months; $3,000 annual minimum |
| Managed Launch | $1,000 | None | Optional |
| Native add-on | $4,500 | $399/month + 0.25% | 12 months |
| Pilot Native offer | $2,250 | Full recurring price | First three qualified pilot operators only |

Stripe processing, app-store memberships, domains, Twilio registration, numbers, carrier fees, and message usage pass through at cost. [Commercial model](03-commercial-model.md) defines the fee base and setup boundaries.

## Evidence state

The repository contains one operator interview. It supports the problem of disconnected booking, payment, waiver, customer, and equipment records. It does not validate the complete feature set, price, native-app demand, or switching commitment.

The bare-bones Florida entity is administrative preparation and is not commercial proof. The next commercial proof is three paid pilot operators across at least two operator types, reached through the interview, commitment, readiness, and payment sequence in [Gates](05-roadmap-validation.md#gates). Pilot status creates no equity, governance, profit-share, intellectual-property, or control right; the [decision register](06-decision-register.md#v2-product-and-commercial-decisions) and the [company formation plan](07-company-formation-and-costs.md#company-and-ownership) hold the canonical statement.

Native scalability remains a hypothesis. The pilot cohort must prove both store-policy acceptance and a low-touch release factory. A successful binary build or internal-store upload is not enough.

## Glossary

| Term | Meaning |
|---|---|
| Trip card | Customer-facing name for a named-customer stored-value card. Every trip card is either a trip-count card or a dollar card. |
| Trip-count card | A trip card that holds whole trip units for eligible products. |
| Dollar card | A trip card that holds USD value in cents, including purchased, cancellation, and promotional value. |
| `PackageAccount` | Internal aggregate behind a trip-count card: tenant-scoped, owned by a known customer, with an append-only unit ledger. |
| `CreditAccount` | Internal aggregate behind a dollar card: USD-denominated, tenant-scoped, owned by one verified customer, with an append-only ledger. |
| `TripCard` | Internal facade that identifies exactly one `PackageAccount` or `CreditAccount`. Its denomination is immutable. |
| Package unit | One whole trip unit held, redeemed, released, or restored on a `PackageAccount` ledger. |
| Credit lot | A source lot of dollar value on a `CreditAccount` that keeps its own eligibility, validity, payment or issue reference, and fee provenance. |
| Roster | The operator booking-management view for one departure. It is not a manifest, check-in, or boarding record. |
| Staged Core module | A Core module (transactional SMS and replies, pooled equipment, marine conditions and operator-directed disruptions, tips, trip cards) that an operator may enable at or after its Core live gate once the module passes its own acceptance. All are required for pilot completion. |
| Core live gate | The acceptance an operator passes before taking its first real booking; see [Core live gate](05-roadmap-validation.md#core-live-gate). |
| Native pilot gate | The acceptance for the operator-owned iOS and Android apps, push, deep links, and native guest journeys. It gates the Native add-on for that operator and does not block the PWA; see [Native pilot gate](05-roadmap-validation.md#native-pilot-gate). |

## Authority and historical artifacts

Use this order when documents conflict:

1. V2 decision register
2. V2 numbered documents
3. V1 ADRs that the V2 decision register retains
4. V1 specification, schema, API, diagrams, and tests as historical design evidence
5. Source prompts and research notes

The following artifacts remain useful but do not define V2 scope:

- [V1 design package](../v1/README.md)
- [V1 specification](../v1/spec/00-index.md)
- [V1 ADR catalog](../v1/adr/README.md)
- [V1 PostgreSQL schema](../../database/schema.sql)
- [V1 OpenAPI contract](../../api/openapi.yaml)
- [V1 diagrams](../v1/diagrams/README.md)
- [Archived source prompts and brand strategy](../archive/README.md)
- [Primary-source register](../../research/source-register.md)

Do not update the V1 schema, API, or generated implementation artifacts until the [Validation gate](05-roadmap-validation.md#validation-gate) passes and V2 contracts receive their own implementation review.
