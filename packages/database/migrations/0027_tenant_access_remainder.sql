-- 0027 tenant access remainder (W3-G2.2b, without managed OIDC and MFA)
--
-- Migration 0027 (claimed at merge; 0019 to 0026 belong to other goals). Five parts, one goal:
--
-- 1. Invitations. A person a tenant adds is invited, not active. Only the
--    invited person, signed in, accepts (app.auth_respond_invitation). An
--    invitation lasts seven days; the owner can send it again.
-- 2. Disable revokes sessions. Disabling a staff identity, or a person's last
--    active membership, revokes their magic-link sessions in the same
--    transaction. Re-enabling never revives them.
-- 3. Support access. TideGrid support agents are platform identities. A
--    tenant owner grants one agent read access to the tenant for a reason and
--    at most four hours (D1). Grants live in a table the runtime cannot touch;
--    it reaches them only through the functions below.
-- 4. Account deletion requests. An owner asks TideGrid to close and delete the
--    tenant's account, and may withdraw the request. Nothing is deleted here:
--    the runtime never holds DELETE, and deletion is an owner-run operation.
-- 5. Retention. Booker name and email on abandoned checkouts (expired,
--    failed, or canceled, with no booking and no successful payment) are
--    replaced with a fixed redaction after the retention period (D2, 30
--    days, also the floor here). A redacted checkout never becomes a booking:
--    a late payment success on one is refunded (reason session_redacted).
--
-- Rules unchanged: forced row-level security on every new table, no DELETE or
-- TRUNCATE for the runtime, credential and grant tables only through schema
-- app, every function with EXECUTE revoked from PUBLIC and search_path pinned.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'this migration must run as a role that bypasses row-level security';
  END IF;
END
$$;

-- Security events ------------------------------------------------------------------

ALTER TABLE public.security_events DROP CONSTRAINT security_events_kind_check;
ALTER TABLE public.security_events ADD CONSTRAINT security_events_kind_check CHECK (kind IN (
  'login_link_issued',
  'login_link_rate_limited',
  'login_link_unknown_email',
  'login_link_consumed',
  'login_link_rejected',
  'session_revoked',
  'staff_user_created',
  'sessions_revoked_on_disable',
  'invitation_accepted',
  'invitation_declined'
));

-- 1. Invitations -------------------------------------------------------------------

ALTER TABLE public.tenant_memberships
  ADD COLUMN invited_by uuid,
  ADD COLUMN invited_at timestamptz,
  ADD COLUMN invitation_expires_at timestamptz,
  ADD COLUMN accepted_at timestamptz;

-- Every membership that exists today was made active without an invitation;
-- it counts as accepted when it was created.
UPDATE public.tenant_memberships SET accepted_at = created_at WHERE accepted_at IS NULL;

ALTER TABLE public.tenant_memberships DROP CONSTRAINT tenant_memberships_status_check;
ALTER TABLE public.tenant_memberships
  ADD CONSTRAINT tenant_memberships_status_check
    CHECK (status IN ('invited', 'active', 'disabled')),
  ADD CONSTRAINT tenant_memberships_active_accepted
    CHECK (status <> 'active' OR accepted_at IS NOT NULL),
  ADD CONSTRAINT tenant_memberships_invited_pending
    CHECK (status <> 'invited'
           OR (accepted_at IS NULL AND invited_at IS NOT NULL
               AND invitation_expires_at IS NOT NULL
               AND invitation_expires_at > invited_at)),
  ADD CONSTRAINT tenant_memberships_invited_by_fkey
    FOREIGN KEY (tenant_id, invited_by)
    REFERENCES public.tenant_memberships (tenant_id, user_id);

-- The runtime's writes. A runtime insert is always an invitation, whatever it
-- names, stamped with its inviter from the transaction's actor. The runtime
-- never sets accepted_at, never makes an unaccepted membership active, and
-- re-invites only a person who never accepted. It can never leave a tenant
-- without an active owner. The owner role (seeds, and the definer functions
-- below) is held only to the constraints. Runs as the writer; reads only the
-- writer's own tenant's memberships, under row-level security.
CREATE FUNCTION app.check_tenant_membership() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_runtime boolean := current_user = 'tidegrid_app';
  v_type text := app.setting_or_null('app.actor_type');
  v_actor text := app.setting_or_null('app.actor_id');
  v_inviter uuid;
BEGIN
  IF v_type = 'staff'
     AND v_actor ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    v_inviter := v_actor::uuid;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF v_runtime THEN
      NEW.status := 'invited';
      NEW.accepted_at := NULL;
      NEW.invited_by := v_inviter;
      NEW.invited_at := clock_timestamp();
      NEW.invitation_expires_at := clock_timestamp() + interval '7 days';
    ELSIF NEW.status = 'active' AND NEW.accepted_at IS NULL THEN
      NEW.accepted_at := clock_timestamp();
    ELSIF NEW.status = 'invited' AND NEW.invited_at IS NULL THEN
      NEW.invited_at := clock_timestamp();
      NEW.invitation_expires_at := coalesce(NEW.invitation_expires_at,
                                            clock_timestamp() + interval '7 days');
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a membership keeps its tenant, person, and creation time'
      USING ERRCODE = '23514', CONSTRAINT = 'tenant_memberships_immutable';
  END IF;

  IF v_runtime THEN
    NEW.accepted_at := OLD.accepted_at;
    NEW.invited_by := OLD.invited_by;
    NEW.invited_at := OLD.invited_at;
    NEW.invitation_expires_at := OLD.invitation_expires_at;
    IF NEW.status = 'active' AND OLD.status <> 'active' AND OLD.accepted_at IS NULL THEN
      RAISE EXCEPTION 'only the invited person accepts an invitation'
        USING ERRCODE = '42501', CONSTRAINT = 'tenant_memberships_acceptance';
    END IF;
    IF NEW.status = 'invited' AND OLD.status <> 'invited' THEN
      IF OLD.accepted_at IS NOT NULL THEN
        RAISE EXCEPTION 'a person who accepted is enabled again, not invited again'
          USING ERRCODE = '23514', CONSTRAINT = 'tenant_memberships_reinvite';
      END IF;
      NEW.invited_by := v_inviter;
      NEW.invited_at := clock_timestamp();
      NEW.invitation_expires_at := clock_timestamp() + interval '7 days';
    END IF;
    -- The last active owner stays: serialized per tenant, so two owners
    -- disabling each other at once cannot both pass.
    IF OLD.role = 'owner' AND OLD.status = 'active'
       AND (NEW.role <> 'owner' OR NEW.status <> 'active') THEN
      PERFORM pg_advisory_xact_lock(hashtextextended('tidegrid.owners:' || OLD.tenant_id::text, 0));
      IF NOT EXISTS (
        SELECT 1 FROM public.tenant_memberships m
         WHERE m.tenant_id = OLD.tenant_id AND m.user_id <> OLD.user_id
           AND m.role = 'owner' AND m.status = 'active') THEN
        RAISE EXCEPTION 'a tenant keeps at least one active owner'
          USING ERRCODE = '23514', CONSTRAINT = 'tenant_memberships_last_owner';
      END IF;
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER tenant_memberships_rules
  BEFORE INSERT OR UPDATE ON public.tenant_memberships
  FOR EACH ROW EXECUTE FUNCTION app.check_tenant_membership();

-- Pending, unexpired invitations for one person, across tenants.
CREATE FUNCTION app.auth_list_invitations(p_user_id uuid)
  RETURNS TABLE (tenant_id uuid, tenant_slug text, tenant_name text, role text,
                 invited_at timestamptz, expires_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT t.id, t.slug, t.display_name, m.role, m.invited_at, m.invitation_expires_at
      FROM public.tenant_memberships m
      JOIN public.tenants t ON t.id = m.tenant_id
      JOIN public.staff_users u ON u.id = m.user_id
     WHERE m.user_id = p_user_id
       AND m.status = 'invited'
       AND m.invitation_expires_at > pg_catalog.now()
       AND t.status = 'active'
       AND u.status = 'active'
     ORDER BY t.display_name, t.id
  $$;

-- Accept or decline one's own invitation. Callable only inside a transaction
-- bound to that tenant whose actor is that person. Returns the new status, or
-- NULL when there is no pending, unexpired invitation for them there.
CREATE FUNCTION app.auth_respond_invitation(p_user_id uuid, p_accept boolean, p_request_id text)
  RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_tenant uuid := app.current_tenant_id();
  v_status text;
BEGIN
  IF v_tenant IS NULL
     OR app.setting_or_null('app.actor_type') IS DISTINCT FROM 'staff'
     OR app.setting_or_null('app.actor_id') IS DISTINCT FROM p_user_id::text THEN
    RAISE EXCEPTION 'an invitation is answered by the invited person in that tenant''s context'
      USING ERRCODE = '42501';
  END IF;
  IF p_accept IS NULL THEN
    RAISE EXCEPTION 'accept or decline' USING ERRCODE = '22023';
  END IF;

  UPDATE public.tenant_memberships m
     SET status = CASE WHEN p_accept THEN 'active' ELSE 'disabled' END,
         accepted_at = CASE WHEN p_accept THEN clock_timestamp() ELSE NULL END
   WHERE m.tenant_id = v_tenant
     AND m.user_id = p_user_id
     AND m.status = 'invited'
     AND m.invitation_expires_at > clock_timestamp()
     AND EXISTS (SELECT 1 FROM public.tenants t WHERE t.id = v_tenant AND t.status = 'active')
     AND EXISTS (SELECT 1 FROM public.staff_users u WHERE u.id = p_user_id AND u.status = 'active')
  RETURNING m.status INTO v_status;

  IF v_status IS NULL THEN
    RETURN NULL;
  END IF;
  INSERT INTO public.security_events (kind, user_id, request_id)
    VALUES (CASE WHEN p_accept THEN 'invitation_accepted' ELSE 'invitation_declined' END,
            p_user_id, p_request_id);
  RETURN v_status;
END;
$$;

-- 2. Disable revokes sessions -------------------------------------------------------

-- A trigger function, never called directly: the runtime holds no EXECUTE on
-- it. It revokes every open session of a person whose identity was just
-- disabled, or whose last active membership was. An invitation that is
-- withdrawn or declined revokes nothing, so a tenant cannot sign out a
-- stranger by inviting and disabling them. Re-enabling an identity revokes
-- again: a sign-in that raced the disable (app.auth_consume_login_token takes
-- no lock) left a session that resolved to nothing while disabled, and must
-- not come back to life. Disables of one person's memberships in different
-- tenants are serialized per person, so two at once cannot each see the
-- other as still active and both skip the revocation.
CREATE FUNCTION app.revoke_sessions_on_disable() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_user uuid;
  v_count integer;
BEGIN
  IF TG_TABLE_NAME = 'staff_users' THEN
    v_user := NEW.id;
  ELSE
    v_user := NEW.user_id;
    PERFORM pg_advisory_xact_lock(hashtextextended('tidegrid.disable:' || v_user::text, 0));
    -- Access to this tenant already ends with the membership: every request
    -- checks it. A person who still works for another operator stays signed
    -- in there; one with no active membership left is signed out.
    IF EXISTS (SELECT 1 FROM public.tenant_memberships m
                 JOIN public.tenants t ON t.id = m.tenant_id
                WHERE m.user_id = v_user AND m.status = 'active' AND t.status = 'active') THEN
      RETURN NULL;
    END IF;
  END IF;
  UPDATE public.staff_sessions s
     SET revoked_at = clock_timestamp()
   WHERE s.user_id = v_user AND s.revoked_at IS NULL AND s.expires_at > clock_timestamp();
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count > 0 THEN
    INSERT INTO public.security_events (kind, user_id, request_id)
      VALUES ('sessions_revoked_on_disable', v_user, app.setting_or_null('app.request_id'));
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER tenant_memberships_disable_revokes_sessions
  AFTER UPDATE OF status ON public.tenant_memberships
  FOR EACH ROW
  WHEN (OLD.status = 'active' AND NEW.status = 'disabled')
  EXECUTE FUNCTION app.revoke_sessions_on_disable();

CREATE TRIGGER staff_users_disable_revokes_sessions
  AFTER UPDATE OF status ON public.staff_users
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION app.revoke_sessions_on_disable();

-- 3. Support access ---------------------------------------------------------------

-- TideGrid's own support agents. Platform rows, written by the owner role
-- only (a runbook step); the runtime has no privileges at all.
CREATE TABLE public.support_agents (
  user_id uuid PRIMARY KEY REFERENCES public.staff_users (id),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.support_agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.support_agents FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.support_agents FROM tidegrid_app;
CREATE TRIGGER support_agents_no_delete
  BEFORE DELETE ON public.support_agents
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();
CREATE TRIGGER support_agents_no_truncate
  BEFORE TRUNCATE ON public.support_agents
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_mutation();

-- One owner-issued grant: one agent, one tenant, a reason, at most four hours,
-- masked unless the owner chose to reveal personal data. The tenant policy is
-- defense in depth: the runtime holds no privileges on the table, so it
-- reaches grants only through the functions below.
CREATE TABLE public.support_access_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants (id),
  agent_user_id uuid NOT NULL REFERENCES public.support_agents (user_id),
  granted_by uuid NOT NULL,
  reason text NOT NULL
    CHECK (char_length(reason) BETWEEN 1 AND 500 AND reason !~ '[[:cntrl:]]'),
  reveal_personal_data boolean NOT NULL DEFAULT false,
  granted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_by uuid,
  request_id text,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, granted_by) REFERENCES public.tenant_memberships (tenant_id, user_id),
  FOREIGN KEY (tenant_id, revoked_by) REFERENCES public.tenant_memberships (tenant_id, user_id),
  CONSTRAINT support_access_grants_window
    CHECK (expires_at > granted_at AND expires_at <= granted_at + interval '4 hours'),
  CONSTRAINT support_access_grants_revocation
    CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);
CREATE INDEX support_access_grants_lookup_idx
  ON public.support_access_grants (tenant_id, agent_user_id, expires_at DESC);

ALTER TABLE public.support_access_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.support_access_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.support_access_grants
  USING (tenant_id = (SELECT app.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()));
REVOKE ALL ON public.support_access_grants FROM tidegrid_app;

-- A grant is revoked once and otherwise never changes, for every role.
CREATE FUNCTION app.check_support_access_grant() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['revoked_at', 'revoked_by'])
       IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['revoked_at', 'revoked_by'])
     OR OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'a support grant is revoked once and otherwise never changes'
      USING ERRCODE = '23514', CONSTRAINT = 'support_access_grants_immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER support_access_grants_rules
  BEFORE UPDATE ON public.support_access_grants
  FOR EACH ROW EXECUTE FUNCTION app.check_support_access_grant();
CREATE TRIGGER support_access_grants_no_delete
  BEFORE DELETE ON public.support_access_grants
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();
CREATE TRIGGER support_access_grants_no_truncate
  BEFORE TRUNCATE ON public.support_access_grants
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_mutation();

-- The transaction's actor, when it is an active owner of the transaction's
-- active tenant; NULL otherwise. Every grant function below requires it.
CREATE FUNCTION app.support_grant_owner() RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT m.user_id
      FROM public.tenant_memberships m
      JOIN public.tenants t ON t.id = m.tenant_id
      JOIN public.staff_users u ON u.id = m.user_id
     WHERE m.tenant_id = app.current_tenant_id()
       AND app.setting_or_null('app.actor_type') = 'staff'
       AND m.user_id::text = app.setting_or_null('app.actor_id')
       AND m.role = 'owner' AND m.status = 'active'
       AND t.status = 'active' AND u.status = 'active'
  $$;

-- Issue a grant. Returns no row when the address is not an active support
-- agent. Raises 23505 (support_access_grants_one_active) when that agent
-- already holds an open grant here, and 42501 when the actor is not an
-- active owner of the transaction's tenant.
CREATE FUNCTION app.support_grant_issue(
    p_agent_email text, p_reason text, p_minutes integer, p_reveal boolean, p_request_id text)
  RETURNS TABLE (grant_id uuid, agent_user_id uuid, granted_at timestamptz, expires_at timestamptz)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
#variable_conflict use_column
DECLARE
  v_owner uuid := app.support_grant_owner();
  v_tenant uuid := app.current_tenant_id();
  v_agent uuid;
  v_row public.support_access_grants;
  v_now timestamptz;
BEGIN
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'only an active owner grants support access' USING ERRCODE = '42501';
  END IF;
  IF p_minutes IS NULL OR p_minutes < 15 OR p_minutes > 240 THEN
    RAISE EXCEPTION 'a support grant lasts 15 to 240 minutes' USING ERRCODE = '22023';
  END IF;
  SELECT a.user_id INTO v_agent
    FROM public.support_agents a
    JOIN public.staff_users u ON u.id = a.user_id
   WHERE btrim(p_agent_email) ~ '^[\x21-\x7e]+$'
     AND u.email = lower(btrim(p_agent_email))
     AND u.status = 'active' AND a.status = 'active';
  IF v_agent IS NULL THEN
    RETURN;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('tidegrid.support:' || v_tenant::text || ':' || v_agent::text, 0));
  -- One instant for the check, the start, and the end, so a 240-minute grant
  -- is exactly four hours.
  v_now := clock_timestamp();
  IF EXISTS (SELECT 1 FROM public.support_access_grants g
              WHERE g.tenant_id = v_tenant AND g.agent_user_id = v_agent
                AND g.revoked_at IS NULL AND g.expires_at > v_now) THEN
    RAISE EXCEPTION 'that agent already holds an open grant here'
      USING ERRCODE = '23505', CONSTRAINT = 'support_access_grants_one_active';
  END IF;

  INSERT INTO public.support_access_grants
      (tenant_id, agent_user_id, granted_by, reason, reveal_personal_data,
       granted_at, expires_at, request_id)
    VALUES (v_tenant, v_agent, v_owner, p_reason, coalesce(p_reveal, false),
            v_now, v_now + make_interval(mins => p_minutes), p_request_id)
    RETURNING * INTO v_row;
  grant_id := v_row.id;
  agent_user_id := v_row.agent_user_id;
  granted_at := v_row.granted_at;
  expires_at := v_row.expires_at;
  RETURN NEXT;
END;
$$;

-- Revoke an open grant of the transaction's tenant. Returns false when there
-- is no such open grant.
CREATE FUNCTION app.support_grant_revoke(p_grant_id uuid)
  RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_owner uuid := app.support_grant_owner();
  v_id uuid;
BEGIN
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'only an active owner revokes support access' USING ERRCODE = '42501';
  END IF;
  UPDATE public.support_access_grants g
     SET revoked_at = clock_timestamp(), revoked_by = v_owner
   WHERE g.tenant_id = app.current_tenant_id() AND g.id = p_grant_id
     AND g.revoked_at IS NULL AND g.expires_at > clock_timestamp()
  RETURNING g.id INTO v_id;
  RETURN v_id IS NOT NULL;
END;
$$;

-- The transaction's tenant's grants, newest first, for its owners.
CREATE FUNCTION app.support_grant_list(p_limit integer, p_grant_id uuid DEFAULT NULL)
  RETURNS TABLE (grant_id uuid, agent_email text, reason text, reveal_personal_data boolean,
                 granted_by uuid, granted_at timestamptz, expires_at timestamptz,
                 revoked_at timestamptz, revoked_by uuid)
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF app.support_grant_owner() IS NULL THEN
    RAISE EXCEPTION 'only an active owner lists support access' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT g.id, u.email, g.reason, g.reveal_personal_data, g.granted_by, g.granted_at,
           g.expires_at, g.revoked_at, g.revoked_by
      FROM public.support_access_grants g
      JOIN public.staff_users u ON u.id = g.agent_user_id
     WHERE g.tenant_id = app.current_tenant_id()
       AND (p_grant_id IS NULL OR g.id = p_grant_id)
     ORDER BY g.granted_at DESC, g.id
     LIMIT greatest(1, least(coalesce(p_limit, 50), 200));
END;
$$;

-- The open grant, if any, that lets the transaction's actor, an active
-- support agent, into the transaction's active tenant right now.
CREATE FUNCTION app.support_grant_active(p_user_id uuid)
  RETURNS TABLE (grant_id uuid, reveal_personal_data boolean, expires_at timestamptz, reason text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT g.id, g.reveal_personal_data, g.expires_at, g.reason
      FROM public.support_access_grants g
      JOIN public.support_agents a ON a.user_id = g.agent_user_id
      JOIN public.staff_users u ON u.id = g.agent_user_id
      JOIN public.tenants t ON t.id = g.tenant_id
     WHERE g.tenant_id = app.current_tenant_id()
       AND g.agent_user_id = p_user_id
       AND p_user_id::text = app.setting_or_null('app.actor_id')
       AND g.revoked_at IS NULL
       AND g.granted_at <= clock_timestamp()
       AND g.expires_at > clock_timestamp()
       AND a.status = 'active' AND u.status = 'active' AND t.status = 'active'
     ORDER BY g.expires_at DESC
     LIMIT 1
  $$;

-- 4. Account deletion requests ----------------------------------------------------

CREATE TABLE public.tenant_deletion_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  state text NOT NULL DEFAULT 'requested' CHECK (state IN ('requested', 'withdrawn')),
  reason text NOT NULL
    CHECK (char_length(reason) BETWEEN 1 AND 500 AND reason !~ '[[:cntrl:]]'),
  requested_by uuid NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  request_id text,
  withdrawn_by uuid,
  withdrawn_at timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, requested_by) REFERENCES public.tenant_memberships (tenant_id, user_id),
  FOREIGN KEY (tenant_id, withdrawn_by) REFERENCES public.tenant_memberships (tenant_id, user_id),
  CONSTRAINT tenant_deletion_requests_withdrawal
    CHECK ((state = 'withdrawn') = (withdrawn_at IS NOT NULL AND withdrawn_by IS NOT NULL))
);
-- At most one open request per tenant. A small table, not a pilot-volume one.
CREATE UNIQUE INDEX tenant_deletion_requests_one_open
  ON public.tenant_deletion_requests (tenant_id) WHERE state = 'requested';

ALTER TABLE public.tenant_deletion_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_deletion_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.tenant_deletion_requests
  USING (tenant_id = (SELECT app.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()));
GRANT UPDATE (state) ON public.tenant_deletion_requests TO tidegrid_app;

-- The requester and the withdrawer come from the transaction's actor, which
-- must be staff with a UUID id; the request id and the times from the
-- transaction. A request is withdrawn once and otherwise never changes.
CREATE FUNCTION app.stamp_tenant_deletion_request() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_type text := app.setting_or_null('app.actor_type');
  v_actor text := app.setting_or_null('app.actor_id');
BEGIN
  IF v_type IS DISTINCT FROM 'staff'
     OR v_actor IS NULL
     OR v_actor !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'a deletion request is made or withdrawn by staff'
      USING ERRCODE = '42501', CONSTRAINT = 'tenant_deletion_requests_staff_author';
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.state := 'requested';
    NEW.requested_by := v_actor::uuid;
    NEW.requested_at := clock_timestamp();
    NEW.request_id := app.setting_or_null('app.request_id');
    NEW.withdrawn_by := NULL;
    NEW.withdrawn_at := NULL;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['state', 'withdrawn_by', 'withdrawn_at'])
       IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['state', 'withdrawn_by', 'withdrawn_at'])
     OR OLD.state <> 'requested' OR NEW.state <> 'withdrawn' THEN
    RAISE EXCEPTION 'a deletion request is withdrawn once and otherwise never changes'
      USING ERRCODE = '23514', CONSTRAINT = 'tenant_deletion_requests_immutable';
  END IF;
  NEW.withdrawn_by := v_actor::uuid;
  NEW.withdrawn_at := clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER tenant_deletion_requests_stamp
  BEFORE INSERT OR UPDATE ON public.tenant_deletion_requests
  FOR EACH ROW EXECUTE FUNCTION app.stamp_tenant_deletion_request();
CREATE TRIGGER tenant_deletion_requests_no_delete
  BEFORE DELETE ON public.tenant_deletion_requests
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();
CREATE TRIGGER tenant_deletion_requests_no_truncate
  BEFORE TRUNCATE ON public.tenant_deletion_requests
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_mutation();

-- 5. Retention of abandoned checkouts --------------------------------------------

-- A late success on a redacted checkout is refunded under its own reason.
ALTER TABLE public.finalization_exceptions DROP CONSTRAINT finalization_exceptions_reason_check;
ALTER TABLE public.finalization_exceptions ADD CONSTRAINT finalization_exceptions_reason_check
  CHECK (reason IN (
    'no_capacity', 'trip_canceled', 'trip_unavailable', 'sales_closed',
    'party_size_out_of_range', 'session_failed', 'session_canceled', 'payment_mismatch',
    'session_redacted'
  ));

ALTER TABLE public.checkout_sessions ADD COLUMN booker_redacted_at timestamptz;
ALTER TABLE public.checkout_sessions
  ADD CONSTRAINT checkout_sessions_booker_redacted
    CHECK (booker_redacted_at IS NULL
           OR (booker_name = 'Redacted' AND booker_email = 'redacted@redacted.invalid'));

-- The checkout rules (0007) keep the booker fixed. Split their trigger so that
-- one update shape skips them: the redaction, which the trigger below checks
-- on its own, for every role.
DROP TRIGGER checkout_sessions_rules ON public.checkout_sessions;
CREATE TRIGGER checkout_sessions_rules
  BEFORE INSERT ON public.checkout_sessions
  FOR EACH ROW EXECUTE FUNCTION app.check_checkout_session();
CREATE TRIGGER checkout_sessions_rules_update
  BEFORE UPDATE ON public.checkout_sessions
  FOR EACH ROW
  WHEN (NOT (OLD.booker_redacted_at IS NULL AND NEW.booker_redacted_at IS NOT NULL))
  EXECUTE FUNCTION app.check_checkout_session();

-- A redaction changes the booker to the fixed values and stamps the time, and
-- nothing else. Only an abandoned checkout qualifies: expired, failed, or
-- canceled at least 30 days ago, with no booking, no successful payment, and
-- no provider event waiting. A redacted checkout never becomes confirmed: a
-- late success on its pending payment is refunded (finalize.ts, reason
-- session_redacted), never booked under a redacted booker. Once set, the
-- stamp never changes. An insert is never redacted.
CREATE FUNCTION app.check_checkout_redaction() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.booker_redacted_at := NULL;
    RETURN NEW;
  END IF;
  IF OLD.booker_redacted_at IS NOT NULL THEN
    IF NEW.booker_redacted_at IS DISTINCT FROM OLD.booker_redacted_at THEN
      RAISE EXCEPTION 'a redaction is permanent'
        USING ERRCODE = '23514', CONSTRAINT = 'checkout_sessions_redaction';
    END IF;
    IF NEW.state = 'confirmed' THEN
      RAISE EXCEPTION 'a redacted checkout never becomes a booking'
        USING ERRCODE = '23514', CONSTRAINT = 'checkout_sessions_redaction';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.booker_redacted_at IS NULL THEN
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['booker_name', 'booker_email', 'booker_redacted_at', 'updated_at'])
       IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['booker_name', 'booker_email', 'booker_redacted_at', 'updated_at'])
     OR NEW.booker_name <> 'Redacted'
     OR NEW.booker_email <> 'redacted@redacted.invalid'
     OR OLD.state NOT IN ('expired', 'failed', 'canceled')
     OR coalesce(OLD.expired_at, OLD.failed_at, OLD.canceled_at) > now() - interval '30 days'
     OR EXISTS (SELECT 1 FROM public.bookings b
                 WHERE b.tenant_id = OLD.tenant_id AND b.checkout_session_id = OLD.id)
     OR EXISTS (SELECT 1 FROM public.payments p
                 WHERE p.tenant_id = OLD.tenant_id AND p.checkout_session_id = OLD.id
                   AND p.state = 'succeeded')
     OR EXISTS (SELECT 1 FROM public.provider_events e
                 WHERE e.tenant_id = OLD.tenant_id AND e.processing_state = 'received'
                   AND e.payment_ref IN (SELECT p.provider_payment_id FROM public.payments p
                                          WHERE p.tenant_id = OLD.tenant_id
                                            AND p.checkout_session_id = OLD.id)) THEN
    RAISE EXCEPTION 'only an abandoned checkout''s booker is redacted, and only the booker'
      USING ERRCODE = '23514', CONSTRAINT = 'checkout_sessions_redaction';
  END IF;
  NEW.booker_redacted_at := now();
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER checkout_sessions_redaction
  BEFORE INSERT OR UPDATE ON public.checkout_sessions
  FOR EACH ROW EXECUTE FUNCTION app.check_checkout_redaction();

-- And no booking is ever written for a redacted checkout, by any writer, not
-- only through the checkout's state: the checkout row is share-locked first,
-- so a redaction and a booking insert of the same checkout are serialized,
-- and whichever commits second sees the other.
CREATE FUNCTION app.check_booking_not_redacted() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF NEW.checkout_session_id IS NULL THEN
    RETURN NEW;
  END IF;
  PERFORM 1 FROM public.checkout_sessions s
    WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.checkout_session_id
      FOR SHARE;
  IF EXISTS (SELECT 1 FROM public.checkout_sessions s
              WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.checkout_session_id
                AND s.booker_redacted_at IS NOT NULL) THEN
    RAISE EXCEPTION 'a redacted checkout never becomes a booking'
      USING ERRCODE = '23514', CONSTRAINT = 'checkout_sessions_redaction';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER bookings_checkout_not_redacted
  BEFORE INSERT ON public.bookings
  FOR EACH ROW EXECUTE FUNCTION app.check_booking_not_redacted();

-- The cron's retention job: redact up to p_limit abandoned checkouts, across
-- tenants, whose end is at least p_days old, and record one audit event per
-- tenant touched. Returns the count per tenant.
CREATE FUNCTION app.retention_redact_abandoned_checkouts(p_days integer, p_limit integer)
  RETURNS TABLE (tenant_id uuid, redacted integer)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
#variable_conflict use_column
BEGIN
  IF p_days IS NULL OR p_days < 30 OR p_days > 3650 THEN
    RAISE EXCEPTION 'retention is 30 to 3650 days' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    WITH due AS (
      SELECT s.tenant_id, s.id
        FROM public.checkout_sessions s
       WHERE s.booker_redacted_at IS NULL
         AND s.state IN ('expired', 'failed', 'canceled')
         AND coalesce(s.expired_at, s.failed_at, s.canceled_at)
               <= pg_catalog.now() - pg_catalog.make_interval(days => p_days)
         AND NOT EXISTS (SELECT 1 FROM public.bookings b
                          WHERE b.tenant_id = s.tenant_id AND b.checkout_session_id = s.id)
         AND NOT EXISTS (SELECT 1 FROM public.payments p
                          WHERE p.tenant_id = s.tenant_id AND p.checkout_session_id = s.id
                            AND p.state = 'succeeded')
         AND NOT EXISTS (SELECT 1 FROM public.provider_events e
                          JOIN public.payments p
                            ON p.tenant_id = e.tenant_id AND p.provider_payment_id = e.payment_ref
                          WHERE e.tenant_id = s.tenant_id AND e.processing_state = 'received'
                            AND p.checkout_session_id = s.id)
       ORDER BY s.tenant_id, s.id
       LIMIT greatest(1, least(coalesce(p_limit, 500), 5000))
       FOR UPDATE OF s SKIP LOCKED
    ), done AS (
      UPDATE public.checkout_sessions s
         SET booker_name = 'Redacted',
             booker_email = 'redacted@redacted.invalid',
             booker_redacted_at = pg_catalog.now()
        FROM due
       WHERE s.tenant_id = due.tenant_id AND s.id = due.id
      RETURNING s.tenant_id
    ), counts AS (
      SELECT d.tenant_id, count(*)::integer AS n FROM done d GROUP BY d.tenant_id
    ), audited AS (
      INSERT INTO public.audit_events
          (tenant_id, actor_type, actor_id, action, subject_type, subject_id, after_state)
        SELECT c.tenant_id, 'system', 'retention', 'retention.checkout_bookers_redacted',
               'tenant', c.tenant_id::text,
               pg_catalog.jsonb_build_object('count', c.n, 'olderThanDays', p_days)
          FROM counts c
      RETURNING 1
    )
    -- A data-modifying WITH runs once whether or not it is read.
    SELECT c.tenant_id, c.n FROM counts c ORDER BY c.tenant_id;
END;
$$;

-- Grants ----------------------------------------------------------------------------

REVOKE ALL ON FUNCTION app.check_tenant_membership() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.auth_list_invitations(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.auth_respond_invitation(uuid, boolean, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.revoke_sessions_on_disable() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.check_support_access_grant() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.support_grant_owner() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.support_grant_issue(text, text, integer, boolean, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.support_grant_revoke(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.support_grant_list(integer, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.support_grant_active(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.stamp_tenant_deletion_request() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.check_checkout_redaction() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.check_booking_not_redacted() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.retention_redact_abandoned_checkouts(integer, integer) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app.auth_list_invitations(uuid) TO tidegrid_app;
GRANT EXECUTE ON FUNCTION app.auth_respond_invitation(uuid, boolean, text) TO tidegrid_app;
GRANT EXECUTE ON FUNCTION app.support_grant_issue(text, text, integer, boolean, text) TO tidegrid_app;
GRANT EXECUTE ON FUNCTION app.support_grant_revoke(uuid) TO tidegrid_app;
GRANT EXECUTE ON FUNCTION app.support_grant_list(integer, uuid) TO tidegrid_app;
GRANT EXECUTE ON FUNCTION app.support_grant_active(uuid) TO tidegrid_app;
GRANT EXECUTE ON FUNCTION app.retention_redact_abandoned_checkouts(integer, integer) TO tidegrid_app;
