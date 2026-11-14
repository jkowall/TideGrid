-- 0052 email freshness in write order (W3-G2.11-rest follow-up)
--
-- Under the owner's go of 2026-11-10 on the rest of Wave 3 (code only,
-- synthetic data). Tenancy follows packages/database/README.md.
--
-- Delivery cancels a link email as stale when a link of its booking and
-- purpose was revoked after the email was written, as when the booker's
-- address is corrected (0037). "Written" was the message's created_at, the
-- start of the transaction that wrote it. A command that waited on the
-- booking's locks behind a correction (a move, say) wrote its email after
-- the correction committed, to the new address, but its transaction had
-- started earlier, so delivery canceled the email the booker should get.
--
-- written_at is the moment the row itself was inserted (clock_timestamp()),
-- which, for a writer that waited on a lock, is after the correction it
-- waited on committed. The insert trigger stamps it; nothing changes it.
-- Rows written before this migration have none, and delivery reads their
-- created_at as before.

ALTER TABLE public.email_messages ADD COLUMN written_at timestamptz;

CREATE FUNCTION app.stamp_email_written_at() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.written_at := pg_catalog.clock_timestamp();
  ELSE
    NEW.written_at := OLD.written_at;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.stamp_email_written_at() FROM PUBLIC;
CREATE TRIGGER email_messages_written_at BEFORE INSERT OR UPDATE ON public.email_messages
  FOR EACH ROW EXECUTE FUNCTION app.stamp_email_written_at();
