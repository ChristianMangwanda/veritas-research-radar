-- Veritas Research Radar — private state, owned by one authenticated user.
--
-- schema.sql holds the public half: jobs and refresh_runs, readable by anon
-- because they are public data by design. This file holds everything that is
-- NOT public — the profile document, the judgments bought from the model, and
-- the triage state — which until now lived on one laptop and was private for
-- the cheapest possible reason: nobody else could reach the disk.
--
-- Hosting the dashboard means that reason disappears. These four tables are the
-- replacement, and they are gated by Supabase Auth rather than by a shared
-- secret. An earlier design (radar/supabase/triage.sql, never applied) tried
-- the secret route with SECURITY DEFINER RPCs, because the page ships a public
-- anon key and there was no user to attach a row to. There is one now.
--
-- APPLY THIS ONCE, in the Supabase SQL editor, AFTER creating the user:
--   Authentication -> Sign In/Up -> enable Email, DISABLE new signups
--   Authentication -> Users -> Add user (auto-confirm)
--
-- SINGLE-USER ASSUMPTION: triage and match_cache use `using (true)` for the
-- authenticated role rather than an ownership predicate. That is safe only
-- while signups stay disabled and exactly one user exists. profile_documents
-- and user_state DO carry the ownership predicate — it costs nothing there and
-- means the two tables holding identity are correct by construction.

-- ---------------------------------------------------------------------------
-- 0. Remove the token design this replaces.
--    Safe to run whether or not triage.sql was ever applied — it never was, but
--    a half-applied state should not block this file.
-- ---------------------------------------------------------------------------

drop function if exists public.radar_get_triage(text);
drop function if exists public.radar_upsert_triage(text, jsonb);
drop function if exists public.check_sync_token(text);
drop table if exists public.private_sync;

-- ---------------------------------------------------------------------------
-- 1. profile_documents — the markdown IS the row.
--    Not a parsed profile: the document is the source of truth, and both the
--    browser and the judge parse it with radar/public/profile-doc.js. Storing
--    the parse would create a second parser and a second answer.
-- ---------------------------------------------------------------------------

create table if not exists public.profile_documents (
  user_id uuid primary key references auth.users (id) on delete cascade,
  content text not null,
  updated_at timestamptz not null default now()
);

alter table public.profile_documents enable row level security;

drop policy if exists "own profile select" on public.profile_documents;
create policy "own profile select" on public.profile_documents
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "own profile insert" on public.profile_documents;
create policy "own profile insert" on public.profile_documents
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

-- UPDATE needs both USING (which rows may be updated) and WITH CHECK (what they
-- may be updated to). With only USING, a rewrite of user_id would pass.
drop policy if exists "own profile update" on public.profile_documents;
create policy "own profile update" on public.profile_documents
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------------
-- 2. match_cache — judgments bought from the model.
--    The primary key is the cache key that already exists on disk:
--    (job content hash, profile hash). Both are fnv1a strings computed by
--    radar/public/scoring.js in whichever runtime asks, so the browser, the
--    Vercel function and the Actions job all address the same row.
--
--    NO foreign key to jobs.id — deliberately. refresh's syncJobs ends with
--    `DELETE FROM jobs WHERE updated_at < <this run>`, so a posting that ages
--    out disappears; an FK would cascade that deletion into judgments we paid
--    for and might want again when the posting reappears. job_id is carried as
--    a plain informational column instead.
-- ---------------------------------------------------------------------------

create table if not exists public.match_cache (
  job_hash text not null,
  profile_hash text not null,
  job_id text,
  verdict text not null,
  different_profession boolean not null,
  meets_requirements boolean not null,
  matches_preferences boolean not null,
  role_summary text,
  reasons jsonb not null default '[]'::jsonb,
  gaps jsonb not null default '[]'::jsonb,
  judged_at timestamptz not null,
  model text,
  primary key (job_hash, profile_hash)
);

-- The dashboard reads one profile_hash at a time and polls for rows newer than
-- its cursor; this index serves both halves of that query.
create index if not exists match_cache_profile_judged_idx
  on public.match_cache (profile_hash, judged_at);

alter table public.match_cache enable row level security;

drop policy if exists "authenticated read" on public.match_cache;
create policy "authenticated read" on public.match_cache
  for select to authenticated
  using (true);

-- No write policies. Judgments are written only by the service role — the
-- Vercel function and the Actions job — because writing one means having spent
-- money at the API, and the browser never holds that key.

-- ---------------------------------------------------------------------------
-- 3. triage — where each posting stands.
--    Per-row rather than the single whole-document blob the local server wrote,
--    so two devices touching different jobs cannot clobber each other.
-- ---------------------------------------------------------------------------

create table if not exists public.triage (
  job_id text primary key,
  status text not null,
  note text,
  applied_at timestamptz,
  -- Kept from the earlier design: the dashboard no longer writes it, but rows
  -- imported from local-state.json may carry it and dropping the column would
  -- lose that history silently.
  variant_sent text,
  updated_at timestamptz not null default now()
);

alter table public.triage enable row level security;

drop policy if exists "authenticated select" on public.triage;
create policy "authenticated select" on public.triage
  for select to authenticated using (true);

drop policy if exists "authenticated insert" on public.triage;
create policy "authenticated insert" on public.triage
  for insert to authenticated with check (true);

drop policy if exists "authenticated update" on public.triage;
create policy "authenticated update" on public.triage
  for update to authenticated using (true) with check (true);

-- DELETE is needed for undo: restoring a job to "never triaged" is a different
-- state from "triaged as new", and the row has to actually go.
drop policy if exists "authenticated delete" on public.triage;
create policy "authenticated delete" on public.triage
  for delete to authenticated using (true);

-- ---------------------------------------------------------------------------
-- 4. user_state — the small per-user settings that are not triage.
-- ---------------------------------------------------------------------------

create table if not exists public.user_state (
  user_id uuid primary key references auth.users (id) on delete cascade,
  ignored_employers jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.user_state enable row level security;

drop policy if exists "own state select" on public.user_state;
create policy "own state select" on public.user_state
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "own state insert" on public.user_state;
create policy "own state insert" on public.user_state
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "own state update" on public.user_state;
create policy "own state update" on public.user_state
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------------
-- 5. Grants, stated explicitly.
--    schema.sql grants nothing and relies on the project's default privileges
--    for new tables in `public`, with RLS as the only real gate. That works,
--    but it means the security of these four tables would depend on a project
--    setting nobody in this repo can see. State it here instead.
-- ---------------------------------------------------------------------------

revoke all on public.profile_documents from anon;
revoke all on public.match_cache from anon;
revoke all on public.triage from anon;
revoke all on public.user_state from anon;

grant select, insert, update on public.profile_documents to authenticated;
grant select on public.match_cache to authenticated;
grant select, insert, update, delete on public.triage to authenticated;
grant select, insert, update on public.user_state to authenticated;

-- Verify after applying (expect permission denied for the anon key on all four,
-- and rows for a signed-in user):
--   curl -s "$SUPABASE_URL/rest/v1/triage?select=job_id&limit=1" -H "apikey: $ANON"
--   curl -s "$SUPABASE_URL/rest/v1/triage?select=job_id&limit=1" \
--        -H "apikey: $ANON" -H "authorization: Bearer $USER_ACCESS_TOKEN"
