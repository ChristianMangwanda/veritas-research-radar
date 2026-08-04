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
| 0.6 | **Added 2026-08-03:** the pre-fetch title prefilter (workday/oracle/successfactors/eightfold/paylocity) had already caused one real recall miss (faculty "Open Rank" titles, found by luck) with zero trace of what it excludes. `filterResearchRelevant` now stamps a `prefiltered_count` per employer into the report; `detectPrefilterAnomalies` flags a suspiciously high excluded-to-seen ratio, unconditionally (no previous-run baseline needed) | `refresh.js` | ✅ + `testPrefilterAnomalies` |

## Tier 1 — Make it a daily driver ✅ DONE 2026-07-19

All six shipped. Dashboard changes browser-verified (headless Chromium, 15
assertions); 1.1 verified against the live local dataset; 1.2's live Supabase
round-trip is pending the migration being applied (see below).

| # | Item | Status |
|---|------|--------|
| 1.1 | Local fit-aware digest with variant + reason | ✅ `radar/scripts/digest-local.js`, `npm run radar:digest:local`; CI digest stays fallback |
| 1.2 | Triage sync to Supabase, replace the 3-way split | ✅ token-gated RPCs `radar/supabase/triage.sql` + client + Settings→Sync UI; local-only until a token is set. **Run the migration + set a token to activate** |
| 1.3 | Funnel past "applied" (interview/offer/rejected/withdrawn) | ✅ states + colors + detail buttons + filter options |
| 1.4 | Per-job notes | ✅ detail textarea + note chip |
| 1.5 | Follow-up aging ("applied N days ago, no update") | ✅ `followup` sort + "Needs follow-up" filter + row chip |
| 1.6 | Fix "NEW since last visit" watermark | ✅ no longer advances on load; explicit "Mark all as seen" |

Follow-up to wire when convenient: schedule `radar:digest:local` on the Mac
(launchd/cron), and apply `radar/supabase/triage.sql` + set a sync token to turn
on cross-device triage.

## Tier 2 — Fix the data itself ✅ DONE 2026-07-19

All six shipped. Pipeline/classification only — the live dataset is untouched per
request; CI folds these in on its next refresh/firehose run. New parsers unit-
tested; salary/deadline/remote UI browser-verified (8 assertions).

| # | Item | Status |
|---|------|--------|
| 2.1 | Title-class recall on the `other` bucket | ✅ +391 relevant jobs recovered (4178→3787): open-rank faculty, data/analyst, developers; Workday prefilter broadened; noise-guard tests |
| 2.2 | PeopleAdmin locations + remote flag | ✅ universal `work_mode`/`remote` (298 remote + 209 hybrid) + safe "…at City" campus recovery (1097 jobs); "Remote only" filter |
| 2.3 | Salary | ✅ shared `lib/salary.js` (range/hourly/K, bounds); Ashby comp + description; 818 jobs get salary; chip + detail + "Salary" sort |
| 2.4 | Deadlines | ✅ cue-anchored `lib/deadline.js` + USAJOBS close date; 285 jobs; "⏱ closes…" chip + "Closing soon" sort |
| 2.5 | Cross-source dedup | ✅ `dedupeCrossSource` collapses cross-tier dupes (ATS>scout>aggregator), keeps distinct same-source reqs |
| 2.6 | Aggregator sponsorship recall | ✅ detail-fetch budget 60→150 (already cap-exempt-prioritized + cached, so it backfills over runs) |

Follow-up (data-layer, deferred with the other DB work): fuller location coverage
via IPEDS city/state in the enrichment overlay.

## Tier 3 — Grow coverage (ongoing, in value order)

| # | Item | Notes | Effort |
|---|------|-------|--------|
| 3.1 | **Rescue the 19 dark null-provider flagships.** **⏳ 9/19 wired.** Workday: HHMI, MSK, UW, + **St. Jude** (Phenom→Workday redirect); Oracle HCM (`oracle` driver): Stanford, Mayo; SuccessFactors + Eightfold drivers: Baylor College of Med, JHU; UltiPro (`ultipro` driver): **Salk**. Dana-Farber deduped against its live Workday twin. **Michigan (Drupal-AJAX) + MIT (PeopleFluent) deferred — no public feed.** Remaining dark: MIT, Harvard, Broad (Avature), Allen (ClearCompany), Cleveland Clinic (Findly), UC Berkeley (UCPath), Northwestern (non-CE Oracle), UW-Madison, Michigan. Full map in `radar/data/flagship-ats-findings.md`. | 1–2h each | incremental |
| 3.2 | Interfolio driver — **done 2026-08-03.** Reversed the earlier "needs Playwright/scout" call: network-capturing one tenant found a plain unauthenticated JSON endpoint (`logic.interfolio.com/byc-search/{tenant_id}/public_job_boards`) with full descriptions inline — a normal `fetchJson` driver, no browser needed. `fetchInterfolioJobs`/`mapInterfolioJob` + `probeInterfolio` shipped. 74 hits discovered (up from 19 at last count). | `refresh.js`, `promote-employers.js` | ✅ |
| 3.3 | ~~Merge the 7 staged registry proposals~~ — **done 2026-08-03.** All 7 were already registered (scout-routed iCIMS, merged in an earlier pass); the only fresh hit was Norfolk State (Workday). | — | ✅ |
| 3.4 | iCIMS / PageUp / Paylocity — **resolved 2026-08-03, premise was wrong.** iCIMS needed no new driver: two `promote-employers.js` bugs (a subdomain-stripping regex artifact, and an identity-match rule too strict for short tenant names) were silently rejecting real candidates — fixed, surfacing 15 more (UCLA, UC Irvine, SRI International, Rockefeller University, Hackensack Meridian…). PageUp confirmed **non-viable**: 3/3 probed tenants (incl. Virginia Tech) redirect into an institutional SSO login — the discovered link is the internal board, not public. Paylocity got a real driver (`fetchPaylocityJobs`, list+detail pages are server-rendered HTML with inline JSON) — 8 of 11 UUID-shaped candidates wired. | `refresh.js`, `promote-employers.js` | ✅ |
| 3.5 | `SERPER_API_KEY` secret + wire `radar:websites` into monthly enrich — thaws the 14k-nonprofit tail | `.github/workflows/radar-enrich.yml` | 1h (needs user to obtain/fund the key) |
| 3.6 | UltiPro/Oracle discovery-crawl backlog — **done 2026-08-03.** The 2026-07-05 crawl had already found 12 UltiPro tenants and 30 Oracle CE hosts that were never promoted (`promote-employers.js` only auto-drafts workday/peopleadmin/icims proposals). Wired 11 UltiPro (incl. Scripps Research Institute, Northern California Institute for Research and Education) + 18 Oracle CE (incl. Icahn School of Medicine at Mount Sinai, UCSF, UT Health San Antonio) by hand-verifying host/site_number against each driver's existing shape — zero new code. | `radar/employers.json` | ✅ |
| 3.7 | Resume the discovery crawl past its first 1,100 sites (`scout/scout_discover.py --limit N`, resumable) — the 1,100 already crawled had 446 unpromoted ATS hits sitting idle (adp:44, csod:22, taleo:14, governmentjobs:17, dayforce:2, brassring:3 all have zero drivers today). A 400-site batch was still running as of session end. | `scout/scout_discover.py` | ongoing, resumable |

## App track — make it land jobs (2026-08-03 pivot)

Direction shift: stop hand-growing the DB (move enrichment to background agents);
make the *product* help land jobs. Job-landing funnel status:

| Layer | Status |
|---|---|
| **Fit ranking** — which jobs fit me, which résumé to send | ✅ now all 7 résumés (was 2): `.docx` support, matchable-term normalization, discriminated weights, recalibrated verdict tiers |
| **Daily loop** — fit digest + cross-device triage sync | ⚠️ digest built + launchd scaffold shipped; **user arms it** (NTFY_TOPIC). Triage sync still off (needs Supabase migration + token + auth) |
| **Pipeline** — applied→interview→offer | ✅ full triage funnel live; **2026-08-03: dedicated Pipeline view** (Radar \| Pipeline toggle, funnel stats bar, stage groups stalest-first, terminal states collapsed), `applied_at` rendered, **`variant_sent` recorded per application** (auto-stamped from the recommendation on apply, editable in the detail pane, in the sync schema), "did you apply?" nudge after opening a posting |
| **Today view** — in-app digest parity | ✅ 2026-08-03: min-verdict + first-seen-recency filters (URL-serialized) + ☀ Today preset chip applying the exact digest cut (24h→48h fallback, ≥good, sorted by fit); `verdictRank` shared via scoring.js so dashboard and digest agree by construction |

Next in this track: arm the digest, turn on triage sync, then daily-use UX
(mobile triage, PWA). Details in `HANDOFF.md` "Pick-up state". Both 2026-08-03
views browser-verified (24-assertion headless-Chromium pass).

## Small fixes / cleanups (bundle anytime)

- ~~`app.js:740` — meaningless identical ternary.~~ ✅ (already gone by 2026-08-03)
- ~~Dead `state.employers` / `/api/employers` path.~~ ✅ done 2026-08-03 (dropped the 162 KB fetch)
- ~~Debounce search input; precompute per-job search blob.~~ ✅ done 2026-08-03 (`job._searchBlob` + 150ms debounce)
- ~~`showAllRows` never resets on filter change.~~ ✅ done 2026-08-03 (resets on filter/sort change)
- ~~Doc drift: "9 adapters".~~ ✅ HANDOFF now says 13 drivers.
- Mobile: row-level triage buttons (keyboard shortcuts are the only fast path today); optional PWA manifest.
- Variant abbrev is a raw 6-char slice ("APPLIE", "DATA-E") — could be smarter.
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
