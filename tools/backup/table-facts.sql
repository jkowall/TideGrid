-- Read by backup.sh (in the backup's snapshot) and verify.py. Read-only.
-- One line per table in the public and app schemas:
--   <schema.table>|<row count>|<digest>|<row level security on and forced: t or f>
-- (DISABLE ROW LEVEL SECURITY keeps the force flag, so both flags are read.)
-- The digest is an md5 over the sorted md5 of each row's text form, so it does
-- not depend on the server's collation or on physical row order. Two databases
-- with the same rows give the same line. At pilot volume this reads every row
-- in well under a minute.
select format('%s.%s|%s|%s|%s',
         n.nspname, c.relname,
         (xpath('/row/n/text()', x))[1]::text,
         coalesce((xpath('/row/d/text()', x))[1]::text, ''),
         case when c.relrowsecurity and c.relforcerowsecurity then 't' else 'f' end)
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  cross join lateral query_to_xml(
    format('select count(*) as n, md5(string_agg(h, '''' order by h)) as d
              from (select md5(t::text) as h from %I.%I t) s', n.nspname, c.relname),
    false, true, '') as x
 where n.nspname in ('public', 'app')
   and c.relkind in ('r', 'p')
 order by 1;
