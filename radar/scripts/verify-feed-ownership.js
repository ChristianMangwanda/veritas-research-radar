#!/usr/bin/env node

/**
 * The gate a candidate feed must pass before it can reach the registry.
 *
 * Discovery proposes an owner by matching a name; this samples what the feed
 * actually serves and asks whether those postings belong to that employer. The
 * scoring lives in lib/feed-ownership.js — this script is the part that knows
 * where employers really are (IPEDS for colleges, IRS EO BMF for nonprofits,
 * both already cached on disk by radar:enrich) and how to pull a small sample
 * of jobs without fetching a whole board.
 *
 * It writes radar/data/feed-ownership.json and edits nothing else. A confirmed
 * feed is a feed a human may now promote; it is not a promotion.
 *
 * Usage:
 *   node radar/scripts/verify-feed-ownership.js [--sample N] [--host x.taleo.net]
 */

const fsp = require('fs/promises');
const path = require('path');

const { fetchJson, fetchText, parseTaleoDetailPage, mapTaleoJob } = require('./refresh.js');
const { scoreFeedOwnership } = require('./lib/feed-ownership.js');
const { extractZipEntry } = require('./lib/zip.js');
const { parseCsv, columnIndex } = require('./lib/csv.js');
const { normalizeName } = require('./lib/entity-resolution.js');

const DATA_DIR = path.resolve(__dirname, '../data');
const CACHE_DIR = path.join(DATA_DIR, 'enrichment-cache');
const PROBE_PATH = path.join(DATA_DIR, 'taleo-sections-probe.json');
const DIRECTORY_PATH = path.join(DATA_DIR, 'cap-exempt-directory.json');
const OUTPUT_PATH = path.join(DATA_DIR, 'feed-ownership.json');

const TZ_HEADERS = { tz: 'GMT-05:00', tzname: 'America/Chicago' };
const DEFAULT_SAMPLE = 8;

function parseArgs(argv) {
  const args = { sample: DEFAULT_SAMPLE, host: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--sample') args.sample = Number(argv[++i]);
    else if (argv[i] === '--host') args.host = argv[++i];
  }
  return args;
}

/**
 * Where employers actually are. The directory carries unitid/ein but not place,
 * so join back to the source files radar:enrich already downloaded — IPEDS
 * HD####.zip for institutions, the IRS EO BMF extracts for nonprofits.
 */
async function loadPlaces() {
  const byUnitid = new Map();
  const byEin = new Map();

  const zips = (await fsp.readdir(CACHE_DIR)).filter((f) => /^HD\d{4}\.zip$/i.test(f)).sort().reverse();
  if (zips.length) {
    const buffer = await fsp.readFile(path.join(CACHE_DIR, zips[0]));
    let entry = null;
    try {
      entry = extractZipEntry(buffer, (name) => /\.csv$/i.test(name));
    } catch (error) {
      console.warn(`  IPEDS zip unreadable (${error.message}) — institution places unavailable`);
    }
    if (entry) {
      const rows = parseCsv(entry.toString('latin1'));
      const headers = rows[0] || [];
      const idx = {
        unitid: columnIndex(headers, ['UNITID']),
        city: columnIndex(headers, ['CITY']),
        state: columnIndex(headers, ['STABBR'])
      };
      for (const row of rows.slice(1)) {
        const unitid = String(row[idx.unitid] || '').trim();
        if (unitid) {
          byUnitid.set(unitid, {
            city: String(row[idx.city] || '').trim(),
            state: String(row[idx.state] || '').trim()
          });
        }
      }
    }
  }

  for (const file of (await fsp.readdir(CACHE_DIR)).filter((f) => /^eo\d\.csv$/i.test(f))) {
    const rows = parseCsv(await fsp.readFile(path.join(CACHE_DIR, file), 'latin1'));
    const headers = rows[0] || [];
    const idx = {
      ein: columnIndex(headers, ['EIN']),
      city: columnIndex(headers, ['CITY']),
      state: columnIndex(headers, ['STATE'])
    };
    if (idx.ein < 0) continue;
    for (const row of rows.slice(1)) {
      const ein = String(row[idx.ein] || '').trim();
      if (ein) {
        byEin.set(ein, {
          city: String(row[idx.city] || '').trim(),
          state: String(row[idx.state] || '').trim()
        });
      }
    }
  }

  return { byUnitid, byEin };
}

function resolveEmployer(name, directory, places) {
  const entry = directory[normalizeName(name)];
  if (!entry) return { name, city: null, state: null, website: null, resolved: false };
  const place = (entry.unitid && places.byUnitid.get(entry.unitid))
    || (entry.ein && places.byEin.get(entry.ein))
    || {};
  return {
    name: entry.name || name,
    city: place.city || null,
    state: place.state || null,
    website: entry.website || null,
    resolved: Boolean(place.city || place.state)
  };
}

/** A handful of real postings, with descriptions — not the whole board. */
async function sampleTaleoJobs(host, section, limit) {
  const payload = await fetchJson(
    `https://${host}/careersection/rest/jobboard/searchjobs?lang=en&portal=${encodeURIComponent(section.portal)}`,
    {
      method: 'POST',
      headers: TZ_HEADERS,
      body: {
        multilineEnabled: false,
        sortingSelection: { sortBySelectionParam: '3', ascendingSortingOrder: 'false' },
        fieldData: { fields: { KEYWORD: '', JOB_TITLE: '' }, valid: true },
        filterSelectionParam: { searchFilterSelections: [] },
        advancedSearchFiltersSelectionParam: { searchFilterSelections: [] },
        pageNo: 1
      }
    }
  );
  const requisitions = (payload.requisitionList || []).slice(0, limit);
  const employer = { id: 'sample', ats_token: 'sample', ats_config: { host } };
  const jobs = [];
  for (const item of requisitions) {
    let detail = null;
    try {
      const html = await fetchText(
        `https://${host}/careersection/${section.code}/jobdetail.ftl`
        + `?job=${encodeURIComponent(item.jobId)}&lang=en`,
        { headers: { ...TZ_HEADERS, accept: 'text/html' } }
      );
      detail = parseTaleoDetailPage(html);
    } catch { /* a missing description just weakens the sample */ }
    jobs.push(mapTaleoJob(item, detail, employer, section));
  }
  return jobs;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const probe = JSON.parse(await fsp.readFile(PROBE_PATH, 'utf8'));
  const directory = JSON.parse(await fsp.readFile(DIRECTORY_PATH, 'utf8')).entries;

  process.stdout.write('Loading IPEDS + IRS locations… ');
  const places = await loadPlaces();
  console.log(`${places.byUnitid.size} institutions, ${places.byEin.size} nonprofits`);

  const candidates = probe.hosts
    .filter((entry) => entry.status === 'readable')
    .filter((entry) => !args.host || entry.host === args.host);

  const results = [];
  for (const entry of candidates) {
    // The crawl may file one host under several names; each claim is judged
    // separately, because at most one of them owns it.
    for (const claimed of entry.claimed_by.length ? entry.claimed_by : ['(unclaimed)']) {
      const employer = resolveEmployer(claimed, directory, places);
      let jobs = [];
      try {
        jobs = await sampleTaleoJobs(entry.host, entry.sections[0], args.sample);
      } catch (error) {
        console.log(`${entry.host} <- ${claimed}: sample failed — ${error.message}`);
        continue;
      }
      // The tenant slug is evidence in its own right: schneider.taleo.net.
      const verdict = scoreFeedOwnership({
        employer, jobs, feedLabel: entry.host.split('.')[0]
      });
      results.push({
        host: entry.host,
        section: entry.sections[0].code,
        claimed_by: claimed,
        employer_place: employer.resolved ? `${employer.city}, ${employer.state}` : null,
        ...verdict
      });

      const mark = { confirmed: 'PASS', rejected: 'FAIL', inconclusive: '  ? ' }[verdict.verdict];
      console.log(`${mark} ${entry.host.padEnd(24)} ${claimed.slice(0, 42).padEnd(43)} ${verdict.reason}`);
      console.log(`       name ${(verdict.signals.name_fraction ?? 0).toFixed(2)}`
        + `  city ${(verdict.signals.city_fraction ?? 0).toFixed(2)}`
        + `  state ${(verdict.signals.state_fraction ?? 0).toFixed(2)}`
        + `  other-org ${verdict.signals.other_org_count ?? 0}`
        + `  usable-loc ${(verdict.signals.usable_location_fraction ?? 0).toFixed(2)}`
        + `  (${employer.city || '?'}, ${employer.state || '?'})`);
      if (verdict.evidence[0]) {
        console.log(`       e.g. ${verdict.evidence[0].signal}: "${verdict.evidence[0].quote.slice(0, 88)}"`);
      }
    }
  }

  const counts = results.reduce((acc, r) => ({ ...acc, [r.verdict]: (acc[r.verdict] || 0) + 1 }), {});
  await fsp.writeFile(OUTPUT_PATH, `${JSON.stringify({
    schema_version: 1,
    generated_at: new Date().toISOString(),
    sample_size: args.sample,
    counts,
    results
  }, null, 2)}\n`);

  console.log(`\n${JSON.stringify(counts)}`);
  console.log(`Wrote ${path.relative(process.cwd(), OUTPUT_PATH)}`);
  console.log('Confirmed feeds are now safe to promote by hand. Nothing was promoted.');
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { resolveEmployer, sampleTaleoJobs, loadPlaces };
