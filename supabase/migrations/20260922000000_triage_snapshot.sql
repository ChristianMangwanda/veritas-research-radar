-- Veritas Research Radar — make an application record self-contained.
--
-- CAUTION: Run this file only against the project in supabase/target.json.
-- Run `npm run supabase:verify:operation` before you use a remote SQL command.
--
-- WHY
--
-- A triage row used to be nothing but a foreign key into `jobs`: job_id, the
-- stage, and when you applied. Everything a person would recognise — who the
-- employer is, what the role was called, where to find the posting again —
-- lived only in the jobs row, and the jobs row does not survive. Closed
-- postings become tombstones for 30 days and are then deleted outright
-- (radar/scripts/refresh.js applyJobLifecycle), and a job whose employer
-- leaves the registry is deleted on the very next refresh. The dashboard
-- renders its pipeline by walking the feed, so the moment that row went, the
-- application vanished from the screen while the triage row sat in this table
-- pointing at nothing.
--
-- Applications outlive postings — that is the normal case, not the edge one.
-- You apply in September and hear back in November, by which time the posting
-- has been taken down and swept. So the facts a pipeline needs to display are
-- copied onto the triage row at the moment you act on the job, and the row can
-- be rendered with no jobs row at all.
--
-- The snapshot is deliberately NOT kept in step with the posting afterwards.
-- It records the job as it was when you applied to it, which is the thing you
-- actually want to remember; the live row is still joined over the top
-- whenever it exists, so nothing here degrades a posting that is still open.
--
-- Safe to run more than once.

begin;

alter table public.triage add column if not exists employer_name text;
alter table public.triage add column if not exists employer_id   text;
alter table public.triage add column if not exists title         text;
alter table public.triage add column if not exists url           text;
alter table public.triage add column if not exists location      text;

-- When the snapshot was taken, which is NOT updated_at: updated_at moves every
-- time you change stage, and the snapshot is written once, on the first write
-- that carried job facts. A null here means a row that predates this migration
-- and was never touched since — those are the orphans that can only be
-- recovered from `jobs` if their posting still happens to be there.
alter table public.triage add column if not exists snapshot_at timestamptz;

-- Back-fill from whatever postings are still present. This cannot rescue rows
-- whose job was already deleted — that data is gone from this database and the
-- back-fill does not invent it. It exists so that the pipeline stops depending
-- on `jobs` for every row that CAN be filled today, before the next refresh
-- sweeps more of them.
update public.triage as t
set
  employer_name = coalesce(t.employer_name, j.employer_name),
  employer_id   = coalesce(t.employer_id,   j.employer_id),
  title         = coalesce(t.title,         j.title),
  url           = coalesce(t.url,           j.url),
  location      = coalesce(t.location,      j.location),
  snapshot_at   = coalesce(t.snapshot_at,   now())
from public.jobs as j
where j.id = t.job_id
  and t.title is null;

commit;
