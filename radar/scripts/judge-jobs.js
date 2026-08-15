#!/usr/bin/env node

/**
 * Read every qualified posting against the profile, in CI, after each refresh.
 *
 * The Vercel function judges what is on screen — a screenful at a time, while
 * you wait. This is the other half: the backlog. Without it, the first read of
 * a fresh pool means holding a browser tab open for the better part of an hour,
 * and every profile edit means doing that again, because editing the document
 * moves the profile hash and every cached judgment addresses the old one.
 *
 * Running it after the 6-hourly refresh makes both problems disappear on their
 * own schedule: new postings arrive judged, and a profile edit heals within one
 * cycle. Nothing has to be open.
 *
 * ORDERING IS LOAD-BEARING. This must run AFTER refresh.js has finished
 * syncing, because syncJobs ends by deleting every posting it did not see this
 * run. Judging a half-synced table would spend money on rows about to vanish.
 * The workflow enforces it by step order, and deliberately without
 * `if: always()` — if the refresh failed there is nothing worth judging.
 *
 * Usage:
 *   node radar/scripts/judge-jobs.js [--dry-run] [--max-spend 5] [--limit N]
 *                                    [--prune-stale-profiles]
 */

const {
  JUDGMENT_SCHEMA, JUDGE_SYSTEM_PROMPT, judgeUserPrompt, normalizeJudgment
} = require('./lib/match.js');
const { DEFAULT_MODEL, judgeOnce, costOf } = require('./lib/openai.js');
const { groupMissesByHash, createCacheWriter } = require('./lib/match-cache.js');
const { loadEnvFile } = require('./lib/env-file.js');
const { fetchAllJobs, supabaseEnv } = require('./lib/supabase.js');
const { parseProfileDocument } = require('../public/profile-doc.js');
const RadarScoring = require('../public/scoring.js');

// Runs in CI with real environment variables, and by hand while iterating —
// this only fills gaps, so CI is unaffected.
loadEnvFile();

/* Three, not six. Six workers produced a steady 4-16 unrecoverable 429s per
 * run: the retry ladders climbed in lockstep and the fleet spent its attempts
 * racing itself. Three plus the shared cooldown in lib/openai.js finishes the
 * same backlog without the pile-up — the limit was never throughput. */
const CONCURRENCY = Number(process.env.RADAR_MATCH_CONCURRENCY || 3);
/* Written as results land, not at the end. A crash or a cancelled workflow run
 * must not throw away judgments already paid for — the same lesson that put a
 * ceiling on the local cache's debounce after 2,900 of them sat unwritten.
 * Smaller batches than before (50) because a rejected batch costs whatever it
 * carried, and lib/match-cache.js only lets go of rows Supabase confirmed. */
const UPSERT_BATCH = 25;
const PAGE = 1000;
const MODEL = process.env.RADAR_MATCH_MODEL || DEFAULT_MODEL;

function parseArgs(argv) {
  const args = { dryRun: false, maxSpend: 5, limit: Infinity, pruneStaleProfiles: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--max-spend') args.maxSpend = Number(argv[++i]);
    else if (argv[i] === '--limit') args.limit = Number(argv[++i]);
    else if (argv[i] === '--prune-stale-profiles') args.pruneStaleProfiles = true;
  }
  return args;
}

/** Which postings have no judgment under this profile yet. Pure, so the
 *  diff can be pinned by tests rather than by watching a bill. */
function diffMisses(jobsWithHashes, existingHashes) {
  return jobsWithHashes.filter(({ hash }) => !existingHashes.has(hash));
}

function rowFromJudgment(job, jobHash, profileHash, judgment, model, nowIso) {
  return {
    job_hash: jobHash,
    profile_hash: profileHash,
    job_id: job.id,
    verdict: judgment.verdict,
    different_profession: judgment.different_profession,
    meets_requirements: judgment.meets_requirements,
    matches_preferences: judgment.matches_preferences,
    role_summary: judgment.role_summary ?? null,
    reasons: Array.isArray(judgment.reasons) ? judgment.reasons : [],
    gaps: Array.isArray(judgment.gaps) ? judgment.gaps : [],
    judged_at: nowIso,
    model
  };
}

function makeClient({ url, key }) {
  const request = async (method, pathname, { body, headers = {} } = {}) => {
    const response = await fetch(`${url}/rest/v1${pathname}`, {
      method,
      headers: {
        apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json', ...headers
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${pathname} → ${response.status}: ${text.slice(0, 250)}`);
    return text ? JSON.parse(text) : null;
  };
  return { request };
}

/** Every job_hash already judged under this profile. Paged — there are
 *  thousands, and PostgREST caps a response long before that. */
async function loadJudgedHashes(client, profileHash) {
  const hashes = new Set();
  for (let offset = 0; ; offset += PAGE) {
    const rows = await client.request('GET',
      `/match_cache?profile_hash=eq.${encodeURIComponent(profileHash)}`
      + `&select=job_hash&order=job_hash&limit=${PAGE}&offset=${offset}`);
    for (const row of rows || []) hashes.add(row.job_hash);
    if (!rows || rows.length < PAGE) break;
  }
  return hashes;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = supabaseEnv();
  if (!env) { console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY not set — nothing to judge against.'); return 1; }
  if (!process.env.OPENAI_API_KEY && !args.dryRun) { console.error('OPENAI_API_KEY not set.'); return 1; }
  const client = makeClient(env);

  const profileRows = await client.request('GET', '/profile_documents?select=content&limit=1');
  const content = profileRows?.[0]?.content;
  if (!content) { console.error('No profile document saved — run seed-supabase.js or save one in the dashboard.'); return 1; }
  const profile = parseProfileDocument(content);
  const invalid = RadarScoring.validateProfile(profile);
  if (invalid) { console.error(`Profile does not validate: ${invalid}`); return 1; }
  const compiled = RadarScoring.compileProfile(profile);
  const profileHash = compiled.hash;

  const jobs = await fetchAllJobs();
  if (!jobs || !jobs.length) { console.error('No jobs in Supabase — has the refresh run?'); return 1; }
  RadarScoring.scoreAll(jobs, compiled, null);

  // Highest keyword fit first: if a spend cap or a limit cuts the run short,
  // what got judged is the part most likely to matter.
  const qualified = jobs
    .filter((job) => RadarScoring.isQualified(job))
    .sort((a, b) => (b.fit?.fit_score || 0) - (a.fit?.fit_score || 0))
    .map((job) => ({ job, hash: RadarScoring.jobContentHash(job) }));

  const judged = await loadJudgedHashes(client, profileHash);
  const missedJobs = diffMisses(qualified, judged);
  // One judgment per distinct posting content, not per posting. The cache is
  // keyed on the content hash and every reader fans a row out to all the jobs
  // sharing it, so judging duplicates separately pays twice for one answer and
  // puts two rows with the same key in one upsert, which Postgres rejects whole.
  const { representatives } = groupMissesByHash(missedJobs);
  const duplicatesCollapsed = missedJobs.length - representatives.length;
  const misses = representatives.slice(0, args.limit);

  console.log(`profile ${profileHash} · ${jobs.length} jobs · ${qualified.length} qualified`);
  console.log(`${judged.size} already judged · ${missedJobs.length} unjudged postings`
    + ` → ${representatives.length} distinct hashes (${duplicatesCollapsed} duplicates collapsed)`);
  console.log(`${misses.length} to judge${Number.isFinite(args.limit) ? ` (limited to ${args.limit})` : ''}`);

  if (args.dryRun || !misses.length) {
    if (args.dryRun) console.log('Dry run — nothing judged, nothing written.');
    await summarize({ judgedNow: 0, unjudged: 0, spend: 0, remaining: misses.length, duplicatesCollapsed });
    return 0;
  }

  let spend = 0;
  let judgedNow = 0;
  let unjudged = 0;
  let stopped = false;

  /* Workers judge in parallel; exactly one of them writes at a time, and a row
   * is only dropped from the queue once Supabase has confirmed it. */
  const writer = createCacheWriter({
    batchSize: UPSERT_BATCH,
    upsert: (rows) => client.request('POST', '/match_cache?on_conflict=job_hash,profile_hash', {
      body: rows, headers: { prefer: 'resolution=merge-duplicates,return=minimal' }
    })
  });

  let next = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, misses.length) }, async () => {
    // Stop buying judgments the moment they can no longer be stored.
    while (next < misses.length && !stopped && !writer.failed) {
      const { job, hash } = misses[next];
      next += 1;
      if (spend >= args.maxSpend) { stopped = true; break; }
      try {
        const { parsed, usage } = await judgeOnce({
          key: process.env.OPENAI_API_KEY,
          model: MODEL,
          system: JUDGE_SYSTEM_PROMPT,
          user: judgeUserPrompt(job, profile, ''),
          schema: JUDGMENT_SCHEMA
        });
        spend += costOf(MODEL, usage);
        const judgment = normalizeJudgment(parsed);
        if (!judgment) { unjudged += 1; continue; }
        // Synchronous — the try/catch below now covers only the model call, so
        // a write problem can no longer be counted as an unjudged posting.
        writer.push(rowFromJudgment(job, hash, profileHash, judgment, MODEL, new Date().toISOString()));
        judgedNow += 1;
        if (judgedNow % 250 === 0) console.log(`  ${judgedNow} judged · $${spend.toFixed(3)}`);
      } catch (error) {
        // A bad key or a revoked one will fail identically on every posting;
        // burning through thousands to discover that is not diagnosis.
        if (/\b(401|403)\b|invalid_api_key/.test(error.message)) {
          console.error(`Fatal: ${error.message}`);
          stopped = true;
          break;
        }
        unjudged += 1;
        console.warn(`  ${job.id}: ${error.message.slice(0, 120)}`);
      }
    }
  }));
  // close() drains what is left and never throws, so the summary below is
  // written whatever happened — a lost final batch used to take the step
  // summary with it and exit before anyone could read what had gone wrong.
  const { written, unwritten, failure } = await writer.close();

  if (stopped && spend >= args.maxSpend) {
    console.log(`Stopped at the $${args.maxSpend} cap — re-run to continue.`);
  }
  const remaining = Math.max(0, misses.length - judgedNow - unjudged);
  console.log(`judged ${judgedNow} (${unjudged} unjudged, ${remaining} not reached) · $${spend.toFixed(3)}`);
  console.log(`cache: ${written} rows written${unwritten ? `, ${unwritten} UNWRITTEN` : ''}`);
  if (failure) {
    // The judgments still in the queue were paid for and are gone. They are not
    // lost work in the long run: the next run sees the same hashes as misses.
    console.error(`Cache write failed after retries — ${unwritten} judgments not stored: ${failure.message}`);
  }
  await summarize({ judgedNow, unjudged, spend, remaining, duplicatesCollapsed, written, unwritten, failure });
  if (failure) return 1;

  if (args.pruneStaleProfiles) {
    // Manual only. A profile edit orphans an entire generation of judgments,
    // and this is how they are reclaimed — but never automatically: a run
    // triggered mid-edit would vacuum rows you might revert to in a minute.
    await client.request('DELETE', `/match_cache?profile_hash=neq.${encodeURIComponent(profileHash)}`,
      { headers: { prefer: 'return=minimal' } });
    console.log('Pruned judgments belonging to other profile generations.');
  }
  return 0;
}

/** GitHub renders this on the run page, so the outcome is visible without
 *  opening the log. */
async function summarize({
  judgedNow, unjudged, spend, remaining,
  duplicatesCollapsed = 0, written = 0, unwritten = 0, failure = null
}) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  const fsp = require('fs/promises');
  await fsp.appendFile(file,
    `### Judged postings\n\n`
    + `- judged this run: **${judgedNow}**\n`
    + `- duplicate postings served by one judgment: ${duplicatesCollapsed}\n`
    + `- unjudged (model gave no usable answer): ${unjudged}\n`
    + `- not reached: ${remaining}\n`
    + `- written to cache: **${written}**${unwritten ? ` (unwritten: ${unwritten})` : ''}\n`
    + `- spend: **$${spend.toFixed(3)}**\n`
    + (failure ? `- **cache write failed:** ${failure.message}\n` : ''));
}

if (require.main === module) {
  main().then((code) => process.exit(code)).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { parseArgs, diffMisses, rowFromJudgment };
