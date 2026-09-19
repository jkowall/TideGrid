Act as an elite Vertical SaaS Enterprise Architect, Principal Software Architect, and Senior Product Manager.

I am designing a focused, lightweight B2B booking and operational platform tailored specifically to boat charter and dive boat operators. Supported operator types include dive charters, fishing charters, sunset cruises, sightseeing excursions, private charters, snorkel boats, and similar passenger-vessel operations.

The platform should be a highly reliable and operationally focused alternative to broad, generic tour engines such as FareHarbor.

The product is not simply a booking widget. Its long-term goal is to become the system of operational record for every vessel departure, from initial availability and customer checkout through check-in, vessel departure, return, financial reconciliation, and post-trip follow-up.

MONETIZATION

The platform uses a hybrid monetization model:

1. A flat monthly SaaS subscription paid by each operator.
2. A 1% platform transaction fee on eligible booking transactions.
3. Stripe Connect for operator payment processing.
4. The specification must clearly define which transaction types are subject to the 1% platform fee, including:
   - Standard bookings
   - Private charters
   - Package purchases
   - Package redemptions
   - Gift card purchases
   - POS purchases
   - Tips
   - Taxes
   - Refunds
   - Cash or externally recorded payments
   - OTA-imported bookings
5. Avoid charging the platform fee twice when a package is purchased and later redeemed.
6. Treat SaaS subscription billing separately from customer booking payments.

PRODUCT STRATEGY

Design the system as:

1. A shared maritime booking and operations core.
2. A specialized dive operations module.
3. A specialized fishing operations module.
4. A sightseeing, excursion, and private-charter module.
5. An extensible architecture that allows later vertical modules without putting every vertical-specific field into the core booking model.

Explicitly separate:

- MVP functionality
- Near-term post-MVP functionality
- Long-term platform functionality
- Intentional non-goals

MVP NON-GOALS

Unless a compelling reason is identified, the first release should not include:

- Flexible payment plans
- Split deposits
- Full payroll processing or tax filing
- Direct payouts to individual crew members
- A complete retail inventory management system
- A full OTA channel manager
- Fully automated weather-based safety or cancellation decisions
- Advanced marketing automation
- A generalized ERP or accounting system

Replace these with lightweight MVP equivalents such as:

- 100% upfront payment
- Crew scheduling and payroll export
- Crew tip allocation ledger
- Basic dockside POS line items
- Public API and webhook foundations
- Human-approved disruption workflows
- Transactional reminders and review requests

PERSONAS AND USER TYPES

Define workflows, permissions, and jobs to be done for:

- Operator owner
- General manager
- Dispatcher
- Front-desk employee
- Captain
- Divemaster
- Dive instructor
- Fishing guide
- Deckhand
- Accountant or bookkeeper
- Customer or primary booker
- Individual participant
- Parent or legal guardian
- Hotel concierge or affiliate
- Platform administrator
- Customer support agent

Support multi-tenant SaaS organizations with:

- Multiple brands
- Multiple locations
- Multiple docks and marinas
- Multiple vessels
- Multiple legal entities where necessary
- Multiple Stripe accounts where necessary
- Location-specific operating time zones
- Role-based and location-based permissions

1. CATALOG, TRIP CONFIGURATION, AND PRICING

Allow operators to configure:

- Trip templates
- Trip variants
- Shared by-the-seat departures
- Private whole-boat charters
- Recurring schedules
- Seasonal schedules
- One-time departures
- Blackout dates
- Booking lead times
- Online booking cutoff times
- Check-in time
- Boarding time
- Departure time
- Expected return time
- Trip duration
- Preparation and turnaround buffers
- Minimum passenger counts
- Maximum passenger counts
- Departure location
- Return location
- Meeting instructions
- Passenger types
- Adult, child, diver, snorkeler, observer, rider, and non-diver pricing
- Add-ons
- Taxes
- Mandatory fees
- Optional gratuities
- Promo codes
- Staff discounts
- Complimentary bookings
- Affiliate pricing
- Private charter flat rates
- Dynamic or seasonal pricing rules
- Cancellation policies by product
- Rescheduling policies by product
- Package eligibility rules
- Required qualifications
- Required waivers and forms

Support manual bookings created by:

- Telephone
- Walk-up
- Hotel concierge
- Affiliate
- Operator staff
- Imported booking
- Complimentary or promotional reservation

2. BOOKING, ORDER, AND DEPARTURE STATE MACHINES

Define separate, explicit state machines for:

A. Checkout sessions
B. Bookings
C. Orders
D. Payments
E. Refunds
F. Departures
G. Participants
H. Waivers
I. Equipment reservations
J. Package redemptions
K. Crew assignments
L. Disruption cases

A booking state model should account for states such as:

- Draft
- Inventory held
- Payment pending
- Confirmed
- Waiver incomplete
- Ready for check-in
- Checked in
- Partially checked in
- Boarded
- Completed
- Rescheduled
- Partially cancelled
- Cancelled by customer
- Cancelled by operator
- No-show
- Payment failed
- Partially refunded
- Fully refunded
- Disputed
- Chargeback lost

A departure state model should account for:

- Draft
- Scheduled
- Minimum passenger count not met
- Confirmed to run
- Weather watch
- Delayed
- Boarding
- Departed
- Returned
- Closed
- Cancelled
- Aborted

Define valid transitions, transition permissions, side effects, notifications, audit events, and reversal rules.

Support:

- Adding or removing guests after booking
- Replacing a participant
- Changing the primary booker
- Moving only part of a group
- Transferring a booking
- Adding or removing rental equipment
- Partial cancellation
- Partial rescheduling
- Partial refund
- Price adjustments
- Operator overrides
- Required override reason codes
- Internal notes
- Customer-visible notes
- No-show handling
- Late arrival handling
- Walk-up additions
- Vessel substitutions
- Crew substitutions

3. GENERALIZED RESOURCE-BASED BOOKING ENGINE

Do not model availability as merely one vessel plus one captain.

Create a generalized resource requirement and reservation system.

Resource types may include:

- Vessel
- Captain
- Divemaster
- Instructor
- Fishing guide
- Deckhand
- Dock
- Marina slip
- Dive site permit
- Departure location
- Trailer
- Transport vehicle
- Rental equipment
- Cylinder
- Gas blend
- Camera equipment
- Compressor
- Specialized safety equipment

Each trip template or departure must be able to declare:

- Required resource type
- Required quantity
- Required qualification
- Time-window requirements
- Preparation buffer
- Cleanup buffer
- Whether substitution is allowed
- Whether operator approval is required
- Whether the resource is exclusive or capacity-based

Prevent a vessel, captain, or other exclusive resource from being double-booked across overlapping time ranges.

Support:

- Vessel maintenance blocks
- Crew unavailability
- Training blocks
- Dock closures
- Preparation blocks
- Cleaning blocks
- Fueling blocks
- Out-of-service periods
- Tentative private-charter option holds
- Manual administrative holds
- Resource substitution

4. MULTIDIMENSIONAL CAPACITY MANAGEMENT

Do not use only one passenger-capacity integer.

Support capacity dimensions such as:

- Maximum passengers
- Maximum total persons aboard
- Crew seats
- Diver capacity
- Snorkeler capacity
- Observer capacity
- Child capacity
- Gear storage capacity
- Tank capacity
- Weight or configuration restrictions where necessary
- Vessel certificate or inspection limits
- Trip-specific capacity limits
- Crew-to-passenger ratios
- Divemaster-to-diver ratios

Allow a vessel’s capacity profile to vary by:

- Trip type
- Crew complement
- Passenger mix
- Operating route
- Vessel configuration
- Inspection or regulatory classification

The database and booking transaction must prevent overselling even when multiple customers check out concurrently.

5. CHECKOUT HOLDS AND CONCURRENCY CONTROL

Implement temporary checkout holds for:

- Seats
- Whole-vessel inventory
- Rental equipment
- Package units
- Add-ons with finite inventory
- Private-charter date options

Define:

- Hold duration
- Expiration behavior
- Extension behavior
- Payment-pending behavior
- Abandoned checkout cleanup
- Late payment-success behavior
- Administrative override behavior

Do not use an in-memory cache as the authoritative source for inventory.

The PostgreSQL database must remain the final authority for:

- Capacity
- Resource availability
- Package balances
- Equipment availability
- Booking confirmation

Use transactions, row locks, database constraints, unique idempotency keys, and appropriate isolation levels.

Include automatic retry behavior for safe serialization failures.

6. CUSTOMER, PARTY, PARTICIPANT, AND IDENTITY MODEL

Keep these concepts separate:

- Customer account
- Primary booker
- Booking party
- Individual participant
- Guardian
- Emergency contact
- Crew member
- Affiliate
- Operator user

Do not require every participant to create an account.

Support:

- Magic-link access
- Booker-managed guest invitations
- Individual participant links
- Guest replacement
- Duplicate customer detection
- Profile merging
- Repeat customer profiles
- Saved certification information
- Saved equipment sizes
- Saved emergency contacts
- Accessibility requests
- Dietary restrictions
- Allergies
- Mobility needs
- Medical-response information
- Communication preferences
- Transactional messaging consent
- Marketing consent
- Per-channel opt-out status
- Operator-only customer flags
- Restricted internal notes

7. PREPAID TRIP CARDS, PACKAGES, GIFT CARDS, AND CREDITS

Support bulk packages such as:

- Ten-dive card
- Five-trip package
- Multi-seat family package
- Corporate package
- Dollar-denominated gift card
- Service credit
- Weather cancellation credit
- Promotional credit

Do not treat all stored value as one generic balance.

Separate:

- Unit-based package entitlements
- Dollar-denominated gift cards
- Promotional credits
- Refund credits
- Operator-issued service credits

A package must support:

- Unit type
- Number of original units
- Eligible products
- Eligible locations
- Eligible passenger types
- Units consumed per product
- Blackout dates
- Validity period
- Expiration
- Extension
- Transferability
- Named ownership
- Shared or family ownership
- Corporate ownership
- Maximum redemptions per booking
- Multiple package redemptions on one booking
- Cancellation reinstatement rules
- Manual adjustments
- Fraud controls
- Secure redemption codes

A two-tank dive may consume two dive units, while a trip-based package may consume one trip unit. Do not assume every redemption decrements a balance by exactly one.

Use an immutable, append-only package ledger with transaction types such as:

- Purchase
- Redemption hold
- Redemption
- Hold release
- Cancellation reinstatement
- Expiration
- Manual credit
- Manual debit
- Refund
- Transfer

Prevent two concurrent checkouts from redeeming the same final package unit.

8. PAYMENTS, STRIPE CONNECT, AND FINANCIAL OPERATIONS

All standard bookings are paid 100% upfront.

Design separate flows for:

A. Online card-not-present checkout
B. Card-present Stripe Terminal payments
C. Customer-authorized card-on-file payments
D. Cash or external payment recording
E. Refunds
F. Partial refunds
G. Disputes and chargebacks
H. SaaS subscription billing
I. Platform transaction fees
J. Operator payouts
K. Tips
L. Gift cards and service credits

Do not conflate Stripe Terminal with charging a saved card.

Require an architecture decision record comparing:

- Direct charges
- Destination charges
- Separate charges and transfers
- Connected account configuration
- Merchant-of-record implications
- Refund responsibility
- Dispute responsibility
- Negative balance responsibility
- Statement descriptors
- Radar and fraud controls
- Tax responsibility
- Terminal compatibility
- Application-fee handling

Recommend the most appropriate model for a vertical SaaS platform where the boat operator generally sells directly to its own customer and the platform takes a 1% fee.

Use:

- One internal order per commercial transaction
- One payment attempt history per order
- Idempotency keys on all payment commands
- Verified Stripe webhook events
- A webhook inbox table
- Unique provider event IDs
- Raw event payload retention
- Asynchronous webhook processing
- Reconciliation jobs
- Refund and dispute ledgers
- Payout reconciliation
- Platform fee reconciliation
- Daily financial closeout
- Accounting export

Never mark a booking paid solely because the browser returned to a success URL.

Define what happens when:

- Payment succeeds after a hold expires
- Payment succeeds but booking finalization fails
- Booking finalizes but the notification fails
- A webhook is delivered more than once
- Events arrive out of order
- An application fee must be refunded
- A partial refund restores only part of a package or rental reservation
- A dispute occurs after a package was already used
- An operator account becomes restricted

9. PRIVATE CHARTER INQUIRY AND QUOTE WORKFLOW

Support higher-value private charters through:

- Inquiry form
- Lead record
- Requested date
- Alternate dates
- Temporary vessel option hold
- Custom itinerary
- Custom passenger count
- Custom line items
- Internal pricing review
- Proposal
- Contract
- Customer acceptance
- Expiring payment link
- Full payment upon acceptance
- Change order
- Custom cancellation terms
- Internal approval
- Conversion reporting

This workflow does not require deposits or installment plans.

10. VERSIONED WAIVERS, MEDICAL FORMS, AND DOCUMENTS

Support:

- Waiver templates by operator
- Waiver templates by activity
- Jurisdiction-specific versions
- Effective dates
- Immutable document versions
- Signature timestamp
- Signer identity
- Guardian identity
- Minor participant linkage
- IP and device metadata
- Consent evidence
- Document hash
- Required re-signing
- Medical questionnaires
- Physician-clearance uploads
- Certification uploads
- Operator verification status
- Expiration dates
- Rejection and resubmission
- Offline document snapshots
- PDF export
- Retention policies
- Complete audit history

Do not store only a waiver-complete boolean.

Allow one guardian to sign for multiple minors while preserving a separate participant record and waiver relationship for each minor.

11. MANIFESTS AND DOCKSIDE CHECK-IN

Provide a high-contrast, mobile-first dockside interface optimized for sunlight, wet environments, gloves, and rapid passenger processing.

Do not communicate status solely through red and green.

Use text, icons, and status labels such as:

- Ready
- Missing waiver
- Medical review required
- Payment incomplete
- Certification unverified
- Equipment incomplete
- Checked in
- Boarded
- No-show
- Disembarked

Track separately:

- Booked
- Confirmed
- Paid
- Paperwork complete
- Certification verified
- Medical review complete
- Checked in
- Boarded
- No-show
- Returned ashore

Create an immutable manifest snapshot when the captain marks the vessel departed.

The manifest snapshot must include:

- Participants
- Crew
- Emergency contacts
- Waiver status
- Payment status
- Certifications
- Rental equipment
- Boarding status
- Vessel
- Captain
- Departure time
- Departure location
- Trip details

12. OFFLINE-FIRST CAPTAIN AND DOCKSIDE APPLICATION

Design a dedicated offline-capable captain application.

The system must allow captains to access essential trip information miles offshore without cellular connectivity.

Use:

- Encrypted local device database
- Pre-downloaded trip bundles
- Versioned local records
- Offline command log
- Device identifier
- Command identifier
- Local sequence number
- Server sequence or sync cursor
- Base record version
- Local occurrence timestamp
- Server receipt timestamp
- Retry count
- Sync status
- Conflict status
- Tombstones for deleted or removed records

Distinguish between:

A. Server-authoritative data
- Payments
- Refunds
- Package balances
- Resource allocation
- Final capacity
- Customer identity
- Financial records

B. Offline-operable commands
- Check in participant
- Mark boarded
- Mark no-show
- Mark disembarked
- Add operational note
- Complete checklist
- Record actual departure
- Record actual return
- Record equipment return
- Create incident report

C. Data requiring manual conflict resolution
- Participant replacement
- Capacity-changing edits
- Conflicting boarding status
- Equipment reassignment
- Manifest identity changes

Do not implement offline synchronization as blind last-write-wins record replacement.

Define deterministic merge rules by command type.

Show:

- Last successful synchronization
- Pending local changes
- Failed changes
- Conflict count
- Stale data warning
- Whether a trip bundle is fully available offline

Specify secure device logout, local data expiration, remote session revocation, and post-trip data purging.

13. DISRUPTION AND WEATHER MANAGEMENT

Replace a narrow Weather Hold function with a generalized Disruption Console.

Disruption reasons should include:

- Weather
- Unsafe sea conditions
- Mechanical issue
- Crew illness
- Port closure
- Dive-site closure
- Visibility problem
- Minimum passenger count not met
- Vessel substitution
- Regulatory restriction
- Operator decision

Actions should include:

- Place on watch
- Delay departure
- Change departure location
- Change vessel
- Shorten trip
- Cancel one departure
- Cancel selected departures
- Cancel all departures for a date
- Notify crew only
- Notify customers and crew
- Reschedule full party
- Reschedule part of a party
- Issue service credit
- Issue gift card
- Restore package units
- Initiate refund
- Partially refund
- Enter priority rebooking pool

Weather data may inform operators but must not autonomously make final safety or cancellation decisions.

Maintain an audit trail containing:

- Weather or marine conditions used
- User who made the decision
- Decision time
- Affected departures
- Notification history
- Customer selections
- Refund or credit results

14. WAITLIST AND STANDBY QUEUE

Support:

- Party size
- Date flexibility
- Product preference
- Location preference
- Package-holder priority
- Membership priority
- First-come-first-served priority
- Operator-managed priority
- Automatic or manual offers
- Offer expiration
- Payment method requirement
- Partial-party matching
- Simultaneous acceptance resolution
- Failed payment fallback
- Next-customer promotion
- Offer delivery status
- Customer opt-out

Prevent more than one waitlisted party from claiming the same released capacity.

15. FINITE RENTAL EQUIPMENT AND DIVE LOGISTICS

Treat rental equipment as finite, time-bound inventory.

Support both:

A. Serialized equipment
- Individual regulator
- Camera
- Dive computer
- Specialized cylinder

B. Pooled equipment
- Wetsuits by size
- Masks
- Fins by size
- Weight belts
- Standard cylinders

Track:

- Inventory pool
- Individual item
- Size
- Location
- Condition
- Inspection status
- Maintenance status
- Out-of-service status
- Reservation hold
- Confirmed allocation
- Check-out to participant
- Return
- Damage
- Loss
- Cleaning
- Maintenance block

Prevent concurrent over-allocation during checkout.

Dive-specific functionality should include:

- Certification upload
- Certification verification
- Certification expiration where applicable
- Minimum certification requirement
- Minimum logged dives
- Self-attestation
- Operator verification
- Medical questionnaire
- Physician clearance
- Buddy-pair assignment
- Dive-group assignment
- Divemaster-to-diver ratio
- Dive site
- Dive plan
- Planned maximum depth
- Actual maximum depth
- Planned bottom time
- Actual bottom time
- Gas type
- Cylinder assignment
- Nitrox percentage
- Analyzer confirmation
- Cylinder visual inspection date
- Cylinder hydrostatic inspection date
- Tank-fill log
- Compressor log
- Emergency oxygen checklist
- First-aid checklist
- Optional post-trip digital dive log

16. NO-FLY AND SURFACE-INTERVAL SAFETY CHECK

Collect the customer’s departure flight date and time where applicable.

The no-fly warning must be configurable rather than based on one universal constant.

Consider:

- Number of dives
- Number of consecutive dive days
- Planned decompression status
- Final planned surfacing time
- Operator-configured safety margin
- Customer acknowledgment
- Operator override
- Override reason
- Warning text version

The system should warn and document acknowledgment. It should not claim to replace professional medical or dive-safety advice.

17. CREW SCHEDULING, QUALIFICATIONS, AND COMPLIANCE

Support crew roles including:

- Captain
- Relief captain
- Divemaster
- Instructor
- Guide
- Deckhand
- Mate
- Photographer
- Trainee

Track:

- Availability
- Assigned role
- Planned hours
- Actual hours
- Pay rate metadata
- Payroll category
- Contractor or employee classification
- Qualification eligibility
- Credential type
- Credential restrictions
- Credential expiration
- Medical certificate expiration
- CPR certification
- First-aid certification
- Oxygen-provider certification
- Dive professional certification
- Drug-testing program status where relevant
- Uploaded credential documents
- Verification status
- Expiration alerts

The MVP should provide scheduling, time capture, payroll metrics, and export. It should not provide full payroll tax calculation or tax filing.

Prevent assigning an unqualified or unavailable crew member unless an authorized operator performs a documented override.

18. VESSEL READINESS, MAINTENANCE, AND COMPLIANCE

Track:

- Vessel
- Registration
- Insurance
- Inspection documents
- Certificate or capacity documents
- Permitted route
- Operating restrictions
- Safety equipment
- Inspection dates
- Maintenance schedule
- Defects
- Out-of-service status
- Fueling
- Cleaning
- Required crew complement
- Document expiration
- Vessel substitution history

Support:

- Pre-departure checklist
- Post-trip checklist
- Safety-equipment confirmation
- Defect reporting
- Maintenance work order
- Maintenance block
- Manager return-to-service approval

19. TRIP EXECUTION, INCIDENTS, AND CLOSEOUT

Continue the operational workflow beyond check-in.

Support:

- Daily dispatch board
- Crew briefing
- Pre-departure checklist
- Passenger safety briefing confirmation
- All-passengers-aboard confirmation
- Actual departure time
- Actual return time
- Overdue return alert
- All-passengers-ashore confirmation
- Equipment return
- Lost equipment
- Damaged equipment
- Customer issue
- Fuel note
- Maintenance note
- Incident report
- Near-miss report
- Injury report
- First-aid action
- Witness details
- Photos
- Attachments
- Manager review
- Trip closeout

Generate an incident export containing:

- Departure manifest snapshot
- Crew roster
- Signed waiver versions
- Emergency contacts
- Trip information
- Vessel information
- Relevant communications
- Incident chronology
- Photos and attachments
- Operator review

20. COMMUNICATIONS AND NOTIFICATIONS

Use SMS and email, not SMS alone.

Support:

- Transactional SMS
- Transactional email
- Delivery status tracking
- Failure tracking
- Email fallback
- Resend
- Two-way inbound replies
- Shared message history
- Operator templates
- Product-specific templates
- Location-specific templates
- Multilingual templates
- Quiet hours
- Transactional consent
- Marketing consent
- Per-recipient opt-out
- Sender configuration
- Failed-delivery alert
- Message deduplication
- Message idempotency

Post-checkout messaging should:

- Confirm the booking
- Send a primary-booker management link
- Send waiver links
- Allow the booker to invite participants
- Remind incomplete participants
- Provide arrival instructions
- Communicate disruption updates
- Provide post-trip tipping and review links

Store Twilio provider status IDs, message status history, errors, and delivery timestamps.

21. TIPPING AND REVIEWS

For MVP:

- Collect tips through the operator’s payment account.
- Maintain an auditable crew tip-allocation ledger.
- Allow allocation by fixed percentage, role, hours, equal split, or manager override.
- Record the crew roster applicable at the time of the trip.
- Support refund and adjustment handling.
- Export tip allocations for payroll or accounting.

Treat direct payouts to individual crew members as post-MVP because they require separate onboarding, identity, payout, refund, dispute, negative-balance, and tax workflows.

Support post-trip prompts for:

- Google reviews
- TripAdvisor reviews
- Operator-owned customer feedback
- Incident or complaint escalation

Avoid asking an unhappy customer for a public review until an internal service-recovery workflow is complete.

22. DISTRIBUTION AND INTEGRATIONS

Include:

- Embeddable booking widget
- Hosted branded booking page
- Product-specific deep links
- Departure-specific deep links
- UTM attribution
- Booking-source attribution
- Affiliate links
- Concierge booking
- Public API
- Outgoing webhooks
- Customer import
- Booking import
- Package import
- Historical data migration
- CSV export
- Accounting export
- Google Analytics or equivalent events

Treat full two-way OTA inventory synchronization as post-MVP, but design an integration boundary that can later support:

- Viator
- GetYourGuide
- Hotel concierges
- Local affiliates
- Resellers
- Tourism bureaus
- Other booking platforms

23. REPORTING AND ANALYTICS

Provide operational and financial reporting for:

- Revenue by trip
- Revenue by vessel
- Revenue by location
- Revenue by source
- Gross revenue
- Net revenue
- Taxes
- Fees
- Refunds
- Platform fees
- Occupancy
- Load factor
- Revenue per available seat
- Minimum-passenger failures
- Weather cancellation rate
- Mechanical cancellation rate
- Reschedule rate
- Refund rate
- No-show rate
- Repeat-customer rate
- Package sales
- Outstanding package liabilities
- Package utilization
- Package expiration
- Package breakage
- Rental utilization
- Rental damage and loss
- Crew utilization
- Planned versus actual crew hours
- Tips
- Payout reconciliation
- Affiliate commission
- Waiver-completion rate
- Certification-verification rate
- Review-conversion rate

Separate transactional workloads from expensive analytical queries. Describe when read replicas, projections, change-data capture, or a warehouse would become appropriate.

24. MULTI-TENANCY, ROLES, AND PLATFORM ADMINISTRATION

Create an explicit multi-tenant model.

Every tenant-owned record should be scoped to an organization or tenant.

Define roles such as:

- Owner
- Manager
- Dispatcher
- Front desk
- Captain
- Crew
- Accountant
- Read-only
- Platform support
- Platform administrator

Support:

- Role-based permissions
- Location-based permissions
- Field-level restrictions
- Sensitive medical-data restrictions
- MFA
- Session management
- API tokens
- Service accounts
- Immutable administrative audit log
- Operator onboarding
- Stripe onboarding status
- Twilio onboarding status
- Feature entitlements
- Subscription status
- Data import
- Data export
- Data deletion requests
- Retention policy
- Feature flags
- Audited support impersonation
- Webhook replay
- Dead-letter inspection
- Tenant suspension
- Tenant offboarding

Use PostgreSQL row-level security as defense in depth, while also enforcing tenant scope in the application layer.

25. RECOMMENDED INITIAL SOFTWARE ARCHITECTURE

Recommend a modular monolith for the initial product rather than independently deployed microservices.

Use clearly separated bounded contexts and ports-and-adapters or hexagonal architecture.

Suggested bounded contexts:

1. Identity and Tenancy
2. Catalog and Pricing
3. Scheduling and Resource Availability
4. Booking and Checkout
5. Orders and Payments
6. Stored Value and Package Ledger
7. Customers and Participants
8. Waivers and Documents
9. Manifests and Trip Operations
10. Equipment Inventory
11. Crew and Compliance
12. Vessels and Maintenance
13. Disruptions and Rebooking
14. Messaging and Notifications
15. Offline Synchronization
16. Reporting and Reconciliation
17. Integrations
18. Platform Administration

Bounded contexts may initially run in one deployable application and one PostgreSQL cluster, but they must have:

- Clear ownership of tables
- Explicit interfaces
- No uncontrolled cross-module writes
- Domain services
- Application services
- Repository or persistence adapters
- Provider adapters
- Published domain events
- Testable module boundaries
- A documented extraction path if a module later requires independent scaling

Do not introduce microservices merely because the product has multiple modules.

Identify likely future extraction candidates, such as:

- Messaging
- Reporting
- Offline synchronization
- Integration connectors
- Document rendering
- High-volume public availability search

26. CLIENT APPLICATION ARCHITECTURE

Design separate clients for:

A. Guest booking and self-service web application
B. Operator administration and dispatch web application
C. Captain and dockside offline-capable mobile application
D. Embeddable booking widget
E. Public API and partner integrations

Recommend whether the captain application should be:

- Native
- Cross-platform native
- Progressive web application
- Hybrid

Prioritize dependable offline storage, predictable background synchronization, device security, and dockside usability over maximum code sharing.

Provide a concrete recommended technology stack plus one viable alternative.

27. DATA ARCHITECTURE

Use PostgreSQL as the authoritative transactional database.

The database specification must include:

- Tenant IDs
- UUID or equivalent primary keys
- Foreign keys
- Check constraints
- Unique constraints
- Partial unique indexes
- Range types
- GiST indexes
- Exclusion constraints
- Transaction timestamps
- Business-effective timestamps
- Created-by and updated-by fields where appropriate
- Version numbers for optimistic concurrency
- Immutable ledgers
- Audit events
- Soft deletion only where appropriate
- Explicit archival rules

Do not soft-delete:

- Financial ledger entries
- Package ledger entries
- Signed waiver evidence
- Manifest snapshots
- Audit events
- Payment events
- Incident records

Store operational timestamps in UTC while retaining:

- Operator IANA time zone
- Departure-local date
- Relevant offset snapshot
- Customer-facing local time

Ensure daylight-saving changes do not create duplicate or nonexistent departure times.

28. DATABASE-ENFORCED AVAILABILITY INVARIANTS

Use PostgreSQL time-range types and exclusion constraints to prevent overlapping exclusive resource reservations.

The constraint must account for:

- Tenant
- Resource
- Time range
- Reservation status
- Holds
- Confirmed reservations
- Preparation buffer
- Cleanup buffer

Only active reservation states should block inventory.

Use the database as the final protection against:

- Double-booked vessels
- Double-booked captains
- Double-booked exclusive equipment
- Oversold capacity
- Negative package balances
- Duplicate package redemption
- Duplicate webhook processing
- Duplicate refund processing
- Duplicate crew assignments
- Duplicate external booking imports

Explain which invariants are enforced by:

- Database constraint
- Transaction
- State machine
- Application validation
- Asynchronous reconciliation

29. EVENTING, JOBS, AND TRANSACTIONAL OUTBOX

Use a transactional outbox pattern.

When a business transaction changes application state and must also trigger an external side effect, write the domain change and outbox event in the same PostgreSQL transaction.

Examples:

- Booking confirmed
- Payment succeeded
- Payment failed
- Waiver requested
- Waiver completed
- Departure cancelled
- Package redeemed
- Package restored
- Customer checked in
- Vessel departed
- Vessel returned
- Tip requested
- Review requested

A worker should publish or process outbox records asynchronously.

Assume at-least-once delivery.

Require:

- Idempotent consumers
- Event ID
- Aggregate ID
- Aggregate version
- Tenant ID
- Event type
- Event version
- Occurred timestamp
- Available-after timestamp
- Retry count
- Processing status
- Last error
- Dead-letter status
- Replay support

Do not perform Stripe, Twilio, email, or weather API calls inside a long-running database transaction.

30. WEBHOOK INBOX

Create a provider-neutral webhook inbox for:

- Stripe
- Twilio
- Weather providers
- Email providers
- Future OTA providers
- Accounting providers

The inbox should store:

- Provider
- Provider event ID
- Event type
- Signature-validation result
- Received timestamp
- Raw payload
- Headers or selected signature metadata
- Processing status
- Processing attempts
- Last error
- Processed timestamp
- Related tenant
- Related aggregate where known

Enforce uniqueness on provider plus provider event ID.

Acknowledge valid webhook delivery rapidly and process the business effect asynchronously where appropriate.

Support:

- Duplicate delivery
- Out-of-order delivery
- Replay
- Poison event quarantine
- Schema-version changes
- Unknown tenant
- Unknown connected account
- Invalid signature
- Test and production environment separation

31. BOOKING AND PAYMENT SAGA

Design the checkout process as an explicit saga or orchestrated workflow.

A recommended sequence is:

1. Create internal checkout session.
2. Validate product and departure.
3. Acquire seat, resource, gear, and package holds in one database transaction.
4. Commit the transaction.
5. Create or update the Stripe PaymentIntent using an idempotency key.
6. Present payment to the customer.
7. Receive verified Stripe webhook.
8. Atomically convert eligible holds to confirmed reservations.
9. Mark order and booking paid.
10. Add transactional outbox events.
11. Send confirmations and waiver links asynchronously.
12. Expire and release abandoned holds.

Define compensation behavior for every failure point.

Explicitly handle payment success after inventory expiration. Possible policies include:

- Attempt to reacquire inventory
- Place into operator exception queue
- Automatically refund
- Issue service credit
- Contact operator for resolution

Do not leave this scenario undefined.

32. EXTERNAL PROVIDER ADAPTERS

Place provider integrations behind internal interfaces.

Examples:

- PaymentProvider
- TerminalProvider
- MessagingProvider
- EmailProvider
- WeatherProvider
- DocumentStorageProvider
- AccountingProvider
- ReviewProvider
- OTAProvider

The domain model should not depend directly on Stripe, Twilio, or any particular weather provider’s object model.

Preserve external IDs and raw provider status while translating provider concepts into the application’s own state model.

33. SECURITY AND PRIVACY ARCHITECTURE

Address:

- Authentication
- Authorization
- MFA
- Tenant isolation
- Row-level security
- Least privilege
- Encryption in transit
- Encryption at rest
- Application-level encryption for highly sensitive fields
- Secure object storage
- Signed download URLs
- Secrets management
- Key rotation
- Webhook signature verification
- API rate limiting
- Brute-force protection
- Redemption-code entropy
- Audit logs
- Support impersonation controls
- Device security
- Session revocation
- Data retention
- Data deletion
- Backup encryption
- Restore testing
- Dependency scanning
- Vulnerability management
- Incident response

Treat medical questionnaires, emergency information, minor information, and identity documents as sensitive data even when a specific healthcare regulation does not apply.

Define which roles can view each sensitive data category.

34. RELIABILITY, OBSERVABILITY, AND OPERATIONS

Define service-level objectives for:

- Public booking availability
- Checkout success
- Availability-search latency
- Webhook processing latency
- Message dispatch latency
- Offline sync success
- Recovery time objective
- Recovery point objective

Include:

- Structured logs
- Correlation IDs
- Distributed tracing where appropriate
- Metrics
- Dashboards
- Alerting
- Audit events
- Queue-depth monitoring
- Webhook failure monitoring
- Expired hold monitoring
- Reconciliation alerts
- Database monitoring
- Backup monitoring
- Restore drills
- Synthetic checkout monitoring
- Third-party provider health
- Feature flags
- Safe deployment rollback
- Database migration safety

Do not claim exactly-once delivery across distributed systems. Design for at-least-once delivery with idempotent processing and reconciliation.

35. API ARCHITECTURE

Define:

- Internal API
- Public operator API
- Booking widget API
- Mobile synchronization API
- Outgoing webhook API
- Admin support API

Address:

- REST versus GraphQL
- Versioning
- Authentication
- Authorization
- Tenant resolution
- Idempotency
- Pagination
- Filtering
- Rate limits
- Error format
- Correlation IDs
- Webhook signatures
- Backward compatibility
- Deprecation
- OpenAPI documentation
- SDK considerations

Provide concrete endpoint examples for:

- Search availability
- Create checkout hold
- Create booking
- Add participant
- Redeem package
- Submit waiver
- Check in participant
- Mark boarded
- Trigger disruption
- Reschedule booking
- Request refund
- Sync offline commands
- Retrieve sync delta

36. TESTING STRATEGY

Include:

- Unit tests
- Domain-state-machine tests
- Integration tests
- Database constraint tests
- Concurrency tests
- Property-based tests
- API contract tests
- Stripe webhook replay tests
- Twilio webhook tests
- Offline synchronization tests
- Clock and time-zone tests
- Daylight-saving tests
- Failure injection
- Queue retry tests
- Dead-letter tests
- Backup restore tests
- Security tests
- Load tests
- Mobile offline tests

Concurrency test scenarios must include:

- Two users buying the final seat
- Two users redeeming the final package unit
- Two users reserving the final rental item
- Captain assigned to overlapping departures
- Vessel assigned to overlapping departures
- Payment success arriving after hold expiration
- Duplicate Stripe events
- Out-of-order Stripe events
- Duplicate Twilio callbacks
- Two offline devices checking in the same participant
- Participant removed online while a captain is offline
- Vessel substitution while the captain is offline
- Partial cancellation involving package units and rental equipment

37. REQUIRED ARCHITECTURE DECISION RECORDS

Provide architecture decision records for:

- Modular monolith versus microservices
- Native or cross-platform mobile versus PWA
- PostgreSQL multi-tenancy strategy
- PostgreSQL row-level security
- Stripe Connect charge model
- Package and gift-card ledger model
- Booking and payment saga
- Transactional outbox
- Webhook inbox
- Queue technology
- Redis usage
- Offline synchronization model
- Document storage and signing evidence
- API style
- Reporting architecture
- Time-zone handling
- Public widget isolation
- Audit-log design
- Sensitive-data encryption

Each decision record should include:

- Context
- Decision
- Alternatives
- Benefits
- Risks
- Consequences
- Conditions that would justify revisiting the decision

38. REQUIRED DATABASE DELIVERABLE

Produce production-oriented PostgreSQL DDL.

Include tables, keys, constraints, indexes, and representative comments for:

- Tenants
- Brands
- Locations
- Users
- Roles
- Permissions
- User-role assignments
- Customers
- Participants
- Guardians
- Emergency contacts
- Products
- Product variants
- Departure templates
- Departure instances
- Vessels
- Resources
- Resource qualifications
- Resource requirements
- Resource reservations
- Capacity profiles
- Capacity buckets
- Capacity holds
- Bookings
- Booking participants
- Orders
- Order lines
- Payment attempts
- Refunds
- Disputes
- Platform fees
- Payout reconciliation
- Packages
- Package accounts
- Package ledger entries
- Gift cards
- Credit ledger entries
- Waiver templates
- Waiver versions
- Waiver signatures
- Medical forms
- Certification documents
- Manifests
- Manifest snapshots
- Equipment pools
- Equipment items
- Equipment holds
- Equipment allocations
- Crew members
- Crew credentials
- Crew availability
- Crew assignments
- Crew time entries
- Tip allocations
- Vessel documents
- Maintenance blocks
- Checklists
- Incidents
- Disruptions
- Waitlist entries
- Waitlist offers
- Messages
- Message deliveries
- Consent records
- Webhook inbox
- Transactional outbox
- Idempotency keys
- Audit events
- Offline devices
- Offline commands
- Sync cursors
- Sync conflicts

Show the exact database mechanism preventing:

- Overlapping vessel bookings
- Overlapping captain bookings
- Invalid crew qualification assignments
- Oversold capacity
- Negative package balances
- Duplicate package redemption
- Rental inventory over-allocation
- Duplicate external webhook processing
- Cross-tenant references

Include:

- Migration order
- Required PostgreSQL extensions
- Sample exclusion constraints
- Sample partial indexes
- Sample row-level security policies
- Representative queries
- Concurrency transaction pseudocode
- Retry logic

39. REQUIRED DIAGRAMS

Provide:

1. C4 system context diagram
2. C4 container diagram
3. Backend module or component diagram
4. Deployment diagram
5. Booking and payment sequence diagram
6. Package redemption sequence diagram
7. Rental inventory hold sequence diagram
8. Stripe webhook sequence diagram
9. Twilio delivery and callback sequence diagram
10. Weather disruption sequence diagram
11. Offline manifest download sequence diagram
12. Offline command synchronization sequence diagram
13. Private charter quote-to-book sequence diagram
14. Data model or entity relationship diagram
15. Trust-boundary and sensitive-data diagram

Use Mermaid syntax where practical.

40. RISK ANALYSIS

Analyze at least:

- Double booking
- Capacity oversell
- Package ledger race
- Equipment inventory race
- Late payment success
- Duplicate webhook delivery
- Out-of-order webhook delivery
- Stripe outage
- Twilio outage
- Weather provider outage
- Email outage
- Offline device conflicts
- Lost or stolen captain device
- Stale manifest
- Incorrect time-zone conversion
- Daylight-saving transition
- Operator credential expiration
- Vessel unexpectedly out of service
- Partial group rescheduling
- Partial package reinstatement
- Chargeback after service delivery
- Refund and application-fee mismatch
- Tenant data leakage
- Support impersonation abuse
- Medical-data exposure
- Waiver-version mismatch
- Minor guardian dispute
- Failed database migration
- Queue backlog
- Reporting query impact
- Backup failure
- Restore failure
- Malicious package-code guessing
- Accidental duplicate notifications
- OTA synchronization conflicts

For each risk provide:

- Likelihood
- Impact
- Detection
- Prevention
- Recovery
- Residual risk
- MVP versus later mitigation

41. OUTPUT FORMAT

Return the specification in this order:

1. Executive summary
2. Product positioning and differentiation
3. Personas and jobs to be done
4. MVP, post-MVP, and non-goal matrix
5. Detailed functional requirements
6. State machines
7. Domain model
8. Recommended software architecture
9. Architecture decision records
10. Diagrams
11. PostgreSQL schema
12. API design
13. Domain event catalog
14. Webhook catalog
15. Offline synchronization protocol
16. Security and privacy architecture
17. Reliability and observability plan
18. Testing strategy
19. Risk analysis
20. Phased implementation roadmap
21. Open questions and assumptions

Do not merely provide a feature list.

Explain:

- Domain ownership
- Business invariants
- Transaction boundaries
- Consistency guarantees
- Failure recovery
- Idempotency
- Concurrency behavior
- Security boundaries
- Operational tradeoffs

When requirements conflict, identify the conflict and recommend a decision rather than quietly making an assumption.