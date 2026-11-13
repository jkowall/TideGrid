-- 0045 import commit, part B: private charter balances (W3-G2.13)
--
-- Under the owner's approval of the standard CSV import draft on 2026-11-13
-- (all twelve answers as recommended) and the code-only pull-forward of
-- Wave 3. Synthetic data only. What it adds to 0044:
--
-- 1. An imported private charter may carry an outstanding balance. Its order
--    records what came in before TideGrid as its deposit (0 when nothing did)
--    and the balance's due instant, which falls before the trip starts. The
--    balance then reads, pays, and moves as any charter balance does (0033):
--    app.booking_balance counts the imported payments as money in.
-- 2. Only an imported order (no quote, an import ledger row from this
--    transaction) carries a deposit of 0.
--
-- Choices made here are coordinator defaults pending owner confirmation (the
-- "W3-G2.13, part B" register entry). Tenancy follows
-- packages/database/README.md.

-- 1. A deposit of 0 only on an imported order ------------------------------------------

ALTER TABLE public.orders
  DROP CONSTRAINT orders_deposit_amount_check,
  ADD CONSTRAINT orders_deposit_amount_check CHECK (
    deposit_amount BETWEEN 1 AND 100000000
    OR (deposit_amount = 0 AND quote_id IS NULL));

-- 2. The order's deposit rules, with the imported charter's balance ---------------------

CREATE OR REPLACE FUNCTION app.check_order_deposit() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.deposit_amount IS DISTINCT FROM OLD.deposit_amount
       OR NEW.balance_due_at IS DISTINCT FROM OLD.balance_due_at THEN
      RAISE EXCEPTION 'an order keeps its deposit and due date'
        USING ERRCODE = '23514', CONSTRAINT = 'orders_deposit';
    END IF;
    RETURN NEW;
  END IF;
  -- An imported order (0044) is paid in full, or (0045) is a private
  -- charter's whose balance falls due before its trip starts, saved by an
  -- import commit in this transaction.
  IF NEW.quote_id IS NULL THEN
    IF NEW.deposit_amount IS NULL AND NEW.balance_due_at IS NULL THEN
      RETURN NEW;
    END IF;
    IF NEW.deposit_amount IS NULL OR NEW.balance_due_at IS NULL
       OR NOT app.import_checkout_live(NEW.tenant_id, NEW.checkout_session_id)
       OR NOT EXISTS (
         SELECT 1 FROM public.products p
           JOIN public.scheduled_trips t
             ON t.tenant_id = p.tenant_id AND t.id = NEW.trip_id AND t.product_id = p.id
          WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.product_id
            AND p.kind = 'private_charter'
            AND NEW.balance_due_at <= t.starts_at) THEN
      RAISE EXCEPTION 'imported order % carries a balance only as a charter''s, due before its trip', NEW.id
        USING ERRCODE = '23514', CONSTRAINT = 'orders_deposit';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.quotes q
     WHERE q.tenant_id = NEW.tenant_id AND q.id = NEW.quote_id
       AND q.deposit_amount IS NOT DISTINCT FROM NEW.deposit_amount
       AND q.balance_due_at IS NOT DISTINCT FROM NEW.balance_due_at
  ) THEN
    RAISE EXCEPTION 'order % does not carry its quote''s deposit', NEW.id
      USING ERRCODE = '23514', CONSTRAINT = 'orders_deposit';
  END IF;
  RETURN NEW;
END;
$$;
