/**
 * Zero-dependency Supabase sink: plain PostgREST over fetch, no SDK.
 * Activated only when SUPABASE_URL + SUPABASE_SERVICE_KEY are set — every
 * caller degrades cleanly to git-only mode without them (dual-write phase).
 */

const BATCH_SIZE = 500;
const REQUEST_TIMEOUT_MS = 30000;

function supabaseEnv() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
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
    payload: job,
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
 * Load the full previous dataset (payload column carries the enriched job
 * verbatim). Returns null when credentials are missing or the table is empty
 * so callers can fall back to the local jobs.json file.
 */
async function fetchAllJobs() {
  const env = supabaseEnv();
  if (!env) return null;
  const pageSize = 1000;
  const jobs = [];
  for (let offset = 0; ; offset += pageSize) {
    const response = await request(env, 'GET', `/jobs?select=payload&order=id&limit=${pageSize}&offset=${offset}`);
    const rows = await response.json();
    jobs.push(...rows.map((row) => row.payload));
    if (rows.length < pageSize) break;
  }
  return jobs.length ? jobs : null;
}

module.exports = { syncJobs, fetchAllJobs, supabaseEnv, jobRow };
