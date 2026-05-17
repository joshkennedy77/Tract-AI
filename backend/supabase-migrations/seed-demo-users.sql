-- DEMO USER SEED — for local testing only.
--
-- Creates three users, one company, and the role wiring you need to exercise
-- every PR-1..PR-3 flow without going through the Supabase Auth UI (which is
-- blocked by a stale trigger on auth.users in this project).
--
-- Run in Supabase SQL Editor AFTER auth-tenancy.sql.
-- Idempotent: re-running won't duplicate rows.
--
-- Credentials (password is the same for all three: demo1234):
--   super@demo.tract     → Tract superadmin + admin of "Acme Inc Demo"
--   admin@acme.demo      → admin of "Acme Inc Demo"
--   employee@acme.demo   → employee of "Acme Inc Demo"
--
-- Why SET ROLE: the auth.* tables are owned by `supabase_auth_admin`, and
-- the SQL Editor's default role can't INSERT into them or ALTER their
-- triggers. We switch role for the auth.* writes, then reset for public.*.
--
-- We don't disable any triggers: the existing `AFTER UPDATE` trigger on
-- auth.users only fires on UPDATE, and this script never updates rows.

-- ------ Preflight --------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'companies'
  ) then
    raise exception 'Run auth-tenancy.sql first — public.companies is missing.';
  end if;
end $$;

create extension if not exists pgcrypto;

-- ------ auth.users + auth.identities (run as supabase_auth_admin) --------
set role supabase_auth_admin;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change
)
values
  ('00000000-0000-0000-0000-000000000000',
   '00000001-0000-0000-0000-000000000001',
   'authenticated', 'authenticated',
   'super@demo.tract', crypt('demo1234', gen_salt('bf', 10)),
   now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
   now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000',
   '00000002-0000-0000-0000-000000000002',
   'authenticated', 'authenticated',
   'admin@acme.demo', crypt('demo1234', gen_salt('bf', 10)),
   now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
   now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000',
   '00000003-0000-0000-0000-000000000003',
   'authenticated', 'authenticated',
   'employee@acme.demo', crypt('demo1234', gen_salt('bf', 10)),
   now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
   now(), now(), '', '', '', '')
on conflict (id) do nothing;

insert into auth.identities (
  user_id, provider, provider_id, identity_data,
  last_sign_in_at, created_at, updated_at
)
values
  ('00000001-0000-0000-0000-000000000001', 'email',
   '00000001-0000-0000-0000-000000000001',
   jsonb_build_object('sub', '00000001-0000-0000-0000-000000000001',
                      'email', 'super@demo.tract',
                      'email_verified', true, 'phone_verified', false),
   now(), now(), now()),
  ('00000002-0000-0000-0000-000000000002', 'email',
   '00000002-0000-0000-0000-000000000002',
   jsonb_build_object('sub', '00000002-0000-0000-0000-000000000002',
                      'email', 'admin@acme.demo',
                      'email_verified', true, 'phone_verified', false),
   now(), now(), now()),
  ('00000003-0000-0000-0000-000000000003', 'email',
   '00000003-0000-0000-0000-000000000003',
   jsonb_build_object('sub', '00000003-0000-0000-0000-000000000003',
                      'email', 'employee@acme.demo',
                      'email_verified', true, 'phone_verified', false),
   now(), now(), now())
on conflict (provider_id, provider) do nothing;

reset role;

-- ------ public.companies / company_members / tract_staff -----------------
do $$
declare
  super_id constant uuid := '00000001-0000-0000-0000-000000000001';
  admin_id constant uuid := '00000002-0000-0000-0000-000000000002';
  emp_id   constant uuid := '00000003-0000-0000-0000-000000000003';
  acme_id  uuid;
begin
  insert into public.companies (name, slug, created_by)
  values ('Acme Inc Demo', 'acme-inc-demo', super_id)
  on conflict (slug) do nothing;

  select id into acme_id from public.companies where slug = 'acme-inc-demo' limit 1;

  insert into public.company_members (company_id, user_id, role, invited_by)
  values
    (acme_id, super_id, 'admin',    super_id),
    (acme_id, admin_id, 'admin',    super_id),
    (acme_id, emp_id,   'employee', super_id)
  on conflict (company_id, user_id) do nothing;

  insert into public.tract_staff (user_id, role)
  values (super_id, 'superadmin')
  on conflict (user_id) do nothing;

  raise notice '';
  raise notice '----------------------------------------------------------';
  raise notice 'Demo users ready. Password for all three: demo1234';
  raise notice '----------------------------------------------------------';
  raise notice '  super@demo.tract     Tract superadmin + admin of Acme';
  raise notice '  admin@acme.demo      admin of Acme Inc Demo';
  raise notice '  employee@acme.demo   employee of Acme Inc Demo';
  raise notice '----------------------------------------------------------';
end $$;
