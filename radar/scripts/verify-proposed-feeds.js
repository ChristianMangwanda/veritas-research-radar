#!/usr/bin/env node

/**
 * The gate every resolver proposal must pass before it can reach the registry.
 *
 * verify-feed-ownership.js asks the same question of Taleo tenants found by the
 * section probe. This asks it of whatever resolve-employer-ats.js proposed, on
 * any provider, and it does so by running THE REAL ADAPTER — the one the 6-hourly
 * refresh will run — rather than a probe.
 *
 * That distinction is the whole reason this file exists. A probe proves the
 * BOARD has postings; only the adapter proves THIS CONFIG can read them. Nine
 * candidates died on exactly that gap in the previous round: six PageUp
 * employers whose sitemaps list jobs while every detail page answers an AWS WAF
 * challenge. Promoted on probe evidence they would have entered the registry
 * and reported "no openings" forever — an error that produces no error.
 *
 * Two questions, in order, and a proposal has to survive both:
 *
 *   1. can the adapter read it?   run it; count what comes back
 *   2. whose jobs are these?      scoreFeedOwnership over a sample
 *
 * Question 2 is where a resolver proposal is most likely to be wrong, because a
 * research institute's careers link so often points at its parent's board. The
 * Feinstein Institute links Northwell Health's; Dean McGee links OU Medicine's.
 * Both are honest links and neither feed belongs to the institute — promoting
 * them would file a whole health system's postings under a research employer.
 *
 * Writes radar/data/proposed-feed-verification.json. Promotes nothing.
 *
 * Usage:
 *   node radar/scripts/verify-proposed-feeds.js [--sample N] [--name "ORG"]
 */

const fsp = require('fs/promises');
const path = require('path');

const { ATS_FETCHERS } = require('./refresh.js');
const { scoreFeedOwnership } = require('./lib/feed-ownership.js');
const { loadPlaces } = require('./verify-feed-ownership.js');
const { normalizeName } = require('./lib/entity-resolution.js');

const DATA_DIR = path.resolve(__dirname, '../data');
const RESOLUTIONS_PATH = path.join(DATA_DIR, 'ats-resolutions.json');
const DIRECTORY_PATH = path.join(DATA_DIR, 'cap-exempt-directory.json');
const REGISTRY_PATH = path.resolve(__dirname, '../employers.json');
const OUTPUT_PATH = path.join(DATA_DIR, 'proposed-feed-verification.json');

const DEFAULT_SAMPLE = 12;

function parseArgs(argv) {
  const args = { sample: DEFAULT_SAMPLE, name: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--sample') args.sample = Number(argv[++i]);
    else if (argv[i] === '--name') args.name = argv[++i];
  }
  return args;
}

/**
 * What identifies a feed, for telling "we already have this board" from "this
 * is a different board".
 *
 * NOT the token. The token is a label we chose, and the same Ultipro board is
 * `salk` in the registry and `SAL1013SIBS` coming out of the resolver — so a
 * token-based key called Salk a new employer and would have registered its
 * board a second time, double-counting every posting under two names.
 *
 * The config is what the vendor issued, so the config is the identity. Every
 * identifying field joins the key, because one field alone is not enough
 * either way: `site` alone collides ("External" is half of Workday), while
 * `tenant` alone would merge the eight Texas A&M campuses that legitimately
 * share the `tamus` tenant and differ only by site. Boards arrays are left out
 * deliberately — the same board can be discovered with a subset of them.
 */
function feedKey(provider, token, config) {
  const parts = [
    config?.host, config?.tenant, config?.site, config?.site_number,
    config?.agency, config?.cid, config?.client_guid, config?.tenant_id
  ].filter(Boolean).map((value) => String(value).toLowerCase());
  // Greenhouse, Lever and Ashby carry no config at all — for those the token
  // IS what the vendor issued, and it is the only identity available.
  return parts.length ? `${provider}:${parts.join('|')}` : `${provider}:${String(token).toLowerCase()}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const resolutions = JSON.parse(await fsp.readFile(RESOLUTIONS_PATH, 'utf8'));
  const directory = JSON.parse(await fsp.readFile(DIRECTORY_PATH, 'utf8')).entries;
  const registry = JSON.parse(await fsp.readFile(REGISTRY_PATH, 'utf8'));

  const registryNames = new Set();
  const registryFeeds = new Map();
  for (const employer of registry) {
    registryNames.add(normalizeName(employer.name));
    for (const alias of employer.aliases || []) registryNames.add(normalizeName(alias));
    for (const feed of [employer, ...(employer.secondary_ats_feeds || [])]) {
      if (!feed.ats_provider) continue;
      registryFeeds.set(feedKey(feed.ats_provider, feed.ats_token, feed.ats_config), employer.id);
    }
  }

  process.stdout.write('Loading IPEDS + IRS locations… ');
  const places = await loadPlaces();
  console.log(`${places.byUnitid.size} institutions, ${places.byEin.size} nonprofits`);

  const proposals = resolutions.results
    .filter((result) => result.status === 'proposed' && result.suggested_registry_entry)
    .filter((result) => !args.name || result.name === args.name);

  console.log(`${proposals.length} proposal(s) to verify\n`);

  const results = [];
  for (const proposal of proposals) {
    const entry = proposal.suggested_registry_entry;
    const key = normalizeName(proposal.name);
    const dirEntry = directory[key];
    const place = (dirEntry?.unitid && places.byUnitid.get(dirEntry.unitid))
      || (dirEntry?.ein && places.byEin.get(dirEntry.ein))
      || {};

    const record = {
      name: proposal.name,
      provider: entry.ats_provider,
      token: entry.ats_token,
      config: entry.ats_config,
      jobs_found_at_resolve: proposal.jobs_found ?? null,
      employer_place: place.city ? `${place.city}, ${place.state}` : null,
      // Carried through so the promotion step needs only this file — a verdict
      // and the entry it applies to belong together, and re-deriving the entry
      // from a resolutions file that a later run has overwritten is how a
      // confirmed feed gets promoted with stale config.
      suggested_registry_entry: entry
    };

    // Cheap disqualifications first — no point fetching a board we already own
    // or already know belongs to somebody else in the registry.
    const owner = registryFeeds.get(feedKey(entry.ats_provider, entry.ats_token, entry.ats_config));
    if (owner) {
      results.push({ ...record, verdict: 'rejected', reason: `feed already serves ${owner}` });
      console.log(`FAIL ${proposal.name.slice(0, 44).padEnd(46)} feed already serves ${owner}`);
      continue;
    }
    if (registryNames.has(key)) {
      results.push({ ...record, verdict: 'rejected', reason: 'employer already in registry' });
      console.log(`FAIL ${proposal.name.slice(0, 44).padEnd(46)} already in registry`);
      continue;
    }

    // 1 — can the adapter read it?
    const fetcher = ATS_FETCHERS[entry.ats_provider];
    if (!fetcher) {
      results.push({ ...record, verdict: 'rejected', reason: `no adapter for ${entry.ats_provider}` });
      console.log(`FAIL ${proposal.name.slice(0, 44).padEnd(46)} no adapter`);
      continue;
    }
    // The adapter shape the drivers expect. research_areas must be present and
    // empty: several drivers use it to narrow a board, and an absent value
    // reads as "no filter" in some and throws in others.
    const asEmployer = {
      id: entry.id,
      name: proposal.name,
      ats_provider: entry.ats_provider,
      ats_token: entry.ats_token,
      ats_config: entry.ats_config || {},
      research_areas: []
    };

    let jobs = [];
    try {
      jobs = await fetcher(asEmployer);
    } catch (error) {
      results.push({ ...record, verdict: 'rejected', reason: `adapter failed: ${String(error.message).slice(0, 120)}` });
      console.log(`FAIL ${proposal.name.slice(0, 44).padEnd(46)} adapter threw — ${String(error.message).slice(0, 60)}`);
      continue;
    }

    record.adapter_jobs = jobs.length;
    if (!jobs.length) {
      // The failure mode this whole script exists to catch: a board that probes
      // alive and reads empty. Registering it adds an employer that can only
      // ever contribute nothing, and never raises an error while doing it.
      results.push({ ...record, verdict: 'rejected', reason: 'adapter returned no jobs' });
      console.log(`FAIL ${proposal.name.slice(0, 44).padEnd(46)} adapter read 0 jobs`);
      continue;
    }

    // 2 — whose jobs are these?
    const employer = {
      name: proposal.name,
      city: place.city || null,
      state: place.state || null,
      website: proposal.learned_website?.website || proposal.model_answer?.careers_page_url || null
    };
    const verdict = scoreFeedOwnership({
      employer,
      jobs: jobs.slice(0, args.sample),
      feedLabel: String(entry.ats_token).split('.')[0]
    });

    results.push({ ...record, ...verdict });
    const mark = { confirmed: 'PASS', rejected: 'FAIL', inconclusive: '  ? ' }[verdict.verdict];
    console.log(`${mark} ${proposal.name.slice(0, 44).padEnd(46)} ${jobs.length} jobs · ${verdict.reason}`);
    console.log(`       name ${(verdict.signals.name_fraction ?? 0).toFixed(2)}`
      + `  city ${(verdict.signals.city_fraction ?? 0).toFixed(2)}`
      + `  state ${(verdict.signals.state_fraction ?? 0).toFixed(2)}`
      + `  other-org ${verdict.signals.other_org_count ?? 0}`
      + `  (${place.city || '?'}, ${place.state || '?'})`);
    if (verdict.evidence?.[0]) {
      console.log(`       e.g. ${verdict.evidence[0].signal}: "${verdict.evidence[0].quote.slice(0, 88)}"`);
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

module.exports = { feedKey };
