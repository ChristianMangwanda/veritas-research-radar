-- Veritas Research Radar — Supabase schema (Stage 4)
-- Jobs are public data by design (public ATS feeds + government datasets);
-- anon gets read-only SELECT, all writes go through the service role from CI.
-- Triage/funnel state intentionally NOT here yet (stays local in v1).

create table if not exists public.jobs (
  id text primary key,
  employer_id text not null,
  employer_name text,
  title text,
  title_class text,
  department text,
  location text,
  url text,
  description_text text,
  veritas_state text,
  sponsor_signal text,
  research_relevance_score integer,
  cap_exempt_status text,
  cap_exempt_score integer,
  class_evidence jsonb,
  citizenship_gated boolean not null default false,
  source text,
  status text not null default 'active',
  first_seen_at timestamptz,
  last_seen_at timestamptz,
  closed_at timestamptz,
  posted_or_updated_at timestamptz,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);

create index if not exists jobs_status_gated_idx on public.jobs (status, citizenship_gated);
create index if not exists jobs_employer_idx on public.jobs (employer_id);
create index if not exists jobs_first_seen_idx on public.jobs (first_seen_at desc);
create index if not exists jobs_updated_idx on public.jobs (updated_at);

alter table public.jobs enable row level security;

drop policy if exists "public read access" on public.jobs;
create policy "public read access" on public.jobs
  for select to anon, authenticated
  using (true);

-- No insert/update/delete policies: writes require the service role.

create table if not exists public.refresh_runs (
  id bigint generated always as identity primary key,
  refreshed_at timestamptz not null,
  report jsonb not null,
  created_at timestamptz not null default now()
);

alter table public.refresh_runs enable row level security;

drop policy if exists "public read access" on public.refresh_runs;
create policy "public read access" on public.refresh_runs
  for select to anon, authenticated
  using (true);
