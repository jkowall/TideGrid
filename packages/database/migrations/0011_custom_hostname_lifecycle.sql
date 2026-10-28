-- 0011 custom hostname lifecycle (G2.14b)
--
-- A hostname selects one tenant's public experience and grants nothing
-- (0002). This migration adds the lifecycle of a custom hostname: requested,
-- pending while the provider validates ownership and issues a certificate,
-- active once the provider reports both active, and disabled when it stops
-- being servable or someone turns it off. Resolution still reads only
-- tenant_hostnames.status; the provider's detail lives beside it in
-- tenant_hostname_provisioning.
--
-- Who may do what:
--
-- - The runtime (tidegrid_app) keeps SELECT only on both tables. Its cron may
--   list the tenants with a check due (app.hostname_sweep_tenants) and record
--   a provider reading inside the tenant's own transaction
--   (app.hostname_record_check), which may demote a hostname and never
--   promotes one.
-- - Requesting, attaching the provider's record, activating, and disabling
--   are admin-only (the admin CLI in tools/hostnames). Activation re-reads the
--   provider at call time. A runtime that both wrote provider states and
--   activated would only repeat what it wrote itself, which adds no boundary.
--
-- Residual trust: provider truth is whatever the adapter reports to the admin
-- CLI or the sweep. The database guards tenant scope, the provider id match,
-- and the transitions. See packages/database/README.md.
--
-- Existing rows and fixtures stay valid unchanged: the name rules for custom
-- hostnames live in app.hostname_request, the only writer of new custom rows,
-- not in a trigger on insert.

-- tenant_hostnames: composite key, platform kind, transitions -------------------

-- The provisioning table names its hostname together with its tenant.
ALTER TABLE public.tenant_hostnames
  ADD CONSTRAINT tenant_hostnames_hostname_tenant_key UNIQUE (hostname, tenant_id);

-- A platform hostname, such as demo.tidegrid.us pointing at the first
-- synthetic tenant, is written by the admin connection only, from an explicit
-- allowlist, and is never swept (G2.14b, D19, a coordinator default pending
-- owner confirmation).
ALTER TABLE public.tenant_hostnames DROP CONSTRAINT tenant_hostnames_kind_check;
ALTER TABLE public.tenant_hostnames ADD CONSTRAINT tenant_hostnames_kind_check
  CHECK (kind IN ('preview', 'custom', 'platform'));
ALTER TABLE public.tenant_hostnames ADD CONSTRAINT tenant_hostnames_platform_allowlist
  CHECK (kind <> 'platform' OR hostname IN ('demo.tidegrid.us'));

-- Provisioning ----------------------------------------------------------------------

-- One row per custom hostname: the provider's record and its latest reading.
-- `instructions` holds the public DNS targets an operator publishes (CNAME,
-- ownership TXT, certificate TXT, HTTP token): never a secret.
CREATE TABLE public.tenant_hostname_provisioning (
  tenant_id uuid NOT NULL REFERENCES public.tenants (id),
  hostname text NOT NULL,
  provider text NOT NULL CHECK (provider IN ('fake', 'cloudflare_saas')),
  provider_hostname_id text
    CHECK (provider_hostname_id IS NULL OR provider_hostname_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  hostname_state text NOT NULL DEFAULT 'pending'
    CHECK (hostname_state IN ('pending', 'active', 'moved', 'blocked', 'deleted', 'unknown')),
  certificate_state text NOT NULL DEFAULT 'pending'
    CHECK (certificate_state IN ('pending', 'active', 'expiring', 'failed', 'unknown')),
  instructions jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(instructions) = 'array' AND octet_length(instructions::text) <= 8192),
  last_error_code text CHECK (last_error_code IS NULL OR last_error_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  last_checked_at timestamptz,
  next_check_at timestamptz NOT NULL DEFAULT now(),
  check_attempts integer NOT NULL DEFAULT 0 CHECK (check_attempts >= 0),
  claim_expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, hostname),
  CONSTRAINT tenant_hostname_provisioning_hostname_key UNIQUE (hostname),
  CONSTRAINT tenant_hostname_provisioning_provider_id_key UNIQUE (provider, provider_hostname_id),
  CONSTRAINT tenant_hostname_provisioning_hostname_fkey
    FOREIGN KEY (hostname, tenant_id) REFERENCES public.tenant_hostnames (hostname, tenant_id)
);
CREATE INDEX tenant_hostname_provisioning_due_idx
  ON public.tenant_hostname_provisioning (next_check_at);

ALTER TABLE public.tenant_hostname_provisioning ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_hostname_provisioning FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.tenant_hostname_provisioning
  USING (tenant_id = (SELECT app.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()));
-- 0001 grants SELECT and INSERT on new tables by default. The runtime keeps
-- SELECT only; every write goes through the functions below.
REVOKE INSERT ON public.tenant_hostname_provisioning FROM tidegrid_app;

-- Guards for every role, the owner included --------------------------------------

-- A hostname keeps its name, tenant, kind, and creation time. Its status moves
-- one way: pending to active (a custom hostname only, verified, and only while
-- its provisioning row holds both provider states active), and pending or
-- active to disabled. A disabled name stays reserved: it never moves again.
CREATE FUNCTION app.check_tenant_hostname_update() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF NEW.hostname IS DISTINCT FROM OLD.hostname
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a hostname keeps its name, tenant, kind, and creation time'
      USING ERRCODE = '23514', CONSTRAINT = 'tenant_hostnames_immutable';
  END IF;
  IF NEW.status = OLD.status THEN
    IF NEW.verified_at IS DISTINCT FROM OLD.verified_at THEN
      RAISE EXCEPTION 'a hostname is verified only when it becomes active'
        USING ERRCODE = '23514', CONSTRAINT = 'tenant_hostnames_transition';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'pending' AND NEW.status = 'active' THEN
    IF OLD.kind <> 'custom' OR NEW.verified_at IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.tenant_hostname_provisioning p
       WHERE p.tenant_id = OLD.tenant_id
         AND p.hostname = OLD.hostname
         AND p.provider_hostname_id IS NOT NULL
         AND p.hostname_state = 'active'
         AND p.certificate_state = 'active'
    ) THEN
      RAISE EXCEPTION 'a custom hostname becomes active only with both provider states active'
        USING ERRCODE = '23514', CONSTRAINT = 'tenant_hostnames_activation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status IN ('pending', 'active') AND NEW.status = 'disabled'
     AND NEW.verified_at IS NOT DISTINCT FROM OLD.verified_at THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'a hostname cannot move from % to %', OLD.status, NEW.status
    USING ERRCODE = '23514', CONSTRAINT = 'tenant_hostnames_transition';
END;
$$;
CREATE TRIGGER tenant_hostnames_transitions BEFORE UPDATE ON public.tenant_hostnames
  FOR EACH ROW EXECUTE FUNCTION app.check_tenant_hostname_update();

-- A provisioning row belongs to a pending custom hostname when it is written,
-- keeps its tenant, name, provider, claim, and creation time, and takes a
-- provider id once. Every write stamps updated_at.
CREATE FUNCTION app.check_hostname_provisioning() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.tenant_hostnames h
       WHERE h.hostname = NEW.hostname
         AND h.tenant_id = NEW.tenant_id
         AND h.kind = 'custom'
         AND h.status = 'pending'
    ) THEN
      RAISE EXCEPTION 'provisioning belongs to a pending custom hostname of the same tenant'
        USING ERRCODE = '23514', CONSTRAINT = 'tenant_hostname_provisioning_custom';
    END IF;
    NEW.created_at := now();
    NEW.updated_at := now();
    RETURN NEW;
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.hostname IS DISTINCT FROM OLD.hostname
     OR NEW.provider IS DISTINCT FROM OLD.provider
     OR NEW.claim_expires_at IS DISTINCT FROM OLD.claim_expires_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR (OLD.provider_hostname_id IS NOT NULL
         AND NEW.provider_hostname_id IS DISTINCT FROM OLD.provider_hostname_id) THEN
    RAISE EXCEPTION 'provisioning keeps its tenant, name, provider, claim, and provider id'
      USING ERRCODE = '23514', CONSTRAINT = 'tenant_hostname_provisioning_immutable';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER tenant_hostname_provisioning_rules
  BEFORE INSERT OR UPDATE ON public.tenant_hostname_provisioning
  FOR EACH ROW EXECUTE FUNCTION app.check_hostname_provisioning();
-- Nobody deletes or truncates provisioning, the owner included.
CREATE TRIGGER tenant_hostname_provisioning_no_delete
  BEFORE DELETE ON public.tenant_hostname_provisioning
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();
CREATE TRIGGER tenant_hostname_provisioning_no_truncate
  BEFORE TRUNCATE ON public.tenant_hostname_provisioning
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_mutation();

-- Resolution ------------------------------------------------------------------------

-- Unchanged signature and result. A second guard joins the CHECK in 0002: an
-- active row must also carry its verification time.
CREATE OR REPLACE FUNCTION app.resolve_hostname(p_hostname text)
  RETURNS TABLE (tenant_id uuid, tenant_slug text, tenant_name text, hostname_kind text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT t.id, t.slug, t.display_name, h.kind
      FROM public.tenant_hostnames h
      JOIN public.tenants t ON t.id = h.tenant_id
     WHERE h.hostname = lower(p_hostname)
       AND h.status = 'active'
       AND h.verified_at IS NOT NULL
       AND t.status = 'active'
  $$;

-- The sweep (runtime) -----------------------------------------------------------------

-- The cron's tenant list: tenants with a provisioned custom hostname whose
-- check is due, pending or active, or whose pending claim has run out. The
-- same argument as app.capacity_hold_sweep_tenants: tenant ids only, at most
-- 1,000, read-only and STABLE, and every read and write that follows runs in
-- that tenant's own transaction under row-level security. It reveals that some
-- tenant has a custom hostname, a weaker signal than the shared audit and
-- outbox id sequences already give.
CREATE FUNCTION app.hostname_sweep_tenants(p_limit integer)
  RETURNS TABLE (tenant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT DISTINCT p.tenant_id
      FROM public.tenant_hostname_provisioning p
      JOIN public.tenant_hostnames h
        ON h.hostname = p.hostname AND h.tenant_id = p.tenant_id
     WHERE h.kind = 'custom'
       AND p.provider_hostname_id IS NOT NULL
       AND (
         (h.status = 'pending'
          AND (p.next_check_at <= pg_catalog.now() OR p.claim_expires_at <= pg_catalog.now()))
         OR (h.status = 'active' AND p.next_check_at <= pg_catalog.now())
       )
     ORDER BY p.tenant_id
     LIMIT greatest(1, least(coalesce(p_limit, 100), 1000))
  $$;

-- Record one provider reading for a hostname of the transaction's own tenant.
-- It refuses unless the tenant is the transaction's, the row is that tenant's,
-- and the provider id equals the one stored. It may demote and never
-- promotes. Disabled is terminal, so only a definitive negative demotes an
-- active custom hostname: ownership moved, blocked, or deleted, or the
-- certificate failed. A pending or unknown reading (a certificate renewing,
-- a state the mapping does not know) is recorded and changes nothing; it
-- would only block an activation. A pending hostname past its claim becomes
-- disabled as expired.
--
-- With both states NULL and an error code, it records that the provider gave
-- no reading for this one record (a refusal about the record, not the
-- account): the stored states stay, the error code is kept, the next check
-- backs off, and nothing is demoted. A claim past its end still expires,
-- because that is the database's own fact. The
-- next check backs off from 60 seconds to 4 hours while pending, the provider's
-- own schedule, and comes hourly while active. Returns 'recorded', 'demoted',
-- or 'expired'.
CREATE FUNCTION app.hostname_record_check(
    p_tenant_id uuid,
    p_hostname text,
    p_provider_id text,
    p_hostname_state text,
    p_certificate_state text,
    p_error_code text)
  RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_status text;
  v_kind text;
  v_provider_id text;
  v_claim timestamptz;
  v_attempts integer;
  v_definitive_negative boolean;
BEGIN
  IF p_tenant_id IS NULL OR p_tenant_id IS DISTINCT FROM app.current_tenant_id() THEN
    RAISE EXCEPTION 'a hostname check runs in its own tenant''s transaction'
      USING ERRCODE = '42501';
  END IF;
  SELECT h.status, h.kind, p.provider_hostname_id, p.claim_expires_at, p.check_attempts
    INTO v_status, v_kind, v_provider_id, v_claim, v_attempts
    FROM public.tenant_hostname_provisioning p
    JOIN public.tenant_hostnames h
      ON h.hostname = p.hostname AND h.tenant_id = p.tenant_id
   WHERE p.tenant_id = p_tenant_id
     AND p.hostname = p_hostname
   FOR UPDATE OF p, h;
  IF NOT FOUND OR v_kind <> 'custom' OR v_provider_id IS NULL
     OR p_provider_id IS NULL OR v_provider_id <> p_provider_id THEN
    RAISE EXCEPTION 'no provisioned hostname of this tenant matches the check'
      USING ERRCODE = '42501';
  END IF;

  IF (p_hostname_state IS NULL) <> (p_certificate_state IS NULL)
     OR (p_hostname_state IS NULL AND p_error_code IS NULL) THEN
    RAISE EXCEPTION 'a check records both states, or neither with an error code'
      USING ERRCODE = '22023';
  END IF;
  v_definitive_negative := coalesce(p_hostname_state IN ('moved', 'blocked', 'deleted'), false)
                           OR coalesce(p_certificate_state = 'failed', false);
  UPDATE public.tenant_hostname_provisioning
     SET hostname_state = coalesce(p_hostname_state, hostname_state),
         certificate_state = coalesce(p_certificate_state, certificate_state),
         last_error_code = p_error_code,
         last_checked_at = pg_catalog.now(),
         check_attempts = v_attempts + 1,
         next_check_at = pg_catalog.now() + CASE
           WHEN v_status = 'active' THEN interval '1 hour'
           ELSE pg_catalog.make_interval(
             secs => least(14400, 60 * pg_catalog.power(2, least(v_attempts, 8))))
         END
   WHERE tenant_id = p_tenant_id AND hostname = p_hostname;

  IF v_status = 'active' AND v_definitive_negative THEN
    UPDATE public.tenant_hostnames SET status = 'disabled'
     WHERE tenant_id = p_tenant_id AND hostname = p_hostname;
    INSERT INTO public.audit_events
      (tenant_id, action, subject_type, subject_id, reason, before_state, after_state)
    VALUES (p_tenant_id, 'hostname.demoted', 'tenant_hostname', p_hostname,
            'The provider no longer reports this hostname servable',
            pg_catalog.jsonb_build_object('status', 'active'),
            pg_catalog.jsonb_build_object('status', 'disabled',
              'hostname_state', p_hostname_state, 'certificate_state', p_certificate_state));
    RETURN 'demoted';
  END IF;
  IF v_status = 'pending' AND v_claim <= pg_catalog.now() THEN
    UPDATE public.tenant_hostname_provisioning SET last_error_code = 'expired'
     WHERE tenant_id = p_tenant_id AND hostname = p_hostname;
    UPDATE public.tenant_hostnames SET status = 'disabled'
     WHERE tenant_id = p_tenant_id AND hostname = p_hostname;
    INSERT INTO public.audit_events
      (tenant_id, action, subject_type, subject_id, reason, before_state, after_state)
    VALUES (p_tenant_id, 'hostname.expired', 'tenant_hostname', p_hostname,
            'The hostname was not validated before its claim ran out',
            pg_catalog.jsonb_build_object('status', 'pending'),
            pg_catalog.jsonb_build_object('status', 'disabled',
              'hostname_state', p_hostname_state, 'certificate_state', p_certificate_state));
    RETURN 'expired';
  END IF;
  RETURN 'recorded';
END;
$$;

-- Admin-only lifecycle ------------------------------------------------------------

-- Request a custom hostname for an active tenant: a pending custom row and its
-- provisioning row, claimed for seven days, the provider's validation window.
-- The name must already be normalized and follow the custom name rules that
-- packages/tenant-config also holds: at most 200 characters (an audit subject
-- holds 200), at least three labels so no apex domain is attached, no
-- punycode label (G2.14b, D13), and none of the platform or reserved suffixes,
-- matched on a label boundary. A name any tenant holds, in any status, is
-- refused: a disabled name stays reserved in the demo.
CREATE FUNCTION app.hostname_request(p_tenant_id uuid, p_hostname text, p_provider text)
  RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_suffix text;
BEGIN
  IF p_hostname IS NULL
     OR char_length(p_hostname) > 200
     OR p_hostname !~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$'
     OR array_length(string_to_array(p_hostname, '.'), 1) < 3
     OR p_hostname ~ '(^|\.)xn--' THEN
    RAISE EXCEPTION 'not a custom hostname: %', left(coalesce(p_hostname, ''), 200)
      USING ERRCODE = '23514', CONSTRAINT = 'tenant_hostnames_custom_name';
  END IF;
  FOREACH v_suffix IN ARRAY ARRAY[
    'tidegrid.us', 'workers.dev', 'pages.dev', 'localhost', 'test', 'example', 'invalid',
    'onion', 'local', 'internal', 'arpa', 'alt'
  ] LOOP
    IF p_hostname = v_suffix OR right(p_hostname, char_length(v_suffix) + 1) = '.' || v_suffix THEN
      RAISE EXCEPTION 'a custom hostname may not end in %', v_suffix
        USING ERRCODE = '23514', CONSTRAINT = 'tenant_hostnames_custom_name';
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM public.tenants t WHERE t.id = p_tenant_id AND t.status = 'active') THEN
    RAISE EXCEPTION 'no active tenant %', p_tenant_id
      USING ERRCODE = '23503', CONSTRAINT = 'tenant_hostnames_tenant_id_fkey';
  END IF;
  IF EXISTS (SELECT 1 FROM public.tenant_hostnames h WHERE h.hostname = p_hostname) THEN
    RAISE EXCEPTION 'that hostname is already held'
      USING ERRCODE = '23505', CONSTRAINT = 'tenant_hostnames_pkey';
  END IF;
  INSERT INTO public.tenant_hostnames (hostname, tenant_id, kind, status)
  VALUES (p_hostname, p_tenant_id, 'custom', 'pending');
  INSERT INTO public.tenant_hostname_provisioning (tenant_id, hostname, provider, claim_expires_at)
  VALUES (p_tenant_id, p_hostname, p_provider, pg_catalog.now() + interval '7 days');
  INSERT INTO public.audit_events
    (tenant_id, action, subject_type, subject_id, reason, after_state)
  VALUES (p_tenant_id, 'hostname.requested', 'tenant_hostname', p_hostname,
          'Custom hostname requested',
          pg_catalog.jsonb_build_object('status', 'pending', 'provider', p_provider));
END;
$$;

-- Store the provider's record id and DNS instructions for a pending custom
-- hostname. Once only: a stored id never changes, so an adoption after a lost
-- answer can happen only before any id is stored.
CREATE FUNCTION app.hostname_attach_provider(
    p_tenant_id uuid, p_hostname text, p_provider_id text, p_instructions jsonb)
  RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  UPDATE public.tenant_hostname_provisioning p
     SET provider_hostname_id = p_provider_id,
         instructions = coalesce(p_instructions, '[]'::jsonb),
         next_check_at = pg_catalog.now()
    FROM public.tenant_hostnames h
   WHERE p.tenant_id = p_tenant_id
     AND p.hostname = p_hostname
     AND p.provider_hostname_id IS NULL
     AND p_provider_id IS NOT NULL
     AND h.hostname = p.hostname
     AND h.tenant_id = p.tenant_id
     AND h.status = 'pending';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no pending hostname of this tenant is waiting for its provider record'
      USING ERRCODE = '23514', CONSTRAINT = 'tenant_hostname_provisioning_attach';
  END IF;
  INSERT INTO public.audit_events
    (tenant_id, action, subject_type, subject_id, reason, after_state)
  VALUES (p_tenant_id, 'hostname.provider_attached', 'tenant_hostname', p_hostname,
          'Provider record attached',
          pg_catalog.jsonb_build_object('provider_hostname_id', p_provider_id));
END;
$$;

-- Activate a pending custom hostname with a provider reading taken at call
-- time: the provider id must equal the stored one and both states must be
-- active. The claim must not have run out.
CREATE FUNCTION app.hostname_activate(
    p_tenant_id uuid,
    p_hostname text,
    p_provider_id text,
    p_hostname_state text,
    p_certificate_state text)
  RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_status text;
  v_kind text;
  v_provider_id text;
  v_claim timestamptz;
BEGIN
  SELECT h.status, h.kind, p.provider_hostname_id, p.claim_expires_at
    INTO v_status, v_kind, v_provider_id, v_claim
    FROM public.tenant_hostnames h
    JOIN public.tenant_hostname_provisioning p
      ON p.hostname = h.hostname AND p.tenant_id = h.tenant_id
   WHERE h.tenant_id = p_tenant_id
     AND h.hostname = p_hostname
   FOR UPDATE OF h, p;
  IF NOT FOUND OR v_kind <> 'custom' OR v_status <> 'pending'
     OR v_provider_id IS NULL OR p_provider_id IS NULL OR v_provider_id <> p_provider_id
     OR p_hostname_state IS DISTINCT FROM 'active'
     OR p_certificate_state IS DISTINCT FROM 'active'
     OR v_claim <= pg_catalog.now() THEN
    RAISE EXCEPTION 'this hostname cannot be activated with that reading'
      USING ERRCODE = '23514', CONSTRAINT = 'tenant_hostnames_activation';
  END IF;
  UPDATE public.tenant_hostname_provisioning
     SET hostname_state = 'active',
         certificate_state = 'active',
         last_error_code = NULL,
         last_checked_at = pg_catalog.now(),
         next_check_at = pg_catalog.now() + interval '1 hour'
   WHERE tenant_id = p_tenant_id AND hostname = p_hostname;
  UPDATE public.tenant_hostnames
     SET status = 'active', verified_at = pg_catalog.now()
   WHERE tenant_id = p_tenant_id AND hostname = p_hostname;
  INSERT INTO public.audit_events
    (tenant_id, action, subject_type, subject_id, reason, before_state, after_state)
  VALUES (p_tenant_id, 'hostname.activated', 'tenant_hostname', p_hostname,
          'The provider reports ownership and certificate active',
          pg_catalog.jsonb_build_object('status', 'pending'),
          pg_catalog.jsonb_build_object('status', 'active', 'provider_hostname_id', p_provider_id));
END;
$$;

-- Disable a hostname of any kind. Returns false when it was already disabled.
CREATE FUNCTION app.hostname_disable(p_tenant_id uuid, p_hostname text, p_reason text)
  RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_status text;
BEGIN
  IF p_reason IS NULL OR char_length(btrim(p_reason)) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'give a reason of 1 to 500 characters'
      USING ERRCODE = '23514', CONSTRAINT = 'tenant_hostnames_disable_reason';
  END IF;
  SELECT h.status INTO v_status
    FROM public.tenant_hostnames h
   WHERE h.tenant_id = p_tenant_id AND h.hostname = p_hostname
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such hostname for this tenant'
      USING ERRCODE = '23503', CONSTRAINT = 'tenant_hostnames_hostname_tenant_key';
  END IF;
  IF v_status = 'disabled' THEN
    RETURN false;
  END IF;
  UPDATE public.tenant_hostnames SET status = 'disabled'
   WHERE tenant_id = p_tenant_id AND hostname = p_hostname;
  INSERT INTO public.audit_events
    (tenant_id, action, subject_type, subject_id, reason, before_state, after_state)
  VALUES (p_tenant_id, 'hostname.disabled', 'tenant_hostname', p_hostname, btrim(p_reason),
          pg_catalog.jsonb_build_object('status', v_status),
          pg_catalog.jsonb_build_object('status', 'disabled'));
  RETURN true;
END;
$$;

-- Privileges ------------------------------------------------------------------------

REVOKE ALL ON FUNCTION app.check_tenant_hostname_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.check_hostname_provisioning() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.hostname_sweep_tenants(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.hostname_record_check(uuid, text, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.hostname_request(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.hostname_attach_provider(uuid, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.hostname_activate(uuid, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.hostname_disable(uuid, text, text) FROM PUBLIC;
-- The runtime may list due tenants and record readings. Request, attach,
-- activate, and disable stay with the admin connection.
GRANT EXECUTE ON FUNCTION app.hostname_sweep_tenants(integer) TO tidegrid_app;
GRANT EXECUTE ON FUNCTION app.hostname_record_check(uuid, text, text, text, text, text)
  TO tidegrid_app;
