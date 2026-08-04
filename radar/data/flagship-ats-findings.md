# Dark-flagship ATS findings (Tier 3.1)

Live probe + headless-Playwright network sniff of the 19 dark null-provider
flagships, 2026-07-19. Goal: find a **supported** ATS tenant (workday, greenhouse,
lever, ashby, smartrecruiters, workable, peopleadmin, usajobs) to wire, else record
the real platform so the next increment is targeted (new driver vs. scout tune).

Method: `scratchpad/probe.js` (hits public ATS feeds), `detect.js` (careers-page
HTML signatures), `sniff.py` (scout venv Playwright — captures outbound ATS API
calls from JS-rendered boards). All three retained in the session scratchpad.

## ✅ Wired — Workday (verified end-to-end through `fetchWorkdayJobs`)

| id | tenant / host / site | total | research-relevant |
|----|----------------------|-------|-------------------|
| `hhmi` | hhmi / hhmi.wd1.myworkdayjobs.com / External | 40 | 31 |
| `memorial-sloan-kettering` | msk / msk.wd108.myworkdayjobs.com / MSKCC_Careers_Primary | 99 | 15 |
| `university-of-washington` | uw / **wd5.myworkdaysite.com** / UWHires | 547 | 111 |

Note UW is on `myworkdaysite.com` (shared Workday host, no tenant subdomain), not
`myworkdayjobs.com` — the tenant lives only in the CXS path. That shape is why the
2026-07-03 token-guess probes missed it; the "find a staff job" link on hr.uw.edu
gave it away.

## ✅ Wired — Oracle Fusion HCM (new `oracle` driver, verified through `fetchOracleJobs`)

New driver: `fetchOracleJobs` in `refresh.js` hits the public CandidateExperience
REST feed (`recruitingCEJobRequisitions` list + `recruitingCEJobRequisitionDetails`
per-job description), same title-prefilter/detail-cap discipline as Workday.
`ats_config = { host, site_name, site_number }`. Unit-tested via `mapOracleJob`.

| id | host / site_name / site_number | total | research-relevant |
|----|--------------------------------|-------|-------------------|
| `stanford-university` | careersearch.stanford.edu / stanford / CX_1 | 300 | 119 (all w/ full desc) |
| `mayo-clinic` | fa-euwp-saasfaprod1.fa.ocs.oraclecloud.com / Mayo-US / CX_1 | 1312 | 201 (27 w/ close date) |

`site_number` is read from the CE site bootstrap (`sites/{site_name}/` HTML); most
external sites are `CX_1`. The Oracle feed also yields structured posting-end dates
→ `deadline_raw`, so Tier 2.4 deadlines come for free where the employer sets them.

## Not wireable today — real platform identified (need new driver or scout tune)

Unsupported ATS platforms, grouped by what a future driver would unlock:

**Oracle HCM** — Stanford + Mayo now WIRED (see above). Still dark:
- `northwestern-university` — careers.northwestern.edu is Oracle (X-ORACLE-DMS
  headers, BIGip pool `chcareers`) but does **not** serve the Fusion CE REST API
  (`/hcmRestApi/...recruitingCEJobRequisitions` → 404; Playwright sniff of the jobs
  flow shows only same-origin `careers.northwestern.edu` traffic, no CE API call).
  It's a different/older Oracle recruiting product — needs its own probe or a
  scout scrape. Not reachable by `fetchOracleJobs`.

**SuccessFactors** — Baylor now WIRED (see below); JHU staff has MOVED to
Eightfold and is wired through the new `eightfold` driver (2026-07-30 probe:
jobs.jhu.edu redirects to careers.jhu.edu → hiring.jhu.edu → jhu.eightfold.ai;
faculty remain on Interfolio → Tier 3.2).

**Other named vendors** (one flagship each; lower leverage):
- `broad-institute` — Avature (broadinstitute.avature.net)
- `allen-institute` — ClearCompany (careers-api.clearcompany.com)
- `cleveland-clinic` — Findly (cdn-static.findly.com) + daliajobs
- `uc-berkeley` — UCPath PeopleSoft (ucphrprdpub.universityofcalifornia.edu)

**Custom same-origin boards** (no third-party ATS host — candidates for scout
`jobs_scrape.yaml` tuning + Playwright verify, the fred-hutch/iCIMS pattern):
- `mit` — hr.mit.edu, /jobs/search
- `salk-institute` — www.salk.edu/about/careers/open-positions/
- `st-jude` — talent.stjude.org/careers/SearchJobs (Recruitics-marketed, Phenom-style)
- `university-of-michigan` — careers.umich.edu/search-jobs
- `dana-farber` — careers.dana-farber.org
- `uw-madison` — jobs.wisc.edu (Clinch/PageUp-marketed custom board; internal hub is Workday `myworkday.com/wisconsin` but no public external tenant found)
- `harvard-university` — hr.harvard.edu/jobs (careers page 403s; likely Brassring)

## ✅ Wired — SuccessFactors CSB (new `successfactors` driver, 2026-07-30)

CSB tenants render search results client-side (search page and
tile-search-results both come back empty), but publish every posting in
`sitemap.xml` (`/job/<slug>/<id>/` — id is canonical, slug is cosmetic and
carries title+location text for the prefilter) and serve microdata-tagged
detail pages (`itemprop="title"`, `Location:` / `Requisition ID:` labels, job
body between the two `itemprop="description"` spans). `ats_config = { host }`.

| id | host | total | research-relevant |
|----|------|-------|-------------------|
| `baylor-college-of-medicine` | jobs.bcm.edu (tenant BCM on performancemanager4) | 444 | 293 (all w/ desc+loc+date) |

## ✅ Wired — Eightfold PCSX (new `eightfold` driver, 2026-07-30)

Eightfold career hubs proxy a plain JSON API on the employer's own host:
`/api/pcsx/search?domain=<domain>&query=&start=N` (page size pinned to 10,
total in `count`) + `/api/pcsx/position_details?position_id=<id>&domain=…&hl=en`
(full `jobDescription`, locations, department). `ats_config = { host, domain }`.
Curl-friendly, no WAF on the API path (the HTML site 403s non-browser TLS).

| id | host / domain | total | research-relevant |
|----|---------------|-------|-------------------|
| `johns-hopkins-university` | hiring.jhu.edu / jhu.edu | 529 | 211 (all w/ desc+loc+date) |

## ✅ Wired — Workday, round 2 (2026-08-03)

St. Jude's public careers page (stjude.org/jobs.html) fronts a Phenom board
(talent.stjude.org) whose `JobDetail/<slug>-JR####/<id>` links **redirect into a
Workday tenant**. Recovered the tenant by following those redirects and wired it
through the existing `fetchWorkdayJobs`.

| id | tenant / host / site | total | research-relevant |
|----|----------------------|-------|-------------------|
| `st-jude` | stjude / stjude.wd1.myworkdayjobs.com / stjude | 176 | 107 (all w/ full desc) |

## ✅ Wired — UltiPro / UKG CSB (new `ultipro` driver, 2026-08-03)

UKG Recruiting "JobBoard" tenants expose a public JSON search feed:
`POST /{tenant}/JobBoard/{guid}/JobBoardView/LoadSearchResults` returns
`opportunities[]` with `Title`, `RequisitionNumber`, `JobCategoryName`, rich
`Locations[]` (address+state), `PostedDate`, and a real `BriefDescription`
(a few hundred chars) **inline** — so no per-job detail call and no title
prefilter (keep every posting; scoring ranks). `ats_config = { host, tenant,
boards: [guid…] }`; a tenant can front several boards (staff/faculty), iterated
and deduped by opportunity `Id`. `mapUltiproJob` keys the id on the stable
`RequisitionNumber`, not the per-board opportunity GUID.

| id | tenant / boards | total | research-relevant |
|----|-----------------|-------|-------------------|
| `salk-institute` | SAL1013SIBS / 2 non-empty boards | 11 | 11 (all w/ BriefDescription); incl. Research Software Engineer I (AIRC), 4 Postdoctoral Fellows |

## Dedup — Dana-Farber (2026-08-03)

`dana-farber` (null-ATS manual entry) was a duplicate of the live Workday entry
`dana-farber-cancer-institute` (same careers.dana-farber.org tenant, ~76 jobs).
Merged the curated fields (proper-case name, research_areas) into the Workday
entry and **re-keyed its DOL sponsor signal** (101 certified LCAs, 3y) in
`dol-sponsor-signals.json` so no sponsorship evidence is orphaned, then removed
the null entry. Registry 239 → 238.

## ⏸️ Deferred — no clean public endpoint (2026-08-03 probe)

- `university-of-michigan` — careers.umich.edu is **Drupal**; jobs render via
  AJAX Views/BigPipe (no server-rendered `job_detail` links, no `ajaxViews` in the
  initial `drupalSettings`). The only structured feed is the marketing RSS
  `/search/feed/advanced`, which is a limited recent-window slice (keyword search
  returns ~9, no real pagination) — wiring it would trip the Tier-0 recall-anomaly
  guard as jobs age out of the window. Needs an interactive-search + rendered
  pagination scrape; not worth the fragility now.
- `mit` — hr.mit.edu is Drupal but only **links out** to PeopleClick/PeopleFluent
  (careers.peopleclick.com/careerscp/client_mit). That external site is an
  AngularJS 1.2 app that returns a fixed ~90KB shell for every stateless request;
  job results load only via a stateful in-app search (session + CSRF). No public
  JSON/HTML inventory feed. A driver would mean replicating the stateful
  PeopleFluent search — fragile and login-adjacent. Not wired.

## ✅ ATS discovery scan over the candidate pool (2026-08-03)

Beyond the 19 named flagships: ran an ATS-detection sweep
(`scratchpad/ats_scan.py`) over the 220 top-scored discovery candidates
(cap-exempt research orgs with websites in `cap-exempt-directory.json`), fetching
each root + a careers page and matching every platform we already have a
config-only driver for (UltiPro, Workday, Oracle CE, SuccessFactors, Eightfold).
16 hits; **15 wired** as new `tier:auto` cap-exempt IHE entries after end-to-end
driver verification:

- **Workday (5)** — liberty-university, new-jersey-institute-of-technology,
  santa-clara-university (myworkdaysite host), wentworth-institute-of-technology,
  albany-medical-college. +60 research-relevant.
- **Oracle CE (10)** — university-of-maine, east-tennessee-state-university,
  loma-linda-university, tennessee-technological-university, vanderbilt-university,
  baylor-university, university-of-tulsa, st-olaf-college, depaul-university,
  champlain-college. ~197 research-relevant. **Trap:** Oracle hosts front several
  sites; pick the `StatusCode: ORA_ACTIVE`, non-student/non-test site (Baylor's CX_1
  is "Student Employment"; the real staff site is CX). The `SiteNumber` doubles as
  the apply-URL path token (verified 200), so `site_name = site_number`.

**Follow-up:** `University of South Florida` matched Oracle CE (`/hcmUI/CandidateExperience`
in its careers HTML) but its Oracle host wasn't resolved from the page — needs a
targeted probe to find the `*.oraclecloud.com` host + canonical site, then it wires
like the others. No UltiPro/SuccessFactors/Eightfold hits in this pool (Salk's UltiPro
board came from the curated set). Scan `cap-exempt-directory.json`'s 5,971
websites for more `recruiting*.ultipro.com` boards next.

## Suggested next increments (value order)

1. ~~Oracle HCM driver~~ — **DONE** (Stanford + Mayo wired). The `oracle` fetcher can
   also absorb any other Fusion-CE employer discovered later — a wire is just an
   `ats_config { host, site_name, site_number }` edit.
2. ~~SuccessFactors driver~~ — **DONE** (Baylor wired; the driver reaches any CSB
   tenant via `ats_config { host }`). ~~JHU staff~~ — **DONE** via the new
   `eightfold` driver (JHU migrated ATS between the crawl and 2026-07-30).
3. ~~Scout tune the custom same-origin boards~~ — **INVESTIGATED 2026-08-03,
   mostly not viable.** The "custom same-origin" premise dissolved on probe: St Jude
   was really Workday (wired), Salk was UltiPro (new driver, wired), Dana-Farber was
   a dup of an existing Workday entry (dedup). Only true same-origin scrape targets
   left are Michigan + MIT, both **deferred** (Drupal-AJAX / PeopleFluent, no public
   inventory — see above). Still-unprobed same-origin candidates: UW-Madison,
   Harvard, Northwestern (non-CE Oracle).
4. **UltiPro driver leverage** — the new `ultipro` fetcher reaches any UKG CSB tenant
   via `ats_config { host, tenant, boards }`. Scan the 14k-nonprofit tail for
   `recruiting*.ultipro.com` boards to thaw more employers with zero new code.
5. Avature (`broad-institute`) / ClearCompany (`allen-institute`) / Findly
   (`cleveland-clinic`) drivers — one flagship each, lowest leverage.

## 2026-08-03 session: discovery-backlog wiring + iCIMS/PageUp/Paylocity corrected

The 2026-07-05 discovery crawl (`radar/data/ats-discovery.json`, 1,100 sites
at session start) had far more unpromoted signal sitting in it than the
earlier 220-candidate scan covered. Cross-referencing by **host**, not name
(a name-string match nearly produced a duplicate: St. Olaf College's Oracle
host was already registered under a punctuation-different name) found:

- **UltiPro: 12 hits, 11 wired** (Trinity Christian College's board is empty).
  Board GUIDs aren't in the crawled URL — they surface in the tenant's own
  `JobBoardView` page (even a 404 response body carries it). Standouts:
  Scripps Research Institute, Northern California Institute for Research and
  Education.
- **Oracle CE: 30 hits, 18 wired** (12 were already registered). Icahn School
  of Medicine at Mount Sinai had two candidate hosts; one was a
  `dev13`-named staging tenant reporting a bogus 6,221-job count with an
  empty `requisitionList` — used the real one instead (confirmed via actual
  posting content). `siteNumber` isn't gated for most single-site tenants
  (any string returns the same results); `site_name` is set to match the
  tenant's real candidate-facing URL path.
- **iCIMS: the "45 candidates" premise was a probe bug, not a routing gap.**
  `promote-employers.js`'s icims regex strips a literal `careers-` prefix to
  normalize decorative subdomains — but for hosts like
  `careers-sri.icims.com` / `careers-rockefelleruniversity.icims.com` that
  prefix **is** the real subdomain, so the stripped tenant always 404'd.
  Separately, `tenantMatchesName`'s substring rule required 4+ characters, so
  a short exact match (tenant `sri` vs. the word "SRI" in "SRI
  International") never passed. Both fixed; re-running promotion surfaced 15
  more real, identity-verified candidates: SRI International, Rockefeller
  University, UCLA, UC Irvine, Hackensack Meridian (1,546 postings), Eastern
  Virginia Medical School, NYIT, San Diego State (via its research
  foundation), American Enterprise Institute, Lovelace Biomedical,
  Auburn-Montgomery, Arizona State (Campus Immersion), Embry-Riddle
  Prescott, Arkansas State-Beebe, Athens State. Four of these
  (UCLA/UC-Irvine/Rockefeller/Auburn-Montgomery) show 0 in the sitemap-based
  probe count — confirmed this is a **platform-wide iCIMS bot-gate on
  `/sitemap.xml` specifically**, not real emptiness: the candidate-facing
  `/jobs/search` pages load fine and identity was confirmed by title or
  acronym match. Scout's Playwright render doesn't hit the sitemap endpoint
  at all, so this shouldn't affect real scouting.
- **PageUp: confirmed non-viable, 3-for-3.** Every probed tenant (Virginia
  Tech this session; two others in an earlier design pass) redirects the
  discovered `careers.pageuppeople.com` / `*.dc4.pageuppeople.com` link into
  an institutional SSO login (SAML2 for VT). The iframe embedded on the
  public marketing careers page is the **internal-employee** board; the
  genuinely public candidate board, if one exists, lives somewhere the
  discovery crawl's regex didn't catch. Not pursued further — no driver
  built, and none of the 57 discovered hits should be assumed drivable
  without a fresh per-tenant probe.
- **Paylocity: real driver shipped.** The public recruiting pages are plain
  server-rendered HTML — no JS API to reverse-engineer. The list page embeds
  the full job set as an inline `window.pageData = {...}` blob (title,
  location, department, date, and a truncated teaser); the detail page
  embeds a standard schema.org `JobPosting` JSON-LD block with the full
  description. `fetchPaylocityJobs`/`mapPaylocityJob` added following the
  SuccessFactors list+detail shape; `probePaylocity` added to
  `promote-employers.js`. Of 59 discovered hits, only 11 had a genuine
  UUID-shaped tenant (the crawl regex also matches plain job-id digits in
  `/Details/<id>` links, which aren't usable client_guids); 8 wired
  (University of Detroit Mercy, Tiffin, New England College of Optometry,
  Elizabethtown, Northwest Nazarene, Midwestern Baptist Theological
  Seminary, Keuka College, BAIM Institute for Clinical Research), 2 correctly
  rejected as identity mismatches (Arkansas Northeastern's guid actually
  belongs to a hospital system).
- **Interfolio: real driver shipped (reversed the earlier "deferred" call).**
  `apply.interfolio.com/<id>` is indeed an AngularJS 1.7 SPA, but
  network-capturing one real tenant with Playwright (not just reading the
  static HTML) found the actual XHR it makes:
  `https://logic.interfolio.com/byc-search/{tenant_id}/public_job_boards`
  — a plain, unauthenticated, paginated JSON endpoint with the full
  description/qualifications/instructions HTML already inline (no separate
  detail fetch needed, unlike Workday/Oracle/SuccessFactors/Eightfold). The
  `{tenant_id}` is exactly the number in the discovered `apply.interfolio.com/<id>`
  URL. A second endpoint, `dossier-api/positions/{id}`, looked related but
  turned out to be an unrelated internal id space (single-position lookups by
  a different numeric counter) — confirmed by a coincidental cross-tenant
  collision (id 31694 resolved to a stale Millikin University posting there,
  while `byc-search/31694/...` correctly returned Case Western Reserve's real
  130-posting board) — so it's not used. Identity is verified for free: the
  list response's own `title` field literally names the institution ("Case
  Western Reserve University Positions"). `fetchInterfolioJobs`/
  `mapInterfolioJob` added; `probeInterfolio` added to
  `promote-employers.js`. 74 hits discovered so far (up from 19); the
  crawler's fallback "interfolio" keyword match (no resolvable id, e.g. Yale,
  JHU) can't be auto-wired and needs manual careers-page follow-up.
- **Registry: 253 → 331** across this session (Norfolk State via the stale
  proposal re-run, USF Oracle CE host resolution, the UltiPro/Oracle
  backlog, the iCIMS bug-fix batch, the Paylocity batch, an extended
  1,100→1,500-site discovery crawl, and — in a follow-on pass — the
  Interfolio driver).

## 2026-08-04 session: prefilter-anomaly metric fix + verification pass

- **Registry: 331 → 346** (4 Interfolio, 11 more from the continued
  discovery crawl). Discovery crawl then moved off the laptop entirely into
  a new `radar-discover.yml` GitHub Actions workflow (monthly + on-demand),
  since the remaining ~4,471-site backlog needs hours of wall-clock time.
- **Prefilter-anomaly detector: found and fixed a real metric conflation
  bug on its first night of live production data.** It flagged 21
  employers. Investigating live (fetching each one's raw title list) found
  the detector was comparing `prefiltered_count` (titles rejected by the
  title regex) against `fetched_jobs` — the FINAL count, taken *after* the
  separate `tier: 'auto'` relevance-score filter (`AUTO_TIER_MIN_RESEARCH_SCORE`)
  runs downstream. Those are two independent filters: an employer whose
  title-prefilter correctly passed several candidates, all of which then
  legitimately scored too low to ship, looked identical to a genuinely
  broken prefilter regex. Confirmed concretely against Bank Street College
  of Education: the title prefilter passed 4 of 79 titles fine ("Faculty -
  Leadership Programs" and similar); all 4 legitimately scored below the
  auto-tier threshold on their actual description content (K-12 pedagogy
  training, not scientific research) — not a prefilter defect.
  Fix: every prefiltering driver (workday/oracle/successfactors/eightfold/
  paylocity) now also stamps `prefilter_survived_count` (the title regex's
  own pass-through, before any detail fetch or scoring); the detector
  compares against that instead. Re-running all 21 flagged employers live
  against the corrected metric dropped the flagged count to 5, then to 3
  after also raising `PREFILTER_ALARM_MIN_EXCLUDED` 20 → 25 (two of the
  five sat exactly at the old floor — too small a sample to mean much
  either way). All 3 remaining were manually reviewed title-by-title and
  are genuinely low-research employers, not bugs: Washington and Lee
  University (0 research-shaped titles among 25 real postings — food
  service, athletics, safety), Hult International Business School (an
  enrollment/marketing-heavy for-profit operator, not primarily academic),
  Palm Beach State College (a trade/vocational community college — welding,
  cosmetology, HVAC adjunct instructors). No `isResearchRelevantTitle`
  keyword changes were needed — the regex itself held up under direct
  inspection every time.
- **The Workday identity-check gap (fixed 2026-08-03) had two live siblings.**
  Greenhouse and SmartRecruiters probes in `promote-employers.js` skipped
  identity verification entirely, same as Workday did before. Fixed both:
  Greenhouse's `/v1/boards/{token}` endpoint (separate from the `/jobs`
  listing) returns `{name}`; SmartRecruiters' existing postings response
  already embeds `content[0].company.name` for free, no extra request. Both
  verified live against real registered tenants (American Institute,
  Scripps Research) with zero false rejections. Lever and Ashby have no
  identity-bearing field anywhere in their public APIs (checked live) — an
  accepted, documented residual gap: Lever has only 3 registered employers
  and tokens come from links scraped off the institution's own site, not
  guessed via multi-site probing (what made the Workday case risky); Ashby
  has zero registered employers today, so it's currently theoretical.
- **The registry can now represent an employer with two ATS feeds.**
  University of Rochester was registered as `workday` (a staff board) but
  also runs a completely separate Interfolio faculty board with 355 real
  open postings — invisible to the dataset until now, because the schema
  only supported one feed per employer. Root cause in
  `promote-employers.js`: `buildProposals()` bailed on `existingIds.has(id)`
  *before* ever looking at other discovered ATS hits for that same
  institution, so a second feed for an already-registered employer was
  silently discarded every single run. Added optional
  `secondary_ats_feeds` to the employer schema; `fetchEmployerJobs` now
  merges every feed fail-soft (reusing every existing driver unchanged via
  a per-feed view object); `promote-employers.js` gained a
  `findSecondaryFeedCandidates` pass reusing the exact same identity-firewall
  probes. 6 candidates wired after live verification: University of
  Rochester (355 postings), Georgetown University (44), Baylor University
  (42), San Diego State University (2), Wake Forest University (8),
  Hillsdale College (1) — all Interfolio faculty boards alongside an
  existing Workday/Oracle/PeopleAdmin staff board. **A defensive fallback
  for a separate known bug (13 employers with `id !== slugify(name)`) was
  tried and reverted after it live-matched "Nebraska Methodist College of
  Nursing & Allied Health" to "The University of Texas Health Science
  Center at San Antonio" — two unrelated institutions sharing only the
  token HEALTH.** Caught before anything was wired; the id-mismatch gap
  itself remains open, undersized for a loose name-overlap fix.

## Phase 4: the next four un-driven platforms (2026-08-04)

Probed one real, live, discovered tenant for each before writing any driver
code, per the session's own discipline (a lesson from PageUp/Paylocity
earlier).

- **ADP Workforce Now: not viable.** Discovered links
  (`workforcenow.adp.com/mascsr/.../recruitment.html?cid=...&ccId=...`) are
  per-posting/per-category deep links, not a stable company-wide board — 8
  real discovered links across 2 institutions (Bradley University,
  Jacksonville University; every `ccId` variant tried for each) all returned
  "This page is currently not available." The generic company-level URL
  (`.../careercenter/public/index.html?cid=...`) redirects into an ADP login
  page instead of a public board. Not pursued further.
- **GovernmentJobs/NeoGov: real driver shipped.** Discovered links resolve to
  `schooljobs.com` for education-sector tenants (NeoGov's higher-ed brand).
  The public board page looks JS-rendered (spinners, no server-rendered job
  rows) — but network-capturing the real request found the same list URL
  (`schooljobs.com/careers/home/index?agency={agency}&sort=...`) returns a
  totally different response depending on one header: with
  `X-Requested-With: XMLHttpRequest` it returns the plain HTML job table
  fragment directly (department, location, posting date, job id — no JS
  execution needed), confirmed live against Youngstown State University (94
  real postings, including genuine faculty roles). Detail pages are plain
  server-rendered HTML too. `fetchGovernmentJobsJobs`/`mapGovernmentJobsJob`
  added following the Workday/Oracle list+detail shape; `probeGovernmentJobs`
  added to `promote-employers.js` (identity via the page's own "Career
  Opportunities at {Institution}" `<title>`). 49 hits discovered so far.
- **Cornerstone OnDemand and Taleo: inconclusive, not pursued further this
  session.** Both show the same "enterprise-SaaS, needs deeper reverse-
  engineering than a quick probe" shape as ADP: Cornerstone's board is a
  JWT-token-gated SPA (`us.api.csod.com` with a bearer token embedded in
  page context) that requires in-app navigation past a generic "Welcome"
  page before any job data loads; Taleo's bare tenant domain
  (`{tenant}.taleo.net`) redirects into `smartorg/.../toc.jsf` — an internal
  recruiter tool, not the public candidate board — and the public board's
  numeric "career section" id isn't captured by the discovery crawl's
  bare-domain signature (guessed ids 1–10 against a real UAB tenant all
  failed). Both need either a Playwright scout path (finding the real
  in-app navigation/API calls) or mining the real deep link off each
  institution's own careers page, same as `mineWorkdayTenant` does for
  vanity Workday portals — real future work, not a quick win.
