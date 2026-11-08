-- Staff-assisted and QR waiver signing (W1-G215-SIGNING)
--
-- Pulled into the demo by the owner's decision of 2026-11-08 (see the
-- decision register). Synthetic data only. Contract:
-- packages/domain-waivers/README.md, "Staff-assisted and QR signing".
--
-- Staff at the dock start a signing for one pending request: either on the
-- staff device (staff_device) or as a QR code the signer scans
-- (participant_qr). Either way the staff member first confirms that they
-- checked who the signer is. That start issues a waiver link that no email
-- carries (guest_access_links.message_id is null), lasting at most 15 minutes,
-- single-use, and records it here, with the staff member as the actor. The
-- link's token travels only in the staff response: on the QR code, or in the
-- address the staff device opens. Only its hash is stored, as for every link.
--
-- Chain of custody, added to 0010's:
--
--   assisted link    requires  a waiver link with no message, issued in this
--                              same transaction for this pending request,
--                              expiring within 15 minutes, by a staff actor
--   signing session  from a link with no message requires its assisted row,
--                              and lasts at most 15 minutes
--   evidence         from an assisted link records its mode as the access
--                              method, match method staff_confirmed, the staff
--                              actor, and no recipient address; from an email
--                              link, the address that link's delivery went to
--
-- A signing session may also be ended by its own page (signed_out): the
-- shared-device cleanup after a signature or 2 minutes idle.
--
-- Tenancy follows packages/database/README.md: tenant_id on every row,
-- composite tenant foreign keys, forced row-level security, SELECT and INSERT
-- from the default privileges, append-only for every role, and no index on a
-- pilot-volume table (rule R4): the two unique keys are on this new table.

CREATE TABLE public.waiver_assisted_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  access_link_id uuid NOT NULL,
  request_id uuid NOT NULL,
  booking_id uuid NOT NULL,
  participant_id uuid NOT NULL,
  mode text NOT NULL CHECK (mode IN ('staff_device', 'participant_qr')),
  -- The staff member ticked that they checked who signs (decision D2).
  identity_checked boolean NOT NULL CHECK (identity_checked),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Stamped from the transaction's context; only staff start a signing.
  actor_type text NOT NULL DEFAULT coalesce(app.setting_or_null('app.actor_type'), 'system')
    CHECK (actor_type = 'staff'),
  actor_id text NOT NULL DEFAULT app.setting_or_null('app.actor_id')
    CHECK (char_length(actor_id) BETWEEN 1 AND 200),
  api_request_id text DEFAULT app.setting_or_null('app.request_id'),
  UNIQUE (tenant_id, id),
  CONSTRAINT waiver_assisted_links_one_per_link UNIQUE (tenant_id, access_link_id),
  FOREIGN KEY (tenant_id, access_link_id) REFERENCES public.guest_access_links (tenant_id, id),
  FOREIGN KEY (tenant_id, request_id, booking_id, participant_id)
    REFERENCES public.waiver_requests (tenant_id, id, booking_id, participant_id)
);

CREATE FUNCTION app.check_waiver_assisted_link() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  NEW.created_at := now();
  NEW.actor_type := coalesce(app.setting_or_null('app.actor_type'), 'system');
  NEW.actor_id := app.setting_or_null('app.actor_id');
  NEW.api_request_id := app.setting_or_null('app.request_id');
  IF NEW.actor_type IS DISTINCT FROM 'staff' OR NEW.actor_id IS NULL THEN
    RAISE EXCEPTION 'only a staff member starts an assisted waiver signing'
      USING ERRCODE = '23514', CONSTRAINT = 'waiver_assisted_links_actor';
  END IF;
  IF NOT EXISTS (
       SELECT 1
         FROM public.guest_access_links l
         JOIN public.waiver_requests r
           ON r.tenant_id = l.tenant_id AND r.id = NEW.request_id
        WHERE l.tenant_id = NEW.tenant_id AND l.id = NEW.access_link_id
          AND l.purpose = 'waiver_sign'
          AND l.message_id IS NULL
          AND l.created_at = now()
          AND l.consumed_at IS NULL AND l.revoked_at IS NULL
          AND l.expires_at <= now() + interval '15 minutes'
          AND l.booking_id = NEW.booking_id
          AND l.participant_id = NEW.participant_id
          AND l.subject_ref = 'waiver_request:' || NEW.request_id::text
          AND r.booking_id = NEW.booking_id
          AND r.participant_id = NEW.participant_id
          AND r.state = 'pending') THEN
    RAISE EXCEPTION 'an assisted signing names a new 15-minute waiver link with no email, for its pending request'
      USING ERRCODE = '23514', CONSTRAINT = 'waiver_assisted_links_link';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER waiver_assisted_links_check BEFORE INSERT ON public.waiver_assisted_links
  FOR EACH ROW EXECUTE FUNCTION app.check_waiver_assisted_link();

ALTER TABLE public.waiver_assisted_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.waiver_assisted_links FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.waiver_assisted_links
  USING (tenant_id = (SELECT app.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()));
CREATE TRIGGER waiver_assisted_links_no_delete BEFORE DELETE ON public.waiver_assisted_links
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();
CREATE TRIGGER waiver_assisted_links_no_truncate BEFORE TRUNCATE ON public.waiver_assisted_links
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_mutation();
CREATE TRIGGER waiver_assisted_links_append_only BEFORE UPDATE ON public.waiver_assisted_links
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();

-- Signing sessions ------------------------------------------------------------------

ALTER TABLE public.waiver_signing_sessions
  DROP CONSTRAINT waiver_signing_sessions_revoked_reason_check;
ALTER TABLE public.waiver_signing_sessions
  ADD CONSTRAINT waiver_signing_sessions_revoked_reason_check CHECK (revoked_reason IN (
    'participant_removed', 'participant_changed', 'booking_canceled', 'superseded',
    'recipient_changed', 'completed', 'signed_out'));

-- A session from a link that no email carried needs that link's assisted row,
-- and lasts at most 15 minutes. Runs beside 0010's session check.
CREATE FUNCTION app.check_waiver_assisted_session() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF EXISTS (
       SELECT 1 FROM public.guest_access_links l
        WHERE l.tenant_id = NEW.tenant_id AND l.id = NEW.access_link_id
          AND l.message_id IS NULL) THEN
    IF NOT EXISTS (
         SELECT 1 FROM public.waiver_assisted_links a
          WHERE a.tenant_id = NEW.tenant_id AND a.access_link_id = NEW.access_link_id
            AND a.request_id = NEW.request_id) THEN
      RAISE EXCEPTION 'a waiver link with no email opens a session only as a staff-assisted signing'
        USING ERRCODE = '23514', CONSTRAINT = 'waiver_signing_sessions_assisted';
    END IF;
    IF NEW.expires_at > now() + interval '15 minutes' THEN
      RAISE EXCEPTION 'a staff-assisted signing session lasts at most 15 minutes'
        USING ERRCODE = '23514', CONSTRAINT = 'waiver_signing_sessions_assisted';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER waiver_signing_sessions_z_assisted BEFORE INSERT ON public.waiver_signing_sessions
  FOR EACH ROW EXECUTE FUNCTION app.check_waiver_assisted_session();

-- Evidence ---------------------------------------------------------------------------

ALTER TABLE public.waiver_evidence DROP CONSTRAINT waiver_evidence_access_method_check;
ALTER TABLE public.waiver_evidence DROP CONSTRAINT waiver_evidence_match_method_check;
ALTER TABLE public.waiver_evidence ALTER COLUMN recipient_email DROP NOT NULL;
ALTER TABLE public.waiver_evidence ADD COLUMN assisted_by text
  CHECK (char_length(assisted_by) BETWEEN 1 AND 200);
ALTER TABLE public.waiver_evidence ADD CONSTRAINT waiver_evidence_access_method_check
  CHECK (access_method IN ('email_link', 'staff_device', 'participant_qr'));
ALTER TABLE public.waiver_evidence ADD CONSTRAINT waiver_evidence_match_method_check
  CHECK (match_method IN ('signer_confirmed', 'staff_confirmed'));
ALTER TABLE public.waiver_evidence ADD CONSTRAINT waiver_evidence_method_shape
  CHECK ((access_method = 'email_link') = (match_method = 'signer_confirmed')
         AND (access_method = 'email_link') = (recipient_email IS NOT NULL)
         AND (access_method = 'email_link') = (assisted_by IS NULL));

-- How the signer arrived, read from the session's own link, never from the
-- writer: an assisted link's mode and staff actor, or an email link's address.
-- Runs after 0010's evidence check (trigger names sort).
CREATE FUNCTION app.check_waiver_evidence_method() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  link record;
BEGIN
  SELECT l.message_id, a.mode, a.actor_id, d.recipient_email
    INTO link
    FROM public.waiver_signing_sessions s
    JOIN public.guest_access_links l ON l.tenant_id = s.tenant_id AND l.id = s.access_link_id
    LEFT JOIN public.waiver_assisted_links a
      ON a.tenant_id = s.tenant_id AND a.access_link_id = s.access_link_id
    LEFT JOIN public.waiver_deliveries d
      ON d.tenant_id = s.tenant_id AND d.message_id = l.message_id
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
CREATE TRIGGER waiver_evidence_method BEFORE INSERT ON public.waiver_evidence
  FOR EACH ROW EXECUTE FUNCTION app.check_waiver_evidence_method();

REVOKE ALL ON FUNCTION app.check_waiver_assisted_link() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.check_waiver_assisted_session() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.check_waiver_evidence_method() FROM PUBLIC;
