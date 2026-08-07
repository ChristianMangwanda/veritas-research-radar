# Veritas Research Radar Handoff

Two products in one repo: the Veritas Chrome extension, and a two-layer
cap-exempt research jobs instrument.

## Pick up here (2026-08-06, night)

**Everything is pushed and live. `main = ba3b493`. Nothing is outstanding.**

```
registry        484 → 547 employers
active jobs  12,440 → 18,038
recall anomalies                0
two days of API spend       ~$7.83
```

The refresh has run against all of it, Pages has deployed, `npm test` is green,
547 validate, no duplicate ids.

**The registry-expansion phase is finished by decision, not exhaustion.** The
user called it: *"this is more than enough… I'll just make a mental reminder to
check the other ones manually."* Do not reopen it unasked. The numbers behind
that call are in **Where the ceiling actually is**, below, and they are worth
reading before proposing any new employer work.

### What the last two days added

**Yesterday: 51 college feeds, ~2,900 postings** — Penn, UT Austin, Villanova
(366), Syracuse (309), Chapman (228), Pitt (216, including a postdoc-only
board), UT Southwestern, Fordham, Oberlin, UNC Wilmington, WVU (including a
faculty board its staff board never showed). UAB's Taleo board went in as a
`secondary_ats_feed` on its existing PeopleAdmin entry — 82 relevant jobs its
current feed misses.

**Tonight: 12 research institutes, ~168 postings, for $2.78** — Draper (25),
MUSC (58), Ai2 (27), Riverside Research (15), Michael J. Fox Foundation (11),
Benaroya, Brookings, ATCC, Pew Research Center, Minneapolis Heart, Altarum,
METR. The non-college side of the registry went 34 → 46.

Those institutes had been invisible for a mundane reason: the resolver only
ever read the ATS-discovery crawl, and that crawl covered IPEDS colleges. The
ranked IRS pool had been scored, had its websites resolved, and had never been
joined to anything. `--pool nonprofits` is that join. All 160 ranked nonprofit
sponsors have now been through the resolver; 12 converted.

MUSC arrived through its Foundation's IRS record, but the feed is the
university's own — its postings say "Medical University of South Carolina
(MUSC - Univ)" — so it is registered under the university with the Foundation
as an alias. Naming it after the Foundation would have filed 58 university
postings under a fundraising arm.

### The rule that keeps earning its keep

**A probe proves the BOARD has postings. Only running the real adapter proves
THIS CONFIG can read them.** Nine candidates died on that gap yesterday — six
PageUp employers whose sitemaps list jobs while every detail page answers an
AWS WAF challenge. Six more died on it tonight, reading zero jobs through an
adapter after resolving perfectly. Without that check all fifteen would have
entered the registry and reported "no openings" forever, which is the failure
mode that produces no error and no complaint.

### Three ways the ownership scorer was wrong

All three were found by RUNNING the gate, not by reasoning about it. Each is
now closed, and each generalises.

1. **Co-location.** Dean McGee Eye Institute was confirmed onto OU Health's
   Workday board: thirteen sampled postings all agreed on "Oklahoma City" and
   not one said "Dean McGee". Co-location is the *normal* condition for a
   research institute, so a shared city is the weakest signal available, not
   the strongest. City agreement now requires the feed's own label to not name
   somebody else.
2. **Token identity.** Salk's Ultipro board is `salk` in the registry and
   `SAL1013SIBS` coming out of the resolver — same host, same tenant, same
   board — and a token-keyed duplicate check waved it straight through. The
   token is a label *we* choose; the config is what the vendor issued, so the
   config is the identity. Fixing it immediately exposed two more duplicates
   already in the registry: **there are 7, not 5.**
3. **Single-token names.** FOSSA is an Oregon nonprofit with no revenue.
   fossa.com is a San Francisco software company hiring account executives.
   Every posting said "FOSSA", the board slug said "fossainc", and on name
   evidence the gate confirmed the software company as a cap-exempt research
   employer. A name that reduces to one token cannot verify itself — it now
   needs geographic corroboration, the same two-signal rule
   `verify-website.js` reached from the other direction.

### New tools

| script | what it does |
|---|---|
| `resolve-employer-ats.js --pool nonprofits` | resolves the ranked IRS institutes, not just the college crawl |
| `verify-proposed-feeds.js` | the gate, generalised past Taleo: runs THE REAL ADAPTER, then scores ownership |
| `promote-verified-feeds.js` | merges only `confirmed`, with curated display names |
| `probe-taleo-sections.js` | enumerates a Taleo tenant's career sections — a tenant runs several and they hold DIFFERENT jobs |
| `resolve-taleo-codes.js` | web-searches the unguessable section codes, then verifies each against the live board |
| `verify-feed-ownership.js` + `lib/feed-ownership.js` | confirmed / rejected / inconclusive, with quotable evidence |

The pipeline is now **resolve → verify → promote**, and only the last one writes
to `employers.json`.

`resolve-employer-ats.js` caches every model answer permanently and replays the
free stages from it, so **iterating on that code costs $0** — only new
employers cost money (~3.4¢ each, measured on both pools). One trap worth
knowing: running `--no-model` first used to write terminal failures that the
paid run then skipped, so free reconnaissance silently cancelled the paid pass.
Fixed, and it reads correctly for entries written before the fix.

### Where the ceiling actually is

Measured tonight. This is the argument for stopping.

- **62 employers produce 80% of all jobs.** The median producing employer
  contributes **9**; the 25th percentile contributes 2. 126 of 547 fetch zero.
- Of 5,449 crawled colleges not in the registry: **550** sit on a provider that
  already has a driver — resolvable with no new code, and the last real block.
  **8** sit on a provider that does not. 4,891 have no findable board at all.
  **New drivers buy eight employers, total, ever.**
- **Phenom and Ashby appear zero times in the 5,967-college crawl.** One
  employer each — Battelle and OpenAI. Do not write those drivers.
- The judge has read 612 postings: **76 strong, 29 possible, 111 stretch, 396
  no.** At that rate the current pool already holds roughly 600 strong matches.
  The binding constraint has stopped being inventory and become applications.

### The manual list

**[Research employers to check by hand](https://app.notion.com/p/3b4b4b9054478148805ed1a64ca0977c)**
— 83 employers the radar cannot reach, every one a live link. Battelle is at
the top: 368 H-1B approvals, the largest single sponsor in the nonprofit pool,
$13bn revenue, on Phenom. Also the 17 dark registry entries (MIT, Harvard,
Berkeley, Broad, Fred Hutch, Allen, Cleveland Clinic, Rockefeller, UCLA,
Michigan, Wisconsin) which look covered in the dashboard and contribute
nothing. Regenerating it means re-running the join over `ats-resolve-cache.json`
and `nonprofit-ranking.json`; the data is all still on disk.

### If there is a next thing

**It is the other side of the funnel, not more employers.** ~600 strong matches
already exist in a pool nobody can exhaust. gpt-5.6-luna is known-lenient and
inflates the top tier; sharpening the `matches_preferences` prompt so "strong"
means twenty jobs instead of six hundred is worth more than any further
expansion. Sharpen the prompt, never swap to a stricter model — you can tighten
a lenient model, you cannot recover a job a strict one hid.

Still open, unchanged and unblocking:

1. **ADP pacer** — 46 employers, the same 6 refused with HTTP 429 every run,
   under the dead-man threshold so it never alarms.
2. **7 pre-existing duplicate feeds** double-count jobs today.
   `hhmi`/`howard-hughes-medical-institute` and the two
   `memorial-sloan-kettering` entries are the same employer twice; Tennessee
   and Maine each have a system and a campus on one Oracle feed; three more are
   distinct schools sharing one system feed.
3. **PeopleSoft** — 11 employers, 689 approvals, 4 instances (UC system, UT
   System, University System of Georgia, Central Washington). Still the biggest
   single unclaimed block if expansion ever restarts. Partially cracked: it
   needs a **cookie jar** (without one every URL redirects to
   `cmd=login&errorPg=ckreq`, which looks like a block and is not), the
   component is `HRS_HRAM_FL.HRS_CG_SEARCH_FL.GBL`, and the listing arrives via
   an `ICAction` postback rather than JSON. **Open question:** the job rows in
   that 308KB response do not use the `JobOpeningId=` pattern — find the row
   markup first. Guessing component URLs is a dead end; three variants returned
   17KB shells.

### Dead ends — do not re-derive

- **PageUp.** It was the largest remaining target by sponsorship (18 orgs,
  1,062 approvals) and 6 of 6 promotion attempts were WAF-blocked at the
  adapter. Retired on evidence, not suspicion. Only revisit with a headless
  browser in CI.
- **A generic schema.org JSON-LD driver.** Sampled 250 of the 4,832
  "no ATS detected" organisations: **zero** publish JobPosting markup. That
  pool is also 4,785 colleges to 47 nonprofits, so the "research nonprofits
  with no supported ATS" population barely exists.
- **Writing more ATS drivers, of any kind.** The genuinely unsupported tail
  across the entire college crawl is **8 employers**, and the two platforms
  worth naming (Phenom, Ashby) have one employer each. A browser tab beats a
  driver here.
- **The 171 non-sponsor nonprofits** left in the ranked pool. They rank below
  the sponsors on the one signal that predicts hiring, and the sponsors
  themselves converted at 12 in 160.

### One ops note

**A red Dead-Man Switch is often just GitHub dropping a scheduled cron**, not a
broken pipeline. It fails the run deliberately because `NTFY_TOPIC` is unset by
design, so failing the Actions list is its only way to be seen. Check which
alarm fired before worrying. `gh workflow run research-radar.yml --ref main`
forces a refresh; `git push` and `gh` hang in the sandbox and need it disabled.

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

Registry: **547 cap-exempt employers** across 16 wired ATS systems
(peopleadmin, workday, oracle, csod, governmentjobs, icims, taleo, adp,
ultipro, paylocity, interfolio, greenhouse, lever, successfactors, eightfold,
usajobs, plus the aggregator firehose). 500 colleges, 46 non-college research
organisations, 1 federal. Dataset **18,038 active jobs**; new employers fold in
on the next 6-hourly refresh. Full orientation in **`PROJECT-MAP.md`**.

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
4. **Matching is two-stage** (rebuilt 2026-08-05). Stage one is deterministic
   and rejects only what is *quotably* impossible — closed, citizens-only, a
   licence or degree the posting demands, a profession needing credentials you
   cannot hold. It no longer asks whether a job is "your line of work": that
   guess (roleTrack) was carrying 616 of the then-12,440 postings and was the
   last place a real match could vanish without evidence. Stage one left ~5,100
   of those; the pool scales with the dataset, which is now 18,038 active.
   Stage two: **gpt-5.6-luna reads every survivor** via `radar/scripts/lib/
   openai.js`, keyed in `radar/data/match-cache.json`.
   - **No Ollama anywhere.** The local 14b took 20s a posting — 54 hours to
     read the pool once. The API does it in minutes for a few dollars, and
     that is what makes a lenient stage one affordable.
   - Model choice was measured on 789 postings the 14b had already judged:
     gpt-5-nano agreed 75% and buried **32 strong matches**; gpt-5-mini agreed
     77% and buried 1; gpt-5.6-luna agreed 63% and buried **0**, while costing
     less than mini. Agreement % is a decoy — nano and mini score alike and
     fail in opposite directions. Only "buries a strong match" decides it.
     luna's known flaw is the opposite one: it is lenient (rejects 52% where
     the 14b rejected 73%) and inflates the top tier. Sharpen that in the
     `matches_preferences` prompt, never by picking a stricter model.
   - `OPENAI_API_KEY` lives in `.env` (gitignored). No key means no judging,
     the same as the hosted dashboard.
   - The verdict is **derived in code**, not asked for: the model answers three
     booleans and `deriveVerdict()` aggregates. Asking for a 4-way enum
     returned "strong" for everything — constrained decoding fills fields in
     declaration order, so the label was written before any reasoning existed.
     **Do not reorder JUDGMENT_SCHEMA's properties.**
   - Cache key = posting content + profile hash. Résumé files are *not* in it,
     which is the whole point of the change below.

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

## Current data status (2026-08-07, after the last refresh)

- **547 employers**, 530 ats-enabled, 16 wired ATS systems. **18,038 active
  jobs** of 25,012 tracked. **0 recall anomalies**; 15 prefilter anomalies.
- **402 employers produce jobs; 126 fetch zero; 6 error** — all six are the
  same HTTP 429 on the shared ADP host, every run, under the dead-man
  threshold so they never alarm.
- The distribution matters more than the total: **62 employers produce 80% of
  all jobs**, the median producer contributes 9, and USAJOBS alone is 2,500.
  Adding employers moves the total far less than the count suggests.
- Fit engine ranks **all 7 résumé variants**; verdict tiers recalibrated
  (strong 50 / good 38 / moderate 27 / weak 16). The judge has read 612
  postings so far: 76 strong, 29 possible, 111 stretch, 396 no.
- 7 GitHub Actions run the pipeline (see `PROJECT-MAP.md` §"How it stays fresh").
- Refresh report also tracks `prefiltered_count` per employer and flags
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
