# TideGrid

TideGrid is an exploratory US-first product for branded passenger-vessel booking. This repository contains product, commercial, validation, and architecture plans. It does not contain a production application.

## Current direction

TideGrid V2 is a productized booking service for direct-first operators. Each operator brand receives a branded PWA and custom domain. A native iOS and Android app pair is an optional premium add-on. Boats are resources inside the operator experience, not separate apps or source forks.

TideGrid is planned as a single-member, member-managed Florida LLC owned and operated by its sole founder. The first three pilot operators are paying customers, not company founders or equity partners. Pilot status grants no ownership, governance, profit share, intellectual-property rights, or authority over TideGrid.

The pilot is intentionally booking-centered. It includes catalog and availability, payments, guest self-service, waivers, transactional messaging, pooled rental inventory, advisory weather evidence, tipping, fixed-unit trip packages, reporting, migration, and branded apps. It excludes full departure operations, medical and certification review, marketing campaigns, points programs, serialized equipment, and live OTA synchronization.

## Canonical V2 package

Start with the [V2 planning index](docs/v2/00-index.md).

- [Pre-customer formation and validation plan](docs/v2/11-pre-customer-formation-and-validation.md)
- [Customer validation deck, PowerPoint](docs/customer/TideGrid-Customer-Validation-Deck.pptx)
- [Customer validation deck, PDF](docs/customer/TideGrid-Customer-Validation-Deck.pdf)
- [Customer-facing validation brief](docs/customer/tidegrid-validation-brief.md)
- [Internal operator validation guide](docs/customer/operator-validation-guide.md)
- [Product strategy](docs/v2/01-product-strategy.md)
- [Pilot product scope](docs/v2/02-product-scope.md)
- [Commercial model](docs/v2/03-commercial-model.md)
- [Company formation and costs](docs/v2/07-company-formation-and-costs.md)
- [Target architecture](docs/v2/04-architecture.md)
- [Build, hosting, and operations](docs/v2/08-build-hosting-and-operations.md)
- [Native app factory and store submission](docs/v2/09-native-app-factory-and-store-submission.md)
- [Build execution and agent plan](docs/v2/10-build-execution-and-agent-plan.md)
- [Roadmap and validation](docs/v2/05-roadmap-validation.md)
- [Decision register](docs/v2/06-decision-register.md)
- [Primary-source register](research/source-register.md)

## Commercial baseline

| Offer | Setup | Recurring | Commitment |
|---|---:|---:|---:|
| Booking Core, self-setup | $0 | $149/month + 1.5% of net managed booking value | 12 months; $3,000 annual minimum |
| Managed Launch | $1,000 | None | Optional |
| Native add-on | $4,500 | $399/month + 0.25% | 12 months |
| Pilot Native offer | $2,250 | Full recurring price | First three qualified pilot operators only |

Managed Launch pays for implementation labor, not product access. The first three qualified pilot operators receive Managed Launch at no charge and pay half of the native setup fee. Provider, registration, domain, and app-store costs pass through at cost.

## Validation gate

TideGrid remains exploratory. First approve the customer-facing brief and internal interview guide, resolve the private filing inputs, and form a bare-bones single-member Florida LLC before the next operator outreach. Formation is administrative preparation, not demand validation, and does not authorize customer contracts, deposits, production accounts, live data, or a production build.

After 12 interviews produce at least five direct-first prospects and three qualified prospects across at least two operator types give written conditional commitments, TideGrid may fund and complete the separate legal, insurance, payment, messaging, security, and operating-readiness gate. The complete production build starts only after those three operators sign 12-month recurring agreements and TideGrid receives all three native setup payments. The product must then pass the acceptance and economic gates in the [roadmap](docs/v2/05-roadmap-validation.md) before the first production pilot launches.

The native model is feasible for three pilot operators but not proven scalable. Apple requires commercial-template apps to be submitted by the content provider, so the operator owns its organization account and performs the final Apple review submission. TideGrid can automate configuration, build, testing, upload, and listing preparation from the shared source line.

If the build gate passes, use a series of bounded long-running goals rather than one goal for the full roadmap. The [build execution and agent plan](docs/v2/10-build-execution-and-agent-plan.md) proposes Astra as the hands-on lead for difficult slices and original UI design, implementation, and visual refinement, with fresh review and optional specialists. It defines model routing, file ownership, token and cost checkpoints, and recovery handoffs; routine work and extensions of accepted UI patterns can stay on Sol, Terra, or Luna.

## Historical V1 package

The July 2026 V1 package remains preserved as design history. It describes a broader departure-operations product and no longer defines current scope or pricing.

- [V1 specification](docs/spec/00-index.md)
- [V1 pricing strategy](docs/spec/pricing-strategy.md)
- [V1 architecture decision records](docs/adr/README.md)
- [V1 PostgreSQL schema](database/schema.sql)
- [V1 OpenAPI contract](api/openapi.yaml)
- [V1 diagrams](docs/diagrams/README.md)
- [Preserved source architecture prompt](TIDEGRID_PLATFORM_ARCHITECTURE_PROMPT.md)

When documents conflict, use the V2 decision register first, followed by the other numbered V2 documents and then the V1 ADRs explicitly retained by V2. Do not treat the V1 schema or API as an implementation contract for V2.

## Naming status

The planning package uses **TideGrid**. An existing theme board says **Tideline Grid**, and the separate brand strategy records a possible naming conflict. Trademark clearance and a final naming decision remain launch gates.
