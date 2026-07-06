#!/usr/bin/env node

/**
 * Stage-3 wiring: turn ATS discovery hits into registry entries.
 *
 * For each crawl-discovered employer whose ATS we have an adapter for
 * (Workday first), probe the live feed, confirm it returns real jobs, and
 * draft a registry entry. Identity comes from crawl provenance — the ATS
 * link was harvested from the employer's own website — so this is not blind
 * slug guessing; the probe just proves the feed is alive and finds the site
 * name Workday needs.
 *
 * Usage:
 *   node radar/scripts/promote-employers.js            # probe + write proposals
 *   node radar/scripts/promote-employers.js --approve  # merge proposals into employers.json
 */

const fsp = require('fs/promises');
const path = require('path');

const DATA_DIR = path.resolve(__dirname, '../data');
const DISCOVERY_PATH = path.join(DATA_DIR, 'ats-discovery.json');
const PROPOSALS_PATH = path.join(DATA_DIR, 'registry-proposals.json');
const EMPLOYERS_PATH = path.resolve(__dirname, '../employers.json');
const HOLDS_PATH = path.join(DATA_DIR, 'registry-holds.json');

const WORKDAY_SITE_CANDIDATES = ['External', 'Careers', 'careers', 'jobs', 'External_Career_Site', 'Career', 'externalsite'];
const PROBE_TIMEOUT_MS = 15000;
const PROBE_DELAY_MS = 600;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function slugify(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
}

async function fetchJsonWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: { 'content-type': 'application/json', 'user-agent': 'veritas-research-radar ats probe', ...(options.headers || {}) }
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function probeWorkday(tenant, dc, siteHint) {
  const host = `${tenant}.wd${dc}.myworkdayjobs.com`;
  // The crawled URL sometimes points at a subsection board (athletics, one
  // department) — probe every candidate and keep the site with most postings
  const sites = [...new Set([siteHint, ...WORKDAY_SITE_CANDIDATES].filter(Boolean))];
  let best = null;
  for (const site of sites) {
    const payload = await fetchJsonWithTimeout(
      `https://${host}/wday/cxs/${encodeURIComponent(tenant)}/${encodeURIComponent(site)}/jobs`,
      { method: 'POST', body: JSON.stringify({ appliedFacets: {}, limit: 1, offset: 0, searchText: '' }) });
    await sleep(PROBE_DELAY_MS);
    const total = Number(payload?.total || 0);
    if (total > 0 && (!best || total > best.total_jobs)) {
      best = { host, tenant, site, total_jobs: total };
    }
  }
  return best;
}

async function fetchTextWithTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'user-agent': 'veritas-research-radar ats probe' }
    });
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Generic words carry no identity: "University of X" vs "University of Y"
const GENERIC_NAME_TOKENS = new Set(['UNIVERSITY', 'COLLEGE', 'THE', 'OF', 'AT', 'AND', 'STATE', 'INSTITUTE', 'SCHOOL', 'ALL', 'JOBS', 'CAREERS', 'SYSTEM']);

function distinctiveTokens(name) {
  return String(name || '').toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').split(/\s+/)
    .filter((token) => token.length > 2 && !GENERIC_NAME_TOKENS.has(token));
}

function namesOverlap(a, b) {
  const tokensA = new Set(distinctiveTokens(a));
  return distinctiveTokens(b).some((token) => tokensA.has(token));
}

/**
 * PeopleAdmin probe: the Atom feed's <title> names the institution, which
 * doubles as the identity check — a shared state-wide instance (e.g. a
 * Commonwealth of Virginia board linked from a member school's site) fails
 * the name match and is skipped instead of mislabeled.
 */
async function probePeopleAdmin(tenantOrHost, expectedName) {
  const host = tenantOrHost.includes('.') ? tenantOrHost : `${tenantOrHost}.peopleadmin.com`;
  const xml = await fetchTextWithTimeout(`https://${host}/postings/search.atom`);
  await sleep(PROBE_DELAY_MS);
  if (!xml) return null;
  const totalJobs = (xml.match(/<entry>/g) || []).length;
  const feedTitle = (xml.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
  if (totalJobs === 0) return null;
  if (!namesOverlap(feedTitle, expectedName)) {
    return { mismatch: true, feed_title: feedTitle.trim() };
  }
  return { host, tenant: tenantOrHost, site: null, total_jobs: totalJobs, feed_title: feedTitle.trim() };
}

const WORKDAY_TENANT_PATTERN = /https?:\/\/([a-z0-9-]+)\.wd(\d+)\.myworkdayjobs\.com/i;

// Vanity Workday portals leak the real tenant in their HTML (CXS calls, CDN
// asset URLs); a plain fetch of the portal page is enough to mine it
async function mineWorkdayTenant(url) {
  if (!url || !url.startsWith('http')) return null;
  const html = await fetchTextWithTimeout(url);
  const match = (html || '').match(WORKDAY_TENANT_PATTERN);
  return match ? { tenant: match[1], dc: match[2] } : null;
}

// SmartRecruiters / Workable already have adapters; probing is one GET each.
// Workable's widget response includes the org name — free identity check.
// iCIMS boards are JS-rendered (the weekly scout drives them with a browser),
// but the sitemap is plain XML — a cheap liveness probe with a job count
async function probeIcimsSitemap(tenant) {
  const xml = await fetchTextWithTimeout(`https://${tenant}.icims.com/sitemap.xml`);
  await sleep(PROBE_DELAY_MS);
  if (!xml) return null;
  const total = (xml.match(/\/jobs\/\d+\//g) || []).length;
  return total > 0 ? { tenant, total_jobs: total } : null;
}

async function probeGreenhouse(token) {
  const response = await fetchJsonWithTimeout(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs`);
  await sleep(PROBE_DELAY_MS);
  const total = Array.isArray(response?.jobs) ? response.jobs.length : 0;
  return total > 0 ? { token, total_jobs: total } : null;
}

async function probeLever(token) {
  const response = await fetchJsonWithTimeout(`https://api.lever.co/v0/postings/${encodeURIComponent(token)}?mode=json`);
  await sleep(PROBE_DELAY_MS);
  const total = Array.isArray(response) ? response.length : 0;
  return total > 0 ? { token, total_jobs: total } : null;
}

async function probeAshby(token) {
  const response = await fetchJsonWithTimeout(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(token)}`);
  await sleep(PROBE_DELAY_MS);
  const total = Array.isArray(response?.jobs) ? response.jobs.length : 0;
  return total > 0 ? { token, total_jobs: total } : null;
}

async function probeSmartRecruiters(token) {
  const response = await fetchJsonWithTimeout(`https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(token)}/postings?limit=1`);
  await sleep(PROBE_DELAY_MS);
  const total = Number(response?.totalFound || 0);
  return total > 0 ? { token, total_jobs: total } : null;
}

async function probeWorkable(slug, expectedName) {
  const response = await fetchJsonWithTimeout(`https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(slug)}?details=false`);
  await sleep(PROBE_DELAY_MS);
  if (!response || !Array.isArray(response.jobs)) return null;
  if (response.name && !namesOverlap(response.name, expectedName)) {
    return { mismatch: true, feed_title: response.name };
  }
  return { token: slug, total_jobs: response.jobs.length };
}

function employerType(record) {
  // ipeds unitid => higher ed; otherwise research nonprofit
  return record.kind === 'ipeds' || record.kind === 'both' || record.unitid
    ? 'institution_of_higher_education'
    : 'nonprofit_research_org';
}

async function buildProposals({ includeScoutFallback = false, minEvidence = 0 } = {}) {
  const discovery = JSON.parse(await fsp.readFile(DISCOVERY_PATH, 'utf8'));
  const directory = JSON.parse(await fsp.readFile(path.join(DATA_DIR, 'cap-exempt-directory.json'), 'utf8')).entries;
  const employers = JSON.parse(await fsp.readFile(EMPLOYERS_PATH, 'utf8'));
  const existingTenants = new Set(employers.filter((e) => e.ats_config?.tenant).map((e) => e.ats_config.tenant));
  // Owner-declined tenants stay declined across probe reruns
  let holds = new Set();
  try {
    holds = new Set(JSON.parse(await fsp.readFile(HOLDS_PATH, 'utf8')).holds.map((h) => h.tenant));
  } catch { /* no holds file */ }
  const existingIds = new Set(employers.map((e) => e.id));

  const proposals = [];
  const skipped = [];

  for (const [key, record] of Object.entries(discovery.employers)) {
    const hits = record.ats || [];
    const workdayHit = hits.find((a) => a.provider === 'workday' && a.tenant && !holds.has(a.tenant));
    const peopleAdminHit = hits.find((a) => a.provider === 'peopleadmin' && a.tenant && !holds.has(a.tenant));
    const smartRecruitersHit = hits.find((a) => a.provider === 'smartrecruiters' && a.tenant && !holds.has(a.tenant));
    const greenhouseHit = hits.find((a) => a.provider === 'greenhouse' && a.tenant && !holds.has(a.tenant));
    const leverHit = hits.find((a) => a.provider === 'lever' && a.tenant && !holds.has(a.tenant));
    const ashbyHit = hits.find((a) => a.provider === 'ashby' && a.tenant && !holds.has(a.tenant));
    // Prefer faculty boards; never internal/login boards
    const icimsHits = hits.filter((a) => a.provider === 'icims' && a.tenant
      && !/internal|login/i.test(a.tenant) && !holds.has(a.tenant));
    icimsHits.sort((a, b) => (/faculty/i.test(b.tenant) ? 1 : 0) - (/faculty/i.test(a.tenant) ? 1 : 0));
    const icimsHit = icimsHits[0];
    const workableHit = hits.find((a) => a.provider === 'workable' && a.tenant && !holds.has(a.tenant));
    const paSignature = hits.find((a) => a.provider === 'peopleadmin' && !a.tenant);
    const wdSignature = hits.find((a) => a.provider === 'workday' && !a.tenant);
    const anyHit = workdayHit || peopleAdminHit || smartRecruitersHit || workableHit || greenhouseHit || leverHit || ashbyHit || icimsHit || paSignature || wdSignature;
    if (!anyHit && !(includeScoutFallback && record.careers_url)) continue;

    const id = slugify(record.name);
    if (existingIds.has(id)) {
      skipped.push({ name: record.name, reason: 'registry id exists' });
      continue;
    }

    let wiring = null;
    if (workdayHit && !existingTenants.has(workdayHit.tenant)) {
      console.log(`probing workday:${workdayHit.tenant} (${record.name})…`);
      const probe = await probeWorkday(workdayHit.tenant, workdayHit.workday_dc || '5', workdayHit.workday_site);
      if (probe) {
        wiring = {
          ats_provider: 'workday',
          ats_token: probe.tenant,
          ats_config: { host: probe.host, tenant: probe.tenant, site: probe.site },
          total_jobs: probe.total_jobs
        };
      }
    }
    if (!wiring && peopleAdminHit && !existingTenants.has(peopleAdminHit.tenant)) {
      console.log(`probing peopleadmin:${peopleAdminHit.tenant} (${record.name})…`);
      const probe = await probePeopleAdmin(peopleAdminHit.tenant, record.name);
      if (probe?.mismatch) {
        skipped.push({ name: record.name, reason: `peopleadmin feed title "${probe.feed_title}" does not match — likely a shared instance` });
        continue;
      }
      if (probe) {
        wiring = {
          ats_provider: 'peopleadmin',
          ats_token: probe.tenant,
          ats_config: { tenant: probe.tenant },
          total_jobs: probe.total_jobs
        };
      }
    }
    if (!wiring && greenhouseHit && !existingTenants.has(greenhouseHit.tenant)) {
      console.log(`probing greenhouse:${greenhouseHit.tenant} (${record.name})…`);
      const probe = await probeGreenhouse(greenhouseHit.tenant);
      if (probe) wiring = { ats_provider: 'greenhouse', ats_token: probe.token, ats_config: undefined, total_jobs: probe.total_jobs };
    }
    if (!wiring && leverHit && !existingTenants.has(leverHit.tenant)) {
      console.log(`probing lever:${leverHit.tenant} (${record.name})…`);
      const probe = await probeLever(leverHit.tenant);
      if (probe) wiring = { ats_provider: 'lever', ats_token: probe.token, ats_config: undefined, total_jobs: probe.total_jobs };
    }
    if (!wiring && ashbyHit && !existingTenants.has(ashbyHit.tenant)) {
      console.log(`probing ashby:${ashbyHit.tenant} (${record.name})…`);
      const probe = await probeAshby(ashbyHit.tenant);
      if (probe) wiring = { ats_provider: 'ashby', ats_token: probe.token, ats_config: undefined, total_jobs: probe.total_jobs };
    }
    if (!wiring && smartRecruitersHit && !existingTenants.has(smartRecruitersHit.tenant)) {
      console.log(`probing smartrecruiters:${smartRecruitersHit.tenant} (${record.name})…`);
      const probe = await probeSmartRecruiters(smartRecruitersHit.tenant);
      if (probe) {
        wiring = { ats_provider: 'smartrecruiters', ats_token: probe.token, ats_config: undefined, total_jobs: probe.total_jobs };
      }
    }
    if (!wiring && workableHit && !existingTenants.has(workableHit.tenant)) {
      console.log(`probing workable:${workableHit.tenant} (${record.name})…`);
      const probe = await probeWorkable(workableHit.tenant, record.name);
      if (probe?.mismatch) {
        skipped.push({ name: record.name, reason: `workable account "${probe.feed_title}" does not match` });
        continue;
      }
      if (probe) {
        wiring = { ats_provider: 'workable', ats_token: probe.token, ats_config: undefined, total_jobs: probe.total_jobs };
      }
    }
    // Vanity-domain PeopleAdmin: the portal host serves the same Atom feed
    if (!wiring && paSignature) {
      const hostCandidates = [...new Set([paSignature.url, record.careers_url]
        .filter((u) => u && u.startsWith('http'))
        .map((u) => { try { return new URL(u).host; } catch { return null; } })
        .filter((h) => h && !holds.has(h) && !existingTenants.has(h)))];
      for (const host of hostCandidates) {
        console.log(`probing peopleadmin host ${host} (${record.name})…`);
        const probe = await probePeopleAdmin(host, record.name);
        if (probe?.mismatch) {
          skipped.push({ name: record.name, reason: `peopleadmin feed title "${probe.feed_title}" does not match` });
          break;
        }
        if (probe) {
          wiring = { ats_provider: 'peopleadmin', ats_token: probe.host, ats_config: { host: probe.host }, total_jobs: probe.total_jobs };
          break;
        }
      }
    }
    // Vanity Workday: mine the real tenant from the portal HTML, then probe
    if (!wiring && wdSignature) {
      const mined = (await mineWorkdayTenant(wdSignature.url)) || (await mineWorkdayTenant(record.careers_url));
      if (mined && !holds.has(mined.tenant) && !existingTenants.has(mined.tenant)) {
        console.log(`probing mined workday:${mined.tenant} (${record.name})…`);
        const probe = await probeWorkday(mined.tenant, mined.dc || '5', null);
        if (probe) {
          wiring = {
            ats_provider: 'workday',
            ats_token: probe.tenant,
            ats_config: { host: probe.host, tenant: probe.tenant, site: probe.site },
            total_jobs: probe.total_jobs
          };
        }
      }
    }
    // iCIMS: registry entry is scout-covered (ats_provider null); the scout's
    // icims driver renders the board and extracts full descriptions
    if (!wiring && icimsHit && !existingTenants.has(icimsHit.tenant)) {
      console.log(`probing icims sitemap:${icimsHit.tenant} (${record.name})…`);
      const probe = await probeIcimsSitemap(icimsHit.tenant);
      if (probe) {
        wiring = {
          ats_provider: null,
          ats_token: null,
          ats_config: undefined,
          total_jobs: probe.total_jobs,
          icims_board: `https://${probe.tenant}.icims.com/jobs/search?ss=1`
        };
      }
    }
    if (!wiring && includeScoutFallback && record.careers_url && record.careers_url.startsWith('http')) {
      wiring = { ats_provider: null, ats_token: null, ats_config: undefined, total_jobs: 0, scout_fallback: true };
    }
    if (!wiring) {
      skipped.push({ name: record.name, reason: 'no live feed found on probes' });
      continue;
    }

    const dirEntry = directory[key] || {};
    const evidenceScore = (dirEntry.uscis_approvals_3y || 0) + 2 * (dirEntry.dol_certified_3y || 0);
    if (wiring.scout_fallback && evidenceScore < minEvidence) {
      skipped.push({ name: record.name, reason: `scout fallback below evidence threshold (${evidenceScore})` });
      continue;
    }
    proposals.push({
      id,
      name: record.name,
      aliases: [],
      type: employerType(dirEntry),
      cap_exempt_status: 'likely',
      evidence_sources: [
        'ats_discovery_crawl',
        ...(dirEntry.unitid ? [`ipeds:${dirEntry.unitid}`] : []),
        ...(dirEntry.ein ? ['irs_eo_bmf'] : [])
      ],
      tier: 'auto',
      ats_provider: wiring.ats_provider,
      ats_token: wiring.ats_token,
      ats_config: wiring.ats_config,
      careers_url: wiring.icims_board || record.careers_url || record.website,
      research_areas: [],
      notes: `${wiring.icims_board ? 'iCIMS board, scout-driven (browser-rendered; sitemap-verified). ' : ''}${wiring.scout_fallback ? 'Careers-page scout coverage (no machine-readable ATS found). ' : ''}Auto-wired from ATS discovery crawl (${record.crawled_at?.slice(0, 10)}); probe saw ${wiring.total_jobs} live postings. USCIS ${dirEntry.uscis_approvals_3y || 0} approvals / DOL ${dirEntry.dol_certified_3y || 0} research LCAs (3y).`,
      probe_total_jobs: wiring.total_jobs
    });
  }

  await fsp.writeFile(PROPOSALS_PATH, `${JSON.stringify({ generated_at: new Date().toISOString(), proposals, skipped }, null, 2)}\n`, 'utf8');
  console.log(`\n${proposals.length} proposals written to ${path.relative(process.cwd(), PROPOSALS_PATH)} (${skipped.length} skipped)`);
  for (const proposal of proposals) {
    console.log(`  + ${proposal.name} — workday:${proposal.ats_config.tenant}/${proposal.ats_config.site} (${proposal.probe_total_jobs} postings)`);
  }
  for (const skip of skipped) console.log(`  - ${skip.name}: ${skip.reason}`);
}

async function approveProposals() {
  const { proposals } = JSON.parse(await fsp.readFile(PROPOSALS_PATH, 'utf8'));
  const employers = JSON.parse(await fsp.readFile(EMPLOYERS_PATH, 'utf8'));
  const existingIds = new Set(employers.map((e) => e.id));
  let added = 0;
  for (const proposal of proposals) {
    if (existingIds.has(proposal.id)) continue;
    const { probe_total_jobs, ...entry } = proposal;
    employers.push(entry);
    added += 1;
  }
  await fsp.writeFile(EMPLOYERS_PATH, `${JSON.stringify(employers, null, 2)}\n`, 'utf8');
  console.log(`Merged ${added} employers into the registry (${employers.length} total)`);
}

if (require.main === module) {
  const approve = process.argv.includes('--approve');
  const includeScoutFallback = process.argv.includes('--scout-fallback');
  const minEvidenceArg = process.argv.indexOf('--min-evidence');
  const minEvidence = minEvidenceArg >= 0 ? Number(process.argv[minEvidenceArg + 1]) : 0;
  (approve ? approveProposals() : buildProposals({ includeScoutFallback, minEvidence })).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { probeWorkday, slugify, employerType };
