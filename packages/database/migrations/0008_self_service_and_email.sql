-- Guest self-service and transactional email (lane 1: G2.11c and the G2.16 demo shim)
--
-- After a booking confirms, its guest manages it without an account: names the
-- party, and cancels within the booking's own policy, which refunds through
-- the payment adapter and gives the seats back. Design authority:
-- docs/v2/02-product-scope.md (policies, cancellation, and refunds; guest,
-- party, and account self-service; transactional email), docs/v2/04-architecture.md
-- (checkout, booking, and orders; waivers, for the access-link pattern;
-- messaging; the retained invariants), and the contracts in
-- packages/domain-booking/README.md and packages/domain-messaging/README.md.
--
-- This migration adds:
--
--   booking_participants     who is coming: one row per place in the party
--   booking_cancellations    one per booking, ever: the remedy its policy gives
--   bookings                 confirmed -> canceled, with its cancellation
--   payment_refunds          a second reason, booking_canceled, for any amount
--                            the cancellation computed, up to what was paid
--
-- Chain of custody for a cancellation, enforced for every role, the owner
-- included:
--
--   booking canceled         requires  its cancellation row
--   cancellation             requires  a confirmed booking whose trip has not
--                                      departed, and the remedy its snapshotted
--                                      policy version gives on the database clock
--   cancellation refund      requires  the canceled booking's cancellation naming
--                                      this refund, for exactly its amount
--   at commit                          a canceled booking's hold is released, and a
--                                      cancellation with money to return has its
--                                      refund row
--
-- Lock order for a cancellation: checkout session, booking, payment, trip, hold
-- (the confirmation path's order, with the booking added after the session).
--
-- Tenancy follows packages/database/README.md: tenant_id on every row,
-- composite tenant foreign keys, forced row-level security with a
-- tenant_isolation policy, SELECT and INSERT from the default privileges,
-- UPDATE only on the columns that carry a change, and no DELETE or TRUNCATE
-- for any role.

-- Participants --------------------------------------------------------------------

-- One person in a booking's party, at one place: 1 to the booking's party
-- size, so a party can never hold more people than it bought. A minor names a
-- guardian, who signs for them (waivers, G2.15); an adult names none. The
-- participant's own email is optional. Personal data: kept for the booking,
-- its roster, and its messages; never in audit rows, events, logs, or URLs.
-- Edited in place, never removed: removing a shared-seat participant releases
-- a seat and is a later goal.
CREATE TABLE public.booking_participants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  booking_id uuid NOT NULL,
  position smallint NOT NULL CHECK (position BETWEEN 1 AND 500),
  full_name text NOT NULL
    CHECK (char_length(full_name) BETWEEN 1 AND 120 AND full_name !~ '[[:cntrl:]]'),
  is_minor boolean NOT NULL,
  email text
    CHECK (email IS NULL OR (char_length(email) <= 254
                             AND email = lower(email)
                             AND email ~ '^[\x21-\x7e]+$'
                             AND email ~ '^[^@]+@[^@]+\.[^@]+$')),
  guardian_name text
    CHECK (guardian_name IS NULL
           OR (char_length(guardian_name) BETWEEN 1 AND 120 AND guardian_name !~ '[[:cntrl:]]')),
  guardian_email text
    CHECK (guardian_email IS NULL OR (char_length(guardian_email) <= 254
                                      AND guardian_email = lower(guardian_email)
                                      AND guardian_email ~ '^[\x21-\x7e]+$'
                                      AND guardian_email ~ '^[^@]+@[^@]+\.[^@]+$')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  -- Lets a row elsewhere (a waiver request, a message) name the participant and
  -- its booking together, so it can never pair one booking with another's guest.
  UNIQUE (tenant_id, booking_id, id),
  CONSTRAINT booking_participants_position_key UNIQUE (tenant_id, booking_id, position),
  FOREIGN KEY (tenant_id, booking_id) REFERENCES public.bookings (tenant_id, id),
  CONSTRAINT booking_participants_guardian CHECK (
    (is_minor AND guardian_name IS NOT NULL AND guardian_email IS NOT NULL)
    OR (NOT is_minor AND guardian_name IS NULL AND guardian_email IS NULL))
);

-- A participant joins and changes only on a confirmed booking, at a place
-- within its party; it keeps its booking and place for good. The booking's
-- row lock orders this against the booking's cancellation, which updates that
-- row: whichever commits second sees the other.
CREATE FUNCTION app.check_booking_participant() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  b record;
BEGIN
  IF TG_OP = 'UPDATE' AND (
       NEW.id IS DISTINCT FROM OLD.id
       OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.booking_id IS DISTINCT FROM OLD.booking_id
       OR NEW.position IS DISTINCT FROM OLD.position
       OR NEW.created_at IS DISTINCT FROM OLD.created_at) THEN
    RAISE EXCEPTION 'a participant keeps its booking and its place in the party'
      USING ERRCODE = '23514', CONSTRAINT = 'booking_participants_immutable';
  END IF;
  SELECT x.state, x.party_size INTO b
    FROM public.bookings x
   WHERE x.tenant_id = NEW.tenant_id AND x.id = NEW.booking_id
     FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no booking % for this tenant', NEW.booking_id
      USING ERRCODE = '23503', CONSTRAINT = 'booking_participants_booking';
  END IF;
  IF b.state <> 'confirmed' THEN
    RAISE EXCEPTION 'booking % is %; its party no longer changes', NEW.booking_id, b.state
      USING ERRCODE = '23514', CONSTRAINT = 'booking_participants_booking_open';
  END IF;
  IF NEW.position > b.party_size THEN
    RAISE EXCEPTION 'booking % has % places; there is no place %',
      NEW.booking_id, b.party_size, NEW.position
      USING ERRCODE = '23514', CONSTRAINT = 'booking_participants_party_size';
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := now();
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER booking_participants_rules BEFORE INSERT OR UPDATE ON public.booking_participants
  FOR EACH ROW EXECUTE FUNCTION app.check_booking_participant();

-- Cancellations -------------------------------------------------------------------

-- A guest's cancellation of one booking, once, with the remedy the booking's
-- own policy version gives: the cutoff instant and the side of it the
-- cancellation fell on, by the database clock; the refund in basis points of
-- what was paid, rounded half up to the cent; and the refund row that returns
-- it. The trigger below computes every term again from the booking, its
-- order's policy version, its trip, and its payment, and refuses a row that
-- differs, so no writer can choose a remedy the policy does not give. A
-- policy that gives credit is not self-service: credits are a later goal
-- (G2.9), and the operator issues them.
CREATE TABLE public.booking_cancellations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  booking_id uuid NOT NULL,
  payment_id uuid NOT NULL,
  product_id uuid NOT NULL,
  policy_version integer NOT NULL,
  departs_at timestamptz NOT NULL,
  cutoff_at timestamptz NOT NULL,
  before_cutoff boolean NOT NULL,
  remedy text NOT NULL CHECK (remedy IN ('full_refund', 'percent_refund', 'none')),
  refund_bp integer NOT NULL CHECK (refund_bp BETWEEN 0 AND 10000),
  paid_amount integer NOT NULL CHECK (paid_amount BETWEEN 1 AND 100000000),
  refund_amount integer NOT NULL CHECK (refund_amount BETWEEN 0 AND 100000000),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  -- Chosen by the service before the refund row is written; checked at commit.
  refund_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  actor_type text NOT NULL DEFAULT coalesce(app.setting_or_null('app.actor_type'), 'system')
    CHECK (actor_type IN ('staff', 'guest', 'system', 'support')),
  actor_id text DEFAULT app.setting_or_null('app.actor_id'),
  request_id text DEFAULT app.setting_or_null('app.request_id'),
  UNIQUE (tenant_id, id),
  -- One cancellation per booking, ever.
  CONSTRAINT booking_cancellations_once UNIQUE (tenant_id, booking_id),
  CONSTRAINT booking_cancellations_refund_key UNIQUE (tenant_id, refund_id),
  FOREIGN KEY (tenant_id, booking_id) REFERENCES public.bookings (tenant_id, id),
  FOREIGN KEY (tenant_id, payment_id) REFERENCES public.payments (tenant_id, id),
  FOREIGN KEY (tenant_id, product_id, policy_version)
    REFERENCES public.policy_versions (tenant_id, product_id, version),
  CONSTRAINT booking_cancellations_refund FOREIGN KEY (tenant_id, refund_id)
    REFERENCES public.payment_refunds (tenant_id, id) DEFERRABLE INITIALLY DEFERRED,
  CHECK (remedy <> 'full_refund' OR refund_bp = 10000),
  CHECK (remedy <> 'percent_refund' OR refund_bp BETWEEN 1 AND 9999),
  CHECK (remedy <> 'none' OR refund_bp = 0),
  -- Half up to the cent: floor((paid x bp + 5000) / 10000).
  CHECK (refund_amount = ((paid_amount::bigint * refund_bp + 5000) / 10000)::integer),
  CHECK ((refund_amount > 0) = (refund_id IS NOT NULL)),
  CHECK (cutoff_at <= departs_at)
);

-- A cancellation is the remedy the booking's policy gives now. Everything is
-- read from the booking's own rows, under the writer's row-level security and
-- with the tenant named, and compared with what the row says.
CREATE FUNCTION app.check_booking_cancellation() RETURNS trigger
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
  IF want_remedy = 'credit' THEN
    RAISE EXCEPTION 'booking % would be credited; credit is issued by the operator, not self-service',
      NEW.booking_id
      USING ERRCODE = '23514', CONSTRAINT = 'booking_cancellations_credit';
  END IF;
  want_bp := CASE want_remedy WHEN 'full_refund' THEN 10000 WHEN 'none' THEN 0 ELSE want_bp END;
  IF NEW.remedy IS DISTINCT FROM want_remedy OR NEW.refund_bp IS DISTINCT FROM want_bp THEN
    RAISE EXCEPTION 'booking %''s policy gives % at % basis points, not % at %',
      NEW.booking_id, want_remedy, want_bp, NEW.remedy, NEW.refund_bp
      USING ERRCODE = '23514', CONSTRAINT = 'booking_cancellations_terms';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER booking_cancellations_rules BEFORE INSERT ON public.booking_cancellations
  FOR EACH ROW EXECUTE FUNCTION app.check_booking_cancellation();

-- Bookings: confirmed -> canceled ---------------------------------------------------

ALTER TABLE public.bookings ADD COLUMN canceled_at timestamptz;
ALTER TABLE public.bookings DROP CONSTRAINT bookings_state_check;
ALTER TABLE public.bookings
  ADD CONSTRAINT bookings_state_check CHECK (state IN ('confirmed', 'canceled'));
ALTER TABLE public.bookings
  ADD CONSTRAINT bookings_canceled_stamp CHECK ((state = 'canceled') = (canceled_at IS NOT NULL));

-- A booking is created confirmed (0007 checks its evidence) and then may only
-- be canceled, once, with its cancellation row. Nothing else about it changes.
DROP TRIGGER bookings_append_only ON public.bookings;

CREATE FUNCTION app.check_booking_lifecycle() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state IS DISTINCT FROM 'confirmed' THEN
      RAISE EXCEPTION 'a booking starts confirmed, not %', NEW.state
        USING ERRCODE = '23514', CONSTRAINT = 'bookings_transition';
    END IF;
    NEW.canceled_at := NULL;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.reference IS DISTINCT FROM OLD.reference
     OR NEW.checkout_session_id IS DISTINCT FROM OLD.checkout_session_id
     OR NEW.order_id IS DISTINCT FROM OLD.order_id
     OR NEW.payment_id IS DISTINCT FROM OLD.payment_id
     OR NEW.hold_id IS DISTINCT FROM OLD.hold_id
     OR NEW.trip_id IS DISTINCT FROM OLD.trip_id
     OR NEW.party_size IS DISTINCT FROM OLD.party_size
     OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.reacquired IS DISTINCT FROM OLD.reacquired
     OR NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a booking keeps its reference, checkout, order, payment, hold, trip, and party'
      USING ERRCODE = '23514', CONSTRAINT = 'bookings_immutable';
  END IF;
  NEW.canceled_at := OLD.canceled_at;
  IF NEW.state = OLD.state THEN
    RETURN NEW;
  END IF;
  IF OLD.state = 'confirmed' AND NEW.state = 'canceled' THEN
    IF NOT EXISTS (SELECT 1 FROM public.booking_cancellations c
                    WHERE c.tenant_id = NEW.tenant_id AND c.booking_id = NEW.id) THEN
      RAISE EXCEPTION 'booking % is canceled only with its cancellation', NEW.id
        USING ERRCODE = '23514', CONSTRAINT = 'bookings_evidence';
    END IF;
    NEW.canceled_at := now();
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'a booking cannot move from % to %', OLD.state, NEW.state
    USING ERRCODE = '23514', CONSTRAINT = 'bookings_transition';
END;
$$;
CREATE TRIGGER bookings_lifecycle BEFORE INSERT OR UPDATE ON public.bookings
  FOR EACH ROW EXECUTE FUNCTION app.check_booking_lifecycle();

-- Checked at commit: a canceled booking gave its seats back. 0007 refuses to
-- release a hold while its booking is confirmed, so the cancellation cancels
-- the booking first and then releases the hold, in one transaction.
CREATE FUNCTION app.check_canceled_booking_released() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF NEW.state = 'canceled' AND NOT EXISTS (
       SELECT 1 FROM public.bookings b
         JOIN public.capacity_holds h ON h.tenant_id = b.tenant_id AND h.id = b.hold_id
        WHERE b.tenant_id = NEW.tenant_id AND b.id = NEW.id AND h.state = 'released') THEN
    RAISE EXCEPTION 'canceled booking % still holds its seats', NEW.id
      USING ERRCODE = '23514', CONSTRAINT = 'bookings_canceled_released';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER bookings_canceled_released
  AFTER UPDATE OF state ON public.bookings
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.check_canceled_booking_released();

-- Refunds: a canceled booking's refund ------------------------------------------------

-- 0007's only refund returned a whole payment that could not become a
-- booking. A cancellation returns what its policy gives, from nothing to the
-- whole payment, and only once its booking is canceled with a cancellation
-- naming this refund for exactly this amount. One refund per payment stays
-- (0007's unique key), so a booking is refunded at most once.
ALTER TABLE public.payment_refunds DROP CONSTRAINT payment_refunds_reason_check;
ALTER TABLE public.payment_refunds
  ADD CONSTRAINT payment_refunds_reason_check
  CHECK (reason IN ('unfulfilled_payment', 'booking_canceled'));

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
    -- The payment's row lock orders this against a booking for the same
    -- payment (check_booking takes it too), so one of them sees the other.
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
      -- Only a payment that could not become a booking is refunded this way.
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

-- Row-level security, append-only guards, and privileges ---------------------------

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['booking_participants', 'booking_cancellations'] LOOP
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
END
$$;

-- A cancellation never changes once written, for any role.
CREATE TRIGGER booking_cancellations_append_only BEFORE UPDATE ON public.booking_cancellations
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();

-- SELECT and INSERT come from the default privileges in 0001. A participant's
-- details may be corrected; a booking's state may move to canceled; the
-- triggers stamp the times and check the evidence.
GRANT UPDATE (full_name, is_minor, email, guardian_name, guardian_email)
  ON public.booking_participants TO tidegrid_app;
GRANT UPDATE (state) ON public.bookings TO tidegrid_app;

REVOKE ALL ON FUNCTION app.check_booking_participant() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.check_booking_cancellation() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.check_booking_lifecycle() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.check_canceled_booking_released() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.check_payment_refund() FROM PUBLIC;
