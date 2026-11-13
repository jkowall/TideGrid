-- W3-G2.15-rest: a signed waiver carries over a booking move only while its
-- version still applies (owner decision 2026-11-13, docs/v2/06).
--
-- A booking moved to another trip keeps its waiver requests: signatures stay
-- with the booking. When the operator published a newer version since a
-- person signed, the move ends that signature with a new reason,
-- `version_changed`, and the waiver module assigns the version in effect now.
-- Every new booking still signs afresh (re-sign policy every_booking), and no
-- signature reaches another booking.
--
-- The database holds the new reason to its case: only a signed request ends
-- this way, and only right after its booking moved: a move of the booking
-- written since this transaction began (0034 stamps a move with the clock at
-- its insert, which in the moving transaction is never before now()).

ALTER TABLE public.waiver_requests DROP CONSTRAINT waiver_requests_revoked_reason_check;
ALTER TABLE public.waiver_requests
  ADD CONSTRAINT waiver_requests_revoked_reason_check CHECK (revoked_reason IN (
    'participant_removed', 'participant_changed', 'booking_canceled', 'version_changed'));

ALTER TABLE public.waiver_signing_sessions
  DROP CONSTRAINT waiver_signing_sessions_revoked_reason_check;
ALTER TABLE public.waiver_signing_sessions
  ADD CONSTRAINT waiver_signing_sessions_revoked_reason_check CHECK (revoked_reason IN (
    'participant_removed', 'participant_changed', 'booking_canceled', 'superseded',
    'recipient_changed', 'completed', 'signed_out', 'version_changed'));

-- Beside 0010's request rules, which keep the one-way states.
CREATE FUNCTION app.check_waiver_version_changed() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF NEW.state = 'revoked' AND NEW.revoked_reason = 'version_changed'
     AND OLD.state IS DISTINCT FROM 'revoked' THEN
    IF OLD.state <> 'signed' THEN
      RAISE EXCEPTION 'only a signed waiver request ends because its version changed'
        USING ERRCODE = '23514', CONSTRAINT = 'waiver_requests_version_changed';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.booking_reschedules m
                    WHERE m.tenant_id = NEW.tenant_id AND m.booking_id = NEW.booking_id
                      AND m.created_at >= now()) THEN
      RAISE EXCEPTION 'a signature ends for a changed version only when its booking moves'
        USING ERRCODE = '23514', CONSTRAINT = 'waiver_requests_version_changed';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER waiver_requests_version_changed BEFORE UPDATE ON public.waiver_requests
  FOR EACH ROW EXECUTE FUNCTION app.check_waiver_version_changed();

REVOKE ALL ON FUNCTION app.check_waiver_version_changed() FROM PUBLIC;
