#!/usr/bin/env node

/**
 * Local fit-aware digest: unlike the CI digest (sponsorship-ranked, profile-
 * blind), this scores every fresh job against your resume profile with the
 * SAME deterministic engine the dashboard uses, and pushes only the ones worth
 * your time — verdict >= good — with the variant to send and a one-line reason.
 *
 * It runs on YOUR machine (launchd/cron), never in CI, so profile.json never
 * leaves the box. The CI digest stays as the profile-blind fallback.
 *
 * Env:
 *   NTFY_TOPIC     — ntfy.sh topic (prints instead of pushing when unset)
 *   DIGEST_HOURS   — lookback window over first_seen_at, default 24
 *   DIGEST_MIN_VERDICT — lowest verdict to include: strong|good|moderate, default good
 *   DASHBOARD_URL  — click-through target
 *   SUPABASE_URL / SUPABASE_SERVICE_KEY — dataset of record (falls back to jobs.json)
 *
 * Usage: node radar/scripts/digest-local.js [--dry-run]
 */

const fsp = require('fs/promises');
const path = require('path');
const { fetchAllJobs } = require('./lib/supabase.js');
const RadarScoring = require('../public/scoring.js');

const DATA_DIR = path.resolve(__dirname, '../data');
const JOBS_PATH = path.join(DATA_DIR, 'jobs.json');
const PROFILE_PATH = path.join(DATA_DIR, 'profile.json');
const ROUTE_CACHE_PATH = path.join(DATA_DIR, 'route-cache.json');
const DEFAULT_DASHBOARD = 'https://christianmangwanda.github.io/veritas-research-radar/';
const MAX_LISTED = 8;

// Verdict tiers, best first; the cutoff is inclusive down to DIGEST_MIN_VERDICT.
const VERDICT_ORDER = RadarScoring.VERDICT_TIERS.map(([tier]) => tier); // strong,good,moderate,weak,stretch

async function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(await fsp.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function loadJobs() {
  let jobs = null;
  try {
    jobs = await fetchAllJobs();
  } catch { /* fall back to file */ }
  if (!jobs) {
    try {
      jobs = JSON.parse(await fsp.readFile(JOBS_PATH, 'utf8'));
    } catch {
      jobs = [];
    }
  }
  return jobs;
}

function variantLabel(job, variantId) {
  const match = (job.fit?.variants || []).find((variant) => variant.id === variantId);
  return match?.label || variantId || 'your resume';
}

async function buildDigest({ hours, minVerdict }) {
  const profile = await readJsonFile(PROFILE_PATH, null);
  if (!profile) {
    return { error: `No profile at ${path.relative(process.cwd(), PROFILE_PATH)} — run npm run radar:profile first.` };
  }
  const problem = RadarScoring.validateProfile(profile);
  if (problem) return { error: `profile.json is not usable: ${problem}` };

  const jobs = await loadJobs();
  const compiled = RadarScoring.compileProfile(profile);
  const routeCache = await readJsonFile(ROUTE_CACHE_PATH, null);
  RadarScoring.scoreAll(jobs, compiled, routeCache);

  const maxRank = VERDICT_ORDER.indexOf(minVerdict);
  const cutoffRank = maxRank === -1 ? VERDICT_ORDER.indexOf('good') : maxRank;
  const cutoff = Date.now() - hours * 60 * 60 * 1000;

  const fits = jobs.filter((job) => {
    if (job.status === 'closed') return false;
    if (job.citizenship_gated) return false; // can't act on it; dashboard still shows it (demote-never-hide)
    if (!Number.isFinite(Date.parse(job.first_seen_at || ''))) return false;
    if (Date.parse(job.first_seen_at) < cutoff) return false;
    const rank = VERDICT_ORDER.indexOf(job.fit?.verdict);
    return rank !== -1 && rank <= cutoffRank;
  });
  if (!fits.length) return { count: 0 };

  fits.sort((a, b) => (b.fit.fit_score ?? -1) - (a.fit.fit_score ?? -1));

  // Reason line: dominant variant + strongest verdict among the fits.
  const strongCount = fits.filter((job) => job.fit.verdict === 'strong').length;
  const byVariant = new Map();
  for (const job of fits) {
    const label = variantLabel(job, job.fit.recommended_variant);
    byVariant.set(label, (byVariant.get(label) || 0) + 1);
  }
  const topVariant = [...byVariant.entries()].sort((a, b) => b[1] - a[1])[0];
  const reason = strongCount
    ? `${strongCount} strong + ${fits.length - strongCount} good fit${fits.length - strongCount === 1 ? '' : 's'}`
    : `${fits.length} good fit${fits.length === 1 ? '' : 's'}`;
  const variantNote = topVariant ? `, mostly for “${topVariant[0]}”` : '';

  const lines = fits.slice(0, MAX_LISTED).map((job) => {
    const use = variantLabel(job, job.fit.recommended_variant);
    return `• ${job.title} — ${job.employer_name} [use: ${use}] (${job.fit.verdict}, fit ${job.fit.fit_score})`;
  });
  if (fits.length > MAX_LISTED) lines.push(`…and ${fits.length - MAX_LISTED} more on the dashboard.`);

  return {
    count: fits.length,
    title: `${reason} on the radar${variantNote}`,
    body: lines.join('\n')
  };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const hours = Number(process.env.DIGEST_HOURS) || 24;
  const minVerdict = (process.env.DIGEST_MIN_VERDICT || 'good').toLowerCase();
  const topic = process.env.NTFY_TOPIC;

  const digest = await buildDigest({ hours, minVerdict });
  if (digest.error) {
    console.error(digest.error);
    process.exitCode = 1;
    return;
  }
  if (!digest.count) {
    console.log(`No ${minVerdict}+ fits first seen in the last ${hours}h — no digest sent.`);
    return;
  }
  console.log(`${digest.title}\n${digest.body}`);

  if (dryRun) return;
  if (!topic) {
    console.log('NTFY_TOPIC not set — digest printed only. Set it to receive pushes.');
    return;
  }

  const response = await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
    method: 'POST',
    headers: {
      Title: digest.title,
      Tags: 'dart',
      Click: process.env.DASHBOARD_URL || DEFAULT_DASHBOARD
    },
    body: digest.body
  });
  if (!response.ok) throw new Error(`ntfy publish failed: ${response.status} ${response.statusText}`);
  console.log(`Local fit digest pushed to ntfy topic "${topic}".`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { buildDigest };
