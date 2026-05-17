-- Base table for Tract scan results. Run this BEFORE the other migrations
-- (add-comparison-id.sql, add-scan-sources.sql), or just run this file alone
-- since it already includes their columns.
--
-- Run in: Supabase Studio → SQL Editor → paste → Run.

create extension if not exists "pgcrypto";

create table if not exists public.scans (
  id              bigserial primary key,
  scan_id         uuid          not null,
  comparison_id   uuid,
  brand           text          not null,
  engine          text          not null,
  prompt          text          not null,
  response        text          not null,
  brand_mentioned boolean       not null default false,
  sentiment       text,
  competitors_mentioned jsonb   not null default '[]'::jsonb,
  source_count    integer       not null default 0,
  sources         jsonb         not null default '[]'::jsonb,
  created_at      timestamptz   not null default now()
);

create index if not exists scans_created_at_idx    on public.scans (created_at desc);
create index if not exists scans_scan_id_idx       on public.scans (scan_id);
create index if not exists scans_comparison_id_idx on public.scans (comparison_id);
create index if not exists scans_brand_idx         on public.scans (brand);
create index if not exists scans_engine_idx        on public.scans (engine);

-- The API uses the service_role key (bypasses RLS). If you want to enable RLS
-- later, add policies before turning it on:
--   alter table public.scans enable row level security;
