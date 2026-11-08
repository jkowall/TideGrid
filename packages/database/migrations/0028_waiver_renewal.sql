-- Waiver link renewal by the guest, and a staff reset of the five sends
-- (W1-WAIVER-RENEWAL)
--
-- Pulled into the demo by the owner's decision of 2026-11-08 (see the
-- decision register). Synthetic data only. Contract:
-- packages/domain-waivers/README.md, "Renewal and the send count".
--
-- D1: a guest with a spent or lapsed emailed link asks for a new one. That is
--     a delivery generation like a staff resend, marked guest_renewal and
--     recorded with the guest actor, only to the address the latest
--     generation went to, and at most three a day for the participant.
-- D2: after five generations, staff may reset the count with a reason; each
--     reset allows five more, up to 20 generations in all. A reset is its
--     own append-only row and is audited.
-- D3 (shared family address) is a flag on the staff read, with no table.
--
-- Tenancy follows packages/database/README.md: tenant_id on every row,
-- composite tenant foreign keys, forced row-level security, SELECT and INSERT
-- from the default privileges, append-only for every role, and no index on a
-- pilot-volume table (rule R4): the unique keys are on this new table.

CREATE TABLE public.waiver_send_resets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  request_id uuid NOT NULL,
  -- The latest generation when staff reset the count: five more may follow.
  after_generation smallint NOT NULL CHECK (after_generation BETWEEN 5 AND 15),
  actor_id text NOT NULL,
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 500 AND reason !~ '[[:cntrl:]]'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CONSTRAINT waiver_send_resets_once UNIQUE (tenant_id, request_id, after_generation),
  FOREIGN KEY (tenant_id, request_id) REFERENCES public.waiver_requests (tenant_id, id)
);

-- A reset is a staff member's, for a pending request whose count is used up,
-- at its latest generation.
CREATE FUNCTION app.check_waiver_send_reset() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  latest smallint;
  previous smallint;
BEGIN
  NEW.created_at := pg_catalog.now();
  IF app.setting_or_null('app.actor_type') IS DISTINCT FROM 'staff'
     OR NEW.actor_id IS DISTINCT FROM app.setting_or_null('app.actor_id') THEN
    RAISE EXCEPTION 'only the staff member asking resets a waiver''s send count'
      USING ERRCODE = '23514', CONSTRAINT = 'waiver_send_resets_staff';
  END IF;
  PERFORM 1 FROM public.waiver_requests r
   WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.request_id AND r.state = 'pending'
     FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'waiver request % is not pending', NEW.request_id
      USING ERRCODE = '23514', CONSTRAINT = 'waiver_send_resets_count';
  END IF;
  SELECT max(d.generation) INTO latest FROM public.waiver_deliveries d
   WHERE d.tenant_id = NEW.tenant_id AND d.request_id = NEW.request_id;
  SELECT max(x.after_generation) INTO previous FROM public.waiver_send_resets x
   WHERE x.tenant_id = NEW.tenant_id AND x.request_id = NEW.request_id;
  IF latest IS NULL OR NEW.after_generation IS DISTINCT FROM latest
     OR latest - coalesce(previous, 0) < 5 THEN
    RAISE EXCEPTION 'a reset comes only once a request''s five sends are used, at its latest generation'
      USING ERRCODE = '23514', CONSTRAINT = 'waiver_send_resets_count';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER waiver_send_resets_check BEFORE INSERT ON public.waiver_send_resets
  FOR EACH ROW EXECUTE FUNCTION app.check_waiver_send_reset();

ALTER TABLE public.waiver_send_resets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.waiver_send_resets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.waiver_send_resets
  USING (tenant_id = (SELECT app.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()));
CREATE TRIGGER waiver_send_resets_no_delete BEFORE DELETE ON public.waiver_send_resets
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();
CREATE TRIGGER waiver_send_resets_no_truncate BEFORE TRUNCATE ON public.waiver_send_resets
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_mutation();
CREATE TRIGGER waiver_send_resets_append_only BEFORE UPDATE ON public.waiver_send_resets
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();
REVOKE ALL ON FUNCTION app.check_waiver_send_reset() FROM PUBLIC;

-- A generation the guest asked for themselves (D1). Booking hooks that run in
-- a guest's transaction (the booker naming a participant) send as the guest
-- too, so the actor alone does not mark a renewal.
ALTER TABLE public.waiver_deliveries
  ADD COLUMN guest_renewal boolean NOT NULL DEFAULT false;

-- Generations: up to 20 in all; the trigger holds five per reset.
ALTER TABLE public.waiver_deliveries DROP CONSTRAINT waiver_deliveries_generation_check;
ALTER TABLE public.waiver_deliveries ADD CONSTRAINT waiver_deliveries_generation_check
  CHECK (generation BETWEEN 1 AND 20);

-- The delivery check, replaced in place: 0010's text with the reset count and
-- the guest's renewal rules added.
CREATE OR REPLACE FUNCTION app.check_waiver_delivery() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  latest record;
  request record;
  refusal record;
  reset_at smallint;
BEGIN
  NEW.created_at := now();
  NEW.send_after := greatest(coalesce(NEW.send_after, now()), now());
  NEW.actor_type := coalesce(app.setting_or_null('app.actor_type'), 'system');
  NEW.actor_id := app.setting_or_null('app.actor_id');
  NEW.api_request_id := app.setting_or_null('app.request_id');
  -- Serializes generations of one request with each other and with signing.
  SELECT r.booking_id, r.participant_id INTO request
    FROM public.waiver_requests r
    WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.request_id AND r.state = 'pending'
      FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'waiver request % is not pending; nothing to send', NEW.request_id
      USING ERRCODE = '23514', CONSTRAINT = 'waiver_deliveries_request';
  END IF;
  SELECT d.generation, d.recipient_email INTO latest
    FROM public.waiver_deliveries d
   WHERE d.tenant_id = NEW.tenant_id AND d.request_id = NEW.request_id
   ORDER BY d.generation DESC
   LIMIT 1;
  IF NEW.generation IS DISTINCT FROM coalesce(latest.generation, 0) + 1 THEN
    RAISE EXCEPTION 'waiver request % takes delivery generation %, not %',
      NEW.request_id, coalesce(latest.generation, 0) + 1, NEW.generation
      USING ERRCODE = '23514', CONSTRAINT = 'waiver_deliveries_sequence';
  END IF;
  -- Five generations, then five more after each staff reset (D2).
  SELECT max(x.after_generation) INTO reset_at
    FROM public.waiver_send_resets x
   WHERE x.tenant_id = NEW.tenant_id AND x.request_id = NEW.request_id;
  IF NEW.generation - coalesce(reset_at, 0) > 5 THEN
    RAISE EXCEPTION 'waiver request % has had its five sends; staff can reset the count', NEW.request_id
      USING ERRCODE = '23514', CONSTRAINT = 'waiver_deliveries_generations';
  END IF;
  -- A guest's own renewal (D1): the guest's, a resend to the address the
  -- latest generation went to, at most three a day for the participant.
  IF NEW.guest_renewal THEN
    IF NEW.actor_type IS DISTINCT FROM 'guest'
       OR NEW.kind IS DISTINCT FROM 'resend'
       OR NEW.recipient_email IS DISTINCT FROM latest.recipient_email THEN
      RAISE EXCEPTION 'a guest renews a waiver link only to the address it last went to'
        USING ERRCODE = '23514', CONSTRAINT = 'waiver_deliveries_guest';
    END IF;
    IF (SELECT count(*)
          FROM public.waiver_deliveries d
          JOIN public.waiver_requests r ON r.tenant_id = d.tenant_id AND r.id = d.request_id
         WHERE d.tenant_id = NEW.tenant_id AND r.booking_id = request.booking_id
           AND r.participant_id = request.participant_id
           AND d.guest_renewal
           AND d.created_at > NEW.created_at - interval '24 hours') >= 3 THEN
      RAISE EXCEPTION 'a guest asked for three new waiver links today'
        USING ERRCODE = '23514', CONSTRAINT = 'waiver_deliveries_guest_limit';
    END IF;
  END IF;
  SELECT * INTO refusal
    FROM app.waiver_send_refusal(NEW.tenant_id, request.booking_id, request.participant_id,
                                 NEW.recipient_email, NEW.send_after);
  IF refusal.code = 'interval' THEN
    RAISE EXCEPTION 'this participant''s waiver went to this address less than 10 minutes before %',
      NEW.send_after
      USING ERRCODE = '23514', CONSTRAINT = 'waiver_deliveries_rate';
  ELSIF refusal.code IS NOT NULL THEN
    RAISE EXCEPTION 'waiver sending limit reached (%) until %', refusal.code, refusal.retry_after
      USING ERRCODE = '23514', CONSTRAINT = 'waiver_deliveries_limit';
  END IF;
  IF NOT EXISTS (
       SELECT 1 FROM public.email_messages m
        WHERE m.tenant_id = NEW.tenant_id AND m.id = NEW.message_id
          AND m.dedupe_key = 'waiver.request:' || NEW.request_id::text || ':'
                             || NEW.generation::text
          AND m.subject_ref = 'waiver_request:' || NEW.request_id::text
          AND m.link_purpose = 'waiver_sign'
          AND m.to_email = NEW.recipient_email
          AND m.next_attempt_at >= NEW.send_after) THEN
    RAISE EXCEPTION 'a delivery names the waiver message queued for its request, generation, and address'
      USING ERRCODE = '23514', CONSTRAINT = 'waiver_deliveries_message';
  END IF;
  RETURN NEW;
END;
$$;
