-- 0048 import commit, part D2: when imported guests get their waiver email (W3-G2.13)
--
-- Under the owner's approval of the standard CSV import draft on 2026-11-13
-- (question 9: waiver email for imported bookings is on by default, set once
-- per batch) and the code-only pull-forward of Wave 3. Synthetic data only.
--
-- 1. import_email_releases: an owner's release of a batch saved with
--    waiver_notifications = hold_until_staff_release. Once a batch, after its
--    clean commit.
-- 2. app.import_waiver_email_held(tenant, booking): an imported booking whose
--    batch holds its waiver email and has no release yet. Its waiver requests
--    exist but are not emailed; a batch saved with send_at_cutover holds
--    nothing.
--
-- Only waiver email is released here. The booking's own emails (confirmation,
-- reminders, balance, cancellation) stay held for every imported booking.
-- Choices made here are coordinator defaults pending owner confirmation (the
-- "W3-G2.13, part D2" register entry). Tenancy follows
-- packages/database/README.md.

-- 1. Releases --------------------------------------------------------------------------

CREATE TABLE public.import_email_releases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  run_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  actor_type text NOT NULL DEFAULT coalesce(app.setting_or_null('app.actor_type'), 'system')
    CHECK (actor_type IN ('staff', 'guest', 'system', 'support')),
  actor_id text DEFAULT app.setting_or_null('app.actor_id'),
  request_id text DEFAULT app.setting_or_null('app.request_id'),
  UNIQUE (tenant_id, id),
  -- Once a batch.
  CONSTRAINT import_email_releases_once UNIQUE (tenant_id, run_id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES public.import_runs (tenant_id, id)
);

-- An active owner, signed in as staff, releases a clean commit that held its
-- waiver email.
CREATE FUNCTION app.check_import_email_release() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  NEW.created_at := now();
  NEW.actor_type := coalesce(app.setting_or_null('app.actor_type'), 'system');
  NEW.actor_id := app.setting_or_null('app.actor_id');
  NEW.request_id := app.setting_or_null('app.request_id');
  IF NEW.actor_type <> 'staff' OR NOT EXISTS (
       SELECT 1 FROM public.tenant_memberships m
        WHERE m.tenant_id = NEW.tenant_id AND m.user_id::text = NEW.actor_id
          AND m.role = 'owner' AND m.status = 'active') THEN
    RAISE EXCEPTION 'only an owner of this operator releases an import''s email'
      USING ERRCODE = '42501', CONSTRAINT = 'import_email_releases_owner';
  END IF;
  IF NOT EXISTS (
       SELECT 1 FROM public.import_runs run
        WHERE run.tenant_id = NEW.tenant_id AND run.id = NEW.run_id
          AND run.mode = 'commit' AND run.clean
          AND run.waiver_notifications = 'hold_until_staff_release') THEN
    RAISE EXCEPTION 'only a saved batch that held its waiver email is released'
      USING ERRCODE = '23514', CONSTRAINT = 'import_email_releases_run';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.check_import_email_release() FROM PUBLIC;
CREATE TRIGGER import_email_releases_rules BEFORE INSERT ON public.import_email_releases
  FOR EACH ROW EXECUTE FUNCTION app.check_import_email_release();

ALTER TABLE public.import_email_releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.import_email_releases FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.import_email_releases
  USING (tenant_id = (SELECT app.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()));
CREATE TRIGGER import_email_releases_append_only BEFORE UPDATE OR DELETE ON public.import_email_releases
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();
CREATE TRIGGER import_email_releases_no_truncate BEFORE TRUNCATE ON public.import_email_releases
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_mutation();

-- 2. Whether an imported booking's waiver email is held ---------------------------------

-- The batch that saved the booking decides: the first clean commit of its
-- bookings.csv record. Run as the caller, under row-level security.
CREATE FUNCTION app.import_waiver_email_held(p_tenant uuid, p_booking uuid)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT EXISTS (
      SELECT 1
        FROM public.bookings b
        JOIN public.import_bookings ib
          ON ib.tenant_id = b.tenant_id AND ib.checkout_session_id = b.checkout_session_id
        JOIN public.import_records r ON r.tenant_id = ib.tenant_id AND r.id = ib.record_id
        JOIN public.import_runs run ON run.tenant_id = r.tenant_id AND run.id = r.run_id
       WHERE b.tenant_id = p_tenant AND b.id = p_booking AND b.source = 'imported'
         AND run.waiver_notifications = 'hold_until_staff_release'
         AND NOT EXISTS (
           SELECT 1 FROM public.import_email_releases x
            WHERE x.tenant_id = run.tenant_id AND x.run_id = run.id))
  $$;
REVOKE ALL ON FUNCTION app.import_waiver_email_held(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.import_waiver_email_held(uuid, uuid) TO tidegrid_app;
