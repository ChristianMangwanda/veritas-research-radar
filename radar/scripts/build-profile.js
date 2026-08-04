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
 * NOTE: the cache key does NOT include the prompt or the normalization rules,
 * so changes to either serve stale extractions until you re-run with --force.
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
const { execFileSync } = require('child_process');
const { CLASS_LABELS } = require('./lib/title-class.js');
const {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL: OLLAMA_DEFAULT_MODEL,
  ollamaAvailable,
  ollamaChat
} = require('./lib/ollama.js');

const { syncManifest, slugify } = require('./lib/manifest-sync.js');

const DATA_DIR = path.resolve(__dirname, '../data');
const RESUMES_DIR = path.join(DATA_DIR, 'resumes');
const MANIFEST_PATH = path.join(RESUMES_DIR, 'manifest.json');
const CACHE_PATH = path.join(RESUMES_DIR, '.extract-cache.json');
const OUT_PATH = path.join(DATA_DIR, 'profile.json');

const ANTHROPIC_MODEL = 'claude-opus-4-8';
const PROFILE_SCHEMA_VERSION = 2;
const RESUME_EXTENSIONS = ['.txt', '.md', '.pdf', '.docx'];
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
      description: 'Matchable skill terms for word-boundary text matching against job descriptions. Each term must be an ATOMIC, canonical technology/method/tool exactly as it appears in postings: prefer 1-2 words, lowercase, spaces (NEVER underscores — write "star schema", never "star_schema"). Decompose project descriptions into their underlying skills: "built an LLM-backed assistant" → "llm", "rag", "prompt engineering"; "iOS app on TestFlight" → "ios", "swift". Do NOT emit resume phrases like "llm-backed assistant feature" or "python programming" — emit "llm", "python". No single letters (write "R" via aliases like "r programming", never bare "r").',
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
    // Model output for this field is DISCARDED (see CROSS_PROFESSION_SIGNALS).
    // Kept in the schema so the model has somewhere to put the instinct
    // instead of smuggling it into skills.
    avoid_signals: {
      type: 'array',
      description: 'Terms whose presence in a JOB POSTING means it is for a different profession than this person practices (e.g. "registered nurse" for a computational person). Never list anything this person does or has done.',
      items: { type: 'string' }
    },
    notes_for_ranking: { type: 'string', description: 'Anything else a ranking system should know: constraints, preferences, unusual strengths.' }
  }
};

const SYSTEM_PROMPT = `You extract structured career profiles from resumes for a job-matching system aimed at international researchers seeking US cap-exempt employer positions (universities, research institutes, research hospitals).

The system will use your output for deterministic text matching against thousands of job postings, so precision in the skills list matters more than completeness: every term must be something that literally appears in job-posting text, matched with word boundaries. Weight skills by how central they are to this person's actual work, not by how often the word appears.

The candidate maintains several resume variants they wrote themselves, each tailored to a role type. You are extracting ONE variant; capture the emphasis of THIS variant rather than a generic average. Never invent skills or experience.

Weights must DISCRIMINATE — they are the whole point of the ranking. Reserve weight 3 for AT MOST the 4-6 skills this variant is genuinely built around (the ones in its summary and leading bullets). Use weight 2 for solid working skills, weight 1 for anything merely familiar or secondary. A profile where every skill is weight 3 is useless to the matcher; if you are marking more than ~6 as weight 3, you are not discriminating hard enough.

Be honest about career stage and degree status — the matcher penalizes jobs whose degree requirements the candidate cannot meet, and that protection only works if the profile is accurate.`;

/* ------------------------------------------------------------------------ */
/* Pure helpers (exported for tests)                                         */

// slugify now lives in lib/manifest-sync.js (shared with the auto-registration
// path); re-exported below so callers and tests keep one import site.

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
// Canonical, matchable single-token skills. When a compound term contains one of
// these as a whole word (e.g. "python programming" → python, "rag pipelines" →
// rag), we surface the bare token as an alias so it matches job text that names
// the technology plainly. An allowlist (not a generic word split) keeps this from
// emitting noisy aliases like "development"/"design" that would over-match.
const ATOMIC_SKILL_TOKENS = new Set([
  'python', 'java', 'javascript', 'typescript', 'scala', 'golang', 'rust',
  'pytorch', 'tensorflow', 'keras', 'sklearn', 'scikit-learn', 'pandas', 'numpy',
  'scipy', 'matplotlib', 'huggingface', 'transformers',
  'sql', 'nosql', 'spark', 'pyspark', 'hadoop', 'airflow', 'dbt', 'etl', 'elt',
  'kafka', 'snowflake', 'databricks', 'redshift', 'bigquery',
  'llm', 'llms', 'rag', 'nlp', 'cnn', 'cnns', 'genomics', 'bioinformatics',
  'docker', 'kubernetes', 'aws', 'gcp', 'azure', 'git', 'linux', 'bash',
  'postgresql', 'postgres', 'mysql', 'mongodb', 'redis',
  'tableau', 'sas', 'stata', 'matlab', 'ios', 'swift', 'android',
  'fastapi', 'flask', 'django', 'react', 'node'
]);

function atomicTokenAliases(term) {
  const out = new Set();
  const cleaned = term.replace(/[_/]+/g, ' ');
  if (ATOMIC_SKILL_TOKENS.has(cleaned.trim())) return [];
  for (const word of cleaned.split(/[\s,()]+/)) {
    const w = word.trim();
    if (w && ATOMIC_SKILL_TOKENS.has(w)) out.add(w);
  }
  return [...out];
}

// weights to 1..3, dedupe terms case-insensitively (first occurrence wins).
// Terms and aliases are normalized: underscores → spaces (the local model
// sometimes emits snake_case that would never match spaced job text), and
// canonical atomic tokens are recovered from compound terms as aliases.
function normalizeTerm(value) {
  return String(value || '').replace(/[_/]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

const MAX_TERM_WORDS = 3;
const MAX_TERM_CHARS = 32;
// Trimming must never end on a connective — "data ingestion and" matches
// nothing, where "data ingestion" matches the posting.
const TRAILING_STOPWORDS = new Set(['and', 'or', 'of', 'for', 'in', 'with', 'to', 'the', 'a', 'an', 'on', 'at', 'from', 'by', 'as', 'into']);

// The matchable concept ends at the first connective: "cnns for medical
// imaging" is about cnns, "etl and data validation pipelines" about etl.
// Cut there first, then cap the length.
function trimToMatchableHead(term) {
  const words = term.split(' ');
  const cut = words.findIndex((word, index) => index > 0 && (TRAILING_STOPWORDS.has(word) || word === '&'));
  const head = cut > 0 ? words.slice(0, cut) : words;
  return head.slice(0, MAX_TERM_WORDS).join(' ');
}

// Split "forecasting models (sarimax prophet)" into a matchable head plus the
// parenthetical tokens as full-weight aliases — the parenthesis is the resume
// author naming the concrete tools, which is exactly what postings say.
function splitParenthetical(raw) {
  const match = raw.match(/^([^(]+)\(([^)]*)\)\s*$/);
  if (match) {
    const head = normalizeTerm(match[1]);
    const extras = match[2].split(/[,;|]|\s{2,}/).map(normalizeTerm).filter((token) => token.length >= 2);
    if (head.length >= 2) return { head, extras };
  }
  // A comma list is the same shape without the parens: "aws sagemaker, lambda,
  // ec2" is one head plus concrete tools, not a four-word phrase.
  if (raw.includes(',')) {
    const [first, ...rest] = raw.split(',').map(normalizeTerm).filter((token) => token.length >= 2);
    if (first && rest.length) return { head: first, extras: rest };
  }
  return { head: raw, extras: [] };
}

function normalizeVariantProfile(profile, warn) {
  const seen = new Set();
  const skills = [];
  for (const skill of profile.skills || []) {
    const raw = normalizeTerm(skill.term);
    if (raw.length < 2) continue;
    const { head, extras } = splitParenthetical(raw);
    // A weight-3 slot holding a resume sentence ("llm-backed products") is the
    // most valuable weight attached to the least matchable string. Keep the
    // leading words — the head is what postings actually print.
    let term = head;
    if (head.split(' ').length > MAX_TERM_WORDS || head.length > MAX_TERM_CHARS) {
      term = trimToMatchableHead(head);
      if (warn && term !== raw) warn(`  trimmed unmatchable term: "${raw}" → "${term}"`);
    }
    if (term.length < 2 || seen.has(term)) continue;
    seen.add(term);
    const weight = Math.min(3, Math.max(1, Number(skill.weight) || 1));
    const aliases = [...new Set([
      ...(skill.aliases || []).map(normalizeTerm),
      ...extras
    ].filter((alias) => alias.length >= 2 && alias !== term))];
    // Recovered atomic tokens are BROAD: a bare "etl" should not earn what
    // "etl pipeline development" earns. scoring.js credits these at weight 1.
    const broadAliases = atomicTokenAliases(raw)
      .filter((alias) => alias !== term && !aliases.includes(alias));
    skills.push({ term, weight, aliases, broad_aliases: broadAliases });
  }
  const normalizeList = (list) => [...new Set((list || []).map(normalizeTerm).filter((item) => item.length >= 2))];
  const domains = normalizeList(profile.domains);
  const targetTitles = normalizeList(profile.target_titles);
  // Self-penalty guard. Asked for "terms that signal a poor fit", models reach
  // for the resume itself and return the person's own experience — one run
  // offered "machine learning", which would have docked every ML job. An avoid
  // signal that overlaps this person's own skills/domains/titles is never
  // trustworthy, whatever the prompt says.
  const own = new Set([
    ...skills.flatMap((skill) => [skill.term, ...skill.aliases, ...skill.broad_aliases]),
    ...domains,
    ...targetTitles
  ]);
  const avoidSignals = normalizeList(profile.avoid_signals).filter((signal) => {
    const collides = own.has(signal) || [...own].some((term) => term.length >= 4 && signal.includes(term));
    if (collides && warn) warn(`  dropped self-referential avoid signal: "${signal}"`);
    return !collides;
  });
  return {
    ...profile,
    skills,
    // Enum values, so dedupe without text normalization (order is meaningful:
    // index 0 is the variant's primary class).
    title_classes: [...new Set(profile.title_classes || [])],
    domains,
    target_titles: targetTitles,
    avoid_signals: avoidSignals
  };
}

// Postings for a plainly different profession. Deliberately narrow: each term
// must be one that a computational person's posting would never contain, since
// a hit costs the job real points. Licence and clearance requirements are the
// eligibility layer's job — this is only about "wrong profession entirely".
const CROSS_PROFESSION_SIGNALS = [
  'registered nurse', 'licensed practical nurse', 'phlebotomy', 'phlebotomist',
  'sonographer', 'radiologic technologist', 'respiratory therapist',
  'occupational therapist', 'physical therapist', 'dental hygienist',
  'cdl license', 'commercial driver', 'food service', 'custodial',
  'groundskeeper', 'security officer', 'police officer', 'firefighter',
  'cosmetology', 'hvac technician', 'electrician', 'plumber', 'welder'
];
const COMPUTATIONAL_CLASSES = new Set(['data_computational', 'engineering_software']);

// Shared facts across variants: a tailored variant may omit a degree, but the
// degree gate must know the user's best credential. Union degrees (completed
// beats in_progress for the same level+field), take the most senior stage and
// the max years.
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

  // Model-generated avoid signals are DISCARDED. Asked which posting terms
  // signal a poor fit, every run returned the person's own history ("research
  // assistant", "graduate teaching assistant", once even "machine learning") —
  // penalties on jobs they could plausibly get. Which professions are somebody
  // else's is fixed knowledge, not something to re-extract per resume, so it
  // comes from a curated list gated on the person's own title classes.
  const avoid = new Map();
  const computational = variantProfiles.some((profile) => (profile.title_classes || [])
    .some((cls) => COMPUTATIONAL_CLASSES.has(cls)));
  if (computational) {
    for (const signal of CROSS_PROFESSION_SIGNALS) avoid.set(signal, signal);
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

// A .docx is a zip; the body lives in word/document.xml as WordprocessingML.
// Turn the paragraph/break/tab markup into plain text (extraction only — nothing
// here rewrites resume content). Zero runtime deps: unzip the one member we need.
function docxXmlToText(xml) {
  return xml
    .replace(/<w:tab\b[^>]*\/?>/g, '\t')
    .replace(/<w:br\b[^>]*\/?>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function readResumeText(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.pdf') {
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
  if (ext === '.docx') {
    let xml;
    try {
      // `unzip -p` streams one member to stdout; ships with macOS + Linux CI.
      xml = execFileSync('unzip', ['-p', filePath, 'word/document.xml'], {
        maxBuffer: 32 * 1024 * 1024
      }).toString('utf8');
    } catch {
      console.error(`DOCX support needs the \`unzip\` CLI (local-only, never used by CI): ${path.basename(filePath)}`);
      console.error('  install unzip, or re-export this resume as PDF/TXT into the resumes folder.');
      process.exit(1);
    }
    return docxXmlToText(xml);
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

// One line telling the extractor how to read an otherwise ambiguous resume.
// It's the only thing the file itself can't supply, so when a resume arrives
// unannounced we ask the model to write it rather than dropping the file or
// blocking on a hand-edit. Marked intent_source:'auto' so the dashboard can
// show it as a draft worth overriding.
const INTENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['intent'],
  properties: {
    intent: {
      type: 'string',
      description: 'One sentence, under 30 words: what this resume variant leads with and the kind of role it targets. Write it as the candidate would ("Data engineer building Python/SQL pipelines end to end").'
    }
  }
};

async function inferIntent(ctx, text, label) {
  if (ctx.provider !== 'ollama') return null; // hosted path: keep it cheap, fall back to the label
  try {
    if (!ctx.ollamaChecked) {
      if (!(await ollamaAvailable(ctx.baseUrl))) return null;
      ctx.ollamaChecked = true;
    }
    const parsed = await ollamaChat({
      baseUrl: ctx.baseUrl,
      model: ctx.model,
      system: 'You summarize a resume in one line for a job-matching system. Be concrete and specific to THIS resume; never invent experience.',
      user: `Resume filename hints the variant is "${label}". Write its one-line intent.\n\n${text.slice(0, 4000)}`,
      format: INTENT_SCHEMA,
      options: { temperature: 0, num_predict: 256 }
    });
    const intent = parsed && typeof parsed.intent === 'string' ? parsed.intent.trim() : '';
    return intent.length >= MIN_INTENT_CHARS ? intent : null;
  } catch {
    return null; // never block a build on the nicety
  }
}

async function loadManifest() {
  const stored = await readJson(MANIFEST_PATH, null);
  let files = [];
  try {
    files = await fsp.readdir(RESUMES_DIR);
  } catch { /* dir missing -> scaffold path below */ }

  // Reconcile with what's actually on disk BEFORE validating: a resume you
  // dropped in is a variant you want ranked, not an error and never a silent
  // no-op.
  const { manifest, added, missing } = syncManifest(stored, files);

  if (manifest.variants.length === 0) {
    await scaffoldManifest();
    process.exit(1);
  }

  if (added.length) {
    console.log(`Found ${added.length} new resume file(s) — registering: ${added.map((v) => v.file).join(', ')}`);
  }
  for (const variant of missing) {
    console.error(`Warning: ${variant.file} ("${variant.label}") is in the manifest but not on disk — skipping it this build.`);
  }
  return { manifest, added, missing, storedWasValid: Boolean(stored) };
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
  return normalizeVariantProfile(parsed, (message) => console.log(message));
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
  return normalizeVariantProfile(JSON.parse(textBlock.text), (message) => console.log(message));
}

function parseArgs(argv) {
  const opts = { force: false, ifStale: false, provider: 'ollama', model: null, positional: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--force') opts.force = true;
    else if (arg === '--if-stale') opts.ifStale = true;
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

  // --if-stale: the automation entrypoint (server watcher, digest run). A
  // fresh profile makes this a silent no-op so callers can fire it blindly.
  if (opts.ifStale && opts.positional.length === 0) {
    const { profileFreshness } = require('./lib/profile-freshness.js');
    const freshness = profileFreshness(RESUMES_DIR, OUT_PATH);
    if (!freshness.stale) {
      console.log(`Profile is up to date with the resumes (${freshness.reason}) — nothing to do.`);
      return;
    }
    console.log(`Profile is stale (${freshness.reason}) — rebuilding…`);
  }

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
  let added = [];
  let missing = [];
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
    ({ manifest, added, missing } = await loadManifest());
    baseDir = RESUMES_DIR;
  }

  // Give every auto-registered variant an intent before validation: ask the
  // model to read the resume, fall back to the filename-derived label. The
  // manifest is the user's file, so this is written back once and then left
  // alone — later builds see a normal hand-editable entry.
  for (const variant of added) {
    let text = null;
    try {
      text = await readResumeText(path.resolve(baseDir, variant.file));
    } catch { /* handled in the main loop */ }
    const inferred = text ? await inferIntent(ctx, text, variant.label) : null;
    variant.intent = inferred || `${variant.label} resume`;
    variant.intent_source = inferred ? 'auto' : 'filename';
    console.log(`  ${variant.file} -> "${variant.label}": ${variant.intent}`);
  }
  if (added.length && opts.positional.length === 0) {
    await writeJson(MANIFEST_PATH, manifest);
    console.log(`Updated ${path.relative(process.cwd(), MANIFEST_PATH)} — edit any auto-written intent in the dashboard's Resumes panel.`);
  }

  const problem = validateManifest(manifest);
  if (problem) {
    console.error(`Invalid ${path.relative(process.cwd(), MANIFEST_PATH)}: ${problem}`);
    process.exit(1);
  }

  const cache = await readJson(CACHE_PATH, { schema_version: 1, entries: {} });
  if (!cache.entries || typeof cache.entries !== 'object') cache.entries = {};

  const variants = [];
  let extractedCount = 0;
  let cachedCount = 0;
  const missingFiles = new Set(missing.map((variant) => variant.file));

  for (const variant of manifest.variants) {
    // A moved or renamed file costs one variant, not the whole profile.
    if (missingFiles.has(variant.file)) continue;
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

  if (variants.length === 0) {
    console.error('No readable resume files — nothing to build. Check radar/data/resumes/.');
    process.exit(1);
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
  MIN_INTENT_CHARS,
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
