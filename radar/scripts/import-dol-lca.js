#!/usr/bin/env node

const fs = require('fs/promises');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const RADAR_DIR = path.join(ROOT, 'radar');
const DATA_DIR = path.join(RADAR_DIR, 'data');
const EMPLOYERS_PATH = path.join(RADAR_DIR, 'employers.json');
const OUT_PATH = path.join(DATA_DIR, 'dol-sponsor-signals.json');

function normalizeName(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/&/g, ' AND ')
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\b(THE|INC|LLC|LTD|CORP|CORPORATION|CO|COMPANY)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseCsvLine(line) {
  const out = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];
    if (char === '"' && quoted && next === '"') {
      current += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
      out.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  out.push(current);
  return out;
}

function columnIndex(headers, candidates) {
  const normalized = headers.map((header) => header.toUpperCase().replace(/[^A-Z0-9]+/g, '_'));
  for (const candidate of candidates) {
    const index = normalized.indexOf(candidate);
    if (index >= 0) return index;
  }
  return -1;
}

function isRecent(value) {
  if (!value) return true;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return true;
  const threeYearsAgo = new Date();
  threeYearsAgo.setFullYear(threeYearsAgo.getFullYear() - 3);
  return date >= threeYearsAgo;
}

function matchEmployer(rowEmployerName, employers) {
  const normalizedRow = normalizeName(rowEmployerName);
  if (!normalizedRow) return null;
  return employers.find((employer) => {
    const normalizedEmployer = normalizeName(employer.name);
    return normalizedRow === normalizedEmployer ||
      normalizedRow.includes(normalizedEmployer) ||
      normalizedEmployer.includes(normalizedRow);
  }) || null;
}

async function importDolCsv(csvPath) {
  const employers = JSON.parse(await fs.readFile(EMPLOYERS_PATH, 'utf8'));
  const csv = await fs.readFile(csvPath, 'utf8');
  const lines = csv.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) throw new Error('CSV file has no data rows');

  const headers = parseCsvLine(lines[0]);
  const employerIndex = columnIndex(headers, ['EMPLOYER_NAME', 'EMPLOYER_LEGAL_BUSINESS_NAME', 'EMPLOYER_BUSINESS_DBA']);
  const statusIndex = columnIndex(headers, ['CASE_STATUS', 'CASESTATUS']);
  const titleIndex = columnIndex(headers, ['JOB_TITLE', 'SOC_TITLE']);
  const dateIndex = columnIndex(headers, ['DECISION_DATE', 'CASE_SUBMITTED', 'RECEIVED_DATE']);

  if (employerIndex < 0) throw new Error('Could not find employer name column');

  const signals = {};
  for (const line of lines.slice(1)) {
    const row = parseCsvLine(line);
    const employer = matchEmployer(row[employerIndex], employers);
    if (!employer) continue;
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

  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(OUT_PATH, `${JSON.stringify(signals, null, 2)}\n`, 'utf8');
  console.log(`Imported DOL sponsor signals for ${Object.keys(signals).length} employers`);
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
