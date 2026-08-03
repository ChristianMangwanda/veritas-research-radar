# Veritas Research Radar — Project Map

*A one-page orientation. Start here when you've lost the thread. Last updated 2026-08-03.*

An engine that finds U.S. research jobs that are both **visa-safe** and **a fit for
your résumés** — and keeps them fresh on its own. Born 2026-07-03; ~1 month old.

---

## 1. The purpose

You're an international, early-career researcher on **F-1 / OPT**. Every U.S. job
has two hard filters: *will they sponsor a visa*, and *does it match what I
actually do*. Veritas answers both automatically.

It focuses on **H-1B cap-exempt** employers — universities, research institutes,
research hospitals — because they can sponsor H-1Bs year-round with no lottery.
It pulls their live postings, scores each against your own résumés, and tells you
which to apply to and which résumé to send. **It never writes résumés — it ranks
and routes the ones you wrote.**

## 2. How it works, end to end

```
309 cap-exempt      13 ATS job      auto-pull        ~11.5k live*     fit engine        you:
employers      →    systems     →   every 6h    →    jobs        →    (your 7      →    dashboard
(registry)          (Workday…)      (refresh.js)     (Supabase)       résumés)          + digest

*job count is pre-refresh as of this doc's last update — the 56 employers added
2026-08-03 fold in on the next scheduled 6-hourly run.
```

## 3. What we've built

- **Employer registry** (`radar/employers.json`) — 309 cap-exempt employers with
  their feed coordinates + sponsorship evidence (IPEDS/IRS/USCIS/DOL).
- **ATS drivers** (`radar/scripts/refresh.js`) — 13 wired systems: Workday,
  Oracle HCM, PeopleAdmin, SuccessFactors, Eightfold, UltiPro, Paylocity,
  Greenhouse, Lever, Ashby, SmartRecruiters, Workable, USAJOBS.
- **Refresh pipeline** — 7 scheduled GitHub Actions (§5). No servers.
- **Dashboard** (`radar/public/`, on GitHub Pages) — jobs ranked by fit,
  filtered by visa signal, moved through a triage funnel.
- **Fit engine** (`build-profile.js` + `scoring.js`) — reads your résumés
  locally, scores every job against all 7, recommends which to send.
- **Daily digest** (`digest-local.js`) — best new fits, once a day (needs arming).

## 4. What the database looks like

- **309 employers** (all cap-exempt) → **~11,487 active jobs** (of ~17,626
  tracked; ~6,139 closed but kept as tombstones) as of the last completed
  refresh — pre-dates the 56 employers added 2026-08-03. **0 recall alarms** =
  nothing silently lost.
- By job system: Workday 139 · PeopleAdmin 80 · Oracle HCM 32 · UltiPro 12 ·
  Paylocity 8 · Lever 3 · Greenhouse 2 · SmartRecruiters / SuccessFactors /
  Eightfold / USAJOBS / Workable 1 each · 28 not-yet-wired (scout-routed
  iCIMS boards + the remaining 10 dark flagships: MIT, Harvard, Broad… on
  closed or JS-only systems).
- Three job lanes: **ATS feeds** (primary), a **scout** for boards with no clean
  feed, and an **aggregator firehose** (Nature/Science careers).
- Dataset of record is **Supabase** (project `nawbdsujjysugaisczta`);
  `jobs.json` is a gitignored local mirror.

## 5. How it stays fresh

Seven scheduled GitHub Actions — nothing runs on your machine.

| Workflow | Runs | Does |
|---|---|---|
| Research Job Radar | every 6h | Pulls live jobs from all ATS feeds |
| Aggregator Firehose | 2×/day | Sweeps Nature/Science job boards |
| Employer Scout | weekly (Mon) | Discovers new cap-exempt employers |
| Enrichment | monthly | Refreshes sponsorship evidence (IPEDS/IRS/USCIS/DOL) |
| Deploy to Pages | every 6h | Rebuilds the live dashboard |
| Daily Digest | daily | Sponsorship-ranked summary (fit digest runs locally) |
| Dead-Man Switch | every 2h | Alerts if data goes stale >8h or feeds error |

**Safety net:** a refresh that reads an empty dataset *aborts instead of
overwriting*; any employer dropping to zero jobs raises a recall alarm; the
dead-man switch pings if the whole thing stalls.

## 6. How we got here

- **Jul 3** — Born as a Chrome extension: "Veritas Visa Eligibility Scanner"
  (color-codes any job page for sponsorship). Still the ranking core today.
- **Jul 11–19** — Grew into the Radar: employer registry + automated job pulls +
  dashboard. Hardened data (Tier 0), daily-driver triage (Tier 1), fixed data
  fields — salary/deadline/location/remote (Tier 2).
- **Jul 19 → Aug 3** — Coverage push (Tier 3): new ATS drivers, dark-flagship
  rescues; registry grew to 253.
- **Aug 3 (morning)** — Pivot to the app itself: fit engine now ranks all 7
  résumés (was 2), faster dashboard, daily digest built.
- **Aug 3 (afternoon)** — Back to coverage: two `promote-employers.js` bugs
  fixed (an iCIMS subdomain artifact, an over-strict identity match) unlocked
  15 real candidates that looked dead; a new Paylocity driver; a 56-employer
  discovery-backlog sweep (UltiPro/Oracle hits sitting unpromoted since
  July); registry 253 → 309. Prefilter recall-visibility instrumentation
  added so a bad title-matching regex gets caught automatically next time.

## 7. Where you are now

**Working & live:** discovery, fit ranking (7 résumés), honest verdict tiers,
the full triage funnel, the self-refreshing pipeline.

**Two things only you can switch on** (see `HANDOFF.md` → "Pick-up state"):
1. **Arm the daily digest** — set `NTFY_TOPIC` in `radar/scripts/.digest.env`,
   load the launchd agent.
2. **Turn on triage sync** — apply `radar/supabase/triage.sql` + set a token
   (needs you to authorize Supabase).

**Nice-to-have next:** move DB enrichment to background agents, scan the wider
nonprofit tail, rescue remaining dark flagships.

---

*Deeper docs: `HANDOFF.md` (how to run it + pick-up state) · `ROADMAP.md`
(what's done / next) · `CHANGELOG.md` (change log) · `radar/data/flagship-ats-findings.md`
(dark-flagship ATS map).*
