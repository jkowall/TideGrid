-- tidegrid:no-transaction
-- Test-only fixture: a concurrent build that takes about 2 s, for the timeout
-- and concurrent-runner tests.
CREATE INDEX CONCURRENTLY fixture_items_slow ON public.fixture_items (public.fixture_slow(id));
