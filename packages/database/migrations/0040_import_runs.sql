-- W3-G2.13, part 1: the standard CSV import's dry runs.
--
-- A dry run checks a batch of legacy files against the operator's catalog,
-- trips, and capacity and writes none of their data. What it keeps is this
-- record: which batch and run, the files' content hash, whether it was clean,
-- and its counts and control totals (numbers only, never a name, an email, or
-- a reference from the files). A later commit step will require the hash of a
-- clean dry run of the same batch, as the draft in
-- docs/v2/drafts/standard-csv-import.md proposes.
--
-- Append-only, forced row-level security, SELECT and INSERT for the runtime.
-- Only an owner signed in as staff records one; the trigger stamps the actor
-- and the time.

CREATE TABLE public.import_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES public.tenants (id),
  batch_id text NOT NULL CHECK (batch_id ~ '^[A-Za-z0-9._-]{1,64}$'),
  run_number integer NOT NULL CHECK (run_number BETWEEN 1 AND 999999),
  source_system text NOT NULL CHECK (source_system ~ '^[A-Za-z0-9._-]{1,64}$'),
  mapping_version text NOT NULL CHECK (mapping_version = 'std-csv-v0'),
  mode text NOT NULL CHECK (mode = 'dry_run'),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  clean boolean NOT NULL,
  error_count integer NOT NULL CHECK (error_count >= 0),
  warning_count integer NOT NULL CHECK (warning_count >= 0),
  CHECK (NOT clean OR error_count = 0),
  -- By file: rows, accepted, refused. By "metric|file": declared and computed.
  files jsonb NOT NULL CHECK (jsonb_typeof(files) = 'object'),
  controls jsonb NOT NULL CHECK (jsonb_typeof(controls) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  actor_type text NOT NULL DEFAULT coalesce(app.setting_or_null('app.actor_type'), 'system')
    CHECK (actor_type IN ('staff', 'guest', 'system', 'support')),
  actor_id text DEFAULT app.setting_or_null('app.actor_id'),
  request_id text DEFAULT app.setting_or_null('app.request_id'),
  UNIQUE (tenant_id, id),
  CONSTRAINT import_runs_run UNIQUE (tenant_id, batch_id, run_number)
);
CREATE INDEX import_runs_recent_idx ON public.import_runs (tenant_id, created_at);

CREATE FUNCTION app.check_import_run() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  NEW.created_at := now();
  NEW.actor_type := coalesce(app.setting_or_null('app.actor_type'), 'system');
  NEW.actor_id := app.setting_or_null('app.actor_id');
  NEW.request_id := app.setting_or_null('app.request_id');
  IF NEW.actor_type <> 'staff' OR NOT EXISTS (
       SELECT 1 FROM public.tenant_memberships m
        WHERE m.tenant_id = NEW.tenant_id AND m.user_id::text = NEW.actor_id
          AND m.role = 'owner' AND m.status = 'active') THEN
    RAISE EXCEPTION 'only an owner of this operator runs an import'
      USING ERRCODE = '42501', CONSTRAINT = 'import_runs_owner';
  END IF;
  -- A batch keeps one source system across its runs. Runs of one batch take
  -- turns (the same lock runImportDryRun takes), and read afresh after the
  -- lock only under READ COMMITTED.
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'import runs are written only under READ COMMITTED, not %',
      pg_catalog.current_setting('transaction_isolation')
      USING ERRCODE = '25001';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(
    'import_runs:' || NEW.tenant_id::text || ':' || NEW.batch_id));
  IF EXISTS (SELECT 1 FROM public.import_runs r
              WHERE r.tenant_id = NEW.tenant_id AND r.batch_id = NEW.batch_id
                AND r.source_system <> NEW.source_system) THEN
    RAISE EXCEPTION 'batch % belongs to another source system', NEW.batch_id
      USING ERRCODE = '23514', CONSTRAINT = 'import_runs_source';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER import_runs_rules BEFORE INSERT ON public.import_runs
  FOR EACH ROW EXECUTE FUNCTION app.check_import_run();

ALTER TABLE public.import_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.import_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.import_runs
  USING (tenant_id = (SELECT app.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()));
CREATE TRIGGER import_runs_append_only BEFORE UPDATE OR DELETE ON public.import_runs
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();
CREATE TRIGGER import_runs_no_truncate BEFORE TRUNCATE ON public.import_runs
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_mutation();

REVOKE ALL ON FUNCTION app.check_import_run() FROM PUBLIC;
