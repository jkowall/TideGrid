-- 0046 import commit, part C: opening booking credit (W3-G2.13)
--
-- Under the owner's approval of the standard CSV import draft on 2026-11-13
-- (all twelve answers as recommended) and the code-only pull-forward of
-- Wave 3. Synthetic data only. What it adds to 0044:
--
-- 1. opening_balances.csv rows join the import ledger.
-- 2. A credit entry of kind `import`: a named customer's booking credit
--    carried over from the legacy system, on the account of the email the
--    customer books with. It names its ledger row from this transaction's
--    clean commit, once, and only adds to the balance. Like all TideGrid
--    credit during the pilot it never expires (the legacy date stays in the
--    import's files); a restriction to some products is refused at the dry
--    run instead.
--
-- Trip cards and dollar cards stay refused (module_disabled): there is no
-- card module yet. Choices made here are coordinator defaults pending owner
-- confirmation (the "W3-G2.13, part C" register entry). Tenancy follows
-- packages/database/README.md.

-- 1. The ledger takes opening balances ------------------------------------------------

ALTER TABLE public.import_records
  DROP CONSTRAINT import_records_file_check,
  ADD CONSTRAINT import_records_file_check CHECK (file IN (
    'products.csv', 'trips.csv', 'customers.csv', 'bookings.csv', 'participants.csv',
    'payments.csv', 'opening_balances.csv'));

-- 2. Imported credit ------------------------------------------------------------------

ALTER TABLE public.credit_entries
  DROP CONSTRAINT credit_entries_kind_check,
  ADD CONSTRAINT credit_entries_kind_check
    CHECK (kind IN ('issue', 'redeem', 'reinstate', 'adjust', 'import')),
  ADD COLUMN import_record_id uuid,
  ADD CONSTRAINT credit_entries_import_record
    FOREIGN KEY (tenant_id, import_record_id) REFERENCES public.import_records (tenant_id, id),
  ADD CONSTRAINT credit_entries_import_once UNIQUE (tenant_id, import_record_id),
  ADD CONSTRAINT credit_entries_import_fields CHECK (
    (kind = 'import') = (import_record_id IS NOT NULL)
    AND (kind <> 'import' OR (amount > 0 AND booking_id IS NULL)));

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
