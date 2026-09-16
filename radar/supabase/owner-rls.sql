-- Veritas Research Radar — durable single-owner authorization.
--
-- CAUTION: Run this file only against the project in supabase/target.json.
-- Run `npm run supabase:verify:operation` before you use a remote SQL command.
-- This transaction stops unless profile_documents contains exactly one row.
-- Make sure that this row belongs to the intended Auth user before you run it.

begin;

do $$
declare
  profile_count integer;
begin
  select count(*) into profile_count from public.profile_documents;
  if profile_count <> 1 then
    raise exception 'owner RLS requires exactly one profile_documents row; found %', profile_count;
  end if;
end
$$;

create table if not exists public.radar_owners (
  user_id uuid primary key references auth.users (id) on delete restrict,
  created_at timestamptz not null default now()
);

-- The precondition makes this insert deterministic. It never selects "the
-- first" profile from an ambiguous project.
insert into public.radar_owners (user_id)
select user_id from public.profile_documents
on conflict (user_id) do nothing;

do $$
declare
  owner_count integer;
  owner_matches_profile boolean;
begin
  select count(*) into owner_count from public.radar_owners;
  select exists (
    select 1
    from public.radar_owners as owner
    join public.profile_documents as profile on profile.user_id = owner.user_id
  ) into owner_matches_profile;

  if owner_count <> 1 or not owner_matches_profile then
    raise exception 'radar_owners must contain only the sole profile owner';
  end if;
end
$$;

alter table public.radar_owners enable row level security;
revoke all on table public.radar_owners from public, anon, authenticated, service_role;

-- Keep SECURITY DEFINER helpers outside every API-exposed schema. Authenticated
-- users can execute this one function but cannot create objects in the schema.
create schema if not exists radar_private;
revoke all on schema radar_private from public, anon, authenticated, service_role;
grant usage on schema radar_private to authenticated;

create or replace function radar_private.is_radar_owner()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.radar_owners
    where user_id = (select auth.uid())
  );
$$;

revoke all on function radar_private.is_radar_owner() from public, anon, authenticated, service_role;
grant execute on function radar_private.is_radar_owner() to authenticated;

drop policy if exists "own profile select" on public.profile_documents;
drop policy if exists "owner profile select" on public.profile_documents;
create policy "owner profile select" on public.profile_documents
  for select to authenticated
  using ((select radar_private.is_radar_owner()) and (select auth.uid()) = user_id);

drop policy if exists "own profile insert" on public.profile_documents;
drop policy if exists "owner profile insert" on public.profile_documents;
create policy "owner profile insert" on public.profile_documents
  for insert to authenticated
  with check ((select radar_private.is_radar_owner()) and (select auth.uid()) = user_id);

drop policy if exists "own profile update" on public.profile_documents;
drop policy if exists "owner profile update" on public.profile_documents;
create policy "owner profile update" on public.profile_documents
  for update to authenticated
  using ((select radar_private.is_radar_owner()) and (select auth.uid()) = user_id)
  with check ((select radar_private.is_radar_owner()) and (select auth.uid()) = user_id);

drop policy if exists "authenticated read" on public.match_cache;
drop policy if exists "owner match cache read" on public.match_cache;
create policy "owner match cache read" on public.match_cache
  for select to authenticated
  using ((select radar_private.is_radar_owner()));

drop policy if exists "authenticated select" on public.triage;
drop policy if exists "owner triage select" on public.triage;
create policy "owner triage select" on public.triage
  for select to authenticated
  using ((select radar_private.is_radar_owner()));

drop policy if exists "authenticated insert" on public.triage;
drop policy if exists "owner triage insert" on public.triage;
create policy "owner triage insert" on public.triage
  for insert to authenticated
  with check ((select radar_private.is_radar_owner()));

drop policy if exists "authenticated update" on public.triage;
drop policy if exists "owner triage update" on public.triage;
create policy "owner triage update" on public.triage
  for update to authenticated
  using ((select radar_private.is_radar_owner()))
  with check ((select radar_private.is_radar_owner()));

drop policy if exists "authenticated delete" on public.triage;
drop policy if exists "owner triage delete" on public.triage;
create policy "owner triage delete" on public.triage
  for delete to authenticated
  using ((select radar_private.is_radar_owner()));

drop policy if exists "own state select" on public.user_state;
drop policy if exists "owner state select" on public.user_state;
create policy "owner state select" on public.user_state
  for select to authenticated
  using ((select radar_private.is_radar_owner()) and (select auth.uid()) = user_id);

drop policy if exists "own state insert" on public.user_state;
drop policy if exists "owner state insert" on public.user_state;
create policy "owner state insert" on public.user_state
  for insert to authenticated
  with check ((select radar_private.is_radar_owner()) and (select auth.uid()) = user_id);

drop policy if exists "own state update" on public.user_state;
drop policy if exists "owner state update" on public.user_state;
create policy "owner state update" on public.user_state
  for update to authenticated
  using ((select radar_private.is_radar_owner()) and (select auth.uid()) = user_id)
  with check ((select radar_private.is_radar_owner()) and (select auth.uid()) = user_id);

-- Remove the exposed-schema helper created by an early draft after every
-- policy that could depend on it has been replaced.
drop function if exists public.is_radar_owner();

commit;
