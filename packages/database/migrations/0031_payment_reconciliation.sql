-- 0031 external payment and reconciliation (W3-G2.10)
--
-- Under the owner's code-only pull-forward of 2026-11-08 (the W3-G2.10 entry
-- in docs/v2/06-decision-register.md). Synthetic data and the fake provider
-- only. What it adds:
--
-- 1. Disputes in the inbox: a verified `dispute.updated` event carries the
--    provider's dispute id, a neutral status, and a reason code. Never the
--    provider's whole dispute object.
-- 2. payment_disputes: one row per provider dispute on a TideGrid payment,
--    moved only by verified events. Closed (won, lost, closed) is final.
-- 3. external_settlements: cash, check, or other tender staff record against
--    a booking, with a reason and an idempotency key. Append-only. A refund
--    may not return more than came in, nor more than the booking cost, and
--    reverses TideGrid's fee on its eligible share, as a card refund does.
-- 4. fee_assessments: TideGrid's fee on a booking's eligible value, once per
--    booking: when its trip has ended, or when it was canceled (its final
--    closed outcome, docs/v2/03). Refunds reverse their share separately
--    (0029's fee_ledger_entries and the external refunds above).
-- 5. billing_plans and fee_invoices: one plan per tenant (written by TideGrid,
--    never by tenant staff) and one draft invoice per plan month. The
--    database computes each invoice's variable fee from the three ledgers for
--    that month in the plan's time zone, carries a negative balance forward
--    against later variable fees only, and adds the annual-minimum true-up in
--    the twelfth month of each contract year.
-- 6. Missing webhooks (D1): a pending payment past its checkout's hold is
--    looked up at the provider at most hourly for 7 days. A reading never
--    confirms, fails, or refunds anything: only a verified event does. A
--    reading that disagrees is raised once for staff in
--    payment_reconciliation_exceptions.
-- 7. app.reconciliation_tenants, for the reconciliation sweep, and the sweep's
--    name in sweep_turns.
--
-- Choices made here are coordinator defaults pending owner confirmation (the
-- W3-G2.10 register entry). D1 is the owner's decision with no default; the
-- proposal recorded here keeps a booking confirming only from a verified
-- provider event.
--
-- Tenancy follows packages/database/README.md: tenant_id on every row,
-- composite tenant foreign keys, forced row-level security with a
-- tenant_isolation policy, SELECT and INSERT from the default privileges,
-- UPDATE only on the columns that carry a change, and no DELETE or TRUNCATE
-- for any role. The index on payments, a pilot-volume table, is built
-- CONCURRENTLY in 0032.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'this migration must run as a role that bypasses row-level security';
  END IF;
END
$$;

-- 1. Disputes in the inbox ----------------------------------------------------------

ALTER TABLE public.provider_events
  ADD COLUMN dispute_ref text CHECK (dispute_ref ~ '^[A-Za-z0-9_]{3,255}$'),
  ADD COLUMN dispute_status text
    CHECK (dispute_status IN ('needs_response', 'under_review', 'won', 'lost', 'closed')),
  ADD COLUMN dispute_reason text CHECK (dispute_reason ~ '^[a-z][a-z0-9_]{0,63}$');
ALTER TABLE public.provider_events DROP CONSTRAINT provider_events_event_type_check;
ALTER TABLE public.provider_events
  ADD CONSTRAINT provider_events_event_type_check
    CHECK (event_type IN (
      'payment.succeeded', 'payment.failed', 'refund.updated', 'dispute.updated', 'other')),
  ADD CONSTRAINT provider_events_dispute_fields
    CHECK ((event_type = 'dispute.updated')
           = (dispute_ref IS NOT NULL AND dispute_status IS NOT NULL AND dispute_reason IS NOT NULL));

-- 0029's rule, with the dispute columns in the immutable content.
CREATE OR REPLACE FUNCTION app.check_provider_event() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.processing_state IS DISTINCT FROM 'received' OR NEW.outcome IS NOT NULL THEN
      RAISE EXCEPTION 'an inbox event starts received, without an outcome'
        USING ERRCODE = '23514', CONSTRAINT = 'provider_events_transition';
    END IF;
    NEW.verified_at := now();
    NEW.processed_at := NULL;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.provider IS DISTINCT FROM OLD.provider
     OR NEW.event_id IS DISTINCT FROM OLD.event_id
     OR NEW.event_type IS DISTINCT FROM OLD.event_type
     OR NEW.provider_type IS DISTINCT FROM OLD.provider_type
     OR NEW.account_ref IS DISTINCT FROM OLD.account_ref
     OR NEW.payment_ref IS DISTINCT FROM OLD.payment_ref
     OR NEW.client_reference IS DISTINCT FROM OLD.client_reference
     OR NEW.amount IS DISTINCT FROM OLD.amount
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.provider_created_at IS DISTINCT FROM OLD.provider_created_at
     OR NEW.payload_sha256 IS DISTINCT FROM OLD.payload_sha256
     OR NEW.verified_at IS DISTINCT FROM OLD.verified_at
     OR NEW.refund_ref IS DISTINCT FROM OLD.refund_ref
     OR NEW.refund_status IS DISTINCT FROM OLD.refund_status
     OR NEW.refund_key IS DISTINCT FROM OLD.refund_key
     OR NEW.refund_failure_code IS DISTINCT FROM OLD.refund_failure_code
     OR NEW.dispute_ref IS DISTINCT FROM OLD.dispute_ref
     OR NEW.dispute_status IS DISTINCT FROM OLD.dispute_status
     OR NEW.dispute_reason IS DISTINCT FROM OLD.dispute_reason THEN
    RAISE EXCEPTION 'an inbox event never changes; only its processing state moves'
      USING ERRCODE = '23514', CONSTRAINT = 'provider_events_immutable';
  END IF;
  IF OLD.processing_state = 'processed' THEN
    RAISE EXCEPTION 'inbox event % was already processed', OLD.id
      USING ERRCODE = '23514', CONSTRAINT = 'provider_events_transition';
  END IF;
  IF NEW.processing_state = 'received' THEN
    IF NEW.outcome IS NOT NULL THEN
      RAISE EXCEPTION 'an outcome is recorded only when the event is processed'
        USING ERRCODE = '23514', CONSTRAINT = 'provider_events_transition';
    END IF;
    NEW.processed_at := NULL;
    RETURN NEW;
  END IF;
  NEW.processed_at := now();
  RETURN NEW;
END;
$$;

-- 2. Disputes ------------------------------------------------------------------------

-- A provider dispute (a chargeback) on a TideGrid payment. Opened and moved
-- only by verified dispute events, in the transaction that processes them;
-- staff read it. A closed dispute (won, lost, or closed) never moves again.
CREATE TABLE public.payment_disputes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  payment_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('fake', 'stripe')),
  dispute_ref text NOT NULL CHECK (dispute_ref ~ '^[A-Za-z0-9_]{3,255}$'),
  amount integer NOT NULL CHECK (amount BETWEEN 1 AND 100000000),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  reason text NOT NULL CHECK (reason ~ '^[a-z][a-z0-9_]{0,63}$'),
  status text NOT NULL
    CHECK (status IN ('needs_response', 'under_review', 'won', 'lost', 'closed')),
  opened_event_id uuid NOT NULL,
  last_event_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  UNIQUE (tenant_id, id),
  CONSTRAINT payment_disputes_ref UNIQUE (provider, dispute_ref),
  FOREIGN KEY (tenant_id, payment_id) REFERENCES public.payments (tenant_id, id),
  FOREIGN KEY (tenant_id, opened_event_id) REFERENCES public.provider_events (tenant_id, id),
  FOREIGN KEY (tenant_id, last_event_id) REFERENCES public.provider_events (tenant_id, id),
  CHECK ((status IN ('won', 'lost', 'closed')) = (closed_at IS NOT NULL))
);
CREATE INDEX payment_disputes_recent_idx ON public.payment_disputes (tenant_id, created_at DESC);

CREATE FUNCTION app.check_payment_dispute() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  e record;
  prior_at timestamptz;
BEGIN
  -- The event names this dispute, its status, its amount, and this payment
  -- on its own account: a genuine event about another payment, another
  -- amount, or another reason never supports the row.
  SELECT x.event_type, x.provider, x.dispute_ref, x.dispute_status, x.dispute_reason, x.amount,
         x.currency, x.payment_ref, x.account_ref, x.provider_created_at
    INTO e FROM public.provider_events x
   WHERE x.tenant_id = NEW.tenant_id AND x.id = NEW.last_event_id;
  IF NOT FOUND OR e.event_type <> 'dispute.updated' OR e.provider <> NEW.provider
     OR e.dispute_ref <> NEW.dispute_ref OR e.dispute_status <> NEW.status
     OR e.amount IS DISTINCT FROM NEW.amount OR e.currency IS DISTINCT FROM NEW.currency
     OR NOT EXISTS (
       SELECT 1 FROM public.payments p
        WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.payment_id
          AND p.provider = e.provider AND p.provider_payment_id = e.payment_ref
          AND p.account_ref = e.account_ref
     ) THEN
    RAISE EXCEPTION 'a dispute moves only as its verified dispute event says'
      USING ERRCODE = '23514', CONSTRAINT = 'payment_disputes_event';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.opened_event_id IS DISTINCT FROM NEW.last_event_id
       OR e.dispute_reason IS DISTINCT FROM NEW.reason THEN
      RAISE EXCEPTION 'a dispute opens with the event that reported it'
        USING ERRCODE = '23514', CONSTRAINT = 'payment_disputes_event';
    END IF;
    -- A pending payment counts too: a dispute means the money moved, even
    -- when the payment's own event has not arrived (D1). Recording it changes
    -- nothing about the payment.
    IF NOT EXISTS (
      SELECT 1 FROM public.payments p
       WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.payment_id
         AND p.state IN ('succeeded', 'pending') AND NEW.amount <= p.amount
    ) THEN
      RAISE EXCEPTION 'a dispute is on a succeeded or pending payment, for at most its amount'
        USING ERRCODE = '23514', CONSTRAINT = 'payment_disputes_payment';
    END IF;
    NEW.created_at := now();
    NEW.updated_at := now();
    NEW.closed_at := CASE WHEN NEW.status IN ('won', 'lost', 'closed') THEN now() END;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.payment_id IS DISTINCT FROM OLD.payment_id
     OR NEW.provider IS DISTINCT FROM OLD.provider
     OR NEW.dispute_ref IS DISTINCT FROM OLD.dispute_ref
     OR NEW.amount IS DISTINCT FROM OLD.amount
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.opened_event_id IS DISTINCT FROM OLD.opened_event_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a dispute keeps its payment, amount, and reason'
      USING ERRCODE = '23514', CONSTRAINT = 'payment_disputes_immutable';
  END IF;
  IF OLD.status IN ('won', 'lost', 'closed') THEN
    RAISE EXCEPTION 'dispute % is closed as %', OLD.id, OLD.status
      USING ERRCODE = '23514', CONSTRAINT = 'payment_disputes_transition';
  END IF;
  -- An event older than the one applied never moves the dispute back.
  SELECT x.provider_created_at INTO prior_at FROM public.provider_events x
   WHERE x.tenant_id = OLD.tenant_id AND x.id = OLD.last_event_id;
  IF prior_at IS NOT NULL AND (e.provider_created_at IS NULL OR e.provider_created_at < prior_at) THEN
    RAISE EXCEPTION 'dispute event is older than the one applied'
      USING ERRCODE = '23514', CONSTRAINT = 'payment_disputes_transition';
  END IF;
  NEW.updated_at := now();
  NEW.closed_at := CASE WHEN NEW.status IN ('won', 'lost', 'closed') THEN now() END;
  RETURN NEW;
END;
$$;
CREATE TRIGGER payment_disputes_rules BEFORE INSERT OR UPDATE ON public.payment_disputes
  FOR EACH ROW EXECUTE FUNCTION app.check_payment_dispute();

-- 3. External settlements --------------------------------------------------------------

-- Money that changed hands outside TideGrid's card flow, recorded by staff
-- against a booking: a payment or a refund, in cash, by check, or by other
-- tender, with a reason and an idempotency key. The fee columns are a
-- refund's reversal of TideGrid's fee on its eligible share, computed as
-- 0029's card refund reversal is. Append-only.
CREATE TABLE public.external_settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  booking_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('payment', 'refund')),
  tender text NOT NULL CHECK (tender IN ('cash', 'check', 'other')),
  amount integer NOT NULL CHECK (amount BETWEEN 1 AND 100000000),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  reason text NOT NULL
    CHECK (char_length(reason) BETWEEN 1 AND 500 AND reason !~ '[\x01-\x1f\x7f]'),
  -- A check number or a receipt number, when there is one.
  tender_reference text
    CHECK (char_length(tender_reference) BETWEEN 1 AND 100 AND tender_reference !~ '[\x01-\x1f\x7f]'),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9_:-]{8,255}$'),
  order_total integer CHECK (order_total BETWEEN 1 AND 100000000),
  eligible_total integer CHECK (eligible_total BETWEEN 0 AND 100000000),
  eligible_amount integer CHECK (eligible_amount BETWEEN 0 AND 100000000),
  fee_bp integer CHECK (fee_bp BETWEEN 0 AND 10000),
  -- Negative or zero: a refund lowers what TideGrid bills.
  fee_amount integer CHECK (fee_amount BETWEEN -100000000 AND 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  actor_type text NOT NULL DEFAULT coalesce(app.setting_or_null('app.actor_type'), 'system')
    CHECK (actor_type IN ('staff', 'guest', 'system', 'support')),
  actor_id text DEFAULT app.setting_or_null('app.actor_id'),
  request_id text DEFAULT app.setting_or_null('app.request_id'),
  UNIQUE (tenant_id, id),
  CONSTRAINT external_settlements_key UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, booking_id) REFERENCES public.bookings (tenant_id, id),
  CONSTRAINT external_settlements_fee_fields CHECK (
    (kind = 'refund') = (order_total IS NOT NULL AND eligible_total IS NOT NULL
                         AND eligible_amount IS NOT NULL AND fee_bp IS NOT NULL
                         AND fee_amount IS NOT NULL)),
  CHECK (kind <> 'refund' OR (
    eligible_total <= order_total AND amount <= order_total
    AND eligible_amount = ((amount::bigint * eligible_total) / order_total)::integer
    -- The reversal is this refund's share, rounded half up, unless less is
    -- left of the booking's fee (the trigger computes the cap).
    AND fee_amount BETWEEN -(((eligible_amount::bigint * fee_bp) + 5000) / 10000)::integer AND 0))
);
CREATE INDEX external_settlements_booking_idx
  ON public.external_settlements (tenant_id, booking_id, created_at);
CREATE INDEX external_settlements_recent_idx ON public.external_settlements (tenant_id, created_at);

-- Written by a signed-in staff member. Concurrent settlements on one booking
-- take its lock, so a refund is checked against every earlier settlement:
-- refunds (card and external) never pass what the booking cost, and an
-- external refund never passes the money that came in (the card payment, less
-- its refunds, plus external payments, less external refunds).
CREATE FUNCTION app.check_external_settlement() RETURNS trigger
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
CREATE TRIGGER external_settlements_rules BEFORE INSERT ON public.external_settlements
  FOR EACH ROW EXECUTE FUNCTION app.check_external_settlement();

-- 4. Fee assessments -------------------------------------------------------------------

-- TideGrid's fee on a booking's eligible value (the order's total without its
-- taxes), once per booking, at its close: a confirmed booking once its trip
-- has ended, a canceled one at any time after it was canceled. Refunds reverse
-- their share separately, so the fee base is the retained eligible value
-- (docs/v2/03). Written by the reconciliation sweep.
CREATE TABLE public.fee_assessments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  booking_id uuid NOT NULL,
  basis text NOT NULL CHECK (basis IN ('trip_completed', 'canceled')),
  order_total integer NOT NULL CHECK (order_total BETWEEN 0 AND 100000000),
  eligible_total integer NOT NULL CHECK (eligible_total BETWEEN 0 AND 100000000),
  fee_bp integer NOT NULL CHECK (fee_bp BETWEEN 0 AND 10000),
  fee_amount integer NOT NULL CHECK (fee_amount BETWEEN 0 AND 100000000),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  created_at timestamptz NOT NULL DEFAULT now(),
  actor_type text NOT NULL DEFAULT coalesce(app.setting_or_null('app.actor_type'), 'system')
    CHECK (actor_type IN ('staff', 'guest', 'system', 'support')),
  actor_id text DEFAULT app.setting_or_null('app.actor_id'),
  request_id text DEFAULT app.setting_or_null('app.request_id'),
  UNIQUE (tenant_id, id),
  CONSTRAINT fee_assessments_once UNIQUE (tenant_id, booking_id),
  FOREIGN KEY (tenant_id, booking_id) REFERENCES public.bookings (tenant_id, id),
  CHECK (eligible_total <= order_total),
  CHECK (fee_amount = (((eligible_total::bigint * fee_bp) + 5000) / 10000)::integer)
);
CREATE INDEX fee_assessments_recent_idx ON public.fee_assessments (tenant_id, created_at);

CREATE FUNCTION app.check_fee_assessment() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  NEW.created_at := now();
  NEW.actor_type := coalesce(app.setting_or_null('app.actor_type'), 'system');
  NEW.actor_id := app.setting_or_null('app.actor_id');
  NEW.request_id := app.setting_or_null('app.request_id');
  IF NOT EXISTS (
       SELECT 1 FROM public.bookings b
         JOIN public.orders o ON o.tenant_id = b.tenant_id AND o.id = b.order_id
         JOIN public.scheduled_trips t ON t.tenant_id = b.tenant_id AND t.id = b.trip_id
        WHERE b.tenant_id = NEW.tenant_id AND b.id = NEW.booking_id
          AND o.total_amount = NEW.order_total
          AND o.total_amount - o.tax_amount - o.included_tax_amount = NEW.eligible_total
          AND ((NEW.basis = 'trip_completed' AND b.state = 'confirmed' AND t.ends_at <= now())
               OR (NEW.basis = 'canceled' AND b.state = 'canceled'))) THEN
    RAISE EXCEPTION 'a fee assessment names a closed booking and its order''s totals'
      USING ERRCODE = '23514', CONSTRAINT = 'fee_assessments_booking';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER fee_assessments_rules BEFORE INSERT ON public.fee_assessments
  FOR EACH ROW EXECUTE FUNCTION app.check_fee_assessment();

-- A card refund for a canceled booking, with the external refunds already
-- recorded against it, returns at most what the booking cost, and at most
-- what a lost dispute left on the card. The 0029 rules
-- check a card refund against the card payment only; this runs beside them,
-- under the same payment lock the external refund takes.
CREATE FUNCTION app.check_card_refund_with_external() RETURNS trigger
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
  RETURN NEW;
END;
$$;
CREATE TRIGGER payment_refunds_with_external BEFORE INSERT ON public.payment_refunds
  FOR EACH ROW EXECUTE FUNCTION app.check_card_refund_with_external();

-- 5. Billing plans and fee invoices ------------------------------------------------------

-- What TideGrid bills a tenant (docs/v2/03, Booking Core): the monthly
-- subscription, the annual minimum, the first day of the contract, and the
-- time zone its months are counted in. Written by TideGrid (a system actor),
-- never by tenant staff, and never changed: a new contract is a new
-- migration's concern.
CREATE TABLE public.billing_plans (
  tenant_id uuid PRIMARY KEY DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  monthly_fee integer NOT NULL CHECK (monthly_fee BETWEEN 0 AND 100000000),
  annual_minimum integer NOT NULL CHECK (annual_minimum BETWEEN 0 AND 1000000000),
  starts_on date NOT NULL CHECK (extract(day FROM starts_on) = 1),
  time_zone app.iana_zone NOT NULL,
  currency text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION app.check_billing_plan() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF coalesce(app.setting_or_null('app.actor_type'), 'system') <> 'system' THEN
    RAISE EXCEPTION 'TideGrid writes a billing plan, never tenant staff'
      USING ERRCODE = '42501', CONSTRAINT = 'billing_plans_actor';
  END IF;
  NEW.created_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER billing_plans_rules BEFORE INSERT ON public.billing_plans
  FOR EACH ROW EXECUTE FUNCTION app.check_billing_plan();

-- The sum of TideGrid's fee entries created in [from, until): assessments,
-- card refund reversals, and external refund reversals. Runs as the caller,
-- so row-level security bounds it to the tenant in context.
CREATE FUNCTION app.fee_ledger_total(p_tenant uuid, p_from timestamptz, p_until timestamptz)
  RETURNS bigint
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT coalesce((SELECT sum(a.fee_amount) FROM public.fee_assessments a
                      WHERE a.tenant_id = p_tenant
                        AND a.created_at >= p_from AND a.created_at < p_until), 0)
         + coalesce((SELECT sum(r.fee_amount) FROM public.fee_ledger_entries r
                      WHERE r.tenant_id = p_tenant
                        AND r.created_at >= p_from AND r.created_at < p_until), 0)
         + coalesce((SELECT sum(s.fee_amount) FROM public.external_settlements s
                      WHERE s.tenant_id = p_tenant AND s.kind = 'refund'
                        AND s.created_at >= p_from AND s.created_at < p_until), 0)
  $$;

-- One draft invoice per plan month, in order, once the month has ended in the
-- plan's time zone (an hour's grace for transactions that straddled it).
--
--   variable_amount = the fee ledger's total for the month (may be negative)
--   carried_in      = the previous invoice's carried_out (0 for the first)
--   variable_billed = max(0, variable_amount + carried_in)
--   carried_out     = min(0, variable_amount + carried_in)
--   true_up_amount  = in the 12th month of a contract year only:
--                     max(0, annual_minimum - the year's subscriptions and
--                     billed variable fees, this month's included)
--   total_amount    = subscription_amount + variable_billed + true_up_amount
--
-- A negative balance carries forward against later variable fees only, never
-- the subscription (docs/v2/03). The database checks every figure. State is
-- draft: sending an invoice waits on the owner's billing tool.
CREATE TABLE public.fee_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  period_start date NOT NULL CHECK (extract(day FROM period_start) = 1),
  contract_month integer NOT NULL CHECK (contract_month BETWEEN 1 AND 12),
  subscription_amount integer NOT NULL CHECK (subscription_amount BETWEEN 0 AND 100000000),
  variable_amount integer NOT NULL CHECK (variable_amount BETWEEN -1000000000 AND 1000000000),
  carried_in integer NOT NULL CHECK (carried_in BETWEEN -1000000000 AND 0),
  variable_billed integer NOT NULL CHECK (variable_billed BETWEEN 0 AND 1000000000),
  carried_out integer NOT NULL CHECK (carried_out BETWEEN -1000000000 AND 0),
  true_up_amount integer NOT NULL CHECK (true_up_amount BETWEEN 0 AND 1000000000),
  total_amount integer NOT NULL CHECK (total_amount BETWEEN 0 AND 2000000000),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CONSTRAINT fee_invoices_period UNIQUE (tenant_id, period_start),
  FOREIGN KEY (tenant_id) REFERENCES public.billing_plans (tenant_id),
  CHECK (variable_billed = greatest(0, variable_amount + carried_in)),
  CHECK (carried_out = least(0, variable_amount + carried_in)),
  CHECK (total_amount = subscription_amount + variable_billed + true_up_amount),
  CHECK (contract_month = 12 OR true_up_amount = 0)
);

CREATE FUNCTION app.check_fee_invoice() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  plan record;
  months integer;
  prior record;
  period_from timestamptz;
  period_until timestamptz;
  year_billed bigint;
BEGIN
  IF coalesce(app.setting_or_null('app.actor_type'), 'system') <> 'system' THEN
    RAISE EXCEPTION 'TideGrid issues a fee invoice, never tenant staff'
      USING ERRCODE = '42501', CONSTRAINT = 'fee_invoices_actor';
  END IF;
  NEW.created_at := now();
  NEW.state := 'draft';
  SELECT p.monthly_fee, p.annual_minimum, p.starts_on, p.time_zone::text AS tz
    INTO plan FROM public.billing_plans p WHERE p.tenant_id = NEW.tenant_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no billing plan for this tenant'
      USING ERRCODE = '23503', CONSTRAINT = 'fee_invoices_plan';
  END IF;
  months := (extract(year FROM NEW.period_start)::integer * 12 + extract(month FROM NEW.period_start)::integer)
          - (extract(year FROM plan.starts_on)::integer * 12 + extract(month FROM plan.starts_on)::integer);
  IF months < 0 OR NEW.contract_month <> (months % 12) + 1 THEN
    RAISE EXCEPTION 'an invoice''s month counts from the plan''s first month'
      USING ERRCODE = '23514', CONSTRAINT = 'fee_invoices_month';
  END IF;
  period_from := NEW.period_start::timestamp AT TIME ZONE plan.tz;
  period_until := (NEW.period_start + interval '1 month')::timestamp AT TIME ZONE plan.tz;
  IF period_until + interval '1 hour' > now() THEN
    RAISE EXCEPTION 'the month has not ended'
      USING ERRCODE = '23514', CONSTRAINT = 'fee_invoices_period';
  END IF;
  IF months = 0 THEN
    IF NEW.carried_in <> 0 THEN
      RAISE EXCEPTION 'the first invoice carries nothing in'
        USING ERRCODE = '23514', CONSTRAINT = 'fee_invoices_carry';
    END IF;
  ELSE
    SELECT i.carried_out INTO prior FROM public.fee_invoices i
     WHERE i.tenant_id = NEW.tenant_id
       AND i.period_start = (NEW.period_start - interval '1 month')::date;
    IF NOT FOUND OR prior.carried_out <> NEW.carried_in THEN
      RAISE EXCEPTION 'an invoice carries in what the previous month carried out'
        USING ERRCODE = '23514', CONSTRAINT = 'fee_invoices_carry';
    END IF;
  END IF;
  IF NEW.subscription_amount <> plan.monthly_fee THEN
    RAISE EXCEPTION 'the subscription is the plan''s monthly fee'
      USING ERRCODE = '23514', CONSTRAINT = 'fee_invoices_subscription';
  END IF;
  IF NEW.variable_amount <> app.fee_ledger_total(NEW.tenant_id, period_from, period_until) THEN
    RAISE EXCEPTION 'the variable fee is the fee ledger''s total for the month'
      USING ERRCODE = '23514', CONSTRAINT = 'fee_invoices_ledger';
  END IF;
  IF NEW.contract_month = 12 THEN
    SELECT coalesce(sum(i.subscription_amount + i.variable_billed), 0) INTO year_billed
      FROM public.fee_invoices i
     WHERE i.tenant_id = NEW.tenant_id
       AND i.period_start >= (NEW.period_start - interval '11 months')::date
       AND i.period_start < NEW.period_start;
    year_billed := year_billed + NEW.subscription_amount + NEW.variable_billed;
    IF NEW.true_up_amount <> greatest(0, plan.annual_minimum - year_billed) THEN
      RAISE EXCEPTION 'the true-up is what the year fell short of the annual minimum'
        USING ERRCODE = '23514', CONSTRAINT = 'fee_invoices_true_up';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER fee_invoices_rules BEFORE INSERT ON public.fee_invoices
  FOR EACH ROW EXECUTE FUNCTION app.check_fee_invoice();

-- 6. Missing webhooks (D1) ----------------------------------------------------------------

-- When the reconciliation sweep last read the provider about a pending
-- payment. Stamped by the database clock.
ALTER TABLE public.payments ADD COLUMN checked_at timestamptz;

CREATE FUNCTION app.stamp_payment_check() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.checked_at := NULL;
    RETURN NEW;
  END IF;
  IF NEW.checked_at IS DISTINCT FROM OLD.checked_at THEN
    IF OLD.state <> 'pending' THEN
      RAISE EXCEPTION 'only a pending payment is checked'
        USING ERRCODE = '23514', CONSTRAINT = 'payments_checked';
    END IF;
    NEW.checked_at := now();
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER payments_check_stamp BEFORE INSERT OR UPDATE OF checked_at ON public.payments
  FOR EACH ROW EXECUTE FUNCTION app.stamp_payment_check();
GRANT UPDATE (checked_at) ON public.payments TO tidegrid_app;

-- A provider reading that disagrees with a pending payment, raised once per
-- payment and reason for staff. It changes nothing: only a verified event
-- confirms or fails a payment. Whether it is still open is read from the
-- payment.
--
--   succeeded_without_event  the provider says it was paid; no event yet
--   failed_without_event     the provider says it will never be paid
--   missing_at_provider      the provider has no such payment
--   amount_mismatch          the provider's amount differs from ours
CREATE TABLE public.payment_reconciliation_exceptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  payment_id uuid NOT NULL,
  reason text NOT NULL CHECK (reason IN (
    'succeeded_without_event', 'failed_without_event', 'missing_at_provider', 'amount_mismatch')),
  provider_status text CHECK (provider_status ~ '^[a-z][a-z0-9_]{0,63}$'),
  provider_amount integer CHECK (provider_amount BETWEEN 0 AND 100000000),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CONSTRAINT payment_reconciliation_exceptions_once UNIQUE (tenant_id, payment_id, reason),
  FOREIGN KEY (tenant_id, payment_id) REFERENCES public.payments (tenant_id, id)
);
CREATE INDEX payment_reconciliation_exceptions_recent_idx
  ON public.payment_reconciliation_exceptions (tenant_id, created_at DESC);

CREATE FUNCTION app.check_payment_reconciliation_exception() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  NEW.created_at := now();
  IF NOT EXISTS (
    SELECT 1 FROM public.payments p
     WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.payment_id
       AND p.state = 'pending' AND p.provider_payment_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'only a pending payment the provider knows is reconciled'
      USING ERRCODE = '23514', CONSTRAINT = 'payment_reconciliation_exceptions_payment';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER payment_reconciliation_exceptions_rules
  BEFORE INSERT ON public.payment_reconciliation_exceptions
  FOR EACH ROW EXECUTE FUNCTION app.check_payment_reconciliation_exception();

-- 7. The reconciliation sweep -------------------------------------------------------------

ALTER TABLE public.sweep_turns DROP CONSTRAINT sweep_turns_sweep_check;
ALTER TABLE public.sweep_turns ADD CONSTRAINT sweep_turns_sweep_check
  CHECK (sweep IN (
    'hold', 'checkout', 'email', 'hostname', 'outbox', 'waiver_reminder', 'reconciliation'));

-- Trips by when they ended, for the assessment step. scheduled_trips is not a
-- pilot-volume table (rule R4).
CREATE INDEX scheduled_trips_ends_at_idx ON public.scheduled_trips (ends_at) INCLUDE (tenant_id);

-- Tenants with reconciliation work, the longest-waiting first. Ids only.
--   a pending payment with a provider id whose checkout's hold ended an hour
--   ago or more, not checked within the hour, created within 7 days;
--   a booking closed within 35 days with no fee assessment;
--   a billing plan whose next month has ended.
--   p_provider names the provider whose payments the caller can read; null
--   leaves payments out, so a tenant is never listed for readings nobody makes.
CREATE FUNCTION app.reconciliation_tenants(p_limit integer, p_provider text)
  RETURNS TABLE (tenant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT x.tenant_id FROM (
      SELECT p.tenant_id
        FROM public.payments p
        JOIN public.checkout_sessions s
          ON s.tenant_id = p.tenant_id AND s.id = p.checkout_session_id
       WHERE p.state = 'pending' AND p.provider_payment_id IS NOT NULL
         AND p.provider = p_provider
         AND p.created_at > pg_catalog.now() - interval '7 days'
         AND (p.checked_at IS NULL OR p.checked_at <= pg_catalog.now() - interval '1 hour')
         AND s.expires_at <= pg_catalog.now() - interval '1 hour'
      UNION
      SELECT b.tenant_id
        FROM public.scheduled_trips t
        JOIN public.bookings b ON b.tenant_id = t.tenant_id AND b.trip_id = t.id
       WHERE t.ends_at <= pg_catalog.now()
         AND t.ends_at > pg_catalog.now() - interval '35 days'
         AND b.state = 'confirmed'
         AND NOT EXISTS (SELECT 1 FROM public.fee_assessments a
                          WHERE a.tenant_id = b.tenant_id AND a.booking_id = b.id)
      UNION
      SELECT c.tenant_id
        FROM public.booking_cancellations c
        JOIN public.bookings b ON b.tenant_id = c.tenant_id AND b.id = c.booking_id
       WHERE c.created_at > pg_catalog.now() - interval '35 days'
         AND b.state = 'canceled'
         AND NOT EXISTS (SELECT 1 FROM public.fee_assessments a
                          WHERE a.tenant_id = b.tenant_id AND a.booking_id = b.id)
      UNION
      SELECT bp.tenant_id
        FROM public.billing_plans bp
        CROSS JOIN LATERAL (
          SELECT coalesce((SELECT (max(i.period_start) + interval '1 month')::date
                             FROM public.fee_invoices i WHERE i.tenant_id = bp.tenant_id),
                          bp.starts_on) AS next_start) n
       WHERE ((n.next_start + interval '1 month')::timestamp AT TIME ZONE bp.time_zone::text)
             + interval '1 hour' <= pg_catalog.now()
    ) x
      LEFT JOIN public.sweep_turns t
        ON t.tenant_id = x.tenant_id AND t.sweep = 'reconciliation'
     ORDER BY t.last_turn_at ASC NULLS FIRST, x.tenant_id
     LIMIT greatest(1, least(coalesce(p_limit, 100), 1000))
  $$;

-- Row-level security, append-only guards, and privileges ---------------------------------

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'payment_disputes', 'external_settlements', 'fee_assessments', 'billing_plans',
    'fee_invoices', 'payment_reconciliation_exceptions'
  ] LOOP
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
  FOREACH t IN ARRAY ARRAY[
    'external_settlements', 'fee_assessments', 'billing_plans', 'fee_invoices',
    'payment_reconciliation_exceptions'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON public.%I'
      ' FOR EACH ROW EXECUTE FUNCTION app.reject_mutation()', t || '_append_only', t);
  END LOOP;
END
$$;

GRANT UPDATE (status, last_event_id) ON public.payment_disputes TO tidegrid_app;

REVOKE ALL ON FUNCTION app.check_payment_dispute() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.check_external_settlement() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.check_card_refund_with_external() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.check_fee_assessment() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.check_billing_plan() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.check_fee_invoice() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.stamp_payment_check() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.check_payment_reconciliation_exception() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.fee_ledger_total(uuid, timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.fee_ledger_total(uuid, timestamptz, timestamptz) TO tidegrid_app;
REVOKE ALL ON FUNCTION app.reconciliation_tenants(integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reconciliation_tenants(integer, text) TO tidegrid_app;
