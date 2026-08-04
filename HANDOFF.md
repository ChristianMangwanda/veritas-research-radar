# Veritas Research Radar Handoff

Two products in one repo: the Veritas Chrome extension, and a two-layer
cap-exempt research jobs instrument.

## Architecture

```
EVERY 6 HOURS (GitHub Action)             SCOUT PRODUCER (scout/, Playwright)
  refresh.js:                               jobs-scout writes
   15 ATS drivers: greenhouse, lever,        radar/data/scouted/<id>.json
   ashby, smartrecruiters, workday,          -> npm run radar:import-scouted
   oracle, ultipro, successfactors,
   eightfold, paylocity, recruitee,        MONTHLY (GitHub Action + local)
   breezy, workable, usajobs,                enrich.js: IPEDS + IRS EO BMF +
   peopleadmin                                USCIS Data Hub + DOL signals
   + scouted-jobs merge (14-day TTL)          -> employer-enrichment.json
   + aggregator firehose (2x/day)             -> discovery-candidates.json
   + employer-enrichment overlay             -> enrichment-report.json
   + resume-variant fit scoring
   -> Supabase / jobs.json / refresh-report.json
```

Registry: **346 cap-exempt employers** (150 Workday, 95 PeopleAdmin, 32
Oracle, 12 UltiPro, 30 not-yet-wired — mostly scout-routed iCIMS boards plus
the remaining dark flagships — the rest across the other systems). Dataset
~11.5k active jobs; new employers fold in on the next 6-hourly refresh. Full
orientation in **`PROJECT-MAP.md`**.

## Commands

```bash
npm test                        # offline test suite (always run before committing)
npm run app:install             # build "Veritas Radar.app" into /Applications
npm run app                     # start the server (if needed) + open the dashboard
npm run radar:refresh           # daily-layer fetch + enrich + lifecycle
npm run radar:serve             # dashboard at http://127.0.0.1:4173
npm run radar:enrich            # monthly joins (downloads ~350MB, cached 25 days)
npm run radar:enrich -- --offline   # rerun from cache (deterministic)
npm run radar:import-dol -- path/to/LCA.csv   # manual DOL signal import
npm run radar:import-scouted    # validate + merge scout snapshots
npm run radar:profile           # extract resume variants -> profile.json (local Ollama by default)
npm run radar:profile -- --force    # re-extract all variants (after a prompt/model change)
npm run radar:route             # optional: local Ollama resolves ambiguous variant calls
npm run radar:digest:local      # fit-aware digest (scores fresh jobs vs your profile)
bash radar/scripts/run-digest.sh    # same, sourcing radar/scripts/.digest.env (used by launchd)
```

Résumé files may be `.txt`, `.md`, `.pdf`, or `.docx` (`.docx` extracted locally
via the `unzip` CLI). The extractor forces a real 3/2/1 skill-weight pyramid so
fit scores discriminate between variants.

Every model step runs locally via Ollama (nothing leaves the machine).
Résumé extraction uses `OLLAMA_MODEL` (default `qwen2.5:7b-instruct`);
**job matching uses `RADAR_MATCH_MODEL` (default `qwen2.5:14b-instruct`)** —
14b reads postings materially better and fits comfortably in 24 GB. Shared
`OLLAMA_URL` (default localhost). `radar:profile -- --provider anthropic`
switches extraction to hosted Claude if local quality is not enough.

## Opening the app

`npm run app:install` builds **Veritas Radar.app** (in /Applications) — a stub
bundle that execs `radar/scripts/launch.sh`, so it never goes stale. Double
-click starts the server if needed, waits for it, and opens the dashboard;
launching again is a no-op. Logs: `~/Library/Logs/veritas-radar.log`. First
open needs right-click → Open (unsigned). `npm start` still works.

The full experience is local by design — resumes, the compiled profile, and
the judging model all live on this machine. The hosted Pages site remains a
read-only mirror: it can browse jobs and (when the local radar is running)
adopt the profile, but it cannot upload resumes or judge matches.

## Resume-variant ritual (ranking + routing)

The radar never writes resumes — you do. It ranks jobs against your own
resume variants and tells you which one to send.

0. Install [Ollama](https://ollama.com) and `ollama pull qwen2.5:7b-instruct`
   (the same model serves both extraction and routing). Extraction is
   structured parsing, not deep reasoning — a local 7-8B model handles it and
   your resume text never leaves the machine.
1. **Drag a resume into the dashboard's "Your resumes" panel** (or drop the
   file into `radar/data/resumes/`, gitignored). It self-registers: the local
   model writes its one-line `intent`, marked as a draft you can edit in the
   panel along with its label. You never open `manifest.json` — the panel
   writes it. One extraction per variant, cached by content hash + model, so
   adding a resume re-reads only the new one (`--force` redoes all). If the
   local profile looks thin, re-run with `-- --provider anthropic`.
   *Before 2026-08-04 a dropped-in resume was silently ignored — the manifest
   was non-empty so the scaffold never re-ran. That is the bug this replaced.*
2. **After that, editing a resume file is the whole ritual (2026-08-04).**
   The `npm start` server watches `radar/data/resumes/` and rebuilds
   `profile.json` automatically (`build-profile.js --if-stale`; mtime-based,
   an unchanged file costs one cached no-model rebuild); the daily digest run
   does the same check at 08:00 so the profile stays fresh even without the
   server. The open dashboard tab polls `/api/profile-freshness`, narrates
   rebuilds in the profile card, and adopts the result. New files no longer
   need any hand-editing (see step 1); a failed rebuild shows up in the
   profile card with the reason.
3. **Say what you want** in the sidebar's "What you want" panel — free text,
   your own words. The model turns it into structured fields (locations,
   remote, salary floor, role types, domains, deal-breakers) shown back to
   you so a bad reading is visible and fixable. Stored in
   `radar/data/preferences.json` (gitignored). The prose stays the source of
   truth; editing it re-judges every job.
4. **Matching is two-stage** (2026-08-04). The deterministic pass narrows
   thousands to hundreds — open, in your tracks, no quoted barrier — and then
   a local **qwen2.5:14b** READS each survivor against your resumes and
   preferences (`radar/scripts/lib/match.js`, judged via `/api/match`,
   cached in `radar/data/match-cache.json`). Each job gets a verdict with
   its reasons and gaps printed on the row.
   - The verdict is **derived in code**, not asked for: the model answers
     three booleans (different profession / meets stated requirements /
     matches what you want) and `deriveVerdict()` aggregates them. Asking for
     a 4-way enum returned "strong" for everything, including postings the
     model itself described as "Not a match" — constrained decoding fills
     fields in declaration order, so the label was written before any
     reasoning existed. **Do not reorder JUDGMENT_SCHEMA's properties.**
   - One judgment is ~19s (14b at ~11 tok/s; the Ollama app runs
     llama-server with `-np 1`, so requests serialize however many you
     fire). `/api/match` therefore answers instantly from cache and drains
     the rest through a priority queue — what is on screen jumps the
     backlog. The count line says how many have been read.
   - Cache key = posting content + profile hash + preferences hash, so any
     of the three changing re-judges.
   - Jobs judged "not your line of work" are set aside like blocked ones:
     counted beside the list, one click back, reasoning attached.
5. Jobs also carry the deterministic fit score (demoted to a hint once judged
   — it is a compressed keyword count, not a percentage), a "use <variant>"
   chip, and ⚠ flags for hard gates. Gates demote — they never hide a job.
6. Optional: `npm run radar:route` — the same local model re-judges only the
   jobs where two variants scored within 8 points and caches the verdicts
   (`route-cache.json`, gitignored, invalidated when the profile changes).
7. Hosted (Pages) dashboard: whenever the local radar is running, the hosted
   page pulls the compiled profile (+ route cache) from
   `http://localhost:4173` over a CORS bridge scoped to the Pages origin
   (Chrome-only in practice — Private Network Access preflight is answered)
   and persists it in that browser's localStorage; newest `generated_at`
   wins, so it never clobbers a newer manual import. The sidebar import
   button remains as the fallback. Resumes and profile flow one direction —
   nothing ever leaves the machine except this pull by your own browser.

## Notifications + hosted dashboard

- Dashboard (static, auto-refreshed every 6h):
  https://christianmangwanda.github.io/veritas-research-radar/ — triage state
  lives in that browser's localStorage; the local `npm start` server keeps
  using `radar/data/local-state.json`.
- Three tabs, toggled in the list header (2026-08-04 restructure; same light
  steel system + Barlow type from the 2026-08-03 brief): **Qualified** — the
  default — is open + in your tracks + no quoted barrier, ranked by fit with
  no cutoff (`RadarScoring.isQualified`; a "+N in your field but blocked"
  link reveals what the eligibility rule held back). **All jobs** is every
  active posting, newest first. **Applied** is your applications grouped by
  stage with follow-up aging and an Export-backup button (ignores every
  filter except search). Hover a row for the **Apply ↗** quick action: opens
  the posting and arms the did-you-apply nudge; confirming stamps applied_at
  + which résumé was sent. Visible filters are just Search / Visa signal /
  First-seen / Remote; the rare toggles, profile import, triage backup, and
  sync UI sit under the sidebar's collapsed **More**. The header shows three
  stats (Qualified · New for you · Active) plus a **Status** button whose
  dot goes red on feed errors, recall alarms, or a failed page load — its
  drawer holds the next-pull countdown, the 7 system tiles, source errors,
  the discovery queue, and the digest setup steps. On the hosted dashboard,
  Qualified needs your profile in that browser's localStorage — it arrives
  automatically from the local radar when it's running (see the
  resume-variant ritual), or via the manual import; the tab prompts until
  one happens.
- Daily digest: the **local** fit digest is armed (2026-08-03) — a launchd
  agent (`com.veritas.radar.digest`) runs `run-digest.sh` at 08:00 daily,
  reading `radar/scripts/.digest.env` (gitignored; holds the private ntfy
  topic + read-only anon key for live data). Log:
  `/tmp/veritas-radar-digest.log`; disarm with
  `launchctl bootout gui/$(id -u)/com.veritas.radar.digest`. The CI digest
  workflow (repo-secret `NTFY_TOPIC`) is deliberately left unset — the user
  checks the dashboard daily instead; the ☀ Today chip applies the same cut
  in-app.

## Setup the automation needs

1. **Push this repo to GitHub** — both workflows (`research-radar.yml` every 6
   hours, `radar-enrich.yml` monthly) are dormant until then.
2. **USAJOBS**: register at developer.usajobs.gov (free, instant). Set
   `USAJOBS_API_KEY` and `USAJOBS_EMAIL` as repo secrets (and in your shell for
   local runs). Without them the federal source skips cleanly.
3. **DOL** (optional but valuable): download an LCA disclosure file from the
   OFLC performance page in a browser (Akamai blocks bots), convert to CSV into
   `radar/data/dol-raw/`, then `npm run radar:import-dol -- <file>` and rerun
   `radar:enrich`. This feeds both the sponsor signal and discovery ranking.

## Monthly enrichment ritual

1. (Optional) refresh the DOL download as above.
2. `npm run radar:enrich` — or let the monthly Action do it.
3. Review `radar/data/enrichment-report.json`: `weak_matches` is your alias
   worklist (add `aliases` to the employer in `employers.json`, rerun with
   `--offline`); `unmatched` shows which employers still lack evidence.
4. Skim `radar/data/discovery-candidates.json` (also in the dashboard panel);
   promote good candidates by pasting their `suggested_registry_entry` into
   `employers.json`, verifying identity, and adding a `careers_url`/ATS token.

## Scout ritual (employers with no clean feed)

The scout producer lives in the LadyLibertysBrief repo (jobs-scout mode). It
writes snapshots matching `radar/SCOUT-CONTRACT.md` into `radar/data/scouted/`,
then `npm run radar:import-scouted` validates and merges them. Snapshots
expire after 14 days, so re-run the scout at least biweekly for fresh coverage.
Any other producer that honors the contract works too.

## Privacy boundary

GitHub Actions only touches public data (ATS feeds, USAJOBS, IPEDS, IRS,
USCIS). Resume files (`radar/data/resumes/`), the extracted profile
(`profile.json`), routing verdicts (`route-cache.json`), and triage state
(`local-state.json`) are all gitignored and stay local. By default both the
extraction and routing steps run a local model via Ollama, so resume text
never leaves the machine at all; only if you opt into `--provider anthropic`
does resume text go to a hosted model. The DOL raw download stays local;
only the aggregated per-employer signal is committed.

## Current data status (2026-08-03)

- **346 employers**, 15 wired ATS systems; ~11.5k active jobs (of ~17.6k
  tracked) as of the last completed refresh — recent registry additions fold
  in on the next 6-hourly run. 0 recall anomalies
  on the last refresh (24 transient feed errors, individual employers — not
  data loss).
- Fit engine ranks **all 7 résumé variants**; verdict tiers recalibrated
  (strong 50 / good 38 / moderate 27 / weak 16).
- 7 GitHub Actions run the pipeline (see `PROJECT-MAP.md` §"How it stays fresh").
- Refresh report now also tracks `prefiltered_count` per employer and flags
  `prefilter_anomalies` — an employer whose title-matching regex is silently
  excluding almost everything gets caught automatically instead of by luck.

## Pick-up state — steady state, nothing pending (2026-08-03)

The setup checklist is empty. The daily digest is armed locally (see
Notifications above). Two former checklist items were **deliberately
dropped**, not forgotten: cross-device triage sync (`triage.sql` stays
unapplied — single user, single browser; revisit only if a second device or
lost triage state comes up; a triage export/import button is the preferred
lightweight insurance) and the CI-digest `NTFY_TOPIC` repo secret (no push
notifications wanted).

The desktop-polish bundle shipped 2026-08-03 late night: Enter/o keyboard
split, full-funnel triage keys (`i`/`O`/`r`/`w`), undo (`u`/Cmd+Z + bar),
sidebar triage export/import, and quiet auto-refresh when the tab regains
focus after a pull.

The **dashboard restructure** shipped 2026-08-04 (see CHANGELOG): three tabs
(Qualified / All jobs / Applied) replace Radar/Pipeline/Routing, the header
is 3 stats + a status corner, and the sidebar dropped from 16 controls to 4
visible. Routing view and saved views were deleted; the Qualified predicate
lives in `RadarScoring.isQualified` (tested). Notion sync of applications was
considered and deliberately deferred — the Applied tab runs on the existing
local triage store, with export/import as the backup. If revisited, the
right shape is a Supabase Edge Function proxy (public repo: no token can
ship in the page).

The **funnel redesign** shipped earlier on 2026-08-04 (see CHANGELOG):
fit-engine repairs, role tracks, an eligibility layer, and the Can-apply
default view.
Every job now carries `fit.track` (is this your line of work) and
`fit.eligibility` (is there a stated barrier, with the sentence that proves
it). `npm run radar:fit-audit -- --histogram|--tracks|--sample-blocked N`
measures the distribution; re-run `--sample-blocked` after touching any
extractor, since a false block is the one error that hides a job you could
have had.

**Next increment (designed, not built):** `radar/scripts/classify-jobs.js` —
a local-Ollama pass over the 34% of jobs whose title matched no regex
(`title_class === 'other'`, ~4,255 jobs) plus any posting flagged
`eligibility.needs_review`. It writes `radar/data/classify-cache.json`
(gitignore it — the route-cache rule is exact-name), keyed by
`RadarScoring.jobContentHash` so an edited posting is re-judged; the read
path is already live in scoring.js (`applyJobClassifications`), the
dashboard, and the digest. Plan in `~/.claude/plans/sparkling-booping-sloth.md`.

## Open follow-ups (nice-to-have, not blocking)

- 10 dark flagships still unwired (MIT, Harvard, Broad, Allen, Cleveland
  Clinic, UC Berkeley…) — closed/JS-only ATS; see `flagship-ats-findings.md`.
- **Interfolio driver** (Tier 3.2) — investigated 2026-08-03: an AngularJS SPA
  over several private REST hosts, not a plain-fetch target. Needs a
  dedicated session (Playwright scout path or real API reverse-engineering).
  19+ candidates already confirmed in an in-progress discovery re-crawl.
- Resume/extend `scout/scout_discover.py` past its first ~1,500 sites (a
  400-site batch was still running as of session end) — the first 1,100 had
  446 unpromoted ATS hits, several on platforms with zero drivers today
  (ADP 44, Cornerstone OnDemand 22, Taleo 14, GovernmentJobs/NeoGov 17).
- Avature (Broad)/ClearCompany (Allen)/Findly (Cleveland Clinic)/UCPath
  (Berkeley) drivers — one flagship each, lowest leverage per
  `flagship-ats-findings.md`.
- Résumé extraction still emits somewhat verbose terms (the allowlist recovers
  the matchable tokens); a larger local model (`qwen2.5:14b`) would sharpen it.
