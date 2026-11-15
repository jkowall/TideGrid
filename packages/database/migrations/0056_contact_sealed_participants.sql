-- 0056 guest contact details sealed by the application, part 2 (W3-OPS-4)
--
-- Owner decision 2026-11-15: encrypt every guest contact detail, in phases.
-- Part 1 (0055) sealed the booker. This part seals the people named in a
-- party: a participant's name and email, and a minor's guardian's name and
-- email. Tenancy follows packages/database/README.md.
--
-- With a keyring (packages/database/src/contact-crypto.ts) the API seals
-- {name, email, guardianName, guardianEmail} into contact_sealed, bound to
-- the tenant and the column, and keeps the blind index token of each address
-- (purpose `email`, as 0055): email_index and guardian_email_index. Nothing
-- searches participants by name, so no name tokens are kept.
--
-- A participant's invitation goes to their own address, or a minor's
-- guardian's, and the database checks that (0036). For a sealed participant
-- it compares tokens, so every email message now also records the token of
-- the address it goes to (email_messages.to_email_index), written by the
-- application wherever a keyring is set. The address itself stays plain on
-- the message until the next part seals the outbox.
--
-- Rows written before stay plain and keep working; a row never moves between
-- plain and sealed. No row is rewritten.

-- 1. Participants --------------------------------------------------------------------

ALTER TABLE public.booking_participants
  ALTER COLUMN full_name DROP NOT NULL,
  ADD COLUMN contact_sealed text
    CHECK (contact_sealed ~ '^tgf1:[a-z0-9]{1,16}:[A-Za-z0-9_-]{24,}$' AND char_length(contact_sealed) <= 4000),
  ADD COLUMN email_index text CHECK (email_index ~ '^[0-9a-f]{64}$'),
  ADD COLUMN guardian_email_index text CHECK (guardian_email_index ~ '^[0-9a-f]{64}$');

-- As 0009, for both shapes. coalesce: a CHECK that evaluates to NULL passes.
-- A sealed minor has a guardian, so a guardian's address token; a sealed
-- adult has none.
ALTER TABLE public.booking_participants DROP CONSTRAINT booking_participants_guardian;
ALTER TABLE public.booking_participants
  ADD CONSTRAINT booking_participants_guardian CHECK (coalesce(
    (contact_sealed IS NULL AND email_index IS NULL AND guardian_email_index IS NULL
     AND full_name IS NOT NULL
     AND ((is_minor AND guardian_name IS NOT NULL AND guardian_email IS NOT NULL)
          OR (NOT is_minor AND guardian_name IS NULL AND guardian_email IS NULL)))
    OR (contact_sealed IS NOT NULL AND full_name IS NULL AND email IS NULL
        AND guardian_name IS NULL AND guardian_email IS NULL
        AND is_minor = (guardian_email_index IS NOT NULL)),
    false));

-- 0035's rules, with the sealed columns: a removal changes none of them, and
-- a correction never moves a participant between plain and sealed.
CREATE OR REPLACE FUNCTION app.check_booking_participant() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  b record;
BEGIN
  IF TG_OP = 'UPDATE' AND (
       NEW.id IS DISTINCT FROM OLD.id
       OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.booking_id IS DISTINCT FROM OLD.booking_id
       OR NEW.position IS DISTINCT FROM OLD.position
       OR NEW.created_at IS DISTINCT FROM OLD.created_at) THEN
    RAISE EXCEPTION 'a participant keeps its booking and its place in the party'
      USING ERRCODE = '23514', CONSTRAINT = 'booking_participants_immutable';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.removed_at IS NOT NULL THEN
    RAISE EXCEPTION 'participant % was removed; it no longer changes', OLD.id
      USING ERRCODE = '23514', CONSTRAINT = 'booking_participants_removed';
  END IF;
  -- A participant stays where it was written: plain stays plain, sealed stays sealed.
  IF TG_OP = 'UPDATE' AND (NEW.contact_sealed IS NULL) <> (OLD.contact_sealed IS NULL) THEN
    RAISE EXCEPTION 'a participant''s details stay sealed, or stay plain'
      USING ERRCODE = '23514', CONSTRAINT = 'booking_participants_contact_place';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.removed_at IS NOT NULL THEN
    RAISE EXCEPTION 'a participant joins a party; it is removed only with a party change'
      USING ERRCODE = '23514', CONSTRAINT = 'booking_participants_removed';
  END IF;
  SELECT x.state, x.party_size, s.party_size AS sold_party_size INTO b
    FROM public.bookings x
    JOIN public.checkout_sessions s
      ON s.tenant_id = x.tenant_id AND s.id = x.checkout_session_id
   WHERE x.tenant_id = NEW.tenant_id AND x.id = NEW.booking_id
     FOR SHARE OF x;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no booking % for this tenant', NEW.booking_id
      USING ERRCODE = '23503', CONSTRAINT = 'booking_participants_booking';
  END IF;
  IF b.state <> 'confirmed' THEN
    RAISE EXCEPTION 'booking % is %; its party no longer changes', NEW.booking_id, b.state
      USING ERRCODE = '23514', CONSTRAINT = 'booking_participants_booking_open';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.removed_at IS NOT NULL THEN
    -- The removal itself: nothing else changes, and its change row names it.
    IF NEW.full_name IS DISTINCT FROM OLD.full_name
       OR NEW.is_minor IS DISTINCT FROM OLD.is_minor
       OR NEW.email IS DISTINCT FROM OLD.email
       OR NEW.guardian_name IS DISTINCT FROM OLD.guardian_name
       OR NEW.guardian_email IS DISTINCT FROM OLD.guardian_email
       OR NEW.contact_sealed IS DISTINCT FROM OLD.contact_sealed
       OR NEW.email_index IS DISTINCT FROM OLD.email_index
       OR NEW.guardian_email_index IS DISTINCT FROM OLD.guardian_email_index
       OR NOT EXISTS (
         SELECT 1 FROM public.booking_party_changes c
          WHERE c.tenant_id = NEW.tenant_id AND c.booking_id = NEW.booking_id
            AND c.participant_id = NEW.id) THEN
      RAISE EXCEPTION 'participant % is removed only with its party change, as it stands', NEW.id
        USING ERRCODE = '23514', CONSTRAINT = 'booking_participants_removed';
    END IF;
    NEW.removed_at := now();
    NEW.updated_at := now();
    RETURN NEW;
  END IF;
  -- Places run 1 to the party size the booking was sold with (fixed on its
  -- checkout), less those given up; a change not yet applied in the same
  -- transaction never opens an extra place.
  IF NEW.position > b.sold_party_size THEN
    RAISE EXCEPTION 'booking % has % places; there is no place %',
      NEW.booking_id, b.party_size, NEW.position
      USING ERRCODE = '23514', CONSTRAINT = 'booking_participants_party_size';
  END IF;
  IF EXISTS (
       SELECT 1 FROM public.booking_party_changes c
        WHERE c.tenant_id = NEW.tenant_id AND c.booking_id = NEW.booking_id
          AND c.position = NEW.position) THEN
    RAISE EXCEPTION 'place % of booking % was given up', NEW.position, NEW.booking_id
      USING ERRCODE = '23514', CONSTRAINT = 'booking_participants_removed';
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := now();
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

GRANT UPDATE (contact_sealed, email_index, guardian_email_index)
  ON public.booking_participants TO tidegrid_app;

-- 2. The address token on each message -----------------------------------------------

ALTER TABLE public.email_messages
  ADD COLUMN to_email_index text CHECK (to_email_index ~ '^[0-9a-f]{64}$');

-- The runtime is granted no UPDATE on it: like the address, it is fixed once
-- the message is written.

-- 0036's invitation rules, comparing a sealed participant's address by token.
CREATE OR REPLACE FUNCTION app.check_profile_invitation() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  p record;
  recent integer;
BEGIN
  -- Under REPEATABLE READ the locks below would not refresh the snapshot the
  -- counts read, so two writers could each count the same total (as 0014's
  -- resend limit requires, READ COMMITTED only).
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'an invitation is written only under READ COMMITTED, not %',
      pg_catalog.current_setting('transaction_isolation')
      USING ERRCODE = '25000';
  END IF;
  PERFORM 1 FROM public.bookings x
   WHERE x.tenant_id = NEW.tenant_id AND x.id = NEW.booking_id
     FOR NO KEY UPDATE;
  SELECT x.is_minor, x.email, x.guardian_email, x.removed_at, x.contact_sealed,
         x.email_index, x.guardian_email_index INTO p
    FROM public.booking_participants x
   WHERE x.tenant_id = NEW.tenant_id AND x.booking_id = NEW.booking_id
     AND x.id = NEW.participant_id
     FOR NO KEY UPDATE;
  IF NOT FOUND
     OR NOT coalesce(app.profile_access_open(NEW.tenant_id, NEW.booking_id, NEW.participant_id),
                     false) THEN
    RAISE EXCEPTION 'an invitation needs a confirmed booking, a trip not yet started, and a participant still in the party'
      USING ERRCODE = '23514', CONSTRAINT = 'email_messages_profile_invitation';
  END IF;
  -- A plain participant by its address; a sealed one by the address's token.
  IF (p.contact_sealed IS NULL
      AND NEW.to_email IS DISTINCT FROM (CASE WHEN p.is_minor THEN p.guardian_email ELSE p.email END))
     OR (p.contact_sealed IS NOT NULL
         AND (NEW.to_email_index IS NULL
              OR NEW.to_email_index IS DISTINCT FROM
                   (CASE WHEN p.is_minor THEN p.guardian_email_index ELSE p.email_index END))) THEN
    RAISE EXCEPTION 'an invitation goes only to the participant''s own address, or a minor''s guardian''s'
      USING ERRCODE = '23514', CONSTRAINT = 'email_messages_profile_recipient';
  END IF;
  SELECT count(*) INTO recent
    FROM public.email_messages m
   WHERE m.tenant_id = NEW.tenant_id AND m.booking_id = NEW.booking_id
     AND m.participant_id = NEW.participant_id
     AND m.link_purpose = 'participant_profile'
     AND m.created_at > now() - interval '24 hours';
  IF recent >= 3 THEN
    RAISE EXCEPTION 'at most 3 invitations an invitee in 24 hours'
      USING ERRCODE = '23514', CONSTRAINT = 'email_messages_profile_limit';
  END IF;
  SELECT count(*) INTO recent
    FROM public.email_messages m
   WHERE m.tenant_id = NEW.tenant_id AND m.booking_id = NEW.booking_id
     AND m.link_purpose = 'participant_profile'
     AND m.created_at > now() - interval '24 hours';
  IF recent >= 20 THEN
    RAISE EXCEPTION 'at most 20 invitations a booking in 24 hours'
      USING ERRCODE = '23514', CONSTRAINT = 'email_messages_profile_limit';
  END IF;
  RETURN NEW;
END;
$$;
