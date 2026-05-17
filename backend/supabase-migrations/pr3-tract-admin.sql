-- PR-3: helper for the Tract-internal companies dashboard.
--
-- Returns one row per company with aggregated member + scan counts so the
-- admin UI can render a single table without N+1 queries.
--
-- Run AFTER auth-tenancy.sql.

create or replace function public.tract_companies_overview()
returns table (
  id              uuid,
  name            text,
  slug            text,
  plan            text,
  created_at      timestamptz,
  deactivated_at  timestamptz,
  created_by      uuid,
  member_count    bigint,
  scan_count      bigint,
  last_activity   timestamptz
)
language sql
security definer
set search_path = ''
as $$
  select
    c.id,
    c.name,
    c.slug,
    c.plan,
    c.created_at,
    c.deactivated_at,
    c.created_by,
    coalesce(m.cnt, 0)  as member_count,
    coalesce(s.cnt, 0)  as scan_count,
    s.last_activity
  from public.companies c
  left join (
    select company_id, count(*)::bigint as cnt
    from public.company_members
    group by company_id
  ) m on m.company_id = c.id
  left join (
    select company_id, count(*)::bigint as cnt, max(created_at) as last_activity
    from public.scans
    where company_id is not null
    group by company_id
  ) s on s.company_id = c.id
  order by c.created_at desc;
$$;

revoke all on function public.tract_companies_overview() from public, anon, authenticated;
-- service_role retains EXECUTE by default.
