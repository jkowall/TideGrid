-- 0023 delivery foundation (W3-G2.3): outbox publication, consumer outcomes,
-- dead letters, replay, and cleanup
--
-- Until now the outbox only collected events: nothing published them, and the
-- cron sweeps did every piece of follow-up work directly. This migration adds
-- what a queue publisher and an async consumer need, with PostgreSQL staying
-- the record of truth (docs/v2/04-architecture.md, "Queues and provider
-- objects are delivery mechanisms or projections, not business truth"):
--
-- 1. outbox_events gains delivered_at, and the runtime may move the delivery
--    columns. A publisher marks a row published when the queue accepted its
--    hint; the consumer marks it delivered when every handler is done. A
--    published row that is not delivered after a while is a lost hint, and
--    the publisher sends it again.
-- 2. outbox_deliveries records one row per event and handler, in the same
--    transaction as the handler's own writes. A second delivery of the same
--    message finds the row and does nothing: handlers are idempotent by key.
-- 3. outbox_dead_letters is the operator-visible record of a message that
--    exhausted its retries. A reviewed replay marks the row replayed, with a
--    reason, and sends the event again; only handlers with no outcome run.
-- 4. app.outbox_publish_tenants lists due tenants for the publisher, least
--    recently served first, as the other sweeps do (0013).
-- 5. app.outbox_dead_letter_tenants lists tenants with open dead letters, for
--    the replay command's list.
-- 6. app.delivery_cleanup removes completed idempotency keys and unused
--    quotes a week past their expiry. The runtime never deletes; it calls
--    this definer function, which deletes only those rows.
--
-- Choices made here are coordinator defaults pending owner confirmation (the
-- W3-G2.3 register entry in docs/v2/06-decision-register.md).

-- 1. Outbox delivery columns ---------------------------------------------------

ALTER TABLE public.outbox_events ADD COLUMN delivered_at timestamptz;

-- Events written before this migration had no consumer, and the cron sweeps
-- already did their follow-up work. Marking them published and delivered
-- keeps the first publisher run from sending history to new handlers.
UPDATE public.outbox_events
   SET published_at = coalesce(published_at, clock_timestamp()),
       delivered_at = clock_timestamp()
 WHERE delivered_at IS NULL;

ALTER TABLE public.outbox_events
  ADD CONSTRAINT outbox_events_delivered_after_published
  CHECK (delivered_at IS NULL OR published_at IS NOT NULL),
  ADD CONSTRAINT outbox_events_last_error_shape
  CHECK (last_error IS NULL OR last_error ~ '^[A-Za-z0-9_.:-]{1,120}$');

-- An event's identity and content never change; only its delivery columns
-- move. No role deletes an event, the owner included.
CREATE FUNCTION app.check_outbox_event_update() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.topic IS DISTINCT FROM OLD.topic
     OR NEW.aggregate_type IS DISTINCT FROM OLD.aggregate_type
     OR NEW.aggregate_id IS DISTINCT FROM OLD.aggregate_id
     OR NEW.payload IS DISTINCT FROM OLD.payload
     OR NEW.request_id IS DISTINCT FROM OLD.request_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'an outbox event''s content is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.check_outbox_event_update() FROM PUBLIC;

CREATE TRIGGER outbox_events_content_immutable
  BEFORE UPDATE ON public.outbox_events
  FOR EACH ROW EXECUTE FUNCTION app.check_outbox_event_update();
CREATE TRIGGER outbox_events_no_delete
  BEFORE DELETE ON public.outbox_events
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();
CREATE TRIGGER outbox_events_no_truncate
  BEFORE TRUNCATE ON public.outbox_events
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_mutation();

GRANT UPDATE (published_at, delivered_at, available_at, attempts, last_error)
  ON public.outbox_events TO tidegrid_app;

-- The lost-hint recovery reads published, undelivered rows by age.
CREATE INDEX outbox_events_undelivered_idx
  ON public.outbox_events (published_at)
  WHERE published_at IS NOT NULL AND delivered_at IS NULL;

-- 2. Consumer outcomes -----------------------------------------------------------

-- One row per event and handler, written in the handler's own transaction.
-- A tenant-owned table under rules 1 to 10 of packages/database/README.md.
-- Append-only for every role.
CREATE TABLE public.outbox_deliveries (
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  outbox_event_id bigint NOT NULL,
  handler text NOT NULL CHECK (handler ~ '^[a-z][a-z0-9_]{0,62}$'),
  processed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  request_id text DEFAULT app.setting_or_null('app.request_id')
    CHECK (request_id IS NULL OR char_length(request_id) <= 128),
  PRIMARY KEY (tenant_id, outbox_event_id, handler),
  FOREIGN KEY (tenant_id, outbox_event_id) REFERENCES public.outbox_events (tenant_id, id)
);

ALTER TABLE public.outbox_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outbox_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.outbox_deliveries
  USING (tenant_id = (SELECT app.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()));

CREATE TRIGGER outbox_deliveries_append_only
  BEFORE UPDATE OR DELETE ON public.outbox_deliveries
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();
CREATE TRIGGER outbox_deliveries_no_truncate
  BEFORE TRUNCATE ON public.outbox_deliveries
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_mutation();

-- 3. Dead letters ---------------------------------------------------------------

-- A message that exhausted its retries. It names the event, its topic, the
-- handler that failed when the consumer knows it, and a short error code:
-- never the payload, a message, or a stack. At most one open dead letter per
-- event; a replay closes it, and a later failure opens a new one.
CREATE TABLE public.outbox_dead_letters (
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  id bigint GENERATED ALWAYS AS IDENTITY,
  outbox_event_id bigint NOT NULL,
  topic text NOT NULL CHECK (topic ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  handler text CHECK (handler IS NULL OR handler ~ '^[a-z][a-z0-9_]{0,62}$'),
  error_code text NOT NULL CHECK (error_code ~ '^[A-Za-z0-9_.:-]{1,120}$'),
  attempts integer NOT NULL CHECK (attempts >= 0),
  -- 'consumer': the consumer gave up after its last attempt. 'queue': the
  -- queue's own dead letter queue handed the message over. 'publisher': the
  -- hint was sent too many times without a delivery.
  source text NOT NULL CHECK (source IN ('consumer', 'queue', 'publisher')),
  dead_lettered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  request_id text DEFAULT app.setting_or_null('app.request_id')
    CHECK (request_id IS NULL OR char_length(request_id) <= 128),
  replayed_at timestamptz,
  replayed_by text CHECK (replayed_by IS NULL OR char_length(replayed_by) BETWEEN 1 AND 200),
  -- Text a person typed: one line, 1 to 500 characters, with something
  -- visible. It goes to the audit row's reason, never to a log.
  replay_reason text CHECK (
    replay_reason IS NULL
    OR (char_length(replay_reason) BETWEEN 1 AND 500
        AND replay_reason !~ '[\x00-\x1f\x7f-\x9f]'
        AND replay_reason ~ '[^[:space:]]')),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, outbox_event_id) REFERENCES public.outbox_events (tenant_id, id),
  CONSTRAINT outbox_dead_letters_replay_complete CHECK (
    (replayed_at IS NULL) = (replayed_by IS NULL)
    AND (replayed_at IS NULL) = (replay_reason IS NULL))
);
CREATE UNIQUE INDEX outbox_dead_letters_one_open
  ON public.outbox_dead_letters (tenant_id, outbox_event_id)
  WHERE replayed_at IS NULL;

ALTER TABLE public.outbox_dead_letters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outbox_dead_letters FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.outbox_dead_letters
  USING (tenant_id = (SELECT app.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()));

-- A dead letter is written open. A replay closes it once: the trigger stamps
-- the time and the actor from the transaction's context, and nothing else
-- moves. No role deletes one.
CREATE FUNCTION app.check_outbox_dead_letter() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_actor text := app.setting_or_null('app.actor_id');
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.replayed_at IS NOT NULL OR NEW.replayed_by IS NOT NULL
       OR NEW.replay_reason IS NOT NULL THEN
      RAISE EXCEPTION 'a dead letter is recorded open' USING ERRCODE = '23514';
    END IF;
    NEW.dead_lettered_at := clock_timestamp();
    RETURN NEW;
  END IF;
  IF OLD.replayed_at IS NOT NULL THEN
    RAISE EXCEPTION 'a dead letter is replayed once' USING ERRCODE = '55000';
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.outbox_event_id IS DISTINCT FROM OLD.outbox_event_id
     OR NEW.topic IS DISTINCT FROM OLD.topic
     OR NEW.handler IS DISTINCT FROM OLD.handler
     OR NEW.error_code IS DISTINCT FROM OLD.error_code
     OR NEW.attempts IS DISTINCT FROM OLD.attempts
     OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.dead_lettered_at IS DISTINCT FROM OLD.dead_lettered_at
     OR NEW.request_id IS DISTINCT FROM OLD.request_id
     OR NEW.replay_reason IS NULL THEN
    RAISE EXCEPTION 'a replay sets its reason and nothing else' USING ERRCODE = '55000';
  END IF;
  IF v_actor IS NULL
     OR app.setting_or_null('app.actor_type') IS DISTINCT FROM 'staff'
        AND app.setting_or_null('app.actor_type') IS DISTINCT FROM 'support' THEN
    RAISE EXCEPTION 'a replay names its actor, who is staff or support, never a job or a guest'
      USING ERRCODE = '42501';
  END IF;
  NEW.replayed_at := clock_timestamp();
  NEW.replayed_by := left(app.setting_or_null('app.actor_type') || ':' || v_actor, 200);
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.check_outbox_dead_letter() FROM PUBLIC;

CREATE TRIGGER outbox_dead_letters_check
  BEFORE INSERT OR UPDATE ON public.outbox_dead_letters
  FOR EACH ROW EXECUTE FUNCTION app.check_outbox_dead_letter();
CREATE TRIGGER outbox_dead_letters_no_delete
  BEFORE DELETE ON public.outbox_dead_letters
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();
CREATE TRIGGER outbox_dead_letters_no_truncate
  BEFORE TRUNCATE ON public.outbox_dead_letters
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_mutation();

-- The runtime sets the reason; the trigger fills replayed_at and replayed_by.
GRANT UPDATE (replay_reason)
  ON public.outbox_dead_letters TO tidegrid_app;

-- 4. Publisher tenant list ----------------------------------------------------------

ALTER TABLE public.sweep_turns DROP CONSTRAINT sweep_turns_sweep_check;
ALTER TABLE public.sweep_turns ADD CONSTRAINT sweep_turns_sweep_check
  CHECK (sweep IN ('hold', 'checkout', 'email', 'hostname', 'outbox'));

-- Tenants with an event due for publication, or a published event whose hint
-- looks lost (published at least p_lost_seconds ago, 60 to 86,400, and not
-- delivered). Either way the event is past its available_at and has no open
-- dead letter, so parked events never keep a tenant listed. Tenant ids only, at most 1,000, least
-- recently served first, for the reasons 0013 gives.
CREATE FUNCTION app.outbox_publish_tenants(p_limit integer, p_lost_seconds integer)
  RETURNS TABLE (tenant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT x.tenant_id FROM (
      SELECT DISTINCT o.tenant_id FROM public.outbox_events o
       WHERE o.available_at <= pg_catalog.now()
         AND (o.published_at IS NULL
              OR (o.delivered_at IS NULL
                  AND o.published_at <= pg_catalog.now() - pg_catalog.make_interval(
                        secs => greatest(60, least(coalesce(p_lost_seconds, 900), 86400)))))
         AND NOT EXISTS (
           SELECT 1 FROM public.outbox_dead_letters d
            WHERE d.tenant_id = o.tenant_id AND d.outbox_event_id = o.id
              AND d.replayed_at IS NULL)
    ) x
      LEFT JOIN public.sweep_turns t
        ON t.tenant_id = x.tenant_id AND t.sweep = 'outbox'
     ORDER BY t.last_turn_at ASC NULLS FIRST, x.tenant_id
     LIMIT greatest(1, least(coalesce(p_limit, 100), 1000))
  $$;
REVOKE ALL ON FUNCTION app.outbox_publish_tenants(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.outbox_publish_tenants(integer, integer) TO tidegrid_app;

-- 5. Dead letter tenant list ---------------------------------------------------------

-- Tenants with at least one open dead letter, at most 1,000, by tenant id.
-- The replay command then reads each tenant's rows in that tenant's own
-- transaction.
CREATE FUNCTION app.outbox_dead_letter_tenants(p_limit integer)
  RETURNS TABLE (tenant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT DISTINCT d.tenant_id FROM public.outbox_dead_letters d
     WHERE d.replayed_at IS NULL
     ORDER BY d.tenant_id
     LIMIT greatest(1, least(coalesce(p_limit, 100), 1000))
  $$;
REVOKE ALL ON FUNCTION app.outbox_dead_letter_tenants(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.outbox_dead_letter_tenants(integer) TO tidegrid_app;

-- 6. Cleanup --------------------------------------------------------------------------

-- Quotes, their lines, and their line taxes were append-only for every role
-- (0005). They stay that way for updates. A delete is allowed only inside
-- app.delivery_cleanup, which marks its own transaction, and only for a quote
-- a week past its expiry; the runtime still holds no DELETE on any of them.
CREATE FUNCTION app.guard_quote_delete() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF coalesce(current_setting('app.cleanup', true), '') IS DISTINCT FROM 'delivery_cleanup' THEN
    RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
  END IF;
  IF TG_TABLE_NAME = 'quotes'
     AND (pg_catalog.to_jsonb(OLD) ->> 'expires_at')::timestamptz
         >= pg_catalog.now() - interval '7 days' THEN
    RAISE EXCEPTION 'only a quote a week past its expiry is removed' USING ERRCODE = '55000';
  END IF;
  RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION app.guard_quote_delete() FROM PUBLIC;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['quotes', 'quote_lines', 'quote_line_taxes'] LOOP
    EXECUTE format('DROP TRIGGER %I ON public.%I', t || '_append_only', t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON public.%I'
      ' FOR EACH ROW EXECUTE FUNCTION app.reject_mutation()', t || '_append_only', t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE DELETE ON public.%I'
      ' FOR EACH ROW EXECUTE FUNCTION app.guard_quote_delete()', t || '_cleanup_only', t);
  END LOOP;
END
$$;


-- Removes, across tenants, at most p_limit (1 to 5,000) of each kind:
-- completed idempotency keys whose expiry passed more than seven days ago, and
-- quotes whose expiry passed more than seven days ago that no checkout or
-- order names, with their lines and line taxes. An in-progress key never
-- outlives its transaction, so none is ever seen here. It writes no audit or
-- outbox row: this is housekeeping, not a domain fact. The runtime may call
-- it; it is the only way any row of these tables is deleted.
CREATE FUNCTION app.delivery_cleanup(p_limit integer)
  RETURNS TABLE (idempotency_keys_deleted integer, quotes_deleted integer)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_limit integer := greatest(1, least(coalesce(p_limit, 1000), 5000));
  v_keys integer;
  v_quotes integer;
BEGIN
  WITH doomed AS (
    SELECT k.tenant_id, k.scope, k.principal, k.key
      FROM public.idempotency_keys k
     WHERE k.status = 'completed'
       AND k.expires_at < pg_catalog.now() - interval '7 days'
     LIMIT v_limit
       FOR UPDATE SKIP LOCKED
  ), gone AS (
    DELETE FROM public.idempotency_keys k
     USING doomed d
     WHERE k.tenant_id = d.tenant_id AND k.scope = d.scope
       AND k.principal = d.principal AND k.key = d.key
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_keys FROM gone;

  -- One statement: the foreign key checks run at its end, after the lines,
  -- taxes, and quotes are all gone. The mark lets the delete guard through
  -- and is cleared before the function returns.
  PERFORM set_config('app.cleanup', 'delivery_cleanup', true);
  WITH doomed AS (
    SELECT q.tenant_id, q.id
      FROM public.quotes q
     WHERE q.expires_at < pg_catalog.now() - interval '7 days'
       AND NOT EXISTS (SELECT 1 FROM public.checkout_sessions s
                        WHERE s.tenant_id = q.tenant_id AND s.quote_id = q.id)
       AND NOT EXISTS (SELECT 1 FROM public.orders o
                        WHERE o.tenant_id = q.tenant_id AND o.quote_id = q.id)
     LIMIT v_limit
       FOR UPDATE OF q SKIP LOCKED
  ), taxes AS (
    DELETE FROM public.quote_line_taxes t
     USING doomed d
     WHERE t.tenant_id = d.tenant_id AND t.quote_id = d.id
  ), lines AS (
    DELETE FROM public.quote_lines l
     USING doomed d
     WHERE l.tenant_id = d.tenant_id AND l.quote_id = d.id
  ), gone AS (
    DELETE FROM public.quotes q
     USING doomed d
     WHERE q.tenant_id = d.tenant_id AND q.id = d.id
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_quotes FROM gone;
  PERFORM set_config('app.cleanup', '', true);

  RETURN QUERY SELECT v_keys, v_quotes;
END;
$$;
REVOKE ALL ON FUNCTION app.delivery_cleanup(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.delivery_cleanup(integer) TO tidegrid_app;
