#!/usr/bin/env node

const fs = require('fs/promises');
const path = require('path');
const { analyzeText } = require('../../scripts/keywords.js');
const { classifyTitle, classLabel } = require('./lib/title-class.js');
const { syncJobs, fetchAllJobs } = require('./lib/supabase.js');

const ROOT = path.resolve(__dirname, '../..');
const RADAR_DIR = path.join(ROOT, 'radar');
const DATA_DIR = path.join(RADAR_DIR, 'data');
const EMPLOYERS_PATH = path.join(RADAR_DIR, 'employers.json');
const JOBS_PATH = path.join(DATA_DIR, 'jobs.json');
const REPORT_PATH = path.join(DATA_DIR, 'refresh-report.json');
const DOL_SIGNALS_PATH = path.join(DATA_DIR, 'dol-sponsor-signals.json');
const SCOUTED_JOBS_PATH = path.join(DATA_DIR, 'scouted-jobs.json');
const SCOUTED_TTL_DAYS = 14;
const AGGREGATED_JOBS_PATH = path.join(DATA_DIR, 'aggregated-jobs.json');
const AGGREGATED_TTL_DAYS = 7;
const ENRICHMENT_PATH = path.join(DATA_DIR, 'employer-enrichment.json');

const CAP_EXEMPT_STATUS_ORDER = { unknown: 0, likely: 1, verified: 2 };

/**
 * Merges the generated enrichment overlay onto the hand-curated registry.
 * Upgrades cap_exempt_status (never downgrades), unions evidence, attaches
 * the score — and never touches identity fields. Missing overlay -> no-op.
 */
function applyEnrichmentOverlay(employers, enrichment) {
  const overlay = enrichment?.employers || {};
  return employers.map((employer) => {
    const evidence = overlay[employer.id];
    if (!evidence) return employer;
    const merged = { ...employer };
    const suggested = evidence.suggested_status;
    if (suggested
      && (CAP_EXEMPT_STATUS_ORDER[suggested] ?? 0) > (CAP_EXEMPT_STATUS_ORDER[employer.cap_exempt_status] ?? 0)) {
      merged.cap_exempt_status = suggested;
    }
    merged.evidence_sources = [...new Set([...(employer.evidence_sources || []), ...(evidence.evidence_tags || [])])];
    if (typeof evidence.cap_exempt_score === 'number') merged.cap_exempt_score = evidence.cap_exempt_score;
    return merged;
  });
}

const USER_AGENT = 'VeritasResearchRadar/1.0 (+https://github.com/ChristianMangwanda/Veritas)';
const REQUEST_TIMEOUT_MS = 20000;
const EMPLOYER_DELAY_MS = 500;
// Auto-wired (tier: "auto") employers only commit research-relevant postings
const AUTO_TIER_MIN_RESEARCH_SCORE = 25;
const SMARTRECRUITERS_PAGE_LIMIT = 100;
const SMARTRECRUITERS_MAX_PAGES = 10;
const SMARTRECRUITERS_DETAIL_DELAY_MS = 200;
const WORKDAY_PAGE_LIMIT = 20;
const WORKDAY_MAX_PAGES = 50;
const WORKDAY_MAX_DETAIL_FETCHES = 400;
const WORKDAY_DETAIL_DELAY_MS = 250;
const USAJOBS_PAGE_SIZE = 500;
const USAJOBS_MAX_PAGES_PER_QUERY = 5;
const USAJOBS_PAGE_DELAY_MS = 300;
const SUPPORTED_ATS_PROVIDERS = ['greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workday', 'recruitee', 'breezy', 'workable', 'usajobs'];

const SIGNAL_PATTERNS = {
  cap_exempt_language: [
    /h-?1b\s+cap\s+exempt/gi,
    /cap[-\s]?exempt\s+h-?1b/gi,
    /cap[-\s]?exempt\s+position/gi,
    /not\s+subject\s+to\s+the\s+h-?1b\s+cap/gi
  ],
  research_role_language: [
    /\bresearch\s+(software\s+)?engineer\b/gi,
    /\bscientific\s+software\b/gi,
    /\bcomputational\s+(biologist|scientist|biology)\b/gi,
    /\bbioinformatics?\b/gi,
    /\bdata\s+scientist\b/gi,
    /\bresearch\s+(associate|scientist|specialist|technician)\b/gi,
    /\bclinical\s+research\b/gi,
    /\blaboratory\b/gi,
    /\bgenomics?\b/gi,
    /\bmachine\s+learning\b/gi
  ],
  international_candidate_language: [
    /international\s+(candidates?|students?|applicants?)\s+(welcome|encouraged|eligible)/gi,
    /f-?1\s+(opt|cpt)/gi,
    /stem\s+opt/gi,
    /visa\s+sponsorship/gi,
    /immigration\s+(support|sponsorship|assistance)/gi
  ]
};

function nowIso() {
  return new Date().toISOString();
}

function normalizeText(value) {
  return String(value || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#039;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeId(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableFetchError(error) {
  // Network failures and timeouts carry no HTTP status; 429/5xx are transient.
  // Other 4xx (e.g. 404 for a wrong board token) are deterministic — do not retry.
  return error.status === undefined || error.status === 429 || error.status >= 500;
}

async function fetchJson(url, options = {}) {
  const { method = 'GET', body, retries = 1, retryDelayMs = 1000, headers = {} } = options;
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method,
        headers: {
          accept: 'application/json',
          'user-agent': USER_AGENT,
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...headers
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal
      });
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status} ${response.statusText}`);
        error.status = response.status;
        throw error;
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < retries && isRetryableFetchError(error)) {
        await sleep(retryDelayMs * (attempt + 1));
        continue;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError;
}

function matchSignals(text) {
  const out = {};
  for (const [name, patterns] of Object.entries(SIGNAL_PATTERNS)) {
    const matches = [];
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      for (const match of text.matchAll(pattern)) {
        matches.push(match[0]);
      }
    }
    out[name] = [...new Set(matches)];
  }
  return out;
}

function scoreResearchRelevance(job, signals, employer) {
  const text = `${job.title} ${job.department} ${job.description_text}`.toLowerCase();
  let score = 0;
  score += Math.min(signals.research_role_language.length * 15, 45);
  for (const area of employer.research_areas || []) {
    if (text.includes(String(area).toLowerCase())) score += 8;
  }
  if (/\b(research|scientific|lab|laboratory|clinical|bioinformatics|genomics|computational)\b/i.test(job.title)) {
    score += 25;
  }
  if (/\b(engineer|software|data|machine learning|python|pipeline|platform)\b/i.test(text)) {
    score += 15;
  }
  return Math.max(0, Math.min(100, score));
}

// Behavioral evidence first: class-level LCA history (this employer certified
// visas for THIS kind of role) outranks institution-wide counts, which alone
// cap at moderate. Explicit sponsorship text plus real history is also strong.
function sponsorSignal(veritasState, dolCount, classCount = 0) {
  if (veritasState === 'RESTRICTED') return 'restricted';
  if (classCount >= 3 || (veritasState === 'FRIENDLY' && dolCount >= 10)) return 'strong';
  if (classCount >= 1 || veritasState === 'FRIENDLY' || dolCount >= 25) return 'moderate';
  if (dolCount > 0) return 'weak';
  return 'unknown';
}

function enrichJob(job, employer, previousById, dolSignal = {}) {
  const text = `${job.title}\n${job.department}\n${job.description_text}`;
  const veritas = analyzeText(text);
  // A mapper-level restriction (e.g. federal citizenship gate) overrides the
  // text scan: the requirement lives in source metadata, not the description
  if (job.restricted_reason) {
    veritas.state = 'RESTRICTED';
    veritas.matches = [{ type: 'RESTRICTED', text: job.restricted_reason }, ...veritas.matches];
  }
  const signals = matchSignals(text);
  const previous = previousById.get(job.id);
  const dolCount = Number(dolSignal.certified_count_3y || employer.dol_lca_certified_count_3y || 0);

  // Title-class evidence: the employer's LCA history for THIS kind of role
  const titleClass = classifyTitle(job.title);
  const classBucket = (dolSignal.title_classes || {})[titleClass] || null;
  const classEvidence = classBucket
    ? {
        certified_count_3y: classBucket.certified_count_3y,
        median_annual_wage: classBucket.median_annual_wage ?? null,
        sample_titles: classBucket.sample_titles || []
      }
    : null;

  return {
    ...job,
    employer_name: employer.name,
    employer_type: employer.type,
    cap_exempt_status: employer.cap_exempt_status,
    cap_exempt_score: employer.cap_exempt_score ?? null,
    cap_exempt_evidence_sources: employer.evidence_sources || [],
    cap_exempt_notes: employer.notes || '',
    first_seen_at: previous?.first_seen_at || nowIso(),
    last_seen_at: nowIso(),
    veritas_state: veritas.state,
    matched_phrases: veritas.matches.map((match) => match.text),
    cap_exempt_language: signals.cap_exempt_language,
    research_role_language: signals.research_role_language,
    international_candidate_language: signals.international_candidate_language,
    dol_lca_certified_count_3y: dolCount,
    dol_recent_titles: dolSignal.recent_titles || employer.dol_recent_titles || [],
    title_class: titleClass,
    title_class_label: classLabel(titleClass),
    class_evidence: classEvidence,
    sponsor_signal: sponsorSignal(veritas.state, dolCount, classEvidence?.certified_count_3y || 0),
    research_relevance_score: scoreResearchRelevance(job, signals, employer),
    provenance: {
      job_source: job.source,
      employer_sources: employer.evidence_sources || [],
      ats_provider: employer.ats_provider,
      ats_token: employer.ats_token,
      fetched_at: nowIso()
    },
    disclaimer: 'Signals are planning aids only. Verify cap-exempt status and sponsorship directly with the employer.'
  };
}

/**
 * Scouted jobs are trusted only while fresh: a snapshot older than the TTL no
 * longer proves the posting exists, so it drops out (and tombstones normally).
 */
function activeScoutedJobs(store, now, ttlDays = SCOUTED_TTL_DAYS) {
  const cutoffMs = Date.parse(now) - ttlDays * 24 * 60 * 60 * 1000;
  return (store.jobs || []).filter((job) => {
    const scoutedAt = Date.parse(job.last_scouted_at || '');
    return Number.isFinite(scoutedAt) && scoutedAt >= cutoffMs;
  });
}

const CLOSED_RETENTION_DAYS = 30;

/**
 * Merges the current fetch with the previous dataset so postings that
 * disappear become tombstones instead of silently vanishing.
 * - fetched job            -> active (revives previously closed postings)
 * - absent + fetch ok      -> closed tombstone (closed_at set once, kept 30 days)
 * - absent + fetch errored -> carried forward unchanged (transient failures
 *                             must not mass-close an employer's jobs)
 * - employer not in registry anymore -> dropped
 */
function applyJobLifecycle({ previousJobs, fetchedJobs, employerOutcomes, now, retentionDays = CLOSED_RETENTION_DAYS }) {
  const nowMs = Date.parse(now);
  const retentionMs = retentionDays * 24 * 60 * 60 * 1000;
  const isExpired = (closedAt) => nowMs - Date.parse(closedAt || now) > retentionMs;
  const fetchedIds = new Set(fetchedJobs.map((job) => job.id));

  const jobs = fetchedJobs.map((job) => {
    const { closed_at, ...rest } = job;
    return { ...rest, status: 'active' };
  });

  for (const previous of previousJobs) {
    if (fetchedIds.has(previous.id)) continue;
    const outcome = employerOutcomes.get(previous.employer_id);
    if (!outcome) continue;
    if (!outcome.attempted || !outcome.ok) {
      if (previous.status === 'closed' && isExpired(previous.closed_at)) continue;
      jobs.push(previous);
      continue;
    }
    const closedAt = previous.closed_at || now;
    if (isExpired(closedAt)) continue;
    jobs.push({ ...previous, status: 'closed', closed_at: closedAt });
  }

  return jobs;
}

function validateEmployer(employer) {
  const required = ['id', 'name', 'type', 'cap_exempt_status', 'evidence_sources', 'careers_url'];
  for (const key of required) {
    if (!employer[key]) throw new Error(`Employer ${employer.id || employer.name || '<unknown>'} is missing ${key}`);
  }
  if (employer.ats_provider && !SUPPORTED_ATS_PROVIDERS.includes(employer.ats_provider)) {
    throw new Error(`Employer ${employer.id} has unsupported ats_provider ${employer.ats_provider}`);
  }
  if (employer.ats_provider && !employer.ats_token) {
    throw new Error(`Employer ${employer.id} has ats_provider but no ats_token`);
  }
  if (employer.ats_provider === 'workday') {
    const config = employer.ats_config || {};
    for (const key of ['host', 'tenant', 'site']) {
      if (!config[key]) throw new Error(`Employer ${employer.id} uses workday but ats_config.${key} is missing`);
    }
  }
}

function mapGreenhouseJob(job, employer) {
  const department = (job.departments || []).map((department) => department.name).filter(Boolean).join(', ');
  const offices = (job.offices || []).map((office) => office.location || office.name).filter(Boolean);
  return {
    id: `greenhouse:${employer.ats_token}:${job.id}`,
    employer_id: employer.id,
    title: job.title || 'Untitled role',
    department,
    location: job.location?.name || offices.join(', ') || 'Unspecified',
    url: job.absolute_url,
    description_text: normalizeText(job.content),
    posted_or_updated_at: job.updated_at || null,
    source: 'greenhouse',
    source_job_id: String(job.id)
  };
}

function mapLeverJob(job, employer) {
  const categories = job.categories || {};
  return {
    id: `lever:${employer.ats_token}:${job.id || normalizeId(job.hostedUrl || job.text)}`,
    employer_id: employer.id,
    title: job.text || 'Untitled role',
    department: categories.team || '',
    location: categories.location || job.workplaceType || 'Unspecified',
    url: job.hostedUrl || job.applyUrl,
    description_text: normalizeText(job.descriptionPlain || job.description || job.additionalPlain || ''),
    posted_or_updated_at: job.createdAt ? new Date(job.createdAt).toISOString() : null,
    source: 'lever',
    source_job_id: String(job.id || '')
  };
}

function mapAshbyJob(job, employer) {
  const location = job.isRemote && job.location
    ? `${job.location} (Remote)`
    : job.location || (job.isRemote ? 'Remote' : 'Unspecified');
  return {
    id: `ashby:${employer.ats_token}:${job.id}`,
    employer_id: employer.id,
    title: job.title || 'Untitled role',
    department: job.department || job.team || '',
    location,
    url: job.jobUrl || job.applyUrl,
    description_text: normalizeText(job.descriptionHtml || job.descriptionPlain || ''),
    posted_or_updated_at: job.publishedAt || null,
    source: 'ashby',
    source_job_id: String(job.id)
  };
}

function mapSmartRecruitersPosting(posting, detail, employer) {
  const location = posting.location || {};
  const locationText = location.fullLocation
    || [location.city, location.region, location.country ? String(location.country).toUpperCase() : '']
      .filter(Boolean).join(', ')
    || 'Unspecified';
  const sections = detail?.jobAd?.sections || {};
  const description = ['companyDescription', 'jobDescription', 'qualifications', 'additionalInformation']
    .map((key) => sections[key]?.text || '')
    .filter(Boolean)
    .join(' ');
  return {
    id: `smartrecruiters:${employer.ats_token}:${posting.id}`,
    employer_id: employer.id,
    title: posting.name || 'Untitled role',
    department: posting.department?.label || '',
    location: location.remote ? `${locationText} (Remote)` : locationText,
    url: detail?.postingUrl || detail?.applyUrl
      || `https://jobs.smartrecruiters.com/${encodeURIComponent(employer.ats_token)}/${encodeURIComponent(posting.id)}`,
    description_text: normalizeText(description),
    posted_or_updated_at: posting.releasedDate || null,
    source: 'smartrecruiters',
    source_job_id: String(posting.id)
  };
}

async function fetchGreenhouseJobs(employer) {
  const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(employer.ats_token)}/jobs?content=true`;
  const payload = await fetchJson(url);
  return (payload.jobs || []).map((job) => mapGreenhouseJob(job, employer));
}

async function fetchLeverJobs(employer) {
  const url = `https://api.lever.co/v0/postings/${encodeURIComponent(employer.ats_token)}?mode=json`;
  const payload = await fetchJson(url);
  return (Array.isArray(payload) ? payload : []).map((job) => mapLeverJob(job, employer));
}

async function fetchAshbyJobs(employer) {
  const url = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(employer.ats_token)}?includeCompensation=true`;
  const payload = await fetchJson(url);
  return (payload.jobs || [])
    .filter((job) => job.isListed !== false)
    .map((job) => mapAshbyJob(job, employer));
}

async function fetchSmartRecruitersJobs(employer) {
  const token = encodeURIComponent(employer.ats_token);
  const listings = [];
  let offset = 0;
  let total = Infinity;
  for (let page = 0; page < SMARTRECRUITERS_MAX_PAGES && offset < total; page += 1) {
    const url = `https://api.smartrecruiters.com/v1/companies/${token}/postings?limit=${SMARTRECRUITERS_PAGE_LIMIT}&offset=${offset}`;
    const payload = await fetchJson(url);
    total = Number(payload.totalFound || 0);
    const content = payload.content || [];
    if (content.length === 0) break;
    listings.push(...content);
    offset += content.length;
  }
  const jobs = [];
  for (const posting of listings) {
    // The list endpoint carries no description; fetch the posting detail per job.
    // Fail-soft: a bad posting should not sink the whole employer.
    try {
      const detail = await fetchJson(`https://api.smartrecruiters.com/v1/companies/${token}/postings/${encodeURIComponent(posting.id)}`);
      jobs.push(mapSmartRecruitersPosting(posting, detail, employer));
    } catch (error) {
      console.warn(`SmartRecruiters detail fetch failed for ${employer.id} posting ${posting.id}: ${error.message}`);
    }
    await sleep(SMARTRECRUITERS_DETAIL_DELAY_MS);
  }
  return jobs;
}

// Recruitee/Breezy/Workable: no registry employer uses these yet — they serve
// the discovery flow (wiring a discovered org is a one-line registry edit).
function mapRecruiteeJob(offer, employer) {
  const locations = (offer.locations || [])
    .map((location) => [location.city, location.state, location.country].filter(Boolean).join(', '))
    .filter(Boolean);
  return {
    id: `recruitee:${employer.ats_token}:${offer.guid || offer.id}`,
    employer_id: employer.id,
    title: offer.title || offer.position || offer.sharing_title || 'Untitled role',
    department: offer.department || '',
    location: locations.join('; ') || offer.location || 'Unspecified',
    url: offer.careers_url || offer.url,
    description_text: normalizeText(offer.description || ''),
    posted_or_updated_at: offer.published_at || null,
    source: 'recruitee',
    source_job_id: String(offer.guid || offer.id || '')
  };
}

function mapBreezyJob(job, employer) {
  return {
    id: `breezy:${employer.ats_token}:${job.id || job.friendly_id}`,
    employer_id: employer.id,
    title: job.name || 'Untitled role',
    department: typeof job.department === 'string' ? job.department : job.department?.name || '',
    location: job.location?.name || 'Unspecified',
    url: job.url,
    // The list feed may omit descriptions; such jobs are dropped by the
    // url+description quality filter until a detail fetch is added
    description_text: normalizeText(job.description || ''),
    posted_or_updated_at: job.published_date || null,
    source: 'breezy',
    source_job_id: String(job.id || job.friendly_id || '')
  };
}

function mapWorkableJob(job, employer) {
  return {
    id: `workable:${employer.ats_token}:${job.shortcode || job.id}`,
    employer_id: employer.id,
    title: job.title || 'Untitled role',
    department: job.department || '',
    location: [job.city, job.state, job.country].filter(Boolean).join(', ')
      || (job.telecommuting ? 'Remote' : 'Unspecified'),
    url: job.url || job.application_url,
    description_text: normalizeText(job.description || ''),
    posted_or_updated_at: job.published_on || job.created_at || null,
    source: 'workable',
    source_job_id: String(job.shortcode || job.id || '')
  };
}

async function fetchRecruiteeJobs(employer) {
  const url = `https://${encodeURIComponent(employer.ats_token)}.recruitee.com/api/offers/`;
  const payload = await fetchJson(url);
  return (payload.offers || []).map((offer) => mapRecruiteeJob(offer, employer));
}

async function fetchBreezyJobs(employer) {
  const url = `https://${encodeURIComponent(employer.ats_token)}.breezy.hr/json`;
  const payload = await fetchJson(url);
  return (Array.isArray(payload) ? payload : []).map((job) => mapBreezyJob(job, employer));
}

async function fetchWorkableJobs(employer) {
  const url = `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(employer.ats_token)}?details=true`;
  const payload = await fetchJson(url);
  return (payload.jobs || []).map((job) => mapWorkableJob(job, employer));
}

// Workday tenants can list thousands of postings and each description costs a
// request, so only titles that look research-relevant get a detail fetch.
const WORKDAY_TITLE_PREFILTER = [
  /\bresearch\b/i,
  /\bpostdoc(toral)?\b/i,
  /\bscientist\b/i,
  /\blaborator(y|ies)\b/i,
  /\bdata\b/i,
  /\bcomputational\b/i,
  /\bbioinformatic/i,
  /\bgenomic/i,
  /\bmachine\s+learning\b/i,
  /\bsoftware\s+engineer/i
];

function isResearchRelevantTitle(title, employer) {
  if (WORKDAY_TITLE_PREFILTER.some((pattern) => pattern.test(title))) return true;
  const lower = String(title).toLowerCase();
  return (employer.research_areas || []).some((area) => lower.includes(String(area).toLowerCase()));
}

function mapWorkdayJob(listItem, detailInfo, employer) {
  const config = employer.ats_config || {};
  const reqId = detailInfo?.jobReqId || (listItem.bulletFields || [])[0] || normalizeId(listItem.externalPath);
  const postedDate = detailInfo?.startDate ? new Date(`${detailInfo.startDate}T00:00:00Z`).toISOString() : null;
  return {
    id: `workday:${employer.ats_token}:${reqId}`,
    employer_id: employer.id,
    title: detailInfo?.title || listItem.title || 'Untitled role',
    department: '',
    location: detailInfo?.location || listItem.locationsText || 'Unspecified',
    url: detailInfo?.externalUrl || `https://${config.host}/${config.site}${listItem.externalPath || ''}`,
    description_text: normalizeText(detailInfo?.jobDescription || ''),
    posted_or_updated_at: postedDate,
    source: 'workday',
    source_job_id: String(reqId)
  };
}

async function fetchWorkdayJobs(employer) {
  const { host, tenant, site } = employer.ats_config;
  const base = `https://${host}/wday/cxs/${encodeURIComponent(tenant)}/${encodeURIComponent(site)}`;

  const listings = [];
  let total = Infinity;
  for (let page = 0; page < WORKDAY_MAX_PAGES && page * WORKDAY_PAGE_LIMIT < total; page += 1) {
    const payload = await fetchJson(`${base}/jobs`, {
      method: 'POST',
      body: {
        appliedFacets: {},
        limit: WORKDAY_PAGE_LIMIT,
        offset: page * WORKDAY_PAGE_LIMIT,
        searchText: ''
      }
    });
    // Workday only reports `total` on the first page; later pages return 0
    if (page === 0) total = Number(payload.total || 0);
    const postings = payload.jobPostings || [];
    if (postings.length === 0) break;
    listings.push(...postings);
  }

  // Later pages can repeat postings while requisitions shift; dedupe by path
  const seenPaths = new Set();
  const uniqueListings = listings.filter((listItem) => {
    if (!listItem.externalPath || seenPaths.has(listItem.externalPath)) return false;
    seenPaths.add(listItem.externalPath);
    return true;
  });

  const relevant = uniqueListings
    .filter((listItem) => isResearchRelevantTitle(listItem.title || '', employer))
    .slice(0, WORKDAY_MAX_DETAIL_FETCHES);

  const jobs = [];
  for (const listItem of relevant) {
    try {
      const detail = await fetchJson(`${base}${listItem.externalPath}`);
      jobs.push(mapWorkdayJob(listItem, detail?.jobPostingInfo, employer));
    } catch (error) {
      console.warn(`Workday detail fetch failed for ${employer.id} ${listItem.externalPath}: ${error.message}`);
    }
    await sleep(WORKDAY_DETAIL_DELAY_MS);
  }
  return jobs;
}

// Federal competitive-service positions require US citizenship by default,
// and the requirement usually lives in "Who May Apply" metadata rather than
// the description text — so gate on the metadata, defaulting to gated.
function usaJobsCitizenshipGated(descriptor, details) {
  const context = [
    details.WhoMayApply?.Name,
    Array.isArray(details.HiringPath) ? details.HiringPath.join(' ') : details.HiringPath,
    details.JobSummary,
    descriptor.QualificationSummary
  ].filter(Boolean).join(' ');
  return !/non-?citizens?\s+(may|can|are\s+(eligible|encouraged))|without\s+regard\s+to\s+citizenship|citizenship\s+is\s+not\s+required/i.test(context);
}

function mapUsaJobsJob(item, employer) {
  const descriptor = item.MatchedObjectDescriptor || {};
  const details = descriptor.UserArea?.Details || {};
  const jobId = item.MatchedObjectId || descriptor.PositionID || '';
  const citizenshipGated = usaJobsCitizenshipGated(descriptor, details);
  return {
    id: `usajobs:${employer.ats_token}:${jobId}`,
    employer_id: employer.id,
    title: descriptor.PositionTitle || 'Untitled role',
    department: [descriptor.DepartmentName, descriptor.OrganizationName].filter(Boolean).join(' — '),
    location: (descriptor.PositionLocation || [])
      .map((location) => location.LocationName)
      .filter(Boolean)
      .slice(0, 3)
      .join('; ') || 'Unspecified',
    url: descriptor.PositionURI,
    description_text: normalizeText([details.JobSummary, descriptor.QualificationSummary].filter(Boolean).join(' ')),
    posted_or_updated_at: descriptor.PublicationStartDate || null,
    source: 'usajobs',
    source_job_id: String(jobId),
    citizenship_gated: citizenshipGated,
    restricted_reason: citizenshipGated ? 'US citizenship required (federal hiring path)' : null
  };
}

async function fetchUsaJobsJobs(employer) {
  const apiKey = process.env.USAJOBS_API_KEY;
  const email = process.env.USAJOBS_EMAIL;
  if (!apiKey || !email) {
    // Missing credentials is a configuration state, not a fetch failure:
    // surface as skipped so the lifecycle carries prior federal jobs forward
    throw Object.assign(new Error('USAJOBS credentials not set (USAJOBS_API_KEY, USAJOBS_EMAIL)'), { skipped: true });
  }
  const config = employer.ats_config || {};
  const maxPages = Number(config.max_pages_per_series) || USAJOBS_MAX_PAGES_PER_QUERY;
  const queries = [
    ...(config.position_series || []).map((value) => ['PositionSeries', value]),
    ...(config.keywords || []).map((value) => ['Keyword', value])
  ];
  const headers = { 'user-agent': email, 'authorization-key': apiKey };
  const byId = new Map();

  for (const [param, value] of queries) {
    for (let page = 1; page <= maxPages; page += 1) {
      const url = `https://data.usajobs.gov/api/search?${param}=${encodeURIComponent(value)}&ResultsPerPage=${USAJOBS_PAGE_SIZE}&Page=${page}`;
      const payload = await fetchJson(url, { headers });
      const items = payload?.SearchResult?.SearchResultItems;
      if (!Array.isArray(items)) {
        // Fail loud: an error outcome carries previous jobs forward, whereas
        // silently returning [] would tombstone every federal job
        throw new Error('USAJOBS response shape unexpected (SearchResult.SearchResultItems missing)');
      }
      for (const item of items) {
        try {
          const job = mapUsaJobsJob(item, employer);
          if (job.source_job_id) byId.set(job.id, job);
        } catch (error) {
          console.warn(`USAJOBS item mapping failed: ${error.message}`);
        }
      }
      if (items.length < USAJOBS_PAGE_SIZE) break;
      await sleep(USAJOBS_PAGE_DELAY_MS);
    }
  }
  return [...byId.values()];
}

const ATS_FETCHERS = {
  greenhouse: fetchGreenhouseJobs,
  lever: fetchLeverJobs,
  ashby: fetchAshbyJobs,
  smartrecruiters: fetchSmartRecruitersJobs,
  workday: fetchWorkdayJobs,
  recruitee: fetchRecruiteeJobs,
  breezy: fetchBreezyJobs,
  workable: fetchWorkableJobs,
  usajobs: fetchUsaJobsJobs
};

async function fetchEmployerJobs(employer) {
  if (!employer.ats_provider) {
    return { jobs: [], skipped: true, error: null };
  }
  const fetcher = ATS_FETCHERS[employer.ats_provider];
  if (!fetcher) {
    return { jobs: [], skipped: true, error: `Unsupported ATS provider ${employer.ats_provider}` };
  }
  try {
    return { jobs: await fetcher(employer), skipped: false, error: null };
  } catch (error) {
    if (error.skipped) {
      return { jobs: [], skipped: true, error: null };
    }
    return { jobs: [], skipped: false, error: error.message };
  }
}

async function runRefresh() {
  const registryEmployers = await readJson(EMPLOYERS_PATH, []);
  const enrichment = await readJson(ENRICHMENT_PATH, null);
  const employers = applyEnrichmentOverlay(registryEmployers, enrichment);
  // Lifecycle state (first_seen_at, tombstones) lives in Supabase once the
  // dataset stops being committed; the local file remains the fallback
  let previousJobs = null;
  try {
    previousJobs = await fetchAllJobs();
    if (previousJobs) console.log(`Loaded ${previousJobs.length} previous jobs from Supabase`);
  } catch (error) {
    console.warn(`Supabase previous-state read failed, using local file: ${error.message}`);
  }
  if (!previousJobs) previousJobs = await readJson(JOBS_PATH, []);
  const dolSignals = await readJson(DOL_SIGNALS_PATH, {});
  const previousById = new Map(previousJobs.map((job) => [job.id, job]));
  const fetchedJobs = [];
  const employerReports = [];
  const employerOutcomes = new Map();

  let networkHits = 0;
  for (const employer of employers) {
    validateEmployer(employer);
    if (employer.ats_provider && networkHits > 0) {
      await sleep(EMPLOYER_DELAY_MS);
    }
    if (employer.ats_provider) networkHits += 1;
    const result = await fetchEmployerJobs(employer);
    let enriched = result.jobs
      .filter((job) => job.url && job.description_text)
      .map((job) => enrichJob(job, employer, previousById, dolSignals[employer.id]));
    // Auto-wired employers (discovery crawl) keep only research-relevant
    // postings — a wired university means thousands of roles, and committing
    // the cafeteria shifts would drown the dataset the radar exists for
    if (employer.tier === 'auto') {
      enriched = enriched.filter((job) =>
        job.research_relevance_score >= AUTO_TIER_MIN_RESEARCH_SCORE || job.class_evidence);
    }
    fetchedJobs.push(...enriched);
    employerOutcomes.set(employer.id, { attempted: !result.skipped, ok: !result.error });
    employerReports.push({
      employer_id: employer.id,
      name: employer.name,
      ats_provider: employer.ats_provider,
      ats_token: employer.ats_token,
      fetched_jobs: enriched.length,
      skipped: result.skipped,
      error: result.error
    });
  }

  const now = nowIso();

  // Merge scouted jobs (external producer snapshots) for employers whose live
  // ATS fetch did not succeed this run — scout data is a fallback, not a
  // duplicate of a working feed. A fresh snapshot with zero jobs and no
  // skipped_reason means "scouted, nothing found" and closes previous scouted
  // jobs; a skipped_reason snapshot carries them forward like an errored fetch.
  const scoutedStore = await readJson(SCOUTED_JOBS_PATH, { jobs: [], snapshots: {} });
  const scoutedByEmployer = new Map();
  for (const job of activeScoutedJobs(scoutedStore, now)) {
    if (!scoutedByEmployer.has(job.employer_id)) scoutedByEmployer.set(job.employer_id, []);
    scoutedByEmployer.get(job.employer_id).push(job);
  }
  const employersById = new Map(employers.map((employer) => [employer.id, employer]));
  const scoutedTtlMs = SCOUTED_TTL_DAYS * 24 * 60 * 60 * 1000;
  for (const [employerId, snapshot] of Object.entries(scoutedStore.snapshots || {})) {
    const employer = employersById.get(employerId);
    if (!employer) continue;
    const scoutedAt = Date.parse(snapshot.scouted_at || '');
    if (!Number.isFinite(scoutedAt) || Date.parse(now) - scoutedAt > scoutedTtlMs) continue;
    if (snapshot.skipped_reason) continue;
    const outcome = employerOutcomes.get(employerId);
    if (outcome && outcome.attempted && outcome.ok) continue;
    const enriched = (scoutedByEmployer.get(employerId) || [])
      .filter((job) => job.url && job.title)
      .map((job) => {
        const enrichedJob = enrichJob(job, employer, previousById, dolSignals[employerId]);
        enrichedJob.disclaimer += ' Extracted by an automated scout from the employer careers page; verify details at the source URL.';
        return enrichedJob;
      });
    fetchedJobs.push(...enriched);
    employerOutcomes.set(employerId, { attempted: true, ok: true });
    const employerReport = employerReports.find((report) => report.employer_id === employerId);
    if (employerReport) {
      employerReport.fetched_jobs += enriched.length;
      employerReport.scouted_jobs = enriched.length;
      employerReport.skipped = false;
    }
  }

  // Merge the aggregator firehose (cap-exempt-filtered jobs from research
  // boards). Jobs use pseudo employer ids (agg:<slug>) so they never collide
  // with registry lifecycle outcomes. Fresh source snapshot -> jobs active;
  // stale/expired -> previous jobs tombstone via the normal lifecycle.
  const aggregatedStore = await readJson(AGGREGATED_JOBS_PATH, { jobs: [], snapshots: {} });
  const aggregatedTtlMs = AGGREGATED_TTL_DAYS * 24 * 60 * 60 * 1000;
  const aggregatedSources = new Set(Object.keys(aggregatedStore.snapshots || {}));
  let aggregatedMerged = 0;
  for (const job of aggregatedStore.jobs || []) {
    if (!job.url || !job.title) continue;
    const snapshot = (aggregatedStore.snapshots || {})[job.source];
    const scoutedAt = Date.parse(snapshot?.scouted_at || '');
    if (!Number.isFinite(scoutedAt) || Date.parse(now) - scoutedAt > aggregatedTtlMs) continue;
    const pseudoEmployer = {
      id: job.employer_id,
      name: job.employer_name,
      type: job.employer_kind === 'ipeds' || job.employer_kind === 'both'
        ? 'institution_of_higher_education'
        : 'nonprofit_research_org',
      cap_exempt_status: 'likely',
      cap_exempt_score: job.cap_exempt_score ?? null,
      evidence_sources: [
        'cap_exempt_directory',
        ...(job.directory_evidence?.unitid ? [`ipeds:${job.directory_evidence.unitid}`] : []),
        ...(job.directory_evidence?.ein ? ['irs_eo_bmf'] : []),
        ...(job.directory_evidence?.uscis_approvals_3y ? ['uscis_h1b_datahub'] : [])
      ],
      ats_provider: null,
      ats_token: null,
      research_areas: [],
      notes: `Matched to the cap-exempt directory from the ${job.source} feed.`
    };
    const enrichedJob = enrichJob(job, pseudoEmployer, previousById, {});
    enrichedJob.disclaimer += ' Sourced from a job aggregator; verify details at the source URL.';
    if (!String(job.description_text || '').trim()) {
      // The firehose only detail-fetches a budgeted subset; a NEUTRAL visa
      // state here means "never read the posting", not "scanned, no language"
      enrichedJob.description_captured = false;
      enrichedJob.disclaimer += ' Description text was not captured; visa and research signals reflect the title only.';
    }
    fetchedJobs.push(enrichedJob);
    aggregatedMerged += 1;
  }
  // Outcomes: every pseudo-employer whose source has a snapshot gets ok, so
  // vanished/expired aggregated jobs close instead of dangling
  const aggregatedEmployerIds = new Set((aggregatedStore.jobs || []).map((job) => job.employer_id));
  for (const previous of previousJobs) {
    if (String(previous.employer_id || '').startsWith('agg:') && aggregatedSources.has(previous.source)) {
      aggregatedEmployerIds.add(previous.employer_id);
    }
  }
  for (const employerId of aggregatedEmployerIds) {
    employerOutcomes.set(employerId, { attempted: true, ok: true });
  }
  if (aggregatedMerged > 0) {
    console.log(`Merged ${aggregatedMerged} aggregated cap-exempt jobs from ${aggregatedSources.size} sources`);
  }

  // ATS feeds occasionally list one requisition twice (same id, two paths);
  // first occurrence wins so the dataset never carries duplicate ids
  const uniqueFetched = [...new Map(fetchedJobs.map((job) => [job.id, job]).reverse()).values()].reverse();

  const allJobs = applyJobLifecycle({ previousJobs, fetchedJobs: uniqueFetched, employerOutcomes, now });

  allJobs.sort((a, b) => {
    const statusDelta = (a.status === 'closed' ? 1 : 0) - (b.status === 'closed' ? 1 : 0);
    if (statusDelta !== 0) return statusDelta;
    const scoreDelta = b.research_relevance_score - a.research_relevance_score;
    if (scoreDelta !== 0) return scoreDelta;
    return String(b.posted_or_updated_at || '').localeCompare(String(a.posted_or_updated_at || ''));
  });

  const closedJobs = allJobs.filter((job) => job.status === 'closed');
  for (const employerReport of employerReports) {
    employerReport.closed_jobs = closedJobs.filter((job) => job.employer_id === employerReport.employer_id).length;
  }

  const report = {
    refreshed_at: now,
    employer_count: employers.length,
    ats_enabled_employer_count: employers.filter((employer) => employer.ats_provider).length,
    job_count: allJobs.length,
    active_job_count: allJobs.length - closedJobs.length,
    closed_job_count: closedJobs.length,
    newly_closed_count: closedJobs.filter((job) => job.closed_at === now).length,
    errored_employers: employerReports.filter((report) => report.error).length,
    sources: {
      greenhouse: 'https://developers.greenhouse.io/job-board.html',
      lever: 'https://github.com/lever/postings-api',
      ashby: 'https://developers.ashbyhq.com/docs/public-job-posting-api',
      smartrecruiters: 'https://developers.smartrecruiters.com/docs/posting-api',
      workday: 'public myworkdayjobs.com CXS job feed (per-tenant)',
      recruitee: 'public {org}.recruitee.com/api/offers/ feed',
      breezy: 'public {org}.breezy.hr/json feed',
      workable: 'https://apply.workable.com/api/v1/widget/accounts/{org}',
      usajobs: 'https://developer.usajobs.gov/api-reference/get-api-search',
      dol_oflc: 'https://www.dol.gov/agencies/eta/foreign-labor/performance',
      ipeds: 'https://nces.ed.gov/ipeds/use-the-data',
      irs_eo_bmf: 'https://www.irs.gov/charities-non-profits/exempt-organizations-business-master-file-extract-eo-bmf'
    },
    employers: employerReports
  };

  await writeJson(JOBS_PATH, allJobs);
  await writeJson(REPORT_PATH, report);
  console.log(`Radar refresh complete: ${allJobs.length} jobs from ${employers.length} employers`);
  if (report.errored_employers) {
    console.log(`${report.errored_employers} employers had fetch errors; see ${path.relative(ROOT, REPORT_PATH)}`);
  }

  // Dual-write phase: Supabase mirrors the dataset when credentials exist;
  // git stays canonical, so a sync failure warns but never fails the refresh
  try {
    const sync = await syncJobs(allJobs, report);
    console.log(sync.synced
      ? `Supabase sync: ${sync.count} jobs mirrored`
      : `Supabase sync skipped (${sync.reason})`);
  } catch (error) {
    console.warn(`Supabase sync failed (git dataset unaffected): ${error.message}`);
  }
  return report;
}

if (require.main === module) {
  runRefresh().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  normalizeText,
  matchSignals,
  scoreResearchRelevance,
  enrichJob,
  fetchJson,
  isRetryableFetchError,
  mapGreenhouseJob,
  mapLeverJob,
  mapAshbyJob,
  mapSmartRecruitersPosting,
  mapWorkdayJob,
  mapRecruiteeJob,
  mapBreezyJob,
  mapWorkableJob,
  mapUsaJobsJob,
  fetchUsaJobsJobs,
  isResearchRelevantTitle,
  applyJobLifecycle,
  activeScoutedJobs,
  applyEnrichmentOverlay,
  fetchGreenhouseJobs,
  fetchLeverJobs,
  fetchAshbyJobs,
  fetchSmartRecruitersJobs,
  fetchWorkdayJobs,
  runRefresh
};
