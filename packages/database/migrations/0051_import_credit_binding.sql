-- 0051 import commit, part C follow-up: bind an imported credit to its ledger row (W3-G2.13)
--
-- Under the owner's approval of the standard CSV import draft on 2026-11-13
-- and the code-only pull-forward of Wave 3. Synthetic data only. Tenancy
-- follows packages/database/README.md.
--
-- Part C (0046) let an `import` credit entry name an opening_balances.csv
-- ledger row from this transaction's clean commit, but the database did not
-- know which customer or how much that row said: any account and any amount
-- passed. This records both beside the ledger row, and the credit entry must
-- match them.
--
-- 1. import_credits: one row per opening_balances.csv ledger row, naming the
--    customers.csv ledger row of the customer it belongs to (from this batch
--    or an earlier one) and the amount in cents. Written in the commit, from
--    this transaction's live ledger row, once; append-only.
-- 2. An `import` credit entry must name a ledger row with an import_credits
--    row whose amount is the entry's, and whose customer's imported email is
--    the credit account's.

-- 1. What each opening balance said ---------------------------------------------------

CREATE TABLE public.import_credits (
  record_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  -- The customers.csv ledger row of the customer whose credit this is.
  customer_record_id uuid NOT NULL,
  amount integer NOT NULL CHECK (amount > 0 AND amount <= 1000000000),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, record_id),
  FOREIGN KEY (tenant_id, record_id) REFERENCES public.import_records (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_record_id) REFERENCES public.import_customers (tenant_id, record_id)
);

CREATE FUNCTION app.check_import_credit() RETURNS trigger
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
          AND c.email IS NOT NULL) THEN
    RAISE EXCEPTION 'an imported credit belongs to an imported customer with an email'
      USING ERRCODE = '23514', CONSTRAINT = 'import_credits_customer';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.check_import_credit() FROM PUBLIC;
CREATE TRIGGER import_credits_rules BEFORE INSERT ON public.import_credits
  FOR EACH ROW EXECUTE FUNCTION app.check_import_credit();

ALTER TABLE public.import_credits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.import_credits FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.import_credits
  USING (tenant_id = (SELECT app.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()));
CREATE TRIGGER import_credits_append_only BEFORE UPDATE OR DELETE ON public.import_credits
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();
CREATE TRIGGER import_credits_no_truncate BEFORE TRUNCATE ON public.import_credits
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_mutation();

-- 2. The credit entry matches it ------------------------------------------------------

-- Called by app.apply_credit_entry (a definer) for an `import` entry, with the
-- account's email. Invoker's rights: it reads the caller's tenant.
CREATE FUNCTION app.import_credit_matches(p_tenant uuid, p_record uuid, p_amount integer, p_email text)
  RETURNS boolean
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT EXISTS (
      SELECT 1 FROM public.import_credits x
        JOIN public.import_customers c
          ON c.tenant_id = x.tenant_id AND c.record_id = x.customer_record_id
       WHERE x.tenant_id = p_tenant AND x.record_id = p_record
         AND x.amount = p_amount AND c.email = p_email)
  $$;
REVOKE ALL ON FUNCTION app.import_credit_matches(uuid, uuid, integer, text) FROM PUBLIC;

-- As 0046, and an `import` entry matches its import_credits row.
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

  SELECT a.id, a.customer_email, a.balance, a.entry_count INTO acct
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
          AND s.booker_email = acct.customer_email) THEN
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
                                     acct.customer_email) THEN
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
