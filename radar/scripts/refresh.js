#!/usr/bin/env node

const fs = require('fs/promises');
const path = require('path');
const { analyzeText } = require('../../scripts/keywords.js');
const { classifyTitle, classLabel } = require('./lib/title-class.js');
const { parseSalary } = require('./lib/salary.js');
const { parseDeadline } = require('./lib/deadline.js');
const { syncJobs, fetchAllJobs, supabaseEnv } = require('./lib/supabase.js');

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
// An employer that had this many active jobs and now fetches zero on an OK
// (non-skipped, non-errored) feed is almost certainly a broken feed, not a
// real emptying — every one of those jobs is about to be tombstoned silently.
const RECALL_ALARM_MIN_ACTIVE = 5;

/**
 * Flag employers whose live feed dropped from >= RECALL_ALARM_MIN_ACTIVE
 * active jobs to zero on a fetch that reported OK. These are the silent
 * mass-tombstone events: the lifecycle will close every prior job because the
 * feed "succeeded" with nothing, so the loss never shows up as an error.
 * Errored/skipped feeds are excluded — the lifecycle already carries their
 * jobs forward untouched.
 */
function detectRecallAnomalies({ previousJobs, employerReports, employerOutcomes, minActive = RECALL_ALARM_MIN_ACTIVE }) {
  const previousActive = new Map();
  for (const job of previousJobs) {
    if (job.status === 'closed') continue;
    const id = job.employer_id;
    previousActive.set(id, (previousActive.get(id) || 0) + 1);
  }
  const anomalies = [];
  for (const report of employerReports) {
    const before = previousActive.get(report.employer_id) || 0;
    const outcome = employerOutcomes.get(report.employer_id);
    const okFetch = Boolean(outcome && outcome.attempted && outcome.ok);
    if (okFetch && report.fetched_jobs === 0 && before >= minActive) {
      anomalies.push({
        employer_id: report.employer_id,
        name: report.name,
        ats_provider: report.ats_provider,
        previous_active: before
      });
    }
    // Multi-feed employers: fetched_jobs is a SUM across feeds, so one feed
    // silently dying can hide behind another feed's healthy count and never
    // trip the check above. This has no previous-active baseline to compare
    // against (unlike the per-employer check), so it's a coarser signal —
    // "a wired feed returned zero jobs with no error" — but that alone is
    // already meaningful for an employer known to have more than one feed.
    if (report.feeds) {
      for (const feed of report.feeds) {
        if (feed.ok && !feed.skipped && feed.fetchedCount === 0) {
          anomalies.push({
            employer_id: report.employer_id,
            name: report.name,
            ats_provider: feed.ats_provider,
            previous_active: null,
            partial_feed: true
          });
        }
      }
    }
  }
  return anomalies;
}

// Below this ratio of excluded-to-seen titles, an employer's prefilter is
// doing its job (skipping cafeteria/facilities postings on a large tenant).
// Above it, on a large-enough sample, the pattern set itself is the more
// likely explanation — this is how the "Open Rank" faculty-title miss should
// have been caught the day it was introduced, instead of by chance.
// Calibrated 2026-08-04 against the first live production batch (21 flagged
// employers): the ratio compared prefiltered_count against fetched_jobs (the
// FINAL count, after the separate auto-tier relevance-score filter), which
// conflated two independent filters — fixed by comparing against
// prefilter_survived_count instead (the title-prefilter's own pass-through).
// That alone dropped 21 -> 5; manually reviewing all 5 remaining found no
// regex gaps, just genuinely low-research employers (a seminary, a trade
// college, an enrollment/business-services company). MIN_EXCLUDED raised
// 20 -> 25 to drop two of those five sitting exactly at the old floor
// (20 excluded, 0 survived) — too small a sample to distinguish "genuinely
// no research openings" from noise either way, so not worth alarm fatigue.
const PREFILTER_ALARM_MIN_EXCLUDED = 25;
const PREFILTER_ALARM_RATIO = 0.97;

/**
 * Flag employers whose pre-fetch title prefilter (workday/oracle/
 * successfactors/eightfold) excluded a suspiciously high share of titles this
 * run. Unlike detectRecallAnomalies this is a within-run ratio with no
 * previous-state dependency, so it runs even when the previous-jobs baseline
 * isn't trusted.
 */
function detectPrefilterAnomalies({ employerReports, minExcluded = PREFILTER_ALARM_MIN_EXCLUDED, ratioThreshold = PREFILTER_ALARM_RATIO }) {
  const anomalies = [];
  for (const report of employerReports) {
    // fetched_jobs is the FINAL count, after the separate auto-tier
    // relevance-score filter — comparing prefiltered_count against it
    // conflates two independent filters. An auto-tier employer whose
    // prefilter-passed titles all legitimately score too low looks
    // identical to a broken prefilter regex unless we use the prefilter's
    // own pass-through count instead (confirmed live against Bank Street
    // College of Education: prefilter passed 4 titles fine; all 4 correctly
    // scored below the auto-tier threshold — not a prefilter bug).
    if (report.prefilter_survived_count == null) continue;
    const excluded = report.prefiltered_count || 0;
    const seen = excluded + report.prefilter_survived_count;
    if (excluded < minExcluded || seen === 0) continue;
    if (excluded / seen >= ratioThreshold) {
      anomalies.push({
        employer_id: report.employer_id,
        name: report.name,
        ats_provider: report.ats_provider,
        prefiltered_count: excluded,
        prefilter_survived_count: report.prefilter_survived_count,
        fetched_jobs: report.fetched_jobs
      });
    }
  }
  return anomalies;
}

/**
 * Best-effort ntfy.sh push. No-ops without NTFY_TOPIC and never throws — an
 * alert channel that can break the refresh is worse than no alert.
 */
async function pushNtfy({ title, body, tags = 'satellite' }) {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) {
    console.log('NTFY_TOPIC not set — alert printed only.');
    return;
  }
  try {
    const response = await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
      method: 'POST',
      headers: { Title: title, Tags: tags },
      body
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  } catch (error) {
    console.warn(`ntfy alert failed: ${error.message}`);
  }
}

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
// Pacing is per ATS VENDOR, not global: two different Workday tenants are two
// different hosts and fetching them at the same time is no less polite than
// fetching them an hour apart. So employers run concurrently, and the delay
// that used to sit between every employer now staggers the START of each
// employer within one provider.
const EMPLOYER_DELAY_MS = 500;
// How many employers may be in flight at once, and how many of those may
// belong to the same ATS vendor. The vendor cap is the real politeness knob —
// without it, 170 Workday tenants would all be hit at once. Both are env-
// tunable so a run can be throttled without a code change.
const REFRESH_CONCURRENCY = Math.max(1, Number(process.env.REFRESH_CONCURRENCY) || 8);
const REFRESH_PROVIDER_CONCURRENCY = Math.max(1, Number(process.env.REFRESH_PROVIDER_CONCURRENCY) || 4);
/* One global number cannot serve every vendor. Workday's tenants are genuinely
 * separate hosts, so four at once is nothing; ADP's 47 tenants are all one host
 * and four at once is what makes six of them answer 429 on every single run.
 * Named vendors override the global cap and the stagger. */
const PROVIDER_LIMITS = { adp: 1 };
const PROVIDER_DELAY_MS = { adp: 3000 };
// Auto-wired (tier: "auto") employers only commit research-relevant postings
const AUTO_TIER_MIN_RESEARCH_SCORE = 25;
const SMARTRECRUITERS_PAGE_LIMIT = 100;
const SMARTRECRUITERS_MAX_PAGES = 10;
const SMARTRECRUITERS_DETAIL_DELAY_MS = 200;
const WORKDAY_PAGE_LIMIT = 20;
const WORKDAY_MAX_PAGES = 50;
const WORKDAY_MAX_DETAIL_FETCHES = 400;
const WORKDAY_DETAIL_DELAY_MS = 250;
// Oracle Fusion HCM "CandidateExperience" REST feed (Stanford, Mayo, Northwestern…).
// Same shape as Workday: a large flat requisition list, description behind a
// per-job detail call — so title-prefilter before spending detail requests.
const ORACLE_PAGE_LIMIT = 25;
const ORACLE_MAX_PAGES = 60;
const ORACLE_MAX_DETAIL_FETCHES = 400;
const ORACLE_DETAIL_DELAY_MS = 200;
// UltiPro / UKG Recruiting "JobBoard" JSON API (Salk, and other UKG tenants).
// The public LoadSearchResults endpoint returns titles + a real BriefDescription
// (a few hundred chars) inline, so no per-job detail call is needed. A tenant can
// expose several board GUIDs (staff, faculty…); iterate over all configured.
const ULTIPRO_PAGE_LIMIT = 100;
const ULTIPRO_MAX_PAGES = 20;
const ULTIPRO_BOARD_DELAY_MS = 300;
// Taleo Enterprise. The career section serves no session cookie and no CSRF —
// what it wants is a `tz` REQUEST HEADER. Without it every REST call answers
// HTTP 500 "An Error Occurred in TEE", which reads like a block and is not one:
// this cost an earlier session a day and the wrong conclusion that Taleo needed
// a headless browser. A browser does not help (Playwright's context.request 500s
// too); the header does, from plain fetch. Page size is fixed at 25 server-side.
const TALEO_PAGE_SIZE = 25;
const TALEO_MAX_PAGES = 60;
const TALEO_MAX_DETAIL_FETCHES = 400;
const TALEO_DETAIL_DELAY_MS = 250;
const TALEO_TZ = 'GMT-05:00';
const TALEO_TZNAME = 'America/Chicago';
const SUCCESSFACTORS_MAX_DETAIL_FETCHES = 400;
const SUCCESSFACTORS_DETAIL_DELAY_MS = 250;
// Eightfold's PCSX search ignores every page-size param and always returns 10.
const EIGHTFOLD_MAX_PAGES = 80;
const EIGHTFOLD_MAX_DETAIL_FETCHES = 400;
const EIGHTFOLD_DETAIL_DELAY_MS = 200;
const PAYLOCITY_MAX_DETAIL_FETCHES = 400;
const PAYLOCITY_DETAIL_DELAY_MS = 200;
// Interfolio "Faculty Search" public job board — found by network-capturing
// the Angular SPA at apply.interfolio.com; the list response already carries
// full HTML description/qualifications/instructions, so no detail fetch is
// needed (unlike the separate dossier-api position lookup, which uses an
// unrelated internal id space and isn't used here).
const INTERFOLIO_PAGE_LIMIT = 100;
const INTERFOLIO_MAX_PAGES = 30;
const INTERFOLIO_PAGE_DELAY_MS = 300;
// GovernmentJobs/NeoGov (schooljobs.com for education-sector tenants) — the
// same list URL a browser hits serves the full page shell UNLESS the request
// carries an X-Requested-With: XMLHttpRequest header, in which case it
// returns just the plain HTML job table fragment (found by network-capturing
// the real request). List rows carry no description, so detail pages are
// fetched per job like Workday/Oracle.
const GOVERNMENTJOBS_PAGE_SIZE = 10;
const GOVERNMENTJOBS_MAX_PAGES = 60;
const GOVERNMENTJOBS_MAX_DETAIL_FETCHES = 400;
const GOVERNMENTJOBS_DETAIL_DELAY_MS = 200;
const USAJOBS_PAGE_SIZE = 500;
const USAJOBS_MAX_PAGES_PER_QUERY = 5;
const USAJOBS_PAGE_DELAY_MS = 300;

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

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return String(url).slice(0, 60);
  }
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
      try {
        return await response.json();
      } catch {
        /* A 200 carrying HTML is how a board says "challenge" or "maintenance"
         * without saying it. Unwrapped, that surfaces as "Unexpected token '<'",
         * which reads like a parser bug and hides that the whole provider may be
         * answering the same way. Label it, and mark it deterministic: the same
         * request will produce the same page a second later. */
        const contentType = response.headers?.get?.('content-type') || 'unknown';
        const error = new Error(`non-JSON response (content-type ${contentType}) from ${hostOf(url)}`);
        error.status = response.status;
        error.nonJson = true;
        throw error;
      }
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

// Normalized work mode from title/location (high signal) then a conservative
// description scan (bare "remote" in a description is noise — "remote sensing",
// "remote monitoring" — so only explicit phrases count there).
function detectWorkMode(job) {
  const title = String(job.title || '');
  const loc = String(job.location || '');
  const desc = String(job.description_text || '');
  const remoteRe = /\bremote\b|\btelecommut/i;
  if (remoteRe.test(title) || remoteRe.test(loc)) return 'remote';
  if (/\bhybrid\b/i.test(title) || /\bhybrid\b/i.test(loc)) return 'hybrid';
  if (/\b(fully|100%|position is|role is|this is a)\s+remote\b|remote[- ]first|remote\s+(position|work|eligible|opportunity)|work\s+from\s+(home|anywhere)|telecommut\w*/i.test(desc)) return 'remote';
  if (/\bhybrid\b/i.test(desc)) return 'hybrid';
  return null;
}

// Single-campus feeds (PeopleAdmin) carry no location, but many institution
// names encode the campus city as a trailing "… at City". Fire only on that
// clear pattern — a wrong city is worse than "Unspecified".
function institutionCity(name) {
  const match = String(name || '').match(/\bat\s+([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){0,2})\s*$/);
  return match ? match[1].trim() : null;
}

function normalizeLocation(job, employer, workMode) {
  let location = job.location;
  const missing = !location || location === 'Unspecified';
  if (workMode === 'remote' && missing) return 'Remote';
  if (missing && job.source === 'peopleadmin') return institutionCity(employer.name) || location;
  return location;
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

  const workMode = detectWorkMode(job);
  // Salary: a dedicated comp field (Ashby) is trusted for single figures too;
  // free description text only yields a range (avoids bonuses/stipends).
  const salary = parseSalary(job.compensation_text, { trusted: true })
    || parseSalary(job.description_text);
  // Structured close date (USAJOBS) wins; otherwise a cue-anchored body parse.
  const deadline = job.deadline_raw || parseDeadline(job.description_text);

  return {
    ...job,
    location: normalizeLocation(job, employer, workMode),
    work_mode: workMode,
    remote: workMode === 'remote',
    deadline: deadline || null,
    salary_min: salary?.salary_min ?? null,
    salary_max: salary?.salary_max ?? null,
    salary_period: salary?.salary_period ?? null,
    salary_currency: salary?.salary_currency ?? null,
    employer_name: employer.name,
    cap_exempt_status: employer.cap_exempt_status,
    cap_exempt_score: employer.cap_exempt_score ?? null,
    cap_exempt_evidence_sources: employer.evidence_sources || [],
    /* employer_type and cap_exempt_notes used to be stamped here. Both
     * described the EMPLOYER, not the posting, so the registry's note —
     * "Auto-wired from ATS discovery crawl (2026-07-06); probe saw 5 live
     * postings…" — was copied onto every one of its jobs: 22 distinct strings
     * across a 400-job sample, and nothing anywhere ever read either field.
     * They cost 303 bytes a row, which is 4.6MB of JSON the browser parsed
     * and cached for no reader. Registry facts belong in radar/employers.json,
     * which is where they already are. */
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
// Source authority tiers for cross-source dedup: an employer's own ATS feed
// beats a scraped scout snapshot beats an aggregator listing.
function sourceTier(job) {
  if (String(job.employer_id || '').startsWith('agg:')) return 1; // aggregator firehose
  if (job.source === 'agent_scout') return 2;                     // scout snapshot
  return 3;                                                        // direct ATS / USAJOBS
}

/**
 * Collapse the SAME role surfaced by more than one source. Keys on normalized
 * (employer + title + location) and keeps only the highest-tier jobs per key.
 * Crucially it never dedupes within a tier — universities post many genuinely
 * distinct reqs with identical titles, so same-source same-title jobs are all
 * kept; only lower-tier cross-source duplicates are dropped.
 */
function dedupeCrossSource(jobs) {
  const norm = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const keyOf = (job) => `${norm(job.employer_name) || job.employer_id}|${norm(job.title)}|${norm(job.location)}`;
  const bestTier = new Map();
  for (const job of jobs) {
    const key = keyOf(job);
    const tier = sourceTier(job);
    if (!bestTier.has(key) || tier > bestTier.get(key)) bestTier.set(key, tier);
  }
  return jobs.filter((job) => sourceTier(job) === bestTier.get(keyOf(job)));
}

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

// Shared by the primary feed and every secondary_ats_feeds entry — label
// identifies which one in a thrown error (e.g. "Employer x" vs
// "Employer x secondary_ats_feeds[0]").
function validateAtsFeedConfig(label, provider, token, config) {
  if (!SUPPORTED_ATS_PROVIDERS.includes(provider)) {
    throw new Error(`${label} has unsupported ats_provider ${provider}`);
  }
  if (!token) {
    throw new Error(`${label} has ats_provider but no ats_token`);
  }
  if (provider === 'workday') {
    for (const key of ['host', 'tenant', 'site']) {
      if (!(config || {})[key]) throw new Error(`${label} uses workday but ats_config.${key} is missing`);
    }
  }
  if (provider === 'oracle') {
    for (const key of ['host', 'site_name', 'site_number']) {
      if (!(config || {})[key]) throw new Error(`${label} uses oracle but ats_config.${key} is missing`);
    }
  }
  // Taleo needs a host plus at least one career section, each with the portal
  // number the REST call requires — a section code alone answers 200 with
  // careerSectionUnAvailable, which no HTTP status would reveal.
  if (provider === 'taleo') {
    if (!config?.host) throw new Error(`${label} uses taleo but ats_config.host is missing`);
    const sections = config.sections
      || [{ code: config.career_section, portal: config.portal }];
    if (!sections.length || sections.some((section) => !section?.code || !section?.portal)) {
      throw new Error(`${label} uses taleo but ats_config.sections needs {code, portal} entries`);
    }
  }
  if (provider === 'paylocity' && !config?.client_guid) {
    throw new Error(`${label} uses paylocity but ats_config.client_guid is missing`);
  }
  if (provider === 'interfolio' && !config?.tenant_id) {
    throw new Error(`${label} uses interfolio but ats_config.tenant_id is missing`);
  }
  if (provider === 'governmentjobs' && !config?.agency) {
    throw new Error(`${label} uses governmentjobs but ats_config.agency is missing`);
  }
  // site_id 0 is not a real Cornerstone site, but check for presence rather
  // than truthiness anyway so a config bug reads as "missing" only when it is.
  if (provider === 'csod' && (config?.site_id === undefined || config?.site_id === null || config?.site_id === '')) {
    throw new Error(`${label} uses csod but ats_config.site_id is missing`);
  }
}

function validateEmployer(employer) {
  const required = ['id', 'name', 'type', 'cap_exempt_status', 'evidence_sources', 'careers_url'];
  for (const key of required) {
    if (!employer[key]) throw new Error(`Employer ${employer.id || employer.name || '<unknown>'} is missing ${key}`);
  }
  const label = `Employer ${employer.id}`;
  if (employer.ats_provider) {
    validateAtsFeedConfig(label, employer.ats_provider, employer.ats_token, employer.ats_config);
  }
  (employer.secondary_ats_feeds || []).forEach((feed, index) => {
    validateAtsFeedConfig(`${label} secondary_ats_feeds[${index}]`, feed.ats_provider, feed.ats_token, feed.ats_config);
  });
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
    source_job_id: String(job.id),
    // Ashby returns structured comp (includeCompensation=true) — keep the
    // summary string so enrichJob can parse it as a trusted salary source
    compensation_text: job.compensation?.compensationTierSummary
      || job.compensation?.scrapeableCompensationSalarySummary || ''
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
  /\bsoftware\s+engineer/i,
  // Broadened so faculty/analyst/developer/informatics roles are fetched and
  // classified instead of dropped before they ever reach the taxonomy.
  /\b(professor|lecturer|faculty)\b|open[ -](rank|level)/i,
  /\banalyst\b/i,
  /\b(developer|programmer)\b/i,
  /\binformatics\b/i,
  /\bstatistic/i,
  /\b(ai|ml)\b/i
];

function isResearchRelevantTitle(title, employer) {
  if (WORKDAY_TITLE_PREFILTER.some((pattern) => pattern.test(title))) return true;
  const lower = String(title).toLowerCase();
  return (employer.research_areas || []).some((area) => lower.includes(String(area).toLowerCase()));
}

// The prefilter above trades recall for request volume — anything it rejects
// never gets a detail fetch and leaves no trace. Callers stamp the excluded
// count onto their returned job array (see detectPrefilterAnomalies) so a bad
// or incomplete pattern shows up as a report anomaly instead of a silent miss.
function filterResearchRelevant(items, getTitle, employer) {
  const relevant = [];
  let excluded = 0;
  for (const item of items) {
    if (isResearchRelevantTitle(getTitle(item) || '', employer)) {
      relevant.push(item);
    } else {
      excluded += 1;
    }
  }
  return { relevant, excluded };
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

  const { relevant: filtered, excluded } = filterResearchRelevant(uniqueListings, (item) => item.title, employer);
  const relevant = filtered.slice(0, WORKDAY_MAX_DETAIL_FETCHES);

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
  jobs.prefiltered_count = excluded;
  jobs.prefilter_survived_count = filtered.length;
  return jobs;
}

function mapOracleJob(listItem, detail, employer) {
  const config = employer.ats_config || {};
  const id = String(listItem.Id);
  // Prefer the fuller detail record when a per-job fetch succeeded.
  const description = normalizeText(
    [detail?.ExternalDescriptionStr, detail?.ExternalQualificationsStr].filter(Boolean).join('\n\n')
  );
  const secondary = (listItem.secondaryLocations || [])
    .map((loc) => loc.Name || loc.name)
    .filter(Boolean);
  const location = [listItem.PrimaryLocation, ...secondary].filter(Boolean).join('; ') || 'Unspecified';
  const posted = detail?.ExternalPostedStartDate || listItem.PostedDate || null;
  // Oracle exposes a structured posting-end date — trust it over any body regex.
  const closeDate = detail?.ExternalPostedEndDate || listItem.PostingEndDate || null;
  return {
    id: `oracle:${employer.ats_token}:${id}`,
    employer_id: employer.id,
    title: listItem.Title || detail?.Title || 'Untitled role',
    department: detail?.Organization || '',
    location,
    url: `https://${config.host}/hcmUI/CandidateExperience/en/sites/${config.site_name}/job/${id}`,
    description_text: description,
    posted_or_updated_at: posted ? new Date(`${String(posted).slice(0, 10)}T00:00:00Z`).toISOString() : null,
    source: 'oracle',
    source_job_id: id,
    deadline_raw: closeDate ? String(closeDate).slice(0, 10) : null
  };
}

async function fetchOracleJobs(employer) {
  const { host, site_name: siteName, site_number: siteNumber } = employer.ats_config;
  const rest = `https://${host}/hcmRestApi/resources/latest`;
  // Oracle nests the flat requisition array + a TotalJobsCount inside items[0].
  const listItems = [];
  let total = Infinity;
  for (let page = 0; page < ORACLE_MAX_PAGES && page * ORACLE_PAGE_LIMIT < total; page += 1) {
    const offset = page * ORACLE_PAGE_LIMIT;
    const url = `${rest}/recruitingCEJobRequisitions?onlyData=true`
      + `&expand=requisitionList.secondaryLocations,flexFieldsFacet.values`
      + `&finder=findReqs;siteNumber=${encodeURIComponent(siteNumber)},`
      + `limit=${ORACLE_PAGE_LIMIT},offset=${offset},sortBy=POSTING_DATES_DESC`;
    const payload = await fetchJson(url);
    const bucket = (payload.items || [])[0] || {};
    if (page === 0) total = Number(bucket.TotalJobsCount || 0);
    const reqs = bucket.requisitionList || [];
    if (reqs.length === 0) break;
    listItems.push(...reqs);
  }

  // Dedupe by requisition Id (paging overlaps can repeat postings).
  const seen = new Set();
  const unique = listItems.filter((item) => {
    if (!item.Id || seen.has(item.Id)) return false;
    seen.add(item.Id);
    return true;
  });

  const { relevant: filteredOracle, excluded: oracleExcluded } = filterResearchRelevant(unique, (item) => item.Title, employer);
  const relevant = filteredOracle.slice(0, ORACLE_MAX_DETAIL_FETCHES);

  const jobs = [];
  for (const item of relevant) {
    // The list feed carries only a short teaser; fetch the full description per
    // job. Fail-soft: a bad detail should not sink the whole employer.
    let detail = null;
    try {
      const url = `${rest}/recruitingCEJobRequisitionDetails?expand=all&onlyData=true`
        + `&finder=ById;Id=%22${encodeURIComponent(item.Id)}%22,siteNumber=${encodeURIComponent(siteNumber)}`;
      const payload = await fetchJson(url);
      detail = (payload.items || [])[0] || null;
    } catch (error) {
      console.warn(`Oracle detail fetch failed for ${employer.id} req ${item.Id}: ${error.message}`);
    }
    jobs.push(mapOracleJob(item, detail, employer));
    await sleep(ORACLE_DETAIL_DELAY_MS);
  }
  jobs.prefiltered_count = oracleExcluded;
  jobs.prefilter_survived_count = filteredOracle.length;
  return jobs;
}

/**
 * Taleo hides the description in plain sight: the detail page renders empty and
 * fills itself by ajax, but the same payload is already sitting in a hidden
 * `initialHistory` input — double-URL-encoded, segments joined by `!*!`, of
 * which segment 0 is metadata and the rest are description/qualifications
 * (each duplicated). Parsing that beats replaying the ajax, which wants a CSRF
 * token and thirty form fields.
 */
function parseTaleoDetailPage(html) {
  const match = /name="initialHistory"[^>]*value="([^"]*)"/.exec(html || '');
  if (!match) return { description_text: '', location: null };
  const segments = match[1].split('!*!');
  // The value is encoded a VARYING number of times, so decode until it settles
  // rather than a fixed number of passes. And decode escape-by-escape: a job
  // description containing a literal "100%" makes decodeURIComponent throw on
  // the whole string, which silently left postings URL-encoded when this took
  // the all-or-nothing route.
  const decodeOnce = (text) => text.replace(/(?:%[0-9A-Fa-f]{2})+/g, (sequence) => {
    try { return decodeURIComponent(sequence); } catch { return sequence; }
  });
  const decode = (segment) => {
    let text = segment;
    for (let pass = 0; pass < 4; pass += 1) {
      const next = decodeOnce(text);
      if (next === text) break;
      text = next;
    }
    return text;
  };

  const meta = decode(segments[0] || '').split('!|!');
  // Taleo escapes its own delimiters with a backslash; undo that before use.
  const clean = (value) => (value || '').replace(/\\([:|])/g, '$1').trim();

  /* Each segment ends with the page's own form state, written as key!|!value
   * pairs. One of those keys is `csrftoken`, and Taleo issues a new one on
   * EVERY request.
   *
   * Keeping it made the stored description different on every single fetch,
   * always at the same length, so nothing ever looked wrong. But
   * jobContentHash hashes the description, so every Taleo posting looked new
   * every time: 509 postings re-judged four times a day, 5,904 judgments
   * bought for answers we already had. It also fed the model "Apply for this
   * position online" and a session token as if they were part of the job.
   *
   * The state block cannot be dropped a whole segment at a time — Towson
   * returns only two segments and puts the description and the token in the
   * same one, so that approach silently emptied the posting. Cut at the first
   * known state key instead, and leave the segment alone when none appears. */
  const STATE_BLOCK = /!\|!(?:pSessionTimeout|pSessionWarning|pBeaconBeat|focusOnField|csrftoken|emptyListToken|isListEmpty|listCount|displayCalloutInLegend|addThisRequired)!\|!/;

  /* The state keys are the reliable marker, but they are not the only tail.
   * UTSW appends the requisition attribute table first — "Full-time!|!Day
   * Job!|!Regular!|!Standard!|!Sep 12, 2023, 9:38:43 PM" — and that timestamp
   * moves too. Both tails share a shape prose never has: delimiters packed
   * close together. Cut at whichever tail starts first. */
  const DELIMITER = /!\|!/g;
  const denseRunStart = (segment) => {
    const at = [];
    let m;
    DELIMITER.lastIndex = 0;
    while ((m = DELIMITER.exec(segment)) !== null) at.push(m.index);
    for (let i = 0; i + 2 < at.length; i += 1) {
      if (at[i + 2] - at[i] <= 120) return at[i];
    }
    return -1;
  };

  const dropPageState = (segment) => {
    const marks = [segment.search(STATE_BLOCK), denseRunStart(segment)].filter((i) => i !== -1);
    const kept = marks.length ? segment.slice(0, Math.min(...marks)) : segment;
    // A lone trailing delimiter is what stops the duplicate-body check below
    // from recognising the same text twice.
    return kept.replace(/(?:!\|!)+\s*$/, '');
  };

  const bodies = [];
  for (const segment of segments.slice(1)) {
    const text = normalizeText(clean(dropPageState(decode(segment))));
    // Description and qualifications each appear twice; keep first occurrences.
    if (text && !bodies.includes(text)) bodies.push(text);
  }

  return {
    description_text: bodies.join('\n\n'),
    // meta carries [.., title, contestNo] near the end — used only as a fallback.
    title: clean(meta[meta.length - 2]) || null,
    contest_no: clean(meta[meta.length - 1]) || null
  };
}

/** The location column arrives as a JSON array string: '["Birmingham, AL"]'. */
function parseTaleoLocation(raw) {
  if (!raw) return null;
  const text = String(raw).trim();
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        const joined = parsed.filter(Boolean).map((v) => String(v).trim()).join('; ');
        return joined || null;
      }
    } catch { /* fall through to the raw string */ }
  }
  return text || null;
}

function mapTaleoJob(listItem, detail, employer, section) {
  const config = employer.ats_config || {};
  const columns = listItem.column || [];
  const jobId = String(listItem.jobId);
  const contestNo = listItem.contestNo || jobId;
  // locationsColumns names which column holds the location; it is not always [1].
  const locationIndex = (listItem.locationsColumns || [])[0];
  const location = parseTaleoLocation(
    locationIndex != null ? columns[locationIndex] : columns[1]
  ) || 'Unspecified';
  const postedRaw = columns[columns.length - 1];
  const posted = postedRaw && !Number.isNaN(Date.parse(postedRaw))
    ? new Date(postedRaw).toISOString()
    : null;
  return {
    // contestNo is the requisition number a human sees and is stable across
    // re-postings; jobId is the internal key the URL needs.
    id: `taleo:${employer.ats_token}:${contestNo}`,
    employer_id: employer.id,
    title: columns[0] || detail?.title || 'Untitled role',
    department: '',
    location,
    url: `https://${config.host}/careersection/${section.code}/jobdetail.ftl`
      + `?job=${encodeURIComponent(jobId)}&lang=en`,
    description_text: detail?.description_text || '',
    posted_or_updated_at: posted,
    source: 'taleo',
    source_job_id: String(contestNo)
  };
}

/**
 * A tenant commonly runs SEVERAL career sections holding different jobs — WVU's
 * `faculty` section carries the postdocs its `staff` section does not, and UTSW
 * splits 675 postings across three. Reading only the first found section is a
 * silent recall loss, so `sections` is a list and every one is fetched.
 */
async function fetchTaleoJobs(employer) {
  const config = employer.ats_config || {};
  const { host } = config;
  const sections = (config.sections && config.sections.length)
    ? config.sections
    : [{ code: config.career_section, portal: config.portal }].filter((s) => s.portal);

  const headers = { tz: TALEO_TZ, tzname: TALEO_TZNAME };
  const collected = [];
  const seen = new Set();

  for (const section of sections) {
    const url = `https://${host}/careersection/rest/jobboard/searchjobs`
      + `?lang=en&portal=${encodeURIComponent(section.portal)}`;
    let total = Infinity;
    for (let page = 1; page <= TALEO_MAX_PAGES && (page - 1) * TALEO_PAGE_SIZE < total; page += 1) {
      const payload = await fetchJson(url, {
        method: 'POST',
        headers,
        body: {
          multilineEnabled: false,
          sortingSelection: { sortBySelectionParam: '3', ascendingSortingOrder: 'false' },
          fieldData: { fields: { KEYWORD: '', JOB_TITLE: '' }, valid: true },
          filterSelectionParam: { searchFilterSelections: [] },
          advancedSearchFiltersSelectionParam: { searchFilterSelections: [] },
          pageNo: page
        }
      });
      // A wrong portal answers 200 with this flag rather than an error status.
      if (payload.careerSectionUnAvailable) {
        console.warn(`Taleo section unavailable for ${employer.id} portal ${section.portal}`);
        break;
      }
      const requisitions = payload.requisitionList || [];
      if (page === 1) total = Number((payload.pagingData || {}).totalCount || 0);
      if (requisitions.length === 0) break;
      for (const item of requisitions) {
        const key = `${item.jobId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        collected.push({ item, section });
      }
    }
  }

  const { relevant, excluded } = filterResearchRelevant(
    collected, (entry) => (entry.item.column || [])[0], employer
  );
  const capped = relevant.slice(0, TALEO_MAX_DETAIL_FETCHES);

  const jobs = [];
  for (const entry of capped) {
    let detail = null;
    try {
      const html = await fetchText(
        `https://${host}/careersection/${entry.section.code}/jobdetail.ftl`
        + `?job=${encodeURIComponent(entry.item.jobId)}&lang=en`,
        { headers: { ...headers, accept: 'text/html' } }
      );
      detail = parseTaleoDetailPage(html);
    } catch (error) {
      console.warn(`Taleo detail fetch failed for ${employer.id} job ${entry.item.jobId}: ${error.message}`);
    }
    jobs.push(mapTaleoJob(entry.item, detail, employer, entry.section));
    await sleep(TALEO_DETAIL_DELAY_MS);
  }
  jobs.prefiltered_count = excluded;
  jobs.prefilter_survived_count = relevant.length;
  return jobs;
}

function mapUltiproJob(opp, boardId, employer) {
  const config = employer.ats_config || {};
  const id = String(opp.Id);
  const reqId = opp.RequisitionNumber || id;
  const locations = (opp.Locations || []).map((loc) => {
    const address = loc.Address || {};
    const state = address.State && (address.State.Code || address.State.Name);
    return [address.City, state].filter(Boolean).join(', ') || loc.LocalizedDescription || '';
  }).filter(Boolean);
  const location = [...new Set(locations)].join('; ') || 'Unspecified';
  const posted = opp.PostedDate && !Number.isNaN(Date.parse(opp.PostedDate))
    ? new Date(opp.PostedDate).toISOString()
    : null;
  return {
    id: `ultipro:${employer.ats_token}:${reqId}`,
    employer_id: employer.id,
    title: opp.Title || 'Untitled role',
    department: opp.JobCategoryName || '',
    location,
    url: `https://${config.host}/${config.tenant}/JobBoard/${boardId}/OpportunityDetail?opportunityId=${id}`,
    description_text: normalizeText(opp.BriefDescription || ''),
    posted_or_updated_at: posted,
    source: 'ultipro',
    source_job_id: String(reqId)
  };
}

async function fetchUltiproJobs(employer) {
  const config = employer.ats_config || {};
  const { host, tenant } = config;
  // A tenant may front several boards; accept a `boards` array or a single `board`.
  const boardIds = (config.boards && config.boards.length)
    ? config.boards
    : [config.board].filter(Boolean);
  // The board feed carries BriefDescription inline (no per-job cost), so keep
  // every posting and let the scoring/classification layers rank — no prefilter.
  const seen = new Set();
  const jobs = [];
  for (const boardId of boardIds) {
    const base = `https://${host}/${encodeURIComponent(tenant)}/JobBoard/${encodeURIComponent(boardId)}`;
    let total = Infinity;
    for (let page = 0; page < ULTIPRO_MAX_PAGES && page * ULTIPRO_PAGE_LIMIT < total; page += 1) {
      let payload;
      try {
        payload = await fetchJson(`${base}/JobBoardView/LoadSearchResults`, {
          method: 'POST',
          retries: 2,
          body: {
            opportunitySearch: {
              Top: ULTIPRO_PAGE_LIMIT,
              Skip: page * ULTIPRO_PAGE_LIMIT,
              QueryString: '',
              OrderBy: [],
              Filters: []
            },
            matchCriteria: {
              PreferredJobs: [],
              Educations: [],
              LicenseAndCertifications: [],
              Skills: [],
              JobFamilies: [],
              Languages: [],
              MinimumRequiredJobFamilies: []
            }
          }
        });
      } catch (error) {
        console.warn(`UltiPro board fetch failed for ${employer.id} board ${boardId}: ${error.message}`);
        break;
      }
      if (page === 0) total = Number(payload.totalCount || 0);
      const opps = payload.opportunities || [];
      if (opps.length === 0) break;
      for (const opp of opps) {
        const key = String(opp.Id);
        if (!opp.Id || seen.has(key)) continue;
        seen.add(key);
        jobs.push(mapUltiproJob(opp, boardId, employer));
      }
    }
    await sleep(ULTIPRO_BOARD_DELAY_MS);
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
    restricted_reason: citizenshipGated ? 'US citizenship required (federal hiring path)' : null,
    // USAJOBS exposes a structured close date — trust it over any body regex
    deadline_raw: descriptor.ApplicationCloseDate ? String(descriptor.ApplicationCloseDate).slice(0, 10) : null
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

// --- PeopleAdmin (PowerSchool) — Atom feed, one request, descriptions inline

async function fetchText(url, options = {}) {
  const { retries = 1, retryDelayMs = 1000, headers = {} } = options;
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        headers: { accept: 'application/atom+xml, application/xml, text/xml', 'user-agent': USER_AGENT, ...headers },
        signal: controller.signal
      });
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status} ${response.statusText}`);
        error.status = response.status;
        throw error;
      }
      return await response.text();
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

// The feed is machine-generated and structurally stable; targeted regex
// extraction avoids an XML-parser dependency
function parsePeopleAdminAtom(xml) {
  const entries = [];
  for (const block of String(xml).match(/<entry>[\s\S]*?<\/entry>/g) || []) {
    const pick = (tag) => (block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)) || [])[1] || '';
    const url = (block.match(/<link[^>]*rel="alternate"[^>]*href="([^"]+)"/) || [])[1] || pick('id').trim();
    entries.push({
      url: url.trim(),
      title: normalizeText(pick('title')),
      content: pick('content'),
      published: pick('published').trim() || null,
      author: normalizeText((block.match(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>/) || [])[1] || '')
    });
  }
  return entries;
}

function mapPeopleAdminEntry(entry, employer) {
  const postingId = (String(entry.url).match(/\/postings\/(\d+)/) || [])[1] || entry.url;
  return {
    id: `peopleadmin:${employer.ats_token}:${postingId}`,
    employer_id: employer.id,
    title: entry.title || 'Untitled role',
    department: entry.author || '',
    location: 'Unspecified',
    url: entry.url,
    description_text: normalizeText(entry.content),
    posted_or_updated_at: entry.published,
    source: 'peopleadmin',
    source_job_id: String(postingId)
  };
}

async function fetchPeopleAdminJobs(employer) {
  // Vanity-domain instances (jobs.university.edu) serve the same Atom feed
  const host = employer.ats_config?.host || `${employer.ats_token}.peopleadmin.com`;
  const xml = await fetchText(`https://${host}/postings/search.atom`);
  return parsePeopleAdminAtom(xml)
    .filter((entry) => entry.url.startsWith('http'))
    .map((entry) => mapPeopleAdminEntry(entry, employer));
}

// SuccessFactors Career Site Builder tenants render search results client-side
// (the search page and tile-search-results endpoint both come back empty), but
// publish every posting in sitemap.xml — the /job/<slug>/<id>/ path carries a
// stable posting id and the slug carries title + location text — and serve
// microdata-tagged detail pages. So: sitemap = listing, detail page = record.
function parseSuccessFactorsSitemap(xml) {
  const entries = [];
  for (const block of String(xml).match(/<url>[\s\S]*?<\/url>/g) || []) {
    const loc = ((block.match(/<loc>([\s\S]*?)<\/loc>/) || [])[1] || '').replace(/&amp;/g, '&').trim();
    const idMatch = loc.match(/\/job\/[^/]+\/(\d+)\/?$/);
    if (!idMatch) continue;
    const rawSlug = (loc.match(/\/job\/([^/]+)\//) || [])[1] || '';
    let slugText;
    try {
      slugText = decodeURIComponent(rawSlug).replace(/-/g, ' ');
    } catch {
      slugText = rawSlug.replace(/-/g, ' ');
    }
    entries.push({
      url: loc,
      postingId: idMatch[1],
      slugText: normalizeText(slugText),
      lastmod: ((block.match(/<lastmod>([\s\S]*?)<\/lastmod>/) || [])[1] || '').trim() || null
    });
  }
  return entries;
}

function parseSuccessFactorsJobPage(html) {
  const src = String(html);
  const title = normalizeText((src.match(/itemprop="title"[^>]*>([^<]*)/) || [])[1] || '');
  // Label values read from the tag-stripped page: tags become separators so a
  // label's value is the next non-empty text run.
  const labeled = src
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, '|');
  const grab = (label) => {
    const match = labeled.match(new RegExp(`${label}\\s*[|\\s]*([^|]+)`));
    return match ? normalizeText(match[1]) : '';
  };
  // The job body sits between the first itemprop="description" span (empty)
  // and the second one (EEO boilerplate); with one marker, read to the end.
  const marks = [];
  const markerPattern = /itemprop="description"/g;
  let marker;
  while ((marker = markerPattern.exec(src))) marks.push(marker.index);
  let description = '';
  if (marks.length > 0) {
    const from = src.indexOf('>', marks[0]) + 1;
    description = normalizeText(src.slice(from, marks[1] ?? src.length));
  }
  return {
    title,
    location: grab('Location:'),
    reqId: (labeled.match(/Requisition ID:\s*[|\s]*(\d+)/) || [])[1] || null,
    description
  };
}

function mapSuccessFactorsJob(entry, pageData, employer) {
  return {
    id: `successfactors:${employer.ats_token}:${entry.postingId}`,
    employer_id: employer.id,
    title: pageData?.title || entry.slugText || 'Untitled role',
    department: '',
    location: pageData?.location || 'Unspecified',
    url: entry.url,
    description_text: pageData?.description || '',
    // sitemap lastmod is a bare date (posting create/update), the only
    // timestamp the public site exposes
    posted_or_updated_at: entry.lastmod ? new Date(`${entry.lastmod.slice(0, 10)}T00:00:00Z`).toISOString() : null,
    source: 'successfactors',
    source_job_id: pageData?.reqId || entry.postingId
  };
}

async function fetchSuccessFactorsJobs(employer) {
  const { host } = employer.ats_config;
  const xml = await fetchText(`https://${host}/sitemap.xml`);
  const entries = parseSuccessFactorsSitemap(xml);

  const seen = new Set();
  const unique = entries.filter((entry) => {
    if (seen.has(entry.postingId)) return false;
    seen.add(entry.postingId);
    return true;
  });

  // The slug mixes title and location text; prefiltering on it keeps recall
  // (location words never match the patterns) while skipping obvious non-fits.
  const { relevant: filteredSf, excluded: sfExcluded } = filterResearchRelevant(unique, (entry) => entry.slugText, employer);
  const relevant = filteredSf.slice(0, SUCCESSFACTORS_MAX_DETAIL_FETCHES);

  const jobs = [];
  for (const entry of relevant) {
    let pageData = null;
    try {
      pageData = parseSuccessFactorsJobPage(await fetchText(entry.url));
    } catch (error) {
      console.warn(`SuccessFactors detail fetch failed for ${employer.id} ${entry.url}: ${error.message}`);
    }
    jobs.push(mapSuccessFactorsJob(entry, pageData, employer));
    await sleep(SUCCESSFACTORS_DETAIL_DELAY_MS);
  }
  jobs.prefiltered_count = sfExcluded;
  jobs.prefilter_survived_count = filteredSf.length;
  return jobs;
}

// Eightfold career hubs (PCSX) expose a plain JSON API on the employer's own
// host: /api/pcsx/search pages the listing 10 at a time and reports the total
// as `count`; /api/pcsx/position_details returns the full record per job.
function mapEightfoldJob(listItem, detail, employer) {
  const config = employer.ats_config || {};
  const id = String(listItem.id);
  const locations = (detail?.locations || listItem.locations || []).filter(Boolean);
  const posted = listItem.postedTs || detail?.postedTs || null;
  return {
    id: `eightfold:${employer.ats_token}:${id}`,
    employer_id: employer.id,
    title: listItem.name || detail?.name || 'Untitled role',
    department: listItem.department || detail?.department || '',
    location: locations.join('; ') || 'Unspecified',
    url: `https://${config.host}/careers/job/${id}`,
    description_text: normalizeText(detail?.jobDescription || ''),
    posted_or_updated_at: posted ? new Date(Number(posted) * 1000).toISOString() : null,
    source: 'eightfold',
    source_job_id: String(listItem.displayJobId || listItem.atsJobId || id)
  };
}

async function fetchEightfoldJobs(employer) {
  const { host, domain } = employer.ats_config;
  const base = `https://${host}/api/pcsx`;

  const listItems = [];
  let total = Infinity;
  let start = 0;
  for (let page = 0; page < EIGHTFOLD_MAX_PAGES && start < total; page += 1) {
    const payload = await fetchJson(`${base}/search?domain=${encodeURIComponent(domain)}&query=&start=${start}`);
    const data = payload.data || {};
    if (page === 0) total = Number(data.count || 0);
    const positions = data.positions || [];
    if (positions.length === 0) break;
    listItems.push(...positions);
    start += positions.length;
  }

  const seen = new Set();
  const unique = listItems.filter((item) => {
    if (!item.id || seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });

  const { relevant: filteredEf, excluded: efExcluded } = filterResearchRelevant(unique, (item) => item.name, employer);
  const relevant = filteredEf.slice(0, EIGHTFOLD_MAX_DETAIL_FETCHES);

  const jobs = [];
  for (const item of relevant) {
    let detail = null;
    try {
      const url = `${base}/position_details?position_id=${encodeURIComponent(item.id)}&domain=${encodeURIComponent(domain)}&hl=en`;
      detail = (await fetchJson(url)).data || null;
    } catch (error) {
      console.warn(`Eightfold detail fetch failed for ${employer.id} position ${item.id}: ${error.message}`);
    }
    jobs.push(mapEightfoldJob(item, detail, employer));
    await sleep(EIGHTFOLD_DETAIL_DELAY_MS);
  }
  jobs.prefiltered_count = efExcluded;
  jobs.prefilter_survived_count = filteredEf.length;
  return jobs;
}

// Paylocity's public recruiting pages are plain server-rendered HTML with the
// full job set embedded inline (no separate JSON API): the list page carries
// a `window.pageData = {...}` blob (Jobs[] with a truncated teaser
// description), and each detail page carries a standard schema.org JobPosting
// JSON-LD block with the full description. ats_config={client_guid}; no
// tenant-name identity check needed (the guid was scraped directly off the
// employer's own site by the discovery crawl).
function parsePaylocityListPage(html) {
  const match = String(html || '').match(/window\.pageData\s*=\s*(\{[\s\S]*?\});/);
  if (!match) return { jobs: [], moduleTitle: '' };
  try {
    const data = JSON.parse(match[1]);
    return { jobs: data.Jobs || [], moduleTitle: data.ModuleTitle || '' };
  } catch {
    return { jobs: [], moduleTitle: '' };
  }
}

function parsePaylocityDetailPage(html) {
  const match = String(html || '').match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function mapPaylocityJob(listItem, detail, employer) {
  const config = employer.ats_config || {};
  const id = String(listItem.JobId);
  const location = listItem.LocationName || detail?.jobLocation?.address?.addressLocality || 'Unspecified';
  const posted = listItem.PublishedDate || detail?.datePosted || null;
  return {
    id: `paylocity:${employer.ats_token}:${id}`,
    employer_id: employer.id,
    title: listItem.JobTitle || detail?.title || 'Untitled role',
    department: listItem.HiringDepartment || '',
    location,
    url: `https://${config.host || 'recruiting.paylocity.com'}/Recruiting/Jobs/Details/${id}`,
    description_text: normalizeText(detail?.description || listItem.Description || ''),
    posted_or_updated_at: posted && !Number.isNaN(Date.parse(posted)) ? new Date(posted).toISOString() : null,
    source: 'paylocity',
    source_job_id: id
  };
}

async function fetchPaylocityJobs(employer) {
  const { host = 'recruiting.paylocity.com', client_guid: clientGuid } = employer.ats_config || {};
  const listHtml = await fetchText(`https://${host}/recruiting/jobs/All/${encodeURIComponent(clientGuid)}`);
  const { jobs: listItems } = parsePaylocityListPage(listHtml);

  const seen = new Set();
  const unique = listItems.filter((item) => {
    if (!item.JobId || seen.has(item.JobId)) return false;
    seen.add(item.JobId);
    return true;
  });

  const { relevant: filtered, excluded } = filterResearchRelevant(unique, (item) => item.JobTitle, employer);
  const relevant = filtered.slice(0, PAYLOCITY_MAX_DETAIL_FETCHES);

  const jobs = [];
  for (const item of relevant) {
    let detail = null;
    try {
      const detailHtml = await fetchText(`https://${host}/Recruiting/Jobs/Details/${item.JobId}`);
      detail = parsePaylocityDetailPage(detailHtml);
    } catch (error) {
      console.warn(`Paylocity detail fetch failed for ${employer.id} job ${item.JobId}: ${error.message}`);
    }
    jobs.push(mapPaylocityJob(item, detail, employer));
    await sleep(PAYLOCITY_DETAIL_DELAY_MS);
  }
  jobs.prefiltered_count = excluded;
  jobs.prefilter_survived_count = filtered.length;
  return jobs;
}

function mapInterfolioJob(item, employer) {
  const applyId = item.legacy_position_id || item.id;
  const description = [item.description, item.qualifications, item.instructions]
    .filter(Boolean)
    .join(' ');
  const posted = item.open_date_raw || null;
  return {
    id: `interfolio:${employer.ats_token}:${item.id}`,
    employer_id: employer.id,
    title: item.name || 'Untitled role',
    department: item.unit_name || '',
    location: item.location || 'Unspecified',
    url: `https://apply.interfolio.com/${applyId}`,
    description_text: normalizeText(description),
    posted_or_updated_at: posted && !Number.isNaN(Date.parse(posted)) ? new Date(posted).toISOString() : null,
    source: 'interfolio',
    source_job_id: String(item.id || '')
  };
}

async function fetchInterfolioJobs(employer) {
  const tenantId = employer.ats_config?.tenant_id;
  const jobs = [];
  for (let page = 1; page <= INTERFOLIO_MAX_PAGES; page += 1) {
    const url = `https://logic.interfolio.com/byc-search/${encodeURIComponent(tenantId)}/public_job_boards?limit=${INTERFOLIO_PAGE_LIMIT}&page=${page}`;
    const payload = await fetchJson(url);
    const results = payload.results || [];
    if (results.length === 0) break;
    jobs.push(...results.map((item) => mapInterfolioJob(item, employer)));
    const total = Number(payload.total_count);
    if (results.length < INTERFOLIO_PAGE_LIMIT || (!Number.isNaN(total) && jobs.length >= total)) break;
    await sleep(INTERFOLIO_PAGE_DELAY_MS);
  }
  return jobs;
}

function parseGovJobsDate(value) {
  const match = String(value || '').match(/^(\d{2})\/(\d{2})\/(\d{2})$/);
  if (!match) return null;
  const [, mm, dd, yy] = match;
  const iso = `20${yy}-${mm}-${dd}T00:00:00Z`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

function parseGovernmentJobsListPage(html) {
  const jobs = [];
  const rowPattern = /<tr>\s*<th scope="row" class="job-table-title" data-job-id="(\d+)">([\s\S]*?)<\/tr>/g;
  let match;
  while ((match = rowPattern.exec(String(html || '')))) {
    const [, jobId, block] = match;
    const linkMatch = block.match(/<a[^>]*href="([^"]+)"[^>]*>([^<]*)<\/a>/);
    const postedMatch = block.match(/class="job-table-posted[^"]*">\s*([^<]*)</);
    const locationMatch = block.match(/class="job-table-location[^"]*">\s*([^<]*)</);
    const departments = [...block.matchAll(/class="job-table-department">\s*([^<]*)</g)]
      .map((m) => m[1].trim())
      .filter(Boolean);
    jobs.push({
      jobId,
      title: normalizeText(linkMatch?.[2] || ''),
      url: linkMatch?.[1] || '',
      posted: postedMatch?.[1]?.trim() || '',
      location: locationMatch?.[1]?.trim() || '',
      department: departments.join(' / ')
    });
  }
  return jobs;
}

function parseGovernmentJobsDetailPage(html) {
  const match = String(html || '').match(/<div id="details-info"[\s\S]*?<dl>([\s\S]*?)<\/dl>/);
  return { description: match ? match[1] : '' };
}

function mapGovernmentJobsJob(listItem, detail, employer) {
  const config = employer.ats_config || {};
  const host = config.host || 'www.schooljobs.com';
  return {
    id: `governmentjobs:${employer.ats_token}:${listItem.jobId}`,
    employer_id: employer.id,
    title: listItem.title || 'Untitled role',
    department: listItem.department || '',
    location: listItem.location || 'Unspecified',
    url: listItem.url?.startsWith('http') ? listItem.url : `https://${host}${listItem.url}`,
    description_text: normalizeText(detail?.description || ''),
    posted_or_updated_at: parseGovJobsDate(listItem.posted),
    source: 'governmentjobs',
    source_job_id: listItem.jobId
  };
}

async function fetchGovernmentJobsJobs(employer) {
  const config = employer.ats_config || {};
  const host = config.host || 'www.schooljobs.com';
  const agency = config.agency;
  const listItems = [];
  for (let page = 1; page <= GOVERNMENTJOBS_MAX_PAGES; page += 1) {
    const html = await fetchText(
      `https://${host}/careers/home/index?agency=${encodeURIComponent(agency)}&sort=PostingDate&isDescendingSort=true&page=${page}`,
      { headers: { accept: 'text/html, */*', 'x-requested-with': 'XMLHttpRequest' } }
    );
    const pageItems = parseGovernmentJobsListPage(html);
    if (pageItems.length === 0) break;
    listItems.push(...pageItems);
    if (pageItems.length < GOVERNMENTJOBS_PAGE_SIZE) break;
    await sleep(GOVERNMENTJOBS_DETAIL_DELAY_MS);
  }

  const seen = new Set();
  const unique = listItems.filter((item) => {
    if (!item.jobId || seen.has(item.jobId)) return false;
    seen.add(item.jobId);
    return true;
  });

  const { relevant: filtered, excluded } = filterResearchRelevant(unique, (item) => item.title, employer);
  const relevant = filtered.slice(0, GOVERNMENTJOBS_MAX_DETAIL_FETCHES);

  const jobs = [];
  for (const listItem of relevant) {
    let detail = null;
    try {
      const detailHtml = await fetchText(`https://${host}${listItem.url}`, { headers: { accept: 'text/html' } });
      detail = parseGovernmentJobsDetailPage(detailHtml);
    } catch (error) {
      console.warn(`GovernmentJobs detail fetch failed for ${employer.id} job ${listItem.jobId}: ${error.message}`);
    }
    jobs.push(mapGovernmentJobsJob(listItem, detail, employer));
    await sleep(GOVERNMENTJOBS_DETAIL_DELAY_MS);
  }
  jobs.prefiltered_count = excluded;
  jobs.prefilter_survived_count = filtered.length;
  return jobs;
}

// ---------------------------------------------------------------------------
// PageUp
//
// PageUp's own APIs are private, but every PageUp careers site publishes two
// public things that together are enough: a sitemap listing every live job
// URL, and a schema.org JobPosting JSON-LD block on each job page. The JSON-LD
// is the structured record (title, description, location, posting date), so
// nothing here depends on scraping page markup.
//
// The sitemap slug encodes the title, which lets the research-relevance
// prefilter run BEFORE spending a request per job — a big campus publishes
// several hundred postings and only a fraction are research roles.
const PAGEUP_MAX_DETAIL_FETCHES = 400;
const PAGEUP_DETAIL_DELAY_MS = 250;
// Consecutive challenge responses before we stop and report the employer as
// errored. Small, because once the gate closes it stays closed for a while and
// every further request just deepens the block.
const PAGEUP_GATE_ABORT_AFTER = 5;
// Reading at least this many candidate pages and finding no posting at all is
// treated as a block rather than as a genuinely empty board.
const PAGEUP_EMPTY_YIELD_FLOOR = 10;

/**
 * A bot-challenge response served in place of the page we asked for. PageUp
 * fronts its sites with AWS WAF, which answers HTTP 202 and a ~2.5KB JS
 * interstitial — a complete HTML document, so size and well-formedness alone
 * cannot tell it apart from a real page. Match the challenge itself.
 *
 * Distinguishing this from "this page has no job on it" is the whole point:
 * one is a temporary block to back off from, the other is a fact about the
 * employer. Treating the first as the second tombstones live jobs.
 */
const CHALLENGE_MARKERS = /awsWafCookie|awswaf|challenge-platform|cf-browser-verification|Just a moment\.\.\.|Checking your browser|captcha-delivery|Enable JavaScript and cookies to continue/i;

function isChallengeResponse(html) {
  const body = String(html || '').trim();
  if (body.length === 0) return true;
  if (CHALLENGE_MARKERS.test(body)) return true;
  // Fallback: a short document carrying neither posting markup nor a real
  // title is not a job page in any form we can use.
  return body.length < 3000 && !/application\/ld\+json/i.test(body) && !/<title>[^<]+<\/title>/i.test(body);
}

function parseSitemapUrls(xml) {
  const urls = [];
  const pattern = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
  let match;
  while ((match = pattern.exec(xml)) !== null) urls.push(match[1]);
  return urls;
}

/**
 * "research-assistant-east-lansing-michigan-united-states-c9d8d397-…" is the
 * only title we have before fetching the page, so the trailing UUID and the
 * location tail are stripped back off to leave something the title classifier
 * can read. Imperfect by nature — it is a prefilter, and anything it keeps is
 * confirmed against the real title from JSON-LD afterwards.
 */
function pageUpTitleFromUrl(url) {
  const slug = String(url || '').split('/').filter(Boolean).pop() || '';
  return slug
    .replace(/-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, '')
    .replace(/-/g, ' ')
    .trim();
}

function extractJsonLdJobPosting(html) {
  const pattern = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    let parsed;
    try {
      parsed = JSON.parse(match[1].trim());
    } catch {
      continue; // a malformed block is not a reason to give up on the page
    }
    const candidates = Array.isArray(parsed) ? parsed : [parsed, ...(parsed['@graph'] || [])];
    for (const candidate of candidates) {
      if (candidate && candidate['@type'] === 'JobPosting') return candidate;
    }
  }
  return null;
}

function jsonLdLocation(posting) {
  const places = [].concat(posting.jobLocation || []);
  const parts = [];
  for (const place of places) {
    const address = place?.address || {};
    const line = [address.addressLocality, address.addressRegion].filter(Boolean).join(', ');
    if (line && !parts.includes(line)) parts.push(line);
  }
  if (!parts.length && posting.jobLocationType === 'TELECOMMUTE') return 'Remote';
  return parts.slice(0, 3).join('; ') || 'Unspecified';
}

function mapPageUpJob(url, posting, employer) {
  return {
    id: `pageup:${employer.ats_token}:${normalizeId(url)}`,
    employer_id: employer.id,
    title: posting.title || pageUpTitleFromUrl(url) || 'Untitled role',
    department: posting.employmentUnit?.name || posting.department || '',
    location: jsonLdLocation(posting),
    url,
    description_text: normalizeText(posting.description || ''),
    posted_or_updated_at: posting.datePosted || null,
    // Date-only, matching the Workday/USAJOBS convention parseDeadline expects.
    deadline_raw: posting.validThrough ? String(posting.validThrough).slice(0, 10) : null,
    source: 'pageup',
    source_job_id: normalizeId(url)
  };
}

async function fetchPageUpJobs(employer) {
  const config = employer.ats_config || {};
  const host = config.host || employer.ats_token;
  if (!host) throw new Error('pageup requires ats_config.host (the careers site host)');
  const sitemapPath = config.sitemap_path || '/sitemap.xml';
  const jobPathSegment = config.job_path || '/jobs/';

  const xml = await fetchText(`https://${host}${sitemapPath}`, { headers: { accept: 'application/xml, text/xml, */*' } });
  const jobUrls = [...new Set(parseSitemapUrls(xml).filter((url) => url.includes(jobPathSegment)))];

  const { relevant: filtered, excluded } = filterResearchRelevant(jobUrls, pageUpTitleFromUrl, employer);
  const relevant = filtered.slice(0, PAGEUP_MAX_DETAIL_FETCHES);

  const jobs = [];
  let gated = 0;
  for (const url of relevant) {
    try {
      const html = await fetchText(url, { headers: { accept: 'text/html,application/xhtml+xml' } });
      // PageUp sits behind a bot challenge that answers 202 with an empty body
      // instead of an error. fetchText treats 2xx as success, so without this
      // an entire gated employer looks like "fetched fine, found nothing" —
      // and every one of its live jobs would be tombstoned. Count it as a
      // block, not as an absence.
      if (isChallengeResponse(html)) {
        gated += 1;
        if (gated >= PAGEUP_GATE_ABORT_AFTER) {
          throw new Error(
            `PageUp bot challenge: ${gated} consecutive empty 202-style responses from ${host}. `
            + 'Aborting so live jobs are carried forward instead of tombstoned.'
          );
        }
        await sleep(PAGEUP_DETAIL_DELAY_MS);
        continue;
      }
      gated = 0;
      const posting = extractJsonLdJobPosting(html);
      // No JSON-LD on a real page means a stale sitemap entry (a closed job);
      // skipping it is correct — a job with no description is dropped anyway.
      if (posting) jobs.push(mapPageUpJob(url, posting, employer));
    } catch (error) {
      if (/bot challenge/.test(error.message)) throw error;
      console.warn(`PageUp detail fetch failed for ${employer.id} ${url}: ${error.message}`);
    }
    await sleep(PAGEUP_DETAIL_DELAY_MS);
  }
  // Backstop for a challenge format this code does not recognise yet: reading
  // a meaningful number of pages and extracting nothing is the signature of a
  // block, not of an employer with no research jobs. Fail rather than hand
  // back an empty feed that would tombstone every live posting.
  if (jobs.length === 0 && relevant.length >= PAGEUP_EMPTY_YIELD_FLOOR) {
    throw new Error(
      `PageUp yielded 0 postings from ${relevant.length} candidate pages at ${host} — `
      + 'treating as blocked rather than empty so live jobs are carried forward.'
    );
  }
  jobs.prefiltered_count = excluded;
  jobs.prefilter_survived_count = filtered.length;
  return jobs;
}

// ---------------------------------------------------------------------------
// ADP Workforce Now
//
// Public career-center REST feed, keyed on the client id (cid) that appears in
// every ADP careers link. The list call carries titles and locations but an
// empty description, so the body comes from a per-requisition detail call.
const ADP_HOST = 'workforcenow.adp.com';
const ADP_BASE = `https://${ADP_HOST}/mascsr/default/careercenter/public/events/staffing/v1/job-requisitions`;
// The server caps responses at 20 records regardless of this value; it is sent
// for correctness, not because it is honoured.
const ADP_PAGE_LIMIT = 20;
// One less than the cap, so consecutive windows overlap by a record instead of
// risking a gap (ADP's $skip=0 returns 19, every later $skip returns 20).
const ADP_PAGE_STRIDE = 19;
// 150 windows ≈ 2,850 postings — far beyond any single ADP client here.
const ADP_MAX_PAGES = 150;
const ADP_MAX_DETAIL_FETCHES = 400;
const ADP_DETAIL_DELAY_MS = 500;
/* Every ADP tenant here is a cid on one shared host, and it rate-limits by
 * host. A single 1s retry was never going to clear a per-minute limiter — six
 * employers failed with 429 on every run for weeks, quietly carrying stale
 * jobs forward under the dead-man threshold. Three tries at 4s/8s/12s do. */
const ADP_RETRY = { retries: 3, retryDelayMs: 4000 };

function adpLocation(requisition) {
  const locations = requisition.requisitionLocations || [];
  const parts = [];
  for (const location of locations) {
    const address = location?.address || {};
    const line = [address.cityName, address.countrySubdivisionLevel1?.codeValue].filter(Boolean).join(', ')
      || String(location?.nameCode?.shortName || '').trim();
    if (line && !parts.includes(line)) parts.push(line);
  }
  return parts.slice(0, 3).join('; ') || 'Unspecified';
}

function mapAdpJob(requisition, detail, employer) {
  const source = detail || requisition;
  return {
    id: `adp:${employer.ats_token}:${requisition.itemID}`,
    employer_id: employer.id,
    title: requisition.requisitionTitle || 'Untitled role',
    department: (requisition.organizationalUnits || [])
      .map((unit) => unit?.nameCode?.shortName)
      .filter(Boolean)
      .join(' — '),
    location: adpLocation(requisition),
    // The public apply link is keyed on the requisition's own id.
    url: `https://${ADP_HOST}/mascsr/default/mdf/recruitment/recruitment.html`
      + `?cid=${encodeURIComponent(employer.ats_config?.cid || employer.ats_token)}`
      + `&jobId=${encodeURIComponent(requisition.itemID)}&lang=en_US`,
    description_text: normalizeText(source.requisitionDescription || ''),
    posted_or_updated_at: requisition.postDate || null,
    source: 'adp',
    source_job_id: String(requisition.itemID || '')
  };
}

async function fetchAdpJobs(employer) {
  const config = employer.ats_config || {};
  const cid = config.cid || employer.ats_token;
  if (!cid) throw new Error('adp requires ats_config.cid');
  const query = `cid=${encodeURIComponent(cid)}`;

  // ADP's paging contract, measured against live clients rather than assumed:
  //   - every response is hard-capped at 20 records, whatever $top says
  //     ($top=200 still returns 20), so the unpaged call is NOT the whole list
  //     — a 130-posting client answers it with 20 and no indication of that;
  //   - $skip is off by one: $skip=0 yields 19 records (indices 0-18), and
  //     $skip=N>0 yields 20 starting at index N-1;
  //   - meta.totalNumber is the only trustworthy count, and it is absent when
  //     $top is small enough to return nothing.
  //
  // So: always page, stride by 19 so consecutive windows overlap by one record
  // rather than risk a gap, and stop on the declared total. Duplicates are
  // dropped on the way in; a gap would be a silently lost posting.
  const listItems = [];
  const seen = new Set();
  const collect = (batch) => {
    for (const item of batch || []) {
      if (!item.itemID || seen.has(item.itemID)) continue;
      seen.add(item.itemID);
      listItems.push(item);
    }
  };

  let declaredTotal = 0;
  for (let page = 0; page < ADP_MAX_PAGES; page += 1) {
    const skip = page * ADP_PAGE_STRIDE;
    const payload = await fetchJson(`${ADP_BASE}?${query}&%24top=${ADP_PAGE_LIMIT}&%24skip=${skip}`, ADP_RETRY);
    if (page === 0) declaredTotal = Number(payload.meta?.totalNumber ?? 0) || 0;
    const batch = payload.jobRequisitions || [];
    if (batch.length === 0) break;
    collect(batch);
    if (declaredTotal && listItems.length >= declaredTotal) break;
    await sleep(ADP_DETAIL_DELAY_MS);
  }

  // Coming up short of the client's own declared count means postings were
  // lost, which downstream would look exactly like postings that closed.
  if (declaredTotal > 0 && listItems.length < declaredTotal) {
    throw new Error(
      `ADP feed incomplete for ${employer.id}: collected ${listItems.length} of ${declaredTotal} declared postings. `
      + 'Reporting as an error so existing jobs are carried forward rather than tombstoned.'
    );
  }

  const unique = listItems;

  const { relevant: filtered, excluded } = filterResearchRelevant(unique, (item) => item.requisitionTitle, employer);
  const relevant = filtered.slice(0, ADP_MAX_DETAIL_FETCHES);

  const jobs = [];
  for (const item of relevant) {
    let detail = null;
    try {
      detail = await fetchJson(`${ADP_BASE}/${encodeURIComponent(item.itemID)}?${query}`, ADP_RETRY);
    } catch (error) {
      console.warn(`ADP detail fetch failed for ${employer.id} req ${item.itemID}: ${error.message}`);
    }
    jobs.push(mapAdpJob(item, detail, employer));
    await sleep(ADP_DETAIL_DELAY_MS);
  }
  jobs.prefiltered_count = excluded;
  jobs.prefilter_survived_count = filtered.length;
  return jobs;
}

// Cornerstone OnDemand (csod)
//
// The career site is a JS shell: every list and detail call is a REST request
// carrying a short-lived JWT that the shell page itself embeds, so there is no
// anonymous endpoint to hit directly. Bootstrapping that token out of the HTML
// is the whole trick — with it, both calls below are ordinary JSON.
//
// Two things the token needs that are easy to miss: the request must also carry
// the AWS load-balancer cookies set alongside it (token without cookies is a
// flat 401, measured), and the search endpoint rejects GET with a 405 — it is
// POST-only even though it reads nothing.
const CSOD_PAGE_SIZE = 100;
// 60 pages ≈ 6,000 postings; the largest site measured here is ~320.
const CSOD_MAX_PAGES = 60;
const CSOD_MAX_DETAIL_FETCHES = 400;
const CSOD_DETAIL_DELAY_MS = 150;

function csodHost(employer) {
  return `${employer.ats_token}.csod.com`;
}

function csodJobUrl(employer, requisitionId) {
  const siteId = employer.ats_config?.site_id;
  return `https://${csodHost(employer)}/ux/ats/careersite/${encodeURIComponent(siteId)}`
    + `/home/requisition/${encodeURIComponent(requisitionId)}?c=${encodeURIComponent(employer.ats_token)}`;
}

// The shell embeds its context as a JSON literal ending in `};</script>`; the
// JSON itself never contains that sequence, so a non-greedy match is safe.
function extractCsodToken(html) {
  const match = /csod\.context=(\{.*?\});<\/script>/s.exec(html || '');
  if (!match) throw new Error('csod career site page carried no csod.context — the site id is probably wrong');
  let context;
  try {
    context = JSON.parse(match[1]);
  } catch (error) {
    throw new Error(`csod career site context did not parse: ${error.message}`);
  }
  if (!context.token) throw new Error('csod career site context carried no token');
  return context.token;
}

// Returns the bearer token plus the cookie header the same page handed out.
// Uses fetch directly rather than fetchText because the Set-Cookie headers are
// as load-bearing as the body here.
async function csodBootstrap(employer) {
  const url = `https://${csodHost(employer)}/ux/ats/careersite/`
    + `${encodeURIComponent(employer.ats_config?.site_id)}/home?c=${encodeURIComponent(employer.ats_token)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { accept: 'text/html', 'user-agent': USER_AGENT },
      signal: controller.signal
    });
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status} ${response.statusText}`);
      error.status = response.status;
      throw error;
    }
    const html = await response.text();
    const cookie = (response.headers.getSetCookie?.() || [])
      .map((entry) => entry.split(';')[0])
      .filter(Boolean)
      .join('; ');
    return { token: extractCsodToken(html), cookie };
  } finally {
    clearTimeout(timeout);
  }
}

function csodAuthHeaders({ token, cookie }) {
  return { authorization: `Bearer ${token}`, ...(cookie ? { cookie } : {}) };
}

function csodLocation(item, detail) {
  const primary = detail?.primaryLocation;
  const display = primary?.locationDisplayTitle || primary?.title;
  if (display) return display;
  const parts = (item.locations || [])
    .map((location) => [location.city, location.state].filter(Boolean).join(', '))
    .filter(Boolean);
  const unique = [...new Set(parts)];
  return unique.slice(0, 3).join('; ') || 'Unspecified';
}

// The list carries postingEffectiveDate as US-formatted M/D/YYYY, which Date
// parses inconsistently; the detail's openDate is already ISO, so prefer it and
// normalise the list value only as a fallback.
function csodPostedAt(item, detail) {
  if (detail?.openDate) return detail.openDate;
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(item.postingEffectiveDate || '').trim());
  if (!match) return null;
  const [, month, day, year] = match;
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

function mapCsodJob(item, detail, employer) {
  return {
    id: `csod:${employer.ats_token}:${item.requisitionId}`,
    employer_id: employer.id,
    title: detail?.displayTitle || item.displayJobTitle || 'Untitled role',
    department: '',
    location: csodLocation(item, detail),
    url: detail?.companyApplyUrl || csodJobUrl(employer, item.requisitionId),
    description_text: normalizeText(detail?.externalDescription || ''),
    posted_or_updated_at: csodPostedAt(item, detail),
    source: 'csod',
    source_job_id: String(item.requisitionId || '')
  };
}

async function fetchCsodJobs(employer) {
  const siteId = employer.ats_config?.site_id;
  if (siteId === undefined || siteId === null || siteId === '') {
    throw new Error('csod requires ats_config.site_id');
  }
  const host = csodHost(employer);
  const auth = await csodBootstrap(employer);

  // pageNumber is 1-based and rejects 0; pageSize is honoured as asked (a 319
  // posting site returns all 319 for pageSize=500), and totalCount is stable
  // across pages, so it is the count to trust.
  const listItems = [];
  const seen = new Set();
  let declaredTotal = 0;
  for (let page = 1; page <= CSOD_MAX_PAGES; page += 1) {
    const payload = await fetchJson(`https://${host}/services/x/career-site/v1/search?c=${encodeURIComponent(employer.ats_token)}`, {
      method: 'POST',
      headers: csodAuthHeaders(auth),
      body: {
        cultureName: 'en-US',
        careerSiteId: Number(siteId),
        pageNumber: page,
        pageSize: CSOD_PAGE_SIZE
      }
    });
    const data = payload.data || {};
    if (page === 1) declaredTotal = Number(data.totalCount || 0) || 0;
    const batch = data.requisitions || [];
    if (batch.length === 0) break;
    for (const item of batch) {
      if (item.requisitionId === undefined || seen.has(item.requisitionId)) continue;
      seen.add(item.requisitionId);
      listItems.push(item);
    }
    if (declaredTotal && listItems.length >= declaredTotal) break;
    await sleep(CSOD_DETAIL_DELAY_MS);
  }

  // Same reasoning as the ADP adapter: a short read is indistinguishable
  // downstream from a batch of postings that closed, so refuse to report it as
  // a successful fetch.
  if (declaredTotal > 0 && listItems.length < declaredTotal) {
    throw new Error(
      `Cornerstone feed incomplete for ${employer.id}: collected ${listItems.length} of ${declaredTotal} declared postings. `
      + 'Reporting as an error so existing jobs are carried forward rather than tombstoned.'
    );
  }

  const { relevant: filtered, excluded } = filterResearchRelevant(listItems, (item) => item.displayJobTitle, employer);
  const relevant = filtered.slice(0, CSOD_MAX_DETAIL_FETCHES);

  // The list gives title and location only — the description that every
  // downstream signal reads comes from the per-requisition call.
  const jobs = [];
  for (const item of relevant) {
    let detail = null;
    try {
      const payload = await fetchJson(
        `https://${host}/services/x/job-requisition/v2/requisitions/${encodeURIComponent(item.requisitionId)}`
        + `/jobDetails?cultureId=1&c=${encodeURIComponent(employer.ats_token)}`,
        { headers: csodAuthHeaders(auth) }
      );
      detail = payload.data || payload || null;
    } catch (error) {
      console.warn(`Cornerstone detail fetch failed for ${employer.id} req ${item.requisitionId}: ${error.message}`);
    }
    jobs.push(mapCsodJob(item, detail, employer));
    await sleep(CSOD_DETAIL_DELAY_MS);
  }
  jobs.prefiltered_count = excluded;
  jobs.prefilter_survived_count = filtered.length;
  return jobs;
}

// iCIMS
//
// The careers pages are an iframe wrapper: fetched plainly they return a ~33KB
// shell with no jobs and no JSON-LD, which reads as "employer has no postings"
// rather than as a failure. Adding in_iframe=1 returns the inner document,
// which does carry a JSON-LD JobPosting. That parameter is the whole adapter.
//
// The list comes from /sitemap.xml rather than the paginated search, because
// the sitemap is one request for the complete set (339 URLs for a tenant whose
// search pages 20 at a time) and its URLs embed the title, so the research
// prefilter runs before any detail fetch rather than after 17 list requests.
const ICIMS_MAX_DETAIL_FETCHES = 400;
const ICIMS_DETAIL_DELAY_MS = 150;
// ~20 postings a page, so 80 pages ≈ 1,600 — past any tenant measured here.
const ICIMS_MAX_SEARCH_PAGES = 80;

function icimsHost(employer) {
  return employer.ats_config?.host || `${employer.ats_token}.icims.com`;
}

// .../jobs/167619/research-administrator%2c-post-award-iii---school-of-medicine/job
// The slug sits second-to-last and is percent-encoded; decoding it first means
// "%2c" reads as a comma rather than as letters inside a word.
function icimsSlugSegments(url) {
  const segments = String(url || '').split('?')[0].split('/').filter(Boolean);
  const jobIndex = segments.lastIndexOf('job');
  if (jobIndex < 2) return { id: '', slug: '' };
  return { id: segments[jobIndex - 2] || '', slug: segments[jobIndex - 1] || '' };
}

function icimsTitleFromUrl(url) {
  const { slug } = icimsSlugSegments(url);
  let decoded = slug;
  try {
    decoded = decodeURIComponent(slug);
  } catch {
    // A malformed escape is not a reason to drop the posting — fall back to raw.
  }
  return decoded.replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
}

// Slugs hyphenate compounds that the title classifier only recognises closed
// up: "post-doctoral-scholar" becomes "post doctoral scholar", which it
// rejects, while "postdoctoral scholar" passes — so the plain transform was
// silently dropping the exact postings this radar exists to find. This string
// is only ever used to decide whether a posting is worth a detail fetch, so it
// carries both readings and lets the prefilter match either.
const ICIMS_SPLIT_PREFIXES = /\b(post|non|pre|co|sub|multi|inter|intra)\s+(?=[a-z])/g;

function icimsPrefilterTitle(url) {
  const spaced = icimsTitleFromUrl(url);
  const closed = spaced.replace(ICIMS_SPLIT_PREFIXES, '$1');
  return closed === spaced ? spaced : `${spaced} ${closed}`;
}

// in_iframe=1 is what turns the wrapper into the document carrying JSON-LD.
function icimsDetailUrl(url) {
  return url.includes('?') ? `${url}&in_iframe=1` : `${url}?in_iframe=1`;
}

// iCIMS fills unknown address fields with the literal string "UNAVAILABLE"
// rather than omitting them, which reaches the dashboard as locations like
// "Remote, UNAVAILABLE". Drop those before the shared formatter sees them.
function icimsCleanPosting(posting) {
  const places = [].concat(posting.jobLocation || []).map((place) => {
    const address = { ...(place?.address || {}) };
    for (const key of Object.keys(address)) {
      if (String(address[key]).trim().toUpperCase() === 'UNAVAILABLE') delete address[key];
    }
    return { ...place, address };
  });
  return { ...posting, jobLocation: places };
}

function mapIcimsJob(url, posting, employer) {
  const { id } = icimsSlugSegments(url);
  return {
    id: `icims:${employer.ats_token}:${id}`,
    employer_id: employer.id,
    title: posting.title || icimsTitleFromUrl(url) || 'Untitled role',
    department: '',
    location: jsonLdLocation(icimsCleanPosting(posting)),
    url,
    description_text: normalizeText(posting.description || ''),
    posted_or_updated_at: posting.datePosted || null,
    source: 'icims',
    source_job_id: String(id || '')
  };
}

function icimsJobPathsFromHtml(html) {
  return [...new Set(String(html || '').match(/\/jobs\/\d+\/[^"'<>?\s]*?\/job/g) || [])];
}

// Fallback for tenants that answer /sitemap.xml with 403 while serving search
// perfectly well (careersat-ohsu does exactly this). Pages are 0-indexed via
// pr=, run ~15-20 postings each, and go empty past the end rather than
// erroring, so "a page added nothing new" is the terminator.
async function icimsSearchJobUrls(host) {
  const urls = new Set();
  for (let page = 0; page < ICIMS_MAX_SEARCH_PAGES; page += 1) {
    const html = await fetchText(`https://${host}/jobs/search?ss=1&in_iframe=1&pr=${page}`, {
      headers: { accept: 'text/html,application/xhtml+xml' }
    });
    const before = urls.size;
    for (const path of icimsJobPathsFromHtml(html)) urls.add(`https://${host}${path}`);
    if (urls.size === before) break;
    await sleep(ICIMS_DETAIL_DELAY_MS);
  }
  return [...urls];
}

async function icimsJobUrls(employer, host) {
  let sitemapError;
  try {
    const xml = await fetchText(`https://${host}/sitemap.xml`, { headers: { accept: 'application/xml, text/xml, */*' } });
    const fromSitemap = [...new Set(
      parseSitemapUrls(xml).filter((url) => url.includes('/jobs/') && url.split('?')[0].replace(/\/$/, '').endsWith('/job'))
    )];
    if (fromSitemap.length) return fromSitemap;
  } catch (error) {
    sitemapError = error;
  }
  // Only now pay for paging. If both routes fail, raise the search error rather
  // than return an empty list — an employer whose feed is unreachable must not
  // be reported as an employer with no postings.
  try {
    return await icimsSearchJobUrls(host);
  } catch (error) {
    throw new Error(
      `iCIMS listing unreachable for ${employer.id}: search paging failed (${error.message})`
      + (sitemapError ? `; sitemap also failed (${sitemapError.message})` : '')
    );
  }
}

async function fetchIcimsJobs(employer) {
  const host = icimsHost(employer);
  const jobUrls = await icimsJobUrls(employer, host);

  const { relevant: filtered, excluded } = filterResearchRelevant(jobUrls, icimsPrefilterTitle, employer);
  const relevant = filtered.slice(0, ICIMS_MAX_DETAIL_FETCHES);

  const jobs = [];
  for (const url of relevant) {
    try {
      const html = await fetchText(icimsDetailUrl(url), { headers: { accept: 'text/html,application/xhtml+xml' } });
      const posting = extractJsonLdJobPosting(html);
      // A sitemap entry with no JSON-LD is a job that has since closed; the
      // sitemap lags. Skipping it is right — the alternative is a title-only
      // record that every downstream signal would score as empty.
      if (posting) jobs.push(mapIcimsJob(url, posting, employer));
    } catch (error) {
      console.warn(`iCIMS detail fetch failed for ${employer.id} ${url}: ${error.message}`);
    }
    await sleep(ICIMS_DETAIL_DELAY_MS);
  }
  jobs.prefiltered_count = excluded;
  jobs.prefilter_survived_count = filtered.length;
  return jobs;
}

const ATS_FETCHERS = {
  greenhouse: fetchGreenhouseJobs,
  pageup: fetchPageUpJobs,
  csod: fetchCsodJobs,
  icims: fetchIcimsJobs,
  adp: fetchAdpJobs,
  lever: fetchLeverJobs,
  ashby: fetchAshbyJobs,
  smartrecruiters: fetchSmartRecruitersJobs,
  workday: fetchWorkdayJobs,
  oracle: fetchOracleJobs,
  taleo: fetchTaleoJobs,
  ultipro: fetchUltiproJobs,
  successfactors: fetchSuccessFactorsJobs,
  eightfold: fetchEightfoldJobs,
  paylocity: fetchPaylocityJobs,
  interfolio: fetchInterfolioJobs,
  governmentjobs: fetchGovernmentJobsJobs,
  recruitee: fetchRecruiteeJobs,
  breezy: fetchBreezyJobs,
  workable: fetchWorkableJobs,
  usajobs: fetchUsaJobsJobs,
  peopleadmin: fetchPeopleAdminJobs
};

// The allowlist IS the dispatch table — a provider is supported exactly when a
// fetcher exists to serve it. This used to be a second, hand-maintained literal
// and the two drifted: the adp and pageup adapters shipped wired into
// ATS_FETCHERS but were never added to the list, so the 46 promoted ADP
// employers failed validateEmployer and took every refresh down with them for
// ~9h on 2026-08-05. Deriving it means adding a fetcher is the only step.
const SUPPORTED_ATS_PROVIDERS = Object.keys(ATS_FETCHERS);

// A few employers genuinely run two separate ATS feeds — most commonly a
// Workday/PeopleAdmin/Oracle board for staff and a completely separate
// Interfolio board for faculty searches (University of Rochester: a
// Workday "Staff" site plus a 353-posting Interfolio faculty board the
// registry couldn't represent at all before this). secondary_ats_feeds is
// optional and absent for nearly every employer.
async function fetchEmployerJobs(employer, fetchers = ATS_FETCHERS) {
  const descriptors = [
    { ats_provider: employer.ats_provider, ats_token: employer.ats_token, ats_config: employer.ats_config },
    ...(employer.secondary_ats_feeds || [])
  ].filter((feed) => feed.ats_provider);

  if (descriptors.length === 0) {
    return { jobs: [], skipped: true, error: null, prefilteredCount: 0, prefilterSurvivedCount: null, feeds: undefined };
  }

  const jobs = [];
  const feeds = [];
  let prefilteredCount = 0;
  let prefilterSurvivedCount = null;

  for (const feed of descriptors) {
    const view = { ...employer, ats_provider: feed.ats_provider, ats_token: feed.ats_token, ats_config: feed.ats_config };
    const fetcher = fetchers[feed.ats_provider];
    if (!fetcher) {
      feeds.push({ ats_provider: feed.ats_provider, ats_token: feed.ats_token, ok: false, skipped: false, error: `Unsupported ATS provider ${feed.ats_provider}`, fetchedCount: 0 });
      continue;
    }
    try {
      // Fail-soft per feed (matching the existing SmartRecruiters
      // per-posting precedent): one broken feed shouldn't sink the other.
      const feedJobs = await fetcher(view);
      // prefilter_survived_count is a property stapled onto the returned
      // array — it's lost once jobs from multiple feeds are concatenated
      // together, so it must be read here, immediately after this feed's
      // own call, not off the merged array afterward.
      const feedExcluded = Number(feedJobs.prefiltered_count) || 0;
      const feedSurvived = feedJobs.prefilter_survived_count === undefined ? null : Number(feedJobs.prefilter_survived_count) || 0;
      jobs.push(...feedJobs);
      prefilteredCount += feedExcluded;
      if (feedSurvived !== null) prefilterSurvivedCount = (prefilterSurvivedCount || 0) + feedSurvived;
      feeds.push({ ats_provider: feed.ats_provider, ats_token: feed.ats_token, ok: true, skipped: false, error: null, fetchedCount: feedJobs.length });
    } catch (error) {
      if (error.skipped) {
        feeds.push({ ats_provider: feed.ats_provider, ats_token: feed.ats_token, ok: true, skipped: true, error: null, fetchedCount: 0 });
        continue;
      }
      feeds.push({ ats_provider: feed.ats_provider, ats_token: feed.ats_token, ok: false, skipped: false, error: error.message, fetchedCount: 0 });
    }
  }

  const allSkipped = feeds.every((feed) => feed.skipped);
  const allFailed = feeds.every((feed) => !feed.ok);
  return {
    jobs,
    skipped: allSkipped,
    // Only report an error if EVERY feed failed — one feed down while
    // another still returns jobs is a soft success, not a hard failure.
    error: allFailed ? feeds.map((feed) => feed.error).filter(Boolean).join('; ') || null : null,
    prefilteredCount,
    prefilterSurvivedCount,
    // Kept only for employers with more than one feed, so the committed
    // report stays byte-identical for the ~337 single-feed employers.
    // Required, not cosmetic: detectRecallAnomalies below reads this to
    // catch one feed of a multi-feed employer silently dying — without it,
    // fetched_jobs is a sum across feeds and can stay nonzero even if a
    // secondary feed is broken.
    feeds: feeds.length > 1 ? feeds : undefined
  };
}

/**
 * The host an employer's requests actually land on. Two registry entries that
 * share a tenant (a primary and a secondary feed on the same board, two
 * campuses on one shared system) must not be fetched at the same time, so they
 * share a lane and run one after the other. Everything else is a distinct host
 * and is free to run in parallel.
 */
function hostLane(employer) {
  const feeds = [
    { ats_provider: employer.ats_provider, ats_token: employer.ats_token },
    ...(employer.secondary_ats_feeds || [])
  ].filter((feed) => feed.ats_provider);
  if (!feeds.length) return null;
  /* ADP is the exception the token-keyed lane gets wrong: every tenant is a
   * "cid" on ONE host, so keying on the token invents 47 lanes over a single
   * server and lets four of them hammer it at once. Key it on the host it
   * really is. */
  if (feeds[0].ats_provider === 'adp') return `adp:${ADP_HOST}`;
  // The primary feed decides the lane; a secondary feed on a busy host is rare
  // enough that serializing on the primary is the right trade.
  return `${feeds[0].ats_provider}:${feeds[0].ats_token ?? ''}`;
}

function providerLane(employer) {
  return employer.ats_provider || null;
}

/**
 * Runs `worker` over `items` concurrently, subject to two limits: a global
 * in-flight cap, and a per-provider cap so one ATS vendor is never hit by more
 * than a handful of tenants at once. Items whose lane or provider is saturated
 * are skipped over and retried on the next scheduling pass, so a single slow
 * vendor cannot stall unrelated employers.
 *
 * Results come back in INPUT order regardless of completion order — the
 * refresh report and the job array are committed to git, so a run's output
 * must not depend on which feed happened to answer first.
 *
 * Worker rejections are captured rather than raced: the pool always drains
 * before the first error is rethrown, so one bad employer can't leave other
 * in-flight fetches as unhandled rejections.
 */
async function runPooled(items, worker, options = {}) {
  const concurrency = Math.max(1, options.concurrency || REFRESH_CONCURRENCY);
  const perProvider = Math.max(1, options.perProvider || REFRESH_PROVIDER_CONCURRENCY);
  const providerLimits = options.providerLimits || PROVIDER_LIMITS;
  const laneOf = options.laneOf || (() => null);
  const groupOf = options.groupOf || (() => null);
  const onStart = options.onStart || null;

  const results = new Array(items.length);
  const pending = items.map((item, index) => ({ item, index }));
  const running = new Set();
  const busyLanes = new Set();
  const groupLoad = new Map();
  const errors = [];

  const runnable = (entry) => {
    const lane = laneOf(entry.item);
    if (lane && busyLanes.has(lane)) return false;
    const group = groupOf(entry.item);
    const cap = providerLimits[group] ?? perProvider;
    if (group && (groupLoad.get(group) || 0) >= cap) return false;
    return true;
  };

  while (pending.length || running.size) {
    for (let index = 0; index < pending.length && running.size < concurrency;) {
      if (!runnable(pending[index])) {
        index += 1;
        continue;
      }
      const [entry] = pending.splice(index, 1);
      const lane = laneOf(entry.item);
      const group = groupOf(entry.item);
      if (lane) busyLanes.add(lane);
      if (group) groupLoad.set(group, (groupLoad.get(group) || 0) + 1);
      if (onStart) onStart(entry.item, entry.index);
      const task = Promise.resolve()
        .then(() => worker(entry.item, entry.index))
        .then((value) => { results[entry.index] = value; })
        .catch((error) => { errors.push(error); })
        .finally(() => {
          running.delete(task);
          if (lane) busyLanes.delete(lane);
          if (group) groupLoad.set(group, (groupLoad.get(group) || 0) - 1);
        });
      running.add(task);
    }
    if (!running.size) {
      // Nothing runnable and nothing running would be a deadlock; the lane and
      // group counters are only decremented by running tasks, so this is
      // unreachable unless a limit is misconfigured. Fail loudly, don't hang.
      throw new Error('refresh pool deadlocked: no runnable work and nothing in flight');
    }
    await Promise.race(running);
  }

  if (errors.length) throw errors[0];
  return results;
}

/**
 * Staggers the start of employers that share an ATS vendor, so a provider sees
 * requests spread out rather than a simultaneous burst from every tenant.
 */
function createProviderPacer(delayMs = EMPLOYER_DELAY_MS, overrides = PROVIDER_DELAY_MS) {
  const nextFreeAt = new Map();
  return async function pace(provider) {
    if (!provider) return;
    const gap = overrides[provider] ?? delayMs;
    const now = Date.now();
    const readyAt = nextFreeAt.get(provider) || 0;
    const waitMs = Math.max(0, readyAt - now);
    nextFreeAt.set(provider, Math.max(now, readyAt) + gap);
    if (waitMs > 0) await sleep(waitMs);
  };
}

/**
 * What kind of failure this is, for the purpose of noticing that a whole
 * provider has gone down rather than one tenant.
 *
 * Only failures a vendor produces IDENTICALLY across unrelated tenants count:
 * a challenge page served as a 200, or the same HTTP status everywhere. Network
 * errors and timeouts deliberately return null — a wedged CI runner shows up as
 * timeouts on everything, and mistaking that for a vendor outage would stop the
 * refresh from even trying.
 */
function breakerSignature(errorText) {
  const text = String(errorText || '');
  if (/non-JSON response/.test(text)) return 'non-json';
  const status = /HTTP (\d{3})/.exec(text);
  return status ? `http:${status[1]}` : null;
}

/**
 * When enough unrelated tenants of one provider fail the same way, stop asking
 * the rest. Their previous jobs are carried forward by the lifecycle, so the
 * cost of being wrong is one run of staleness — while the cost of being right
 * is not spending an hour of timeouts on a vendor that is down.
 *
 * Distinct EMPLOYERS are counted, not failures: one tenant retrying is not
 * evidence about anybody else.
 */
function createProviderBreaker({ threshold = 5 } = {}) {
  const seen = new Map();
  const open = new Map();
  return {
    record(provider, employerId, errorText) {
      if (!provider || open.has(provider)) return;
      const signature = breakerSignature(errorText);
      if (!signature) return;
      const key = `${provider} ${signature}`;
      const tenants = seen.get(key) || new Set();
      tenants.add(employerId);
      seen.set(key, tenants);
      if (tenants.size >= threshold) open.set(provider, signature);
    },
    openSignature(provider) {
      return (provider && open.get(provider)) || null;
    },
    tripped() {
      return [...open.entries()].map(([provider, signature]) => ({ provider, signature }));
    }
  };
}

async function runRefresh() {
  const registryEmployers = await readJson(EMPLOYERS_PATH, []);
  const enrichment = await readJson(ENRICHMENT_PATH, null);
  const employers = applyEnrichmentOverlay(registryEmployers, enrichment);
  // Lifecycle state (first_seen_at, tombstones) lives in Supabase once the
  // dataset stops being committed; the local file remains the fallback
  const supabaseConfigured = Boolean(supabaseEnv());
  let previousJobs = null;
  let supabaseReadFailed = false;
  // Provenance matters for the sync guard below: a length check alone can't
  // tell a trustworthy remote read from a stale local fallback. Only a
  // successful, non-empty remote read is a baseline we can safely overwrite.
  let previousFromRemote = false;
  try {
    const remote = await fetchAllJobs();
    if (remote) {
      previousJobs = remote;
      previousFromRemote = true;
      console.log(`Loaded ${remote.length} previous jobs from Supabase`);
    }
  } catch (error) {
    supabaseReadFailed = true;
    console.warn(`Supabase previous-state read failed, using local file: ${error.message}`);
  }
  if (!previousJobs) previousJobs = await readJson(JOBS_PATH, []);
  // In Supabase mode only a remote read is authoritative; in git-only mode the
  // local file IS the dataset of record, so it's trustworthy on its own.
  const trustedBaseline = supabaseConfigured ? previousFromRemote : true;
  const dolSignals = await readJson(DOL_SIGNALS_PATH, {});
  const previousById = new Map(previousJobs.map((job) => [job.id, job]));
  const fetchedJobs = [];
  const employerReports = [];
  const employerOutcomes = new Map();

  // Validate the whole registry BEFORE any fetching: a malformed entry is a
  // repo bug, and it should abort the run instantly rather than after an hour
  // of network work.
  for (const employer of employers) validateEmployer(employer);

  const pace = createProviderPacer();
  const breaker = createProviderBreaker();
  const completed = { count: 0 };
  const outcomes = await runPooled(employers, async (employer) => {
    // This provider is already known to be answering the same way for everyone.
    // Reporting it as an error (not "skipped") is what makes applyJobLifecycle
    // carry the employer's existing jobs forward instead of tombstoning them.
    const openSignature = breaker.openSignature(employer.ats_provider);
    if (openSignature) {
      completed.count += 1;
      return {
        employer,
        enriched: [],
        result: {
          jobs: [], skipped: false, prefilteredCount: 0, prefilterSurvivedCount: 0,
          error: `${employer.ats_provider} circuit open (${openSignature} from multiple tenants)`
            + ' — not queried; previous jobs carried forward'
        }
      };
    }
    await pace(employer.ats_provider);
    const result = await fetchEmployerJobs(employer);
    if (result.error) breaker.record(employer.ats_provider, employer.id, result.error);
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
    completed.count += 1;
    if (completed.count % 25 === 0 || completed.count === employers.length) {
      console.log(`  ...${completed.count}/${employers.length} employers fetched`);
    }
    return { employer, result, enriched };
  }, {
    concurrency: REFRESH_CONCURRENCY,
    perProvider: REFRESH_PROVIDER_CONCURRENCY,
    laneOf: hostLane,
    groupOf: providerLane
  });

  console.log(`Fetched ${employers.length} employers with concurrency ${REFRESH_CONCURRENCY} (per provider ${REFRESH_PROVIDER_CONCURRENCY})`);

  // Registry order, not completion order — refresh-report.json is committed,
  // so its row order must stay stable across runs.
  for (const { employer, result, enriched } of outcomes) {
    fetchedJobs.push(...enriched);
    employerOutcomes.set(employer.id, { attempted: !result.skipped, ok: !result.error });
    employerReports.push({
      employer_id: employer.id,
      name: employer.name,
      ats_provider: employer.ats_provider,
      ats_token: employer.ats_token,
      fetched_jobs: enriched.length,
      prefiltered_count: result.prefilteredCount,
      prefilter_survived_count: result.prefilterSurvivedCount,
      skipped: result.skipped,
      error: result.error,
      feeds: result.feeds
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
  // Then collapse the same role surfaced by multiple sources (ATS beats scout
  // beats aggregator), keeping distinct same-source reqs intact.
  const dedupedFetched = dedupeCrossSource(uniqueFetched);

  const allJobs = applyJobLifecycle({ previousJobs, fetchedJobs: dedupedFetched, employerOutcomes, now });

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

  // A "dropped to zero" signal is only meaningful against a baseline we trust;
  // against a stale/empty one every feed looks empty, so skip detection rather
  // than flood alerts.
  const recallAnomalies = trustedBaseline
    ? detectRecallAnomalies({ previousJobs, employerReports, employerOutcomes })
    : [];
  // No previous-state dependency, so this runs unconditionally.
  const prefilterAnomalies = detectPrefilterAnomalies({ employerReports });

  const report = {
    refreshed_at: now,
    employer_count: employers.length,
    ats_enabled_employer_count: employers.filter((employer) => employer.ats_provider).length,
    job_count: allJobs.length,
    active_job_count: allJobs.length - closedJobs.length,
    closed_job_count: closedJobs.length,
    newly_closed_count: closedJobs.filter((job) => job.closed_at === now).length,
    errored_employers: employerReports.filter((report) => report.error).length,
    recall_anomalies: recallAnomalies,
    prefilter_anomalies: prefilterAnomalies,
    provider_circuits: breaker.tripped(),
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
  if (recallAnomalies.length) {
    const summary = recallAnomalies
      .map((a) => `${a.name} (${a.previous_active} → 0)`)
      .join(', ');
    console.warn(`Zero-job recall alarm: ${recallAnomalies.length} employer(s) dropped to zero on an OK fetch: ${summary}`);
    await pushNtfy({
      title: `Radar recall alarm: ${recallAnomalies.length} feed(s) went to zero`,
      body: recallAnomalies
        .map((a) => `• ${a.name} [${a.ats_provider || 'n/a'}]: ${a.previous_active} active → 0`)
        .join('\n'),
      tags: 'warning'
    });
  }
  if (prefilterAnomalies.length) {
    const summary = prefilterAnomalies
      .map((a) => `${a.name} (${a.prefiltered_count} excluded, ${a.fetched_jobs} fetched)`)
      .join(', ');
    console.warn(`Prefilter alarm: ${prefilterAnomalies.length} employer(s) excluded almost every title this run: ${summary}`);
    await pushNtfy({
      title: `Radar prefilter alarm: ${prefilterAnomalies.length} feed(s) look over-filtered`,
      body: prefilterAnomalies
        .map((a) => `• ${a.name} [${a.ats_provider || 'n/a'}]: ${a.prefiltered_count} excluded vs ${a.fetched_jobs} fetched`)
        .join('\n'),
      tags: 'warning'
    });
  }
  const trippedCircuits = report.provider_circuits;
  if (trippedCircuits.length) {
    // Deliberately loud. This also pushes errored_employers well past the
    // dead-man threshold, which is correct — a vendor answering the same way
    // for every tenant is exactly the thing nobody should learn about a week
    // later from a dashboard that quietly stopped changing.
    const summary = trippedCircuits.map((c) => `${c.provider} (${c.signature})`).join(', ');
    console.warn(`Provider circuit opened: ${summary} — remaining tenants skipped, their jobs carried forward.`);
    await pushNtfy({
      title: `Radar provider outage: ${summary}`,
      body: trippedCircuits
        .map((c) => `• ${c.provider}: multiple unrelated tenants returned ${c.signature}; remaining tenants not queried`)
        .join('\n'),
      tags: 'rotating_light'
    });
  }

  // Supabase IS the dataset of record — the dashboard, the digest and the judge
  // all read it, and jobs.json is a local convenience. A sync that fails is
  // therefore a failed refresh, not a footnote.
  //
  // Guard the destructive path first: the sync deletes the rows its baseline
  // had and this run no longer carries. That is only meaningful when we
  // successfully loaded the previous state. If we could NOT trust it — the read
  // errored (rows are still in Supabase but unseen here), or it came back empty
  // and the local fallback was empty too (the normal CI shape) — then syncing is
  // unsafe no matter how many jobs this run fetched: it would reset first_seen,
  // drop tombstones, and treat every unread row as departed. A stale local
  // fallback is no safer — pushing it would overwrite fresher remote rows we
  // never read, so we trust the baseline ONLY when it came from a successful
  // non-empty remote read (trustedBaseline). Abort in every other case; a
  // genuine first-run bootstrap sets RADAR_ALLOW_EMPTY_SYNC=1.
  const wouldResetLifecycle = supabaseConfigured
    && !trustedBaseline
    && !process.env.RADAR_ALLOW_EMPTY_SYNC;
  if (wouldResetLifecycle) {
    report.supabase_sync_aborted = supabaseReadFailed
      ? 'previous-state read failed; refusing to overwrite the dataset of record'
      : 'no trustworthy previous state (empty remote / local-only fallback); refusing to reset first_seen/tombstones or wipe the table';
    await writeJson(REPORT_PATH, report);
    console.warn(`Supabase sync ABORTED: ${report.supabase_sync_aborted}. `
      + 'Set RADAR_ALLOW_EMPTY_SYNC=1 only for an intentional first-run bootstrap.');
    return report;
  }
  try {
    // The baseline this run already read, reused as the diff's left-hand side.
    const sync = await syncJobs(allJobs, report, { previous: previousFromRemote ? previousJobs : null });
    if (sync.synced) {
      report.supabase_sync_status = 'ok';
      console.log(`Supabase sync: ${sync.upserted} upserted, ${sync.deleted} deleted, `
        + `${sync.unchanged} unchanged (${sync.count} total)`);
    } else {
      console.log(`Supabase sync skipped (${sync.reason})`);
    }
    await writeJson(REPORT_PATH, report);
  } catch (error) {
    /* The report was written before the sync was attempted, so without this it
     * would be committed looking like a clean run. Record the failure, then
     * fail the step: the workflow runs the judge immediately after this one and
     * deliberately without `if: always()`, so a non-zero exit is what stops it
     * paying to judge a table that missed this run's writes. The commit step
     * runs with `if: always()` and preserves the report either way. */
    report.supabase_sync_status = 'failed';
    report.supabase_sync_error = String(error.message).slice(0, 300);
    await writeJson(REPORT_PATH, report);
    console.error(`Supabase sync FAILED: ${error.message}`);
    process.exitCode = 1;
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
  parseSitemapUrls,
  extractJsonLdJobPosting,
  isChallengeResponse,
  pageUpTitleFromUrl,
  mapPageUpJob,
  mapAdpJob,
  adpLocation,
  fetchPageUpJobs,
  fetchAdpJobs,
  mapCsodJob,
  csodLocation,
  csodPostedAt,
  extractCsodToken,
  csodBootstrap,
  csodAuthHeaders,
  fetchCsodJobs,
  mapIcimsJob,
  icimsTitleFromUrl,
  icimsPrefilterTitle,
  icimsSlugSegments,
  icimsDetailUrl,
  icimsCleanPosting,
  icimsJobPathsFromHtml,
  fetchIcimsJobs,
  runPooled,
  hostLane,
  providerLane,
  createProviderPacer,
  createProviderBreaker,
  breakerSignature,
  parsePeopleAdminAtom,
  mapPeopleAdminEntry,
  fetchPeopleAdminJobs,
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
  detectWorkMode,
  institutionCity,
  applyJobLifecycle,
  dedupeCrossSource,
  detectRecallAnomalies,
  detectPrefilterAnomalies,
  filterResearchRelevant,
  activeScoutedJobs,
  applyEnrichmentOverlay,
  fetchGreenhouseJobs,
  fetchLeverJobs,
  fetchAshbyJobs,
  fetchSmartRecruitersJobs,
  fetchWorkdayJobs,
  fetchOracleJobs,
  mapOracleJob,
  fetchText,
  fetchTaleoJobs,
  mapTaleoJob,
  parseTaleoDetailPage,
  parseTaleoLocation,
  fetchUltiproJobs,
  mapUltiproJob,
  fetchSuccessFactorsJobs,
  parseSuccessFactorsSitemap,
  parseSuccessFactorsJobPage,
  mapSuccessFactorsJob,
  fetchEightfoldJobs,
  mapEightfoldJob,
  fetchPaylocityJobs,
  mapPaylocityJob,
  parsePaylocityListPage,
  parsePaylocityDetailPage,
  fetchInterfolioJobs,
  mapInterfolioJob,
  fetchGovernmentJobsJobs,
  mapGovernmentJobsJob,
  parseGovernmentJobsListPage,
  parseGovernmentJobsDetailPage,
  fetchEmployerJobs,
  validateEmployer,
  ATS_FETCHERS,
  runRefresh
};
