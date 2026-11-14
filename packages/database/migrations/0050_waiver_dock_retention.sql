-- 0050 retention for the dock QR's lookups (W3-G2.15-rest follow-up)
--
-- Under the owner's go of 2026-11-10 on the rest of Wave 3 (code only,
-- synthetic data). Choices made here are coordinator defaults pending owner
-- confirmation (the "dock lookup retention" register entry). Tenancy follows
-- packages/database/README.md.
--
-- waiver_dock_lookups (0043) keeps every try at the dock QR's lookup, with the
-- client's network address, for good. Its limits look back at most 24 hours.
-- After 30 days a try is housekeeping, not a fact anyone needs:
--
-- 1. A try that started no signing (every miss, and a match nobody signed
--    from) is deleted.
-- 2. A match that started a signing stays, since the signing link names it,
--    but its client address is replaced with 'redacted'. The signature's own
--    evidence keeps what it recorded (0010), so nothing about a signature
--    changes.
--
-- Both run only inside app.waiver_dock_cleanup, which marks its own
-- transaction. Every other UPDATE and DELETE still raises, and the runtime
-- holds neither privilege. As with 0023's mark, a role that does hold them
-- (the owner) could set the mark itself; the guard then still allows only a
-- delete or a redaction of a row over 30 days old. The cron calls it as its
-- own step.

-- 1. The guard ------------------------------------------------------------------------

-- Only inside the cleanup, and only for a try more than 30 days old: a delete,
-- or an update that changes nothing but the client to 'redacted'.
CREATE FUNCTION app.guard_waiver_dock_lookup_change() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF coalesce(current_setting('app.cleanup', true), '') IS DISTINCT FROM 'waiver_dock_cleanup' THEN
    RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
  END IF;
  IF OLD.created_at >= pg_catalog.now() - interval '30 days' THEN
    RAISE EXCEPTION 'only a dock lookup more than 30 days old is cleaned up' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF NEW.client_key <> 'redacted'
     OR (pg_catalog.to_jsonb(NEW) - 'client_key') IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - 'client_key') THEN
    RAISE EXCEPTION 'a dock lookup''s cleanup only redacts its client' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.guard_waiver_dock_lookup_change() FROM PUBLIC;

DROP TRIGGER waiver_dock_lookups_no_delete ON public.waiver_dock_lookups;
DROP TRIGGER waiver_dock_lookups_append_only ON public.waiver_dock_lookups;
CREATE TRIGGER waiver_dock_lookups_cleanup_only BEFORE UPDATE OR DELETE ON public.waiver_dock_lookups
  FOR EACH ROW EXECUTE FUNCTION app.guard_waiver_dock_lookup_change();

-- For the cleanup's scan across tenants: rows not yet redacted, so a row kept
-- for its signing is not read again on every run.
CREATE INDEX waiver_dock_lookups_cleanup_idx ON public.waiver_dock_lookups (created_at)
  WHERE client_key <> 'redacted';

-- 2. The cleanup ----------------------------------------------------------------------

-- Across tenants, at most p_limit (1 to 5,000) of each kind: tries more than
-- 30 days old that started no signing are deleted, and those that did have
-- their client redacted. No audit or outbox row: this is housekeeping. The
-- runtime may call it; it is the only way a lookup is changed or removed.
CREATE FUNCTION app.waiver_dock_cleanup(p_limit integer)
  RETURNS TABLE (deleted integer, redacted integer)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_limit integer := greatest(1, least(coalesce(p_limit, 1000), 5000));
  v_deleted integer;
  v_redacted integer;
BEGIN
  PERFORM set_config('app.cleanup', 'waiver_dock_cleanup', true);
  WITH doomed AS (
    SELECT k.tenant_id, k.id
      FROM public.waiver_dock_lookups k
     WHERE k.created_at < pg_catalog.now() - interval '30 days'
       AND k.client_key <> 'redacted'
       AND NOT EXISTS (SELECT 1 FROM public.waiver_assisted_links a
                        WHERE a.tenant_id = k.tenant_id AND a.dock_lookup_id = k.id)
     ORDER BY k.created_at
     LIMIT v_limit
       FOR UPDATE OF k SKIP LOCKED
  ), gone AS (
    DELETE FROM public.waiver_dock_lookups k
     USING doomed d
     WHERE k.tenant_id = d.tenant_id AND k.id = d.id
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_deleted FROM gone;

  WITH kept AS (
    SELECT k.tenant_id, k.id
      FROM public.waiver_dock_lookups k
     WHERE k.created_at < pg_catalog.now() - interval '30 days'
       AND k.client_key <> 'redacted'
       AND EXISTS (SELECT 1 FROM public.waiver_assisted_links a
                    WHERE a.tenant_id = k.tenant_id AND a.dock_lookup_id = k.id)
     ORDER BY k.created_at
     LIMIT v_limit
       FOR UPDATE OF k SKIP LOCKED
  ), done AS (
    UPDATE public.waiver_dock_lookups k
       SET client_key = 'redacted'
      FROM kept d
     WHERE k.tenant_id = d.tenant_id AND k.id = d.id
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_redacted FROM done;
  PERFORM set_config('app.cleanup', '', true);

  RETURN QUERY SELECT v_deleted, v_redacted;
END;
$$;
REVOKE ALL ON FUNCTION app.waiver_dock_cleanup(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.waiver_dock_cleanup(integer) TO tidegrid_app;
