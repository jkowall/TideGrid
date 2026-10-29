-- seed-0002-era.sql
--
-- What this is: the rows that the deployed build b87e269 (2026-09-24) wrote to
-- the database when its deterministic seed (tools/seed/src/seed.ts) ran with
-- SEED_OWNER_EMAILS=owner.one@nov1-upgrade.test,owner.two@nov1-upgrade.test.
-- Two demo operators with preview hostnames, four demo staff, and two owner
-- addresses that hold owner memberships in both operators.
--
-- Derived from: b87e269 tools/seed/src/seed.ts:62-91. Same ids, slugs, display
-- names, hostnames, roles, and "on conflict do nothing" semantics. Owner display
-- names are the address local parts, as that seed does.
--
-- How it is used: the upgrade-path integration test runs this file once, as the
-- admin role, in one simple-query call, after migrations 0001 and 0002 and
-- before any later migration. It contains begin and commit and no psql
-- meta-commands.
--
-- Data: synthetic only. Every address ends in .test, which is reserved and
-- undeliverable. No customer data, no credentials.

begin;

-- b87e269: tools/seed/src/seed.ts:63-68
insert into public.tenants (id, slug, display_name)
  values ('7d1e5b3a-1c2f-4a8e-9b61-0a1c2e3f4a01', 'demo-harbor', 'Demo Harbor Charters')
  on conflict (id) do nothing;
insert into public.tenant_hostnames (hostname, tenant_id, kind, status, verified_at)
  values ('demo-harbor.book.tidegrid.us', '7d1e5b3a-1c2f-4a8e-9b61-0a1c2e3f4a01', 'preview', 'active', now())
  on conflict (hostname) do nothing;

insert into public.tenants (id, slug, display_name)
  values ('7d1e5b3a-1c2f-4a8e-9b61-0a1c2e3f4a02', 'demo-reef', 'Demo Reef Divers')
  on conflict (id) do nothing;
insert into public.tenant_hostnames (hostname, tenant_id, kind, status, verified_at)
  values ('demo-reef.book.tidegrid.us', '7d1e5b3a-1c2f-4a8e-9b61-0a1c2e3f4a02', 'preview', 'active', now())
  on conflict (hostname) do nothing;

-- b87e269: tools/seed/src/seed.ts:35-40 and 78-89 (demo staff, one tenant each)
insert into public.staff_users (email, display_name)
  values ('ava.owner@demo-harbor.test', 'Ava Owner') on conflict (email) do nothing;
insert into public.tenant_memberships (tenant_id, user_id, role, display_name)
  select '7d1e5b3a-1c2f-4a8e-9b61-0a1c2e3f4a01', u.id, 'owner', 'Ava Owner'
    from public.staff_users u where u.email = 'ava.owner@demo-harbor.test'
  on conflict do nothing;

insert into public.staff_users (email, display_name)
  values ('ben.desk@demo-harbor.test', 'Ben Desk') on conflict (email) do nothing;
insert into public.tenant_memberships (tenant_id, user_id, role, display_name)
  select '7d1e5b3a-1c2f-4a8e-9b61-0a1c2e3f4a01', u.id, 'booking_staff', 'Ben Desk'
    from public.staff_users u where u.email = 'ben.desk@demo-harbor.test'
  on conflict do nothing;

insert into public.staff_users (email, display_name)
  values ('fay.books@demo-harbor.test', 'Fay Books') on conflict (email) do nothing;
insert into public.tenant_memberships (tenant_id, user_id, role, display_name)
  select '7d1e5b3a-1c2f-4a8e-9b61-0a1c2e3f4a01', u.id, 'finance', 'Fay Books'
    from public.staff_users u where u.email = 'fay.books@demo-harbor.test'
  on conflict do nothing;

insert into public.staff_users (email, display_name)
  values ('cara.owner@demo-reef.test', 'Cara Owner') on conflict (email) do nothing;
insert into public.tenant_memberships (tenant_id, user_id, role, display_name)
  select '7d1e5b3a-1c2f-4a8e-9b61-0a1c2e3f4a02', u.id, 'owner', 'Cara Owner'
    from public.staff_users u where u.email = 'cara.owner@demo-reef.test'
  on conflict do nothing;

-- b87e269: tools/seed/src/seed.ts:42-45 and 71-89 (owner addresses from
-- SEED_OWNER_EMAILS, owner role in both operators, display name is the local part)
insert into public.staff_users (email, display_name)
  values ('owner.one@nov1-upgrade.test', 'owner.one') on conflict (email) do nothing;
insert into public.tenant_memberships (tenant_id, user_id, role, display_name)
  select '7d1e5b3a-1c2f-4a8e-9b61-0a1c2e3f4a01', u.id, 'owner', 'owner.one'
    from public.staff_users u where u.email = 'owner.one@nov1-upgrade.test'
  on conflict do nothing;
insert into public.tenant_memberships (tenant_id, user_id, role, display_name)
  select '7d1e5b3a-1c2f-4a8e-9b61-0a1c2e3f4a02', u.id, 'owner', 'owner.one'
    from public.staff_users u where u.email = 'owner.one@nov1-upgrade.test'
  on conflict do nothing;

insert into public.staff_users (email, display_name)
  values ('owner.two@nov1-upgrade.test', 'owner.two') on conflict (email) do nothing;
insert into public.tenant_memberships (tenant_id, user_id, role, display_name)
  select '7d1e5b3a-1c2f-4a8e-9b61-0a1c2e3f4a01', u.id, 'owner', 'owner.two'
    from public.staff_users u where u.email = 'owner.two@nov1-upgrade.test'
  on conflict do nothing;
insert into public.tenant_memberships (tenant_id, user_id, role, display_name)
  select '7d1e5b3a-1c2f-4a8e-9b61-0a1c2e3f4a02', u.id, 'owner', 'owner.two'
    from public.staff_users u where u.email = 'owner.two@nov1-upgrade.test'
  on conflict do nothing;

commit;
