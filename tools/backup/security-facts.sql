-- Read by backup.sh (in the backup's snapshot) and verify.py. Read-only.
-- Two lines that fingerprint tenant isolation itself:
--   policies|<count>|<digest>   every row-level security policy on public and
--                               app tables: table, name, command, roles,
--                               permissive, USING and WITH CHECK
--   grants|<count>|<digest>     every table and column privilege the runtime
--                               role or PUBLIC holds, with its grant option,
--                               and EXECUTE on the schemas' own functions
-- A restore that drops, loosens, or adds a policy or a grant changes a digest.
select format('policies|%s|%s', count(*),
         coalesce(md5(string_agg(concat_ws('|', schemaname, tablename, policyname, cmd, permissive,
           roles::text, coalesce(qual, ''), coalesce(with_check, '')), chr(10)
           order by schemaname, tablename, policyname)), ''))
  from pg_policies where schemaname in ('public', 'app');
select format('grants|%s|%s', count(*),
         coalesce(md5(string_agg(g, chr(10) order by g)), ''))
  from (
    -- Whole-table privileges.
    select concat_ws('|', grantee, table_schema, table_name, '*', privilege_type, is_grantable) as g
      from information_schema.role_table_grants
     where grantee in ('tidegrid_app', 'PUBLIC') and table_schema in ('public', 'app')
    union all
    -- Column privileges granted on their own, such as UPDATE (state).
    select concat_ws('|', case when x.grantee = 0 then 'PUBLIC' else 'tidegrid_app' end,
             n.nspname, c.relname, a.attname, x.privilege_type, x.is_grantable)
      from pg_attribute a
      join pg_class c on c.oid = a.attrelid
      join pg_namespace n on n.oid = c.relnamespace
      cross join lateral aclexplode(a.attacl) x
     where a.attacl is not null and not a.attisdropped
       and n.nspname in ('public', 'app')
       and (x.grantee = 'tidegrid_app'::regrole or x.grantee = 0)
    union all
    -- EXECUTE on the schema's own functions, by signature. Routines that
    -- belong to an extension are left out, as the restore may leave out the
    -- extension.
    select concat_ws('|', case when x.grantee = 0 then 'PUBLIC' else 'tidegrid_app' end,
             n.nspname, p.oid::regprocedure::text, x.privilege_type, x.is_grantable)
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x
     where n.nspname in ('public', 'app')
       and not exists (select 1 from pg_depend d
                        where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
       and (x.grantee = 'tidegrid_app'::regrole or x.grantee = 0)
  ) grants;
