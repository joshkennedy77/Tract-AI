-- Multi-tenant identity for Tract-AI.
--
-- Order of migrations (run in Supabase SQL Editor):
--   1. create-scans.sql
--   2. add-comparison-id.sql        (optional — auth-tenancy.sql does not need it)
--   3. add-scan-sources.sql         (optional — same)
--   4. auth-tenancy.sql             (this file)
--
-- Isolation model:
--   App-enforced via server.js — every /api/scan, /api/scans, /api/stats
--   filters by company_id from the caller's JWT. RLS policies are defined
--   below but DISABLED. To flip to RLS-enforced later: (a) make the API
--   forward the caller's JWT to a per-request Supabase client instead of
--   using service-role, (b) `alter table ... enable row level security`.

create extension if not exists "pgcrypto";

-- One row per enterprise customer.
create table if not exists public.companies (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  slug            text unique,
  plan            text not null default 'free',
  created_at      timestamptz not null default now(),
  created_by      uuid references auth.users(id),
  deactivated_at  timestamptz
);

-- Membership + role inside a company.
create table if not exists public.company_members (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  role        text not null check (role in ('admin','employee')),
  invited_by  uuid references auth.users(id),
  joined_at   timestamptz not null default now(),
  unique (company_id, user_id)
);
create index if not exists company_members_user_id_idx    on public.company_members(user_id);
create index if not exists company_members_company_id_idx on public.company_members(company_id);

-- Who at Tract can provision/manage companies.
-- Seed manually in Supabase Studio after you sign up:
--   insert into public.tract_staff (user_id, role)
--   values ('<your-auth.users-id>', 'superadmin');
create table if not exists public.tract_staff (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  role       text not null check (role in ('superadmin','support')),
  created_at timestamptz not null default now()
);

-- Tenant columns on scans.
alter table public.scans
  add column if not exists company_id uuid references public.companies(id),
  add column if not exists created_by uuid references auth.users(id);
create index if not exists scans_company_id_idx on public.scans(company_id);

-- ---------------------------------------------------------------------------
-- RLS policies (DISABLED for now — app-enforced via service-role + company_id
-- filtering in server.js). Drop-then-create makes this file idempotent.
-- ---------------------------------------------------------------------------

drop policy if exists scans_select_own_company on public.scans;
create policy scans_select_own_company on public.scans
  for select
  using (
    company_id in (
      select company_id from public.company_members where user_id = auth.uid()
    )
    or exists (select 1 from public.tract_staff where user_id = auth.uid())
  );

drop policy if exists scans_insert_own_company on public.scans;
create policy scans_insert_own_company on public.scans
  for insert
  with check (
    company_id in (
      select company_id from public.company_members where user_id = auth.uid()
    )
    or exists (select 1 from public.tract_staff where user_id = auth.uid())
  );

drop policy if exists companies_select_member on public.companies;
create policy companies_select_member on public.companies
  for select
  using (
    id in (select company_id from public.company_members where user_id = auth.uid())
    or exists (select 1 from public.tract_staff where user_id = auth.uid())
  );

drop policy if exists company_members_select_self on public.company_members;
create policy company_members_select_self on public.company_members
  for select
  using (
    company_id in (
      select m.company_id from public.company_members m where m.user_id = auth.uid()
    )
    or exists (select 1 from public.tract_staff where user_id = auth.uid())
  );

-- When ready to enforce in the database:
--   alter table public.scans            enable row level security;
--   alter table public.companies        enable row level security;
--   alter table public.company_members  enable row level security;
