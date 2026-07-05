#!/usr/bin/env node

/**
 * Monthly enrichment: manufactures the cap-exempt signal by joining
 *  - IPEDS HD (accredited higher-ed = the legal cap-exempt definition)
 *  - IRS EO BMF (501(c)(3) research nonprofits via NTEE U/H/V)
 *  - USCIS H-1B Employer Data Hub (who actually gets petitions approved)
 *  - DOL LCA signals (who files, in which titles) — from the manual import
 * via entity resolution, producing:
 *  - employer-enrichment.json   (overlay merged by refresh.js)
 *  - discovery-candidates.json  (ranked new cap-exempt employer candidates)
 *  - enrichment-report.json     (match rates + alias worklist)
 *
 * Usage: npm run radar:enrich [-- --force] [-- --offline] [-- --dol-csv path]
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const readline = require('readline');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { createResolver, normalizeName, significantTokens } = require('./lib/entity-resolution.js');
const { parseCsv, csvRecords, columnIndex } = require('./lib/csv.js');
const { extractZipEntry } = require('./lib/zip.js');
const { matchSignals } = require('./refresh.js');

const ROOT = path.resolve(__dirname, '../..');
const RADAR_DIR = path.join(ROOT, 'radar');
const DATA_DIR = path.join(RADAR_DIR, 'data');
const CACHE_DIR = path.join(DATA_DIR, 'enrichment-cache');
const EMPLOYERS_PATH = path.join(RADAR_DIR, 'employers.json');
const DOL_SIGNALS_PATH = path.join(DATA_DIR, 'dol-sponsor-signals.json');
const DOL_RAW_DIR = path.join(DATA_DIR, 'dol-raw');
const ENRICHMENT_PATH = path.join(DATA_DIR, 'employer-enrichment.json');
const DISCOVERY_PATH = path.join(DATA_DIR, 'discovery-candidates.json');
const REPORT_PATH = path.join(DATA_DIR, 'enrichment-report.json');
const DIRECTORY_PATH = path.join(DATA_DIR, 'cap-exempt-directory.json');

const USER_AGENT = 'VeritasResearchRadar/1.0 (+https://github.com/ChristianMangwanda/Veritas)';
const DOWNLOAD_TIMEOUT_MS = 300000;
const CACHE_MAX_AGE_DAYS = 25;
const MIN_SCORING_CONFIDENCE = 0.75;
const DISCOVERY_LIMIT = 250;
const RESEARCH_NTEE = /^[UHV]/;
const NONPROFIT_RESEARCH_TYPES = new Set(['nonprofit_research_org', 'nonprofit_research_hospital']);

// ---------------------------------------------------------------------------
// Download cache

async function downloadToFile(url, destPath, { force = false, offline = false, maxAgeDays = CACHE_MAX_AGE_DAYS } = {}) {
  let stat = null;
  try {
    stat = await fsp.stat(destPath);
  } catch {
    stat = null;
  }
  const fresh = stat && (Date.now() - stat.mtimeMs) < maxAgeDays * 24 * 60 * 60 * 1000;
  if (stat && (offline || (fresh && !force))) {
    return { path: destPath, cached: true, bytes: stat.size };
  }
  if (offline) return null;

  await fsp.mkdir(path.dirname(destPath), { recursive: true });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': USER_AGENT },
      signal: controller.signal
    });
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status} ${response.statusText}`);
      error.status = response.status;
      throw error;
    }
    const tempPath = `${destPath}.download`;
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(tempPath));
    await fsp.rename(tempPath, destPath);
    const written = await fsp.stat(destPath);
    return { path: destPath, cached: false, bytes: written.size };
  } finally {
    clearTimeout(timeout);
  }
}

async function readFirstLine(filePath) {
  const stream = fs.createReadStream(filePath, { start: 0, end: 4096 });
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8').split(/\r?\n/)[0] || '';
}

// ---------------------------------------------------------------------------
// IPEDS (accredited institutions of higher education)

function normalizeWebsite(value) {
  const raw = String(value || '').trim().replace(/^"+|"+$/g, '');
  if (!raw || raw === '.') return null;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    return new URL(withScheme).toString();
  } catch {
    return null;
  }
}

function parseIpedsCsv(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) return [];
  const headers = rows[0];
  const idx = {
    unitid: columnIndex(headers, ['UNITID']),
    instnm: columnIndex(headers, ['INSTNM']),
    city: columnIndex(headers, ['CITY']),
    stabbr: columnIndex(headers, ['STABBR']),
    webaddr: columnIndex(headers, ['WEBADDR'])
  };
  if (idx.unitid < 0 || idx.instnm < 0) return [];
  const institutions = [];
  for (const row of rows.slice(1)) {
    const unitid = String(row[idx.unitid] || '').trim();
    const instnm = String(row[idx.instnm] || '').trim();
    if (!unitid || !instnm) continue;
    institutions.push({
      unitid,
      instnm,
      city: String(row[idx.city] || '').trim(),
      stabbr: String(row[idx.stabbr] || '').trim(),
      website: idx.webaddr >= 0 ? normalizeWebsite(row[idx.webaddr]) : null
    });
  }
  return institutions;
}

async function loadIpeds(options) {
  const currentYear = new Date().getFullYear();
  for (let year = currentYear - 1; year >= 2022; year -= 1) {
    const dest = path.join(CACHE_DIR, `HD${year}.zip`);
    try {
      const download = await downloadToFile(`https://nces.ed.gov/ipeds/datacenter/data/HD${year}.zip`, dest, options);
      if (!download) continue;
      const buffer = await fsp.readFile(dest);
      const csvBuffer = extractZipEntry(buffer, (name) => name.toLowerCase().endsWith('.csv'));
      // IPEDS CSVs are windows-1252; latin1 decoding is lossless for our fields
      const institutions = parseIpedsCsv(csvBuffer.toString('latin1'));
      if (institutions.length > 0) {
        return { year, institutions, cached: download.cached };
      }
    } catch (error) {
      console.warn(`IPEDS HD${year}: ${error.message}`);
    }
  }
  return { year: null, institutions: [], cached: false };
}

// ---------------------------------------------------------------------------
// IRS EO BMF (research nonprofits) — streamed, never buffered

async function streamIrsFile(filePath, { resolver, registryTokens, keptRows }) {
  const rl = readline.createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });
  let idx = null;
  let rowNo = 0;
  for await (const row of csvRecords(rl)) {
    rowNo += 1;
    if (!idx) {
      idx = {
        ein: columnIndex(row, ['EIN']),
        name: columnIndex(row, ['NAME']),
        subsection: columnIndex(row, ['SUBSECTION']),
        ntee: columnIndex(row, ['NTEE_CD']),
        sortName: columnIndex(row, ['SORT_NAME']),
        state: columnIndex(row, ['STATE'])
      };
      if (idx.ein < 0 || idx.name < 0) throw new Error(`${path.basename(filePath)}: unexpected header`);
      continue;
    }
    if (rowNo % 250000 === 0) console.log(`  ${path.basename(filePath)}: ${rowNo} rows...`);
    const name = String(row[idx.name] || '').trim();
    if (!name) continue;
    const ntee = String(row[idx.ntee] || '').trim();
    const subsection = String(row[idx.subsection] || '').trim().padStart(2, '0');
    const isResearch = subsection === '03' && RESEARCH_NTEE.test(ntee);

    let registry = null;
    if (!isResearch) {
      // Cheap token guard before the (comparatively) expensive resolver:
      // skip rows sharing no significant token with any registry name/alias
      const tokens = normalizeName(name).split(' ');
      if (!tokens.some((token) => registryTokens.has(token))) continue;
    }
    const resolved = resolver.resolve(name);
    const sortResolved = !resolved.matched && idx.sortName >= 0 && row[idx.sortName]
      ? resolver.resolve(row[idx.sortName])
      : null;
    const best = resolved.matched ? resolved : sortResolved;
    if (best?.matched) {
      registry = { id: best.matched.id, confidence: best.confidence, strategy: best.strategy };
    }
    if (!isResearch && !registry) continue;

    keptRows.push({
      ein: String(row[idx.ein] || '').trim(),
      name,
      subsection,
      ntee_cd: ntee,
      state: String(row[idx.state] || '').trim(),
      is_research: isResearch,
      registry
    });
  }
}

async function loadIrsEoBmf({ resolver, registryTokens }, options) {
  const keptRows = [];
  const files = ['eo1.csv', 'eo2.csv', 'eo3.csv', 'eo4.csv'];
  let loaded = 0;
  for (const file of files) {
    const dest = path.join(CACHE_DIR, file);
    try {
      const download = await downloadToFile(`https://www.irs.gov/pub/irs-soi/${file}`, dest, options);
      if (!download) continue;
      console.log(`IRS ${file}: ${download.cached ? 'cache' : 'downloaded'} (${Math.round(download.bytes / 1048576)}MB)`);
      await streamIrsFile(dest, { resolver, registryTokens, keptRows });
      loaded += 1;
    } catch (error) {
      console.warn(`IRS ${file}: ${error.message}`);
    }
  }
  return { files_loaded: loaded, rows: keptRows };
}

// ---------------------------------------------------------------------------
// USCIS H-1B Employer Data Hub

async function streamUscisFile(filePath, byEmployer) {
  const rl = readline.createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });
  let idx = null;
  for await (const row of csvRecords(rl)) {
    if (!idx) {
      idx = {
        employer: columnIndex(row, ['EMPLOYER', 'EMPLOYER_NAME', 'EMPLOYER_PETITIONER_NAME']),
        initial: columnIndex(row, ['INITIAL_APPROVAL', 'INITIAL_APPROVALS']),
        continuing: columnIndex(row, ['CONTINUING_APPROVAL', 'CONTINUING_APPROVALS'])
      };
      if (idx.employer < 0) throw new Error(`${path.basename(filePath)}: unexpected header`);
      continue;
    }
    const name = String(row[idx.employer] || '').trim();
    if (!name) continue;
    const toCount = (value) => Number(String(value || '0').replace(/[^0-9]/g, '')) || 0;
    const approvals = toCount(row[idx.initial]) + toCount(row[idx.continuing]);
    if (approvals === 0) continue;
    const key = normalizeName(name);
    if (!key) continue;
    byEmployer.set(key, (byEmployer.get(key) || 0) + approvals);
  }
}

async function loadUscis(options) {
  const byEmployer = new Map();
  const years = [];
  const currentFiscalYear = new Date().getFullYear() + 1;
  for (let year = currentFiscalYear; year >= 2019 && years.length < 3; year -= 1) {
    const dest = path.join(CACHE_DIR, `h1b_datahubexport-${year}.csv`);
    try {
      const download = await downloadToFile(`https://www.uscis.gov/sites/default/files/document/data/h1b_datahubexport-${year}.csv`, dest, options);
      if (!download) continue;
      const firstLine = await readFirstLine(dest);
      if (!/fiscal year|employer/i.test(firstLine)) {
        // A 200 HTML tool page must not poison the cache
        await fsp.unlink(dest).catch(() => {});
        continue;
      }
      await streamUscisFile(dest, byEmployer);
      years.push(year);
    } catch (error) {
      if (error.status !== 404) console.warn(`USCIS FY${year}: ${error.message}`);
    }
  }
  return { years, byEmployer };
}

// ---------------------------------------------------------------------------
// DOL raw CSV (discovery signal: who files LCAs for research titles)

async function streamDolFile(filePath, byEmployer) {
  const rl = readline.createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });
  let idx = null;
  for await (const row of csvRecords(rl)) {
    if (!idx) {
      idx = {
        employer: columnIndex(row, ['EMPLOYER_NAME', 'EMPLOYER_LEGAL_BUSINESS_NAME', 'EMPLOYER_BUSINESS_DBA']),
        status: columnIndex(row, ['CASE_STATUS', 'CASESTATUS']),
        title: columnIndex(row, ['JOB_TITLE', 'SOC_TITLE'])
      };
      if (idx.employer < 0) throw new Error(`${path.basename(filePath)}: no employer column`);
      continue;
    }
    const status = String(row[idx.status] || '').toUpperCase();
    if (idx.status >= 0 && !status.includes('CERTIFIED')) continue;
    const title = String(row[idx.title] || '').trim();
    if (!title || matchSignals(title).research_role_language.length === 0) continue;
    const key = normalizeName(row[idx.employer]);
    if (!key) continue;
    const current = byEmployer.get(key) || { certified_count: 0, sample_titles: [] };
    current.certified_count += 1;
    if (current.sample_titles.length < 5 && !current.sample_titles.includes(title)) {
      current.sample_titles.push(title);
    }
    byEmployer.set(key, current);
  }
}

async function loadDolRaw(explicitCsv) {
  const byEmployer = new Map();
  let files = [];
  if (explicitCsv) {
    files = [explicitCsv];
  } else {
    try {
      const names = await fsp.readdir(DOL_RAW_DIR);
      files = names.filter((name) => name.toLowerCase().endsWith('.csv')).map((name) => path.join(DOL_RAW_DIR, name));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  for (const file of files) {
    console.log(`DOL raw: streaming ${path.basename(file)}...`);
    await streamDolFile(file, byEmployer);
  }
  return { files_loaded: files.length, byEmployer };
}

// ---------------------------------------------------------------------------
// Scoring + status suggestion (pure, exported)

function computeCapExemptScore(evidence) {
  const components = {};
  const confidenceOf = (match) => match?.match?.confidence ?? 1;
  if (evidence.ipeds && confidenceOf(evidence.ipeds) >= MIN_SCORING_CONFIDENCE) {
    components.ipeds = 40;
  }
  if (evidence.irs && confidenceOf(evidence.irs) >= MIN_SCORING_CONFIDENCE && evidence.irs.subsection === '03') {
    components.irs = RESEARCH_NTEE.test(evidence.irs.ntee_cd || '') ? 25 : 10;
  }
  const dol = Number(evidence.dol_certified_3y || 0);
  if (dol > 0) components.dol = Math.min(20, Math.round(Math.log10(dol + 1) * 10));
  const uscis = Number(evidence.uscis_approvals_3y || 0);
  if (uscis > 0) components.uscis = Math.min(15, Math.round(Math.log10(uscis + 1) * 7.5));
  const score = Math.min(100, Object.values(components).reduce((sum, value) => sum + value, 0));
  return { score, components };
}

function suggestStatus(evidence, employer) {
  const confidenceOf = (match) => match?.match?.confidence ?? 1;
  if (evidence.ipeds && confidenceOf(evidence.ipeds) >= MIN_SCORING_CONFIDENCE) {
    if (employer.type === 'institution_of_higher_education') return 'verified';
  }
  if (evidence.irs && confidenceOf(evidence.irs) >= MIN_SCORING_CONFIDENCE
    && evidence.irs.subsection === '03' && RESEARCH_NTEE.test(evidence.irs.ntee_cd || '')) {
    if (NONPROFIT_RESEARCH_TYPES.has(employer.type)) return 'verified';
  }
  return employer.cap_exempt_status;
}

// ---------------------------------------------------------------------------
// Discovery (pure, exported)

function buildDiscoveryCandidates({ irsRows, ipedsInstitutions, dolActivity, uscisActivity, registryResolver, limit = DISCOVERY_LIMIT }) {
  const pool = new Map();
  const byTokenKey = new Map();

  const upsert = (name, patch) => {
    const normalized = normalizeName(name);
    if (!normalized) return;
    const tokenKey = significantTokens(name).sort().join(' ');
    let key = normalized;
    if (!pool.has(key) && byTokenKey.has(tokenKey)) key = byTokenKey.get(tokenKey);
    const current = pool.get(key) || {
      name,
      normalized_name: normalized,
      ipeds: null,
      irs: null,
      dol_research_certified_3y: 0,
      dol_sample_titles: [],
      uscis_approvals_3y: 0
    };
    Object.assign(current, patch);
    pool.set(key, current);
    if (tokenKey) byTokenKey.set(tokenKey, key);
  };

  for (const institution of ipedsInstitutions) {
    upsert(institution.instnm, { ipeds: { unitid: institution.unitid, instnm: institution.instnm, stabbr: institution.stabbr } });
  }
  for (const row of irsRows) {
    if (!row.is_research) continue;
    upsert(row.name, { irs: { ein: row.ein, ntee_cd: row.ntee_cd, subsection: row.subsection, state: row.state } });
  }

  const candidates = [];
  for (const candidate of pool.values()) {
    const tokenKey = significantTokens(candidate.name).sort().join(' ');
    const dol = dolActivity.get(candidate.normalized_name) || dolActivity.get(tokenKey) || null;
    if (dol) {
      candidate.dol_research_certified_3y = dol.certified_count;
      candidate.dol_sample_titles = dol.sample_titles;
    }
    const uscis = uscisActivity.get(candidate.normalized_name) ?? uscisActivity.get(tokenKey) ?? 0;
    candidate.uscis_approvals_3y = uscis;

    // Eligibility gate: legal-basis evidence AND demonstrated activity
    if (!candidate.ipeds && !candidate.irs) continue;
    if (candidate.dol_research_certified_3y === 0 && candidate.uscis_approvals_3y === 0) continue;
    // Drop anything already in the registry (any match strategy)
    if (registryResolver.resolve(candidate.name).matched) continue;

    const { score, components } = computeCapExemptScore({
      ipeds: candidate.ipeds,
      irs: candidate.irs,
      dol_certified_3y: candidate.dol_research_certified_3y,
      uscis_approvals_3y: candidate.uscis_approvals_3y
    });
    candidates.push({ ...candidate, score, score_components: components });
  }

  candidates.sort((a, b) =>
    (b.score - a.score)
    || (b.dol_research_certified_3y - a.dol_research_certified_3y)
    || (b.uscis_approvals_3y - a.uscis_approvals_3y)
    || a.name.localeCompare(b.name));

  return candidates.slice(0, limit).map((candidate) => ({
    ...candidate,
    suggested_registry_entry: {
      id: candidate.normalized_name.toLowerCase().replace(/\s+/g, '-').slice(0, 60),
      name: candidate.name,
      type: candidate.ipeds ? 'institution_of_higher_education' : 'nonprofit_research_org',
      cap_exempt_status: 'likely',
      evidence_sources: [
        ...(candidate.ipeds ? ['ipeds'] : []),
        ...(candidate.irs ? ['irs_eo_bmf'] : []),
        ...(candidate.dol_research_certified_3y ? ['dol_lca'] : []),
        ...(candidate.uscis_approvals_3y ? ['uscis_h1b_datahub'] : [])
      ],
      ats_provider: null,
      ats_token: null,
      careers_url: null,
      research_areas: [],
      notes: 'Discovered by radar:enrich; verify identity and add careers_url before wiring.'
    }
  }));
}

// ---------------------------------------------------------------------------
// Cap-exempt directory: the full IPEDS + IRS-research universe as a lookup
// table, so the aggregator firehose can keep only cap-exempt employers.
// Keyed by normalizeName; token_key enables order-insensitive lookups.

function buildCapExemptDirectory({ ipedsInstitutions, irsRows, dolActivity, uscisActivity }) {
  const entries = {};
  const upsert = (name, patch) => {
    const key = normalizeName(name);
    if (!key) return;
    const current = entries[key] || {
      name,
      token_key: significantTokens(name).sort().join(' '),
      kind: null,
      unitid: null,
      ein: null,
      ntee_cd: null,
      website: null,
      uscis_approvals_3y: 0,
      dol_certified_3y: 0
    };
    // Never let a null overwrite a known website
    if (patch.website == null) delete patch.website;
    Object.assign(current, patch);
    current.kind = current.unitid && current.ein ? 'both' : (current.unitid ? 'ipeds' : 'irs');
    entries[key] = current;
  };

  for (const institution of ipedsInstitutions) {
    upsert(institution.instnm, { unitid: institution.unitid, website: institution.website });
  }
  for (const row of irsRows) {
    if (!row.is_research) continue;
    upsert(row.name, { ein: row.ein, ntee_cd: row.ntee_cd });
  }
  for (const [key, entry] of Object.entries(entries)) {
    const tokenKey = entry.token_key;
    const dol = dolActivity.get(key) || dolActivity.get(tokenKey);
    if (dol) entry.dol_certified_3y = dol.certified_count;
    entry.uscis_approvals_3y = uscisActivity.get(key) ?? uscisActivity.get(tokenKey) ?? 0;
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Registry join

function buildRegistryTokenSet(employers) {
  const tokens = new Set();
  for (const employer of employers) {
    for (const token of significantTokens(employer.name)) tokens.add(token);
    for (const alias of employer.aliases || []) {
      for (const token of significantTokens(alias)) tokens.add(token);
    }
  }
  return tokens;
}

function joinRegistryEvidence({ employers, ipeds, irsRows, uscisByEmployer, dolSignals }) {
  const weakMatches = [];
  const employerEvidence = {};

  // IPEDS: resolve each registry employer INTO an IPEDS resolver
  const ipedsResolver = createResolver(ipeds.institutions.map((institution) => ({
    id: institution.unitid,
    name: institution.instnm
  })));
  const bestIrsByEmployer = new Map();
  for (const row of irsRows) {
    if (!row.registry) continue;
    const existing = bestIrsByEmployer.get(row.registry.id);
    const rank = (candidate) => (candidate.registry.confidence * 10) + (candidate.is_research ? 1 : 0);
    if (!existing || rank(row) > rank(existing)) bestIrsByEmployer.set(row.registry.id, row);
  }

  for (const employer of employers) {
    const namesToTry = [employer.name, ...(employer.aliases || [])];

    let ipedsMatch = null;
    for (const name of namesToTry) {
      const resolved = ipedsResolver.resolve(name);
      if (resolved.matched && (!ipedsMatch || resolved.confidence > ipedsMatch.match.confidence)) {
        ipedsMatch = {
          unitid: resolved.matched.id,
          instnm: resolved.matched.name,
          match: { strategy: resolved.strategy, confidence: resolved.confidence }
        };
      }
    }
    if (ipedsMatch && ipedsMatch.match.confidence < MIN_SCORING_CONFIDENCE) {
      weakMatches.push({ employer_id: employer.id, source: 'ipeds', candidate_name: ipedsMatch.instnm, ...ipedsMatch.match });
    }

    const irsRow = bestIrsByEmployer.get(employer.id) || null;
    const irsMatch = irsRow ? {
      ein: irsRow.ein,
      ntee_cd: irsRow.ntee_cd,
      subsection: irsRow.subsection,
      name: irsRow.name,
      match: { strategy: irsRow.registry.strategy, confidence: irsRow.registry.confidence }
    } : null;
    if (irsMatch && irsMatch.match.confidence < MIN_SCORING_CONFIDENCE) {
      weakMatches.push({ employer_id: employer.id, source: 'irs_eo_bmf', candidate_name: irsMatch.name, ...irsMatch.match });
    }

    let uscisApprovals = 0;
    for (const name of namesToTry) {
      const key = normalizeName(name);
      if (uscisByEmployer.has(key)) uscisApprovals = Math.max(uscisApprovals, uscisByEmployer.get(key));
    }

    const dolCertified = Number(dolSignals[employer.id]?.certified_count_3y || 0);

    const evidence = {
      ipeds: ipedsMatch,
      irs: irsMatch,
      uscis_approvals_3y: uscisApprovals,
      dol_certified_3y: dolCertified
    };
    const { score, components } = computeCapExemptScore(evidence);
    const suggested = suggestStatus(evidence, employer);
    employerEvidence[employer.id] = {
      ...evidence,
      cap_exempt_score: score,
      score_components: components,
      suggested_status: suggested,
      evidence_tags: [
        ...(ipedsMatch && ipedsMatch.match.confidence >= MIN_SCORING_CONFIDENCE ? [`ipeds:${ipedsMatch.unitid}`] : []),
        ...(irsMatch && irsMatch.match.confidence >= MIN_SCORING_CONFIDENCE ? ['irs_eo_bmf'] : []),
        ...(dolCertified > 0 ? ['dol_lca'] : []),
        ...(uscisApprovals > 0 ? ['uscis_h1b_datahub'] : [])
      ]
    };
  }

  return { employerEvidence, weakMatches };
}

// ---------------------------------------------------------------------------
// Orchestration

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fsp.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function writeJson(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function runEnrich({ force = false, offline = false, dolCsv = null } = {}) {
  const startedAt = new Date().toISOString();
  const options = { force, offline };
  const employers = await readJson(EMPLOYERS_PATH, []);
  const dolSignals = await readJson(DOL_SIGNALS_PATH, {});
  const registryResolver = createResolver(employers);
  const registryTokens = buildRegistryTokenSet(employers);

  console.log('Loading IPEDS...');
  const ipeds = await loadIpeds(options);
  console.log(`IPEDS: ${ipeds.institutions.length} institutions (HD${ipeds.year ?? 'unavailable'})`);

  console.log('Loading IRS EO BMF (streams ~340MB on first run)...');
  const irs = await loadIrsEoBmf({ resolver: registryResolver, registryTokens }, options);
  console.log(`IRS: kept ${irs.rows.length} rows from ${irs.files_loaded} files`);

  console.log('Loading USCIS H-1B Data Hub...');
  const uscis = await loadUscis(options);
  console.log(`USCIS: ${uscis.byEmployer.size} employers across FY ${uscis.years.join(', ') || 'none available'}`);

  console.log('Loading DOL raw disclosure CSVs (optional)...');
  const dolRaw = await loadDolRaw(dolCsv);
  console.log(`DOL raw: ${dolRaw.byEmployer.size} research-title employers from ${dolRaw.files_loaded} files`);

  const { employerEvidence, weakMatches } = joinRegistryEvidence({
    employers,
    ipeds,
    irsRows: irs.rows,
    uscisByEmployer: uscis.byEmployer,
    dolSignals
  });

  const discovery = buildDiscoveryCandidates({
    irsRows: irs.rows,
    ipedsInstitutions: ipeds.institutions,
    dolActivity: dolRaw.byEmployer,
    uscisActivity: uscis.byEmployer,
    registryResolver
  });

  const directory = buildCapExemptDirectory({
    ipedsInstitutions: ipeds.institutions,
    irsRows: irs.rows,
    dolActivity: dolRaw.byEmployer,
    uscisActivity: uscis.byEmployer
  });

  // Nonprofit websites arrive from a separate resumable fetcher (ProPublica
  // 990 lookups keyed by directory key); merge without overwriting IPEDS data
  const websiteSidecar = await readJson(path.join(DATA_DIR, 'employer-websites.json'), {});
  let sidecarMerged = 0;
  for (const [key, record] of Object.entries(websiteSidecar)) {
    if (directory[key] && !directory[key].website && record.website) {
      directory[key].website = record.website;
      sidecarMerged += 1;
    }
  }
  if (sidecarMerged) console.log(`Merged ${sidecarMerged} nonprofit websites from sidecar`);

  const enrichment = {
    schema_version: 1,
    generated_at: startedAt,
    sources: {
      ipeds: { year: ipeds.year, institutions: ipeds.institutions.length },
      irs_eo_bmf: { files_loaded: irs.files_loaded, kept_rows: irs.rows.length },
      uscis: { years: uscis.years, employers: uscis.byEmployer.size },
      dol: { signals_file: Object.keys(dolSignals).length > 0, raw_files: dolRaw.files_loaded }
    },
    employers: employerEvidence
  };

  const matched = (source) => Object.values(employerEvidence).filter((evidence) => evidence[source]).length;
  const unmatched = employers
    .filter((employer) => employer.id !== 'us-federal-research')
    .map((employer) => {
      const evidence = employerEvidence[employer.id];
      const missing = [];
      if (!evidence.ipeds && employer.type === 'institution_of_higher_education') missing.push('ipeds');
      if (!evidence.irs && NONPROFIT_RESEARCH_TYPES.has(employer.type)) missing.push('irs_eo_bmf');
      if (!evidence.uscis_approvals_3y) missing.push('uscis');
      if (!evidence.dol_certified_3y) missing.push('dol');
      return { employer_id: employer.id, missing_sources: missing };
    })
    .filter((entry) => entry.missing_sources.length > 0);

  const report = {
    generated_at: startedAt,
    sources: enrichment.sources,
    registry: {
      employer_count: employers.length,
      ipeds_matched: matched('ipeds'),
      irs_matched: matched('irs'),
      with_uscis_activity: Object.values(employerEvidence).filter((evidence) => evidence.uscis_approvals_3y > 0).length,
      with_dol_signal: Object.values(employerEvidence).filter((evidence) => evidence.dol_certified_3y > 0).length,
      verified_suggested: Object.values(employerEvidence).filter((evidence) => evidence.suggested_status === 'verified').length
    },
    weak_matches: weakMatches,
    unmatched,
    discovery: { candidate_count: discovery.length, limit: DISCOVERY_LIMIT }
  };

  await writeJson(ENRICHMENT_PATH, enrichment);
  await writeJson(DISCOVERY_PATH, { schema_version: 1, generated_at: startedAt, candidates: discovery });
  await writeJson(REPORT_PATH, report);
  // Directory is large (~20k entries) — compact JSON, no pretty-printing
  await fsp.writeFile(DIRECTORY_PATH, `${JSON.stringify({ schema_version: 1, generated_at: startedAt, entries: directory })}\n`, 'utf8');
  console.log(`Cap-exempt directory: ${Object.keys(directory).length} employers`);

  console.log(`Enrichment complete: ${report.registry.verified_suggested} employers suggested 'verified', ${discovery.length} discovery candidates`);
  if (weakMatches.length) {
    console.log(`${weakMatches.length} weak matches need alias review — see ${path.relative(ROOT, REPORT_PATH)}`);
  }
  return report;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const dolCsvIndex = args.indexOf('--dol-csv');
  runEnrich({
    force: args.includes('--force'),
    offline: args.includes('--offline'),
    dolCsv: dolCsvIndex >= 0 ? path.resolve(args[dolCsvIndex + 1]) : null
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  parseIpedsCsv,
  computeCapExemptScore,
  suggestStatus,
  buildDiscoveryCandidates,
  buildCapExemptDirectory,
  joinRegistryEvidence,
  buildRegistryTokenSet,
  downloadToFile,
  runEnrich
};
