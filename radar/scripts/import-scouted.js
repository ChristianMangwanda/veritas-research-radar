#!/usr/bin/env node

/**
 * Validates scout-producer snapshots (see radar/SCOUT-CONTRACT.md) and merges
 * them into the scouted-jobs store consumed by the refresh pipeline.
 */

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { normalizeText } = require('./refresh.js');

const ROOT = path.resolve(__dirname, '../..');
const RADAR_DIR = path.join(ROOT, 'radar');
const DATA_DIR = path.join(RADAR_DIR, 'data');
const EMPLOYERS_PATH = path.join(RADAR_DIR, 'employers.json');
const SCOUTED_DIR = path.join(DATA_DIR, 'scouted');
const STORE_PATH = path.join(DATA_DIR, 'scouted-jobs.json');

const TRACKING_PARAM = /^(utm_|gclid$|fbclid$|mc_cid$|mc_eid$)/i;

function canonicalUrl(rawUrl) {
  const url = new URL(rawUrl);
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAM.test(key)) url.searchParams.delete(key);
  }
  let pathname = url.pathname;
  if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);
  const search = url.searchParams.toString();
  return `${url.protocol}//${url.host.toLowerCase()}${pathname}${search ? `?${search}` : ''}`;
}

function scoutedJobId(employerId, rawUrl) {
  const hash = crypto.createHash('sha256').update(canonicalUrl(rawUrl)).digest('hex').slice(0, 12);
  return `scout:${employerId}:${hash}`;
}

function isAbsoluteHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function validateScoutedFile(payload, employersById) {
  if (!payload || typeof payload !== 'object') {
    return { accepted: [], rejected: [], fileError: 'payload is not an object' };
  }
  if (payload.schema_version !== 1) {
    return { accepted: [], rejected: [], fileError: `unsupported schema_version ${payload.schema_version}` };
  }
  const employer = employersById.get(payload.employer_id);
  if (!employer) {
    return { accepted: [], rejected: [], fileError: `unknown employer_id ${payload.employer_id}` };
  }
  if (!payload.scouted_at || Number.isNaN(Date.parse(payload.scouted_at))) {
    return { accepted: [], rejected: [], fileError: 'scouted_at missing or unparseable' };
  }
  if (!Array.isArray(payload.jobs)) {
    return { accepted: [], rejected: [], fileError: 'jobs is not an array' };
  }

  const accepted = [];
  const rejected = [];
  const seenIds = new Set();
  payload.jobs.forEach((job, index) => {
    if (!job || typeof job !== 'object') {
      rejected.push({ index, reason: 'job is not an object' });
      return;
    }
    if (typeof job.title !== 'string' || !job.title.trim()) {
      rejected.push({ index, reason: 'missing title' });
      return;
    }
    if (typeof job.url !== 'string' || !isAbsoluteHttpUrl(job.url)) {
      rejected.push({ index, reason: 'url missing or not absolute http(s)' });
      return;
    }
    for (const key of ['location', 'department', 'description_text', 'posted_at']) {
      if (job[key] !== undefined && job[key] !== null && typeof job[key] !== 'string') {
        rejected.push({ index, reason: `${key} must be a string when present` });
        return;
      }
    }
    const id = scoutedJobId(payload.employer_id, job.url);
    if (seenIds.has(id)) {
      rejected.push({ index, reason: 'duplicate url in snapshot' });
      return;
    }
    seenIds.add(id);
    accepted.push({ ...job, id });
  });

  return { accepted, rejected, fileError: null, employer };
}

function normalizeScoutedJob(job, payload) {
  return {
    id: job.id,
    employer_id: payload.employer_id,
    title: job.title.trim(),
    department: (job.department || '').trim(),
    location: (job.location || '').trim() || 'Unspecified',
    url: job.url,
    description_text: normalizeText(job.description_text || ''),
    posted_or_updated_at: job.posted_at || null,
    source: 'agent_scout',
    source_job_id: job.id.split(':')[2],
    last_scouted_at: payload.scouted_at
  };
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function importScouted(filePaths) {
  const employers = await readJson(EMPLOYERS_PATH, []);
  const employersById = new Map(employers.map((employer) => [employer.id, employer]));
  const store = await readJson(STORE_PATH, { schema_version: 1, updated_at: null, snapshots: {}, jobs: [] });
  store.snapshots = store.snapshots || {};

  let files = filePaths;
  if (!files || files.length === 0) {
    try {
      const names = await fs.readdir(SCOUTED_DIR);
      files = names.filter((name) => name.endsWith('.json')).map((name) => path.join(SCOUTED_DIR, name));
    } catch (error) {
      if (error.code === 'ENOENT') files = [];
      else throw error;
    }
  }
  if (files.length === 0) {
    console.log('No scouted snapshot files found in radar/data/scouted/');
    return { imported: 0 };
  }

  let totalAccepted = 0;
  let totalRejected = 0;
  for (const filePath of files) {
    let payload;
    try {
      payload = JSON.parse(await fs.readFile(filePath, 'utf8'));
    } catch (error) {
      console.error(`${path.basename(filePath)}: unreadable JSON (${error.message})`);
      continue;
    }
    const { accepted, rejected, fileError, employer } = validateScoutedFile(payload, employersById);
    if (fileError) {
      console.error(`${path.basename(filePath)}: rejected — ${fileError}`);
      continue;
    }
    if (employer.ats_provider) {
      console.warn(`${path.basename(filePath)}: note — ${employer.id} now has a live ATS provider (${employer.ats_provider}); scouted data will be ignored by refresh while that feed works`);
    }
    for (const reject of rejected) {
      console.warn(`${path.basename(filePath)}: job[${reject.index}] rejected — ${reject.reason}`);
    }
    // Snapshot-replace: this file is the full truth for its employer.
    // The snapshot record lets refresh distinguish "scouted, zero jobs"
    // (close previous) from "could not scout" (carry previous forward).
    store.jobs = store.jobs.filter((job) => job.employer_id !== payload.employer_id);
    store.jobs.push(...accepted.map((job) => normalizeScoutedJob(job, payload)));
    store.snapshots[payload.employer_id] = {
      scouted_at: payload.scouted_at,
      job_count: accepted.length,
      skipped_reason: payload.skipped_reason || null
    };
    totalAccepted += accepted.length;
    totalRejected += rejected.length;
    console.log(`${path.basename(filePath)}: ${accepted.length} accepted, ${rejected.length} rejected${payload.skipped_reason ? ` (skipped_reason: ${payload.skipped_reason})` : ''}`);
  }

  store.updated_at = new Date().toISOString();
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STORE_PATH, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
  console.log(`Scouted store: ${store.jobs.length} jobs total (${totalAccepted} accepted, ${totalRejected} rejected this run)`);
  return { imported: totalAccepted, rejected: totalRejected };
}

if (require.main === module) {
  importScouted(process.argv.slice(2).map((p) => path.resolve(p))).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { validateScoutedFile, scoutedJobId, canonicalUrl, normalizeScoutedJob, importScouted };
