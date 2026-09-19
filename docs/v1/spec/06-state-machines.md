# 6. State machines

## Transition contract

Every accepted transition writes:

- aggregate ID and previous/new state;
- aggregate version;
- tenant, actor or service principal, role, device, and correlation ID;
- reason and override code when required;
- business-effective and recorded timestamps;
- domain event and audit event in the same transaction;
- resulting notifications or provider commands as outbox records.

Transitions use optimistic aggregate versions plus row locking when they consume scarce inventory or balances. A reversal is a compensating transition. History is never deleted.

## A. Checkout session

States: `draft`, `holding`, `payment_pending`, `completed`, `expired`, `abandoned`, `exception`.

| From | Command | To | Actor and guard | Transactional side effects |
|---|---|---|---|---|
| draft | acquire holds | holding | Booker/staff; quote valid | Lock and create all capacity, resource, equipment, add-on, and package holds |
| holding | extend | holding | System; extension budget and all holds active | Extend every hold atomically |
| holding | start payment | payment_pending | Booker/staff; order created | Persist payment attempt and payment-pending deadline |
| holding | expire/abandon | expired/abandoned | Scheduler/booker | Release all holds and package hold ledger entries |
| payment_pending | provider success | completed | Verified webhook; holds active or reacquired | Confirm reservations, redemption, booking and order; append outbox |
| payment_pending | provider failure | holding | Verified webhook; hold still active | Mark attempt failed; permit safe retry |
| payment_pending | success after expiry | completed/exception | Verified webhook | Reacquire all atomically or create refund and operator exception |
| any nonterminal | invariant failure | exception | System | Preserve evidence, release safe holds, alert operator |

Terminal states cannot be reopened. A new checkout references the prior session.

## B. Booking

Booking uses orthogonal state dimensions to avoid one state field combining service, readiness, and finance.

### Lifecycle

`draft`, `held`, `confirmed`, `partially_cancelled`, `cancelled_customer`, `cancelled_operator`, `rescheduled`, `completed`.

### Service state

`not_started`, `partially_checked_in`, `checked_in`, `partially_boarded`, `boarded`, `no_show`, `completed`.

### Readiness

`payment_pending`, `payment_failed`, `waiver_incomplete`, `requirements_incomplete`, `ready_for_check_in`, `blocked`.

### Financial projection

`unpaid`, `paid`, `partially_refunded`, `fully_refunded`, `disputed`, `chargeback_lost`.

| Command | Required permission/guard | Result and side effects |
|---|---|---|
| confirm | Checkout orchestrator; payment/stored value and inventory finalized | Lifecycle confirmed; confirmation and participant invitations queued |
| add/remove/replace participant | Booker within policy or staff; capacity and requirements valid | Reprice, adjust capacity/equipment, invalidate readiness as needed |
| change booker | Current booker verification or staff override | New scoped link; old link revoked; audit |
| move full/partial party | Staff or eligible self-service; target holds acquired first | Source/target allocations change atomically; price/refund/credit delta recorded |
| cancel full/partial | Booker policy or staff | Release corresponding capacity/equipment; restore package units; request calculated refund |
| check in/board/no-show | Front desk or assigned crew | Update participant service state and derived booking service state |
| complete | Departure closeout | Lifecycle/service completed; post-trip journeys queued |

The UI may present summary labels such as “Payment failed” or “Disputed,” but command guards use the underlying dimension.

## C. Order

States: `draft`, `open`, `payment_pending`, `paid`, `partially_refunded`, `refunded`, `disputed`, `closed`, `void`.

- Draft becomes open only after immutable order lines, currency, seller legal entity, Stripe account, and fee base are fixed.
- Open becomes payment pending when an attempt is created.
- Only verified payment state or reconciliation can mark paid.
- Refund states derive from succeeded refund allocations, not requests.
- Disputed may coexist with delivered service; it blocks automatic close.
- Void is allowed only before successful payment and cannot delete order lines.
- Closed requires matched payments, fees, refunds, and dispute disposition.

## D. Payment attempt

States: `created`, `requires_method`, `requires_action`, `processing`, `succeeded`, `failed`, `cancelled`, `reconciliation_required`.

| Event | Transition rule |
|---|---|
| Provider create response | Move to provider-reported actionable state and store provider IDs |
| Browser return | Read-only refresh; no authoritative transition |
| Verified webhook | Apply only if provider object/version is newer or fills missing evidence |
| Duplicate webhook | No-op after inbox uniqueness/idempotent handler check |
| Out-of-order event | Retrieve current provider object when event would regress state |
| Succeeded but finalization fails | `reconciliation_required`; retry booking finalization idempotently |
| Cancelled/failed | Release payment-pending holds if no other active attempt |

`succeeded` never regresses. Later refunds and disputes use separate aggregates.

## E. Refund

States: `requested`, `approved`, `submitted`, `pending`, `succeeded`, `failed`, `cancelled`, `reconciliation_required`.

- A request must contain line-level allocation across service, tax, tip, stored value, cash, package units, equipment, and application fee.
- Approval follows amount and role thresholds.
- Submission uses one internal idempotency key and connected-account context.
- Success appends refund, fee-reversal, credit/package, and order projection entries atomically.
- Provider success with incomplete internal allocation enters reconciliation required.
- Retrying a failed request reuses the same refund aggregate unless the provider definitively rejected it before creation.

## F. Departure

States: `draft`, `scheduled`, `minimum_not_met`, `confirmed_to_run`, `weather_watch`, `delayed`, `boarding`, `departed`, `returned`, `closed`, `cancelled`, `aborted`.

| Command | Allowed from | Guard and side effects |
|---|---|---|
| schedule | draft | Valid local time, product, capacity, and initial requirements |
| evaluate minimum | scheduled/minimum_not_met | Derive count; notify operator before cutoff |
| confirm to run | scheduled/minimum_not_met/weather_watch | Authorized human; resources and readiness sufficient or overrides documented |
| place watch/delay | scheduled/confirmed/weather_watch | Open/link disruption case; update customer-visible time only after approval |
| begin boarding | confirmed/delayed | Vessel/captain assigned; mandatory checklist threshold met |
| depart | boarding | Captain; all aboard confirmation; immutable manifest snapshot |
| return | departed | Captain; actual return and disembark reconciliation |
| close | returned | All boarded accounted for; equipment and open incidents explicit; financial close status recorded |
| cancel | pre-departure states | Disruption remedy plan required |
| abort | departed | Captain/manager; incident and return/recovery workflow required |

Departed cannot return to a pre-departure state. Corrections append actual-time or manifest amendments.

## G. Participant on a booking

States: `invited`, `profile_incomplete`, `requirements_incomplete`, `ready`, `checked_in`, `boarded`, `no_show`, `disembarked`, `removed`, `replaced`.

- Profile and requirement completion are recalculated from current product rules and evidence.
- Check-in requires payment/readiness or authorized override.
- Boarded requires check-in except for documented emergency/manual recovery.
- Removed or replaced after check-in requires staff authority and capacity/equipment reconciliation.
- A boarded participant cannot be removed; they must be disembarked or associated with an incident.
- Two devices issuing the same state command resolve by command ID and monotonic transition rules.

## H. Waiver/evidence requirement

States: `not_requested`, `requested`, `viewed`, `signed`, `under_review`, `accepted`, `rejected`, `expired`, `superseded`.

- Signature binds immutable template version, participant, signer/guardian, content hash, timestamp, and consent evidence.
- Required manual review moves signed to under review.
- A new mandatory version marks prior evidence superseded and recalculates readiness.
- Rejection requires reason and may allow resubmission.
- Accepted evidence is never edited; correction creates a new evidence record.

## I. Equipment reservation/allocation

States: `held`, `allocated`, `checked_out`, `returned`, `cleaning`, `maintenance`, `damaged`, `lost`, `released`, `cancelled`.

- Held consumes inventory until expiry/release.
- Allocation requires confirmed booking and specific participant or departure.
- Checked out records custodian, condition, and time.
- Return records condition; damaged/lost routes to incident and financial review.
- Pooled units use quantity deltas; serialized items use item identity and occupied ranges.
- Cleaning and maintenance block future availability.

## J. Package redemption

States: `held`, `redeemed`, `released`, `reinstated`, `expired`, `disputed`.

- Hold appends a negative pending entry while the locked balance projection remains nonnegative.
- Redeem converts the hold without a second decrement.
- Release appends a compensating positive entry.
- Eligible cancellation appends reinstatement referencing the original redemption.
- Expiration is a distinct ledger action, never deletion.
- Dispute after use creates an exception and does not silently reverse delivered service.

## K. Crew assignment

States: `proposed`, `confirmed`, `checked_in`, `completed`, `cancelled`, `replaced`, `exception`.

- Confirm validates time overlap, role, qualifications, credentials, route, availability, and ratios.
- Override moves to exception and requires manager reason; the assignment can still be operationally confirmed.
- Replacement validates the new member before releasing the old assignment.
- Actual hours and applicable tip roster snapshot at completion.
- A departed assignment is corrected through replacement/amendment history, not deletion.

## L. Disruption case

States: `draft`, `watching`, `decision_required`, `approved`, `executing`, `partially_resolved`, `resolved`, `cancelled`.

| Transition | Guard |
|---|---|
| draft to watching | Reason/evidence and affected departures recorded |
| watching to decision required | Deadline, alert, or operator escalation |
| decision required to approved | Authorized human selects actions and customer remedies |
| approved to executing | Idempotent per-booking/per-departure tasks created |
| executing to partially resolved | At least one task complete and exceptions remain |
| executing/partial to resolved | All affected records have an explicit outcome |
| draft/watching to cancelled | Condition cleared; actor and evidence retained |

Execution tasks are independently retryable. One failed refund or message cannot roll back successful capacity and schedule changes.

## Permission and reversal summary

| Action class | Minimum authority | Reversal |
|---|---|---|
| Self-service within policy | Verified booker/participant | New compensating command within policy |
| Check-in/boarding | Front desk or assigned crew | Staff correction before departure; amendment after departure |
| Resource/crew substitution | Dispatcher | New substitution; never erase history |
| Refund or credit | Threshold-based finance role | Compensating charge/ledger entry only where legally and contractually valid |
| Safety-affecting departure state | Captain or manager per tenant policy | New human decision with evidence |
| Qualification/capacity override | Manager | Expire/revoke override and revalidate |
| Platform intervention | JIT privileged support/admin | Tenant-visible audit and explicit remediation |
