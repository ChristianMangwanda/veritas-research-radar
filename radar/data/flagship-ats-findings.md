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
