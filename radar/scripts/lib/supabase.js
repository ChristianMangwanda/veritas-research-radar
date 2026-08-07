/**
 * Zero-dependency Supabase sink: plain PostgREST over fetch, no SDK.
 * Activated only when SUPABASE_URL + SUPABASE_SERVICE_KEY are set — every
 * caller degrades cleanly to git-only mode without them (dual-write phase).
 */

const BATCH_SIZE = 500;
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
 * around. That is a safety property, not an oversight: syncJobs ends by
 * deleting every row it did not just write, so a local run that silently
 * adopted a .env would mutate production while its author believed they were
 * working offline. Scripts meant to be run by hand opt in explicitly with
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
 * Full-dataset sync: upsert every current job stamped with this run's
 * timestamp, then delete rows the run did not touch (jobs that aged out of
 * the lifecycle entirely). Mirrors "jobs.json is the whole dataset" semantics.
 */
async function syncJobs(jobs, report) {
  const env = supabaseEnv();
  if (!env) return { synced: false, reason: 'SUPABASE_URL / SUPABASE_SERVICE_KEY not set' };

  const syncedAt = new Date().toISOString();
  // Same-id duplicates in one upsert make Postgres reject the whole batch
  // ("cannot affect row a second time") — last occurrence wins
  const uniqueJobs = [...new Map(jobs.map((job) => [job.id, job])).values()];
  for (let offset = 0; offset < uniqueJobs.length; offset += BATCH_SIZE) {
    const batch = uniqueJobs.slice(offset, offset + BATCH_SIZE).map((job) => jobRow(job, syncedAt));
    await request(env, 'POST', '/jobs?on_conflict=id', {
      body: batch,
      headers: { prefer: 'resolution=merge-duplicates,return=minimal' }
    });
  }

  // Rows untouched by this sync are no longer in the dataset
  await request(env, 'DELETE', `/jobs?updated_at=lt.${encodeURIComponent(syncedAt)}`, {
    headers: { prefer: 'return=minimal' }
  });

  if (report) {
    await request(env, 'POST', '/refresh_runs', {
      body: { refreshed_at: report.refreshed_at, report },
      headers: { prefer: 'return=minimal' }
    });
  }

  return { synced: true, count: uniqueJobs.length };
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
 */
async function fetchAllJobs() {
  const env = supabaseEnv();
  if (!env) return null;
  const pageSize = 1000;
  const jobs = [];
  for (let offset = 0; ; offset += pageSize) {
    const pathname = `/jobs?select=payload,description_text&order=id&limit=${pageSize}&offset=${offset}`;
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
  }
  return jobs.length ? jobs : null;
}

module.exports = { syncJobs, fetchAllJobs, supabaseEnv, jobRow, rehydrateJob, payloadWithoutDescription };
