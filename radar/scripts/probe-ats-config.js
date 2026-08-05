#!/usr/bin/env node

/**
 * Resolve the ats_config the new adapters need before an employer can be
 * promoted.
 *
 * Discovery finds the platform and the tenant, and for Greenhouse or Lever that
 * is the whole config. The three providers wired up here each need one more
 * value that no crawl captured, and that cannot be guessed:
 *
 *   csod         ats_config.site_id     — the career site number. NOT uniformly
 *                                         1: measured 2 (Boston College), 2
 *                                         (Wayne State), 5 (Idaho State), 1
 *                                         (Southern Miss), 4 (Arizona).
 *   oracle       ats_config.site_number — "CX", "CX_1", "CX_1001", … A tenant
 *                                         commonly publishes several, and only
 *                                         one is the live external board.
 *   icims        (none)                 — the tenant alone is enough, but the
 *                                         crawl also recorded the vendor's own
 *                                         marketing hosts (www, www2) and
 *                                         internal boards that 403, so each
 *                                         tenant still has to be confirmed to
 *                                         serve postings.
 *
 * For every candidate this probes the live board, keeps the variant carrying
 * the most postings, and writes the result to radar/data/ats-config-probe.json.
 * It never edits the registry — promotion stays a separate, deliberate step.
 *
 * Usage:
 *   node radar/scripts/probe-ats-config.js [--provider csod|oracle|icims]
 *                                          [--limit N] [--include-registered]
 */

const fsp = require('fs/promises');
const path = require('path');

const {
  csodBootstrap,
  csodAuthHeaders,
  fetchJson,
  parseSitemapUrls,
  runPooled
} = require('./refresh.js');

const DISCOVERY_PATH = path.resolve(__dirname, '../data/ats-discovery.json');
const REGISTRY_PATH = path.resolve(__dirname, '../employers.json');
const OUTPUT_PATH = path.resolve(__dirname, '../data/ats-config-probe.json');

// Cornerstone site numbers observed live are all small; 8 covers every tenant
// measured here with room to spare.
const CSOD_SITE_IDS = [1, 2, 3, 4, 5, 6, 7, 8];
// The crawl recorded the vendor's own hosts alongside real customer tenants.
const ICIMS_TENANT_BLOCKLIST = new Set(['www', 'www2', 'careers', 'icims']);
const PROBE_CONCURRENCY = 4;

function parseArgs(argv) {
  const args = { provider: null, limit: Infinity, includeRegistered: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--provider') args.provider = argv[i + 1];
    if (argv[i] === '--limit') args.limit = Number(argv[i + 1]) || Infinity;
    if (argv[i] === '--include-registered') args.includeRegistered = true;
  }
  return args;
}

function normalizeName(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// ── csod ───────────────────────────────────────────────────────────────────
// Every site number is a separate career site with its own postings, so the
// count is the only way to tell the live external board from the leftovers.
async function probeCsod(tenant) {
  const variants = [];
  for (const siteId of CSOD_SITE_IDS) {
    try {
      const employer = { ats_token: tenant, ats_config: { site_id: siteId } };
      const auth = await csodBootstrap(employer);
      const payload = await fetchJson(
        `https://${tenant}.csod.com/services/x/career-site/v1/search?c=${encodeURIComponent(tenant)}`,
        {
          method: 'POST',
          headers: csodAuthHeaders(auth),
          body: { cultureName: 'en-US', careerSiteId: siteId, pageNumber: 1, pageSize: 1 }
        }
      );
      const total = Number(payload.data?.totalCount || 0);
      if (total > 0) variants.push({ site_id: siteId, jobs: total });
    } catch {
      // A site number that does not exist answers with a redirect or a shell
      // page carrying no token. That is the normal case for most of the range,
      // not an error worth reporting.
    }
  }
  variants.sort((a, b) => b.jobs - a.jobs);
  if (!variants.length) return null;
  return {
    ats_provider: 'csod',
    ats_token: tenant,
    ats_config: { site_id: variants[0].site_id },
    jobs_found: variants[0].jobs,
    other_sites: variants.slice(1)
  };
}

// ── oracle ─────────────────────────────────────────────────────────────────
// recruitingCESites lists every candidate-experience site on the tenant with
// the SiteNumber the existing Oracle adapter already takes.
async function probeOracle(host) {
  const rest = `https://${host}/hcmRestApi/resources/latest`;
  const sites = await fetchJson(`${rest}/recruitingCESites?onlyData=true`);
  const variants = [];
  for (const site of sites.items || []) {
    const siteNumber = site.SiteNumber;
    if (!siteNumber) continue;
    try {
      const payload = await fetchJson(
        `${rest}/recruitingCEJobRequisitions?onlyData=true`
        + `&finder=findReqs;siteNumber=${encodeURIComponent(siteNumber)},limit=1,offset=0`
      );
      const total = Number((payload.items || [])[0]?.TotalJobsCount || 0);
      if (total > 0) variants.push({ site_number: siteNumber, site_name: site.SiteCode || siteNumber, jobs: total });
    } catch {
      // A configured-but-dead site answers 400/404; skip it.
    }
  }
  variants.sort((a, b) => b.jobs - a.jobs);
  if (!variants.length) return null;
  const best = variants[0];
  return {
    // Deliberately 'oracle', not the 'oraclecloud' the crawl labelled it:
    // oraclecloud IS Oracle CX, and the existing adapter already serves it.
    // The two names were the only thing making these look unreachable.
    ats_provider: 'oracle',
    ats_token: host,
    ats_config: { host, site_name: best.site_name, site_number: best.site_number },
    jobs_found: best.jobs,
    other_sites: variants.slice(1)
  };
}

// ── icims ──────────────────────────────────────────────────────────────────
// The crawl's "tenant" is not always the subdomain: it records `insightglobal`
// for careers-insightglobal.icims.com, so deriving the host from the tenant
// silently probes a hostname that does not exist. Trust the discovered URL.
async function probeIcims(tenant, discoveredHost) {
  if (ICIMS_TENANT_BLOCKLIST.has(tenant)) return null;
  const host = discoveredHost && discoveredHost.endsWith('.icims.com') ? discoveredHost : `${tenant}.icims.com`;
  const token = host.replace(/\.icims\.com$/, '');
  if (ICIMS_TENANT_BLOCKLIST.has(token)) return null;
  let count = 0;
  let route = null;
  try {
    const response = await fetch(`https://${host}/sitemap.xml`, { headers: { accept: 'application/xml' } });
    if (response.ok) {
      const urls = parseSitemapUrls(await response.text())
        .filter((url) => url.includes('/jobs/') && url.split('?')[0].replace(/\/$/, '').endsWith('/job'));
      if (urls.length) {
        count = urls.length;
        route = 'sitemap';
      }
    }
  } catch {
    // Fall through to the search route.
  }
  if (!count) {
    try {
      const response = await fetch(`https://${host}/jobs/search?ss=1&in_iframe=1&pr=0`, { headers: { accept: 'text/html' } });
      if (response.ok) {
        const paths = new Set(String(await response.text()).match(/\/jobs\/\d+\/[^"'<>?\s]*?\/job/g) || []);
        if (paths.size) {
          count = paths.size; // first page only — a floor, not the total
          route = 'search';
        }
      }
    } catch {
      // Neither route served postings; reported as unreachable below.
    }
  }
  if (!route) return null;
  return {
    ats_provider: 'icims',
    ats_token: token,
    // The adapter derives the host from the token; carry an explicit host only
    // when the two would disagree.
    ats_config: host === `${token}.icims.com` ? {} : { host },
    jobs_found: count,
    route
  };
}

function collectCandidates(discovery, registry, args) {
  const registered = new Set(registry.map((employer) => normalizeName(employer.name)));
  const employers = Array.isArray(discovery.employers) ? discovery.employers : Object.values(discovery.employers || {});
  const wanted = args.provider ? [args.provider] : ['csod', 'oraclecloud', 'icims'];
  const candidates = [];

  for (const employer of employers) {
    if (!args.includeRegistered && registered.has(normalizeName(employer.name))) continue;
    const byProvider = new Map();
    for (const detection of employer.ats || []) {
      const provider = detection.provider === 'oracle' ? 'oraclecloud' : detection.provider;
      if (!wanted.includes(provider) || !detection.tenant) continue;
      if (!byProvider.has(provider)) byProvider.set(provider, detection);
    }
    for (const [provider, detection] of byProvider) {
      candidates.push({
        name: employer.name,
        website: employer.website,
        careers_url: employer.careers_url,
        provider,
        tenant: detection.tenant,
        // oraclecloud identifies the tenant by host, not by a short token.
        host: (() => {
          try {
            return new URL(detection.url).host;
          } catch {
            return detection.tenant;
          }
        })()
      });
    }
  }
  return candidates.slice(0, args.limit);
}

async function probeCandidate(candidate) {
  if (candidate.provider === 'csod') return probeCsod(candidate.tenant);
  if (candidate.provider === 'oraclecloud') return probeOracle(candidate.host);
  if (candidate.provider === 'icims') return probeIcims(candidate.tenant, candidate.host);
  return null;
}

/**
 * Collapse the results to one row per distinct feed.
 *
 * Chains and systems point many "employers" at a single board: 44 Empire Beauty
 * School locations share one Cornerstone site, 14 Arizona College campuses and
 * 8 Concorde campuses share one iCIMS tenant, and three University of Tennessee
 * entries share one Oracle site. Promoted per-row, each of those would ingest
 * the same postings once per campus.
 *
 * Tokens are compared case-insensitively because the crawl records both:
 * East Stroudsburg arrived as `ESU` and the Pennsylvania State System as `esu`
 * — one board, two rows, and nothing else to tell them apart.
 */
function groupByFeed(results) {
  const feeds = new Map();
  for (const entry of results) {
    const key = [
      entry.ats_provider,
      String(entry.ats_token).toLowerCase(),
      JSON.stringify(entry.ats_config || {})
    ].join('|');
    if (!feeds.has(key)) {
      feeds.set(key, {
        ats_provider: entry.ats_provider,
        ats_token: entry.ats_token,
        ats_config: entry.ats_config || {},
        jobs_found: entry.jobs_found,
        route: entry.route,
        other_sites: entry.other_sites,
        claimed_by: []
      });
    }
    const feed = feeds.get(key);
    feed.jobs_found = Math.max(feed.jobs_found, entry.jobs_found);
    feed.claimed_by.push({ name: entry.name, careers_url: entry.careers_url });
  }
  return [...feeds.values()]
    .map((feed) => ({
      ...feed,
      employer_count: feed.claimed_by.length,
      // More than one claimant is a judgement call, not a fact the probe can
      // settle: someone has to decide which entity owns the board.
      needs_owner_decision: feed.claimed_by.length > 1
    }))
    .sort((a, b) => b.jobs_found - a.jobs_found);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [discovery, registry] = await Promise.all([
    fsp.readFile(DISCOVERY_PATH, 'utf8').then(JSON.parse),
    fsp.readFile(REGISTRY_PATH, 'utf8').then(JSON.parse)
  ]);
  const registryList = Array.isArray(registry) ? registry : registry.employers;
  const candidates = collectCandidates(discovery, registryList, args);
  console.log(`Probing ${candidates.length} candidate feed(s)…`);

  const results = [];
  await runPooled(candidates, async (candidate) => {
    let resolved = null;
    let error = null;
    try {
      resolved = await probeCandidate(candidate);
    } catch (probeError) {
      error = probeError.message;
    }
    if (resolved) {
      results.push({ name: candidate.name, careers_url: candidate.careers_url, ...resolved });
      console.log(`  ok    ${candidate.provider.padEnd(12)} ${candidate.name.slice(0, 40).padEnd(40)} ${resolved.jobs_found} jobs`);
    } else {
      console.log(`  none  ${candidate.provider.padEnd(12)} ${candidate.name.slice(0, 40).padEnd(40)} ${error || 'no site with postings'}`);
    }
  }, { concurrency: PROBE_CONCURRENCY, groupOf: (candidate) => candidate.provider, perProvider: PROBE_CONCURRENCY });

  const feeds = groupByFeed(results);
  const byProvider = feeds.reduce((totals, entry) => {
    totals[entry.ats_provider] = (totals[entry.ats_provider] || 0) + 1;
    return totals;
  }, {});

  await fsp.writeFile(OUTPUT_PATH, `${JSON.stringify({
    schema_version: 1,
    // Stamped by the caller's clock; this script performs no other time logic.
    probed_at: new Date().toISOString(),
    candidates_probed: candidates.length,
    employer_rows_resolved: results.length,
    feeds: feeds
  }, null, 2)}\n`);

  const shared = feeds.filter((feed) => feed.needs_owner_decision);
  console.log(`\nResolved ${results.length} of ${candidates.length} employer rows`);
  console.log(`Distinct feeds: ${feeds.length} ${JSON.stringify(byProvider)}`);
  if (shared.length) {
    console.log(`${shared.length} feed(s) claimed by more than one employer — pick an owner before promoting:`);
    for (const feed of shared) {
      console.log(`  ${feed.ats_provider} ${feed.ats_token} — ${feed.employer_count} rows, e.g. ${feed.claimed_by[0].name}`);
    }
  }
  console.log(`Wrote ${path.relative(process.cwd(), OUTPUT_PATH)}`);
  console.log('Nothing was added to the registry — review the file, then promote.');
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { collectCandidates, probeCsod, probeOracle, probeIcims, normalizeName, groupByFeed };
