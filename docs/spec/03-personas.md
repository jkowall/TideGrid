# 3. Personas and jobs to be done

## Internal operator roles

| Persona | Primary jobs | Critical permissions | Restricted actions |
|---|---|---|---|
| Operator owner | Configure organization, review performance, control commercial and security settings | All tenant locations, billing, Stripe onboarding, roles, exports | Cannot alter immutable evidence or bypass audit |
| General manager | Run locations, approve overrides, disruptions, refunds, maintenance return-to-service | Assigned locations, pricing, staffing, refunds, sensitive approvals | No SaaS billing or platform administration |
| Dispatcher | Build and monitor departures, assign resources and crew, manage disruptions | Scheduling, assignments, operational overrides, manifests | No payment-method access or medical detail beyond readiness |
| Front-desk employee | Create manual bookings, take payment, check in, manage paperwork and equipment | Customer-facing booking and check-in at assigned locations | Limited refunds, no unrestricted medical notes |
| Captain | Review assigned departure, crew and manifest; execute checklists and trip states | Assigned departures, offline commands, incidents, return state | No pricing, refunds, customer merge, or package adjustment |
| Divemaster | Verify dive readiness, groups, buddies, equipment, and dive execution | Assigned dive departures and permitted health-readiness summary | No unrelated medical detail or financial administration |
| Dive instructor | Validate training prerequisites and participant readiness | Assigned instruction products and certification evidence | No fleet-wide customer or finance access |
| Fishing guide | Review party, trip plan, equipment, notes, and catch/closeout fields | Assigned fishing departure | No organization-wide administration |
| Deckhand | Check in, board, equipment return, checklist, and operational notes | Assigned departure and task-specific commands | No medical detail, pricing, refunds, or customer exports |
| Accountant or bookkeeper | Reconcile orders, payments, refunds, platform fees, payouts, tips, and exports | Financial reports, ledgers, accounting export | No medical records; no operational overrides |

## Customer and partner roles

| Persona | Primary jobs | Access model |
|---|---|---|
| Customer or primary booker | Find availability, pay, manage party, invite participants, reschedule within policy | Optional account or scoped magic link |
| Individual participant | Complete waiver, profile, certification, equipment sizes, and check-in requirements | Participant-specific expiring magic link |
| Parent or legal guardian | Sign for linked minors, manage required information, review versions | Verified guardian link and relationship evidence |
| Hotel concierge or affiliate | Search permitted inventory, create attributed booking, track commission | Scoped partner account or signed affiliate link |

## Platform roles

| Persona | Primary jobs | Guardrails |
|---|---|---|
| Platform administrator | Operate tenants, entitlements, feature flags, provider configuration, and abuse response | MFA, just-in-time privilege, immutable audit, no silent impersonation |
| Customer support agent | Diagnose tenant issues, inspect delivery and sync status, replay safe events | Audited, time-bounded support session; sensitive fields masked by default |

## Jobs to be done

### Owner

When the day is busy or disrupted, I want to see whether every departure has the people, equipment, documents, capacity, and money required, so I can intervene before a problem reaches the dock.

### Dispatcher

When schedules or conditions change, I want to move the affected operational record and all dependent work together, so I do not rebuild the day across separate tools.

### Captain

When I am assigned a trip, I want the current manifest, emergency contacts, readiness state, and checklists available without a signal, so I can operate and record events offshore.

### Front desk

When guests arrive at once, I want a sunlight-readable readiness view and fast corrective actions, so I can board the right people without overlooking requirements.

### Accountant

When a departure closes, I want the sale, platform fee, refunds, credits, packages, POS, tips, and payout connected to the same record, so I can reconcile without spreadsheet joins.

### Primary booker

When I book for a group, I want to pay once and let each participant complete their own requirements, so I do not collect sensitive information on their behalf.

### Participant

When I receive a trip link, I want to complete only the information required for my activity and know whether I am ready, so arrival is predictable.

## Authorization principles

- Role grants define actions; location scope limits where those actions apply.
- Assignment scope further limits captain and crew access to their departures.
- Sensitive medical, minor, identity, and credential fields use explicit field permissions.
- Every override requires a reason code, note, actor, timestamp, and before/after state.
- Platform access never inherits tenant-owner authority implicitly.
