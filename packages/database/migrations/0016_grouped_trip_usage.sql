-- 0016 grouped trip capacity usage (W1-INV-PRICING)
--
-- G2.6 review note: both trip listings called app.trip_capacity_usage once per
-- listed trip through a lateral join, and a staff listing can span 92 days.
-- This adds one grouped read that sums the live holds of every listed trip in
-- a single call, and makes the per-trip function a wrapper over it, so the
-- rule for which holds take capacity still lives in one place.
--
-- Both functions are STABLE invoker SQL functions with search_path pinned:
-- row-level security applies inside them, and they filter by tenant
-- explicitly as well. Neither writes. The per-trip function is replaced in
-- place, so its name, owner, grants, and result type stay as 0006 made them.
-- No table, column, index, policy, or row changes. The capacity trigger keeps
-- its own sum under the trip lock; these reads stay advisory.

-- Seats taken on each named trip right now: held by holds that have not
-- reached their expiry instant, and confirmed. One row per distinct id asked
-- for, zeros included, so a caller can join it to its trips without a
-- coalesce. An id that names no trip of this tenant counts nothing.
CREATE FUNCTION app.trip_capacity_usage_grouped(p_tenant_id uuid, p_trip_ids uuid[])
  RETURNS TABLE (trip_id uuid, held integer, confirmed integer)
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT ids.id,
           coalesce(sum(h.seats) FILTER (WHERE h.state = 'active'), 0)::integer,
           coalesce(sum(h.seats) FILTER (WHERE h.state = 'confirmed'), 0)::integer
      FROM (SELECT DISTINCT u.id FROM unnest(p_trip_ids) AS u(id)) AS ids
      LEFT JOIN public.capacity_holds h
        ON h.tenant_id = p_tenant_id
       AND h.trip_id = ids.id
       AND h.state IN ('active', 'confirmed')
       AND (h.state = 'confirmed' OR h.expires_at > pg_catalog.now())
     GROUP BY ids.id
  $$;

-- The per-trip read, now one grouped call for one trip. It still returns
-- exactly one row, zeros when nothing is held.
CREATE OR REPLACE FUNCTION app.trip_capacity_usage(p_tenant_id uuid, p_trip_id uuid)
  RETURNS TABLE (held integer, confirmed integer)
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT g.held, g.confirmed
      FROM app.trip_capacity_usage_grouped(p_tenant_id, ARRAY[p_trip_id]) AS g
  $$;

REVOKE ALL ON FUNCTION app.trip_capacity_usage_grouped(uuid, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.trip_capacity_usage_grouped(uuid, uuid[]) TO tidegrid_app;
