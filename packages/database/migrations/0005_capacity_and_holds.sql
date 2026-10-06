-- Capacity and holds (G2.6)
--
-- A capacity hold reserves trip capacity for one owner, named by an opaque
-- reference such as a checkout session. On a shared-seat trip a hold takes
-- seats equal to its party size. On a private charter it takes the whole boat:
-- every seat on the trip, so one live hold leaves nothing for anyone else.
--
-- States move one way:
--
--   active -> confirmed | released | expired
--   expired -> confirmed   (reacquisition after a late payment; capacity and
--                           sales rules are checked again, as for a new hold)
--   confirmed -> released  (a confirmed booking gives its capacity back)
--
-- Released is final. Nothing returns to active.
--
-- The invariant. For every trip, the seats of its holds in state active or
-- confirmed never exceed the trip's seat capacity. It is a rule over stored
-- states, not over time. A hold whose expiry instant has passed still counts
-- until something marks it expired; the inventory service does that, under
-- the trip's lock, before it counts, so an expired hold never blocks a new one
-- and correctness never depends on the sweep. Because the decision that a hold
-- has expired is written down before anyone relies on it, two transactions can
-- never disagree about it, whatever their clocks read.
--
-- Enforcement. The trigger below checks every insert and every transition
-- into a counted state for every role, the owner included. It takes the
-- trip's row lock first (FOR NO KEY UPDATE), so writers to one trip queue, and
-- then counts with a fresh snapshot: a VOLATILE trigger function in READ
-- COMMITTED sees rows committed while it waited. Under REPEATABLE READ the
-- count would use a stale snapshot, so the trigger refuses any isolation level
-- but READ COMMITTED. A partial unique index backs up the whole-boat rule
-- without any trigger. A second trigger guards the trip side: no role can
-- shrink a trip below the seats its holds take, change the product its holds
-- came from, or resize a charter a whole-boat hold has taken.
--
-- Clock. The database clock decides expiry: now(), the transaction's start,
-- read once per transaction, so every statement in a command agrees with the
-- trigger. Worker isolates never compare their own clocks.
--
-- Tenancy follows packages/database/README.md: tenant_id with forced
-- row-level security and a tenant_isolation policy, a composite foreign key to
-- the trip, SELECT and INSERT from the default privileges, UPDATE on state
-- only, and no DELETE or TRUNCATE for any role. The trigger sets every
-- timestamp, so the runtime needs no other column.

-- The sweep helper below is a SECURITY DEFINER function that reads a table
-- with forced row-level security; its owner must bypass row-level security,
-- as in the brand and tenancy migrations.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'the capacity and holds migration must run as a role that bypasses row-level security';
  END IF;
END
$$;

-- Holds ---------------------------------------------------------------------------

CREATE TABLE public.capacity_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  trip_id uuid NOT NULL,
  -- Opaque to this module: "<owner type>:<id>", for example
  -- "checkout_session:<uuid>". One hold per owner and trip, ever.
  owner_ref text NOT NULL
    CHECK (owner_ref ~ '^[a-z][a-z0-9_]{0,39}:[A-Za-z0-9_.:-]{1,200}$'),
  -- Set by the trigger from the trip's product: seats on a shared-seat trip,
  -- whole_boat on a private charter.
  kind text NOT NULL CHECK (kind IN ('seats', 'whole_boat')),
  -- Guests the hold is for.
  party_size integer NOT NULL CHECK (party_size BETWEEN 1 AND 500),
  -- Capacity the hold takes, set by the trigger: the party size for seats,
  -- every seat on the trip for a whole boat.
  seats integer NOT NULL CHECK (seats BETWEEN 1 AND 500),
  state text NOT NULL DEFAULT 'active'
    CHECK (state IN ('active', 'confirmed', 'released', 'expired')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz,
  released_at timestamptz,
  expired_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CONSTRAINT capacity_holds_owner_trip_key UNIQUE (tenant_id, owner_ref, trip_id),
  FOREIGN KEY (tenant_id, trip_id) REFERENCES public.scheduled_trips (tenant_id, id),
  CHECK (kind = 'whole_boat' OR seats = party_size),
  CHECK (seats >= party_size),
  CHECK (state <> 'active' OR (confirmed_at IS NULL AND released_at IS NULL AND expired_at IS NULL)),
  CHECK (state <> 'confirmed' OR confirmed_at IS NOT NULL),
  CHECK (state <> 'released' OR released_at IS NOT NULL),
  CHECK (state <> 'expired' OR expired_at IS NOT NULL)
);

-- Counted holds per trip: the capacity check and the availability reads.
CREATE INDEX capacity_holds_live_idx ON public.capacity_holds (tenant_id, trip_id)
  INCLUDE (state, seats, expires_at)
  WHERE state IN ('active', 'confirmed');
-- Every hold of a trip, for staff reads.
CREATE INDEX capacity_holds_trip_idx ON public.capacity_holds (tenant_id, trip_id, created_at);
-- Due holds per tenant (the per-tenant sweep) and across tenants (the sweep's
-- tenant list).
CREATE INDEX capacity_holds_due_idx ON public.capacity_holds (tenant_id, expires_at)
  WHERE state = 'active';
CREATE INDEX capacity_holds_due_any_tenant_idx ON public.capacity_holds (expires_at)
  INCLUDE (tenant_id)
  WHERE state = 'active';
-- The whole-boat rule without any trigger: at most one counted whole-boat hold
-- per trip. The trigger normally refuses the second hold first, on capacity.
CREATE UNIQUE INDEX capacity_holds_one_whole_boat ON public.capacity_holds (tenant_id, trip_id)
  WHERE kind = 'whole_boat' AND state IN ('active', 'confirmed');

ALTER TABLE public.capacity_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.capacity_holds FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.capacity_holds
  USING (tenant_id = (SELECT app.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()));

-- Rules ---------------------------------------------------------------------------

-- Runs for every role, so the owner and any future writer obey the same rules
-- as the inventory service. Raised errors carry a constraint name so callers
-- and tests can tell them apart: capacity_holds_capacity, _eligibility,
-- _transition, _expiry, _immutable, _kind, and _trip.
CREATE FUNCTION app.check_capacity_hold() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  trip record;
  taken integer;
  derived_kind text;
  derived_seats integer;
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
         p.min_party_size, p.max_party_size, p.booking_cutoff_minutes
    INTO trip
    FROM public.scheduled_trips t
    JOIN public.products p ON p.tenant_id = t.tenant_id AND p.id = t.product_id
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

  IF TG_OP = 'INSERT' THEN
    derived_kind := CASE trip.product_kind WHEN 'shared_seat' THEN 'seats' ELSE 'whole_boat' END;
    derived_seats := CASE derived_kind WHEN 'seats' THEN NEW.party_size ELSE trip.seat_capacity END;
    IF (NEW.kind IS NOT NULL AND NEW.kind <> derived_kind)
       OR (NEW.seats IS NOT NULL AND NEW.seats <> derived_seats) THEN
      RAISE EXCEPTION 'a % hold on this trip is a % hold of % seats',
        NEW.kind, derived_kind, derived_seats
        USING ERRCODE = '23514', CONSTRAINT = 'capacity_holds_kind';
    END IF;
    NEW.kind := derived_kind;
    NEW.seats := derived_seats;
    IF NEW.expires_at <= now()
       OR NEW.expires_at > now() + interval '1 hour'
       OR NEW.expires_at > trip.starts_at THEN
      RAISE EXCEPTION 'a hold expires within an hour, after now and no later than departure'
        USING ERRCODE = '23514', CONSTRAINT = 'capacity_holds_expiry';
    END IF;
  END IF;

  IF check_capacity THEN
    SELECT coalesce(sum(h.seats), 0)::integer INTO taken
      FROM public.capacity_holds h
     WHERE h.tenant_id = NEW.tenant_id
       AND h.trip_id = NEW.trip_id
       AND h.state IN ('active', 'confirmed')
       AND h.id <> NEW.id;
    IF taken + NEW.seats > trip.seat_capacity THEN
      RAISE EXCEPTION 'trip % has % of % seats taken; % more do not fit',
        NEW.trip_id, taken, trip.seat_capacity, NEW.seats
        USING ERRCODE = '23514', CONSTRAINT = 'capacity_holds_capacity';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
CREATE TRIGGER capacity_holds_rules
  BEFORE INSERT OR UPDATE ON public.capacity_holds
  FOR EACH ROW EXECUTE FUNCTION app.check_capacity_hold();

-- The trip side of the invariant. The runtime cannot change a trip's capacity
-- or product at all (0003 grants it neither column). This stops the owner role,
-- or a later migration, from shrinking a trip below the seats its holds take,
-- from changing the product its holds' kind came from, and from resizing a
-- charter that a whole-boat hold has taken. The update has already locked the
-- trip's row when this runs, so no hold can arrive in between, and the count
-- sees every committed hold. Holds count by stored state, as everywhere.
CREATE FUNCTION app.check_trip_capacity_floor() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  taken integer;
  has_whole_boat boolean;
BEGIN
  IF NEW.seat_capacity IS NOT DISTINCT FROM OLD.seat_capacity
     AND NEW.product_id IS NOT DISTINCT FROM OLD.product_id THEN
    RETURN NEW;
  END IF;
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'a trip''s capacity or product changes only under READ COMMITTED, not %',
      pg_catalog.current_setting('transaction_isolation')
      USING ERRCODE = '25000';
  END IF;
  SELECT coalesce(sum(h.seats), 0)::integer, coalesce(bool_or(h.kind = 'whole_boat'), false)
    INTO taken, has_whole_boat
    FROM public.capacity_holds h
   WHERE h.tenant_id = OLD.tenant_id
     AND h.trip_id = OLD.id
     AND h.state IN ('active', 'confirmed');
  IF taken > 0 AND (NEW.product_id IS DISTINCT FROM OLD.product_id OR has_whole_boat) THEN
    RAISE EXCEPTION 'trip % has holds; neither its product nor a held charter''s size can change',
      OLD.id
      USING ERRCODE = '23514', CONSTRAINT = 'capacity_holds_trip_floor';
  END IF;
  IF NEW.seat_capacity < taken THEN
    RAISE EXCEPTION 'trip % has % seats held or confirmed, more than a capacity of %',
      OLD.id, taken, NEW.seat_capacity
      USING ERRCODE = '23514', CONSTRAINT = 'capacity_holds_trip_floor';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER scheduled_trips_capacity_floor
  BEFORE UPDATE OF seat_capacity, product_id ON public.scheduled_trips
  FOR EACH ROW EXECUTE FUNCTION app.check_trip_capacity_floor();

-- Holds are released or expire; they are never deleted, by any role.
CREATE FUNCTION app.reject_capacity_hold_removal() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  RAISE EXCEPTION 'capacity holds are never deleted; release them instead' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER capacity_holds_no_delete
  BEFORE DELETE ON public.capacity_holds
  FOR EACH ROW EXECUTE FUNCTION app.reject_capacity_hold_removal();
CREATE TRIGGER capacity_holds_no_truncate
  BEFORE TRUNCATE ON public.capacity_holds
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_capacity_hold_removal();

-- Reads ---------------------------------------------------------------------------

-- Seats taken on one trip right now: held by holds that have not reached their
-- expiry instant, and confirmed. Availability and the inventory service both
-- read it, so the rule lives in one place. It runs as the caller, under the
-- caller's row-level security, and filters by tenant explicitly as well.
CREATE FUNCTION app.trip_capacity_usage(p_tenant_id uuid, p_trip_id uuid)
  RETURNS TABLE (held integer, confirmed integer)
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT coalesce(sum(h.seats) FILTER (WHERE h.state = 'active'), 0)::integer,
           coalesce(sum(h.seats) FILTER (WHERE h.state = 'confirmed'), 0)::integer
      FROM public.capacity_holds h
     WHERE h.tenant_id = p_tenant_id
       AND h.trip_id = p_trip_id
       AND h.state IN ('active', 'confirmed')
       AND (h.state = 'confirmed' OR h.expires_at > pg_catalog.now())
  $$;

-- The sweep's tenant list: tenants with at least one hold past its expiry
-- instant and not yet marked expired. It returns tenant ids only, and the
-- sweep expires each tenant's holds inside that tenant's own transaction. This
-- is the one cross-tenant read the runtime has outside sign-in and hostname
-- resolution; the security argument is in packages/database/README.md.
CREATE FUNCTION app.capacity_hold_sweep_tenants(p_limit integer)
  RETURNS TABLE (tenant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT DISTINCT h.tenant_id
      FROM public.capacity_holds h
     WHERE h.state = 'active'
       AND h.expires_at <= pg_catalog.now()
     ORDER BY h.tenant_id
     LIMIT greatest(1, least(coalesce(p_limit, 100), 1000))
  $$;

-- Privileges ----------------------------------------------------------------------

-- SELECT and INSERT come from the default privileges in 0001. State is the
-- only column the runtime may update; the trigger sets the timestamps.
GRANT UPDATE (state) ON public.capacity_holds TO tidegrid_app;

REVOKE ALL ON FUNCTION app.check_capacity_hold() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.check_trip_capacity_floor() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.reject_capacity_hold_removal() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.trip_capacity_usage(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.capacity_hold_sweep_tenants(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.trip_capacity_usage(uuid, uuid) TO tidegrid_app;
GRANT EXECUTE ON FUNCTION app.capacity_hold_sweep_tenants(integer) TO tidegrid_app;
