# Primary-source register

**Research started:** July 15, 2026
**Last updated:** September 4, 2026
**Scope:** US-first V2 branded booking product, company formation, pilot economics, build and release operations, and preserved V1 architecture evidence

This register records the sources used to verify provider behavior, safety context, regulatory boundaries, and competitor claims. Competitor statements are self-reported marketing claims. Regulatory and safety entries identify design inputs, not legal, medical, or operational advice.

## Operator discovery

| Source | Evidence captured |
|---|---|
| [Oceans Eight Dive Company discovery interview](interviews/oceans-eight-dive-company-discovery-call.md) | A small dive-charter operator currently splits booking, payment, and waiver work across FareHarbor, Square, and Smartwaiver. The call provides strong evidence for connected commercial and readiness state, payment-independent waivers, returning-customer reuse, dive-specific data, low-risk migration, and post-onboarding support. Weather automation, WhatsApp, and AI support were prompted concepts and remain hypotheses. |

**Research implication:** Lead small dive-charter discovery with the cost and operational consequences of fragmented booking, payment, refund, waiver, participant, equipment, and departure records. Do not treat one operator's positive reaction as feature priority or pricing validation. Quantify the workaround and switching conditions across additional operators.

## Company formation and business readiness

| Source | V2 use and boundary |
|---|---|
| [Florida Division of Corporations LLC filing](https://dos.fl.gov/sunbiz/start-business/efile/fl-llc/) and [official LLC fee schedule](https://dos.fl.gov/sunbiz/forms/fees/llc-fees/) | A Florida LLC costs $125 to form. The annual report is $138.75, or $538.75 after May 1. File through the state site rather than a paid intermediary unless a specific service is justified. |
| [Florida Statute 605.0407](https://www.leg.state.fl.us/Statutes/index.cfm?App_mode=Display_Statute&URL=0600-0699/0605/Sections/0605.0407.html) and [Sunbiz filing instructions](https://dos.fl.gov/sunbiz/start-business/efile/fl-llc/instructions/) | A Florida LLC is member-managed unless its operating agreement or articles expressly make it manager-managed. TideGrid's current plan is one 100% member who operates the company. |
| [Florida Statutes 605.04071](https://www.leg.state.fl.us/Statutes/index.cfm?App_mode=Display_Statute&URL=0600-0699/0605/Sections/0605.04071.html), [605.0504](https://www.leg.state.fl.us/STATUTES/index.cfm?App_mode=Display_Statute&URL=0600-0699/0605/Sections/0605.0504.html), and [605.0701](https://www.leg.state.fl.us/Statutes/index.cfm?App_mode=Display_Statute&URL=0600-0699/0605/Sections/0605.0701.html) | Florida permits documented delegation and representative action in defined circumstances, while an LLC with no member for 90 consecutive days can face dissolution. A single-member company therefore needs succession, incapacity, account-recovery, customer-export, and safe-shutdown plans without granting anyone equity. |
| [IRS single-member LLC guidance](https://www.irs.gov/businesses/small-businesses-self-employed/single-member-limited-liability-companies) | A domestic single-member LLC is generally disregarded for federal income tax unless it elects corporate treatment. A CPA must confirm TideGrid's reporting, W-9, and any later election; an LLC EIN is still useful for banking, employment taxes, and provider accounts. |
| [Sunbiz entity search](https://dos.fl.gov/sunbiz/search/) | State-name availability is an early screen, not trademark clearance or a reservation. |
| [IRS EIN application](https://www.irs.gov/businesses/small-businesses-self-employed/get-an-employer-identification-number) | The IRS issues an EIN directly at no charge after the state entity exists. |
| [FinCEN BOI reporting](https://www.fincen.gov/boi) | As of September 3, 2026, US-created companies and US persons are exempt from BOI reporting under the final rule effective August 14, 2026. Recheck at formation because this area has changed repeatedly. |
| [Pompano Beach business-tax guidance](https://www.pompanobeachfl.gov/government/code-compliance/business-tax-receipt-division/business-tax-receipt-division-faqs) and [Broward County business tax receipt](https://browardtax.org/business-tax-receipt/) | A Pompano business obtains city zoning and its city receipt before the county receipt. Confirm the activity classification and home-business requirements directly before filing. |
| [USPTO trademark search](https://www.uspto.gov/trademarks/search) and [fee schedule](https://www.uspto.gov/trademarks/trademark-fee-information) | Name clearance and any federal filing are separate from entity formation. The base electronic application fee is currently $350 per class before possible additional fees. |
| [Stripe Atlas](https://stripe.com/atlas) and [Clerky pricing](https://www.clerky.com/pricing) | These are convenience options for a deliberate Delaware C-corporation path, not the default for the Florida bootstrap pilot. Vendor prices exclude Florida foreign qualification and some ongoing compliance. |

**V2 decision:** Approve the validation materials and resolve the private filing inputs first. Then form a bare-bones single-member, member-managed Florida LLC owned 100% by TideGrid's sole founder before the next operator outreach. Entity formation is administrative preparation, not demand evidence, and does not authorize contracts, deposits, production accounts, live customer data, or the production build. After the 12-interview and conditional-demand gates pass, fund and complete paid-pilot legal, tax, accounting, insurance, payment, messaging, security, intellectual-property, and continuity readiness before accepting money. Pilot operators are customers and receive no company ownership or governance rights. A Delaware C corporation is a financing decision, not a default startup ritual.

## Competitive products

| Source | Verified claim used |
|---|---|
| [FareHarbor tour operator software](https://fareharbor.com/solutions/tours/) | Online booking, OTA connections, crew assignment, notifications, and offline mobile check-in are existing category capabilities. |
| [FareHarbor boat-tour pricing](https://fareharbor.com/aloha/boat-tours/) | FareHarbor advertises no monthly fee, up to 6% on direct bookings and 2% on API bookings, plus payment processing. |
| [FareHarbor product overview](https://fareharbor.com/blog/what-is-fareharbor/) | FareHarbor markets waivers, POS, waitlists, packages, reporting, and broad operations across tours and water activities. |
| [Peek Pro tour operator software](https://www.peekpro.com/solutions/tour-operator-software) | Peek markets dynamic pricing, POS, mobile manifests, guide assignment, self-rescheduling, and customer messaging. |
| [Xola tour management software](https://www.xola.com/tour-management-software) | Xola markets scheduling, pricing, inventory, guide assignment, customer communication, RBAC, and analytics. |
| [Xola pricing](https://www.xola.com/join/) | Xola advertises a $199 implementation fee, no recurring subscription fee, and a 6% online booking fee. |
| [Bókun pricing](https://www.bokun.io/pricing) | Bókun publishes plans at $49 plus 1.5%, $149 plus 1.25%, and $499 plus 1.0%, alongside resource, gift-card, POS, API/webhook, and OTA capabilities. |
| [FareHarbor external API](https://developer.fareharbor.com/api/external/v1/) | FareHarbor exposes an integration API and status concepts, supporting the need for a clean import/adapter boundary. |

**Historical V1 product implication:** This research informed a hybrid baseline of $149 to $999 per month plus 1.25% to 3.00%. That conclusion and the departure-operations positioning are superseded by the [V2 commercial model](../docs/v2/03-commercial-model.md). Preserve the entries as category context, not current pricing authority.

## V2 commercial, app, and messaging evidence

| Source | V2 use and boundary |
|---|---|
| [Bókun pricing](https://www.bokun.io/pricing) | Published subscription and transaction-fee combinations provide an external pricing anchor. They do not establish TideGrid willingness to pay. |
| [Xola pricing](https://www.xola.com/pricing/) and [onboarding](https://www.xola.com/join/) | Published fee and onboarding structures provide category context for separating software access from implementation work. |
| [FareHarbor boat-tour software](https://fareharbor.com/solutions/boat-tour/) | The category already markets booking, payments, waivers, messaging, and distribution to boat-tour operators. TideGrid cannot treat a feature checklist as differentiation. |
| [GoFish pricing](https://www.gofish.rocks/pricing) | Fishing-charter software pricing provides a segment-specific comparison point for smaller operators. It is not evidence that dive or passenger-vessel operators accept TideGrid pricing. |
| [mTrip pricing](https://www.mtrip.com/en/pricing/) | A published white-label mobile-app offer supports treating app configuration, store work, and maintenance as a separate commercial service. |
| [Apple App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/) | Store acceptance is an external dependency. TideGrid must use an operator-owned account, meaningful operator-specific content, and one configurable source product rather than low-value cloned submissions. |
| [Google Play repetitive-content guidance](https://support.google.com/googleplay/android-developer/answer/15884185) | Repetitive or low-value white-label submissions face policy risk. Native acceptance must be validated with the pilot configuration and cannot be promised as a deterministic TideGrid outcome. |
| [Apple Developer Program enrollment](https://developer.apple.com/help/account/membership/program-enrollment) | Organization enrollment requires a legal entity, D-U-N-S number, domain-based business email, public website, and binding authority. The current annual fee is $99. |
| [Google Play organization-account requirements](https://support.google.com/googleplay/android-developer/answer/13628312) | Organization verification ties legal identity, D-U-N-S data, payments profile, website, phone, and contact evidence together. Customer-controlled verification time is outside TideGrid's promised delivery time. |
| [Google Play account registration](https://support.google.com/googleplay/android-developer/answer/6112435) | Google currently charges a one-time $25 registration fee. The operator pays and owns the account. |
| [Apple app privacy](https://developer.apple.com/help/app-store-connect/manage-app-information/manage-app-privacy/) and [account deletion](https://developer.apple.com/support/offering-account-deletion-in-your-app/) | Each operator release needs current privacy answers, SDK disclosure, an in-app deletion path, and a public deletion page. |
| [Google Play Data safety and deletion](https://support.google.com/googleplay/android-developer/answer/10144311) | Each Android listing needs a current Data safety declaration and compliant account-deletion path. |
| [Expo app variants](https://docs.expo.dev/build-reference/variants/) and [EAS store submission](https://docs.expo.dev/deploy/submit-to-app-stores/) | Expo can generate variants and automate build, upload, and listing work. TideGrid still owns the manifest, source, credentials boundary, evidence packet, and human approval workflow. |
| [Twilio US A2P 10DLC](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc) and [ISV onboarding](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/onboarding-isv) | US application-to-person messaging requires brand and campaign registration. The operator must supply accurate business and consent evidence, while TideGrid automates a dedicated sender boundary where supported. |
| [Twilio Messaging Policy](https://www.twilio.com/en-us/legal/messaging-policy) | Consent evidence, sender identification, and opt-out handling are product requirements. Transactional consent remains separate from marketing consent. |
| [Stripe Connect business models](https://docs.stripe.com/connect/saas-platforms-and-marketplaces) and [merchant-of-record guidance](https://docs.stripe.com/connect/merchant-of-record) | Connect supports software platforms whose connected businesses sell to their own customers. The operator remains merchant of record under the selected direct-charge model. |
| [Stripe connected-account configuration](https://docs.stripe.com/connect/accounts-v2/connected-account-configuration) and [Managed Risk](https://docs.stripe.com/connect/risk-management/managed-risk) | Merchant-of-record status does not determine unrecoverable negative-balance liability. Pilot pricing requires `defaults.responsibilities.fees_collector = stripe` and `defaults.responsibilities.losses_collector = stripe`, or a written Managed Risk equivalent. |
| [Stripe Managed Payments eligibility](https://docs.stripe.com/payments/managed-payments/eligibility) | Alternative merchant-of-record services have eligibility and product constraints. TideGrid will not assume that role or a processing spread during the pilot. |

**V2 evidence boundary:** Published competitor prices are anchors, not proof of TideGrid's value, support cost, or willingness to pay. The V2 price is a falsifiable commercial hypothesis. Three paid pilot operators and the commercial gates in the [V2 roadmap](../docs/v2/05-roadmap-validation.md) are required before the complete production build.

## Stripe

| Source | Verified constraint |
|---|---|
| [Connect direct charges](https://docs.stripe.com/connect/direct-charges) | Direct charges place the charge on the connected operator account. Stripe supports `application_fee_amount`, but TideGrid V2 does not use that capability for its separately invoiced managed-booking fee during the pilot. |
| [Connect overview](https://docs.stripe.com/connect) | Connect supports SaaS platforms whose businesses collect payments from their own customers. |
| [Terminal with Connect](https://docs.stripe.com/terminal/features/connect) | Terminal supports direct charges using the connected-account context; connected accounts own their readers in the standard direct-charge model. |
| [Billing and Connect](https://docs.stripe.com/connect/integrate-billing-connect) | SaaS subscription billing can be integrated separately from customer booking payments. |
| [Stripe webhooks](https://docs.stripe.com/webhooks) | Signatures must be verified; delivery can be duplicated and out of order; handlers should acknowledge quickly and process asynchronously. |

**V2 decision:** Use direct charges with the operator as merchant of record. Maintain distinct TideGrid orders, payment attempts, fee-assessment records, refund records, disputes, and reconciliation projections. Invoice TideGrid subscription and managed-booking fees separately. Browser redirects never establish payment success.

## Build-agent and goal execution evidence

| Source | V2 use and boundary |
|---|---|
| [OpenAI long-running work](https://learn.chatgpt.com/docs/long-running-work) | A goal needs a clear outcome, constraints, and verification. Parallel tasks should not write the same source. This supports bounded vertical goals rather than one goal for the entire roadmap. |
| [OpenAI GPT-5.6 model guidance](https://developers.openai.com/api/docs/guides/latest-model) and [model catalog](https://developers.openai.com/api/docs/models) | Current guidance positions Sol as the flagship option, Terra as the intelligence-and-cost balance, and Luna for high-volume cost-sensitive work. Reasoning effort should be deliberate and multi-agent work should divide cleanly. Availability, capability, pricing, and concurrency require a fresh check before each run. |

## Cloudflare

| Source | Verified constraint |
|---|---|
| [Hyperdrive supported features](https://developers.cloudflare.com/hyperdrive/reference/supported-databases-and-features/) | PostgreSQL 17 is supported. Advisory locks, `LISTEN`/`NOTIFY`, and SQL-managed prepared statements are not supported. |
| [Cloudflare Neon integration](https://developers.cloudflare.com/workers/databases/third-party-integrations/neon/) | Cloudflare recommends Hyperdrive for Neon and instructs Hyperdrive users to select Neon’s direct connection with connection pooling disabled. |
| [Hyperdrive query caching](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/) | Query caching is on by default, does not invalidate reads after writes, and can be disabled per configuration for current-data paths. |
| [Workers placement](https://developers.cloudflare.com/workers/configuration/placement/) | A Worker can use an Azure region hint to reduce repeated database round trips to a known regional backend. |
| [Cloudflare Queues delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/) | Queue delivery is at least once; consumers require database-backed deduplication and idempotency. |
| [Cloudflare Queues DLQ](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/) | Failed messages can be redirected to a configured dead-letter queue after retries. |
| [Cloudflare Workflows limits](https://developers.cloudflare.com/workflows/reference/limits/) | Workflow state has finite retention and platform limits; it cannot be the commercial system of record. |
| [R2 data security](https://developers.cloudflare.com/r2/reference/data-security/) | R2 encrypts objects at rest and in transit. Sensitive fields still require application-level controls and private access. |
| [R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/) | Time-limited signed access can be used for private uploads and downloads. |
| [API Shield schema validation](https://developers.cloudflare.com/api-shield/security/schema-validation/) | API Shield imports OpenAPI 3.0 schemas, with documented validation limits. |
| [Turnstile validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/) | Server-side validation is mandatory; tokens are short-lived and single-use. |
| [Workers traces](https://developers.cloudflare.com/workers/observability/traces/) | Workers provides tracing and supports OpenTelemetry export. |
| [Secrets Store](https://developers.cloudflare.com/secrets-store/) | Secrets Store is currently beta, so production secrets need an exit path and tested rotation procedure. |
| [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/) | Web applications can ship static assets with Workers while retaining distinct application and API deployments. TideGrid does not need Pages for the pilot product surfaces. |
| [Cloudflare for SaaS plans](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/plans/) and [setup](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/getting-started/) | The first 100 custom hostnames are included on current self-service plans and additional hostnames are $0.10 each. The pilot requires a customer CNAME subdomain because apex proxying is not in the standard self-service plans. |
| [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/), and [R2 pricing](https://developers.cloudflare.com/r2/pricing/) | Current usage and included allowances support a low fixed pilot baseline, but TideGrid must meter production traffic and retain budget alerts instead of assuming the free allowances. |
| [Workers GitHub Actions](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/), [gradual deployments](https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/), and [rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/) | GitHub Actions can orchestrate version upload, explicit promotion, post-deploy checks, and Worker rollback. Database rollback still requires forward repair and expand-contract migrations. |
| [Workers OpenTelemetry export](https://developers.cloudflare.com/workers/observability/exporting-opentelemetry-data/) | Worker telemetry can feed an external observability system. Domain audit evidence remains in PostgreSQL rather than logs. |

**Decision:** Cloudflare owns edge delivery, application compute, asynchronous transport, workflow orchestration, and object storage. PostgreSQL owns all business truth. An after-commit queue hint plus scheduled outbox sweeper closes the database-to-queue reliability gap.

## PostgreSQL, Neon, and Azure

| Source | Verified constraint |
|---|---|
| [Neon pricing and plan capabilities](https://neon.com/pricing) | Scale provides a 30-day restore window, IP rules, observability export, SLA coverage, usage-based compute, and multi-AZ storage. |
| [Neon branching with GitHub Actions](https://neon.com/docs/guides/branching-github-actions) | Ephemeral pull-request databases can use synthetic or sanitized fixtures. TideGrid must not clone raw production personal data into previews. |
| [Neon SLA](https://neon.com/sla) | The Scale SLA covers compute endpoints and does not cover every Neon platform function. |
| [Neon regional status](https://neon.com/docs/introduction/status) | Neon operates Azure East US 2 and Azure West US 3 regional services in the United States. |
| [Neon `btree_gist`](https://neon.com/docs/extensions/btree_gist) | Neon supports the extension required for multicolumn GiST indexes and exclusion constraints. |
| [Neon compute management](https://neon.com/docs/manage/endpoints/) | Paid computes support autoscaling and disabling scale-to-zero; compute changes and restarts can interrupt connections. |
| [Neon `pg_dump` and `pg_restore`](https://neon.com/docs/import/migrate-from-neon) | Logical export and restore use the direct, unpooled endpoint; pooled endpoints are unsuitable for `pg_dump`. |
| [Neon Terraform provider](https://registry.terraform.io/providers/kislerdm/neon/latest/docs) | The available Neon Terraform provider is community maintained, so TideGrid must pin and review it and retain a Neon API fallback. |
| [Azure Key Vault key operations](https://learn.microsoft.com/en-us/azure/key-vault/keys/about-keys-details) | Key Vault supports versioned key wrap and unwrap operations for envelope-encryption data keys. |
| [PostgreSQL transaction isolation](https://www.postgresql.org/docs/17/transaction-iso.html) | Serializable transactions can abort and must be retried from the beginning. |
| [PostgreSQL row security](https://www.postgresql.org/docs/17/ddl-rowsecurity.html) | RLS provides default-deny tenant filtering when enabled and correctly configured. |
| [PostgreSQL constraints](https://www.postgresql.org/docs/17/ddl-constraints.html) | Exclusion constraints create supporting indexes; `CHECK` constraints cannot safely enforce aggregate cross-row balances. |

**Decision:** Run PostgreSQL 17 on Neon Scale in Azure East US 2. Connect Hyperdrive to Neon’s direct endpoint, disable Hyperdrive caching for MVP domain traffic, keep production compute active, retain 30 days of Neon history, and store an encrypted daily logical backup in R2. Use exclusion constraints for overlapping exclusive reservations. Use locked projection rows plus immutable ledgers for aggregate balances. Retry serialization failures and deadlocks with bounded jitter.

## Maritime, weather, diving, privacy, and messaging

| Source | Verified design input |
|---|---|
| [USCG passenger vessels](https://www.dco.uscg.mil/Our-Organization/Assistant-Commandant-for-Prevention-Policy-CG-5P/Inspections-Compliance-CG-5PC-/Commercial-Vessel-Compliance/Domestic-Compliance-Division/Passenger-Vessels/) | Passenger-vessel requirements vary by vessel and voyage category. This informed V1 compliance-document scope. V2 stores operator-approved booking policies and legal links but excludes vessel compliance documents and certification claims. |
| [NWS API](https://www.weather.gov/documentation/services-web-api) | NOAA/NWS exposes forecast and alert APIs; coastal marine forecast availability has endpoint-specific limitations. |
| [NWS alerts](https://www.weather.gov/documentation/services-web-alerts) | Alerts can be queried by point, zone, area, and marine region and have published rate guidance. |
| [DAN flying after diving](https://world.dan.org/health-medicine/health-resources/diseases-conditions/flying-after-diving/) | DAN distinguishes single, repetitive/multiday, and decompression profiles and cautions that recommendations reduce but do not eliminate risk. |
| [PCI DSS](https://www.pcisecuritystandards.org/document_library/) | PCI DSS v4.0.1 is the current referenced standard. Hosted Stripe elements and Terminal reduce, but do not eliminate, TideGrid’s security responsibilities. |
| [FTC children’s privacy](https://www.ftc.gov/business-guidance/privacy-security/childrens-privacy) | Collecting information from children can create COPPA duties; guardian workflows and minimization require counsel review. |
| [FTC data security guide](https://www.ftc.gov/business-guidance/resources/protecting-personal-information-guide-business) | Inventory, minimization, least access, secure disposal, and vendor controls are baseline security practices. |
| [Twilio Messaging Services](https://www.twilio.com/docs/messaging/services) | Delivery callbacks, inbound webhooks, and advanced opt-out controls are supported. |
| [Twilio Messaging Policy](https://www.twilio.com/en-us/legal/messaging-policy) | Senders must retain proof of consent and honor straightforward opt-out. |

## Required validation before production

- Obtain trademark counsel’s decision on TideGrid versus Tideline Grid.
- Obtain payments counsel and Stripe review of merchant-of-record, fee, refund, tax, and negative-balance configuration.
- Obtain maritime counsel or qualified compliance review for each supported operator class and jurisdiction.
- Obtain privacy counsel review for minors, medical data, consent, retention, deletion, and state privacy laws.
- Complete PCI scope determination with a qualified assessor.
- Validate all external provider behavior against sandbox accounts before implementation acceptance.
