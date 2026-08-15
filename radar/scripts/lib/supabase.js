/**
 * Zero-dependency Supabase sink: plain PostgREST over fetch, no SDK.
 * Activated only when SUPABASE_URL + SUPABASE_SERVICE_KEY are set — every
 * caller degrades cleanly to git-only mode without them (dual-write phase).
 */

const { writeAllBatches } = require('./batch-write.js');

/* Upserts are batched small and written one after another. The old sink pushed
 * 500 rows a time and rewrote all ~25,000 every run — a mirror, not a sync —
 * which is what put statement timeouts on half the refreshes. A differential
 * run writes hundreds, so the batch size is now about surviving a slow moment
 * rather than about throughput. */
const BATCH_SIZE = 100;
/* Ids are long and colon-composed, so a delete list is chunked by count to keep
 * the request URL well inside any sane limit. */
const DELETE_BATCH = 80;
const REQUEST_TIMEOUT_MS = 30000;
// Deep-offset GET pages transiently 500 under load; a couple of retries with
// backoff turns a flaky page into a slow one instead of an empty read that
// would reset the whole lifecycle downstream.
const READ_RETRIES = 3;
const READ_RETRY_BASE_MS = 500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Credentials come from the ENVIRONMENT only — never from a file found lying
 * around. That is a safety property, not an oversight: syncJobs writes and
 * deletes rows in the dataset of record, so a local run that silently adopted a
 * .env would mutate production while its author believed they were working
 * offline. Scripts meant to be run by hand opt in explicitly with
 * lib/env-file.js.
 *
 * Both key names are accepted because both are in circulation: CI holds
 * SUPABASE_SERVICE_KEY as a repo secret, and Supabase now calls the same thing
 * a "secret key" (sb_secret_…) in the dashboard.
 */
function supabaseEnv() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) return null;
  return { url: url.replace(/\/$/, ''), key };
}

async function request(env, method, pathname, { body, headers = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${env.url}/rest/v1${pathname}`, {
      method,
      signal: controller.signal,
      headers: {
        apikey: env.key,
        authorization: `Bearer ${env.key}`,
        'content-type': 'application/json',
        ...headers
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`supabase ${method} ${pathname}: ${response.status} ${detail.slice(0, 300)}`);
    }
    return response;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The description is the single biggest field on a job (~59% of the serialized
 * payload, ~3KB each) and it already has its own column. Storing it a second
 * time inside `payload` bought nothing and roughly doubled the table.
 *
 * It is stripped on write and put back on read (`rehydrateJob`), so every
 * consumer still sees a whole job. Rows written before this change still carry
 * the description inside payload; rehydrate prefers the column and falls back
 * to whatever the payload holds, so both generations read identically.
 */
function payloadWithoutDescription(job) {
  const { description_text: _description, ...rest } = job;
  return rest;
}

function rehydrateJob(row) {
  if (!row || !row.payload) return null;
  return {
    ...row.payload,
    description_text: row.description_text ?? row.payload.description_text ?? null
  };
}

function jobRow(job, syncedAt) {
  return {
    id: job.id,
    employer_id: job.employer_id,
    employer_name: job.employer_name ?? null,
    title: job.title ?? null,
    title_class: job.title_class ?? null,
    department: job.department ?? null,
    location: job.location ?? null,
    url: job.url ?? null,
    description_text: job.description_text ?? null,
    veritas_state: job.veritas_state ?? null,
    sponsor_signal: job.sponsor_signal ?? null,
    research_relevance_score: job.research_relevance_score ?? null,
    cap_exempt_status: job.cap_exempt_status ?? null,
    cap_exempt_score: job.cap_exempt_score ?? null,
    class_evidence: job.class_evidence ?? null,
    citizenship_gated: Boolean(job.citizenship_gated),
    source: job.source ?? null,
    status: job.status ?? 'active',
    first_seen_at: job.first_seen_at ?? null,
    last_seen_at: job.last_seen_at ?? null,
    closed_at: job.closed_at ?? null,
    posted_or_updated_at: job.posted_or_updated_at || null,
    payload: payloadWithoutDescription(job),
    updated_at: syncedAt
  };
}

/**
 * `in.("a","b")` for PostgREST. Quoting is not optional: job ids are
 * colon-composed (`workday:cornell:WDR-1`) and a bare colon ends the value.
 * Getting it wrong does not error — the filter simply matches nothing, which
 * for a DELETE means the rows silently stay.
 */
function inList(values) {
  return `(${values.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')})`;
}

/**
 * JSON.stringify with object keys sorted, recursively.
 *
 * This is what makes a content comparison possible at all. Previous rows come
 * back out of a jsonb column, and Postgres does not preserve key order in
 * jsonb — it stores keys sorted by length then bytes. Fresh jobs carry the
 * insertion order enrichJob built them with. Compared naively, every row on
 * every run looks changed, and the differential sync degenerates into the full
 * mirror it replaced.
 */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v) ?? 'null').join(',')}]`;
  const parts = [];
  for (const key of Object.keys(value).sort()) {
    const encoded = stableStringify(value[key]);
    // Matching JSON.stringify: a property whose value is undefined is dropped.
    if (encoded !== undefined) parts.push(`${JSON.stringify(key)}:${encoded}`);
  }
  return `{${parts.join(',')}}`;
}

/**
 * The comparison key for "has this posting actually changed?".
 *
 * Two fields are deliberately excluded because enrichJob restamps them on every
 * single fetch: `last_seen_at` and `provenance.fetched_at`. Including them
 * would mark all ~18,000 active jobs as changed every run and buy nothing —
 * they are written by the refresh and read by nobody.
 *
 * The cost is a real semantic change worth knowing about: a stored
 * `last_seen_at` now means "when this posting's CONTENT last changed", not
 * "when we last saw it". Anything that ever wants true sighting times has to
 * put the field back and accept rewriting the whole table to carry it.
 *
 * Comparing built rows rather than stored bytes also makes the two row
 * generations equivalent: legacy rows keep the description inside `payload`
 * and current rows do not, but both sides pass through payloadWithoutDescription
 * here, so an untouched legacy row does not count as changed (it stays fat in
 * the table until its content changes, which costs bytes, not correctness).
 */
function comparableRow(job) {
  const probe = {
    ...job,
    last_seen_at: null,
    provenance: job.provenance ? { ...job.provenance, fetched_at: null } : job.provenance
  };
  // A fixed timestamp on both sides, so updated_at cancels out.
  return stableStringify(jobRow(probe, null));
}

/**
 * What this run has to write, against the previous state it read.
 *
 * `previous` of null means "no trustworthy baseline" — everything is an upsert
 * and nothing is deleted, which is the bootstrap shape and can never remove a
 * row we failed to read.
 *
 * On deletes: the id list is exactly the rows the baseline had and this run no
 * longer carries. Closed tombstones are still IN `jobs` until they age out, so
 * they are never in that set — the deletions are expired tombstones and rows
 * belonging to employers dropped from the registry. That is the same set the
 * old timestamp sweep removed, enumerated instead of inferred.
 */
function diffJobs(previousJobs, nextJobs) {
  // Same-id duplicates in one upsert make Postgres reject the whole batch
  // ("cannot affect row a second time") — last occurrence wins.
  const next = [...new Map(nextJobs.map((job) => [job.id, job])).values()];
  if (!previousJobs) return { upserts: next, deleteIds: [], unchanged: 0 };

  const previousById = new Map(previousJobs.map((job) => [job.id, job]));
  const upserts = [];
  let unchanged = 0;
  for (const job of next) {
    const before = previousById.get(job.id);
    if (before && comparableRow(before) === comparableRow(job)) unchanged += 1;
    else upserts.push(job);
  }

  const nextIds = new Set(next.map((job) => job.id));
  const deleteIds = [...previousById.keys()].filter((id) => !nextIds.has(id));
  return { upserts, deleteIds, unchanged };
}

/**
 * Differential sync: write what changed, delete what left, leave the rest alone.
 *
 * The previous version was a mirror — it upserted all ~25,000 rows stamped with
 * the run's timestamp and then deleted everything older. Postgres had to write
 * every row and maintain the updated_at index whether or not anything about the
 * posting had moved, roughly 154,000 large upserts a day across the schedules,
 * and half of the refreshes hit a statement timeout on the way through.
 *
 * Order matters: upserts first, and deletes only once every one of them
 * succeeded. A run that dies halfway leaves rows written but nothing removed,
 * which is a state the next run corrects; the reverse could delete a posting
 * whose replacement never landed.
 */
async function syncJobs(jobs, report, { previous = null } = {}) {
  const env = supabaseEnv();
  if (!env) return { synced: false, reason: 'SUPABASE_URL / SUPABASE_SERVICE_KEY not set' };

  const syncedAt = new Date().toISOString();
  const { upserts, deleteIds, unchanged } = diffJobs(previous, jobs);

  await writeAllBatches(
    upserts.map((job) => jobRow(job, syncedAt)),
    (batch) => request(env, 'POST', '/jobs?on_conflict=id', {
      body: batch,
      headers: { prefer: 'resolution=merge-duplicates,return=minimal' }
    }),
    { batchSize: BATCH_SIZE }
  );

  for (let offset = 0; offset < deleteIds.length; offset += DELETE_BATCH) {
    const batch = deleteIds.slice(offset, offset + DELETE_BATCH);
    await request(env, 'DELETE', `/jobs?id=in.${encodeURIComponent(inList(batch))}`, {
      headers: { prefer: 'return=minimal' }
    });
  }

  if (report) {
    report.supabase_sync = {
      mode: previous ? 'diff' : 'full',
      upserted: upserts.length,
      deleted: deleteIds.length,
      unchanged,
      total: jobs.length
    };
    try {
      await request(env, 'POST', '/refresh_runs', {
        body: { refreshed_at: report.refreshed_at, report },
        headers: { prefer: 'return=minimal' }
      });
    } catch (error) {
      // Telemetry, not data. The jobs table is already correct at this point and
      // failing the refresh here would skip judging for no reason worth having.
      report.refresh_run_recorded = false;
      console.warn(`refresh_runs telemetry insert failed (jobs are synced): ${error.message}`);
    }
  }

  return {
    synced: true,
    count: jobs.length,
    upserted: upserts.length,
    deleted: deleteIds.length,
    unchanged
  };
}

/**
 * Load the full previous dataset (the payload column carries the enriched job
 * minus its description, which is rejoined from its own column). Returns null
 * when credentials are missing or the table is empty so callers can fall back
 * to the local jobs.json file.
 *
 * The description MUST be selected here, not just in the dashboard: refresh.js
 * uses this as previous state, and jobs carried forward through a failed fetch
 * are written straight back. Reading without it would blank the description of
 * every carried-forward job on the next run.
 *
 * KEYSET, not OFFSET, and 500 rows a page. OFFSET makes Postgres walk and
 * discard every row before the window, so the cost climbs with depth while the
 * statement timeout does not — the dashboard was measured losing 11 of 26 deep
 * pages that way, showing 14,054 of 25,054 jobs. Cursoring on the primary key
 * reads every page for the same price. The pages stay SEQUENTIAL: fetching
 * ranges concurrently was measured far worse (65 failures, 3,000 rows missing).
 */
async function fetchAllJobs() {
  const env = supabaseEnv();
  if (!env) return null;
  const pageSize = 500;
  const jobs = [];
  let cursor = null;
  for (;;) {
    const pathname = `/jobs?select=id,payload,description_text&order=id&limit=${pageSize}`
      + (cursor === null ? '' : `&id=gt.${encodeURIComponent(cursor)}`);
    let rows = null;
    for (let attempt = 0; ; attempt += 1) {
      try {
        const response = await request(env, 'GET', pathname);
        rows = await response.json();
        break;
      } catch (error) {
        // A single failed page must not collapse the whole read to "empty" —
        // that empties previous-state and resets first_seen/tombstones. Retry,
        // then propagate so the caller can abort rather than corrupt.
        if (attempt >= READ_RETRIES) throw error;
        await sleep(READ_RETRY_BASE_MS * (attempt + 1));
      }
    }
    jobs.push(...rows.map(rehydrateJob).filter(Boolean));
    if (rows.length < pageSize) break;
    cursor = rows[rows.length - 1].id;
  }
  return jobs.length ? jobs : null;
}

module.exports = {
  syncJobs, fetchAllJobs, supabaseEnv, jobRow, rehydrateJob, payloadWithoutDescription,
  diffJobs, comparableRow, stableStringify, inList
};
