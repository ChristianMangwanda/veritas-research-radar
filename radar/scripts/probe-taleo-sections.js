#!/usr/bin/env node

/**
 * Enumerate the career sections behind a Taleo Enterprise tenant.
 *
 * Taleo needed no headless browser after all — the REST board answers a plain
 * fetch as long as the request carries a `tz` HEADER. Without it every call is
 * HTTP 500 "An Error Occurred in TEE", which reads exactly like a block and is
 * why this platform sat on the "impossible" list. See refresh.js's TALEO_* notes.
 *
 * What still cannot be guessed is the pair a feed needs:
 *
 *   ats_config.sections[].code    — the career section path segment. Measured
 *                                   values are all over the place: `ext` (UAB),
 *                                   `ex` (SMU), `2`/`3`/`4` (UT Southwestern),
 *                                   `staff`/`faculty` (WVU), `1` (Schneider).
 *   ats_config.sections[].portal  — the portal number the REST call demands.
 *                                   A wrong or missing portal does not error;
 *                                   it answers 200 with careerSectionUnAvailable.
 *
 * A tenant routinely runs SEVERAL sections holding different postings — WVU
 * keeps its postdocs in `faculty`, which a probe stopping at the first hit
 * never sees, and UT Southwestern splits 675 postings across three. So this
 * collects every section it can find rather than the first.
 *
 * It writes radar/data/taleo-sections-probe.json and never edits the registry:
 * the crawl's name attribution is not trustworthy enough to promote from
 * (schneider.taleo.net is filed under a college and serves truck-driver jobs),
 * so promotion stays a separate, deliberate step.
 *
 * Usage:
 *   node radar/scripts/probe-taleo-sections.js [--host uab.taleo.net] [--codes a,b]
 *                                              [--limit N] [--concurrency N]
 */

const fsp = require('fs/promises');
const path = require('path');

const { fetchJson, fetchText, runPooled } = require('./refresh.js');

const DISCOVERY_PATH = path.resolve(__dirname, '../data/ats-discovery.json');
const OUTPUT_PATH = path.resolve(__dirname, '../data/taleo-sections-probe.json');

// Ordered by how often each has been seen in the wild, so the common tenants
// resolve in a couple of requests instead of forty.
const DEFAULT_CODES = [
  'ext', 'ex', 'external', '1', '2', '3', '4', '5', '6', '10',
  'staff', 'faculty', 'facstaff', 'fac', 'student', 'hourly', 'adjunct',
  'main', 'professional', 'classified', 'campus', 'jobs', 'careers',
  'ext1', 'ext_1', 'ext2', 'external1', 'cs', 'cs1', 'med', 'health', 'sysoff'
];

const TZ_HEADERS = { tz: 'GMT-05:00', tzname: 'America/Chicago' };
const SEARCH_BODY = {
  multilineEnabled: false,
  sortingSelection: { sortBySelectionParam: '3', ascendingSortingOrder: 'false' },
  fieldData: { fields: { KEYWORD: '', JOB_TITLE: '' }, valid: true },
  filterSelectionParam: { searchFilterSelections: [] },
  advancedSearchFiltersSelectionParam: { searchFilterSelections: [] },
  pageNo: 1
};

function parseArgs(argv) {
  const args = { codes: DEFAULT_CODES, limit: Infinity, concurrency: 4, host: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--host') args.host = argv[++i];
    else if (arg === '--codes') args.codes = argv[++i].split(',').map((c) => c.trim()).filter(Boolean);
    else if (arg === '--limit') args.limit = Number(argv[++i]);
    else if (arg === '--concurrency') args.concurrency = Number(argv[++i]);
  }
  return args;
}

/** Taleo Enterprise hosts the crawl recorded, deduped, with who claimed each. */
async function collectHosts() {
  const discovery = JSON.parse(await fsp.readFile(DISCOVERY_PATH, 'utf8'));
  const hosts = new Map();
  for (const [name, record] of Object.entries(discovery.employers || {})) {
    for (const entry of record.ats || []) {
      if (entry.provider !== 'taleo') continue;
      const match = /^https?:\/\/([a-z0-9.-]*taleo\.net)/i.exec(entry.url || '');
      // Taleo Business Edition (*.tbe.taleo.net) is a different product with a
      // different API; this probe speaks only Enterprise.
      if (!match || match[1].includes('.tbe.')) continue;
      const host = match[1].toLowerCase();
      if (!hosts.has(host)) hosts.set(host, []);
      hosts.get(host).push(name);
    }
  }
  return [...hosts.entries()].map(([host, claimed_by]) => ({ host, claimed_by }));
}

/** The portal number is only ever published in the career section's own page. */
async function readPortalNo(host, code) {
  const html = await fetchText(`https://${host}/careersection/${code}/jobsearch.ftl?lang=en`, {
    headers: { ...TZ_HEADERS, accept: 'text/html' }
  });
  const match = /portalNo:\s*'(\d+)'/.exec(html);
  return match ? match[1] : null;
}

async function probeSection(host, code) {
  let portal = null;
  try {
    portal = await readPortalNo(host, code);
  } catch (error) {
    // A 404 means this tenant does not use that code — the common case, and the
    // only one worth swallowing. Anything else (a bug in here, a DNS failure)
    // must surface: a blanket catch once reported every host as having no
    // career section because a helper was simply not exported.
    if (error.status) return null;
    throw error;
  }
  if (!portal) return null;

  const payload = await fetchJson(
    `https://${host}/careersection/rest/jobboard/searchjobs?lang=en&portal=${encodeURIComponent(portal)}`,
    { method: 'POST', headers: TZ_HEADERS, body: SEARCH_BODY }
  );
  if (payload.careerSectionUnAvailable) return null;
  const requisitions = payload.requisitionList || [];
  return {
    code,
    portal,
    total: Number((payload.pagingData || {}).totalCount || 0),
    sample_titles: requisitions.slice(0, 3).map((item) => (item.column || [])[0]).filter(Boolean)
  };
}

async function probeHost(entry, codes) {
  const sections = [];
  const seenPortals = new Set();
  for (const code of codes) {
    let section = null;
    try {
      section = await probeSection(entry.host, code);
    } catch (error) {
      // One bad code must not end the tenant's turn, but say so rather than
      // letting a silent skip read as "this tenant has nothing".
      console.warn(`  ${entry.host} ${code}: ${error.message}`);
      continue;
    }
    // Several codes can front the SAME portal; that is one section, not two.
    if (section && !seenPortals.has(section.portal)) {
      seenPortals.add(section.portal);
      sections.push(section);
    }
  }
  const total = sections.reduce((sum, section) => sum + section.total, 0);
  return {
    host: entry.host,
    claimed_by: entry.claimed_by,
    sections,
    total_requisitions: total,
    status: sections.length ? 'readable' : 'no_section_found',
    suggested_ats_config: sections.length
      ? { host: entry.host, sections: sections.map(({ code, portal }) => ({ code, portal })) }
      : null
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const hosts = args.host
    ? [{ host: args.host, claimed_by: [] }]
    : (await collectHosts()).slice(0, args.limit);

  console.log(`Probing ${hosts.length} Taleo Enterprise host(s), ${args.codes.length} candidate code(s) each`);

  const results = await runPooled(hosts, async (entry) => {
    const result = await probeHost(entry, args.codes);
    const label = result.status === 'readable'
      ? `${result.sections.length} section(s), ${result.total_requisitions} postings`
      : 'no career section found';
    console.log(`  ${result.host.padEnd(30)} ${label}`);
    return result;
  }, { concurrency: args.concurrency });

  const readable = results.filter((result) => result.status === 'readable');
  const totalJobs = readable.reduce((sum, result) => sum + result.total_requisitions, 0);

  await fsp.writeFile(OUTPUT_PATH, `${JSON.stringify({
    schema_version: 1,
    generated_at: new Date().toISOString(),
    hosts_probed: results.length,
    hosts_readable: readable.length,
    total_requisitions: totalJobs,
    hosts: results
  }, null, 2)}\n`);

  console.log(`\n${readable.length} of ${results.length} hosts readable, ${totalJobs} requisitions`);
  const multi = readable.filter((result) => result.sections.length > 1);
  if (multi.length) {
    console.log(`${multi.length} tenant(s) run more than one section — wire ALL of them or the extra postings are lost:`);
    for (const result of multi) {
      console.log(`  ${result.host}: ${result.sections.map((s) => `${s.code}(${s.total})`).join(' ')}`);
    }
  }
  console.log(`Wrote ${path.relative(process.cwd(), OUTPUT_PATH)}`);
  console.log('Nothing was added to the registry — the crawl\'s name attribution is not evidence of ownership.');
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { collectHosts, probeHost, probeSection, DEFAULT_CODES };
