# TideGrid V2 build, hosting, and operations plan

**Status:** Proposed pilot baseline; provisional until the paid-validation gate

**Date:** September 4, 2026

This document turns the V2 architecture direction into a build and operating plan. It does not authorize production work or provider spending. TideGrid should provision production infrastructure only after three pilot operators pay the native setup fee and sign the recurring agreement in [`05-roadmap-validation.md`](05-roadmap-validation.md).

The current V2 design defines the tenant boundary, transactional authority, and shared native model. It does not yet provide an implementation contract. TideGrid must test the choices in this document during Stage 0 and record accepted changes in [`06-decision-register.md`](06-decision-register.md) or a new ADR. [`10-build-execution-and-agent-plan.md`](10-build-execution-and-agent-plan.md) defines how to divide that work into bounded goals and subagent assignments.

## Recommended pilot baseline

| Layer | Proposed choice | Reason | Status before paid validation |
|---|---|---|---|
| Repository | Private GitHub repository with a pinned pnpm workspace | One source tree can share contracts, UI, provider adapters, and release tooling | Prototype only |
| API | TypeScript and Hono on Cloudflare Workers | Matches the retained modular-monolith direction and avoids server management | Spike required |
| Data access | Kysely plus reviewed SQL migrations | Keeps transaction and PostgreSQL behavior visible | Spike required |
| Guest web | React, Vite, and a service-worker PWA on Workers Static Assets | One web build can load versioned brand configuration for every operator | Prototype allowed |
| Operator web | React and Vite on a separate Workers Static Assets deployment | Staff access, release cadence, and CSP differ from the guest surface | Prototype allowed |
| Native | Expo React Native with EAS Build and EAS Submit | One native shell can generate operator variants without maintaining build hosts | Store proof required |
| Database | PostgreSQL 17 on Neon Scale in Azure East US 2 | Retains PostgreSQL transactions, RLS, exclusion constraints, and managed recovery | Revalidation required |
| Database connection | Cloudflare Hyperdrive to the direct Neon endpoint with Hyperdrive query caching disabled | Hyperdrive supplies pooling without stacking Neon's PgBouncer pool | Connection and race tests required |
| Async delivery | PostgreSQL outbox plus Cloudflare Queues and a DLQ | PostgreSQL retains intent when queue delivery fails or repeats | Failure test required |
| Object storage | Private R2 buckets | Stores waiver evidence, approved brand assets, generated documents, and independent logical backups | Security and restore test required |
| Infrastructure as code | Terraform with reviewed Cloudflare modules and a pinned Neon API or provider wrapper | Reproducible environments reduce console drift | Plan-only before the gate |
| CI/CD | GitHub Actions, Wrangler versions, Neon branches, and EAS workflows | One control plane can retain test, build, deployment, and submission evidence | Prototype workflows allowed |
| Telemetry | Workers Logs and traces, Neon metrics, synthetic journeys, and OpenTelemetry export | Covers customer journeys and provider failures without adding application servers | Destination choice open |

Cloudflare, Neon, Expo, and the supporting libraries remain replaceable adapters. Paid validation, technical spikes, and recovery drills control the final choice.

## Proposed repository shape

```text
apps/
  guest-site/           shared guest PWA and custom-hostname bootstrap
  operator-site/        TideGrid operator console
  api-worker/           HTTP API, provider callbacks, and scheduled entrypoints
  async-worker/         queue consumers, outbox publication, imports, and reconciliation
  native-shell/         shared Expo React Native application
packages/
  contracts/            OpenAPI types, events, provider callback schemas
  domain-*/             booking, payments, waivers, equipment, packages, messaging
  database/             Kysely types, repositories, and reviewed SQL migrations
  design-system/        shared tokens and components with supported brand inputs
  tenant-config/        schema, validation, versioning, and safe defaults
  provider-*/           Stripe, Twilio, email, weather, R2, push, and auth adapters
  observability/        logging, tracing, metrics, audit, and redaction helpers
config/
  tenants/              approved non-secret tenant manifests and asset references
tools/
  app-factory/          config validation, asset generation, store-package generation
  migration/            standard import mapping, control totals, and rehearsal tools
infra/
  terraform/            Cloudflare, Neon, GitHub, monitoring, and environment modules
ops/
  runbooks/              deployment, recovery, provider, and incident procedures
```

The repository may contain public brand inputs that an operator approved for release. It must contain credential references instead of credentials, signed documents, customer exports, or production data. CI stores generated customer release artifacts in access-controlled build storage with retention rules.

The app factory validates one versioned tenant manifest. The manifest identifies the tenant, brand version, custom hostname, public legal URLs, native application identifiers, store record identifiers, supported capabilities, approved asset hashes, and secret references. The same manifest drives PWA smoke tests and native generation. Server configuration remains the authority for catalog, policies, waivers, and operational content.

## Runtime component topology

Use shared deployments for every operator. Boats and brands must not create Workers, databases, schemas, queues, or source branches.

| Component | Responsibility | Public route | Stateful dependencies |
|---|---|---|---|
| Guest site Worker | Serve the shared PWA, resolve a verified hostname, issue an experience bootstrap, and enforce guest CSP | Operator custom hostnames and TideGrid preview subdomains | Tenant-hostname mapping and approved brand assets |
| Operator site Worker | Serve the shared staff console under TideGrid's domain | `console.<tidegrid-domain>` | Managed OIDC and API |
| API Worker | Authenticate, authorize, validate, run domain transactions, and accept provider callbacks | `api.<tidegrid-domain>` | Hyperdrive, PostgreSQL, R2, and queue producers |
| Async Worker | Publish outbox events, consume queues, run imports, expire holds, and reconcile providers | No guest route | PostgreSQL, queues, R2, and provider adapters |

Workers Static Assets supports a combined Worker and asset deployment, and Cloudflare does not charge for static asset requests. A Worker accepts one static asset collection, so the guest site and operator site use separate deployments. The API and async workers deploy apart from both sites because they have different rollback and resource bindings.

Do not use Workers for Platforms in the pilot. TideGrid runs shared code and server-controlled configuration. A per-customer Worker would add deployment and isolation work without serving a product need.

## Custom-domain plan

Cloudflare for SaaS handles customer-owned hostnames. Cloudflare Worker Custom Domains apply to zones that TideGrid controls and cannot attach a Worker to an external operator zone.

The pilot contract should require a subdomain such as `book.operator.com`:

1. TideGrid creates the custom-hostname record and supplies the CNAME target.
2. The operator creates the CNAME at its DNS provider.
3. TideGrid checks hostname ownership and certificate status through the Cloudflare API.
4. TideGrid activates the domain only after hostname and certificate validation succeed.
5. A TideGrid preview subdomain remains available during setup and DNS incidents.

Cloudflare for SaaS includes 100 custom hostnames on Free, Pro, and Business plans at the September 2026 published rate. Additional hostnames cost $0.10 each. Cloudflare reserves apex proxying for an Enterprise add-on, so the pilot must not promise an apex domain such as `operator.com`. A customer that requires an apex domain needs a custom quote and a provider review.

The hostname selects public brand context. It grants no guest, participant, staff, or support permission. PostgreSQL stores the authoritative hostname-to-tenant mapping. A cache may hold a signed, short-lived projection keyed by the normalized hostname. Unknown, inactive, moved, or validation-pending hostnames fail closed.

## PostgreSQL and Hyperdrive plan

The V1 plan selected Neon Scale PostgreSQL 17 in Azure East US 2. V2 retains Neon as a provisional default and requires current price, region, recovery, and provider-fit checks before provisioning.

### Production proposal

- Create one TideGrid production project and one shared-schema production database.
- Protect the production root branch and retain 30 days of Neon history.
- Start production compute at 0.25 to 2 CU with scale to zero disabled. Raise the minimum only after load and working-set tests.
- Connect runtime traffic through Hyperdrive to Neon's direct, unpooled TLS endpoint.
- Disable Hyperdrive query caching for tenant authorization, availability, holds, bookings, money, packages, waivers, equipment, and read-after-write queries.
- Use separate PostgreSQL roles for runtime, migration, backup, reporting, and emergency repair.
- Send migrations, backups, and repair sessions through restricted direct connections instead of Hyperdrive.

Cloudflare includes Hyperdrive in Workers Paid. Neon advises Hyperdrive users to avoid Neon's pooled endpoint because both products pool connections.

Apply a placement hint to the database-bound API Worker after a latency test confirms the supported Azure region value. Cloudflare documents that placement affects fetch handlers, not queue, cron, or named RPC handlers. Measure async Worker database latency and connection behavior before accepting the topology. If async latency misses the gate, route bounded database work through a placed fetch service or choose another supported execution pattern after an ADR.

### Nonproduction proposal

Use a separate Neon Launch project for development, preview, and staging. Keep scale to zero enabled. Create expiring branches for pull requests, apply the candidate migration, load synthetic data, run tests, and delete the branch when the pull request closes.

Do not branch raw production data into a nonproduction project. A reviewed masking process may produce a test fixture after legal and security approval. Until then, use deterministic synthetic tenants, bookings, payment states, waivers, equipment pools, and package ledgers.

## Environment matrix

| Environment | Cloudflare | PostgreSQL | Data | Providers | Promotion rule |
|---|---|---|---|---|---|
| Local | Wrangler local runtime and local asset builds | Local PostgreSQL 17 container or disposable Neon branch | Deterministic synthetic fixtures | Provider sandboxes and local callback fixtures | Developer command only |
| Pull request | Wrangler preview version with an unguessable URL | Expiring Neon branch in the nonproduction project | Synthetic fixtures | Provider sandboxes; no live SMS, email, or charges | CI creates and destroys it |
| Staging | Dedicated staging Workers, queues, R2 buckets, routes, and Hyperdrive config | Long-lived branch or database in the nonproduction project | Synthetic acceptance set; approved migration rehearsal copies only | Provider test modes and dedicated test senders | Merge to main after required checks |
| Production | Dedicated production Cloudflare account, zone, Workers, queues, R2 buckets, and Hyperdrive config | Neon Scale production project and protected root branch | Live tenant data | Live provider accounts and operator-owned connected accounts | Sole TideGrid owner through the GitHub production environment |

Use separate Cloudflare accounts for production and nonproduction during the live pilot. This adds one Workers Paid minimum but limits token, binding, route, and console blast radius. If Cloudflare account administration blocks that layout, TideGrid must document equivalent resource separation and least-privilege tokens before launch.

Neither preview nor staging may send messages to a real customer, create live charges, publish store builds, or resolve a production custom hostname.

## Infrastructure and configuration ownership

Terraform owns Cloudflare zones and stable routes, queues and DLQs, R2 buckets, Hyperdrive configurations, service tokens, alert destinations, and custom-hostname plumbing. A pinned Neon provider or a small reviewed Neon API wrapper owns projects, branches, compute policy, roles, and restore-window settings. Terraform outputs the resource identifiers needed by each environment, but it does not deploy Worker scripts or attach their version bindings. TideGrid must not place secret values in Terraform state.

Wrangler owns each Worker version's code, static assets, compatibility date and flags, limits, and binding declarations. Environment-specific Wrangler configuration references the Terraform-created resource identifiers. GitHub Actions verifies that every declared binding resolves before upload. Terraform and Wrangler must never manage the same Worker script, version, binding, route, or provider resource.

Store encrypted Terraform state in a remote backend with locking and version history. GitHub Actions produces a plan for each infrastructure change. The sole TideGrid owner approves production apply. Console changes serve incident response only; the owner records the change and imports it into code after the incident.

Use these credential boundaries:

- Cloudflare Worker secrets hold runtime provider credentials for one environment.
- GitHub environment secrets hold restricted deployment, migration, backup, and provisioning credentials.
- EAS and each operator's store account hold native signing and submission credentials under least-privilege access.
- A company password manager holds break-glass credentials, backup-key recovery material, and account-recovery codes. The owner enrolls two hardware security keys and stores them separately.
- Source code, tenant manifests, logs, Terraform state, and client bundles contain no credential values.

Cloudflare Secrets Store remains in open beta as of September 2026. Do not make it the only custody system for a production root or recovery key until Cloudflare publishes production terms that TideGrid accepts.

## CI/CD ownership and flow

GitHub Actions owns the web, API, database, infrastructure, and release evidence flow. EAS owns native compilation and binary upload. Store owners retain the legal declarations and final release authority for their app records.

### Pull-request checks

1. Install locked dependencies with a pinned Node.js and pnpm version.
2. Run formatting, lint, type, unit, contract, policy, and dependency checks.
3. Validate all enabled tenant manifests and approved asset hashes.
4. Build the guest site, operator site, API Worker, async Worker, and native configuration output.
5. Create an expiring Neon branch, apply migrations, and run tenant-isolation, concurrency, ledger, webhook, and import tests.
6. Upload Worker preview versions and run browser tests against synthetic tenants.
7. Produce an SBOM, dependency-license report, build manifest, and test summary.
8. Delete preview database and provider resources when the pull request closes.

### Staging promotion

1. Merge an approved commit to main.
2. Apply expand-compatible migrations to staging.
3. Deploy immutable Worker versions and content-hashed web assets.
4. Run guest booking, operator change, waiver, refund, message, package, and migration synthetics.
5. Record the commit, migration set, Worker version IDs, config schema version, artifact hashes, and test results in the release ledger.

### Production promotion

1. The sole TideGrid owner opens the GitHub production environment.
2. CI verifies backups, provider status, migration compatibility, enabled tenant manifests, and staging results.
3. CI applies the production expand migration through the restricted migration role.
4. CI uploads Worker versions without routing traffic, then runs preview checks.
5. CI promotes the version through a small traffic step when volume supports a useful sample. Version affinity and backward-compatible contracts limit version skew.
6. CI runs synthetic booking and callback probes, checks error and reconciliation signals, and promotes or rolls back.
7. The sole TideGrid owner records the decision and closes the release ledger entry.

Low pilot traffic may not support a statistical canary. In that case, run a TideGrid-owned synthetic tenant and use a scheduled pilot launch window before moving all traffic. Web deployment must not wait for one operator's store submission or review.

## Database migration and rollback policy

Use expand, backfill, verify, and contract migrations:

- Expand adds compatible columns, tables, indexes, and dual-read or dual-write support.
- Backfill runs in bounded batches with progress, pause, and restart controls.
- Verify compares old and new projections and records control totals.
- Contract removes the old shape only after the supported web and native versions stop using it.

Set PostgreSQL lock and statement timeouts. Test each migration on a production-shaped Neon branch. CI blocks migrations that require an unbounded table rewrite or hide a destructive data conversion.

Cloudflare can roll a Worker back to a retained version, but that action does not revert database migrations or restore deleted bindings. Application rollback uses a schema-compatible Worker version. Database incidents use a forward fix or an approved point-in-time restore. No rollback may discard confirmed bookings, provider events, payments, refunds, waivers, packages, or audit records.

## Observability and incident signals

Use structured logs with environment, deployment, operation, tenant hash, correlation ID, aggregate ID, outcome, latency, dependency, retry count, and stable error code. Logs and traces must exclude tokens, message bodies, waiver text, signatures, payment method data, device tokens, and raw customer contact details.

Monitor these customer journeys and invariants:

- catalog to atomic hold, payment to confirmation, and booking change to remedy;
- waiver invitation to participant evidence and signed PDF;
- provider callback intake, outbox age, queue retries, and DLQ depth;
- package and service-credit balance attempts, equipment conflicts, and hold expiry;
- message acceptance, delivery, opt-out, reply, fallback, and push failure;
- custom-hostname status, app-version adoption, import control totals, and backup age.

Workers Logs provides seven days of retention on Workers Paid. Keep business audit evidence in PostgreSQL and immutable document metadata. Export sampled operational logs and traces through OpenTelemetry when TideGrid needs retention or paging beyond the Cloudflare window. Select the external destination during Stage 0 and record its retention, access, redaction, and cost.

Run a synthetic booking against a dedicated TideGrid tenant at least every five minutes. The synthetic path uses provider test modes and cannot consume live operator capacity or send customer messages. Page the owner for suspected tenant escape, database unavailability, payment success without booking finalization, a threatened recovery point, or a critical DLQ. Create a business-hours incident for lesser provider degradation and cost anomalies.

## Solo-owner operating boundary

The sole TideGrid owner operates the pilot. Customer agreements must match that staffing model rather than imply a larger support organization.

Standard support uses email or a ticket queue from 9:00 a.m. to 5:00 p.m. Eastern Time, Monday through Friday, excluding US federal holidays. Published severity targets measure acknowledgement and initial triage during those hours, not resolution:

| Severity | Example | Business-hours response target |
|---|---|---:|
| Critical | Confirmed tenant escape, production database unavailable, or confirmed payment without a booking | 1 business hour |
| High | A material booking, waiver, refund, messaging, or operator workflow is degraded without a safe normal path | 4 business hours |
| Normal | Configuration, reporting, documentation, or non-blocking defects | 2 business days |

Automated monitoring may alert at any time, but the standard pilot includes no 24-hour human coverage, guaranteed resolution time, contractual uptime credit, or service-level agreement. TideGrid may offer those commitments only after contracted backup coverage, incident authority, and incremental price are in place. The monitoring frequency and RPO/RTO values in this document are internal engineering objectives and acceptance gates, not customer-facing service levels.

Each pilot operator must maintain and rehearse a manual fallback for closing sales, checking the latest exported departure roster, recording new manual changes, collecting or recording external payments, and contacting affected guests while TideGrid is unavailable. TideGrid launches and cutovers occur sequentially; the owner does not overlap initial migration or live-cutover work across operators. TideGrid may not accept customer four until a documented owner-capacity review covers the prior 90 days of support, incidents, releases, launch work, planned absence, and contingency capacity.

TideGrid owns its corporate domain, platform accounts, repositories, billing accounts, and recovery records. The owner uses company-controlled identities where providers allow them, enrolls two separately stored hardware keys, and does not share personal or root credentials. Before the first live booking, TideGrid must name a non-equity emergency custodian, document narrowly scoped break-glass and safe-shutdown authority, and test recovery-material handoff without granting routine production access. An independent qualified person must execute or observe one complete logical-backup restore before launch and at least annually; the owner still runs and records the quarterly restore drills required below.

## Security controls

- Use managed OIDC with MFA for operator users, the TideGrid owner, and any later authorized TideGrid staff. Guest links carry narrow, expiring scopes.
- Apply forced PostgreSQL RLS, tenant-aware foreign keys, explicit tenant predicates, and two-tenant escape tests.
- Use Cloudflare WAF controls, endpoint rate limits, bounded request bodies, schema validation, CSP, and Turnstile on abuse-prone public flows.
- Use Stripe-hosted or embedded payment fields so TideGrid does not receive card numbers.
- Keep R2 buckets private. Authorize each upload and download, verify content type and size, scan generated or uploaded documents, and record hashes.
- Encrypt designated contact, guardian, waiver, token, and recovery fields with versioned keys. Keep the root recovery material outside the runtime account.
- Generate an SBOM and dependency-license report for each production release. Scan dependencies, source, infrastructure, and containerless bundles in CI.
- Grant support access for one tenant, reason, and time window. Record each access in the audit log.

Stage 0 must choose the managed OIDC, transactional email, malware scanning, paging, and long-retention telemetry providers. Those choices must support US customer data, deletion, export, audit, and incident-response requirements.

## Backup and disaster recovery

Neon history and an independent logical backup address different failures. Monitor them as separate controls.

| Recovery case | Proposed source | Planning RPO | Planning RTO | Required proof |
|---|---|---:|---:|---|
| Erroneous application or operator change | Neon point-in-time restore within the 30-day window | 5 minutes | 60 minutes | Restore to an isolated branch, verify state, then perform an approved cutover |
| Corrupt migration | Pre-migration restore point plus forward-fix migration | 5 minutes | 60 minutes | Rehearsal with production-shaped volume and both application versions |
| Neon project, account, or region loss | Encrypted logical backup in a separate private R2 backup bucket | 24 hours | 4 hours | Restore to a new standard PostgreSQL target and pass tenant, ledger, and checkout checks |
| R2 evidence loss or corruption | Object inventory, hashes, retention metadata, and an approved copy strategy | To be selected | To be selected | Recover selected waiver and brand objects with matching hashes |

Create an encrypted logical `pg_dump` through the direct, unpooled Neon endpoint at least once per day. Store it in a dedicated R2 bucket with a retention and deletion policy. Keep the decryption key and recovery instructions outside both Neon and the application Worker account. Verify the dump, schema version, object count, checksum, and restore log.

A daily logical backup cannot meet a five-minute recovery point after complete Neon loss. The pilot accepts a 24-hour provider-loss RPO only after the sole TideGrid owner and each affected pilot operator approve that risk in writing. If any affected operator rejects it, add continuous replication or WAL-based recovery to a separate provider before that operator launches and update the cost model.

Run both Neon point-in-time and logical-backup restore drills before the first live booking and at least once each quarter. Reconcile restored state against Stripe, Twilio, email, push, and import provider records before reopening writes.

## Provider responsibility matrix

| Provider or account | Account owner | TideGrid responsibility | Operator responsibility | Cost treatment |
|---|---|---|---|---|
| Cloudflare | TideGrid | Configure runtime, domains, security controls, storage, queues, deployment, and recovery | Supply DNS access or complete the requested CNAME | Shared hosting unless dedicated service is requested |
| Neon | TideGrid | Operate PostgreSQL, roles, migrations, monitoring, backup, and restore | None | Shared hosting |
| GitHub and infrastructure state | TideGrid | Protect source, CI, approvals, provenance, and IaC state | None | Shared engineering overhead |
| Managed OIDC, email, telemetry, and scanning | TideGrid | Select providers, configure tenants, limit data, monitor use, and handle incidents | Approve sender identity and authorized staff | Shared base plus attributable usage under the contract |
| Stripe Connect | TideGrid platform account and operator connected account | Require Stripe-set fees and Stripe negative-balance loss collection, build onboarding and payment management, verify callbacks, and reconcile TideGrid records | Own the connected account and merchant obligations; authorize refunds and answer disputes | Operator processing and connected-account charges pass through or bill to the operator; TideGrid does not accept connected-account loss liability at pilot pricing |
| Twilio | TideGrid master account with one subaccount and sender per operator | Provision subaccount, registration workflow, callbacks, consent state, opt-out, reply, and usage reporting | Supply business records, approve sender use, and follow consent rules | Operator registration, number, carrier, and message usage pass through at cost |
| Domain and DNS | Operator | Supply DNS instructions, validation state, and fallback hostname | Own the domain and maintain the CNAME | Registration or dedicated domain service passes through |
| Apple Developer and App Store Connect | Operator | Generate, test, upload, record, and support the build under delegated access | Own membership, agreements, legal declarations, listing approval, and release authority | Membership and extra store work pass through or use the setup scope |
| Google Play Console | Operator | Generate, test, upload, record, and support the build under delegated access | Own account, agreements, declarations, listing approval, and release authority | Registration and extra store work pass through or use the setup scope |
| Expo EAS | TideGrid | Maintain the shared native project tooling, build profiles, credential references, and release evidence | Approve the branded build | Shared native tooling plus attributable build overages |
| NOAA/NWS | Public source | Cache source and freshness evidence and expose provider failure | Make each trip decision | Shared hosting |

No provider may become the business system of record for bookings, capacity, packages, waivers, or TideGrid fee assessment. PostgreSQL remains authoritative and provider reconciliation repairs projections after outages.

## Pilot cost envelope

The prices below use provider pages checked on September 3, 2026. Providers can change them. "Official" means a published rate, not a TideGrid forecast. "Planning" means an internal budget that the pilot cohort must replace with measured invoices and usage.

### Published infrastructure anchors

| Service | September 2026 published anchor | Label | Source |
|---|---:|---|---|
| Cloudflare Workers Paid | $5 minimum per account per month; 10 million dynamic requests and 30 million CPU milliseconds included | Official | [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) |
| Workers Static Assets | Static asset requests free and unlimited on the published Workers plans | Official | [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) |
| Cloudflare for SaaS | 100 custom hostnames included; $0.10 for each additional hostname on non-Enterprise plans | Official | [Cloudflare for SaaS plans](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/plans/) |
| Hyperdrive | Included in Workers Paid with no separate query or egress charge | Official | [Hyperdrive pricing](https://developers.cloudflare.com/hyperdrive/platform/pricing/) |
| Cloudflare Queues | 1 million operations included each month; $0.40 per additional million operations; a common delivery consumes three operations | Official | [Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/) |
| R2 Standard | 10 GB-month, 1 million Class A operations, and 10 million Class B operations included; then $0.015 per GB-month, $4.50 per million Class A, and $0.36 per million Class B | Official | [R2 pricing](https://developers.cloudflare.com/r2/pricing/) |
| Workers Logs | 20 million events included on Workers Paid with seven-day retention; $0.60 per additional million | Official | [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/) |
| Neon Scale compute | $0.222 per CU-hour | Official | [Neon pricing](https://neon.com/pricing) |
| Neon data storage | $0.35 per GB-month; history storage $0.20 per GB-month of retained changes | Official | [Neon pricing](https://neon.com/pricing) |
| Neon production minimum example | About $41.63 for 187.5 CU-hours at 0.25 CU kept active for a 750-hour month, before storage and autoscaling | Calculated from official rate | [Neon pricing](https://neon.com/pricing) |
| Neon Launch nonproduction example | Neon publishes a typical $15 monthly example for intermittent load and 1 GB | Official example, not a quote | [Neon pricing](https://neon.com/pricing) |

### TideGrid planning budget for three pilot operators

| Cost group | Monthly planning range | Included assumption |
|---|---:|---|
| Cloudflare production and nonproduction | $10 to $25 | Two Workers Paid accounts plus low pilot request volume |
| Neon production and nonproduction | $60 to $110 | Always-active 0.25 CU production floor, modest bursts, small storage/history, and scale-to-zero nonproduction |
| R2, Queues, and backup execution | $0 to $10 | Usage remains near published included amounts |
| OIDC, transactional email, telemetry retention, paging, and document scanning | $40 to $80 | Low-volume managed plans selected in Stage 0 |
| GitHub CI and native build tooling | $40 to $85 | Sole-owner private repository, routine CI, and bounded pilot build cadence |
| **Shared pilot total** | **$150 to $310** | Excludes labor and operator pass-through charges |

The central estimate is $230 per month, or about $77 per native pilot operator across three pilot operators. This sits near the commercial model's current $80 monthly combined Core infrastructure and Native tooling allowance per native operator. It does not validate that assumption.

This envelope assumes that the sole owner supplies operating labor. It excludes the value of the owner's time, paid support or on-call backup, emergency-custodian professional fees, and any contractual SLA or uptime-credit reserve. Price and approve those items separately before making a customer commitment that requires them.

Track fixed shared cost, usage shared by volume, attributable tenant cost, and customer-specific labor as separate ledger categories. Record Worker requests and CPU, Neon CU-hours and storage, message volume, email volume, R2 storage and operations, queue operations, EAS build time, CI minutes, telemetry events, and support time by month. Trigger a pricing review when the shared total exceeds $310 for two months or one tenant causes more than 25 percent of shared variable cost without corresponding revenue.

Stripe processing, connected-account fees, Twilio registration and use, operator domains, Apple and Google memberships, taxes, dedicated services, and extra store cycles remain outside this envelope under [`03-commercial-model.md`](03-commercial-model.md).

## Required operating runbooks

TideGrid must approve and rehearse these runbooks before the first live booking:

- custom hostname request, pre-validation, cutover, failure, move, and removal;
- tenant creation, brand publication, role assignment, and support-access expiry;
- Stripe connected-account onboarding, webhook rotation, payment uncertainty, refund, and dispute reconciliation;
- Twilio sender registration, consent dispute, opt-out, inbound reply, delivery failure, and email fallback;
- Worker and web deployment, synthetic verification, traffic promotion, and rollback;
- database expand migration, bounded backfill, verification, forward fix, and point-in-time restore;
- queue retry, DLQ review, replay, duplicate suppression, and provider recovery;
- logical backup, decryption-key recovery, alternate PostgreSQL restore, and application reconciliation;
- suspected tenant escape, leaked secret, lost device token, malicious upload, and waiver-evidence access;
- native build, internal testing, store submission, review response, phased release, and urgent compatibility block.

Each runbook names an owner, approval threshold, safe first action, customer-impact check, evidence location, rollback or recovery limit, communication owner, and closure test.

## Required build and release artifacts

Retain these artifacts for each production web or backend release:

- source commit, dependency lock hash, build manifest, and CI run;
- SBOM, license report, security scan, and approved exceptions;
- tenant-config schema version plus the hash of each enabled non-secret manifest;
- migration list, schema compatibility statement, plan output, backfill status, and control totals;
- Worker version IDs, web asset hashes, binding inventory, and Terraform plan/apply record;
- automated test, concurrency, tenant-isolation, provider-sandbox, and synthetic results;
- approver, traffic steps, monitoring evidence, incident links, and final outcome.

Retain a customer native release bundle under the separate native release process. It includes the operator approval, app manifest, generated configuration, asset hashes, signed binaries, build provenance, screenshots, store metadata, privacy and data-safety declarations, review notes, submission receipts, store status, and review correspondence.

Build storage must apply access control, retention, legal hold, and deletion policy by artifact class. Release records may reference secrets or signing assets by identifier but must not contain their values.

## Architecture acceptance gates

TideGrid must pass each gate before processing live bookings:

| Gate | Proof |
|---|---|
| Shared web build | One immutable guest PWA build serves at least two distinct brands from server configuration with no source change |
| Custom hostname | An operator-owned external DNS zone completes CNAME, certificate pre-validation, activation, renewal observation, and removal without manual origin changes |
| Tenant isolation | Hostname, token, application identity, PostgreSQL rows, R2 objects, queues, logs, and provider context cannot cross two synthetic tenants |
| Database connection | Hyperdrive reaches the direct Neon endpoint, avoids Neon's pooled endpoint, survives compute restart, and preserves read-after-write behavior with query caching disabled |
| Transaction correctness | Production-shaped final-seat, exclusive-boat, equipment, package, service-credit, payment-late-arrival, and duplicate-callback tests pass |
| Async recovery | A lost queue hint, duplicate delivery, retry exhaustion, and DLQ replay produce one recorded outcome through the PostgreSQL outbox/inbox contracts |
| Deployment | Staging promotion, production version upload, synthetic check, traffic change, and Worker rollback complete from CI with retained evidence |
| Migration | Expand, backfill, verify, contract, and forward-fix rehearsals preserve old and new application compatibility |
| Recovery | Neon point-in-time restore and independent logical restore meet the approved RPO/RTO and reconcile provider records |
| Observability | Alerts identify payment finalization gaps, outbox age, critical DLQ, database loss, backup age, and suspected tenant escape without exposing customer data |
| Cost | One month of production-shaped testing attributes provider use and supports the accepted shared and per-tenant cost envelope |
| Native integration | One pilot-operator build and a second brand build use the same source commit, pass shared tests, and produce complete store release bundles without source edits |

Reject or revise this baseline when a gate shows that:

- Cloudflare for SaaS requires an Enterprise feature for qualified pilot domains;
- Worker or async database latency misses the booking targets;
- Neon recovery, security controls, regional fit, or measured cost misses the approved threshold;
- TideGrid cannot restore business truth and reconcile external providers within the accepted window;
- tenant-specific hosting or source changes enter the standard launch path;
- native store policy or build operations prevent repeatable branded releases; or
- shared recurring infrastructure and release tooling cannot fit the pricing margin gate.

## Official implementation references

- [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/)
- [Cloudflare for SaaS setup](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/getting-started/)
- [Worker Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
- [Wrangler environments](https://developers.cloudflare.com/workers/wrangler/environments/)
- [Cloudflare GitHub Actions](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)
- [Workers gradual deployments](https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/)
- [Workers rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)
- [Workers placement](https://developers.cloudflare.com/workers/configuration/placement/)
- [Workers OpenTelemetry export](https://developers.cloudflare.com/workers/observability/exporting-opentelemetry-data/)
- [Neon compute management](https://neon.com/docs/manage/endpoints/)
- [Neon branching with GitHub Actions](https://neon.com/docs/guides/branching-github-actions)
- [Neon logical export and restore](https://neon.com/docs/import/migrate-from-neon)
- [Expo application variants](https://docs.expo.dev/build-reference/variants/)
- [Expo app-store submission](https://docs.expo.dev/deploy/submit-to-app-stores/)
