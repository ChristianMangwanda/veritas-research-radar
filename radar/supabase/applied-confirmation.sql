-- Proof that an application was actually submitted.
--
-- CAUTION: Run only against the project in supabase/target.json.
--
-- WHY
--
-- "Applied" was a stage you clicked, and a click is not evidence. The stage
-- could be set by mistake, knocked back by a stray button (it was), or lost to
-- a write that never landed (it was) — and afterwards nothing on the record
-- could tell you whether you had really sent the thing or not. Weeks later
-- that is the only question that matters, and the app could not answer it.
--
-- So the claim and the evidence are now separate fields. `status` stays what
-- you told the app. `applied_confirmation` is what the EMPLOYER told you: a
-- confirmation number, an application id, the subject line of the receipt
-- email — whatever you can point at. An application with a stage but no
-- confirmation reads as unconfirmed rather than as done, which is honest about
-- the difference.
--
-- Deliberately free text. A dropdown would force a vocabulary on evidence that
-- arrives in whatever shape the employer's ATS happens to send.
--
-- Safe to run more than once.

begin;

alter table public.triage add column if not exists applied_confirmation text;

-- When the confirmation was recorded. Distinct from applied_at (when you say
-- you applied) and from updated_at (any edit at all).
alter table public.triage add column if not exists confirmed_at timestamptz;

commit;
