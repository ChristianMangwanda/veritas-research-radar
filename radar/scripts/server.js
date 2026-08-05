#!/usr/bin/env node

const fs = require('fs/promises');
const fsSync = require('fs');
const http = require('http');
const path = require('path');
const { URL } = require('url');
const { syncManifest, isResumeFile, RESUME_EXTENSIONS } = require('./lib/manifest-sync.js');
const {
  JUDGMENT_SCHEMA, JUDGE_SYSTEM_PROMPT, judgeUserPrompt, matchCacheKey, normalizeJudgment
} = require('./lib/match.js');
const { parseProfileDocument } = require('./lib/profile-doc.js');
const { createFlushScheduler } = require('./lib/flush-scheduler.js');
const { DEFAULT_MODEL, readKey, judgeOnce, costOf } = require('./lib/openai.js');
const RadarScoring = require('../public/scoring.js');

const ROOT = path.resolve(__dirname, '../..');
const RADAR_DIR = path.join(ROOT, 'radar');
const DATA_DIR = path.join(RADAR_DIR, 'data');
const PUBLIC_DIR = path.join(RADAR_DIR, 'public');
const LOCAL_STATE_PATH = path.join(DATA_DIR, 'local-state.json');
const RESUMES_DIR = path.join(DATA_DIR, 'resumes');
const MANIFEST_PATH = path.join(RESUMES_DIR, 'manifest.json');
/* The profile is an authored document now, not a model's reading of seven
 * résumé files. radar/PROFILE-PROMPT.md is how it gets written. Nothing
 * rewrites it: résumés are for sending to employers, not for deriving a person
 * from. That is what stopped every cached judgment dying whenever a bullet
 * point was reworded. */
const PROFILE_DOC_PATH = path.join(DATA_DIR, 'profile.md');
const ENV_PATH = path.join(ROOT, '.env');
const MATCH_CACHE_PATH = path.join(DATA_DIR, 'match-cache.json');

const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '127.0.0.1';

const MATCH_MODEL = DEFAULT_MODEL;
/* The API judges in parallel, which the local model could not: Ollama runs
 * llama-server with -np 1 and serialised everything. Six at a time keeps well
 * inside the rate limits while reading the whole pool in minutes. */
const MATCH_CONCURRENCY = Number(process.env.RADAR_MATCH_CONCURRENCY || 6);

// The hosted dashboard may pull the compiled profile from this local server
// (never the other way around — resumes and profile stay on this machine).
const BRIDGE_ORIGINS = new Set([
  'https://christianmangwanda.github.io'
]);
if (process.env.RADAR_BRIDGE_ORIGIN) BRIDGE_ORIGINS.add(process.env.RADAR_BRIDGE_ORIGIN);
const BRIDGE_PATHS = new Set(['/api/profile', '/api/route-cache', '/api/profile-freshness']);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png'
};

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

async function readBodyBuffer(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_UPLOAD_BYTES) throw new Error('file too large (15 MB max)');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// Uploads name their file in a header rather than multipart — one filename,
// no parser dependency. Everything about the name is rebuilt from scratch
// here: basename only, allowed extension only, no separators, no dotfiles.
function safeResumeName(raw) {
  const decoded = (() => {
    try { return decodeURIComponent(String(raw || '')); } catch { return String(raw || ''); }
  })();
  const base = path.basename(decoded).replace(/[/\\]/g, '');
  const extension = path.extname(base).toLowerCase();
  if (!RESUME_EXTENSIONS.includes(extension)) return null;
  const stem = base.slice(0, base.length - extension.length)
    .replace(/[^A-Za-z0-9 ._-]/g, '')
    .replace(/^[.\s]+/, '')
    .trim()
    .slice(0, 80);
  if (!stem) return null;
  return `${stem}${extension}`;
}

function send(response, status, body, contentType = 'application/json; charset=utf-8', extraHeaders = null) {
  response.writeHead(status, {
    'content-type': contentType,
    'cache-control': 'no-store',
    ...(extraHeaders || {})
  });
  response.end(body);
}

async function serveStatic(response, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  const filePath = path.resolve(PUBLIC_DIR, relative);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    send(response, 403, 'Forbidden', 'text/plain; charset=utf-8');
    return;
  }
  try {
    const body = await fs.readFile(filePath);
    send(response, 200, body, MIME[path.extname(filePath)] || 'application/octet-stream');
  } catch (error) {
    if (error.code === 'ENOENT') {
      send(response, 404, 'Not found', 'text/plain; charset=utf-8');
      return;
    }
    throw error;
  }
}

function defaultLocalState() {
  return {
    version: 1,
    updated_at: null,
    ignored_employers: [],
    triage: {}
  };
}

/* ------------------------------------------------------------------------ */
/* Profile auto-rebuild: edit a resume, the dashboard adapts.                */
/* Serialized (one build at a time, trailing changes queue one more run) and */
/* always --if-stale, so spurious triggers are cheap no-ops. An unchanged    */
/* resume set hits the extraction cache — no model call needed.              */

/* The profile is read, never built. What used to live here — a debounced
 * fs.watch on the résumés directory that re-ran a local model and rewrote
 * profile.json — was the reason a reworded bullet point cost five hours of
 * re-judging. Résumés are now just files you send. */

let profileCache = { mtimeMs: 0, profile: null, error: null };

/** Reads radar/data/profile.md, parsed, cached on mtime so every judgment
 *  request does not re-parse it. Returns null when there is no document yet —
 *  the dashboard then shows its first-run prompt rather than a false zero. */
function loadProfile() {
  let stat;
  try { stat = fsSync.statSync(PROFILE_DOC_PATH); }
  catch { profileCache = { mtimeMs: 0, profile: null, error: 'no radar/data/profile.md yet' }; return null; }
  if (profileCache.profile && stat.mtimeMs === profileCache.mtimeMs) return profileCache.profile;
  try {
    const profile = parseProfileDocument(fsSync.readFileSync(PROFILE_DOC_PATH, 'utf8'));
    const problem = RadarScoring.validateProfile(profile);
    if (problem) throw new Error(problem);
    profileCache = { mtimeMs: stat.mtimeMs, profile, error: null };
    const dropped = profile.dropped_terms || [];
    console.log(`[profile] loaded profile.md — ${profile.variants[0].skills.length} capabilities`
      + (dropped.length ? `, ignored ${JSON.stringify(dropped)} (too short to match)` : ''));
    return profile;
  } catch (error) {
    profileCache = { mtimeMs: stat.mtimeMs, profile: null, error: error.message };
    console.error(`[profile] ${PROFILE_DOC_PATH} could not be read: ${error.message}`);
    return null;
  }
}

// What the Resumes panel renders: manifest entries joined with what's really
// on disk, plus the current build state so the panel can narrate itself.
async function listResumes() {
  let files = [];
  try {
    files = (await fs.readdir(RESUMES_DIR)).filter(isResumeFile);
  } catch { /* no dir yet */ }
  const manifest = await readJson(MANIFEST_PATH, { schema_version: 1, variants: [] });
  const { manifest: synced, missing } = syncManifest(manifest, files);
  const missingFiles = new Set(missing.map((variant) => variant.file));
  return {
    variants: (synced.variants || []).map((variant) => ({
      id: variant.id,
      label: variant.label,
      file: variant.file,
      intent: variant.intent,
      intent_source: variant.intent_source || 'user',
      missing: missingFiles.has(variant.file)
    }))
  };
}

/* ------------------------------------------------------------------------ */
/* Judged matching: the model reads a posting against resumes + preferences. */

const matchCache = { entries: {}, dirty: false, loaded: false };

async function loadMatchCache() {
  if (matchCache.loaded) return;
  const stored = await readJson(MATCH_CACHE_PATH, null);
  matchCache.entries = (stored && typeof stored.entries === 'object') ? stored.entries : {};
  matchCache.loaded = true;
}

// Debounced, with a ceiling so a fast producer cannot starve the writer —
// see lib/flush-scheduler.js for what went wrong without one.
const matchFlusher = createFlushScheduler({
  flush: () => writeJson(MATCH_CACHE_PATH, { schema_version: 1, entries: matchCache.entries })
});

function scheduleMatchCacheFlush() {
  matchFlusher.schedule();
}

// Last line of defence: judgments cost money, so never let a Ctrl-C or a
// launchd stop throw away work that has already been paid for.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    matchFlusher.flushNow()
      .catch((error) => console.error(`[match] could not persist cache on exit: ${error.message}`))
      .finally(() => process.exit(0));
  });
}

/* A background queue, not a blocking call.
 *
 * Even at a second or two per judgment, a page load asks about hundreds of
 * postings and must not wait for them. So: answer instantly with whatever is
 * cached, queue the rest, and let the list fill in as results land. What is on
 * screen jumps the queue; the rest of the backlog drains behind it, and keeps
 * draining after the browser is closed. */

const judgeQueue = {
  items: [],          // {job, key, priority} — lower priority number first
  seen: new Set(),    // cache keys already queued or done
  running: false,
  judgedThisRun: 0,
  lastError: null,
  // What this run has cost, reported rather than left to a billing surprise.
  spend: 0,
  tokens: { input: 0, output: 0 },
  /* Everything judged this run, in order, so the page can collect results
   * without re-posting the postings it wants collected. Polling used to mean
   * shipping back a megabyte of job descriptions every few seconds just to
   * ask "done yet?", which capped how much the page bothered to ask about. */
  log: [],
  seq: 0
};
const JUDGE_LOG_LIMIT = 4000;

function recordJudgment(jobId, record) {
  judgeQueue.seq += 1;
  judgeQueue.log.push({ seq: judgeQueue.seq, id: jobId, record });
  if (judgeQueue.log.length > JUDGE_LOG_LIMIT) judgeQueue.log.splice(0, judgeQueue.log.length - JUDGE_LOG_LIMIT);
}

// Judgments finished after `since`. The client passes back the cursor it last
// saw, so a poll costs one small JSON body either way.
function judgmentsSince(since) {
  const out = {};
  for (const entry of judgeQueue.log) {
    if (entry.seq > since) out[entry.id] = entry.record;
  }
  return out;
}

function queueJudgments(jobs, context, priority) {
  let added = 0;
  for (const job of jobs) {
    const key = matchCacheKey(RadarScoring.jobContentHash(job), context.profileHash, context.prefsHash);
    if (matchCache.entries[key] || judgeQueue.seen.has(key)) continue;
    judgeQueue.seen.add(key);
    judgeQueue.items.push({ job, key, priority });
    added += 1;
  }
  if (added) judgeQueue.items.sort((a, b) => a.priority - b.priority);
  return added;
}

async function judgeOne(job, key, context) {
  const { parsed, usage } = await judgeOnce({
    key: context.apiKey,
    model: MATCH_MODEL,
    system: JUDGE_SYSTEM_PROMPT,
    user: judgeUserPrompt(job, context.profile, ''),
    schema: JUDGMENT_SCHEMA
  });
  judgeQueue.spend += costOf(MATCH_MODEL, usage);
  judgeQueue.tokens.input += usage.input;
  judgeQueue.tokens.output += usage.output;
  // A refusal or an unparseable body is NOT a "no" — it is an absent answer,
  // and treating it as a verdict would hide the job for no stated reason.
  const judgment = normalizeJudgment(parsed);
  if (!judgment) return null;
  const record = { ...judgment, judged_at: new Date().toISOString(), model: MATCH_MODEL };
  matchCache.entries[key] = record;
  recordJudgment(job.id, record);
  scheduleMatchCacheFlush();
  return record;
}

async function drainJudgeQueue(context) {
  if (judgeQueue.running) return;
  judgeQueue.running = true;
  const worker = async () => {
    while (judgeQueue.items.length) {
      // Re-read the head each pass: a fresh high-priority batch (what the
      // user just scrolled to) overtakes the background backlog.
      const next = judgeQueue.items.shift();
      try {
        await judgeOne(next.job, next.key, context);
        judgeQueue.judgedThisRun += 1;
        judgeQueue.lastError = null;
        if (judgeQueue.judgedThisRun % 50 === 0) {
          console.log(`[match] ${judgeQueue.judgedThisRun} judged, ${judgeQueue.items.length} to go`
            + `, $${judgeQueue.spend.toFixed(3)} spent`);
        }
      } catch (error) {
        judgeQueue.lastError = error.message;
        console.error(`[match] ${next.job.id}: ${error.message}`);
        // A bad key or a revoked account would spin the whole backlog into
        // the same error at full tilt. Stop; the next request restarts us.
        if (/401|403|invalid_api_key|fetch failed/i.test(error.message)) {
          judgeQueue.items.length = 0;
          break;
        }
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: MATCH_CONCURRENCY }, worker));
  } finally {
    judgeQueue.running = false;
    if (judgeQueue.judgedThisRun) {
      console.log(`[match] idle — ${judgeQueue.judgedThisRun} judged this run, $${judgeQueue.spend.toFixed(3)}`);
    }
  }
}

/* Everything a judgment depends on. The cache key is built from these, so
 * what is NOT here matters as much as what is: résumé files are absent, which
 * is why editing one no longer invalidates anything. `prefsHash` survives as a
 * key component because "what I want" moved inside the profile document — one
 * hash now covers both, and old entries fall out on their own. */
async function matchContext() {
  const profile = loadProfile();
  if (!profile) return null;
  const apiKey = readKey(ENV_PATH);
  if (!apiKey) return null;
  return {
    profile,
    apiKey,
    profileHash: RadarScoring.profileHash(profile),
    prefsHash: 'in-profile'
  };
}

function cachedJudgments(jobs, context) {
  const out = {};
  for (const job of jobs) {
    const key = matchCacheKey(RadarScoring.jobContentHash(job), context.profileHash, context.prefsHash);
    const hit = matchCache.entries[key];
    if (hit) out[job.id] = hit;
  }
  return out;
}

/* ------------------------------------------------------------------------ */

// CORS for the hosted-dashboard bridge. Chrome's Private Network Access sends
// a preflight for public->localhost requests; answer it or the bridge fails.
function bridgeHeaders(request) {
  const origin = request.headers.origin;
  if (!origin || !BRIDGE_ORIGINS.has(origin)) return null;
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET',
    'access-control-allow-private-network': 'true',
    'vary': 'origin'
  };
}

async function route(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const cors = BRIDGE_PATHS.has(url.pathname) ? bridgeHeaders(request) : null;

  if (request.method === 'OPTIONS' && BRIDGE_PATHS.has(url.pathname)) {
    response.writeHead(cors ? 204 : 403, cors || {});
    response.end();
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/profile-freshness') {
    const profile = loadProfile();
    send(response, 200, JSON.stringify({
      // Nothing goes stale any more: the document is the source of truth and
      // is never regenerated. This reports whether it loaded, and what got
      // dropped, so a broken edit is visible instead of silently empty.
      stale: false,
      reason: profile ? 'authored' : (profileCache.error || 'missing'),
      loaded: Boolean(profile),
      error: profileCache.error,
      capabilities: profile ? profile.variants[0].skills.length : 0,
      dropped_terms: profile ? (profile.dropped_terms || []) : []
    }), undefined, cors);
    return;
  }

  /* There were /api/preferences endpoints here. What the user wants is a
     section of profile.md now — one document, edited in one place, with no
     model in between turning prose into fields that then disagree with it. */

  // Returns what's judged NOW and queues the rest. The client posts the job
  // payloads it wants read, so the server never loads the 44 MB job mirror.
  // `priority` 0 = on screen, 1 = prefetch, 2 = background backlog.
  if (request.method === 'POST' && url.pathname === '/api/match') {
    await loadMatchCache();
    const payload = JSON.parse(await readBody(request) || '{}');
    const jobs = Array.isArray(payload.jobs) ? payload.jobs.slice(0, 200) : [];
    const since = Number.isFinite(payload.since) ? payload.since : 0;
    const context = await matchContext();
    if (!context) {
      send(response, 200, JSON.stringify({
        judgments: {}, queued: 0, pending: 0, running: false, cursor: 0,
        reason: 'no resume profile yet'
      }));
      return;
    }
    const priority = Number.isFinite(payload.priority) ? payload.priority : 0;
    // A body with no jobs is a collect-only poll — still answer it with
    // whatever finished since the client's cursor.
    const judgments = jobs.length ? cachedJudgments(jobs, context) : {};
    const queued = jobs.length
      ? queueJudgments(jobs.filter((job) => !judgments[job.id]), context, priority)
      : 0;
    drainJudgeQueue(context); // deliberately not awaited
    send(response, 200, JSON.stringify({
      judgments: { ...judgmentsSince(since), ...judgments },
      cursor: judgeQueue.seq,
      queued,
      pending: judgeQueue.items.length,
      running: judgeQueue.running,
      judged_total: Object.keys(matchCache.entries).length,
      last_error: judgeQueue.lastError,
      model: MATCH_MODEL,
      spend: Number(judgeQueue.spend.toFixed(4)),
      judged_this_run: judgeQueue.judgedThisRun
    }));
    return;
  }

  /* Resume variants: the dashboard owns these now — upload, rename, retitle,
     remove. manifest.json is written here so the user never opens it. Writes
     are localhost-only (never in BRIDGE_PATHS). */

  if (request.method === 'GET' && url.pathname === '/api/resumes') {
    send(response, 200, JSON.stringify(await listResumes()));
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/resumes') {
    const name = safeResumeName(request.headers['x-resume-filename']);
    if (!name) {
      send(response, 400, JSON.stringify({ error: `Give the file a name ending in ${RESUME_EXTENSIONS.join(', ')}.` }));
      return;
    }
    let body;
    try {
      body = await readBodyBuffer(request);
    } catch (error) {
      send(response, 413, JSON.stringify({ error: error.message }));
      return;
    }
    if (!body.length) {
      send(response, 400, JSON.stringify({ error: 'empty file' }));
      return;
    }
    await fs.mkdir(RESUMES_DIR, { recursive: true });
    await fs.writeFile(path.join(RESUMES_DIR, name), body);
    send(response, 200, JSON.stringify({ ok: true, file: name, ...(await listResumes()) }));
    return;
  }

  // Edit labels/intents, or drop a variant. Body: {variants:[{id,label,intent}],
  // remove:[id], delete_files:bool}
  if (request.method === 'POST' && url.pathname === '/api/resume-variants') {
    const payload = JSON.parse(await readBody(request) || '{}');
    const manifest = await readJson(MANIFEST_PATH, { schema_version: 1, variants: [] });
    const byId = new Map((manifest.variants || []).map((variant) => [variant.id, variant]));

    for (const edit of Array.isArray(payload.variants) ? payload.variants : []) {
      const variant = byId.get(edit.id);
      if (!variant) continue;
      if (typeof edit.label === 'string' && edit.label.trim()) variant.label = edit.label.trim().slice(0, 60);
      if (typeof edit.intent === 'string' && edit.intent.trim()) {
        variant.intent = edit.intent.trim().slice(0, 600);
        variant.intent_source = 'user'; // a hand-written intent is never overwritten
      }
    }

    const removing = new Set(Array.isArray(payload.remove) ? payload.remove : []);
    const removed = (manifest.variants || []).filter((variant) => removing.has(variant.id));
    manifest.variants = (manifest.variants || []).filter((variant) => !removing.has(variant.id));

    // Removing a variant deletes its FILE too — otherwise the next rebuild
    // re-registers it and the removal looks broken.
    for (const variant of removed) {
      const target = path.join(RESUMES_DIR, path.basename(variant.file));
      if (target.startsWith(RESUMES_DIR)) await fs.rm(target, { force: true });
    }

    await writeJson(MANIFEST_PATH, manifest);
    send(response, 200, JSON.stringify({ ok: true, ...(await listResumes()) }));
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/jobs') {
    send(response, 200, JSON.stringify(await readJson(path.join(DATA_DIR, 'jobs.json'), [])));
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/employers') {
    send(response, 200, JSON.stringify(await readJson(path.join(RADAR_DIR, 'employers.json'), [])));
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/refresh-report') {
    send(response, 200, JSON.stringify(await readJson(path.join(DATA_DIR, 'refresh-report.json'), null)));
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/discovery') {
    send(response, 200, JSON.stringify(await readJson(path.join(DATA_DIR, 'discovery-candidates.json'), { candidates: [] })));
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/local-state') {
    send(response, 200, JSON.stringify(await readJson(LOCAL_STATE_PATH, defaultLocalState())));
    return;
  }

  // Both files are script-owned (radar:profile / radar:route) and gitignored;
  // read-only here so the dashboard picks them up without any import step.
  // CORS-opened to the hosted dashboard so IT can pick them up too.
  if (request.method === 'GET' && url.pathname === '/api/profile') {
    send(response, 200, JSON.stringify(loadProfile()), undefined, cors);
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/route-cache') {
    send(response, 200, JSON.stringify(await readJson(path.join(DATA_DIR, 'route-cache.json'), null)), undefined, cors);
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/local-state') {
    const payload = JSON.parse(await readBody(request) || '{}');
    const state = {
      version: 1,
      updated_at: new Date().toISOString(),
      triage: payload.triage && typeof payload.triage === 'object' ? payload.triage : {},
      ignored_employers: Array.isArray(payload.ignored_employers)
        ? payload.ignored_employers.filter((id) => typeof id === 'string')
        : []
    };
    await writeJson(LOCAL_STATE_PATH, state);
    send(response, 200, JSON.stringify(state));
    return;
  }

  if (request.method === 'GET') {
    await serveStatic(response, url.pathname);
    return;
  }

  send(response, 405, 'Method not allowed', 'text/plain; charset=utf-8');
}

const server = http.createServer((request, response) => {
  route(request, response).catch((error) => {
    console.error(error);
    send(response, 500, JSON.stringify({ error: error.message }));
  });
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.log(`A dashboard is already running — open http://${HOST}:${PORT}`);
    console.log('(To restart it instead: pkill -f radar/scripts/server.js, then npm start.)');
    process.exit(0);
  }
  throw error;
});

server.listen(PORT, HOST, () => {
  console.log(`Veritas Research Radar running at http://${HOST}:${PORT}`);
  loadProfile();
});
