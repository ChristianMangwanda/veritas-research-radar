# Veritas Research Radar Handoff

Two products in one repo: the Veritas Chrome extension, and a two-layer
cap-exempt research jobs instrument.

## Architecture

```
EVERY 6 HOURS (GitHub Action)             SCOUT PRODUCER (LadyLibertysBrief repo)
  refresh.js:                               Playwright jobs-scout writes
   9 ATS adapters (greenhouse, lever,        radar/data/scouted/<id>.json
   ashby, smartrecruiters, workday,          -> npm run radar:import-scouted
   recruitee, breezy, workable, usajobs)
   + scouted-jobs merge (14-day TTL)       MONTHLY (GitHub Action + local)
   + employer-enrichment overlay             enrich.js: IPEDS + IRS EO BMF +
   -> jobs.json / refresh-report.json         USCIS Data Hub + DOL signals
                                              -> employer-enrichment.json
                                              -> discovery-candidates.json
                                              -> enrichment-report.json
```

## Commands

```bash
npm test                        # offline test suite (always run before committing)
npm run radar:refresh           # daily-layer fetch + enrich + lifecycle
npm run radar:serve             # dashboard at http://127.0.0.1:4173
npm run radar:enrich            # monthly joins (downloads ~350MB, cached 25 days)
npm run radar:enrich -- --offline   # rerun from cache (deterministic)
npm run radar:import-dol -- path/to/LCA.csv   # manual DOL signal import
npm run radar:import-scouted    # validate + merge scout snapshots
npm run radar:profile           # extract resume variants -> profile.json (needs ANTHROPIC_API_KEY)
npm run radar:route             # optional: local Ollama resolves ambiguous variant calls
```

## Resume-variant ritual (ranking + routing)

The radar never writes resumes — you do. It ranks jobs against your own
resume variants and tells you which one to send.

1. Drop your resume variants (txt/md/pdf) into `radar/data/resumes/`
   (gitignored). Run `npm run radar:profile` once — it scaffolds
   `manifest.json`; fill in each variant's `label` and one-line `intent`
   ("Leads with production ML, PyTorch, MLOps") and re-run. One extraction
   API call per variant, cached by content hash: adding a 6th resume later
   re-extracts only the new one (`--force` to redo all).
2. Reload the dashboard. Jobs now carry a fit score, a verdict tier, a
   "use <variant>" chip, and ⚠ flags for hard gates (PhD required,
   citizens-only). Gates demote — they never hide a job. The detail pane's
   why panel shows per-variant scores, matched terms, and the posting's own
   degree-requirement sentence.
3. Optional: install [Ollama](https://ollama.com), `ollama pull qwen3:8b`,
   then `npm run radar:route` — a local model re-judges only the jobs where
   two variants scored within 8 points and caches the verdicts
   (`route-cache.json`, gitignored, invalidated when the profile changes).
4. Hosted (Pages) dashboard: import `radar/data/profile.json` (and
   optionally `route-cache.json`) via the sidebar profile card — they
   persist in that browser's localStorage only.

## Notifications + hosted dashboard

- Dashboard (static, auto-refreshed every 6h):
  https://christianmangwanda.github.io/veritas-research-radar/ — triage state
  lives in that browser's localStorage; the local `npm start` server keeps
  using `radar/data/local-state.json`.
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
(`local-state.json`) are all gitignored and stay local. Resume text leaves
the machine only for the one extraction API call per variant; the Ollama
routing step talks to a model on localhost. The DOL raw download stays
local; only the aggregated per-employer signal is committed.

## Current data status

Live daily sources: CZ Biohub (greenhouse), Scripps Research (smartrecruiters),
UCSF (lever), University of Chicago (workday), US federal (usajobs, needs key).
First enrichment run: 20 of 25 registry employers carry hard "verified"
cap-exempt evidence (IPEDS/IRS joins), 250 ranked discovery candidates.
HigherEdJobs/HERC/Nature/Science Careers were evaluated and ruled out — no
machine-readable feeds and bot walls we will not circumvent.
