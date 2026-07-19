#!/usr/bin/env node

/**
 * Dead-man's switch: a radar that silently stops refreshing looks identical to
 * one with no new jobs. This runs on its own schedule, reads the committed
 * refresh report, and pushes an ntfy alert if the pipeline looks dead:
 *   - the last refresh is older than DEADMAN_MAX_AGE_HOURS (default 8), or
 *   - the last refresh reported fetch errors, or
 *   - the last refresh flagged a zero-job recall anomaly, or
 *   - the last refresh aborted its Supabase sync (lifecycle guard tripped).
 *
 * Env:
 *   NTFY_TOPIC              — ntfy.sh topic (prints instead of pushing when unset)
 *   DEADMAN_MAX_AGE_HOURS   — staleness threshold in hours, default 8
 *   DEADMAN_MAX_ERRORED     — errored-employer count that trips the alarm, default 10
 *                             (transient single-feed blips are normal and shouldn't page)
 *
 * Exits 0 on a clean check or a delivered alert; exits 1 only when it cannot
 * read the report at all (which the workflow surfaces as a failed run).
 */

const fsp = require('fs/promises');
const path = require('path');

const REPORT_PATH = path.resolve(__dirname, '../data/refresh-report.json');

async function pushNtfy(title, body) {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) {
    console.log(`[no NTFY_TOPIC] ${title}\n${body}`);
    return;
  }
  const response = await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
    method: 'POST',
    headers: { Title: title, Tags: 'rotating_light' },
    body
  });
  if (!response.ok) throw new Error(`ntfy publish failed: ${response.status} ${response.statusText}`);
}

async function main() {
  const maxAgeHours = Number(process.env.DEADMAN_MAX_AGE_HOURS) || 8;
  const maxErrored = Number(process.env.DEADMAN_MAX_ERRORED) || 10;

  let report;
  try {
    report = JSON.parse(await fsp.readFile(REPORT_PATH, 'utf8'));
  } catch (error) {
    console.error(`Cannot read refresh report at ${REPORT_PATH}: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const problems = [];
  const refreshedAt = Date.parse(report.refreshed_at || '');
  if (!Number.isFinite(refreshedAt)) {
    problems.push('refresh report has no valid refreshed_at timestamp');
  } else {
    const ageHours = (Date.now() - refreshedAt) / (60 * 60 * 1000);
    if (ageHours > maxAgeHours) {
      problems.push(`last refresh was ${ageHours.toFixed(1)}h ago (> ${maxAgeHours}h) — the pipeline may be stuck`);
    }
  }
  if (report.errored_employers >= maxErrored) {
    problems.push(`${report.errored_employers} employer(s) errored on the last refresh (>= ${maxErrored})`);
  }
  if (Array.isArray(report.recall_anomalies) && report.recall_anomalies.length) {
    const names = report.recall_anomalies.map((a) => a.name).join(', ');
    problems.push(`${report.recall_anomalies.length} zero-job recall anomaly(ies): ${names}`);
  }
  if (report.supabase_sync_aborted) {
    problems.push(`Supabase sync aborted: ${report.supabase_sync_aborted}`);
  }

  if (!problems.length) {
    console.log(`Radar healthy: last refresh ${report.refreshed_at}, ${report.active_job_count} active jobs.`);
    return;
  }

  const title = 'Radar dead-man alert';
  const body = problems.map((p) => `• ${p}`).join('\n');
  // Log the detail first so it survives even if the push fails, then push
  // best-effort: a flaky ntfy must not turn a problem-detected run into a
  // detail-less failed workflow (whose generic failure alert loses this body).
  console.warn(`${title}\n${body}`);
  try {
    await pushNtfy(title, body);
  } catch (error) {
    console.warn(`ntfy push failed (detail logged above): ${error.message}`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { main };
