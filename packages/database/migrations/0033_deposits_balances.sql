-- 0033 private charter deposits and balances (W3-G2.8)
--
-- Under the owner's code-only pull-forward of 2026-11-08 and his go on the
-- rest of Wave 3 on 2026-11-10 (the W3-G2.8 entry in
-- docs/v2/06-decision-register.md). Synthetic data and the fake provider
-- only. What it adds (docs/v2/02, "Private-charter deposit and balance"):
--
-- 1. Deposit terms on a charter's price list version: full payment (the
--    default, and the only choice for shared seats), a fixed deposit, or a
--    percentage of the booking's total, with one balance due date a whole
--    number of days before the trip starts.
-- 2. The quote and its order carry the deposit and the balance due instant
--    the terms give at the quote instant. A booking made on or after that
--    instant, or whose deposit would be the whole total, pays in full.
-- 3. Checkout charges the deposit, or the total when there is none.
-- 4. balance_payments: the card payment of what is left, one open at a time
--    per booking, for exactly the balance owed when it was opened. Only a
--    verified provider event marks one paid or failed, as for payments.
-- 5. balance_due_changes: staff move a booking's due date with a reason.
--    Append-only; the newest one is the due date.
-- 6. app.booking_balance: what a booking owes, from its order, its deposit
--    payment, its balance payments, and the external payments staff
--    recorded (0031). Nothing is ever charged without the guest, and nothing
--    cancels a booking because a balance is unpaid.
-- 7. The external refund and card refund limits of 0031 count a balance
--    paid by card as money in.
--
-- Choices made here are coordinator defaults pending owner confirmation (the
-- W3-G2.8 register entry). Tenancy follows packages/database/README.md.

-- 1. Deposit terms ------------------------------------------------------------------

ALTER TABLE public.price_list_versions
  ADD COLUMN deposit_kind text NOT NULL DEFAULT 'none'
    CHECK (deposit_kind IN ('none', 'fixed', 'percent')),
  ADD COLUMN deposit_amount integer CHECK (deposit_amount BETWEEN 1 AND 100000000),
  ADD COLUMN deposit_bp integer CHECK (deposit_bp BETWEEN 1 AND 9999),
  ADD COLUMN balance_due_days integer CHECK (balance_due_days BETWEEN 1 AND 365),
  ADD CONSTRAINT price_list_versions_deposit CHECK (
    (deposit_kind = 'none' AND deposit_amount IS NULL AND deposit_bp IS NULL
       AND balance_due_days IS NULL)
    OR (deposit_kind = 'fixed' AND deposit_amount IS NOT NULL AND deposit_bp IS NULL
       AND balance_due_days IS NOT NULL)
    OR (deposit_kind = 'percent' AND deposit_amount IS NULL AND deposit_bp IS NOT NULL
       AND balance_due_days IS NOT NULL)),
  ADD CONSTRAINT price_list_versions_deposit_charter
    CHECK (deposit_kind = 'none' OR product_kind = 'private_charter');

-- 2. The quote's and the order's deposit ---------------------------------------------

ALTER TABLE public.quotes
  ADD COLUMN deposit_amount integer CHECK (deposit_amount BETWEEN 1 AND 100000000),
  ADD COLUMN balance_due_at timestamptz,
  ADD CONSTRAINT quotes_deposit_fields CHECK (
    (deposit_amount IS NULL) = (balance_due_at IS NULL)
    AND (deposit_amount IS NULL OR deposit_amount < total_amount)
    AND (balance_due_at IS NULL OR balance_due_at < trip_starts_at));

ALTER TABLE public.orders
  ADD COLUMN deposit_amount integer CHECK (deposit_amount BETWEEN 1 AND 100000000),
  ADD COLUMN balance_due_at timestamptz,
  ADD CONSTRAINT orders_deposit_fields CHECK (
    (deposit_amount IS NULL) = (balance_due_at IS NULL)
    AND (deposit_amount IS NULL OR deposit_amount < total_amount));

-- The deposit the price list version's terms give for this total, trip, and
-- quote instant: null when the booking pays in full.
CREATE FUNCTION app.deposit_for(
  p_kind text, p_amount integer, p_bp integer, p_days integer,
  p_total integer, p_trip_starts_at timestamptz, p_quoted_at timestamptz)
  RETURNS TABLE (deposit_amount integer, balance_due_at timestamptz)
  LANGUAGE sql IMMUTABLE
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT CASE WHEN ok THEN d END, CASE WHEN ok THEN due END
      FROM (
        SELECT d, due,
               p_kind <> 'none' AND d BETWEEN 1 AND p_total - 1 AND due > p_quoted_at AS ok
          FROM (
            SELECT CASE p_kind
                     WHEN 'fixed' THEN p_amount
                     WHEN 'percent' THEN ((p_total::bigint * p_bp + 5000) / 10000)::integer
                   END AS d,
                   p_trip_starts_at - make_interval(hours => coalesce(p_days, 0) * 24) AS due
          ) x
      ) y
  $$;

CREATE FUNCTION app.check_quote_deposit() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v record;
  expected record;
BEGIN
  SELECT p.deposit_kind, p.deposit_amount, p.deposit_bp, p.balance_due_days INTO v
    FROM public.price_list_versions p
   WHERE p.tenant_id = NEW.tenant_id AND p.product_id = NEW.product_id
     AND p.version = NEW.price_list_version;
  IF NOT FOUND THEN
    -- The foreign key reports it.
    RETURN NEW;
  END IF;
  SELECT * INTO expected FROM app.deposit_for(v.deposit_kind, v.deposit_amount, v.deposit_bp,
    v.balance_due_days, NEW.total_amount, NEW.trip_starts_at, NEW.quoted_at);
  IF NEW.deposit_amount IS DISTINCT FROM expected.deposit_amount
     OR NEW.balance_due_at IS DISTINCT FROM expected.balance_due_at THEN
    RAISE EXCEPTION 'a quote carries the deposit its price list version gives'
      USING ERRCODE = '23514', CONSTRAINT = 'quotes_deposit';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER quotes_deposit BEFORE INSERT ON public.quotes
  FOR EACH ROW EXECUTE FUNCTION app.check_quote_deposit();

CREATE FUNCTION app.check_order_deposit() RETURNS trigger
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
CREATE TRIGGER orders_deposit BEFORE INSERT OR UPDATE ON public.orders
  FOR EACH ROW EXECUTE FUNCTION app.check_order_deposit();

-- 3. Checkout charges the deposit (0007's payment rules, with that one change) -------

CREATE OR REPLACE FUNCTION app.check_payment() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  ev record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state IS DISTINCT FROM 'pending' OR NEW.provider_payment_id IS NOT NULL
       OR NEW.succeeded_event_id IS NOT NULL OR NEW.failed_event_id IS NOT NULL THEN
      RAISE EXCEPTION 'a payment starts pending, before the provider knows it'
        USING ERRCODE = '23514', CONSTRAINT = 'payments_transition';
    END IF;
    NEW.created_at := now();
    NEW.updated_at := now();
    NEW.provider_recorded_at := NULL;
    NEW.succeeded_at := NULL;
    NEW.failed_at := NULL;
    IF NOT EXISTS (
      SELECT 1 FROM public.orders o
       WHERE o.tenant_id = NEW.tenant_id AND o.id = NEW.order_id
         AND o.checkout_session_id = NEW.checkout_session_id
         AND coalesce(o.deposit_amount, o.total_amount) = NEW.amount
         AND o.currency = NEW.currency
         AND o.status = 'pending'
    ) THEN
      RAISE EXCEPTION 'a payment charges its own pending order''s total, or its deposit'
        USING ERRCODE = '23514', CONSTRAINT = 'payments_order';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.payment_accounts a
       WHERE a.tenant_id = NEW.tenant_id AND a.provider = NEW.provider
         AND a.account_ref = NEW.account_ref AND a.status = 'active'
    ) THEN
      RAISE EXCEPTION 'a payment needs the operator''s active account at its provider'
        USING ERRCODE = '23514', CONSTRAINT = 'payments_account';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.checkout_session_id IS DISTINCT FROM OLD.checkout_session_id
     OR NEW.order_id IS DISTINCT FROM OLD.order_id
     OR NEW.provider IS DISTINCT FROM OLD.provider
     OR NEW.account_ref IS DISTINCT FROM OLD.account_ref
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.amount IS DISTINCT FROM OLD.amount
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR (OLD.provider_payment_id IS NOT NULL
         AND NEW.provider_payment_id IS DISTINCT FROM OLD.provider_payment_id)
     OR (OLD.succeeded_event_id IS NOT NULL
         AND NEW.succeeded_event_id IS DISTINCT FROM OLD.succeeded_event_id)
     OR (OLD.failed_event_id IS NOT NULL
         AND NEW.failed_event_id IS DISTINCT FROM OLD.failed_event_id) THEN
    RAISE EXCEPTION 'a payment keeps its order, account, key, amount, provider id, and evidence'
      USING ERRCODE = '23514', CONSTRAINT = 'payments_immutable';
  END IF;
  NEW.provider_recorded_at := CASE
    WHEN OLD.provider_payment_id IS NULL AND NEW.provider_payment_id IS NOT NULL THEN now()
    ELSE OLD.provider_recorded_at END;
  NEW.succeeded_at := OLD.succeeded_at;
  NEW.failed_at := OLD.failed_at;
  NEW.updated_at := now();

  IF NEW.state = OLD.state THEN
    IF NEW.succeeded_event_id IS DISTINCT FROM OLD.succeeded_event_id
       OR NEW.failed_event_id IS DISTINCT FROM OLD.failed_event_id THEN
      RAISE EXCEPTION 'payment evidence is recorded only with its transition'
        USING ERRCODE = '23514', CONSTRAINT = 'payments_evidence';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT ((OLD.state = 'pending' AND NEW.state IN ('succeeded', 'failed'))
          OR (OLD.state = 'failed' AND NEW.state = 'succeeded')) THEN
    RAISE EXCEPTION 'a payment cannot move from % to %', OLD.state, NEW.state
      USING ERRCODE = '23514', CONSTRAINT = 'payments_transition';
  END IF;

  IF NEW.state = 'succeeded' THEN
    IF NEW.failed_event_id IS DISTINCT FROM OLD.failed_event_id THEN
      RAISE EXCEPTION 'payment evidence is recorded only with its transition'
        USING ERRCODE = '23514', CONSTRAINT = 'payments_evidence';
    END IF;
    SELECT e.event_type, e.provider, e.payment_ref, e.account_ref, e.amount, e.currency,
           e.client_reference
      INTO ev
      FROM public.provider_events e
     WHERE e.tenant_id = NEW.tenant_id AND e.id = NEW.succeeded_event_id;
    IF NOT FOUND
       OR ev.event_type <> 'payment.succeeded'
       OR ev.provider <> NEW.provider
       OR NEW.provider_payment_id IS NULL
       OR ev.payment_ref <> NEW.provider_payment_id
       OR ev.account_ref <> NEW.account_ref
       OR ev.amount <> NEW.amount
       OR ev.currency <> NEW.currency
       OR (ev.client_reference IS NOT NULL AND ev.client_reference <> NEW.id) THEN
      RAISE EXCEPTION 'payment % succeeds only with a verified success event for it', NEW.id
        USING ERRCODE = '23514', CONSTRAINT = 'payments_evidence';
    END IF;
    NEW.succeeded_at := now();
  ELSE
    IF NEW.succeeded_event_id IS NOT NULL THEN
      RAISE EXCEPTION 'payment evidence is recorded only with its transition'
        USING ERRCODE = '23514', CONSTRAINT = 'payments_evidence';
    END IF;
    SELECT e.event_type, e.provider, e.payment_ref, e.account_ref, e.client_reference
      INTO ev
      FROM public.provider_events e
     WHERE e.tenant_id = NEW.tenant_id AND e.id = NEW.failed_event_id;
    IF NOT FOUND
       OR ev.event_type <> 'payment.failed'
       OR ev.provider <> NEW.provider
       OR NEW.provider_payment_id IS NULL
       OR ev.payment_ref <> NEW.provider_payment_id
       OR ev.account_ref <> NEW.account_ref
       OR (ev.client_reference IS NOT NULL AND ev.client_reference <> NEW.id) THEN
      RAISE EXCEPTION 'payment % fails only with a verified failure event for it', NEW.id
        USING ERRCODE = '23514', CONSTRAINT = 'payments_evidence';
    END IF;
    NEW.failed_at := now();
  END IF;
  RETURN NEW;
END;
$$;


CREATE OR REPLACE FUNCTION app.check_external_settlement() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  b record;
  money_in bigint;
  refunded bigint;
  left_to_reverse bigint;
BEGIN
  NEW.created_at := now();
  NEW.actor_type := coalesce(app.setting_or_null('app.actor_type'), 'system');
  NEW.actor_id := app.setting_or_null('app.actor_id');
  NEW.request_id := app.setting_or_null('app.request_id');
  IF NEW.actor_type <> 'staff' OR NEW.actor_id IS NULL THEN
    RAISE EXCEPTION 'a signed-in staff member records external money'
      USING ERRCODE = '42501', CONSTRAINT = 'external_settlements_actor';
  END IF;
  SELECT x.id, x.payment_id, o.total_amount,
         o.total_amount - o.tax_amount - o.included_tax_amount AS eligible_total
    INTO b
    FROM public.bookings x
    JOIN public.orders o ON o.tenant_id = x.tenant_id AND o.id = x.order_id
   WHERE x.tenant_id = NEW.tenant_id AND x.id = NEW.booking_id
     FOR NO KEY UPDATE OF x;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no booking % to record against', NEW.booking_id
      USING ERRCODE = '23503', CONSTRAINT = 'external_settlements_booking';
  END IF;
  IF NEW.kind = 'payment' THEN
    NEW.order_total := NULL;
    NEW.eligible_total := NULL;
    NEW.eligible_amount := NULL;
    NEW.fee_bp := NULL;
    NEW.fee_amount := NULL;
    RETURN NEW;
  END IF;
  -- A card refund takes the payment's lock (0029); so does this, so the two
  -- never pass the limits below together.
  PERFORM 1 FROM public.payments p
    WHERE p.tenant_id = NEW.tenant_id AND p.id = b.payment_id
      FOR NO KEY UPDATE;
  IF b.total_amount IS DISTINCT FROM NEW.order_total
     OR b.eligible_total IS DISTINCT FROM NEW.eligible_total THEN
    RAISE EXCEPTION 'an external refund carries its order''s totals as they are'
      USING ERRCODE = '23514', CONSTRAINT = 'external_settlements_order';
  END IF;
  SELECT coalesce(sum(r.amount) FILTER (WHERE r.state IN ('requested', 'pending', 'succeeded')), 0)
    INTO refunded
    FROM public.payment_refunds r
   WHERE r.tenant_id = NEW.tenant_id AND r.payment_id = b.payment_id;
  -- A lost dispute took its amount back from the card payment.
  SELECT (SELECT CASE WHEN p.state = 'succeeded' THEN p.amount ELSE 0 END
            FROM public.payments p
           WHERE p.tenant_id = NEW.tenant_id AND p.id = b.payment_id)
         - (SELECT coalesce(sum(d.amount), 0) FROM public.payment_disputes d
             WHERE d.tenant_id = NEW.tenant_id AND d.payment_id = b.payment_id
               AND d.status = 'lost')
         - refunded
         -- A balance paid by card (0033) came in too.
         + (SELECT coalesce(sum(bp.amount), 0) FROM public.balance_payments bp
             WHERE bp.tenant_id = NEW.tenant_id AND bp.booking_id = NEW.booking_id
               AND bp.state = 'succeeded')
         + coalesce(sum(s.amount) FILTER (WHERE s.kind = 'payment'), 0)
         - coalesce(sum(s.amount) FILTER (WHERE s.kind = 'refund'), 0),
         refunded + coalesce(sum(s.amount) FILTER (WHERE s.kind = 'refund'), 0)
    INTO money_in, refunded
    FROM public.external_settlements s
   WHERE s.tenant_id = NEW.tenant_id AND s.booking_id = NEW.booking_id;
  IF NEW.amount > money_in THEN
    RAISE EXCEPTION 'an external refund returns at most the money that came in'
      USING ERRCODE = '23514', CONSTRAINT = 'external_settlements_refund_limit';
  END IF;
  IF refunded + NEW.amount > b.total_amount THEN
    RAISE EXCEPTION 'refunds return at most what the booking cost'
      USING ERRCODE = '23514', CONSTRAINT = 'external_settlements_refund_limit';
  END IF;
  -- Rounding each refund on its own could reverse more than the fee on the
  -- whole booking: the reversal is capped at what is left of that fee after
  -- earlier reversals, card and external.
  SELECT greatest(0, ((b.eligible_total::bigint * NEW.fee_bp + 5000) / 10000)
           + (SELECT coalesce(sum(f.fee_amount), 0) FROM public.fee_ledger_entries f
               WHERE f.tenant_id = NEW.tenant_id AND f.booking_id = NEW.booking_id)
           + (SELECT coalesce(sum(x.fee_amount), 0) FROM public.external_settlements x
               WHERE x.tenant_id = NEW.tenant_id AND x.booking_id = NEW.booking_id
                 AND x.kind = 'refund'))
    INTO left_to_reverse;
  IF NEW.fee_amount IS DISTINCT FROM greatest(
       -(((NEW.eligible_amount::bigint * NEW.fee_bp) + 5000) / 10000), -left_to_reverse) THEN
    RAISE EXCEPTION 'an external refund reverses its share of the fee, at most what is left'
      USING ERRCODE = '23514', CONSTRAINT = 'external_settlements_fee';
  END IF;
  RETURN NEW;
END;
$$;


CREATE OR REPLACE FUNCTION app.check_card_refund_with_external() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  total integer;
  card bigint;
  external bigint;
  booking uuid;
BEGIN
  IF NEW.reason = 'unfulfilled_payment' THEN
    RETURN NEW;
  END IF;
  PERFORM 1 FROM public.payments p
    WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.payment_id
      FOR NO KEY UPDATE;
  SELECT b.id, o.total_amount INTO booking, total
    FROM public.bookings b
    JOIN public.orders o ON o.tenant_id = b.tenant_id AND o.id = b.order_id
   WHERE b.tenant_id = NEW.tenant_id AND b.payment_id = NEW.payment_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  SELECT coalesce(sum(r.amount), 0) INTO card
    FROM public.payment_refunds r
   WHERE r.tenant_id = NEW.tenant_id AND r.payment_id = NEW.payment_id
     AND r.state IN ('requested', 'pending', 'succeeded');
  SELECT coalesce(sum(x.amount), 0) INTO external
    FROM public.external_settlements x
   WHERE x.tenant_id = NEW.tenant_id AND x.booking_id = booking AND x.kind = 'refund';
  IF card + external + NEW.amount > total THEN
    RAISE EXCEPTION 'refunds return at most what the booking cost, external refunds included'
      USING ERRCODE = '23514', CONSTRAINT = 'payment_refunds_external_limit';
  END IF;
  -- A lost dispute already took its amount back from the card.
  IF card + NEW.amount > (SELECT p.amount FROM public.payments p
                           WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.payment_id)
       - (SELECT coalesce(sum(d.amount), 0) FROM public.payment_disputes d
           WHERE d.tenant_id = NEW.tenant_id AND d.payment_id = NEW.payment_id
             AND d.status = 'lost') THEN
    RAISE EXCEPTION 'a card refund returns at most what a lost dispute left on the card'
      USING ERRCODE = '23514', CONSTRAINT = 'payment_refunds_external_limit';
  END IF;
  -- And at most the money still held across card and external tender: what
  -- came in, less lost disputes and every refund so far.
  IF card + external + NEW.amount >
       (SELECT CASE WHEN p.state = 'succeeded' THEN p.amount ELSE 0 END FROM public.payments p
         WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.payment_id)
       + (SELECT coalesce(sum(x.amount), 0) FROM public.external_settlements x
           WHERE x.tenant_id = NEW.tenant_id AND x.booking_id = booking AND x.kind = 'payment')
       + (SELECT coalesce(sum(bp.amount), 0) FROM public.balance_payments bp
           WHERE bp.tenant_id = NEW.tenant_id AND bp.booking_id = booking
             AND bp.state = 'succeeded')
       - (SELECT coalesce(sum(d.amount), 0) FROM public.payment_disputes d
           WHERE d.tenant_id = NEW.tenant_id AND d.payment_id = NEW.payment_id
             AND d.status = 'lost') THEN
    RAISE EXCEPTION 'a card refund returns at most the money still held'
      USING ERRCODE = '23514', CONSTRAINT = 'payment_refunds_external_limit';
  END IF;
  RETURN NEW;
END;
$$;

-- 4. What a booking owes ---------------------------------------------------------------

-- Staff move a booking's balance due date, with a reason. Append-only; the
-- newest row is the due date. Only a signed-in staff member writes one, for a
-- booking with a balance that is not canceled, to an instant before its trip.
CREATE TABLE public.balance_due_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  booking_id uuid NOT NULL,
  due_at timestamptz NOT NULL,
  reason text NOT NULL
    CHECK (char_length(reason) BETWEEN 1 AND 500 AND reason !~ '[\x01-\x1f\x7f]'),
  created_at timestamptz NOT NULL DEFAULT now(),
  actor_type text NOT NULL DEFAULT coalesce(app.setting_or_null('app.actor_type'), 'system')
    CHECK (actor_type IN ('staff', 'guest', 'system', 'support')),
  actor_id text DEFAULT app.setting_or_null('app.actor_id'),
  request_id text DEFAULT app.setting_or_null('app.request_id'),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, booking_id) REFERENCES public.bookings (tenant_id, id)
);
CREATE INDEX balance_due_changes_booking_idx
  ON public.balance_due_changes (tenant_id, booking_id, created_at DESC, id DESC);

-- A card payment of a booking's balance. Opened for exactly the balance owed,
-- one open (pending) at a time per booking; a guest who comes back after the
-- balance changed gets a new one, and the old one is abandoned. Only a
-- verified provider event marks one succeeded or failed; an abandoned one the
-- guest still pays is recorded as paid, because the money moved.
CREATE TABLE public.balance_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  booking_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('fake', 'stripe')),
  account_ref text NOT NULL,
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9_:-]{8,255}$'),
  provider_payment_id text CHECK (provider_payment_id ~ '^[A-Za-z0-9_]{3,255}$'),
  amount integer NOT NULL CHECK (amount BETWEEN 1 AND 100000000),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'succeeded', 'failed', 'abandoned')),
  succeeded_event_id uuid,
  failed_event_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  provider_recorded_at timestamptz,
  succeeded_at timestamptz,
  failed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  actor_type text NOT NULL DEFAULT coalesce(app.setting_or_null('app.actor_type'), 'system')
    CHECK (actor_type IN ('staff', 'guest', 'system', 'support')),
  actor_id text DEFAULT app.setting_or_null('app.actor_id'),
  UNIQUE (tenant_id, id),
  CONSTRAINT balance_payments_idempotency_key UNIQUE (provider, idempotency_key),
  CONSTRAINT balance_payments_provider_payment UNIQUE (provider, provider_payment_id),
  FOREIGN KEY (tenant_id, booking_id) REFERENCES public.bookings (tenant_id, id),
  FOREIGN KEY (tenant_id, provider, account_ref)
    REFERENCES public.payment_accounts (tenant_id, provider, account_ref),
  FOREIGN KEY (tenant_id, succeeded_event_id) REFERENCES public.provider_events (tenant_id, id),
  FOREIGN KEY (tenant_id, failed_event_id) REFERENCES public.provider_events (tenant_id, id),
  CHECK ((state = 'succeeded') = (succeeded_event_id IS NOT NULL AND succeeded_at IS NOT NULL)),
  CHECK ((failed_event_id IS NULL) = (failed_at IS NULL)),
  CHECK ((provider_payment_id IS NULL) = (provider_recorded_at IS NULL)),
  CHECK (state IN ('pending', 'abandoned') OR provider_payment_id IS NOT NULL)
);
CREATE UNIQUE INDEX balance_payments_one_open
  ON public.balance_payments (tenant_id, booking_id) WHERE state = 'pending';
CREATE INDEX balance_payments_booking_idx
  ON public.balance_payments (tenant_id, booking_id, created_at);

-- The booking's balance: its order's total and deposit, its due date (the
-- newest change, else the order's), what came in toward it (the deposit
-- payment, balance payments, and external payments), and what is owed (never
-- below zero; `paid_in` above the total shows an overpayment). Empty for a
-- booking that paid in full at checkout. Runs as the caller, under its
-- tenant's row-level security.
CREATE FUNCTION app.booking_balance(p_tenant_id uuid, p_booking_id uuid)
  RETURNS TABLE (total_amount integer, deposit_amount integer, due_at timestamptz,
                 original_due_at timestamptz, paid_in bigint, owed bigint)
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT o.total_amount, o.deposit_amount,
           coalesce((SELECT c.due_at FROM public.balance_due_changes c
                      WHERE c.tenant_id = b.tenant_id AND c.booking_id = b.id
                      ORDER BY c.created_at DESC, c.id DESC LIMIT 1), o.balance_due_at),
           o.balance_due_at,
           x.paid_in, greatest(0, o.total_amount - x.paid_in)
      FROM public.bookings b
      JOIN public.orders o ON o.tenant_id = b.tenant_id AND o.id = b.order_id
      CROSS JOIN LATERAL (
        SELECT (SELECT coalesce(sum(p.amount), 0) FROM public.payments p
                 WHERE p.tenant_id = b.tenant_id AND p.id = b.payment_id
                   AND p.state = 'succeeded')
             + (SELECT coalesce(sum(bp.amount), 0) FROM public.balance_payments bp
                 WHERE bp.tenant_id = b.tenant_id AND bp.booking_id = b.id
                   AND bp.state = 'succeeded')
             + (SELECT coalesce(sum(s.amount), 0) FROM public.external_settlements s
                 WHERE s.tenant_id = b.tenant_id AND s.booking_id = b.id AND s.kind = 'payment')
             AS paid_in
      ) x
     WHERE b.tenant_id = p_tenant_id AND b.id = p_booking_id AND o.deposit_amount IS NOT NULL
  $$;

CREATE FUNCTION app.check_balance_due_change() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  NEW.created_at := now();
  NEW.actor_type := coalesce(app.setting_or_null('app.actor_type'), 'system');
  NEW.actor_id := app.setting_or_null('app.actor_id');
  NEW.request_id := app.setting_or_null('app.request_id');
  IF NEW.actor_type <> 'staff' OR NEW.actor_id IS NULL THEN
    RAISE EXCEPTION 'a signed-in staff member moves a balance due date'
      USING ERRCODE = '42501', CONSTRAINT = 'balance_due_changes_actor';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.bookings b
      JOIN public.orders o ON o.tenant_id = b.tenant_id AND o.id = b.order_id
      JOIN public.scheduled_trips t ON t.tenant_id = b.tenant_id AND t.id = b.trip_id
     WHERE b.tenant_id = NEW.tenant_id AND b.id = NEW.booking_id
       AND b.state = 'confirmed' AND o.deposit_amount IS NOT NULL
       AND NEW.due_at < t.starts_at
  ) THEN
    RAISE EXCEPTION 'a due date moves only on a confirmed booking with a balance, before its trip'
      USING ERRCODE = '23514', CONSTRAINT = 'balance_due_changes_booking';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER balance_due_changes_rules BEFORE INSERT ON public.balance_due_changes
  FOR EACH ROW EXECUTE FUNCTION app.check_balance_due_change();

-- A balance payment opens on a confirmed booking with a balance, for exactly
-- what it owes, under the booking's lock (so two cannot open at once against
-- the same balance, and a staff record of external money waits for it). It
-- moves as a payment does: pending to succeeded or failed on a verified
-- event; failed to succeeded on a later verified success; pending to
-- abandoned when a new one replaces it; abandoned to succeeded on a verified
-- success, because the money moved.
CREATE FUNCTION app.check_balance_payment() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  ev record;
  owed_now bigint;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state IS DISTINCT FROM 'pending' OR NEW.provider_payment_id IS NOT NULL
       OR NEW.succeeded_event_id IS NOT NULL OR NEW.failed_event_id IS NOT NULL THEN
      RAISE EXCEPTION 'a balance payment starts pending, before the provider knows it'
        USING ERRCODE = '23514', CONSTRAINT = 'balance_payments_transition';
    END IF;
    NEW.created_at := now();
    NEW.updated_at := now();
    NEW.provider_recorded_at := NULL;
    NEW.succeeded_at := NULL;
    NEW.failed_at := NULL;
    NEW.actor_type := coalesce(app.setting_or_null('app.actor_type'), 'system');
    NEW.actor_id := app.setting_or_null('app.actor_id');
    PERFORM 1 FROM public.bookings b
      WHERE b.tenant_id = NEW.tenant_id AND b.id = NEW.booking_id AND b.state = 'confirmed'
        FOR NO KEY UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'a balance is paid only on a confirmed booking'
        USING ERRCODE = '23514', CONSTRAINT = 'balance_payments_booking';
    END IF;
    SELECT x.owed INTO owed_now FROM app.booking_balance(NEW.tenant_id, NEW.booking_id) x;
    IF owed_now IS NULL OR owed_now <> NEW.amount THEN
      RAISE EXCEPTION 'a balance payment charges exactly what the booking owes'
        USING ERRCODE = '23514', CONSTRAINT = 'balance_payments_amount';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.payment_accounts a
       WHERE a.tenant_id = NEW.tenant_id AND a.provider = NEW.provider
         AND a.account_ref = NEW.account_ref AND a.status = 'active'
    ) THEN
      RAISE EXCEPTION 'a balance payment needs the operator''s active account at its provider'
        USING ERRCODE = '23514', CONSTRAINT = 'balance_payments_account';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.booking_id IS DISTINCT FROM OLD.booking_id
     OR NEW.provider IS DISTINCT FROM OLD.provider
     OR NEW.account_ref IS DISTINCT FROM OLD.account_ref
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.amount IS DISTINCT FROM OLD.amount
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.actor_type IS DISTINCT FROM OLD.actor_type
     OR NEW.actor_id IS DISTINCT FROM OLD.actor_id
     OR (OLD.provider_payment_id IS NOT NULL
         AND NEW.provider_payment_id IS DISTINCT FROM OLD.provider_payment_id)
     OR (OLD.succeeded_event_id IS NOT NULL
         AND NEW.succeeded_event_id IS DISTINCT FROM OLD.succeeded_event_id)
     OR (OLD.failed_event_id IS NOT NULL
         AND NEW.failed_event_id IS DISTINCT FROM OLD.failed_event_id) THEN
    RAISE EXCEPTION 'a balance payment keeps its booking, account, key, amount, provider id, and evidence'
      USING ERRCODE = '23514', CONSTRAINT = 'balance_payments_immutable';
  END IF;
  NEW.provider_recorded_at := CASE
    WHEN OLD.provider_payment_id IS NULL AND NEW.provider_payment_id IS NOT NULL THEN now()
    ELSE OLD.provider_recorded_at END;
  NEW.succeeded_at := OLD.succeeded_at;
  NEW.failed_at := OLD.failed_at;
  NEW.updated_at := now();

  IF NEW.state = OLD.state THEN
    IF NEW.succeeded_event_id IS DISTINCT FROM OLD.succeeded_event_id
       OR NEW.failed_event_id IS DISTINCT FROM OLD.failed_event_id THEN
      RAISE EXCEPTION 'balance payment evidence is recorded only with its transition'
        USING ERRCODE = '23514', CONSTRAINT = 'balance_payments_evidence';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT ((OLD.state = 'pending' AND NEW.state IN ('succeeded', 'failed', 'abandoned'))
          OR (OLD.state IN ('failed', 'abandoned') AND NEW.state = 'succeeded')) THEN
    RAISE EXCEPTION 'a balance payment cannot move from % to %', OLD.state, NEW.state
      USING ERRCODE = '23514', CONSTRAINT = 'balance_payments_transition';
  END IF;

  IF NEW.state = 'abandoned' THEN
    IF NEW.succeeded_event_id IS NOT NULL OR NEW.failed_event_id IS DISTINCT FROM OLD.failed_event_id THEN
      RAISE EXCEPTION 'balance payment evidence is recorded only with its transition'
        USING ERRCODE = '23514', CONSTRAINT = 'balance_payments_evidence';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.state = 'succeeded' THEN
    IF NEW.failed_event_id IS DISTINCT FROM OLD.failed_event_id THEN
      RAISE EXCEPTION 'balance payment evidence is recorded only with its transition'
        USING ERRCODE = '23514', CONSTRAINT = 'balance_payments_evidence';
    END IF;
    SELECT e.event_type, e.provider, e.payment_ref, e.account_ref, e.amount, e.currency,
           e.client_reference
      INTO ev
      FROM public.provider_events e
     WHERE e.tenant_id = NEW.tenant_id AND e.id = NEW.succeeded_event_id;
    IF NOT FOUND
       OR ev.event_type <> 'payment.succeeded'
       OR ev.provider <> NEW.provider
       OR NEW.provider_payment_id IS NULL
       OR ev.payment_ref <> NEW.provider_payment_id
       OR ev.account_ref <> NEW.account_ref
       OR ev.amount <> NEW.amount
       OR ev.currency <> NEW.currency
       OR (ev.client_reference IS NOT NULL AND ev.client_reference <> NEW.id) THEN
      RAISE EXCEPTION 'balance payment % succeeds only with a verified success event for it', NEW.id
        USING ERRCODE = '23514', CONSTRAINT = 'balance_payments_evidence';
    END IF;
    NEW.succeeded_at := now();
  ELSE
    IF NEW.succeeded_event_id IS NOT NULL THEN
      RAISE EXCEPTION 'balance payment evidence is recorded only with its transition'
        USING ERRCODE = '23514', CONSTRAINT = 'balance_payments_evidence';
    END IF;
    SELECT e.event_type, e.provider, e.payment_ref, e.account_ref, e.client_reference
      INTO ev
      FROM public.provider_events e
     WHERE e.tenant_id = NEW.tenant_id AND e.id = NEW.failed_event_id;
    IF NOT FOUND
       OR ev.event_type <> 'payment.failed'
       OR ev.provider <> NEW.provider
       OR NEW.provider_payment_id IS NULL
       OR ev.payment_ref <> NEW.provider_payment_id
       OR ev.account_ref <> NEW.account_ref
       OR (ev.client_reference IS NOT NULL AND ev.client_reference <> NEW.id) THEN
      RAISE EXCEPTION 'balance payment % fails only with a verified failure event for it', NEW.id
        USING ERRCODE = '23514', CONSTRAINT = 'balance_payments_evidence';
    END IF;
    NEW.failed_at := now();
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER balance_payments_rules BEFORE INSERT OR UPDATE ON public.balance_payments
  FOR EACH ROW EXECUTE FUNCTION app.check_balance_payment();

-- External money recorded against a booking with an open balance payment
-- would change what it owes under the guest's feet: a staff payment takes
-- the booking's lock (0031) after any balance payment opened, and the guest's
-- next visit opens a new one for the new amount.

-- 5. A balance paid by card counts as money in (0031's limits, with that one change) --


-- Row-level security, append-only guards, and privileges ---------------------------------

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['balance_due_changes', 'balance_payments'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I'
      ' USING (tenant_id = (SELECT app.current_tenant_id()))'
      ' WITH CHECK (tenant_id = (SELECT app.current_tenant_id()))', t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE DELETE ON public.%I'
      ' FOR EACH ROW EXECUTE FUNCTION app.reject_mutation()', t || '_no_delete', t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I'
      ' FOR EACH STATEMENT EXECUTE FUNCTION app.reject_mutation()', t || '_no_truncate', t);
  END LOOP;
  EXECUTE 'CREATE TRIGGER balance_due_changes_append_only BEFORE UPDATE ON public.balance_due_changes'
          ' FOR EACH ROW EXECUTE FUNCTION app.reject_mutation()';
END
$$;

GRANT UPDATE (state, provider_payment_id, succeeded_event_id, failed_event_id)
  ON public.balance_payments TO tidegrid_app;

REVOKE ALL ON FUNCTION app.deposit_for(text, integer, integer, integer, integer, timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.deposit_for(text, integer, integer, integer, integer, timestamptz, timestamptz) TO tidegrid_app;
REVOKE ALL ON FUNCTION app.check_quote_deposit() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.check_order_deposit() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.check_balance_due_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.check_balance_payment() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.booking_balance(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.booking_balance(uuid, uuid) TO tidegrid_app;
