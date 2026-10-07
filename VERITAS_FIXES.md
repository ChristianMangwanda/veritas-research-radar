# Veritas Research Radar: screening fixes

> **Status (2026-10-06): fixes 1-3 done.** Shipped in `4f8b5ba` and the follow-up commit that added this file.
> - Fix 1: done, but narrower than proposed. Only an explicit refusal blocks (`parseSponsorshipRefusal`). `veritas_state === 'RESTRICTED'` is not used, because it also catches "must be authorized to work", export-control text and "green card holders preferred".
> - Fix 2: done as a block at 4+ years (`WEIGHTS.MAX_REQUIRED_YEARS = 3`), with a wider parser. Equivalency or substitution routes ("or equivalent", "may substitute for the degree", "in lieu of") stay visible, by the owner's choice.
> - Fix 3: done for Lever (the description, all `lists` and `additional`). PeopleAdmin, UltiPro, Oracle and Cornerstone are still open.
> - Live review of 100 sampled new blocks (seeds 7 and 11) found 8 false blocks. All 8 are fixed and kept as regression tests.

Found on 2026-10-06 while applying to jobs from the Possible tab. Repo commit checked: `3c65bc5`.
Apply these in the Veritas repo itself. None of them requires re-judging postings.

## 1. "No sponsorship" text does not hide a job

**Symptom.** Cornell "CALS Programmer Analyst III" has `veritas_state: RESTRICTED` and the posting says "Visa sponsorship is not available for this position." It still shows in Possible with eligibility `clear` and verdict `strong`.

**Cause.** `assessEligibility` in `radar/public/scoring.js` never reads `job.veritas_state`. RESTRICTED only subtracts `WEIGHTS.RESTRICTED_LANGUAGE` (-15) from the fit score. `isQualified` hides jobs only when eligibility is `blocked`.

**Scale.** 80 of the 1,592 jobs in the user's Possible queue are RESTRICTED but eligible.

**Fix.** In `assessEligibility`, when `job.veritas_state === 'RESTRICTED'`, push a blocker with `type: 'sponsorship'`, `source: 'text'`, and the matched restricted phrase as `evidence`. This keeps the file's rule that every block is quotable. Add a test with the Cornell sentence. Also check that a negated phrase such as "no sponsorship restrictions" does not block.

## 2. Years of experience are never applied

**Symptom.** Postings that require 5, 6 or 10+ years were judged `strong` (examples: University of Rochester "Sr Data Analyst" R273318, Medical College of Wisconsin "Enterprise BI Systems Analyst", St. Jude "Data Scientist, Clinical ML" JR7593).

**Cause.** `assessEligibility` ignores years on purpose (see the comment that starts "A stated years-of-experience requirement is deliberately ignored"). The judge prompt in `radar/scripts/lib/match.js` (rule 4) only calls 8+ years a stretch.

**Fix (pick one).**
- Add an opt-in profile setting, for example `max_required_years: 4`. When it is set, a quotable `parseYearsRequirement` result above it becomes a blocker. When it is not set, behavior stays as it is today.
- Or change rule 4 so that requirements well above the candidate's stated years count as "no". This changes the prompt and therefore needs a re-judge, so prefer the setting above.

Note: `parseYearsRequirement` is strict (it needs a requirement word nearby). On the queue it found 23 postings with 5+ years. A looser check found about 132, so the parser probably misses phrasings like "Bachelor's degree and 5 years of relevant experience required".

## 3. Some sources store only part of the description

**Symptom.** Altarum (Lever) has a 295-character `description_text`. The sponsorship sentence ("sponsorship is not available") was in the part that was not stored, so neither the phrase scan nor the judge saw it.

**Scale.** Of the 1,592 queued jobs, 226 have fewer than 800 characters of description: peopleadmin 166, ultipro 31, oracle 12, lever 8, csod 6, taleo 2, governmentjobs 1. Across all jobs: peopleadmin 2,735, csod 424, ultipro 101, oracle 104.

**Fix.** In the source mappers, fetch the full posting body. For Lever, include the `lists` and `additional` sections as well as `descriptionPlain`. After that, rerun `enrichJob` so `veritas_state` updates, and re-judge only the jobs whose text changed. The content hash already does this.

## Not needed

Do not re-judge all ~7,900 postings. Fixes 1 and 2 only remove jobs and can be done with deterministic code. A re-judge only makes sense if the judge is suspected of wrongly rejecting jobs the user qualifies for. To test that, sample about 50 "Not for you" verdicts and review them by hand first.
