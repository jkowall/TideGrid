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
--   email_messages           transactional email, enqueued with the change that
--                            causes it and sent after commit by a delivery job
--   guest_access_links       accountless, single-use, expiring access tokens,
--                            stored only as hashes and issued when an email is sent
--   guest_sessions           the restricted session a redeemed link opens
--   fake_email_deliveries    what the fake email provider "sent" (demo shim)
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

-- The delivery job's tenant list below is a SECURITY DEFINER function that
-- reads a table with forced row-level security; its owner must bypass it.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'this migration must run as a role that bypasses row-level security';
  END IF;
END
$$;

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

-- Email messages -------------------------------------------------------------------

-- One transactional email, enqueued in the same transaction as the change
-- that causes it (a booking confirmed or canceled, a link requested, a waiver
-- request), so it exists only if the change commits. It is rendered when it
-- is enqueued, with the tenant's brand, and kept with its template and
-- version. A delivery job sends it after commit with the message id as the
-- provider's idempotency key and records the outcome; states move one way.
-- dedupe_key names the logical message, once per tenant for ever, so a
-- retried command or a replayed event enqueues nothing new.
--
-- A message that carries an access link records where and why, never the
-- link: the delivery job issues the token when it sends and writes the URL
-- into the bodies in place of the marker that link_slot names, so a raw token
-- is never stored. Personal data: the recipient and the bodies stay here and
-- in the provider call, never in audit rows, events, or logs.
CREATE TABLE public.email_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  dedupe_key text NOT NULL CHECK (dedupe_key ~ '^[a-z][a-z0-9_.]*:[A-Za-z0-9_.:-]{1,200}$'),
  template text NOT NULL CHECK (template ~ '^[a-z][a-z0-9_]{0,63}$'),
  template_version integer NOT NULL CHECK (template_version BETWEEN 1 AND 1000),
  booking_id uuid,
  participant_id uuid,
  -- What else the message is about, such as 'waiver_request:<uuid>'.
  subject_ref text CHECK (subject_ref ~ '^[a-z][a-z0-9_]{0,63}:[0-9a-f-]{36}$'),
  to_email text NOT NULL
    CHECK (char_length(to_email) <= 254
           AND to_email = lower(to_email)
           AND to_email ~ '^[\x21-\x7e]+$'
           AND to_email ~ '^[^@]+@[^@]+\.[^@]+$'),
  to_name text CHECK (to_name IS NULL
                      OR (char_length(to_name) BETWEEN 1 AND 120 AND to_name !~ '[[:cntrl:]]')),
  from_name text NOT NULL
    CHECK (char_length(from_name) BETWEEN 1 AND 120 AND from_name !~ '[[:cntrl:]]'),
  reply_to text CHECK (reply_to IS NULL OR (char_length(reply_to) <= 254
                                            AND reply_to ~ '^[\x21-\x7e]+$'
                                            AND reply_to ~ '^[^@]+@[^@]+\.[^@]+$')),
  subject text NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 200 AND subject !~ '[[:cntrl:]]'),
  html_body text NOT NULL CHECK (char_length(html_body) BETWEEN 1 AND 200000),
  text_body text NOT NULL CHECK (char_length(text_body) BETWEEN 1 AND 100000),
  link_purpose text CHECK (link_purpose IN ('booking_manage', 'waiver_sign')),
  link_path text CHECK (link_path ~ '^/[a-z0-9/_-]{0,100}$'),
  link_ttl_seconds integer CHECK (link_ttl_seconds BETWEEN 300 AND 1209600),
  link_slot text CHECK (link_slot ~ '^[0-9a-f]{32}$'),
  state text NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued', 'sending', 'sent', 'failed', 'canceled')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 100),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  -- When the latest attempt was claimed; stamped by the trigger.
  last_attempt_at timestamptz,
  lease_expires_at timestamptz,
  provider text CHECK (provider IN ('fake', 'cloudflare')),
  provider_message_id text CHECK (provider_message_id ~ '^[A-Za-z0-9_.@<>:+=-]{3,255}$'),
  last_error_code text CHECK (last_error_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  failed_at timestamptz,
  canceled_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CONSTRAINT email_messages_once UNIQUE (tenant_id, dedupe_key),
  FOREIGN KEY (tenant_id, booking_id) REFERENCES public.bookings (tenant_id, id),
  FOREIGN KEY (tenant_id, booking_id, participant_id)
    REFERENCES public.booking_participants (tenant_id, booking_id, id),
  CHECK (participant_id IS NULL OR booking_id IS NOT NULL),
  CONSTRAINT email_messages_link CHECK (
    (link_purpose IS NULL) = (link_slot IS NULL)
    AND (link_purpose IS NULL) = (link_path IS NULL)
    AND (link_purpose IS NULL) = (link_ttl_seconds IS NULL)
    AND (link_purpose IS NULL OR booking_id IS NOT NULL)
    AND (link_purpose IS DISTINCT FROM 'waiver_sign' OR participant_id IS NOT NULL)),
  CHECK ((state = 'sending') = (lease_expires_at IS NOT NULL)),
  CHECK ((attempts = 0) = (last_attempt_at IS NULL)),
  CHECK ((state = 'sent') = (sent_at IS NOT NULL)),
  CHECK (state <> 'sent' OR (provider IS NOT NULL AND provider_message_id IS NOT NULL)),
  CHECK (state = 'sent' OR provider_message_id IS NULL),
  CHECK ((state = 'failed') = (failed_at IS NOT NULL)),
  CHECK (state <> 'failed' OR last_error_code IS NOT NULL),
  CHECK ((state = 'canceled') = (canceled_at IS NOT NULL))
);
-- Due work, per tenant and across tenants (the delivery job).
CREATE INDEX email_messages_due_idx ON public.email_messages (tenant_id, next_attempt_at)
  WHERE state = 'queued';
CREATE INDEX email_messages_due_any_tenant_idx ON public.email_messages (next_attempt_at)
  INCLUDE (tenant_id)
  WHERE state = 'queued';
CREATE INDEX email_messages_leased_idx ON public.email_messages (lease_expires_at)
  INCLUDE (tenant_id)
  WHERE state = 'sending';
CREATE INDEX email_messages_booking_idx ON public.email_messages (tenant_id, booking_id, created_at)
  WHERE booking_id IS NOT NULL;

-- A message's content never changes. Its delivery moves one way: claimed for
-- a short lease (each claim one more attempt, only when due or when the last
-- attempt's lease has lapsed), then sent with the provider's id, back to
-- queued for a later attempt after a temporary failure, or failed. A queued
-- message may be canceled, and so may one being sent: the attempt under way
-- then records nothing and is never retried. Times come from the database
-- clock.
CREATE FUNCTION app.check_email_message() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state IS DISTINCT FROM 'queued' OR NEW.attempts IS DISTINCT FROM 0
       OR NEW.lease_expires_at IS NOT NULL OR NEW.provider IS NOT NULL
       OR NEW.provider_message_id IS NOT NULL OR NEW.last_error_code IS NOT NULL THEN
      RAISE EXCEPTION 'a message starts queued and unsent'
        USING ERRCODE = '23514', CONSTRAINT = 'email_messages_transition';
    END IF;
    NEW.created_at := now();
    NEW.updated_at := now();
    NEW.last_attempt_at := NULL;
    NEW.sent_at := NULL;
    NEW.failed_at := NULL;
    NEW.canceled_at := NULL;
    -- A message may wait to be sent (a reminder); it never jumps the queue.
    NEW.next_attempt_at := greatest(coalesce(NEW.next_attempt_at, now()), now());
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.dedupe_key IS DISTINCT FROM OLD.dedupe_key
     OR NEW.template IS DISTINCT FROM OLD.template
     OR NEW.template_version IS DISTINCT FROM OLD.template_version
     OR NEW.booking_id IS DISTINCT FROM OLD.booking_id
     OR NEW.participant_id IS DISTINCT FROM OLD.participant_id
     OR NEW.subject_ref IS DISTINCT FROM OLD.subject_ref
     OR NEW.to_email IS DISTINCT FROM OLD.to_email
     OR NEW.to_name IS DISTINCT FROM OLD.to_name
     OR NEW.from_name IS DISTINCT FROM OLD.from_name
     OR NEW.reply_to IS DISTINCT FROM OLD.reply_to
     OR NEW.subject IS DISTINCT FROM OLD.subject
     OR NEW.html_body IS DISTINCT FROM OLD.html_body
     OR NEW.text_body IS DISTINCT FROM OLD.text_body
     OR NEW.link_purpose IS DISTINCT FROM OLD.link_purpose
     OR NEW.link_path IS DISTINCT FROM OLD.link_path
     OR NEW.link_ttl_seconds IS DISTINCT FROM OLD.link_ttl_seconds
     OR NEW.link_slot IS DISTINCT FROM OLD.link_slot
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a message''s recipient and content never change'
      USING ERRCODE = '23514', CONSTRAINT = 'email_messages_immutable';
  END IF;
  NEW.last_attempt_at := OLD.last_attempt_at;
  NEW.sent_at := OLD.sent_at;
  NEW.failed_at := OLD.failed_at;
  NEW.canceled_at := OLD.canceled_at;
  NEW.updated_at := now();
  IF OLD.state IN ('sent', 'failed', 'canceled') THEN
    IF NEW.state IS DISTINCT FROM OLD.state OR NEW.attempts IS DISTINCT FROM OLD.attempts
       OR NEW.next_attempt_at IS DISTINCT FROM OLD.next_attempt_at
       OR NEW.lease_expires_at IS DISTINCT FROM OLD.lease_expires_at
       OR NEW.provider IS DISTINCT FROM OLD.provider
       OR NEW.provider_message_id IS DISTINCT FROM OLD.provider_message_id
       OR NEW.last_error_code IS DISTINCT FROM OLD.last_error_code THEN
      RAISE EXCEPTION 'message % is %; it no longer changes', OLD.id, OLD.state
        USING ERRCODE = '23514', CONSTRAINT = 'email_messages_transition';
    END IF;
    RETURN NEW;
  END IF;

  -- A claim: one more attempt, under a fresh lease of at most ten minutes.
  IF NEW.state = 'sending' AND (OLD.state = 'queued' OR NEW.attempts IS DISTINCT FROM OLD.attempts) THEN
    IF (OLD.state = 'queued' AND OLD.next_attempt_at > now())
       OR (OLD.state = 'sending' AND OLD.lease_expires_at > now()) THEN
      RAISE EXCEPTION 'message % is not due', OLD.id
        USING ERRCODE = '23514', CONSTRAINT = 'email_messages_claim';
    END IF;
    IF NEW.attempts IS DISTINCT FROM OLD.attempts + 1
       OR NEW.lease_expires_at IS NULL OR NEW.lease_expires_at <= now()
       OR NEW.lease_expires_at > now() + interval '10 minutes'
       OR NEW.provider IS NULL OR NEW.provider_message_id IS NOT NULL THEN
      RAISE EXCEPTION 'a claim is one more attempt at one provider, under a lease of at most ten minutes'
        USING ERRCODE = '23514', CONSTRAINT = 'email_messages_claim';
    END IF;
    NEW.next_attempt_at := OLD.next_attempt_at;
    NEW.last_error_code := OLD.last_error_code;
    NEW.last_attempt_at := now();
    RETURN NEW;
  END IF;
  IF NEW.attempts IS DISTINCT FROM OLD.attempts THEN
    RAISE EXCEPTION 'attempts count claims only'
      USING ERRCODE = '23514', CONSTRAINT = 'email_messages_transition';
  END IF;
  IF NEW.state = OLD.state THEN
    -- Without a transition only time moves, and only earlier: a queued message
    -- due sooner, or a lease ended sooner (tests make time pass this way).
    IF NEW.provider IS DISTINCT FROM OLD.provider
       OR NEW.provider_message_id IS DISTINCT FROM OLD.provider_message_id
       OR NEW.last_error_code IS DISTINCT FROM OLD.last_error_code
       OR NEW.next_attempt_at > OLD.next_attempt_at
       OR (OLD.state = 'queued' AND NEW.lease_expires_at IS NOT NULL)
       OR (OLD.state = 'sending'
           AND (NEW.next_attempt_at IS DISTINCT FROM OLD.next_attempt_at
                OR NEW.lease_expires_at IS NULL
                OR NEW.lease_expires_at > OLD.lease_expires_at)) THEN
      RAISE EXCEPTION 'a message''s delivery changes only with a transition; its times move only earlier'
        USING ERRCODE = '23514', CONSTRAINT = 'email_messages_transition';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.state = 'sending' AND NEW.state = 'sent' THEN
    IF NEW.provider_message_id IS NULL OR NEW.provider IS DISTINCT FROM OLD.provider THEN
      RAISE EXCEPTION 'a sent message names the provider''s id for it'
        USING ERRCODE = '23514', CONSTRAINT = 'email_messages_transition';
    END IF;
    NEW.lease_expires_at := NULL;
    NEW.next_attempt_at := OLD.next_attempt_at;
    -- The last attempt was accepted: an earlier attempt's error no longer applies.
    NEW.last_error_code := NULL;
    NEW.sent_at := now();
    RETURN NEW;
  END IF;
  IF OLD.state = 'sending' AND NEW.state IN ('queued', 'failed') THEN
    IF NEW.last_error_code IS NULL OR NEW.provider_message_id IS NOT NULL
       OR NEW.provider IS DISTINCT FROM OLD.provider
       OR (NEW.state = 'queued' AND NEW.next_attempt_at <= now()) THEN
      RAISE EXCEPTION 'a failed attempt records its error, and a retry waits'
        USING ERRCODE = '23514', CONSTRAINT = 'email_messages_transition';
    END IF;
    NEW.lease_expires_at := NULL;
    IF NEW.state = 'failed' THEN
      NEW.next_attempt_at := OLD.next_attempt_at;
      NEW.failed_at := now();
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.state IN ('queued', 'sending') AND NEW.state = 'canceled' THEN
    NEW.next_attempt_at := OLD.next_attempt_at;
    NEW.lease_expires_at := NULL;
    NEW.provider := OLD.provider;
    NEW.provider_message_id := NULL;
    -- Its error code is the one the cancellation sets (such as
    -- recipient_changed), or none: every cancel sets it, and an earlier
    -- attempt's error no longer describes the message.
    NEW.canceled_at := now();
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'a message cannot move from % to %', OLD.state, NEW.state
    USING ERRCODE = '23514', CONSTRAINT = 'email_messages_transition';
END;
$$;
CREATE TRIGGER email_messages_rules BEFORE INSERT OR UPDATE ON public.email_messages
  FOR EACH ROW EXECUTE FUNCTION app.check_email_message();

-- The delivery job's tenant list: tenants with a queued message that is due,
-- or a message whose sending lease has lapsed (an attempt that crashed). The
-- same argument as app.capacity_hold_sweep_tenants and app.checkout_sweep_tenants:
-- tenant ids only, at most 1,000, read-only and STABLE; every read and write
-- that follows runs inside that tenant's own transaction under row-level
-- security. It reveals that some tenant has mail to send, a weaker signal
-- than the shared audit and outbox id sequences already give.
CREATE FUNCTION app.email_delivery_tenants(p_limit integer)
  RETURNS TABLE (tenant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT x.tenant_id FROM (
      SELECT m.tenant_id FROM public.email_messages m
       WHERE m.state = 'queued' AND m.next_attempt_at <= pg_catalog.now()
      UNION
      SELECT m.tenant_id FROM public.email_messages m
       WHERE m.state = 'sending' AND m.lease_expires_at <= pg_catalog.now()
    ) x
     ORDER BY x.tenant_id
     LIMIT greatest(1, least(coalesce(p_limit, 100), 1000))
  $$;

-- Guest access links ----------------------------------------------------------------

-- An accountless entry to one booking for one purpose: the booking's
-- management (booking_manage) or, from G2.15, a participant's waiver
-- (waiver_sign). The raw token is 32 random bytes that travel only in an
-- email, in the URL's fragment; only its SHA-256 is stored. A link is
-- short-lived (at most 14 days), used once (consumed atomically by an
-- explicit redemption, a POST, never by a GET or a link preview), and
-- revocable. Issued by the delivery job when it sends the email that carries
-- it (message_id), so retries never need a stored token.
CREATE TABLE public.guest_access_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  booking_id uuid NOT NULL,
  participant_id uuid,
  purpose text NOT NULL CHECK (purpose IN ('booking_manage', 'waiver_sign')),
  subject_ref text CHECK (subject_ref ~ '^[a-z][a-z0-9_]{0,63}:[0-9a-f-]{36}$'),
  message_id uuid,
  token_hash text NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  revoked_at timestamptz,
  -- superseded: a newer email's link replaced it. completed: its purpose is
  -- done (a waiver signed). withdrawn: no longer needed (a participant or
  -- requirement removed). recipient_changed, booking_canceled, staff: as named.
  revoked_reason text
    CHECK (revoked_reason IN ('superseded', 'completed', 'withdrawn', 'recipient_changed',
                              'booking_canceled', 'staff')),
  UNIQUE (tenant_id, id),
  CONSTRAINT guest_access_links_token_key UNIQUE (token_hash),
  FOREIGN KEY (tenant_id, booking_id) REFERENCES public.bookings (tenant_id, id),
  FOREIGN KEY (tenant_id, booking_id, participant_id)
    REFERENCES public.booking_participants (tenant_id, booking_id, id),
  FOREIGN KEY (tenant_id, message_id) REFERENCES public.email_messages (tenant_id, id),
  CHECK (purpose <> 'waiver_sign' OR participant_id IS NOT NULL),
  CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL)),
  CHECK (consumed_at IS NULL OR revoked_at IS NULL)
);
-- Live links of one booking and purpose, for superseding and revoking.
CREATE INDEX guest_access_links_live_idx
  ON public.guest_access_links (tenant_id, booking_id, purpose)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;

-- A link is written unused, expiring within 14 days; afterwards only its use
-- or its revocation is recorded, once, on the database clock, and a link used
-- or revoked never changes again. Using it needs it unexpired.
CREATE FUNCTION app.check_guest_access_link() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.consumed_at IS NOT NULL OR NEW.revoked_at IS NOT NULL OR NEW.revoked_reason IS NOT NULL THEN
      RAISE EXCEPTION 'a link starts unused'
        USING ERRCODE = '23514', CONSTRAINT = 'guest_access_links_transition';
    END IF;
    NEW.created_at := now();
    IF NEW.expires_at <= now() OR NEW.expires_at > now() + interval '14 days' THEN
      RAISE EXCEPTION 'a link expires within 14 days, not at %', NEW.expires_at
        USING ERRCODE = '23514', CONSTRAINT = 'guest_access_links_expiry';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.booking_id IS DISTINCT FROM OLD.booking_id
     OR NEW.participant_id IS DISTINCT FROM OLD.participant_id
     OR NEW.purpose IS DISTINCT FROM OLD.purpose
     OR NEW.subject_ref IS DISTINCT FROM OLD.subject_ref
     OR NEW.message_id IS DISTINCT FROM OLD.message_id
     OR NEW.token_hash IS DISTINCT FROM OLD.token_hash
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.expires_at > OLD.expires_at THEN
    RAISE EXCEPTION 'a link keeps its booking, purpose, and token; its expiry moves only earlier'
      USING ERRCODE = '23514', CONSTRAINT = 'guest_access_links_immutable';
  END IF;
  IF OLD.consumed_at IS NOT NULL OR OLD.revoked_at IS NOT NULL THEN
    IF NEW.expires_at IS DISTINCT FROM OLD.expires_at
       OR NEW.consumed_at IS DISTINCT FROM OLD.consumed_at
       OR NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
       OR NEW.revoked_reason IS DISTINCT FROM OLD.revoked_reason THEN
      RAISE EXCEPTION 'link % was already used or revoked', OLD.id
        USING ERRCODE = '23514', CONSTRAINT = 'guest_access_links_transition';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.consumed_at IS NOT NULL THEN
    IF NEW.revoked_at IS NOT NULL OR NEW.revoked_reason IS NOT NULL THEN
      RAISE EXCEPTION 'a link is used or revoked, not both'
        USING ERRCODE = '23514', CONSTRAINT = 'guest_access_links_transition';
    END IF;
    IF OLD.expires_at <= now() THEN
      RAISE EXCEPTION 'link % expired at %', OLD.id, OLD.expires_at
        USING ERRCODE = '23514', CONSTRAINT = 'guest_access_links_expiry';
    END IF;
    NEW.consumed_at := now();
  ELSIF NEW.revoked_at IS NOT NULL OR NEW.revoked_reason IS NOT NULL THEN
    IF NEW.revoked_at IS NULL OR NEW.revoked_reason IS NULL THEN
      RAISE EXCEPTION 'a revocation records its reason'
        USING ERRCODE = '23514', CONSTRAINT = 'guest_access_links_transition';
    END IF;
    NEW.revoked_at := now();
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guest_access_links_rules BEFORE INSERT OR UPDATE ON public.guest_access_links
  FOR EACH ROW EXECUTE FUNCTION app.check_guest_access_link();

-- Guest sessions ----------------------------------------------------------------------

-- The restricted session a guest holds after redeeming a link: bound to one
-- tenant, one booking, one purpose (and, for a waiver, one participant and
-- subject), for at most 12 hours, revocable. Its raw token goes back once in
-- the redemption's response body and is sent as a bearer token; only its
-- SHA-256 is stored. It is opened only by the redemption that consumed its
-- link, in that transaction, or by the checkout that made the booking within
-- an hour of confirmation (the guest names the party right after paying).
CREATE TABLE public.guest_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  booking_id uuid NOT NULL,
  participant_id uuid,
  purpose text NOT NULL CHECK (purpose IN ('booking_manage', 'waiver_sign')),
  subject_ref text CHECK (subject_ref ~ '^[a-z][a-z0-9_]{0,63}:[0-9a-f-]{36}$'),
  link_id uuid,
  checkout_session_id uuid,
  token_hash text NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  UNIQUE (tenant_id, id),
  CONSTRAINT guest_sessions_token_key UNIQUE (token_hash),
  -- One session per redeemed link.
  CONSTRAINT guest_sessions_one_per_link UNIQUE (tenant_id, link_id),
  FOREIGN KEY (tenant_id, booking_id) REFERENCES public.bookings (tenant_id, id),
  FOREIGN KEY (tenant_id, booking_id, participant_id)
    REFERENCES public.booking_participants (tenant_id, booking_id, id),
  FOREIGN KEY (tenant_id, link_id) REFERENCES public.guest_access_links (tenant_id, id),
  FOREIGN KEY (tenant_id, checkout_session_id) REFERENCES public.checkout_sessions (tenant_id, id),
  CHECK ((link_id IS NULL) <> (checkout_session_id IS NULL))
);

CREATE FUNCTION app.check_guest_session() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  l record;
  b record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'a session starts unrevoked'
        USING ERRCODE = '23514', CONSTRAINT = 'guest_sessions_transition';
    END IF;
    NEW.created_at := now();
    IF NEW.expires_at <= now() OR NEW.expires_at > now() + interval '12 hours' THEN
      RAISE EXCEPTION 'a guest session lasts at most 12 hours'
        USING ERRCODE = '23514', CONSTRAINT = 'guest_sessions_expiry';
    END IF;
    IF NEW.link_id IS NOT NULL THEN
      -- The link's own trigger stamped its use with now(), this transaction's
      -- start: a link used in an earlier transaction opens nothing.
      SELECT x.booking_id, x.participant_id, x.purpose, x.subject_ref, x.consumed_at
        INTO l
        FROM public.guest_access_links x
       WHERE x.tenant_id = NEW.tenant_id AND x.id = NEW.link_id;
      IF NOT FOUND OR l.consumed_at IS DISTINCT FROM now()
         OR l.booking_id <> NEW.booking_id
         OR l.participant_id IS DISTINCT FROM NEW.participant_id
         OR l.purpose <> NEW.purpose
         OR l.subject_ref IS DISTINCT FROM NEW.subject_ref THEN
        RAISE EXCEPTION 'a session is opened only by the redemption that used its link'
          USING ERRCODE = '23514', CONSTRAINT = 'guest_sessions_evidence';
      END IF;
    ELSE
      SELECT x.id, x.confirmed_at INTO b
        FROM public.bookings x
       WHERE x.tenant_id = NEW.tenant_id AND x.checkout_session_id = NEW.checkout_session_id;
      IF NOT FOUND OR b.id <> NEW.booking_id OR NEW.purpose <> 'booking_manage'
         OR NEW.participant_id IS NOT NULL OR NEW.subject_ref IS NOT NULL
         OR now() > b.confirmed_at + interval '1 hour' THEN
        RAISE EXCEPTION 'a checkout opens a session for its own booking, within an hour of confirmation'
          USING ERRCODE = '23514', CONSTRAINT = 'guest_sessions_evidence';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.booking_id IS DISTINCT FROM OLD.booking_id
     OR NEW.participant_id IS DISTINCT FROM OLD.participant_id
     OR NEW.purpose IS DISTINCT FROM OLD.purpose
     OR NEW.subject_ref IS DISTINCT FROM OLD.subject_ref
     OR NEW.link_id IS DISTINCT FROM OLD.link_id
     OR NEW.checkout_session_id IS DISTINCT FROM OLD.checkout_session_id
     OR NEW.token_hash IS DISTINCT FROM OLD.token_hash
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.expires_at > OLD.expires_at THEN
    RAISE EXCEPTION 'a session keeps its booking, purpose, and token; its expiry moves only earlier'
      USING ERRCODE = '23514', CONSTRAINT = 'guest_sessions_immutable';
  END IF;
  IF OLD.revoked_at IS NOT NULL THEN
    IF NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
       OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
      RAISE EXCEPTION 'session % was already revoked', OLD.id
        USING ERRCODE = '23514', CONSTRAINT = 'guest_sessions_transition';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.revoked_at IS NOT NULL THEN
    NEW.revoked_at := now();
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guest_sessions_rules BEFORE INSERT OR UPDATE ON public.guest_sessions
  FOR EACH ROW EXECUTE FUNCTION app.check_guest_session();

-- The fake email provider -----------------------------------------------------------

-- A demo stand-in for an email provider behind the neutral adapter (the
-- owner's 2026-10-05 decision to shim providers): every send it answers, as
-- it answered it, append-only. A key is accepted once; a repeat answers with
-- the first. It never reads or writes TideGrid's own message table. The API
-- refuses the fake provider in a production configuration.
CREATE TABLE public.fake_email_deliveries (
  id text PRIMARY KEY CHECK (id ~ '^fmsg_[A-Za-z0-9]{24}$'),
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 255),
  result text NOT NULL CHECK (result IN ('accepted', 'unavailable', 'rejected')),
  from_address text NOT NULL CHECK (char_length(from_address) BETWEEN 3 AND 254),
  from_name text NOT NULL CHECK (char_length(from_name) BETWEEN 1 AND 120),
  reply_to text CHECK (reply_to IS NULL OR char_length(reply_to) BETWEEN 3 AND 254),
  to_address text NOT NULL CHECK (char_length(to_address) BETWEEN 3 AND 254),
  to_name text CHECK (to_name IS NULL OR char_length(to_name) BETWEEN 1 AND 120),
  subject text NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 200),
  html_body text NOT NULL CHECK (char_length(html_body) BETWEEN 1 AND 210000),
  text_body text NOT NULL CHECK (char_length(text_body) BETWEEN 1 AND 110000),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX fake_email_deliveries_accepted_once
  ON public.fake_email_deliveries (tenant_id, idempotency_key) WHERE result = 'accepted';
CREATE INDEX fake_email_deliveries_key_idx
  ON public.fake_email_deliveries (tenant_id, idempotency_key);
CREATE INDEX fake_email_deliveries_recent_idx
  ON public.fake_email_deliveries (tenant_id, created_at DESC);

-- Row-level security, append-only guards, and privileges ---------------------------

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'booking_participants', 'booking_cancellations', 'email_messages', 'guest_access_links',
    'guest_sessions', 'fake_email_deliveries'
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
END
$$;

-- These never change once written, for any role.
CREATE TRIGGER booking_cancellations_append_only BEFORE UPDATE ON public.booking_cancellations
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();
CREATE TRIGGER fake_email_deliveries_append_only BEFORE UPDATE ON public.fake_email_deliveries
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();

-- SELECT and INSERT come from the default privileges in 0001. A participant's
-- details may be corrected; a booking's state may move to canceled; a
-- message's delivery moves; a link is used or revoked; a session is revoked.
-- The triggers stamp the times and check every move.
GRANT UPDATE (full_name, is_minor, email, guardian_name, guardian_email)
  ON public.booking_participants TO tidegrid_app;
GRANT UPDATE (state) ON public.bookings TO tidegrid_app;
GRANT UPDATE (state, attempts, next_attempt_at, lease_expires_at, provider, provider_message_id,
              last_error_code)
  ON public.email_messages TO tidegrid_app;
GRANT UPDATE (consumed_at, revoked_at, revoked_reason) ON public.guest_access_links TO tidegrid_app;
GRANT UPDATE (revoked_at) ON public.guest_sessions TO tidegrid_app;

REVOKE ALL ON FUNCTION app.check_booking_participant() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.check_booking_cancellation() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.check_booking_lifecycle() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.check_canceled_booking_released() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.check_payment_refund() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.check_email_message() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.check_guest_access_link() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.check_guest_session() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.email_delivery_tenants(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.email_delivery_tenants(integer) TO tidegrid_app;
