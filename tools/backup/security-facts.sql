-- Read by backup.sh (in the backup's snapshot) and verify.py. Read-only.
-- Two lines that fingerprint tenant isolation itself:
--   policies|<count>|<digest>   every row-level security policy on public and
--                               app tables: table, name, command, roles,
--                               permissive, USING and WITH CHECK
--   grants|<count>|<digest>     every table privilege the runtime role holds
-- A restore that drops, loosens, or adds a policy or a grant changes a digest.
select format('policies|%s|%s', count(*),
         coalesce(md5(string_agg(concat_ws('|', schemaname, tablename, policyname, cmd, permissive,
           roles::text, coalesce(qual, ''), coalesce(with_check, '')), chr(10)
           order by schemaname, tablename, policyname)), ''))
  from pg_policies where schemaname in ('public', 'app');
select format('grants|%s|%s', count(*),
         coalesce(md5(string_agg(concat_ws('|', table_schema, table_name, privilege_type), chr(10)
           order by table_schema, table_name, privilege_type)), ''))
  from information_schema.role_table_grants
 where grantee = 'tidegrid_app' and table_schema in ('public', 'app');
