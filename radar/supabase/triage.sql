-- Cross-device triage sync for the Veritas Research Radar dashboard (roadmap 1.2).
--
-- Problem: triage state lived in three non-syncing places — the local server's
-- local-state.json, the laptop browser's localStorage, and the phone browser's
-- localStorage. This gives all three one shared store in Supabase.
--
-- Security model: the dashboard ships a PUBLIC anon key, so the triage table is
-- NOT exposed to it directly (RLS denies all, grants revoked). Instead the anon
-- role may call only two SECURITY DEFINER functions, both gated by a secret
-- sync token you generate and store once per device (Settings → Sync on the
-- dashboard). Without the token, the anon key can neither read nor write triage.
--
-- SETUP (run once, in the Supabase SQL editor for project nawbdsujjysugaisczta):
--   1. Run this whole file.
--   2. Generate a long random token and store it:
--        insert into private_sync (token) values ('PASTE_A_LONG_RANDOM_STRING');
--      (e.g. `openssl rand -hex 32`)
--   3. On each device, open the dashboard → Settings → Sync, paste the token.

-- One-row private table holding the shared secret. Never exposed via PostgREST.
create table if not exists private_sync (
  id int primary key default 1,
  token text not null,
  constraint private_sync_single_row check (id = 1)
);

-- The shared triage store: one row per job.
create table if not exists triage (
  job_id text primary key,
  status text not null,
  note text,
  applied_at timestamptz,
  updated_at timestamptz not null default now()
);

-- Lock both tables: RLS on with no policies denies all direct access; the
-- SECURITY DEFINER functions below are the only way in. Revoke table grants too.
alter table private_sync enable row level security;
alter table triage enable row level security;
revoke all on private_sync from anon, authenticated;
revoke all on triage from anon, authenticated;

-- Token check — SECURITY DEFINER so it can read the locked private_sync table.
create or replace function check_sync_token(p_token text)
returns boolean
language sql
security definer
stable
as $$
  select exists (select 1 from private_sync where token = p_token);
$$;

-- Read the full triage set, gated by the token.
create or replace function radar_get_triage(p_token text)
returns setof triage
language plpgsql
security definer
stable
as $$
begin
  if not check_sync_token(p_token) then
    raise exception 'invalid sync token';
  end if;
  return query select * from triage;
end;
$$;

-- Upsert a batch of triage rows (the client pushes its whole set), gated by the
-- token. Last-write-wins: the client has already merged by updated_at.
create or replace function radar_upsert_triage(p_token text, p_rows jsonb)
returns void
language plpgsql
security definer
as $$
begin
  if not check_sync_token(p_token) then
    raise exception 'invalid sync token';
  end if;
  insert into triage (job_id, status, note, applied_at, updated_at)
  select
    (r->>'job_id')::text,
    (r->>'status')::text,
    nullif(r->>'note', '')::text,
    nullif(r->>'applied_at', '')::timestamptz,
    coalesce(nullif(r->>'updated_at', '')::timestamptz, now())
  from jsonb_array_elements(p_rows) as r
  on conflict (job_id) do update set
    status = excluded.status,
    note = excluded.note,
    applied_at = excluded.applied_at,
    updated_at = excluded.updated_at;
end;
$$;

-- Expose ONLY these two RPCs to the dashboard's anon role. check_sync_token is
-- internal (called by the definer functions) and is intentionally not granted.
grant execute on function radar_get_triage(text) to anon;
grant execute on function radar_upsert_triage(text, jsonb) to anon;
