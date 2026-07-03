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

async function fetchJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: {
        accept: 'application/json',
        'user-agent': USER_AGENT
      },
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    return response.json();
  } finally {
    clearTimeout(timeout);
  }
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
  if (employer.ats_provider && !['greenhouse', 'lever'].includes(employer.ats_provider)) {
    throw new Error(`Employer ${employer.id} has unsupported ats_provider ${employer.ats_provider}`);
  }
  if (employer.ats_provider && !employer.ats_token) {
    throw new Error(`Employer ${employer.id} has ats_provider but no ats_token`);
  }
}

async function fetchGreenhouseJobs(employer) {
  const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(employer.ats_token)}/jobs?content=true`;
  const payload = await fetchJson(url);
  return (payload.jobs || []).map((job) => {
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
  });
}

async function fetchLeverJobs(employer) {
  const url = `https://api.lever.co/v0/postings/${encodeURIComponent(employer.ats_token)}?mode=json`;
  const payload = await fetchJson(url);
  return (Array.isArray(payload) ? payload : []).map((job) => {
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
  });
}

async function fetchEmployerJobs(employer) {
  if (!employer.ats_provider) {
    return { jobs: [], skipped: true, error: null };
  }
  try {
    if (employer.ats_provider === 'greenhouse') {
      return { jobs: await fetchGreenhouseJobs(employer), skipped: false, error: null };
    }
    if (employer.ats_provider === 'lever') {
      return { jobs: await fetchLeverJobs(employer), skipped: false, error: null };
    }
    return { jobs: [], skipped: true, error: `Unsupported ATS provider ${employer.ats_provider}` };
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

  for (const employer of employers) {
    validateEmployer(employer);
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
  fetchGreenhouseJobs,
  fetchLeverJobs,
  runRefresh
};
