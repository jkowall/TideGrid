-- W3-G2.12-rest: an owner's capacity override with a reason.
--
-- A shared-seat trip sells at most its seat capacity (0006), which an
-- operator often sets below the boat's licensed guest capacity: crew, gear, or
-- comfort. When the trip is full and the owner decides one more party may
-- come, this lets that one booking go past the trip's capacity, and only:
--
-- 1. An active owner of the tenant writes the override, signed in as staff;
--    the database checks the membership, so no other role or actor can.
-- 2. It names one future hold (its owner reference on one trip), a number of
--    extra seats, and a reason code (a note is required for other). It is
--    written once and never changed or removed.
-- 3. The hold trigger lets that hold, and only that hold, count against the
--    trip's capacity plus those extra seats, and never past the boat's guest
--    capacity. Every other hold still counts against the trip's capacity, so
--    once the overridden hold lands the trip is full to everyone else: no race
--    goes beyond the override, under the trip lock as before.
-- 4. Never on a private charter, which already takes the whole boat.
--
-- It also lets a party change's smaller replacement hold in on a trip past
-- its capacity, since giving up a place never adds seats.
-- Everything else in 0006 is unchanged: this replaces app.check_capacity_hold
-- with the same function plus the allowance, and the trip-side floor still
-- refuses a capacity below the seats held.

CREATE TABLE public.capacity_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  trip_id uuid NOT NULL,
  owner_ref text NOT NULL
    CHECK (owner_ref ~ '^[a-z][a-z0-9_]{0,39}:[A-Za-z0-9_.:-]{1,200}$'),
  extra_seats integer NOT NULL CHECK (extra_seats BETWEEN 1 AND 500),
  reason_code text NOT NULL
    CHECK (reason_code IN ('regular_guest', 'group_kept_together', 'captain_approved',
                           'make_good', 'other')),
  note text CHECK (char_length(note) BETWEEN 1 AND 500 AND note !~ '[\x01-\x1f\x7f]'),
  created_at timestamptz NOT NULL DEFAULT now(),
  actor_type text NOT NULL DEFAULT coalesce(app.setting_or_null('app.actor_type'), 'system')
    CHECK (actor_type IN ('staff', 'guest', 'system', 'support')),
  actor_id text DEFAULT app.setting_or_null('app.actor_id'),
  request_id text DEFAULT app.setting_or_null('app.request_id'),
  UNIQUE (tenant_id, id),
  CONSTRAINT capacity_overrides_one_per_hold UNIQUE (tenant_id, trip_id, owner_ref),
  FOREIGN KEY (tenant_id, trip_id) REFERENCES public.scheduled_trips (tenant_id, id),
  -- The retention job (below) clears the note of an abandoned checkout's
  -- override with the checkout's booker, since a note can name a guest.
  note_redacted_at timestamptz,
  CHECK (reason_code <> 'other' OR note IS NOT NULL OR note_redacted_at IS NOT NULL),
  CHECK (note_redacted_at IS NULL OR note IS NULL)
);
CREATE INDEX capacity_overrides_recent_idx ON public.capacity_overrides (tenant_id, created_at);

-- Who and what: an active owner, signed in as staff, for a staff checkout
-- (the only place an override is taken), on a shared-seat trip
-- whose boat has room past the trip's capacity, before any hold of that
-- owner reference exists on the trip (the override comes first, in the same
-- transaction as the hold it is for).
CREATE FUNCTION app.check_capacity_override() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  trip record;
BEGIN
  NEW.created_at := now();
  NEW.actor_type := coalesce(app.setting_or_null('app.actor_type'), 'system');
  NEW.actor_id := app.setting_or_null('app.actor_id');
  NEW.request_id := app.setting_or_null('app.request_id');
  NEW.note_redacted_at := NULL;
  -- The trip's lock first, as the hold rules and a checkout take it, so an
  -- override, a hold, and a checkout under one reference are checked in turn,
  -- each seeing what the others committed. Only under READ COMMITTED, where each
  -- check after the lock reads afresh.
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'capacity overrides and checkouts are written only under READ COMMITTED, not %',
      pg_catalog.current_setting('transaction_isolation')
      USING ERRCODE = '25000';
  END IF;
  PERFORM 1 FROM public.scheduled_trips t
    WHERE t.tenant_id = NEW.tenant_id AND t.id = NEW.trip_id
      FOR NO KEY UPDATE;
  IF NEW.owner_ref NOT LIKE 'checkout\_session:%' THEN
    RAISE EXCEPTION 'a capacity override is for a staff checkout'
      USING ERRCODE = '23514', CONSTRAINT = 'capacity_overrides_trip';
  END IF;
  IF NEW.actor_type <> 'staff' OR NOT EXISTS (
       SELECT 1 FROM public.tenant_memberships m
        WHERE m.tenant_id = NEW.tenant_id AND m.user_id::text = NEW.actor_id
          AND m.role = 'owner' AND m.status = 'active') THEN
    RAISE EXCEPTION 'only an owner of this operator overrides a trip''s capacity'
      USING ERRCODE = '42501', CONSTRAINT = 'capacity_overrides_owner';
  END IF;
  SELECT t.seat_capacity, p.kind AS product_kind, b.guest_capacity AS boat_capacity
    INTO trip
    FROM public.scheduled_trips t
    JOIN public.products p ON p.tenant_id = t.tenant_id AND p.id = t.product_id
    JOIN public.boats b ON b.tenant_id = t.tenant_id AND b.id = t.boat_id
   WHERE t.tenant_id = NEW.tenant_id AND t.id = NEW.trip_id;
  IF NOT FOUND OR trip.product_kind <> 'shared_seat' THEN
    RAISE EXCEPTION 'a capacity override is for a shared-seat trip'
      USING ERRCODE = '23514', CONSTRAINT = 'capacity_overrides_trip';
  END IF;
  IF NEW.extra_seats > trip.boat_capacity - trip.seat_capacity THEN
    RAISE EXCEPTION 'trip % sells % of its boat''s % guests; % more would pass the boat',
      NEW.trip_id, trip.seat_capacity, trip.boat_capacity, NEW.extra_seats
      USING ERRCODE = '23514', CONSTRAINT = 'capacity_overrides_boat';
  END IF;
  -- A checkout already open under that reference must be a staff checkout.
  IF EXISTS (SELECT 1 FROM public.checkout_sessions s
              WHERE s.tenant_id = NEW.tenant_id
                AND NEW.owner_ref = 'checkout_session:' || s.id::text
                AND (s.source <> 'staff_assisted' OR s.trip_id <> NEW.trip_id)) THEN
    RAISE EXCEPTION 'a capacity override is for a staff checkout of this trip'
      USING ERRCODE = '23514', CONSTRAINT = 'capacity_overrides_trip';
  END IF;
  IF EXISTS (SELECT 1 FROM public.capacity_holds h
              WHERE h.tenant_id = NEW.tenant_id AND h.trip_id = NEW.trip_id
                AND h.owner_ref = NEW.owner_ref) THEN
    RAISE EXCEPTION 'an override comes before the hold it is for'
      USING ERRCODE = '23514', CONSTRAINT = 'capacity_overrides_trip';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER capacity_overrides_rules BEFORE INSERT ON public.capacity_overrides
  FOR EACH ROW EXECUTE FUNCTION app.check_capacity_override();

ALTER TABLE public.capacity_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.capacity_overrides FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.capacity_overrides
  USING (tenant_id = (SELECT app.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()));
CREATE TRIGGER capacity_overrides_no_delete BEFORE DELETE ON public.capacity_overrides
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();
CREATE TRIGGER capacity_overrides_no_truncate BEFORE TRUNCATE ON public.capacity_overrides
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_mutation();
-- And the other way round: a checkout opened under a reference an override
-- names is a staff checkout of that override's trip, whatever order the two
-- rows are written in, so no guest or direct checkout uses an override.
CREATE FUNCTION app.check_checkout_capacity_override() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  -- The trip's lock first, as an override takes it (see above).
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'capacity overrides and checkouts are written only under READ COMMITTED, not %',
      pg_catalog.current_setting('transaction_isolation')
      USING ERRCODE = '25000';
  END IF;
  PERFORM 1 FROM public.scheduled_trips t
    WHERE t.tenant_id = NEW.tenant_id AND t.id = NEW.trip_id
      FOR NO KEY UPDATE;
  IF EXISTS (SELECT 1 FROM public.capacity_overrides o
              WHERE o.tenant_id = NEW.tenant_id
                AND o.owner_ref = 'checkout_session:' || NEW.id::text
                AND (NEW.source <> 'staff_assisted' OR o.trip_id <> NEW.trip_id)) THEN
    RAISE EXCEPTION 'checkout % names a capacity override; only a staff checkout of its trip may', NEW.id
      USING ERRCODE = '23514', CONSTRAINT = 'capacity_overrides_trip';
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER checkout_sessions_capacity_override AFTER INSERT ON public.checkout_sessions
  FOR EACH ROW EXECUTE FUNCTION app.check_checkout_capacity_override();

-- Append-only, except one update shape: the retention job clearing a note
-- and stamping when (once, permanently). Any other change is refused.
CREATE FUNCTION app.check_capacity_override_update() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF OLD.note_redacted_at IS NULL AND NEW.note_redacted_at IS NOT NULL AND NEW.note IS NULL
     AND (to_jsonb(NEW) - ARRAY['note', 'note_redacted_at'])
         = (to_jsonb(OLD) - ARRAY['note', 'note_redacted_at']) THEN
    NEW.note_redacted_at := now();
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'capacity_overrides is append-only' USING ERRCODE = '42501';
END;
$$;
CREATE TRIGGER capacity_overrides_append_only BEFORE UPDATE ON public.capacity_overrides
  FOR EACH ROW EXECUTE FUNCTION app.check_capacity_override_update();

-- The hold rules, with the allowance. Identical to 0006 otherwise.
CREATE OR REPLACE FUNCTION app.check_capacity_hold() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  trip record;
  taken integer;
  derived_kind text;
  derived_seats integer;
  allowance integer := 0;
  shrinks boolean := false;
  lock_trip boolean := false;
  check_sales boolean := false;
  check_capacity boolean := false;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION 'a capacity hold starts active, not %', NEW.state
        USING ERRCODE = '23514', CONSTRAINT = 'capacity_holds_transition';
    END IF;
    NEW.created_at := now();
    NEW.updated_at := now();
    NEW.confirmed_at := NULL;
    NEW.released_at := NULL;
    NEW.expired_at := NULL;
    lock_trip := true;
    check_sales := true;
    check_capacity := true;
  ELSE
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.trip_id IS DISTINCT FROM OLD.trip_id
       OR NEW.owner_ref IS DISTINCT FROM OLD.owner_ref
       OR NEW.kind IS DISTINCT FROM OLD.kind
       OR NEW.party_size IS DISTINCT FROM OLD.party_size
       OR NEW.seats IS DISTINCT FROM OLD.seats
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'a capacity hold keeps its trip, owner, kind, size, and creation time'
        USING ERRCODE = '23514', CONSTRAINT = 'capacity_holds_immutable';
    END IF;
    -- The expiry instant moves earlier, never later, so the bounds checked at
    -- insert hold for the life of the hold: within an hour of acquisition and
    -- no later than the departure. No service moves it; tests make time pass
    -- by moving it earlier through the owner role.
    IF NEW.expires_at > OLD.expires_at THEN
      RAISE EXCEPTION 'hold % expires at %; its expiry can move earlier, never later',
        OLD.id, OLD.expires_at
        USING ERRCODE = '23514', CONSTRAINT = 'capacity_holds_expiry';
    END IF;
    -- Timestamps move only with a transition, and only here.
    NEW.confirmed_at := OLD.confirmed_at;
    NEW.released_at := OLD.released_at;
    NEW.expired_at := OLD.expired_at;
    NEW.updated_at := now();
    IF NEW.state = OLD.state THEN
      RETURN NEW;
    END IF;
    IF OLD.state = 'active' AND NEW.state = 'confirmed' THEN
      -- A hold past its expiry instant is confirmed only by reacquiring it:
      -- mark it expired, then move it from expired to confirmed.
      IF OLD.expires_at <= now() THEN
        RAISE EXCEPTION 'hold % expired at %; reacquire it instead', OLD.id, OLD.expires_at
          USING ERRCODE = '23514', CONSTRAINT = 'capacity_holds_expiry';
      END IF;
      NEW.confirmed_at := now();
      lock_trip := true;
    ELSIF OLD.state = 'active' AND NEW.state = 'released' THEN
      NEW.released_at := now();
    ELSIF OLD.state = 'active' AND NEW.state = 'expired' THEN
      IF OLD.expires_at > now() THEN
        RAISE EXCEPTION 'hold % does not expire until %', OLD.id, OLD.expires_at
          USING ERRCODE = '23514', CONSTRAINT = 'capacity_holds_expiry';
      END IF;
      NEW.expired_at := now();
    ELSIF OLD.state = 'expired' AND NEW.state = 'confirmed' THEN
      NEW.confirmed_at := now();
      lock_trip := true;
      check_sales := true;
      check_capacity := true;
    ELSIF OLD.state = 'confirmed' AND NEW.state = 'released' THEN
      NEW.released_at := now();
    ELSE
      RAISE EXCEPTION 'a capacity hold cannot move from % to %', OLD.state, NEW.state
        USING ERRCODE = '23514', CONSTRAINT = 'capacity_holds_transition';
    END IF;
  END IF;

  IF NOT lock_trip THEN
    RETURN NEW;
  END IF;

  IF check_capacity AND pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'capacity holds change only under READ COMMITTED, not %',
      pg_catalog.current_setting('transaction_isolation')
      USING ERRCODE = '25000';
  END IF;

  -- Writers to one trip queue here. The lock also orders holds against the
  -- trip's own sales-state changes. FOR NO KEY UPDATE needs UPDATE on some
  -- column of the trip, which 0003 grants the runtime; keep that grant.
  SELECT t.sales_state, t.starts_at, t.seat_capacity,
         p.kind AS product_kind, p.sales_status AS product_status,
         p.min_party_size, p.max_party_size, p.booking_cutoff_minutes,
         b.guest_capacity AS boat_capacity
    INTO trip
    FROM public.scheduled_trips t
    JOIN public.products p ON p.tenant_id = t.tenant_id AND p.id = t.product_id
    JOIN public.boats b ON b.tenant_id = t.tenant_id AND b.id = t.boat_id
   WHERE t.tenant_id = NEW.tenant_id AND t.id = NEW.trip_id
     FOR NO KEY UPDATE OF t;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no trip % for this tenant', NEW.trip_id
      USING ERRCODE = '23503', CONSTRAINT = 'capacity_holds_trip';
  END IF;

  -- No transition into a counted state on a canceled trip, including the
  -- confirmation of a hold taken before the trip was canceled.
  IF trip.sales_state = 'canceled' THEN
    RAISE EXCEPTION 'trip % is canceled', NEW.trip_id
      USING ERRCODE = '23514', CONSTRAINT = 'capacity_holds_eligibility';
  END IF;

  -- A new hold, or a reacquired one, needs the trip on sale now: published
  -- trip and product, before the booking cutoff, and a party the product and
  -- the trip allow. The service also checks the location, the boat, and
  -- blackouts, as availability does.
  IF check_sales THEN
    IF trip.sales_state <> 'published' OR trip.product_status <> 'published' THEN
      RAISE EXCEPTION 'trip % is not on sale', NEW.trip_id
        USING ERRCODE = '23514', CONSTRAINT = 'capacity_holds_eligibility';
    END IF;
    IF now() >= trip.starts_at - make_interval(mins => trip.booking_cutoff_minutes) THEN
      RAISE EXCEPTION 'sales for trip % closed at its booking cutoff', NEW.trip_id
        USING ERRCODE = '23514', CONSTRAINT = 'capacity_holds_eligibility';
    END IF;
    IF NEW.party_size < trip.min_party_size OR NEW.party_size > trip.max_party_size
       OR NEW.party_size > trip.seat_capacity THEN
      RAISE EXCEPTION 'a party of % is outside this trip''s limits', NEW.party_size
        USING ERRCODE = '23514', CONSTRAINT = 'capacity_holds_eligibility';
    END IF;
  END IF;

  -- The kind and the seats come from the trip: the party size on a shared-seat
  -- trip, every seat on a charter. A new hold takes them here. A reacquired
  -- hold must still match them, because the owner role can resize a charter,
  -- or change a trip's product or that product's kind, while the hold is
  -- expired and uncounted. Its seats are fixed, so a hold that no longer
  -- matches is refused, never resized.
  IF check_capacity THEN
    derived_kind := CASE trip.product_kind WHEN 'shared_seat' THEN 'seats' ELSE 'whole_boat' END;
    derived_seats := CASE derived_kind WHEN 'seats' THEN NEW.party_size ELSE trip.seat_capacity END;
    IF (NEW.kind IS NOT NULL AND NEW.kind <> derived_kind)
       OR (NEW.seats IS NOT NULL AND NEW.seats <> derived_seats) THEN
      RAISE EXCEPTION 'a % hold of % seats on this trip must be a % hold of % seats',
        NEW.kind, NEW.seats, derived_kind, derived_seats
        USING ERRCODE = '23514', CONSTRAINT = 'capacity_holds_kind';
    END IF;
    NEW.kind := derived_kind;
    NEW.seats := derived_seats;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.expires_at <= now()
       OR NEW.expires_at > now() + interval '1 hour'
       OR NEW.expires_at > trip.starts_at THEN
      RAISE EXCEPTION 'a hold expires within an hour, after now and no later than departure'
        USING ERRCODE = '23514', CONSTRAINT = 'capacity_holds_expiry';
    END IF;
  END IF;

  IF check_capacity THEN
    -- An owner's override for this hold (0038): seats past the trip's
    -- capacity this one hold may take, never past the boat's guest capacity.
    -- Only on a shared-seat trip; a charter already takes the whole boat.
    IF NEW.kind = 'seats' THEN
      SELECT o.extra_seats INTO allowance
        FROM public.capacity_overrides o
       WHERE o.tenant_id = NEW.tenant_id AND o.trip_id = NEW.trip_id
         AND o.owner_ref = NEW.owner_ref;
      allowance := least(coalesce(allowance, 0),
                         greatest(0, trip.boat_capacity - trip.seat_capacity));
    END IF;
    -- A party change's new hold, taken in place of its booking's larger one
    -- that it released, never adds seats: on a trip already past its
    -- capacity by an override, a guest can still give up a place. Only on
    -- insert, once per change (a hold's owner reference is unique on its
    -- trip), for fewer seats than the released hold took, and only up to what
    -- the trip's overrides allowed in all, never past the boat.
    IF TG_OP = 'INSERT' AND NEW.kind = 'seats'
       AND NEW.owner_ref LIKE 'booking\_party\_change:%' THEN
      SELECT true INTO shrinks
        FROM public.booking_party_changes c
        JOIN public.capacity_holds f ON f.tenant_id = c.tenant_id AND f.id = c.from_hold_id
       WHERE c.tenant_id = NEW.tenant_id AND c.trip_id = NEW.trip_id
         AND NEW.owner_ref = 'booking_party_change:' || c.id::text
         AND f.state = 'released' AND f.seats > NEW.seats;
    END IF;
    SELECT coalesce(sum(h.seats), 0)::integer INTO taken
      FROM public.capacity_holds h
     WHERE h.tenant_id = NEW.tenant_id
       AND h.trip_id = NEW.trip_id
       AND h.state IN ('active', 'confirmed')
       AND h.id <> NEW.id;
    IF coalesce(shrinks, false) THEN
      SELECT greatest(allowance, least(coalesce(sum(o.extra_seats), 0),
                                       greatest(0, trip.boat_capacity - trip.seat_capacity)))::integer
        INTO allowance
        FROM public.capacity_overrides o
       WHERE o.tenant_id = NEW.tenant_id AND o.trip_id = NEW.trip_id;
    END IF;
    IF taken + NEW.seats > trip.seat_capacity + allowance THEN
      RAISE EXCEPTION 'trip % has % of % seats taken (% more allowed by an override); % more do not fit',
        NEW.trip_id, taken, trip.seat_capacity, allowance, NEW.seats
        USING ERRCODE = '23514', CONSTRAINT = 'capacity_holds_capacity';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app.check_capacity_override() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.check_capacity_hold() FROM PUBLIC;

-- The 0026 retention job, unchanged but for one more step: an abandoned
-- checkout's override loses its note with the checkout's booker (W3-G2.12).
CREATE OR REPLACE FUNCTION app.retention_redact_abandoned_checkouts(p_days integer, p_limit integer)
  RETURNS TABLE (tenant_id uuid, redacted integer)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
#variable_conflict use_column
BEGIN
  IF p_days IS NULL OR p_days < 30 OR p_days > 3650 THEN
    RAISE EXCEPTION 'retention is 30 to 3650 days' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    WITH due AS (
      SELECT s.tenant_id, s.id
        FROM public.checkout_sessions s
       WHERE s.booker_redacted_at IS NULL
         AND s.state IN ('expired', 'failed', 'canceled')
         AND coalesce(s.expired_at, s.failed_at, s.canceled_at)
               <= pg_catalog.now() - pg_catalog.make_interval(days => p_days)
         AND NOT EXISTS (SELECT 1 FROM public.bookings b
                          WHERE b.tenant_id = s.tenant_id AND b.checkout_session_id = s.id)
         AND NOT EXISTS (SELECT 1 FROM public.payments p
                          WHERE p.tenant_id = s.tenant_id AND p.checkout_session_id = s.id
                            AND p.state = 'succeeded')
         AND NOT EXISTS (SELECT 1 FROM public.provider_events e
                          JOIN public.payments p
                            ON p.tenant_id = e.tenant_id AND p.provider_payment_id = e.payment_ref
                          WHERE e.tenant_id = s.tenant_id AND e.processing_state = 'received'
                            AND p.checkout_session_id = s.id)
       ORDER BY s.tenant_id, s.id
       LIMIT greatest(1, least(coalesce(p_limit, 500), 5000))
       FOR UPDATE OF s SKIP LOCKED
    ), done AS (
      UPDATE public.checkout_sessions s
         SET booker_name = 'Redacted',
             booker_email = 'redacted@redacted.invalid',
             booker_redacted_at = pg_catalog.now()
        FROM due
       WHERE s.tenant_id = due.tenant_id AND s.id = due.id
      RETURNING s.tenant_id, s.id
    ), notes AS (
      UPDATE public.capacity_overrides o
         SET note = NULL,
             note_redacted_at = pg_catalog.now()
        FROM done d
       WHERE o.tenant_id = d.tenant_id
         AND o.owner_ref = 'checkout_session:' || d.id::text
         AND o.note IS NOT NULL
      RETURNING 1
    ), counts AS (
      SELECT d.tenant_id, count(*)::integer AS n FROM done d GROUP BY d.tenant_id
    ), audited AS (
      INSERT INTO public.audit_events
          (tenant_id, actor_type, actor_id, action, subject_type, subject_id, after_state)
        SELECT c.tenant_id, 'system', 'retention', 'retention.checkout_bookers_redacted',
               'tenant', c.tenant_id::text,
               pg_catalog.jsonb_build_object('count', c.n, 'olderThanDays', p_days)
          FROM counts c
      RETURNING 1
    )
    -- A data-modifying WITH runs once whether or not it is read.
    SELECT c.tenant_id, c.n FROM counts c ORDER BY c.tenant_id;
END;
$$;

REVOKE ALL ON FUNCTION app.check_capacity_override_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.check_checkout_capacity_override() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.retention_redact_abandoned_checkouts(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.retention_redact_abandoned_checkouts(integer, integer) TO tidegrid_app;
