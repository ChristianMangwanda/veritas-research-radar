#!/usr/bin/env node

/**
 * Resume-variant routing, ambiguity resolver — OPTIONAL local step.
 *
 * Deterministic scoring (radar/public/scoring.js) recommends a resume variant
 * per job; when the top two variants score within AMBIGUITY_MARGIN of each
 * other the call is genuinely close. This script re-judges only those jobs
 * with a local open-source model via Ollama and caches the verdicts in
 * radar/data/route-cache.json (gitignored), keyed to the profile hash so
 * verdicts never outlive the profile they were decided against.
 *
 * The model only ever picks WHICH of the user's own resumes fits a posting —
 * it never writes or edits resume content. Job text and profile skill terms
 * go to the local model only; nothing leaves this machine. The dashboard
 * works fine without this step: deterministic routing stays in effect for
 * any job without a cached verdict.
 *
 * Usage:
 *   npm run radar:route                     # resolve ambiguous jobs (default caps)
 *   npm run radar:route -- --limit 50      # cap how many jobs to ask about
 *   npm run radar:route -- --min-fit 40    # skip low-fit jobs entirely
 *   npm run radar:route -- --model llama3.1:8b
 *   OLLAMA_MODEL / OLLAMA_URL env vars override the defaults.
 */

const fsp = require('fs/promises');
const path = require('path');
const RadarScoring = require('../public/scoring.js');

const DATA_DIR = path.resolve(__dirname, '../data');
const PROFILE_PATH = path.join(DATA_DIR, 'profile.json');
const JOBS_PATH = path.join(DATA_DIR, 'jobs.json');
const CACHE_PATH = path.join(DATA_DIR, 'route-cache.json');

const DEFAULT_MODEL = process.env.OLLAMA_MODEL || 'qwen3:8b';
const DEFAULT_BASE_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const DESCRIPTION_SLICE = 2500;
const CONFIDENCE_LEVELS = ['high', 'medium', 'low'];

const SYSTEM_PROMPT = `You pick which of a candidate's own resume variants best fits a job posting. The candidate wrote every variant themselves and declared what each one leads with. You never write or edit resume content; you only choose a variant id and give a one-line reason grounded in the posting text.`;

/* ------------------------------------------------------------------------ */
/* Pure helpers (exported for tests)                                         */

function selectAmbiguousJobs(jobs, verdicts, { minFit = 0, limit = 200 } = {}) {
  return jobs
    .filter((job) => job.fit
      && job.fit.ambiguous
      && job.fit.fit_score !== null
      && job.fit.fit_score >= minFit
      && !(verdicts && verdicts[job.id]))
    .sort((a, b) => b.fit.fit_score - a.fit.fit_score)
    .slice(0, Math.max(0, limit));
}

function validateVerdict(raw, variantIds) {
  if (!raw || typeof raw !== 'object') return null;
  if (!variantIds.includes(raw.variant_id)) return null;
  return {
    variant_id: raw.variant_id,
    confidence: CONFIDENCE_LEVELS.includes(raw.confidence) ? raw.confidence : 'low',
    reason: String(raw.reason || '').trim().slice(0, 300)
  };
}

function buildRoutePrompt(job, profile, fit) {
  const variantLines = profile.variants.map((variant) => {
    const scored = fit.variants.find((entry) => entry.id === variant.id);
    const topSkills = (variant.skills || [])
      .slice()
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 10)
      .map((skill) => skill.term)
      .join(', ');
    return `- id: ${variant.id} | ${variant.label} | intent: ${variant.intent} | top skills: ${topSkills} | deterministic score for this job: ${scored ? scored.score : 0}`;
  });

  return [
    'The candidate maintains these resume variants:',
    ...variantLines,
    '',
    `Job posting — ${job.title}${job.department ? ` (${job.department})` : ''}:`,
    String(job.description_text || '').slice(0, DESCRIPTION_SLICE),
    '',
    'Deterministic scoring found the top variants too close to call for this posting. Pick the single best variant id. Answer in JSON.'
  ].join('\n');
}

/* ------------------------------------------------------------------------ */
/* Ollama                                                                    */

async function ollamaAvailable(baseUrl) {
  try {
    const response = await fetch(`${baseUrl}/api/tags`);
    return response.ok;
  } catch {
    return false;
  }
}

async function askOllama(job, profile, fit, { model, baseUrl }) {
  const variantIds = profile.variants.map((variant) => variant.id);
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildRoutePrompt(job, profile, fit) }
      ],
      format: {
        type: 'object',
        additionalProperties: false,
        required: ['variant_id', 'confidence', 'reason'],
        properties: {
          variant_id: { type: 'string', enum: variantIds },
          confidence: { type: 'string', enum: CONFIDENCE_LEVELS },
          reason: { type: 'string' }
        }
      },
      options: { temperature: 0 }
    })
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`ollama ${response.status}: ${body.slice(0, 200)}`);
  }
  const data = await response.json();
  let parsed = null;
  try {
    parsed = JSON.parse(data.message?.content ?? '');
  } catch {
    return null;
  }
  return validateVerdict(parsed, variantIds);
}

/* ------------------------------------------------------------------------ */

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fsp.readFile(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, value) {
  await fsp.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function parseArgs(argv) {
  const options = { limit: 200, minFit: 0, model: DEFAULT_MODEL };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--limit') options.limit = Number(argv[++i]);
    else if (argv[i] === '--min-fit') options.minFit = Number(argv[++i]);
    else if (argv[i] === '--model') options.model = String(argv[++i]);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  const profile = await readJson(PROFILE_PATH, null);
  const problem = profile ? RadarScoring.validateProfile(profile) : 'radar/data/profile.json not found';
  if (problem) {
    console.error(`Cannot route: ${problem}`);
    console.error('Build your profile first: npm run radar:profile');
    process.exitCode = 1;
    return;
  }
  if (profile.variants.length < 2) {
    console.log('Only one resume variant — nothing to route.');
    return;
  }

  const jobs = await readJson(JOBS_PATH, []);
  if (!jobs.length) {
    console.error('radar/data/jobs.json is empty — run npm run radar:refresh first.');
    process.exitCode = 1;
    return;
  }

  const compiled = RadarScoring.compileProfile(profile);
  RadarScoring.scoreAll(jobs, compiled, null);

  let cache = await readJson(CACHE_PATH, null);
  if (!cache || cache.profile_hash !== compiled.hash) {
    if (cache) console.log('Profile changed since the last run — starting a fresh verdict map.');
    cache = { schema_version: 1, profile_hash: compiled.hash, model: options.model, verdicts: {} };
  }

  const candidates = selectAmbiguousJobs(jobs, cache.verdicts, options);
  if (!candidates.length) {
    console.log('No ambiguous jobs need routing — deterministic recommendations stand.');
    return;
  }

  if (!(await ollamaAvailable(DEFAULT_BASE_URL))) {
    console.log('Ollama is not running — deterministic routing stays in effect.');
    console.log(`To enable local routing: install https://ollama.com, then: ollama pull ${options.model}`);
    return;
  }

  console.log(`Routing ${candidates.length} ambiguous job(s) with ${options.model} (local)…`);
  let decided = 0;
  for (const [index, job] of candidates.entries()) {
    let verdict = null;
    try {
      verdict = await askOllama(job, profile, job.fit, { model: options.model, baseUrl: DEFAULT_BASE_URL });
    } catch (error) {
      console.error(`\n${error.message}`);
      if (/404/.test(error.message)) {
        console.error(`Model missing? Try: ollama pull ${options.model}`);
      }
      break;
    }
    if (!verdict) {
      console.log(`  [${index + 1}/${candidates.length}] ${job.title.slice(0, 60)} → unusable answer, skipped`);
      continue;
    }
    cache.verdicts[job.id] = { ...verdict, decided_at: new Date().toISOString() };
    cache.model = options.model;
    decided += 1;
    console.log(`  [${index + 1}/${candidates.length}] ${job.title.slice(0, 60)} → ${verdict.variant_id} (${verdict.confidence})`);
    // Save as we go so an interrupted run keeps its progress
    if (decided % 5 === 0) await writeJson(CACHE_PATH, cache);
  }

  await writeJson(CACHE_PATH, cache);
  console.log(`\n${decided} verdict(s) saved to ${path.relative(process.cwd(), CACHE_PATH)} (gitignored — stays local)`);
  console.log('Reload the dashboard — ambiguous jobs now show the locally-resolved variant.');
}

module.exports = {
  selectAmbiguousJobs,
  validateVerdict,
  buildRoutePrompt,
  askOllama,
  SYSTEM_PROMPT
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
