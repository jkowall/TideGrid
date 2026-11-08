-- tidegrid:no-transaction
-- Test-only fixture: a unique index built concurrently. A duplicate code fails
-- the build and leaves the index invalid.
CREATE UNIQUE INDEX CONCURRENTLY fixture_items_code_key ON public.fixture_items (code);
