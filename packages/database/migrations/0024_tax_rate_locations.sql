-- Per-location tax rates (W3-G2.5-TAX)
--
-- Until now a tax rate applied to every taxable line in every quote of its
-- tenant (0005). An operator with docks in different tax jurisdictions needs a
-- rate that applies only to trips departing one location. Each operator
-- enters its own rates. TideGrid calculates and displays them; it does not
-- decide what is owed (packages/domain-pricing/README.md).
--
-- A tax rate version now names the location it applies to, or none. A
-- version with no location applies at every location, exactly as before, so
-- every existing version and every existing quote keeps its meaning. A
-- version with a location applies only to quotes for products departing that
-- location. The location is part of the version: changing it appends a
-- version, and a quote names the version it used, so the scope a quote was
-- priced under never changes.
--
-- The column is nullable with no default, so adding it rewrites nothing and
-- fires no row trigger; tax_rate_versions stays append-only (0005). The
-- composite foreign key carries tenant_id, so a rate can name only its own
-- tenant's location (packages/database/README.md, rule 6).
--
-- Every writer is held to the scope: a quote line tax may use a rate version
-- scoped to a location only when the quote's product departs that location.
-- The trigger runs as the writer, inside its tenant transaction, like
-- app.check_sealed_parent, so another tenant's rows stay invisible. A quote
-- that leaves out an in-scope rate is still the service's to get right, as
-- 0005 already records.

ALTER TABLE public.tax_rate_versions
  ADD COLUMN location_id uuid,
  ADD CONSTRAINT tax_rate_versions_location_fkey
    FOREIGN KEY (tenant_id, location_id) REFERENCES public.locations (tenant_id, id);

COMMENT ON COLUMN public.tax_rate_versions.location_id IS
  'The location whose departures this version applies to; null applies at every location.';

CREATE FUNCTION app.check_quote_tax_location() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  rate_location uuid;
  product_location uuid;
BEGIN
  SELECT r.location_id INTO rate_location
    FROM public.tax_rate_versions r
   WHERE r.tenant_id = NEW.tenant_id AND r.tax_rate_id = NEW.tax_rate_id
     AND r.version = NEW.tax_rate_version;
  IF rate_location IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT p.location_id INTO product_location
    FROM public.quotes q
    JOIN public.products p ON p.tenant_id = q.tenant_id AND p.id = q.product_id
   WHERE q.tenant_id = NEW.tenant_id AND q.id = NEW.quote_id;
  IF product_location IS DISTINCT FROM rate_location THEN
    RAISE EXCEPTION 'tax rate % version % does not apply at this quote''s location',
      NEW.tax_rate_id, NEW.tax_rate_version
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER quote_line_taxes_location BEFORE INSERT ON public.quote_line_taxes
  FOR EACH ROW EXECUTE FUNCTION app.check_quote_tax_location();

REVOKE ALL ON FUNCTION app.check_quote_tax_location() FROM PUBLIC;
