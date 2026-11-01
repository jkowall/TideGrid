-- Staff resend ledger (G2.16b follow-up)
--
-- The limits on a staff resend of a booking's email, held by the database for
-- every writer, not only by the service (owner decision D4 A of 2026-10-29
-- and its 0014 follow-up; the follow-up's decisions D1 to D11 are coordinator
-- defaults pending owner confirmation, docs/v2/06-decision-register.md):
--
--   at most 5 deliverable resends per booking, for ever (attempted, or still
--   waiting: a message canceled before any attempt never reached a mailbox);
--   at least 10 minutes after the booking's newest resend, of any state;
--   at most 50 resends, of any state, per operator in the last hour.
--
-- booking_email_resends is the append-only ledger: one row per staff resend,
-- naming the message the same transaction queued under the key
-- booking.resend:<booking>:<generation>. app.booking_resend_facts counts by
-- those rules; the service reads it before it decides, and the ledger's check
-- trigger reads it again for every writer, under the tenant's resend lock. At
-- commit, a booking.resend: message stands only beside its ledger row, so a
-- writer cannot skip the ledger. The service's eligibility refusals (kind,
-- trip over, refund failed, in progress) stay in the service (D5 A).
--
-- Lock order for a ledger writer: the tenant's resend lock
-- (pg_advisory_xact_lock(hashtextextended('tidegrid.booking_resend:' ||
-- tenant, 0))), which the service takes first, before any row lock; the
-- trigger takes it again, a no-op for the service. A writer that locks the
-- booking before this key can deadlock with a service resend; PostgreSQL
-- detects it, and no service path takes that order.
--
-- Tenancy follows packages/database/README.md: tenant_id on every row,
-- composite tenant foreign keys, forced row-level security with a
-- tenant_isolation policy, SELECT and INSERT from the default privileges, and
-- no UPDATE, DELETE, or TRUNCATE for any role, the owner included.

-- The backfill below reads email_messages, which has forced row-level
-- security: a role that does not bypass it would see no rows and backfill
-- nothing, and the count check could not tell.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'this migration must run as a role that bypasses row-level security';
  END IF;
END
$$;

-- The ledger ---------------------------------------------------------------------

-- One staff resend of a booking's confirmation or cancellation notice. The
-- generation is 1 plus the booking's highest, in any state, and is the last
-- part of its message's key (at most 9 digits). Who asked comes from the
-- transaction's context, stamped by the trigger (D1 B, as waiver_deliveries
-- does): a writer that bypasses the service writes no audit row, so this is
-- its only attribution. No reason column: the reason code is in audit, and
-- free text stays out. created_at's default only serves a seed written with
-- the check trigger off; the trigger stamps it.
CREATE TABLE public.booking_email_resends (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  booking_id uuid NOT NULL,
  generation integer NOT NULL CHECK (generation BETWEEN 1 AND 999999999),
  kind text NOT NULL CHECK (kind IN ('confirmation', 'cancellation')),
  message_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  actor_type text NOT NULL CHECK (actor_type IN ('staff', 'guest', 'system', 'support')),
  actor_id text,
  api_request_id text,
  UNIQUE (tenant_id, id),
  CONSTRAINT booking_email_resends_generation_key UNIQUE (tenant_id, booking_id, generation),
  CONSTRAINT booking_email_resends_message_key UNIQUE (tenant_id, message_id),
  FOREIGN KEY (tenant_id, booking_id) REFERENCES public.bookings (tenant_id, id),
  FOREIGN KEY (tenant_id, message_id) REFERENCES public.email_messages (tenant_id, id)
);
-- The operator's last hour.
CREATE INDEX booking_email_resends_recent_idx
  ON public.booking_email_resends (tenant_id, created_at);

-- Backfill, before any trigger exists: one row per staff resend already sent
-- (D8 A). The key must parse strictly, with no leading zero (so :01 cannot
-- pass for :1), name the message's own booking, and the template must be one
-- of the two; anything else stops the file.
DO $$
DECLARE
  bad record;
BEGIN
  SELECT m.id, m.dedupe_key INTO bad
    FROM public.email_messages m
   WHERE starts_with(m.dedupe_key, 'booking.resend:')
     AND (m.dedupe_key !~ '^booking\.resend:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[1-9][0-9]{0,8}$'
          OR m.booking_id IS NULL
          OR split_part(m.dedupe_key, ':', 2) <> m.booking_id::text
          OR m.template NOT IN ('booking_confirmation', 'booking_canceled'))
   ORDER BY m.created_at, m.id
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'staff resend message % has key %, which names no booking, generation, and kind for the ledger',
      bad.id, bad.dedupe_key;
  END IF;
END
$$;

INSERT INTO public.booking_email_resends
    (tenant_id, booking_id, generation, kind, message_id, created_at, actor_type)
SELECT m.tenant_id, m.booking_id, split_part(m.dedupe_key, ':', 3)::integer,
       CASE m.template WHEN 'booking_confirmation' THEN 'confirmation' ELSE 'cancellation' END,
       m.id, m.created_at, 'system'
  FROM public.email_messages m
 WHERE starts_with(m.dedupe_key, 'booking.resend:');

-- Every resend message has its row. This catches rows skipped or failed to
-- parse; an empty backfill under row-level security is what the guard above
-- stops.
DO $$
DECLARE
  messages bigint;
  ledger bigint;
BEGIN
  SELECT count(*) INTO messages FROM public.email_messages
   WHERE starts_with(dedupe_key, 'booking.resend:');
  SELECT count(*) INTO ledger FROM public.booking_email_resends;
  IF messages <> ledger THEN
    RAISE EXCEPTION 'the staff resend backfill wrote % ledger rows for % messages', ledger, messages;
  END IF;
END
$$;

-- The facts ----------------------------------------------------------------------

-- What the limits are decided from, at p_at, by D4's counting rules: the
-- booking's deliverable resends (state not canceled, or attempted at least
-- once), its newest resend of any state, the operator's resends of any state
-- in the hour before p_at, and, once there are 50, when the 50th newest is an
-- hour old. The service reads it to decide and to answer when a limit lifts;
-- the trigger reads it to decide again. Invoker: row-level security applies,
-- and it filters by tenant explicitly.
CREATE FUNCTION app.booking_resend_facts(p_tenant uuid, p_booking uuid, p_at timestamptz)
  RETURNS TABLE (deliverable integer, newest_at timestamptz, operator_resends integer,
                 operator_available_at timestamptz)
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT
    (SELECT count(*)::integer
       FROM public.booking_email_resends r
       JOIN public.email_messages m ON m.tenant_id = r.tenant_id AND m.id = r.message_id
      WHERE r.tenant_id = p_tenant AND r.booking_id = p_booking
        AND (m.state <> 'canceled' OR m.attempts > 0)),
    (SELECT max(r.created_at)
       FROM public.booking_email_resends r
      WHERE r.tenant_id = p_tenant AND r.booking_id = p_booking),
    (SELECT count(*)::integer
       FROM public.booking_email_resends r
      WHERE r.tenant_id = p_tenant AND r.created_at > p_at - interval '1 hour'),
    (SELECT r.created_at + interval '1 hour'
       FROM public.booking_email_resends r
      WHERE r.tenant_id = p_tenant AND r.created_at > p_at - interval '1 hour'
      ORDER BY r.created_at DESC
     OFFSET 49 LIMIT 1)
$$;

-- The check ----------------------------------------------------------------------

-- Every ledger row, for every writer: stamped from the transaction, under
-- READ COMMITTED only, under the tenant's resend lock, the booking's next
-- generation, naming the message this transaction queued for it, and within
-- the limits at now(). The lock is taken in its own statement, so every
-- statement after it reads what was committed before it was granted; a
-- REPEATABLE READ or SERIALIZABLE writer would read a snapshot from before
-- the lock and could pass a limit, so it is refused (as 0006 refuses capacity
-- changes). Runs as the writer, under its row-level security, and filters by
-- tenant explicitly.
CREATE FUNCTION app.check_booking_email_resend() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  latest integer;
  facts record;
BEGIN
  NEW.created_at := now();
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
          AND m.created_at = now()) THEN
    RAISE EXCEPTION 'a staff resend names the message this transaction queued for its booking, generation, and kind'
      USING ERRCODE = '23514', CONSTRAINT = 'booking_email_resends_message';
  END IF;
  SELECT * INTO facts FROM app.booking_resend_facts(NEW.tenant_id, NEW.booking_id, now());
  IF facts.deliverable >= 5 THEN
    RAISE EXCEPTION 'booking % has 5 deliverable staff resends', NEW.booking_id
      USING ERRCODE = '23514', CONSTRAINT = 'booking_email_resends_limit';
  ELSIF facts.newest_at + interval '10 minutes' > now() THEN
    RAISE EXCEPTION 'booking %''s newest staff resend is under 10 minutes old', NEW.booking_id
      USING ERRCODE = '23514', CONSTRAINT = 'booking_email_resends_interval';
  ELSIF facts.operator_resends >= 50 THEN
    RAISE EXCEPTION 'the operator has 50 staff resends in the last hour, until %',
      facts.operator_available_at
      USING ERRCODE = '23514', CONSTRAINT = 'booking_email_resends_rate';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER booking_email_resends_check BEFORE INSERT ON public.booking_email_resends
  FOR EACH ROW EXECUTE FUNCTION app.check_booking_email_resend();

-- Checked at commit: a booking.resend: message commits only with its ledger
-- row, so a writer that queues one and skips the ledger is refused (D4 A).
-- This goes beyond the waiver precedent, which binds no message to its
-- delivery row at commit. A build from before 0014 writes no ledger row, so
-- its resends fail here until it is rolled forward (owner item O3).
CREATE FUNCTION app.check_booking_resend_recorded() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF NOT EXISTS (
       SELECT 1 FROM public.booking_email_resends r
        WHERE r.tenant_id = NEW.tenant_id AND r.message_id = NEW.id) THEN
    RAISE EXCEPTION 'staff resend message % commits only with its ledger row', NEW.id
      USING ERRCODE = '23514', CONSTRAINT = 'email_messages_staff_resend';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER email_messages_staff_resend
  AFTER INSERT ON public.email_messages
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (starts_with(NEW.dedupe_key, 'booking.resend:'))
  EXECUTE FUNCTION app.check_booking_resend_recorded();

-- Row-level security and append-only guards ---------------------------------------

ALTER TABLE public.booking_email_resends ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.booking_email_resends FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.booking_email_resends
  USING (tenant_id = (SELECT app.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()));
CREATE TRIGGER booking_email_resends_no_delete BEFORE DELETE ON public.booking_email_resends
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();
CREATE TRIGGER booking_email_resends_no_truncate BEFORE TRUNCATE ON public.booking_email_resends
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_mutation();
CREATE TRIGGER booking_email_resends_append_only BEFORE UPDATE ON public.booking_email_resends
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();

-- Privileges ----------------------------------------------------------------------

-- SELECT and INSERT come from the default privileges in 0001; nothing more.
REVOKE ALL ON FUNCTION app.check_booking_email_resend() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.check_booking_resend_recorded() FROM PUBLIC;
-- The service reads the facts before it decides.
REVOKE ALL ON FUNCTION app.booking_resend_facts(uuid, uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.booking_resend_facts(uuid, uuid, timestamptz) TO tidegrid_app;
