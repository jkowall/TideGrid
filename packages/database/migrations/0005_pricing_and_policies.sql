-- 0005 pricing, add-ons, fees, taxes, promotions, policies, and quotes
--
-- Commercial terms for the demo build (goal G2.5): what a product costs, what
-- is added to it, the terms on which a guest may change it, and an immutable
-- snapshot of a priced quote. Design authority: docs/v2/02-product-scope.md
-- (pricing, taxes, fees, and quotes; policies) and docs/v2/04-architecture.md
-- (Product snapshots, PromotionRuleVersion, the immutable checkout quote).
--
-- Versions. Terms change by appending a version; nothing is edited in place.
-- A product's current price list and policy are its highest versions; a tax
-- rate's or promotion's current terms are its highest version. Old versions
-- stay readable, so every quote names exactly what it used.
--
-- Money is integer US cents with an explicit currency. Rates are integers:
-- tax rates in parts per million (70000 is 7%), discounts and refunds in basis
-- points (1000 is 10%).
--
-- Tenancy follows packages/database/README.md: tenant_id on every row,
-- composite tenant foreign keys, forced row-level security with a
-- tenant_isolation policy, and the runtime keeps 0001's default SELECT and
-- INSERT. Every table here is append-only for every role, the owner included:
-- UPDATE, DELETE, and TRUNCATE raise. Child rows (price list items, promotion
-- products, quote lines, and quote line taxes) can be written only in the
-- transaction that created their parent, so a version or a quote cannot grow
-- after it commits.

-- The commit-time checks below are definer functions that read tables with
-- forced row-level security; their owner must bypass row-level security.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'migration 0005 must run as a role that bypasses row-level security';
  END IF;
END
$$;

-- Keys on catalog tables --------------------------------------------------------

-- Foreign keys below carry a product's kind and a trip's product, so a price
-- list cannot describe the wrong kind of product and a quote cannot pair a
-- trip with another product.
ALTER TABLE public.products
  ADD CONSTRAINT products_tenant_id_id_kind_key UNIQUE (tenant_id, id, kind);
ALTER TABLE public.scheduled_trips
  ADD CONSTRAINT scheduled_trips_tenant_id_id_product_id_key UNIQUE (tenant_id, id, product_id);

-- Sealed parents ----------------------------------------------------------------

-- A version or quote records the transaction that created it. Its child rows
-- must be written by that same transaction. pg_current_xact_id() is the
-- top-level transaction id, also inside a savepoint. The stamp is set by
-- trigger, so no writer can choose it.
CREATE FUNCTION app.stamp_created_txid() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  NEW.created_txid := pg_catalog.pg_current_xact_id();
  RETURN NEW;
END;
$$;

-- Runs as the writer, inside its tenant transaction, so a parent in another
-- tenant is invisible and the row is refused.
CREATE FUNCTION app.check_sealed_parent() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  parent_txid xid8;
  all_products boolean;
BEGIN
  IF TG_TABLE_NAME = 'price_list_items' THEN
    SELECT v.created_txid INTO parent_txid
      FROM public.price_list_versions v
     WHERE v.tenant_id = NEW.tenant_id AND v.product_id = NEW.product_id
       AND v.version = NEW.version;
  ELSIF TG_TABLE_NAME = 'promotion_version_products' THEN
    SELECT v.created_txid, v.applies_to_all_products INTO parent_txid, all_products
      FROM public.promotion_versions v
     WHERE v.tenant_id = NEW.tenant_id AND v.promotion_id = NEW.promotion_id
       AND v.version = NEW.version;
    IF all_products THEN
      RAISE EXCEPTION 'a promotion for all products lists no products' USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME IN ('quote_lines', 'quote_line_taxes') THEN
    SELECT q.created_txid INTO parent_txid
      FROM public.quotes q
     WHERE q.tenant_id = NEW.tenant_id AND q.id = NEW.quote_id;
  ELSE
    RAISE EXCEPTION 'check_sealed_parent does not guard %', TG_TABLE_NAME;
  END IF;
  IF parent_txid IS DISTINCT FROM pg_catalog.pg_current_xact_id() THEN
    RAISE EXCEPTION '% rows are written only with their parent, in its transaction', TG_TABLE_NAME
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

-- Who wrote a row comes from the transaction's context, never from the row,
-- so a writer cannot name another actor. A guest transaction therefore fails
-- each terms table's actor_type check, however its insert is written.
CREATE FUNCTION app.stamp_actor() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  NEW.actor_type := coalesce(app.setting_or_null('app.actor_type'), 'system');
  NEW.actor_id := app.setting_or_null('app.actor_id');
  NEW.request_id := app.setting_or_null('app.request_id');
  RETURN NEW;
END;
$$;

-- Price lists -------------------------------------------------------------------

-- A product's price list: its ticket types or its charter price, its
-- mandatory fees, and its paid add-ons. The highest version is current.
-- Guests never write one.
CREATE TABLE public.price_list_versions (
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  product_id uuid NOT NULL,
  version integer NOT NULL CHECK (version BETWEEN 1 AND 1000000),
  product_kind text NOT NULL CHECK (product_kind IN ('shared_seat', 'private_charter')),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_txid xid8 NOT NULL DEFAULT pg_current_xact_id(),
  actor_type text NOT NULL DEFAULT coalesce(app.setting_or_null('app.actor_type'), 'system')
    CHECK (actor_type IN ('staff', 'system', 'support')),
  actor_id text DEFAULT app.setting_or_null('app.actor_id'),
  request_id text DEFAULT app.setting_or_null('app.request_id'),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 500),
  PRIMARY KEY (tenant_id, product_id, version),
  UNIQUE (tenant_id, product_id, version, product_kind),
  FOREIGN KEY (tenant_id, product_id, product_kind) REFERENCES public.products (tenant_id, id, kind)
);

-- One priced item. Tickets belong to shared-seat products, one per ticket
-- type, and each ticket is one seat. A charter price list has exactly one
-- charter item, coded 'charter'. Fees are mandatory and charged per booking
-- or per participant. Add-ons are optional, limited per booking or per
-- participant, and offered for trips whose local date falls in their range.
CREATE TABLE public.price_list_items (
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  product_id uuid NOT NULL,
  version integer NOT NULL,
  product_kind text NOT NULL CHECK (product_kind IN ('shared_seat', 'private_charter')),
  item_kind text NOT NULL CHECK (item_kind IN ('ticket', 'charter', 'fee', 'add_on')),
  code text NOT NULL CHECK (code ~ '^[a-z][a-z0-9_]{0,31}$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80 AND name !~ '[[:cntrl:]]'),
  unit_amount integer NOT NULL CHECK (unit_amount BETWEEN 0 AND 10000000),
  taxable boolean NOT NULL,
  basis text CHECK (basis IN ('per_booking', 'per_participant')),
  max_quantity integer CHECK (max_quantity BETWEEN 1 AND 100),
  available_from date,
  available_until date,
  sort_order smallint NOT NULL CHECK (sort_order BETWEEN 0 AND 99),
  PRIMARY KEY (tenant_id, product_id, version, item_kind, code),
  FOREIGN KEY (tenant_id, product_id, version, product_kind)
    REFERENCES public.price_list_versions (tenant_id, product_id, version, product_kind),
  CHECK ((item_kind IN ('fee', 'add_on')) = (basis IS NOT NULL)),
  CHECK ((item_kind = 'add_on') = (max_quantity IS NOT NULL)),
  CHECK (item_kind = 'add_on' OR (available_from IS NULL AND available_until IS NULL)),
  CHECK (available_until >= available_from),
  CHECK (item_kind <> 'ticket' OR product_kind = 'shared_seat'),
  CHECK (item_kind <> 'charter' OR (product_kind = 'private_charter' AND code = 'charter')),
  CHECK (item_kind <> 'fee' OR unit_amount >= 1)
);

-- Checked at commit, after the items are written: a shared-seat price list
-- sells at least one ticket type, and a charter price list has its price.
CREATE FUNCTION app.check_price_list_complete() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  tickets integer;
  charters integer;
BEGIN
  SELECT count(*) FILTER (WHERE i.item_kind = 'ticket'),
         count(*) FILTER (WHERE i.item_kind = 'charter')
    INTO tickets, charters
    FROM public.price_list_items i
   WHERE i.tenant_id = NEW.tenant_id AND i.product_id = NEW.product_id
     AND i.version = NEW.version;
  IF NEW.product_kind = 'shared_seat' AND tickets = 0 THEN
    RAISE EXCEPTION 'a shared-seat price list needs at least one ticket type'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.product_kind = 'private_charter' AND charters <> 1 THEN
    RAISE EXCEPTION 'a charter price list needs its charter price' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER price_list_versions_stamp BEFORE INSERT ON public.price_list_versions
  FOR EACH ROW EXECUTE FUNCTION app.stamp_created_txid();
CREATE CONSTRAINT TRIGGER price_list_versions_complete
  AFTER INSERT ON public.price_list_versions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.check_price_list_complete();
CREATE TRIGGER price_list_items_sealed BEFORE INSERT ON public.price_list_items
  FOR EACH ROW EXECUTE FUNCTION app.check_sealed_parent();

-- Policies ----------------------------------------------------------------------

-- A product's cancellation, reschedule, no-show, operator-cancellation, and
-- weather terms. The cutoff is elapsed minutes before departure. Before it, a
-- guest's cancellation or reschedule gets the before-cutoff remedy; at or
-- after it, the after-cutoff remedy. A percentage refund names its basis
-- points. The highest version is current. Operator cancellations and weather
-- disruptions are staff decisions; their text tells the guest what to expect.
CREATE TABLE public.policy_versions (
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  product_id uuid NOT NULL,
  version integer NOT NULL CHECK (version BETWEEN 1 AND 1000000),
  change_cutoff_minutes integer NOT NULL CHECK (change_cutoff_minutes BETWEEN 0 AND 43200),
  before_cutoff_remedy text NOT NULL
    CHECK (before_cutoff_remedy IN ('full_refund', 'percent_refund', 'credit', 'none')),
  before_cutoff_refund_bp integer CHECK (before_cutoff_refund_bp BETWEEN 1 AND 9999),
  after_cutoff_remedy text NOT NULL
    CHECK (after_cutoff_remedy IN ('full_refund', 'percent_refund', 'credit', 'none')),
  after_cutoff_refund_bp integer CHECK (after_cutoff_refund_bp BETWEEN 1 AND 9999),
  no_show_remedy text NOT NULL
    CHECK (no_show_remedy IN ('full_refund', 'percent_refund', 'credit', 'none')),
  no_show_refund_bp integer CHECK (no_show_refund_bp BETWEEN 1 AND 9999),
  cancellation_text text NOT NULL CHECK (char_length(cancellation_text) BETWEEN 1 AND 2000
    AND cancellation_text !~ '[\x01-\x09\x0b-\x1f\x7f]'),
  reschedule_text text NOT NULL CHECK (char_length(reschedule_text) BETWEEN 1 AND 2000
    AND reschedule_text !~ '[\x01-\x09\x0b-\x1f\x7f]'),
  no_show_text text NOT NULL CHECK (char_length(no_show_text) BETWEEN 1 AND 2000
    AND no_show_text !~ '[\x01-\x09\x0b-\x1f\x7f]'),
  operator_cancellation_text text NOT NULL CHECK (char_length(operator_cancellation_text) BETWEEN 1 AND 2000
    AND operator_cancellation_text !~ '[\x01-\x09\x0b-\x1f\x7f]'),
  weather_text text NOT NULL CHECK (char_length(weather_text) BETWEEN 1 AND 2000
    AND weather_text !~ '[\x01-\x09\x0b-\x1f\x7f]'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor_type text NOT NULL DEFAULT coalesce(app.setting_or_null('app.actor_type'), 'system')
    CHECK (actor_type IN ('staff', 'system', 'support')),
  actor_id text DEFAULT app.setting_or_null('app.actor_id'),
  request_id text DEFAULT app.setting_or_null('app.request_id'),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 500),
  PRIMARY KEY (tenant_id, product_id, version),
  FOREIGN KEY (tenant_id, product_id) REFERENCES public.products (tenant_id, id),
  CHECK ((before_cutoff_remedy = 'percent_refund') = (before_cutoff_refund_bp IS NOT NULL)),
  CHECK ((after_cutoff_remedy = 'percent_refund') = (after_cutoff_refund_bp IS NOT NULL)),
  CHECK ((no_show_remedy = 'percent_refund') = (no_show_refund_bp IS NOT NULL))
);

-- Taxes -------------------------------------------------------------------------

-- An operator-supplied tax: name, rate, and whether prices include it.
-- TideGrid calculates and displays it; it does not decide what is owed. A
-- rate applies to every taxable line while its highest version is active.
CREATE TABLE public.tax_rate_versions (
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  tax_rate_id uuid NOT NULL,
  version integer NOT NULL CHECK (version BETWEEN 1 AND 1000000),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80 AND name !~ '[[:cntrl:]]'),
  rate_ppm integer NOT NULL CHECK (rate_ppm BETWEEN 1 AND 500000),
  inclusive boolean NOT NULL,
  active boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor_type text NOT NULL DEFAULT coalesce(app.setting_or_null('app.actor_type'), 'system')
    CHECK (actor_type IN ('staff', 'system', 'support')),
  actor_id text DEFAULT app.setting_or_null('app.actor_id'),
  request_id text DEFAULT app.setting_or_null('app.request_id'),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 500),
  PRIMARY KEY (tenant_id, tax_rate_id, version)
);

-- Promotions --------------------------------------------------------------------

-- One code per promotion, unique per tenant, stored upper case; guests type
-- it in any case. The code never changes. Its versions carry the terms.
CREATE TABLE public.promotions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  code text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{2,31}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor_type text NOT NULL DEFAULT coalesce(app.setting_or_null('app.actor_type'), 'system')
    CHECK (actor_type IN ('staff', 'system', 'support')),
  actor_id text DEFAULT app.setting_or_null('app.actor_id'),
  request_id text DEFAULT app.setting_or_null('app.request_id'),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code)
);

-- PromotionRuleVersion: one fixed-amount or percentage discount off the trip
-- price (tickets or the charter price) of eligible products, redeemable while
-- the quote instant is in [starts_at, ends_at). No stacking and no usage
-- rules. A version that does not apply to all products lists its products.
CREATE TABLE public.promotion_versions (
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  promotion_id uuid NOT NULL,
  version integer NOT NULL CHECK (version BETWEEN 1 AND 1000000),
  discount_kind text NOT NULL CHECK (discount_kind IN ('fixed_amount', 'percent')),
  amount_off integer CHECK (amount_off BETWEEN 1 AND 10000000),
  percent_off_bp integer CHECK (percent_off_bp BETWEEN 1 AND 10000),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  applies_to_all_products boolean NOT NULL,
  active boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_txid xid8 NOT NULL DEFAULT pg_current_xact_id(),
  actor_type text NOT NULL DEFAULT coalesce(app.setting_or_null('app.actor_type'), 'system')
    CHECK (actor_type IN ('staff', 'system', 'support')),
  actor_id text DEFAULT app.setting_or_null('app.actor_id'),
  request_id text DEFAULT app.setting_or_null('app.request_id'),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 500),
  PRIMARY KEY (tenant_id, promotion_id, version),
  FOREIGN KEY (tenant_id, promotion_id) REFERENCES public.promotions (tenant_id, id),
  CHECK ((discount_kind = 'fixed_amount') = (amount_off IS NOT NULL)),
  CHECK ((discount_kind = 'percent') = (percent_off_bp IS NOT NULL)),
  CHECK (ends_at > starts_at)
);

CREATE TABLE public.promotion_version_products (
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  promotion_id uuid NOT NULL,
  version integer NOT NULL,
  product_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, promotion_id, version, product_id),
  FOREIGN KEY (tenant_id, promotion_id, version)
    REFERENCES public.promotion_versions (tenant_id, promotion_id, version),
  FOREIGN KEY (tenant_id, product_id) REFERENCES public.products (tenant_id, id)
);

CREATE TRIGGER promotion_versions_stamp BEFORE INSERT ON public.promotion_versions
  FOR EACH ROW EXECUTE FUNCTION app.stamp_created_txid();
CREATE TRIGGER promotion_version_products_sealed BEFORE INSERT ON public.promotion_version_products
  FOR EACH ROW EXECUTE FUNCTION app.check_sealed_parent();

-- Quotes ------------------------------------------------------------------------

-- An immutable priced quote for one trip and party: the versions it used, a
-- snapshot of the trip it prices, its lines, and its totals. The total is the
-- subtotal (trip price and add-ons) less the discount, plus fees, plus taxes
-- added on top; taxes included in prices are reported, not added. A guest may
-- create one; nobody may change one. Checkout (G2.6 and G2.7) builds on it.
CREATE TABLE public.quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  trip_id uuid NOT NULL,
  product_id uuid NOT NULL,
  product_kind text NOT NULL CHECK (product_kind IN ('shared_seat', 'private_charter')),
  product_name text NOT NULL CHECK (char_length(product_name) BETWEEN 1 AND 120),
  trip_time_zone app.iana_zone NOT NULL,
  trip_local_date date NOT NULL,
  trip_local_start_time time(0) NOT NULL,
  trip_starts_at timestamptz NOT NULL,
  trip_start_utc_offset_minutes smallint NOT NULL
    CHECK (trip_start_utc_offset_minutes BETWEEN -1080 AND 1080),
  price_list_version integer NOT NULL,
  policy_version integer NOT NULL,
  promotion_id uuid,
  promotion_version integer,
  currency text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  party_size integer NOT NULL CHECK (party_size BETWEEN 1 AND 500),
  subtotal_amount integer NOT NULL CHECK (subtotal_amount BETWEEN 0 AND 100000000),
  discount_amount integer NOT NULL CHECK (discount_amount BETWEEN 0 AND 100000000),
  fee_amount integer NOT NULL CHECK (fee_amount BETWEEN 0 AND 100000000),
  tax_amount integer NOT NULL CHECK (tax_amount BETWEEN 0 AND 100000000),
  included_tax_amount integer NOT NULL CHECK (included_tax_amount BETWEEN 0 AND 100000000),
  total_amount integer NOT NULL CHECK (total_amount BETWEEN 0 AND 100000000),
  quoted_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_txid xid8 NOT NULL DEFAULT pg_current_xact_id(),
  actor_type text NOT NULL DEFAULT coalesce(app.setting_or_null('app.actor_type'), 'system')
    CHECK (actor_type IN ('guest', 'staff', 'system', 'support')),
  actor_id text DEFAULT app.setting_or_null('app.actor_id'),
  request_id text DEFAULT app.setting_or_null('app.request_id'),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, trip_id, product_id)
    REFERENCES public.scheduled_trips (tenant_id, id, product_id),
  FOREIGN KEY (tenant_id, product_id, price_list_version, product_kind)
    REFERENCES public.price_list_versions (tenant_id, product_id, version, product_kind),
  FOREIGN KEY (tenant_id, product_id, policy_version)
    REFERENCES public.policy_versions (tenant_id, product_id, version),
  FOREIGN KEY (tenant_id, promotion_id, promotion_version)
    REFERENCES public.promotion_versions (tenant_id, promotion_id, version),
  CHECK ((promotion_id IS NULL) = (promotion_version IS NULL)),
  CHECK (discount_amount <= subtotal_amount),
  CHECK (total_amount = subtotal_amount - discount_amount + fee_amount + tax_amount),
  -- The service holds a price for 30 minutes; no quote may hold one longer than an hour.
  CHECK (expires_at > quoted_at AND expires_at <= quoted_at + interval '1 hour')
);

-- Ticket, charter, add-on, and fee lines carry quantity times unit price and,
-- on trip-price lines, their share of the discount. The discount line carries
-- the whole discount as a negative amount. Taxes are per line and rate below.
CREATE TABLE public.quote_lines (
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  quote_id uuid NOT NULL,
  line_no smallint NOT NULL CHECK (line_no BETWEEN 1 AND 200),
  kind text NOT NULL CHECK (kind IN ('ticket', 'charter', 'add_on', 'fee', 'discount')),
  code text NOT NULL CHECK (char_length(code) BETWEEN 1 AND 32),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  basis text CHECK (basis IN ('per_booking', 'per_participant')),
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 50000),
  unit_amount integer NOT NULL CHECK (unit_amount BETWEEN 0 AND 100000000),
  amount integer NOT NULL CHECK (amount BETWEEN -100000000 AND 100000000),
  discount_amount integer NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
  taxable boolean NOT NULL,
  PRIMARY KEY (tenant_id, quote_id, line_no),
  FOREIGN KEY (tenant_id, quote_id) REFERENCES public.quotes (tenant_id, id),
  CHECK ((kind IN ('fee', 'add_on')) = (basis IS NOT NULL)),
  CHECK (kind = 'discount' OR amount::bigint = quantity::bigint * unit_amount),
  CHECK (kind <> 'discount'
         OR (quantity = 1 AND amount = -unit_amount AND NOT taxable AND discount_amount = 0)),
  CHECK (kind IN ('ticket', 'charter') OR discount_amount = 0),
  CHECK (discount_amount <= greatest(amount, 0))
);

-- One row per taxable line and tax rate: the pre-tax amount the rate applies
-- to and the tax, rounded half up per line. Whether the tax is added or
-- included comes from the rate version it names.
CREATE TABLE public.quote_line_taxes (
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  quote_id uuid NOT NULL,
  line_no smallint NOT NULL,
  tax_rate_id uuid NOT NULL,
  tax_rate_version integer NOT NULL,
  taxable_amount integer NOT NULL CHECK (taxable_amount BETWEEN 0 AND 100000000),
  amount integer NOT NULL CHECK (amount BETWEEN 0 AND 100000000),
  PRIMARY KEY (tenant_id, quote_id, line_no, tax_rate_id),
  FOREIGN KEY (tenant_id, quote_id, line_no)
    REFERENCES public.quote_lines (tenant_id, quote_id, line_no),
  FOREIGN KEY (tenant_id, tax_rate_id, tax_rate_version)
    REFERENCES public.tax_rate_versions (tenant_id, tax_rate_id, version)
);

-- Checked at commit, after the lines are written: the header totals equal the
-- sums of the lines, only taxable lines carry tax, the discount is allocated
-- in full, and a quote has a trip-price line and a discount line only when it
-- names a promotion.
CREATE FUNCTION app.check_quote_totals() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  sums record;
  taxes record;
BEGIN
  SELECT coalesce(sum(l.amount) FILTER (WHERE l.kind IN ('ticket', 'charter', 'add_on')), 0)
           AS subtotal,
         coalesce(-sum(l.amount) FILTER (WHERE l.kind = 'discount'), 0) AS discount,
         coalesce(sum(l.discount_amount), 0) AS allocated,
         coalesce(sum(l.amount) FILTER (WHERE l.kind = 'fee'), 0) AS fees,
         count(*) FILTER (WHERE l.kind IN ('ticket', 'charter')) AS price_lines,
         count(*) FILTER (WHERE l.kind = 'discount') AS discount_lines
    INTO sums
    FROM public.quote_lines l
   WHERE l.tenant_id = NEW.tenant_id AND l.quote_id = NEW.id;
  SELECT coalesce(sum(t.amount) FILTER (WHERE NOT r.inclusive), 0) AS added,
         coalesce(sum(t.amount) FILTER (WHERE r.inclusive), 0) AS included,
         count(*) FILTER (WHERE NOT l.taxable) AS untaxable
    INTO taxes
    FROM public.quote_line_taxes t
    JOIN public.quote_lines l
      ON l.tenant_id = t.tenant_id AND l.quote_id = t.quote_id AND l.line_no = t.line_no
    JOIN public.tax_rate_versions r
      ON r.tenant_id = t.tenant_id AND r.tax_rate_id = t.tax_rate_id
     AND r.version = t.tax_rate_version
   WHERE t.tenant_id = NEW.tenant_id AND t.quote_id = NEW.id;
  IF sums.price_lines = 0
     OR sums.subtotal <> NEW.subtotal_amount
     OR sums.discount <> NEW.discount_amount
     OR sums.allocated <> NEW.discount_amount
     OR sums.fees <> NEW.fee_amount
     OR taxes.added <> NEW.tax_amount
     OR taxes.included <> NEW.included_tax_amount
     OR taxes.untaxable <> 0
     OR sums.discount_lines > 1
     OR (sums.discount_lines = 1) <> (NEW.promotion_id IS NOT NULL) THEN
    RAISE EXCEPTION 'quote % does not add up to its lines', NEW.id USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

-- Checked when the quote is written, as the writer: its trip snapshot is the
-- trip's own time, zone, and product, so what a guest is shown is the
-- departure the quote names.
CREATE FUNCTION app.check_quote_trip() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  trip record;
BEGIN
  SELECT t.time_zone, t.local_date, t.local_start_time, t.starts_at,
         t.start_utc_offset_minutes, p.name, p.kind
    INTO trip
    FROM public.scheduled_trips t
    JOIN public.products p ON p.tenant_id = t.tenant_id AND p.id = t.product_id
   WHERE t.tenant_id = NEW.tenant_id AND t.id = NEW.trip_id AND t.product_id = NEW.product_id;
  IF NOT FOUND
     OR trip.time_zone <> NEW.trip_time_zone
     OR trip.local_date <> NEW.trip_local_date
     OR trip.local_start_time <> NEW.trip_local_start_time
     OR trip.starts_at <> NEW.trip_starts_at
     OR trip.start_utc_offset_minutes <> NEW.trip_start_utc_offset_minutes
     OR trip.name <> NEW.product_name
     OR trip.kind <> NEW.product_kind THEN
    RAISE EXCEPTION 'quote does not match the trip it names' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

-- Checked at commit: the quote is what its versions produce. Each priced line
-- is an item of the named price list version copied exactly, with a quantity
-- its rule allows on the trip's date; each item appears once and every
-- mandatory fee is charged; the tickets are the party. A promotion was
-- redeemable for the product at the quote instant, and the discount is its
-- rule on the trip price. Taxes follow their rate versions: every taxable line
-- carries the same rates on one pre-tax amount, inclusive rates extracted
-- from the line's net and added rates rounded half up. Integer division of
-- non-negative values, floor((2a + b) / 2b), is the half-up rounding the
-- service uses.
CREATE FUNCTION app.check_quote_terms() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  promo record;
  eligible bigint;
  expected_discount bigint;
BEGIN
  IF EXISTS (
       SELECT 1
         FROM public.quote_lines l
         LEFT JOIN public.price_list_items i
           ON i.tenant_id = l.tenant_id AND i.product_id = NEW.product_id
          AND i.version = NEW.price_list_version AND i.item_kind = l.kind AND i.code = l.code
        WHERE l.tenant_id = NEW.tenant_id AND l.quote_id = NEW.id AND l.kind <> 'discount'
          AND (i.code IS NULL
               OR i.name <> l.name
               OR i.unit_amount <> l.unit_amount
               OR i.taxable <> l.taxable
               OR i.basis IS DISTINCT FROM l.basis
               OR (l.kind = 'charter' AND l.quantity <> 1)
               OR (l.kind = 'fee' AND l.quantity
                     <> CASE i.basis WHEN 'per_participant' THEN NEW.party_size ELSE 1 END)
               OR (l.kind = 'add_on' AND (
                     l.quantity::bigint > i.max_quantity::bigint
                       * CASE i.basis WHEN 'per_participant' THEN NEW.party_size ELSE 1 END
                     OR NEW.trip_local_date < coalesce(i.available_from, NEW.trip_local_date)
                     OR NEW.trip_local_date > coalesce(i.available_until, NEW.trip_local_date)))))
  THEN
    RAISE EXCEPTION 'quote % has lines its price list does not allow', NEW.id
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
       SELECT 1 FROM public.quote_lines l
        WHERE l.tenant_id = NEW.tenant_id AND l.quote_id = NEW.id
        GROUP BY l.kind, l.code HAVING count(*) > 1)
     OR EXISTS (
       SELECT 1 FROM public.price_list_items i
        WHERE i.tenant_id = NEW.tenant_id AND i.product_id = NEW.product_id
          AND i.version = NEW.price_list_version AND i.item_kind = 'fee'
          AND NOT EXISTS (
            SELECT 1 FROM public.quote_lines l
             WHERE l.tenant_id = NEW.tenant_id AND l.quote_id = NEW.id
               AND l.kind = 'fee' AND l.code = i.code))
     OR (NEW.product_kind = 'shared_seat' AND NEW.party_size <> (
           SELECT coalesce(sum(l.quantity), 0) FROM public.quote_lines l
            WHERE l.tenant_id = NEW.tenant_id AND l.quote_id = NEW.id AND l.kind = 'ticket'))
  THEN
    RAISE EXCEPTION 'quote % does not cover its party and fees', NEW.id USING ERRCODE = '23514';
  END IF;

  IF NEW.promotion_id IS NOT NULL THEN
    SELECT p.code, v.discount_kind, v.amount_off, v.percent_off_bp, v.starts_at, v.ends_at,
           v.active, v.applies_to_all_products,
           EXISTS (
             SELECT 1 FROM public.promotion_version_products pp
              WHERE pp.tenant_id = v.tenant_id AND pp.promotion_id = v.promotion_id
                AND pp.version = v.version AND pp.product_id = NEW.product_id) AS listed
      INTO promo
      FROM public.promotions p
      JOIN public.promotion_versions v ON v.tenant_id = p.tenant_id AND v.promotion_id = p.id
     WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.promotion_id
       AND v.version = NEW.promotion_version;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'quote % names a promotion version that does not exist', NEW.id
        USING ERRCODE = '23514';
    END IF;
    SELECT coalesce(sum(l.amount), 0) INTO eligible
      FROM public.quote_lines l
     WHERE l.tenant_id = NEW.tenant_id AND l.quote_id = NEW.id
       AND l.kind IN ('ticket', 'charter');
    expected_discount := CASE promo.discount_kind
      WHEN 'percent' THEN (2 * eligible * promo.percent_off_bp + 10000) / 20000
      ELSE least(promo.amount_off::bigint, eligible) END;
    IF NOT promo.active
       OR NEW.quoted_at < promo.starts_at
       OR NEW.quoted_at >= promo.ends_at
       OR NOT (promo.applies_to_all_products OR promo.listed)
       OR expected_discount <> NEW.discount_amount
       OR NOT EXISTS (
         SELECT 1 FROM public.quote_lines l
          WHERE l.tenant_id = NEW.tenant_id AND l.quote_id = NEW.id
            AND l.kind = 'discount' AND l.code = promo.code) THEN
      RAISE EXCEPTION 'quote % applies a promotion it may not', NEW.id USING ERRCODE = '23514';
    END IF;
  END IF;

  IF EXISTS (
       WITH rates AS (
         SELECT DISTINCT t.tax_rate_id, t.tax_rate_version
           FROM public.quote_line_taxes t
          WHERE t.tenant_id = NEW.tenant_id AND t.quote_id = NEW.id),
       per_line AS (
         SELECT l.line_no,
                l.amount - l.discount_amount AS net,
                count(t.tax_rate_id) AS rate_count,
                count(DISTINCT t.taxable_amount) AS bases,
                min(t.taxable_amount) AS base,
                coalesce(sum(t.amount) FILTER (WHERE r.inclusive), 0) AS included,
                coalesce(sum(r.rate_ppm) FILTER (WHERE r.inclusive), 0) AS included_ppm,
                count(*) FILTER (
                  WHERE NOT r.inclusive
                    AND t.amount <> (2 * t.taxable_amount::bigint * r.rate_ppm + 1000000) / 2000000
                ) AS wrong_added
           FROM public.quote_lines l
           LEFT JOIN public.quote_line_taxes t
             ON t.tenant_id = l.tenant_id AND t.quote_id = l.quote_id AND t.line_no = l.line_no
           LEFT JOIN public.tax_rate_versions r
             ON r.tenant_id = t.tenant_id AND r.tax_rate_id = t.tax_rate_id
            AND r.version = t.tax_rate_version
          WHERE l.tenant_id = NEW.tenant_id AND l.quote_id = NEW.id AND l.taxable
          GROUP BY l.line_no, l.amount, l.discount_amount)
     SELECT 1 FROM per_line
      WHERE rate_count <> (SELECT count(*) FROM rates)
         OR (rate_count > 0 AND (
               bases <> 1
               OR base + included <> net
               OR base <> (2 * net::bigint * 1000000 + 1000000 + included_ppm)
                          / (2 * (1000000 + included_ppm))
               OR wrong_added > 0)))
     OR (SELECT count(DISTINCT t.tax_rate_id) FROM public.quote_line_taxes t
          WHERE t.tenant_id = NEW.tenant_id AND t.quote_id = NEW.id)
        <> (SELECT count(*) FROM (
              SELECT DISTINCT t.tax_rate_id, t.tax_rate_version FROM public.quote_line_taxes t
               WHERE t.tenant_id = NEW.tenant_id AND t.quote_id = NEW.id) d)
  THEN
    RAISE EXCEPTION 'quote % has taxes that do not follow its rates', NEW.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER quotes_stamp BEFORE INSERT ON public.quotes
  FOR EACH ROW EXECUTE FUNCTION app.stamp_created_txid();
CREATE TRIGGER quotes_trip_snapshot BEFORE INSERT ON public.quotes
  FOR EACH ROW EXECUTE FUNCTION app.check_quote_trip();
CREATE CONSTRAINT TRIGGER quotes_add_up
  AFTER INSERT ON public.quotes
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.check_quote_totals();
CREATE CONSTRAINT TRIGGER quotes_follow_terms
  AFTER INSERT ON public.quotes
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.check_quote_terms();
CREATE TRIGGER quote_lines_sealed BEFORE INSERT ON public.quote_lines
  FOR EACH ROW EXECUTE FUNCTION app.check_sealed_parent();
CREATE TRIGGER quote_line_taxes_sealed BEFORE INSERT ON public.quote_line_taxes
  FOR EACH ROW EXECUTE FUNCTION app.check_sealed_parent();

-- Publishing needs terms ----------------------------------------------------------

-- A product is published only with a price list and a policy. The publish
-- service reports each missing piece by name; this trigger holds the rule for
-- every writer. Versions are append-only, so a product that has terms keeps
-- them. The commit-time check above keeps every price list complete.
CREATE FUNCTION app.check_product_sale_terms() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF NEW.sales_status <> 'published' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.sales_status = 'published' THEN
      RETURN NEW;
    END IF;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.price_list_versions v
     WHERE v.tenant_id = NEW.tenant_id AND v.product_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'product % has no price list', NEW.id USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.policy_versions p
     WHERE p.tenant_id = NEW.tenant_id AND p.product_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'product % has no policy', NEW.id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER products_sale_terms BEFORE INSERT OR UPDATE OF sales_status ON public.products
  FOR EACH ROW EXECUTE FUNCTION app.check_product_sale_terms();

-- Row-level security and append-only guards ---------------------------------------

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'price_list_versions', 'price_list_items', 'policy_versions', 'tax_rate_versions',
    'promotions', 'promotion_versions', 'promotion_version_products',
    'quotes', 'quote_lines', 'quote_line_taxes'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I'
      ' USING (tenant_id = (SELECT app.current_tenant_id()))'
      ' WITH CHECK (tenant_id = (SELECT app.current_tenant_id()))', t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I'
      ' FOR EACH ROW EXECUTE FUNCTION app.reject_mutation()', t || '_append_only', t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I'
      ' FOR EACH STATEMENT EXECUTE FUNCTION app.reject_mutation()', t || '_no_truncate', t);
  END LOOP;
END
$$;

-- Every table that records an actor takes it from the transaction.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'price_list_versions', 'policy_versions', 'tax_rate_versions',
    'promotions', 'promotion_versions', 'quotes'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE INSERT ON public.%I'
      ' FOR EACH ROW EXECUTE FUNCTION app.stamp_actor()', t || '_actor', t);
  END LOOP;
END
$$;

-- The runtime keeps the default SELECT and INSERT from 0001 on every table
-- above and receives nothing more. Trigger functions run as the writer, or as
-- their owner for the commit-time checks; none is callable directly.
REVOKE ALL ON FUNCTION app.stamp_created_txid() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.stamp_actor() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.check_sealed_parent() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.check_price_list_complete() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.check_quote_totals() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.check_quote_trip() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.check_quote_terms() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.check_product_sale_terms() FROM PUBLIC;
