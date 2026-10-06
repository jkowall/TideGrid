-- Console completion (G2.12c): internal booking notes
--
-- Staff add short internal notes to a booking: what a guest asked on the
-- phone, what the dock should know. A note is append-only for every role, the
-- owner included: nobody edits or removes one. Its author, request, and time
-- come from the transaction, never from the row, so no writer can name another
-- author or date a note. Owners and booking staff write notes (notes.write)
-- and every role reads them (notes.read); the API checks the role, and this
-- table holds authorship, immutability, and tenancy.
--
-- The body is free text a person typed. It never enters audit rows, outbox
-- events, or logs: the audit row for a note names the note's id only.
--
-- Tenancy follows packages/database/README.md, rules 1 to 10: tenant_id on
-- every row, forced row-level security with a tenant_isolation policy, the
-- default SELECT and INSERT and nothing more, no DELETE or TRUNCATE for any
-- role, and composite foreign keys that carry tenant_id, so a note can name
-- only its own tenant's booking and its own tenant's member as its author.

CREATE TABLE public.booking_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  booking_id uuid NOT NULL,
  -- Line breaks are allowed; other control characters are not, and a note
  -- holds at least one visible character.
  body text NOT NULL
    CHECK (char_length(body) BETWEEN 1 AND 500
           AND body ~ '[^[:space:]]'
           AND body !~ '[\x01-\x09\x0b-\x1f\x7f]'),
  -- The staff member who wrote it: the transaction's actor, set by the trigger.
  author_user_id uuid NOT NULL,
  request_id text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, booking_id) REFERENCES public.bookings (tenant_id, id),
  -- The author is a member of the note's own tenant.
  FOREIGN KEY (tenant_id, author_user_id)
    REFERENCES public.tenant_memberships (tenant_id, user_id)
);
CREATE INDEX booking_notes_booking_idx
  ON public.booking_notes (tenant_id, booking_id, created_at DESC, id DESC);

ALTER TABLE public.booking_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.booking_notes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.booking_notes
  USING (tenant_id = (SELECT app.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()));

-- Only a staff actor writes a note, and the note is theirs. Runs as the
-- writer; it reads nothing but the transaction's settings.
CREATE FUNCTION app.stamp_booking_note() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_actor text := app.setting_or_null('app.actor_id');
BEGIN
  IF app.setting_or_null('app.actor_type') IS DISTINCT FROM 'staff'
     OR v_actor IS NULL
     OR v_actor !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'a booking note is written by a signed-in staff member'
      USING ERRCODE = '42501', CONSTRAINT = 'booking_notes_staff_author';
  END IF;
  NEW.author_user_id := v_actor::uuid;
  NEW.request_id := app.setting_or_null('app.request_id');
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER booking_notes_stamp
  BEFORE INSERT ON public.booking_notes
  FOR EACH ROW EXECUTE FUNCTION app.stamp_booking_note();
CREATE TRIGGER booking_notes_append_only
  BEFORE UPDATE OR DELETE ON public.booking_notes
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();
CREATE TRIGGER booking_notes_no_truncate
  BEFORE TRUNCATE ON public.booking_notes
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_mutation();

-- The runtime keeps the default SELECT and INSERT from 0001 and receives
-- nothing more. The trigger function is not callable directly.
REVOKE ALL ON FUNCTION app.stamp_booking_note() FROM PUBLIC;
