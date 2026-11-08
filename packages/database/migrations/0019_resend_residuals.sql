-- 0019 the 0014 residuals closed (W1-0014-RESIDUALS)
--
-- Pre-pilot hardening, pulled forward by the owner's O-SCOPE decision of
-- 2026-11-08 (docs/v2/06-decision-register.md). Migration 0014 left three
-- residuals, recorded in docs/verification-log.md; each needs a writer with
-- tidegrid_app's credentials that skips the service. This file closes all
-- three (D1, coordinator default pending owner confirmation).
--
-- D4 C, the two templates' keys. A booking_confirmation or booking_canceled
-- message under any other key was not a resend, so neither 0014's ledger
-- nor 0017's claim guard bound it: a writer could send a booking's
-- confirmation as often as it liked. Now a message of either template must
-- name its booking and go out under that booking's own key: the original
-- (booking.confirmation:<booking> or booking.canceled:<booking>, unique per
-- tenant, so once) or a staff resend (booking.resend:<booking>:<n>, which
-- commits only with its ledger row). Refused as email_messages_booking_key.
-- The original also fits the booking's state (the confirmation while it is
-- confirmed, the notice once it is canceled), so a writer cannot take the
-- notice's key early and leave the real one a duplicate that never goes out
-- (email_messages_booking_state). A message of another template is not
-- held here, whatever its content or link: the remaining residual.
-- Checked when the message is inserted; existing rows are not touched.
--
-- D5 A, eligibility. The service refuses a resend when the email does not
-- fit the booking's state (kind_mismatch), the trip is over (trip_over, a
-- confirmation), the cancellation's refund failed (refund_failed, a
-- cancellation notice), or an earlier email of the template is being sent
-- (in_progress). Those lived only in the service, so a writer could resend a
-- confirmation for a canceled booking within the limits. The ledger's check
-- trigger now decides them too, at the same instant the service does
-- (the transaction's time to the millisecond), in the service's order:
-- booking_email_resends_kind_mismatch, _trip_over, _refund_failed, then
-- 0014's limits, then _in_progress.
-- The booking's row, a cancellation notice's refund, and the earlier emails
-- are locked FOR SHARE before the decision (the service holds stronger
-- locks on the same rows, so for it these are no-ops), so a cancellation, a
-- refund outcome, or a delivery claim in progress finishes first and none
-- starts until the resend commits. An earlier email still queued is not
-- refused: the service cancels it first, a direct writer may leave it, and
-- the limits still count every resend (security review, low, recorded).
--
-- D6, the waiver send_after hole. A waiver delivery's send_after is when the
-- sending limits allow its email; 0010 requires the message to be due no
-- earlier when the delivery is written. The email trigger lets a queued
-- message's next_attempt_at move earlier (tests make time pass that way), so
-- a writer could move a waiver email ahead of its send_after and past the
-- interval. Now a queued waiver.request: message moves earlier only to a
-- time no earlier than its delivery's send_after, or once send_after has
-- passed, when it could be claimed anyway, and only once its delivery is
-- committed (a delivery insert still open read the message's old time).
-- Refused as email_messages_waiver_send_after.
--
-- D2: the rules run in the existing triggers, through an invoker function
-- with search_path pinned, not a security definer. Every table they read is
-- one the writer already reads under its own row-level security, so a
-- definer would add a privilege and gain nothing.
--
-- The service path is unchanged: it decides every refusal first, under the
-- same locks, so it does not meet the new errors. No column, index, or row
-- changes on email_messages, bookings, payment_refunds, or waiver tables
-- (rule R4). Both trigger functions are replaced in place, as 0015 and 0017
-- did: app.check_email_message's body is 0017's with two new steps, and
-- app.check_booking_email_resend's is 0014's with two.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'this migration must run as a role that bypasses row-level security';
  END IF;
END
$$;

-- Eligibility (D5 A) -----------------------------------------------------------------

-- The first eligibility refusal for a staff resend of `p_kind` at `p_at`,
-- as the service decides it (refusalsOf in packages/domain-booking), or null.
-- In the service's order; in_progress is decided last, by the trigger.
CREATE FUNCTION app.booking_resend_eligibility_refusal(
    p_tenant uuid, p_booking uuid, p_kind text, p_at timestamptz)
  RETURNS text
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT CASE
           WHEN b.state IS DISTINCT FROM
                  CASE p_kind WHEN 'confirmation' THEN 'confirmed' ELSE 'canceled' END
             THEN 'kind_mismatch'
           WHEN p_kind = 'confirmation' AND t.ends_at <= p_at THEN 'trip_over'
           WHEN p_kind = 'cancellation' AND EXISTS (
                  SELECT 1 FROM public.booking_cancellations c
                    JOIN public.payment_refunds r
                      ON r.tenant_id = c.tenant_id AND r.id = c.refund_id
                   WHERE c.tenant_id = b.tenant_id AND c.booking_id = b.id
                     AND r.state = 'failed')
             THEN 'refund_failed'
         END
    FROM public.bookings b
    JOIN public.scheduled_trips t ON t.tenant_id = b.tenant_id AND t.id = b.trip_id
   WHERE b.tenant_id = p_tenant AND b.id = p_booking
$$;

-- The ledger's check (0014), with eligibility before the limits and the
-- earlier emails after them ----------------------------------------------------

CREATE OR REPLACE FUNCTION app.check_booking_email_resend() RETURNS trigger
  LANGUAGE plpgsql VOLATILE
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  latest integer;
  facts record;
  refusal text;
  pending integer;
  -- The row's time, and when the limits are decided: the transaction's
  -- time, as the service and the message read it.
  decided timestamptz := pg_catalog.date_trunc('milliseconds', pg_catalog.now());
BEGIN
  NEW.created_at := decided;
  NEW.actor_type := coalesce(app.setting_or_null('app.actor_type'), 'system');
  NEW.actor_id := app.setting_or_null('app.actor_id');
  NEW.api_request_id := app.setting_or_null('app.request_id');
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'a staff resend is recorded only under READ COMMITTED, not %',
      pg_catalog.current_setting('transaction_isolation')
      USING ERRCODE = '25000';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('tidegrid.booking_resend:' || NEW.tenant_id::text, 0));
  -- Waiting for the lock counts: the stamp must not lag the decision by more.
  IF pg_catalog.clock_timestamp() - pg_catalog.now() > app.booking_resend_max_transaction() THEN
    RAISE EXCEPTION 'this staff resend''s transaction has run longer than %',
      app.booking_resend_max_transaction()
      USING ERRCODE = '23514', CONSTRAINT = 'booking_email_resends_late';
  END IF;
  SELECT max(r.generation) INTO latest
    FROM public.booking_email_resends r
   WHERE r.tenant_id = NEW.tenant_id AND r.booking_id = NEW.booking_id;
  IF NEW.generation IS DISTINCT FROM coalesce(latest, 0) + 1 THEN
    RAISE EXCEPTION 'booking % takes staff resend generation %, not %',
      NEW.booking_id, coalesce(latest, 0) + 1, NEW.generation
      USING ERRCODE = '23514', CONSTRAINT = 'booking_email_resends_sequence';
  END IF;
  IF NOT EXISTS (
       SELECT 1 FROM public.email_messages m
        WHERE m.tenant_id = NEW.tenant_id AND m.id = NEW.message_id
          AND m.booking_id = NEW.booking_id
          AND m.dedupe_key = 'booking.resend:' || NEW.booking_id::text || ':'
                             || NEW.generation::text
          AND m.template = CASE NEW.kind WHEN 'confirmation' THEN 'booking_confirmation'
                                         ELSE 'booking_canceled' END
          AND m.state = 'queued' AND m.attempts = 0
          -- Queued by this transaction: its stamp is the transaction's time.
          AND m.created_at = now()) THEN
    RAISE EXCEPTION 'a staff resend names the message this transaction queued for its booking, generation, and kind'
      USING ERRCODE = '23514', CONSTRAINT = 'booking_email_resends_message';
  END IF;
  -- Eligibility (0019, D5 A): the service's refusals, decided again for
  -- every writer. The booking's row first (FOR SHARE: a cancellation in
  -- progress finishes before this reads its state, and none starts until
  -- this transaction ends), then a cancellation notice's refund. The
  -- service already holds stronger locks on both, so for it these are
  -- no-ops; the delivery job's key checks never wait behind them.
  PERFORM 1 FROM public.bookings b
    WHERE b.tenant_id = NEW.tenant_id AND b.id = NEW.booking_id
      FOR SHARE OF b;
  IF NEW.kind = 'cancellation' THEN
    PERFORM 1 FROM public.booking_cancellations c
      JOIN public.payment_refunds r ON r.tenant_id = c.tenant_id AND r.id = c.refund_id
     WHERE c.tenant_id = NEW.tenant_id AND c.booking_id = NEW.booking_id
       FOR SHARE OF r;
  END IF;
  refusal := app.booking_resend_eligibility_refusal(NEW.tenant_id, NEW.booking_id,
                                                    NEW.kind, decided);
  IF refusal IS NOT NULL THEN
    RAISE EXCEPTION 'booking % cannot have its % sent again: %', NEW.booking_id, NEW.kind, refusal
      USING ERRCODE = '23514', CONSTRAINT = 'booking_email_resends_' || refusal;
  END IF;
  SELECT * INTO facts FROM app.booking_resend_facts(NEW.tenant_id, NEW.booking_id, decided);
  IF facts.deliverable >= 5 THEN
    RAISE EXCEPTION 'booking % has 5 deliverable staff resends', NEW.booking_id
      USING ERRCODE = '23514', CONSTRAINT = 'booking_email_resends_limit';
  ELSIF facts.newest_at + interval '10 minutes' > decided THEN
    RAISE EXCEPTION 'booking %''s newest staff resend is under 10 minutes old', NEW.booking_id
      USING ERRCODE = '23514', CONSTRAINT = 'booking_email_resends_interval';
  ELSIF facts.operator_resends >= 50 THEN
    RAISE EXCEPTION 'the operator has 50 staff resends in the last hour, until %',
      facts.operator_available_at
      USING ERRCODE = '23514', CONSTRAINT = 'booking_email_resends_rate';
  END IF;
  -- Last, as the service decides it: no earlier email of the template for
  -- the booking is being sent. The earlier ones still to go are locked
  -- (FOR SHARE) first, so a claim in progress finishes before this reads
  -- their state, and none starts until this transaction ends.
  -- The filter is on the aggregate, never a WHERE outside the locking
  -- subquery, so every row still to go is locked, not only those already
  -- sending: a claim held open on a queued one is waited for, then seen.
  SELECT count(*) FILTER (WHERE p.state = 'sending')::integer INTO pending FROM (
    SELECT m.state FROM public.email_messages m
     WHERE m.tenant_id = NEW.tenant_id AND m.booking_id = NEW.booking_id
       AND m.id <> NEW.message_id
       AND m.template = CASE NEW.kind WHEN 'confirmation' THEN 'booking_confirmation'
                                      ELSE 'booking_canceled' END
       AND m.state IN ('queued', 'sending')
       FOR SHARE OF m) p;
  IF pending > 0 THEN
    RAISE EXCEPTION 'booking %''s earlier % email is being sent', NEW.booking_id, NEW.kind
      USING ERRCODE = '23514', CONSTRAINT = 'booking_email_resends_in_progress';
  END IF;
  RETURN NEW;
END;
$$;

-- The email trigger (0017), with the key pin at insert (D4 C) and the waiver
-- send_after floor when a queued message moves earlier (D6) ------------------

CREATE OR REPLACE FUNCTION app.check_email_message() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  refusal record;
  booking_state text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state IS DISTINCT FROM 'queued' OR NEW.attempts IS DISTINCT FROM 0
       OR NEW.lease_expires_at IS NOT NULL OR NEW.provider IS NOT NULL
       OR NEW.provider_message_id IS NOT NULL OR NEW.last_error_code IS NOT NULL THEN
      RAISE EXCEPTION 'a message starts queued and unsent'
        USING ERRCODE = '23514', CONSTRAINT = 'email_messages_transition';
    END IF;
    -- A booking's confirmation and cancellation notice go out under their
    -- booking's own keys only (0019, D4 C): the original, once, or a staff
    -- resend, which commits only with its ledger row (0014).
    IF NEW.template IN ('booking_confirmation', 'booking_canceled')
       AND (NEW.booking_id IS NULL
            OR (NEW.dedupe_key IS DISTINCT FROM
                  CASE NEW.template WHEN 'booking_confirmation' THEN 'booking.confirmation:'
                                    ELSE 'booking.canceled:' END || NEW.booking_id::text
                AND NOT starts_with(NEW.dedupe_key,
                                    'booking.resend:' || NEW.booking_id::text || ':'))) THEN
      RAISE EXCEPTION 'a % message goes out under its booking''s own key or a staff resend''s',
        NEW.template
        USING ERRCODE = '23514', CONSTRAINT = 'email_messages_booking_key';
    END IF;
    -- The original fits the booking's state, as the service writes it: the
    -- confirmation for a confirmed booking, the notice once it is canceled.
    -- Otherwise a writer could take the key early, send a false notice, and
    -- leave the real one a duplicate that never goes out. The booking's row
    -- is locked (FOR SHARE) so a cancellation in progress finishes first and
    -- none starts until this message commits: a confirmation never lands
    -- after a cancellation's scan of the pending emails.
    IF NEW.template IN ('booking_confirmation', 'booking_canceled')
       AND NOT starts_with(NEW.dedupe_key, 'booking.resend:') THEN
      SELECT b.state INTO booking_state FROM public.bookings b
       WHERE b.tenant_id = NEW.tenant_id AND b.id = NEW.booking_id
         FOR SHARE OF b;
      IF booking_state IS DISTINCT FROM
           (CASE NEW.template WHEN 'booking_confirmation' THEN 'confirmed' ELSE 'canceled' END) THEN
        RAISE EXCEPTION 'a booking''s % goes out only while the booking is %', NEW.template,
          CASE NEW.template WHEN 'booking_confirmation' THEN 'confirmed' ELSE 'canceled' END
          USING ERRCODE = '23514', CONSTRAINT = 'email_messages_booking_state';
      END IF;
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
    -- A waiver email never comes due before its delivery's send_after, the
    -- time the sending limits allowed (0019, D6). Moving it earlier needs
    -- its delivery committed, and is allowed only to a time no earlier than
    -- send_after, or once send_after has passed, when the message could be
    -- claimed anyway. A delivery not yet visible refuses the move: it may be
    -- an insert still open, whose own check read the message's old time.
    IF OLD.state = 'queued' AND NEW.next_attempt_at < OLD.next_attempt_at
       AND starts_with(NEW.dedupe_key, 'waiver.request:')
       AND NOT EXISTS (
         SELECT 1 FROM public.waiver_deliveries d
          WHERE d.tenant_id = NEW.tenant_id AND d.message_id = NEW.id
            AND d.send_after <= greatest(NEW.next_attempt_at, now())) THEN
      RAISE EXCEPTION 'waiver message % is not due before its delivery''s send_after', NEW.id
        USING ERRCODE = '23514', CONSTRAINT = 'email_messages_waiver_send_after';
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

-- The ledger's trigger runs as the writer and reads eligibility.
REVOKE ALL ON FUNCTION app.booking_resend_eligibility_refusal(uuid, uuid, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.booking_resend_eligibility_refusal(uuid, uuid, text, timestamptz) TO tidegrid_app;
