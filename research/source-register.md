# Primary-source register

**Research started:** July 15, 2026
**Last updated:** July 24, 2026
**Scope:** US-first MVP architecture and product positioning

This register records the sources used to verify provider behavior, safety context, regulatory boundaries, and competitor claims. Competitor statements are self-reported marketing claims. Regulatory and safety entries identify design inputs, not legal, medical, or operational advice.

## Operator discovery

| Source | Evidence captured |
|---|---|
| [Oceans Eight Dive Company discovery interview](interviews/oceans-eight-dive-company-discovery-call.md) | A small dive-charter operator currently splits booking, payment, and waiver work across FareHarbor, Square, and Smartwaiver. The call provides strong evidence for connected commercial and readiness state, payment-independent waivers, returning-customer reuse, dive-specific data, low-risk migration, and post-onboarding support. Weather automation, WhatsApp, and AI support were prompted concepts and remain hypotheses. |

**Research implication:** Lead small dive-charter discovery with the cost and operational consequences of fragmented booking, payment, refund, waiver, participant, equipment, and departure records. Do not treat one operator's positive reaction as feature priority or pricing validation. Quantify the workaround and switching conditions across additional operators.

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

**Product implication:** Competitor pricing supports a hybrid TideGrid baseline of $149 to $999 per month plus 1.25% to 3.00%, with 0.75% to 1.00% reserved for Enterprise commitments. Price alone is not defensible. TideGrid's wedge must be the connected departure record, maritime readiness dependencies, deterministic offline execution, and operational-to-financial closeout.

## Stripe

| Source | Verified constraint |
|---|---|
| [Connect direct charges](https://docs.stripe.com/connect/direct-charges) | Direct charges place the charge on the connected operator account, support `application_fee_amount`, and require explicit application-fee refund handling. |
| [Connect overview](https://docs.stripe.com/connect) | Connect supports SaaS platforms whose businesses collect payments from their own customers. |
| [Terminal with Connect](https://docs.stripe.com/terminal/features/connect) | Terminal supports direct charges using the connected-account context; connected accounts own their readers in the standard direct-charge model. |
| [Billing and Connect](https://docs.stripe.com/connect/integrate-billing-connect) | SaaS subscription billing can be integrated separately from customer booking payments. |
| [Stripe webhooks](https://docs.stripe.com/webhooks) | Signatures must be verified; delivery can be duplicated and out of order; handlers should acknowledge quickly and process asynchronously. |

**Decision:** Use direct charges with the operator as merchant of record. Maintain distinct TideGrid orders, payment attempts, application-fee records, refund records, disputes, and reconciliation projections. Browser redirects never establish payment success.

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

**Decision:** Cloudflare owns edge delivery, application compute, asynchronous transport, workflow orchestration, and object storage. PostgreSQL owns all business truth. An after-commit queue hint plus scheduled outbox sweeper closes the database-to-queue reliability gap.

## PostgreSQL, Neon, and Azure

| Source | Verified constraint |
|---|---|
| [Neon pricing and plan capabilities](https://neon.com/pricing) | Scale provides a 30-day restore window, IP rules, observability export, SLA coverage, usage-based compute, and multi-AZ storage. |
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
| [USCG passenger vessels](https://www.dco.uscg.mil/Our-Organization/Assistant-Commandant-for-Prevention-Policy-CG-5P/Inspections-Compliance-CG-5PC-/Commercial-Vessel-Compliance/Domestic-Compliance-Division/Passenger-Vessels/) | Passenger-vessel requirements vary by vessel and voyage category; TideGrid must store operator-supplied documents and rules without claiming compliance certification. |
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
