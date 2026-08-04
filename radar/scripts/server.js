#!/usr/bin/env node

const fs = require('fs/promises');
const fsSync = require('fs');
const http = require('http');
const path = require('path');
const { URL } = require('url');
const { spawn } = require('child_process');
const { profileFreshness } = require('./lib/profile-freshness.js');
const { syncManifest, isResumeFile, RESUME_EXTENSIONS } = require('./lib/manifest-sync.js');

const ROOT = path.resolve(__dirname, '../..');
const RADAR_DIR = path.join(ROOT, 'radar');
const DATA_DIR = path.join(RADAR_DIR, 'data');
const PUBLIC_DIR = path.join(RADAR_DIR, 'public');
const LOCAL_STATE_PATH = path.join(DATA_DIR, 'local-state.json');
const RESUMES_DIR = path.join(DATA_DIR, 'resumes');
const MANIFEST_PATH = path.join(RESUMES_DIR, 'manifest.json');
const PROFILE_PATH = path.join(DATA_DIR, 'profile.json');
const BUILD_PROFILE = path.join(__dirname, 'build-profile.js');

const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '127.0.0.1';

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

const rebuild = { running: false, queued: false, last: null };

function runProfileRebuild(trigger) {
  if (rebuild.running) {
    rebuild.queued = true;
    return;
  }
  rebuild.running = true;
  const startedAt = new Date().toISOString();
  console.log(`[profile] rebuild check (${trigger})…`);
  const child = spawn(process.execPath, [BUILD_PROFILE, '--if-stale'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  child.on('close', (code) => {
    rebuild.running = false;
    const tail = output.trim().split('\n').slice(-3).join(' · ');
    rebuild.last = { at: startedAt, code, message: tail };
    if (code === 0) console.log(`[profile] ${tail || 'ok'}`);
    else console.error(`[profile] rebuild failed (exit ${code}): ${tail}`);
    if (rebuild.queued) {
      rebuild.queued = false;
      runProfileRebuild('queued change');
    }
  });
}

function watchResumes() {
  if (!fsSync.existsSync(RESUMES_DIR)) return;
  let timer = null;
  try {
    fsSync.watch(RESUMES_DIR, (event, filename) => {
      if (filename && filename.startsWith('.')) return; // .extract-cache.json, .DS_Store
      clearTimeout(timer);
      // Debounced: editors and Finder fire bursts of events per save.
      timer = setTimeout(() => runProfileRebuild(`resumes changed: ${filename || 'unknown'}`), 2000);
    });
    console.log('[profile] watching radar/data/resumes — edits rebuild the profile automatically');
  } catch (error) {
    console.error(`[profile] could not watch resumes dir: ${error.message}`);
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
  const profile = await readJson(PROFILE_PATH, null);
  const skillCounts = new Map(
    (profile?.variants || []).map((variant) => [variant.id, (variant.skills || []).length])
  );
  return {
    variants: (synced.variants || []).map((variant) => ({
      id: variant.id,
      label: variant.label,
      file: variant.file,
      intent: variant.intent,
      intent_source: variant.intent_source || 'user',
      missing: missingFiles.has(variant.file),
      pending: !skillCounts.has(variant.id),
      skill_terms: skillCounts.get(variant.id) ?? null
    })),
    building: rebuild.running,
    last_result: rebuild.last
  };
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
    const freshness = profileFreshness(RESUMES_DIR, PROFILE_PATH);
    send(response, 200, JSON.stringify({
      ...freshness,
      building: rebuild.running,
      last_result: rebuild.last
    }), undefined, cors);
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
    // build-profile registers it (and writes an intent) on the rebuild.
    runProfileRebuild(`upload: ${name}`);
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
    runProfileRebuild('variants edited');
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
    send(response, 200, JSON.stringify(await readJson(PROFILE_PATH, null)), undefined, cors);
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
  runProfileRebuild('boot');
  watchResumes();
});
