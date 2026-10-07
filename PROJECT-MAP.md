# Veritas Research Radar — Project Map

Updated 2026-09-16. This document describes the current architecture and the pending reliability release.

## Purpose

The Radar collects research jobs and ranks them against an authored profile.
It emphasizes employers with evidence of cap-exempt sponsorship.
A positive signal does not guarantee sponsorship for a particular posting.

The repository also contains a Chrome extension that scans job pages for visa-related language.
The extension processes page text locally. The Radar uses hosted services.

## Where each part runs

| Part | Location | Responsibility |
|---|---|---|
| Dashboard | Vercel, `radar/public/` | Job search, profile editor, ranking, and triage |
| Public job database | Supabase `nawbdsujjysugaisczta` | Postings and refresh history |
| Private account data | Supabase | Profile document, AI judgments, triage, and account state |
| Job collection | GitHub Actions, every six hours | ATS feeds, lifecycle updates, and database sync |
| Scheduled AI matching | GitHub Actions, after refresh | Judgments for qualified jobs, with a $5 run limit |
| On-demand AI matching | Vercel `api/judge.js` | Judgments for visible jobs, with server-side credentials |
| Scout and enrichment | Scheduled GitHub Actions | Supplemental postings and employer evidence |
| Development server | `npm start` | Local dashboard preview and optional local job mirror |

The registry contains 547 employers. Coverage varies by employer and feed health.
Current counts come from the dashboard and refresh report. This guide does not freeze them into documentation.

## How matching works

1. The browser and scripts parse the same profile document.
2. The deterministic scorer checks posting requirements and ranks jobs.
3. The AI reads the candidate information and posting text.
4. The application stores the judgment and resolves it against the current inputs.

The pending release shares the prompt, schema, and fingerprint code in `radar/public/matching.js`.
Profile fingerprints include profile constraints, preferences, model, prompt, schema, and judgment version.
Posting fingerprints include employer, title, department, description, location, remote status, and salary.

Old judgments remain in storage. A changed fingerprint prevents an old judgment from appearing as current.
The scheduled run rebuilds judgments within its existing spending limit.
The first release of the new fingerprints requires fresh judgments for the eligible pool.

## How collection failures appear

The collector retains existing postings when a feed fails. It does not refresh their last-seen dates.
The pending release records each feed's failure count and last successful refresh.
Three consecutive failures produce a dashboard warning and a failed health-check run.
A single persistent source failure does not prevent matching for healthy sources.
Temporary network errors use bounded retries and the server's `Retry-After` value.

Carnegie Mellon's replacement Workday host returned 93 jobs in a direct adapter check on 2026-09-16.
Eastern Washington's new PageUp site works in a browser, but its detail pages block the server-side adapter.
Its manual link points to the new site. Automated collection remains unresolved and visible as a failure.

## Release state

The `codex/radar-reliability` branch includes the existing pending safeguards and the new cache and feed fixes.
The branch started from the latest fetched `origin/main` data commit, `a10b68e`.
A local change is not a deployed change. The website and scheduled workflows require a coordinated release.

Production checks on 2026-09-16 found one Auth user and one matching profile owner.
Public signups remain enabled. The owner allowlist table is absent.
GitHub and Vercel do not yet contain `RADAR_OWNER_USER_ID`.
These findings must be resolved before the pending security changes reach production.
The release procedure is in [HANDOFF.md](HANDOFF.md#production-security-gate).

## Development checks

Run the JavaScript tests:

```sh
npm test
```

Run the Python tests:

```sh
scout/.venv/bin/python -m pytest scout/tests
```

Check the repository's database target:

```sh
npm run supabase:verify:manifest
```

The manifest check does not inspect live permissions or create a CLI project link.
