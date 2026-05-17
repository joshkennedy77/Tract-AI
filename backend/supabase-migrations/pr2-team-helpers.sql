-- PR-2: helpers for the company-admin Team view.
--
-- The auth schema isn't exposed through PostgREST, so we expose two
-- SECURITY DEFINER functions in public that read auth.users for us.
-- Only the service-role key is used to call them; anon/authenticated are
-- revoked below.
--
-- Run AFTER auth-tenancy.sql.

create or replace function public.find_user_by_email(p_email text)
returns table (id uuid, email text)
language sql
security definer
set search_path = ''
as $$
  select u.id, u.email
  from auth.users u
  where lower(u.email) = lower(p_email)
  limit 1;
$$;

create or replace function public.company_member_emails(p_company_id uuid)
returns table (
  id          uuid,
  user_id     uuid,
  role        text,
  joined_at   timestamptz,
  invited_by  uuid,
  email       text
)
language sql
security definer
set search_path = ''
as $$
  select cm.id, cm.user_id, cm.role, cm.joined_at, cm.invited_by, u.email
  from public.company_members cm
  left join auth.users u on u.id = cm.user_id
  where cm.company_id = p_company_id
  order by cm.joined_at asc;
$$;

revoke all on function public.find_user_by_email(text)             from public, anon, authenticated;
revoke all on function public.company_member_emails(uuid)          from public, anon, authenticated;
-- service_role retains EXECUTE by default; this is what the API uses.
