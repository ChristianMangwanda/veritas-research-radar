# Changelog

All notable changes to Veritas are documented in this file.

## [Unreleased]

### Session 2026-08-07 — the laptop stops being part of the system

The dashboard lives at **https://veritas-research-radar.vercel.app**. Everything
that used to require this machine being awake now does not.

**What actually needed a server.** Judging costs money at the API, so it needs
a key, and a key cannot ship in a page served from a public repo. GitHub Pages
has no server-side anything, which is the entire reason the laptop stayed in
the loop — the profile, the judgments and triage lived on its disk because that
is where the key was. `api/judge.js` on Vercel is that missing server: 20 job
ids in, judgments out, the key in Vercel's environment. The contract is ids
only; the old endpoint took whole job payloads and a backlog pass shipped ~80MB
of posting text per page load to ask "have you read these yet".

**7,795 judgments migrated rather than re-bought.** The cache key is
`1:<jobContentHash>:<profileHash>:in-profile`, and the whole migration turns on
it staying byte-identical — so `profile-doc.js` moved into `radar/public/`
under the same UMD wrapper `scoring.js` uses, and the browser, the Vercel
function and the Actions job all compute hashes with one implementation.
Verified by resolving stored hashes against live postings: 7,659 of 7,934
qualified jobs hit. The 275 misses were 273 postings that arrived after judging
finished and 2 whose text changed. Had the contract broken, that number would
have been 7,934.

**Private state got a user, not a shared secret.** Four Supabase tables behind
Supabase Auth with signups disabled. This replaces `triage.sql`, which reached
for SECURITY DEFINER RPCs behind a pasted token because the page ships a public
anon key and there was no user to attach a row to. `match_cache` deliberately
has NO foreign key to `jobs`: refresh ends by deleting every posting it did not
see this run, and a cascade would take judgments we paid for. Grants are
written out explicitly — `schema.sql` leans on the project's default privileges,
which makes a table's security depend on a setting invisible from the repo.

**The backlog judges itself now.** `judge-jobs.js` runs after each refresh,
capped at $5. Before this, reading a fresh pool meant holding a browser tab
open for the better part of an hour — measured: 3,193 postings, 45 minutes,
$1.39 — and every profile edit meant doing it again. Step order is the race
guard: it runs strictly after `syncJobs` and its delete sweep, deliberately
without `if: always()`.

**Retired:** `pages.yml`, the CORS bridge that let the hosted page borrow the
profile from `localhost:4173` over a Private Network Access preflight, and 491
lines of `server.js` — which is now static files and the local jobs mirror. It
stubs nothing, so developing on localhost exercises the endpoints that actually
run.

**Bugs found by running it, not by reading it.**

- The dashboard was showing **14,054 of 25,054 jobs**, 11 of 26 pages failed.
  `OFFSET` makes Postgres walk and discard every row before the window, so cost
  climbs with depth while the statement timeout does not. Single deep requests
  failed on their own, so the earlier "3 at a time with one retry" fix had
  bought time rather than solved it. Keyset pagination at 500 rows a page with
  backoff returns all 25,054, zero failures. A ranged-concurrent variant was
  measured and was far worse — 65 failures, 3,000 rows missing, 214s.
  Concurrency is what this database minds, not depth.
- Anonymous load crashed the comparator: `job.fit` is only stamped by
  `applyProfile`, which had moved behind the sign-in.
- A `.env` fallback added to `supabaseEnv()` broke "refresh must not need
  Supabase" — a safety property, since a local run could have mutated
  production believing it was offline. Reading `.env` is now explicit opt-in via
  `lib/env-file.js`.
- `/api/judge` answered every request with "SUPABASE_SERVICE_KEY not
  configured" because Supabase's dashboard issues the key as
  SUPABASE_**SECRET**_KEY now. Both names accepted; the error names which
  variable is missing.
- The Possible tab still told you to run `npm start` — copy missed when the
  profile moved into the account.

**Spend.** ~$12.70 to build the whole thing. Ongoing: the median 6-hour cycle
brings ~68 qualified postings at $0.000435 each — about **$0.03 a cycle, $3.50
a month**. A profile edit re-judges the pool once, ~$3.44.

**Two traps that cost real time, recorded so they cost none next time.** Vercel
binds environment variables at deployment time — saving one does not change the
deployment already running. And a second, empty Supabase project in the same
account authenticates perfectly happily while holding none of the data; the URL
and the key must come from the same project.


### Session 2026-08-06 — the platforms that looked shut, and the one rule that kept paying

**Taleo was never browser-only.** The HTTP 500 "An Error Occurred in TEE" that
put it on the impossible list is a missing `tz` REQUEST HEADER — no cookie, no
session, no CSRF. A browser does not fix it (Playwright's `context.request`
500s beside the page that works), which is how the earlier session reached the
wrong conclusion: it replayed the call instead of adding the header. Ships as a
plain-fetch driver alongside the other fifteen, plus `probe-taleo-sections.js`
(a tenant runs SEVERAL career sections holding DIFFERENT jobs — WVU keeps its
postdocs in `faculty`, Pitt splits 452 postings across four boards, one of them
postdoc-only) and `resolve-taleo-codes.js` for the codes no guess list reaches:
`pitt_faculty_external_pd`, `tu_ex_staff`,
`00_student%2Bworkers%2Band%2Bwork%2Bstudy`. 14 hosts cost $0.58; 9 of 13
high-confidence model proposals returned no postings and were dropped.

**A gate feeds must pass before the registry.** `lib/feed-ownership.js` scores
a sample of real postings against where the employer actually is (IPEDS, IRS EO
BMF) and returns confirmed / rejected / inconclusive with quotable evidence.
Three outcomes on purpose: `inconclusive` is the honest majority answer for
small feeds and must never auto-promote. Signals are independent because none
survives alone — UAB's location column says only "University", so `uab.edu` in
the posting body carries it; SMU's postings rarely name the employer but are
all in Dallas. Rejection counts postings rather than proportioning them
(Schneider names itself in 2 of 20), an employer's own acronym must not read as
a rival's ("utsw" appears in every UT Southwestern posting), and
`stateOf('West Virginia University')` returned VA until state names were
matched longest-first.

**The layered resolver.** `resolve-employer-ats.js` finds the board behind an
employer the crawl failed: free re-fetch and link-following first (scored by
anchor TEXT as well as URL — UT Austin's board hides behind
`hr.utexas.edu/prospective` under a link reading "staff jobs"), paid web search
only on failure, then config derivation, then provenance requiring the
employer's own domain to link or host the board. 153 organisations, 54
proposals, **$4.11 total** — and every model answer is cached so the free
stages re-run from it forever. The model proposes; the live page decides: for
Penn the model reported PeopleAdmin, true years ago, and re-fetching the page
it named gave Workday, 447 jobs.

**51 feeds promoted, registry 484 → 535**, carrying ~2,900 research-relevant
postings — Penn, UT Austin, Villanova, Syracuse, Chapman, Pitt, UT
Southwestern, WVU, Temple, Fordham, Oberlin. UAB's Taleo board entered as a
`secondary_ats_feed` on its existing PeopleAdmin entry, adding 82 jobs that
feed never showed.

**The rule that earned its keep: a probe proves the BOARD has postings; only
running the real adapter proves THIS CONFIG can read them.** Nine candidates
died on that gap — six PageUp employers whose sitemaps list jobs while every
detail page answers an AWS WAF challenge, and three returning nothing. All nine
would otherwise have sat in the registry reporting "no openings" forever.

**Retired on evidence:** PageUp (18 orgs, 1,062 H-1B approvals behind it, 6 of
6 attempts blocked) and the generic schema.org JSON-LD driver idea (0 of 250
sampled organisations publish JobPosting markup). The remaining unsupported
tail is ~30 organisations, of which PeopleSoft is 11 — the one clear win left.

### Session 2026-08-04 (late) — the reading continues when you stop watching

**The app wears the logo.** `logo.png` is composed into a proper macOS icon by
`radar/scripts/make-icon.py` — the flat backdrop is dissolved (alpha recovered
from the blend, so the anti-aliased edge fades to nothing instead of to a grey
halo) and the artwork re-inset to Apple's ~82% safe area. The `.icns` is
committed, so installing needs no Pillow and no `sips`/`iconutil` chain —
which also retires the trap where `icons/icon128.png` is a JPEG wearing a
`.png` name and silently poisoned every generated iconset.

**Highlights say which question they answer.** Visa language is warm (red when
restrictive, amber when welcoming) and research/skills stays blue. Both were
blue before and were indistinguishable mid-paragraph. The legend now names
which kind of visa language it found. Highlights longer than 200 characters
are skipped: 202 of 3,671 captured phrases are extraction spill rather than a
phrase — one runs 14,262 characters, the entire posting — and painting the
whole description one colour says nothing. Classification still uses them.

**Less arithmetic above the list.** `989 qualified · 12 read so far, still
reading… +714 set aside (714 blocked) · show` is now `980 jobs · 43 read…`
and `723 set aside · show`, with the breakdown on the tooltip. The header stat
already says QUALIFIED and the tab says it again; the line only carries what
they cannot — the count *after* filtering, and whether the model is still
working. Reading progress moved to the Status drawer as a gauge.

**Judging no longer stops when you close the tab.** The queue used to hold
only the ~20-40 postings the screen had asked about. That kept the model busy
while you watched and ran dry minutes after you looked away — which is why a
989-posting list had 75 judgments. The page now hands over the whole qualified
backlog on load (from any tab, in fit order) and polls with an empty body plus
a cursor to collect what finished, instead of re-uploading megabytes of
postings to ask "done yet?". Measured with no browser open: **20.0s per
posting, 180/hour, sustained** — 989 postings is ~5 hours the server does
without you, cached to disk.

**14b stays the default, and now there is a measurement behind that.**
Re-judging the same 52 postings the 14b had already read, `qwen2.5:7b-instruct`
runs 21.4s → 11.5s each but agrees on only 21 of 52, and drops six to "no"
that the 14b kept — including a Clinical Informatics Analyst at an institute
for genomic health and a Bioinformatics Data Analyst the 14b called a strong
match. `RADAR_MATCH_MODEL=qwen2.5:7b-instruct` takes the trade if you want it.
`RADAR_MATCH_CONCURRENCY` is gone: it was never read, and could not have
helped — Ollama runs llama-server with `-np 1`, so requests serialize anyway.

Also: HR/legal boilerplate (EEO statements, search-firm notices, pay-band
blurbs) is cut from the tail of a posting before the model reads it, from the
half-way mark only so a posting that opens with an equal-opportunity line
keeps its requirements. Worth ~2% of prompt on this dataset — kept because it
is free and the model has less to wade through, not because it is fast.

**A bug caught in verification, not in production.** Trimming
`description_text` to 4,000 characters in the match payload looked like free
bandwidth. It is not: `jobContentHash` hashes the description, so a truncated
payload hashes differently and silently invalidated every judgment already
made for a long posting — cached-and-displayed judgments fell from 52 to 13.
Payloads go over whole; truncation for the prompt belongs in `jobBrief`, where
it does not touch cache identity.

### Session 2026-08-04 (evening) — the model reads the job; the app is an app

The remaining hand-work disappears and matching stops being keyword overlap.

**Resumes live in the app.** Drag a PDF/DOCX into the sidebar's "Your resumes"
panel; it self-registers, the local model writes its one-line intent (marked
as a draft), and you edit labels/intents or remove variants from the same
panel. `manifest.json` is never opened by hand. This also fixes a silent bug:
a resume dropped into `radar/data/resumes/` used to be ignored entirely,
because the manifest was non-empty so the scaffold never re-ran.

**A new input: what you want.** Free text in your own words, structured by the
model into correctable fields (locations, remote, salary floor, role types,
domains, deal-breakers). The system previously knew what you *could* do and
nothing about what you *wanted*.

**Matching is judged, not counted.** Stage one still narrows thousands to
hundreds deterministically; stage two has qwen2.5:14b read each survivor
against your resumes and preferences, returning a verdict with its reasons
and gaps on the row. The 0-100 fit score is demoted to a hint — measured on
the live data, 8,942 of 12,440 jobs score 0-4 and only 12 clear 50, so it was
a compressed keyword count printed at a precision it never had.

Two findings worth keeping:
- Asking the model for a 4-way verdict enum returned "strong" for *everything*
  — including a nurse-practitioner posting whose own headline read "Not a
  match". Constrained decoding fills fields in declaration order, so the label
  preceded any reasoning. The model now answers three booleans and
  `deriveVerdict()` aggregates in code; the spread went from `{strong:9}` to
  `{no:6, stretch:2, strong:1}`.
- A judgment costs ~19s (14b at ~11 tok/s, and the Ollama app runs
  llama-server with `-np 1`). So `/api/match` answers instantly from cache and
  drains the rest through a priority queue; on-screen jobs jump the backlog.

**It's an app now.** `npm run app:install` builds Veritas Radar.app for the
Dock — starts the server, opens the dashboard, no terminal.

Also removed by request: the cryptic `j k o s a x` keyboard strip (shortcuts
still work) and the "Qualified — needs your resume profile" label.

### Session 2026-08-04 (later still) — the profile follows the resume files

profile.json stops being a thing the user manages and becomes a cache the
system keeps fresh. New `build-profile.js --if-stale` (mtime check via
`lib/profile-freshness.js`; a touched-but-unchanged file costs one cached,
no-model rebuild). The `npm start` server runs the check at boot, watches
`radar/data/resumes/` (debounced, serialized, dotfiles ignored), and exposes
`/api/profile-freshness`; the dashboard polls it, narrates rebuilds in the
profile card, and adopts the result live. The daily digest run does the same
check at 08:00. The hosted dashboard pulls the compiled profile from
`http://localhost:4173` when the local radar is up — CORS scoped to the
Pages origin with the Private Network Access preflight answered, newest
generated_at wins, manual import kept as fallback. Resumes still never leave
the machine; the only new movement is the user's own browser pulling the
compiled profile from their own localhost.

### Session 2026-08-04 (later) — dashboard restructure: three tabs, one status corner

The funnel redesign gave the data honest layers; this session gave the UI the
same shape. Ten commits, each leaving the app working.

**Three tabs replace Radar / Pipeline / Routing.** **Qualified** (default) =
open + in your tracks + no quoted barrier, ranked by fit with no cutoff — the
predicate is `RadarScoring.isQualified`, tested, and shared with the header
stat so the two can never disagree. Blocked-in-track jobs stay one click away
("+N in your field but blocked · show"); without a profile the tab shows the
one-time import prompt, never an unranked fallback. **All jobs** = every
active posting, newest first. **Applied** = the pipeline view renamed, with
Export backup surfaced (localStorage is the only durable store). The Routing
view was deleted outright — its per-job value (recommended résumé + why)
already lives in the row and the detail why-panel.

**Header: 7 stats + 3 drawers → 3 stats + 1 status corner.** Qualified · New
for you · Active are the only headline numbers. The "250 discovered" stat is
gone — it was a hard cap (enrich.js DISCOVERY_LIMIT), not a count. Errors,
discovery queue, digest setup, and the instrument tiles all live in one
Status drawer behind a health dot (red on feed errors, recall alarms, or a
failed page load), with the next-pull countdown and Pull-now link.

**Sidebar: 16 controls → 4 visible.** Search, Visa signal, First-seen,
Remote; everything rare folds into a collapsed More. Deleted: source,
employer-type, cap-exempt evidence, triage-state, min-research, min-fit
verdict (fit is a sort, never a filter — only ~45 of 12k active jobs rate
good+), new-only, follow-up, saved views, Today chip. Old bookmark params are
ignored and scrubbed.

**Apply flow.** Hovering a row reveals **Apply ↗**: opens the posting and
arms the existing did-you-apply nudge; confirming stamps `applied_at` and
which résumé was sent. Notion sync was considered and deliberately deferred —
tracking stays local, export/import is the backup.

**Fixes along the way:** importing a profile now refreshes the header stats
without a reload (the root cause of "in your tracks: –" on the hosted site,
together with the never-done one-time import); a boot tripwire warns on any
missing DOM id instead of crashing mid-render; the phantom
`/api/classify-cache` fetch is gone. Net: app.js shrank ~700 lines.

The radar found jobs well but could not say which ones would take you. Three
layers, eight commits, each shippable.

**Fit-engine repairs.** Five defects in how postings were matched:
underscored profile entries (`machine_learning`) could never match prose,
killing ~2/3 of the domain channel; no plural or hyphen tolerance; auto-
recovered atomic tokens crediting a compound skill's full weight; a word
counting twice as skill and domain; and longer descriptions inflating fit
monotonically (now a 4000-char matching window, with gates still reading the
whole text). Extraction was also emitting unmatchable résumé sentences into
weight-3 slots — terms are now cut at the first connective and capped at three
words, with parenthetical and comma lists becoming aliases. Avoid signals moved
from the model to a curated list after every run returned the user's own
history, once including "machine learning", which would have docked every ML
job. Top-of-list is transformed: Data Scientist roles at CMU, Rochester, MSK,
Stanford and UChicago now rank 51-65 where the old ceiling was ~52.

**Role tracks** (`fit.track`) answer a question fit cannot: is this your line
of work at all? Pooled from every variant's title classes and target titles —
reachable / adjacent / unknown / none. Never touches the score.

**Eligibility** (`fit.eligibility`) reads the posting for hard barriers —
years, licences, clearance, student-only, internal-only, plus the existing
degree and citizenship gates — and returns clear / likely / blocked. Blocking
requires evidence quotable back to the user; anything ambiguous stays visible.
A live precision review of every blocked job with fit ≥ 25 found two ways a
good job could be hidden ("Ph.D. (optional)" read as required; "5-7 years"
read as 7), both fixed and pinned as regressions.

**The Can-apply view.** The radar now opens on jobs with no stated barrier;
a counter beside the list says how many are hidden and reveals them with their
evidence. Applied and shortlisted jobs are never hidden. Two header stats make
the funnel legible: **12,440 active → 980 in your tracks → 409 clear to
apply**.

New: `npm run radar:fit-audit` (`--histogram`, `--tracks`, `--sample-blocked N`)
for measuring the distribution instead of guessing at it.

### Session 2026-08-03 (late night) — desktop polish bundle

Five commits, each shippable; 23-assertion browser pass + new unit tests.

- **Enter double-fire fixed**: Enter selects/opens details, `o` opens the
  posting — one keypress no longer does both (row handlers stop propagation;
  the global Enter branch only acts from bare-body focus, so focused buttons
  keep native activation).
- **Keyboard covers the whole funnel**: `i` interview, `O` offer (shift+o),
  `r` rejected, `w` withdrawn join the existing map; full reference in the
  ⌨ tooltip.
- **Undo**: every triage change and employer-ignore pushes onto a 20-deep
  stack; a transient bottom-left bar shows "Rejected — was Offer · Undo",
  and `u` / Cmd+Z / the button walk it back. Restores are verbatim
  (`RadarPipeline.restoreTriageRecord`): old `updated_at` kept, an
  absent record stays absent — follow-up aging and sync LWW both survive.
- **Triage backup**: sidebar Export/Import of statuses, notes, and ignored
  employers as one JSON file; imports LWW-merge (an old backup never
  clobbers newer local work) with strict shape validation.
- **Focus auto-refresh**: returning to a long-lived tab re-fetches quietly
  when >15 min have passed and a 6-hourly pull slot has landed since the
  last load (`RadarPipeline.shouldAutoRefresh`); selection and scroll
  survive.

### Session 2026-08-03 (night) — digest armed; steady state

- Redesign deployed and verified on the live Pages site (fonts serving,
  light-only markup confirmed).
- Local daily digest **armed**: launchd agent at 08:00 daily, live Supabase
  reads via the read-only anon key (no service secret on disk), private topic
  in gitignored `.digest.env`. Verified with a real push.
- Fixed a real send bug the test caught: `fetch` rejects non-Latin-1 header
  values, so curly quotes in the digest title crashed the ntfy publish —
  titles are now RFC 2047-encoded (`headerValue()` in `digest-local.js`).
- Decisions of record: no phone notifications (single user checks the site
  daily; ☀ Today is the digest), cross-device triage sync deliberately
  dropped (`triage.sql` stays unapplied). Next build: desktop polish
  (Enter double-fire, funnel keyboard keys, undo, triage export/import).

### Session 2026-08-03 (evening) — full dashboard redesign to the design brief

Implements "Veritas Research Radar (standalone).html" (repo root — the
commissioned design brief, all three takes) across seven commits, each leaving
the app shippable:

- **System**: light-only steel palette (`#5980a6` on `#faf9f5`) swapped in
  under the existing token names; self-hosted Barlow / Barlow Condensed;
  square hairline panels with registration-mark corner ticks; dark mode
  removed. Fit is always number + single-hue bar.
- **Radar (take 2a)**: the list is a 5-column cockpit table (Role / Fit /
  Visa signal + evidence line / Send résumé + winning margin / Closes);
  stateful sidebar facets with live counts (each facet counted with every
  other filter applied); 5-stat header with next-pull countdown and an
  Arm-daily-digest walkthrough; partial-load banner reworded with a working
  Retry pull.
- **Detail pane**: triage is a 7-step stepper with Reject/Withdraw/Ignore
  demoted to links (terminal states show a Reopen line); SEND THIS ONE panel;
  Copy-résumé-path (profile `source_file`); single-source skeleton.
- **Pipeline (take 2c)**: instrument strip — next-pull gauge + Pull-now link
  and seven system tiles with truthful live bits (real per-employer outcome
  squares on the radar tile; dead-man ALARM on anomalies) — over big-number
  funnel stage cells.
- **Routing (take 2b, new third view)**: all résumés heat-scored in-row
  (intensity = calibrated verdict tiers), best route, per-row Shortlist,
  removable filter chips, CSV **Export shortlist**
  (`RadarPipeline.buildShortlistCsv`, unit-tested).
- **New features**: Save-this-view presets (localStorage), Ignore employer
  (local-state; never hides jobs you acted on), variant initials
  (`RadarScoring.variantInitials`, fixes the "APPLIE" abbrevs).
- Verified: `npm test` green (5 new unit tests) + a 51-assertion headless-
  Chromium pass. `pages.yml` now `cp -r` (fonts dir); `server.js` persists
  `ignored_employers`.

### Session 2026-08-03 — coverage push + fit-engine hardening

Coverage (Tier 3.1 dark-flagship rescues + a candidate-pool ATS scan; registry
239 → 253):
- **St. Jude** wired via Workday — its Phenom board (`talent.stjude.org`)
  redirects into a Workday tenant; recovered by following the redirects.
  176 postings, 107 research-relevant. Was a dark null-provider flagship.
- **New `ultipro` driver** (UKG Recruiting JobBoard JSON, `fetchUltiproJobs` +
  `mapUltiproJob`, `ats_config={host,tenant,boards[]}`, `BriefDescription`
  inline so no per-job fetch). Rescued **Salk** (11 jobs incl. Research Software
  Engineer @ AIRC + 4 postdocs).
- **Dana-Farber dedup** — the null `dana-farber` entry duplicated the live
  Workday `dana-farber-cancer-institute`; merged curated fields, re-keyed its
  DOL sponsor signal (no orphan), removed the dupe.
- **Michigan / MIT deferred** — Drupal-AJAX and PeopleFluent stateful-Angular
  respectively; no public inventory feed. Documented in
  `radar/data/flagship-ats-findings.md` so they aren't re-probed.
- **ATS discovery scan** over the 220 top-scored discovery candidates found 16
  config-only-wireable feeds; **15 new tier:auto cap-exempt IHEs wired** after
  end-to-end driver verification — 5 Workday (Liberty, NJIT, Santa Clara,
  Wentworth, Albany Med; +60 relevant) and 10 Oracle CE (U-Maine, ETSU, Loma
  Linda, Tennessee Tech, Vanderbilt, Baylor, Tulsa, St Olaf, DePaul, Champlain;
  ~197 relevant). Oracle canonical-site trap noted (pick `ORA_ACTIVE`,
  non-student site; `SiteNumber` doubles as the apply-URL token).

Fit engine (make it rank all 7 of the user's résumés, well):
- **`.docx` résumé support** in `build-profile.js` (`readResumeText` extracts
  `word/document.xml` via the `unzip` CLI, zero runtime deps, local-only).
  Manifest expanded to all 7 variants; `profile.json` rebuilt via Ollama.
- **Matchable skill-term normalization** — underscores → spaces + canonical
  atomic tokens (python/sql/etl/rag/llm/aws…) recovered from compound terms as
  aliases via an allowlist. Fixed variants that scored 0 on obviously-matching
  jobs.
- **Weight discrimination** — the local 7B marked nearly every skill weight 3;
  the prompt now enforces a real 3/2/1 pyramid, so per-variant scores separate.
- **Verdict tiers recalibrated** to the new (honest, lower) score scale:
  strong 50 / good 38 / moderate 27 / weak 16 (was 70/55/40/25, which had made
  "strong" unreachable). Dataset now spreads strong 11 / good 23 / moderate 126.

Daily loop + dashboard:
- **Launchd scaffold** for the fit-aware digest (`run-digest.sh`,
  `.digest.env.example`, `com.veritas.radar.digest.plist`). Verified; arming
  needs a user `NTFY_TOPIC` (+ optional Supabase creds).
- **Dashboard UX** — removed a dead 162 KB `employers.json` fetch on every
  load, debounced search + memoized per-job search blob, reset "show all" on
  filter change.

### Session 2026-08-03 (cont'd) — discovery backlog + verification hardening

Registry 253 → 309. Reused the existing discovery crawl and ATS drivers
rather than growing new ones where possible:
- **UltiPro/Oracle discovery backlog** — the 2026-07-05 crawl had already
  found 12 UltiPro tenants and 30 Oracle CE hosts that were never promoted.
  Wired 11 UltiPro (Scripps Research Institute, Northern California
  Institute for Research and Education, ...) + 18 Oracle CE (Icahn School of
  Medicine at Mount Sinai, UCSF, UT Health San Antonio, ...) — zero new
  driver code, just host/site_number resolution and live verification.
- **Two `promote-employers.js` bugs fixed** — a subdomain-stripping regex
  artifact and an overly strict identity-match rule were silently rejecting
  real iCIMS candidates (UCLA, UC Irvine, SRI International, Rockefeller
  University among them). The "45 iCIMS candidates need routing" premise in
  the roadmap was actually this bug; iCIMS was already scout-routed and
  working. Fixed, surfacing 15 more real candidates.
- **PageUp confirmed non-viable** (3/3 probed tenants, incl. Virginia Tech,
  redirect into an institutional SSO login — the discovered link is the
  internal board, not public candidate-facing).
- **New `paylocity` driver** — public recruiting pages are server-rendered
  HTML with the full job set inline (`window.pageData`) and a schema.org
  JobPosting JSON-LD block per detail page; no JS API needed. 8 of 11
  UUID-shaped discovered candidates wired.
- **USF wired** (Oracle CE) — resolved the host left unresolved by the
  earlier discovery scan (leaked via a CSP header on a redirect).
- **Prefilter recall-visibility** — the pre-fetch title prefilter
  (workday/oracle/successfactors/eightfold/paylocity) now stamps a
  `prefiltered_count` per employer into the refresh report;
  `detectPrefilterAnomalies` flags a suspiciously high excluded-to-seen
  ratio so a bad regex pattern gets caught automatically (this is what
  should have caught the earlier "Open Rank" faculty-title miss).
- **Interfolio investigated, deferred** — an AngularJS SPA over several
  private REST hosts, not a plain-fetch target; needs its own session.
  Findings in `radar/data/flagship-ats-findings.md`.
- Discovery crawl resumed past its first 1,100 sites (`scout_discover.py`,
  resumable); a 400-site batch was still running as of session end.

### Added (Stage 5: resume-variant-aware ranking)
- **Multi-variant resume ingestion** (`npm run radar:profile`): the user
  maintains resume variants they wrote themselves (ML engineer, data
  engineer, …), declared with a label + intent note in
  `radar/data/resumes/manifest.json` (scaffolded on first run; txt/md/pdf).
  One cached extraction per variant builds `profile.json` v2 with weighted
  matchable skill terms, taxonomy title classes, and a reconciled core
  (degree union, most senior stage). The system never writes or edits resume
  content — it only ranks and routes the user's own documents.
- **Local-first extraction**: extraction defaults to a local open-source
  model via Ollama (`qwen2.5:7b-instruct`), so resume text never leaves the
  machine at all — structured extraction is shallow work a 7-8B model handles
  well. Hosted Claude stays available as a fallback (`--provider anthropic`);
  `--model` / `OLLAMA_MODEL` override the model; the cache key includes the
  model so switching re-extracts. Shared Ollama client in
  `radar/scripts/lib/ollama.js` (also used by the router).
- **Deterministic scoring engine** (`radar/public/scoring.js`, shared by
  browser and node): per-variant word-boundary matching over posting text +
  title-class alignment + degree gate parsed from description text (softener
  and negation aware; postdoc/faculty imply PhD) + citizenship gate +
  sponsorship-evidence tiebreak. Reachability demotes and flags — never
  hides a job. Verdict tiers strong/good/moderate/weak/stretch; hard gates
  cap at stretch. 9k jobs × 5 variants score in ~0.6s.
- **Dashboard**: profile card (variants, core facts, import/clear), per-row
  "use <variant>" chip with verdict tier and ⚠ gate flags, and a why panel
  (per-variant score bars, matched terms grouped by weight, degree-gate
  evidence snippet, bonus ledger). Local server serves `/api/profile` +
  `/api/route-cache`; GitHub Pages imports the same files into localStorage.
  The old pasted-resume heuristic is deleted.
- **Optional local routing** (`npm run radar:route`): ambiguous variant calls
  (top two scores within 8 points) are re-judged by the same local Ollama
  model (structured JSON output, temperature 0) and cached in the gitignored
  `route-cache.json`, keyed to the profile hash so profile edits invalidate
  verdicts. No Ollama → deterministic routing stands. Job text and skill
  terms go to the local model only; resumes never leave disk.

### Fixed
- Pages dashboard rendered 0 jobs once the dataset passed ~9k rows: the
  fully parallel Supabase page fetch made deep-offset queries 500 under
  burst, and the loader fell through to an empty static file. Pages now
  fetch 3 at a time with one retry each (~9s to full data).

### Added (Stage 4: Supabase backbone — cutover complete)
- The dataset of record moved from a 22MB git-committed jobs.json to Supabase
  Postgres: CI refreshes upsert every job (dedup fixed: one Workday feed listed
  a requisition twice) and journal each run; lifecycle state (first-seen,
  tombstones) loads from the database. jobs.json is no longer committed.
- Dashboard reads live data via the anon key (RLS read-only) with parallel
  page fetches — ~5s to first rows for 3,587 jobs; falls back to the local
  API server, then static JSON. Digest queries the database too.


### Added (Phase 3: coverage flywheel)
- **ATS discovery pipeline**: websites flow into the cap-exempt directory
  (IPEDS WEBADDR + resumable nonprofit resolver), and `scout_discover.py`
  crawls careers pages harvesting ATS links — URL patterns with tenant
  extraction for 20+ providers plus content signatures that unmask platforms
  behind vanity domains. First census (106 top-evidence employers, 68%
  identified): iCIMS 26, Workday 20, PeopleAdmin 16, PageUp 8 — the adapter
  priority list is now data, not guesswork.
- **promote-employers.js**: probes crawl-discovered Workday tenants via the
  live CXS API (best site board wins), drafts registry proposals with crawl
  provenance as identity, merges on approval. First wave: 23 universities
  wired (registry 25 → 48), including WashU, Cornell, CMU, Brown, Georgetown,
  Rochester, Northeastern — ~5,700 live postings behind them.
- **Auto-tier guard**: crawl-wired employers commit only research-relevant
  postings (score ≥ 25 or class evidence), so wiring a university adds its
  labs, not its cafeteria shifts.

### Added (Phase 2: behavioral evidence)
- **Title-class evidence engine**: every LCA row and every posting classifies
  through one shared taxonomy (`lib/title-class.js`, 9 classes + SOC-code
  fallback). The DOL importer now emits per employer × class certified counts,
  median annualized wages, and sample titles; refresh attaches the bucket
  matching each posting's class. A UCSF postdoc posting now shows "47 postdoc-
  class LCAs (3y), median $77,030" instead of an institution-wide number.
- **Sponsor signal is behavioral-first**: strong requires class-level history
  (or explicit sponsorship text plus institution history); institution-wide
  counts alone cap at moderate. 133 of 750 eligible jobs now rank strong on
  class-backed evidence.
- **Evidence-first dashboard**: green "sponsors <class> ×N" chips on rows,
  "Sponsorship evidence" cell with wage medians leads the signal grid, the
  text scan is demoted to a "Posting language" footnote, new evidence sort,
  and NEUTRAL chips no longer clutter every row.
- **Dashboard on GitHub Pages**: the same bundle now runs statically —
  /api/* falls back to committed JSON copies, triage falls back to
  localStorage. Deployed by `pages.yml` on a schedule (bot commits can't
  trigger workflows) to christianmangwanda.github.io/veritas-research-radar.
- **Daily digest** (`radar/scripts/digest.js` + `radar-digest.yml`): new
  eligible jobs from the last 24h ranked by class evidence, pushed via
  ntfy.sh at 13:05 UTC. Prints-only until the NTFY_TOPIC secret is set.

### Added (Phase 1: signal honesty)
- **Federal citizenship gate**: USAJOBS postings are citizen-gated by default
  (the requirement lives in hiring-path metadata, not description text) and
  marked RESTRICTED at the mapper level; the dashboard hides them unless
  "Include citizen-only federal" is checked, and headline stats exclude them.
- **Negation guard now covers FRIENDLY matches**: "applicants should not expect
  that sponsorship will be offered" no longer reads as an offer. New restricted
  pattern for "does not commit to providing visa sponsorship".
- **Ground-truth analyzer corpus** (`tests/analyzer-corpus.json`): labeled real
  + synthetic excerpts with per-class precision/recall printed on every test
  run; pins every false positive found in the wild (USCIS-agency-name-as-
  friendly, negated offers). Corpus immediately caught three recall gaps —
  including that the cap-exempt pattern promised since v1.2 never existed
  (now added; 120 patterns: 67 restricted / 53 friendly).
- Tightened "immigration services" to require providing-context — the bare
  phrase is the name of the federal agency.
- **Word-boundary fit matching**: the resume matcher no longer matches skill
  "r" against every posting or "api" against "rapid".
- **Honest evidence labels**: "verified" cap-exempt pill replaced with
  "Institution status: cap-exempt confirmed via IPEDS/IRS…"; sponsorship
  history is explicitly marked institution-wide, not role-specific.
- **Incremental aggregator detail-fetch**: previously fetched descriptions are
  reused from the committed store, so each run's budget goes only to unread
  jobs and description coverage converges instead of plateauing at ~50%.

### Added
- **Dashboard redesign**: three-pane triage layout (filters / scannable job list /
  full detail pane) with keyboard flow (j/k navigate, o open, s/a/e/v/x triage,
  / search), matched-phrase highlighting inside the full description, one-click
  triage buttons, a stat strip (active / new-for-you / friendly / employers),
  dark mode with a theme toggle, discovery and source-error drawers, an empty
  state with filter reset, and a list-first mobile layout with a filters toggle.
- Weekly employer-scout workflow (`radar-scout.yml`): scouted snapshots expire
  after 14 days; CI now re-scouts ATS-less employers every Monday so their jobs
  stop silently tombstoning.
- Aggregated jobs without captured descriptions are now explicitly marked
  (`description_captured: false` + disclaimer) so a NEUTRAL visa state can't be
  mistaken for "posting scanned, no visa language found".

### Fixed
- Extension: manual rescan (toolbar click) on an already-scanned page removed
  the badge without redrawing it; the rescan now resets the content hash.
- Extension: highlight toggle no longer needs two clicks after a badge is
  dismissed or replaced (stale `highlightsVisible` state).
- Extension: removed a literal NUL byte embedded in ui.js that made git treat
  the file as binary.
- Radar: CSV parsing now handles quoted fields containing newlines across all
  government-file readers (new `parseCsv`/`csvRecords` in lib/csv.js); the DOL
  importer streams the multi-hundred-MB file instead of buffering it.
- Radar: aggregator-firehose jobs now pass the same url/title integrity filter
  as the scout path.
- CI: the four data workflows share one concurrency group with staggered crons,
  so simultaneous runs can no longer race to a failed non-fast-forward push of
  jobs.json.

### Added (prior firehose work)
- **Aggregator firehose**: single repo now includes the Python+Playwright scout
  (`scout/`). Scrapes research-job boards (Nature Careers, Science Careers,
  HigherEdJobs), resolves every job's employer against a generated ~20,000-entry
  cap-exempt directory (IPEDS + IRS-research universe), and keeps only the
  cap-exempt matches. First run: 551 scraped → 110 kept across 53 new employers
  (dataset 172 → 282 jobs, live employers 5 → 58).
- **Automated DOL download** (`scout/scout_dol.py`): pulls the Akamai-gated OFLC
  LCA disclosure file via a real browser session and converts it to CSV. All
  four enrichment datasets now feed the signal (first import: FY2026 Q2,
  1.04M records; 22/25 registry employers carry sponsorship counts).
- Dashboard: source filter, cap-exempt-score badge + sort.
- Policy: the scout treats robots.txt as advisory (owner decision); throttled,
  no CAPTCHA defeat. Aggregators previously ruled out are now in scope.

### Added (prior two-layer work)
- **Two-layer cap-exempt instrument**: 6-hourly job sourcing + monthly signal
  enrichment joining IPEDS, IRS EO BMF, USCIS H-1B Data Hub, and DOL LCA data
  via a confidence-ordered entity-resolution library (aliases, token matching,
  false-positive guards)
- Four new daily sources: USAJOBS (official API, free key), Recruitee, Breezy,
  Workable — nine ATS adapters total
- Enrichment outputs: employer evidence overlay (20/25 registry employers now
  hard-"verified"), ranked discovery list of 250 new cap-exempt employer
  candidates (dashboard panel + /api/discovery), and an alias worklist report
- Scout producer contract (radar/SCOUT-CONTRACT.md) + validating importer with
  stable URL-hash ids, snapshot-replace semantics, and 14-day TTL — feeds
  Playwright-scouted jobs from the LadyLibertysBrief agent into the radar
- Monthly enrichment GitHub Action; daily refresh now runs every 6 hours
- New RESTRICTED patterns: "US persons only", ITAR / export control / deemed export,
  and restrictive TN/E-3/O-1/L-1 counterparts (117 patterns total: 66 restricted / 51 friendly)
- Sentence-scoped negation guard: negated restricted phrases ("No security clearance
  required", "not subject to ITAR") no longer flag a posting as restricted
- Radar: Ashby, SmartRecruiters, and Workday adapters alongside Greenhouse/Lever;
  live sources grew from 1 to 4 employers (CZ Biohub, Scripps Research, UCSF,
  University of Chicago — 165 jobs, up from 29)
- Radar: fetch retry with backoff, inter-employer rate limiting, and closed-posting
  tombstones with 30-day retention (transient errors never mass-close jobs)
- Dashboard: sort control, "new since last visit" badges and filter, closed-posting
  toggle with warnings for triaged jobs, URL-persisted filters, per-employer error
  detail, smarter PhD-requirement fit penalty

## [1.3.0] - 2026-07

### Added
- **Research Job Radar**: local-first pipeline that fetches postings from public ATS APIs
  (Greenhouse/Lever) for curated likely cap-exempt research employers, scores them with the
  shared Veritas analyzer, and serves a triage dashboard (`npm run radar:refresh` / `npm run radar:serve`)
- Optional DOL LCA disclosure import as a local sponsorship-history signal (`npm run radar:import-dol`)
- Daily GitHub Actions refresh of the public radar dataset
- Automated test suite (`npm test`) covering the shared analyzer and radar pipeline
- Test fixture pages under `tests/test-pages/` for manual extension testing
- LICENSE, CHANGELOG.md, and INSTALLATION.md

### Changed
- Keyword engine is dual-exported (browser IIFE + CommonJS) so the extension and radar share one analyzer
- Version aligned to 1.3.0 across manifest, package, and docs

### Fixed
- Keyword highlighting now wraps only the matched phrase instead of the entire paragraph,
  and duplicate phrases no longer trigger redundant page scans
- Content script no longer throws when a non-Error value is raised during a scan
- Removed dead state tracking in the content script

## [1.2.6] - 2026

### Changed
- Detection patterns expanded to 109 (58 restricted / 51 friendly)
- Stability improvements to scanning and badge rendering

## [1.2.0] - 2026-01

### Added
- 95+ keyword patterns (up from 44)
- Manual scan of any webpage via the toolbar icon
- Dismissible badge with close button
- New high-contrast icon
- New detections: security clearance as citizenship proxy, cap-exempt H-1B positions,
  TN visa (Canada/Mexico), E-3 visa (Australia), immigration team mentions, H-1B transfer support

### Changed
- Content hashing prevents badge blinking on unchanged pages
- Auto-scanning restricted to job sites (no longer runs everywhere)
