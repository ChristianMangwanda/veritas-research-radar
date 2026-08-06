#!/usr/bin/env node

/**
 * Find the real job board behind an employer the crawl failed, as cheaply as
 * that can be done honestly.
 *
 * The 4,832 "no ATS detected" orgs turned out to hide 153 heavy H-1B sponsors
 * (Penn 631 approvals, Florida 510, UT Austin 430…) that are missing from the
 * registry for a data-quality reason, not a platform reason: the crawl's
 * recorded careers_url is often a student career-services page, an academic
 * program page, or in one case a google.com/search URL. So this resolver is
 * layered, and each layer exists to keep the next one from being paid for:
 *
 *   A  free   re-fetch the recorded careers_url, follow job-shaped links,
 *             detect a known ATS host. Found 29 of 153 in the sample.
 *   B  paid   only when A fails: a web-search model finds the employer's real
 *             careers page. Measured $0.036/org, ~89% of it search-call fees.
 *   C  free   derive/probe the provider config the adapter needs (site ids,
 *             portals, sections) with the existing probe machinery.
 *   D  free   provenance: re-fetch the page that supposedly links the board
 *             and confirm the link is really there ON THE ORG'S OWN DOMAIN.
 *             The model's word is never the evidence; the page is.
 *
 * Every model answer is cached in radar/data/ats-resolve-cache.json keyed by
 * org name — a re-run never pays twice for the same employer. The output,
 * radar/data/ats-resolutions.json, contains suggested registry entries for the
 * ones that survived; it never edits the registry itself.
 *
 * Usage:
 *   node radar/scripts/resolve-employer-ats.js [--min-uscis N] [--limit N]
 *        [--name "EXACT ORG NAME"] [--no-model] [--max-spend USD] [--force]
 */

const fsp = require('fs/promises');
const path = require('path');

const {
  fetchJson, fetchText, ATS_FETCHERS, parseSitemapUrls, parseSuccessFactorsSitemap
} = require('./refresh.js');
const { probeCsod, probeOracle, probeIcims } = require('./probe-ats-config.js');
const { probeHost: probeTaleoHost, DEFAULT_CODES: TALEO_CODES } = require('./probe-taleo-sections.js');
const { readKey } = require('./lib/openai.js');
const { normalizeName } = require('./lib/entity-resolution.js');

const DATA_DIR = path.resolve(__dirname, '../data');
const DISCOVERY_PATH = path.join(DATA_DIR, 'ats-discovery.json');
const DIRECTORY_PATH = path.join(DATA_DIR, 'cap-exempt-directory.json');
const REGISTRY_PATH = path.resolve(__dirname, '../employers.json');
const CACHE_PATH = path.join(DATA_DIR, 'ats-resolve-cache.json');
const OUTPUT_PATH = path.join(DATA_DIR, 'ats-resolutions.json');
const ENV_PATH = path.resolve(__dirname, '../../.env');

const MODEL = process.env.RADAR_RESOLVE_MODEL || 'gpt-5.6-luna';
const WEB_SEARCH_CALL_USD = 0.01;
const PRICE_PER_1M = { input: 0.20, output: 1.20 };

/* Host fragments that give a hosted ATS away. Only providers with a fetcher in
 * ATS_FETCHERS produce a proposal; the rest are still recorded, so the next
 * driver decision starts from data instead of a fresh crawl. */
const ATS_HOST_SIGNS = [
  ['myworkdayjobs.com', 'workday'], ['myworkdaysite.com', 'workday'],
  ['.taleo.net', 'taleo'], ['.icims.com', 'icims'], ['.csod.com', 'csod'],
  ['peopleadmin.com', 'peopleadmin'], ['oraclecloud.com', 'oracle'],
  ['successfactors', 'successfactors'], ['ultipro.com', 'ultipro'],
  ['paylocity.com', 'paylocity'], ['interfolio.com', 'interfolio'],
  ['governmentjobs.com', 'governmentjobs'], ['schooljobs.com', 'governmentjobs'],
  ['greenhouse.io', 'greenhouse'], ['jobs.lever.co', 'lever'],
  ['ashbyhq.com', 'ashby'], ['smartrecruiters.com', 'smartrecruiters'],
  ['recruitee.com', 'recruitee'], ['breezy.hr', 'breezy'],
  ['workable.com', 'workable'], ['pageuppeople.com', 'pageup'],
  ['workforcenow.adp.com', 'adp'], ['eightfold.ai', 'eightfold'],
  ['cornerstoneondemand', 'csod'], ['neogov.com', 'governmentjobs'],
  // seen, but no driver exists — recorded for the record, never proposed
  ['brassring.com', 'brassring'], ['jobvite.com', 'jobvite'],
  ['dayforcehcm.com', 'dayforce'], ['avature.net', 'avature'],
  ['clearcompany.com', 'clearcompany'], ['bamboohr.com', 'bamboohr'],
  ['applicantpro.com', 'applicantpro'], ['paycomonline.net', 'paycom'],
  ['jazz.co', 'jazzhr'], ['applytojob.com', 'jazzhr'], ['paycor.com', 'paycor'],
  ['phenompeople', 'phenom'], ['silkroad.com', 'silkroad'],
  ['isolvedhire.com', 'isolved'], ['hirebridge.com', 'hirebridge']
];

/* PeopleSoft self-service career sites have no vendor host to match — they run
 * on the university's own domain and are identifiable only by their URL shape
 * (/psp/ or /psc/ with the HRS_HRAM job-application component). Checked before
 * the host list so a page mentioning Oracle is not filed under Oracle CX. */
const PEOPLESOFT_URL = /\/(psp|psc)\/[a-z0-9_]+\/(employee|candidate)/i;

function parseArgs(argv) {
  const args = { minUscis: 10, limit: Infinity, name: null, noModel: false, maxSpend: 8, force: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--min-uscis') args.minUscis = Number(argv[++i]);
    else if (argv[i] === '--limit') args.limit = Number(argv[++i]);
    else if (argv[i] === '--name') args.name = argv[++i];
    else if (argv[i] === '--no-model') args.noModel = true;
    else if (argv[i] === '--max-spend') args.maxSpend = Number(argv[++i]);
    else if (argv[i] === '--force') args.force = true;
  }
  return args;
}

/** "hr.upenn.edu" and "www.upenn.edu" are the same place for provenance. */
function registrableDomain(urlOrHost) {
  const host = String(urlOrHost || '')
    .replace(/^https?:\/\//i, '').split('/')[0].toLowerCase();
  const labels = host.split('.').filter(Boolean);
  return labels.length <= 2 ? labels.join('.') : labels.slice(-2).join('.');
}

function absolutize(link, baseUrl) {
  if (!link) return null;
  if (/^https?:\/\//i.test(link)) return link;
  if (link.startsWith('//')) return `https:${link}`;
  const root = /^(https?:\/\/[^/]+)/.exec(baseUrl);
  if (!root) return null;
  return root[1] + (link.startsWith('/') ? link : `/${link}`);
}

function detectAts(html, finalUrl) {
  const haystack = `${html}\n${finalUrl}`;
  if (PEOPLESOFT_URL.test(finalUrl)) {
    return { provider: 'peoplesoft', evidence_url: finalUrl, fragment: 'peoplesoft_url' };
  }
  for (const [fragment, provider] of ATS_HOST_SIGNS) {
    if (!haystack.toLowerCase().includes(fragment)) continue;
    // Pull a concrete URL containing the fragment so config derivation has
    // something to parse — the fragment alone names a vendor, not a tenant.
    const escaped = fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(
      `https?://[a-z0-9.-]*${escaped}[a-z0-9._~:/?#@!$&'()*+,;=%-]*`, 'i'
    ).exec(haystack);
    return { provider, evidence_url: match ? match[0].replace(/["'<>].*$/, '') : null, fragment };
  }
  return null;
}

/* Careers pages block the radar's honest bot UA often enough to matter — the
 * Python sampling pass ran as a browser and found ATS links this script then
 * could not reproduce. Detection has to see what a person sees. */
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * Some university hosts (hr.upenn.edu, all subdomains) serve an incomplete TLS
 * chain: browsers quietly fetch the missing intermediate, Node refuses. For a
 * read-only DETECTION fetch that refusal only costs coverage, so retry those
 * specific failures without verification and say so in the result. Configs
 * derived this way still point at the ATS vendor's own host, which carries a
 * valid chain — nothing insecure is ever written for the driver to use.
 */
function insecureGet(url, redirectsLeft = 3) {
  return new Promise((resolve, reject) => {
    const https = require('https');
    const request = https.get(url, {
      rejectUnauthorized: false,
      headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': BROWSER_UA },
      timeout: 20000
    }, (response) => {
      const { statusCode, headers } = response;
      if ([301, 302, 303, 307, 308].includes(statusCode) && headers.location && redirectsLeft > 0) {
        response.resume();
        resolve(insecureGet(absolutize(headers.location, url), redirectsLeft - 1));
        return;
      }
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { if (body.length < 800000) body += chunk; });
      response.on('end', () => resolve({ statusCode, body }));
    });
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', reject);
  });
}

async function fetchPage(url) {
  try {
    const html = await fetchText(url, {
      headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': BROWSER_UA }
    });
    return { ok: true, html, finalUrl: url };
  } catch (error) {
    if (/UNABLE_TO_VERIFY|CERT_|certificate/i.test(`${error.message} ${error.cause?.code || ''}`)) {
      try {
        const response = await insecureGet(url);
        if (response.statusCode === 200) {
          return { ok: true, html: response.body, finalUrl: url, tls_incomplete_chain: true };
        }
        return { ok: false, error: `HTTP ${response.statusCode} (insecure retry)` };
      } catch (retryError) {
        return { ok: false, error: retryError.message };
      }
    }
    return { ok: false, error: error.message };
  }
}

/**
 * Which links off a careers landing page are worth following? Judged by anchor
 * TEXT as much as URL: UT Austin's board sits behind hr.utexas.edu/prospective
 * — a URL that says nothing, under a link that says "staff jobs". URL-pattern
 * matching alone walked straight past it.
 */
function candidateLinks(html, baseUrl) {
  const scored = [];
  for (const match of html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]{0,200}?)<\/a>/gi)) {
    const link = absolutize(match[1], baseUrl);
    if (!link || /\.(pdf|jpg|png|svg|css|js)([?#]|$)/i.test(link)) continue;
    if (registrableDomain(link) === 'google.com') continue;
    const text = match[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
    const target = `${link.toLowerCase()} ${text}`;
    let score = 0;
    if (/^https?:\/\/(hr|jobs|careers|employment|work(day)?|talent)[.-]/i.test(link)) score += 3;
    if (/staff|faculty|employment|job|career|prospective|join|opportunit|work (at|for|with)/.test(target)) score += 2;
    if (/student (job|career|employment)|career (services|center|pathway|coach|fair)|advising|internship/.test(target)) score -= 3;
    if (score >= 2) scored.push({ link, score });
  }
  const seen = new Set();
  return scored
    .sort((a, b) => b.score - a.score)
    .filter(({ link }) => !seen.has(link) && seen.add(link))
    .map(({ link }) => link);
}

/** Stage A: what the recorded page (and one hop past it) actually links. */
async function freeDetect(record) {
  const startUrl = record.careers_url || record.website;
  if (!startUrl || !/^https?:\/\//i.test(startUrl)) return { status: 'no_url' };
  const page = await fetchPage(startUrl);
  if (!page.ok) return { status: 'unreachable', detail: page.error, tried: startUrl };

  const direct = detectAts(page.html, startUrl);
  if (direct) return { status: 'found', ...direct, found_on: startUrl };

  for (const link of candidateLinks(page.html, startUrl).slice(0, 4)) {
    const hop = await fetchPage(link);
    if (!hop.ok) continue;
    const found = detectAts(hop.html, link);
    if (found) return { status: 'found', ...found, found_on: startUrl, via: link };
  }
  return { status: 'no_ats_on_page', page_url: startUrl };
}

/** "Workday Recruiting", "Oracle Taleo", "NEOGOV" → the provider key we use. */
function normalizePlatform(label, evidenceUrl) {
  if (!label) return null;
  const text = label.toLowerCase();
  const MAP = [
    // ORDER MATTERS. "Oracle PeopleSoft" and "Oracle Taleo" both contain
    // "oracle", and PeopleSoft is a different product with no driver — the
    // UT System and University of California career sites are PeopleSoft
    // (/psp/ and /psc/ paths), not Oracle CX. Matching 'oracle' first filed
    // twelve of them as a supported provider whose config could never be
    // derived, which reads as a config bug rather than an unsupported vendor.
    ['peoplesoft', 'peoplesoft'], ['ucpath', 'peoplesoft'],
    ['workday', 'workday'], ['taleo', 'taleo'], ['peopleadmin', 'peopleadmin'],
    ['icims', 'icims'], ['cornerstone', 'csod'], ['csod', 'csod'],
    ['successfactors', 'successfactors'], ['oracle', 'oracle'],
    ['neogov', 'governmentjobs'], ['governmentjobs', 'governmentjobs'],
    ['schooljobs', 'governmentjobs'], ['ultipro', 'ultipro'], ['ukg', 'ultipro'],
    ['interfolio', 'interfolio'], ['pageup', 'pageup'], ['paylocity', 'paylocity'],
    ['greenhouse', 'greenhouse'], ['lever', 'lever'], ['eightfold', 'eightfold'],
    ['smartrecruiters', 'smartrecruiters'], ['workable', 'workable'],
    ['breezy', 'breezy'], ['recruitee', 'recruitee'], ['adp', 'adp'],
    ['avature', 'avature'], ['brassring', 'brassring'], ['jobvite', 'jobvite'],
    ['dayforce', 'dayforce'], ['clearcompany', 'clearcompany'],
    ['bamboohr', 'bamboohr'], ['phenom', 'phenom']
  ];
  const hit = MAP.find(([needle]) => text.includes(needle));
  return hit ? { provider: hit[1], evidence_url: evidenceUrl } : null;
}

/**
 * Turn a model answer into a candidate, trusting the LIVE page over the
 * model's memory. Penn made the case: the model reported the PeopleAdmin URL
 * pattern Penn used years ago, while the careers page it named links today's
 * Workday tenant. Fetch that page and detect from what is actually on it;
 * only fall back to the model's remembered URLs when the page yields nothing.
 */
async function candidateFromModelAnswer(parsed) {
  const pageUrl = parsed?.careers_page_url || null;
  if (pageUrl) {
    const page = await fetchPage(pageUrl);
    if (page.ok) {
      const detected = detectAts(page.html, pageUrl);
      if (detected) return { ...detected, found_on: pageUrl, page_confirmed: true };
    }
  }
  const atsUrl = (parsed?.ats_urls || [])[0] || null;
  if (atsUrl) {
    const detected = detectAts(atsUrl, atsUrl) || normalizePlatform(parsed?.ats_platform, atsUrl);
    if (detected) return { ...detected, found_on: pageUrl, page_confirmed: false };
  }
  return null;
}

/** Stage B: pay the web only when the free path failed. */
const MODEL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['careers_page_url', 'ats_urls', 'ats_platform', 'ats_tenant', 'confidence', 'notes'],
  properties: {
    // Evidence first, verdict after — field order is load-bearing under
    // constrained decoding (see JUDGMENT_SCHEMA's history).
    careers_page_url: { type: ['string', 'null'], description: "The employer's own staff-employment page (not student career services)" },
    ats_urls: { type: 'array', items: { type: 'string' }, description: 'Job-board URLs actually seen, on the ATS host' },
    ats_platform: { type: ['string', 'null'] },
    ats_tenant: { type: ['string', 'null'] },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    notes: { type: 'string' }
  }
};

const MODEL_SYSTEM = `You find the page where a US employer's OWN STAFF job openings are listed, and the applicant-tracking system behind it.

Beware the common trap for universities: the "careers" page that ranks first is often the STUDENT career-services office. You want faculty/staff employment — usually under hr.<school>.edu, jobs.<school>.edu, or "work at <school>".

Follow the employment page to where postings actually live. Report the job-board URLs you actually saw (myworkdayjobs.com, taleo.net, icims.com, csod.com, peopleadmin.com, interfolio.com, schooljobs.com, ultipro.com, oraclecloud.com, …) and name the platform. Report only URLs you saw; if you cannot find the board, say so with confidence low rather than guessing.`;

async function modelDetect(key, org) {
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: MODEL,
      input: [
        { role: 'system', content: MODEL_SYSTEM },
        { role: 'user', content: `Employer: ${org.name}\nKnown website: ${org.website || 'unknown'}\n\nFind the staff job board and its ATS.` }
      ],
      tools: [{ type: 'web_search' }],
      text: { format: { type: 'json_schema', name: 'ats_resolution', strict: true, schema: MODEL_SCHEMA } },
      reasoning: { effort: 'low' }
    })
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`openai ${response.status}: ${text.slice(0, 160)}`);
  const data = JSON.parse(text);
  const searches = (data.output || []).filter((item) => item.type === 'web_search_call').length;
  const message = (data.output || []).find((item) => item.type === 'message');
  const raw = message?.content?.find((c) => c.type === 'output_text')?.text ?? data.output_text ?? '';
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { parsed = null; }
  const usage = data.usage || {};
  const cost = ((usage.input_tokens || 0) / 1e6) * PRICE_PER_1M.input
    + ((usage.output_tokens || 0) / 1e6) * PRICE_PER_1M.output
    + searches * WEB_SEARCH_CALL_USD;
  return { parsed, searches, cost };
}

/** Stage C: turn "provider + a URL" into the config the adapter needs. */
async function deriveConfig(provider, urls, orgName) {
  const url = urls.find(Boolean) || '';
  const lower = url.toLowerCase();

  if (provider === 'workday') {
    let match = /https?:\/\/([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:[a-z]{2}-[a-z]{2}\/)?([a-z0-9_-]+)/i.exec(lower);
    if (match) {
      const [, tenant, wd, site] = match;
      const host = `${tenant}.${wd}.myworkdayjobs.com`;
      const total = await workdayCount(host, tenant, site);
      return { ats_token: tenant, ats_config: { host, tenant, site }, jobs_found: total };
    }
    match = /https?:\/\/(wd\d+)\.myworkdaysite\.com\/(?:[a-z]{2}-[a-z]{2}\/)?recruiting\/([a-z0-9-]+)\/([a-z0-9_-]+)/i.exec(lower);
    if (match) {
      const [, wd, tenant, site] = match;
      const host = `${wd}.myworkdaysite.com`;
      const total = await workdayCount(host, tenant, site, true);
      return { ats_token: tenant, ats_config: { host, tenant, site }, jobs_found: total };
    }
    return null;
  }

  if (provider === 'peopleadmin') {
    // Two shapes: <tenant>.peopleadmin.com, or a vanity domain — careers.
    // fordham.edu serves the same /postings/search.atom feed (60 entries) while
    // fordham.peopleadmin.com does not resolve at all. So do not require the
    // URL to contain /postings; ask each candidate host for the feed and let
    // the feed decide. The driver already accepts ats_config.host for this.
    const hosts = [];
    const vendor = /https?:\/\/([a-z0-9-]+)\.peopleadmin\.com/i.exec(lower);
    if (vendor) hosts.push(`${vendor[1]}.peopleadmin.com`);
    for (const candidate of urls.filter(Boolean)) {
      const host = /https?:\/\/([a-z0-9.-]+)/i.exec(candidate)?.[1];
      if (host && !hosts.includes(host)) hosts.push(host);
    }
    for (const host of hosts) {
      try {
        const xml = await fetchText(`https://${host}/postings/search.atom`, {
          headers: { accept: 'application/atom+xml, application/xml, text/xml' }
        });
        const count = (xml.match(/<entry[\s>]/g) || []).length;
        if (!count && !/<feed/i.test(xml)) continue;
        const token = host.endsWith('.peopleadmin.com')
          ? host.replace(/\.peopleadmin\.com$/, '')
          : (host.split('.').find((label) => !['jobs', 'hr', 'www', 'careers', 'employment', 'apply'].includes(label))
            || host.replace(/\./g, '-'));
        const config = host.endsWith('.peopleadmin.com') ? { tenant: token } : { host, tenant: token };
        return { ats_token: token, ats_config: config, jobs_found: count };
      } catch { /* try the next candidate host */ }
    }
    return null;
  }

  if (provider === 'governmentjobs') {
    const match = /https?:\/\/(www\.)?(governmentjobs|schooljobs)\.com\/careers\/([a-z0-9_-]+)/i.exec(lower);
    if (!match) return null;
    return {
      ats_token: match[3],
      ats_config: { host: `www.${match[2]}.com`, agency: match[3] },
      jobs_found: null
    };
  }

  if (provider === 'icims') {
    // The subdomain IS the tenant, and it is not always <org>: Emory's board is
    // faculty-emory / staff-emory. Trust the URL, never a reconstruction.
    const match = /https?:\/\/([a-z0-9-]+)\.icims\.com/i.exec(lower);
    if (!match) return null;
    const [, token] = match;
    const probed = await probeIcims(token, `${token}.icims.com`).catch(() => null);
    if (probed) {
      return { ats_token: probed.ats_token, ats_config: probed.ats_config || {}, jobs_found: probed.jobs_found };
    }
    // A tenant that serves neither sitemap nor search may still be real but
    // gated. Record it as a candidate rather than losing the tenant we learned.
    return { ats_token: token, ats_config: {}, jobs_found: null, unproven: 'icims_no_public_route' };
  }

  // ADP identifies a client by a `cid` GUID that only ever appears in the
  // board URL — there is nothing to derive it from and nothing to probe.
  if (provider === 'adp') {
    const match = /[?&]cid=([0-9a-f-]{36})/i.exec(url);
    if (!match) return null;
    return { ats_token: match[1], ats_config: { cid: match[1] }, jobs_found: null };
  }

  if (provider === 'csod') {
    const match = /https?:\/\/([a-z0-9-]+)\.csod\.com/i.exec(lower);
    if (!match) return null;
    const probed = await probeCsod(match[1]).catch(() => null);
    return probed && { ats_token: probed.ats_token, ats_config: probed.ats_config, jobs_found: probed.jobs_found };
  }

  if (provider === 'oracle') {
    // Oracle CX is served either from Oracle's own host or from the employer's
    // vanity domain (careersearch.stanford.edu) — same REST API underneath, so
    // probe whichever host the evidence URL names.
    const match = /https?:\/\/([a-z0-9.-]+\.oraclecloud\.com)/i.exec(lower)
      || /https?:\/\/([a-z0-9.-]+)\/hcmui\//i.exec(lower)
      || /https?:\/\/([a-z0-9.-]+)\/(?:hcmrestapi|recruitingce)/i.exec(lower);
    if (!match) return null;
    const probed = await probeOracle(match[1]).catch(() => null);
    return probed && { ats_token: probed.ats_token, ats_config: probed.ats_config, jobs_found: probed.jobs_found };
  }

  if (provider === 'taleo') {
    const hostMatch = /https?:\/\/([a-z0-9.-]*\.taleo\.net)/i.exec(lower);
    if (!hostMatch || hostMatch[1].includes('.tbe.')) return null;
    const seen = [...url.matchAll(/careersection\/([A-Za-z0-9_.%-]+)\//gi)].map((m) => m[1]);
    const probed = await probeTaleoHost(
      { host: hostMatch[1], claimed_by: [orgName] },
      [...new Set([...seen, ...TALEO_CODES])]
    );
    if (!probed.sections.length) return null;
    return {
      ats_token: hostMatch[1].split('.')[0],
      ats_config: probed.suggested_ats_config,
      jobs_found: probed.total_requisitions
    };
  }

  if (provider === 'ultipro') {
    const match = /https?:\/\/(recruiting\d?\.ultipro\.com)\/([A-Za-z0-9]+)\/JobBoard\/([a-f0-9-]{36})/i.exec(url);
    if (!match) return null;
    return {
      ats_token: match[2],
      ats_config: { host: match[1], tenant: match[2], boards: [match[3]] },
      jobs_found: null
    };
  }

  // PageUp and SuccessFactors both need only a host — but "has a host" is not
  // "serves jobs", so prove the sitemap before proposing either. PageUp in
  // particular fronts its sites with an AWS WAF that answers 202 and a JS
  // interstitial; that is a block to record, not an employer with no openings.
  if (provider === 'pageup' || provider === 'successfactors') {
    const match = /https?:\/\/([a-z0-9.-]+)/i.exec(lower);
    if (!match) return null;
    const host = match[1];
    try {
      const xml = await fetchText(`https://${host}/sitemap.xml`, {
        headers: { accept: 'application/xml, text/xml, */*' }
      });
      if (/awsWafCookie|awswaf|challenge-platform|Just a moment/i.test(xml)) {
        return { ats_token: host, ats_config: { host }, jobs_found: null, blocked: 'bot_challenge' };
      }
      const count = provider === 'successfactors'
        ? parseSuccessFactorsSitemap(xml).length
        : parseSitemapUrls(xml).filter((url) => url.includes('/jobs/')).length;
      if (!count) return null;
      // The token identifies the FEED, so it must be distinctive. The first
      // host label is not: careers.uh.edu and careers.und.edu would both be
      // "careers", colliding in every by-token check. Use the whole host.
      return { ats_token: host.replace(/\./g, '-'), ats_config: { host }, jobs_found: count };
    } catch { return null; }
  }

  if (provider === 'greenhouse') {
    const match = /greenhouse\.io\/(?:embed\/job_board\?for=)?([a-z0-9]+)/i.exec(lower);
    if (!match) return null;
    try {
      const payload = await fetchJson(`https://boards-api.greenhouse.io/v1/boards/${match[1]}/jobs`);
      return { ats_token: match[1], ats_config: {}, jobs_found: (payload.jobs || []).length };
    } catch { return null; }
  }

  if (provider === 'lever') {
    const match = /jobs\.lever\.co\/([a-z0-9-]+)/i.exec(lower);
    if (!match) return null;
    try {
      const payload = await fetchJson(`https://api.lever.co/v0/postings/${match[1]}?mode=json`);
      return { ats_token: match[1], ats_config: {}, jobs_found: payload.length };
    } catch { return null; }
  }

  return null; // supported provider, but its config cannot be derived from a URL
}

async function workdayCount(host, tenant, site, isSite = false) {
  try {
    const base = `https://${host}/wday/cxs/${encodeURIComponent(tenant)}/${encodeURIComponent(site)}`;
    const payload = await fetchJson(`${base}/jobs`, {
      method: 'POST',
      body: { appliedFacets: {}, limit: 1, offset: 0, searchText: '' }
    });
    return Number(payload.total || 0);
  } catch { return null; }
}

/**
 * Stage D: the ownership evidence. The model saying "Penn uses Workday" is a
 * claim; Penn's own employment page linking that Workday tenant is provenance.
 * Re-fetch the page ourselves and require both the link and the domain.
 */
async function verifyProvenance(pageUrl, orgWebsite, atsUrl, provider) {
  // A board on the org's own domain (jobs.hr.upenn.edu under upenn.edu) is
  // provenance by construction — nobody hosts a rival's board on their domain.
  if (atsUrl && orgWebsite && registrableDomain(atsUrl) === registrableDomain(orgWebsite)) {
    return { ok: true, page: atsUrl, method: 'ats_on_org_domain' };
  }
  if (!pageUrl) return { ok: false, reason: 'no_page' };
  const page = await fetchPage(pageUrl);
  if (!page.ok) return { ok: false, reason: 'page_unreachable' };

  const haystack = page.html.toLowerCase();
  const needle = atsUrl
    ? registrableDomainWithPath(atsUrl)
    : (ATS_HOST_SIGNS.find(([, p]) => p === provider) || [])[0];
  const linked = needle ? haystack.includes(needle.toLowerCase()) : false;
  if (!linked) return { ok: false, reason: 'link_not_on_page' };

  const sameDomain = orgWebsite
    && registrableDomain(pageUrl) === registrableDomain(orgWebsite);
  if (!sameDomain) return { ok: false, reason: 'page_not_on_org_domain' };
  return { ok: true, page: pageUrl };
}

/** Enough of the ATS URL to prove the page links THIS tenant, not the vendor. */
function registrableDomainWithPath(atsUrl) {
  const match = /^https?:\/\/([^/]+)(\/[^?#\s]{0,40})?/i.exec(atsUrl || '');
  if (!match) return null;
  return match[1] + (match[2] && match[2].length > 1 ? match[2] : '');
}

function suggestEntry(org, dirEntry, provider, derived, careersUrl) {
  const slug = org.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const isIpeds = dirEntry?.kind === 'ipeds';
  return {
    id: slug,
    name: org.name,
    type: isIpeds ? 'institution_of_higher_education' : 'nonprofit_research_org',
    cap_exempt_status: 'likely',
    evidence_sources: [
      'ats_resolver',
      isIpeds && dirEntry.unitid ? `ipeds:${dirEntry.unitid}` : (dirEntry?.ein ? `irs_eo_bmf:${dirEntry.ein}` : null)
    ].filter(Boolean),
    careers_url: careersUrl,
    ats_provider: provider,
    ats_token: derived.ats_token,
    ats_config: derived.ats_config
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const discovery = JSON.parse(await fsp.readFile(DISCOVERY_PATH, 'utf8')).employers;
  const directory = JSON.parse(await fsp.readFile(DIRECTORY_PATH, 'utf8')).entries;
  const registry = JSON.parse(await fsp.readFile(REGISTRY_PATH, 'utf8'));
  const registryNames = new Set();
  for (const employer of registry) {
    registryNames.add(normalizeName(employer.name));
    for (const alias of employer.aliases || []) registryNames.add(normalizeName(alias));
  }

  let cache = { schema_version: 1, entries: {} };
  try { cache = JSON.parse(await fsp.readFile(CACHE_PATH, 'utf8')); } catch { /* first run */ }

  /* Persist after every org, not at the end. The cache is the only record of
   * money already spent; a crash or a Ctrl-C on org 140 of 153 must not mean
   * buying those 140 answers again. Written to a temp file and renamed so an
   * interrupted write cannot leave a truncated cache behind. */
  let cacheDirty = false;
  const saveCache = async () => {
    if (!cacheDirty) return;
    const temp = `${CACHE_PATH}.tmp`;
    await fsp.writeFile(temp, `${JSON.stringify(cache, null, 2)}\n`);
    await fsp.rename(temp, CACHE_PATH);
    cacheDirty = false;
  };
  const remember = async (key, value) => {
    cache.entries[key] = value;
    cacheDirty = true;
    await saveCache();
  };

  const pool = Object.entries(discovery)
    .filter(([name, record]) => !(record.ats || []).length
      && !registryNames.has(normalizeName(name))
      && (args.name ? name === args.name : (record.uscis_approvals_3y || 0) >= args.minUscis))
    .sort((a, b) => (b[1].uscis_approvals_3y || 0) - (a[1].uscis_approvals_3y || 0))
    .slice(0, args.limit);

  console.log(`${pool.length} org(s) to resolve (min ${args.minUscis} H-1B approvals; cache holds ${Object.keys(cache.entries).length})\n`);

  const key = args.noModel ? null : readKey(ENV_PATH);
  if (!args.noModel && !key) console.log('No OPENAI_API_KEY — running free stages only.\n');

  let spend = 0;
  const results = [];
  for (const [name, record] of pool) {
    const cacheKey = normalizeName(name);
    const cached = cache.entries[cacheKey];
    // A cached MODEL answer is never re-bought. Terminal statuses are reused
    // outright; a stalled one (needs_config / unverified) re-runs only the FREE
    // stages from the cached evidence, so iterating on this script costs $0.
    // Re-deriving is free once the model answer is bought, so anything with a
    // known provider is re-run: a stalled one may now derive, and a proposed
    // one is re-checked against the live board and picks up fixes (the PageUp
    // token collision below was cached as `proposed` and would otherwise have
    // survived its own fix). Only unresolvable outcomes are terminal.
    const retryable = cached && cached.provider
      && ['needs_config', 'ats_found_unverified', 'proposed', 'feed_unproven'].includes(cached.status);
    if (!args.force && cached && !retryable) {
      results.push(cached);
      continue;
    }
    const org = { name, website: record.website, uscis: record.uscis_approvals_3y || 0 };
    const out = { name, uscis: org.uscis, resolved_at: new Date().toISOString() };

    let found;
    let careersPage;
    if (retryable && !args.force) {
      out.stage_a = cached.stage_a;
      if (cached.model) out.model = { ...cached.model, cost: 0, reused: true };
      if (cached.model_answer) {
        // Redo the post-processing from the stored answer — free, and it picks
        // up any detection improvements made since the answer was bought.
        out.model_answer = cached.model_answer;
        const candidate = await candidateFromModelAnswer(cached.model_answer);
        found = candidate
          ? { status: 'found', ...candidate, via_model: true }
          : { status: 'no_ats_found' };
      } else {
        found = {
          status: 'found',
          provider: cached.provider,
          evidence_url: cached.evidence_url,
          // found_on is the page the link was seen on — the whole basis of the
          // provenance check. Dropping it on a cache replay silently turned
          // every re-run proposal into "unverified".
          found_on: cached.found_on || cached.model_page || null,
          via: cached.via || null,
          via_model: Boolean(cached.model)
        };
      }
      careersPage = found.found_on || cached.model_page || null;
      if (careersPage) out.model_page = careersPage;
    } else {
      // A — free
      found = await freeDetect(record);
      out.stage_a = found.status;
      careersPage = found.found_on || null;
    }
    // Remember the provenance trail, not just the answer, so a replay can
    // re-verify instead of re-buying.
    if (found.found_on) out.found_on = found.found_on;
    if (found.via) out.via = found.via;

    // B — paid, only on failure and under budget
    if (found.status !== 'found' && key && spend < args.maxSpend) {
      try {
        const answer = await modelDetect(key, org);
        spend += answer.cost;
        out.model = {
          cost: answer.cost,
          searches: answer.searches,
          confidence: answer.parsed?.confidence || null,
          notes: (answer.parsed?.notes || '').slice(0, 200)
        };
        out.model_answer = answer.parsed;
        const candidate = await candidateFromModelAnswer(answer.parsed);
        if (candidate) {
          found = { status: 'found', ...candidate, via_model: true };
          careersPage = candidate.found_on || null;
          out.model_page = careersPage;
        }
      } catch (error) {
        out.model = { error: error.message.slice(0, 160) };
      }
    }

    if (found.status !== 'found') {
      out.status = found.status === 'unreachable' ? 'unreachable' : 'no_ats_found';
      results.push(out);
      await remember(cacheKey, out);
      console.log(`—    ${name.slice(0, 46).padEnd(48)} ${out.status}`);
      continue;
    }

    out.provider = found.provider;
    out.evidence_url = found.evidence_url;

    // Cornerstone is a learning-management system as well as an ATS. A csod
    // link through a SAML login or a learning-object deep link is the training
    // portal, not a job board — Delaware's udel.csod.com is exactly this.
    if (found.provider === 'csod' && /samldefault|lodetails|deeplink/i.test(found.evidence_url || '')) {
      out.status = 'not_a_job_board';
      out.note = 'csod link is the LMS portal, not a career site';
      results.push(out);
      await remember(cacheKey, out);
      console.log(`~    ${name.slice(0, 46).padEnd(48)} csod link is their LMS, not a job board`);
      continue;
    }
    const supported = Object.keys(ATS_FETCHERS).includes(found.provider);

    if (!supported) {
      out.status = 'no_driver';
      results.push(out);
      await remember(cacheKey, out);
      console.log(`~    ${name.slice(0, 46).padEnd(48)} ${found.provider} (no driver)`);
      continue;
    }

    // C — free config derivation/probing
    // Pass every URL we have, not just the vendor-matched one. A page can name
    // a provider without linking a vendor host — Fordham's PeopleAdmin feed
    // lives on careers.fordham.edu, so the page's OWN url is the lead.
    const derived = await deriveConfig(
      found.provider,
      [found.evidence_url, found.via, found.found_on, careersPage, record.careers_url].filter(Boolean),
      name
    ).catch(() => null);
    if (!derived) {
      out.status = 'needs_config';
      results.push(out);
      await remember(cacheKey, out);
      console.log(`~    ${name.slice(0, 46).padEnd(48)} ${found.provider} (config underivable)`);
      continue;
    }
    out.jobs_found = derived.jobs_found;

    // D — provenance. Stage-A finds carry it by construction (we fetched the
    // org's own recorded page); model finds must survive a re-fetch.
    let provenance;
    if (found.via_model) {
      provenance = await verifyProvenance(careersPage, org.website, found.evidence_url, found.provider);
    } else {
      const onOwnDomain = org.website
        && registrableDomain(found.found_on) === registrableDomain(org.website);
      provenance = onOwnDomain
        ? { ok: true, page: found.found_on }
        : { ok: false, reason: 'crawl_page_not_on_org_domain' };
    }
    out.provenance = provenance;

    if (!provenance.ok) {
      out.status = 'ats_found_unverified';
      results.push(out);
      await remember(cacheKey, out);
      console.log(`?    ${name.slice(0, 46).padEnd(48)} ${found.provider} (${provenance.reason})`);
      continue;
    }

    // A tenant we identified but never saw serve a posting is a lead, not a
    // proposal: a blocked PageUp or a gated iCIMS would enter the registry and
    // then quietly fetch nothing, which reads as "employer has no openings".
    if (derived.blocked || derived.unproven) {
      out.status = 'feed_unproven';
      out.note = derived.blocked || derived.unproven;
      out.candidate_config = { ats_provider: found.provider, ats_token: derived.ats_token, ats_config: derived.ats_config };
      results.push(out);
      await remember(cacheKey, out);
      console.log(`?    ${name.slice(0, 46).padEnd(48)} ${found.provider} ${derived.ats_token} (${out.note})`);
      continue;
    }

    out.status = 'proposed';
    out.suggested_registry_entry = suggestEntry(
      org, directory[normalizeName(name)], found.provider, derived,
      careersPage || record.careers_url || org.website
    );
    results.push(out);
    await remember(cacheKey, out);
    console.log(`OK   ${name.slice(0, 46).padEnd(48)} ${found.provider} ${derived.ats_token} (${derived.jobs_found ?? '?'} jobs)`);
  }

  await saveCache();

  /* Two orgs can honestly resolve to ONE board — New York Stem Cell Foundation
   * now routes to thejacksonlaboratory's Workday, because Jackson acquired it,
   * and nyscf.org says so on its own homepage. Promoting both would file the
   * same postings under two employers. Flag the collision for a human instead
   * of silently picking a winner; the registry already has this concept. */
  const byFeed = new Map();
  for (const result of results) {
    const entry = result.suggested_registry_entry;
    if (!entry) continue;
    const key = `${entry.ats_provider}:${entry.ats_token}:${JSON.stringify(entry.ats_config)}`;
    if (!byFeed.has(key)) byFeed.set(key, []);
    byFeed.get(key).push(result);
  }
  const shared = [...byFeed.values()].filter((group) => group.length > 1);
  for (const group of shared) {
    for (const result of group) {
      result.needs_owner_decision = true;
      result.feed_also_claimed_by = group.filter((other) => other !== result).map((other) => other.name);
    }
  }
  // A feed already serving a registered employer is the same collision.
  const registeredFeeds = new Set(registry
    .filter((employer) => employer.ats_provider)
    .map((employer) => `${employer.ats_provider}:${employer.ats_token}`));
  for (const result of results) {
    const entry = result.suggested_registry_entry;
    if (entry && registeredFeeds.has(`${entry.ats_provider}:${entry.ats_token}`)) {
      result.needs_owner_decision = true;
      result.feed_already_in_registry = true;
    }
  }

  const counts = results.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] || 0) + 1 }), {});
  await fsp.writeFile(OUTPUT_PATH, `${JSON.stringify({
    schema_version: 1,
    generated_at: new Date().toISOString(),
    model: MODEL,
    spend_usd: Number(spend.toFixed(4)),
    counts,
    results
  }, null, 2)}\n`);

  console.log(`\n${JSON.stringify(counts)}`);
  const contested = results.filter((result) => result.needs_owner_decision);
  if (contested.length) {
    console.log(`${contested.length} proposal(s) share a feed — pick an owner before promoting:`);
    for (const result of contested) {
      const why = result.feed_already_in_registry
        ? 'feed already serves a registered employer'
        : `also claimed by ${(result.feed_also_claimed_by || []).join(', ')}`;
      console.log(`  ${result.name} — ${why}`);
    }
  }
  console.log(`Model spend this run: $${spend.toFixed(2)} (cached answers are free forever)`);
  console.log(`Wrote ${path.relative(process.cwd(), OUTPUT_PATH)}`);
  console.log('Nothing was added to the registry.');
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { detectAts, deriveConfig, registrableDomain, verifyProvenance, normalizePlatform };
