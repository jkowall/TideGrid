-- 0002 tenancy, staff access, audit, idempotency, and outbox
--
-- Tenant isolation. Every tenant-owned table carries tenant_id, has row-level
-- security enabled and forced, and admits only rows whose tenant matches the
-- transaction-local setting app.tenant_id. A transaction without that setting
-- sees no tenant rows and can write none. Runtime code sets the context with
-- set_config(..., true) inside each transaction; see packages/database/README.md.
-- Forced RLS is defense in depth: application queries also filter by tenant.
--
-- Platform tables (staff identities, login tokens, sessions, security events)
-- are not tenant-owned. The runtime role has no direct privileges on the
-- credential tables. It reaches them only through the SECURITY DEFINER
-- functions in schema app, each of which pins search_path and qualifies every
-- name.
--
-- Privileges. Migration 0001 grants SELECT and INSERT on new tables by default.
-- This migration revokes INSERT where the runtime must not create rows and
-- grants UPDATE column by column where it may change them. The runtime never
-- receives DELETE or TRUNCATE.

-- The SECURITY DEFINER functions below read platform tables that have forced
-- row-level security and no policies. They work only because their owner, the
-- role running this migration, bypasses row-level security, as Neon's owner role
-- does. Refuse to install them under a role that would make every sign-in fail
-- silently.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'migration 0002 must run as a role that bypasses row-level security';
  END IF;
END
$$;

-- Every policy below assumes the runtime role is the plain role that migration
-- 0001 creates. A role made through the Neon console or API joins
-- neon_superuser and bypasses row-level security, and 0001 cannot tell because
-- it skips creation when the role already exists. Refuse to continue.
DO $$
DECLARE
  r record;
BEGIN
  SELECT u.rolsuper, u.rolbypassrls, u.rolcreaterole, u.rolcreatedb,
         EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid
                  WHERE m.member = u.oid
                    AND (g.rolname = 'neon_superuser' OR g.rolname LIKE 'pg\_%')) AS privileged
    INTO r
    FROM pg_roles u
   WHERE u.rolname = 'tidegrid_app';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tidegrid_app is missing; migration 0001 creates it';
  END IF;
  IF r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR r.privileged THEN
    RAISE EXCEPTION 'tidegrid_app is elevated; drop it and let migration 0001 recreate it';
  END IF;
END
$$;

-- Functions are not executable by PUBLIC unless a migration grants them.
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- The runtime needs no temporary objects. Without them it cannot plant a
-- pg_temp object for any function to resolve.
DO $$
BEGIN
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
  -- A non-owner's REVOKE only warns; make that a failure.
  IF has_database_privilege('tidegrid_app', current_database(), 'TEMP') THEN
    RAISE EXCEPTION 'tidegrid_app still holds TEMPORARY; run this migration as the database owner';
  END IF;
END
$$;

CREATE SCHEMA app;
GRANT USAGE ON SCHEMA app TO tidegrid_app;

-- Context helpers -------------------------------------------------------------

-- The tenant for the current transaction, or NULL when none is set. NULL makes
-- every tenant policy false, so missing context fails closed. A malformed
-- value raises instead of matching anything.
CREATE FUNCTION app.current_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT nullif(pg_catalog.current_setting('app.tenant_id', true), '')::uuid $$;

CREATE FUNCTION app.setting_or_null(p_name text) RETURNS text
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT nullif(pg_catalog.current_setting(p_name, true), '') $$;

CREATE FUNCTION app.reject_mutation() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;

REVOKE ALL ON FUNCTION app.current_tenant_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.setting_or_null(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.reject_mutation() FROM PUBLIC;
-- Policies and column defaults run with the privileges of the querying role.
GRANT EXECUTE ON FUNCTION app.current_tenant_id() TO tidegrid_app;
GRANT EXECUTE ON FUNCTION app.setting_or_null(text) TO tidegrid_app;

-- Tenants and hostnames -------------------------------------------------------

CREATE TABLE public.tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE
    CHECK (slug ~ '^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$'),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 120),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.tenants
  USING (id = (SELECT app.current_tenant_id()))
  WITH CHECK (id = (SELECT app.current_tenant_id()));
REVOKE INSERT ON public.tenants FROM tidegrid_app;

-- A hostname selects one tenant's public experience. It grants no permission.
-- Only active, verified hostnames of active tenants resolve; everything else
-- fails closed. The label pattern rejects IP literals because the final label
-- must start with a letter.
CREATE TABLE public.tenant_hostnames (
  hostname text PRIMARY KEY
    CHECK (char_length(hostname) <= 253
           AND hostname ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$'),
  tenant_id uuid NOT NULL REFERENCES public.tenants (id),
  kind text NOT NULL CHECK (kind IN ('preview', 'custom')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'disabled')),
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenant_hostnames_active_is_verified CHECK (status <> 'active' OR verified_at IS NOT NULL)
);
CREATE INDEX tenant_hostnames_tenant_idx ON public.tenant_hostnames (tenant_id);

ALTER TABLE public.tenant_hostnames ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_hostnames FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.tenant_hostnames
  USING (tenant_id = (SELECT app.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()));
REVOKE INSERT ON public.tenant_hostnames FROM tidegrid_app;

-- Staff identities and memberships --------------------------------------------

-- A staff identity is global because one person may work for more than one
-- operator. A tenant sees only identities that hold a membership in it, and
-- never the identity's own display name: each membership carries the name that
-- tenant chose. Addresses are ASCII so that case folding cannot map a lookalike
-- character (for example the Kelvin sign) onto another person's address.
CREATE TABLE public.staff_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL
    CHECK (email = lower(email)
           AND char_length(email) <= 254
           AND email ~ '^[\x21-\x7e]+$'
           AND email ~ '^[^@]+@[^@]+\.[^@]+$'),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 120),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX staff_users_email_key ON public.staff_users (email);

-- Roles follow the pilot product scope: owner (or administrator), booking
-- staff, and read-only finance. The API contract enum must match this list.
CREATE TABLE public.tenant_memberships (
  tenant_id uuid NOT NULL REFERENCES public.tenants (id),
  user_id uuid NOT NULL REFERENCES public.staff_users (id),
  role text NOT NULL CHECK (role IN ('owner', 'booking_staff', 'finance')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 120),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);
CREATE INDEX tenant_memberships_user_idx ON public.tenant_memberships (user_id);

ALTER TABLE public.tenant_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.tenant_memberships
  USING (tenant_id = (SELECT app.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()));
GRANT UPDATE (role, status, display_name, updated_at) ON public.tenant_memberships TO tidegrid_app;

ALTER TABLE public.staff_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staff_users FORCE ROW LEVEL SECURITY;
CREATE POLICY staff_users_visible_through_membership ON public.staff_users
  FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.tenant_memberships m
     WHERE m.user_id = staff_users.id
       AND m.tenant_id = (SELECT app.current_tenant_id())
  ));
-- Identities are created only through app.ensure_staff_user. Tenants read the
-- membership's display name, not the identity's.
REVOKE INSERT ON public.staff_users FROM tidegrid_app;
REVOKE SELECT ON public.staff_users FROM tidegrid_app;
GRANT SELECT (id, email, status, created_at) ON public.staff_users TO tidegrid_app;

-- Audit -----------------------------------------------------------------------

-- Append-only record of who did what, when, why, and with what effect. The
-- actor, correlation, and source columns default from the transaction context
-- so a command cannot forget them. The runtime may insert and read; nobody may
-- update, delete, or truncate, including the table owner.
CREATE TABLE public.audit_events (
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  id bigint GENERATED ALWAYS AS IDENTITY,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor_type text NOT NULL DEFAULT coalesce(app.setting_or_null('app.actor_type'), 'system')
    CHECK (actor_type IN ('staff', 'guest', 'system', 'support')),
  actor_id text DEFAULT app.setting_or_null('app.actor_id'),
  request_id text DEFAULT app.setting_or_null('app.request_id'),
  source_ip text DEFAULT app.setting_or_null('app.source_ip'),
  action text NOT NULL CHECK (action ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  subject_type text NOT NULL CHECK (subject_type ~ '^[a-z][a-z0-9_]*$'),
  subject_id text NOT NULL CHECK (char_length(subject_id) BETWEEN 1 AND 200),
  reason text CHECK (reason IS NULL OR char_length(reason) BETWEEN 1 AND 500),
  before_state jsonb CHECK (before_state IS NULL OR jsonb_typeof(before_state) = 'object'),
  after_state jsonb CHECK (after_state IS NULL OR jsonb_typeof(after_state) = 'object'),
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX audit_events_subject_idx
  ON public.audit_events (tenant_id, subject_type, subject_id, id DESC);

ALTER TABLE public.audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.audit_events
  USING (tenant_id = (SELECT app.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()));
CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON public.audit_events
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();
CREATE TRIGGER audit_events_no_truncate
  BEFORE TRUNCATE ON public.audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_mutation();

-- Idempotency -----------------------------------------------------------------

-- A command claims its key inside the same transaction as its domain writes
-- and stores its successful response before commit. A concurrent duplicate
-- blocks on the primary key until the first commits, then replays the stored
-- response. A failed command rolls back its claim, so the key stays unused.
-- Keys are scoped by tenant, operation, and principal so one principal can
-- never replay another's response.
CREATE TABLE public.idempotency_keys (
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  scope text NOT NULL CHECK (scope ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'),
  principal text NOT NULL CHECK (char_length(principal) BETWEEN 1 AND 200),
  key text NOT NULL CHECK (key ~ '^[A-Za-z0-9_.:-]{8,255}$'),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'completed')),
  response_status integer CHECK (response_status BETWEEN 200 AND 299),
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  PRIMARY KEY (tenant_id, scope, principal, key),
  CONSTRAINT idempotency_keys_completion CHECK (
    (status = 'completed') = (response_status IS NOT NULL AND completed_at IS NOT NULL)
  )
);

ALTER TABLE public.idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.idempotency_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.idempotency_keys
  USING (tenant_id = (SELECT app.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()));
GRANT UPDATE (status, response_status, response_body, completed_at)
  ON public.idempotency_keys TO tidegrid_app;

-- Outbox ----------------------------------------------------------------------

-- Domain events commit in the same transaction as the state they describe.
-- Publication (a later goal) marks rows published; until then the runtime may
-- only insert and read.
CREATE TABLE public.outbox_events (
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  id bigint GENERATED ALWAYS AS IDENTITY,
  topic text NOT NULL CHECK (topic ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  aggregate_type text NOT NULL CHECK (aggregate_type ~ '^[a-z][a-z0-9_]*$'),
  aggregate_id text NOT NULL CHECK (char_length(aggregate_id) BETWEEN 1 AND 200),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  request_id text DEFAULT app.setting_or_null('app.request_id'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  published_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error text,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX outbox_events_pending_idx
  ON public.outbox_events (available_at) WHERE published_at IS NULL;

ALTER TABLE public.outbox_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outbox_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.outbox_events
  USING (tenant_id = (SELECT app.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()));

-- Platform credential tables --------------------------------------------------

-- Hashes only. The raw login token travels in a URL fragment and the raw
-- session token in an HttpOnly cookie; neither is stored.
CREATE TABLE public.staff_login_tokens (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  user_id uuid NOT NULL REFERENCES public.staff_users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);
CREATE INDEX staff_login_tokens_user_idx ON public.staff_login_tokens (user_id, created_at DESC);

CREATE TABLE public.staff_sessions (
  session_hash text PRIMARY KEY CHECK (session_hash ~ '^[0-9a-f]{64}$'),
  user_id uuid NOT NULL REFERENCES public.staff_users (id),
  auth_method text NOT NULL CHECK (auth_method IN ('magic_link')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX staff_sessions_user_idx ON public.staff_sessions (user_id);

CREATE TABLE public.security_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  kind text NOT NULL CHECK (kind IN (
    'login_link_issued',
    'login_link_rate_limited',
    'login_link_unknown_email',
    'login_link_consumed',
    'login_link_rejected',
    'session_revoked',
    'staff_user_created'
  )),
  user_id uuid REFERENCES public.staff_users (id),
  request_id text
);
CREATE TRIGGER security_events_append_only
  BEFORE UPDATE OR DELETE ON public.security_events
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();
CREATE TRIGGER security_events_no_truncate
  BEFORE TRUNCATE ON public.security_events
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_mutation();

ALTER TABLE public.staff_login_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staff_login_tokens FORCE ROW LEVEL SECURITY;
ALTER TABLE public.staff_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staff_sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE public.security_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.security_events FORCE ROW LEVEL SECURITY;
-- No policies: any role subject to RLS sees and writes nothing. The runtime has
-- no privileges at all; the functions below run as the table owner.
REVOKE ALL ON public.staff_login_tokens FROM tidegrid_app;
REVOKE ALL ON public.staff_sessions FROM tidegrid_app;
REVOKE ALL ON public.security_events FROM tidegrid_app;

-- Narrow privileged functions -------------------------------------------------
-- Rules for every function below: SECURITY DEFINER, search_path pinned to
-- pg_catalog then pg_temp, every relation schema-qualified, EXECUTE revoked
-- from PUBLIC and granted only to the runtime role, and explicit predicates
-- because the owner bypasses row-level security.

-- Resolve a public hostname to its tenant. Callers normalize first; the
-- function lowercases again as a guard.
CREATE FUNCTION app.resolve_hostname(p_hostname text)
  RETURNS TABLE (tenant_id uuid, tenant_slug text, tenant_name text, hostname_kind text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT t.id, t.slug, t.display_name, h.kind
      FROM public.tenant_hostnames h
      JOIN public.tenants t ON t.id = h.tenant_id
     WHERE h.hostname = lower(p_hostname)
       AND h.status = 'active'
       AND t.status = 'active'
  $$;

-- Map an authenticated identity (a verified Cloudflare Access email) to an
-- active staff user.
CREATE FUNCTION app.auth_find_staff_by_email(p_email text)
  RETURNS TABLE (user_id uuid, email text, display_name text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT u.id, u.email, u.display_name
      FROM public.staff_users u
     WHERE btrim(p_email) ~ '^[\x21-\x7e]+$'
       AND u.email = lower(btrim(p_email))
       AND u.status = 'active'
  $$;

-- The authenticated user's own active memberships across tenants.
CREATE FUNCTION app.auth_list_memberships(p_user_id uuid)
  RETURNS TABLE (tenant_id uuid, tenant_slug text, tenant_name text, role text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT t.id, t.slug, t.display_name, m.role
      FROM public.tenant_memberships m
      JOIN public.tenants t ON t.id = m.tenant_id
     WHERE m.user_id = p_user_id
       AND m.status = 'active'
       AND t.status = 'active'
     ORDER BY t.display_name, t.id
  $$;

-- Issue a single-use login token for an active staff user. Returns 'issued',
-- 'unknown', or 'rate_limited'; the API answers the same way for all three so
-- the endpoint does not reveal which addresses exist. At most five tokens per
-- user in fifteen minutes, serialized per user so the limit holds under
-- concurrency.
CREATE FUNCTION app.auth_issue_login_token(
    p_email text, p_token_hash text, p_ttl_seconds integer, p_request_id text)
  RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_user uuid;
  v_recent integer;
BEGIN
  IF p_ttl_seconds IS NULL OR p_ttl_seconds < 60 OR p_ttl_seconds > 3600 THEN
    RAISE EXCEPTION 'login token ttl must be between 60 and 3600 seconds' USING ERRCODE = '22023';
  END IF;

  SELECT u.id INTO v_user
    FROM public.staff_users u
   WHERE btrim(p_email) ~ '^[\x21-\x7e]+$'
     AND u.email = lower(btrim(p_email))
     AND u.status = 'active';

  IF v_user IS NULL THEN
    INSERT INTO public.security_events (kind, request_id)
      VALUES ('login_link_unknown_email', p_request_id);
    RETURN 'unknown';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('tidegrid.login:' || v_user::text, 0));

  SELECT count(*) INTO v_recent
    FROM public.staff_login_tokens t
   WHERE t.user_id = v_user AND t.created_at > now() - interval '15 minutes';

  IF v_recent >= 5 THEN
    INSERT INTO public.security_events (kind, user_id, request_id)
      VALUES ('login_link_rate_limited', v_user, p_request_id);
    RETURN 'rate_limited';
  END IF;

  INSERT INTO public.staff_login_tokens (token_hash, user_id, expires_at)
    VALUES (p_token_hash, v_user, clock_timestamp() + make_interval(secs => p_ttl_seconds));
  INSERT INTO public.security_events (kind, user_id, request_id)
    VALUES ('login_link_issued', v_user, p_request_id);
  RETURN 'issued';
END;
$$;

-- Consume a login token exactly once and open a session for its user. Returns
-- no row for an unknown, used, or expired token, or a disabled user.
CREATE FUNCTION app.auth_consume_login_token(
    p_token_hash text, p_session_hash text, p_session_ttl_seconds integer, p_request_id text)
  RETURNS TABLE (user_id uuid, expires_at timestamptz)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
#variable_conflict use_column
DECLARE
  v_user uuid;
  v_expires timestamptz;
BEGIN
  IF p_session_ttl_seconds IS NULL OR p_session_ttl_seconds < 300 OR p_session_ttl_seconds > 604800 THEN
    RAISE EXCEPTION 'session ttl must be between 300 and 604800 seconds' USING ERRCODE = '22023';
  END IF;

  UPDATE public.staff_login_tokens t
     SET consumed_at = clock_timestamp()
   WHERE t.token_hash = p_token_hash
     AND t.consumed_at IS NULL
     AND t.expires_at > clock_timestamp()
     AND EXISTS (SELECT 1 FROM public.staff_users u WHERE u.id = t.user_id AND u.status = 'active')
  RETURNING t.user_id INTO v_user;

  IF v_user IS NULL THEN
    INSERT INTO public.security_events (kind, request_id)
      VALUES ('login_link_rejected', p_request_id);
    RETURN;
  END IF;

  v_expires := clock_timestamp() + make_interval(secs => p_session_ttl_seconds);
  INSERT INTO public.staff_sessions (session_hash, user_id, auth_method, expires_at)
    VALUES (p_session_hash, v_user, 'magic_link', v_expires);
  INSERT INTO public.security_events (kind, user_id, request_id)
    VALUES ('login_link_consumed', v_user, p_request_id);

  user_id := v_user;
  expires_at := v_expires;
  RETURN NEXT;
END;
$$;

-- Resolve a session cookie to its active user.
CREATE FUNCTION app.auth_resolve_session(p_session_hash text)
  RETURNS TABLE (user_id uuid, email text, display_name text, expires_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT u.id, u.email, u.display_name, s.expires_at
      FROM public.staff_sessions s
      JOIN public.staff_users u ON u.id = s.user_id
     WHERE s.session_hash = p_session_hash
       AND s.revoked_at IS NULL
       AND s.expires_at > now()
       AND u.status = 'active'
  $$;

CREATE FUNCTION app.auth_revoke_session(p_session_hash text, p_request_id text)
  RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_user uuid;
BEGIN
  UPDATE public.staff_sessions s
     SET revoked_at = clock_timestamp()
   WHERE s.session_hash = p_session_hash AND s.revoked_at IS NULL
  RETURNING s.user_id INTO v_user;

  IF v_user IS NULL THEN
    RETURN false;
  END IF;
  INSERT INTO public.security_events (kind, user_id, request_id)
    VALUES ('session_revoked', v_user, p_request_id);
  RETURN true;
END;
$$;

-- Find or create the identity for an address being added to a tenant. Callable
-- only inside a transaction bound to an existing, active tenant; the caller has
-- already authorized the membership change. A new identity's own display name
-- is the address's local part, so no tenant can choose what another tenant or
-- the person sees. Tenants name people on the membership instead.
CREATE FUNCTION app.ensure_staff_user(p_email text, p_request_id text)
  RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_tenant uuid := app.current_tenant_id();
  v_email text;
  v_user uuid;
BEGIN
  IF v_tenant IS NULL OR NOT EXISTS (
       SELECT 1 FROM public.tenants t WHERE t.id = v_tenant AND t.status = 'active') THEN
    RAISE EXCEPTION 'ensure_staff_user requires an active tenant context' USING ERRCODE = '42501';
  END IF;
  IF btrim(p_email) !~ '^[\x21-\x7e]+$' THEN
    RAISE EXCEPTION 'staff addresses must be ASCII' USING ERRCODE = '22023';
  END IF;
  v_email := lower(btrim(p_email));

  INSERT INTO public.staff_users (email, display_name)
    VALUES (v_email, left(split_part(v_email, '@', 1), 120))
    ON CONFLICT (email) DO NOTHING
    RETURNING id INTO v_user;

  IF v_user IS NOT NULL THEN
    INSERT INTO public.security_events (kind, user_id, request_id)
      VALUES ('staff_user_created', v_user, p_request_id);
    RETURN v_user;
  END IF;

  SELECT u.id INTO v_user FROM public.staff_users u WHERE u.email = v_email;
  RETURN v_user;
END;
$$;

REVOKE ALL ON FUNCTION app.resolve_hostname(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.auth_find_staff_by_email(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.auth_list_memberships(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.auth_issue_login_token(text, text, integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.auth_consume_login_token(text, text, integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.auth_resolve_session(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.auth_revoke_session(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.ensure_staff_user(text, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app.resolve_hostname(text) TO tidegrid_app;
GRANT EXECUTE ON FUNCTION app.auth_find_staff_by_email(text) TO tidegrid_app;
GRANT EXECUTE ON FUNCTION app.auth_list_memberships(uuid) TO tidegrid_app;
GRANT EXECUTE ON FUNCTION app.auth_issue_login_token(text, text, integer, text) TO tidegrid_app;
GRANT EXECUTE ON FUNCTION app.auth_consume_login_token(text, text, integer, text) TO tidegrid_app;
GRANT EXECUTE ON FUNCTION app.auth_resolve_session(text) TO tidegrid_app;
GRANT EXECUTE ON FUNCTION app.auth_revoke_session(text, text) TO tidegrid_app;
GRANT EXECUTE ON FUNCTION app.ensure_staff_user(text, text) TO tidegrid_app;
