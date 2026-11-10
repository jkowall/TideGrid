-- 0034 whole-booking rescheduling (W3-G2.11-rest, first part)
--
-- Under the owner's code-only pull-forward of 2026-11-08 and his go on the
-- rest of Wave 3 on 2026-11-10 (the W3-G2.11-rest entry in
-- docs/v2/06-decision-register.md). Synthetic data only. What it adds
-- (docs/v2/02, "Customer and staff changes"):
--
-- 1. booking_reschedules: append-only, one row per move of a whole booking
--    from one trip of its product to another. The move takes a new
--    confirmed hold on the new trip, owned by the reschedule, before the
--    booking gives back its old one, in one transaction: capacity is
--    reacquired atomically, or nothing changes.
-- 2. A booking's trip and hold may change only with its reschedule row, and
--    stay confirmed. Everything else about a booking stays fixed.
-- 3. Before the policy's cutoff anyone the booking allows may move it; at or
--    after the cutoff only a staff member with a reason (an override). No one
--    moves a booking whose trip has left.
--
-- The booking keeps the price it was sold at: its order is the sale's
-- statement and is never rewritten (a coordinator default pending owner
-- confirmation). Tenancy follows packages/database/README.md.

CREATE TABLE public.booking_reschedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  booking_id uuid NOT NULL,
  from_trip_id uuid NOT NULL,
  to_trip_id uuid NOT NULL,
  from_hold_id uuid NOT NULL,
  to_hold_id uuid NOT NULL,
  -- On the database clock, against the trip the booking left.
  before_cutoff boolean NOT NULL,
  -- A staff member's reason for a move the policy does not allow by itself.
  override_reason text
    CHECK (char_length(override_reason) BETWEEN 1 AND 500
           AND override_reason !~ '[\x01-\x1f\x7f]'),
  created_at timestamptz NOT NULL DEFAULT now(),
  actor_type text NOT NULL DEFAULT coalesce(app.setting_or_null('app.actor_type'), 'system')
    CHECK (actor_type IN ('staff', 'guest', 'system', 'support')),
  actor_id text DEFAULT app.setting_or_null('app.actor_id'),
  request_id text DEFAULT app.setting_or_null('app.request_id'),
  CHECK (from_trip_id <> to_trip_id),
  CHECK (from_hold_id <> to_hold_id),
  UNIQUE (tenant_id, id),
  CONSTRAINT booking_reschedules_to_hold_key UNIQUE (tenant_id, to_hold_id),
  CONSTRAINT booking_reschedules_from_hold_key UNIQUE (tenant_id, from_hold_id),
  FOREIGN KEY (tenant_id, booking_id) REFERENCES public.bookings (tenant_id, id),
  FOREIGN KEY (tenant_id, from_trip_id) REFERENCES public.scheduled_trips (tenant_id, id),
  FOREIGN KEY (tenant_id, to_trip_id) REFERENCES public.scheduled_trips (tenant_id, id),
  FOREIGN KEY (tenant_id, from_hold_id) REFERENCES public.capacity_holds (tenant_id, id),
  FOREIGN KEY (tenant_id, to_hold_id) REFERENCES public.capacity_holds (tenant_id, id)
);
CREATE INDEX booking_reschedules_booking_idx
  ON public.booking_reschedules (tenant_id, booking_id, created_at);

-- A move is written under the booking's lock, for the booking as it stands:
-- confirmed, on the trip and hold it leaves, to another trip of the same
-- product that has not left, with the new hold already confirmed for the same
-- party and owned by this move. The cutoff is the booking's own policy
-- version's, against the trip it leaves.
CREATE FUNCTION app.check_booking_reschedule() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  b record;
BEGIN
  NEW.created_at := clock_timestamp();
  NEW.actor_type := coalesce(app.setting_or_null('app.actor_type'), 'system');
  NEW.actor_id := app.setting_or_null('app.actor_id');
  NEW.request_id := app.setting_or_null('app.request_id');
  PERFORM 1 FROM public.bookings x
    WHERE x.tenant_id = NEW.tenant_id AND x.id = NEW.booking_id
      FOR NO KEY UPDATE;
  SELECT x.state, x.trip_id, x.hold_id, x.party_size, o.product_id, o.deposit_amount,
         t.starts_at,
         now() < t.starts_at - make_interval(mins => v.change_cutoff_minutes) AS before_cutoff
    INTO b
    FROM public.bookings x
    JOIN public.orders o ON o.tenant_id = x.tenant_id AND o.id = x.order_id
    JOIN public.scheduled_trips t ON t.tenant_id = x.tenant_id AND t.id = x.trip_id
    JOIN public.policy_versions v
      ON v.tenant_id = o.tenant_id AND v.product_id = o.product_id
     AND v.version = o.policy_version
   WHERE x.tenant_id = NEW.tenant_id AND x.id = NEW.booking_id;
  IF NOT FOUND OR b.state <> 'confirmed'
     OR b.trip_id <> NEW.from_trip_id OR b.hold_id <> NEW.from_hold_id THEN
    RAISE EXCEPTION 'a move starts from a confirmed booking''s own trip and hold'
      USING ERRCODE = '23514', CONSTRAINT = 'booking_reschedules_booking';
  END IF;
  IF now() >= b.starts_at THEN
    RAISE EXCEPTION 'booking %''s trip has left; it cannot move', NEW.booking_id
      USING ERRCODE = '23514', CONSTRAINT = 'booking_reschedules_departed';
  END IF;
  NEW.before_cutoff := b.before_cutoff;
  IF NEW.override_reason IS NOT NULL AND NEW.actor_type <> 'staff' THEN
    RAISE EXCEPTION 'only staff move a booking against its policy'
      USING ERRCODE = '42501', CONSTRAINT = 'booking_reschedules_override';
  END IF;
  IF NOT b.before_cutoff AND NEW.override_reason IS NULL THEN
    RAISE EXCEPTION 'booking % is past its change cutoff; staff may move it with a reason',
      NEW.booking_id
      USING ERRCODE = '23514', CONSTRAINT = 'booking_reschedules_cutoff';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.scheduled_trips t
     WHERE t.tenant_id = NEW.tenant_id AND t.id = NEW.to_trip_id
       AND t.product_id = b.product_id AND t.starts_at > now()
  ) THEN
    RAISE EXCEPTION 'a booking moves only to another trip of its product that has not left'
      USING ERRCODE = '23514', CONSTRAINT = 'booking_reschedules_trip';
  END IF;
  -- A balance still owed must stay due before the trip (0033).
  IF b.deposit_amount IS NOT NULL AND EXISTS (
    SELECT 1 FROM app.booking_balance(NEW.tenant_id, NEW.booking_id) x
      JOIN public.scheduled_trips t ON t.tenant_id = NEW.tenant_id AND t.id = NEW.to_trip_id
     WHERE x.owed > 0 AND x.due_at >= t.starts_at
  ) THEN
    RAISE EXCEPTION 'the new trip leaves before booking %''s balance is due', NEW.booking_id
      USING ERRCODE = '23514', CONSTRAINT = 'booking_reschedules_balance';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.capacity_holds h
     WHERE h.tenant_id = NEW.tenant_id AND h.id = NEW.to_hold_id
       AND h.trip_id = NEW.to_trip_id AND h.state = 'confirmed'
       AND h.party_size = b.party_size
       AND h.owner_ref = 'booking_reschedule:' || NEW.id::text
  ) THEN
    RAISE EXCEPTION 'a move needs its own confirmed hold on the new trip for the same party'
      USING ERRCODE = '23514', CONSTRAINT = 'booking_reschedules_hold';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER booking_reschedules_rules BEFORE INSERT ON public.booking_reschedules
  FOR EACH ROW EXECUTE FUNCTION app.check_booking_reschedule();

-- 0009's lifecycle, with one change: a confirmed booking's trip and hold move
-- together, with the reschedule row that names both ends.
CREATE OR REPLACE FUNCTION app.check_booking_lifecycle() RETURNS trigger
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
     OR NEW.party_size IS DISTINCT FROM OLD.party_size
     OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.reacquired IS DISTINCT FROM OLD.reacquired
     OR NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a booking keeps its reference, checkout, order, payment, hold, trip, and party'
      USING ERRCODE = '23514', CONSTRAINT = 'bookings_immutable';
  END IF;
  IF NEW.hold_id IS DISTINCT FROM OLD.hold_id OR NEW.trip_id IS DISTINCT FROM OLD.trip_id THEN
    IF OLD.state <> 'confirmed' OR NEW.state <> 'confirmed' OR NOT EXISTS (
         SELECT 1 FROM public.booking_reschedules r
          WHERE r.tenant_id = NEW.tenant_id AND r.booking_id = NEW.id
            AND r.from_trip_id = OLD.trip_id AND r.from_hold_id = OLD.hold_id
            AND r.to_trip_id = NEW.trip_id AND r.to_hold_id = NEW.hold_id) THEN
      RAISE EXCEPTION 'a booking''s trip and hold change only with its reschedule'
        USING ERRCODE = '23514', CONSTRAINT = 'bookings_immutable';
    END IF;
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

-- Checked at commit: a moved booking gave its old seats back, so a move never
-- holds two trips at once once it commits.
CREATE FUNCTION app.check_rescheduled_released() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.capacity_holds h
     WHERE h.tenant_id = NEW.tenant_id AND h.id = NEW.from_hold_id AND h.state <> 'released'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.bookings b
     WHERE b.tenant_id = NEW.tenant_id AND b.id = NEW.booking_id
       AND b.hold_id = NEW.to_hold_id AND b.trip_id = NEW.to_trip_id
  ) THEN
    RAISE EXCEPTION 'move % must leave its booking on the new hold with the old one released',
      NEW.id
      USING ERRCODE = '23514', CONSTRAINT = 'booking_reschedules_applied';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER booking_reschedules_applied
  AFTER INSERT ON public.booking_reschedules
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.check_rescheduled_released();

-- Row-level security, append-only guards, and privileges ---------------------------------

ALTER TABLE public.booking_reschedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.booking_reschedules FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.booking_reschedules
  USING (tenant_id = (SELECT app.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()));
CREATE TRIGGER booking_reschedules_no_delete BEFORE DELETE ON public.booking_reschedules
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();
CREATE TRIGGER booking_reschedules_no_truncate BEFORE TRUNCATE ON public.booking_reschedules
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_mutation();
CREATE TRIGGER booking_reschedules_append_only BEFORE UPDATE ON public.booking_reschedules
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();

GRANT UPDATE (trip_id, hold_id) ON public.bookings TO tidegrid_app;

REVOKE ALL ON FUNCTION app.check_booking_reschedule() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.check_rescheduled_released() FROM PUBLIC;
