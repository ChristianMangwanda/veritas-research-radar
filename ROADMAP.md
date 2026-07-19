# Deep-Scan Findings & Roadmap — 2026-07-11

Full audit of pipeline, dashboard, scout/registry/CI, and the live Supabase dataset
(10,144 jobs / 8,903 active / 239 employers). Constraints honored throughout:
demote-never-hide, no AI-authored application materials, resume data never leaves
the machine.

## Verdict

The foundation is real: 10 ATS drivers, a tested job-lifecycle state machine,
deterministic resume-variant scoring, 6-hourly automated refresh, ~270 new jobs/day.
What separates it from a daily-driver job-search tool is concentrated in four areas:

1. **Relevant inventory is thin** — only ~116 active jobs (1.3%) sit in the two
   title classes that match the ML-engineer / data-warehousing profile, while 47%
   of the dataset (4,273 jobs) is unclassified `other` that likely hides relevant
   staff data/software roles.
2. **The pipeline can silently lose data** — one Supabase read blip in CI resets
   every `first_seen_at`, drops tombstones, and writes the corrupted state back;
   an employer feed going 0-jobs on an OK fetch erodes silently over 30 days
   (69 employers are at zero today); no workflow has failure alerting.
3. **The daily loop is unsupported past "found it"** — triage state is fragmented
   across three non-syncing stores, the funnel dead-ends at "applied" (no
   interview/offer/rejected, no notes, no follow-up aging), "NEW" resets on every
   page load, and the daily digest never sees the resume profile.
4. **Job facts are missing** — no salary (Ashby comp is fetched then discarded),
   no deadlines, 56% of locations are "Unspecified" (PeopleAdmin hardcodes it),
   no remote flag, no cross-source dedup (~2,815 active jobs share employer+title).

## What's already strong (don't rebuild)

- Job lifecycle (tombstone/revive/TTL) — well-designed, well-tested (`tests/radar.test.js`, 1,502 lines).
- Resume-variant scoring engine — deterministic, dual-env, honors never-hide (`radar/public/scoring.js`).
- Description capture — median ~2,000 chars, 99.6% coverage; the ranking raw material is there.
- Entity resolution + cap-exempt enrichment (IPEDS/IRS/USCIS/DOL joins).
- URL-serialized filters, keyboard-driven triage, XSS-safe highlighting in the dashboard.
- USAJOBS fail-loud pattern (`refresh.js:693-697`) — the model to copy to other drivers.

---

## Tier 0 — Protect the dataset ✅ DONE 2026-07-19

All five items landed in one pass (see the working tree). `npm test` green, all
workflow YAML parses, `deadman-check.js` + `digest.js` smoke-tested locally.

| # | Item | Where | Status |
|---|------|-------|--------|
| 0.1 | Guard the Supabase-only lifecycle: retry in `lib/supabase.js`; in `runRefresh`, if previous-state load is empty but employers fetched OK, **abort the sync** instead of resetting first_seen/tombstones | `refresh.js:826-833`, `lib/supabase.js:17-40` | ✅ read-retry + `RADAR_ALLOW_EMPTY_SYNC` escape hatch; report records `supabase_sync_aborted` |
| 0.2 | Zero-job recall alarm: flag any employer dropping from ≥N active to 0 on an OK fetch, in report + ntfy. Add test pinning "0-job employer must not mass-tombstone unnoticed" | `refresh.js:802-818` | ✅ `detectRecallAnomalies` (N=5) → `report.recall_anomalies` + ntfy; `testRecallAnomalies` added |
| 0.3 | Failure alerting: `if: failure()` ntfy step on all 6 workflows + tiny dead-man's-switch workflow (ping if `refresh-report.refreshed_at` > 8h old or `errored_employers` > 0) | `.github/workflows/*` | ✅ alert step on all 6 + new `radar-deadman.yml` / `deadman-check.js` (2-hourly) |
| 0.4 | digest.js: wrap the `jobs.json` fallback read in try/catch (it ENOENTs in CI); fix wrong "reads committed data only" comment in `radar-digest.yml` | `digest.js:43-46` | ✅ |
| 0.5 | Dashboard: keep successfully fetched pages when one Supabase page fails (currently one flaky page → 0 jobs); real error state distinct from "no filter matches" | `app.js:159-177`, `index.html:171-174` | ✅ per-page failures kept + `#load-error` banner; **browser-verified** (headless Chromium: partial + hard-failure paths) |

## Tier 1 — Make it a daily driver (~1 week)

| # | Item | Notes | Effort |
|---|------|-------|--------|
| 1.1 | **Local fit-aware digest**: `radar:digest:local` loads `profile.json`, scores with `RadarScoring`, pushes only verdict ≥ good with variant + reason ("3 strong ML-engineer fits at cap-exempt employers"). Runs on the Mac (launchd/cron) so the profile never enters CI. CI digest stays as fallback | `digest.js` + `scoring.js` | 1d |
| 1.2 | **Triage sync to Supabase**: per-user table (single-user token or Supabase Auth), replace the 3-way split (local-state.json / laptop localStorage / phone localStorage). Prerequisite for everything below | `app.js:217-228`, `server.js:121-131`, new table + RLS | 1–2d |
| 1.3 | Funnel past "applied": add interview / offer / rejected / withdrawn states + colors + filters | `app.js:21-37,1021`, `index.html` | 0.5d |
| 1.4 | Per-job notes (contact, next step) in the triage record + detail textarea | `app.js:1002` | 0.5d |
| 1.5 | Follow-up aging view: "applied N days ago, no update" sort/filter using the already-captured `updated_at` | `app.js` | 0.5d |
| 1.6 | Fix "NEW since last visit": stop advancing watermark on every load; explicit "mark all seen"; durable per-job seen set | `app.js:1257-1258` | 0.5d |

## Tier 2 — Fix the data itself (~1 week)

| # | Item | Notes | Effort |
|---|------|-------|--------|
| 2.1 | **Title-class recall pass on the 4,273 `other` jobs** — likely the single biggest lever on relevant inventory. Expand `lib/title-class.js` taxonomy for staff data/ML/software/analyst roles; audit the Workday title prefilter (`refresh.js:548-559`) for over-aggressive drops | taxonomy + tests | 1–2d |
| 2.2 | PeopleAdmin location parsing (4,724 jobs hardcoded "Unspecified") + a normalized remote flag | `refresh.js:764-778` | 0.5–1d |
| 2.3 | Salary: persist Ashby comp (already fetched, `refresh.js:439`) + shared regex parser over `description_text`; expose salary_min/max in row + detail | pipeline + UI | 1d |
| 2.4 | Deadline extraction (Greenhouse/Workday/USAJOBS payloads + "apply by/closes" regex); "closing soon" sort. Matters most for the 2,257 faculty postings | pipeline + UI | 1d |
| 2.5 | Cross-source fuzzy dedup: collapse (normalized employer + title + location) across ATS/scouted/aggregated | `refresh.js:971` | 0.5d |
| 2.6 | Sponsorship-text recall for aggregator jobs (raise detail-fetch budget; backfill descriptions) — only 49 FRIENDLY jobs today | firehose | 0.5–1d |

## Tier 3 — Grow coverage (ongoing, in value order)

| # | Item | Notes | Effort |
|---|------|-------|--------|
| 3.1 | **Rescue the 19 dark null-provider flagships** (MIT, Stanford, Harvard, Broad, Allen, Salk, HHMI, MSK, Dana-Farber, Mayo, Cleveland Clinic, St. Jude, …). Most sit on real ATS tenants behind vanity domains — wire true tenant or tune `scout/jobs_scrape.yaml` (only fred-hutch is tuned) | 1–2h each | incremental |
| 3.2 | Interfolio driver + promote wiring (74 discovered faculty boards, currently unreachable) | `refresh.js` + `promote-employers.js:228-244` | 1d |
| 3.3 | Merge the 7 staged registry proposals in `registry-proposals.json` | review + approve | 1h |
| 3.4 | iCIMS (45 candidates) and PageUp (57) drivers; Paylocity (59) next | 1d each | incremental |
| 3.5 | `SERPER_API_KEY` secret + wire `radar:websites` into monthly enrich — thaws the 14k-nonprofit tail | `.github/workflows/radar-enrich.yml` | 1h |

## Small fixes / cleanups (bundle anytime)

- `app.js:740` — meaningless identical ternary (`'alert-warn' : 'alert-warn'`).
- Dead `state.employers` / `/api/employers` path (`app.js:1263,1271`).
- Debounce search input; precompute per-job search blob (`app.js:237,1170`).
- `showAllRows` never resets on filter change (`app.js:103`).
- Doc drift: HANDOFF/CHANGELOG say "9 adapters", there are 10 (peopleadmin).
- Mobile: row-level triage buttons (keyboard shortcuts are the only fast path today); optional PWA manifest.
- ~~Supabase MCP connector in Claude sessions points at a different project (couples app)~~ — fixed 2026-07-11: project-scoped `.mcp.json` pins `nawbdsujjysugaisczta` for this repo (takes effect next session).

## Observed, not actioned

- Scout robots-drift: SCOUT-CONTRACT vs `jobs_scout.py:9` docstring vs actual
  `robots_allows()` behavior (`jobs_scout.py:121-126`, `net.py:26-28`) are three-way
  inconsistent. Owner is handling this personally — left untouched.

## Suggested sequence

Week 1: Tier 0 entirely + 1.1 (local fit digest) — the radar becomes trustworthy and
starts telling you what's worth applying to.
Week 2: 1.2–1.6 (triage sync + funnel + notes + NEW fix) — the radar becomes where the
search *lives*.
Week 3: 2.1–2.4 (classification recall, locations, salary, deadlines) — rankings get
sharper and inventory grows.
Then: Tier 3 coverage, a few employers/drivers at a time.
