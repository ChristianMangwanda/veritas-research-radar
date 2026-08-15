/**
 * Judge the postings on screen. The one piece of this system that needs a
 * server, and the reason the dashboard could never be fully hosted before.
 *
 * Judging costs money at the OpenAI API, so it needs a key, and a key cannot
 * ship in a page served from a public repo. GitHub Pages has no server-side
 * anything, which is why the laptop stayed in the loop. This function is that
 * missing server: the key lives in Vercel's environment, never in the client.
 *
 * The contract is deliberately IDS ONLY. The old localhost endpoint took whole
 * job payloads because the client already had them, and the backlog pass moved
 * something like 80 MB of posting text per page load to say "have you read
 * these yet". Here the client sends `{ids: [...]}`, ~1 KB, and this function
 * fetches the postings itself from the same table the client read them from.
 *
 * What it does NOT do is decide anything about the judgment. The schema, the
 * prompt, the verdict derivation and the cache key all come from
 * radar/scripts/lib/match.js — the same modules the Actions job uses — because
 * two implementations of "how do we judge a posting" would drift, and a drift
 * in the cache key silently orphans every judgment already paid for.
 */

const {
  JUDGMENT_SCHEMA, JUDGE_SYSTEM_PROMPT, judgeUserPrompt, normalizeJudgment
} = require('../radar/scripts/lib/match.js');
const { DEFAULT_MODEL, judgeOnce, costOf } = require('../radar/scripts/lib/openai.js');
const { groupMissesByHash, dedupeCacheRows } = require('../radar/scripts/lib/match-cache.js');
const { rehydrateJob } = require('../radar/scripts/lib/supabase.js');
const { parseProfileDocument } = require('../radar/public/profile-doc.js');
const RadarScoring = require('../radar/public/scoring.js');

const MAX_IDS = 20;
const CONCURRENCY = 4;
/* Vercel kills the function at maxDuration (60s, set in vercel.json). Stop
 * LAUNCHING work at 45s and return what finished: a partial answer the client
 * can ask again for beats a 504 that loses the judgments already bought. */
const LAUNCH_DEADLINE_MS = 45000;

const MODEL = process.env.RADAR_MATCH_MODEL || DEFAULT_MODEL;

/* Both key names are accepted because both are in circulation: CI holds
 * SUPABASE_SERVICE_KEY as a repo secret, and Supabase's dashboard now issues
 * the same thing as a "secret key" (sb_secret_…). Which name a key was pasted
 * under should never be the thing that breaks judging. */
function env() {
  const url = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY || '';
  return url && key ? { url, key } : null;
}

/** Which of the required variables are actually missing — so a 500 says what
 *  to go and set rather than restating the whole list. */
function missingEnv() {
  const missing = [];
  if (!process.env.SUPABASE_URL) missing.push('SUPABASE_URL');
  if (!process.env.SUPABASE_SERVICE_KEY && !process.env.SUPABASE_SECRET_KEY) {
    missing.push('SUPABASE_SERVICE_KEY (or SUPABASE_SECRET_KEY)');
  }
  if (!process.env.OPENAI_API_KEY) missing.push('OPENAI_API_KEY');
  return missing;
}

/** PostgREST with the service role. Small clone of lib/supabase.js's request()
 *  rather than an import, so this function owns its own error surface. */
async function sb({ url, key }, method, pathname, { body, headers = {} } = {}) {
  const response = await fetch(`${url}/rest/v1${pathname}`, {
    method,
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      ...headers
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`supabase ${method} ${pathname} → ${response.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

/**
 * Who is asking. The access token is verified by handing it to GoTrue and
 * seeing whether it answers — no JWT library, no JWKS fetching, no key
 * rotation to get wrong. Costs one request; this repo has no dependencies and
 * this is why it can stay that way.
 */
async function verifyUser({ url, key }, token) {
  if (!token) return null;
  const response = await fetch(`${url}/auth/v1/user`, {
    headers: { apikey: key, authorization: `Bearer ${token}` }
  });
  if (!response.ok) return null;
  const user = await response.json().catch(() => null);
  return user && user.id ? user : null;
}

/**
 * `in.("a","b")` for PostgREST.
 *
 * Quoting is not optional: job ids are colon-composed (`workday:cornell:WDR-1`)
 * and a bare colon ends the value. Getting this wrong does not error — it
 * returns zero rows, which reads as "nothing is cached" and re-judges the whole
 * screen at full price, every time.
 */
function inList(values) {
  return `(${values.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')})`;
}

async function runPool(items, limit, worker) {
  const results = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  }));
  return results;
}

async function handler(request, response) {
  const origin = request.headers.origin || '';
  // The page is served from the same origin as this function; localhost is
  // allowed so `npm start` exercises the production judging path rather than a
  // stub that behaves differently.
  if (/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) {
    response.setHeader('access-control-allow-origin', origin);
    response.setHeader('access-control-allow-headers', 'authorization, content-type');
    response.setHeader('access-control-allow-methods', 'POST, OPTIONS');
    response.setHeader('vary', 'origin');
  }
  if (request.method === 'OPTIONS') { response.status(204).end(); return; }
  if (request.method !== 'POST') { response.status(405).json({ error: 'POST only' }); return; }

  const missing = missingEnv();
  if (missing.length) {
    response.status(500).json({ error: `not configured on this deployment: ${missing.join(', ')}` });
    return;
  }
  const config = env();

  const token = /^Bearer (.+)$/i.exec(request.headers.authorization || '')?.[1];
  const user = await verifyUser(config, token);
  if (!user) { response.status(401).json({ error: 'sign in to judge postings' }); return; }

  const body = typeof request.body === 'string' ? JSON.parse(request.body || '{}') : (request.body || {});
  const ids = Array.isArray(body.ids) ? body.ids.filter((id) => typeof id === 'string' && id) : null;
  if (!ids || !ids.length) { response.status(400).json({ error: 'body must be {ids: [jobId, …]}' }); return; }
  if (ids.length > MAX_IDS) { response.status(400).json({ error: `at most ${MAX_IDS} ids per request` }); return; }

  try {
    /* ---- the profile ------------------------------------------------- */
    const profileRows = await sb(config, 'GET', '/profile_documents?select=content&limit=1');
    const content = profileRows?.[0]?.content;
    if (!content) { response.status(409).json({ error: 'no profile document saved yet' }); return; }
    const profile = parseProfileDocument(content);
    const invalid = RadarScoring.validateProfile(profile);
    if (invalid) { response.status(409).json({ error: `profile does not validate: ${invalid}` }); return; }
    const profileHash = RadarScoring.profileHash(profile);

    /* ---- the postings -------------------------------------------------
     * rehydrateJob is not a convenience here, it is the identity rule: the
     * browser builds jobs the same way (payload spread, description column
     * preferred over the copy inside payload). Build them differently and
     * jobContentHash differs, and every cached judgment for that posting
     * becomes unreachable. */
    const rows = await sb(config, 'GET',
      `/jobs?id=in.${encodeURIComponent(inList(ids))}&select=payload,description_text`);
    const jobs = (rows || []).map(rehydrateJob).filter(Boolean);
    const hashOf = new Map(jobs.map((job) => [job.id, RadarScoring.jobContentHash(job)]));

    /* ---- what we already know ------------------------------------------ */
    const hashes = [...hashOf.values()];
    const judgments = {};
    if (hashes.length) {
      const cached = await sb(config, 'GET',
        `/match_cache?profile_hash=eq.${encodeURIComponent(profileHash)}`
        + `&job_hash=in.${encodeURIComponent(inList(hashes))}`
        + '&select=job_hash,verdict,different_profession,meets_requirements,'
        + 'matches_preferences,role_summary,reasons,gaps,judged_at,model');
      const byHash = new Map((cached || []).map((row) => [row.job_hash, row]));
      for (const job of jobs) {
        const row = byHash.get(hashOf.get(job.id));
        if (row) {
          const { job_hash: _hash, ...record } = row;
          judgments[job.id] = record;
        }
      }
    }

    /* ---- judge the rest ------------------------------------------------
     * One call per distinct posting CONTENT, not per posting. A screenful can
     * easily hold the same "Assistant Professor" text from two aggregators;
     * judging each separately pays twice for one answer and puts two rows with
     * the same (job_hash, profile_hash) into one upsert, which Postgres rejects
     * whole. The cache is hash-keyed, so one judgment serves every duplicate. */
    const started = Date.now();
    const misses = jobs.filter((job) => !judgments[job.id]);
    const { representatives, membersByHash } = groupMissesByHash(
      misses.map((job) => ({ job, hash: hashOf.get(job.id) }))
    );
    const unjudged = [];
    let spend = 0;
    const fresh = [];

    await runPool(representatives, CONCURRENCY, async ({ job, hash }) => {
      const members = membersByHash.get(hash) || [job];
      if (Date.now() - started > LAUNCH_DEADLINE_MS) {
        for (const member of members) unjudged.push(member.id);
        return;
      }
      try {
        const { parsed, usage } = await judgeOnce({
          key: process.env.OPENAI_API_KEY,
          model: MODEL,
          system: JUDGE_SYSTEM_PROMPT,
          user: judgeUserPrompt(job, profile, ''),
          schema: JUDGMENT_SCHEMA
        });
        spend += costOf(MODEL, usage);
        // A refusal or an unparseable body is an ABSENT answer, never a "no" —
        // recording it as a verdict would hide a job with no stated reason.
        const judgment = normalizeJudgment(parsed);
        if (!judgment) {
          for (const member of members) unjudged.push(member.id);
          return;
        }
        const record = { ...judgment, judged_at: new Date().toISOString(), model: MODEL };
        for (const member of members) judgments[member.id] = record;
        fresh.push({ job_hash: hash, profile_hash: profileHash, job_id: job.id, ...record });
      } catch (error) {
        for (const member of members) unjudged.push(member.id);
        console.error(`judge ${job.id}: ${error.message}`);
      }
    });

    if (fresh.length) {
      await sb(config, 'POST', '/match_cache?on_conflict=job_hash,profile_hash', {
        // Grouping above already guarantees this, but the upsert is the place
        // where a duplicate key costs the whole batch — cheap to make certain.
        body: dedupeCacheRows(fresh),
        headers: { prefer: 'resolution=merge-duplicates,return=minimal' }
      });
    }

    response.status(200).json({
      judgments,
      unjudged,
      profile_hash: profileHash,
      model: MODEL,
      spend: Number(spend.toFixed(4))
    });
  } catch (error) {
    console.error(error);
    response.status(502).json({ error: String(error.message).slice(0, 300) });
  }
}

// Vercel calls the default export; the named helpers are exported so the pure
// parts can be tested without a deployment.
module.exports = handler;
module.exports.inList = inList;
module.exports.MAX_IDS = MAX_IDS;
