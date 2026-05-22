-- Adds GEO (Generative Engine Optimization) output to public.scans.
-- Safe to re-run.

alter table public.scans
  add column if not exists geo_analysis  jsonb not null default '{}'::jsonb,
  add column if not exists geo_score     integer;

create index if not exists scans_geo_score_idx on public.scans (geo_score);
