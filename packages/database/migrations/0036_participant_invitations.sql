-- 0036 participant invitations (W3-G2.11-rest, third part)
--
-- Under the owner's go of 2026-11-10 on the rest of Wave 3 (the W3-G2.11-rest
-- participant invitations entry in docs/v2/06-decision-register.md).
-- Synthetic data only. What it adds (docs/v2/02, "Guest, party, and account
-- self-service": "invite participants through participant-specific links",
-- and "A participant can manage only their own profile"):
--
-- 1. A third access purpose, `participant_profile`: a single-use link that an
--    invitation email carries to one named participant (or, for a minor, to
--    their guardian), and the restricted session it opens. Like a waiver link
--    it always names its participant.
-- 2. An invitation goes only to the address the participant's row holds now:
--    the participant's own email, or a minor's guardian's. Never to the
--    booker's or any other address. At most 3 an invitee in 24 hours and 20
--    a booking, counted here, under the participant's row lock.
-- 3. A link and a session of this purpose open only while the booking is
--    confirmed, its trip has not started, and the participant is not
--    removed; a link never outlives the trip's start.
-- 4. A participant's session changes only its own participant's row, and
--    never whether they are a minor; it never names a place.
--
-- Tenancy follows packages/database/README.md: every check below reads under
-- the caller's row-level security, in the caller's tenant.

-- 1. The purpose ----------------------------------------------------------------------

ALTER TABLE public.email_messages DROP CONSTRAINT email_messages_link_purpose_check;
ALTER TABLE public.email_messages ADD CONSTRAINT email_messages_link_purpose_check
  CHECK (link_purpose IN ('booking_manage', 'waiver_sign', 'participant_profile')) NOT VALID;
ALTER TABLE public.email_messages VALIDATE CONSTRAINT email_messages_link_purpose_check;
ALTER TABLE public.email_messages ADD CONSTRAINT email_messages_profile_participant
  CHECK (link_purpose IS DISTINCT FROM 'participant_profile' OR participant_id IS NOT NULL)
  NOT VALID;
ALTER TABLE public.email_messages VALIDATE CONSTRAINT email_messages_profile_participant;

ALTER TABLE public.guest_access_links DROP CONSTRAINT guest_access_links_purpose_check;
ALTER TABLE public.guest_access_links ADD CONSTRAINT guest_access_links_purpose_check
  CHECK (purpose IN ('booking_manage', 'waiver_sign', 'participant_profile')) NOT VALID;
ALTER TABLE public.guest_access_links VALIDATE CONSTRAINT guest_access_links_purpose_check;
ALTER TABLE public.guest_access_links ADD CONSTRAINT guest_access_links_profile_participant
  CHECK (purpose <> 'participant_profile' OR participant_id IS NOT NULL) NOT VALID;
ALTER TABLE public.guest_access_links VALIDATE CONSTRAINT guest_access_links_profile_participant;

ALTER TABLE public.guest_sessions DROP CONSTRAINT guest_sessions_purpose_check;
ALTER TABLE public.guest_sessions ADD CONSTRAINT guest_sessions_purpose_check
  CHECK (purpose IN ('booking_manage', 'waiver_sign', 'participant_profile')) NOT VALID;
ALTER TABLE public.guest_sessions VALIDATE CONSTRAINT guest_sessions_purpose_check;
ALTER TABLE public.guest_sessions ADD CONSTRAINT guest_sessions_profile_participant
  CHECK (purpose <> 'participant_profile' OR participant_id IS NOT NULL) NOT VALID;
ALTER TABLE public.guest_sessions VALIDATE CONSTRAINT guest_sessions_profile_participant;

-- Whether one participant of a booking may be reached through this purpose
-- now: the booking confirmed, its trip not started, the participant named and
-- not removed. Null when the booking or participant is not this tenant's.
CREATE FUNCTION app.profile_access_open(p_tenant uuid, p_booking uuid, p_participant uuid)
  RETURNS boolean
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT b.state = 'confirmed' AND t.starts_at > now() AND p.removed_at IS NULL
    FROM public.bookings b
    JOIN public.scheduled_trips t ON t.tenant_id = b.tenant_id AND t.id = b.trip_id
    JOIN public.booking_participants p
      ON p.tenant_id = b.tenant_id AND p.booking_id = b.id AND p.id = p_participant
   WHERE b.tenant_id = p_tenant AND b.id = p_booking
$$;

-- 2. The invitation email -------------------------------------------------------------

-- An invitation is a message carrying a participant_profile link. It goes to
-- the address the participant's row holds now, and the limits are counted
-- under that row's lock, so two invitations at once count each other. The
-- lock is FOR NO KEY UPDATE, as the booking service takes it, so a delivery's
-- foreign key checks on the row never wait behind it.
CREATE FUNCTION app.check_profile_invitation() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  p record;
  recent integer;
BEGIN
  SELECT x.is_minor, x.email, x.guardian_email, x.removed_at INTO p
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
  IF NEW.to_email IS DISTINCT FROM (CASE WHEN p.is_minor THEN p.guardian_email ELSE p.email END) THEN
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
CREATE TRIGGER email_messages_profile_invitation BEFORE INSERT ON public.email_messages
  FOR EACH ROW WHEN (NEW.link_purpose = 'participant_profile')
  EXECUTE FUNCTION app.check_profile_invitation();

-- 3. Links and sessions ---------------------------------------------------------------

-- A participant_profile link is issued only while the participant may still
-- be reached, and never outlives the trip's start (a second to live if the
-- start is that close, so it opens nothing). Runs before the module's own
-- rules, as the waiver clamp does.
CREATE FUNCTION app.check_profile_link() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  trip_start timestamptz;
BEGIN
  IF NOT coalesce(app.profile_access_open(NEW.tenant_id, NEW.booking_id, NEW.participant_id),
                  false) THEN
    RAISE EXCEPTION 'a participant link needs a confirmed booking, a trip not yet started, and a participant still in the party'
      USING ERRCODE = '23514', CONSTRAINT = 'guest_access_links_profile';
  END IF;
  SELECT t.starts_at INTO trip_start
    FROM public.bookings b
    JOIN public.scheduled_trips t ON t.tenant_id = b.tenant_id AND t.id = b.trip_id
   WHERE b.tenant_id = NEW.tenant_id AND b.id = NEW.booking_id;
  NEW.expires_at := greatest(least(NEW.expires_at, trip_start), now() + interval '1 second');
  RETURN NEW;
END;
$$;
CREATE TRIGGER guest_access_links_a_profile BEFORE INSERT ON public.guest_access_links
  FOR EACH ROW WHEN (NEW.purpose = 'participant_profile')
  EXECUTE FUNCTION app.check_profile_link();

-- A participant's session opens only while they may still be reached. (The
-- module's own rules already require the redemption that used its link, for
-- the same booking, participant, and purpose.)
CREATE FUNCTION app.check_profile_session() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF NOT coalesce(app.profile_access_open(NEW.tenant_id, NEW.booking_id, NEW.participant_id),
                  false) THEN
    RAISE EXCEPTION 'a participant session needs a confirmed booking, a trip not yet started, and a participant still in the party'
      USING ERRCODE = '23514', CONSTRAINT = 'guest_sessions_profile';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guest_sessions_a_profile BEFORE INSERT ON public.guest_sessions
  FOR EACH ROW WHEN (NEW.purpose = 'participant_profile')
  EXECUTE FUNCTION app.check_profile_session();

-- 4. What a participant's session may change ------------------------------------------

-- The API names a guest session as the actor (`guest_session:<id>`) for the
-- rows its request writes. When that session is a participant's, it names no
-- place and changes only its own participant, never whether they are a minor,
-- and only while it is live. Other actors are not affected here.
CREATE FUNCTION app.check_profile_session_write() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  actor text := app.setting_or_null('app.actor_id');
  s record;
BEGIN
  IF actor IS NULL OR actor !~ '^guest_session:[0-9a-f-]{36}$' THEN
    RETURN NEW;
  END IF;
  SELECT g.purpose, g.booking_id, g.participant_id, g.revoked_at, g.expires_at INTO s
    FROM public.guest_sessions g
   WHERE g.tenant_id = NEW.tenant_id AND g.id = substr(actor, 15)::uuid;
  IF NOT FOUND OR s.purpose <> 'participant_profile' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT'
     OR OLD.id <> s.participant_id OR OLD.booking_id <> s.booking_id
     OR NEW.is_minor IS DISTINCT FROM OLD.is_minor
     OR s.revoked_at IS NOT NULL OR s.expires_at <= now() THEN
    RAISE EXCEPTION 'a participant''s session changes only that participant''s own details'
      USING ERRCODE = '42501', CONSTRAINT = 'booking_participants_profile_session';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER booking_participants_profile_session
  BEFORE INSERT OR UPDATE ON public.booking_participants
  FOR EACH ROW EXECUTE FUNCTION app.check_profile_session_write();

REVOKE ALL ON FUNCTION app.profile_access_open(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.profile_access_open(uuid, uuid, uuid) TO tidegrid_app;
REVOKE ALL ON FUNCTION app.check_profile_invitation() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.check_profile_link() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.check_profile_session() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.check_profile_session_write() FROM PUBLIC;
