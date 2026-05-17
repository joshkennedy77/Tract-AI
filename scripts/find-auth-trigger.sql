-- Diagnose the trigger that's blocking user creation, and print the exact
-- DROP statement you need to run.
--
-- Run in Supabase SQL Editor.
-- If the function is in `public` schema you OWN it and the DROP will work.
-- If it's in `auth` or another protected schema, you can't DROP it from
-- SQL Editor — open a Supabase support request to remove it.

select
  t.tgname                                                    as trigger_name,
  n.nspname || '.' || p.proname || '()'                       as function_to_drop,
  format(
    'drop function %I.%I() cascade;  -- removes the trigger too',
    n.nspname, p.proname
  )                                                           as drop_command,
  pg_get_triggerdef(t.oid)                                    as full_trigger_def,
  pg_get_functiondef(t.tgfoid)                                as function_body
from pg_trigger t
join pg_proc      p on p.oid = t.tgfoid
join pg_namespace n on n.oid = p.pronamespace
where t.tgrelid = 'auth.users'::regclass
  and not t.tgisinternal;
