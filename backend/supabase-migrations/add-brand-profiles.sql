-- Per-company brand profile (domains + verified facts) used by GEO scoring
-- and the AEO judge's accuracy check.

create table if not exists public.brand_profiles (
  company_id  uuid not null references public.companies(id) on delete cascade,
  brand       text not null,
  domains     text[] not null default '{}',
  facts       text not null default '',
  updated_by  uuid references auth.users(id),
  updated_at  timestamptz not null default now(),
  primary key (company_id, brand)
);

create index if not exists brand_profiles_company_id_idx
  on public.brand_profiles (company_id);

alter table public.brand_profiles enable row level security;

-- Only used via service_role from the API; lock everything down by default.
drop policy if exists brand_profiles_read_self on public.brand_profiles;
create policy brand_profiles_read_self on public.brand_profiles
  for select
  using (
    company_id in (
      select cm.company_id
      from public.company_members cm
      where cm.user_id = auth.uid()
    )
  );
