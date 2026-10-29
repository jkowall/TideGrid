-- b87e269-queries.sql
--
-- What this is: every SQL statement and SECURITY DEFINER function call that the
-- API Worker of the deployed build b87e269 (2026-09-24) can issue at runtime,
-- written as plain SQL with literal values. Kysely queries are the equivalent
-- SQL, not the exact text Kysely emits (it quotes identifiers and uses bind
-- parameters). Each statement carries a "b87e269: <path>:<line>" comment that
-- names the source it mirrors.
--
-- How it is used: the upgrade-path integration test runs this file as the
-- runtime role tidegrid_app, so row-level security applies. It runs three
-- times: on the 0002 schema right after seed-0002-era.sql, after migrating to
-- the latest file, and after today's seed has also run. The test splits the
-- file on lines that begin with the step marker and runs each chunk with one
-- simple-query call. A chunk may hold several statements and whole
-- begin/commit blocks.
--
-- Repeatable: tokens, ids, idempotency keys, request ids, and new staff
-- addresses are fresh random values on every run. No step depends on a row a
-- previous run created, and no step is expected to fail. Each run adds one
-- sign-in token for owner.one (the limit is five per fifteen minutes), one
-- security event or two, one new staff member in Demo Harbor, and the audit,
-- outbox, and idempotency rows that go with it.
--
-- Tenant transactions mirror inTenantTransaction (b87e269
-- packages/database/src/tenant.ts): begin, the leaked-context check, then
-- set_config(..., true) for app.tenant_id, app.actor_type, app.actor_id,
-- app.request_id, and app.source_ip. The actor id is the principal's user id,
-- looked up by synthetic email through app.auth_find_staff_by_email.
--
-- Values that TypeScript computes are computed in SQL here:
--   - sha256Hex(text) becomes encode(sha256(convert_to(text, 'UTF8')), 'hex').
--   - newOpaqueToken() (32 random bytes, base64url, 43 characters) becomes
--     base64url of two md5(gen_random_uuid()) values decoded from hex.
--   - requestHash() becomes the same sha256 over the same joined text.
--   - Values that one statement returns and a later one uses are carried in
--     custom settings named tidegrid_fixture.*. Transaction-local where one
--     transaction holds the whole flow, session-level (and cleared at the end
--     of the chunk) where the flow spans transactions. The API does not do
--     this; it holds the values in TypeScript variables.
--
-- Not covered because they issue no SQL of their own: driver type fetches that
-- postgres.js runs on connect, JWT checks (auth/access.ts), hostname
-- normalization, role matrix checks, login link delivery, the rate limiter
-- binding, and the console gateway.
--
-- Data: synthetic only. Every address ends in .test. No credentials.
--
-- Fixed ids (from seed-0002-era.sql):
--   Demo Harbor Charters  7d1e5b3a-1c2f-4a8e-9b61-0a1c2e3f4a01
--   Demo Reef Divers      7d1e5b3a-1c2f-4a8e-9b61-0a1c2e3f4a02

-- step: health probe
-- b87e269: apps/api-worker/src/routes/system.ts:49
select count(*) as applied, max(name) as latest from schema_migrations;

-- step: public tenant resolution
-- b87e269: apps/api-worker/src/routes/public.ts:33
select tenant_slug, tenant_name from app.resolve_hostname('demo-harbor.book.tidegrid.us');
-- b87e269: apps/api-worker/src/routes/public.ts:33
select tenant_slug, tenant_name from app.resolve_hostname('demo-reef.book.tidegrid.us');
-- b87e269: apps/api-worker/src/routes/public.ts:33 (an unpublished host returns no rows)
select tenant_slug, tenant_name from app.resolve_hostname('unpublished.book.tidegrid.us');

-- step: access principal lookup
-- b87e269: apps/api-worker/src/auth/principal.ts:43
select * from app.auth_find_staff_by_email('ava.owner@demo-harbor.test');
-- b87e269: apps/api-worker/src/auth/principal.ts:43 (an unprovisioned identity returns no rows)
select * from app.auth_find_staff_by_email('not.provisioned@nov1-upgrade.test');

-- step: sign-in link requested for an unknown address
-- b87e269: apps/api-worker/src/routes/auth.ts:53
-- The hash is a random 64 character hex value, as sha256Hex(newOpaqueToken()) would be.
select app.auth_issue_login_token(
  'nobody.here@nov1-upgrade.test',
  encode(sha256(convert_to(md5(gen_random_uuid()::text), 'UTF8')), 'hex'),
  900,
  gen_random_uuid()::text
) as outcome;

-- step: sign-in lifecycle (issue, redeem, replay, resolve, me, sign out)
-- Fresh tokens for this run. Session-level settings, cleared at the end of the chunk.
-- b87e269: apps/api-worker/src/auth/tokens.ts:2
begin;
select
  set_config('tidegrid_fixture.login_token',
    replace(replace(rtrim(encode(decode(md5(gen_random_uuid()::text) || md5(gen_random_uuid()::text), 'hex'), 'base64'), '='), '+', '-'), '/', '_'),
    false),
  set_config('tidegrid_fixture.session_token',
    replace(replace(rtrim(encode(decode(md5(gen_random_uuid()::text) || md5(gen_random_uuid()::text), 'hex'), 'base64'), '='), '+', '-'), '/', '_'),
    false);
commit;

-- b87e269: apps/api-worker/src/routes/auth.ts:53 (login token ttl 900 seconds, auth.ts:22)
begin;
select app.auth_issue_login_token(
  'owner.one@nov1-upgrade.test',
  encode(sha256(convert_to(current_setting('tidegrid_fixture.login_token'), 'UTF8')), 'hex'),
  900,
  gen_random_uuid()::text
) as outcome;
commit;

-- b87e269: apps/api-worker/src/routes/auth.ts:99 (session ttl 86400 seconds, principal.ts:13)
begin;
select user_id from app.auth_consume_login_token(
  encode(sha256(convert_to(current_setting('tidegrid_fixture.login_token'), 'UTF8')), 'hex'),
  encode(sha256(convert_to(current_setting('tidegrid_fixture.session_token'), 'UTF8')), 'hex'),
  86400,
  gen_random_uuid()::text
);
commit;

-- b87e269: apps/api-worker/src/routes/auth.ts:116
begin;
select * from app.auth_resolve_session(
  encode(sha256(convert_to(current_setting('tidegrid_fixture.session_token'), 'UTF8')), 'hex')
);
commit;

-- Redeeming the same link again returns no rows and records a rejection (the 401 path).
-- b87e269: apps/api-worker/src/routes/auth.ts:99
begin;
select user_id from app.auth_consume_login_token(
  encode(sha256(convert_to(current_setting('tidegrid_fixture.login_token'), 'UTF8')), 'hex'),
  encode(sha256(convert_to(md5(gen_random_uuid()::text), 'UTF8')), 'hex'),
  86400,
  gen_random_uuid()::text
);
commit;

-- b87e269: apps/api-worker/src/auth/principal.ts:66
begin;
select * from app.auth_resolve_session(
  encode(sha256(convert_to(current_setting('tidegrid_fixture.session_token'), 'UTF8')), 'hex')
);
commit;

-- b87e269: apps/api-worker/src/routes/auth.ts:183 (the user id comes from the session lookup)
begin;
select * from app.auth_list_memberships((
  select user_id from app.auth_resolve_session(
    encode(sha256(convert_to(current_setting('tidegrid_fixture.session_token'), 'UTF8')), 'hex')
  )
));
commit;

-- b87e269: apps/api-worker/src/routes/auth.ts:155
begin;
select app.auth_revoke_session(
  encode(sha256(convert_to(current_setting('tidegrid_fixture.session_token'), 'UTF8')), 'hex'),
  gen_random_uuid()::text
);
commit;

-- After sign-out the session no longer resolves.
-- b87e269: apps/api-worker/src/auth/principal.ts:66
begin;
select * from app.auth_resolve_session(
  encode(sha256(convert_to(current_setting('tidegrid_fixture.session_token'), 'UTF8')), 'hex')
);
commit;

begin;
select
  set_config('tidegrid_fixture.login_token', '', false),
  set_config('tidegrid_fixture.session_token', '', false);
commit;

-- step: me memberships for demo staff
-- b87e269: apps/api-worker/src/routes/auth.ts:183 (principal from the Access path)
select * from app.auth_list_memberships(
  (select user_id from app.auth_find_staff_by_email('ava.owner@demo-harbor.test'))
);
-- b87e269: apps/api-worker/src/routes/auth.ts:183 (an owner in both operators)
select * from app.auth_list_memberships(
  (select user_id from app.auth_find_staff_by_email('owner.two@nov1-upgrade.test'))
);

-- step: staff members list, owner.one in Demo Harbor
begin;
-- b87e269: packages/database/src/tenant.ts:43
select nullif(current_setting('app.tenant_id', true), '') as tenant;
-- b87e269: packages/database/src/tenant.ts:49
select
  set_config('app.tenant_id', '7d1e5b3a-1c2f-4a8e-9b61-0a1c2e3f4a01', true),
  set_config('app.actor_type', 'staff', true),
  set_config('app.actor_id', (select user_id::text from app.auth_find_staff_by_email('owner.one@nov1-upgrade.test')), true),
  set_config('app.request_id', gen_random_uuid()::text, true),
  set_config('app.source_ip', '203.0.113.7', true);
-- b87e269: packages/domain-identity/src/members.ts:24
select t.id, t.slug, t.display_name, t.status, m.role
  from tenant_memberships as m
  inner join tenants as t on t.id = m.tenant_id
  where m.tenant_id = '7d1e5b3a-1c2f-4a8e-9b61-0a1c2e3f4a01'
    and t.id = '7d1e5b3a-1c2f-4a8e-9b61-0a1c2e3f4a01'
    and m.user_id = current_setting('app.actor_id')::uuid
    and m.status = 'active';
-- b87e269: packages/domain-identity/src/members.ts:59
select m.user_id, u.email, m.display_name, m.role, m.status, m.created_at
  from tenant_memberships as m
  inner join staff_users as u on u.id = m.user_id
  where m.tenant_id = '7d1e5b3a-1c2f-4a8e-9b61-0a1c2e3f4a01'
  order by m.display_name, m.user_id;
commit;

-- step: staff members list, owner.two in Demo Reef
begin;
-- b87e269: packages/database/src/tenant.ts:43
select nullif(current_setting('app.tenant_id', true), '') as tenant;
-- b87e269: packages/database/src/tenant.ts:49
select
  set_config('app.tenant_id', '7d1e5b3a-1c2f-4a8e-9b61-0a1c2e3f4a02', true),
  set_config('app.actor_type', 'staff', true),
  set_config('app.actor_id', (select user_id::text from app.auth_find_staff_by_email('owner.two@nov1-upgrade.test')), true),
  set_config('app.request_id', gen_random_uuid()::text, true),
  set_config('app.source_ip', '203.0.113.7', true);
-- b87e269: packages/domain-identity/src/members.ts:24
select t.id, t.slug, t.display_name, t.status, m.role
  from tenant_memberships as m
  inner join tenants as t on t.id = m.tenant_id
  where m.tenant_id = '7d1e5b3a-1c2f-4a8e-9b61-0a1c2e3f4a02'
    and t.id = '7d1e5b3a-1c2f-4a8e-9b61-0a1c2e3f4a02'
    and m.user_id = current_setting('app.actor_id')::uuid
    and m.status = 'active';
-- b87e269: packages/domain-identity/src/members.ts:59
select m.user_id, u.email, m.display_name, m.role, m.status, m.created_at
  from tenant_memberships as m
  inner join staff_users as u on u.id = m.user_id
  where m.tenant_id = '7d1e5b3a-1c2f-4a8e-9b61-0a1c2e3f4a02'
  order by m.display_name, m.user_id;
commit;

-- step: staff request for a tenant the account does not belong to (404 path, rolled back)
begin;
-- b87e269: packages/database/src/tenant.ts:43
select nullif(current_setting('app.tenant_id', true), '') as tenant;
-- b87e269: packages/database/src/tenant.ts:49
select
  set_config('app.tenant_id', '7d1e5b3a-1c2f-4a8e-9b61-0a1c2e3f4a02', true),
  set_config('app.actor_type', 'staff', true),
  set_config('app.actor_id', (select user_id::text from app.auth_find_staff_by_email('ava.owner@demo-harbor.test')), true),
  set_config('app.request_id', gen_random_uuid()::text, true),
  set_config('app.source_ip', '203.0.113.7', true);
-- b87e269: packages/domain-identity/src/members.ts:24 (ava.owner has no membership in Demo Reef, so no row)
select t.id, t.slug, t.display_name, t.status, m.role
  from tenant_memberships as m
  inner join tenants as t on t.id = m.tenant_id
  where m.tenant_id = '7d1e5b3a-1c2f-4a8e-9b61-0a1c2e3f4a02'
    and t.id = '7d1e5b3a-1c2f-4a8e-9b61-0a1c2e3f4a02'
    and m.user_id = current_setting('app.actor_id')::uuid
    and m.status = 'active';
rollback;

-- step: staff request by a role without the permission (403 path, rolled back)
begin;
-- b87e269: packages/database/src/tenant.ts:43
select nullif(current_setting('app.tenant_id', true), '') as tenant;
-- b87e269: packages/database/src/tenant.ts:49
select
  set_config('app.tenant_id', '7d1e5b3a-1c2f-4a8e-9b61-0a1c2e3f4a01', true),
  set_config('app.actor_type', 'staff', true),
  set_config('app.actor_id', (select user_id::text from app.auth_find_staff_by_email('ben.desk@demo-harbor.test')), true),
  set_config('app.request_id', gen_random_uuid()::text, true),
  set_config('app.source_ip', '203.0.113.7', true);
-- b87e269: packages/domain-identity/src/members.ts:24 (booking staff loads access, then the permission check fails in TypeScript)
select t.id, t.slug, t.display_name, t.status, m.role
  from tenant_memberships as m
  inner join tenants as t on t.id = m.tenant_id
  where m.tenant_id = '7d1e5b3a-1c2f-4a8e-9b61-0a1c2e3f4a01'
    and t.id = '7d1e5b3a-1c2f-4a8e-9b61-0a1c2e3f4a01'
    and m.user_id = current_setting('app.actor_id')::uuid
    and m.status = 'active';
rollback;

-- step: staff audit history, finance in Demo Harbor
begin;
-- b87e269: packages/database/src/tenant.ts:43
select nullif(current_setting('app.tenant_id', true), '') as tenant;
-- b87e269: packages/database/src/tenant.ts:49
select
  set_config('app.tenant_id', '7d1e5b3a-1c2f-4a8e-9b61-0a1c2e3f4a01', true),
  set_config('app.actor_type', 'staff', true),
  set_config('app.actor_id', (select user_id::text from app.auth_find_staff_by_email('fay.books@demo-harbor.test')), true),
  set_config('app.request_id', gen_random_uuid()::text, true),
  set_config('app.source_ip', '203.0.113.7', true);
-- b87e269: packages/domain-identity/src/members.ts:24
select t.id, t.slug, t.display_name, t.status, m.role
  from tenant_memberships as m
  inner join tenants as t on t.id = m.tenant_id
  where m.tenant_id = '7d1e5b3a-1c2f-4a8e-9b61-0a1c2e3f4a01'
    and t.id = '7d1e5b3a-1c2f-4a8e-9b61-0a1c2e3f4a01'
    and m.user_id = current_setting('app.actor_id')::uuid
    and m.status = 'active';
-- First page: the default limit is 50 and the query asks for one extra row (members.ts:144).
-- b87e269: packages/domain-identity/src/members.ts:127
select id, occurred_at, actor_type, actor_id, request_id, action, subject_type, subject_id, reason, before_state, after_state
  from audit_events
  where tenant_id = '7d1e5b3a-1c2f-4a8e-9b61-0a1c2e3f4a01'
  order by id desc
  limit 51;
-- Next page: a cursor is up to 18 digits (contracts AuditEventQuery).
-- b87e269: packages/domain-identity/src/members.ts:145
select id, occurred_at, actor_type, actor_id, request_id, action, subject_type, subject_id, reason, before_state, after_state
  from audit_events
  where tenant_id = '7d1e5b3a-1c2f-4a8e-9b61-0a1c2e3f4a01'
    and id < '999999999999999999'
  order by id desc
  limit 11;
commit;

-- step: staff add member with idempotency key, then replay (owner.one in Demo Harbor)
-- Fresh address, key, and display name for this run. Session-level settings, cleared at the end of the chunk.
begin;
select
  set_config('tidegrid_fixture.email', 'invitee.' || substr(md5(gen_random_uuid()::text), 1, 12) || '@nov1-upgrade.test', false),
  set_config('tidegrid_fixture.key', 'fixture-' || md5(gen_random_uuid()::text), false),
  set_config('tidegrid_fixture.display_name', 'Invitee ' || substr(md5(gen_random_uuid()::text), 1, 8), false);
-- b87e269: packages/database/src/idempotency.ts:102 and 111 (canonical JSON sorts keys; to_json quotes strings)
-- Text hashed: METHOD, route template, canonical params, canonical body, joined by newlines.
select set_config('tidegrid_fixture.request_hash',
  encode(sha256(convert_to(
    'POST' || E'\n'
    || '/v1/staff/tenants/{tenantId}/members' || E'\n'
    || '{"tenantId":"7d1e5b3a-1c2f-4a8e-9b61-0a1c2e3f4a01"}' || E'\n'
    || '{"displayName":' || to_json(current_setting('tidegrid_fixture.display_name'))::text
    || ',"email":' || to_json(current_setting('tidegrid_fixture.email'))::text
    || ',"reason":"Fixture onboarding","role":"booking_staff"}',
    'UTF8')), 'hex'),
  false);
commit;

-- First request.
begin;
-- b87e269: packages/database/src/tenant.ts:43
select nullif(current_setting('app.tenant_id', true), '') as tenant;
-- b87e269: packages/database/src/tenant.ts:49
select
  set_config('app.tenant_id', '7d1e5b3a-1c2f-4a8e-9b61-0a1c2e3f4a01', true),
  set_config('app.actor_type', 'staff', true),
  set_config('app.actor_id', (select user_id::text from app.auth_find_staff_by_email('owner.one@nov1-upgrade.test')), true),
  set_config('app.request_id', gen_random_uuid()::text, true),
  set_config('app.source_ip', '203.0.113.7', true);
-- b87e269: packages/domain-identity/src/members.ts:24
select t.id, t.slug, t.display_name, t.status, m.role
  from tenant_memberships as m
  inner join tenants as t on t.id = m.tenant_id
  where m.tenant_id = '7d1e5b3a-1c2f-4a8e-9b61-0a1c2e3f4a01'
    and t.id = '7d1e5b3a-1c2f-4a8e-9b61-0a1c2e3f4a01'
    and m.user_id = current_setting('app.actor_id')::uuid
    and m.status = 'active';
-- b87e269: packages/database/src/idempotency.ts:39
insert into idempotency_keys (tenant_id, scope, principal, key, request_hash)
  values ('7d1e5b3a-1c2f-4a8e-9b61-0a1c2e3f4a01', 'members.create',
          'staff:' || current_setting('app.actor_id'),
          current_setting('tidegrid_fixture.key'),
          current_setting('tidegrid_fixture.request_hash'))
  on conflict (tenant_id, scope, principal, key) do nothing
  returning key;
-- The id that ensure_staff_user returns goes into a transaction-local setting so later statements can use it.
-- b87e269: packages/domain-identity/src/members.ts:83
select set_config('tidegrid_fixture.user_id',
  app.ensure_staff_user(current_setting('tidegrid_fixture.email'), current_setting('app.request_id'))::text,
  true) as id;
-- b87e269: packages/domain-identity/src/members.ts:89
insert into tenant_memberships (tenant_id, user_id, role, display_name)
  values ('7d1e5b3a-1c2f-4a8e-9b61-0a1c2e3f4a01',
          current_setting('tidegrid_fixture.user_id')::uuid,
          'booking_staff',
          current_setting('tidegrid_fixture.display_name'))
  on conflict (tenant_id, user_id) do nothing
  returning user_id, role, status, display_name, created_at;
-- b87e269: packages/database/src/audit.ts:26
insert into audit_events (tenant_id, actor_type, actor_id, request_id, source_ip, action, subject_type, subject_id, reason, before_state, after_state)
  values ('7d1e5b3a-1c2f-4a8e-9b61-0a1c2e3f4a01', 'staff',
          current_setting('app.actor_id'), current_setting('app.request_id'), current_setting('app.source_ip'),
          'membership.created', 'staff_user', current_setting('tidegrid_fixture.user_id'),
          'Fixture onboarding', null, '{"role":"booking_staff","status":"active"}');
-- b87e269: packages/database/src/outbox.ts:22
insert into outbox_events (tenant_id, topic, aggregate_type, aggregate_id, payload, request_id)
  values ('7d1e5b3a-1c2f-4a8e-9b61-0a1c2e3f4a01', 'tenant.membership.created', 'tenant_membership',
          current_setting('tidegrid_fixture.user_id'),
          jsonb_build_object('tenantId', '7d1e5b3a-1c2f-4a8e-9b61-0a1c2e3f4a01',
                             'userId', current_setting('tidegrid_fixture.user_id'),
                             'role', 'booking_staff'),
          current_setting('app.request_id'));
-- The stored response is the 201 body: { member: { userId, email, displayName, role, status, createdAt } }.
-- b87e269: packages/database/src/idempotency.ts:82
update idempotency_keys
  set status = 'completed',
      response_status = 201,
      response_body = (
        select jsonb_build_object('member', jsonb_build_object(
                 'userId', m.user_id,
                 'email', current_setting('tidegrid_fixture.email'),
                 'displayName', m.display_name,
                 'role', m.role,
                 'status', m.status,
                 'createdAt', to_char(m.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
          from tenant_memberships m
          where m.tenant_id = '7d1e5b3a-1c2f-4a8e-9b61-0a1c2e3f4a01'
            and m.user_id = current_setting('tidegrid_fixture.user_id')::uuid),
      completed_at = now()
  where tenant_id = '7d1e5b3a-1c2f-4a8e-9b61-0a1c2e3f4a01'
    and scope = 'members.create'
    and principal = 'staff:' || current_setting('app.actor_id')
    and key = current_setting('tidegrid_fixture.key')
    and status = 'in_progress';
commit;

-- Retry with the same key and body: the claim conflicts, the stored response is read, nothing else is written.
begin;
-- b87e269: packages/database/src/tenant.ts:43
select nullif(current_setting('app.tenant_id', true), '') as tenant;
-- b87e269: packages/database/src/tenant.ts:49
select
  set_config('app.tenant_id', '7d1e5b3a-1c2f-4a8e-9b61-0a1c2e3f4a01', true),
  set_config('app.actor_type', 'staff', true),
  set_config('app.actor_id', (select user_id::text from app.auth_find_staff_by_email('owner.one@nov1-upgrade.test')), true),
  set_config('app.request_id', gen_random_uuid()::text, true),
  set_config('app.source_ip', '203.0.113.7', true);
-- b87e269: packages/domain-identity/src/members.ts:24
select t.id, t.slug, t.display_name, t.status, m.role
  from tenant_memberships as m
  inner join tenants as t on t.id = m.tenant_id
  where m.tenant_id = '7d1e5b3a-1c2f-4a8e-9b61-0a1c2e3f4a01'
    and t.id = '7d1e5b3a-1c2f-4a8e-9b61-0a1c2e3f4a01'
    and m.user_id = current_setting('app.actor_id')::uuid
    and m.status = 'active';
-- b87e269: packages/database/src/idempotency.ts:39
insert into idempotency_keys (tenant_id, scope, principal, key, request_hash)
  values ('7d1e5b3a-1c2f-4a8e-9b61-0a1c2e3f4a01', 'members.create',
          'staff:' || current_setting('app.actor_id'),
          current_setting('tidegrid_fixture.key'),
          current_setting('tidegrid_fixture.request_hash'))
  on conflict (tenant_id, scope, principal, key) do nothing
  returning key;
-- b87e269: packages/database/src/idempotency.ts:53
select request_hash, status, response_status, response_body
  from idempotency_keys
  where tenant_id = '7d1e5b3a-1c2f-4a8e-9b61-0a1c2e3f4a01'
    and scope = 'members.create'
    and principal = 'staff:' || current_setting('app.actor_id')
    and key = current_setting('tidegrid_fixture.key');
commit;

begin;
select
  set_config('tidegrid_fixture.email', '', false),
  set_config('tidegrid_fixture.key', '', false),
  set_config('tidegrid_fixture.display_name', '', false),
  set_config('tidegrid_fixture.request_hash', '', false);
commit;

-- step: staff add member that already exists (409 path, rolled back)
begin;
-- b87e269: packages/database/src/tenant.ts:43
select nullif(current_setting('app.tenant_id', true), '') as tenant;
-- b87e269: packages/database/src/tenant.ts:49
select
  set_config('app.tenant_id', '7d1e5b3a-1c2f-4a8e-9b61-0a1c2e3f4a01', true),
  set_config('app.actor_type', 'staff', true),
  set_config('app.actor_id', (select user_id::text from app.auth_find_staff_by_email('owner.one@nov1-upgrade.test')), true),
  set_config('app.request_id', gen_random_uuid()::text, true),
  set_config('app.source_ip', '203.0.113.7', true);
-- b87e269: packages/domain-identity/src/members.ts:24
select t.id, t.slug, t.display_name, t.status, m.role
  from tenant_memberships as m
  inner join tenants as t on t.id = m.tenant_id
  where m.tenant_id = '7d1e5b3a-1c2f-4a8e-9b61-0a1c2e3f4a01'
    and t.id = '7d1e5b3a-1c2f-4a8e-9b61-0a1c2e3f4a01'
    and m.user_id = current_setting('app.actor_id')::uuid
    and m.status = 'active';
-- A fresh key, so the claim inserts; the rollback below releases it, as the API does when it throws.
-- b87e269: packages/database/src/idempotency.ts:39
insert into idempotency_keys (tenant_id, scope, principal, key, request_hash)
  values ('7d1e5b3a-1c2f-4a8e-9b61-0a1c2e3f4a01', 'members.create',
          'staff:' || current_setting('app.actor_id'),
          'fixture-' || md5(gen_random_uuid()::text),
          encode(sha256(convert_to(md5(gen_random_uuid()::text), 'UTF8')), 'hex'))
  on conflict (tenant_id, scope, principal, key) do nothing
  returning key;
-- b87e269: packages/domain-identity/src/members.ts:83 (an existing identity: no new row, no security event)
select app.ensure_staff_user('ben.desk@demo-harbor.test', current_setting('app.request_id')) as id;
-- b87e269: packages/domain-identity/src/members.ts:89 (the membership exists, so the insert returns no row)
insert into tenant_memberships (tenant_id, user_id, role, display_name)
  select '7d1e5b3a-1c2f-4a8e-9b61-0a1c2e3f4a01', app.ensure_staff_user('ben.desk@demo-harbor.test', current_setting('app.request_id')), 'booking_staff', 'Ben Desk'
  on conflict (tenant_id, user_id) do nothing
  returning user_id, role, status, display_name, created_at;
rollback;
