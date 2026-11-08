-- 0028 refunds, booking credits, and fee reversal (W3-G2.9)
--
-- Design authority: docs/v2/02-product-scope.md ("Refunds and booking
-- credits", "Policies, cancellation, rescheduling, refunds, and credits"),
-- docs/v2/03-commercial-model.md ("Net managed booking value", "Payment
-- economics"), and the domain-booking and domain-payments READMEs.
--
-- This migration adds:
--
-- 1. payment_refunds gains a pending state: the provider accepted the refund
--    but has not finished it. requested -> pending -> succeeded or failed;
--    requested may also settle at once. checked_at records the last time
--    TideGrid asked the provider and got no final answer.
-- 2. provider_events records refund events (refund.updated): the provider's
--    refund id, its status, the refund's idempotency key, and a failure code.
--    Before this, Stripe's refund events were recorded as 'other'.
-- 3. booking_cancellations takes a credit remedy, a staff override with a
--    reason, and the policy's own terms beside the applied ones. Staff may
--    take the policy's refund value as credit instead; anything else that
--    differs from the policy is an override and needs a reason.
-- 4. credit_accounts and credit_entries: a named customer's USD booking credit,
--    as an append-only ledger (issue, redeem, reinstate, adjust). The balance
--    is kept by a definer trigger and can never go below zero.
-- 5. fee_ledger_entries: TideGrid's own managed-booking fee ledger. A
--    succeeded cancellation refund reverses the fee on the refunded eligible
--    value, in proportion (docs/v2/03). Assessment arrives with G2.10.
-- 6. refund_exceptions: a refund still unsettled after the threshold, a
--    lookup the provider keeps refusing, or a refund that failed after it had
--    succeeded. One per refund and reason, append-only.
-- 7. payment_cancellations: an expired or canceled checkout's payment is
--    canceled at the provider, not refunded. The row is the intent, written
--    with the checkout's change; the outcome is recorded after the call.
-- 8. app.checkout_sweep_tenants also lists tenants with a pending refund due
--    a check, or a payment cancellation to send.
--
-- Choices made here are coordinator defaults pending owner confirmation (the
-- W3-G2.9 register entry in docs/v2/06-decision-register.md): D1 a refund
-- unsettled for 24 hours becomes an exception; D2 credit never expires during
-- the pilot (expires_at stays null); D3 payment_intent.canceled maps to
-- payment.failed through its verified event, with no new payment state.
--
-- Tenancy follows packages/database/README.md: tenant_id on every row,
-- composite tenant foreign keys, forced row-level security with a
-- tenant_isolation policy, SELECT and INSERT from the default privileges,
-- UPDATE only on the columns that carry a change, and no DELETE or TRUNCATE
-- for any role.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'this migration must run as a role that bypasses row-level security';
  END IF;
END
$$;

-- 1. Refunds: pending ----------------------------------------------------------

ALTER TABLE public.payment_refunds ADD COLUMN checked_at timestamptz;
ALTER TABLE public.payment_refunds DROP CONSTRAINT payment_refunds_state_check;
ALTER TABLE public.payment_refunds DROP CONSTRAINT payment_refunds_check;
ALTER TABLE public.payment_refunds
  ADD CONSTRAINT payment_refunds_state_check
    CHECK (state IN ('requested', 'pending', 'succeeded', 'failed')),
  ADD CONSTRAINT payment_refunds_settled_stamp
    CHECK ((state IN ('requested', 'pending')) = (settled_at IS NULL)),
  ADD CONSTRAINT payment_refunds_pending_ref
    CHECK (state <> 'pending' OR provider_refund_id IS NOT NULL);

-- The 0009 rules, with pending: a refund starts requested; requested may move
-- to pending, succeeded, or failed; pending may move to succeeded or failed;
-- a settled refund never moves again. The provider's refund id is recorded
-- once. checked_at is stamped by the database clock and only while unsettled.
CREATE OR REPLACE FUNCTION app.check_payment_refund() RETURNS trigger
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
    NEW.checked_at := NULL;
    PERFORM 1 FROM public.payments p
      WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.payment_id
        FOR NO KEY UPDATE;
    IF NEW.reason = 'unfulfilled_payment' THEN
      IF NOT EXISTS (
        SELECT 1 FROM public.payments p
         WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.payment_id
           AND p.state = 'succeeded' AND p.amount = NEW.amount AND p.currency = NEW.currency
      ) THEN
        RAISE EXCEPTION 'a refund returns the full amount of a succeeded payment'
          USING ERRCODE = '23514', CONSTRAINT = 'payment_refunds_payment';
      END IF;
      IF EXISTS (
        SELECT 1 FROM public.bookings b
         WHERE b.tenant_id = NEW.tenant_id AND b.payment_id = NEW.payment_id
      ) THEN
        RAISE EXCEPTION 'payment % has a booking; it is not an unfulfilled payment', NEW.payment_id
          USING ERRCODE = '23514', CONSTRAINT = 'payment_refunds_payment';
      END IF;
    ELSE
      IF NOT EXISTS (
        SELECT 1
          FROM public.payments p
          JOIN public.bookings b ON b.tenant_id = p.tenant_id AND b.payment_id = p.id
          JOIN public.booking_cancellations c
            ON c.tenant_id = b.tenant_id AND c.booking_id = b.id
         WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.payment_id
           AND p.state = 'succeeded' AND p.currency = NEW.currency
           AND NEW.amount <= p.amount
           AND b.state = 'canceled'
           AND c.payment_id = p.id AND c.refund_id = NEW.id AND c.refund_amount = NEW.amount
      ) THEN
        RAISE EXCEPTION 'a cancellation refund returns what its canceled booking''s cancellation computed'
          USING ERRCODE = '23514', CONSTRAINT = 'payment_refunds_payment';
      END IF;
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
  IF NEW.checked_at IS DISTINCT FROM OLD.checked_at THEN
    IF OLD.state NOT IN ('requested', 'pending') THEN
      RAISE EXCEPTION 'refund % is settled; there is nothing to check', OLD.id
        USING ERRCODE = '23514', CONSTRAINT = 'payment_refunds_transition';
    END IF;
    NEW.checked_at := now();
  END IF;
  IF NEW.state = OLD.state THEN
    -- A settled refund never changes, its provider id included.
    IF OLD.state IN ('succeeded', 'failed')
       AND NEW.provider_refund_id IS DISTINCT FROM OLD.provider_refund_id THEN
      RAISE EXCEPTION 'refund % is settled', OLD.id
        USING ERRCODE = '23514', CONSTRAINT = 'payment_refunds_immutable';
    END IF;
    IF NEW.failure_code IS DISTINCT FROM OLD.failure_code THEN
      RAISE EXCEPTION 'a refund''s failure is recorded with its transition'
        USING ERRCODE = '23514', CONSTRAINT = 'payment_refunds_transition';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.state = 'requested' AND NEW.state IN ('pending', 'succeeded', 'failed') THEN
    NULL;
  ELSIF OLD.state = 'pending' AND NEW.state IN ('succeeded', 'failed') THEN
    NULL;
  ELSE
    RAISE EXCEPTION 'refund % cannot move from % to %', OLD.id, OLD.state, NEW.state
      USING ERRCODE = '23514', CONSTRAINT = 'payment_refunds_transition';
  END IF;
  IF NEW.state = 'pending' THEN
    NEW.checked_at := now();
  ELSE
    NEW.settled_at := now();
  END IF;
  RETURN NEW;
END;
$$;

GRANT UPDATE (checked_at) ON public.payment_refunds TO tidegrid_app;

-- 2. Refund events in the inbox ---------------------------------------------------

ALTER TABLE public.provider_events
  ADD COLUMN refund_ref text CHECK (refund_ref ~ '^[A-Za-z0-9_]{3,255}$'),
  ADD COLUMN refund_status text CHECK (refund_status IN ('pending', 'succeeded', 'failed')),
  ADD COLUMN refund_key text CHECK (refund_key ~ '^[A-Za-z0-9_:-]{8,255}$'),
  ADD COLUMN refund_failure_code text CHECK (refund_failure_code ~ '^[a-z][a-z0-9_]{0,63}$');
ALTER TABLE public.provider_events DROP CONSTRAINT provider_events_event_type_check;
ALTER TABLE public.provider_events
  ADD CONSTRAINT provider_events_event_type_check
    CHECK (event_type IN ('payment.succeeded', 'payment.failed', 'refund.updated', 'other')),
  ADD CONSTRAINT provider_events_refund_fields
    CHECK ((event_type = 'refund.updated')
           = (refund_ref IS NOT NULL AND refund_status IS NOT NULL AND refund_key IS NOT NULL)),
  ADD CONSTRAINT provider_events_refund_failure
    CHECK (refund_failure_code IS NULL OR refund_status = 'failed');

-- 0007's rule, with the refund columns in the immutable content.
CREATE OR REPLACE FUNCTION app.check_provider_event() RETURNS trigger
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
     OR NEW.verified_at IS DISTINCT FROM OLD.verified_at
     OR NEW.refund_ref IS DISTINCT FROM OLD.refund_ref
     OR NEW.refund_status IS DISTINCT FROM OLD.refund_status
     OR NEW.refund_key IS DISTINCT FROM OLD.refund_key
     OR NEW.refund_failure_code IS DISTINCT FROM OLD.refund_failure_code THEN
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

-- 3. Cancellations: credit, staff choice, and override --------------------------

ALTER TABLE public.booking_cancellations
  ADD COLUMN credit_amount integer NOT NULL DEFAULT 0
    CHECK (credit_amount BETWEEN 0 AND 100000000),
  -- Chosen by the service before the credit entry is written; checked at commit.
  ADD COLUMN credit_entry_id uuid,
  -- Null on rows written before 0028, whose remedy was always the policy's.
  ADD COLUMN policy_remedy text
    CHECK (policy_remedy IN ('full_refund', 'percent_refund', 'credit', 'none')),
  ADD COLUMN policy_refund_bp integer CHECK (policy_refund_bp BETWEEN 0 AND 10000),
  ADD COLUMN override_reason text
    CHECK (char_length(override_reason) BETWEEN 1 AND 500
           AND override_reason !~ '[\x01-\x1f\x7f]');
ALTER TABLE public.booking_cancellations DROP CONSTRAINT booking_cancellations_remedy_check;
-- 0009's amount rule, for a refund only; credit has its own below.
ALTER TABLE public.booking_cancellations DROP CONSTRAINT booking_cancellations_check3;
ALTER TABLE public.booking_cancellations
  ADD CONSTRAINT booking_cancellations_remedy_check
    CHECK (remedy IN ('full_refund', 'percent_refund', 'credit', 'none')),
  ADD CONSTRAINT booking_cancellations_credit_bp
    CHECK (remedy <> 'credit' OR refund_bp BETWEEN 1 AND 10000),
  -- Half up to the cent: floor((paid x bp + 5000) / 10000), as a refund or as credit.
  ADD CONSTRAINT booking_cancellations_value
    CHECK (refund_amount = CASE WHEN remedy = 'credit' THEN 0
                                ELSE ((paid_amount::bigint * refund_bp + 5000) / 10000)::integer END
           AND credit_amount = CASE WHEN remedy = 'credit'
                                    THEN ((paid_amount::bigint * refund_bp + 5000) / 10000)::integer
                                    ELSE 0 END),
  ADD CONSTRAINT booking_cancellations_credit_entry
    CHECK ((credit_amount > 0) = (credit_entry_id IS NOT NULL)),
  ADD CONSTRAINT booking_cancellations_credit_entry_key UNIQUE (tenant_id, credit_entry_id),
  ADD CONSTRAINT booking_cancellations_policy_terms
    CHECK ((policy_remedy IS NULL) = (policy_refund_bp IS NULL));

-- The remedy a cancellation applies, checked against the policy the booking
-- carries, on the database clock. The policy's own remedy and basis points
-- are stamped on the row (a policy credit is its full value, 10000). Then:
--
-- - a guest (or anyone but staff) gets exactly the policy, and a policy that
--   gives credit is not self-service;
-- - staff may also take the policy's refund value as credit instead (the
--   explicit alternative in docs/v2/02), with no reason needed;
-- - anything else is an override: staff only, with a reason. Any remedy at
--   any basis points the table's checks allow.
--
-- Departure, the booking's state, and its payment are checked for everyone.
CREATE OR REPLACE FUNCTION app.check_booking_cancellation() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  b record;
  p record;
  want_remedy text;
  want_bp integer;
BEGIN
  NEW.created_at := now();
  NEW.actor_type := coalesce(app.setting_or_null('app.actor_type'), 'system');
  NEW.actor_id := app.setting_or_null('app.actor_id');
  NEW.request_id := app.setting_or_null('app.request_id');

  SELECT x.state, x.payment_id, o.product_id, o.policy_version, t.starts_at,
         pay.state AS payment_state, pay.amount AS paid, pay.currency
    INTO b
    FROM public.bookings x
    JOIN public.orders o ON o.tenant_id = x.tenant_id AND o.id = x.order_id
    JOIN public.scheduled_trips t ON t.tenant_id = x.tenant_id AND t.id = x.trip_id
    JOIN public.payments pay ON pay.tenant_id = x.tenant_id AND pay.id = x.payment_id
   WHERE x.tenant_id = NEW.tenant_id AND x.id = NEW.booking_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no booking % for this tenant', NEW.booking_id
      USING ERRCODE = '23503', CONSTRAINT = 'booking_cancellations_booking';
  END IF;
  IF b.state <> 'confirmed' THEN
    RAISE EXCEPTION 'booking % is %, not confirmed', NEW.booking_id, b.state
      USING ERRCODE = '23514', CONSTRAINT = 'booking_cancellations_booking';
  END IF;
  IF now() >= b.starts_at THEN
    RAISE EXCEPTION 'booking % departed at %; it can no longer be canceled', NEW.booking_id, b.starts_at
      USING ERRCODE = '23514', CONSTRAINT = 'booking_cancellations_departed';
  END IF;
  IF b.payment_state <> 'succeeded' OR NEW.payment_id IS DISTINCT FROM b.payment_id
     OR NEW.paid_amount IS DISTINCT FROM b.paid OR NEW.currency IS DISTINCT FROM b.currency THEN
    RAISE EXCEPTION 'a cancellation names its booking''s succeeded payment and what it paid'
      USING ERRCODE = '23514', CONSTRAINT = 'booking_cancellations_terms';
  END IF;

  SELECT v.change_cutoff_minutes, v.before_cutoff_remedy, v.before_cutoff_refund_bp,
         v.after_cutoff_remedy, v.after_cutoff_refund_bp
    INTO p
    FROM public.policy_versions v
   WHERE v.tenant_id = NEW.tenant_id AND v.product_id = b.product_id
     AND v.version = b.policy_version;
  IF NOT FOUND OR NEW.product_id IS DISTINCT FROM b.product_id
     OR NEW.policy_version IS DISTINCT FROM b.policy_version THEN
    RAISE EXCEPTION 'a cancellation applies its booking''s own policy version'
      USING ERRCODE = '23514', CONSTRAINT = 'booking_cancellations_terms';
  END IF;
  IF NEW.departs_at IS DISTINCT FROM b.starts_at
     OR NEW.cutoff_at IS DISTINCT FROM b.starts_at - make_interval(mins => p.change_cutoff_minutes)
     OR NEW.before_cutoff IS DISTINCT FROM (now() < NEW.cutoff_at) THEN
    RAISE EXCEPTION 'a cancellation''s cutoff is its policy''s, and its side of it is the database clock''s'
      USING ERRCODE = '23514', CONSTRAINT = 'booking_cancellations_terms';
  END IF;
  IF NEW.before_cutoff THEN
    want_remedy := p.before_cutoff_remedy;
    want_bp := p.before_cutoff_refund_bp;
  ELSE
    want_remedy := p.after_cutoff_remedy;
    want_bp := p.after_cutoff_refund_bp;
  END IF;
  want_bp := CASE want_remedy
               WHEN 'full_refund' THEN 10000 WHEN 'credit' THEN 10000 WHEN 'none' THEN 0
               ELSE want_bp END;
  NEW.policy_remedy := want_remedy;
  NEW.policy_refund_bp := want_bp;

  IF NEW.override_reason IS NOT NULL THEN
    IF NEW.actor_type <> 'staff' THEN
      RAISE EXCEPTION 'only staff override a cancellation''s policy'
        USING ERRCODE = '23514', CONSTRAINT = 'booking_cancellations_override';
    END IF;
    RETURN NEW;
  END IF;
  IF want_remedy = 'credit' AND NEW.actor_type <> 'staff' THEN
    RAISE EXCEPTION 'booking % would be credited; credit is issued by the operator, not self-service',
      NEW.booking_id
      USING ERRCODE = '23514', CONSTRAINT = 'booking_cancellations_credit';
  END IF;
  IF NEW.refund_bp IS DISTINCT FROM want_bp
     OR (NEW.remedy IS DISTINCT FROM want_remedy
         AND NOT (NEW.actor_type = 'staff' AND NEW.remedy = 'credit'
                  AND want_remedy IN ('full_refund', 'percent_refund'))) THEN
    RAISE EXCEPTION 'booking %''s policy gives % at % basis points, not % at %; a different remedy is an override with a reason',
      NEW.booking_id, want_remedy, want_bp, NEW.remedy, NEW.refund_bp
      USING ERRCODE = '23514', CONSTRAINT = 'booking_cancellations_terms';
  END IF;
  RETURN NEW;
END;
$$;

-- 4. Booking credit ---------------------------------------------------------------

-- One named customer's USD credit with one operator, keyed by the email the
-- customer booked with (lower case, as checkout stores it). Never
-- transferable: an entry moves value only within its own account. The
-- balance is the sum of the account's entries, kept by the entry trigger;
-- the runtime cannot write it.
CREATE TABLE public.credit_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  customer_email text NOT NULL
    CHECK (char_length(customer_email) <= 254
           AND customer_email = lower(customer_email)
           AND customer_email ~ '^[\x21-\x7e]+$'
           AND customer_email ~ '^[^@]+@[^@]+\.[^@]+$'),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  balance integer NOT NULL DEFAULT 0 CHECK (balance BETWEEN 0 AND 1000000000),
  -- How many entries the account has; the trigger numbers each new one.
  entry_count integer NOT NULL DEFAULT 0 CHECK (entry_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CONSTRAINT credit_accounts_customer UNIQUE (tenant_id, customer_email)
);

-- Every change to a credit balance, append-only:
--
--   issue      a credit cancellation's value, once per cancellation
--   redeem     credit used toward a booking of the same customer
--   reinstate  a redemption returned because its booking was canceled, once
--   adjust     staff's correction, up or down, with a reason
--
-- Each row carries the balance after it. The idempotency key makes a
-- repeated command find the first entry instead of moving value twice.
CREATE TABLE public.credit_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  account_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('issue', 'redeem', 'reinstate', 'adjust')),
  amount integer NOT NULL CHECK (amount <> 0 AND amount BETWEEN -100000000 AND 100000000),
  balance_after integer NOT NULL DEFAULT 0 CHECK (balance_after BETWEEN 0 AND 1000000000),
  -- The entry's place in its account's ledger, numbered under the account's
  -- lock, so the last entry's balance_after is the account's balance.
  seq integer NOT NULL DEFAULT 0 CHECK (seq >= 0),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  booking_id uuid,
  cancellation_id uuid,
  reinstates_entry_id uuid,
  -- Null during the pilot (D2: credit never expires).
  expires_at timestamptz,
  reason text CHECK (char_length(reason) BETWEEN 1 AND 500 AND reason !~ '[\x01-\x1f\x7f]'),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9_:-]{8,255}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  actor_type text NOT NULL DEFAULT coalesce(app.setting_or_null('app.actor_type'), 'system')
    CHECK (actor_type IN ('staff', 'guest', 'system', 'support')),
  actor_id text DEFAULT app.setting_or_null('app.actor_id'),
  request_id text DEFAULT app.setting_or_null('app.request_id'),
  UNIQUE (tenant_id, id),
  CONSTRAINT credit_entries_key UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT credit_entries_cancellation_once UNIQUE (tenant_id, cancellation_id),
  CONSTRAINT credit_entries_reinstated_once UNIQUE (tenant_id, reinstates_entry_id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES public.credit_accounts (tenant_id, id),
  FOREIGN KEY (tenant_id, booking_id) REFERENCES public.bookings (tenant_id, id),
  FOREIGN KEY (tenant_id, cancellation_id) REFERENCES public.booking_cancellations (tenant_id, id),
  FOREIGN KEY (tenant_id, reinstates_entry_id) REFERENCES public.credit_entries (tenant_id, id),
  CHECK (kind <> 'issue' OR (amount > 0 AND cancellation_id IS NOT NULL AND booking_id IS NOT NULL)),
  CHECK (kind <> 'redeem' OR (amount < 0 AND booking_id IS NOT NULL)),
  CHECK (kind <> 'reinstate' OR (amount > 0 AND reinstates_entry_id IS NOT NULL)),
  CHECK (kind <> 'adjust' OR reason IS NOT NULL),
  CHECK ((kind = 'issue') = (cancellation_id IS NOT NULL)),
  CHECK ((kind = 'reinstate') = (reinstates_entry_id IS NOT NULL)),
  CHECK (expires_at IS NULL OR kind = 'issue')
);
CREATE UNIQUE INDEX credit_entries_account_seq ON public.credit_entries (tenant_id, account_id, seq);

ALTER TABLE public.booking_cancellations
  ADD CONSTRAINT booking_cancellations_credit FOREIGN KEY (tenant_id, credit_entry_id)
    REFERENCES public.credit_entries (tenant_id, id) DEFERRABLE INITIALLY DEFERRED;

-- A new account starts at zero.
CREATE FUNCTION app.check_credit_account() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  NEW.balance := 0;
  NEW.created_at := now();
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER credit_accounts_rules BEFORE INSERT ON public.credit_accounts
  FOR EACH ROW EXECUTE FUNCTION app.check_credit_account();

-- Every entry is checked against what it claims, then moves the account's
-- balance under the account's row lock, so two entries on one account apply
-- one after the other and the balance never goes below zero. SECURITY
-- DEFINER only so it can write the balance, which no role but the owner may;
-- it reads only the rows the inserted entry names, with the tenant named,
-- and the insert itself ran under the writer's row-level security.
CREATE FUNCTION app.apply_credit_entry() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  acct record;
  next_balance bigint;
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() THEN
    RAISE EXCEPTION 'a credit entry is written in its own tenant'
      USING ERRCODE = '42501', CONSTRAINT = 'credit_entries_tenant';
  END IF;
  NEW.created_at := now();
  NEW.actor_type := coalesce(app.setting_or_null('app.actor_type'), 'system');
  NEW.actor_id := app.setting_or_null('app.actor_id');
  NEW.request_id := app.setting_or_null('app.request_id');

  SELECT a.id, a.customer_email, a.balance, a.entry_count INTO acct
    FROM public.credit_accounts a
   WHERE a.tenant_id = NEW.tenant_id AND a.id = NEW.account_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no credit account % for this tenant', NEW.account_id
      USING ERRCODE = '23503', CONSTRAINT = 'credit_entries_account';
  END IF;

  -- A booking an entry names belongs to the account's customer.
  IF NEW.booking_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.bookings bk
         JOIN public.checkout_sessions s
           ON s.tenant_id = bk.tenant_id AND s.id = bk.checkout_session_id
        WHERE bk.tenant_id = NEW.tenant_id AND bk.id = NEW.booking_id
          AND s.booker_email = acct.customer_email) THEN
    RAISE EXCEPTION 'booking % is not this credit account''s customer''s', NEW.booking_id
      USING ERRCODE = '23514', CONSTRAINT = 'credit_entries_customer';
  END IF;

  IF NEW.kind = 'issue' THEN
    IF NOT EXISTS (
         SELECT 1 FROM public.booking_cancellations c
           JOIN public.bookings bk ON bk.tenant_id = c.tenant_id AND bk.id = c.booking_id
          WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.cancellation_id
            AND c.booking_id = NEW.booking_id AND c.remedy = 'credit'
            AND c.credit_entry_id = NEW.id AND c.credit_amount = NEW.amount
            AND bk.state = 'canceled') THEN
      RAISE EXCEPTION 'credit is issued for exactly what its canceled booking''s cancellation computed'
        USING ERRCODE = '23514', CONSTRAINT = 'credit_entries_issue';
    END IF;
    IF NEW.expires_at IS NOT NULL AND NEW.expires_at <= now() THEN
      RAISE EXCEPTION 'credit cannot be issued already expired'
        USING ERRCODE = '23514', CONSTRAINT = 'credit_entries_issue';
    END IF;
  ELSIF NEW.kind = 'reinstate' THEN
    IF NOT EXISTS (
         SELECT 1 FROM public.credit_entries r
           JOIN public.bookings bk ON bk.tenant_id = r.tenant_id AND bk.id = r.booking_id
          WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.reinstates_entry_id
            AND r.account_id = NEW.account_id AND r.kind = 'redeem'
            AND r.amount = -NEW.amount AND bk.state = 'canceled'
            AND NEW.booking_id IS NOT DISTINCT FROM r.booking_id) THEN
      RAISE EXCEPTION 'a reinstatement returns one redemption of this account whose booking was canceled'
        USING ERRCODE = '23514', CONSTRAINT = 'credit_entries_reinstate';
    END IF;
  ELSIF NEW.kind = 'adjust' THEN
    IF NEW.actor_type NOT IN ('staff', 'support') THEN
      RAISE EXCEPTION 'only staff adjust a credit balance'
        USING ERRCODE = '23514', CONSTRAINT = 'credit_entries_adjust';
    END IF;
  END IF;

  next_balance := acct.balance::bigint + NEW.amount;
  IF next_balance < 0 THEN
    RAISE EXCEPTION 'credit account % holds %; it cannot give %', NEW.account_id, acct.balance, -NEW.amount
      USING ERRCODE = '23514', CONSTRAINT = 'credit_entries_balance';
  END IF;
  IF next_balance > 1000000000 THEN
    RAISE EXCEPTION 'credit account % would exceed the largest balance', NEW.account_id
      USING ERRCODE = '23514', CONSTRAINT = 'credit_entries_balance';
  END IF;
  NEW.balance_after := next_balance::integer;
  NEW.seq := acct.entry_count + 1;
  UPDATE public.credit_accounts
     SET balance = next_balance::integer, entry_count = acct.entry_count + 1, updated_at = now()
   WHERE tenant_id = NEW.tenant_id AND id = NEW.account_id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER credit_entries_apply BEFORE INSERT ON public.credit_entries
  FOR EACH ROW EXECUTE FUNCTION app.apply_credit_entry();

-- 5. TideGrid's managed-booking fee ledger --------------------------------------------

-- TideGrid's own fee on net managed booking value (docs/v2/03), never the
-- guest's money. This goal writes one kind: when a cancellation refund
-- succeeds, the refunded eligible value leaves the fee base, so the fee on it
-- is reversed. Eligible value is the order's total without its taxes;
-- the refund's share of it is in proportion, rounded down, and the fee
-- reversed is the fee rate on that share, half up to the cent. Credit is not
-- a refund: the value stays counted on the original booking (docs/v2/03), so
-- it reverses nothing. One reversal per refund. Assessment arrives with G2.10.
CREATE TABLE public.fee_ledger_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  kind text NOT NULL CHECK (kind IN ('refund_reversal')),
  booking_id uuid NOT NULL,
  refund_id uuid NOT NULL,
  refund_amount integer NOT NULL CHECK (refund_amount BETWEEN 1 AND 100000000),
  order_total integer NOT NULL CHECK (order_total BETWEEN 1 AND 100000000),
  eligible_total integer NOT NULL CHECK (eligible_total BETWEEN 0 AND 100000000),
  eligible_amount integer NOT NULL CHECK (eligible_amount BETWEEN 0 AND 100000000),
  fee_bp integer NOT NULL CHECK (fee_bp BETWEEN 0 AND 10000),
  -- Negative: a reversal lowers what TideGrid bills.
  fee_amount integer NOT NULL CHECK (fee_amount BETWEEN -100000000 AND 0),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  created_at timestamptz NOT NULL DEFAULT now(),
  actor_type text NOT NULL DEFAULT coalesce(app.setting_or_null('app.actor_type'), 'system')
    CHECK (actor_type IN ('staff', 'guest', 'system', 'support')),
  actor_id text DEFAULT app.setting_or_null('app.actor_id'),
  request_id text DEFAULT app.setting_or_null('app.request_id'),
  UNIQUE (tenant_id, id),
  CONSTRAINT fee_ledger_entries_refund_once UNIQUE (tenant_id, refund_id),
  FOREIGN KEY (tenant_id, booking_id) REFERENCES public.bookings (tenant_id, id),
  FOREIGN KEY (tenant_id, refund_id) REFERENCES public.payment_refunds (tenant_id, id),
  CHECK (eligible_total <= order_total AND refund_amount <= order_total),
  CHECK (eligible_amount = ((refund_amount::bigint * eligible_total) / order_total)::integer),
  CHECK (fee_amount = -(((eligible_amount::bigint * fee_bp) + 5000) / 10000)::integer)
);
CREATE INDEX fee_ledger_entries_recent_idx ON public.fee_ledger_entries (tenant_id, created_at);

-- A reversal names a succeeded cancellation refund of this booking, and the
-- order's totals as they are.
CREATE FUNCTION app.check_fee_ledger_entry() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  NEW.created_at := now();
  NEW.actor_type := coalesce(app.setting_or_null('app.actor_type'), 'system');
  NEW.actor_id := app.setting_or_null('app.actor_id');
  NEW.request_id := app.setting_or_null('app.request_id');
  IF NOT EXISTS (
       SELECT 1 FROM public.payment_refunds r
         JOIN public.bookings b ON b.tenant_id = r.tenant_id AND b.payment_id = r.payment_id
         JOIN public.orders o ON o.tenant_id = b.tenant_id AND o.id = b.order_id
        WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.refund_id
          AND r.state = 'succeeded' AND r.reason = 'booking_canceled'
          AND r.amount = NEW.refund_amount
          AND b.id = NEW.booking_id
          AND o.total_amount = NEW.order_total
          AND o.total_amount - o.tax_amount - o.included_tax_amount = NEW.eligible_total) THEN
    RAISE EXCEPTION 'a fee reversal names a succeeded cancellation refund of its booking and the order''s totals'
      USING ERRCODE = '23514', CONSTRAINT = 'fee_ledger_entries_refund';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER fee_ledger_entries_rules BEFORE INSERT ON public.fee_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION app.check_fee_ledger_entry();

-- 6. Refund exceptions ------------------------------------------------------------

-- A refund that needs a person: still unsettled after the threshold (D1, 24
-- hours), a provider lookup that keeps being refused past it, or a refund
-- that failed after it had already succeeded. Raised once per refund and
-- reason; whether it is still open is read from the refund.
CREATE TABLE public.refund_exceptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  refund_id uuid NOT NULL,
  reason text NOT NULL
    CHECK (reason IN ('unsettled', 'lookup_refused', 'failed_after_success', 'succeeded_after_failure')),
  refund_state text NOT NULL CHECK (refund_state IN ('requested', 'pending', 'succeeded', 'failed')),
  error_code text CHECK (error_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CONSTRAINT refund_exceptions_once UNIQUE (tenant_id, refund_id, reason),
  FOREIGN KEY (tenant_id, refund_id) REFERENCES public.payment_refunds (tenant_id, id)
);
CREATE INDEX refund_exceptions_recent_idx ON public.refund_exceptions (tenant_id, created_at DESC);

CREATE FUNCTION app.check_refund_exception() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  r record;
BEGIN
  NEW.created_at := now();
  SELECT x.state, x.created_at INTO r FROM public.payment_refunds x
   WHERE x.tenant_id = NEW.tenant_id AND x.id = NEW.refund_id;
  IF NOT FOUND OR r.state IS DISTINCT FROM NEW.refund_state THEN
    RAISE EXCEPTION 'a refund exception records its refund''s state'
      USING ERRCODE = '23514', CONSTRAINT = 'refund_exceptions_refund';
  END IF;
  IF NEW.reason IN ('unsettled', 'lookup_refused')
     AND (r.state NOT IN ('requested', 'pending') OR r.created_at > now() - interval '24 hours') THEN
    RAISE EXCEPTION 'only a refund unsettled for 24 hours is an exception for that reason'
      USING ERRCODE = '23514', CONSTRAINT = 'refund_exceptions_refund';
  END IF;
  IF NEW.reason = 'failed_after_success' AND r.state <> 'succeeded' THEN
    RAISE EXCEPTION 'only a succeeded refund can fail after success'
      USING ERRCODE = '23514', CONSTRAINT = 'refund_exceptions_refund';
  END IF;
  IF NEW.reason = 'succeeded_after_failure' AND r.state <> 'failed' THEN
    RAISE EXCEPTION 'only a failed refund can succeed after failure'
      USING ERRCODE = '23514', CONSTRAINT = 'refund_exceptions_refund';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER refund_exceptions_rules BEFORE INSERT ON public.refund_exceptions
  FOR EACH ROW EXECUTE FUNCTION app.check_refund_exception();

-- 7. Payment cancellations ----------------------------------------------------------

-- An expired or canceled checkout's payment, canceled at the provider so the
-- guest can no longer pay it. Written in the transaction that closes the
-- checkout, for a payment still pending with a provider id; sent after commit,
-- and resent by the sweep, with its own key. The outcome: canceled; too_late
-- (the payment had already succeeded, so the late-success refund takes over);
-- or refused (the provider will not cancel it, for good).
CREATE TABLE public.payment_cancellations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  payment_id uuid NOT NULL,
  checkout_session_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9_:-]{8,255}$'),
  state text NOT NULL DEFAULT 'requested'
    CHECK (state IN ('requested', 'canceled', 'too_late', 'refused')),
  outcome_code text CHECK (outcome_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CONSTRAINT payment_cancellations_once UNIQUE (tenant_id, payment_id),
  CONSTRAINT payment_cancellations_key UNIQUE (idempotency_key),
  FOREIGN KEY (tenant_id, payment_id) REFERENCES public.payments (tenant_id, id),
  FOREIGN KEY (tenant_id, checkout_session_id) REFERENCES public.checkout_sessions (tenant_id, id),
  CHECK ((state = 'requested') = (settled_at IS NULL)),
  CHECK ((state = 'refused') = (outcome_code IS NOT NULL))
);
CREATE INDEX payment_cancellations_requested_idx
  ON public.payment_cancellations (created_at) INCLUDE (tenant_id)
  WHERE state = 'requested';

CREATE FUNCTION app.check_payment_cancellation() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state IS DISTINCT FROM 'requested' OR NEW.outcome_code IS NOT NULL THEN
      RAISE EXCEPTION 'a payment cancellation starts requested'
        USING ERRCODE = '23514', CONSTRAINT = 'payment_cancellations_transition';
    END IF;
    NEW.created_at := now();
    NEW.updated_at := now();
    NEW.settled_at := NULL;
    IF NOT EXISTS (
         SELECT 1 FROM public.payments p
           JOIN public.checkout_sessions s
             ON s.tenant_id = p.tenant_id AND s.id = p.checkout_session_id
          WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.payment_id
            AND s.id = NEW.checkout_session_id
            AND p.state = 'pending' AND p.provider_payment_id IS NOT NULL
            AND s.state IN ('expired', 'canceled')) THEN
      RAISE EXCEPTION 'only a pending payment of an expired or canceled checkout is canceled'
        USING ERRCODE = '23514', CONSTRAINT = 'payment_cancellations_payment';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.payment_id IS DISTINCT FROM OLD.payment_id
     OR NEW.checkout_session_id IS DISTINCT FROM OLD.checkout_session_id
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a payment cancellation keeps its payment and key'
      USING ERRCODE = '23514', CONSTRAINT = 'payment_cancellations_immutable';
  END IF;
  NEW.updated_at := now();
  NEW.settled_at := OLD.settled_at;
  IF NEW.state = OLD.state AND NEW.outcome_code IS NOT DISTINCT FROM OLD.outcome_code THEN
    RETURN NEW;
  END IF;
  IF OLD.state <> 'requested' OR NEW.state = 'requested' THEN
    RAISE EXCEPTION 'payment cancellation % already settled as %', OLD.id, OLD.state
      USING ERRCODE = '23514', CONSTRAINT = 'payment_cancellations_transition';
  END IF;
  NEW.settled_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER payment_cancellations_rules BEFORE INSERT OR UPDATE ON public.payment_cancellations
  FOR EACH ROW EXECUTE FUNCTION app.check_payment_cancellation();

-- 8. The checkout sweep's tenants ---------------------------------------------------

-- 0013's list, with two more reasons a tenant is due: a pending refund not
-- checked for an hour, and a payment cancellation waiting past the grace.
CREATE OR REPLACE FUNCTION app.checkout_sweep_tenants(p_limit integer, p_grace_seconds integer)
  RETURNS TABLE (tenant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT x.tenant_id FROM (
      SELECT s.tenant_id FROM public.checkout_sessions s
       WHERE s.state = 'open' AND s.expires_at <= pg_catalog.now()
      UNION
      SELECT r.tenant_id FROM public.payment_refunds r
       WHERE r.state = 'requested'
         AND r.created_at <= pg_catalog.now() - pg_catalog.make_interval(
               secs => greatest(0, least(coalesce(p_grace_seconds, 60), 3600)))
      UNION
      SELECT r.tenant_id FROM public.payment_refunds r
       WHERE r.state = 'pending'
         AND r.checked_at <= pg_catalog.now() - interval '1 hour'
      UNION
      SELECT e.tenant_id FROM public.provider_events e
       WHERE e.processing_state = 'received'
         AND e.verified_at <= pg_catalog.now() - pg_catalog.make_interval(
               secs => greatest(0, least(coalesce(p_grace_seconds, 60), 3600)))
      UNION
      SELECT c.tenant_id FROM public.payment_cancellations c
       WHERE c.state = 'requested'
         AND c.created_at <= pg_catalog.now() - pg_catalog.make_interval(
               secs => greatest(0, least(coalesce(p_grace_seconds, 60), 3600)))
    ) x
      LEFT JOIN public.sweep_turns t
        ON t.tenant_id = x.tenant_id AND t.sweep = 'checkout'
     ORDER BY t.last_turn_at ASC NULLS FIRST, x.tenant_id
     LIMIT greatest(1, least(coalesce(p_limit, 100), 1000))
  $$;

-- Row-level security, append-only guards, and privileges ---------------------------

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'credit_accounts', 'credit_entries', 'fee_ledger_entries', 'refund_exceptions',
    'payment_cancellations'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I'
      ' USING (tenant_id = (SELECT app.current_tenant_id()))'
      ' WITH CHECK (tenant_id = (SELECT app.current_tenant_id()))', t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE DELETE ON public.%I'
      ' FOR EACH ROW EXECUTE FUNCTION app.reject_mutation()', t || '_no_delete', t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I'
      ' FOR EACH STATEMENT EXECUTE FUNCTION app.reject_mutation()', t || '_no_truncate', t);
  END LOOP;
  -- These never change once written. The account's balance moves only
  -- through the definer trigger, which runs as the owner.
  FOREACH t IN ARRAY ARRAY['credit_entries', 'fee_ledger_entries', 'refund_exceptions'] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON public.%I'
      ' FOR EACH ROW EXECUTE FUNCTION app.reject_mutation()', t || '_append_only', t);
  END LOOP;
END
$$;

GRANT UPDATE (state, outcome_code) ON public.payment_cancellations TO tidegrid_app;

REVOKE ALL ON FUNCTION app.check_credit_account() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.apply_credit_entry() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.check_fee_ledger_entry() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.check_refund_exception() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.check_payment_cancellation() FROM PUBLIC;
