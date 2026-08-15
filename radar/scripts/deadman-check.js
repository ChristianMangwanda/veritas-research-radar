#!/usr/bin/env node

/**
 * Dead-man's switch: a radar that silently stops refreshing looks identical to
 * one with no new jobs. This runs on its own schedule, reads the committed
 * refresh report, and pushes an ntfy alert if the pipeline looks dead:
 *   - the last refresh is older than DEADMAN_MAX_AGE_HOURS (default 8), or
 *   - the last refresh reported fetch errors, or
 *   - the last refresh flagged a zero-job recall anomaly, or
 *   - the last refresh aborted its Supabase sync (lifecycle guard tripped), or
 *   - the last refresh FAILED its Supabase sync partway through.
 *
 * Env:
 *   NTFY_TOPIC              — ntfy.sh topic (prints instead of pushing when unset)
 *   DEADMAN_MAX_AGE_HOURS   — staleness threshold in hours, default 8
 *   DEADMAN_MAX_ERRORED     — errored-employer count that trips the alarm, default 10
 *                             (transient single-feed blips are normal and shouldn't page)
 *
 * Exit codes — the alarm has to end up somewhere a human will look:
 *   0  clean check, or a problem that was successfully pushed to ntfy
 *   1  a problem with NOWHERE to deliver it (no NTFY_TOPIC, or the push
 *      failed), or the report could not be read at all
 *
 * That second case is the whole point. With no ntfy topic configured the
 * alert used to be printed into the log of a run that then reported success,
 * so a stalled pipeline showed a green tick — observed live on 2026-08-04,
 * when this correctly detected a 12.7h-stale pipeline and said so only in a
 * log nobody opens. When there is no push channel, a failed run IS the
 * notification: it puts a red mark in the Actions list.
 */

const fsp = require('fs/promises');
const path = require('path');

const REPORT_PATH = path.resolve(__dirname, '../data/refresh-report.json');

// Returns true only when the alert actually reached ntfy. The caller uses that
// to decide whether the run itself has to carry the signal instead.
async function pushNtfy(title, body) {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) {
    console.log(`[no NTFY_TOPIC] ${title}\n${body}`);
    return false;
  }
  const response = await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
    method: 'POST',
    headers: { Title: title, Tags: 'rotating_light' },
    body
  });
  if (!response.ok) throw new Error(`ntfy publish failed: ${response.status} ${response.statusText}`);
  return true;
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
  /* An ABORTED sync wrote nothing and left the table consistent. A FAILED one
   * threw partway through, so the dataset of record is missing this run's
   * writes while the report itself looks perfectly healthy — fresh timestamp,
   * no errors, no anomalies. That combination is exactly what let a broken sync
   * sit behind a green tick, so it gets its own alarm. Absent field = an older
   * report from before this was recorded, which is not a problem. */
  if (report.supabase_sync_status === 'failed') {
    problems.push(`Supabase sync FAILED on the last refresh: ${report.supabase_sync_error || 'no reason recorded'}`);
  }

  if (!problems.length) {
    console.log(`Radar healthy: last refresh ${report.refreshed_at}, ${report.active_job_count} active jobs.`);
    return;
  }

  const title = 'Radar dead-man alert';
  const body = problems.map((p) => `• ${p}`).join('\n');
  // Log the detail first so it survives even if the push fails, then push
  // best-effort: a flaky ntfy must not cost us the detail.
  console.warn(`${title}\n${body}`);

  // Put the reason on the run's summary page too, so the red mark in the
  // Actions list is self-explaining without opening the log.
  await writeStepSummary(title, problems);

  let delivered = false;
  try {
    delivered = await pushNtfy(title, body);
  } catch (error) {
    console.warn(`ntfy push failed (detail logged above): ${error.message}`);
  }

  if (!delivered) {
    console.error('No delivery channel for this alert — failing the run so it is visible in the Actions list.');
    process.exitCode = 1;
  }
}

/**
 * GitHub renders this file on the run's summary page. Absent outside Actions,
 * and a failure to write it must never mask the alert itself.
 */
async function writeStepSummary(title, problems) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  const lines = [`## ${title}`, '', ...problems.map((p) => `- ${p}`), ''];
  try {
    await fsp.appendFile(summaryPath, `${lines.join('\n')}\n`, 'utf8');
  } catch (error) {
    console.warn(`could not write step summary: ${error.message}`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { main };
