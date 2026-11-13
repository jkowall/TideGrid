-- 0047 import commit, part D1: legacy waiver status (W3-G2.13)
--
-- Under the owner's approval of the standard CSV import draft on 2026-11-13
-- (all twelve answers as recommended) and the code-only pull-forward of
-- Wave 3. Synthetic data only. What it adds to 0044 and 0046:
--
-- 1. waivers.csv rows join the import ledger.
-- 2. import_waiver_statuses: what the legacy waiver tool said about an
--    imported participant (signed, unsigned, or unknown), for staff to read
--    beside the TideGrid status. It is information only: it never marks a
--    TideGrid waiver signed, creates evidence, or skips a request, and it
--    holds no legacy document or signature.
--
-- Choices made here are coordinator defaults pending owner confirmation (the
-- "W3-G2.13, part D1" register entry). Tenancy follows
-- packages/database/README.md.

-- 1. The ledger takes waiver status ---------------------------------------------------

ALTER TABLE public.import_records
  DROP CONSTRAINT import_records_file_check,
  ADD CONSTRAINT import_records_file_check CHECK (file IN (
    'products.csv', 'trips.csv', 'customers.csv', 'bookings.csv', 'participants.csv',
    'payments.csv', 'opening_balances.csv', 'waivers.csv'));

-- 2. Legacy waiver status -------------------------------------------------------------

CREATE TABLE public.import_waiver_statuses (
  record_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  participant_id uuid NOT NULL,
  legacy_status text NOT NULL CHECK (legacy_status IN ('signed', 'unsigned', 'unknown')),
  legacy_signed_on date,
  legacy_system text
    CHECK (char_length(legacy_system) BETWEEN 1 AND 80 AND legacy_system !~ '[[:cntrl:]]'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, record_id),
  -- One legacy status per participant.
  CONSTRAINT import_waiver_statuses_participant UNIQUE (tenant_id, participant_id),
  FOREIGN KEY (tenant_id, record_id) REFERENCES public.import_records (tenant_id, id),
  FOREIGN KEY (tenant_id, participant_id) REFERENCES public.booking_participants (tenant_id, id),
  CONSTRAINT import_waiver_statuses_signed_on
    CHECK (legacy_signed_on IS NULL OR legacy_status = 'signed')
);

-- A status names its waivers.csv ledger row from this transaction's clean
-- commit, and the participant its own participants.csv record created.
CREATE FUNCTION app.check_import_waiver_status() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  NEW.created_at := now();
  -- The participant is the one the participants.csv record with the same
  -- source system and key became.
  IF NOT app.import_record_live(NEW.tenant_id, NEW.record_id, 'waivers.csv')
     OR NOT EXISTS (
       SELECT 1 FROM public.import_records w
         JOIN public.import_records p
           ON p.tenant_id = w.tenant_id AND p.file = 'participants.csv'
          AND p.source_system = w.source_system AND p.dedupe_key = w.dedupe_key
        WHERE w.tenant_id = NEW.tenant_id AND w.id = NEW.record_id
          AND p.participant_id = NEW.participant_id) THEN
    RAISE EXCEPTION 'a legacy waiver status names its waivers.csv record from this commit and an imported participant'
      USING ERRCODE = '23514', CONSTRAINT = 'import_waiver_statuses_record';
  END IF;
  -- The participant's booking is still confirmed, read under a share lock so
  -- a cancellation racing the commit either finishes first (and this refuses)
  -- or waits for the commit.
  PERFORM 1
     FROM public.booking_participants p
     JOIN public.bookings b ON b.tenant_id = p.tenant_id AND b.id = p.booking_id
    WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.participant_id
      AND b.state = 'confirmed'
      FOR SHARE OF b;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'a legacy waiver status is saved only on a confirmed booking'
      USING ERRCODE = '23514', CONSTRAINT = 'import_waiver_statuses_booking_closed';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.check_import_waiver_status() FROM PUBLIC;
CREATE TRIGGER import_waiver_statuses_rules BEFORE INSERT ON public.import_waiver_statuses
  FOR EACH ROW EXECUTE FUNCTION app.check_import_waiver_status();

ALTER TABLE public.import_waiver_statuses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.import_waiver_statuses FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.import_waiver_statuses
  USING (tenant_id = (SELECT app.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()));
CREATE TRIGGER import_waiver_statuses_append_only BEFORE UPDATE OR DELETE ON public.import_waiver_statuses
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();
CREATE TRIGGER import_waiver_statuses_no_truncate BEFORE TRUNCATE ON public.import_waiver_statuses
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_mutation();
