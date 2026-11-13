-- W3-G2.13, part A of the commit step: saving a standard CSV import batch.
--
-- The owner approved the import draft and all twelve of its questions on
-- 2026-11-13 (docs/v2/06), including the import capacity path (question 12).
-- Part 1 (0040) recorded dry runs only. This migration lets a clean dry run
-- be committed: future trips, customers, bookings, their participants, and
-- their legacy payments and refunds. Charter balances, opening balances, and
-- legacy waiver status come in later parts.
--
-- An imported booking keeps the rows every reader joins, so none drops it:
--
--   checkout_sessions  source 'imported', no quote; the booker's name and
--                      email (which may be empty) copied from customers.csv
--   orders             no quote and no lines; the legacy totals (all zero
--                      for an OTA reservation)
--   capacity_holds     confirmed, taken through the import branch of
--                      app.check_capacity_hold
--   bookings           source 'imported', no payment
--
-- Its evidence is the import ledger, as a complimentary booking's is the
-- owner's grant (0039):
--
--   import_runs        gains mode 'commit'. A commit follows its batch's
--                      latest run, a clean dry run with the same content
--                      hash, and is written by an owner (0040's rule).
--   import_records     one row per imported record of every file, with its
--                      source system, file, external id, deduplication key,
--                      and a hash of the row as imported. Unique by source
--                      system, file, and key, so a record is imported once
--                      and a re-run finds it.
--   import_customers   the imported customer: personal data, kept here and
--                      on the checkout, never in audit rows.
--   import_bookings    the legacy booking: source (direct, staff-assisted,
--                      OTA), channel, and amounts.
--
-- Every ledger row must belong to a clean commit run written in the same
-- transaction (created_txid). The branches below key on that, so no other
-- path reaches them: a guest or staff checkout never has a ledger row, and a
-- ledger row cannot be written outside a commit.
--
-- The import capacity path (question 12). A hold whose owner checkout has a
-- ledger row from this transaction's commit, for its trip and party, may be
-- taken on a draft trip and inside the booking cutoff, and lasts until
-- departure instead of an hour. It keeps the trip's row lock, the count of
-- active and confirmed holds, the party check against the product's limits
-- and the trip's seats, and the refusal of a canceled or departed trip. It
-- uses no capacity override. No other booking path changes.
--
-- Imported money is external tender (question 3): external_settlements rows
-- that name their payments.csv ledger row and when the money moved. Tender
-- gains card_outside_tidegrid and bank_transfer. No payments row, no
-- provider call.
--
-- An imported booking cancels like a complimentary one, with nothing
-- returned through TideGrid, and only by staff.
--
-- The ledger is append-only, with forced row-level security; the runtime has
-- the default SELECT and INSERT.

-- 1. Import runs: the commit ---------------------------------------------------------

ALTER TABLE public.import_runs DROP CONSTRAINT import_runs_mode_check;
ALTER TABLE public.import_runs
  ADD CONSTRAINT import_runs_mode_check CHECK (mode IN ('dry_run', 'commit')),
  ADD COLUMN dry_run_id uuid,
  ADD COLUMN created_txid xid8 NOT NULL DEFAULT pg_current_xact_id(),
  ADD COLUMN waiver_notifications text
    CHECK (waiver_notifications IN ('send_at_cutover', 'hold_until_staff_release')),
  ADD CONSTRAINT import_runs_dry_run
    FOREIGN KEY (tenant_id, dry_run_id) REFERENCES public.import_runs (tenant_id, id),
  ADD CONSTRAINT import_runs_commit_names_dry_run
    CHECK ((mode = 'commit') = (dry_run_id IS NOT NULL));
-- One clean commit per batch; a final delta is a new batch.
CREATE UNIQUE INDEX import_runs_one_commit ON public.import_runs (tenant_id, batch_id)
  WHERE mode = 'commit' AND clean;

-- 2. The ledger ----------------------------------------------------------------------

CREATE TABLE public.import_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  run_id uuid NOT NULL,
  source_system text NOT NULL CHECK (source_system ~ '^[A-Za-z0-9._-]{1,64}$'),
  mapping_version text NOT NULL CHECK (mapping_version = 'std-csv-v0'),
  file text NOT NULL CHECK (file IN ('products.csv', 'trips.csv', 'customers.csv',
                                     'bookings.csv', 'participants.csv', 'payments.csv')),
  -- The source system's own id for the record (for a participant, the
  -- booking's reference and the position).
  external_id text NOT NULL
    CHECK (char_length(external_id) BETWEEN 1 AND 200 AND external_id !~ '[[:cntrl:]]'),
  dedupe_key text NOT NULL
    CHECK (char_length(dedupe_key) BETWEEN 1 AND 300 AND dedupe_key !~ '[[:cntrl:]]'),
  -- SHA-256 of the row as imported, so a later batch can tell an unchanged
  -- row (a no-op) from a changed one (refused).
  row_hash text NOT NULL CHECK (row_hash ~ '^[0-9a-f]{64}$'),
  -- What the record became, for the files that map to one row.
  product_id uuid,
  trip_id uuid,
  participant_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  actor_type text NOT NULL DEFAULT coalesce(app.setting_or_null('app.actor_type'), 'system')
    CHECK (actor_type IN ('staff', 'guest', 'system', 'support')),
  actor_id text DEFAULT app.setting_or_null('app.actor_id'),
  request_id text DEFAULT app.setting_or_null('app.request_id'),
  UNIQUE (tenant_id, id),
  CONSTRAINT import_records_key UNIQUE (tenant_id, source_system, file, dedupe_key),
  FOREIGN KEY (tenant_id, run_id) REFERENCES public.import_runs (tenant_id, id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES public.products (tenant_id, id),
  FOREIGN KEY (tenant_id, trip_id) REFERENCES public.scheduled_trips (tenant_id, id),
  FOREIGN KEY (tenant_id, participant_id) REFERENCES public.booking_participants (tenant_id, id),
  CHECK ((file = 'products.csv') = (product_id IS NOT NULL)),
  CHECK ((file = 'trips.csv') = (trip_id IS NOT NULL)),
  CHECK ((file = 'participants.csv') = (participant_id IS NOT NULL))
);
CREATE INDEX import_records_run_idx ON public.import_records (tenant_id, run_id);

CREATE TABLE public.import_customers (
  record_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  full_name text NOT NULL
    CHECK (char_length(full_name) BETWEEN 1 AND 120 AND full_name !~ '[[:cntrl:]]'),
  email text
    CHECK (email IS NULL OR (char_length(email) <= 254
                             AND email = lower(email)
                             AND email ~ '^[\x21-\x7e]+$'
                             AND email ~ '^[^@]+@[^@]+\.[^@]+$')),
  phone text CHECK (phone ~ '^\+[1-9][0-9]{1,14}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, record_id),
  FOREIGN KEY (tenant_id, record_id) REFERENCES public.import_records (tenant_id, id)
);
-- Match candidates by email, for the operator's review; never merged.
CREATE INDEX import_customers_email_idx ON public.import_customers (tenant_id, email)
  WHERE email IS NOT NULL;

CREATE TABLE public.import_bookings (
  record_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  -- Chosen by the commit before the hold and the checkout exist.
  checkout_session_id uuid NOT NULL,
  customer_record_id uuid NOT NULL,
  trip_id uuid NOT NULL,
  party_size integer NOT NULL CHECK (party_size BETWEEN 1 AND 500),
  legacy_source text NOT NULL CHECK (legacy_source IN ('direct', 'staff_assisted', 'ota')),
  staff_channel text CHECK (staff_channel IN ('phone', 'email', 'walk_up')),
  ota_channel text
    CHECK (char_length(ota_channel) BETWEEN 1 AND 80 AND ota_channel !~ '[[:cntrl:]]'),
  subtotal_cents integer CHECK (subtotal_cents BETWEEN 0 AND 100000000),
  discount_cents integer CHECK (discount_cents BETWEEN 0 AND 100000000),
  fee_cents integer CHECK (fee_cents BETWEEN 0 AND 100000000),
  tax_cents integer CHECK (tax_cents BETWEEN 0 AND 100000000),
  included_tax_cents integer CHECK (included_tax_cents BETWEEN 0 AND 100000000),
  total_cents integer CHECK (total_cents BETWEEN 0 AND 100000000),
  booked_at timestamptz,
  -- An OTA reservation is a capacity and roster shadow, outside the fee base.
  in_fee_base boolean GENERATED ALWAYS AS (legacy_source <> 'ota') STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, record_id),
  CONSTRAINT import_bookings_checkout UNIQUE (tenant_id, checkout_session_id),
  FOREIGN KEY (tenant_id, record_id) REFERENCES public.import_records (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_record_id) REFERENCES public.import_customers (tenant_id, record_id),
  FOREIGN KEY (tenant_id, trip_id) REFERENCES public.scheduled_trips (tenant_id, id),
  CONSTRAINT import_bookings_checkout_fkey
    FOREIGN KEY (tenant_id, checkout_session_id)
    REFERENCES public.checkout_sessions (tenant_id, id)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT import_bookings_channel CHECK (
    (legacy_source = 'staff_assisted') = (staff_channel IS NOT NULL)
    AND (legacy_source = 'ota') = (ota_channel IS NOT NULL)),
  CONSTRAINT import_bookings_amounts CHECK (
    (legacy_source = 'ota'
       AND subtotal_cents IS NULL AND discount_cents IS NULL AND fee_cents IS NULL
       AND tax_cents IS NULL AND included_tax_cents IS NULL AND total_cents IS NULL)
    OR (legacy_source <> 'ota'
       AND subtotal_cents IS NOT NULL AND discount_cents IS NOT NULL AND fee_cents IS NOT NULL
       AND tax_cents IS NOT NULL AND included_tax_cents IS NOT NULL AND total_cents IS NOT NULL
       AND discount_cents <= subtotal_cents
       AND included_tax_cents <= subtotal_cents - discount_cents
       AND total_cents = subtotal_cents - discount_cents + fee_cents + tax_cents))
);

-- Every ledger row belongs to a clean commit run of its tenant written in this
-- same transaction, under that run's source system, and is stamped here.
CREATE FUNCTION app.check_import_record() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  NEW.created_at := now();
  NEW.actor_type := coalesce(app.setting_or_null('app.actor_type'), 'system');
  NEW.actor_id := app.setting_or_null('app.actor_id');
  NEW.request_id := app.setting_or_null('app.request_id');
  IF NOT EXISTS (
       SELECT 1 FROM public.import_runs run
        WHERE run.tenant_id = NEW.tenant_id AND run.id = NEW.run_id
          AND run.mode = 'commit' AND run.clean
          AND run.source_system = NEW.source_system
          AND run.mapping_version = NEW.mapping_version
          AND run.created_txid = pg_catalog.pg_current_xact_id()) THEN
    RAISE EXCEPTION 'an import record belongs to a clean commit run written in this transaction'
      USING ERRCODE = '23514', CONSTRAINT = 'import_records_run';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER import_records_rules BEFORE INSERT ON public.import_records
  FOR EACH ROW EXECUTE FUNCTION app.check_import_record();

-- A record of the given file, imported in this transaction's commit.
CREATE FUNCTION app.import_record_live(p_tenant uuid, p_record uuid, p_file text)
  RETURNS boolean
  LANGUAGE sql
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT EXISTS (
      SELECT 1 FROM public.import_records r
        JOIN public.import_runs run ON run.tenant_id = r.tenant_id AND run.id = r.run_id
       WHERE r.tenant_id = p_tenant AND r.id = p_record AND r.file = p_file
         AND run.mode = 'commit' AND run.clean
         AND run.created_txid = pg_catalog.pg_current_xact_id())
  $$;

CREATE FUNCTION app.check_import_customer() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  NEW.created_at := now();
  IF NOT app.import_record_live(NEW.tenant_id, NEW.record_id, 'customers.csv') THEN
    RAISE EXCEPTION 'an imported customer names its customers.csv record from this commit'
      USING ERRCODE = '23514', CONSTRAINT = 'import_customers_record';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER import_customers_rules BEFORE INSERT ON public.import_customers
  FOR EACH ROW EXECUTE FUNCTION app.check_import_customer();

CREATE FUNCTION app.check_import_booking() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  NEW.created_at := now();
  IF NOT app.import_record_live(NEW.tenant_id, NEW.record_id, 'bookings.csv') THEN
    RAISE EXCEPTION 'an imported booking names its bookings.csv record from this commit'
      USING ERRCODE = '23514', CONSTRAINT = 'import_bookings_record';
  END IF;
  -- The checkout id is new: nothing may name an existing checkout.
  IF EXISTS (SELECT 1 FROM public.checkout_sessions s
              WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.checkout_session_id)
     OR EXISTS (SELECT 1 FROM public.capacity_holds h
                 WHERE h.tenant_id = NEW.tenant_id
                   AND h.owner_ref = 'checkout_session:' || NEW.checkout_session_id::text) THEN
    RAISE EXCEPTION 'an imported booking names a new checkout'
      USING ERRCODE = '23514', CONSTRAINT = 'import_bookings_checkout';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER import_bookings_rules BEFORE INSERT ON public.import_bookings
  FOR EACH ROW EXECUTE FUNCTION app.check_import_booking();

-- An imported checkout, named by a ledger row from this transaction's commit.
CREATE FUNCTION app.import_checkout_live(p_tenant uuid, p_checkout uuid)
  RETURNS boolean
  LANGUAGE sql
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT EXISTS (
      SELECT 1 FROM public.import_bookings ib
       WHERE ib.tenant_id = p_tenant AND ib.checkout_session_id = p_checkout
         AND app.import_record_live(p_tenant, ib.record_id, 'bookings.csv'))
  $$;

-- The import capacity path's gate: a hold owned by such a checkout, for the
-- ledger row's own trip and party.
CREATE FUNCTION app.import_hold_live(p_tenant uuid, p_owner_ref text, p_trip uuid, p_party integer)
  RETURNS boolean
  LANGUAGE sql
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT EXISTS (
      SELECT 1 FROM public.import_bookings ib
       WHERE ib.tenant_id = p_tenant
         AND p_owner_ref = 'checkout_session:' || ib.checkout_session_id::text
         AND ib.trip_id = p_trip AND ib.party_size = p_party
         AND app.import_record_live(p_tenant, ib.record_id, 'bookings.csv'))
  $$;

ALTER TABLE public.import_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.import_records FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.import_records
  USING (tenant_id = (SELECT app.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()));
CREATE TRIGGER import_records_append_only BEFORE UPDATE OR DELETE ON public.import_records
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();
CREATE TRIGGER import_records_no_truncate BEFORE TRUNCATE ON public.import_records
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_mutation();

ALTER TABLE public.import_customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.import_customers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.import_customers
  USING (tenant_id = (SELECT app.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()));
CREATE TRIGGER import_customers_append_only BEFORE UPDATE OR DELETE ON public.import_customers
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();
CREATE TRIGGER import_customers_no_truncate BEFORE TRUNCATE ON public.import_customers
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_mutation();

ALTER TABLE public.import_bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.import_bookings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.import_bookings
  USING (tenant_id = (SELECT app.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()));
CREATE TRIGGER import_bookings_append_only BEFORE UPDATE OR DELETE ON public.import_bookings
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();
CREATE TRIGGER import_bookings_no_truncate BEFORE TRUNCATE ON public.import_bookings
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_mutation();

-- 3. Imported checkouts, orders, and bookings --------------------------------------------

ALTER TABLE public.checkout_sessions
  ALTER COLUMN quote_id DROP NOT NULL,
  ALTER COLUMN booker_email DROP NOT NULL;
ALTER TABLE public.checkout_sessions DROP CONSTRAINT checkout_sessions_source_check;
ALTER TABLE public.checkout_sessions
  ADD CONSTRAINT checkout_sessions_source_check
    CHECK (source IN ('direct', 'staff_assisted', 'imported')),
  -- Only an imported checkout has no quote, and only it may have no booker email.
  ADD CONSTRAINT checkout_sessions_imported_quote
    CHECK ((source = 'imported') = (quote_id IS NULL)),
  ADD CONSTRAINT checkout_sessions_booker_email_required
    CHECK (source = 'imported' OR booker_email IS NOT NULL);

ALTER TABLE public.orders ALTER COLUMN quote_id DROP NOT NULL;

ALTER TABLE public.bookings DROP CONSTRAINT bookings_source_check;
ALTER TABLE public.bookings DROP CONSTRAINT bookings_complimentary_payment;
ALTER TABLE public.bookings
  ADD CONSTRAINT bookings_source_check
    CHECK (source IN ('direct', 'staff_assisted', 'complimentary', 'imported')),
  -- A booking without a payment is complimentary or imported, and those have none.
  ADD CONSTRAINT bookings_complimentary_payment
    CHECK ((source IN ('complimentary', 'imported')) = (payment_id IS NULL));

-- 4. Imported money -------------------------------------------------------------------

ALTER TABLE public.external_settlements DROP CONSTRAINT external_settlements_tender_check;
ALTER TABLE public.external_settlements
  ADD CONSTRAINT external_settlements_tender_check
    CHECK (tender IN ('cash', 'check', 'other', 'card_outside_tidegrid', 'bank_transfer')),
  ADD COLUMN import_record_id uuid,
  ADD COLUMN received_at timestamptz,
  ADD CONSTRAINT external_settlements_import_record
    FOREIGN KEY (tenant_id, import_record_id) REFERENCES public.import_records (tenant_id, id),
  ADD CONSTRAINT external_settlements_one_per_record UNIQUE (tenant_id, import_record_id),
  ADD CONSTRAINT external_settlements_imported_at
    CHECK ((import_record_id IS NULL) = (received_at IS NULL));

-- 5. The rules, with their import branches -------------------------------------------

CREATE OR REPLACE FUNCTION app.check_import_run() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  last record;
BEGIN
  NEW.created_at := now();
  NEW.actor_type := coalesce(app.setting_or_null('app.actor_type'), 'system');
  NEW.actor_id := app.setting_or_null('app.actor_id');
  NEW.request_id := app.setting_or_null('app.request_id');
  IF NEW.actor_type <> 'staff' OR NOT EXISTS (
       SELECT 1 FROM public.tenant_memberships m
        WHERE m.tenant_id = NEW.tenant_id AND m.user_id::text = NEW.actor_id
          AND m.role = 'owner' AND m.status = 'active') THEN
    RAISE EXCEPTION 'only an owner of this operator runs an import'
      USING ERRCODE = '42501', CONSTRAINT = 'import_runs_owner';
  END IF;
  -- A batch keeps one source system across its runs. Runs of one batch take
  -- turns (the same lock runImportDryRun takes), and read afresh after the
  -- lock only under READ COMMITTED.
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'import runs are written only under READ COMMITTED, not %',
      pg_catalog.current_setting('transaction_isolation')
      USING ERRCODE = '25001';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(
    'import_runs:' || NEW.tenant_id::text || ':' || NEW.batch_id));
  IF EXISTS (SELECT 1 FROM public.import_runs r
              WHERE r.tenant_id = NEW.tenant_id AND r.batch_id = NEW.batch_id
                AND r.source_system <> NEW.source_system) THEN
    RAISE EXCEPTION 'batch % belongs to another source system', NEW.batch_id
      USING ERRCODE = '23514', CONSTRAINT = 'import_runs_source';
  END IF;
  NEW.created_txid := pg_catalog.pg_current_xact_id();
  -- A commit (0044) follows its batch's latest run, which must be a clean dry
  -- run of the same files (the content hash leaves out the run number and
  -- mode), and takes the next run number. A refused commit is recorded too,
  -- not clean, so the next commit needs a fresh dry run.
  IF NEW.mode = 'commit' THEN
    SELECT r.id, r.mode, r.clean, r.content_hash, r.run_number INTO last
      FROM public.import_runs r
     WHERE r.tenant_id = NEW.tenant_id AND r.batch_id = NEW.batch_id
     ORDER BY r.run_number DESC
     LIMIT 1;
    IF NOT FOUND OR last.id IS DISTINCT FROM NEW.dry_run_id OR last.mode <> 'dry_run'
       OR NOT last.clean OR last.content_hash <> NEW.content_hash
       OR NEW.run_number <> last.run_number + 1 THEN
      RAISE EXCEPTION 'a commit follows its batch''s latest run, a clean dry run of the same files'
        USING ERRCODE = '23514', CONSTRAINT = 'import_runs_commit';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

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
  is_import boolean := false;
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
    -- The import capacity path (owner decision 2026-11-13, question 12): a
    -- hold that a batch commit in this transaction named for its imported
    -- booking skips the on-sale checks and the one-hour window. Nothing else
    -- can name one: the ledger row exists only in a commit run of a clean,
    -- matching dry run, written by an owner in this same transaction.
    is_import := app.import_hold_live(NEW.tenant_id, NEW.owner_ref, NEW.trip_id, NEW.party_size);
    check_sales := NOT is_import;
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

  -- An imported booking keeps every other rule: no departed trip, and a
  -- party the product and the trip allow.
  IF is_import THEN
    IF trip.starts_at <= now() THEN
      RAISE EXCEPTION 'trip % has departed', NEW.trip_id
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

  IF TG_OP = 'INSERT' AND is_import THEN
    -- An imported hold is confirmed in its own transaction; until then it
    -- lasts until departure, never later.
    IF NEW.expires_at IS DISTINCT FROM trip.starts_at THEN
      RAISE EXCEPTION 'an imported hold expires at its trip''s departure'
        USING ERRCODE = '23514', CONSTRAINT = 'capacity_holds_expiry';
    END IF;
  ELSIF TG_OP = 'INSERT' THEN
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
    IF NEW.kind = 'seats' AND NOT is_import THEN
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

CREATE OR REPLACE FUNCTION app.stamp_checkout_source() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_type text := app.setting_or_null('app.actor_type');
  v_actor text := app.setting_or_null('app.actor_id');
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- A checkout a batch commit in this transaction named for an imported
    -- booking (0044). The legacy channel stays on the import ledger.
    IF app.import_checkout_live(NEW.tenant_id, NEW.id) THEN
      NEW.source := 'imported';
      NEW.opened_by := NULL;
      NEW.channel := NULL;
      RETURN NEW;
    END IF;
    IF v_type = 'staff'
       AND v_actor ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      NEW.source := 'staff_assisted';
      NEW.opened_by := v_actor::uuid;
    ELSE
      -- A guest, the system, or a connection without context opens a direct
      -- checkout, whatever the insert names.
      NEW.source := 'direct';
      NEW.opened_by := NULL;
      NEW.channel := NULL;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.source IS DISTINCT FROM OLD.source
     OR NEW.channel IS DISTINCT FROM OLD.channel
     OR NEW.opened_by IS DISTINCT FROM OLD.opened_by THEN
    RAISE EXCEPTION 'a checkout session keeps its source, channel, and opener'
      USING ERRCODE = '23514', CONSTRAINT = 'checkout_sessions_source_immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION app.check_checkout_session() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  q record;
  h record;
  hold_state text;
  seats_free boolean;
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
    NEW.unfulfilled_at := NULL;
    NEW.failed_at := NULL;
    NEW.expired_at := NULL;
    NEW.canceled_at := NULL;

    -- An imported booking's checkout (0044) has no quote: its terms are the
    -- legacy system's, on the import ledger. Keyed on the ledger, not on
    -- NEW.source: the source stamp fires after this trigger.
    IF app.import_checkout_live(NEW.tenant_id, NEW.id) THEN
      IF NEW.quote_id IS NOT NULL OR NOT EXISTS (
           SELECT 1 FROM public.import_bookings ib
            WHERE ib.tenant_id = NEW.tenant_id AND ib.checkout_session_id = NEW.id
              AND ib.trip_id = NEW.trip_id AND ib.party_size = NEW.party_size) THEN
        RAISE EXCEPTION 'an imported checkout has no quote and takes its ledger row''s trip and party'
          USING ERRCODE = '23514', CONSTRAINT = 'checkout_sessions_import';
      END IF;
    ELSE
    -- A quote holds its price until the earlier of its own expiry and 30
    -- minutes after the database wrote it. The checkout must start, and must
    -- end, inside that time.
    SELECT x.trip_id, x.party_size, x.policy_version,
           least(x.expires_at, x.created_at + interval '30 minutes') AS valid_until
      INTO q
      FROM public.quotes x
     WHERE x.tenant_id = NEW.tenant_id AND x.id = NEW.quote_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'no quote % for this tenant', NEW.quote_id
        USING ERRCODE = '23503', CONSTRAINT = 'checkout_sessions_quote';
    END IF;
    IF now() >= q.valid_until OR NEW.expires_at > q.valid_until THEN
      RAISE EXCEPTION 'quote % is not valid for a checkout ending at %', NEW.quote_id, NEW.expires_at
        USING ERRCODE = '23514', CONSTRAINT = 'checkout_sessions_quote_fresh';
    END IF;
    IF q.trip_id <> NEW.trip_id OR q.party_size <> NEW.party_size
       OR q.policy_version <> NEW.policy_version THEN
      RAISE EXCEPTION 'a checkout takes its quote''s trip, party, and policy'
        USING ERRCODE = '23514', CONSTRAINT = 'checkout_sessions_quote';
    END IF;
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
  NEW.unfulfilled_at := OLD.unfulfilled_at;
  NEW.failed_at := OLD.failed_at;
  NEW.expired_at := OLD.expired_at;
  NEW.canceled_at := OLD.canceled_at;
  NEW.updated_at := now();
  IF NEW.state = OLD.state THEN
    RETURN NEW;
  END IF;
  IF NOT (   (OLD.state = 'open'
              AND NEW.state IN ('confirmed', 'unfulfilled', 'failed', 'expired', 'canceled'))
          OR (OLD.state = 'expired' AND NEW.state IN ('confirmed', 'unfulfilled'))
          OR (OLD.state IN ('failed', 'canceled') AND NEW.state = 'unfulfilled')) THEN
    RAISE EXCEPTION 'a checkout session cannot move from % to %', OLD.state, NEW.state
      USING ERRCODE = '23514', CONSTRAINT = 'checkout_sessions_transition';
  END IF;

  SELECT x.state INTO hold_state
    FROM public.capacity_holds x
   WHERE x.tenant_id = NEW.tenant_id AND x.id = NEW.hold_id;
  -- False, not null, when the hold is missing.
  seats_free := coalesce(hold_state IN ('released', 'expired'), false);
  SELECT x.state INTO payment_state
    FROM public.payments x
   WHERE x.tenant_id = NEW.tenant_id AND x.checkout_session_id = NEW.id;

  IF NEW.state = 'confirmed' THEN
    -- A complimentary checkout (0039) confirms on its owner's grant, with no
    -- payment at all, from open only.
    IF hold_state IS DISTINCT FROM 'confirmed'
       OR NOT (payment_state IS NOT DISTINCT FROM 'succeeded'
               OR (payment_state IS NULL AND OLD.state = 'open'
                   AND (EXISTS (SELECT 1 FROM public.complimentary_grants g
                                 WHERE g.tenant_id = NEW.tenant_id
                                   AND g.checkout_session_id = NEW.id)
                        -- An imported checkout (0044) confirms on its ledger row.
                        OR (OLD.source = 'imported'
                            AND EXISTS (SELECT 1 FROM public.import_bookings ib
                                         WHERE ib.tenant_id = NEW.tenant_id
                                           AND ib.checkout_session_id = NEW.id)))))
       OR NOT EXISTS (SELECT 1 FROM public.bookings b
                       WHERE b.tenant_id = NEW.tenant_id AND b.checkout_session_id = NEW.id) THEN
      RAISE EXCEPTION 'checkout session % confirms only with a booking on a succeeded payment', NEW.id
        USING ERRCODE = '23514', CONSTRAINT = 'checkout_sessions_evidence';
    END IF;
    NEW.confirmed_at := now();
  ELSIF NEW.state = 'unfulfilled' THEN
    IF payment_state IS DISTINCT FROM 'succeeded'
       OR NOT seats_free
       OR NOT EXISTS (SELECT 1 FROM public.finalization_exceptions e
                       WHERE e.tenant_id = NEW.tenant_id AND e.checkout_session_id = NEW.id
                         AND e.refund_id IS NOT NULL)
       OR EXISTS (SELECT 1 FROM public.bookings b
                   WHERE b.tenant_id = NEW.tenant_id AND b.checkout_session_id = NEW.id) THEN
      RAISE EXCEPTION 'checkout session % closes as unfulfilled only with a refund exception and no booking', NEW.id
        USING ERRCODE = '23514', CONSTRAINT = 'checkout_sessions_evidence';
    END IF;
    NEW.unfulfilled_at := now();
  ELSIF NEW.state = 'failed' THEN
    IF payment_state IS DISTINCT FROM 'failed' OR NOT seats_free THEN
      RAISE EXCEPTION 'checkout session % fails only on a failed payment with its hold released or expired', NEW.id
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
    IF NOT seats_free THEN
      RAISE EXCEPTION 'checkout session % is canceled only with its hold released or expired', NEW.id
        USING ERRCODE = '23514', CONSTRAINT = 'checkout_sessions_evidence';
    END IF;
    NEW.canceled_at := now();
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION app.check_order() RETURNS trigger
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
         AND s.quote_id IS NOT DISTINCT FROM NEW.quote_id
         -- Only an imported checkout's order has no quote (0044).
         AND (NEW.quote_id IS NOT NULL OR s.source = 'imported')
         AND s.trip_id = NEW.trip_id
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

CREATE OR REPLACE FUNCTION app.check_order_matches_quote() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  q record;
BEGIN
  -- An imported order (0044) is the legacy system's statement: no lines, and
  -- the totals on its import ledger row (all zero for an OTA reservation).
  IF NEW.quote_id IS NULL THEN
    IF EXISTS (SELECT 1 FROM public.order_lines ol
                WHERE ol.tenant_id = NEW.tenant_id AND ol.order_id = NEW.id)
       OR NOT EXISTS (
         SELECT 1 FROM public.checkout_sessions s
           JOIN public.import_bookings ib
             ON ib.tenant_id = s.tenant_id AND ib.checkout_session_id = s.id
          WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.checkout_session_id
            AND s.source = 'imported'
            AND ib.trip_id = NEW.trip_id AND ib.party_size = NEW.party_size
            AND coalesce(ib.subtotal_cents, 0) = NEW.subtotal_amount
            AND coalesce(ib.discount_cents, 0) = NEW.discount_amount
            AND coalesce(ib.fee_cents, 0) = NEW.fee_amount
            AND coalesce(ib.tax_cents, 0) = NEW.tax_amount
            AND coalesce(ib.included_tax_cents, 0) = NEW.included_tax_amount
            AND coalesce(ib.total_cents, 0) = NEW.total_amount) THEN
      RAISE EXCEPTION 'imported order % carries its ledger row''s totals and no lines', NEW.id
        USING ERRCODE = '23514', CONSTRAINT = 'orders_match_quote';
    END IF;
    RETURN NULL;
  END IF;
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

CREATE OR REPLACE FUNCTION app.check_order_deposit() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.deposit_amount IS DISTINCT FROM OLD.deposit_amount
       OR NEW.balance_due_at IS DISTINCT FROM OLD.balance_due_at THEN
      RAISE EXCEPTION 'an order keeps its deposit and due date'
        USING ERRCODE = '23514', CONSTRAINT = 'orders_deposit';
    END IF;
    RETURN NEW;
  END IF;
  -- An imported order (0044) is paid in full, for now: a charter balance
  -- arrives with a later part of the import.
  IF NEW.quote_id IS NULL THEN
    IF NEW.deposit_amount IS NOT NULL OR NEW.balance_due_at IS NOT NULL THEN
      RAISE EXCEPTION 'imported order % carries no deposit', NEW.id
        USING ERRCODE = '23514', CONSTRAINT = 'orders_deposit';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.quotes q
     WHERE q.tenant_id = NEW.tenant_id AND q.id = NEW.quote_id
       AND q.deposit_amount IS NOT DISTINCT FROM NEW.deposit_amount
       AND q.balance_due_at IS NOT DISTINCT FROM NEW.balance_due_at
  ) THEN
    RAISE EXCEPTION 'order % does not carry its quote''s deposit', NEW.id
      USING ERRCODE = '23514', CONSTRAINT = 'orders_deposit';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION app.check_booking() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  NEW.created_at := now();
  NEW.confirmed_at := now();
  -- An imported booking (0044): its checkout's ledger row from a batch
  -- commit in this transaction, the same confirmed hold and pending order,
  -- and no payment at all. Keyed on the ledger, so the order of this
  -- table's triggers still cannot matter.
  IF NEW.payment_id IS NULL
     AND app.import_checkout_live(NEW.tenant_id, NEW.checkout_session_id) THEN
    PERFORM 1 FROM public.checkout_sessions s
      WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.checkout_session_id
        FOR NO KEY UPDATE;
    IF EXISTS (SELECT 1 FROM public.payments p
                WHERE p.tenant_id = NEW.tenant_id
                  AND p.checkout_session_id = NEW.checkout_session_id)
       OR NOT EXISTS (
         SELECT 1
           FROM public.checkout_sessions s
           JOIN public.orders o
             ON o.tenant_id = s.tenant_id AND o.checkout_session_id = s.id
           JOIN public.capacity_holds h
             ON h.tenant_id = s.tenant_id AND h.id = s.hold_id
          WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.checkout_session_id
            AND s.state = 'open'
            AND s.trip_id = NEW.trip_id AND s.party_size = NEW.party_size
            AND s.hold_id = NEW.hold_id
            AND o.id = NEW.order_id AND o.status = 'pending' AND o.quote_id IS NULL
            AND h.state = 'confirmed'
            AND h.owner_ref = 'checkout_session:' || s.id::text
            AND h.trip_id = NEW.trip_id AND h.party_size = NEW.party_size) THEN
      RAISE EXCEPTION 'an imported booking needs its checkout''s ledger row from this commit, its confirmed hold, and no payment'
        USING ERRCODE = '23514', CONSTRAINT = 'bookings_evidence';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.payment_id IS NULL THEN
    PERFORM 1 FROM public.checkout_sessions s
      WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.checkout_session_id
        FOR NO KEY UPDATE;
    IF EXISTS (SELECT 1 FROM public.payments p
                WHERE p.tenant_id = NEW.tenant_id
                  AND p.checkout_session_id = NEW.checkout_session_id)
       OR NOT EXISTS (
         SELECT 1
           FROM public.checkout_sessions s
           JOIN public.orders o
             ON o.tenant_id = s.tenant_id AND o.checkout_session_id = s.id
           JOIN public.complimentary_grants g
             ON g.tenant_id = s.tenant_id AND g.checkout_session_id = s.id
           JOIN public.capacity_holds h
             ON h.tenant_id = s.tenant_id AND h.id = s.hold_id
          WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.checkout_session_id
            AND s.state = 'open'
            AND s.trip_id = NEW.trip_id AND s.party_size = NEW.party_size
            AND s.hold_id = NEW.hold_id
            AND o.id = NEW.order_id AND o.status = 'pending'
            AND g.order_id = o.id
            AND h.state = 'confirmed'
            AND h.owner_ref = 'checkout_session:' || s.id::text
            AND h.trip_id = NEW.trip_id AND h.party_size = NEW.party_size) THEN
      RAISE EXCEPTION 'a complimentary booking needs its checkout''s grant and confirmed hold, and no payment'
        USING ERRCODE = '23514', CONSTRAINT = 'bookings_evidence';
    END IF;
    RETURN NEW;
  END IF;
  -- Ordered against a refund of the same payment by the payment's row lock,
  -- as in check_payment_refund: a payment is booked or refunded, never both.
  PERFORM 1 FROM public.payments p
    WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.payment_id
      FOR NO KEY UPDATE;
  IF EXISTS (
       SELECT 1 FROM public.payment_refunds r
        WHERE r.tenant_id = NEW.tenant_id AND r.payment_id = NEW.payment_id) THEN
    RAISE EXCEPTION 'payment % is being refunded; it cannot back a booking', NEW.payment_id
      USING ERRCODE = '23514', CONSTRAINT = 'bookings_evidence';
  END IF;
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

  SELECT x.state, x.payment_id, x.source, o.product_id, o.policy_version, t.starts_at,
         pay.state AS payment_state, pay.amount AS paid, pay.currency
    INTO b
    FROM public.bookings x
    JOIN public.orders o ON o.tenant_id = x.tenant_id AND o.id = x.order_id
    JOIN public.scheduled_trips t ON t.tenant_id = x.tenant_id AND t.id = x.trip_id
    LEFT JOIN public.payments pay ON pay.tenant_id = x.tenant_id AND pay.id = x.payment_id
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
  -- An imported booking (0044) was paid outside TideGrid, if at all: only
  -- staff cancel it, with nothing returned here. Money owed back is recorded
  -- as an external refund.
  IF b.source = 'imported' AND NEW.actor_type <> 'staff' THEN
    RAISE EXCEPTION 'booking % was imported; the operator cancels it', NEW.booking_id
      USING ERRCODE = '23514', CONSTRAINT = 'booking_cancellations_imported';
  END IF;
  IF b.payment_id IS NULL THEN
    IF b.source NOT IN ('complimentary', 'imported') OR NEW.payment_id IS NOT NULL OR NEW.paid_amount <> 0
       OR NEW.currency IS DISTINCT FROM 'USD' THEN
      RAISE EXCEPTION 'a complimentary or imported booking''s cancellation names no payment and nothing paid'
        USING ERRCODE = '23514', CONSTRAINT = 'booking_cancellations_terms';
    END IF;
  ELSIF b.payment_state <> 'succeeded' OR NEW.payment_id IS DISTINCT FROM b.payment_id
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

  IF b.payment_id IS NULL THEN
    IF NEW.remedy <> 'none' OR NEW.refund_bp <> 0 OR NEW.override_reason IS NOT NULL THEN
      RAISE EXCEPTION 'booking % was complimentary or imported; it cancels with nothing to return here', NEW.booking_id
        USING ERRCODE = '23514', CONSTRAINT = 'booking_cancellations_terms';
    END IF;
    RETURN NEW;
  END IF;

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

CREATE OR REPLACE FUNCTION app.check_external_settlement() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  b record;
  money_in bigint;
  refunded bigint;
  left_to_reverse bigint;
BEGIN
  NEW.created_at := now();
  NEW.actor_type := coalesce(app.setting_or_null('app.actor_type'), 'system');
  NEW.actor_id := app.setting_or_null('app.actor_id');
  NEW.request_id := app.setting_or_null('app.request_id');
  IF NEW.actor_type <> 'staff' OR NEW.actor_id IS NULL THEN
    RAISE EXCEPTION 'a signed-in staff member records external money'
      USING ERRCODE = '42501', CONSTRAINT = 'external_settlements_actor';
  END IF;
  -- An imported payment or refund (0044) names its payments.csv ledger row
  -- from a batch commit in this transaction, on an imported booking. Only
  -- it carries when the money moved.
  IF NEW.import_record_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.import_records r
         JOIN public.import_runs run ON run.tenant_id = r.tenant_id AND run.id = r.run_id
         JOIN public.bookings x ON x.tenant_id = r.tenant_id AND x.id = NEW.booking_id
        WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.import_record_id
          AND r.file = 'payments.csv' AND x.source = 'imported'
          AND run.mode = 'commit' AND run.clean
          AND run.created_txid = pg_catalog.pg_current_xact_id()) THEN
    RAISE EXCEPTION 'an imported settlement names its ledger row from this commit, on an imported booking'
      USING ERRCODE = '23514', CONSTRAINT = 'external_settlements_import';
  END IF;
  IF (NEW.import_record_id IS NULL) <> (NEW.received_at IS NULL)
     OR NEW.received_at > now() THEN
    RAISE EXCEPTION 'only an imported settlement carries when its money moved, never later than now'
      USING ERRCODE = '23514', CONSTRAINT = 'external_settlements_import';
  END IF;
  SELECT x.id, x.payment_id, o.total_amount,
         o.total_amount - o.tax_amount - o.included_tax_amount AS eligible_total
    INTO b
    FROM public.bookings x
    JOIN public.orders o ON o.tenant_id = x.tenant_id AND o.id = x.order_id
   WHERE x.tenant_id = NEW.tenant_id AND x.id = NEW.booking_id
     FOR NO KEY UPDATE OF x;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no booking % to record against', NEW.booking_id
      USING ERRCODE = '23503', CONSTRAINT = 'external_settlements_booking';
  END IF;
  IF NEW.kind = 'payment' THEN
    NEW.order_total := NULL;
    NEW.eligible_total := NULL;
    NEW.eligible_amount := NULL;
    NEW.fee_bp := NULL;
    NEW.fee_amount := NULL;
    RETURN NEW;
  END IF;
  -- A card refund takes the payment's lock (0029); so does this, so the two
  -- never pass the limits below together.
  PERFORM 1 FROM public.payments p
    WHERE p.tenant_id = NEW.tenant_id AND p.id = b.payment_id
      FOR NO KEY UPDATE;
  IF b.total_amount IS DISTINCT FROM NEW.order_total
     OR b.eligible_total IS DISTINCT FROM NEW.eligible_total THEN
    RAISE EXCEPTION 'an external refund carries its order''s totals as they are'
      USING ERRCODE = '23514', CONSTRAINT = 'external_settlements_order';
  END IF;
  SELECT coalesce(sum(r.amount) FILTER (WHERE r.state IN ('requested', 'pending', 'succeeded')), 0)
    INTO refunded
    FROM public.payment_refunds r
   WHERE r.tenant_id = NEW.tenant_id AND r.payment_id = b.payment_id;
  -- A lost dispute took its amount back from the card payment.
  SELECT (SELECT CASE WHEN p.state = 'succeeded' THEN p.amount ELSE 0 END
            FROM public.payments p
           WHERE p.tenant_id = NEW.tenant_id AND p.id = b.payment_id)
         - (SELECT coalesce(sum(d.amount), 0) FROM public.payment_disputes d
             WHERE d.tenant_id = NEW.tenant_id AND d.payment_id = b.payment_id
               AND d.status = 'lost')
         - refunded
         -- A balance paid by card (0033) came in too.
         + (SELECT coalesce(sum(bp.amount), 0) FROM public.balance_payments bp
             WHERE bp.tenant_id = NEW.tenant_id AND bp.booking_id = NEW.booking_id
               AND bp.state = 'succeeded')
         + coalesce(sum(s.amount) FILTER (WHERE s.kind = 'payment'), 0)
         - coalesce(sum(s.amount) FILTER (WHERE s.kind = 'refund'), 0),
         refunded + coalesce(sum(s.amount) FILTER (WHERE s.kind = 'refund'), 0)
    INTO money_in, refunded
    FROM public.external_settlements s
   WHERE s.tenant_id = NEW.tenant_id AND s.booking_id = NEW.booking_id;
  IF NEW.amount > money_in THEN
    RAISE EXCEPTION 'an external refund returns at most the money that came in'
      USING ERRCODE = '23514', CONSTRAINT = 'external_settlements_refund_limit';
  END IF;
  IF refunded + NEW.amount > b.total_amount THEN
    RAISE EXCEPTION 'refunds return at most what the booking cost'
      USING ERRCODE = '23514', CONSTRAINT = 'external_settlements_refund_limit';
  END IF;
  -- An imported refund (0044) returned money paid above the booking's total
  -- before TideGrid: the import requires each booking's payments, less its
  -- refunds, to equal its total, which is what the fee is assessed on. So it
  -- reverses no fee.
  IF NEW.import_record_id IS NOT NULL THEN
    IF NEW.fee_amount <> 0 THEN
      RAISE EXCEPTION 'an imported refund reverses no fee'
        USING ERRCODE = '23514', CONSTRAINT = 'external_settlements_fee';
    END IF;
    RETURN NEW;
  END IF;
  -- Rounding each refund on its own could reverse more than the fee on the
  -- whole booking: the reversal is capped at what is left of that fee after
  -- earlier reversals, card and external.
  SELECT greatest(0, ((b.eligible_total::bigint * NEW.fee_bp + 5000) / 10000)
           + (SELECT coalesce(sum(f.fee_amount), 0) FROM public.fee_ledger_entries f
               WHERE f.tenant_id = NEW.tenant_id AND f.booking_id = NEW.booking_id)
           + (SELECT coalesce(sum(x.fee_amount), 0) FROM public.external_settlements x
               WHERE x.tenant_id = NEW.tenant_id AND x.booking_id = NEW.booking_id
                 AND x.kind = 'refund'))
    INTO left_to_reverse;
  IF NEW.fee_amount IS DISTINCT FROM greatest(
       -(((NEW.eligible_amount::bigint * NEW.fee_bp) + 5000) / 10000), -left_to_reverse) THEN
    RAISE EXCEPTION 'an external refund reverses its share of the fee, at most what is left'
      USING ERRCODE = '23514', CONSTRAINT = 'external_settlements_fee';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app.check_import_record() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.check_import_customer() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.check_import_booking() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.import_record_live(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.import_checkout_live(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.import_hold_live(uuid, text, uuid, integer) FROM PUBLIC;
-- The triggers above call these as the writer.
GRANT EXECUTE ON FUNCTION app.import_record_live(uuid, uuid, text) TO tidegrid_app;
GRANT EXECUTE ON FUNCTION app.import_checkout_live(uuid, uuid) TO tidegrid_app;
GRANT EXECUTE ON FUNCTION app.import_hold_live(uuid, text, uuid, integer) TO tidegrid_app;
