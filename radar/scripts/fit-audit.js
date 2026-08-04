#!/usr/bin/env node

/**
 * Read-only introspection of the fit engine against the real dataset.
 *
 * The verdict tiers are absolute floors on a score scale that shifts whenever
 * the matching rules change, so recalibration has to be driven by the actual
 * distribution rather than by intuition. This prints it, plus the per-variant
 * score ceilings (a 27-skill variant can outscore a 10-skill one on breadth
 * alone) and a sampled review set for the eligibility verdicts.
 *
 * Nothing here writes: it loads the live dataset, scores it in memory, and
 * reports. Resume data stays local, as everywhere else.
 *
 * Usage:
 *   node radar/scripts/fit-audit.js --histogram
 *   node radar/scripts/fit-audit.js --tracks
 *   node radar/scripts/fit-audit.js --sample-blocked 30 [--seed 7]
 */

const fsp = require('fs/promises');
const path = require('path');
const { fetchAllJobs } = require('./lib/supabase.js');
const RadarScoring = require('../public/scoring.js');

const DATA_DIR = path.resolve(__dirname, '../data');
const JOBS_PATH = path.join(DATA_DIR, 'jobs.json');
const PROFILE_PATH = path.join(DATA_DIR, 'profile.json');
const ROUTE_CACHE_PATH = path.join(DATA_DIR, 'route-cache.json');
const CLASSIFY_CACHE_PATH = path.join(DATA_DIR, 'classify-cache.json');

async function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(await fsp.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

// Supabase is the dataset of record; jobs.json is usually absent locally.
async function loadJobs() {
  try {
    const jobs = await fetchAllJobs();
    if (jobs && jobs.length) return jobs;
  } catch { /* fall back to file */ }
  return readJsonFile(JOBS_PATH, []);
}

/* -------------------------------------------------------------------------- */
/* Pure helpers (exported for tests)                                           */

// Deterministic sampling: a review set must be reproducible across runs, so
// findings can be quoted and re-checked after a fix.
function seededShuffle(items, seed) {
  const out = items.slice();
  let state = (seed >>> 0) || 1;
  for (let i = out.length - 1; i > 0; i -= 1) {
    state ^= state << 13; state >>>= 0;
    state ^= state >> 17;
    state ^= state << 5; state >>>= 0;
    const j = state % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function histogram(jobs, bucketSize = 5) {
  const buckets = new Map();
  const tiers = new Map();
  let scored = 0;
  for (const job of jobs) {
    const score = job.fit?.fit_score;
    if (!Number.isFinite(score)) continue;
    scored += 1;
    const bucket = Math.floor(score / bucketSize) * bucketSize;
    buckets.set(bucket, (buckets.get(bucket) || 0) + 1);
    tiers.set(job.fit.verdict, (tiers.get(job.fit.verdict) || 0) + 1);
  }
  return { scored, buckets, tiers };
}

// The ceiling a variant could reach on a perfect posting — the visible form of
// "breadth beats precision" (a long skill list saturates the cap, a short one
// cannot reach it at all).
function variantCeilings(profile) {
  const { WEIGHTS } = RadarScoring;
  return (profile.variants || []).map((variant) => {
    const raw = (variant.skills || [])
      .reduce((sum, skill) => sum + (WEIGHTS.SKILL_POINTS[Math.min(3, Math.max(1, Math.round(skill.weight)))] || 0), 0);
    return {
      id: variant.id,
      skills: (variant.skills || []).length,
      rawSkillPoints: raw,
      cappedSkillPoints: Math.min(raw, WEIGHTS.SKILL_CAP),
      reachesCap: raw >= WEIGHTS.SKILL_CAP
    };
  });
}

function sampleBlocked(jobs, count, seed) {
  const blocked = jobs.filter((job) => job.fit?.eligibility?.verdict === 'blocked');
  return { total: blocked.length, sample: seededShuffle(blocked, seed).slice(0, count) };
}

/* -------------------------------------------------------------------------- */

function parseArgs(argv) {
  const opts = { mode: null, count: 30, seed: 7 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--histogram') opts.mode = 'histogram';
    else if (arg === '--tracks') opts.mode = 'tracks';
    else if (arg === '--sample-blocked') {
      opts.mode = 'sample-blocked';
      const next = Number(argv[i + 1]);
      if (Number.isFinite(next)) { opts.count = next; i += 1; }
    } else if (arg === '--seed') { opts.seed = Number(argv[i + 1]) || 7; i += 1; }
  }
  return opts;
}

function bar(count, max, width = 40) {
  return '█'.repeat(Math.max(count > 0 ? 1 : 0, Math.round((count / max) * width)));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.mode) {
    console.error('Usage: fit-audit.js --histogram | --tracks | --sample-blocked N [--seed S]');
    process.exitCode = 1;
    return;
  }

  const profile = await readJsonFile(PROFILE_PATH, null);
  if (!profile) {
    console.error('No radar/data/profile.json — run npm run radar:profile first.');
    process.exitCode = 1;
    return;
  }
  const compiled = RadarScoring.compileProfile(profile);
  if (!compiled) {
    console.error(`profile.json is not usable: ${RadarScoring.validateProfile(profile)}`);
    process.exitCode = 1;
    return;
  }

  const allJobs = await loadJobs();
  const jobs = allJobs.filter((job) => job.status !== 'closed');
  if (!jobs.length) {
    console.error('No jobs available (Supabase unreachable and no local jobs.json).');
    process.exitCode = 1;
    return;
  }
  const classifyCache = await readJsonFile(CLASSIFY_CACHE_PATH, null);
  if (classifyCache && RadarScoring.applyJobClassifications) {
    const applied = RadarScoring.applyJobClassifications(jobs, classifyCache);
    if (applied) console.log(`Applied ${applied.toLocaleString()} cached classifications.\n`);
  }
  RadarScoring.scoreAll(jobs, compiled, await readJsonFile(ROUTE_CACHE_PATH, null));

  if (opts.mode === 'histogram') {
    const { scored, buckets, tiers } = histogram(jobs);
    console.log(`Fit distribution over ${scored.toLocaleString()} active jobs\n`);
    const ordered = [...buckets.entries()].sort((a, b) => a[0] - b[0]);
    const max = Math.max(...ordered.map(([, count]) => count));
    for (const [bucket, count] of ordered) {
      console.log(`${String(bucket).padStart(3)}-${String(bucket + 4).padEnd(3)} ${String(count).padStart(6)} ${bar(count, max)}`);
    }
    console.log('\nVerdict tiers (current floors):');
    for (const [tier, floor] of RadarScoring.VERDICT_TIERS) {
      console.log(`  ${tier.padEnd(9)} >= ${String(floor).padStart(3)}  ${String(tiers.get(tier) || 0).padStart(6)} jobs`);
    }
    const top = jobs.filter((job) => Number.isFinite(job.fit?.fit_score))
      .sort((a, b) => b.fit.fit_score - a.fit.fit_score).slice(0, 10);
    console.log('\nTop 10 by fit:');
    for (const job of top) {
      console.log(`  ${String(job.fit.fit_score).padStart(3)} ${job.fit.verdict.padEnd(9)} ${job.title.slice(0, 62)} — ${job.employer_name}`);
    }
    console.log('\nPer-variant skill ceilings (cap ' + RadarScoring.WEIGHTS.SKILL_CAP + '):');
    for (const row of variantCeilings(profile)) {
      console.log(`  ${row.id.padEnd(22)} ${String(row.skills).padStart(3)} skills  max ${String(row.rawSkillPoints).padStart(3)}` +
        `${row.reachesCap ? '' : '  (cannot reach cap)'}`);
    }
    return;
  }

  if (opts.mode === 'tracks') {
    const counts = new Map();
    for (const job of jobs) {
      const status = job.fit?.track?.status || 'n/a';
      counts.set(status, (counts.get(status) || 0) + 1);
    }
    console.log(`Role tracks over ${jobs.length.toLocaleString()} active jobs\n`);
    for (const [status, count] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${status.padEnd(10)} ${String(count).padStart(6)}  ${(count / jobs.length * 100).toFixed(1)}%`);
    }
    const eligible = jobs.filter((job) => job.fit?.eligibility);
    if (eligible.length) {
      const verdicts = new Map();
      for (const job of eligible) verdicts.set(job.fit.eligibility.verdict, (verdicts.get(job.fit.eligibility.verdict) || 0) + 1);
      console.log('\nEligibility:');
      for (const [verdict, count] of [...verdicts.entries()].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${verdict.padEnd(10)} ${String(count).padStart(6)}  ${(count / eligible.length * 100).toFixed(1)}%`);
      }
      const reachable = jobs.filter((job) => job.fit?.track?.status === 'reachable');
      const clear = reachable.filter((job) => job.fit.eligibility.verdict === 'clear');
      console.log(`\nFunnel: ${jobs.length.toLocaleString()} active` +
        ` → ${reachable.length.toLocaleString()} in-track` +
        ` → ${clear.length.toLocaleString()} clear to apply`);
    }
    return;
  }

  const { total, sample } = sampleBlocked(jobs, opts.count, opts.seed);
  console.log(`${total.toLocaleString()} blocked jobs; reviewing ${sample.length} (seed ${opts.seed}).`);
  console.log('A false block is the unforgivable error — it hides a job you could get.\n');
  for (const [index, job] of sample.entries()) {
    console.log(`${String(index + 1).padStart(3)}. ${job.title} — ${job.employer_name}`);
    console.log(`     fit ${job.fit.fit_score} ${job.fit.verdict} · ${job.title_class} · ${job.url}`);
    for (const blocker of job.fit.eligibility.blockers) {
      console.log(`     [${blocker.type}] ${blocker.source === 'metadata' ? '(metadata)' : `"${blocker.evidence}"`}`);
    }
    console.log();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { histogram, variantCeilings, sampleBlocked, seededShuffle, parseArgs };
