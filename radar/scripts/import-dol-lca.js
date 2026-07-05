#!/usr/bin/env node

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const readline = require('readline');
const { normalizeName, createResolver } = require('./lib/entity-resolution.js');
const { parseCsvLine, csvRecords, columnIndex } = require('./lib/csv.js');
const { classifyTitle } = require('./lib/title-class.js');

const ROOT = path.resolve(__dirname, '../..');
const RADAR_DIR = path.join(ROOT, 'radar');
const DATA_DIR = path.join(RADAR_DIR, 'data');
const EMPLOYERS_PATH = path.join(RADAR_DIR, 'employers.json');
const OUT_PATH = path.join(DATA_DIR, 'dol-sponsor-signals.json');

const MIN_MATCH_CONFIDENCE = 0.75;

function isRecent(value) {
  if (!value) return true;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return true;
  const threeYearsAgo = new Date();
  threeYearsAgo.setFullYear(threeYearsAgo.getFullYear() - 3);
  return date >= threeYearsAgo;
}

// LCA wages come in mixed units; annualize so medians are comparable
const WAGE_UNIT_MULTIPLIERS = {
  YEAR: 1,
  MONTH: 12,
  'BI-WEEKLY': 26,
  WEEK: 52,
  HOUR: 2080
};

function annualWage(rate, unit) {
  const value = Number(String(rate || '').replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(value) || value <= 0) return null;
  const multiplier = WAGE_UNIT_MULTIPLIERS[String(unit || 'YEAR').trim().toUpperCase()];
  if (!multiplier) return null;
  const annual = value * multiplier;
  // Guard against unit typos producing absurd annualizations
  return annual >= 10000 && annual <= 2000000 ? Math.round(annual) : null;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

async function importDolCsv(csvPath) {
  const employers = JSON.parse(await fsp.readFile(EMPLOYERS_PATH, 'utf8'));
  const resolver = createResolver(employers);
  const weakMatches = new Map();
  // Streamed: the disclosure files run to hundreds of MB, and quoted fields
  // can contain newlines — csvRecords joins those into whole records.
  const rl = readline.createInterface({ input: fs.createReadStream(csvPath), crlfDelay: Infinity });

  let employerIndex = -1;
  let statusIndex = -1;
  let titleIndex = -1;
  let dateIndex = -1;
  let socIndex = -1;
  let wageIndex = -1;
  let wageUnitIndex = -1;
  let headerSeen = false;
  let dataRows = 0;

  const signals = {};
  for await (const row of csvRecords(rl)) {
    if (!headerSeen) {
      headerSeen = true;
      employerIndex = columnIndex(row, ['EMPLOYER_NAME', 'EMPLOYER_LEGAL_BUSINESS_NAME', 'EMPLOYER_BUSINESS_DBA']);
      statusIndex = columnIndex(row, ['CASE_STATUS', 'CASESTATUS']);
      titleIndex = columnIndex(row, ['JOB_TITLE', 'SOC_TITLE']);
      dateIndex = columnIndex(row, ['DECISION_DATE', 'CASE_SUBMITTED', 'RECEIVED_DATE']);
      socIndex = columnIndex(row, ['SOC_CODE']);
      wageIndex = columnIndex(row, ['WAGE_RATE_OF_PAY_FROM', 'WAGE_RATE_OF_PAY', 'PREVAILING_WAGE']);
      wageUnitIndex = columnIndex(row, ['WAGE_UNIT_OF_PAY', 'PW_UNIT_OF_PAY']);
      if (employerIndex < 0) throw new Error('Could not find employer name column');
      continue;
    }
    dataRows += 1;
    const resolution = resolver.resolve(row[employerIndex]);
    if (!resolution.matched) continue;
    if (resolution.confidence < MIN_MATCH_CONFIDENCE) {
      // Near-miss: surface it so the user can add an alias, don't silently count it
      weakMatches.set(resolution.normalized, resolution.matched.id);
      continue;
    }
    const employer = resolution.matched;
    const status = String(row[statusIndex] || '').toUpperCase();
    if (statusIndex >= 0 && !status.includes('CERTIFIED')) continue;
    if (dateIndex >= 0 && !isRecent(row[dateIndex])) continue;

    const current = signals[employer.id] || {
      employer_id: employer.id,
      certified_count_3y: 0,
      recent_titles: [],
      title_classes: {},
      source: path.basename(csvPath),
      imported_at: new Date().toISOString()
    };
    current.certified_count_3y += 1;
    const title = String(row[titleIndex] || '').trim();
    if (title && !current.recent_titles.includes(title) && current.recent_titles.length < 12) {
      current.recent_titles.push(title);
    }

    // Per title-class evidence: this is the job-relevant signal — "37 postdoc
    // LCAs" means something to a postdoc applicant that "194 LCAs" does not
    const titleClass = classifyTitle(title, socIndex >= 0 ? row[socIndex] : null);
    const bucket = current.title_classes[titleClass] || { certified_count_3y: 0, wages: [], sample_titles: [] };
    bucket.certified_count_3y += 1;
    const wage = annualWage(wageIndex >= 0 ? row[wageIndex] : null, wageUnitIndex >= 0 ? row[wageUnitIndex] : 'Year');
    if (wage) bucket.wages.push(wage);
    if (title && bucket.sample_titles.length < 5 && !bucket.sample_titles.includes(title)) {
      bucket.sample_titles.push(title);
    }
    current.title_classes[titleClass] = bucket;
    signals[employer.id] = current;
  }

  if (!headerSeen || dataRows === 0) throw new Error('CSV file has no data rows');

  // Collapse wage arrays into medians before writing
  for (const signal of Object.values(signals)) {
    for (const bucket of Object.values(signal.title_classes || {})) {
      bucket.median_annual_wage = median(bucket.wages);
      delete bucket.wages;
    }
  }

  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.writeFile(OUT_PATH, `${JSON.stringify(signals, null, 2)}\n`, 'utf8');
  console.log(`Imported DOL sponsor signals for ${Object.keys(signals).length} employers`);
  if (weakMatches.size) {
    console.log('Near-miss employer names (add an alias to employers.json to count them):');
    for (const [name, employerId] of weakMatches) {
      console.log(`  "${name}" ~ ${employerId}`);
    }
  }
}

if (require.main === module) {
  const csvPath = process.argv[2];
  if (!csvPath) {
    console.error('Usage: node radar/scripts/import-dol-lca.js path/to/LCA_Disclosure_Data.csv');
    process.exit(1);
  }
  importDolCsv(path.resolve(csvPath)).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { importDolCsv, normalizeName, parseCsvLine, annualWage, median };
