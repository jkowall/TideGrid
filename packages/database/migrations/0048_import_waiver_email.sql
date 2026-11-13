-- 0048 import commit, part D2: when imported guests get their waiver email (W3-G2.13)
--
-- Under the owner's approval of the standard CSV import draft on 2026-11-13
-- (question 9: waiver email for imported bookings is on by default, set once
-- per batch) and the code-only pull-forward of Wave 3. Synthetic data only.
--
-- Saving a batch sends nothing and creates no waiver request, so a large
-- batch's save stays short. The cron's import waiver sweep does that work
-- afterwards, a few bookings at a time and under an hourly email budget per
-- operator, for every saved batch whose email is due: one saved with
-- waiver_notifications = send_at_cutover, or one saved with
-- hold_until_staff_release once an owner has released it.
--
-- 1. import_email_releases: an owner's release of a held batch. Once a batch,
--    after its clean commit.
-- 2. import_waiver_email_done: the bookings the sweep has finished for a
--    batch, so a booking it cannot email (no address, no waiver needed) never
--    holds up the rest.
-- 3. app.import_waiver_email_held(tenant, booking, participant): whether a
--    guest's waiver email waits for an owner. The batch that imported the
--    guest decides; a guest added in TideGrid follows the batch that imported
--    the booking.
-- 4. app.import_waiver_email_tenants(limit): the sweep's tenants, ids only.
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

-- 2. Bookings the sweep finished for a batch ------------------------------------------

CREATE TABLE public.import_waiver_email_done (
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  run_id uuid NOT NULL,
  booking_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, run_id, booking_id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES public.import_runs (tenant_id, id),
  FOREIGN KEY (tenant_id, booking_id) REFERENCES public.bookings (tenant_id, id)
);

ALTER TABLE public.import_waiver_email_done ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.import_waiver_email_done FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.import_waiver_email_done
  USING (tenant_id = (SELECT app.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()));
CREATE TRIGGER import_waiver_email_done_append_only BEFORE UPDATE OR DELETE ON public.import_waiver_email_done
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();
CREATE TRIGGER import_waiver_email_done_no_truncate BEFORE TRUNCATE ON public.import_waiver_email_done
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_mutation();

-- 3. Whether a guest's waiver email is held ---------------------------------------------

-- The batch that imported the participant decides; a participant added in
-- TideGrid to an imported booking follows the batch that imported the
-- booking. Held while that batch was saved with hold_until_staff_release and
-- has no release. Run as the caller, under row-level security.
CREATE FUNCTION app.import_waiver_email_held(p_tenant uuid, p_booking uuid, p_participant uuid)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SET search_path = pg_catalog, pg_temp
  AS $$
    WITH source AS (
      SELECT r.run_id
        FROM public.import_records r
       WHERE r.tenant_id = p_tenant AND r.file = 'participants.csv'
         AND r.participant_id = p_participant
      UNION ALL
      SELECT r.run_id
        FROM public.bookings b
        JOIN public.import_bookings ib
          ON ib.tenant_id = b.tenant_id AND ib.checkout_session_id = b.checkout_session_id
        JOIN public.import_records r ON r.tenant_id = ib.tenant_id AND r.id = ib.record_id
       WHERE b.tenant_id = p_tenant AND b.id = p_booking AND b.source = 'imported'
         AND NOT EXISTS (
           SELECT 1 FROM public.import_records p
            WHERE p.tenant_id = p_tenant AND p.file = 'participants.csv'
              AND p.participant_id = p_participant)
    )
    SELECT EXISTS (
      SELECT 1
        FROM source
        JOIN public.import_runs run ON run.tenant_id = p_tenant AND run.id = source.run_id
       WHERE run.waiver_notifications = 'hold_until_staff_release'
         AND NOT EXISTS (
           SELECT 1 FROM public.import_email_releases x
            WHERE x.tenant_id = run.tenant_id AND x.run_id = run.id))
  $$;
REVOKE ALL ON FUNCTION app.import_waiver_email_held(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.import_waiver_email_held(uuid, uuid, uuid) TO tidegrid_app;

-- 4. The sweep's tenants ----------------------------------------------------------------

ALTER TABLE public.sweep_turns DROP CONSTRAINT sweep_turns_sweep_check;
ALTER TABLE public.sweep_turns ADD CONSTRAINT sweep_turns_sweep_check
  CHECK (sweep IN (
    'hold', 'checkout', 'email', 'hostname', 'outbox', 'waiver_reminder', 'reconciliation',
    'import_waiver_email'));

-- Tenants with a saved batch whose waiver email is due (sent at cutover, or
-- released) and a booking it imported or added guests to that is confirmed,
-- not yet left, and not finished by the sweep. The longest-waiting first. Ids
-- only.
CREATE FUNCTION app.import_waiver_email_tenants(p_limit integer)
  RETURNS TABLE (tenant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT x.tenant_id FROM (
      SELECT DISTINCT run.tenant_id
        FROM public.import_runs run
        JOIN public.import_records r
          ON r.tenant_id = run.tenant_id AND r.run_id = run.id
         AND r.file IN ('bookings.csv', 'participants.csv')
        LEFT JOIN public.import_bookings ib
          ON ib.tenant_id = r.tenant_id AND ib.record_id = r.id
        LEFT JOIN public.booking_participants bp
          ON bp.tenant_id = r.tenant_id AND bp.id = r.participant_id
        JOIN public.bookings b
          ON b.tenant_id = run.tenant_id
         AND (b.checkout_session_id = ib.checkout_session_id OR b.id = bp.booking_id)
        JOIN public.scheduled_trips t ON t.tenant_id = b.tenant_id AND t.id = b.trip_id
       WHERE run.mode = 'commit' AND run.clean
         AND (run.waiver_notifications = 'send_at_cutover'
              OR EXISTS (SELECT 1 FROM public.import_email_releases x
                          WHERE x.tenant_id = run.tenant_id AND x.run_id = run.id))
         AND b.state = 'confirmed' AND t.starts_at > pg_catalog.now()
         AND NOT EXISTS (SELECT 1 FROM public.import_waiver_email_done d
                          WHERE d.tenant_id = run.tenant_id AND d.run_id = run.id
                            AND d.booking_id = b.id)
    ) x
      LEFT JOIN public.sweep_turns s
        ON s.tenant_id = x.tenant_id AND s.sweep = 'import_waiver_email'
     ORDER BY s.last_turn_at ASC NULLS FIRST, x.tenant_id
     LIMIT greatest(1, least(coalesce(p_limit, 100), 1000))
  $$;
REVOKE ALL ON FUNCTION app.import_waiver_email_tenants(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.import_waiver_email_tenants(integer) TO tidegrid_app;
