# 16. Security and privacy architecture

## Security model

TideGrid is a multi-tenant internet service that processes commerce, safety, identity, minor, medical, emergency, and signed-evidence data. The primary threats are cross-tenant access, account takeover, authorization bypass, payment/webhook forgery, stored-value abuse, lost devices, malicious documents, support abuse, supply-chain compromise, and destructive operational mistakes.

The system follows least privilege, deny by default, explicit tenant context, short-lived credentials, append-only evidence, defense-in-depth tenant isolation, and data minimization.

## Identity and authorization

- Operator users authenticate through OIDC. MFA is mandatory for tenant owners, finance, support, credential reviewers, and users with safety overrides.
- Sensitive actions use recent-authentication step-up: payout/account changes, refunds above threshold, API-key creation, support access, data export/deletion, and webhook-secret rotation.
- RBAC grants baseline permissions. Location, legal entity, assignment, resource, data category, state, amount, and ownership supply attribute checks.
- The Worker resolves tenant from verified identity and route context. It sets database tenant context only inside a transaction.
- Sessions are short lived, refresh tokens rotate, suspicious reuse revokes the session family, and user/device revocation propagates promptly.
- Service identities have separate credentials and scopes. No shared production administrator accounts.

## Sensitive-data access matrix

| Data | Guest/booker | Front desk | Assigned captain/crew | Manager/safety | Finance | Support |
|---|---|---|---|---|---|---|
| Customer contact | Own/authorized party | Required booking scope | Minimum assigned-manifest contact | Tenant scope | Receipt contact only | Masked by default |
| Participant identity and age category | Own/authorized | Required booking scope | Assigned departure minimum | Tenant scope | No birth date | Masked, JIT exception |
| Emergency contact | Own/authorized edit | Read when operationally required | Assigned departure, offline allowed | Tenant scope | None | No default access |
| Medical questionnaire | Own submission | Status only | Safety flag/minimum instruction only | Named reviewer, full answer if required | None | No access |
| Certification/identity document | Own upload/status | Status | Status and relevant restriction | Named reviewer | None | Metadata only |
| Waiver | Own sign/view | Status | Status | Evidence viewer | Refund-related status only | Metadata, JIT evidence access |
| Payment | Own receipt, Stripe-hosted method | Status and last-four where permitted | Status only | Status | Transactions, no PAN | Masked operational state |
| Incident sensitive details | Own only through controlled process | No default | Creator/assigned safety scope | Full authorized scope | Financial consequence only | No default, JIT exception |

Every sensitive read is purpose-bound and audited. Tenant-defined custom roles cannot grant a permission unavailable to that tenant plan or regulatory policy.

## Tenant and application isolation

- Composite tenant-aware keys reject cross-tenant references.
- Forced PostgreSQL RLS filters all tenant tables, including writes.
- Application queries always include tenant predicates even with RLS.
- Cloudflare caches never key private responses without tenant, principal, scope, and version.
- R2 object keys use unguessable tenant prefixes. Access is through short-lived signed URLs or authenticated streaming, never a public bucket.
- Widget code runs as an isolated web component with explicit host integration and no operator-session authority.
- Production, staging, and test use separate accounts, databases, buckets, secrets, and connected-provider modes.

## Encryption and key management

- TLS 1.2 or later is required for client, provider, Cloudflare-to-Neon, database, key-management, and object traffic.
- Neon storage and history, independent logical backups, R2, device storage, and provider-managed storage use encryption at rest.
- Medical answers, participant/minor identity fields, emergency contacts, credential numbers, incident details, tax identifiers, and webhook secrets use application-level envelope encryption.
- A per-record data key is wrapped by a versioned tenant or data-class key in Azure Key Vault. Ciphertext stores algorithm, key version, nonce, and authentication tag.
- Keys rotate on schedule and incident. Rewrap jobs do not require plaintext persistence. Key use is logged and rate limited.
- R2 signed URLs are purpose and object scoped, short lived, and never included in analytics or referrer-bearing pages.

## Payments, stored value, and redemption

Stripe Elements/Checkout and Terminal SDKs keep PAN and sensitive authentication data out of TideGrid systems. TideGrid stores Stripe identifiers, amounts, states, and limited display metadata. PCI scope must be validated against the exact integration and current PCI DSS 4.0.1 requirements before launch.

Package and gift codes have at least 128 bits of cryptographically secure entropy, are shown selectively, and are stored only as slow verification hashes or keyed hashes. Redemption is rate limited by principal, tenant, IP reputation, device, and code prefix. Repeated failures trigger progressive delay and operator alert without confirming code existence.

## Edge and API controls

- Cloudflare WAF, DDoS protection, schema validation, bounded bodies, endpoint-specific rate limits, and bot controls protect public endpoints.
- Turnstile tokens are validated server side, are single use, and supplement rather than replace authorization.
- Hono validates path, query, header, and body schemas before domain code.
- Output encoding, strict content security policy, frame controls, origin allowlists, CSRF defenses, and secure cookie attributes protect web clients.
- File upload validates type by content, size, decompression limits, malware scan, document hash, and quarantine state.
- Provider webhooks verify signatures against raw bytes before parsing and enforce timestamp tolerances and event uniqueness.

## Secrets and supply chain

Runtime credentials use Cloudflare Worker secrets or write-only Hyperdrive configuration. Azure Key Vault holds key-encryption keys. Migration, backup, and Neon API credentials stay in the CI/CD secret store and never enter Worker bindings unless that Worker needs them. Secrets do not appear in Terraform state, source, logs, client bundles, build arguments, or local test fixtures. Rotation supports overlap for webhook and API secrets.

CI requires lockfile integrity, dependency and container scanning, secret scanning, static analysis, license policy, signed provenance, protected branches, review, and environment approval. Critical exploitable findings block release. Emergency patches follow the same artifact signing and audit path.

## Support access

Support impersonation is disabled by default. JIT access requires a ticket, reason, tenant approval where practical, narrow role, maximum duration, MFA step-up, banner visible to support, tenant-visible audit, and recording of every read/change. Support cannot reveal medical fields or payment data unless a separately approved break-glass policy allows the exact category. Break-glass use pages security leadership.

## Privacy lifecycle

- Collect only fields required for booking, safety, legal evidence, communication, and reconciliation.
- Record purpose, source, policy version, consent/authorization basis, retention class, and tenant ownership.
- Separate transactional messaging from marketing consent and honor STOP/START and email suppression promptly.
- Guardian authority and signature evidence are explicit for minors. Do not infer that a booker is a guardian.
- Tenant export, correction, restriction, deletion, and legal-hold requests use an auditable workflow.
- Deletion removes or cryptographically erases eligible PII from primary data, search, caches, devices, documents, and downstream processors. Required finance/safety evidence is retained with minimized identity and legal basis.
- Backups age out on schedule. Deletion is not claimed from immutable backups before expiry; restored systems rerun tombstones before service.
- A data-processing inventory records provider, data classes, region, retention, subprocessor, and transfer controls.

US-first launch requires counsel-reviewed privacy notice, state-law applicability, children/minor handling, consent language, retention schedule, incident notification process, and messaging terms. The architecture provides controls but does not determine legal applicability.

## Security operations

Security telemetry covers authentication anomalies, permission changes, support access, code guessing, export volume, signed-URL creation, webhook failures, RLS errors, device revocation, provider-account changes, and encryption-key use. Alerts route by severity with runbooks.

Incident response has preparation, detection, containment, evidence preservation, eradication, recovery, customer/legal assessment, and post-incident review. Backups are encrypted and access tested. Quarterly restore drills verify RTO/RPO and application-level decryption. Annual penetration testing and tenant-isolation testing occur before major launch and after high-risk changes.
