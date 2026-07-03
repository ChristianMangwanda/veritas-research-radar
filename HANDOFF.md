# Veritas Research Radar Handoff

This folder contains the consolidated implementation of the Veritas Research Job Radar.

## What Is Included

- Chrome extension source from Veritas.
- Shared Veritas sponsorship analyzer in `scripts/keywords.js`.
- Research radar employer registry in `radar/employers.json`.
- Greenhouse/Lever refresh pipeline in `radar/scripts/refresh.js`.
- Local dashboard in `radar/public/`.
- Local-only triage server in `radar/scripts/server.js`.
- DOL LCA import helper in `radar/scripts/import-dol-lca.js`.
- Generated live job data in `radar/data/jobs.json`.
- GitHub Actions daily refresh workflow in `.github/workflows/research-radar.yml`.
- Node tests in `tests/radar.test.js`.

## Commands

```bash
npm test
npm run radar:refresh
npm run radar:serve
```

Then open:

```text
http://127.0.0.1:4173
```

## Privacy Boundary

GitHub Actions only refreshes public ATS data. Resume text, local profile scoring, and triage state stay local. The local server stores triage in `radar/data/local-state.json`, which is ignored by git.

## Current Data Status

The verified live source is Chan Zuckerberg Biohub's Greenhouse board token, `biohub`. The current generated dataset contains 29 jobs. Other likely cap-exempt institutions are present in the employer registry, but their ATS sources are deferred until a clean public Greenhouse or Lever endpoint is verified.
