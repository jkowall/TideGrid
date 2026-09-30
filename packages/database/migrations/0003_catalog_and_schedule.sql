-- 0003 catalog and schedule
-- Locations, boats, sellable products, the boats each product may use,
-- seasonal schedules, scheduled trips, and blackouts. Every table follows the
-- tenancy contract in packages/database/README.md: tenant_id with forced
-- row-level security and a tenant_isolation policy, SELECT and INSERT for the
-- runtime by default, UPDATE only on the columns a command changes, and no
-- DELETE. References between catalog rows carry tenant_id, so a row cannot
-- point at another tenant's row even through an application bug.
--
-- Time follows ADR 0016. A scheduled trip stores its IANA zone, local date and
-- start time, resolved UTC start and end, and both offsets. The application
-- resolves local times and rejects gaps and unchosen overlaps; the database
-- refuses any row whose local and UTC values disagree under its own zone data.

-- Zone names ------------------------------------------------------------------

-- IANA Area/Location names and UTC only. POSIX forms such as 'UTC+3' invert
-- their sign and abbreviations are ambiguous, so neither is accepted.
CREATE DOMAIN app.iana_zone AS text
  CHECK (VALUE ~ '^(UTC|[A-Z][A-Za-z_]+(/[A-Za-z0-9_+-]+)+)$');

-- Trigger functions run with the privileges of the role that fired them and
-- call only pg_catalog functions, so the runtime needs no EXECUTE grant.
CREATE FUNCTION app.check_time_zone() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  -- Raises 22023 for a zone this server does not know.
  PERFORM pg_catalog.timezone(NEW.time_zone, pg_catalog.now());
  RETURN NEW;
END;
$$;

-- Locations -------------------------------------------------------------------

CREATE TABLE public.locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  time_zone app.iana_zone NOT NULL,
  meeting_point text NOT NULL DEFAULT '' CHECK (char_length(meeting_point) <= 200),
  meeting_instructions text NOT NULL DEFAULT ''
    CHECK (char_length(meeting_instructions) <= 2000),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE TRIGGER locations_time_zone BEFORE INSERT OR UPDATE OF time_zone ON public.locations
  FOR EACH ROW EXECUTE FUNCTION app.check_time_zone();

-- Boats -----------------------------------------------------------------------

CREATE TABLE public.boats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  guest_capacity integer NOT NULL CHECK (guest_capacity BETWEEN 1 AND 500),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

-- Products --------------------------------------------------------------------

-- A sellable trip. Shared-seat products sell seats; private charters sell the
-- whole boat. seat_limit caps seats per trip below the boat's capacity and is
-- meaningful only for shared seats. Prices, fees, taxes, and policies arrive
-- with G2.5, and the publish check grows with them.
CREATE TABLE public.products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  location_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('shared_seat', 'private_charter')),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  summary text NOT NULL DEFAULT '' CHECK (char_length(summary) <= 500),
  duration_minutes integer NOT NULL CHECK (duration_minutes BETWEEN 15 AND 1440),
  booking_cutoff_minutes integer NOT NULL DEFAULT 0
    CHECK (booking_cutoff_minutes BETWEEN 0 AND 10080),
  turnaround_buffer_minutes integer NOT NULL DEFAULT 0
    CHECK (turnaround_buffer_minutes BETWEEN 0 AND 720),
  min_party_size integer NOT NULL DEFAULT 1 CHECK (min_party_size BETWEEN 1 AND 500),
  max_party_size integer NOT NULL CHECK (max_party_size BETWEEN 1 AND 500),
  seat_limit integer CHECK (seat_limit BETWEEN 1 AND 500),
  sales_status text NOT NULL DEFAULT 'draft'
    CHECK (sales_status IN ('draft', 'published', 'archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES public.locations (tenant_id, id),
  CHECK (min_party_size <= max_party_size),
  CHECK (kind = 'shared_seat' OR seat_limit IS NULL)
);

CREATE TABLE public.product_boats (
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  product_id uuid NOT NULL,
  boat_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, product_id, boat_id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES public.products (tenant_id, id),
  FOREIGN KEY (tenant_id, boat_id) REFERENCES public.boats (tenant_id, id)
);
CREATE INDEX product_boats_boat_idx ON public.product_boats (tenant_id, boat_id);

-- Schedules -------------------------------------------------------------------

-- A seasonal pattern: listed weekdays between two dates at one or more local
-- departure times. The zone is the product location's, captured when the
-- schedule is created. Generation turns it into scheduled trips.
CREATE TABLE public.schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  product_id uuid NOT NULL,
  boat_id uuid NOT NULL,
  time_zone app.iana_zone NOT NULL,
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  weekdays smallint[] NOT NULL
    CHECK (cardinality(weekdays) BETWEEN 1 AND 7
           AND weekdays <@ ARRAY[1, 2, 3, 4, 5, 6, 7]::smallint[]),
  start_times time(0)[] NOT NULL CHECK (cardinality(start_times) BETWEEN 1 AND 24),
  ambiguous_time text NOT NULL DEFAULT 'reject'
    CHECK (ambiguous_time IN ('earlier', 'later', 'reject')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'ended')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, product_id, boat_id)
    REFERENCES public.product_boats (tenant_id, product_id, boat_id),
  CHECK (ends_on >= starts_on)
);

CREATE FUNCTION app.check_schedule() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  location_zone text;
BEGIN
  SELECT l.time_zone INTO location_zone
    FROM public.products p
    JOIN public.locations l ON l.tenant_id = p.tenant_id AND l.id = p.location_id
   WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.product_id;
  IF location_zone IS DISTINCT FROM NEW.time_zone THEN
    RAISE EXCEPTION 'schedule zone % must match its product location', NEW.time_zone
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER schedules_time_zone BEFORE INSERT OR UPDATE OF time_zone ON public.schedules
  FOR EACH ROW EXECUTE FUNCTION app.check_time_zone();
CREATE TRIGGER schedules_consistency BEFORE INSERT OR UPDATE OF time_zone, product_id ON public.schedules
  FOR EACH ROW EXECUTE FUNCTION app.check_schedule();

-- Scheduled trips -------------------------------------------------------------

-- One bookable departure. Local values, UTC instants, and offsets are a
-- snapshot: changing a trip's time means an explicit new trip, never a silent
-- rewrite, so the runtime can update only the sales state. Stored sales states
-- are draft, published, closed, canceled, and completed. Sold out is computed
-- from capacity; delayed belongs to trip changes, which the demo defers.
CREATE TABLE public.scheduled_trips (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  product_id uuid NOT NULL,
  boat_id uuid NOT NULL,
  schedule_id uuid,
  time_zone app.iana_zone NOT NULL,
  local_date date NOT NULL,
  local_start_time time(0) NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  start_utc_offset_minutes smallint NOT NULL CHECK (start_utc_offset_minutes BETWEEN -1080 AND 1080),
  end_utc_offset_minutes smallint NOT NULL CHECK (end_utc_offset_minutes BETWEEN -1080 AND 1080),
  duration_minutes integer NOT NULL CHECK (duration_minutes BETWEEN 15 AND 1440),
  seat_capacity integer NOT NULL CHECK (seat_capacity BETWEEN 1 AND 500),
  sales_state text NOT NULL DEFAULT 'draft'
    CHECK (sales_state IN ('draft', 'published', 'closed', 'canceled', 'completed')),
  sales_state_changed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  -- One departure per product, boat, and instant: generation is idempotent.
  UNIQUE (tenant_id, product_id, boat_id, starts_at),
  FOREIGN KEY (tenant_id, product_id, boat_id)
    REFERENCES public.product_boats (tenant_id, product_id, boat_id),
  FOREIGN KEY (tenant_id, schedule_id) REFERENCES public.schedules (tenant_id, id),
  CHECK (ends_at = starts_at + make_interval(mins => duration_minutes))
);
CREATE INDEX scheduled_trips_local_date_idx ON public.scheduled_trips (tenant_id, local_date);
CREATE INDEX scheduled_trips_boat_idx ON public.scheduled_trips (tenant_id, boat_id, starts_at);

CREATE FUNCTION app.check_scheduled_trip() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  -- timezone() raises 22023 for a zone this server does not know.
  local_start timestamp := pg_catalog.timezone(NEW.time_zone, NEW.starts_at);
  local_end timestamp := pg_catalog.timezone(NEW.time_zone, NEW.ends_at);
  location_zone text;
  boat_capacity integer;
  schedule record;
BEGIN
  IF local_start <> NEW.local_date + NEW.local_start_time THEN
    RAISE EXCEPTION 'trip local start % does not match % in %',
      NEW.local_date + NEW.local_start_time, NEW.starts_at, NEW.time_zone
      USING ERRCODE = '23514';
  END IF;
  IF NEW.start_utc_offset_minutes
       <> extract(epoch FROM local_start - pg_catalog.timezone('UTC', NEW.starts_at)) / 60
     OR NEW.end_utc_offset_minutes
       <> extract(epoch FROM local_end - pg_catalog.timezone('UTC', NEW.ends_at)) / 60 THEN
    RAISE EXCEPTION 'trip offset snapshot does not match % at its instants', NEW.time_zone
      USING ERRCODE = '23514';
  END IF;
  SELECT l.time_zone INTO location_zone
    FROM public.products p
    JOIN public.locations l ON l.tenant_id = p.tenant_id AND l.id = p.location_id
   WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.product_id;
  IF location_zone IS DISTINCT FROM NEW.time_zone THEN
    RAISE EXCEPTION 'trip zone % must match its product location', NEW.time_zone
      USING ERRCODE = '23514';
  END IF;
  SELECT b.guest_capacity INTO boat_capacity
    FROM public.boats b WHERE b.tenant_id = NEW.tenant_id AND b.id = NEW.boat_id;
  IF boat_capacity IS NULL OR NEW.seat_capacity > boat_capacity THEN
    RAISE EXCEPTION 'trip capacity % exceeds its boat', NEW.seat_capacity USING ERRCODE = '23514';
  END IF;
  IF NEW.schedule_id IS NOT NULL THEN
    SELECT s.product_id, s.boat_id, s.time_zone INTO schedule
      FROM public.schedules s WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.schedule_id;
    IF NOT FOUND OR schedule.product_id <> NEW.product_id OR schedule.boat_id <> NEW.boat_id
       OR schedule.time_zone <> NEW.time_zone THEN
      RAISE EXCEPTION 'trip does not match its schedule' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER scheduled_trips_consistency
  BEFORE INSERT OR UPDATE OF time_zone, local_date, local_start_time, starts_at, ends_at,
    start_utc_offset_minutes, end_utc_offset_minutes, product_id, boat_id, schedule_id,
    seat_capacity
  ON public.scheduled_trips
  FOR EACH ROW EXECUTE FUNCTION app.check_scheduled_trip();

-- Canceled and completed are final. Completion is recorded after departure.
CREATE FUNCTION app.check_trip_sales_state() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF NEW.sales_state IS DISTINCT FROM OLD.sales_state AND NOT (
       (OLD.sales_state = 'draft' AND NEW.sales_state IN ('published', 'canceled'))
    OR (OLD.sales_state = 'published' AND NEW.sales_state IN ('closed', 'canceled', 'completed'))
    OR (OLD.sales_state = 'closed' AND NEW.sales_state IN ('published', 'canceled', 'completed'))
  ) THEN
    RAISE EXCEPTION 'trip cannot move from % to %', OLD.sales_state, NEW.sales_state
      USING ERRCODE = '23514';
  END IF;
  IF NEW.sales_state = 'completed' AND OLD.sales_state <> 'completed'
     AND NEW.starts_at > pg_catalog.now() THEN
    RAISE EXCEPTION 'a trip cannot be completed before it departs' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER scheduled_trips_sales_state BEFORE UPDATE OF sales_state ON public.scheduled_trips
  FOR EACH ROW EXECUTE FUNCTION app.check_trip_sales_state();

-- Blackouts -------------------------------------------------------------------

-- Whole local days with no sales: tenant-wide, or for one location, product,
-- or boat (an operator block). Generation skips trips that overlap one, and
-- availability hides existing trips that overlap one without canceling them.
-- starts_at and ends_at are the first instants of starts_on and the day after
-- ends_on, which may not be local midnight on a transition day.
CREATE TABLE public.blackouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  location_id uuid,
  product_id uuid,
  boat_id uuid,
  time_zone app.iana_zone NOT NULL,
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES public.locations (tenant_id, id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES public.products (tenant_id, id),
  FOREIGN KEY (tenant_id, boat_id) REFERENCES public.boats (tenant_id, id),
  CHECK (num_nonnulls(location_id, product_id, boat_id) <= 1),
  CHECK (ends_on >= starts_on),
  CHECK (ends_at > starts_at)
);
CREATE INDEX blackouts_window_idx ON public.blackouts (tenant_id, starts_at, ends_at);

CREATE FUNCTION app.check_blackout() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF pg_catalog.timezone(NEW.time_zone, NEW.starts_at)::date <> NEW.starts_on
     OR pg_catalog.timezone(NEW.time_zone, NEW.starts_at - interval '1 second')::date
        <> NEW.starts_on - 1
     OR pg_catalog.timezone(NEW.time_zone, NEW.ends_at)::date <> NEW.ends_on + 1
     OR pg_catalog.timezone(NEW.time_zone, NEW.ends_at - interval '1 second')::date
        <> NEW.ends_on THEN
    RAISE EXCEPTION 'blackout instants must be the local day boundaries in %', NEW.time_zone
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER blackouts_consistency BEFORE INSERT OR UPDATE ON public.blackouts
  FOR EACH ROW EXECUTE FUNCTION app.check_blackout();

-- Row-level security ----------------------------------------------------------

ALTER TABLE public.locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.locations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.locations
  USING (tenant_id = (SELECT app.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()));

ALTER TABLE public.boats ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.boats FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.boats
  USING (tenant_id = (SELECT app.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()));

ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.products FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.products
  USING (tenant_id = (SELECT app.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()));

ALTER TABLE public.product_boats ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_boats FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.product_boats
  USING (tenant_id = (SELECT app.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()));

ALTER TABLE public.schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.schedules FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.schedules
  USING (tenant_id = (SELECT app.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()));

ALTER TABLE public.scheduled_trips ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scheduled_trips FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.scheduled_trips
  USING (tenant_id = (SELECT app.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()));

ALTER TABLE public.blackouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blackouts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.blackouts
  USING (tenant_id = (SELECT app.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()));

-- Runtime privileges ----------------------------------------------------------

-- SELECT and INSERT come from the default privileges in 0001. The only runtime
-- updates in this goal are publishing a product and moving a trip's sales state.
GRANT UPDATE (sales_status, updated_at) ON public.products TO tidegrid_app;
GRANT UPDATE (sales_state, sales_state_changed_at, updated_at) ON public.scheduled_trips
  TO tidegrid_app;

REVOKE ALL ON FUNCTION app.check_time_zone() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.check_schedule() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.check_scheduled_trip() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.check_trip_sales_state() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.check_blackout() FROM PUBLIC;
