-- Run in Supabase SQL editor (or psql) once so inserts from save.js succeed.
-- Required when PERSIST_SCANS=true.

alter table public.scans
  add column if not exists source_count integer not null default 0;

alter table public.scans
  add column if not exists sources jsonb not null default '[]'::jsonb;
