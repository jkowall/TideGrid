# 13. Domain event catalog

## Event envelope

Every event is inserted into `transactional_outbox` in the same transaction as the domain change.

```json
{
  "event_id": "uuid",
  "event_type": "booking.confirmed.v1",
  "event_version": 1,
  "tenant_id": "uuid",
  "aggregate_type": "booking",
  "aggregate_id": "uuid",
  "aggregate_version": 7,
  "occurred_at": "2026-07-15T18:42:11.123Z",
  "correlation_id": "uuid",
  "causation_id": "uuid",
  "actor": {"type": "user", "id": "uuid"},
  "data": {},
  "metadata": {"source": "booking-api"}
}
```

`event_id` is globally unique. Ordering is guaranteed only per aggregate version. Consumers insert `(tenant_id, consumer_name, event_id)` before committing effects. Payloads contain identifiers and operational data, not secrets, medical answers, full waiver content, or payment method data.

## Catalog

| Event type | Trigger | Required data | Primary consumers |
|---|---|---|---|
| `checkout.holds_acquired.v1` | All requirements held | checkout, expiry, requirement IDs | Widget, expiry scheduler |
| `checkout.expired.v1` | Hold deadline passed | checkout, released requirements | Messaging, analytics |
| `checkout.finalization_exception.v1` | Late payment cannot reacquire | payment, unavailable requirements | Refund orchestrator, operator alert |
| `booking.created.v1` | Booking draft persisted | booking, departure, customer | Audit projection |
| `booking.confirmed.v1` | Payment/value and inventory finalized | booking, order, participants | Confirmation, manifest, integration |
| `booking.cancelled.v1` | Full cancellation committed | booking, actor, reason, remedy | Messaging, waitlist, reconciliation |
| `booking.rescheduled.v1` | Full/partial move committed | source, target, participant IDs, deltas | Messaging, manifest |
| `booking.readiness_changed.v1` | Derived readiness changes | booking, previous/new state, blockers | Operator UI, reminders |
| `participant.added.v1` | Participant added | booking participant, requirements | Waiver/certification journeys |
| `participant.checked_in.v1` | Check-in command accepted | participant, booking, actor/device | Manifest, operator UI |
| `participant.boarded.v1` | Boarding command accepted | participant, departure, actor/device | Manifest |
| `participant.no_show.v1` | No-show command accepted | participant, booking, actor/device | Reconciliation, messaging |
| `participant.disembarked.v1` | Return accounted for | participant, departure, timestamp | Closeout |
| `waiver.signed.v1` | Immutable signature saved | evidence ID, version, participant, hash | Readiness, retention |
| `waiver.reviewed.v1` | Human accepts/rejects | evidence, result, reviewer, reason | Readiness, messaging |
| `capacity.released.v1` | Held/confirmed units released | departure, dimensions, quantities | Waitlist matcher |
| `resource.reserved.v1` | Exclusive reservation confirmed | resource, range, departure | Operations calendar |
| `equipment.allocated.v1` | Pool/item allocated | booking, participant, range, quantity | Rental operations |
| `equipment.condition_recorded.v1` | Return/damage/loss recorded | item/allocation, condition, incident | Maintenance, finance |
| `package.entry_posted.v1` | Ledger entry committed | account, entry, delta, balance | Customer account, reconciliation |
| `credit.entry_posted.v1` | Credit/gift ledger entry committed | account, entry, delta, balance | Customer account, reconciliation |
| `order.paid.v1` | Verified payment finalized | order, payment, totals, fee ID | Receipt, reconciliation |
| `refund.requested.v1` | Refund aggregate created | refund, allocations, approval need | Approval workflow |
| `refund.succeeded.v1` | Provider and ledger finalized | refund, provider ID, fee reversal | Receipt, reconciliation |
| `payment.reconciliation_required.v1` | Provider/internal mismatch | attempt, provider state, reason | Finance exception queue |
| `dispute.opened.v1` | Verified provider dispute | dispute, payment, amount, deadline | Operator alert, evidence workflow |
| `dispute.closed.v1` | Provider closes dispute | dispute, outcome, amount | Ledger/reconciliation |
| `departure.state_changed.v1` | Valid transition committed | departure, previous/new, actor, reason | Ops UI, messaging |
| `departure.manifest_snapshotted.v1` | Departure/return snapshot saved | departure, snapshot, hash | Evidence retention |
| `departure.incident_created.v1` | Incident recorded | incident, departure, severity | Safety escalation |
| `crew.assignment_changed.v1` | Confirm/replace/cancel | departure, assignment, role, exception | Crew app, schedule |
| `disruption.approved.v1` | Human approves plan | case, approver, evidence, actions | Durable executor |
| `disruption.action_completed.v1` | One target action completes | case, action, result | Disruption projection |
| `message.delivery_changed.v1` | Provider callback changes delivery | message, state, provider code | Journeys, support |
| `offline.conflict_created.v1` | Command cannot merge | command, conflict type, target | Operator conflict queue |
| `device.revoked.v1` | Device loses authorization | device, actor, reason | Sync denial, remote purge signal |

## Publication and failure handling

The outbox sweeper claims rows with `FOR UPDATE SKIP LOCKED`, publishes queue messages, and marks them published. A queue notification is a wake-up hint, never the record of truth. A scheduled sweep catches missed hints.

Cloudflare Queues delivers at least once. Consumers:

1. begin a tenant-scoped database transaction;
2. insert the consumption key;
3. return success on uniqueness conflict;
4. validate event version and aggregate assumptions;
5. write effects and any new outbox rows;
6. commit before acknowledging.

Transient failures retry with exponential backoff and jitter. Poison messages reach a DLQ with payload reference, error, attempt count, and correlation ID. Replay is an audited operator command.

## Versioning

Event names end in `.vN`. Within a version, producers may only add optional fields. A breaking payload or semantic change publishes a new version in parallel. Consumers advertise supported versions, and removal requires usage evidence, migration, and an announced support window.
