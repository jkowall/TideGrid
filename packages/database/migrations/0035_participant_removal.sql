-- 0035 removing a participant from a shared-seat booking (W3-G2.11-rest, second part)
--
-- Under the owner's go of 2026-11-10 on the rest of Wave 3 (the W3-G2.11-rest
-- participant removal entry in docs/v2/06-decision-register.md). Synthetic
-- data only. What it adds (docs/v2/02, "Customer and staff changes" and
-- "Guest, party, and account self-service"):
--
-- 1. booking_party_changes: append-only, one row per place given up by a
--    shared-seat booking. The party shrinks by one, and the seat goes back on
--    sale: the booking's hold is released and a new confirmed hold for the
--    smaller party, owned by the change, takes its place, in one transaction.
-- 2. A booking's party size may change only with its change row, by one
--    place, down, together with its hold. Its trip stays.
-- 3. A participant at the place given up is kept, marked removed
--    (`removed_at`), for the waiver and message history that names them; a
--    removed participant never changes again, and the place is never named
--    again. Places keep their numbers: a party of 4 that gave up place 2 has
--    places 1, 3, and 4.
-- 4. Before the policy's change cutoff anyone the booking allows may give up
--    a place; at or after the cutoff only a staff member with a reason (an
--    override). Never after the trip has left, never the last place (that is
--    a cancellation), and never on a private charter, whose party does not
--    take seats.
--
-- The booking keeps the price it was sold at: its order is the sale's
-- statement and is never rewritten (a coordinator default pending owner
-- confirmation). Tenancy follows packages/database/README.md.

ALTER TABLE public.booking_participants ADD COLUMN removed_at timestamptz;

CREATE TABLE public.booking_party_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  booking_id uuid NOT NULL,
  trip_id uuid NOT NULL,
  from_hold_id uuid NOT NULL,
  from_party_size integer NOT NULL CHECK (from_party_size BETWEEN 2 AND 500),
  to_party_size integer NOT NULL,
  -- The place given up, as the party numbered it.
  position smallint NOT NULL CHECK (position BETWEEN 1 AND 500),
  -- The participant named at that place, if anyone was.
  participant_id uuid,
  -- On the database clock, against the booking's trip.
  before_cutoff boolean NOT NULL,
  -- A staff member's reason for a change the policy does not allow by itself.
  override_reason text
    CHECK (char_length(override_reason) BETWEEN 1 AND 500
           AND override_reason !~ '[\x01-\x1f\x7f]'),
  created_at timestamptz NOT NULL DEFAULT now(),
  actor_type text NOT NULL DEFAULT coalesce(app.setting_or_null('app.actor_type'), 'system')
    CHECK (actor_type IN ('staff', 'guest', 'system', 'support')),
  actor_id text DEFAULT app.setting_or_null('app.actor_id'),
  request_id text DEFAULT app.setting_or_null('app.request_id'),
  CHECK (to_party_size = from_party_size - 1),
  UNIQUE (tenant_id, id),
  CONSTRAINT booking_party_changes_position_key UNIQUE (tenant_id, booking_id, position),
  CONSTRAINT booking_party_changes_from_hold_key UNIQUE (tenant_id, from_hold_id),
  CONSTRAINT booking_party_changes_participant_key UNIQUE (tenant_id, participant_id),
  FOREIGN KEY (tenant_id, booking_id) REFERENCES public.bookings (tenant_id, id),
  FOREIGN KEY (tenant_id, trip_id) REFERENCES public.scheduled_trips (tenant_id, id),
  FOREIGN KEY (tenant_id, from_hold_id) REFERENCES public.capacity_holds (tenant_id, id),
  FOREIGN KEY (tenant_id, booking_id, participant_id)
    REFERENCES public.booking_participants (tenant_id, booking_id, id)
);
CREATE INDEX booking_party_changes_booking_idx
  ON public.booking_party_changes (tenant_id, booking_id, created_at);

-- A change is written under the booking's lock, for the booking as it
-- stands: confirmed, shared-seat, on its own trip and hold and party, at a
-- place the party still has, naming whoever is at that place. The cutoff is
-- the booking's own policy version's, against its trip.
CREATE FUNCTION app.check_booking_party_change() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  b record;
  at_place uuid;
BEGIN
  NEW.created_at := clock_timestamp();
  NEW.actor_type := coalesce(app.setting_or_null('app.actor_type'), 'system');
  NEW.actor_id := app.setting_or_null('app.actor_id');
  NEW.request_id := app.setting_or_null('app.request_id');
  PERFORM 1 FROM public.bookings x
    WHERE x.tenant_id = NEW.tenant_id AND x.id = NEW.booking_id
      FOR NO KEY UPDATE;
  SELECT x.state, x.trip_id, x.hold_id, x.party_size, p.kind AS product_kind,
         s.party_size AS sold_party_size, t.starts_at,
         now() < t.starts_at - make_interval(mins => v.change_cutoff_minutes) AS before_cutoff
    INTO b
    FROM public.bookings x
    JOIN public.checkout_sessions s
      ON s.tenant_id = x.tenant_id AND s.id = x.checkout_session_id
    JOIN public.orders o ON o.tenant_id = x.tenant_id AND o.id = x.order_id
    JOIN public.products p ON p.tenant_id = o.tenant_id AND p.id = o.product_id
    JOIN public.scheduled_trips t ON t.tenant_id = x.tenant_id AND t.id = x.trip_id
    JOIN public.policy_versions v
      ON v.tenant_id = o.tenant_id AND v.product_id = o.product_id
     AND v.version = o.policy_version
   WHERE x.tenant_id = NEW.tenant_id AND x.id = NEW.booking_id;
  IF NOT FOUND OR b.state <> 'confirmed'
     OR b.trip_id <> NEW.trip_id OR b.hold_id <> NEW.from_hold_id
     OR b.party_size <> NEW.from_party_size THEN
    RAISE EXCEPTION 'a party change starts from a confirmed booking''s own trip, hold, and party'
      USING ERRCODE = '23514', CONSTRAINT = 'booking_party_changes_booking';
  END IF;
  IF b.product_kind <> 'shared_seat' THEN
    RAISE EXCEPTION 'only a shared-seat booking gives up a place'
      USING ERRCODE = '23514', CONSTRAINT = 'booking_party_changes_kind';
  END IF;
  IF now() >= b.starts_at THEN
    RAISE EXCEPTION 'booking %''s trip has left; its party no longer changes', NEW.booking_id
      USING ERRCODE = '23514', CONSTRAINT = 'booking_party_changes_departed';
  END IF;
  NEW.before_cutoff := b.before_cutoff;
  IF NEW.override_reason IS NOT NULL AND NEW.actor_type <> 'staff' THEN
    RAISE EXCEPTION 'only staff change a party against its policy'
      USING ERRCODE = '42501', CONSTRAINT = 'booking_party_changes_override';
  END IF;
  IF NOT b.before_cutoff AND NEW.override_reason IS NULL THEN
    RAISE EXCEPTION 'booking % is past its change cutoff; staff may change it with a reason',
      NEW.booking_id
      USING ERRCODE = '23514', CONSTRAINT = 'booking_party_changes_cutoff';
  END IF;
  -- The places are 1 to the party size the booking was sold with, less those
  -- given up; the unique key refuses one given up twice.
  IF NEW.position > b.sold_party_size OR EXISTS (
       SELECT 1 FROM public.booking_party_changes c
        WHERE c.tenant_id = NEW.tenant_id AND c.booking_id = NEW.booking_id
          AND c.position = NEW.position) THEN
    RAISE EXCEPTION 'booking % has no place %', NEW.booking_id, NEW.position
      USING ERRCODE = '23514', CONSTRAINT = 'booking_party_changes_position';
  END IF;
  SELECT q.id INTO at_place
    FROM public.booking_participants q
   WHERE q.tenant_id = NEW.tenant_id AND q.booking_id = NEW.booking_id
     AND q.position = NEW.position
     FOR NO KEY UPDATE;
  IF at_place IS DISTINCT FROM NEW.participant_id THEN
    RAISE EXCEPTION 'a party change names the participant at its place, or none if unnamed'
      USING ERRCODE = '23514', CONSTRAINT = 'booking_party_changes_participant';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER booking_party_changes_rules BEFORE INSERT ON public.booking_party_changes
  FOR EACH ROW EXECUTE FUNCTION app.check_booking_party_change();

-- 0009's participant rules, with places given up: a participant joins only at
-- a place the party still has; one at a place given up is marked removed,
-- once, with its change row, and never changes again.
CREATE OR REPLACE FUNCTION app.check_booking_participant() RETURNS trigger
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
  IF TG_OP = 'UPDATE' AND OLD.removed_at IS NOT NULL THEN
    RAISE EXCEPTION 'participant % was removed; it no longer changes', OLD.id
      USING ERRCODE = '23514', CONSTRAINT = 'booking_participants_removed';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.removed_at IS NOT NULL THEN
    RAISE EXCEPTION 'a participant joins a party; it is removed only with a party change'
      USING ERRCODE = '23514', CONSTRAINT = 'booking_participants_removed';
  END IF;
  SELECT x.state, x.party_size, s.party_size AS sold_party_size INTO b
    FROM public.bookings x
    JOIN public.checkout_sessions s
      ON s.tenant_id = x.tenant_id AND s.id = x.checkout_session_id
   WHERE x.tenant_id = NEW.tenant_id AND x.id = NEW.booking_id
     FOR SHARE OF x;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no booking % for this tenant', NEW.booking_id
      USING ERRCODE = '23503', CONSTRAINT = 'booking_participants_booking';
  END IF;
  IF b.state <> 'confirmed' THEN
    RAISE EXCEPTION 'booking % is %; its party no longer changes', NEW.booking_id, b.state
      USING ERRCODE = '23514', CONSTRAINT = 'booking_participants_booking_open';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.removed_at IS NOT NULL THEN
    -- The removal itself: nothing else changes, and its change row names it.
    IF NEW.full_name IS DISTINCT FROM OLD.full_name
       OR NEW.is_minor IS DISTINCT FROM OLD.is_minor
       OR NEW.email IS DISTINCT FROM OLD.email
       OR NEW.guardian_name IS DISTINCT FROM OLD.guardian_name
       OR NEW.guardian_email IS DISTINCT FROM OLD.guardian_email
       OR NOT EXISTS (
         SELECT 1 FROM public.booking_party_changes c
          WHERE c.tenant_id = NEW.tenant_id AND c.booking_id = NEW.booking_id
            AND c.participant_id = NEW.id) THEN
      RAISE EXCEPTION 'participant % is removed only with its party change, as it stands', NEW.id
        USING ERRCODE = '23514', CONSTRAINT = 'booking_participants_removed';
    END IF;
    NEW.removed_at := now();
    NEW.updated_at := now();
    RETURN NEW;
  END IF;
  -- Places run 1 to the party size the booking was sold with (fixed on its
  -- checkout), less those given up; a change not yet applied in the same
  -- transaction never opens an extra place.
  IF NEW.position > b.sold_party_size THEN
    RAISE EXCEPTION 'booking % has % places; there is no place %',
      NEW.booking_id, b.party_size, NEW.position
      USING ERRCODE = '23514', CONSTRAINT = 'booking_participants_party_size';
  END IF;
  IF EXISTS (
       SELECT 1 FROM public.booking_party_changes c
        WHERE c.tenant_id = NEW.tenant_id AND c.booking_id = NEW.booking_id
          AND c.position = NEW.position) THEN
    RAISE EXCEPTION 'place % of booking % was given up', NEW.position, NEW.booking_id
      USING ERRCODE = '23514', CONSTRAINT = 'booking_participants_removed';
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := now();
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- 0007's rule that a confirmed booking keeps its seats, with one exception:
-- the hold a party change gives back. The change's own check at commit
-- (below) makes sure the booking holds its new, smaller hold by then.
CREATE OR REPLACE FUNCTION app.check_booked_hold() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF OLD.state = 'confirmed' AND NEW.state IS DISTINCT FROM 'confirmed'
     AND EXISTS (SELECT 1 FROM public.bookings b
                  WHERE b.tenant_id = OLD.tenant_id AND b.hold_id = OLD.id
                    AND b.state = 'confirmed')
     AND NOT EXISTS (SELECT 1 FROM public.booking_party_changes c
                      WHERE c.tenant_id = OLD.tenant_id AND c.from_hold_id = OLD.id) THEN
    RAISE EXCEPTION 'hold % backs a confirmed booking and keeps its seats', OLD.id
      USING ERRCODE = '23514', CONSTRAINT = 'capacity_holds_booked';
  END IF;
  RETURN NEW;
END;
$$;

-- 0034's lifecycle, with one more change: a confirmed booking's party size
-- and hold move together, down by one, with the party change row that names
-- the old hold and whose own confirmed hold is the new one. Its trip stays.
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
     OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.reacquired IS DISTINCT FROM OLD.reacquired
     OR NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a booking keeps its reference, checkout, order, payment, hold, trip, and party'
      USING ERRCODE = '23514', CONSTRAINT = 'bookings_immutable';
  END IF;
  IF NEW.party_size IS DISTINCT FROM OLD.party_size THEN
    IF OLD.state <> 'confirmed' OR NEW.state <> 'confirmed'
       OR NEW.trip_id IS DISTINCT FROM OLD.trip_id OR NOT EXISTS (
         SELECT 1 FROM public.booking_party_changes c
           JOIN public.capacity_holds h
             ON h.tenant_id = c.tenant_id AND h.owner_ref = 'booking_party_change:' || c.id::text
          WHERE c.tenant_id = NEW.tenant_id AND c.booking_id = NEW.id
            AND c.from_hold_id = OLD.hold_id AND c.from_party_size = OLD.party_size
            AND c.to_party_size = NEW.party_size AND c.trip_id = OLD.trip_id
            AND h.id = NEW.hold_id AND h.trip_id = NEW.trip_id
            AND h.party_size = NEW.party_size AND h.state = 'confirmed') THEN
      RAISE EXCEPTION 'a booking''s party and hold change only with its party change'
        USING ERRCODE = '23514', CONSTRAINT = 'bookings_immutable';
    END IF;
  ELSIF NEW.hold_id IS DISTINCT FROM OLD.hold_id OR NEW.trip_id IS DISTINCT FROM OLD.trip_id THEN
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

-- Checked at commit: the change gave its old hold back and its booking took
-- the change's own hold, and the participant at the place, if any, was marked
-- removed. The new hold may since have been given up by a later change or
-- move, or the booking canceled, in the same transaction.
CREATE FUNCTION app.check_party_change_applied() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.capacity_holds h
     WHERE h.tenant_id = NEW.tenant_id AND h.id = NEW.from_hold_id AND h.state <> 'released'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.capacity_holds h
      JOIN public.bookings b ON b.tenant_id = h.tenant_id AND b.id = NEW.booking_id
     WHERE h.tenant_id = NEW.tenant_id
       AND h.owner_ref = 'booking_party_change:' || NEW.id::text
       AND h.trip_id = NEW.trip_id AND h.party_size = NEW.to_party_size
       AND ((h.state = 'confirmed' AND b.hold_id = h.id)
            OR (b.state = 'canceled' AND b.hold_id = h.id)
            OR EXISTS (SELECT 1 FROM public.booking_party_changes c
                        WHERE c.tenant_id = h.tenant_id AND c.from_hold_id = h.id)
            OR EXISTS (SELECT 1 FROM public.booking_reschedules r
                        WHERE r.tenant_id = h.tenant_id AND r.from_hold_id = h.id))
  ) OR (NEW.participant_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.booking_participants q
     WHERE q.tenant_id = NEW.tenant_id AND q.id = NEW.participant_id
       AND q.removed_at IS NOT NULL
  )) THEN
    RAISE EXCEPTION 'party change % must leave its booking on its own hold, the old one released, and the participant removed',
      NEW.id
      USING ERRCODE = '23514', CONSTRAINT = 'booking_party_changes_applied';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER booking_party_changes_applied
  AFTER INSERT ON public.booking_party_changes
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.check_party_change_applied();

-- 0034's commit check for a move, which also accepts a move whose new hold
-- a later party change (or move) in the same transaction gave up, as the
-- party change's own check does.
CREATE OR REPLACE FUNCTION app.check_rescheduled_released() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.capacity_holds h
     WHERE h.tenant_id = NEW.tenant_id AND h.id = NEW.from_hold_id AND h.state <> 'released'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.bookings b
      JOIN public.capacity_holds h ON h.tenant_id = b.tenant_id AND h.id = NEW.to_hold_id
     WHERE b.tenant_id = NEW.tenant_id AND b.id = NEW.booking_id
       AND ((b.hold_id = NEW.to_hold_id AND b.trip_id = NEW.to_trip_id
             -- Still holding its new seats, unless it was canceled since.
             AND (h.state = 'confirmed' OR b.state = 'canceled'))
            OR EXISTS (SELECT 1 FROM public.booking_party_changes c
                        WHERE c.tenant_id = NEW.tenant_id AND c.from_hold_id = NEW.to_hold_id)
            OR EXISTS (SELECT 1 FROM public.booking_reschedules r
                        WHERE r.tenant_id = NEW.tenant_id AND r.from_hold_id = NEW.to_hold_id))
  ) THEN
    RAISE EXCEPTION 'move % must leave its booking on the new hold with the old one released',
      NEW.id
      USING ERRCODE = '23514', CONSTRAINT = 'booking_reschedules_applied';
  END IF;
  RETURN NULL;
END;
$$;

-- Row-level security, append-only guards, and privileges ---------------------------------

ALTER TABLE public.booking_party_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.booking_party_changes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.booking_party_changes
  USING (tenant_id = (SELECT app.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()));
CREATE TRIGGER booking_party_changes_no_delete BEFORE DELETE ON public.booking_party_changes
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();
CREATE TRIGGER booking_party_changes_no_truncate BEFORE TRUNCATE ON public.booking_party_changes
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_mutation();
CREATE TRIGGER booking_party_changes_append_only BEFORE UPDATE ON public.booking_party_changes
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();

GRANT UPDATE (party_size) ON public.bookings TO tidegrid_app;
GRANT UPDATE (removed_at) ON public.booking_participants TO tidegrid_app;

REVOKE ALL ON FUNCTION app.check_booking_party_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.check_party_change_applied() FROM PUBLIC;
