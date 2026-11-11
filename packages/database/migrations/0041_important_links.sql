-- W3-G2.14b-rest, part 1: an operator's Important links.
--
-- Operators keep a short list of named HTTPS links for their guests (docs/v2/02,
-- brand configuration): a fishing-license page for fishing trips, a parking
-- map, a packing list. Each link applies to every trip, or only to the
-- products it names. Guests see the links that apply to their booking beside
-- its arrival instructions. These are the operator's own external resources;
-- TideGrid neither issues nor checks what they point to.
--
-- Configuration, not evidence: an owner edits and reorders links in place,
-- and archives one rather than deleting it, so the runtime never gets DELETE.
-- An archived link is final; a new one is added instead. Every writer is held
-- to the same rules: an https address with a host name (no user name,
-- password, or IP address), short text without control characters, at most
-- 20 products, each one of the tenant's own, and at most 25 active links
-- (500 in all, archived ones included) a tenant, counted under a per-tenant
-- lock.

CREATE TABLE public.important_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  label text NOT NULL
    CHECK (char_length(label) BETWEEN 1 AND 60 AND label !~ '[[:cntrl:]\u0080-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff]'
      AND label !~ '^[[:space:]\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]|[[:space:]\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]$'),
  -- https, a host name ending in a letters-only label (so never an IP
  -- address or a bare name like localhost) that is not a name reserved for
  -- local or special use (.local, .internal, .home.arpa, .test, and so on),
  -- an optional port from 1 to 65535, and nothing before the host: no user
  -- name or password. No control, space, line or paragraph separator,
  -- direction-changing, or zero-width character anywhere. The same rule as
  -- isImportantLinkUrl in @tidegrid/contracts.
  url text NOT NULL
    CHECK (char_length(url) BETWEEN 12 AND 2048 AND url !~ '[[:cntrl:][:space:]   -   　\u0080-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff]'
      AND url ~ '^https://[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.[A-Za-z]{2,63}(?::(?:[1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5]))?(?:[/?#].*)?$'
      AND lower(substring(url FROM '^https://([^/?#:]+)')) !~ '(^|\.)(localhost|localdomain|local|internal|intranet|lan|home|corp|private|test|invalid|example|onion|arpa|alt)$'),
  description text
    CHECK (description IS NULL OR (char_length(description) BETWEEN 1 AND 200
      AND description !~ '[[:cntrl:]\u0080-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff]'
      AND description ~ '[^[:space:]\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]')),
  -- Null: every trip. Otherwise the products whose bookings show it.
  product_ids uuid[]
    CHECK (product_ids IS NULL OR (cardinality(product_ids) BETWEEN 1 AND 20
      AND array_position(product_ids, NULL) IS NULL)),
  position integer NOT NULL CHECK (position BETWEEN 0 AND 999),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text DEFAULT app.setting_or_null('app.actor_id'),
  updated_by text DEFAULT app.setting_or_null('app.actor_id'),
  UNIQUE (tenant_id, id)
);
CREATE INDEX important_links_tenant_idx ON public.important_links (tenant_id, status, position);

COMMENT ON TABLE public.important_links IS
  'An operator''s named HTTPS links for guests, for every trip or named products (W3-G2.14b-rest).';

CREATE FUNCTION app.check_important_link() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  active_count integer;
  total_count integer;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.created_at <> OLD.created_at
       OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
      RAISE EXCEPTION 'an important link keeps its identity'
        USING ERRCODE = '23514', CONSTRAINT = 'important_links_identity';
    END IF;
    IF OLD.status = 'archived' THEN
      RAISE EXCEPTION 'an archived important link does not change'
        USING ERRCODE = '23514', CONSTRAINT = 'important_links_archived';
    END IF;
  ELSE
    IF NEW.status <> 'active' THEN
      RAISE EXCEPTION 'an important link starts active'
        USING ERRCODE = '23514', CONSTRAINT = 'important_links_archived';
    END IF;
    NEW.created_at := now();
    NEW.created_by := app.setting_or_null('app.actor_id');
  END IF;
  NEW.updated_at := now();
  NEW.updated_by := app.setting_or_null('app.actor_id');

  IF NEW.product_ids IS NOT NULL THEN
    IF (SELECT count(DISTINCT x) FROM unnest(NEW.product_ids) AS x) <> cardinality(NEW.product_ids)
       OR EXISTS (
         SELECT 1 FROM unnest(NEW.product_ids) AS x
          WHERE NOT EXISTS (SELECT 1 FROM public.products p
                             WHERE p.tenant_id = NEW.tenant_id AND p.id = x)) THEN
      RAISE EXCEPTION 'an important link names only its operator''s products, once each'
        USING ERRCODE = '23503', CONSTRAINT = 'important_links_products';
    END IF;
  END IF;

  IF NEW.status = 'active' AND (TG_OP = 'INSERT' OR OLD.status <> 'active') THEN
    -- The counts below are right only if read afresh after the lock, which
    -- READ COMMITTED does and a snapshot taken earlier would not.
    IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
      RAISE EXCEPTION 'important links are added only under READ COMMITTED, not %',
        pg_catalog.current_setting('transaction_isolation')
        USING ERRCODE = '25001';
    END IF;
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtext('important_links:' || NEW.tenant_id::text));
    -- Archived links are kept, so the whole list is bounded too.
    IF TG_OP = 'INSERT' THEN
      SELECT count(*) INTO total_count FROM public.important_links l
       WHERE l.tenant_id = NEW.tenant_id;
      IF total_count >= 500 THEN
        RAISE EXCEPTION 'an operator keeps at most 500 important links, archived ones included'
          USING ERRCODE = '23514', CONSTRAINT = 'important_links_total';
      END IF;
    END IF;
    SELECT count(*) INTO active_count FROM public.important_links l
     WHERE l.tenant_id = NEW.tenant_id AND l.status = 'active' AND l.id <> NEW.id;
    IF active_count >= 25 THEN
      RAISE EXCEPTION 'an operator keeps at most 25 important links'
        USING ERRCODE = '23514', CONSTRAINT = 'important_links_limit';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER important_links_rules BEFORE INSERT OR UPDATE ON public.important_links
  FOR EACH ROW EXECUTE FUNCTION app.check_important_link();
CREATE TRIGGER important_links_no_delete BEFORE DELETE ON public.important_links
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();
CREATE TRIGGER important_links_no_truncate BEFORE TRUNCATE ON public.important_links
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_mutation();

ALTER TABLE public.important_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.important_links FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.important_links
  USING (tenant_id = (SELECT app.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()));

-- SELECT and INSERT come from the default privileges in 0001.
GRANT UPDATE (label, url, description, product_ids, position, status, updated_at, updated_by)
  ON public.important_links TO tidegrid_app;

REVOKE ALL ON FUNCTION app.check_important_link() FROM PUBLIC;
