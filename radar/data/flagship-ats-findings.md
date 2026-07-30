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

## Suggested next increments (value order)

1. ~~Oracle HCM driver~~ — **DONE** (Stanford + Mayo wired). The `oracle` fetcher can
   also absorb any other Fusion-CE employer discovered later — a wire is just an
   `ats_config { host, site_name, site_number }` edit.
2. ~~SuccessFactors driver~~ — **DONE** (Baylor wired; the driver reaches any CSB
   tenant via `ats_config { host }`). ~~JHU staff~~ — **DONE** via the new
   `eightfold` driver (JHU migrated ATS between the crawl and 2026-07-30).
3. **Scout tune** the custom same-origin boards (MIT, Salk, St Jude, U-Michigan,
   Dana-Farber, UW-Madison, Harvard, + Northwestern's non-CE Oracle) — each ~1h: set
   `listing_url` + anchor `selector` in `scout/jobs_scrape.yaml`, verify with
   `scout/.venv` Playwright, `npm run radar:import-scouted`. Only viable where
   job-detail anchors match `JOB_DETAIL_PATTERN`; some SPAs render cards without
   per-job anchor hrefs.
4. Avature / ClearCompany / Findly drivers — one flagship each, lowest leverage.
