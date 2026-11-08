-- 0021 email bounce and complaint events (W1-EMAIL-EVENTS)
--
-- Pulled forward by the owner on 2026-11-08 (docs/v2/06-decision-register.md).
-- A message marked sent was only accepted by the provider; a later bounce or
-- spam complaint never reached TideGrid, so staff saw "sent" for mail the
-- guest never got. Cloudflare publishes those outcomes as Email Sending events
-- to a queue. This file gives the consumer what it needs to record them.
--
-- The join. An event carries the provider's message id and no tenant.
-- app.resolve_email_message(provider, id) answers which tenant's sent message
-- carries that id, and nothing else: the definer function reads one row by
-- the unique index 0022 builds, and the event is then recorded inside that
-- tenant's own transaction, under its row-level security, like the payment
-- inbox (0007's app.resolve_payment_account). No other RLS bypass.
--
-- The inbox, public.email_events. Tenant-owned under packages/database/README.md
-- rules 1 to 10: tenant_id on every row, forced row-level security with a
-- tenant_isolation policy, the default SELECT and INSERT from 0001 and nothing
-- more, append-only for every role, and a composite foreign key to the
-- tenant's own message. One row per provider event id per tenant
-- (email_events_once), so a queue's redelivery or a replay changes nothing.
-- Only bounced and complained events are kept; the consumer drops the rest.
--
-- Once. The first bounce or complaint for a message is its outcome: its row
-- is marked applied, and a partial unique key allows one applied row per
-- message (email_events_applied_once). A later event for the same message
-- is still recorded, as not applied. Staff reads show the applied row; the
-- message's own state stays sent (the provider did accept it), so 0009's
-- delivery rules, 0014's limits, and 0017's claims are untouched.
--
-- The check trigger, app.check_email_event(), an invoker function. The
-- message must be this tenant's, sent, through the event's provider, under
-- the event's provider message id; it is locked FOR SHARE while the event is
-- recorded. received_at comes from the database clock. So a writer holding
-- tidegrid_app's credentials cannot attach an event to a queued or failed
-- message, to another provider's, or to one whose id the event does not
-- carry. It can still record a made-up bounce for its own tenant's sent
-- message: the runtime is trusted to record what the queue gave it
-- (recorded as a residual). The queue itself is not authenticated beyond
-- who may publish to it: anything that can, can claim the account and
-- domain the consumer checks.
--
-- Unknown ids, public.email_events_unmatched. An event whose id joins no sent
-- message is recorded here, once per provider event id, and joined to
-- nothing. It has no tenant, so it is a platform table under rule 6: row-level
-- security forced with no policy, every privilege revoked from the runtime
-- (its identity sequence too), not append-only so the owner can prune it,
-- and written only through app.record_unmatched_email_event, a definer
-- function that inserts one row and answers whether it was new. The runtime
-- can never read it back. It holds the provider's ids, the event's type and
-- times, and no recipient, subject, or body.
--
-- Indexes. The inbox's own keys are its indexes. The unique index on
-- email_messages (provider, provider_message_id) is a pilot-volume index, so
-- it is built CONCURRENTLY in 0022, a no-transaction file. Until 0022 runs,
-- the resolver works by a slower scan; apply both together.

DO $$
BEGIN
  IF NOT (SELECT rolbypassrls OR rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION '0021 runs as the migration role, which bypasses row-level security';
  END IF;
END;
$$;

CREATE TABLE public.email_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  provider text NOT NULL CHECK (provider IN ('cloudflare')),
  -- The provider's event id (Cloudflare's payload.eventId, UUID-like).
  event_id text NOT NULL CHECK (event_id ~ '^[A-Za-z0-9_.:-]{8,128}$'),
  event_type text NOT NULL CHECK (event_type IN ('bounced', 'complained')),
  -- The provider message id the event named, after the adapter's
  -- normalization (normalizeCloudflareMessageId), the same form the message
  -- stored when it was sent.
  provider_message_id text NOT NULL CHECK (provider_message_id ~ '^[A-Za-z0-9_.@<>:+=-]{3,255}$'),
  message_id uuid NOT NULL,
  -- A bounce's kind (hard or soft) and a short code: the enhanced SMTP status
  -- for a bounce (such as 5.1.1) or the complaint's type (such as abuse).
  -- Never the provider's free-text response, which can quote the address.
  bounce_type text CHECK (bounce_type IN ('hard', 'soft')),
  detail_code text CHECK (detail_code ~ '^[A-Za-z0-9_.-]{1,64}$'),
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  applied boolean NOT NULL,
  UNIQUE (tenant_id, id),
  CONSTRAINT email_events_once UNIQUE (tenant_id, provider, event_id),
  CONSTRAINT email_events_bounce_type CHECK ((event_type = 'bounced') OR bounce_type IS NULL),
  FOREIGN KEY (tenant_id, message_id) REFERENCES public.email_messages (tenant_id, id)
);
CREATE UNIQUE INDEX email_events_applied_once ON public.email_events (tenant_id, message_id)
  WHERE applied;

ALTER TABLE public.email_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.email_events
  USING (tenant_id = (SELECT app.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()));

-- The event joins the tenant's own sent message under the id it names. Runs
-- as the writer, under its row-level security.
CREATE FUNCTION app.check_email_event() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  m record;
BEGIN
  SELECT e.state, e.provider, e.provider_message_id INTO m
    FROM public.email_messages e
   WHERE e.tenant_id = NEW.tenant_id AND e.id = NEW.message_id
   FOR SHARE OF e;
  IF NOT FOUND OR m.state IS DISTINCT FROM 'sent' OR m.provider IS DISTINCT FROM NEW.provider
     OR m.provider_message_id IS DISTINCT FROM NEW.provider_message_id THEN
    RAISE EXCEPTION 'an email event names a sent message of its own tenant, provider, and id'
      USING ERRCODE = '23514', CONSTRAINT = 'email_events_message';
  END IF;
  NEW.received_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER email_events_check
  BEFORE INSERT ON public.email_events
  FOR EACH ROW EXECUTE FUNCTION app.check_email_event();
CREATE TRIGGER email_events_append_only
  BEFORE UPDATE OR DELETE ON public.email_events
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();
CREATE TRIGGER email_events_no_truncate
  BEFORE TRUNCATE ON public.email_events
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_mutation();

REVOKE ALL ON FUNCTION app.check_email_event() FROM PUBLIC;

-- Events whose message id joins nothing. A platform table (rule 6).
CREATE TABLE public.email_events_unmatched (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider text NOT NULL CHECK (provider IN ('cloudflare')),
  event_id text NOT NULL CHECK (event_id ~ '^[A-Za-z0-9_.:-]{8,128}$'),
  event_type text NOT NULL CHECK (event_type IN ('bounced', 'complained')),
  provider_message_id text NOT NULL CHECK (provider_message_id ~ '^[A-Za-z0-9_.@<>:+=-]{3,255}$'),
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT email_events_unmatched_once UNIQUE (provider, event_id)
);
-- No append-only trigger: anything that can publish to the queue can add
-- rows here, so the owner must be able to prune it. The runtime cannot.
ALTER TABLE public.email_events_unmatched ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_events_unmatched FORCE ROW LEVEL SECURITY;
-- No policy: the runtime holds nothing and reaches it only through the
-- function below, which runs as the table owner.
REVOKE ALL ON public.email_events_unmatched FROM tidegrid_app;
-- 0001's default privileges give the runtime every new sequence; this one
-- would let it count unmatched events or burn ids.
REVOKE ALL ON SEQUENCE public.email_events_unmatched_id_seq FROM tidegrid_app;

-- Which tenant's sent message carries a provider's message id: one row or
-- none. Filters explicitly, since its owner bypasses row-level security.
CREATE FUNCTION app.resolve_email_message(p_provider text, p_provider_message_id text)
  RETURNS TABLE (tenant_id uuid, message_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT m.tenant_id, m.id
      FROM public.email_messages m
     WHERE m.provider = p_provider
       AND m.provider_message_id = p_provider_message_id
       AND m.state = 'sent'
     LIMIT 1
  $$;

-- Records an event that joined no message, once per provider event id.
-- Answers true when the row is new, false for a duplicate.
CREATE FUNCTION app.record_unmatched_email_event(
  p_provider text, p_event_id text, p_event_type text,
  p_provider_message_id text, p_occurred_at timestamptz)
  RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  inserted integer;
BEGIN
  INSERT INTO public.email_events_unmatched
         (provider, event_id, event_type, provider_message_id, occurred_at)
  VALUES (p_provider, p_event_id, p_event_type, p_provider_message_id, p_occurred_at)
  ON CONFLICT ON CONSTRAINT email_events_unmatched_once DO NOTHING;
  GET DIAGNOSTICS inserted = ROW_COUNT;
  RETURN inserted = 1;
END;
$$;

REVOKE ALL ON FUNCTION app.resolve_email_message(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.record_unmatched_email_event(text, text, text, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_email_message(text, text) TO tidegrid_app;
GRANT EXECUTE ON FUNCTION app.record_unmatched_email_event(text, text, text, text, timestamptz) TO tidegrid_app;
