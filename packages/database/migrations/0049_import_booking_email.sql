-- 0049 import commit follow-up: an imported booking's own email (W3-G2.13)
--
-- Under the owner's go of 2026-11-10 on the rest of Wave 3 (code only,
-- synthetic data). Choices made here are coordinator defaults pending owner
-- confirmation (the "imported bookings' own email" register entry). Tenancy
-- follows packages/database/README.md.
--
-- Until now an imported booking got no booking email at all: no
-- confirmation, reminder, management link, cancellation, or move notice
-- (0044, part A's D4). Its waiver email already follows the batch's
-- waiver_notifications setting (0048). This opens the booking's own email on
-- the same release: once the batch that imported a booking has its email due
-- (saved with send_at_cutover, or released by an owner), the cron's import
-- sweep sends the booker one welcome, worded for a booking paid before
-- TideGrid, and from then on the booking's email works as any booking's does.
--
-- 1. import_booking_email_opened: the imported bookings whose own email is
--    open, one row a booking, written by the sweep in the transaction that
--    queues the welcome. The trigger allows it only for an imported booking
--    whose importing batch has its email due, named as that batch.
-- 2. The sweep's tenants (app.import_waiver_email_tenants) also lists a
--    tenant with an imported booking whose email is due and not yet open.

-- 1. Opened ----------------------------------------------------------------------------

CREATE TABLE public.import_booking_email_opened (
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  booking_id uuid NOT NULL,
  -- The batch that imported the booking.
  run_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, booking_id),
  FOREIGN KEY (tenant_id, booking_id) REFERENCES public.bookings (tenant_id, id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES public.import_runs (tenant_id, id)
);

-- The booking was imported by this batch, a clean commit, and the batch's
-- email is due: sent at cutover, or released by an owner.
CREATE FUNCTION app.check_import_booking_email_opened() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  NEW.created_at := now();
  IF NOT EXISTS (
       SELECT 1
         FROM public.bookings b
         JOIN public.import_bookings ib
           ON ib.tenant_id = b.tenant_id AND ib.checkout_session_id = b.checkout_session_id
         JOIN public.import_records r ON r.tenant_id = ib.tenant_id AND r.id = ib.record_id
         JOIN public.import_runs run ON run.tenant_id = r.tenant_id AND run.id = r.run_id
        WHERE b.tenant_id = NEW.tenant_id AND b.id = NEW.booking_id AND b.source = 'imported'
          AND run.id = NEW.run_id AND run.mode = 'commit' AND run.clean
          AND (run.waiver_notifications = 'send_at_cutover'
               OR EXISTS (SELECT 1 FROM public.import_email_releases x
                           WHERE x.tenant_id = run.tenant_id AND x.run_id = run.id))) THEN
    RAISE EXCEPTION 'only an imported booking whose batch''s email is due opens its email'
      USING ERRCODE = '23514', CONSTRAINT = 'import_booking_email_opened_due';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.check_import_booking_email_opened() FROM PUBLIC;
CREATE TRIGGER import_booking_email_opened_rules BEFORE INSERT ON public.import_booking_email_opened
  FOR EACH ROW EXECUTE FUNCTION app.check_import_booking_email_opened();

ALTER TABLE public.import_booking_email_opened ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.import_booking_email_opened FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.import_booking_email_opened
  USING (tenant_id = (SELECT app.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()));
CREATE TRIGGER import_booking_email_opened_append_only BEFORE UPDATE OR DELETE ON public.import_booking_email_opened
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();
CREATE TRIGGER import_booking_email_opened_no_truncate BEFORE TRUNCATE ON public.import_booking_email_opened
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_mutation();

-- 2. The sweep's tenants ----------------------------------------------------------------

-- As 0048, and also a batch's due booking that it imported and whose own
-- email is not open yet.
CREATE OR REPLACE FUNCTION app.import_waiver_email_tenants(p_limit integer)
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
         AND (NOT EXISTS (SELECT 1 FROM public.import_waiver_email_done d
                           WHERE d.tenant_id = run.tenant_id AND d.run_id = run.id
                             AND d.booking_id = b.id)
              OR (ib.record_id IS NOT NULL
                  AND NOT EXISTS (SELECT 1 FROM public.import_booking_email_opened o
                                   WHERE o.tenant_id = b.tenant_id AND o.booking_id = b.id)))
    ) x
      LEFT JOIN public.sweep_turns s
        ON s.tenant_id = x.tenant_id AND s.sweep = 'import_waiver_email'
     ORDER BY s.last_turn_at ASC NULLS FIRST, x.tenant_id
     LIMIT greatest(1, least(coalesce(p_limit, 100), 1000))
  $$;
