# 15. Offline synchronization protocol

The captain application is a React Native native build with a SQLCipher-backed local database. It supports assigned-departure operations during loss of connectivity. It is not an offline booking, pricing, payment, capacity, identity-administration, refund, package-balance, or crew-scheduling system.

## Device lifecycle

1. User signs in online with MFA as policy requires.
2. App generates a device key in Secure Enclave/Android Keystore and registers the public key.
3. Server grants assignment-scoped synchronization and issues short-lived tokens.
4. App downloads encrypted deltas for assigned departures within the configured time window.
5. Revocation blocks new sync, records `device.revoked.v1`, and signals local purge on next contact.
6. After trip close plus retention grace, local PII, manifests, documents, tokens, and keys are cryptographically purged.

Biometric access is a local convenience, not a substitute for server authentication. Rooted/jailbroken-device policy is tenant configurable, with high-risk access denied by default.

## Data classes

| Class | Offline behavior |
|---|---|
| Manifest identity, emergency contact, waiver/cert readiness | Read-only cached projection, minimum necessary fields |
| Check-in, boarding, no-show, disembark | Device commands, monotonic merge |
| Checklist completion and notes | Per-item commands, field-level merge |
| Equipment checkout/return and condition | Device commands, conflict if custody overlaps |
| Incident draft and attachments | Locally encrypted queue, server append-only on acceptance |
| Booking price/payment/refund | Read-only summary, no mutation |
| Capacity and resource assignments | Read-only, server authoritative |
| Package/gift/credit balances | Read-only last-known value, no redemption |
| Medical details | Excluded unless a specific safety workflow and policy authorize minimum data |

## Command envelope

Each device command contains:

- device-scoped UUID `command_id`;
- strictly increasing `local_sequence`;
- command type and payload version;
- aggregate type/ID and optional `base_version`;
- device-observed time plus monotonic local ordering;
- encrypted payload at rest;
- user, device, assignment, and app-version context added during upload.

The server stores the command before execution, deduplicates by `(tenant_id, command_id)` and `(tenant_id, device_id, local_sequence)`, then returns `applied`, `noop`, `conflict`, `rejected`, or `failed`. A failed transport never changes the command ID.

## Merge rules

| Command | Deterministic rule |
|---|---|
| Check in | Apply if current state precedes check-in; same/later compatible state is no-op |
| Board | Apply only after checked-in, or with authorized recovery evidence; duplicate is no-op |
| No-show | Conflict if already boarded; no-op if already no-show |
| Disembark | Apply only to boarded participant; duplicate is no-op |
| Checklist item | Merge by item ID and item version; incompatible answer after lock is conflict |
| Equipment checkout | Conflict if item has another active custodian or allocation |
| Equipment return | Apply to matching active custody; condition changes append evidence |
| Incident | Always append once by command ID; never merge chronology by last write |
| Free-form note | Append once; correction appends another note |

Device timestamps order commands from one device but do not override server state. Cross-device resolution uses state-machine monotonicity, server receipt sequence, base version, assignment authority, and explicit conflicts. There is no general last-write-wins rule.

## Download protocol

`GET /v1/offline/deltas` returns assignment, manifest, or operations streams after a server sequence cursor. A page includes next cursor, has-more flag, aggregate version, tombstones, and data. The app applies a page in one SQLCipher transaction and advances the cursor only after commit.

If a cursor is older than retained deltas, the server returns `410` and the app requests a fresh authorized snapshot. Snapshot generation records scope, version, expiry, and hash. Removed assignments create tombstones and immediate local-access revocation.

## Upload and conflict recovery

Commands upload in local sequence order, at most 100 per batch. Independent aggregates may be processed in parallel after durable receipt; commands for the same aggregate preserve sequence. Retryable failures remain queued. A conflict stores server state and device intent in `sync_conflicts` and appears in an operator queue.

The device receives authoritative deltas after each upload, including its own accepted changes. UI states distinguish pending, synced, rejected, and needs review. A rejected safety-relevant command cannot be silently discarded.

## Security controls

- SQLCipher database key wrapped by hardware-backed keystore.
- TLS, certificate validation, token binding to registered device key where supported.
- Screen capture and background previews suppressed on sensitive views.
- No sensitive payloads in push notifications, analytics, crash logs, or OS backups.
- Attachment encryption before local storage and resumable upload.
- Configurable idle lock, remote revocation, data expiry, and post-trip purge.
- Server audit links every accepted/rejected command to user, device, app version, assignment, and correlation ID.

## Failure cases

Clock skew, app reinstall, sequence gaps, duplicate batches, two active devices, permission revocation, trip reassignment, expired delta cursor, partial attachment upload, and server rollback all have explicit test cases. Financial or capacity changes discovered after reconnection are shown as server-authoritative exceptions, never rewritten by local state.
