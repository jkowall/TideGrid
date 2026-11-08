-- Waiver reminders up to a completion cutoff (W1-G215-REMINDERS)
--
-- Pulled into the demo by the owner's decision of 2026-11-08 (see the
-- decision register). Synthetic data only. Contract:
-- packages/domain-waivers/README.md, "Reminders".
--
-- An unsigned waiver gets at most two reminder emails, one in each slot:
-- '72h' from 72 hours before the trip leaves, and '24h' from 24 hours before.
-- None is queued from 2 hours before departure (the completion cutoff). A
-- reminder is not a delivery generation: it never counts against the five
-- generations or the sending limits that hold staff resends (decision D2), and
-- those limits never count it.
--
-- Chain of custody:
--
--   reminder   one per request and slot, for a pending request, queued in its
--              slot's window and before the cutoff, naming the message this
--              same transaction queued under the key waiver.reminder:<request>:<slot>
--              for the request's booking, participant, and subject
--
-- The reminder sweep finds tenants through app.waiver_reminder_tenants, a
-- SECURITY DEFINER function that reads no row's content, and takes its turns
-- through sweep_turns, which gains the sweep name 'waiver_reminder'.
--
-- Tenancy follows packages/database/README.md: tenant_id on every row,
-- composite tenant foreign keys, forced row-level security, SELECT and INSERT
-- from the default privileges, append-only for every role, and no index on a
-- pilot-volume table (rule R4): the unique keys are on this new table.

CREATE TABLE public.waiver_reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  request_id uuid NOT NULL,
  booking_id uuid NOT NULL,
  participant_id uuid NOT NULL,
  slot text NOT NULL CHECK (slot IN ('72h', '24h')),
  message_id uuid NOT NULL,
  recipient_email text NOT NULL CHECK (char_length(recipient_email) BETWEEN 3 AND 320),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  -- Deduplicated across sweeps and retries: one reminder per request and slot.
  CONSTRAINT waiver_reminders_once UNIQUE (tenant_id, request_id, slot),
  CONSTRAINT waiver_reminders_one_message UNIQUE (tenant_id, message_id),
  FOREIGN KEY (tenant_id, message_id) REFERENCES public.email_messages (tenant_id, id),
  FOREIGN KEY (tenant_id, request_id, booking_id, participant_id)
    REFERENCES public.waiver_requests (tenant_id, id, booking_id, participant_id)
);

CREATE FUNCTION app.check_waiver_reminder() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  starts timestamptz;
  hours integer;
  latest record;
BEGIN
  NEW.created_at := pg_catalog.now();
  hours := CASE NEW.slot WHEN '72h' THEN 72 ELSE 24 END;
  SELECT t.starts_at INTO starts
    FROM public.waiver_requests r
    JOIN public.bookings b ON b.tenant_id = r.tenant_id AND b.id = r.booking_id
    JOIN public.scheduled_trips t ON t.tenant_id = b.tenant_id AND t.id = b.trip_id
   WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.request_id
     AND r.booking_id = NEW.booking_id AND r.participant_id = NEW.participant_id
     AND r.state = 'pending'
     -- Serialized with signing, revocation and staff sends, as
     -- app.check_waiver_delivery is, so a reminder cannot commit after the
     -- request stopped waiting.
     FOR NO KEY UPDATE OF r;
  IF starts IS NULL
     OR NEW.created_at < starts - pg_catalog.make_interval(hours => hours)
     OR NEW.created_at >= starts - interval '2 hours' THEN
    RAISE EXCEPTION 'a waiver reminder is for a pending request, in its slot, before the 2 hour cutoff'
      USING ERRCODE = '23514', CONSTRAINT = 'waiver_reminders_window';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.email_messages m
     WHERE m.tenant_id = NEW.tenant_id AND m.id = NEW.message_id
       AND m.dedupe_key = 'waiver.reminder:' || NEW.request_id::text || ':' || NEW.slot
       AND m.booking_id = NEW.booking_id AND m.participant_id = NEW.participant_id
       AND m.subject_ref = 'waiver_request:' || NEW.request_id::text
       AND m.link_purpose = 'waiver_sign'
       AND m.to_email = NEW.recipient_email
       AND m.state = 'queued' AND m.attempts = 0
       AND m.created_at = pg_catalog.now()) THEN
    RAISE EXCEPTION 'a waiver reminder names the reminder email this transaction queued for its request'
      USING ERRCODE = '23514', CONSTRAINT = 'waiver_reminders_message';
  END IF;
  -- Only to the address the latest invitation went to, and only while
  -- nothing since that invitation (it, or a reminder after it) was closed
  -- because the address changed. Signing evidence reads the address from this
  -- row, so it must not be free to choose.
  SELECT d.recipient_email, m.created_at AS sent_from INTO latest
    FROM public.waiver_deliveries d
    JOIN public.email_messages m ON m.tenant_id = d.tenant_id AND m.id = d.message_id
   WHERE d.tenant_id = NEW.tenant_id AND d.request_id = NEW.request_id
   ORDER BY d.generation DESC LIMIT 1;
  IF latest.recipient_email IS NULL
     OR latest.recipient_email IS DISTINCT FROM NEW.recipient_email
     OR EXISTS (SELECT 1 FROM public.email_messages m
                 WHERE m.tenant_id = NEW.tenant_id
                   AND m.subject_ref = 'waiver_request:' || NEW.request_id::text
                   AND m.id <> NEW.message_id
                   AND m.created_at >= latest.sent_from
                   AND ((m.state = 'canceled' AND m.last_error_code = 'recipient_changed')
                        OR EXISTS (SELECT 1 FROM public.guest_access_links l
                                    WHERE l.tenant_id = m.tenant_id AND l.message_id = m.id
                                      AND l.revoked_reason = 'recipient_changed'))) THEN
    RAISE EXCEPTION 'a waiver reminder goes only to the address its latest invitation went to'
      USING ERRCODE = '23514', CONSTRAINT = 'waiver_reminders_recipient';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER waiver_reminders_check BEFORE INSERT ON public.waiver_reminders
  FOR EACH ROW EXECUTE FUNCTION app.check_waiver_reminder();

ALTER TABLE public.waiver_reminders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.waiver_reminders FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.waiver_reminders
  USING (tenant_id = (SELECT app.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()));
CREATE TRIGGER waiver_reminders_no_delete BEFORE DELETE ON public.waiver_reminders
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();
CREATE TRIGGER waiver_reminders_no_truncate BEFORE TRUNCATE ON public.waiver_reminders
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_mutation();
CREATE TRIGGER waiver_reminders_append_only BEFORE UPDATE ON public.waiver_reminders
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();

-- Signing through a reminder link -------------------------------------------------

-- Evidence from an email link records the address that link was sent to. A
-- reminder's message has no delivery generation, so the address comes from
-- its waiver_reminders row instead. Otherwise unchanged from 0020.
CREATE OR REPLACE FUNCTION app.check_waiver_evidence_method() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  link record;
BEGIN
  SELECT l.message_id, a.mode, a.actor_id,
         coalesce(d.recipient_email, w.recipient_email) AS recipient_email
    INTO link
    FROM public.waiver_signing_sessions s
    JOIN public.guest_access_links l ON l.tenant_id = s.tenant_id AND l.id = s.access_link_id
    LEFT JOIN public.waiver_assisted_links a
      ON a.tenant_id = s.tenant_id AND a.access_link_id = s.access_link_id
    LEFT JOIN public.waiver_deliveries d
      ON d.tenant_id = s.tenant_id AND d.message_id = l.message_id
    LEFT JOIN public.waiver_reminders w
      ON w.tenant_id = s.tenant_id AND w.message_id = l.message_id
   WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.session_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'evidence needs its session''s link'
      USING ERRCODE = '23514', CONSTRAINT = 'waiver_evidence_method';
  END IF;
  IF link.message_id IS NULL THEN
    IF link.mode IS NULL OR NEW.access_method IS DISTINCT FROM link.mode
       OR NEW.match_method IS DISTINCT FROM 'staff_confirmed'
       OR NEW.assisted_by IS DISTINCT FROM link.actor_id
       OR NEW.recipient_email IS NOT NULL THEN
      RAISE EXCEPTION 'evidence from a staff-assisted link records its mode, staff_confirmed, and the staff member'
        USING ERRCODE = '23514', CONSTRAINT = 'waiver_evidence_method';
    END IF;
  ELSIF NEW.access_method IS DISTINCT FROM 'email_link'
        OR NEW.match_method IS DISTINCT FROM 'signer_confirmed'
        OR NEW.assisted_by IS NOT NULL
        OR link.recipient_email IS NULL
        OR NEW.recipient_email IS DISTINCT FROM link.recipient_email THEN
    RAISE EXCEPTION 'evidence from an email link records the address that link was sent to'
      USING ERRCODE = '23514', CONSTRAINT = 'waiver_evidence_method';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.check_waiver_evidence_method() FROM PUBLIC;

-- The reminder sweep's turns ------------------------------------------------------

ALTER TABLE public.sweep_turns DROP CONSTRAINT sweep_turns_sweep_check;
ALTER TABLE public.sweep_turns ADD CONSTRAINT sweep_turns_sweep_check
  CHECK (sweep IN ('hold', 'checkout', 'email', 'hostname', 'waiver_reminder'));

-- Tenants with a pending waiver whose trip leaves within 72 hours and not
-- within the 2 hour cutoff, the longest-waiting first. Ids only.
CREATE FUNCTION app.waiver_reminder_tenants(p_limit integer)
  RETURNS TABLE (tenant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT x.tenant_id FROM (
      SELECT DISTINCT r.tenant_id
        FROM public.waiver_requests r
        JOIN public.bookings b ON b.tenant_id = r.tenant_id AND b.id = r.booking_id
        JOIN public.scheduled_trips t ON t.tenant_id = b.tenant_id AND t.id = b.trip_id
       WHERE r.state = 'pending'
         AND t.starts_at > pg_catalog.now() + interval '2 hours'
         AND t.starts_at <= pg_catalog.now() + interval '72 hours'
    ) x
      LEFT JOIN public.sweep_turns s
        ON s.tenant_id = x.tenant_id AND s.sweep = 'waiver_reminder'
     ORDER BY s.last_turn_at ASC NULLS FIRST, x.tenant_id
     LIMIT greatest(1, least(coalesce(p_limit, 100), 1000))
  $$;

REVOKE ALL ON FUNCTION app.check_waiver_reminder() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.waiver_reminder_tenants(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.waiver_reminder_tenants(integer) TO tidegrid_app;
