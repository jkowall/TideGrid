-- Test-only fixture for the no-transaction runner mode
-- (src/migrate.integration.test.ts). Never applied outside a scratch database.
CREATE TABLE public.fixture_items (
  id int PRIMARY KEY,
  code text NOT NULL
);

INSERT INTO public.fixture_items (id, code)
SELECT g, 'code-' || g FROM generate_series(1, 1000) AS g;

-- About 2 ms a row, so an index over it builds for about 2 s.
CREATE FUNCTION public.fixture_slow(i int) RETURNS int
LANGUAGE plpgsql IMMUTABLE
AS $$
BEGIN
  PERFORM pg_sleep(0.002);
  RETURN i;
END
$$;
