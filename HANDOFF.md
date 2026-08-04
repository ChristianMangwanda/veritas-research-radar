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

Both resume steps run a local model via Ollama (nothing leaves the machine).
One shared knob: `OLLAMA_MODEL` (default `qwen2.5:7b-instruct`), `OLLAMA_URL`
(default localhost). `radar:profile -- --provider anthropic` switches
extraction to hosted Claude if local quality is not enough.

## Resume-variant ritual (ranking + routing)

The radar never writes resumes — you do. It ranks jobs against your own
resume variants and tells you which one to send.

0. Install [Ollama](https://ollama.com) and `ollama pull qwen2.5:7b-instruct`
   (the same model serves both extraction and routing). Extraction is
   structured parsing, not deep reasoning — a local 7-8B model handles it and
   your resume text never leaves the machine.
1. Drop your resume variants (txt/md/pdf) into `radar/data/resumes/`
   (gitignored). Run `npm run radar:profile` once — it scaffolds
   `manifest.json`; fill in each variant's `label` and one-line `intent`
   ("Leads with production ML, PyTorch, MLOps") and re-run. One local
   extraction per variant, cached by content hash + model: adding a 6th
   resume later re-extracts only the new one (`--force` to redo all). If the
   local profile looks thin, re-run with `-- --provider anthropic`.
2. Reload the dashboard. Jobs now carry a fit score, a verdict tier, a
   "use <variant>" chip, and ⚠ flags for hard gates (PhD required,
   citizens-only). Gates demote — they never hide a job. The detail pane's
   why panel shows per-variant scores, matched terms, and the posting's own
   degree-requirement sentence.
3. Optional: `npm run radar:route` — the same local model re-judges only the
   jobs where two variants scored within 8 points and caches the verdicts
   (`route-cache.json`, gitignored, invalidated when the profile changes).
4. Hosted (Pages) dashboard: import `radar/data/profile.json` (and
   optionally `route-cache.json`) via the sidebar profile card — they
   persist in that browser's localStorage only.

## Notifications + hosted dashboard

- Dashboard (static, auto-refreshed every 6h):
  https://christianmangwanda.github.io/veritas-research-radar/ — triage state
  lives in that browser's localStorage; the local `npm start` server keeps
  using `radar/data/local-state.json`.
- Three views, toggled in the list header (2026-08-03 redesign — light steel
  system, Barlow type, per the design brief in the repo root): **Radar** (the
  5-column cockpit table: role, fit bar, visa + evidence, send-résumé call,
  closes), **Pipeline** (your applications grouped by stage under the
  instrument strip: next-pull gauge + the 7 system tiles; ignores every filter
  except search), and **Routing** (every résumé heat-scored in-row, filter
  chips, CSV export). The **☀ Today** chip applies the digest's exact cut
  in-app: seen ≤24h (48h fallback), verdict ≥ good, sorted by fit. Marking a
  job Applied records which résumé variant was sent (editable in the detail
  pane; "Copy résumé path" hands you the file). Save-this-view presets and
  Ignore-employer live in the sidebar footer.
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

The **funnel redesign** shipped 2026-08-04 (see CHANGELOG): fit-engine
repairs, role tracks, an eligibility layer, and the Can-apply default view.
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
