-- Groups rows from one multi-brand Run Audit (each brand still has its own scan_id).
alter table public.scans
  add column if not exists comparison_id uuid;

create index if not exists scans_comparison_id_idx on public.scans (comparison_id);
