-- 0004 brand configuration
--
-- A tenant's guest brand is versioned server configuration (BrandConfigVersion
-- in docs/v2/04-architecture.md). Publishing appends an immutable version and
-- an activation record. The active brand is the tenant's latest activation;
-- going back to an earlier brand is a new activation of that version, so old
-- versions never change and the history stays auditable.
--
-- The stored config is the brand contract's shape
-- (packages/contracts/src/brand.ts): colors, fonts from the supported set, a
-- validated logo data URI, plain copy, contact details, legal links, locale,
-- and guest capabilities. Writers validate it before insert and the API
-- validates it again before serving it; this table bounds its shape and size.
--
-- Tenant isolation follows packages/database/README.md: tenant_id on every
-- row, tenant-aware foreign keys, forced row-level security with a
-- tenant_isolation policy, and the runtime keeps 0001's default SELECT and
-- INSERT only. Nobody, the owner included, may UPDATE, DELETE, or TRUNCATE.

-- The definer function below reads tables with forced row-level security; its
-- owner must bypass row-level security, as in 0002.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'migration 0004 must run as a role that bypasses row-level security';
  END IF;
END
$$;

-- Versions ----------------------------------------------------------------------

CREATE TABLE public.brand_config_versions (
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  version integer NOT NULL CHECK (version BETWEEN 1 AND 1000000),
  schema_version smallint NOT NULL CHECK (schema_version = 1),
  config jsonb NOT NULL
    CHECK (jsonb_typeof(config) = 'object' AND octet_length(config::text) <= 65536),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor_type text NOT NULL DEFAULT coalesce(app.setting_or_null('app.actor_type'), 'system')
    CHECK (actor_type IN ('staff', 'system', 'support')),
  actor_id text DEFAULT app.setting_or_null('app.actor_id'),
  request_id text DEFAULT app.setting_or_null('app.request_id'),
  PRIMARY KEY (tenant_id, version)
);

ALTER TABLE public.brand_config_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.brand_config_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.brand_config_versions
  USING (tenant_id = (SELECT app.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()));
CREATE TRIGGER brand_config_versions_append_only
  BEFORE UPDATE OR DELETE ON public.brand_config_versions
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();
CREATE TRIGGER brand_config_versions_no_truncate
  BEFORE TRUNCATE ON public.brand_config_versions
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_mutation();

-- Activations -------------------------------------------------------------------

-- Who made which version live, when, and why. The foreign key includes
-- tenant_id, so an activation can only name its own tenant's version.
CREATE TABLE public.brand_activations (
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  id bigint GENERATED ALWAYS AS IDENTITY,
  version integer NOT NULL,
  activated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor_type text NOT NULL DEFAULT coalesce(app.setting_or_null('app.actor_type'), 'system')
    CHECK (actor_type IN ('staff', 'system', 'support')),
  actor_id text DEFAULT app.setting_or_null('app.actor_id'),
  request_id text DEFAULT app.setting_or_null('app.request_id'),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 500),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, version) REFERENCES public.brand_config_versions (tenant_id, version)
);
-- The primary key (tenant_id, id) serves "latest activation for a tenant".

ALTER TABLE public.brand_activations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.brand_activations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.brand_activations
  USING (tenant_id = (SELECT app.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()));
CREATE TRIGGER brand_activations_append_only
  BEFORE UPDATE OR DELETE ON public.brand_activations
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();
CREATE TRIGGER brand_activations_no_truncate
  BEFORE TRUNCATE ON public.brand_activations
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_mutation();

-- Public bootstrap ----------------------------------------------------------------

-- Resolve a public hostname to its tenant and the tenant's active brand. The
-- hostname rules (active, verified hostname of an active tenant) come from
-- app.resolve_hostname, so they live in one place; anything else returns no
-- row. The brand columns are NULL until the tenant has an activation. Every
-- brand read is filtered by the resolved tenant explicitly, because the owner
-- bypasses row-level security. The tenant id is for the caller's logs; the
-- public response carries only the slug and name.
CREATE FUNCTION app.resolve_public_brand(p_hostname text)
  RETURNS TABLE (
    tenant_id uuid,
    tenant_slug text,
    tenant_name text,
    brand_version integer,
    brand_schema_version smallint,
    brand_config jsonb
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT r.tenant_id, r.tenant_slug, r.tenant_name, v.version, v.schema_version, v.config
      FROM app.resolve_hostname(p_hostname) r
      LEFT JOIN LATERAL (
        SELECT a.version
          FROM public.brand_activations a
         WHERE a.tenant_id = r.tenant_id
         ORDER BY a.id DESC
         LIMIT 1
      ) active ON true
      LEFT JOIN public.brand_config_versions v
        ON v.tenant_id = r.tenant_id AND v.version = active.version
  $$;

REVOKE ALL ON FUNCTION app.resolve_public_brand(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_public_brand(text) TO tidegrid_app;
