#!/usr/bin/env node

/**
 * Imports aggregator firehose snapshots (radar/data/aggregated/<source>.json)
 * and applies the cap-exempt filter: a job survives only if its employer
 * resolves into the cap-exempt directory (IPEDS + IRS research universe built
 * by radar:enrich) or the curated registry.
 *
 * Kept jobs land in radar/data/aggregated-jobs.json with employer evidence
 * and a cap_exempt_score attached; refresh.js merges them into the dataset.
 */

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { normalizeText } = require('./refresh.js');
const { computeCapExemptScore } = require('./enrich.js');
const { normalizeName, significantTokens, createResolver } = require('./lib/entity-resolution.js');

const ROOT = path.resolve(__dirname, '../..');
const RADAR_DIR = path.join(ROOT, 'radar');
const DATA_DIR = path.join(RADAR_DIR, 'data');
const EMPLOYERS_PATH = path.join(RADAR_DIR, 'employers.json');
const DIRECTORY_PATH = path.join(DATA_DIR, 'cap-exempt-directory.json');
const AGGREGATED_DIR = path.join(DATA_DIR, 'aggregated');
const STORE_PATH = path.join(DATA_DIR, 'aggregated-jobs.json');

function aggregatedJobId(source, url) {
  const hash = crypto.createHash('sha256').update(String(url)).digest('hex').slice(0, 12);
  return `agg:${source}:${hash}`;
}

function pseudoEmployerId(employerName) {
  const slug = normalizeName(employerName).toLowerCase().replace(/\s+/g, '-').slice(0, 60);
  return `agg:${slug}`;
}

function directoryLookup(directory, tokenKeyIndex, employerName) {
  const normalized = normalizeName(employerName);
  if (!normalized) return null;
  const direct = directory[normalized];
  if (direct) return direct;
  const tokenKey = significantTokens(employerName).sort().join(' ');
  const viaToken = tokenKeyIndex.get(tokenKey);
  return viaToken ? directory[viaToken] : null;
}

function resolveAggregatedJob(job, { directory, tokenKeyIndex, registryResolver, liveProviderIds }) {
  const registry = registryResolver.resolve(job.employer_name);
  if (registry.matched && registry.confidence >= 0.75 && liveProviderIds.has(registry.matched.id)) {
    return { keep: false, reason: 'covered_by_live_ats' };
  }
  const entry = directoryLookup(directory, tokenKeyIndex, job.employer_name);
  if (!entry && !(registry.matched && registry.confidence >= 0.75)) {
    return { keep: false, reason: 'not_cap_exempt' };
  }
  const kind = entry ? entry.kind : 'registry';
  const evidence = entry ? {
    ipeds: entry.unitid ? { unitid: entry.unitid, match: { strategy: 'directory', confidence: 1 } } : null,
    irs: entry.ein ? { ein: entry.ein, ntee_cd: entry.ntee_cd, subsection: '03', match: { strategy: 'directory', confidence: 1 } } : null,
    dol_certified_3y: entry.dol_certified_3y || 0,
    uscis_approvals_3y: entry.uscis_approvals_3y || 0
  } : { dol_certified_3y: 0, uscis_approvals_3y: 0 };
  const { score } = computeCapExemptScore(evidence);
  return { keep: true, kind, entry, score, registryMatch: registry.matched && registry.confidence >= 0.75 ? registry.matched.id : null };
}

function normalizeAggregatedJob(job, payload, resolution) {
  return {
    id: aggregatedJobId(payload.source, job.url),
    employer_id: pseudoEmployerId(job.employer_name),
    employer_name: job.employer_name.trim(),
    employer_kind: resolution.kind,
    registry_employer_id: resolution.registryMatch,
    directory_evidence: resolution.entry ? {
      unitid: resolution.entry.unitid,
      ein: resolution.entry.ein,
      ntee_cd: resolution.entry.ntee_cd,
      uscis_approvals_3y: resolution.entry.uscis_approvals_3y,
      dol_certified_3y: resolution.entry.dol_certified_3y
    } : null,
    cap_exempt_score: resolution.score,
    title: job.title.trim(),
    department: '',
    location: (job.location || '').trim() || 'Unspecified',
    url: job.url,
    description_text: normalizeText(job.description_text || ''),
    posted_or_updated_at: job.posted_at || null,
    source: payload.source,
    source_job_id: aggregatedJobId(payload.source, job.url).split(':')[2],
    last_scouted_at: payload.scouted_at
  };
}

function isAbsoluteHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function importAggregated() {
  const employers = await readJson(EMPLOYERS_PATH, []);
  const directoryFile = await readJson(DIRECTORY_PATH, null);
  if (!directoryFile) {
    console.error('cap-exempt-directory.json missing — run npm run radar:enrich first');
    process.exitCode = 1;
    return;
  }
  const directory = directoryFile.entries || {};
  const tokenKeyIndex = new Map();
  for (const [key, entry] of Object.entries(directory)) {
    if (entry.token_key && !tokenKeyIndex.has(entry.token_key)) tokenKeyIndex.set(entry.token_key, key);
  }
  const registryResolver = createResolver(employers);
  const liveProviderIds = new Set(employers.filter((employer) => employer.ats_provider).map((employer) => employer.id));

  const store = await readJson(STORE_PATH, { schema_version: 1, updated_at: null, snapshots: {}, jobs: [] });
  store.snapshots = store.snapshots || {};

  let files = [];
  try {
    const names = await fs.readdir(AGGREGATED_DIR);
    files = names.filter((name) => name.endsWith('.json')).map((name) => path.join(AGGREGATED_DIR, name));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (files.length === 0) {
    console.log('No aggregated snapshots in radar/data/aggregated/ — run the firehose first');
    return;
  }

  const context = { directory, tokenKeyIndex, registryResolver, liveProviderIds };
  for (const filePath of files) {
    let payload;
    try {
      payload = JSON.parse(await fs.readFile(filePath, 'utf8'));
    } catch (error) {
      console.error(`${path.basename(filePath)}: unreadable JSON (${error.message})`);
      continue;
    }
    if (payload.schema_version !== 1 || !payload.source || !Array.isArray(payload.jobs)) {
      console.error(`${path.basename(filePath)}: invalid snapshot shape`);
      continue;
    }
    const kept = [];
    const drops = { covered_by_live_ats: 0, not_cap_exempt: 0, invalid: 0 };
    const seenIds = new Set();
    for (const job of payload.jobs) {
      if (!job || typeof job.title !== 'string' || !job.title.trim()
        || typeof job.employer_name !== 'string' || !job.employer_name.trim()
        || !isAbsoluteHttpUrl(job.url)) {
        drops.invalid += 1;
        continue;
      }
      const resolution = resolveAggregatedJob(job, context);
      if (!resolution.keep) {
        drops[resolution.reason] += 1;
        continue;
      }
      const normalized = normalizeAggregatedJob(job, payload, resolution);
      if (seenIds.has(normalized.id)) continue;
      seenIds.add(normalized.id);
      kept.push(normalized);
    }
    // Snapshot-replace per source
    store.jobs = store.jobs.filter((job) => job.source !== payload.source);
    store.jobs.push(...kept);
    store.snapshots[payload.source] = {
      scouted_at: payload.scouted_at,
      job_count: kept.length,
      scraped_count: payload.jobs.length,
      dropped: drops,
      skipped_reason: payload.skipped_reason || null
    };
    console.log(`${payload.source}: kept ${kept.length}/${payload.jobs.length} (live-ATS dupes ${drops.covered_by_live_ats}, not cap-exempt ${drops.not_cap_exempt}, invalid ${drops.invalid})`);
  }

  store.updated_at = new Date().toISOString();
  await fs.writeFile(STORE_PATH, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
  const employerCount = new Set(store.jobs.map((job) => job.employer_id)).size;
  console.log(`Aggregated store: ${store.jobs.length} cap-exempt jobs across ${employerCount} employers`);
}

if (require.main === module) {
  importAggregated().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { importAggregated, resolveAggregatedJob, normalizeAggregatedJob, aggregatedJobId, pseudoEmployerId, directoryLookup };
