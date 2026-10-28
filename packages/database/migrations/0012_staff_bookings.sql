-- G2.12d: staff-assisted bookings (demo slice).
--
-- A booking staff member or an owner opens a checkout for a guest who reached
-- them by phone, email, or walk-up. The chain of custody does not change: the
-- checkout takes a hold, writes the order and a pending payment, and a booking
-- exists only once a verified provider event says the payment succeeded
-- (0007). This migration only records where a checkout and its booking came
-- from, and who opened it.
--
-- - checkout_sessions gains source, channel, and opened_by. A trigger stamps
--   source and opened_by from the transaction's actor, so no writer chooses
--   them: a staff actor with a UUID id opens a staff-assisted checkout, and
--   anyone else opens a direct one. The channel is the staff member's input
--   and is required on a staff-assisted checkout, null on a direct one. None of
--   the three ever changes.
-- - bookings.source widens to staff_assisted. A trigger sets each new
--   booking's source from its checkout, whatever the insert names, so the
--   confirmation code (book(), finalize.ts) is unchanged and cannot forge it.
--   app.check_booking (0007) is not replaced and does not read source.
--
-- No new tables and no grant changes. The runtime's table-level INSERT on
-- checkout_sessions covers the new columns; its UPDATE stays on state only.

-- Checkout sessions ----------------------------------------------------------------

ALTER TABLE public.checkout_sessions
  ADD COLUMN source text NOT NULL DEFAULT 'direct',
  ADD COLUMN channel text,
  ADD COLUMN opened_by uuid;

ALTER TABLE public.checkout_sessions
  ADD CONSTRAINT checkout_sessions_source_check
    CHECK (source IN ('direct', 'staff_assisted')),
  ADD CONSTRAINT checkout_sessions_channel_check
    CHECK (channel IN ('phone', 'email', 'walk_up')),
  -- A staff-assisted checkout names how the guest reached staff; a direct one does not.
  ADD CONSTRAINT checkout_sessions_staff_channel
    CHECK ((source = 'staff_assisted') = (channel IS NOT NULL)),
  -- A staff-assisted checkout names the staff member who opened it; a direct one does not.
  ADD CONSTRAINT checkout_sessions_staff_opener
    CHECK ((source = 'staff_assisted') = (opened_by IS NOT NULL)),
  -- The opener is a member of the checkout's own tenant.
  ADD CONSTRAINT checkout_sessions_opened_by_fkey
    FOREIGN KEY (tenant_id, opened_by)
    REFERENCES public.tenant_memberships (tenant_id, user_id);

-- Source and opener come from the transaction's actor, as a booking note's
-- author does (0008). Runs as the writer; it reads nothing but the
-- transaction's settings. On update, none of the three columns moves, for
-- any role.
CREATE FUNCTION app.stamp_checkout_source() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_type text := app.setting_or_null('app.actor_type');
  v_actor text := app.setting_or_null('app.actor_id');
BEGIN
  IF TG_OP = 'INSERT' THEN
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

CREATE TRIGGER checkout_sessions_source
  BEFORE INSERT OR UPDATE ON public.checkout_sessions
  FOR EACH ROW EXECUTE FUNCTION app.stamp_checkout_source();

-- Bookings -------------------------------------------------------------------------

ALTER TABLE public.bookings DROP CONSTRAINT bookings_source_check;
ALTER TABLE public.bookings
  ADD CONSTRAINT bookings_source_check CHECK (source IN ('direct', 'staff_assisted'));

-- A booking's source is its checkout's. Set, not checked: book() inserts the
-- default and this replaces it, so a verified payment is never stranded by a
-- mismatch. A booking without its checkout fails its foreign key and
-- app.check_booking anyway. Runs as the writer, under its row-level security,
-- and filters by tenant explicitly. Named to fire before bookings_evidence and
-- bookings_lifecycle, though neither reads source.
CREATE FUNCTION app.stamp_booking_source() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_source text;
BEGIN
  SELECT s.source INTO v_source
    FROM public.checkout_sessions s
   WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.checkout_session_id;
  NEW.source := coalesce(v_source, 'direct');
  RETURN NEW;
END;
$$;

CREATE TRIGGER bookings_a_source
  BEFORE INSERT ON public.bookings
  FOR EACH ROW EXECUTE FUNCTION app.stamp_booking_source();

-- Neither trigger function is callable directly.
REVOKE ALL ON FUNCTION app.stamp_checkout_source() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.stamp_booking_source() FROM PUBLIC;
