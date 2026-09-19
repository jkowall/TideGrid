# 8. Recommended software architecture

## Decision

Build a TypeScript modular monolith with ports-and-adapters boundaries. Deploy the public API and application modules on Cloudflare Workers. Use PostgreSQL 17 on Neon Scale in Azure East US 2 as the system of record.

## Repository shape for implementation

```text
apps/
  api-worker/          Hono HTTP API, webhooks, scheduled triggers
  async-worker/        Queue consumers and outbox publisher
  guest-web/           React/Vite booking and self-service
  operator-web/        React/Vite administration and dispatch
  captain-mobile/      React Native application
  booking-widget/      Isolated web component bundle
packages/
  domain-*/            Bounded-context domain and application services
  contracts/           OpenAPI types, events, webhook schemas
  database/            Kysely types, repositories, SQL migrations
  provider-*/          Stripe, Twilio, email, weather, R2 adapters
  observability/       Logging, metrics, tracing, audit helpers
infra/                 Terraform modules for Cloudflare and Azure; Neon provider/API wrapper
```

Context packages may depend on shared value types and declared ports, not another context’s repository implementation.

## Runtime topology

### Request path

1. Cloudflare WAF, rate limits, bot controls, and Turnstile protect public entry points.
2. The API Worker authenticates, resolves tenant/location, validates OpenAPI input, creates correlation context, and authorizes the command.
3. The application service opens a short PostgreSQL transaction through Hyperdrive.
4. Domain state, audit event, idempotency result, and outbox entries commit together.
5. External provider work occurs after commit.

### Database path

- Hyperdrive connects to Neon’s direct, unpooled endpoint with TLS verification and a dedicated runtime role.
- Database-bound Workers use the `azure:eastus2` placement hint. Static assets remain at the edge.
- The MVP Hyperdrive binding disables query caching. Public catalog or availability candidate reads may use a separate cache-enabled binding only after the application defines a staleness budget.
- The application uses `pg` through Kysely. Complex invariants and migrations remain hand-written SQL.
- Runtime code does not use advisory locks, `LISTEN`/`NOTIFY`, or session state.
- Schema migration CI uses a restricted direct, unpooled Neon connection, not Hyperdrive.
- Production uses Neon Scale, a protected root branch, 30-day instant restore, encryption at rest, and an always-active compute that starts at 0.25 to 2 CU autoscaling.
- A restricted runner creates an encrypted daily logical backup in a separate R2 bucket. Quarterly drills restore from Neon history and the independent backup.
- Development and pull-request environments use expiring Neon branches with scale-to-zero. Production data requires masking before non-production use.

### Async path

1. Business transaction inserts an outbox row.
2. After commit, the Worker sends a best-effort queue hint containing only outbox ID and tenant.
3. A scheduled sweeper claims unpublished rows with `FOR UPDATE SKIP LOCKED` and sends them to Cloudflare Queues.
4. Queue consumers claim/process idempotently and record consumer outcome.
5. Retryable errors use bounded backoff. Permanent failures enter a DLQ and database exception.

The queue message is transport, not truth. Missing hints are recovered by the sweeper. Duplicate messages are suppressed by event/consumer unique keys.

### Workflow path

Cloudflare Workflows coordinates long waits or multi-step processes such as disruption remedies, private-charter acceptance, and payment exception recovery. Every step uses application idempotency keys. PostgreSQL stores canonical saga state because Workflow retention is finite.

## Client architecture

### Guest and operator web

- React, Vite, TypeScript, React Router, TanStack Query, and generated OpenAPI clients.
- Static assets served through Cloudflare’s edge.
- Guest app uses secure, scoped magic-link sessions and Stripe-hosted payment components.
- Operator app uses OIDC, MFA, tenant/location scope, and field-level permissions.
- No sensitive business truth is persisted in browser storage.

### Booking widget

- Web component with Shadow DOM isolation and explicit postMessage contract.
- Loads from a TideGrid-owned origin with CSP and version pinning.
- Uses the same public booking API and hosted Stripe fields.
- Host page never receives card data or TideGrid authentication secrets.

### Captain and dockside mobile

Primary: React Native with native modules, SQLCipher database, iOS Keychain/Android Keystore, background sync, remote session revocation, and biometric/device unlock where available.

Alternative: separate Swift and Kotlin applications. Revisit only if React Native background execution, database encryption, device management, or field reliability fails acceptance tests.

A PWA is rejected because dependable encrypted persistence, background execution, secure key storage, and remote device controls are more important than code sharing.

## API architecture

- REST with OpenAPI 3.0 under `/v1`.
- Command endpoints require `Idempotency-Key`.
- RFC 9457 problem responses with stable TideGrid codes.
- Cursor pagination, bounded filters, ETags/aggregate versions, and correlation IDs.
- HMAC-signed outgoing webhooks with timestamp and delivery ID.
- Mobile sync uses command batches and cursor deltas, not general record PUT.
- GraphQL is not used initially. Read complexity does not justify a second authorization and caching model.

## Provider ports

```typescript
interface PaymentProvider {
  createIntent(command: CreatePaymentIntent): Promise<ProviderPayment>;
  refund(command: CreateRefund): Promise<ProviderRefund>;
  retrievePayment(reference: ProviderReference): Promise<ProviderPayment>;
}

interface MessagingProvider {
  send(command: SendMessage): Promise<ProviderDelivery>;
}

interface WeatherProvider {
  observations(query: WeatherQuery): Promise<WeatherEvidence>;
  alerts(query: WeatherQuery): Promise<WeatherEvidence[]>;
}

interface DocumentStorageProvider {
  createUpload(command: CreateDocumentUpload): Promise<SignedUpload>;
  createDownload(command: CreateDocumentDownload): Promise<SignedDownload>;
}
```

Provider payloads are stored for evidence and diagnostics but translated before reaching domain logic.

## Technology selections

| Layer | Primary | Viable alternative |
|---|---|---|
| Backend | Workers, Hono, TypeScript | Kotlin/Spring Boot in managed containers |
| SQL | Kysely + `pg` + manual SQL | Drizzle plus manual SQL |
| Web | React/Vite | React Router framework mode |
| Mobile | React Native native build | Swift plus Kotlin |
| Database | Neon Scale PostgreSQL 17 on Azure | Aiven Business or Crunchy Bridge on Google Cloud |
| Queue | Cloudflare Queues | Google Cloud Pub/Sub |
| Workflow | Cloudflare Workflows | Temporal Cloud |
| Documents | Cloudflare R2 | Azure Blob Storage |
| IaC | Terraform | Pulumi |
| Observability | OpenTelemetry export plus Workers observability | Vendor-specific SDK behind adapter |

## Security boundaries

- Cloudflare edge to Worker.
- Worker to Hyperdrive/Neon.
- Worker to Stripe/Twilio/email/weather.
- Worker to private R2.
- Mobile device encrypted store to sync API.
- Platform support plane to tenant data plane.

No trust crosses a boundary based only on network location.

## Scaling and extraction

Keep one deployable domain application until a measured need requires extraction. Likely candidates:

- high-volume availability search read service;
- messaging delivery;
- reporting projections and warehouse feeds;
- offline synchronization gateway;
- OTA connectors;
- document rendering and malware scanning.

Extraction requires a stable event/API contract, independent operational ownership, and evidence that module-level scaling or failure isolation materially improves the system.
