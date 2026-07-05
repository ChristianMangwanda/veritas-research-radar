#!/usr/bin/env node

/**
 * Resolves directory entries that have an EIN but no website.
 *
 * Strategies, in order:
 *   1. Serper.dev search (authoritative) — used when SERPER_API_KEY is set.
 *   2. Domain guessing + verification (free) — candidate domains generated
 *      from the org name, fetched, and accepted only when the page text
 *      shares enough distinctive tokens with the name.
 *
 * Resumable: results (including misses) persist to
 * radar/data/employer-websites.json; reruns only process unknown keys.
 * A `--retry-misses` flag reprocesses old misses (e.g. after adding a key).
 *
 * Usage:
 *   node radar/scripts/fetch-nonprofit-websites.js [--limit N] [--retry-misses]
 */

const fsp = require('fs/promises');
const path = require('path');

const DATA_DIR = path.resolve(__dirname, '../data');
const DIRECTORY_PATH = path.join(DATA_DIR, 'cap-exempt-directory.json');
const SIDECAR_PATH = path.join(DATA_DIR, 'employer-websites.json');

const REQUEST_DELAY_MS = 350;
const SAVE_EVERY = 50;
const FETCH_TIMEOUT_MS = 8000;
const UA = 'veritas-research-radar (nonprofit website resolution; contact via repo)';

const STOPWORDS = new Set(['OF', 'AND', 'AT', 'IN', 'FOR', 'THE', 'INC', 'FOUNDATION', 'FUND', 'TRUST', 'ASSOCIATION', 'SOCIETY', 'CENTER', 'INSTITUTE', 'CORPORATION', 'CORP', 'CO']);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function significantTokens(name) {
  return String(name || '').toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').split(/\s+/)
    .filter((token) => token.length > 2 && !STOPWORDS.has(token));
}

function normalizeWebsite(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(withScheme);
    if (!url.hostname.includes('.')) return null;
    return `${url.origin}${url.pathname === '/' ? '/' : url.pathname}`;
  } catch {
    return null;
  }
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal, redirect: 'follow' });
  } finally {
    clearTimeout(timer);
  }
}

/* --------------------------- Serper (preferred) -------------------------- */

async function serperLookup(name) {
  const response = await fetchWithTimeout('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'X-API-KEY': process.env.SERPER_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ q: `"${name}" official website`, num: 5 })
  });
  if (!response.ok) throw new Error(`serper ${response.status}`);
  const body = await response.json();
  const tokens = significantTokens(name);
  for (const result of body.organic || []) {
    const url = normalizeWebsite(result.link);
    if (!url) continue;
    const host = new URL(url).hostname;
    // Skip aggregators/registries that outrank small org sites
    if (/wikipedia|propublica|guidestar|charitynavigator|linkedin|facebook|instagram|zoominfo|causeiq|idealist|glassdoor|indeed/.test(host)) continue;
    const haystack = `${result.title || ''} ${result.snippet || ''} ${host}`.toUpperCase();
    const matched = tokens.filter((token) => haystack.includes(token)).length;
    if (matched >= Math.min(2, tokens.length)) return { website: new URL(url).origin + '/', confidence: 'search' };
  }
  return null;
}

/* ------------------------ Domain guess + verify -------------------------- */

function candidateDomains(name) {
  const tokens = significantTokens(name).map((token) => token.toLowerCase());
  if (!tokens.length) return [];
  const joined = tokens.join('');
  const acronym = tokens.map((token) => token[0]).join('');
  const bases = new Set([joined, tokens.slice(0, 2).join(''), tokens[0]]);
  if (acronym.length >= 3) bases.add(acronym);
  const domains = [];
  for (const base of bases) {
    if (base.length < 4 || base.length > 40) continue;
    for (const tld of ['org', 'edu', 'com']) domains.push(`${base}.${tld}`);
  }
  return domains.slice(0, 9);
}

async function verifyDomain(domain, name) {
  try {
    const response = await fetchWithTimeout(`https://${domain}/`, { headers: { 'user-agent': UA } });
    if (!response.ok) return null;
    const text = (await response.text()).slice(0, 20000).toUpperCase();
    const tokens = significantTokens(name);
    const matched = tokens.filter((token) => text.includes(token)).length;
    // Require most distinctive tokens to appear — one shared generic word
    // ("CANCER") must never claim someone else's site
    if (matched >= Math.min(2, tokens.length) && matched >= tokens.length * 0.5) {
      return { website: `https://${domain}/`, confidence: 'guess-verified' };
    }
  } catch { /* dead domain / timeout */ }
  return null;
}

async function resolveWebsite(name) {
  if (process.env.SERPER_API_KEY) {
    try {
      const hit = await serperLookup(name);
      if (hit) return hit;
    } catch (error) {
      console.warn(`  serper failed for ${name}: ${error.message}`);
    }
  }
  for (const domain of candidateDomains(name)) {
    const hit = await verifyDomain(domain, name);
    if (hit) return hit;
    await sleep(120);
  }
  return null;
}

/* --------------------------------- Main ---------------------------------- */

async function main() {
  const limitArg = process.argv.indexOf('--limit');
  const limit = limitArg >= 0 ? Number(process.argv[limitArg + 1]) : Infinity;
  const retryMisses = process.argv.includes('--retry-misses');

  const directory = JSON.parse(await fsp.readFile(DIRECTORY_PATH, 'utf8'));
  let sidecar = {};
  try {
    sidecar = JSON.parse(await fsp.readFile(SIDECAR_PATH, 'utf8'));
  } catch { /* first run */ }

  const pending = Object.entries(directory.entries)
    .filter(([key, entry]) => entry.ein && !entry.website)
    .filter(([key]) => retryMisses ? !(sidecar[key]?.website) : !sidecar[key])
    .sort(([, a], [, b]) =>
      ((b.uscis_approvals_3y || 0) + (b.dol_certified_3y || 0) * 2)
      - ((a.uscis_approvals_3y || 0) + (a.dol_certified_3y || 0) * 2))
    .slice(0, limit);

  const mode = process.env.SERPER_API_KEY ? 'serper+guess' : 'guess-only (set SERPER_API_KEY to upgrade)';
  console.log(`${pending.length} names to resolve via ${mode} (${Object.keys(sidecar).length} cached)`);
  let processed = 0;
  let hits = 0;

  const save = () => fsp.writeFile(SIDECAR_PATH, `${JSON.stringify(sidecar, null, 1)}\n`, 'utf8');

  for (const [key, entry] of pending) {
    const result = await resolveWebsite(entry.name);
    sidecar[key] = {
      ein: entry.ein,
      website: result?.website || null,
      confidence: result?.confidence || null,
      source: result ? (result.confidence === 'search' ? 'serper' : 'domain-guess') : 'unresolved',
      fetched_at: new Date().toISOString()
    };
    if (result) hits += 1;
    processed += 1;
    if (processed % SAVE_EVERY === 0) {
      await save();
      console.log(`  ${processed}/${pending.length} processed, ${hits} websites found`);
    }
    await sleep(REQUEST_DELAY_MS);
  }

  await save();
  console.log(`Done: ${processed} processed, ${hits} found (${Math.round(hits / Math.max(1, processed) * 100)}%), sidecar ${Object.keys(sidecar).length} entries`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
