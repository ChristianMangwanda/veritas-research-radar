# Radar Scout (Python + Playwright)

The scraping layer of the research-radar. It handles the sources the
zero-dependency Node pipeline can't: JS-rendered career pages, and the research
aggregators. Lives in its own Python environment so the radar core stays
dependency-free.

## Policy

robots.txt is checked and **logged** but no longer blocks fetching (owner
decision, 2026-07 — see `radar_scout/net.py`). Throttling stays on: we are
polite even where we are not obedient. The scout does not solve CAPTCHAs or
rotate proxies; a hard bot-wall is reported as a skip.

## Setup

```bash
python3.11 -m venv scout/.venv          # 3.11–3.13 all work
scout/.venv/bin/pip install -r scout/requirements.txt
scout/.venv/bin/python -m playwright install chromium
```

## Modes

**Aggregator firehose** — scrape research-job boards, tagged by employer:

```bash
npm run scout:aggregators -- --all --details 60 --import
# or a single source:
npm run scout:aggregators -- --source nature-careers --source science-careers
```

Writes `radar/data/aggregated/<source>.json`. `--import` then runs
`radar:import-aggregated`, which resolves each job's employer against the
cap-exempt directory (`radar/data/cap-exempt-directory.json`, built by
`radar:enrich`) and keeps only cap-exempt matches. Sources: `nature-careers`,
`science-careers` (both solid), `higheredjobs` (best-effort; the result rows
are finicky and it often returns `no_listings_found`).

**Per-employer scout** — for registry employers with no ATS feed:

```bash
npm run scout:jobs -- --employer fred-hutch --import
npm run scout:jobs -- --all
```

Writes `radar/data/scouted/<employer-id>.json` per `radar/SCOUT-CONTRACT.md`;
`radar:import-scouted` validates and merges.

**DOL downloader** — pulls the OFLC LCA disclosure file (Akamai-gated to bots;
a real browser session passes):

```bash
scout/.venv/bin/python scout/scout_dol.py
npm run radar:import-dol -- radar/data/dol-raw/<file>.csv
npm run radar:enrich
```

## Tests

```bash
cd scout && .venv/bin/python -m pytest -q
```

Pure-function coverage (link triage, board detection, posting validation,
name normalization mirrored from the Node entity-resolver). No network in tests.
