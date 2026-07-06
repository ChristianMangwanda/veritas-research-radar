#!/usr/bin/env node

/**
 * Daily digest: new eligible jobs from the last window, ranked by sponsorship
 * evidence, pushed via ntfy.sh. A radar that never beeps is a report — this
 * is the beep.
 *
 * Env:
 *   NTFY_TOPIC     — ntfy.sh topic to publish to (skips cleanly when unset)
 *   DIGEST_HOURS   — lookback window, default 24
 *   DASHBOARD_URL  — click-through target for the notification
 *
 * Usage: node radar/scripts/digest.js [--dry-run]
 */

const fsp = require('fs/promises');
const path = require('path');
const { fetchAllJobs } = require('./lib/supabase.js');

const JOBS_PATH = path.resolve(__dirname, '../data/jobs.json');
const DEFAULT_DASHBOARD = 'https://christianmangwanda.github.io/veritas-research-radar/';
const MAX_LISTED = 8;

function evidenceLine(job) {
  const evidence = job.class_evidence;
  if (evidence?.certified_count_3y) {
    const wage = evidence.median_annual_wage ? `, median $${evidence.median_annual_wage.toLocaleString('en-US')}` : '';
    return `${evidence.certified_count_3y} ${job.title_class_label} LCAs (3y)${wage}`;
  }
  if (job.dol_lca_certified_count_3y) return `${job.dol_lca_certified_count_3y} LCAs institution-wide`;
  return 'no sponsorship history on record';
}

function rankJobs(a, b) {
  const classDelta = (b.class_evidence?.certified_count_3y || 0) - (a.class_evidence?.certified_count_3y || 0);
  if (classDelta !== 0) return classDelta;
  return (b.research_relevance_score || 0) - (a.research_relevance_score || 0);
}

async function buildDigest({ hours }) {
  // Supabase is the dataset of record; the local file is the fallback
  let jobs = null;
  try {
    jobs = await fetchAllJobs();
  } catch { /* fall back to file */ }
  if (!jobs) jobs = JSON.parse(await fsp.readFile(JOBS_PATH, 'utf8'));
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  const fresh = jobs.filter((job) =>
    job.status !== 'closed'
    && !job.citizenship_gated
    && Number.isFinite(Date.parse(job.first_seen_at || ''))
    && Date.parse(job.first_seen_at) >= cutoff);
  if (!fresh.length) return null;

  fresh.sort(rankJobs);
  const lines = fresh.slice(0, MAX_LISTED).map((job) =>
    `• ${job.title} — ${job.employer_name} (${evidenceLine(job)})`);
  if (fresh.length > MAX_LISTED) lines.push(`…and ${fresh.length - MAX_LISTED} more on the dashboard.`);

  return {
    title: `${fresh.length} new research job${fresh.length === 1 ? '' : 's'} on the radar`,
    body: lines.join('\n'),
    count: fresh.length
  };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const hours = Number(process.env.DIGEST_HOURS) || 24;
  const topic = process.env.NTFY_TOPIC;

  const digest = await buildDigest({ hours });
  if (!digest) {
    console.log(`No new jobs in the last ${hours}h — no digest sent.`);
    return;
  }
  console.log(`${digest.title}\n${digest.body}`);

  if (dryRun) return;
  if (!topic) {
    console.log('NTFY_TOPIC not set — digest printed only. Set the secret to receive pushes.');
    return;
  }

  const response = await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
    method: 'POST',
    headers: {
      Title: digest.title,
      Tags: 'satellite',
      Click: process.env.DASHBOARD_URL || DEFAULT_DASHBOARD
    },
    body: digest.body
  });
  if (!response.ok) throw new Error(`ntfy publish failed: ${response.status} ${response.statusText}`);
  console.log(`Digest pushed to ntfy topic "${topic}".`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { buildDigest, evidenceLine };
