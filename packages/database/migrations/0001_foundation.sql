-- 0001 foundation
-- Establishes the runtime role and default privileges. Runtime code connects as
-- tidegrid_app, which never owns tables, so FORCE ROW LEVEL SECURITY applies to
-- it on every tenant-owned table created by later migrations.
--
-- The role is created here in SQL on purpose. A role created through the Neon
-- API or console joins neon_superuser, which carries BYPASSRLS and write access
-- to every table; that would defeat tenant isolation. The password is set out
-- of band by `pnpm --filter @tidegrid/database app-role:password`.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tidegrid_app') THEN
    CREATE ROLE tidegrid_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO tidegrid_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO tidegrid_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO tidegrid_app;

-- The runtime may read migration state for health reporting but never write it.
GRANT SELECT ON schema_migrations TO tidegrid_app;
