-- 0017 staff resend limits held at the delivery claim (W1-RESEND-CLAIM)
--
-- Pre-pilot hardening, pulled forward by the owner's O-SCOPE decision of
-- 2026-11-08 (docs/v2/06-decision-register.md). Migration 0014 holds the
-- staff resend limits when a resend is written: at most 5 deliverable per
-- booking, 10 minutes after the booking's newest, and 50 an hour per
-- operator, each counted on the ledger's stamps. A stamp is the writer's
-- transaction time, and 0014 bounds it only up to its commit check. A writer
-- with tidegrid_app's credentials that waits after that check (a deferred
-- foreign key held by another session, or SET CONSTRAINTS ... IMMEDIATE)
-- commits a resend whose stamp is old. Nothing else can resend while it waits,
-- since it holds the tenant's resend lock, but once it commits its emails go
-- out beside resends stamped minutes later: two emails to one guest seconds
-- apart, or a hundred of the operator's in one hour. Migration 0014 calls
-- bounding sends at the delivery claim "a possible pre-pilot follow-up". This
-- file is that bound.
--
-- The claim is the one place an email starts towards the provider: a message
-- moves to sending, one more attempt, and the delivery job sends it after
-- that transaction commits. Every claim of a booking.resend: message, the
-- first and every later one, is now checked under the tenant's resend lock,
-- at the database clock when the lock is held (clock_timestamp(), not the
-- transaction's start), and recorded in the append-only claim log
-- booking_email_resend_claims. The claim is refused when:
--
--   another resend of the booking is deliverable five times over (0014's
--   count: not canceled, or attempted at least once): permanent, so the
--   delivery job cancels the message as resend_limit;
--   another resend of the booking was claimed in the last 10 minutes:
--   resend_interval, until 10 minutes after that claim;
--   50 other resends of the operator were claimed in the last hour (each
--   message counted once): resend_rate, until the 50th newest is an hour old;
--   the message has no ledger row, which only a writer with 0014's triggers
--   off can leave: permanent, resend_unrecorded.
--
-- A refused claim raises (SQLSTATE 23514, email_messages_resend_<rule>), so a
-- writer that bypasses the delivery job cannot claim past the limits either.
-- The delivery job reads the same rules first, under the same lock, and never
-- meets the error: it leaves a resend that must wait in the queue, and claims
-- other mail, and it cancels one that can never go.
--
-- Why claim times, and why this holds for every writer. Only the delivery job
-- sends, and it sends right after its own claim commits. Its claims run in a
-- short transaction and each records the clock it was checked at, so the log
-- holds the real time of every claim that sends. A claim a bypass writer
-- makes, and then holds open, records an early time, but it sends nothing,
-- and while it is open it holds the tenant's resend lock, so no other resend
-- is written or claimed. Its message goes out only when the delivery job
-- claims it again, which is checked and logged at that real time. A writer
-- can add log rows only through a claim, or directly, and either only adds
-- to what the limits count.
--
-- The service path is unchanged in normal operation: a resend is claimed
-- within seconds of its write, and 0014 already spaced it from the booking's
-- other resends and the operator's hour. A resend now waits when real sends
-- would otherwise break the limits: after a backlog (an outage, or a missed
-- delivery run) puts claims closer together than their writes, or when the
-- booking's previous resend was retried less than 10 minutes before. It goes
-- out at the next delivery run after the wait (coordinator default, pending
-- owner confirmation). Retries of the same message are not limited here; the
-- message's own attempts stay under the delivery rules.
--
-- Lock order. The delivery job takes the tenant's resend lock before it
-- locks any message, as the resend service does (0014), so the two never
-- deadlock. The claim guard takes it again for every writer (a no-op for the
-- job). A bypass writer that locks a resend message first can still deadlock
-- with a service resend; PostgreSQL detects it, and no service path takes
-- that order.
--
-- No column, index, or row changes on email_messages (rule R4). The guard is
-- the email message trigger function, replaced in place as 0015 did: its
-- body is 0015's with one new step in the claim branch.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'this migration must run as a role that bypasses row-level security';
  END IF;
END
$$;

-- The claim log ------------------------------------------------------------------

-- One claim of a booking.resend: message: its booking, its message, the
-- attempt the claim began, and the clock the claim was checked at. Written
-- by the claim guard; a direct insert is stamped the same way and only adds
-- to the counts. Append-only for every role.
CREATE TABLE public.booking_email_resend_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  booking_id uuid NOT NULL,
  message_id uuid NOT NULL,
  attempt integer NOT NULL CHECK (attempt >= 1),
  claimed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, booking_id) REFERENCES public.bookings (tenant_id, id),
  FOREIGN KEY (tenant_id, message_id) REFERENCES public.email_messages (tenant_id, id)
);
-- The operator's last hour, and a booking's last 10 minutes.
CREATE INDEX booking_email_resend_claims_recent_idx
  ON public.booking_email_resend_claims (tenant_id, claimed_at);
CREATE INDEX booking_email_resend_claims_booking_idx
  ON public.booking_email_resend_claims (tenant_id, booking_id, claimed_at);

-- Backfill, before any trigger exists: the latest claim of every resend
-- message attempted so far, at its latest attempt's time. A message given its
-- attempt back (0015) has no attempt to record.
INSERT INTO public.booking_email_resend_claims
    (tenant_id, booking_id, message_id, attempt, claimed_at)
SELECT m.tenant_id, m.booking_id, m.id, m.attempts, m.last_attempt_at
  FROM public.email_messages m
 WHERE starts_with(m.dedupe_key, 'booking.resend:')
   AND m.attempts > 0;

-- A log row names a booking.resend: message of its own booking, and is
-- stamped at the clock, whatever the insert names.
CREATE FUNCTION app.check_booking_email_resend_claim() RETURNS trigger
  LANGUAGE plpgsql VOLATILE
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  NEW.claimed_at := pg_catalog.clock_timestamp();
  IF NOT EXISTS (
       SELECT 1 FROM public.email_messages m
        WHERE m.tenant_id = NEW.tenant_id AND m.id = NEW.message_id
          AND m.booking_id = NEW.booking_id
          AND starts_with(m.dedupe_key, 'booking.resend:')) THEN
    RAISE EXCEPTION 'a resend claim names a staff resend message of its booking'
      USING ERRCODE = '23514', CONSTRAINT = 'booking_email_resend_claims_message';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER booking_email_resend_claims_check BEFORE INSERT ON public.booking_email_resend_claims
  FOR EACH ROW EXECUTE FUNCTION app.check_booking_email_resend_claim();

ALTER TABLE public.booking_email_resend_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.booking_email_resend_claims FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.booking_email_resend_claims
  USING (tenant_id = (SELECT app.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()));
CREATE TRIGGER booking_email_resend_claims_no_delete BEFORE DELETE ON public.booking_email_resend_claims
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();
CREATE TRIGGER booking_email_resend_claims_no_truncate BEFORE TRUNCATE ON public.booking_email_resend_claims
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_mutation();
CREATE TRIGGER booking_email_resend_claims_append_only BEFORE UPDATE ON public.booking_email_resend_claims
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();

-- The rules ----------------------------------------------------------------------

-- Why a claim of p_message at p_at must not go ahead, or no row: one row,
-- with its rule and, for a wait, when it lifts. No row for a message that is
-- not a booking.resend: message. Counts have no upper bound on time: a claim
-- logged after p_at still counts. The delivery job reads it to choose and the
-- claim guard reads it to decide. Invoker: row-level security applies, and it
-- filters by tenant explicitly.
CREATE FUNCTION app.booking_resend_claim_refusal(p_tenant uuid, p_message uuid, p_at timestamptz)
  RETURNS TABLE (code text, available_at timestamptz)
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, pg_temp
  AS $$
  WITH msg AS (
    SELECT m.id, m.booking_id,
           EXISTS (SELECT 1 FROM public.booking_email_resends r
                    WHERE r.tenant_id = m.tenant_id AND r.message_id = m.id
                      AND r.booking_id = m.booking_id) AS recorded
      FROM public.email_messages m
     WHERE m.tenant_id = p_tenant AND m.id = p_message
       AND starts_with(m.dedupe_key, 'booking.resend:')
  ), facts AS (
    SELECT msg.recorded,
           (SELECT count(*)::integer
              FROM public.booking_email_resends r
              JOIN public.email_messages o ON o.tenant_id = r.tenant_id AND o.id = r.message_id
             WHERE r.tenant_id = p_tenant AND r.booking_id = msg.booking_id
               AND r.message_id <> msg.id
               AND (o.state <> 'canceled' OR o.attempts > 0)) AS deliverable,
           (SELECT max(c.claimed_at)
              FROM public.booking_email_resend_claims c
             WHERE c.tenant_id = p_tenant AND c.booking_id = msg.booking_id
               AND c.message_id <> msg.id
               AND c.claimed_at > p_at - interval '10 minutes') AS booking_newest,
           (SELECT count(DISTINCT c.message_id)::integer
              FROM public.booking_email_resend_claims c
             WHERE c.tenant_id = p_tenant AND c.message_id <> msg.id
               AND c.claimed_at > p_at - interval '1 hour') AS operator_claims,
           (SELECT x.latest + interval '1 hour'
              FROM (SELECT max(c.claimed_at) AS latest
                      FROM public.booking_email_resend_claims c
                     WHERE c.tenant_id = p_tenant AND c.message_id <> msg.id
                       AND c.claimed_at > p_at - interval '1 hour'
                     GROUP BY c.message_id) x
             ORDER BY x.latest DESC
            OFFSET 49 LIMIT 1) AS operator_available_at
      FROM msg
  )
  SELECT CASE
           WHEN NOT f.recorded THEN 'resend_unrecorded'
           WHEN f.deliverable >= 5 THEN 'resend_limit'
           WHEN f.booking_newest IS NOT NULL THEN 'resend_interval'
           ELSE 'resend_rate'
         END,
         CASE
           WHEN NOT f.recorded OR f.deliverable >= 5 THEN NULL
           WHEN f.booking_newest IS NOT NULL THEN f.booking_newest + interval '10 minutes'
           ELSE f.operator_available_at
         END
    FROM facts f
   WHERE NOT f.recorded OR f.deliverable >= 5 OR f.booking_newest IS NOT NULL
      OR f.operator_claims >= 50
$$;

-- The claim guard ----------------------------------------------------------------

-- 0015's function with one new step: a claim of a booking.resend: message,
-- under READ COMMITTED only, takes the tenant's resend lock, is decided at
-- the clock once the lock is held, and is logged. Everything else is 0015's
-- text, unchanged.
CREATE OR REPLACE FUNCTION app.check_email_message() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  refusal record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state IS DISTINCT FROM 'queued' OR NEW.attempts IS DISTINCT FROM 0
       OR NEW.lease_expires_at IS NOT NULL OR NEW.provider IS NOT NULL
       OR NEW.provider_message_id IS NOT NULL OR NEW.last_error_code IS NOT NULL THEN
      RAISE EXCEPTION 'a message starts queued and unsent'
        USING ERRCODE = '23514', CONSTRAINT = 'email_messages_transition';
    END IF;
    NEW.created_at := now();
    NEW.updated_at := now();
    NEW.last_attempt_at := NULL;
    NEW.sent_at := NULL;
    NEW.failed_at := NULL;
    NEW.canceled_at := NULL;
    -- A message may wait to be sent (a reminder); it never jumps the queue.
    NEW.next_attempt_at := greatest(coalesce(NEW.next_attempt_at, now()), now());
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.dedupe_key IS DISTINCT FROM OLD.dedupe_key
     OR NEW.template IS DISTINCT FROM OLD.template
     OR NEW.template_version IS DISTINCT FROM OLD.template_version
     OR NEW.booking_id IS DISTINCT FROM OLD.booking_id
     OR NEW.participant_id IS DISTINCT FROM OLD.participant_id
     OR NEW.subject_ref IS DISTINCT FROM OLD.subject_ref
     OR NEW.to_email IS DISTINCT FROM OLD.to_email
     OR NEW.to_name IS DISTINCT FROM OLD.to_name
     OR NEW.from_name IS DISTINCT FROM OLD.from_name
     OR NEW.reply_to IS DISTINCT FROM OLD.reply_to
     OR NEW.subject IS DISTINCT FROM OLD.subject
     OR NEW.html_body IS DISTINCT FROM OLD.html_body
     OR NEW.text_body IS DISTINCT FROM OLD.text_body
     OR NEW.link_purpose IS DISTINCT FROM OLD.link_purpose
     OR NEW.link_path IS DISTINCT FROM OLD.link_path
     OR NEW.link_ttl_seconds IS DISTINCT FROM OLD.link_ttl_seconds
     OR NEW.link_slot IS DISTINCT FROM OLD.link_slot
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a message''s recipient and content never change'
      USING ERRCODE = '23514', CONSTRAINT = 'email_messages_immutable';
  END IF;
  NEW.last_attempt_at := OLD.last_attempt_at;
  NEW.sent_at := OLD.sent_at;
  NEW.failed_at := OLD.failed_at;
  NEW.canceled_at := OLD.canceled_at;
  NEW.updated_at := now();
  IF OLD.state IN ('sent', 'failed', 'canceled') THEN
    IF NEW.state IS DISTINCT FROM OLD.state OR NEW.attempts IS DISTINCT FROM OLD.attempts
       OR NEW.next_attempt_at IS DISTINCT FROM OLD.next_attempt_at
       OR NEW.lease_expires_at IS DISTINCT FROM OLD.lease_expires_at
       OR NEW.provider IS DISTINCT FROM OLD.provider
       OR NEW.provider_message_id IS DISTINCT FROM OLD.provider_message_id
       OR NEW.last_error_code IS DISTINCT FROM OLD.last_error_code THEN
      RAISE EXCEPTION 'message % is %; it no longer changes', OLD.id, OLD.state
        USING ERRCODE = '23514', CONSTRAINT = 'email_messages_transition';
    END IF;
    RETURN NEW;
  END IF;

  -- A claim: one more attempt, under a fresh lease of at most ten minutes.
  IF NEW.state = 'sending' AND (OLD.state = 'queued' OR NEW.attempts IS DISTINCT FROM OLD.attempts) THEN
    IF (OLD.state = 'queued' AND OLD.next_attempt_at > now())
       OR (OLD.state = 'sending' AND OLD.lease_expires_at > now()) THEN
      RAISE EXCEPTION 'message % is not due', OLD.id
        USING ERRCODE = '23514', CONSTRAINT = 'email_messages_claim';
    END IF;
    IF NEW.attempts IS DISTINCT FROM OLD.attempts + 1
       OR NEW.lease_expires_at IS NULL OR NEW.lease_expires_at <= now()
       OR NEW.lease_expires_at > now() + interval '10 minutes'
       OR NEW.provider IS NULL OR NEW.provider_message_id IS NOT NULL THEN
      RAISE EXCEPTION 'a claim is one more attempt at one provider, under a lease of at most ten minutes'
        USING ERRCODE = '23514', CONSTRAINT = 'email_messages_claim';
    END IF;
    -- A staff resend's claim (0017): under the tenant's resend lock, decided
    -- at the clock once the lock is held, within the limits on claims, and
    -- logged. A snapshot from before the lock could pass a limit, so only
    -- READ COMMITTED claims a resend; each statement below takes a fresh one.
    IF starts_with(NEW.dedupe_key, 'booking.resend:') THEN
      IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
        RAISE EXCEPTION 'a staff resend is claimed only under READ COMMITTED, not %',
          pg_catalog.current_setting('transaction_isolation')
          USING ERRCODE = '25000';
      END IF;
      PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended('tidegrid.booking_resend:' || NEW.tenant_id::text, 0));
      SELECT r.code, r.available_at INTO refusal
        FROM app.booking_resend_claim_refusal(NEW.tenant_id, NEW.id,
                                              pg_catalog.clock_timestamp()) r;
      IF FOUND THEN
        RAISE EXCEPTION 'staff resend message % is not claimed: %, until %',
          NEW.id, refusal.code, coalesce(refusal.available_at::text, 'never')
          USING ERRCODE = '23514',
                CONSTRAINT = 'email_messages_' || refusal.code;
      END IF;
      -- The log's own trigger stamps the clock, a moment after the decision.
      INSERT INTO public.booking_email_resend_claims (tenant_id, booking_id, message_id, attempt)
        VALUES (NEW.tenant_id, NEW.booking_id, NEW.id, NEW.attempts);
    END IF;
    NEW.next_attempt_at := OLD.next_attempt_at;
    NEW.last_error_code := OLD.last_error_code;
    NEW.last_attempt_at := now();
    RETURN NEW;
  END IF;
  -- An account-level fault gives its attempt back (0015). The provider said
  -- it took nothing, and every other email would meet the same fault, so an
  -- outage never spends a message's attempts. Exactly one, only undoing the
  -- claim under way, only for an account-fault code, never with a provider's
  -- id, and the retry waits at least a minute. Any other change to attempts
  -- still meets the rule below.
  IF OLD.state = 'sending' AND NEW.state = 'queued'
     AND NEW.attempts IS DISTINCT FROM OLD.attempts THEN
    IF NEW.attempts IS DISTINCT FROM OLD.attempts - 1
       OR NEW.last_error_code IS NULL
       OR NEW.last_error_code NOT IN ('provider_quota_exceeded', 'sender_not_verified',
                                      'provider_account_suspended')
       OR NEW.provider_message_id IS NOT NULL
       OR NEW.provider IS DISTINCT FROM OLD.provider
       OR NEW.next_attempt_at < now() + interval '1 minute' THEN
      RAISE EXCEPTION 'only an account-level fault gives its attempt back: one, after a wait'
        USING ERRCODE = '23514', CONSTRAINT = 'email_messages_transition';
    END IF;
    NEW.lease_expires_at := NULL;
    -- No attempt counts any more: the CHECK pairs attempts 0 with no time.
    IF NEW.attempts = 0 THEN
      NEW.last_attempt_at := NULL;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.attempts IS DISTINCT FROM OLD.attempts THEN
    RAISE EXCEPTION 'attempts count claims only'
      USING ERRCODE = '23514', CONSTRAINT = 'email_messages_transition';
  END IF;
  IF NEW.state = OLD.state THEN
    -- Without a transition only time moves, and only earlier: a queued message
    -- due sooner, or a lease ended sooner (tests make time pass this way).
    IF NEW.provider IS DISTINCT FROM OLD.provider
       OR NEW.provider_message_id IS DISTINCT FROM OLD.provider_message_id
       OR NEW.last_error_code IS DISTINCT FROM OLD.last_error_code
       OR NEW.next_attempt_at > OLD.next_attempt_at
       OR (OLD.state = 'queued' AND NEW.lease_expires_at IS NOT NULL)
       OR (OLD.state = 'sending'
           AND (NEW.next_attempt_at IS DISTINCT FROM OLD.next_attempt_at
                OR NEW.lease_expires_at IS NULL
                OR NEW.lease_expires_at > OLD.lease_expires_at)) THEN
      RAISE EXCEPTION 'a message''s delivery changes only with a transition; its times move only earlier'
        USING ERRCODE = '23514', CONSTRAINT = 'email_messages_transition';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.state = 'sending' AND NEW.state = 'sent' THEN
    IF NEW.provider_message_id IS NULL OR NEW.provider IS DISTINCT FROM OLD.provider THEN
      RAISE EXCEPTION 'a sent message names the provider''s id for it'
        USING ERRCODE = '23514', CONSTRAINT = 'email_messages_transition';
    END IF;
    NEW.lease_expires_at := NULL;
    NEW.next_attempt_at := OLD.next_attempt_at;
    -- The last attempt was accepted: an earlier attempt's error no longer applies.
    NEW.last_error_code := NULL;
    NEW.sent_at := now();
    RETURN NEW;
  END IF;
  IF OLD.state = 'sending' AND NEW.state IN ('queued', 'failed') THEN
    IF NEW.last_error_code IS NULL OR NEW.provider_message_id IS NOT NULL
       OR NEW.provider IS DISTINCT FROM OLD.provider
       OR (NEW.state = 'queued' AND NEW.next_attempt_at <= now()) THEN
      RAISE EXCEPTION 'a failed attempt records its error, and a retry waits'
        USING ERRCODE = '23514', CONSTRAINT = 'email_messages_transition';
    END IF;
    NEW.lease_expires_at := NULL;
    IF NEW.state = 'failed' THEN
      NEW.next_attempt_at := OLD.next_attempt_at;
      NEW.failed_at := now();
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.state IN ('queued', 'sending') AND NEW.state = 'canceled' THEN
    NEW.next_attempt_at := OLD.next_attempt_at;
    NEW.lease_expires_at := NULL;
    NEW.provider := OLD.provider;
    NEW.provider_message_id := NULL;
    -- Its error code is the one the cancellation sets (such as
    -- recipient_changed), or none: every cancel sets it, and an earlier
    -- attempt's error no longer describes the message.
    NEW.canceled_at := now();
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'a message cannot move from % to %', OLD.state, NEW.state
    USING ERRCODE = '23514', CONSTRAINT = 'email_messages_transition';
END;
$$;

-- Privileges ----------------------------------------------------------------------

-- SELECT and INSERT on the log come from the default privileges in 0001.
REVOKE ALL ON FUNCTION app.check_booking_email_resend_claim() FROM PUBLIC;
-- The delivery job and the claim guard, both as the writer, read the rules.
REVOKE ALL ON FUNCTION app.booking_resend_claim_refusal(uuid, uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.booking_resend_claim_refusal(uuid, uuid, timestamptz) TO tidegrid_app;
