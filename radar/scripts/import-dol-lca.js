#!/usr/bin/env node

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const readline = require('readline');
const { normalizeName, createResolver } = require('./lib/entity-resolution.js');
const { parseCsvLine, csvRecords, columnIndex } = require('./lib/csv.js');

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
      source: path.basename(csvPath),
      imported_at: new Date().toISOString()
    };
    current.certified_count_3y += 1;
    const title = String(row[titleIndex] || '').trim();
    if (title && !current.recent_titles.includes(title) && current.recent_titles.length < 12) {
      current.recent_titles.push(title);
    }
    signals[employer.id] = current;
  }

  if (!headerSeen || dataRows === 0) throw new Error('CSV file has no data rows');

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

module.exports = { importDolCsv, normalizeName, parseCsvLine };
