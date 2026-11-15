-- 0054 waiver evidence's personal fields, sealed by the application (W3-OPS-4)
--
-- Under the owner's go of 2026-11-15 on W3-OPS-4, security hardening before
-- real data (code only, synthetic data). Tenancy follows
-- packages/database/README.md.
--
-- The evidence row named the participant and the signer, the typed
-- signature, the address the link went to, the client address, and the
-- device in plain columns. With field encryption (packages/database/src/
-- field-crypto.ts) the API seals all six into one value, personal_sealed,
-- with AES-256-GCM under a versioned key the database never sees, bound to
-- the tenant and this column. The plain columns stay null on such a row.
-- Rows written before (all synthetic) keep their plain columns.
--
-- The database can no longer compare the recorded address with the one the
-- link was sent to. A sealed email-link row instead names the link's email,
-- link_message_id, and the method trigger holds it to the session's link, so
-- the evidence still proves which delivery the signer followed; the address
-- itself is in that delivery and inside the sealed value.

ALTER TABLE public.waiver_evidence
  ALTER COLUMN participant_name DROP NOT NULL,
  ALTER COLUMN signer_name DROP NOT NULL,
  ALTER COLUMN signature_text DROP NOT NULL,
  ADD COLUMN personal_sealed text
    CHECK (personal_sealed ~ '^tgf1:[a-z0-9]{1,16}:[A-Za-z0-9_-]{24,}$'
           AND char_length(personal_sealed) <= 8000),
  ADD COLUMN link_message_id uuid;

-- coalesce: a CHECK that evaluates to NULL passes.
ALTER TABLE public.waiver_evidence
  ADD CONSTRAINT waiver_evidence_personal_place CHECK (coalesce(
    (personal_sealed IS NULL AND participant_name IS NOT NULL AND signer_name IS NOT NULL
     AND signature_text IS NOT NULL AND link_message_id IS NULL)
    OR (personal_sealed IS NOT NULL AND participant_name IS NULL AND signer_name IS NULL
        AND signature_text IS NULL AND recipient_email IS NULL AND source_ip IS NULL
        AND user_agent IS NULL),
    false));

-- As 0043, and a sealed email-link row names its link's email instead of the
-- address; no other method names one.
ALTER TABLE public.waiver_evidence DROP CONSTRAINT waiver_evidence_method_shape;
ALTER TABLE public.waiver_evidence ADD CONSTRAINT waiver_evidence_method_shape
  CHECK (CASE access_method
           WHEN 'email_link' THEN match_method = 'signer_confirmed' AND assisted_by IS NULL
                                  AND (recipient_email IS NOT NULL
                                       OR (personal_sealed IS NOT NULL
                                           AND link_message_id IS NOT NULL))
           WHEN 'dock_lookup' THEN match_method = 'booking_lookup'
                                   AND recipient_email IS NULL AND assisted_by IS NULL
                                   AND link_message_id IS NULL
           ELSE match_method = 'staff_confirmed'
                AND recipient_email IS NULL AND assisted_by IS NOT NULL
                AND link_message_id IS NULL END);

-- As 0043; an email-link row records the address that link was sent to, or,
-- sealed, that link's email.
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
  IF link.message_id IS NULL AND link.mode = 'dock_lookup' THEN
    IF NEW.access_method IS DISTINCT FROM 'dock_lookup'
       OR NEW.match_method IS DISTINCT FROM 'booking_lookup'
       OR NEW.assisted_by IS NOT NULL
       OR NEW.recipient_email IS NOT NULL
       OR NEW.link_message_id IS NOT NULL THEN
      RAISE EXCEPTION 'evidence from a dock lookup records dock_lookup, booking_lookup, and no staff member or address'
        USING ERRCODE = '23514', CONSTRAINT = 'waiver_evidence_method';
    END IF;
  ELSIF link.message_id IS NULL THEN
    IF link.mode IS NULL OR NEW.access_method IS DISTINCT FROM link.mode
       OR NEW.match_method IS DISTINCT FROM 'staff_confirmed'
       OR NEW.assisted_by IS DISTINCT FROM link.actor_id
       OR NEW.recipient_email IS NOT NULL
       OR NEW.link_message_id IS NOT NULL THEN
      RAISE EXCEPTION 'evidence from a staff-assisted link records its mode, staff_confirmed, and the staff member'
        USING ERRCODE = '23514', CONSTRAINT = 'waiver_evidence_method';
    END IF;
  ELSIF NEW.access_method IS DISTINCT FROM 'email_link'
        OR NEW.match_method IS DISTINCT FROM 'signer_confirmed'
        OR NEW.assisted_by IS NOT NULL
        OR link.recipient_email IS NULL
        OR (NEW.personal_sealed IS NULL
            AND NEW.recipient_email IS DISTINCT FROM link.recipient_email)
        OR (NEW.personal_sealed IS NOT NULL
            AND NEW.link_message_id IS DISTINCT FROM link.message_id) THEN
    RAISE EXCEPTION 'evidence from an email link records the address that link was sent to'
      USING ERRCODE = '23514', CONSTRAINT = 'waiver_evidence_method';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app.check_waiver_evidence_method() FROM PUBLIC;
