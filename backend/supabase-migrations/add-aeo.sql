-- Adds AEO judge output to public.scans.
-- Safe to re-run.

alter table public.scans
  add column if not exists intent        text,
  add column if not exists aeo_analysis  jsonb not null default '{}'::jsonb,
  add column if not exists aeo_score     integer,
  add column if not exists aeo_error     text;

create index if not exists scans_intent_idx     on public.scans (intent);
create index if not exists scans_aeo_score_idx  on public.scans (aeo_score);
