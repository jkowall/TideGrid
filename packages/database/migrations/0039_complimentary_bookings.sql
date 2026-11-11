-- W3-G2.12-rest: complimentary bookings, an owner's grant with a reason.
--
-- Until now a booking existed only once a verified provider event said its
-- payment succeeded (0007). A complimentary booking is the one exception, and
-- only this way:
--
-- 1. An active owner of the tenant, signed in as staff, writes a grant for an
--    open staff checkout of their own (0012), on its pending order, for the
--    order's whole total, with a reason code (a note is required for other).
--    The database checks the membership, so no other role or actor can.
-- 2. The checkout then has no payment, ever: a grant is refused once a
--    payment exists, and a payment is refused once a grant exists. A deposit
--    order is never comped: a private charter's deposit and balance stay paid.
-- 3. The booking names no payment. Its source is complimentary, stamped from
--    the grant, never chosen by a writer; and a booking without a payment is
--    complimentary, and a complimentary one has no payment.
-- 4. Everything else about the booking is unchanged: the same quote, hold,
--    order, waivers, emails, moves, and party changes. The order closes as
--    paid, settled by the grant rather than a card.
-- 5. It cancels with nothing to return: no refund, no credit, no remedy, at
--    any time before departure, by the guest or staff.
-- 6. TideGrid's fee on it is zero (docs/v2/03: complimentary value is not in
--    the fee base): its assessment records a zero total.
--
-- The grant is append-only. The runtime keeps the default SELECT and INSERT.

-- 1. Grants ---------------------------------------------------------------------

CREATE TABLE public.complimentary_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  checkout_session_id uuid NOT NULL,
  order_id uuid NOT NULL,
  -- The order's whole total, waived.
  waived_amount integer NOT NULL CHECK (waived_amount BETWEEN 0 AND 100000000),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  reason_code text NOT NULL
    CHECK (reason_code IN ('service_recovery', 'staff_or_crew', 'partner_or_media',
                           'charity_or_donation', 'other')),
  note text CHECK (char_length(note) BETWEEN 1 AND 500 AND note !~ '[\x01-\x1f\x7f]'),
  created_at timestamptz NOT NULL DEFAULT now(),
  actor_type text NOT NULL DEFAULT coalesce(app.setting_or_null('app.actor_type'), 'system')
    CHECK (actor_type IN ('staff', 'guest', 'system', 'support')),
  actor_id text DEFAULT app.setting_or_null('app.actor_id'),
  request_id text DEFAULT app.setting_or_null('app.request_id'),
  UNIQUE (tenant_id, id),
  CONSTRAINT complimentary_grants_session UNIQUE (tenant_id, checkout_session_id),
  CONSTRAINT complimentary_grants_order UNIQUE (tenant_id, order_id),
  FOREIGN KEY (tenant_id, checkout_session_id) REFERENCES public.checkout_sessions (tenant_id, id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES public.orders (tenant_id, id),
  CHECK (reason_code <> 'other' OR note IS NOT NULL)
);
CREATE INDEX complimentary_grants_recent_idx ON public.complimentary_grants (tenant_id, created_at);

-- Who and what: an active owner, signed in as staff, for an open staff
-- checkout's pending order with no deposit and no payment, for its total.
-- The checkout's row lock first, as a payment for it takes it (below), so a
-- grant and a payment for one checkout are checked one after the other.
CREATE FUNCTION app.check_complimentary_grant() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  NEW.created_at := now();
  NEW.actor_type := coalesce(app.setting_or_null('app.actor_type'), 'system');
  NEW.actor_id := app.setting_or_null('app.actor_id');
  NEW.request_id := app.setting_or_null('app.request_id');
  IF NEW.actor_type <> 'staff' OR NOT EXISTS (
       SELECT 1 FROM public.tenant_memberships m
        WHERE m.tenant_id = NEW.tenant_id AND m.user_id::text = NEW.actor_id
          AND m.role = 'owner' AND m.status = 'active') THEN
    RAISE EXCEPTION 'only an owner of this operator books a guest complimentary'
      USING ERRCODE = '42501', CONSTRAINT = 'complimentary_grants_owner';
  END IF;
  PERFORM 1 FROM public.checkout_sessions s
    WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.checkout_session_id
      FOR NO KEY UPDATE;
  IF NOT EXISTS (
       SELECT 1 FROM public.checkout_sessions s
         JOIN public.orders o
           ON o.tenant_id = s.tenant_id AND o.checkout_session_id = s.id
        WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.checkout_session_id
          AND s.source = 'staff_assisted' AND s.state = 'open' AND s.expires_at > now()
          AND o.id = NEW.order_id AND o.status = 'pending'
          AND o.deposit_amount IS NULL
          AND o.total_amount = NEW.waived_amount AND o.currency = NEW.currency) THEN
    RAISE EXCEPTION 'a complimentary grant waives an open staff checkout''s whole order, with no deposit'
      USING ERRCODE = '23514', CONSTRAINT = 'complimentary_grants_checkout';
  END IF;
  IF EXISTS (SELECT 1 FROM public.payments p
              WHERE p.tenant_id = NEW.tenant_id
                AND p.checkout_session_id = NEW.checkout_session_id) THEN
    RAISE EXCEPTION 'checkout % already has a payment; it cannot be complimentary',
      NEW.checkout_session_id
      USING ERRCODE = '23514', CONSTRAINT = 'complimentary_grants_checkout';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER complimentary_grants_rules BEFORE INSERT ON public.complimentary_grants
  FOR EACH ROW EXECUTE FUNCTION app.check_complimentary_grant();

ALTER TABLE public.complimentary_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.complimentary_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.complimentary_grants
  USING (tenant_id = (SELECT app.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()));
CREATE TRIGGER complimentary_grants_append_only
  BEFORE UPDATE OR DELETE ON public.complimentary_grants
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();
CREATE TRIGGER complimentary_grants_no_truncate
  BEFORE TRUNCATE ON public.complimentary_grants
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_mutation();

-- 2. No payment for a complimentary checkout ------------------------------------

-- The other half of the grant's rule, under the same checkout row lock. The
-- checkout's own transaction inserts its payment right after the checkout, so
-- the lock is already held there; any other writer waits for it.
CREATE FUNCTION app.check_payment_not_complimentary() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  PERFORM 1 FROM public.checkout_sessions s
    WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.checkout_session_id
      FOR NO KEY UPDATE;
  IF EXISTS (SELECT 1 FROM public.complimentary_grants g
              WHERE g.tenant_id = NEW.tenant_id
                AND g.checkout_session_id = NEW.checkout_session_id) THEN
    RAISE EXCEPTION 'checkout % is complimentary; it takes no payment', NEW.checkout_session_id
      USING ERRCODE = '23514', CONSTRAINT = 'payments_complimentary';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER payments_not_complimentary BEFORE INSERT ON public.payments
  FOR EACH ROW EXECUTE FUNCTION app.check_payment_not_complimentary();

-- 3. Bookings -------------------------------------------------------------------

ALTER TABLE public.bookings ALTER COLUMN payment_id DROP NOT NULL;
ALTER TABLE public.bookings DROP CONSTRAINT bookings_source_check;
ALTER TABLE public.bookings
  ADD CONSTRAINT bookings_source_check
    CHECK (source IN ('direct', 'staff_assisted', 'complimentary')),
  -- A booking without a payment is complimentary, and a complimentary one has none.
  ADD CONSTRAINT bookings_complimentary_payment
    CHECK ((source = 'complimentary') = (payment_id IS NULL));

-- 0012's stamp, plus: a checkout with a grant books as complimentary.
CREATE OR REPLACE FUNCTION app.stamp_booking_source() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_source text;
BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM public.complimentary_grants g
                            WHERE g.tenant_id = s.tenant_id AND g.checkout_session_id = s.id)
              THEN 'complimentary' ELSE s.source END
    INTO v_source
    FROM public.checkout_sessions s
   WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.checkout_session_id;
  NEW.source := coalesce(v_source, 'direct');
  RETURN NEW;
END;
$$;

-- 0007's evidence, unchanged for a paid booking. A complimentary booking's
-- evidence is its checkout's grant in place of the succeeded payment, with
-- the same confirmed hold and pending order, and no payment at all.
CREATE OR REPLACE FUNCTION app.check_booking() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  NEW.created_at := now();
  NEW.confirmed_at := now();
  IF NEW.payment_id IS NULL THEN
    PERFORM 1 FROM public.checkout_sessions s
      WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.checkout_session_id
        FOR NO KEY UPDATE;
    IF EXISTS (SELECT 1 FROM public.payments p
                WHERE p.tenant_id = NEW.tenant_id
                  AND p.checkout_session_id = NEW.checkout_session_id)
       OR NOT EXISTS (
         SELECT 1
           FROM public.checkout_sessions s
           JOIN public.orders o
             ON o.tenant_id = s.tenant_id AND o.checkout_session_id = s.id
           JOIN public.complimentary_grants g
             ON g.tenant_id = s.tenant_id AND g.checkout_session_id = s.id
           JOIN public.capacity_holds h
             ON h.tenant_id = s.tenant_id AND h.id = s.hold_id
          WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.checkout_session_id
            AND s.state = 'open'
            AND s.trip_id = NEW.trip_id AND s.party_size = NEW.party_size
            AND s.hold_id = NEW.hold_id
            AND o.id = NEW.order_id AND o.status = 'pending'
            AND g.order_id = o.id
            AND h.state = 'confirmed'
            AND h.owner_ref = 'checkout_session:' || s.id::text
            AND h.trip_id = NEW.trip_id AND h.party_size = NEW.party_size) THEN
      RAISE EXCEPTION 'a complimentary booking needs its checkout''s grant and confirmed hold, and no payment'
        USING ERRCODE = '23514', CONSTRAINT = 'bookings_evidence';
    END IF;
    RETURN NEW;
  END IF;
  -- Ordered against a refund of the same payment by the payment's row lock,
  -- as in check_payment_refund: a payment is booked or refunded, never both.
  PERFORM 1 FROM public.payments p
    WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.payment_id
      FOR NO KEY UPDATE;
  IF EXISTS (
       SELECT 1 FROM public.payment_refunds r
        WHERE r.tenant_id = NEW.tenant_id AND r.payment_id = NEW.payment_id) THEN
    RAISE EXCEPTION 'payment % is being refunded; it cannot back a booking', NEW.payment_id
      USING ERRCODE = '23514', CONSTRAINT = 'bookings_evidence';
  END IF;
  IF NOT EXISTS (
       SELECT 1
         FROM public.checkout_sessions s
         JOIN public.orders o
           ON o.tenant_id = s.tenant_id AND o.checkout_session_id = s.id
         JOIN public.payments p
           ON p.tenant_id = s.tenant_id AND p.checkout_session_id = s.id
         JOIN public.capacity_holds h
           ON h.tenant_id = s.tenant_id AND h.id = s.hold_id
        WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.checkout_session_id
          AND s.state IN ('open', 'expired')
          AND s.trip_id = NEW.trip_id AND s.party_size = NEW.party_size
          AND s.hold_id = NEW.hold_id
          AND o.id = NEW.order_id AND o.status = 'pending'
          AND p.id = NEW.payment_id AND p.state = 'succeeded'
          AND h.state = 'confirmed'
          AND h.owner_ref = 'checkout_session:' || s.id::text
          AND h.trip_id = NEW.trip_id AND h.party_size = NEW.party_size) THEN
    RAISE EXCEPTION 'a booking needs its checkout''s succeeded payment and confirmed hold'
      USING ERRCODE = '23514', CONSTRAINT = 'bookings_evidence';
  END IF;
  RETURN NEW;
END;
$$;

-- 0007's checkout rules, unchanged but for one thing: a complimentary
-- checkout confirms with its booking on the owner's grant, where any other
-- needs its booking on a succeeded payment. (0026 and 0037 only changed when
-- the update trigger runs these rules.)
CREATE OR REPLACE FUNCTION app.check_checkout_session() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  q record;
  h record;
  hold_state text;
  seats_free boolean;
  payment_state text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state IS DISTINCT FROM 'open' THEN
      RAISE EXCEPTION 'a checkout session starts open, not %', NEW.state
        USING ERRCODE = '23514', CONSTRAINT = 'checkout_sessions_transition';
    END IF;
    NEW.created_at := now();
    NEW.updated_at := now();
    NEW.confirmed_at := NULL;
    NEW.unfulfilled_at := NULL;
    NEW.failed_at := NULL;
    NEW.expired_at := NULL;
    NEW.canceled_at := NULL;

    -- A quote holds its price until the earlier of its own expiry and 30
    -- minutes after the database wrote it. The checkout must start, and must
    -- end, inside that time.
    SELECT x.trip_id, x.party_size, x.policy_version,
           least(x.expires_at, x.created_at + interval '30 minutes') AS valid_until
      INTO q
      FROM public.quotes x
     WHERE x.tenant_id = NEW.tenant_id AND x.id = NEW.quote_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'no quote % for this tenant', NEW.quote_id
        USING ERRCODE = '23503', CONSTRAINT = 'checkout_sessions_quote';
    END IF;
    IF now() >= q.valid_until OR NEW.expires_at > q.valid_until THEN
      RAISE EXCEPTION 'quote % is not valid for a checkout ending at %', NEW.quote_id, NEW.expires_at
        USING ERRCODE = '23514', CONSTRAINT = 'checkout_sessions_quote_fresh';
    END IF;
    IF q.trip_id <> NEW.trip_id OR q.party_size <> NEW.party_size
       OR q.policy_version <> NEW.policy_version THEN
      RAISE EXCEPTION 'a checkout takes its quote''s trip, party, and policy'
        USING ERRCODE = '23514', CONSTRAINT = 'checkout_sessions_quote';
    END IF;

    SELECT x.owner_ref, x.trip_id, x.party_size, x.state, x.expires_at
      INTO h
      FROM public.capacity_holds x
     WHERE x.tenant_id = NEW.tenant_id AND x.id = NEW.hold_id;
    IF NOT FOUND
       OR h.owner_ref <> 'checkout_session:' || NEW.id::text
       OR h.trip_id <> NEW.trip_id
       OR h.party_size <> NEW.party_size
       OR h.state <> 'active'
       OR h.expires_at <> NEW.expires_at
       OR NEW.expires_at <= now() THEN
      RAISE EXCEPTION 'a checkout session needs its own active hold for its trip and party, expiring with it'
        USING ERRCODE = '23514', CONSTRAINT = 'checkout_sessions_hold';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.quote_id IS DISTINCT FROM OLD.quote_id
     OR NEW.trip_id IS DISTINCT FROM OLD.trip_id
     OR NEW.party_size IS DISTINCT FROM OLD.party_size
     OR NEW.hold_id IS DISTINCT FROM OLD.hold_id
     OR NEW.policy_version IS DISTINCT FROM OLD.policy_version
     OR NEW.secret_hash IS DISTINCT FROM OLD.secret_hash
     OR NEW.client_key IS DISTINCT FROM OLD.client_key
     OR NEW.booker_name IS DISTINCT FROM OLD.booker_name
     OR NEW.booker_email IS DISTINCT FROM OLD.booker_email
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a checkout session keeps its quote, trip, party, hold, secret, and booker'
      USING ERRCODE = '23514', CONSTRAINT = 'checkout_sessions_immutable';
  END IF;
  -- The expiry moves earlier, never later; tests make time pass that way.
  IF NEW.expires_at > OLD.expires_at THEN
    RAISE EXCEPTION 'checkout session % expires at %; its expiry can move earlier, never later',
      OLD.id, OLD.expires_at
      USING ERRCODE = '23514', CONSTRAINT = 'checkout_sessions_expiry';
  END IF;
  NEW.confirmed_at := OLD.confirmed_at;
  NEW.unfulfilled_at := OLD.unfulfilled_at;
  NEW.failed_at := OLD.failed_at;
  NEW.expired_at := OLD.expired_at;
  NEW.canceled_at := OLD.canceled_at;
  NEW.updated_at := now();
  IF NEW.state = OLD.state THEN
    RETURN NEW;
  END IF;
  IF NOT (   (OLD.state = 'open'
              AND NEW.state IN ('confirmed', 'unfulfilled', 'failed', 'expired', 'canceled'))
          OR (OLD.state = 'expired' AND NEW.state IN ('confirmed', 'unfulfilled'))
          OR (OLD.state IN ('failed', 'canceled') AND NEW.state = 'unfulfilled')) THEN
    RAISE EXCEPTION 'a checkout session cannot move from % to %', OLD.state, NEW.state
      USING ERRCODE = '23514', CONSTRAINT = 'checkout_sessions_transition';
  END IF;

  SELECT x.state INTO hold_state
    FROM public.capacity_holds x
   WHERE x.tenant_id = NEW.tenant_id AND x.id = NEW.hold_id;
  -- False, not null, when the hold is missing.
  seats_free := coalesce(hold_state IN ('released', 'expired'), false);
  SELECT x.state INTO payment_state
    FROM public.payments x
   WHERE x.tenant_id = NEW.tenant_id AND x.checkout_session_id = NEW.id;

  IF NEW.state = 'confirmed' THEN
    -- A complimentary checkout (0039) confirms on its owner's grant, with no
    -- payment at all, from open only.
    IF hold_state IS DISTINCT FROM 'confirmed'
       OR NOT (payment_state IS NOT DISTINCT FROM 'succeeded'
               OR (payment_state IS NULL AND OLD.state = 'open'
                   AND EXISTS (SELECT 1 FROM public.complimentary_grants g
                                WHERE g.tenant_id = NEW.tenant_id
                                  AND g.checkout_session_id = NEW.id)))
       OR NOT EXISTS (SELECT 1 FROM public.bookings b
                       WHERE b.tenant_id = NEW.tenant_id AND b.checkout_session_id = NEW.id) THEN
      RAISE EXCEPTION 'checkout session % confirms only with a booking on a succeeded payment', NEW.id
        USING ERRCODE = '23514', CONSTRAINT = 'checkout_sessions_evidence';
    END IF;
    NEW.confirmed_at := now();
  ELSIF NEW.state = 'unfulfilled' THEN
    IF payment_state IS DISTINCT FROM 'succeeded'
       OR NOT seats_free
       OR NOT EXISTS (SELECT 1 FROM public.finalization_exceptions e
                       WHERE e.tenant_id = NEW.tenant_id AND e.checkout_session_id = NEW.id
                         AND e.refund_id IS NOT NULL)
       OR EXISTS (SELECT 1 FROM public.bookings b
                   WHERE b.tenant_id = NEW.tenant_id AND b.checkout_session_id = NEW.id) THEN
      RAISE EXCEPTION 'checkout session % closes as unfulfilled only with a refund exception and no booking', NEW.id
        USING ERRCODE = '23514', CONSTRAINT = 'checkout_sessions_evidence';
    END IF;
    NEW.unfulfilled_at := now();
  ELSIF NEW.state = 'failed' THEN
    IF payment_state IS DISTINCT FROM 'failed' OR NOT seats_free THEN
      RAISE EXCEPTION 'checkout session % fails only on a failed payment with its hold released or expired', NEW.id
        USING ERRCODE = '23514', CONSTRAINT = 'checkout_sessions_evidence';
    END IF;
    NEW.failed_at := now();
  ELSIF NEW.state = 'expired' THEN
    IF OLD.expires_at > now() OR hold_state IS DISTINCT FROM 'expired' THEN
      RAISE EXCEPTION 'checkout session % expires only after its instant, with its hold expired', NEW.id
        USING ERRCODE = '23514', CONSTRAINT = 'checkout_sessions_evidence';
    END IF;
    NEW.expired_at := now();
  ELSE
    IF NOT seats_free THEN
      RAISE EXCEPTION 'checkout session % is canceled only with its hold released or expired', NEW.id
        USING ERRCODE = '23514', CONSTRAINT = 'checkout_sessions_evidence';
    END IF;
    NEW.canceled_at := now();
  END IF;
  RETURN NEW;
END;
$$;


-- 4. Cancellations --------------------------------------------------------------

ALTER TABLE public.booking_cancellations ALTER COLUMN payment_id DROP NOT NULL;
ALTER TABLE public.booking_cancellations DROP CONSTRAINT booking_cancellations_paid_amount_check;
ALTER TABLE public.booking_cancellations
  ADD CONSTRAINT booking_cancellations_paid_amount_check
    CHECK (paid_amount BETWEEN 0 AND 100000000),
  -- A complimentary booking's cancellation names no payment and paid nothing;
  -- every other names its payment and what it paid.
  ADD CONSTRAINT booking_cancellations_complimentary
    CHECK ((payment_id IS NULL) = (paid_amount = 0));

-- 0029's rules, unchanged for a paid booking. A complimentary booking cancels
-- with no payment, nothing paid, and no remedy: no refund and no credit,
-- whatever its policy gives a paid booking, by its guest or by staff. The
-- policy's own remedy is still stamped on the row for the record.
CREATE OR REPLACE FUNCTION app.check_booking_cancellation() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  b record;
  p record;
  want_remedy text;
  want_bp integer;
BEGIN
  NEW.created_at := now();
  NEW.actor_type := coalesce(app.setting_or_null('app.actor_type'), 'system');
  NEW.actor_id := app.setting_or_null('app.actor_id');
  NEW.request_id := app.setting_or_null('app.request_id');

  SELECT x.state, x.payment_id, x.source, o.product_id, o.policy_version, t.starts_at,
         pay.state AS payment_state, pay.amount AS paid, pay.currency
    INTO b
    FROM public.bookings x
    JOIN public.orders o ON o.tenant_id = x.tenant_id AND o.id = x.order_id
    JOIN public.scheduled_trips t ON t.tenant_id = x.tenant_id AND t.id = x.trip_id
    LEFT JOIN public.payments pay ON pay.tenant_id = x.tenant_id AND pay.id = x.payment_id
   WHERE x.tenant_id = NEW.tenant_id AND x.id = NEW.booking_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no booking % for this tenant', NEW.booking_id
      USING ERRCODE = '23503', CONSTRAINT = 'booking_cancellations_booking';
  END IF;
  IF b.state <> 'confirmed' THEN
    RAISE EXCEPTION 'booking % is %, not confirmed', NEW.booking_id, b.state
      USING ERRCODE = '23514', CONSTRAINT = 'booking_cancellations_booking';
  END IF;
  IF now() >= b.starts_at THEN
    RAISE EXCEPTION 'booking % departed at %; it can no longer be canceled', NEW.booking_id, b.starts_at
      USING ERRCODE = '23514', CONSTRAINT = 'booking_cancellations_departed';
  END IF;
  IF b.payment_id IS NULL THEN
    IF b.source <> 'complimentary' OR NEW.payment_id IS NOT NULL OR NEW.paid_amount <> 0
       OR NEW.currency IS DISTINCT FROM 'USD' THEN
      RAISE EXCEPTION 'a complimentary booking''s cancellation names no payment and nothing paid'
        USING ERRCODE = '23514', CONSTRAINT = 'booking_cancellations_terms';
    END IF;
  ELSIF b.payment_state <> 'succeeded' OR NEW.payment_id IS DISTINCT FROM b.payment_id
     OR NEW.paid_amount IS DISTINCT FROM b.paid OR NEW.currency IS DISTINCT FROM b.currency THEN
    RAISE EXCEPTION 'a cancellation names its booking''s succeeded payment and what it paid'
      USING ERRCODE = '23514', CONSTRAINT = 'booking_cancellations_terms';
  END IF;

  SELECT v.change_cutoff_minutes, v.before_cutoff_remedy, v.before_cutoff_refund_bp,
         v.after_cutoff_remedy, v.after_cutoff_refund_bp
    INTO p
    FROM public.policy_versions v
   WHERE v.tenant_id = NEW.tenant_id AND v.product_id = b.product_id
     AND v.version = b.policy_version;
  IF NOT FOUND OR NEW.product_id IS DISTINCT FROM b.product_id
     OR NEW.policy_version IS DISTINCT FROM b.policy_version THEN
    RAISE EXCEPTION 'a cancellation applies its booking''s own policy version'
      USING ERRCODE = '23514', CONSTRAINT = 'booking_cancellations_terms';
  END IF;
  IF NEW.departs_at IS DISTINCT FROM b.starts_at
     OR NEW.cutoff_at IS DISTINCT FROM b.starts_at - make_interval(mins => p.change_cutoff_minutes)
     OR NEW.before_cutoff IS DISTINCT FROM (now() < NEW.cutoff_at) THEN
    RAISE EXCEPTION 'a cancellation''s cutoff is its policy''s, and its side of it is the database clock''s'
      USING ERRCODE = '23514', CONSTRAINT = 'booking_cancellations_terms';
  END IF;
  IF NEW.before_cutoff THEN
    want_remedy := p.before_cutoff_remedy;
    want_bp := p.before_cutoff_refund_bp;
  ELSE
    want_remedy := p.after_cutoff_remedy;
    want_bp := p.after_cutoff_refund_bp;
  END IF;
  want_bp := CASE want_remedy
               WHEN 'full_refund' THEN 10000 WHEN 'credit' THEN 10000 WHEN 'none' THEN 0
               ELSE want_bp END;
  NEW.policy_remedy := want_remedy;
  NEW.policy_refund_bp := want_bp;

  IF b.payment_id IS NULL THEN
    IF NEW.remedy <> 'none' OR NEW.refund_bp <> 0 OR NEW.override_reason IS NOT NULL THEN
      RAISE EXCEPTION 'booking % was complimentary; it cancels with nothing to return', NEW.booking_id
        USING ERRCODE = '23514', CONSTRAINT = 'booking_cancellations_terms';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.override_reason IS NOT NULL THEN
    IF NEW.actor_type <> 'staff' THEN
      RAISE EXCEPTION 'only staff override a cancellation''s policy'
        USING ERRCODE = '23514', CONSTRAINT = 'booking_cancellations_override';
    END IF;
    RETURN NEW;
  END IF;
  IF want_remedy = 'credit' AND NEW.actor_type <> 'staff' THEN
    RAISE EXCEPTION 'booking % would be credited; credit is issued by the operator, not self-service',
      NEW.booking_id
      USING ERRCODE = '23514', CONSTRAINT = 'booking_cancellations_credit';
  END IF;
  IF NEW.refund_bp IS DISTINCT FROM want_bp
     OR (NEW.remedy IS DISTINCT FROM want_remedy
         AND NOT (NEW.actor_type = 'staff' AND NEW.remedy = 'credit'
                  AND want_remedy IN ('full_refund', 'percent_refund'))) THEN
    RAISE EXCEPTION 'booking %''s policy gives % at % basis points, not % at %; a different remedy is an override with a reason',
      NEW.booking_id, want_remedy, want_bp, NEW.remedy, NEW.refund_bp
      USING ERRCODE = '23514', CONSTRAINT = 'booking_cancellations_terms';
  END IF;
  RETURN NEW;
END;
$$;

-- 5. TideGrid's fee -------------------------------------------------------------

-- 0031's rule, plus: a complimentary booking's assessment records a zero
-- total, so its fee is zero and nothing is counted as owed by the guest.
CREATE OR REPLACE FUNCTION app.check_fee_assessment() RETURNS trigger
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
          AND CASE WHEN b.source = 'complimentary'
                   THEN NEW.order_total = 0 AND NEW.eligible_total = 0
                   ELSE o.total_amount = NEW.order_total
                        AND o.total_amount - o.tax_amount - o.included_tax_amount
                            = NEW.eligible_total END
          AND ((NEW.basis = 'trip_completed' AND b.state = 'confirmed' AND t.ends_at <= now())
               OR (NEW.basis = 'canceled' AND b.state = 'canceled'))) THEN
    RAISE EXCEPTION 'a fee assessment names a closed booking and its order''s totals'
      USING ERRCODE = '23514', CONSTRAINT = 'fee_assessments_booking';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app.check_complimentary_grant() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.check_payment_not_complimentary() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.stamp_booking_source() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.check_booking() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.check_checkout_session() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.check_booking_cancellation() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.check_fee_assessment() FROM PUBLIC;
