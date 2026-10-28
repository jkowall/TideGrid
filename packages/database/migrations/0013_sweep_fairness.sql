-- 0013 sweep fairness (pre-pilot hardening, item 5, Part A)
--
-- The cron's four cross-tenant sweeps (holds, checkouts, email, hostnames)
-- listed due tenants in tenant id order, at most 100 a run, and spent a 20
-- second budget in that order. Tenant ids are random, so the same tenants lost
-- every run. This migration records, per tenant and sweep, when the sweep last
-- started a turn for that tenant, and the four list functions now name due
-- tenants least recently served first. A tenant the sweep has never served
-- sorts first, and ties fall back to tenant id, so until a sweep writes its
-- first stamp its order is exactly the order before this migration.
--
-- The design is the coordinator default D1 A in the hardening packet (least
-- recently served, with a per-tenant quantum), pending owner confirmation.

-- When each sweep last started a turn for each tenant. A tenant-owned table
-- under rules 1 to 10 of packages/database/README.md. The runtime inserts a
-- tenant's row at its first turn and later moves only the time and the run id;
-- the tenant and the sweep never change. Housekeeping, not a domain fact: a
-- stamp writes no audit or outbox row (D3 A).
CREATE TABLE public.sweep_turns (
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  sweep text NOT NULL CHECK (sweep IN ('hold', 'checkout', 'email', 'hostname')),
  last_turn_at timestamptz NOT NULL DEFAULT now(),
  run_id text CHECK (run_id IS NULL OR char_length(run_id) <= 128),
  PRIMARY KEY (tenant_id, sweep)
);

ALTER TABLE public.sweep_turns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sweep_turns FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.sweep_turns
  USING (tenant_id = (SELECT app.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()));

-- No role deletes or truncates a stamp, the owner included. Not the audit
-- trigger's BEFORE UPDATE OR DELETE: a stamp is updated every turn. The shared
-- app.reject_mutation says "is append-only"; here that means rows stay.
CREATE TRIGGER sweep_turns_no_delete
  BEFORE DELETE ON public.sweep_turns
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();
CREATE TRIGGER sweep_turns_no_truncate
  BEFORE TRUNCATE ON public.sweep_turns
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_mutation();

-- SELECT and INSERT come from the default privileges in 0001.
GRANT UPDATE (last_turn_at, run_id) ON public.sweep_turns TO tidegrid_app;

-- The four list functions keep their names, parameters, return type, owner,
-- and grants (CREATE OR REPLACE). Each due predicate is unchanged and wrapped
-- in a subquery, then joined to that sweep's stamps: never served first, then
-- least recently served, then tenant id. They still return tenant ids only, at
-- most 1,000, read-only and STABLE; the stamps add only the relative recency
-- of the sweep's own turns, which platform code alone sees.

CREATE OR REPLACE FUNCTION app.capacity_hold_sweep_tenants(p_limit integer)
  RETURNS TABLE (tenant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT d.tenant_id
      FROM (SELECT DISTINCT h.tenant_id
              FROM public.capacity_holds h
             WHERE h.state = 'active'
               AND h.expires_at <= pg_catalog.now()) d
      LEFT JOIN public.sweep_turns t
        ON t.tenant_id = d.tenant_id AND t.sweep = 'hold'
     ORDER BY t.last_turn_at ASC NULLS FIRST, d.tenant_id
     LIMIT greatest(1, least(coalesce(p_limit, 100), 1000))
  $$;

CREATE OR REPLACE FUNCTION app.checkout_sweep_tenants(p_limit integer, p_grace_seconds integer)
  RETURNS TABLE (tenant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT x.tenant_id FROM (
      SELECT s.tenant_id FROM public.checkout_sessions s
       WHERE s.state = 'open' AND s.expires_at <= pg_catalog.now()
      UNION
      SELECT r.tenant_id FROM public.payment_refunds r
       WHERE r.state = 'requested'
         AND r.created_at <= pg_catalog.now() - pg_catalog.make_interval(
               secs => greatest(0, least(coalesce(p_grace_seconds, 60), 3600)))
      UNION
      SELECT e.tenant_id FROM public.provider_events e
       WHERE e.processing_state = 'received'
         AND e.verified_at <= pg_catalog.now() - pg_catalog.make_interval(
               secs => greatest(0, least(coalesce(p_grace_seconds, 60), 3600)))
    ) x
      LEFT JOIN public.sweep_turns t
        ON t.tenant_id = x.tenant_id AND t.sweep = 'checkout'
     ORDER BY t.last_turn_at ASC NULLS FIRST, x.tenant_id
     LIMIT greatest(1, least(coalesce(p_limit, 100), 1000))
  $$;

-- Order-neutral until the email sweep writes 'email' stamps (Part C).
CREATE OR REPLACE FUNCTION app.email_delivery_tenants(p_limit integer)
  RETURNS TABLE (tenant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT x.tenant_id FROM (
      SELECT m.tenant_id FROM public.email_messages m
       WHERE m.state = 'queued' AND m.next_attempt_at <= pg_catalog.now()
      UNION
      SELECT m.tenant_id FROM public.email_messages m
       WHERE m.state = 'sending' AND m.lease_expires_at <= pg_catalog.now()
    ) x
      LEFT JOIN public.sweep_turns t
        ON t.tenant_id = x.tenant_id AND t.sweep = 'email'
     ORDER BY t.last_turn_at ASC NULLS FIRST, x.tenant_id
     LIMIT greatest(1, least(coalesce(p_limit, 100), 1000))
  $$;

-- Order-neutral until the hostname sweep writes 'hostname' stamps (Part D).
CREATE OR REPLACE FUNCTION app.hostname_sweep_tenants(p_limit integer)
  RETURNS TABLE (tenant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT d.tenant_id
      FROM (SELECT DISTINCT p.tenant_id
              FROM public.tenant_hostname_provisioning p
              JOIN public.tenant_hostnames h
                ON h.hostname = p.hostname AND h.tenant_id = p.tenant_id
             WHERE h.kind = 'custom'
               AND p.provider_hostname_id IS NOT NULL
               AND (
                 (h.status = 'pending'
                  AND (p.next_check_at <= pg_catalog.now() OR p.claim_expires_at <= pg_catalog.now()))
                 OR (h.status = 'active' AND p.next_check_at <= pg_catalog.now())
               )) d
      LEFT JOIN public.sweep_turns t
        ON t.tenant_id = d.tenant_id AND t.sweep = 'hostname'
     ORDER BY t.last_turn_at ASC NULLS FIRST, d.tenant_id
     LIMIT greatest(1, least(coalesce(p_limit, 100), 1000))
  $$;
