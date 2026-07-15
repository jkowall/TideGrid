# 11. PostgreSQL schema

## Authority and deployment

PostgreSQL 17 on Neon Scale in Azure East US 2 is the transactional authority. Cloudflare Hyperdrive provides transaction-mode connection pooling for runtime traffic. The MVP uses a cache-disabled Hyperdrive configuration so authorization, capacity, payment, stored-value, and read-after-write queries reach PostgreSQL. Migrations, logical backups, and operational repair use separate restricted roles through Neon’s direct, unpooled TLS endpoint because Hyperdrive is not a migration or lock-management plane.

The executable baseline is [`database/schema.sql`](../../database/schema.sql). The [database implementation guide](../../database/README.md) defines migration order, transaction conventions, retry behavior, and concurrency validation.

## Schema map

| Domain | Principal tables |
|---|---|
| Tenant and identity | `tenants`, `legal_entities`, `locations`, `provider_accounts`, `users`, `roles` |
| Customer and participant | `customers`, `participants`, `guardians`, `emergency_contacts` |
| Catalog and schedule | `products`, `product_variants`, `departure_templates`, `departure_instances` |
| Availability | `resources`, `resource_requirements`, `resource_reservations`, `capacity_buckets`, `capacity_holds` |
| Commerce | `checkout_sessions`, `bookings`, `orders`, `order_lines`, `payment_attempts`, `refunds`, `platform_fees` |
| Stored value | `packages`, `package_accounts`, `package_ledger_entries`, `credit_accounts`, `credit_ledger_entries`, `gift_cards` |
| Safety evidence | `waiver_signatures`, `medical_forms`, `certification_documents`, `manifests`, `manifest_snapshots`, `incidents` |
| Fleet and crew | `vessels`, `maintenance_blocks`, `crew_members`, `crew_credentials`, `crew_assignments`, `crew_time_entries` |
| Equipment | `equipment_pools`, `equipment_items`, `equipment_holds`, `equipment_allocations` |
| Disruption and demand | `disruptions`, `disruption_actions`, `waitlist_entries`, `charter_inquiries`, `charter_proposals` |
| Messaging | `message_templates`, `messages`, `message_deliveries`, `consent_records` |
| Integration and consistency | `webhook_inbox`, `transactional_outbox`, `event_consumptions`, `idempotency_keys`, `external_records` |
| Offline | `offline_devices`, `offline_commands`, `sync_cursors`, `sync_conflicts` |
| Governance | `audit_events`, `reconciliation_exceptions`, outgoing webhook tables |

## Tenant isolation

Tenant-owned primary keys are composite `(tenant_id, id)`. Foreign keys repeat `tenant_id`, so a reference cannot point into another tenant even if the application sends an incorrect identifier. Forced RLS applies `tenant_id = app.current_tenant_id()` to reads and writes.

The application opens a transaction and executes `SET LOCAL app.tenant_id` from authenticated server context. A missing context produces no tenant rows. Guests, operator apps, widgets, and mobile devices never receive database credentials.

## Availability representation

An availability query intersects independent dimensions:

```text
sellable = schedule open
        AND seat/category capacity available
        AND every exclusive resource interval available
        AND every pooled equipment bucket available
        AND required crew qualifications valid
        AND operational blocks absent
        AND product/channel/cutoff rules satisfied
```

Exclusive vessel, room, vehicle, captain, guide, and serialized-item intervals use half-open `tstzrange` values and partial GiST exclusion constraints. Seat/category and pooled inventory use projection rows updated conditionally under row locks. A checkout is valid only when all required dimensions acquire holds in one transaction.

## Financial and stored-value records

Order lines snapshot seller, classification, amount, tax, tip, discount, and fee eligibility. `orders` snapshots the pricing plan, schedule version, and platform-fee rate used for the transaction. `platform_fees` repeats those pricing facts with the eligible base, computed fee, and refunded fee for reconciliation. Dock, Growth, Fleet, and Enterprise rates are selected by the subscription service, then snapshotted so later commercial changes are prospective. The database uses integer half-up rounding:

\[
\text{feeMinor} = \left\lfloor\frac{\text{eligibleBaseMinor}\times\text{rateBps}+5000}{10000}\right\rfloor
\]

Package and credit balances are locked projections supported by immutable entries. Retrying a command returns its original entry. Reversals append a compensating entry that references the original.

## Evidence and encryption

R2 object bytes are private. PostgreSQL stores object key, content hash, media type, retention class, and lifecycle metadata. Signed waivers bind a version, signer, participant/guardian, timestamp, consent evidence, signed-object hash, and document object. Designated medical, participant, credential, emergency-contact, and incident fields use envelope-encrypted ciphertext with key versions.

## Evolution rules

- Never delete or rewrite financial or signed evidence.
- Add nullable columns or new tables first, backfill in bounded jobs, then enforce constraints.
- Create large indexes concurrently outside a transaction in post-baseline migrations.
- Version JSON structures and promote frequently queried properties to typed columns.
- Do not add advisory locks or `LISTEN/NOTIFY` dependencies, because the runtime path uses Hyperdrive.
- Do not route Hyperdrive through Neon’s pooled endpoint. Hyperdrive owns runtime pooling and connects to Neon’s direct endpoint.
- Keep a cache-disabled Hyperdrive binding for authoritative reads. A cache-enabled binding requires an explicit staleness budget and cannot serve authorization, financial, inventory, or read-after-write paths.
- A schema change that affects a public event or API must remain backward compatible for its published support window.
