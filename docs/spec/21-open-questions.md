# 21. Open questions and assumptions

## Fixed assumptions for this baseline

- Product name in architecture: TideGrid. “Tideline Grid” on the existing theme board is superseded copy pending a later asset change.
- Launch: United States first, USD, English, with IANA time zones and extension points.
- Business model: tiered subscription plus a 0.75% to 3.00% plan-specific platform fee on eligible TideGrid-processed sale value, assessed once.
- Usage model: unlimited customers, bookings, users, products, and departures; plan-governed locations and active boats.
- Merchant model: operator is merchant of record through Stripe Connect direct charges.
- Infrastructure: Cloudflare-first application layer with Neon Scale PostgreSQL 17 in Azure East US 2.
- Mobile: React Native native build with SQLCipher, not a PWA.
- Safety: weather and rules can prompt and block workflow, but humans make departure decisions.
- Product code, external account creation, brand-asset editing, and deployment are outside this package.

## Product and commercial questions

| Question | Default pending decision | Owner/gate | Architecture impact |
|---|---|---|---|
| Public list-price validation | Dock $149 + 3.00%; Growth $399 + 2.00%; Fleet $999 + 1.25%; Enterprise custom at 0.75% to 1.00% | Product/finance through pilot contracts | Billing catalog, rate selection, sales positioning |
| Minimum platform-fee amount or cap | No variable-fee minimum/cap; monthly subscription is the minimum commitment | Finance before pricing publication | Fee formula and disclosures |
| Extra capacity pricing | $75 per active boat per month; additional locations require upgrade or contract | Product/finance through pilots | Entitlement meter and Billing invoice items |
| Commercial lifecycle | $499 onboarding waived annually; 15% annual subscription discount; $49 seasonal read-only mode | Product/finance through pilots | Subscription states, entitlements, safe read/refund access |
| Fee treatment of discounts and operator-funded credits | Net eligible sale after discount; new cash only | Finance/legal before checkout build | Order allocation and refund math |
| Who absorbs Stripe fees on refunds/disputes | Operator under Connect terms | Commercial/legal before pilot | Statements, UX, support policy |
| Private-charter deposit defaults | Tenant policy with fixed amount/percentage | Product/design partners in Phase 1 | Quote and payment state |
| Default cancellation/no-show rules | Tenant configurable within supported templates | Product/legal before pilot | Policy snapshots and remedy engine |
| Waitlist package/member priority | Tenant-configurable class, no opaque ML | Product before Phase 1 | Priority score and fairness audit |
| Tip pooling behavior | Record allocation, do not execute payroll/payout | Legal/product before Terminal | Tip roster and export |

## Operational and safety questions

| Question | Default pending decision | Owner/gate | Architecture impact |
|---|---|---|---|
| Initial passenger-vessel operator segments and routes | Small US passenger vessels, validate with design partners | Product/legal Phase 0 | Required documents, crew roles, terminology |
| Exact USCG evidence/retention needs by operator | Tenant configuration after counsel/operations review | Legal/safety before pilot | Document types, retention, checklists |
| Dive medical questionnaire source/license | Tenant-supplied approved version | Legal/safety before dive pilot | Template license, review workflow |
| Default no-fly reminder values | Guidance display only, source/date visible | Safety/legal before dive pilot | Journey timing and disclosures |
| Who may override credential/readiness blocks | Manager role with explicit policy; legal blocks never overridden | Tenant admin/legal before pilot | Permission and exception matrix |
| Offline manifest retention on device | Trip close plus 24-hour grace | Security/safety pilot validation | Purge scheduler and emergency use |
| Incident severity/escalation matrix | Conservative default, tenant approved | Safety/security before pilot | Paging, access, retention |

## Technical questions

| Question | Default pending decision | Owner/gate | Architecture impact |
|---|---|---|---|
| Neon production sizing | Azure East US 2; 0.25 to 2 CU, production scale-to-zero disabled; raise the floor after load and working-set tests | Platform Phase 0 | Latency, cost ceiling, connection capacity |
| Neon recovery target | 30-day instant restore plus encrypted daily logical backup to R2; approve alternate PostgreSQL restore target during Phase 0 | Platform/security Phase 0 | RPO/RTO, provider exit, key recovery |
| Identity provider | Standards-based managed OIDC | Security/engineering Phase 0 | MFA, SCIM, session controls |
| Transactional email provider | Provider-neutral adapter, choose on deliverability and US support | Engineering/ops Phase 0 | Webhook mapping and DNS |
| R2 document scanning service | Quarantine plus asynchronous scan | Security Phase 0 | Upload finalization SLO |
| Cloudflare Workflows task boundaries | Disruption/refund/document orchestration only | Architecture during build | Workflow versioning and limits |
| Direct Neon emergency path | Disabled for application traffic; pre-provisioned restricted role and runbook for migration, backup, and repair | Platform/security Phase 0 | Network and credential controls |
| Mobile device attestation policy | Use platform signals where reliable, do not make them sole control | Security/mobile pilot | Supported devices and false positives |
| Delta retention | 30 days initially | Engineering/load test | Storage and resnapshot frequency |
| Data warehouse trigger | Add when transactional projections or replica cannot meet reporting SLO | Product/platform post-MVP | CDC, governance, cost |

## Legal and launch gates

- TideGrid name/trademark clearance and update of the existing theme asset.
- Operator agreement, Stripe Connect disclosures, fee/refund language, and prohibited-business review.
- PCI DSS scope and evidence confirmed for exact web, Terminal, and support flows.
- US privacy applicability, minors/guardian handling, consent, retention, deletion, and incident notification reviewed by counsel.
- SMS/email transactional and marketing consent/opt-out language approved.
- USCG/operator evidence requirements validated with qualified maritime counsel and design partners.
- NOAA and DAN material is presented as sourced guidance, not autonomous safety or legal advice.

## Decision process

Open questions receive an owner, decision date, evidence, and affected artifacts. A decision that changes an accepted architecture choice creates or supersedes an ADR. Launch-blocking items cannot be waived by an undocumented assumption.
