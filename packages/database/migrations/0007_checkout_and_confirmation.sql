-- Checkout, orders, payments, the provider-event inbox, and bookings (G2.7)
--
-- A checkout session turns an immutable quote into a held party and an
-- immutable order, and a verified payment-success event turns that into a
-- confirmed booking. Design authority: docs/v2/04-architecture.md (checkout,
-- booking, and orders; payments; the retained invariants) and the checkout
-- contract in packages/domain-booking/README.md.
--
-- Chain of custody. Nothing here becomes paid or confirmed on a client's say:
--
--   checkout session confirmed  requires  a booking for the session
--   booking                     requires  a succeeded payment and a confirmed hold
--   payment succeeded           requires  a verified payment.succeeded event in the
--                                         inbox for that provider payment, amount,
--                                         currency, and connected account
--
-- The triggers below enforce each link for every role, the owner included.
-- The inbox row itself is written only after the API verifies the provider's
-- signature; the database cannot check an HMAC, so that one step is the
-- service's (packages/domain-payments/README.md).
--
-- State machines, one way, enforced by triggers:
--
--   checkout session: open -> confirmed | paid | failed | expired | canceled
--                     expired -> confirmed | paid   (a late success reacquires
--                                                    or is refunded)
--                     failed | canceled -> paid     (a success after the hold was
--                                                    released is refunded)
--   order:            pending -> paid | void
--   payment:          pending -> succeeded | failed; failed -> succeeded
--   refund:           requested -> succeeded | failed
--   inbox event:      received -> processed
--
-- "paid" on a checkout session means a verified success arrived that could not
-- be honored. The payment is refunded in full and a finalization exception is
-- left for the operator.
--
-- Lock order for every command: provider event, then checkout session, then
-- trip, then hold (the inventory module's order), then the rest. External calls
-- never run inside a transaction.
--
-- The fake payment provider (fake_provider_*) is a demo shim behind the same
-- adapter the Stripe adapter will implement. Its tables are append-only and
-- tenant-owned like everything else; the API refuses the fake provider in a
-- production configuration.
--
-- Tenancy follows packages/database/README.md: tenant_id on every row,
-- composite tenant foreign keys, forced row-level security with a
-- tenant_isolation policy, SELECT and INSERT from the default privileges, UPDATE
-- only on the columns that carry a state transition, and no DELETE or TRUNCATE
-- for any role.

-- The two cross-tenant lookups below are SECURITY DEFINER functions that read
-- tables with forced row-level security; their owner must bypass it.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'migration 0007 must run as a role that bypasses row-level security';
  END IF;
END
$$;

-- Payment accounts ----------------------------------------------------------------

-- The operator's connected account at a payment provider. Direct charges land
-- here; the operator is the merchant of record. Written by onboarding (the
-- seed in the demo); the runtime may only read it, so no request can change
-- where money goes. The fake provider's references are synthetic.
CREATE TABLE public.payment_accounts (
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  provider text NOT NULL CHECK (provider IN ('fake', 'stripe')),
  account_ref text NOT NULL CHECK (account_ref ~ '^acct_[A-Za-z0-9_-]{1,64}$'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, provider),
  UNIQUE (tenant_id, provider, account_ref),
  -- One account belongs to one operator.
  UNIQUE (provider, account_ref)
);

-- Provider-event inbox ------------------------------------------------------------

-- Every verified provider callback, once. A row is written only after its
-- signature verifies, and is unique on the provider's event id, so a duplicate
-- delivery finds the first row instead of acting again. The event's content
-- never changes; only its processing state moves, once, from received to
-- processed with an outcome. The raw payload is not kept, only its hash and the
-- fields processing needs.
CREATE TABLE public.provider_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  provider text NOT NULL CHECK (provider IN ('fake', 'stripe')),
  event_id text NOT NULL CHECK (event_id ~ '^[A-Za-z0-9_]{3,255}$'),
  -- The provider-neutral kind; anything else is recorded as 'other' and ignored.
  event_type text NOT NULL
    CHECK (event_type IN ('payment.succeeded', 'payment.failed', 'other')),
  -- The provider's own type string, for diagnosis.
  provider_type text NOT NULL
    CHECK (char_length(provider_type) BETWEEN 1 AND 100 AND provider_type ~ '^[a-z][a-z0-9_.]*$'),
  account_ref text NOT NULL,
  payment_ref text CHECK (payment_ref ~ '^[A-Za-z0-9_]{3,255}$'),
  -- Our payment id, as we gave it to the provider when creating the payment.
  client_reference uuid,
  amount integer CHECK (amount BETWEEN 0 AND 100000000),
  currency text CHECK (currency ~ '^[A-Z]{3}$'),
  provider_created_at timestamptz,
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  verified_at timestamptz NOT NULL DEFAULT now(),
  processing_state text NOT NULL DEFAULT 'received'
    CHECK (processing_state IN ('received', 'processed')),
  outcome text CHECK (outcome ~ '^[a-z][a-z0-9_]{0,63}$'),
  processed_at timestamptz,
  UNIQUE (tenant_id, id),
  CONSTRAINT provider_events_once UNIQUE (provider, event_id),
  -- The account an event names belongs to the tenant that records it.
  FOREIGN KEY (tenant_id, provider, account_ref)
    REFERENCES public.payment_accounts (tenant_id, provider, account_ref),
  CHECK ((processing_state = 'processed') = (outcome IS NOT NULL AND processed_at IS NOT NULL)),
  CHECK (event_type = 'other'
         OR (payment_ref IS NOT NULL AND amount IS NOT NULL AND currency IS NOT NULL))
);
CREATE INDEX provider_events_pending_idx ON public.provider_events (tenant_id, verified_at)
  WHERE processing_state = 'received';
CREATE INDEX provider_events_pending_any_tenant_idx ON public.provider_events (verified_at)
  INCLUDE (tenant_id)
  WHERE processing_state = 'received';
CREATE INDEX provider_events_payment_idx ON public.provider_events (tenant_id, provider, payment_ref);

-- Checkout sessions ---------------------------------------------------------------

-- One guest's attempt to buy one quote. The service chooses the id first,
-- because the capacity hold's owner reference is "checkout_session:<id>", then
-- acquires the hold and writes this row with the hold's expiry. The guest holds
-- a capability secret; only its SHA-256 is stored. The booker's name and email
-- are the only personal data, kept for the booking and its messages; they never
-- enter audit rows, events, logs, or URLs.
CREATE TABLE public.checkout_sessions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  quote_id uuid NOT NULL,
  trip_id uuid NOT NULL,
  party_size integer NOT NULL CHECK (party_size BETWEEN 1 AND 500),
  hold_id uuid NOT NULL,
  -- The policy version the guest accepted before paying: the quote's.
  policy_version integer NOT NULL CHECK (policy_version >= 1),
  state text NOT NULL DEFAULT 'open'
    CHECK (state IN ('open', 'confirmed', 'paid', 'failed', 'expired', 'canceled')),
  -- The hold's expiry instant. Can move earlier, never later.
  expires_at timestamptz NOT NULL,
  secret_hash text NOT NULL CHECK (secret_hash ~ '^[0-9a-f]{64}$'),
  -- SHA-256 of the tenant and the client's address, for the per-client limit on
  -- open checkouts. Null when the request carried no address.
  client_key text CHECK (client_key ~ '^[0-9a-f]{64}$'),
  booker_name text NOT NULL
    CHECK (char_length(booker_name) BETWEEN 1 AND 120 AND booker_name !~ '[[:cntrl:]]'),
  booker_email text NOT NULL
    CHECK (char_length(booker_email) <= 254
           AND booker_email = lower(booker_email)
           AND booker_email ~ '^[\x21-\x7e]+$'
           AND booker_email ~ '^[^@]+@[^@]+\.[^@]+$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz,
  paid_at timestamptz,
  failed_at timestamptz,
  expired_at timestamptz,
  canceled_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  -- One checkout per quote, ever. A new attempt starts from a new quote.
  CONSTRAINT checkout_sessions_one_per_quote UNIQUE (tenant_id, quote_id),
  UNIQUE (tenant_id, hold_id),
  FOREIGN KEY (tenant_id, quote_id) REFERENCES public.quotes (tenant_id, id),
  FOREIGN KEY (tenant_id, trip_id) REFERENCES public.scheduled_trips (tenant_id, id),
  FOREIGN KEY (tenant_id, hold_id) REFERENCES public.capacity_holds (tenant_id, id),
  CHECK (state <> 'open' OR (confirmed_at IS NULL AND paid_at IS NULL AND failed_at IS NULL
                             AND expired_at IS NULL AND canceled_at IS NULL)),
  CHECK (state <> 'confirmed' OR confirmed_at IS NOT NULL),
  CHECK (state <> 'paid' OR paid_at IS NOT NULL),
  CHECK (state <> 'failed' OR failed_at IS NOT NULL),
  CHECK (state <> 'expired' OR expired_at IS NOT NULL),
  CHECK (state <> 'canceled' OR canceled_at IS NOT NULL)
);
-- Open sessions past their instant, per tenant and across tenants (the sweep).
CREATE INDEX checkout_sessions_due_idx ON public.checkout_sessions (tenant_id, expires_at)
  WHERE state = 'open';
CREATE INDEX checkout_sessions_due_any_tenant_idx ON public.checkout_sessions (expires_at)
  INCLUDE (tenant_id)
  WHERE state = 'open';
-- Open sessions per client, for the per-client limit.
CREATE INDEX checkout_sessions_client_idx ON public.checkout_sessions (tenant_id, client_key)
  WHERE state = 'open' AND client_key IS NOT NULL;

-- Orders --------------------------------------------------------------------------

-- The immutable financial statement for one checkout, copied from its quote:
-- service (tickets or the charter price), paid add-on, fee, discount, and one
-- tax line per tax rate. Lines can be written only in the order's own
-- transaction, and at commit the order must equal its quote line for line.
-- Only the status moves: pending until a booking confirms (paid) or the
-- checkout can no longer confirm (void).
CREATE TABLE public.orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  checkout_session_id uuid NOT NULL,
  quote_id uuid NOT NULL,
  trip_id uuid NOT NULL,
  product_id uuid NOT NULL,
  party_size integer NOT NULL CHECK (party_size BETWEEN 1 AND 500),
  policy_version integer NOT NULL,
  currency text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  subtotal_amount integer NOT NULL CHECK (subtotal_amount BETWEEN 0 AND 100000000),
  discount_amount integer NOT NULL CHECK (discount_amount BETWEEN 0 AND 100000000),
  fee_amount integer NOT NULL CHECK (fee_amount BETWEEN 0 AND 100000000),
  tax_amount integer NOT NULL CHECK (tax_amount BETWEEN 0 AND 100000000),
  included_tax_amount integer NOT NULL CHECK (included_tax_amount BETWEEN 0 AND 100000000),
  total_amount integer NOT NULL CHECK (total_amount BETWEEN 0 AND 100000000),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'void')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_txid xid8 NOT NULL DEFAULT pg_current_xact_id(),
  paid_at timestamptz,
  voided_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, checkout_session_id),
  UNIQUE (tenant_id, quote_id),
  FOREIGN KEY (tenant_id, checkout_session_id) REFERENCES public.checkout_sessions (tenant_id, id),
  FOREIGN KEY (tenant_id, quote_id) REFERENCES public.quotes (tenant_id, id),
  FOREIGN KEY (tenant_id, trip_id, product_id)
    REFERENCES public.scheduled_trips (tenant_id, id, product_id),
  FOREIGN KEY (tenant_id, product_id, policy_version)
    REFERENCES public.policy_versions (tenant_id, product_id, version),
  CHECK (discount_amount <= subtotal_amount),
  CHECK (total_amount = subtotal_amount - discount_amount + fee_amount + tax_amount),
  CHECK ((status = 'paid') = (paid_at IS NOT NULL)),
  CHECK ((status = 'void') = (voided_at IS NOT NULL))
);

-- Copied lines keep their quote line number (1 to 200). Tax lines follow from
-- 201, one per tax rate version, carrying the rate's total over the quote's
-- lines; an inclusive tax is inside the prices and is reported, not added.
CREATE TABLE public.order_lines (
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  order_id uuid NOT NULL,
  line_no smallint NOT NULL CHECK (line_no BETWEEN 1 AND 400),
  kind text NOT NULL CHECK (kind IN ('service', 'add_on', 'fee', 'tax', 'discount')),
  code text NOT NULL CHECK (char_length(code) BETWEEN 1 AND 32),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  basis text CHECK (basis IN ('per_booking', 'per_participant')),
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 50000),
  unit_amount integer NOT NULL CHECK (unit_amount BETWEEN 0 AND 100000000),
  amount integer NOT NULL CHECK (amount BETWEEN -100000000 AND 100000000),
  discount_amount integer NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
  taxable boolean NOT NULL,
  tax_rate_id uuid,
  tax_rate_version integer,
  tax_inclusive boolean,
  taxable_amount integer CHECK (taxable_amount BETWEEN 0 AND 100000000),
  PRIMARY KEY (tenant_id, order_id, line_no),
  FOREIGN KEY (tenant_id, order_id) REFERENCES public.orders (tenant_id, id),
  FOREIGN KEY (tenant_id, tax_rate_id, tax_rate_version)
    REFERENCES public.tax_rate_versions (tenant_id, tax_rate_id, version),
  CHECK ((kind = 'tax') = (line_no > 200)),
  CHECK ((kind = 'tax') = (tax_rate_id IS NOT NULL AND tax_rate_version IS NOT NULL
                           AND tax_inclusive IS NOT NULL AND taxable_amount IS NOT NULL)),
  CHECK (kind <> 'tax'
         OR (code = 'tax' AND quantity = 1 AND amount = unit_amount AND NOT taxable
             AND discount_amount = 0 AND basis IS NULL)),
  CHECK ((kind IN ('fee', 'add_on')) = (basis IS NOT NULL)),
  CHECK (kind IN ('discount', 'tax') OR amount::bigint = quantity::bigint * unit_amount),
  CHECK (kind <> 'discount'
         OR (quantity = 1 AND amount = -unit_amount AND NOT taxable AND discount_amount = 0)),
  CHECK (kind = 'service' OR discount_amount = 0),
  CHECK (discount_amount <= greatest(amount, 0))
);

-- Payments ------------------------------------------------------------------------

-- One direct charge on the operator's connected account for one checkout. The
-- row is written with the checkout, before the provider is called, carrying
-- the provider idempotency key; the provider's payment id is recorded after
-- the call returns, once. The amount is the order's total, never one a client
-- sent. Only a verified inbox event moves the state.
CREATE TABLE public.payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  checkout_session_id uuid NOT NULL,
  order_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('fake', 'stripe')),
  account_ref text NOT NULL,
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9_:-]{8,255}$'),
  provider_payment_id text CHECK (provider_payment_id ~ '^[A-Za-z0-9_]{3,255}$'),
  amount integer NOT NULL CHECK (amount BETWEEN 1 AND 100000000),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'succeeded', 'failed')),
  succeeded_event_id uuid,
  failed_event_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  provider_recorded_at timestamptz,
  succeeded_at timestamptz,
  failed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, checkout_session_id),
  UNIQUE (tenant_id, order_id),
  CONSTRAINT payments_idempotency_key UNIQUE (provider, idempotency_key),
  CONSTRAINT payments_provider_payment UNIQUE (provider, provider_payment_id),
  FOREIGN KEY (tenant_id, checkout_session_id) REFERENCES public.checkout_sessions (tenant_id, id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES public.orders (tenant_id, id),
  FOREIGN KEY (tenant_id, provider, account_ref)
    REFERENCES public.payment_accounts (tenant_id, provider, account_ref),
  FOREIGN KEY (tenant_id, succeeded_event_id) REFERENCES public.provider_events (tenant_id, id),
  FOREIGN KEY (tenant_id, failed_event_id) REFERENCES public.provider_events (tenant_id, id),
  CHECK ((state = 'succeeded') = (succeeded_event_id IS NOT NULL AND succeeded_at IS NOT NULL)),
  CHECK (state <> 'failed' OR (failed_event_id IS NOT NULL AND failed_at IS NOT NULL)),
  CHECK ((failed_event_id IS NULL) = (failed_at IS NULL)),
  CHECK ((provider_payment_id IS NULL) = (provider_recorded_at IS NULL)),
  CHECK (state = 'pending' OR provider_payment_id IS NOT NULL)
);

-- The one refund G2.7 makes: the full amount of a payment that succeeded but
-- could not be honored. The row is the intent, committed before the provider
-- is called with its idempotency key; the outcome is recorded after. One per
-- payment, so a repeated command cannot refund twice.
CREATE TABLE public.payment_refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  payment_id uuid NOT NULL,
  amount integer NOT NULL CHECK (amount BETWEEN 1 AND 100000000),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  reason text NOT NULL CHECK (reason IN ('unfulfilled_payment')),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9_:-]{8,255}$'),
  provider_refund_id text CHECK (provider_refund_id ~ '^[A-Za-z0-9_]{3,255}$'),
  state text NOT NULL DEFAULT 'requested' CHECK (state IN ('requested', 'succeeded', 'failed')),
  failure_code text CHECK (failure_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CONSTRAINT payment_refunds_one_per_payment UNIQUE (tenant_id, payment_id),
  CONSTRAINT payment_refunds_idempotency_key UNIQUE (idempotency_key),
  FOREIGN KEY (tenant_id, payment_id) REFERENCES public.payments (tenant_id, id),
  CHECK ((state = 'requested') = (settled_at IS NULL)),
  CHECK (state <> 'succeeded' OR provider_refund_id IS NOT NULL),
  CHECK ((state = 'failed') = (failure_code IS NOT NULL))
);
CREATE INDEX payment_refunds_requested_idx ON public.payment_refunds (tenant_id, created_at)
  WHERE state = 'requested';
CREATE INDEX payment_refunds_requested_any_tenant_idx ON public.payment_refunds (created_at)
  INCLUDE (tenant_id)
  WHERE state = 'requested';

-- Bookings ------------------------------------------------------------------------

-- One party on one trip, created confirmed, only in the transaction that
-- records a verified payment success and confirms the hold. The reference is
-- what the guest and the operator quote to each other. Append-only in this
-- goal; cancellation (G2.11) adds its own transition.
CREATE TABLE public.bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  -- Eight characters of Crockford base32: no I, L, O, or U.
  reference text NOT NULL CHECK (reference ~ '^[0-9A-HJKMNP-TV-Z]{8}$'),
  checkout_session_id uuid NOT NULL,
  order_id uuid NOT NULL,
  payment_id uuid NOT NULL,
  hold_id uuid NOT NULL,
  trip_id uuid NOT NULL,
  party_size integer NOT NULL CHECK (party_size BETWEEN 1 AND 500),
  source text NOT NULL DEFAULT 'direct' CHECK (source IN ('direct')),
  state text NOT NULL DEFAULT 'confirmed' CHECK (state IN ('confirmed')),
  -- Confirmed after the hold had expired, by taking the capacity again.
  reacquired boolean NOT NULL,
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CONSTRAINT bookings_reference_key UNIQUE (tenant_id, reference),
  UNIQUE (tenant_id, checkout_session_id),
  UNIQUE (tenant_id, order_id),
  UNIQUE (tenant_id, payment_id),
  UNIQUE (tenant_id, hold_id),
  FOREIGN KEY (tenant_id, checkout_session_id) REFERENCES public.checkout_sessions (tenant_id, id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES public.orders (tenant_id, id),
  FOREIGN KEY (tenant_id, payment_id) REFERENCES public.payments (tenant_id, id),
  FOREIGN KEY (tenant_id, hold_id) REFERENCES public.capacity_holds (tenant_id, id),
  FOREIGN KEY (tenant_id, trip_id) REFERENCES public.scheduled_trips (tenant_id, id)
);
CREATE INDEX bookings_trip_idx ON public.bookings (tenant_id, trip_id, confirmed_at);

-- Finalization exceptions ---------------------------------------------------------

-- A verified payment success that could not become a booking: the capacity was
-- lost, the trip canceled or closed, or the checkout had already failed or been
-- canceled. The payment is refunded in full (refund_id). A success whose
-- amount, currency, or account does not match the payment is not refunded
-- automatically (payment_mismatch); the operator investigates. One row per
-- verified event, append-only. Resolution by staff arrives with the console.
CREATE TABLE public.finalization_exceptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  checkout_session_id uuid NOT NULL,
  payment_id uuid NOT NULL,
  provider_event_id uuid NOT NULL,
  reason text NOT NULL CHECK (reason IN (
    'no_capacity', 'trip_canceled', 'trip_unavailable', 'sales_closed',
    'party_size_out_of_range', 'session_failed', 'session_canceled', 'payment_mismatch'
  )),
  refund_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CONSTRAINT finalization_exceptions_once UNIQUE (tenant_id, provider_event_id),
  FOREIGN KEY (tenant_id, checkout_session_id) REFERENCES public.checkout_sessions (tenant_id, id),
  FOREIGN KEY (tenant_id, payment_id) REFERENCES public.payments (tenant_id, id),
  FOREIGN KEY (tenant_id, provider_event_id) REFERENCES public.provider_events (tenant_id, id),
  FOREIGN KEY (tenant_id, refund_id) REFERENCES public.payment_refunds (tenant_id, id),
  CHECK ((reason = 'payment_mismatch') = (refund_id IS NULL))
);
CREATE INDEX finalization_exceptions_recent_idx
  ON public.finalization_exceptions (tenant_id, created_at DESC);

-- The fake payment provider -------------------------------------------------------

-- A demo stand-in for Stripe behind the same adapter: payments, their outcome
-- events, and refunds, all append-only. A payment's status is derived from its
-- events. Event bodies are kept as the exact text delivered, so a redelivery
-- is byte for byte the same event.
CREATE TABLE public.fake_provider_payments (
  id text PRIMARY KEY CHECK (id ~ '^fpay_[A-Za-z0-9]{24}$'),
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  provider text NOT NULL DEFAULT 'fake' CHECK (provider = 'fake'),
  account_ref text NOT NULL,
  amount integer NOT NULL CHECK (amount BETWEEN 1 AND 100000000),
  currency text NOT NULL CHECK (currency = 'USD'),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 255),
  client_reference text NOT NULL CHECK (char_length(client_reference) BETWEEN 1 AND 255),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, provider, account_ref)
    REFERENCES public.payment_accounts (tenant_id, provider, account_ref)
);

CREATE TABLE public.fake_provider_events (
  id text PRIMARY KEY CHECK (id ~ '^fevt_[A-Za-z0-9]{24}$'),
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  payment_id text NOT NULL,
  type text NOT NULL CHECK (type IN ('payment.succeeded', 'payment.failed')),
  body text NOT NULL CHECK (char_length(body) <= 16384 AND jsonb_typeof(body::jsonb) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, payment_id) REFERENCES public.fake_provider_payments (tenant_id, id)
);
-- A fake payment has one outcome: it succeeds or fails, once.
CREATE UNIQUE INDEX fake_provider_events_one_outcome
  ON public.fake_provider_events (tenant_id, payment_id);

CREATE TABLE public.fake_provider_refunds (
  id text PRIMARY KEY CHECK (id ~ '^frf_[A-Za-z0-9]{24}$'),
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  payment_id text NOT NULL,
  amount integer NOT NULL CHECK (amount BETWEEN 1 AND 100000000),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 255),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, payment_id) REFERENCES public.fake_provider_payments (tenant_id, id)
);

-- Rules ---------------------------------------------------------------------------
--
-- Every trigger function runs as the writer, inside its tenant transaction, so
-- row-level security applies, and filters by the row's tenant explicitly. Raised
-- errors carry a constraint name so callers and tests can tell them apart.

-- The inbox: content is immutable; processing moves once from received to
-- processed, with an outcome. verified_at and processed_at come from the
-- database clock.
CREATE FUNCTION app.check_provider_event() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.processing_state IS DISTINCT FROM 'received' OR NEW.outcome IS NOT NULL THEN
      RAISE EXCEPTION 'an inbox event starts received, without an outcome'
        USING ERRCODE = '23514', CONSTRAINT = 'provider_events_transition';
    END IF;
    NEW.verified_at := now();
    NEW.processed_at := NULL;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.provider IS DISTINCT FROM OLD.provider
     OR NEW.event_id IS DISTINCT FROM OLD.event_id
     OR NEW.event_type IS DISTINCT FROM OLD.event_type
     OR NEW.provider_type IS DISTINCT FROM OLD.provider_type
     OR NEW.account_ref IS DISTINCT FROM OLD.account_ref
     OR NEW.payment_ref IS DISTINCT FROM OLD.payment_ref
     OR NEW.client_reference IS DISTINCT FROM OLD.client_reference
     OR NEW.amount IS DISTINCT FROM OLD.amount
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.provider_created_at IS DISTINCT FROM OLD.provider_created_at
     OR NEW.payload_sha256 IS DISTINCT FROM OLD.payload_sha256
     OR NEW.verified_at IS DISTINCT FROM OLD.verified_at THEN
    RAISE EXCEPTION 'an inbox event never changes; only its processing state moves'
      USING ERRCODE = '23514', CONSTRAINT = 'provider_events_immutable';
  END IF;
  IF OLD.processing_state = 'processed' THEN
    RAISE EXCEPTION 'inbox event % was already processed', OLD.id
      USING ERRCODE = '23514', CONSTRAINT = 'provider_events_transition';
  END IF;
  IF NEW.processing_state = 'received' THEN
    IF NEW.outcome IS NOT NULL THEN
      RAISE EXCEPTION 'an outcome is recorded only when the event is processed'
        USING ERRCODE = '23514', CONSTRAINT = 'provider_events_transition';
    END IF;
    NEW.processed_at := NULL;
    RETURN NEW;
  END IF;
  NEW.processed_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER provider_events_rules BEFORE INSERT OR UPDATE ON public.provider_events
  FOR EACH ROW EXECUTE FUNCTION app.check_provider_event();

-- Checkout sessions: a new session is open, on a quote that is still fresh by
-- the database clock, for the quote's trip, party, and policy, with an active
-- hold this session owns that expires when the session does. Afterwards only
-- the state moves, one way, and each move needs its evidence: a booking to
-- confirm, a refund exception to close as paid, a released hold to fail or
-- cancel, an expired hold to expire.
CREATE FUNCTION app.check_checkout_session() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  q record;
  h record;
  hold_state text;
  payment_state text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state IS DISTINCT FROM 'open' THEN
      RAISE EXCEPTION 'a checkout session starts open, not %', NEW.state
        USING ERRCODE = '23514', CONSTRAINT = 'checkout_sessions_transition';
    END IF;
    NEW.created_at := now();
    NEW.updated_at := now();
    NEW.confirmed_at := NULL;
    NEW.paid_at := NULL;
    NEW.failed_at := NULL;
    NEW.expired_at := NULL;
    NEW.canceled_at := NULL;

    SELECT x.trip_id, x.party_size, x.policy_version,
           now() < least(x.expires_at, x.created_at + interval '30 minutes') AS fresh
      INTO q
      FROM public.quotes x
     WHERE x.tenant_id = NEW.tenant_id AND x.id = NEW.quote_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'no quote % for this tenant', NEW.quote_id
        USING ERRCODE = '23503', CONSTRAINT = 'checkout_sessions_quote';
    END IF;
    IF NOT q.fresh THEN
      RAISE EXCEPTION 'quote % is no longer valid for checkout', NEW.quote_id
        USING ERRCODE = '23514', CONSTRAINT = 'checkout_sessions_quote_fresh';
    END IF;
    IF q.trip_id <> NEW.trip_id OR q.party_size <> NEW.party_size
       OR q.policy_version <> NEW.policy_version THEN
      RAISE EXCEPTION 'a checkout takes its quote''s trip, party, and policy'
        USING ERRCODE = '23514', CONSTRAINT = 'checkout_sessions_quote';
    END IF;

    SELECT x.owner_ref, x.trip_id, x.party_size, x.state, x.expires_at
      INTO h
      FROM public.capacity_holds x
     WHERE x.tenant_id = NEW.tenant_id AND x.id = NEW.hold_id;
    IF NOT FOUND
       OR h.owner_ref <> 'checkout_session:' || NEW.id::text
       OR h.trip_id <> NEW.trip_id
       OR h.party_size <> NEW.party_size
       OR h.state <> 'active'
       OR h.expires_at <> NEW.expires_at
       OR NEW.expires_at <= now() THEN
      RAISE EXCEPTION 'a checkout session needs its own active hold for its trip and party, expiring with it'
        USING ERRCODE = '23514', CONSTRAINT = 'checkout_sessions_hold';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.quote_id IS DISTINCT FROM OLD.quote_id
     OR NEW.trip_id IS DISTINCT FROM OLD.trip_id
     OR NEW.party_size IS DISTINCT FROM OLD.party_size
     OR NEW.hold_id IS DISTINCT FROM OLD.hold_id
     OR NEW.policy_version IS DISTINCT FROM OLD.policy_version
     OR NEW.secret_hash IS DISTINCT FROM OLD.secret_hash
     OR NEW.client_key IS DISTINCT FROM OLD.client_key
     OR NEW.booker_name IS DISTINCT FROM OLD.booker_name
     OR NEW.booker_email IS DISTINCT FROM OLD.booker_email
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a checkout session keeps its quote, trip, party, hold, secret, and booker'
      USING ERRCODE = '23514', CONSTRAINT = 'checkout_sessions_immutable';
  END IF;
  -- The expiry moves earlier, never later; tests make time pass that way.
  IF NEW.expires_at > OLD.expires_at THEN
    RAISE EXCEPTION 'checkout session % expires at %; its expiry can move earlier, never later',
      OLD.id, OLD.expires_at
      USING ERRCODE = '23514', CONSTRAINT = 'checkout_sessions_expiry';
  END IF;
  NEW.confirmed_at := OLD.confirmed_at;
  NEW.paid_at := OLD.paid_at;
  NEW.failed_at := OLD.failed_at;
  NEW.expired_at := OLD.expired_at;
  NEW.canceled_at := OLD.canceled_at;
  NEW.updated_at := now();
  IF NEW.state = OLD.state THEN
    RETURN NEW;
  END IF;
  IF NOT (   (OLD.state = 'open' AND NEW.state IN ('confirmed', 'paid', 'failed', 'expired', 'canceled'))
          OR (OLD.state = 'expired' AND NEW.state IN ('confirmed', 'paid'))
          OR (OLD.state IN ('failed', 'canceled') AND NEW.state = 'paid')) THEN
    RAISE EXCEPTION 'a checkout session cannot move from % to %', OLD.state, NEW.state
      USING ERRCODE = '23514', CONSTRAINT = 'checkout_sessions_transition';
  END IF;

  SELECT x.state INTO hold_state
    FROM public.capacity_holds x
   WHERE x.tenant_id = NEW.tenant_id AND x.id = NEW.hold_id;
  SELECT x.state INTO payment_state
    FROM public.payments x
   WHERE x.tenant_id = NEW.tenant_id AND x.checkout_session_id = NEW.id;

  IF NEW.state = 'confirmed' THEN
    IF hold_state IS DISTINCT FROM 'confirmed'
       OR payment_state IS DISTINCT FROM 'succeeded'
       OR NOT EXISTS (SELECT 1 FROM public.bookings b
                       WHERE b.tenant_id = NEW.tenant_id AND b.checkout_session_id = NEW.id) THEN
      RAISE EXCEPTION 'checkout session % confirms only with a booking on a succeeded payment', NEW.id
        USING ERRCODE = '23514', CONSTRAINT = 'checkout_sessions_evidence';
    END IF;
    NEW.confirmed_at := now();
  ELSIF NEW.state = 'paid' THEN
    IF payment_state IS DISTINCT FROM 'succeeded'
       OR hold_state NOT IN ('released', 'expired')
       OR NOT EXISTS (SELECT 1 FROM public.finalization_exceptions e
                       WHERE e.tenant_id = NEW.tenant_id AND e.checkout_session_id = NEW.id
                         AND e.refund_id IS NOT NULL)
       OR EXISTS (SELECT 1 FROM public.bookings b
                   WHERE b.tenant_id = NEW.tenant_id AND b.checkout_session_id = NEW.id) THEN
      RAISE EXCEPTION 'checkout session % closes as paid only with a refund exception and no booking', NEW.id
        USING ERRCODE = '23514', CONSTRAINT = 'checkout_sessions_evidence';
    END IF;
    NEW.paid_at := now();
  ELSIF NEW.state = 'failed' THEN
    IF payment_state IS DISTINCT FROM 'failed' OR hold_state IS DISTINCT FROM 'released' THEN
      RAISE EXCEPTION 'checkout session % fails only on a failed payment with its hold released', NEW.id
        USING ERRCODE = '23514', CONSTRAINT = 'checkout_sessions_evidence';
    END IF;
    NEW.failed_at := now();
  ELSIF NEW.state = 'expired' THEN
    IF OLD.expires_at > now() OR hold_state IS DISTINCT FROM 'expired' THEN
      RAISE EXCEPTION 'checkout session % expires only after its instant, with its hold expired', NEW.id
        USING ERRCODE = '23514', CONSTRAINT = 'checkout_sessions_evidence';
    END IF;
    NEW.expired_at := now();
  ELSE
    IF hold_state IS DISTINCT FROM 'released' THEN
      RAISE EXCEPTION 'checkout session % is canceled only with its hold released', NEW.id
        USING ERRCODE = '23514', CONSTRAINT = 'checkout_sessions_evidence';
    END IF;
    NEW.canceled_at := now();
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER checkout_sessions_rules BEFORE INSERT OR UPDATE ON public.checkout_sessions
  FOR EACH ROW EXECUTE FUNCTION app.check_checkout_session();

-- Orders: written once, with its own session and that session's quote; only
-- the status moves, to paid with a booking or to void without one.
CREATE FUNCTION app.check_order() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status IS DISTINCT FROM 'pending' THEN
      RAISE EXCEPTION 'an order starts pending, not %', NEW.status
        USING ERRCODE = '23514', CONSTRAINT = 'orders_transition';
    END IF;
    NEW.created_at := pg_catalog.clock_timestamp();
    NEW.created_txid := pg_catalog.pg_current_xact_id();
    NEW.updated_at := now();
    NEW.paid_at := NULL;
    NEW.voided_at := NULL;
    IF NOT EXISTS (
      SELECT 1 FROM public.checkout_sessions s
       WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.checkout_session_id
         AND s.quote_id = NEW.quote_id AND s.trip_id = NEW.trip_id
         AND s.party_size = NEW.party_size AND s.policy_version = NEW.policy_version
         AND s.state = 'open'
    ) THEN
      RAISE EXCEPTION 'an order belongs to an open checkout session for its quote'
        USING ERRCODE = '23514', CONSTRAINT = 'orders_session';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.checkout_session_id IS DISTINCT FROM OLD.checkout_session_id
     OR NEW.quote_id IS DISTINCT FROM OLD.quote_id
     OR NEW.trip_id IS DISTINCT FROM OLD.trip_id
     OR NEW.product_id IS DISTINCT FROM OLD.product_id
     OR NEW.party_size IS DISTINCT FROM OLD.party_size
     OR NEW.policy_version IS DISTINCT FROM OLD.policy_version
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.subtotal_amount IS DISTINCT FROM OLD.subtotal_amount
     OR NEW.discount_amount IS DISTINCT FROM OLD.discount_amount
     OR NEW.fee_amount IS DISTINCT FROM OLD.fee_amount
     OR NEW.tax_amount IS DISTINCT FROM OLD.tax_amount
     OR NEW.included_tax_amount IS DISTINCT FROM OLD.included_tax_amount
     OR NEW.total_amount IS DISTINCT FROM OLD.total_amount
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.created_txid IS DISTINCT FROM OLD.created_txid THEN
    RAISE EXCEPTION 'an order is an immutable statement; only its status moves'
      USING ERRCODE = '23514', CONSTRAINT = 'orders_immutable';
  END IF;
  NEW.paid_at := OLD.paid_at;
  NEW.voided_at := OLD.voided_at;
  NEW.updated_at := now();
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'pending' AND NEW.status = 'paid' THEN
    IF NOT EXISTS (SELECT 1 FROM public.bookings b
                    WHERE b.tenant_id = NEW.tenant_id AND b.order_id = NEW.id) THEN
      RAISE EXCEPTION 'order % is paid only with a confirmed booking', NEW.id
        USING ERRCODE = '23514', CONSTRAINT = 'orders_evidence';
    END IF;
    NEW.paid_at := now();
  ELSIF OLD.status = 'pending' AND NEW.status = 'void' THEN
    IF EXISTS (SELECT 1 FROM public.bookings b
                WHERE b.tenant_id = NEW.tenant_id AND b.order_id = NEW.id) THEN
      RAISE EXCEPTION 'order % has a booking and cannot be void', NEW.id
        USING ERRCODE = '23514', CONSTRAINT = 'orders_evidence';
    END IF;
    NEW.voided_at := now();
  ELSE
    RAISE EXCEPTION 'an order cannot move from % to %', OLD.status, NEW.status
      USING ERRCODE = '23514', CONSTRAINT = 'orders_transition';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER orders_rules BEFORE INSERT OR UPDATE ON public.orders
  FOR EACH ROW EXECUTE FUNCTION app.check_order();

-- Order lines are written only in their order's transaction, so an order
-- cannot grow after it commits.
CREATE FUNCTION app.check_order_line_sealed() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  parent_txid xid8;
BEGIN
  SELECT o.created_txid INTO parent_txid
    FROM public.orders o
   WHERE o.tenant_id = NEW.tenant_id AND o.id = NEW.order_id;
  IF parent_txid IS DISTINCT FROM pg_catalog.pg_current_xact_id() THEN
    RAISE EXCEPTION 'order lines are written only with their order, in its transaction'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER order_lines_sealed BEFORE INSERT ON public.order_lines
  FOR EACH ROW EXECUTE FUNCTION app.check_order_line_sealed();

-- Checked at commit: the order is its quote. The header carries the quote's
-- trip, product, party, policy, and totals; every quote line appears once with
-- its number, kind, code, name, quantity, prices, discount share, and
-- taxability (tickets and the charter price become service lines); and each
-- tax rate version on the quote appears once as a tax line with its totals.
-- Nothing else is on the order.
CREATE FUNCTION app.check_order_matches_quote() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  q record;
BEGIN
  SELECT x.* INTO q FROM public.quotes x WHERE x.tenant_id = NEW.tenant_id AND x.id = NEW.quote_id;
  IF NOT FOUND
     OR q.trip_id <> NEW.trip_id OR q.product_id <> NEW.product_id
     OR q.party_size <> NEW.party_size OR q.policy_version <> NEW.policy_version
     OR q.currency <> NEW.currency
     OR q.subtotal_amount <> NEW.subtotal_amount OR q.discount_amount <> NEW.discount_amount
     OR q.fee_amount <> NEW.fee_amount OR q.tax_amount <> NEW.tax_amount
     OR q.included_tax_amount <> NEW.included_tax_amount
     OR q.total_amount <> NEW.total_amount THEN
    RAISE EXCEPTION 'order % does not carry its quote''s terms and totals', NEW.id
      USING ERRCODE = '23514', CONSTRAINT = 'orders_match_quote';
  END IF;
  IF EXISTS (
       SELECT 1
         FROM (SELECT * FROM public.order_lines ol
                WHERE ol.tenant_id = NEW.tenant_id AND ol.order_id = NEW.id AND ol.kind <> 'tax') o
         FULL JOIN (SELECT * FROM public.quote_lines ql
                     WHERE ql.tenant_id = NEW.tenant_id AND ql.quote_id = NEW.quote_id) l
           ON l.line_no = o.line_no
        WHERE o.line_no IS NULL OR l.line_no IS NULL
           OR o.kind <> CASE l.kind WHEN 'ticket' THEN 'service' WHEN 'charter' THEN 'service'
                                    ELSE l.kind END
           OR o.code <> l.code OR o.name <> l.name
           OR o.basis IS DISTINCT FROM l.basis
           OR o.quantity <> l.quantity OR o.unit_amount <> l.unit_amount
           OR o.amount <> l.amount OR o.discount_amount <> l.discount_amount
           OR o.taxable <> l.taxable)
     OR EXISTS (
       SELECT 1
         FROM (SELECT * FROM public.order_lines ol
                WHERE ol.tenant_id = NEW.tenant_id AND ol.order_id = NEW.id AND ol.kind = 'tax') o
         FULL JOIN (
           SELECT t.tax_rate_id, t.tax_rate_version,
                  sum(t.amount)::integer AS amount,
                  sum(t.taxable_amount)::integer AS taxable_amount
             FROM public.quote_line_taxes t
            WHERE t.tenant_id = NEW.tenant_id AND t.quote_id = NEW.quote_id
            GROUP BY t.tax_rate_id, t.tax_rate_version) l
           ON l.tax_rate_id = o.tax_rate_id AND l.tax_rate_version = o.tax_rate_version
         LEFT JOIN public.tax_rate_versions r
           ON r.tenant_id = NEW.tenant_id AND r.tax_rate_id = l.tax_rate_id
          AND r.version = l.tax_rate_version
        WHERE o.line_no IS NULL OR l.tax_rate_id IS NULL
           OR o.amount <> l.amount OR o.taxable_amount <> l.taxable_amount
           OR o.tax_inclusive <> r.inclusive OR o.name <> r.name) THEN
    RAISE EXCEPTION 'order % does not copy its quote''s lines and taxes', NEW.id
      USING ERRCODE = '23514', CONSTRAINT = 'orders_match_quote';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER orders_match_quote
  AFTER INSERT ON public.orders
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.check_order_matches_quote();

-- Payments: written pending for the order's total on the tenant's active
-- account. The provider's payment id is recorded once. The state moves only
-- with a verified inbox event of the right kind for this provider payment,
-- account, amount, and currency.
CREATE FUNCTION app.check_payment() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  ev record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state IS DISTINCT FROM 'pending' OR NEW.provider_payment_id IS NOT NULL
       OR NEW.succeeded_event_id IS NOT NULL OR NEW.failed_event_id IS NOT NULL THEN
      RAISE EXCEPTION 'a payment starts pending, before the provider knows it'
        USING ERRCODE = '23514', CONSTRAINT = 'payments_transition';
    END IF;
    NEW.created_at := now();
    NEW.updated_at := now();
    NEW.provider_recorded_at := NULL;
    NEW.succeeded_at := NULL;
    NEW.failed_at := NULL;
    IF NOT EXISTS (
      SELECT 1 FROM public.orders o
       WHERE o.tenant_id = NEW.tenant_id AND o.id = NEW.order_id
         AND o.checkout_session_id = NEW.checkout_session_id
         AND o.total_amount = NEW.amount AND o.currency = NEW.currency
         AND o.status = 'pending'
    ) THEN
      RAISE EXCEPTION 'a payment charges its own pending order''s total'
        USING ERRCODE = '23514', CONSTRAINT = 'payments_order';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.payment_accounts a
       WHERE a.tenant_id = NEW.tenant_id AND a.provider = NEW.provider
         AND a.account_ref = NEW.account_ref AND a.status = 'active'
    ) THEN
      RAISE EXCEPTION 'a payment needs the operator''s active account at its provider'
        USING ERRCODE = '23514', CONSTRAINT = 'payments_account';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.checkout_session_id IS DISTINCT FROM OLD.checkout_session_id
     OR NEW.order_id IS DISTINCT FROM OLD.order_id
     OR NEW.provider IS DISTINCT FROM OLD.provider
     OR NEW.account_ref IS DISTINCT FROM OLD.account_ref
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.amount IS DISTINCT FROM OLD.amount
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR (OLD.provider_payment_id IS NOT NULL
         AND NEW.provider_payment_id IS DISTINCT FROM OLD.provider_payment_id)
     OR (OLD.succeeded_event_id IS NOT NULL
         AND NEW.succeeded_event_id IS DISTINCT FROM OLD.succeeded_event_id)
     OR (OLD.failed_event_id IS NOT NULL
         AND NEW.failed_event_id IS DISTINCT FROM OLD.failed_event_id) THEN
    RAISE EXCEPTION 'a payment keeps its order, account, key, amount, provider id, and evidence'
      USING ERRCODE = '23514', CONSTRAINT = 'payments_immutable';
  END IF;
  NEW.provider_recorded_at := CASE
    WHEN OLD.provider_payment_id IS NULL AND NEW.provider_payment_id IS NOT NULL THEN now()
    ELSE OLD.provider_recorded_at END;
  NEW.succeeded_at := OLD.succeeded_at;
  NEW.failed_at := OLD.failed_at;
  NEW.updated_at := now();

  IF NEW.state = OLD.state THEN
    IF NEW.succeeded_event_id IS DISTINCT FROM OLD.succeeded_event_id
       OR NEW.failed_event_id IS DISTINCT FROM OLD.failed_event_id THEN
      RAISE EXCEPTION 'payment evidence is recorded only with its transition'
        USING ERRCODE = '23514', CONSTRAINT = 'payments_evidence';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT ((OLD.state = 'pending' AND NEW.state IN ('succeeded', 'failed'))
          OR (OLD.state = 'failed' AND NEW.state = 'succeeded')) THEN
    RAISE EXCEPTION 'a payment cannot move from % to %', OLD.state, NEW.state
      USING ERRCODE = '23514', CONSTRAINT = 'payments_transition';
  END IF;

  IF NEW.state = 'succeeded' THEN
    IF NEW.failed_event_id IS DISTINCT FROM OLD.failed_event_id THEN
      RAISE EXCEPTION 'payment evidence is recorded only with its transition'
        USING ERRCODE = '23514', CONSTRAINT = 'payments_evidence';
    END IF;
    SELECT e.event_type, e.provider, e.payment_ref, e.account_ref, e.amount, e.currency,
           e.client_reference
      INTO ev
      FROM public.provider_events e
     WHERE e.tenant_id = NEW.tenant_id AND e.id = NEW.succeeded_event_id;
    IF NOT FOUND
       OR ev.event_type <> 'payment.succeeded'
       OR ev.provider <> NEW.provider
       OR NEW.provider_payment_id IS NULL
       OR ev.payment_ref <> NEW.provider_payment_id
       OR ev.account_ref <> NEW.account_ref
       OR ev.amount <> NEW.amount
       OR ev.currency <> NEW.currency
       OR (ev.client_reference IS NOT NULL AND ev.client_reference <> NEW.id) THEN
      RAISE EXCEPTION 'payment % succeeds only with a verified success event for it', NEW.id
        USING ERRCODE = '23514', CONSTRAINT = 'payments_evidence';
    END IF;
    NEW.succeeded_at := now();
  ELSE
    IF NEW.succeeded_event_id IS NOT NULL THEN
      RAISE EXCEPTION 'payment evidence is recorded only with its transition'
        USING ERRCODE = '23514', CONSTRAINT = 'payments_evidence';
    END IF;
    SELECT e.event_type, e.provider, e.payment_ref, e.account_ref, e.client_reference
      INTO ev
      FROM public.provider_events e
     WHERE e.tenant_id = NEW.tenant_id AND e.id = NEW.failed_event_id;
    IF NOT FOUND
       OR ev.event_type <> 'payment.failed'
       OR ev.provider <> NEW.provider
       OR NEW.provider_payment_id IS NULL
       OR ev.payment_ref <> NEW.provider_payment_id
       OR ev.account_ref <> NEW.account_ref
       OR (ev.client_reference IS NOT NULL AND ev.client_reference <> NEW.id) THEN
      RAISE EXCEPTION 'payment % fails only with a verified failure event for it', NEW.id
        USING ERRCODE = '23514', CONSTRAINT = 'payments_evidence';
    END IF;
    NEW.failed_at := now();
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER payments_rules BEFORE INSERT OR UPDATE ON public.payments
  FOR EACH ROW EXECUTE FUNCTION app.check_payment();

-- Refunds: the full amount of a succeeded payment, requested once; the
-- provider's refund id is recorded once, and the state settles once.
CREATE FUNCTION app.check_payment_refund() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state IS DISTINCT FROM 'requested' OR NEW.provider_refund_id IS NOT NULL
       OR NEW.failure_code IS NOT NULL THEN
      RAISE EXCEPTION 'a refund starts requested'
        USING ERRCODE = '23514', CONSTRAINT = 'payment_refunds_transition';
    END IF;
    NEW.created_at := now();
    NEW.updated_at := now();
    NEW.settled_at := NULL;
    IF NOT EXISTS (
      SELECT 1 FROM public.payments p
       WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.payment_id
         AND p.state = 'succeeded' AND p.amount = NEW.amount AND p.currency = NEW.currency
    ) THEN
      RAISE EXCEPTION 'a refund returns the full amount of a succeeded payment'
        USING ERRCODE = '23514', CONSTRAINT = 'payment_refunds_payment';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.payment_id IS DISTINCT FROM OLD.payment_id
     OR NEW.amount IS DISTINCT FROM OLD.amount
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR (OLD.provider_refund_id IS NOT NULL
         AND NEW.provider_refund_id IS DISTINCT FROM OLD.provider_refund_id) THEN
    RAISE EXCEPTION 'a refund keeps its payment, amount, key, and provider id'
      USING ERRCODE = '23514', CONSTRAINT = 'payment_refunds_immutable';
  END IF;
  NEW.settled_at := OLD.settled_at;
  NEW.updated_at := now();
  IF NEW.state = OLD.state THEN
    IF NEW.failure_code IS DISTINCT FROM OLD.failure_code THEN
      RAISE EXCEPTION 'a refund''s failure is recorded with its transition'
        USING ERRCODE = '23514', CONSTRAINT = 'payment_refunds_transition';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.state <> 'requested' THEN
    RAISE EXCEPTION 'refund % already settled as %', OLD.id, OLD.state
      USING ERRCODE = '23514', CONSTRAINT = 'payment_refunds_transition';
  END IF;
  NEW.settled_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER payment_refunds_rules BEFORE INSERT OR UPDATE ON public.payment_refunds
  FOR EACH ROW EXECUTE FUNCTION app.check_payment_refund();

-- Bookings: created confirmed, in the same transaction as their evidence: a
-- succeeded payment and a confirmed hold owned by the same checkout session,
-- for the session's trip, party, and pending order.
CREATE FUNCTION app.check_booking() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  NEW.created_at := now();
  NEW.confirmed_at := now();
  IF NOT EXISTS (
       SELECT 1
         FROM public.checkout_sessions s
         JOIN public.orders o
           ON o.tenant_id = s.tenant_id AND o.checkout_session_id = s.id
         JOIN public.payments p
           ON p.tenant_id = s.tenant_id AND p.checkout_session_id = s.id
         JOIN public.capacity_holds h
           ON h.tenant_id = s.tenant_id AND h.id = s.hold_id
        WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.checkout_session_id
          AND s.state IN ('open', 'expired')
          AND s.trip_id = NEW.trip_id AND s.party_size = NEW.party_size
          AND s.hold_id = NEW.hold_id
          AND o.id = NEW.order_id AND o.status = 'pending'
          AND p.id = NEW.payment_id AND p.state = 'succeeded'
          AND h.state = 'confirmed'
          AND h.owner_ref = 'checkout_session:' || s.id::text
          AND h.trip_id = NEW.trip_id AND h.party_size = NEW.party_size) THEN
    RAISE EXCEPTION 'a booking needs its checkout''s succeeded payment and confirmed hold'
      USING ERRCODE = '23514', CONSTRAINT = 'bookings_evidence';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER bookings_evidence BEFORE INSERT ON public.bookings
  FOR EACH ROW EXECUTE FUNCTION app.check_booking();

-- Finalization exceptions name a verified success for a payment of their own
-- checkout; a refunded one names that payment's refund.
CREATE FUNCTION app.check_finalization_exception() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  NEW.created_at := now();
  IF NOT EXISTS (
       SELECT 1
         FROM public.payments p
         JOIN public.provider_events e
           ON e.tenant_id = p.tenant_id AND e.id = NEW.provider_event_id
        WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.payment_id
          AND p.checkout_session_id = NEW.checkout_session_id
          AND e.event_type = 'payment.succeeded')
     OR (NEW.refund_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.payment_refunds r
        WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.refund_id
          AND r.payment_id = NEW.payment_id)) THEN
    RAISE EXCEPTION 'a finalization exception names its checkout''s payment, success, and refund'
      USING ERRCODE = '23514', CONSTRAINT = 'finalization_exceptions_evidence';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER finalization_exceptions_evidence BEFORE INSERT ON public.finalization_exceptions
  FOR EACH ROW EXECUTE FUNCTION app.check_finalization_exception();

-- A trip with confirmed bookings cannot be canceled until cancellation and
-- remedies exist (G2.9 and G2.11): its guests would keep a paid booking on a
-- trip that no longer runs. The update has locked the trip's row when this
-- runs, as confirmation also locks it, so the count sees every confirmed hold.
-- Under READ COMMITTED only, for the reason the holds trigger gives.
CREATE FUNCTION app.check_trip_cancel_bookings() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  confirmed integer;
BEGIN
  IF NEW.sales_state IS DISTINCT FROM 'canceled' OR OLD.sales_state = 'canceled' THEN
    RETURN NEW;
  END IF;
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'a trip is canceled only under READ COMMITTED, not %',
      pg_catalog.current_setting('transaction_isolation')
      USING ERRCODE = '25000';
  END IF;
  SELECT count(*)::integer INTO confirmed
    FROM public.capacity_holds h
   WHERE h.tenant_id = OLD.tenant_id AND h.trip_id = OLD.id AND h.state = 'confirmed';
  IF confirmed > 0 THEN
    RAISE EXCEPTION 'trip % has % confirmed bookings; it cannot be canceled yet', OLD.id, confirmed
      USING ERRCODE = '23514', CONSTRAINT = 'scheduled_trips_cancel_with_bookings';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER scheduled_trips_cancel_with_bookings
  BEFORE UPDATE OF sales_state ON public.scheduled_trips
  FOR EACH ROW EXECUTE FUNCTION app.check_trip_cancel_bookings();

-- Cross-tenant lookups ------------------------------------------------------------

-- A provider callback names a connected account, not a tenant. This returns
-- the tenant that owns the account, and its status, so the webhook can record
-- the event inside that tenant's own transaction. An id grants nothing: every
-- read and write that follows runs under row-level security, and events are
-- accepted only with a valid provider signature. Accounts and tenants are
-- returned whatever their status, because money that has moved must still be
-- recorded; callers decide what a disabled account may do.
CREATE FUNCTION app.resolve_payment_account(p_provider text, p_account_ref text)
  RETURNS TABLE (tenant_id uuid, account_status text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT a.tenant_id, a.status
      FROM public.payment_accounts a
     WHERE a.provider = p_provider
       AND a.account_ref = p_account_ref
  $$;

-- The checkout sweep's tenant list: tenants with an open checkout past its
-- instant, a refund requested a minute ago or more and not settled, or an
-- inbox event received a minute ago or more and not processed. Tenant ids
-- only, at most 1,000, as app.capacity_hold_sweep_tenants returns; the sweep
-- then works inside each tenant's own transaction.
CREATE FUNCTION app.checkout_sweep_tenants(p_limit integer)
  RETURNS TABLE (tenant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT x.tenant_id FROM (
      SELECT s.tenant_id FROM public.checkout_sessions s
       WHERE s.state = 'open' AND s.expires_at <= pg_catalog.now()
      UNION
      SELECT r.tenant_id FROM public.payment_refunds r
       WHERE r.state = 'requested' AND r.created_at <= pg_catalog.now() - interval '1 minute'
      UNION
      SELECT e.tenant_id FROM public.provider_events e
       WHERE e.processing_state = 'received'
         AND e.verified_at <= pg_catalog.now() - interval '1 minute'
    ) x
     ORDER BY x.tenant_id
     LIMIT greatest(1, least(coalesce(p_limit, 100), 1000))
  $$;

-- Row-level security and append-only guards ---------------------------------------

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'payment_accounts', 'provider_events', 'checkout_sessions', 'orders', 'order_lines',
    'payments', 'payment_refunds', 'bookings', 'finalization_exceptions',
    'fake_provider_payments', 'fake_provider_events', 'fake_provider_refunds'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I'
      ' USING (tenant_id = (SELECT app.current_tenant_id()))'
      ' WITH CHECK (tenant_id = (SELECT app.current_tenant_id()))', t);
    -- No role deletes or truncates any of these.
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE DELETE ON public.%I'
      ' FOR EACH ROW EXECUTE FUNCTION app.reject_mutation()', t || '_no_delete', t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I'
      ' FOR EACH STATEMENT EXECUTE FUNCTION app.reject_mutation()', t || '_no_truncate', t);
  END LOOP;
  -- These never change once written, for any role.
  FOREACH t IN ARRAY ARRAY[
    'order_lines', 'bookings', 'finalization_exceptions',
    'fake_provider_payments', 'fake_provider_events', 'fake_provider_refunds'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON public.%I'
      ' FOR EACH ROW EXECUTE FUNCTION app.reject_mutation()', t || '_append_only', t);
  END LOOP;
END
$$;

-- Privileges ----------------------------------------------------------------------

-- SELECT and INSERT come from the default privileges in 0001. Payment
-- accounts are written by onboarding (the seed), never by a request. UPDATE is
-- granted on the columns that carry a transition; the triggers stamp the times.
REVOKE INSERT ON public.payment_accounts FROM tidegrid_app;
GRANT UPDATE (state) ON public.checkout_sessions TO tidegrid_app;
GRANT UPDATE (status) ON public.orders TO tidegrid_app;
GRANT UPDATE (state, provider_payment_id, succeeded_event_id, failed_event_id)
  ON public.payments TO tidegrid_app;
GRANT UPDATE (state, provider_refund_id, failure_code) ON public.payment_refunds TO tidegrid_app;
GRANT UPDATE (processing_state, outcome) ON public.provider_events TO tidegrid_app;

REVOKE ALL ON FUNCTION app.check_provider_event() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.check_checkout_session() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.check_order() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.check_order_line_sealed() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.check_order_matches_quote() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.check_payment() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.check_payment_refund() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.check_booking() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.check_finalization_exception() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.check_trip_cancel_bookings() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.resolve_payment_account(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.checkout_sweep_tenants(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_payment_account(text, text) TO tidegrid_app;
GRANT EXECUTE ON FUNCTION app.checkout_sweep_tenants(integer) TO tidegrid_app;
