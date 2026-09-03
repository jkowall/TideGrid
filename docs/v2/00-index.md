# TideGrid V2 planning package

**Version:** 2.0 planning baseline
**Date:** September 4, 2026
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
- Keep the operator as merchant of record. TideGrid owns the booking and payment-management experience through Stripe Connect direct charges. Pilot pricing also requires Stripe to set and collect processing fees and accept connected-account negative-balance loss; merchant-of-record status alone is insufficient.
- Include shared-seat and private-charter booking, deposits, customer self-service, native waivers, transactional email and SMS, pooled equipment, advisory weather, tipping, and fixed-unit trip packages in the paid pilot.
- Require all selected capabilities to pass acceptance before the first production pilot. Pilot operators may use staging builds during development.
- Exclude medical and certification review, points, gift cards, serialized equipment, crew and vessel operations, offline departure workflows, marketing campaigns, and live OTA synchronization.

## Company and delivery decisions

- Approve the validation materials, resolve the private filing inputs, and form a bare-bones single-member, member-managed Florida LLC owned 100% by TideGrid's sole founder before the next operator outreach. Formation does not count as demand evidence or authorize contracts, deposits, production accounts, live data, or the production build.
- After the 12-interview gate yields at least five direct-first prospects and three written conditional pilot-operator commitments across at least two operator types, fund and complete the separate legal, insurance, payment, messaging, continuity, and account-readiness gate before accepting deposits or signing recurring contracts.
- Operate TideGrid through the pilot with one human owner and no cofounders or equity partners. Attorneys, accountants, contractors, vendors, and Codex agents can perform scoped work but receive no ownership, governance, or independent commercial authority.
- Reconsider a Delaware C corporation only when institutional financing, preferred stock, or a formal employee option plan becomes a near-term requirement.
- If paid validation passes, use one TypeScript monorepo, shared Cloudflare deployments, PostgreSQL on Neon as business truth, private R2 storage, and a PostgreSQL outbox with recoverable queue delivery.
- Require customer-owned booking subdomains during the pilot. Apex domains are custom work because the proposed Cloudflare path does not include apex proxying on self-service plans.
- Treat the $4,500 Native setup price and 22-hour ceiling as provisional until one public-store launch is reproduced for a second operator without source changes.
- Execute the build as bounded, roadmap-aligned goals with explicit token budgets, disjoint subagent path ownership, independent review, and durable contract and test handoffs. Do not put Stages 2 through 5 into one goal run.

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

The bare-bones Florida entity is administrative preparation and is not commercial proof. The next commercial proof is three paid pilot operators across at least two operator types. TideGrid must pass the 12-interview and direct-first-profile gate, obtain three qualifying written conditional commitments across that mix, complete paid-pilot readiness, and then collect all three setup payments and signed recurring agreements before starting the full production build. Pilot status creates no equity, governance, profit-sharing, intellectual-property, or company-control right.

Native scalability remains a hypothesis. The pilot cohort must prove both store-policy acceptance and a low-touch release factory. A successful binary build or internal-store upload is not enough.

## Authority and historical artifacts

Use this order when documents conflict:

1. V2 decision register
2. V2 numbered documents
3. V1 ADRs that the V2 decision register retains
4. V1 specification, schema, API, diagrams, and tests as historical design evidence
5. Source prompts and research notes

The following artifacts remain useful but do not define V2 scope:

- [V1 specification](../spec/00-index.md)
- [V1 ADR catalog](../adr/README.md)
- [V1 PostgreSQL schema](../../database/schema.sql)
- [V1 OpenAPI contract](../../api/openapi.yaml)
- [V1 diagrams](../diagrams/README.md)
- [Primary-source register](../../research/source-register.md)

Do not update the V1 schema, API, or generated implementation artifacts until the paid-pilot gate passes and V2 contracts receive their own implementation review.
