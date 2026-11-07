-- 0015 email account faults give their attempt back (G2.16-live prep)
--
-- Owner decision, 2026-11-07 (docs/v2/06-decision-register.md): during a
-- Cloudflare account-level outage (a daily limit, an unverified sender, a
-- suspended account), each sweep claimed one queued email, spent one of its
-- six attempts on a provider that said it took nothing, and stopped. An
-- outage longer than about 5.35 hours drained the queue to
-- retries_exhausted. From this migration such a retry gives its attempt
-- back, so an outage never exhausts an email; each run's one call still
-- serves as the recovery check.
--
-- The trigger function is replaced in place: CREATE OR REPLACE keeps its
-- name, owner, grants, and the trigger that calls it. Its body is 0009's
-- with one new branch, before the rule that attempts count claims only. No
-- table, column, grant, policy, or row changes, and it reads no tenant rows.
-- The account-fault codes are listed here and in ACCOUNT_FAULT_CODES
-- (packages/domain-messaging/src/adapter.ts); a parity test keeps them equal.

-- A message's content never changes. Its delivery moves one way: claimed for
-- a short lease (each claim one more attempt, only when due or when the last
-- attempt's lease has lapsed), then sent with the provider's id, back to
-- queued for a later attempt after a temporary failure, or failed. Since 0015
-- an account-level fault goes back to queued and gives its attempt back. A
-- queued message may be canceled, and so may one being sent: the attempt
-- under way then records nothing and is never retried. Times come from the
-- database clock.
CREATE OR REPLACE FUNCTION app.check_email_message() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
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
