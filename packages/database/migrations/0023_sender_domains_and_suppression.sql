-- 0023 per-operator sender domains and per-operator suppression (W3-G2.16-rest)
--
-- Pulled forward as code only by the owner on 2026-11-08
-- (docs/v2/06-decision-register.md, "Code-only pilot pieces now"). Nothing
-- here sends mail, changes DNS, or onboards a domain with the provider.
--
-- Sender domains, public.tenant_sender_domains. Until now every operator sent
-- from one TideGrid address, so one operator's bounce or spam complaint made
-- the provider refuse another operator's mail to the same guest (the
-- provider suppresses per account or sending domain). Each operator may now
-- have one sending domain of its own. A row starts 'pending'; delivery uses
-- it only once it is 'verified', and 'retired' is final. Tenant-owned under
-- packages/database/README.md rules 1 to 10, but the runtime may only read
-- it: INSERT is revoked from 0001's default, and no UPDATE is granted. Only
-- the admin connection adds, verifies, or retires a domain, through
-- app.sender_domain_add, app.sender_domain_verify, and app.sender_domain_retire
-- (definer functions with no EXECUTE for the runtime), each writing an audit
-- row. So a writer holding tidegrid_app's credentials can never make mail go
-- out from a domain nobody checked. Verification records the evidence the
-- admin gives (what the provider showed for SPF, DKIM, and DMARC); the
-- database cannot check DNS itself.
--
-- One live domain per operator and one operator per live domain: two partial
-- unique keys over rows that are not retired. A domain that names TideGrid
-- (a 'tidegrid' label before the top-level one) or carries an IDNA label is
-- refused, as the brand rules refuse such contact addresses.
--
-- app.email_sender_domain_known(domain) answers whether any operator's
-- domain with that name was ever verified, and nothing else. The events
-- consumer uses it for an event whose message id joins nothing, so it can
-- refuse events from a domain TideGrid never sent from without learning
-- which operator owns it.
--
-- Suppression, public.email_suppressions. A hard bounce or a spam complaint
-- the provider reports now stops that operator's later mail to the address,
-- and only that operator's. Tenant-owned: forced row-level security with
-- tenant_isolation, the default SELECT and INSERT from 0001, and no UPDATE
-- or DELETE for the runtime. Each row names the event that caused it (a
-- composite foreign key to the tenant's own email_events row). The check
-- trigger app.check_email_suppression() (an invoker function) refuses a row
-- unless that event is a complaint or a hard bounce and the address is the
-- one its message was sent to, so the runtime cannot suppress an address the
-- provider never reported. One active row per operator and address. The
-- admin lifts one through app.email_suppression_lift, with a reason and an
-- audit row; a lifted row stays, and a later event adds a new one. The
-- row keeps the address because delivery must match on it; the audit row
-- names only the suppression's id.
--
-- Nothing changes on email_messages, so 0009's delivery rules, 0014's
-- limits, 0017's claims, and 0021's events are untouched.

DO $$
BEGIN
  IF NOT (SELECT rolbypassrls OR rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION '0023 runs as the migration role, which bypasses row-level security';
  END IF;
END;
$$;

-- Sender domains -------------------------------------------------------------------

CREATE TABLE public.tenant_sender_domains (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  -- Lowercase letters, digits, and hyphens in two or more labels; no
  -- trailing dot. A 'tidegrid' label before the last one, or an IDNA label,
  -- is refused.
  domain text NOT NULL
    CHECK (char_length(domain) BETWEEN 4 AND 253
           AND domain ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'
           AND domain !~ '(^|\.)tidegrid\.'
           AND domain !~ '(^|\.)xn--'),
  -- The mailbox mail is sent from, such as 'bookings'.
  local_part text NOT NULL DEFAULT 'bookings'
    CHECK (local_part ~ '^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$' AND local_part !~ '\.\.'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'retired')),
  verified_at timestamptz,
  retired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id),
  CONSTRAINT tenant_sender_domains_verified CHECK (status <> 'verified' OR verified_at IS NOT NULL),
  CONSTRAINT tenant_sender_domains_retired CHECK ((status = 'retired') = (retired_at IS NOT NULL))
);
CREATE UNIQUE INDEX tenant_sender_domains_one_live ON public.tenant_sender_domains (tenant_id)
  WHERE status <> 'retired';
CREATE UNIQUE INDEX tenant_sender_domains_domain_live ON public.tenant_sender_domains (domain)
  WHERE status <> 'retired';
CREATE INDEX tenant_sender_domains_domain_idx ON public.tenant_sender_domains (domain);

ALTER TABLE public.tenant_sender_domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_sender_domains FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.tenant_sender_domains
  USING (tenant_id = (SELECT app.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()));
-- Read only for the runtime: 0001's default INSERT is taken back.
REVOKE INSERT ON public.tenant_sender_domains FROM tidegrid_app;

-- Only the status moves, one way: pending to verified or retired, verified
-- to retired. The times come from the clock. Nothing else changes.
CREATE FUNCTION app.check_sender_domain_update() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a sender domain is retired, never deleted'
      USING ERRCODE = '23514', CONSTRAINT = 'tenant_sender_domains_transition';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.domain IS DISTINCT FROM OLD.domain OR NEW.local_part IS DISTINCT FROM OLD.local_part
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a sender domain''s tenant, domain, and mailbox never change'
      USING ERRCODE = '23514', CONSTRAINT = 'tenant_sender_domains_immutable';
  END IF;
  IF NOT ((OLD.status = 'pending' AND NEW.status IN ('verified', 'retired'))
          OR (OLD.status = 'verified' AND NEW.status = 'retired')) THEN
    RAISE EXCEPTION 'a sender domain moves from pending to verified or retired, or from verified to retired'
      USING ERRCODE = '23514', CONSTRAINT = 'tenant_sender_domains_transition';
  END IF;
  NEW.verified_at := CASE WHEN NEW.status = 'verified' THEN clock_timestamp() ELSE OLD.verified_at END;
  NEW.retired_at := CASE WHEN NEW.status = 'retired' THEN clock_timestamp() ELSE NULL END;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE FUNCTION app.check_sender_domain_insert() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF NEW.status <> 'pending' OR NEW.verified_at IS NOT NULL OR NEW.retired_at IS NOT NULL THEN
    RAISE EXCEPTION 'a sender domain starts pending'
      USING ERRCODE = '23514', CONSTRAINT = 'tenant_sender_domains_transition';
  END IF;
  NEW.created_at := clock_timestamp();
  NEW.updated_at := NEW.created_at;
  RETURN NEW;
END;
$$;

CREATE TRIGGER tenant_sender_domains_insert
  BEFORE INSERT ON public.tenant_sender_domains
  FOR EACH ROW EXECUTE FUNCTION app.check_sender_domain_insert();
CREATE TRIGGER tenant_sender_domains_update
  BEFORE UPDATE OR DELETE ON public.tenant_sender_domains
  FOR EACH ROW EXECUTE FUNCTION app.check_sender_domain_update();
CREATE TRIGGER tenant_sender_domains_no_truncate
  BEFORE TRUNCATE ON public.tenant_sender_domains
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_mutation();

-- Adds a pending domain for a tenant. The admin connection only.
CREATE FUNCTION app.sender_domain_add(p_tenant_id uuid, p_domain text, p_local_part text)
  RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO public.tenant_sender_domains (tenant_id, domain, local_part)
  VALUES (p_tenant_id, p_domain, coalesce(p_local_part, 'bookings'))
  RETURNING id INTO v_id;
  INSERT INTO public.audit_events
    (tenant_id, action, subject_type, subject_id, after_state)
  VALUES (p_tenant_id, 'email.sender_domain_added', 'tenant_sender_domain', v_id::text,
          pg_catalog.jsonb_build_object('domain', p_domain, 'status', 'pending'));
  RETURN v_id;
END;
$$;

-- Marks a tenant's pending domain verified, with the admin's evidence (what
-- the provider showed for SPF, DKIM, and DMARC). Answers false when it was
-- already verified.
CREATE FUNCTION app.sender_domain_verify(p_tenant_id uuid, p_domain text, p_evidence text)
  RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_id uuid;
  v_status text;
BEGIN
  IF p_evidence IS NULL OR char_length(btrim(p_evidence)) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'give the verification evidence in 1 to 500 characters'
      USING ERRCODE = '23514', CONSTRAINT = 'tenant_sender_domains_evidence';
  END IF;
  SELECT d.id, d.status INTO v_id, v_status
    FROM public.tenant_sender_domains d
   WHERE d.tenant_id = p_tenant_id AND d.domain = p_domain AND d.status <> 'retired'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such live sender domain for this tenant'
      USING ERRCODE = '23503', CONSTRAINT = 'tenant_sender_domains_tenant_domain';
  END IF;
  IF v_status = 'verified' THEN
    RETURN false;
  END IF;
  UPDATE public.tenant_sender_domains SET status = 'verified'
   WHERE tenant_id = p_tenant_id AND id = v_id;
  INSERT INTO public.audit_events
    (tenant_id, action, subject_type, subject_id, reason, before_state, after_state)
  VALUES (p_tenant_id, 'email.sender_domain_verified', 'tenant_sender_domain', v_id::text,
          btrim(p_evidence),
          pg_catalog.jsonb_build_object('domain', p_domain, 'status', v_status),
          pg_catalog.jsonb_build_object('domain', p_domain, 'status', 'verified'));
  RETURN true;
END;
$$;

-- Retires a tenant's live domain, with a reason. Mail goes back to the
-- shared sender, or waits where the deployment requires an operator domain.
-- Answers false when the tenant has no live domain of that name.
CREATE FUNCTION app.sender_domain_retire(p_tenant_id uuid, p_domain text, p_reason text)
  RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_id uuid;
  v_status text;
BEGIN
  IF p_reason IS NULL OR char_length(btrim(p_reason)) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'give a reason of 1 to 500 characters'
      USING ERRCODE = '23514', CONSTRAINT = 'tenant_sender_domains_reason';
  END IF;
  SELECT d.id, d.status INTO v_id, v_status
    FROM public.tenant_sender_domains d
   WHERE d.tenant_id = p_tenant_id AND d.domain = p_domain AND d.status <> 'retired'
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  UPDATE public.tenant_sender_domains SET status = 'retired'
   WHERE tenant_id = p_tenant_id AND id = v_id;
  INSERT INTO public.audit_events
    (tenant_id, action, subject_type, subject_id, reason, before_state, after_state)
  VALUES (p_tenant_id, 'email.sender_domain_retired', 'tenant_sender_domain', v_id::text,
          btrim(p_reason),
          pg_catalog.jsonb_build_object('domain', p_domain, 'status', v_status),
          pg_catalog.jsonb_build_object('domain', p_domain, 'status', 'retired'));
  RETURN true;
END;
$$;

-- Whether any operator's domain of this name was ever verified. Filters
-- explicitly, since its owner bypasses row-level security; answers nothing
-- about which operator.
CREATE FUNCTION app.email_sender_domain_known(p_domain text)
  RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT EXISTS (
      SELECT 1 FROM public.tenant_sender_domains d
       WHERE d.domain = p_domain AND d.verified_at IS NOT NULL)
  $$;

-- Suppression ----------------------------------------------------------------------

CREATE TABLE public.email_suppressions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  -- The address as email_messages.to_email stores it.
  address text NOT NULL
    CHECK (char_length(address) <= 254
           AND address = lower(address)
           AND address ~ '^[\x21-\x7e]+$'
           AND address ~ '^[^@]+@[^@]+\.[^@]+$'),
  reason text NOT NULL CHECK (reason IN ('hard_bounce', 'complaint')),
  -- The event that caused it.
  event_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lifted_at timestamptz,
  lift_reason text CHECK (lift_reason IS NULL OR char_length(lift_reason) BETWEEN 1 AND 500),
  UNIQUE (tenant_id, id),
  CONSTRAINT email_suppressions_lifted CHECK ((lifted_at IS NULL) = (lift_reason IS NULL)),
  FOREIGN KEY (tenant_id, event_id) REFERENCES public.email_events (tenant_id, id)
);
CREATE UNIQUE INDEX email_suppressions_active ON public.email_suppressions (tenant_id, address)
  WHERE lifted_at IS NULL;

ALTER TABLE public.email_suppressions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_suppressions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.email_suppressions
  USING (tenant_id = (SELECT app.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()));

-- A suppression names its tenant's own complaint or hard bounce, and the
-- address that event's message went to. Runs as the writer, under its
-- row-level security.
CREATE FUNCTION app.check_email_suppression() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  e record;
BEGIN
  SELECT ev.event_type, ev.bounce_type, m.to_email INTO e
    FROM public.email_events ev
    JOIN public.email_messages m ON m.tenant_id = ev.tenant_id AND m.id = ev.message_id
   WHERE ev.tenant_id = NEW.tenant_id AND ev.id = NEW.event_id;
  IF NOT FOUND
     OR NOT ((e.event_type = 'complained' AND NEW.reason = 'complaint')
             OR (e.event_type = 'bounced' AND e.bounce_type = 'hard' AND NEW.reason = 'hard_bounce'))
     OR e.to_email IS DISTINCT FROM NEW.address THEN
    RAISE EXCEPTION 'a suppression names its tenant''s complaint or hard bounce and that message''s address'
      USING ERRCODE = '23514', CONSTRAINT = 'email_suppressions_event';
  END IF;
  IF NEW.lifted_at IS NOT NULL THEN
    RAISE EXCEPTION 'a suppression starts active'
      USING ERRCODE = '23514', CONSTRAINT = 'email_suppressions_lift';
  END IF;
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END;
$$;

-- Only a lift changes a row, once: lifted_at from the clock, with a reason.
CREATE FUNCTION app.check_email_suppression_update() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF OLD.lifted_at IS NOT NULL OR NEW.lift_reason IS NULL
     OR NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.address IS DISTINCT FROM OLD.address OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.event_id IS DISTINCT FROM OLD.event_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a suppression is only lifted, once, with a reason'
      USING ERRCODE = '23514', CONSTRAINT = 'email_suppressions_lift';
  END IF;
  NEW.lifted_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER email_suppressions_check
  BEFORE INSERT ON public.email_suppressions
  FOR EACH ROW EXECUTE FUNCTION app.check_email_suppression();
CREATE TRIGGER email_suppressions_update
  BEFORE UPDATE ON public.email_suppressions
  FOR EACH ROW EXECUTE FUNCTION app.check_email_suppression_update();
CREATE TRIGGER email_suppressions_no_truncate
  BEFORE TRUNCATE ON public.email_suppressions
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_mutation();

-- Lifts a tenant's active suppression of an address, with a reason. The
-- admin connection only. Answers false when none is active.
CREATE FUNCTION app.email_suppression_lift(p_tenant_id uuid, p_address text, p_reason text)
  RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_id uuid;
  v_reason text;
BEGIN
  IF p_reason IS NULL OR char_length(btrim(p_reason)) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'give a reason of 1 to 500 characters'
      USING ERRCODE = '23514', CONSTRAINT = 'email_suppressions_lift';
  END IF;
  SELECT s.id, s.reason INTO v_id, v_reason
    FROM public.email_suppressions s
   WHERE s.tenant_id = p_tenant_id AND s.address = lower(btrim(p_address)) AND s.lifted_at IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  UPDATE public.email_suppressions SET lift_reason = btrim(p_reason)
   WHERE tenant_id = p_tenant_id AND id = v_id;
  -- The audit row names the suppression, never the address.
  INSERT INTO public.audit_events
    (tenant_id, action, subject_type, subject_id, reason, before_state, after_state)
  VALUES (p_tenant_id, 'email.suppression_lifted', 'email_suppression', v_id::text,
          btrim(p_reason),
          pg_catalog.jsonb_build_object('reason', v_reason, 'active', true),
          pg_catalog.jsonb_build_object('reason', v_reason, 'active', false));
  RETURN true;
END;
$$;

-- Privileges -----------------------------------------------------------------------

REVOKE ALL ON FUNCTION app.check_sender_domain_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.check_sender_domain_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.sender_domain_add(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.sender_domain_verify(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.sender_domain_retire(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.email_sender_domain_known(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.check_email_suppression() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.check_email_suppression_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.email_suppression_lift(uuid, text, text) FROM PUBLIC;
-- The runtime may ask whether a domain is known. Adding, verifying, and
-- retiring a domain, and lifting a suppression, stay with the admin connection.
GRANT EXECUTE ON FUNCTION app.email_sender_domain_known(text) TO tidegrid_app;
