-- 0055 guest contact details sealed by the application, part 1 (W3-OPS-4)
--
-- Owner decision 2026-11-15: encrypt every guest contact detail, in phases.
-- This first part covers the booker on each checkout, the credit account a
-- booker's email keys, and the customers a CSV import saves, because the
-- database matches those three to each other by email. Tenancy follows
-- packages/database/README.md.
--
-- With a keyring (packages/database/src/contact-crypto.ts) the API seals the
-- booker's name and email into booker_sealed, with AES-256-GCM under a key
-- the database never sees, bound to the tenant and the column. What SQL still
-- needs is kept as blind index tokens (keyed HMAC-SHA256):
--
--   booker_email_index   the address, to match a credit account or to find a
--                        booking by its full address;
--   booker_name_index    one token per word of the name, for whole-word search,
--                        and one of the exact name, so any correction to it
--                        (even of case or punctuation) changes the tokens.
--
-- A credit account is keyed by the same email token instead of the address,
-- and an imported customer keeps its name, email, and phone sealed with its
-- email token beside them. The same address gives the same token in every
-- table of one tenant, and unrelated tokens at two tenants.
--
-- Rows written before stay plain and keep working: every match compares the
-- plain columns or the tokens. A plain row and a sealed row never match each
-- other, so an environment writes one way: plain where no keyring is set
-- (local, preview; synthetic data), sealed where one is (staging and
-- production refuse to write without it). No row is rewritten.

-- 1. The booker on a checkout --------------------------------------------------------

ALTER TABLE public.checkout_sessions
  ALTER COLUMN booker_name DROP NOT NULL,
  ADD COLUMN booker_sealed text
    CHECK (booker_sealed ~ '^tgf1:[a-z0-9]{1,16}:[A-Za-z0-9_-]{24,}$' AND char_length(booker_sealed) <= 4000),
  ADD COLUMN booker_email_index text CHECK (booker_email_index ~ '^[0-9a-f]{64}$'),
  ADD COLUMN booker_name_index text[]
    CHECK (cardinality(booker_name_index) >= 1
           AND array_position(booker_name_index, NULL) IS NULL
           AND array_to_string(booker_name_index, ',') ~ '^[0-9a-f]{64}(,[0-9a-f]{64})*$');

-- coalesce: a CHECK that evaluates to NULL passes. A sealed booker has a name
-- token always and an email token unless it was imported with no address; a
-- plain one has neither. A redacted booker is plain (0026).
ALTER TABLE public.checkout_sessions
  ADD CONSTRAINT checkout_sessions_booker_place CHECK (coalesce(
    (booker_sealed IS NULL AND booker_name IS NOT NULL
     AND booker_email_index IS NULL AND booker_name_index IS NULL)
    OR (booker_sealed IS NOT NULL AND booker_name IS NULL AND booker_email IS NULL
        AND booker_name_index IS NOT NULL AND booker_redacted_at IS NULL),
    false));

-- As 0044: only an imported checkout may have no booker email, plain or sealed.
ALTER TABLE public.checkout_sessions DROP CONSTRAINT checkout_sessions_booker_email_required;
ALTER TABLE public.checkout_sessions
  ADD CONSTRAINT checkout_sessions_booker_email_required
    CHECK (source = 'imported' OR booker_email IS NOT NULL OR booker_email_index IS NOT NULL);

CREATE INDEX checkout_sessions_booker_email_index_idx
  ON public.checkout_sessions (tenant_id, booker_email_index)
  WHERE booker_email_index IS NOT NULL;
CREATE INDEX checkout_sessions_booker_name_index_idx
  ON public.checkout_sessions USING gin (booker_name_index)
  WHERE booker_name_index IS NOT NULL;

-- As 0026: a redaction may also clear a sealed booker, and must.
CREATE OR REPLACE FUNCTION app.check_checkout_redaction() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.booker_redacted_at := NULL;
    RETURN NEW;
  END IF;
  IF OLD.booker_redacted_at IS NOT NULL THEN
    IF NEW.booker_redacted_at IS DISTINCT FROM OLD.booker_redacted_at THEN
      RAISE EXCEPTION 'a redaction is permanent'
        USING ERRCODE = '23514', CONSTRAINT = 'checkout_sessions_redaction';
    END IF;
    IF NEW.state = 'confirmed' THEN
      RAISE EXCEPTION 'a redacted checkout never becomes a booking'
        USING ERRCODE = '23514', CONSTRAINT = 'checkout_sessions_redaction';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.booker_redacted_at IS NULL THEN
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['booker_name', 'booker_email', 'booker_sealed', 'booker_email_index',
                         'booker_name_index', 'booker_redacted_at', 'updated_at'])
       IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['booker_name', 'booker_email', 'booker_sealed', 'booker_email_index',
                         'booker_name_index', 'booker_redacted_at', 'updated_at'])
     OR NEW.booker_name <> 'Redacted'
     OR NEW.booker_email <> 'redacted@redacted.invalid'
     OR NEW.booker_sealed IS NOT NULL
     OR OLD.state NOT IN ('expired', 'failed', 'canceled')
     OR coalesce(OLD.expired_at, OLD.failed_at, OLD.canceled_at) > now() - interval '30 days'
     OR EXISTS (SELECT 1 FROM public.bookings b
                 WHERE b.tenant_id = OLD.tenant_id AND b.checkout_session_id = OLD.id)
     OR EXISTS (SELECT 1 FROM public.payments p
                 WHERE p.tenant_id = OLD.tenant_id AND p.checkout_session_id = OLD.id
                   AND p.state = 'succeeded')
     OR EXISTS (SELECT 1 FROM public.provider_events e
                 WHERE e.tenant_id = OLD.tenant_id AND e.processing_state = 'received'
                   AND e.payment_ref IN (SELECT p.provider_payment_id FROM public.payments p
                                          WHERE p.tenant_id = OLD.tenant_id
                                            AND p.checkout_session_id = OLD.id)) THEN
    RAISE EXCEPTION 'only an abandoned checkout''s booker is redacted, and only the booker'
      USING ERRCODE = '23514', CONSTRAINT = 'checkout_sessions_redaction';
  END IF;
  NEW.booker_redacted_at := now();
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- As 0038: the retention job clears a sealed booker with the plain one.
CREATE OR REPLACE FUNCTION app.retention_redact_abandoned_checkouts(p_days integer, p_limit integer)
  RETURNS TABLE (tenant_id uuid, redacted integer)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
#variable_conflict use_column
BEGIN
  IF p_days IS NULL OR p_days < 30 OR p_days > 3650 THEN
    RAISE EXCEPTION 'retention is 30 to 3650 days' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    WITH due AS (
      SELECT s.tenant_id, s.id
        FROM public.checkout_sessions s
       WHERE s.booker_redacted_at IS NULL
         AND s.state IN ('expired', 'failed', 'canceled')
         AND coalesce(s.expired_at, s.failed_at, s.canceled_at)
               <= pg_catalog.now() - pg_catalog.make_interval(days => p_days)
         AND NOT EXISTS (SELECT 1 FROM public.bookings b
                          WHERE b.tenant_id = s.tenant_id AND b.checkout_session_id = s.id)
         AND NOT EXISTS (SELECT 1 FROM public.payments p
                          WHERE p.tenant_id = s.tenant_id AND p.checkout_session_id = s.id
                            AND p.state = 'succeeded')
         AND NOT EXISTS (SELECT 1 FROM public.provider_events e
                          JOIN public.payments p
                            ON p.tenant_id = e.tenant_id AND p.provider_payment_id = e.payment_ref
                          WHERE e.tenant_id = s.tenant_id AND e.processing_state = 'received'
                            AND p.checkout_session_id = s.id)
       ORDER BY s.tenant_id, s.id
       LIMIT greatest(1, least(coalesce(p_limit, 500), 5000))
       FOR UPDATE OF s SKIP LOCKED
    ), done AS (
      UPDATE public.checkout_sessions s
         SET booker_name = 'Redacted',
             booker_email = 'redacted@redacted.invalid',
             booker_sealed = NULL,
             booker_email_index = NULL,
             booker_name_index = NULL,
             booker_redacted_at = pg_catalog.now()
        FROM due
       WHERE s.tenant_id = due.tenant_id AND s.id = due.id
      RETURNING s.tenant_id, s.id
    ), notes AS (
      UPDATE public.capacity_overrides o
         SET note = NULL,
             note_redacted_at = pg_catalog.now()
        FROM done d
       WHERE o.tenant_id = d.tenant_id
         AND o.owner_ref = 'checkout_session:' || d.id::text
         AND o.note IS NOT NULL
      RETURNING 1
    ), counts AS (
      SELECT d.tenant_id, count(*)::integer AS n FROM done d GROUP BY d.tenant_id
    ), audited AS (
      INSERT INTO public.audit_events
          (tenant_id, actor_type, actor_id, action, subject_type, subject_id, after_state)
        SELECT c.tenant_id, 'system', 'retention', 'retention.checkout_bookers_redacted',
               'tenant', c.tenant_id::text,
               pg_catalog.jsonb_build_object('count', c.n, 'olderThanDays', p_days)
          FROM counts c
      RETURNING 1
    )
    -- A data-modifying WITH runs once whether or not it is read.
    SELECT c.tenant_id, c.n FROM counts c ORDER BY c.tenant_id;
END;
$$;

-- As 0037: a sealed correction is a correction too. It changes the sealed
-- value and its tokens and nothing else, never moves a booker between plain
-- and sealed, and records which of the name and email changed by their tokens.
CREATE OR REPLACE FUNCTION app.check_booker_contact_change() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  b record;
  recent integer;
  change_id uuid;
BEGIN
  IF (pg_catalog.to_jsonb(NEW) - ARRAY['booker_name', 'booker_email', 'booker_sealed',
                                        'booker_email_index', 'booker_name_index', 'updated_at'])
       IS DISTINCT FROM
     (pg_catalog.to_jsonb(OLD) - ARRAY['booker_name', 'booker_email', 'booker_sealed',
                                        'booker_email_index', 'booker_name_index', 'updated_at']) THEN
    RAISE EXCEPTION 'a correction changes the booker''s name and email, and nothing else'
      USING ERRCODE = '23514', CONSTRAINT = 'checkout_sessions_immutable';
  END IF;
  -- A booker stays where it was written: plain stays plain, sealed stays sealed.
  IF (NEW.booker_sealed IS NULL) <> (OLD.booker_sealed IS NULL) THEN
    RAISE EXCEPTION 'a correction keeps the booker sealed, or keeps it plain'
      USING ERRCODE = '23514', CONSTRAINT = 'checkout_sessions_booker_place';
  END IF;
  -- The booking first, as every other change to a booking locks it.
  SELECT bk.id, bk.state, t.starts_at INTO b
    FROM public.bookings bk
    JOIN public.scheduled_trips t ON t.tenant_id = bk.tenant_id AND t.id = bk.trip_id
   WHERE bk.tenant_id = OLD.tenant_id AND bk.checkout_session_id = OLD.id
     FOR NO KEY UPDATE OF bk;
  IF NOT FOUND OR OLD.state <> 'confirmed' THEN
    RAISE EXCEPTION 'only a confirmed booking''s booker is corrected'
      USING ERRCODE = '23514', CONSTRAINT = 'checkout_sessions_booker_contact';
  END IF;
  IF b.state <> 'confirmed' THEN
    RAISE EXCEPTION 'booking % is %; its booker no longer changes', b.id, b.state
      USING ERRCODE = '23514', CONSTRAINT = 'checkout_sessions_booker_contact';
  END IF;
  IF now() >= b.starts_at THEN
    RAISE EXCEPTION 'booking %''s trip has started; its booker no longer changes', b.id
      USING ERRCODE = '23514', CONSTRAINT = 'checkout_sessions_booker_contact';
  END IF;
  -- The limit is the guest's: staff restoring a booking someone took over
  -- with a leaked link must never be locked out by that person's changes.
  IF coalesce(app.setting_or_null('app.actor_type'), 'system') = 'guest' THEN
    SELECT count(*)::integer INTO recent FROM public.booking_contact_changes c
     WHERE c.tenant_id = OLD.tenant_id AND c.booking_id = b.id AND c.actor_type = 'guest'
       AND c.created_at > now() - interval '24 hours';
    IF recent >= 3 THEN
      RAISE EXCEPTION 'booking % had 3 contact corrections by the guest in the last 24 hours', b.id
        USING ERRCODE = '23514', CONSTRAINT = 'booking_contact_changes_limit';
    END IF;
  END IF;
  INSERT INTO public.booking_contact_changes (tenant_id, booking_id, name_changed, email_changed)
  VALUES (OLD.tenant_id, b.id,
          NEW.booker_name IS DISTINCT FROM OLD.booker_name
            OR NEW.booker_name_index IS DISTINCT FROM OLD.booker_name_index,
          NEW.booker_email IS DISTINCT FROM OLD.booker_email
            OR NEW.booker_email_index IS DISTINCT FROM OLD.booker_email_index)
  RETURNING id INTO change_id;
  -- The writer reads which row is its own from this transaction's setting,
  -- never by time: another correction may have committed in between.
  PERFORM pg_catalog.set_config('app.contact_change_id', change_id::text, true);
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- The 0007 rules (as split in 0026 and 0037) compare the plain booker; a
-- sealed booker changes only as a correction, checked here.
CREATE TRIGGER checkout_sessions_contact_sealed
  BEFORE UPDATE ON public.checkout_sessions
  FOR EACH ROW
  WHEN (OLD.booker_redacted_at IS NULL AND NEW.booker_redacted_at IS NULL
        AND NEW.booker_name IS NOT DISTINCT FROM OLD.booker_name
        AND NEW.booker_email IS NOT DISTINCT FROM OLD.booker_email
        AND (NEW.booker_sealed IS DISTINCT FROM OLD.booker_sealed
             OR NEW.booker_email_index IS DISTINCT FROM OLD.booker_email_index
             OR NEW.booker_name_index IS DISTINCT FROM OLD.booker_name_index))
  EXECUTE FUNCTION app.check_booker_contact_change();

GRANT UPDATE (booker_sealed, booker_email_index, booker_name_index)
  ON public.checkout_sessions TO tidegrid_app;

-- 2. Credit accounts -----------------------------------------------------------------

-- An account is keyed by its customer's address, or, where contact details
-- are sealed, by the address's token. Nothing reads the address back.
ALTER TABLE public.credit_accounts
  ALTER COLUMN customer_email DROP NOT NULL,
  ADD COLUMN customer_email_index text CHECK (customer_email_index ~ '^[0-9a-f]{64}$');
ALTER TABLE public.credit_accounts
  ADD CONSTRAINT credit_accounts_customer_key
    CHECK ((customer_email IS NULL) <> (customer_email_index IS NULL)),
  ADD CONSTRAINT credit_accounts_customer_index UNIQUE (tenant_id, customer_email_index);

-- 3. Imported customers --------------------------------------------------------------

ALTER TABLE public.import_customers
  ALTER COLUMN full_name DROP NOT NULL,
  ADD COLUMN contact_sealed text
    CHECK (contact_sealed ~ '^tgf1:[a-z0-9]{1,16}:[A-Za-z0-9_-]{24,}$' AND char_length(contact_sealed) <= 4000),
  ADD COLUMN email_index text CHECK (email_index ~ '^[0-9a-f]{64}$');
ALTER TABLE public.import_customers
  ADD CONSTRAINT import_customers_contact_place CHECK (coalesce(
    (contact_sealed IS NULL AND full_name IS NOT NULL AND email_index IS NULL)
    OR (contact_sealed IS NOT NULL AND full_name IS NULL AND email IS NULL AND phone IS NULL),
    false));
CREATE INDEX import_customers_email_index_idx ON public.import_customers (tenant_id, email_index)
  WHERE email_index IS NOT NULL;

-- As 0051: an imported credit's customer has an email, plain or sealed.
CREATE OR REPLACE FUNCTION app.check_import_credit() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  NEW.created_at := now();
  IF NOT app.import_record_live(NEW.tenant_id, NEW.record_id, 'opening_balances.csv') THEN
    RAISE EXCEPTION 'an imported credit names its opening_balances.csv record from this commit'
      USING ERRCODE = '23514', CONSTRAINT = 'import_credits_record';
  END IF;
  IF NOT EXISTS (
       SELECT 1 FROM public.import_customers c
        WHERE c.tenant_id = NEW.tenant_id AND c.record_id = NEW.customer_record_id
          AND (c.email IS NOT NULL OR c.email_index IS NOT NULL)) THEN
    RAISE EXCEPTION 'an imported credit belongs to an imported customer with an email'
      USING ERRCODE = '23514', CONSTRAINT = 'import_credits_customer';
  END IF;
  RETURN NEW;
END;
$$;

-- As 0051, matching the account by its address or by its token.
CREATE FUNCTION app.import_credit_matches(p_tenant uuid, p_record uuid, p_amount integer,
                                          p_email text, p_email_index text)
  RETURNS boolean
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT EXISTS (
      SELECT 1 FROM public.import_credits x
        JOIN public.import_customers c
          ON c.tenant_id = x.tenant_id AND c.record_id = x.customer_record_id
       WHERE x.tenant_id = p_tenant AND x.record_id = p_record
         AND x.amount = p_amount
         AND (c.email = p_email OR c.email_index = p_email_index))
  $$;
REVOKE ALL ON FUNCTION app.import_credit_matches(uuid, uuid, integer, text, text) FROM PUBLIC;

-- As 0051, matching a booking to the account by address or by token.
CREATE OR REPLACE FUNCTION app.apply_credit_entry() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  acct record;
  next_balance bigint;
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() THEN
    RAISE EXCEPTION 'a credit entry is written in its own tenant'
      USING ERRCODE = '42501', CONSTRAINT = 'credit_entries_tenant';
  END IF;
  NEW.created_at := now();
  NEW.actor_type := coalesce(app.setting_or_null('app.actor_type'), 'system');
  NEW.actor_id := app.setting_or_null('app.actor_id');
  NEW.request_id := app.setting_or_null('app.request_id');

  SELECT a.id, a.customer_email, a.customer_email_index, a.balance, a.entry_count INTO acct
    FROM public.credit_accounts a
   WHERE a.tenant_id = NEW.tenant_id AND a.id = NEW.account_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no credit account % for this tenant', NEW.account_id
      USING ERRCODE = '23503', CONSTRAINT = 'credit_entries_account';
  END IF;

  -- A booking an entry names belongs to the account's customer.
  IF NEW.booking_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.bookings bk
         JOIN public.checkout_sessions s
           ON s.tenant_id = bk.tenant_id AND s.id = bk.checkout_session_id
        WHERE bk.tenant_id = NEW.tenant_id AND bk.id = NEW.booking_id
          AND (s.booker_email = acct.customer_email
               OR s.booker_email_index = acct.customer_email_index)) THEN
    RAISE EXCEPTION 'booking % is not this credit account''s customer''s', NEW.booking_id
      USING ERRCODE = '23514', CONSTRAINT = 'credit_entries_customer';
  END IF;

  IF NEW.kind = 'issue' THEN
    IF NOT EXISTS (
         SELECT 1 FROM public.booking_cancellations c
           JOIN public.bookings bk ON bk.tenant_id = c.tenant_id AND bk.id = c.booking_id
          WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.cancellation_id
            AND c.booking_id = NEW.booking_id AND c.remedy = 'credit'
            AND c.credit_entry_id = NEW.id AND c.credit_amount = NEW.amount
            AND bk.state = 'canceled') THEN
      RAISE EXCEPTION 'credit is issued for exactly what its canceled booking''s cancellation computed'
        USING ERRCODE = '23514', CONSTRAINT = 'credit_entries_issue';
    END IF;
    IF NEW.expires_at IS NOT NULL AND NEW.expires_at <= now() THEN
      RAISE EXCEPTION 'credit cannot be issued already expired'
        USING ERRCODE = '23514', CONSTRAINT = 'credit_entries_issue';
    END IF;
  ELSIF NEW.kind = 'reinstate' THEN
    IF NOT EXISTS (
         SELECT 1 FROM public.credit_entries r
           JOIN public.bookings bk ON bk.tenant_id = r.tenant_id AND bk.id = r.booking_id
          WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.reinstates_entry_id
            AND r.account_id = NEW.account_id AND r.kind = 'redeem'
            AND r.amount = -NEW.amount AND bk.state = 'canceled'
            AND NEW.booking_id IS NOT DISTINCT FROM r.booking_id) THEN
      RAISE EXCEPTION 'a reinstatement returns one redemption of this account whose booking was canceled'
        USING ERRCODE = '23514', CONSTRAINT = 'credit_entries_reinstate';
    END IF;
  ELSIF NEW.kind = 'import' THEN
    -- An opening balance (0046): one opening_balances.csv ledger row from
    -- this transaction's clean commit, written by signed-in staff, once.
    IF NEW.actor_type <> 'staff' OR NEW.actor_id IS NULL
       OR NOT app.import_record_live(NEW.tenant_id, NEW.import_record_id, 'opening_balances.csv') THEN
      RAISE EXCEPTION 'an imported credit names its opening_balances.csv record from this commit'
        USING ERRCODE = '23514', CONSTRAINT = 'credit_entries_import';
    END IF;
    -- What that row said (0051): its amount, and its customer's email is the
    -- account's.
    IF NOT app.import_credit_matches(NEW.tenant_id, NEW.import_record_id, NEW.amount,
                                     acct.customer_email, acct.customer_email_index) THEN
      RAISE EXCEPTION 'an imported credit is the amount its record gives, on its customer''s account'
        USING ERRCODE = '23514', CONSTRAINT = 'credit_entries_import_match';
    END IF;
  ELSIF NEW.kind = 'adjust' THEN
    IF NEW.actor_type NOT IN ('staff', 'support') THEN
      RAISE EXCEPTION 'only staff adjust a credit balance'
        USING ERRCODE = '23514', CONSTRAINT = 'credit_entries_adjust';
    END IF;
  END IF;

  next_balance := acct.balance::bigint + NEW.amount;
  IF next_balance < 0 THEN
    RAISE EXCEPTION 'credit account % holds %; it cannot give %', NEW.account_id, acct.balance, -NEW.amount
      USING ERRCODE = '23514', CONSTRAINT = 'credit_entries_balance';
  END IF;
  IF next_balance > 1000000000 THEN
    RAISE EXCEPTION 'credit account % would exceed the largest balance', NEW.account_id
      USING ERRCODE = '23514', CONSTRAINT = 'credit_entries_balance';
  END IF;
  NEW.balance_after := next_balance::integer;
  NEW.seq := acct.entry_count + 1;
  UPDATE public.credit_accounts
     SET balance = next_balance::integer, entry_count = acct.entry_count + 1, updated_at = now()
   WHERE tenant_id = NEW.tenant_id AND id = NEW.account_id;
  RETURN NEW;
END;
$$;

DROP FUNCTION app.import_credit_matches(uuid, uuid, integer, text);
