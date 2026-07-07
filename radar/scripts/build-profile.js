#!/usr/bin/env node

/**
 * Resume-aware ranking, step 1: understand the user's own resumes once, deeply.
 *
 * The user maintains several resume variants they wrote themselves (ML
 * engineer, data engineer, ...), declared in radar/data/resumes/manifest.json
 * with a label and an intent note. For each variant this script extracts a
 * structured, matchable profile (title classes from the radar's own taxonomy,
 * weighted skill terms with aliases, degrees, domains), reconciles the shared
 * facts into a core block, and writes radar/data/profile.json v2.
 *
 * Extraction runs on a LOCAL open-source model via Ollama by default, so
 * resume text never leaves the machine at all. Structured extraction is
 * shallow work a 7-8B model handles well. A hosted Claude fallback stays
 * available for when local quality is not enough (--provider anthropic).
 *
 * Nothing here writes or edits resume content — extraction only. Results are
 * cached by content hash + model, so re-runs and added variants are cheap.
 *
 * The dashboard then ranks all jobs deterministically against the variants —
 * no per-job model calls — and recommends which resume to use per job.
 *
 * Usage:
 *   npm run radar:profile                          # local Ollama, manifest mode
 *   npm run radar:profile -- resume.txt            # local Ollama, single file
 *   npm run radar:profile -- --model qwen2.5:14b-instruct
 *   ANTHROPIC_API_KEY=sk-... npm run radar:profile -- --provider anthropic
 *   Flags: --force   re-extract even when the cache has an entry
 *          --provider ollama|anthropic  (default: ollama)
 *          --model <tag>                override the model (also OLLAMA_MODEL env)
 */

const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { CLASS_LABELS } = require('./lib/title-class.js');
const {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL: OLLAMA_DEFAULT_MODEL,
  ollamaAvailable,
  ollamaChat
} = require('./lib/ollama.js');

const DATA_DIR = path.resolve(__dirname, '../data');
const RESUMES_DIR = path.join(DATA_DIR, 'resumes');
const MANIFEST_PATH = path.join(RESUMES_DIR, 'manifest.json');
const CACHE_PATH = path.join(RESUMES_DIR, '.extract-cache.json');
const OUT_PATH = path.join(DATA_DIR, 'profile.json');

const ANTHROPIC_MODEL = 'claude-opus-4-8';
const PROFILE_SCHEMA_VERSION = 2;
const RESUME_EXTENSIONS = ['.txt', '.md', '.pdf'];
const MIN_RESUME_CHARS = 200;
const MIN_INTENT_CHARS = 10;
// Local models default to 128 predicted tokens in some Ollama versions, which
// truncates a profile mid-JSON — give the structured output room to finish.
const OLLAMA_NUM_PREDICT = 8192;

const TITLE_CLASSES = Object.keys(CLASS_LABELS);

const STAGE_ORDER = ['student', 'recent_graduate', 'early_career', 'mid_career', 'senior'];

const VARIANT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'career_stage', 'years_experience', 'degrees', 'title_classes',
    'domains', 'skills', 'target_titles', 'notes_for_ranking'],
  properties: {
    summary: { type: 'string', description: 'Two sentences: who this person is professionally and what they are strongest at.' },
    career_stage: { type: 'string', enum: STAGE_ORDER },
    years_experience: { type: 'integer', description: 'Total years of relevant professional/research experience, internships count as fractional.' },
    degrees: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['level', 'field', 'status'],
        properties: {
          level: { type: 'string', enum: ['bachelors', 'masters', 'phd', 'md', 'other'] },
          field: { type: 'string' },
          status: { type: 'string', enum: ['completed', 'in_progress'] }
        }
      }
    },
    title_classes: {
      type: 'array',
      description: 'Job classes this resume variant targets, best fit first. Use ONLY the allowed values.',
      items: { type: 'string', enum: TITLE_CLASSES }
    },
    domains: {
      type: 'array',
      description: 'Research/professional domains, most central first (e.g. genomics, machine learning, health economics).',
      items: { type: 'string' }
    },
    skills: {
      type: 'array',
      description: 'Matchable skill terms for word-boundary text matching against job descriptions. Include tools, methods, languages. Each term must be a phrase that would literally appear in a job posting (no single letters; write "R programming" as the alias-bearing term "R," via aliases like "R,", never bare "r").',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['term', 'weight'],
        properties: {
          term: { type: 'string', description: 'Primary matchable phrase, lowercase, at least 2 characters.' },
          weight: { type: 'integer', description: '3 = core strength used extensively, 2 = solid working skill, 1 = familiar.' },
          aliases: { type: 'array', items: { type: 'string' }, description: 'Alternate spellings/phrasings that appear in postings (e.g. "scikit-learn" vs "sklearn").' }
        }
      }
    },
    target_titles: {
      type: 'array',
      description: 'Concrete job titles this variant would fit well, best first.',
      items: { type: 'string' }
    },
    avoid_signals: {
      type: 'array',
      description: 'Terms in a posting that indicate a poor fit (e.g. "registered nurse" for a computational person).',
      items: { type: 'string' }
    },
    notes_for_ranking: { type: 'string', description: 'Anything else a ranking system should know: constraints, preferences, unusual strengths.' }
  }
};

const SYSTEM_PROMPT = `You extract structured career profiles from resumes for a job-matching system aimed at international researchers seeking US cap-exempt employer positions (universities, research institutes, research hospitals).

The system will use your output for deterministic text matching against thousands of job postings, so precision in the skills list matters more than completeness: every term must be something that literally appears in job-posting text, matched with word boundaries. Weight skills by how central they are to this person's actual work, not by how often the word appears.

The candidate maintains several resume variants they wrote themselves, each tailored to a role type. You are extracting ONE variant; capture the emphasis of THIS variant rather than a generic average. Never invent skills or experience.

Be honest about career stage and degree status — the matcher penalizes jobs whose degree requirements the candidate cannot meet, and that protection only works if the profile is accurate.`;

/* ------------------------------------------------------------------------ */
/* Pure helpers (exported for tests)                                         */

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'variant';
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') return 'manifest is not an object';
  if (manifest.schema_version !== 1) return `manifest schema_version must be 1 (got ${manifest.schema_version})`;
  if (!Array.isArray(manifest.variants) || manifest.variants.length === 0) return 'manifest.variants must be a non-empty array';
  const seen = new Set();
  for (const [index, variant] of manifest.variants.entries()) {
    const where = `variants[${index}]`;
    if (!variant || typeof variant !== 'object') return `${where} is not an object`;
    if (!/^[a-z0-9][a-z0-9-]{0,23}$/.test(variant.id || '')) return `${where}.id must be a short lowercase slug (got "${variant.id}")`;
    if (seen.has(variant.id)) return `duplicate variant id "${variant.id}"`;
    seen.add(variant.id);
    if (!variant.label || typeof variant.label !== 'string') return `${where}.label is required`;
    if (!variant.file || typeof variant.file !== 'string') return `${where}.file is required`;
    const extension = path.extname(variant.file).toLowerCase();
    if (!RESUME_EXTENSIONS.includes(extension)) return `${where}.file must be one of ${RESUME_EXTENSIONS.join('/')} (got "${variant.file}")`;
    if (typeof variant.intent !== 'string' || variant.intent.trim().length < MIN_INTENT_CHARS) {
      return `${where} ("${variant.label}") needs an intent note of at least ${MIN_INTENT_CHARS} characters — one line on what this resume leads with`;
    }
  }
  return null;
}

// modelTag ("ollama:qwen2.5:7b-instruct" or "claude-opus-4-8") is part of the
// key so switching provider or model re-extracts rather than serving a stale
// profile made by a different model.
function variantCacheKey(text, variant, modelTag = ANTHROPIC_MODEL) {
  const material = JSON.stringify([PROFILE_SCHEMA_VERSION, modelTag, variant.label, variant.intent, text]);
  return crypto.createHash('sha256').update(material).digest('hex');
}

function sourceHash(text) {
  return `sha256:${crypto.createHash('sha256').update(text).digest('hex')}`;
}

// Guard the matcher: drop terms too short for word-boundary matching, clamp
// weights to 1..3, dedupe terms case-insensitively (first occurrence wins).
function normalizeVariantProfile(profile) {
  const seen = new Set();
  const skills = [];
  for (const skill of profile.skills || []) {
    const term = String(skill.term || '').trim().toLowerCase();
    if (term.length < 2 || seen.has(term)) continue;
    seen.add(term);
    const weight = Math.min(3, Math.max(1, Number(skill.weight) || 1));
    const aliases = [...new Set((skill.aliases || [])
      .map((alias) => String(alias || '').trim().toLowerCase())
      .filter((alias) => alias.length >= 2 && alias !== term))];
    skills.push({ term, weight, aliases });
  }
  return { ...profile, skills };
}

// Shared facts across variants: a tailored variant may omit a degree, but the
// degree gate must know the user's best credential. Union degrees (completed
// beats in_progress for the same level+field), take the most senior stage and
// the max years, union avoid signals.
function reconcileCore(variantProfiles) {
  const degrees = new Map();
  for (const profile of variantProfiles) {
    for (const degree of profile.degrees || []) {
      const key = `${degree.level}|${String(degree.field || '').trim().toLowerCase()}`;
      const existing = degrees.get(key);
      if (!existing) {
        degrees.set(key, { level: degree.level, field: degree.field, status: degree.status });
      } else if (existing.status === 'in_progress' && degree.status === 'completed') {
        existing.status = 'completed';
      }
    }
  }

  const stageIndexes = variantProfiles
    .map((profile) => STAGE_ORDER.indexOf(profile.career_stage))
    .filter((index) => index >= 0);
  const careerStage = stageIndexes.length ? STAGE_ORDER[Math.max(...stageIndexes)] : 'early_career';

  const avoid = new Map();
  for (const profile of variantProfiles) {
    for (const signal of profile.avoid_signals || []) {
      const trimmed = String(signal || '').trim();
      if (trimmed && !avoid.has(trimmed.toLowerCase())) avoid.set(trimmed.toLowerCase(), trimmed);
    }
  }

  const notes = [...new Set(variantProfiles
    .map((profile) => String(profile.notes_for_ranking || '').trim())
    .filter(Boolean))];

  const primary = variantProfiles[0] || {};
  return {
    summary: primary.summary || '',
    career_stage: careerStage,
    years_experience: Math.max(0, ...variantProfiles.map((profile) => Number(profile.years_experience) || 0)),
    degrees: [...degrees.values()],
    avoid_signals: [...avoid.values()],
    notes_for_ranking: notes.join(' | ')
  };
}

/* ------------------------------------------------------------------------ */
/* IO                                                                        */

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fsp.readFile(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function readResumeText(filePath) {
  if (path.extname(filePath).toLowerCase() === '.pdf') {
    let pdfParse;
    try {
      pdfParse = require('pdf-parse');
    } catch {
      console.error('PDF support needs the pdf-parse package (local-only, never used by CI):');
      console.error('  npm install');
      process.exit(1);
    }
    const parsed = await pdfParse(await fsp.readFile(filePath));
    return parsed.text || '';
  }
  return fsp.readFile(filePath, 'utf8');
}

async function scaffoldManifest() {
  await fsp.mkdir(RESUMES_DIR, { recursive: true });
  const entries = (await fsp.readdir(RESUMES_DIR))
    .filter((name) => !name.startsWith('.') && RESUME_EXTENSIONS.includes(path.extname(name).toLowerCase()))
    .sort();

  const used = new Set();
  const variants = entries.map((file) => {
    let id = slugify(file);
    while (used.has(id)) id = `${id.slice(0, 21)}-${used.size}`;
    used.add(id);
    return {
      id,
      label: path.basename(file, path.extname(file)).replace(/[-_]+/g, ' ').trim(),
      file,
      intent: ''
    };
  });

  await writeJson(MANIFEST_PATH, { schema_version: 1, variants });
  console.error(`Scaffolded ${path.relative(process.cwd(), MANIFEST_PATH)} with ${variants.length} variant(s).`);
  if (variants.length === 0) {
    console.error(`Drop your resume files (txt/md/pdf) into ${path.relative(process.cwd(), RESUMES_DIR)}/ and re-run.`);
  } else {
    console.error('Fill in each variant\'s "intent" (one line on what that resume leads with,');
    console.error('e.g. "Leads with production ML, PyTorch, MLOps") and re-run.');
  }
}

async function loadManifest() {
  const manifest = await readJson(MANIFEST_PATH, null);
  // Missing manifest, or an untouched empty scaffold (user dropped resume
  // files in after the first run): (re)scaffold from the directory listing.
  if (!manifest || (Array.isArray(manifest.variants) && manifest.variants.length === 0)) {
    await scaffoldManifest();
    process.exit(1);
  }
  const problem = validateManifest(manifest);
  if (problem) {
    console.error(`Invalid ${path.relative(process.cwd(), MANIFEST_PATH)}: ${problem}`);
    process.exit(1);
  }
  return manifest;
}

/* ------------------------------------------------------------------------ */
/* Extraction                                                                */

function variantUserPrompt(text, variant) {
  return `This resume is the candidate's "${variant.label}" variant. Their declared intent for it: "${variant.intent}". Extract skills, domains, and target titles as they present them in THIS variant.\n\n${text}`;
}

async function extractVariant(ctx, text, variant) {
  if (ctx.provider === 'anthropic') return extractVariantAnthropic(ctx, text, variant);
  return extractVariantOllama(ctx, text, variant);
}

async function extractVariantOllama(ctx, text, variant) {
  const parsed = await ollamaChat({
    baseUrl: ctx.baseUrl,
    model: ctx.model,
    system: SYSTEM_PROMPT,
    user: variantUserPrompt(text, variant),
    format: VARIANT_SCHEMA,
    options: { temperature: 0, num_predict: OLLAMA_NUM_PREDICT }
  });
  if (!parsed) {
    console.error(`The local model returned no usable JSON for "${variant.label}".`);
    console.error(`Try a larger model (e.g. --model qwen2.5:14b-instruct) or the hosted fallback (--provider anthropic).`);
    process.exit(1);
  }
  return normalizeVariantProfile(parsed);
}

async function extractVariantAnthropic(ctx, text, variant) {
  if (!ctx.anthropic) {
    // Lazy require keeps `npm test` and CI free of the SDK dependency.
    const Anthropic = require('@anthropic-ai/sdk');
    ctx.anthropic = { client: new Anthropic(), Anthropic };
  }
  const { client, Anthropic } = ctx.anthropic;
  let response;
  try {
    response = await client.messages.create({
      model: ctx.model,
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      system: SYSTEM_PROMPT,
      output_config: { format: { type: 'json_schema', schema: VARIANT_SCHEMA } },
      messages: [{ role: 'user', content: variantUserPrompt(text, variant) }]
    });
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) {
      console.error('No valid Anthropic credentials. Set ANTHROPIC_API_KEY and rerun:');
      console.error('  ANTHROPIC_API_KEY=sk-ant-... npm run radar:profile -- --provider anthropic');
      process.exit(1);
    }
    throw error;
  }

  if (response.stop_reason === 'refusal') {
    console.error(`Extraction for "${variant.label}" was declined. Check the resume content and retry.`);
    process.exit(1);
  }

  const textBlock = response.content.find((block) => block.type === 'text');
  return normalizeVariantProfile(JSON.parse(textBlock.text));
}

function parseArgs(argv) {
  const opts = { force: false, provider: 'ollama', model: null, positional: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--force') opts.force = true;
    else if (arg === '--provider') opts.provider = argv[++i];
    else if (arg === '--anthropic') opts.provider = 'anthropic';
    else if (arg === '--ollama') opts.provider = 'ollama';
    else if (arg === '--model') opts.model = argv[++i];
    else if (arg.startsWith('--')) { /* ignore unknown flags */ }
    else opts.positional.push(arg);
  }
  return opts;
}

/* ------------------------------------------------------------------------ */

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { force } = opts;

  if (opts.provider !== 'ollama' && opts.provider !== 'anthropic') {
    console.error(`Unknown --provider "${opts.provider}". Use ollama (default) or anthropic.`);
    process.exit(1);
  }

  const model = opts.provider === 'ollama'
    ? (opts.model || OLLAMA_DEFAULT_MODEL)
    : (opts.model || ANTHROPIC_MODEL);
  const modelTag = opts.provider === 'ollama' ? `ollama:${model}` : model;
  const ctx = { provider: opts.provider, model, baseUrl: DEFAULT_BASE_URL, anthropic: null, ollamaChecked: false };

  let manifest;
  let baseDir;
  if (opts.positional.length > 0) {
    // Legacy single-file mode: one variant named "default".
    const resumePath = path.resolve(opts.positional[0]);
    manifest = {
      schema_version: 1,
      variants: [{
        id: 'default',
        label: path.basename(resumePath, path.extname(resumePath)).replace(/[-_]+/g, ' ').trim() || 'General resume',
        file: path.basename(resumePath),
        intent: 'General resume'
      }]
    };
    baseDir = path.dirname(resumePath);
  } else {
    manifest = await loadManifest();
    baseDir = RESUMES_DIR;
  }

  const cache = await readJson(CACHE_PATH, { schema_version: 1, entries: {} });
  if (!cache.entries || typeof cache.entries !== 'object') cache.entries = {};

  const variants = [];
  let extractedCount = 0;
  let cachedCount = 0;

  for (const variant of manifest.variants) {
    const filePath = path.resolve(baseDir, variant.file);
    let text;
    try {
      text = await readResumeText(filePath);
    } catch (error) {
      console.error(`Cannot read ${variant.file} for variant "${variant.label}": ${error.message}`);
      process.exit(1);
    }
    if (text.trim().length < MIN_RESUME_CHARS) {
      console.error(`${variant.file} looks too short (${text.trim().length} chars) — is this the right file?`);
      process.exit(1);
    }

    const key = variantCacheKey(text, variant, modelTag);
    let entry = force ? null : cache.entries[key];
    if (entry) {
      cachedCount += 1;
    } else {
      // Check the local model is reachable only when we actually need it — an
      // all-cached run needs no model at all.
      if (ctx.provider === 'ollama' && !ctx.ollamaChecked) {
        if (!(await ollamaAvailable(ctx.baseUrl))) {
          console.error(`Ollama is not reachable at ${ctx.baseUrl}.`);
          console.error(`Install https://ollama.com, then: ollama pull ${ctx.model}`);
          console.error('Or use the hosted model: npm run radar:profile -- --provider anthropic');
          process.exit(1);
        }
        ctx.ollamaChecked = true;
      }
      console.log(`Extracting "${variant.label}" (${modelTag})…`);
      const profile = await extractVariant(ctx, text, variant);
      entry = { extracted_at: new Date().toISOString(), variant_profile: profile };
      cache.entries[key] = entry;
      await writeJson(CACHE_PATH, cache);
      extractedCount += 1;
    }

    variants.push({
      id: variant.id,
      label: variant.label,
      intent: variant.intent,
      source_file: variant.file,
      source_hash: sourceHash(text),
      extracted_at: entry.extracted_at,
      profile: entry.variant_profile
    });
  }

  const core = reconcileCore(variants.map((variant) => variant.profile));
  const output = {
    schema_version: PROFILE_SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    model: modelTag,
    core,
    variants: variants.map((variant) => ({
      id: variant.id,
      label: variant.label,
      intent: variant.intent,
      source_file: variant.source_file,
      source_hash: variant.source_hash,
      extracted_at: variant.extracted_at,
      title_classes: variant.profile.title_classes || [],
      domains: variant.profile.domains || [],
      skills: variant.profile.skills || [],
      target_titles: variant.profile.target_titles || []
    }))
  };

  await writeJson(OUT_PATH, output);

  console.log(`\nProfile written to ${path.relative(process.cwd(), OUT_PATH)} (gitignored — stays local)`);
  console.log(`  ${core.summary}`);
  const degreeSummary = core.degrees.map((degree) => `${degree.level}${degree.status === 'in_progress' ? ' (in progress)' : ''}`).join(', ') || 'none listed';
  console.log(`  core: ${core.career_stage} | ${core.years_experience} yrs | degrees: ${degreeSummary}`);
  for (const variant of output.variants) {
    console.log(`  ${variant.id.padEnd(10)} ${variant.label}: ${variant.skills.length} skill terms | classes: ${variant.title_classes.join(', ')}`);
  }
  console.log(`  variants: ${output.variants.length} (${extractedCount} extracted, ${cachedCount} cached)`);
  console.log('\nReload the dashboard — jobs now rank against your resume variants.');
}

module.exports = {
  TITLE_CLASSES,
  STAGE_ORDER,
  VARIANT_SCHEMA,
  PROFILE_SCHEMA_VERSION,
  slugify,
  validateManifest,
  variantCacheKey,
  sourceHash,
  normalizeVariantProfile,
  reconcileCore,
  variantUserPrompt,
  parseArgs
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
