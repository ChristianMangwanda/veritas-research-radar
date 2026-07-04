#!/usr/bin/env node

const fs = require('fs/promises');
const path = require('path');
const { analyzeText } = require('../../scripts/keywords.js');

const ROOT = path.resolve(__dirname, '../..');
const RADAR_DIR = path.join(ROOT, 'radar');
const DATA_DIR = path.join(RADAR_DIR, 'data');
const EMPLOYERS_PATH = path.join(RADAR_DIR, 'employers.json');
const JOBS_PATH = path.join(DATA_DIR, 'jobs.json');
const REPORT_PATH = path.join(DATA_DIR, 'refresh-report.json');
const DOL_SIGNALS_PATH = path.join(DATA_DIR, 'dol-sponsor-signals.json');

const USER_AGENT = 'VeritasResearchRadar/1.0 (+https://github.com/ChristianMangwanda/Veritas)';
const REQUEST_TIMEOUT_MS = 20000;
const EMPLOYER_DELAY_MS = 500;
const SMARTRECRUITERS_PAGE_LIMIT = 100;
const SMARTRECRUITERS_MAX_PAGES = 5;
const SMARTRECRUITERS_DETAIL_DELAY_MS = 200;
const SUPPORTED_ATS_PROVIDERS = ['greenhouse', 'lever', 'ashby', 'smartrecruiters'];

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
  const { method = 'GET', body, retries = 1, retryDelayMs = 1000 } = options;
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
          ...(body ? { 'content-type': 'application/json' } : {})
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

function sponsorSignal(veritasState, dolCount) {
  if (veritasState === 'RESTRICTED') return 'restricted';
  if (dolCount >= 10) return 'strong';
  if (veritasState === 'FRIENDLY') return 'moderate';
  if (dolCount > 0) return 'weak';
  return 'unknown';
}

function enrichJob(job, employer, previousById, dolSignal = {}) {
  const text = `${job.title}\n${job.department}\n${job.description_text}`;
  const veritas = analyzeText(text);
  const signals = matchSignals(text);
  const previous = previousById.get(job.id);
  const dolCount = Number(dolSignal.certified_count_3y || employer.dol_lca_certified_count_3y || 0);

  return {
    ...job,
    employer_name: employer.name,
    employer_type: employer.type,
    cap_exempt_status: employer.cap_exempt_status,
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
    sponsor_signal: sponsorSignal(veritas.state, dolCount),
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

const ATS_FETCHERS = {
  greenhouse: fetchGreenhouseJobs,
  lever: fetchLeverJobs,
  ashby: fetchAshbyJobs,
  smartrecruiters: fetchSmartRecruitersJobs
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
    return { jobs: [], skipped: false, error: error.message };
  }
}

async function runRefresh() {
  const employers = await readJson(EMPLOYERS_PATH, []);
  const previousJobs = await readJson(JOBS_PATH, []);
  const dolSignals = await readJson(DOL_SIGNALS_PATH, {});
  const previousById = new Map(previousJobs.map((job) => [job.id, job]));
  const allJobs = [];
  const employerReports = [];

  let networkHits = 0;
  for (const employer of employers) {
    validateEmployer(employer);
    if (employer.ats_provider && networkHits > 0) {
      await sleep(EMPLOYER_DELAY_MS);
    }
    if (employer.ats_provider) networkHits += 1;
    const result = await fetchEmployerJobs(employer);
    const enriched = result.jobs
      .filter((job) => job.url && job.description_text)
      .map((job) => enrichJob(job, employer, previousById, dolSignals[employer.id]));
    allJobs.push(...enriched);
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

  allJobs.sort((a, b) => {
    const scoreDelta = b.research_relevance_score - a.research_relevance_score;
    if (scoreDelta !== 0) return scoreDelta;
    return String(b.posted_or_updated_at || '').localeCompare(String(a.posted_or_updated_at || ''));
  });

  const report = {
    refreshed_at: nowIso(),
    employer_count: employers.length,
    ats_enabled_employer_count: employers.filter((employer) => employer.ats_provider).length,
    job_count: allJobs.length,
    errored_employers: employerReports.filter((report) => report.error).length,
    sources: {
      greenhouse: 'https://developers.greenhouse.io/job-board.html',
      lever: 'https://github.com/lever/postings-api',
      ashby: 'https://developers.ashbyhq.com/docs/public-job-posting-api',
      smartrecruiters: 'https://developers.smartrecruiters.com/docs/posting-api',
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
  fetchGreenhouseJobs,
  fetchLeverJobs,
  fetchAshbyJobs,
  fetchSmartRecruitersJobs,
  runRefresh
};
