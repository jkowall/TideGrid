-- W3-G2.11-rest, last part: correcting the booker's own contact details.
--
-- The booker's name and email live on the booking's checkout session (0007),
-- which every read and every booking email already joins. Until now nothing
-- could change them after checkout. This migration lets the runtime correct
-- them on a confirmed booking, and only in one shape, which the database
-- checks for every writer:
--
-- 1. Only the name and the email change, nothing else on the checkout.
-- 2. The checkout is confirmed, its booking is confirmed (not canceled), its
--    trip has not started, and the booker was never redacted.
-- 3. At most 3 corrections a booking in 24 hours, whoever makes them.
-- 4. Every correction writes a row to booking_contact_changes, from the
--    transaction's actor: who changed which field, never the addresses.
--
-- Other rules on the checkout (0007's immutability, 0026's redaction, 0012's
-- source) still apply to every other update. The service (domain-booking
-- booker-contact.ts) does the rest: it ends the old address's management
-- access, moves unsent email to the new address, and tells the old address.

-- The record of corrections ---------------------------------------------------------------

CREATE TABLE public.booking_contact_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  booking_id uuid NOT NULL,
  name_changed boolean NOT NULL,
  email_changed boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  actor_type text NOT NULL DEFAULT coalesce(app.setting_or_null('app.actor_type'), 'system')
    CHECK (actor_type IN ('staff', 'guest', 'system', 'support')),
  actor_id text DEFAULT app.setting_or_null('app.actor_id'),
  request_id text DEFAULT app.setting_or_null('app.request_id'),
  CHECK (name_changed OR email_changed),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, booking_id) REFERENCES public.bookings (tenant_id, id)
);
CREATE INDEX booking_contact_changes_booking_idx
  ON public.booking_contact_changes (tenant_id, booking_id, created_at);

-- Rows come only from the checkout trigger below, which runs as the writer:
-- a direct insert is refused unless that trigger is the caller.
CREATE FUNCTION app.check_contact_change_insert() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF pg_catalog.pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'a contact change is written by correcting the checkout''s booker'
      USING ERRCODE = '42501', CONSTRAINT = 'booking_contact_changes_source';
  END IF;
  NEW.created_at := now();
  NEW.actor_type := coalesce(app.setting_or_null('app.actor_type'), 'system');
  NEW.actor_id := app.setting_or_null('app.actor_id');
  NEW.request_id := app.setting_or_null('app.request_id');
  RETURN NEW;
END;
$$;
CREATE TRIGGER booking_contact_changes_source BEFORE INSERT ON public.booking_contact_changes
  FOR EACH ROW EXECUTE FUNCTION app.check_contact_change_insert();

ALTER TABLE public.booking_contact_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.booking_contact_changes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.booking_contact_changes
  USING (tenant_id = (SELECT app.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()));
CREATE TRIGGER booking_contact_changes_no_delete BEFORE DELETE ON public.booking_contact_changes
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();
CREATE TRIGGER booking_contact_changes_no_truncate BEFORE TRUNCATE ON public.booking_contact_changes
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_mutation();
CREATE TRIGGER booking_contact_changes_append_only BEFORE UPDATE ON public.booking_contact_changes
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();

-- The correction itself ---------------------------------------------------------------------

-- 0026 runs 0007's checkout rules on every update except a redaction. A
-- correction of the booker is now a second shape those rules skip, because
-- they keep the booker fixed; the trigger after this checks it instead.
DROP TRIGGER checkout_sessions_rules_update ON public.checkout_sessions;
CREATE TRIGGER checkout_sessions_rules_update
  BEFORE UPDATE ON public.checkout_sessions
  FOR EACH ROW
  WHEN (NOT (OLD.booker_redacted_at IS NULL AND NEW.booker_redacted_at IS NOT NULL)
        AND NOT (OLD.booker_redacted_at IS NULL AND NEW.booker_redacted_at IS NULL
                 AND (NEW.booker_name IS DISTINCT FROM OLD.booker_name
                      OR NEW.booker_email IS DISTINCT FROM OLD.booker_email)))
  EXECUTE FUNCTION app.check_checkout_session();

CREATE FUNCTION app.check_booker_contact_change() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  b record;
  recent integer;
BEGIN
  IF (pg_catalog.to_jsonb(NEW) - ARRAY['booker_name', 'booker_email', 'updated_at'])
       IS DISTINCT FROM
     (pg_catalog.to_jsonb(OLD) - ARRAY['booker_name', 'booker_email', 'updated_at']) THEN
    RAISE EXCEPTION 'a correction changes the booker''s name and email, and nothing else'
      USING ERRCODE = '23514', CONSTRAINT = 'checkout_sessions_immutable';
  END IF;
  -- The booking first, as every other change to a booking locks it.
  SELECT bk.id, bk.state, t.starts_at INTO b
    FROM public.bookings bk
    JOIN public.scheduled_trips t ON t.tenant_id = bk.tenant_id AND t.id = bk.trip_id
   WHERE bk.tenant_id = OLD.tenant_id AND bk.checkout_session_id = OLD.id
     FOR NO KEY UPDATE OF bk;
  IF NOT FOUND OR OLD.state <> 'confirmed' THEN
    RAISE EXCEPTION 'only a confirmed booking''s booker is corrected'
      USING ERRCODE = '23514', CONSTRAINT = 'checkout_sessions_booker_contact';
  END IF;
  IF b.state <> 'confirmed' THEN
    RAISE EXCEPTION 'booking % is %; its booker no longer changes', b.id, b.state
      USING ERRCODE = '23514', CONSTRAINT = 'checkout_sessions_booker_contact';
  END IF;
  IF now() >= b.starts_at THEN
    RAISE EXCEPTION 'booking %''s trip has started; its booker no longer changes', b.id
      USING ERRCODE = '23514', CONSTRAINT = 'checkout_sessions_booker_contact';
  END IF;
  SELECT count(*)::integer INTO recent FROM public.booking_contact_changes c
   WHERE c.tenant_id = OLD.tenant_id AND c.booking_id = b.id
     AND c.created_at > now() - interval '24 hours';
  IF recent >= 3 THEN
    RAISE EXCEPTION 'booking % had 3 contact corrections in the last 24 hours', b.id
      USING ERRCODE = '23514', CONSTRAINT = 'booking_contact_changes_limit';
  END IF;
  INSERT INTO public.booking_contact_changes (tenant_id, booking_id, name_changed, email_changed)
  VALUES (OLD.tenant_id, b.id,
          NEW.booker_name IS DISTINCT FROM OLD.booker_name,
          NEW.booker_email IS DISTINCT FROM OLD.booker_email);
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER checkout_sessions_contact
  BEFORE UPDATE ON public.checkout_sessions
  FOR EACH ROW
  WHEN (OLD.booker_redacted_at IS NULL AND NEW.booker_redacted_at IS NULL
        AND (NEW.booker_name IS DISTINCT FROM OLD.booker_name
             OR NEW.booker_email IS DISTINCT FROM OLD.booker_email))
  EXECUTE FUNCTION app.check_booker_contact_change();

GRANT UPDATE (booker_name, booker_email) ON public.checkout_sessions TO tidegrid_app;

REVOKE ALL ON FUNCTION app.check_contact_change_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.check_booker_contact_change() FROM PUBLIC;
