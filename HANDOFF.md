# Veritas Research Radar Handoff

Two products in one repo: the Veritas Chrome extension, and a two-layer
cap-exempt research jobs instrument.

## Architecture

```
EVERY 6 HOURS (GitHub Action)             SCOUT PRODUCER (scout/, Playwright)
  refresh.js:                               jobs-scout writes
   13 ATS drivers: greenhouse, lever,        radar/data/scouted/<id>.json
   ashby, smartrecruiters, workday,          -> npm run radar:import-scouted
   oracle, ultipro, successfactors,
   eightfold, recruitee, breezy,           MONTHLY (GitHub Action + local)
   workable, usajobs, peopleadmin            enrich.js: IPEDS + IRS EO BMF +
   + scouted-jobs merge (14-day TTL)          USCIS Data Hub + DOL signals
   + aggregator firehose (2x/day)            -> employer-enrichment.json
   + employer-enrichment overlay             -> discovery-candidates.json
   + resume-variant fit scoring              -> enrichment-report.json
   -> Supabase / jobs.json / refresh-report.json
```

Registry: **253 cap-exempt employers** (135 Workday, 78 PeopleAdmin, 12 Oracle,
17 not-yet-wired dark flagships, the rest across 8 other systems). Dataset
~11.5k active jobs. Full orientation in **`PROJECT-MAP.md`**.

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
- Two views, toggled in the list header: **Radar** (discovery, all filters) and
  **Pipeline** (only jobs you applied to / contacted, grouped by stage with a
  funnel stats bar; ignores every filter except search). The **☀ Today** chip
  applies the digest's exact cut in-app: seen ≤24h (48h fallback), verdict ≥
  good, sorted by fit. Marking a job Applied records which résumé variant was
  sent (defaults to the recommendation, editable in the detail pane).
- Daily digest: pick a private topic name, set it as the `NTFY_TOPIC` repo
  secret, then subscribe to `ntfy.sh/<topic>` in the ntfy app or browser.
  Until the secret exists the digest workflow just prints.

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

- **253 employers**, 12 wired ATS systems; ~11.5k active jobs (of ~17.6k
  tracked), 0 recall anomalies on the last refresh (24 transient feed errors,
  individual employers — not data loss).
- Fit engine ranks **all 7 résumé variants**; verdict tiers recalibrated
  (strong 50 / good 38 / moderate 27 / weak 16).
- 7 GitHub Actions run the pipeline (see `PROJECT-MAP.md` §"How it stays fresh").

## Pick-up state — what needs YOU (nothing is blocked on code)

1. **Arm the daily fit digest.** `cp radar/scripts/.digest.env.example
   radar/scripts/.digest.env`, set `NTFY_TOPIC` (a private ntfy.sh topic you
   subscribe to; optionally `SUPABASE_URL`/`SUPABASE_SERVICE_KEY` for live data),
   then load the launchd agent — commands are in the header of
   `radar/scripts/com.veritas.radar.digest.plist`.
2. **Turn on cross-device triage sync.** Apply `radar/supabase/triage.sql` and
   set a sync token in the dashboard's Settings → Sync. Needs you to authorize
   the Supabase connection (couldn't be done from a headless session).
3. **Set `NTFY_TOPIC` repo secret** if you also want the CI daily digest to push
   (the local fit digest above is the better one).

## Open follow-ups (nice-to-have, not blocking)

- 17 dark flagships still unwired (MIT, Harvard, Broad, Allen, Cleveland
  Clinic, UC Berkeley…) — closed/JS-only ATS; see `flagship-ats-findings.md`.
- Scan the wider `cap-exempt-directory.json` (5,971 sites) for more
  config-only-wireable feeds (the 15-employer scan only covered the top 220).
- `University of South Florida` matched Oracle CE but its host was unresolved —
  a targeted probe would wire it.
- Résumé extraction still emits somewhat verbose terms (the allowlist recovers
  the matchable tokens); a larger local model (`qwen2.5:14b`) would sharpen it.
