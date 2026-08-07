# Veritas Research Radar Handoff

Two products in one repo: the Veritas Chrome extension, and a two-layer
cap-exempt research jobs instrument.

## Pick up here (2026-08-07)

**The laptop is out of the loop. The dashboard lives at
https://veritas-research-radar.vercel.app and everything private lives in
Supabase behind a sign-in.**

```
dashboard        Vercel (static) + one serverless function, api/judge.js
private state    Supabase, gated by Supabase Auth (one user, signups disabled)
the crawl        unchanged — GitHub Actions, every 6 hours
judging          gpt-5.6-luna, in CI after each refresh + on demand from the page
```

GitHub Pages is retired (`pages.yml` deleted). The CORS bridge that let the
hosted page borrow the profile from localhost is gone. `server.js` is 120 lines
and serves static files and the local jobs mirror — nothing else.

### What moved, and what did not

| | before | now |
|---|---|---|
| postings | Supabase, anon read | unchanged |
| the crawl | Actions every 6h | unchanged |
| profile document | `radar/data/profile.md` on disk | `profile_documents`, edited in the app |
| judgments | `match-cache.json` on disk | `match_cache`, keyed the same way |
| triage | `local-state.json` / localStorage | `triage`, one row per posting |
| judging the backlog | a browser tab left open | a step in `research-radar.yml` |
| the OpenAI key | `.env` on the laptop | Vercel env + a GitHub secret |

**7,795 judgments were migrated rather than re-bought.** The cache key is
`1:<jobContentHash>:<profileHash>:in-profile`, and the migration was verified by
resolving stored hashes against live postings: 7,659 of 7,934 qualified jobs hit
(96.5%). The 275 misses were 273 postings that arrived after judging finished
and 2 whose text changed — if the hash contract had broken, that number would
have been 7,934.

### The state of things

```
registry        484 → 547 employers
active jobs  12,440 → 18,038
judged            7,993 of 7,993 qualified   (strong 662 · possible 413 · stretch 941 · no 5,977)
recall anomalies      0
API spend         ~$11.19 over three days ($3.36 of it judging)
```

`npm test` is green, 547 employers validate, no duplicate ids.

**The registry-expansion phase is finished by decision, not exhaustion.** The
user called it: *"this is more than enough… I'll just make a mental reminder to
check the other ones manually."* Do not reopen it unasked. The numbers behind
that call are in **Where the ceiling actually is**, below, and they are worth
reading before proposing any new employer work.

### What the last two days added

**Yesterday: 51 college feeds, ~2,900 postings** — Penn, UT Austin, Villanova
(366), Syracuse (309), Chapman (228), Pitt (216, including a postdoc-only
board), UT Southwestern, Fordham, Oberlin, UNC Wilmington, WVU (including a
faculty board its staff board never showed). UAB's Taleo board went in as a
`secondary_ats_feed` on its existing PeopleAdmin entry — 82 relevant jobs its
current feed misses.

**Tonight: 12 research institutes, ~168 postings, for $2.78** — Draper (25),
MUSC (58), Ai2 (27), Riverside Research (15), Michael J. Fox Foundation (11),
Benaroya, Brookings, ATCC, Pew Research Center, Minneapolis Heart, Altarum,
METR. The non-college side of the registry went 34 → 46.

Those institutes had been invisible for a mundane reason: the resolver only
ever read the ATS-discovery crawl, and that crawl covered IPEDS colleges. The
ranked IRS pool had been scored, had its websites resolved, and had never been
joined to anything. `--pool nonprofits` is that join. All 160 ranked nonprofit
sponsors have now been through the resolver; 12 converted.

MUSC arrived through its Foundation's IRS record, but the feed is the
university's own — its postings say "Medical University of South Carolina
(MUSC - Univ)" — so it is registered under the university with the Foundation
as an alias. Naming it after the Foundation would have filed 58 university
postings under a fundraising arm.

### The rule that keeps earning its keep

**A probe proves the BOARD has postings. Only running the real adapter proves
THIS CONFIG can read them.** Nine candidates died on that gap yesterday — six
PageUp employers whose sitemaps list jobs while every detail page answers an
AWS WAF challenge. Six more died on it tonight, reading zero jobs through an
adapter after resolving perfectly. Without that check all fifteen would have
entered the registry and reported "no openings" forever, which is the failure
mode that produces no error and no complaint.

### Three ways the ownership scorer was wrong

All three were found by RUNNING the gate, not by reasoning about it. Each is
now closed, and each generalises.

1. **Co-location.** Dean McGee Eye Institute was confirmed onto OU Health's
   Workday board: thirteen sampled postings all agreed on "Oklahoma City" and
   not one said "Dean McGee". Co-location is the *normal* condition for a
   research institute, so a shared city is the weakest signal available, not
   the strongest. City agreement now requires the feed's own label to not name
   somebody else.
2. **Token identity.** Salk's Ultipro board is `salk` in the registry and
   `SAL1013SIBS` coming out of the resolver — same host, same tenant, same
   board — and a token-keyed duplicate check waved it straight through. The
   token is a label *we* choose; the config is what the vendor issued, so the
   config is the identity. Fixing it immediately exposed two more duplicates
   already in the registry: **there are 7, not 5.**
3. **Single-token names.** FOSSA is an Oregon nonprofit with no revenue.
   fossa.com is a San Francisco software company hiring account executives.
   Every posting said "FOSSA", the board slug said "fossainc", and on name
   evidence the gate confirmed the software company as a cap-exempt research
   employer. A name that reduces to one token cannot verify itself — it now
   needs geographic corroboration, the same two-signal rule
   `verify-website.js` reached from the other direction.

### New tools

| script | what it does |
|---|---|
| `resolve-employer-ats.js --pool nonprofits` | resolves the ranked IRS institutes, not just the college crawl |
| `verify-proposed-feeds.js` | the gate, generalised past Taleo: runs THE REAL ADAPTER, then scores ownership |
| `promote-verified-feeds.js` | merges only `confirmed`, with curated display names |
| `probe-taleo-sections.js` | enumerates a Taleo tenant's career sections — a tenant runs several and they hold DIFFERENT jobs |
| `resolve-taleo-codes.js` | web-searches the unguessable section codes, then verifies each against the live board |
| `verify-feed-ownership.js` + `lib/feed-ownership.js` | confirmed / rejected / inconclusive, with quotable evidence |

The pipeline is now **resolve → verify → promote**, and only the last one writes
to `employers.json`.

`resolve-employer-ats.js` caches every model answer permanently and replays the
free stages from it, so **iterating on that code costs $0** — only new
employers cost money (~3.4¢ each, measured on both pools). One trap worth
knowing: running `--no-model` first used to write terminal failures that the
paid run then skipped, so free reconnaissance silently cancelled the paid pass.
Fixed, and it reads correctly for entries written before the fix.

### Where the ceiling actually is

Measured tonight. This is the argument for stopping.

- **62 employers produce 80% of all jobs.** The median producing employer
  contributes **9**; the 25th percentile contributes 2. 126 of 547 fetch zero.
- Of 5,449 crawled colleges not in the registry: **550** sit on a provider that
  already has a driver — resolvable with no new code, and the last real block.
  **8** sit on a provider that does not. 4,891 have no findable board at all.
  **New drivers buy eight employers, total, ever.**
- **Phenom and Ashby appear zero times in the 5,967-college crawl.** One
  employer each — Battelle and OpenAI. Do not write those drivers.
- The judge has read 612 postings: **76 strong, 29 possible, 111 stretch, 396
  no.** At that rate the current pool already holds roughly 600 strong matches.
  The binding constraint has stopped being inventory and become applications.

### The manual list

**[Research employers to check by hand](https://app.notion.com/p/3b4b4b9054478148805ed1a64ca0977c)**
— 83 employers the radar cannot reach, every one a live link. Battelle is at
the top: 368 H-1B approvals, the largest single sponsor in the nonprofit pool,
$13bn revenue, on Phenom. Also the 17 dark registry entries (MIT, Harvard,
Berkeley, Broad, Fred Hutch, Allen, Cleveland Clinic, Rockefeller, UCLA,
Michigan, Wisconsin) which look covered in the dashboard and contribute
nothing. Regenerating it means re-running the join over `ats-resolve-cache.json`
and `nonprofit-ranking.json`; the data is all still on disk.

### If there is a next thing

**It is the other side of the funnel, not more employers.** ~600 strong matches
already exist in a pool nobody can exhaust. gpt-5.6-luna is known-lenient and
inflates the top tier; sharpening the `matches_preferences` prompt so "strong"
means twenty jobs instead of six hundred is worth more than any further
expansion. Sharpen the prompt, never swap to a stricter model — you can tighten
a lenient model, you cannot recover a job a strict one hid.

Still open, unchanged and unblocking:

1. **ADP pacer** — 46 employers, the same 6 refused with HTTP 429 every run,
   under the dead-man threshold so it never alarms.
2. **7 pre-existing duplicate feeds** double-count jobs today.
   `hhmi`/`howard-hughes-medical-institute` and the two
   `memorial-sloan-kettering` entries are the same employer twice; Tennessee
   and Maine each have a system and a campus on one Oracle feed; three more are
   distinct schools sharing one system feed.
3. **PeopleSoft** — 11 employers, 689 approvals, 4 instances (UC system, UT
   System, University System of Georgia, Central Washington). Still the biggest
   single unclaimed block if expansion ever restarts. Partially cracked: it
   needs a **cookie jar** (without one every URL redirects to
   `cmd=login&errorPg=ckreq`, which looks like a block and is not), the
   component is `HRS_HRAM_FL.HRS_CG_SEARCH_FL.GBL`, and the listing arrives via
   an `ICAction` postback rather than JSON. **Open question:** the job rows in
   that 308KB response do not use the `JobOpeningId=` pattern — find the row
   markup first. Guessing component URLs is a dead end; three variants returned
   17KB shells.

### Dead ends — do not re-derive

- **PageUp.** It was the largest remaining target by sponsorship (18 orgs,
  1,062 approvals) and 6 of 6 promotion attempts were WAF-blocked at the
  adapter. Retired on evidence, not suspicion. Only revisit with a headless
  browser in CI.
- **A generic schema.org JSON-LD driver.** Sampled 250 of the 4,832
  "no ATS detected" organisations: **zero** publish JobPosting markup. That
  pool is also 4,785 colleges to 47 nonprofits, so the "research nonprofits
  with no supported ATS" population barely exists.
- **Writing more ATS drivers, of any kind.** The genuinely unsupported tail
  across the entire college crawl is **8 employers**, and the two platforms
  worth naming (Phenom, Ashby) have one employer each. A browser tab beats a
  driver here.
- **The 171 non-sponsor nonprofits** left in the ranked pool. They rank below
  the sponsors on the one signal that predicts hiring, and the sponsors
  themselves converted at 12 in 160.

### One ops note

**A red Dead-Man Switch is often just GitHub dropping a scheduled cron**, not a
broken pipeline. It fails the run deliberately because `NTFY_TOPIC` is unset by
design, so failing the Actions list is its only way to be seen. Check which
alarm fired before worrying. `gh workflow run research-radar.yml --ref main`
forces a refresh; `git push` and `gh` hang in the sandbox and need it disabled.

## Architecture

```
GITHUB ACTIONS  (every 6h)              VERCEL
  refresh.js                              static dashboard (radar/public)
   16 ATS drivers -> Supabase.jobs        api/judge.js — reads on demand
   + aggregator firehose (2x/day)           (holds OPENAI_API_KEY)
   + scouted-jobs merge (14-day TTL)
   + employer-enrichment overlay         SUPABASE
  judge-jobs.js                            jobs, refresh_runs   — anon read
   reads every unjudged qualified          profile_documents    ┐
   posting -> Supabase.match_cache         match_cache          │ signed-in
                                           triage               │ only
MONTHLY (GitHub Action)                    user_state           ┘
  enrich.js: IPEDS + IRS EO BMF +
   USCIS Data Hub + DOL signals          THE BROWSER
   -> employer-enrichment.json            scoring.js  — stage one, deterministic
   -> discovery-candidates.json           profile-doc.js — parses the document
   -> enrichment-report.json              auth.js     — GoTrue, hand-rolled
```

Three files are shared verbatim between the browser and Node — `scoring.js`,
`profile-doc.js`, `pipeline.js` — and that is load-bearing rather than tidy.
The cache key is a hash of the profile and the posting; if the browser and the
judge computed it differently, every judgment already paid for would become
unreadable. One implementation, both runtimes.

Registry: **547 cap-exempt employers** across 16 wired ATS systems
(peopleadmin, workday, oracle, csod, governmentjobs, icims, taleo, adp,
ultipro, paylocity, interfolio, greenhouse, lever, successfactors, eightfold,
usajobs, plus the aggregator firehose). 500 colleges, 46 non-college research
organisations, 1 federal. Dataset **18,038 active jobs**; new employers fold in
on the next 6-hourly refresh. Full orientation in **`PROJECT-MAP.md`**.

## Commands

The dashboard is a website now — https://veritas-research-radar.vercel.app —
so none of this is needed to USE the radar. These are for working on it.

```bash
npm test                        # offline test suite (always run before committing)
npm start                       # dev server on 127.0.0.1:4173 (static + local jobs mirror)
npm run radar:refresh           # daily-layer fetch + enrich + lifecycle (writes Supabase)
npm run radar:enrich            # monthly joins (downloads ~350MB, cached 25 days)
npm run radar:enrich -- --offline   # rerun from cache (deterministic)
npm run radar:import-dol -- path/to/LCA.csv   # manual DOL signal import
npm run radar:import-scouted    # validate + merge scout snapshots
node radar/scripts/judge-jobs.js --dry-run    # what the 6-hourly judge step would read
node radar/scripts/seed-supabase.js --dry-run # one-time migration of local state (already run)
```

`npm start` serves the page and `radar/data/jobs.json`. Sign-in, judgments,
profile and triage all go to the real Supabase and Vercel endpoints from
localhost — nothing is stubbed, so working here exercises what actually runs.
The one gap is judging a posting nobody has read yet, which needs the
serverless function: set `window.RADAR_JUDGE_ORIGIN` to the Vercel origin, or
just do that on the deployed site.

The local `jobs.json` mirror goes stale as soon as CI refreshes. Rebuild it
with `fetchAllJobs()` from `lib/supabase.js` when a stale list gets confusing —
or delete it, since the page falls back to reading Supabase directly.

**Already gone:** `radar:profile` and `radar:route` — the profile is a document
you write, not a model's reading of seven résumés, and the router chose between
variants that no longer exist.

**Still there but largely pointless now:** `npm run app` / `app:install` build
and launch the `Veritas Radar.app` bundle, which opens the LOCAL dashboard.
That was the front door when the laptop held everything. It now opens a dev
server that asks you to sign in to the same account the website uses. Kept
because it works, not because it earns its place — the Vercel URL is the front
door. (`npm start` also runs `git pull --rebase --autostash` first, which is
occasionally surprising.)

Every model step runs locally via Ollama (nothing leaves the machine).
Résumé extraction uses `OLLAMA_MODEL` (default `qwen2.5:7b-instruct`);
**job matching uses `RADAR_MATCH_MODEL` (default `qwen2.5:14b-instruct`)** —
14b reads postings materially better and fits comfortably in 24 GB. Shared
`OLLAMA_URL` (default localhost). `radar:profile -- --provider anthropic`
switches extraction to hosted Claude if local quality is not enough.

## Opening it

**https://veritas-research-radar.vercel.app** — that is the whole answer now.
Postings load without signing in; Status → sign in unlocks the profile, the
judgments and triage, and they follow you to any browser or phone.

The old answer was a `.app` bundle that started a server on this machine
because the machine was where the profile, the judgments and the triage lived.
That is no longer true of anything, so the bundle survives only as a way to
open the dev server.

## How ranking works

The radar never writes résumés — you do. It ranks postings against a document
you write about yourself, and the document is the only input.

1. **Write the profile.** `radar/PROFILE-PROMPT.md` is the guide. Frontmatter
   carries the deterministic gates (degrees, work authorization, locations,
   salary floor, an `avoid` list that gates on posting titles); the prose
   sections are what the model reads. Edit it in the dashboard under
   **Status → Edit profile** — it validates before it saves, because a document
   that does not parse would leave every posting judged against nothing while
   the UI looked fine.

   *This replaced deriving a profile from seven résumé files with a local
   model. That derivation was the churn engine: the profile was rewritten
   whenever any résumé changed, its hash moved, and every cached judgment died
   with it. A document changes when the person changes, which is rarely.*

2. **Stage one is deterministic** (`radar/public/scoring.js`, shared verbatim by
   the browser and every script). It rejects only what is *quotably* impossible
   — closed, citizens-only, a licence or degree the posting demands, a
   profession needing credentials you cannot hold. It deliberately does not ask
   whether a job is "your line of work": that guess was carrying 616 postings
   and was the last place a real match could vanish without evidence. ~7,900
   survive of ~18,000 active.

3. **Stage two: gpt-5.6-luna reads every survivor.** In CI after each refresh
   (`judge-jobs.js`, capped at $5/run), and on demand for anything on screen
   that has not been read yet (`api/judge.js`). Judgments live in `match_cache`,
   keyed by `1:<jobContentHash>:<profileHash>:in-profile`.

   - Model choice was measured on 789 postings a local 14b had already judged:
     gpt-5-nano agreed 75% and buried **32 strong matches**; gpt-5-mini agreed
     77% and buried 1; gpt-5.6-luna agreed 63% and buried **0**, while costing
     less than mini. Agreement % is a decoy — nano and mini score alike and fail
     in opposite directions. Only "buries a strong match" decides it.
   - luna's known flaw is the opposite one: it is lenient and inflates the top
     tier. Sharpen that in the `matches_preferences` prompt, **never** by
     picking a stricter model — you can tighten a lenient model, you cannot
     recover a job a strict one hid.
   - The verdict is **derived in code**, not asked for: the model answers three
     booleans and `deriveVerdict()` aggregates. Asking for a 4-way enum returned
     "strong" for everything, because constrained decoding fills fields in
     declaration order and the label was written before any reasoning existed.
     **Do not reorder JUDGMENT_SCHEMA's properties.** A test pins the order.
   - An unparseable answer is recorded as *unjudged*, never as "no". A verdict
     nobody wrote would hide a job with no stated reason.

4. **What invalidates a judgment.** Only the posting's title, department and
   body, or the profile's capability list and "Who I am" summary. Editing
   "What I want", the salary floor, locations or degrees changes the prompt or
   the deterministic gates **without** moving the hash — a real gap, left alone
   deliberately, because changing the hash recipe would orphan every judgment
   already paid for. After a profile edit the next 6-hourly run re-judges under
   the new hash.

5. Rows carry the deterministic fit score as a hint (a compressed keyword
   count, not a percentage) and ⚠ flags for hard gates. **Gates demote — they
   never hide a job.**

## Notifications + hosted dashboard

- Dashboard: **https://veritas-research-radar.vercel.app** (static build +
  `api/judge.js`, rebuilt whenever a shipped file changes). Postings are public
  and load without signing in; the profile, the judgments and triage need the
  account. Note Vercel gives every deployment its own URL behind SSO — those
  302 to a Vercel login and are not the site. The production alias above is.
- Three tabs, toggled in the list header (2026-08-04 restructure; same light
  steel system + Barlow type from the 2026-08-03 brief): **Qualified** — the
  default — is open + in your tracks + no quoted barrier, ranked by fit with
  no cutoff (`RadarScoring.isQualified`; a "+N in your field but blocked"
  link reveals what the eligibility rule held back). **All jobs** is every
  active posting, newest first. **Applied** is your applications grouped by
  stage with follow-up aging and an Export-backup button (ignores every
  filter except search). Hover a row for the **Apply ↗** quick action: opens
  the posting and arms the did-you-apply nudge; confirming stamps applied_at
  + which résumé was sent. Visible filters are just Search / Visa signal /
  First-seen / Remote; the rare toggles, profile import, triage backup, and
  sync UI sit under the sidebar's collapsed **More**. The header shows three
  stats (Qualified · New for you · Active) plus a **Status** button whose
  dot goes red on feed errors, recall alarms, or a failed page load — its
  drawer holds the next-pull countdown, the 7 system tiles, source errors,
  the discovery queue, and the digest setup steps. On the hosted dashboard,
  Qualified needs your profile in that browser's localStorage — it arrives
  automatically from the local radar when it's running (see the
  resume-variant ritual), or via the manual import; the tab prompts until
  one happens.
- Daily digest: the **local** fit digest is armed (2026-08-03) — a launchd
  agent (`com.veritas.radar.digest`) runs `run-digest.sh` at 08:00 daily,
  reading `radar/scripts/.digest.env` (gitignored; holds the private ntfy
  topic + read-only anon key for live data). Log:
  `/tmp/veritas-radar-digest.log`; disarm with
  `launchctl bootout gui/$(id -u)/com.veritas.radar.digest`. The CI digest
  workflow (repo-secret `NTFY_TOPIC`) is deliberately left unset — the user
  checks the dashboard daily instead; the ☀ Today chip applies the same cut
  in-app.

## Where the credentials live

Three places, and each one is a different failure if it is wrong.

| where | names | what breaks without it |
|---|---|---|
| **Vercel** env vars (Production) | `SUPABASE_URL`, `SUPABASE_SECRET_KEY` *or* `SUPABASE_SERVICE_KEY`, `OPENAI_API_KEY` | `/api/judge` 500s; reading existing judgments still works |
| **GitHub** repo secrets | the same three, plus `USAJOBS_*` and `NTFY_TOPIC` | the 6-hourly judge step does nothing; the crawl still runs |
| **`.env`** (gitignored, local) | the same three | the hand-run scripts (`seed-supabase.js`, `judge-jobs.js`) refuse to start |

Two traps, both hit for real during the migration:

- **Vercel binds env vars at deployment time.** Saving a variable does not
  change the deployment already running — redeploy, or it stays broken with the
  variable sitting right there in the dashboard looking correct.
- **`SUPABASE_URL` must be the `nawbdsujjysugaisczta` project.** A second,
  empty project in the same account will authenticate happily and hold none of
  the data. The key and the URL must come from the same project.

`api/judge.js` and `supabaseEnv()` both accept the secret key under either
name, because Supabase's dashboard issues it as SECRET while CI holds it as
SERVICE. `supabaseEnv()` reads the environment and never a file, deliberately:
`syncJobs` deletes every row it did not just write, so a local run that
silently adopted a `.env` could mutate production. Scripts meant to be run by
hand opt in with `lib/env-file.js`.

## Setup the automation needs

1. **USAJOBS**: register at developer.usajobs.gov (free, instant). Set
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

**This moved, and it moved deliberately.** It used to be absolute: the profile,
the judgments and the triage sat on one laptop, and privacy was free because
nobody else could reach the disk. Hosting the dashboard trades that for
something weaker and far more usable.

Where things stand now:

- **The profile document is in Supabase**, readable only by the one
  authenticated user (RLS on `auth.uid()`), and the anon key that ships in the
  page is refused outright — verified with curl, not assumed. Signups are
  disabled, so "the one user" stays one user.
- **Posting text and the profile prose go to OpenAI** on every judgment. That
  was already true before the migration; it is the deal `gpt-5.6-luna` reads
  postings under. Roughly 1,800 tokens per judgment: your prose verbatim plus
  the posting trimmed to 3,000 characters.
- **Triage is in Supabase**, which is the point — it follows you to a phone.
- **Résumé files never went anywhere and still do not.** They are not part of
  this system: `radar/data/resumes/` is gitignored, unread, and the profile is
  a document you write rather than a model's reading of them.
- **GitHub Actions still only touches public data** for the crawl (ATS feeds,
  USAJOBS, IPEDS, IRS, USCIS). The judge step it now also runs reads your
  profile from Supabase and sends postings to OpenAI — the same exposure as
  above, on a schedule instead of a click.
- The DOL raw download stays local; only the aggregated per-employer signal is
  committed. `radar/data/profile*.md` is gitignored **anywhere in the tree**,
  not just its home directory, because copies were twice saved elsewhere and
  this repo is public.

What you get for that: the dashboard works on any device, judging happens while
nothing is open, and no part of it depends on a laptop being awake.

## Current data status (2026-08-07, after the last refresh)

- **547 employers**, 530 ats-enabled, 16 wired ATS systems. **18,038 active
  jobs** of 25,012 tracked. **0 recall anomalies**; 15 prefilter anomalies.
- **402 employers produce jobs; 126 fetch zero; 6 error** — all six are the
  same HTTP 429 on the shared ADP host, every run, under the dead-man
  threshold so they never alarm.
- The distribution matters more than the total: **62 employers produce 80% of
  all jobs**, the median producer contributes 9, and USAJOBS alone is 2,500.
  Adding employers moves the total far less than the count suggests.
- **Every qualified posting has been read**: 7,993 of 7,993 — strong 662,
  possible 413, stretch 941, no 5,977. So ~1,075 postings are worth your
  attention out of 25,012 tracked, and the constraint stopped being inventory
  a while ago.
- 6 GitHub Actions run the pipeline (see `PROJECT-MAP.md` §"How it stays
  fresh"). `pages.yml` was the seventh and is retired; `research-radar.yml`
  gained a judging step after its refresh.
- Refresh report also tracks `prefiltered_count` per employer and flags
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

The **dashboard restructure** shipped 2026-08-04 (see CHANGELOG): three tabs
(Qualified / All jobs / Applied) replace Radar/Pipeline/Routing, the header
is 3 stats + a status corner, and the sidebar dropped from 16 controls to 4
visible. Routing view and saved views were deleted; the Qualified predicate
lives in `RadarScoring.isQualified` (tested). Notion sync of applications was
considered and deliberately deferred — the Applied tab runs on the existing
local triage store, with export/import as the backup. If revisited, the
right shape is a Supabase Edge Function proxy (public repo: no token can
ship in the page).

The **funnel redesign** shipped earlier on 2026-08-04 (see CHANGELOG):
fit-engine repairs, role tracks, an eligibility layer, and the Can-apply
default view.
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
