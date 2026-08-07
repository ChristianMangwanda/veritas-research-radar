#!/usr/bin/env node

/**
 * The development server. Serves the dashboard and the local jobs mirror, and
 * nothing else.
 *
 * It used to be the application: it held the profile, ran the judge queue,
 * owned the match cache and stored triage on disk, and the hosted page reached
 * back to it over a CORS bridge to borrow the profile whenever this machine
 * happened to be awake. All of that lives in Supabase and a Vercel function
 * now, which is why this file is a tenth of its former size.
 *
 * What it deliberately does NOT do is stub any of those out. Signing in,
 * reading judgments, saving the profile and writing triage all go straight to
 * the same production endpoints from localhost — so working on the page here
 * exercises what actually runs, rather than a convenience shim that behaves
 * differently in the one place it matters.
 */

const fs = require('fs/promises');
const http = require('http');
const path = require('path');
const { URL } = require('url');

const ROOT = path.resolve(__dirname, '../..');
const RADAR_DIR = path.join(ROOT, 'radar');
const DATA_DIR = path.join(RADAR_DIR, 'data');
const PUBLIC_DIR = path.join(RADAR_DIR, 'public');

const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2'
};

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

function send(response, status, body, contentType = 'application/json; charset=utf-8') {
  response.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store' });
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

async function route(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);

  /* The local jobs mirror. The page tries this first and falls back to reading
   * Supabase directly, so a stale or missing file costs nothing but a slower
   * first load. Rebuild it with lib/supabase.js's fetchAllJobs when working
   * offline; CI writes to Supabase, never to this file. */
  if (request.method === 'GET' && url.pathname === '/api/jobs') {
    send(response, 200, JSON.stringify(await readJson(path.join(DATA_DIR, 'jobs.json'), [])));
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
  console.log('Sign in on the page — profile, judgments and triage live in Supabase.');
});
