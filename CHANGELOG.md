# Changelog

All notable changes to Veritas are documented in this file.

## [Unreleased]

### Added (Phase 3: coverage flywheel)
- **ATS discovery pipeline**: websites flow into the cap-exempt directory
  (IPEDS WEBADDR + resumable nonprofit resolver), and `scout_discover.py`
  crawls careers pages harvesting ATS links — URL patterns with tenant
  extraction for 20+ providers plus content signatures that unmask platforms
  behind vanity domains. First census (106 top-evidence employers, 68%
  identified): iCIMS 26, Workday 20, PeopleAdmin 16, PageUp 8 — the adapter
  priority list is now data, not guesswork.
- **promote-employers.js**: probes crawl-discovered Workday tenants via the
  live CXS API (best site board wins), drafts registry proposals with crawl
  provenance as identity, merges on approval. First wave: 23 universities
  wired (registry 25 → 48), including WashU, Cornell, CMU, Brown, Georgetown,
  Rochester, Northeastern — ~5,700 live postings behind them.
- **Auto-tier guard**: crawl-wired employers commit only research-relevant
  postings (score ≥ 25 or class evidence), so wiring a university adds its
  labs, not its cafeteria shifts.

### Added (Phase 2: behavioral evidence)
- **Title-class evidence engine**: every LCA row and every posting classifies
  through one shared taxonomy (`lib/title-class.js`, 9 classes + SOC-code
  fallback). The DOL importer now emits per employer × class certified counts,
  median annualized wages, and sample titles; refresh attaches the bucket
  matching each posting's class. A UCSF postdoc posting now shows "47 postdoc-
  class LCAs (3y), median $77,030" instead of an institution-wide number.
- **Sponsor signal is behavioral-first**: strong requires class-level history
  (or explicit sponsorship text plus institution history); institution-wide
  counts alone cap at moderate. 133 of 750 eligible jobs now rank strong on
  class-backed evidence.
- **Evidence-first dashboard**: green "sponsors <class> ×N" chips on rows,
  "Sponsorship evidence" cell with wage medians leads the signal grid, the
  text scan is demoted to a "Posting language" footnote, new evidence sort,
  and NEUTRAL chips no longer clutter every row.
- **Dashboard on GitHub Pages**: the same bundle now runs statically —
  /api/* falls back to committed JSON copies, triage falls back to
  localStorage. Deployed by `pages.yml` on a schedule (bot commits can't
  trigger workflows) to christianmangwanda.github.io/veritas-research-radar.
- **Daily digest** (`radar/scripts/digest.js` + `radar-digest.yml`): new
  eligible jobs from the last 24h ranked by class evidence, pushed via
  ntfy.sh at 13:05 UTC. Prints-only until the NTFY_TOPIC secret is set.

### Added (Phase 1: signal honesty)
- **Federal citizenship gate**: USAJOBS postings are citizen-gated by default
  (the requirement lives in hiring-path metadata, not description text) and
  marked RESTRICTED at the mapper level; the dashboard hides them unless
  "Include citizen-only federal" is checked, and headline stats exclude them.
- **Negation guard now covers FRIENDLY matches**: "applicants should not expect
  that sponsorship will be offered" no longer reads as an offer. New restricted
  pattern for "does not commit to providing visa sponsorship".
- **Ground-truth analyzer corpus** (`tests/analyzer-corpus.json`): labeled real
  + synthetic excerpts with per-class precision/recall printed on every test
  run; pins every false positive found in the wild (USCIS-agency-name-as-
  friendly, negated offers). Corpus immediately caught three recall gaps —
  including that the cap-exempt pattern promised since v1.2 never existed
  (now added; 120 patterns: 67 restricted / 53 friendly).
- Tightened "immigration services" to require providing-context — the bare
  phrase is the name of the federal agency.
- **Word-boundary fit matching**: the resume matcher no longer matches skill
  "r" against every posting or "api" against "rapid".
- **Honest evidence labels**: "verified" cap-exempt pill replaced with
  "Institution status: cap-exempt confirmed via IPEDS/IRS…"; sponsorship
  history is explicitly marked institution-wide, not role-specific.
- **Incremental aggregator detail-fetch**: previously fetched descriptions are
  reused from the committed store, so each run's budget goes only to unread
  jobs and description coverage converges instead of plateauing at ~50%.

### Added
- **Dashboard redesign**: three-pane triage layout (filters / scannable job list /
  full detail pane) with keyboard flow (j/k navigate, o open, s/a/e/v/x triage,
  / search), matched-phrase highlighting inside the full description, one-click
  triage buttons, a stat strip (active / new-for-you / friendly / employers),
  dark mode with a theme toggle, discovery and source-error drawers, an empty
  state with filter reset, and a list-first mobile layout with a filters toggle.
- Weekly employer-scout workflow (`radar-scout.yml`): scouted snapshots expire
  after 14 days; CI now re-scouts ATS-less employers every Monday so their jobs
  stop silently tombstoning.
- Aggregated jobs without captured descriptions are now explicitly marked
  (`description_captured: false` + disclaimer) so a NEUTRAL visa state can't be
  mistaken for "posting scanned, no visa language found".

### Fixed
- Extension: manual rescan (toolbar click) on an already-scanned page removed
  the badge without redrawing it; the rescan now resets the content hash.
- Extension: highlight toggle no longer needs two clicks after a badge is
  dismissed or replaced (stale `highlightsVisible` state).
- Extension: removed a literal NUL byte embedded in ui.js that made git treat
  the file as binary.
- Radar: CSV parsing now handles quoted fields containing newlines across all
  government-file readers (new `parseCsv`/`csvRecords` in lib/csv.js); the DOL
  importer streams the multi-hundred-MB file instead of buffering it.
- Radar: aggregator-firehose jobs now pass the same url/title integrity filter
  as the scout path.
- CI: the four data workflows share one concurrency group with staggered crons,
  so simultaneous runs can no longer race to a failed non-fast-forward push of
  jobs.json.

### Added (prior firehose work)
- **Aggregator firehose**: single repo now includes the Python+Playwright scout
  (`scout/`). Scrapes research-job boards (Nature Careers, Science Careers,
  HigherEdJobs), resolves every job's employer against a generated ~20,000-entry
  cap-exempt directory (IPEDS + IRS-research universe), and keeps only the
  cap-exempt matches. First run: 551 scraped → 110 kept across 53 new employers
  (dataset 172 → 282 jobs, live employers 5 → 58).
- **Automated DOL download** (`scout/scout_dol.py`): pulls the Akamai-gated OFLC
  LCA disclosure file via a real browser session and converts it to CSV. All
  four enrichment datasets now feed the signal (first import: FY2026 Q2,
  1.04M records; 22/25 registry employers carry sponsorship counts).
- Dashboard: source filter, cap-exempt-score badge + sort.
- Policy: the scout treats robots.txt as advisory (owner decision); throttled,
  no CAPTCHA defeat. Aggregators previously ruled out are now in scope.

### Added (prior two-layer work)
- **Two-layer cap-exempt instrument**: 6-hourly job sourcing + monthly signal
  enrichment joining IPEDS, IRS EO BMF, USCIS H-1B Data Hub, and DOL LCA data
  via a confidence-ordered entity-resolution library (aliases, token matching,
  false-positive guards)
- Four new daily sources: USAJOBS (official API, free key), Recruitee, Breezy,
  Workable — nine ATS adapters total
- Enrichment outputs: employer evidence overlay (20/25 registry employers now
  hard-"verified"), ranked discovery list of 250 new cap-exempt employer
  candidates (dashboard panel + /api/discovery), and an alias worklist report
- Scout producer contract (radar/SCOUT-CONTRACT.md) + validating importer with
  stable URL-hash ids, snapshot-replace semantics, and 14-day TTL — feeds
  Playwright-scouted jobs from the LadyLibertysBrief agent into the radar
- Monthly enrichment GitHub Action; daily refresh now runs every 6 hours
- New RESTRICTED patterns: "US persons only", ITAR / export control / deemed export,
  and restrictive TN/E-3/O-1/L-1 counterparts (117 patterns total: 66 restricted / 51 friendly)
- Sentence-scoped negation guard: negated restricted phrases ("No security clearance
  required", "not subject to ITAR") no longer flag a posting as restricted
- Radar: Ashby, SmartRecruiters, and Workday adapters alongside Greenhouse/Lever;
  live sources grew from 1 to 4 employers (CZ Biohub, Scripps Research, UCSF,
  University of Chicago — 165 jobs, up from 29)
- Radar: fetch retry with backoff, inter-employer rate limiting, and closed-posting
  tombstones with 30-day retention (transient errors never mass-close jobs)
- Dashboard: sort control, "new since last visit" badges and filter, closed-posting
  toggle with warnings for triaged jobs, URL-persisted filters, per-employer error
  detail, smarter PhD-requirement fit penalty

## [1.3.0] - 2026-07

### Added
- **Research Job Radar**: local-first pipeline that fetches postings from public ATS APIs
  (Greenhouse/Lever) for curated likely cap-exempt research employers, scores them with the
  shared Veritas analyzer, and serves a triage dashboard (`npm run radar:refresh` / `npm run radar:serve`)
- Optional DOL LCA disclosure import as a local sponsorship-history signal (`npm run radar:import-dol`)
- Daily GitHub Actions refresh of the public radar dataset
- Automated test suite (`npm test`) covering the shared analyzer and radar pipeline
- Test fixture pages under `tests/test-pages/` for manual extension testing
- LICENSE, CHANGELOG.md, and INSTALLATION.md

### Changed
- Keyword engine is dual-exported (browser IIFE + CommonJS) so the extension and radar share one analyzer
- Version aligned to 1.3.0 across manifest, package, and docs

### Fixed
- Keyword highlighting now wraps only the matched phrase instead of the entire paragraph,
  and duplicate phrases no longer trigger redundant page scans
- Content script no longer throws when a non-Error value is raised during a scan
- Removed dead state tracking in the content script

## [1.2.6] - 2026

### Changed
- Detection patterns expanded to 109 (58 restricted / 51 friendly)
- Stability improvements to scanning and badge rendering

## [1.2.0] - 2026-01

### Added
- 95+ keyword patterns (up from 44)
- Manual scan of any webpage via the toolbar icon
- Dismissible badge with close button
- New high-contrast icon
- New detections: security clearance as citizenship proxy, cap-exempt H-1B positions,
  TN visa (Canada/Mexico), E-3 visa (Australia), immigration team mentions, H-1B transfer support

### Changed
- Content hashing prevents badge blinking on unchanged pages
- Auto-scanning restricted to job sites (no longer runs everywhere)
