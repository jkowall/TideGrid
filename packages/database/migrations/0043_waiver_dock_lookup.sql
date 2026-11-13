-- W3-G2.15-rest: the generic dock QR (owner decision 2026-11-13, docs/v2/06).
--
-- One QR code posted at the dock opens the guest site's dock page. A guest
-- types the booking code and the booker's last name. A match shows only that
-- booking's own party, only for a trip that departs that day, and lets the
-- guest sign on their own phone with no email. Tries are limited so the page
-- cannot be used to fish for names, and a miss never says why.
--
-- Two pieces:
--
--   waiver_dock_lookups  every try, matched or not, append-only. A match
--                        carries a 15-minute secret (only its hash) that
--                        lists the party and starts signings. The database
--                        holds the limits for every writer, counted under
--                        advisory locks:
--                          - 10 misses from one client address in 15 minutes
--                          - 5 misses for one booking code in an hour, from
--                            anywhere, so one code cannot be tried name by
--                            name from many addresses
--                          - 300 misses at one operator in an hour
--                          - 20 matches from one client address in an hour
--                        A match must name a confirmed booking with that
--                        code whose trip departs today, in the trip's own
--                        time zone, and has not ended.
--   waiver_assisted_links gains the mode `dock_lookup`: the signing link a
--                        matched lookup starts, written by the guest, not by
--                        staff, naming its lookup. The session and evidence
--                        rules of 0020 then hold as they are, with the
--                        evidence recording `dock_lookup` and the match
--                        method `booking_lookup`, no staff member, and no
--                        address.
--
-- The last-name comparison is the service's (Unicode-normalized, the last
-- word or words of the booker's name). The database checks the code, the
-- booking, and the day.
--
-- Tenancy follows packages/database/README.md: tenant_id on every row,
-- composite tenant foreign keys, forced row-level security, SELECT and INSERT
-- from the default privileges, append-only for every role.

CREATE TABLE public.waiver_dock_lookups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  -- The code as typed, normalized (upper case, Crockford's look-alikes
  -- folded, separators dropped). Never a name: the last name is not stored.
  reference_key text NOT NULL CHECK (reference_key ~ '^[0-9A-Z]{1,16}$'),
  -- The client address, from the transaction's context, as the audit log
  -- keeps it.
  client_key text NOT NULL DEFAULT coalesce(app.setting_or_null('app.source_ip'), 'unknown')
    CHECK (char_length(client_key) BETWEEN 1 AND 100),
  matched boolean NOT NULL,
  booking_id uuid,
  secret_hash text CHECK (secret_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  actor_type text NOT NULL DEFAULT coalesce(app.setting_or_null('app.actor_type'), 'system')
    CHECK (actor_type = 'guest'),
  api_request_id text DEFAULT app.setting_or_null('app.request_id'),
  CHECK (matched = (booking_id IS NOT NULL)
         AND matched = (secret_hash IS NOT NULL)
         AND matched = (expires_at IS NOT NULL)),
  UNIQUE (tenant_id, id),
  CONSTRAINT waiver_dock_lookups_secret_key UNIQUE (secret_hash),
  FOREIGN KEY (tenant_id, booking_id) REFERENCES public.bookings (tenant_id, id)
);
CREATE INDEX waiver_dock_lookups_client_idx
  ON public.waiver_dock_lookups (tenant_id, client_key, created_at);
CREATE INDEX waiver_dock_lookups_reference_idx
  ON public.waiver_dock_lookups (tenant_id, reference_key, created_at);

-- Why a lookup may not be tried now, or null. Takes the client's and the
-- code's advisory locks first, so the count it reads is the one the insert
-- trigger reads, and two tries of one client or one code never pass a limit
-- together. Invoker's rights: the counts read the caller's tenant only.
CREATE FUNCTION app.waiver_dock_refusal(p_reference_key text, p_matched boolean)
  RETURNS text
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_tenant uuid := app.current_tenant_id();
  v_client text := coalesce(app.setting_or_null('app.source_ip'), 'unknown');
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('tidegrid.waiver_dock_client:' || v_tenant::text || ':' || v_client, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('tidegrid.waiver_dock_code:' || v_tenant::text || ':' || p_reference_key, 0));
  IF (SELECT count(*) FROM public.waiver_dock_lookups
       WHERE tenant_id = v_tenant AND client_key = v_client AND NOT matched
         AND created_at > now() - interval '15 minutes') >= 10 THEN
    RETURN 'client';
  END IF;
  IF (SELECT count(*) FROM public.waiver_dock_lookups
       WHERE tenant_id = v_tenant AND reference_key = p_reference_key AND NOT matched
         AND created_at > now() - interval '1 hour') >= 5 THEN
    RETURN 'code';
  END IF;
  IF (SELECT count(*) FROM public.waiver_dock_lookups
       WHERE tenant_id = v_tenant AND NOT matched
         AND created_at > now() - interval '1 hour') >= 300 THEN
    RETURN 'operator';
  END IF;
  IF p_matched AND (SELECT count(*) FROM public.waiver_dock_lookups
       WHERE tenant_id = v_tenant AND client_key = v_client AND matched
         AND created_at > now() - interval '1 hour') >= 20 THEN
    RETURN 'client';
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION app.check_waiver_dock_lookup() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_refusal text;
BEGIN
  NEW.created_at := now();
  NEW.client_key := coalesce(app.setting_or_null('app.source_ip'), 'unknown');
  NEW.actor_type := coalesce(app.setting_or_null('app.actor_type'), 'system');
  NEW.api_request_id := app.setting_or_null('app.request_id');
  IF NEW.actor_type IS DISTINCT FROM 'guest' THEN
    RAISE EXCEPTION 'a dock lookup is a guest''s'
      USING ERRCODE = '23514', CONSTRAINT = 'waiver_dock_lookups_actor';
  END IF;
  v_refusal := app.waiver_dock_refusal(NEW.reference_key, NEW.matched);
  IF v_refusal IS NOT NULL THEN
    RAISE EXCEPTION 'too many dock lookups (%)', v_refusal
      USING ERRCODE = '23514', CONSTRAINT = 'waiver_dock_lookups_limit';
  END IF;
  IF NEW.matched THEN
    NEW.expires_at := now() + interval '15 minutes';
    IF NOT EXISTS (
         SELECT 1
           FROM public.bookings b
           JOIN public.scheduled_trips t ON t.tenant_id = b.tenant_id AND t.id = b.trip_id
          WHERE b.tenant_id = NEW.tenant_id AND b.id = NEW.booking_id
            AND b.reference = NEW.reference_key
            AND b.state = 'confirmed'
            AND t.ends_at > now()
            AND (t.starts_at AT TIME ZONE t.time_zone)::date = (now() AT TIME ZONE t.time_zone)::date) THEN
      RAISE EXCEPTION 'a dock lookup matches a confirmed booking with its code whose trip departs today'
        USING ERRCODE = '23514', CONSTRAINT = 'waiver_dock_lookups_booking';
    END IF;
  ELSE
    NEW.expires_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER waiver_dock_lookups_check BEFORE INSERT ON public.waiver_dock_lookups
  FOR EACH ROW EXECUTE FUNCTION app.check_waiver_dock_lookup();

ALTER TABLE public.waiver_dock_lookups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.waiver_dock_lookups FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.waiver_dock_lookups
  USING (tenant_id = (SELECT app.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()));
CREATE TRIGGER waiver_dock_lookups_no_delete BEFORE DELETE ON public.waiver_dock_lookups
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();
CREATE TRIGGER waiver_dock_lookups_no_truncate BEFORE TRUNCATE ON public.waiver_dock_lookups
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_mutation();
CREATE TRIGGER waiver_dock_lookups_append_only BEFORE UPDATE ON public.waiver_dock_lookups
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();

-- Signing links a lookup starts ----------------------------------------------------

ALTER TABLE public.waiver_assisted_links DROP CONSTRAINT waiver_assisted_links_mode_check;
ALTER TABLE public.waiver_assisted_links ADD CONSTRAINT waiver_assisted_links_mode_check
  CHECK (mode IN ('staff_device', 'participant_qr', 'dock_lookup'));
ALTER TABLE public.waiver_assisted_links DROP CONSTRAINT waiver_assisted_links_actor_type_check;
ALTER TABLE public.waiver_assisted_links ALTER COLUMN actor_id DROP NOT NULL;
ALTER TABLE public.waiver_assisted_links ADD COLUMN dock_lookup_id uuid;
ALTER TABLE public.waiver_assisted_links ADD CONSTRAINT waiver_assisted_links_dock_lookup_fkey
  FOREIGN KEY (tenant_id, dock_lookup_id) REFERENCES public.waiver_dock_lookups (tenant_id, id);
-- Staff start the staff modes, by name; a guest's lookup starts dock_lookup,
-- with no staff member.
ALTER TABLE public.waiver_assisted_links ADD CONSTRAINT waiver_assisted_links_mode_actor
  CHECK (CASE WHEN mode = 'dock_lookup'
              THEN actor_type = 'guest' AND actor_id IS NULL AND dock_lookup_id IS NOT NULL
              ELSE actor_type = 'staff' AND actor_id IS NOT NULL AND dock_lookup_id IS NULL END);
-- Most signing links a single lookup starts in its 15 minutes.
CREATE INDEX waiver_assisted_links_dock_lookup_idx
  ON public.waiver_assisted_links (tenant_id, dock_lookup_id) WHERE dock_lookup_id IS NOT NULL;

-- As 0020, and a dock_lookup start needs its guest actor and a matched lookup
-- of the same booking still in its 15 minutes, whose trip has not ended.
CREATE OR REPLACE FUNCTION app.check_waiver_assisted_link() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  NEW.created_at := now();
  NEW.actor_type := coalesce(app.setting_or_null('app.actor_type'), 'system');
  NEW.actor_id := app.setting_or_null('app.actor_id');
  NEW.api_request_id := app.setting_or_null('app.request_id');
  IF NEW.mode = 'dock_lookup' THEN
    IF NEW.actor_type IS DISTINCT FROM 'guest' THEN
      RAISE EXCEPTION 'a dock lookup''s signing is started by the guest'
        USING ERRCODE = '23514', CONSTRAINT = 'waiver_assisted_links_actor';
    END IF;
    NEW.actor_id := NULL;
    IF NOT EXISTS (
         SELECT 1
           FROM public.waiver_dock_lookups k
           JOIN public.bookings b ON b.tenant_id = k.tenant_id AND b.id = k.booking_id
           JOIN public.scheduled_trips t ON t.tenant_id = b.tenant_id AND t.id = b.trip_id
          WHERE k.tenant_id = NEW.tenant_id AND k.id = NEW.dock_lookup_id
            AND k.matched AND k.expires_at > now()
            AND k.booking_id = NEW.booking_id
            AND b.state = 'confirmed' AND t.ends_at > now()) THEN
      RAISE EXCEPTION 'a dock signing needs a matched lookup of its booking, within its 15 minutes'
        USING ERRCODE = '23514', CONSTRAINT = 'waiver_assisted_links_dock';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('tidegrid.waiver_dock_lookup:' || NEW.dock_lookup_id::text, 0));
    IF (SELECT count(*) FROM public.waiver_assisted_links a
         WHERE a.tenant_id = NEW.tenant_id AND a.dock_lookup_id = NEW.dock_lookup_id) >= 30 THEN
      RAISE EXCEPTION 'a dock lookup starts at most 30 signings'
        USING ERRCODE = '23514', CONSTRAINT = 'waiver_assisted_links_dock';
    END IF;
  ELSIF NEW.actor_type IS DISTINCT FROM 'staff' OR NEW.actor_id IS NULL THEN
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

-- Evidence -------------------------------------------------------------------------

ALTER TABLE public.waiver_evidence DROP CONSTRAINT waiver_evidence_access_method_check;
ALTER TABLE public.waiver_evidence ADD CONSTRAINT waiver_evidence_access_method_check
  CHECK (access_method IN ('email_link', 'staff_device', 'participant_qr', 'dock_lookup'));
ALTER TABLE public.waiver_evidence DROP CONSTRAINT waiver_evidence_match_method_check;
ALTER TABLE public.waiver_evidence ADD CONSTRAINT waiver_evidence_match_method_check
  CHECK (match_method IN ('signer_confirmed', 'staff_confirmed', 'booking_lookup'));
ALTER TABLE public.waiver_evidence DROP CONSTRAINT waiver_evidence_method_shape;
ALTER TABLE public.waiver_evidence ADD CONSTRAINT waiver_evidence_method_shape
  CHECK (CASE access_method
           WHEN 'email_link' THEN match_method = 'signer_confirmed'
                                  AND recipient_email IS NOT NULL AND assisted_by IS NULL
           WHEN 'dock_lookup' THEN match_method = 'booking_lookup'
                                   AND recipient_email IS NULL AND assisted_by IS NULL
           ELSE match_method = 'staff_confirmed'
                AND recipient_email IS NULL AND assisted_by IS NOT NULL END);

-- As 0025, and evidence from a dock lookup's link records dock_lookup,
-- booking_lookup, no staff member, and no address.
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
       OR NEW.recipient_email IS NOT NULL THEN
      RAISE EXCEPTION 'evidence from a dock lookup records dock_lookup, booking_lookup, and no staff member or address'
        USING ERRCODE = '23514', CONSTRAINT = 'waiver_evidence_method';
    END IF;
  ELSIF link.message_id IS NULL THEN
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

REVOKE ALL ON FUNCTION app.check_waiver_dock_lookup() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.check_waiver_assisted_link() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.check_waiver_evidence_method() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.waiver_dock_refusal(text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.waiver_dock_refusal(text, boolean) TO tidegrid_app;
