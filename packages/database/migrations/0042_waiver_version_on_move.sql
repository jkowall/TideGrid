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
-- this way; only in the transaction that moved its booking (the move row was
-- written by this very transaction, by its xmin, so a move committed by
-- another transaction meanwhile does not count); and only when the version
-- it was signed on is no longer the one in effect for the booking's product
-- (the same choice as the waiver module: a product template before the
-- operator template, the highest version in effect on the database clock;
-- templates.ts findApplicableVersion must stay the same). A move written
-- under a savepoint carries the savepoint's id instead, so this fails closed
-- and the move rolls back; the move uses no savepoint.

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
DECLARE
  applicable_template uuid;
  applicable_version integer;
BEGIN
  IF NEW.state = 'revoked' AND NEW.revoked_reason = 'version_changed'
     AND OLD.state IS DISTINCT FROM 'revoked' THEN
    IF OLD.state <> 'signed' THEN
      RAISE EXCEPTION 'only a signed waiver request ends because its version changed'
        USING ERRCODE = '23514', CONSTRAINT = 'waiver_requests_version_changed';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.booking_reschedules m
                    WHERE m.tenant_id = NEW.tenant_id AND m.booking_id = NEW.booking_id
                      AND m.xmin = pg_current_xact_id()::xid) THEN
      RAISE EXCEPTION 'a signature ends for a changed version only when its booking moves'
        USING ERRCODE = '23514', CONSTRAINT = 'waiver_requests_version_changed';
    END IF;
    SELECT v.template_id, v.version INTO applicable_template, applicable_version
      FROM public.bookings b
      JOIN public.scheduled_trips t ON t.tenant_id = b.tenant_id AND t.id = b.trip_id
      JOIN public.waiver_templates w ON w.tenant_id = b.tenant_id
       AND (w.scope = 'operator' OR (w.scope = 'product' AND w.product_id = t.product_id))
      JOIN public.waiver_template_versions v ON v.tenant_id = w.tenant_id AND v.template_id = w.id
     WHERE b.tenant_id = NEW.tenant_id AND b.id = NEW.booking_id
       AND v.effective_from <= clock_timestamp()
       AND (v.effective_until IS NULL OR v.effective_until > clock_timestamp())
     ORDER BY (w.scope = 'product') DESC, v.version DESC
     LIMIT 1;
    IF applicable_template IS NULL
       OR (applicable_template = OLD.template_id AND applicable_version = OLD.template_version) THEN
      RAISE EXCEPTION 'a signature on the version still in effect does not end as a changed version'
        USING ERRCODE = '23514', CONSTRAINT = 'waiver_requests_version_changed';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER waiver_requests_version_changed BEFORE UPDATE ON public.waiver_requests
  FOR EACH ROW EXECUTE FUNCTION app.check_waiver_version_changed();

REVOKE ALL ON FUNCTION app.check_waiver_version_changed() FROM PUBLIC;
