'use strict';

/**
 * The judged match: a local model actually READS a posting against the
 * user's resumes and stated preferences.
 *
 * Why this exists: the deterministic fit score is keyword overlap wearing a
 * percentage sign. Measured on the live dataset, 8,942 of 12,440 active jobs
 * score 0-4 out of 100 and only 12 clear 50 — so the number is a compressed
 * long tail printed at a precision the math cannot support, and the gap
 * between a 51 and a 54 is noise.
 *
 * The split that fixes it:
 *   stage 1  deterministic, cheap, high recall — narrow thousands to hundreds
 *            (isQualified: open, in-track, no quoted barrier). Keeps its job.
 *   stage 2  this module — the model reads the survivors and returns a
 *            verdict WITH its reasons, so the answer can be checked rather
 *            than trusted.
 *
 * Stage 1 still decides what is even considered, so it must stay generous:
 * a judged "no" is recoverable (you can read the reason and disagree); a job
 * stage 1 never surfaced is invisible forever.
 */

const MATCH_SCHEMA_VERSION = 1;

const VERDICTS = ['strong', 'possible', 'stretch', 'no'];

const VERDICT_LABELS = {
  strong: 'Strong match',
  possible: 'Worth a look',
  stretch: 'Stretch',
  no: 'Not for you'
};

const VERDICT_RANK = { strong: 0, possible: 1, stretch: 2, no: 3 };

/* FIELD ORDER IS LOad-BEARING.
 *
 * Constrained decoding fills these in the order declared, so whatever comes
 * first is written before the model has reasoned about anything. With
 * `verdict` first, every job came back "strong" — including a Nurse
 * Practitioner posting whose own headline read "Not a match, irrelevant
 * field". The prose was right and the label was garbage.
 *
 * So the evidence is written first and the verdict LAST, derived from it.
 * Do not reorder these properties.
 *
 * The word limits are a speed budget too: 14b generates ~11 tok/s on an M4,
 * so every field is latency the user waits through. */
const JUDGMENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['role_summary', 'different_profession', 'meets_requirements',
    'matches_preferences', 'reasons', 'gaps'],
  properties: {
    role_summary: {
      type: 'string',
      description: 'MAX 12 WORDS. What this job actually is, in plain terms — the profession and the level. Write this FIRST and judge honestly, e.g. "Bedside nurse practitioner role, clinical not computational".'
    },
    // Three booleans instead of one enum. Under constrained decoding a 4-way
    // enum landed on "strong" for everything — including postings the model
    // itself described as "Not for you". Yes/no questions decode reliably,
    // so the model answers those and `deriveVerdict` does the aggregation in
    // code where it can be read and tested.
    different_profession: {
      type: 'boolean',
      description: 'true if this is a DIFFERENT PROFESSION than a data/ML/computational-research person practices — nursing, bedside clinical care, teaching faculty, administration, facilities, trades — or requires a licence they cannot hold (RN, MD, PE). false for data, research, analytics, engineering or computational work.'
    },
    meets_requirements: {
      type: 'boolean',
      description: 'true only if the candidate meets the posting\'s STATED hard requirements — degree level, required years of experience, required certifications. false if the posting demands a PhD they lack, or clearly more years than they have.'
    },
    matches_preferences: {
      type: 'boolean',
      description: 'true if this job fits WHAT THEY SAID THEY WANT (role type, domain, location, remote, salary floor) and breaks none of their deal-breakers. false if it conflicts with a stated preference.'
    },
    reasons: {
      type: 'array',
      maxItems: 2,
      description: 'AT MOST 2, EACH UNDER 10 WORDS. Concrete overlap only: name the skill or requirement. "Posting wants PyTorch + SQL; both core strengths". Empty array if there is genuinely no overlap. Never write filler like "aligns well with".',
      items: { type: 'string' }
    },
    gaps: {
      type: 'array',
      maxItems: 2,
      description: 'AT MOST 2, EACH UNDER 10 WORDS. Name the missing thing only: "Wants Tableau; candidate has Power BI". "Requires PhD; candidate has masters in progress". Empty array if none.',
      items: { type: 'string' }
    }
    /* There was a `resume_id` here: the model picked which résumé variant to
     * send. It is gone. Choosing what to send is a decision made once, by a
     * person who has read the posting — not something worth carrying seven
     * résumé summaries in every prompt to answer, and not something a model
     * should get wrong silently. */
  }
};

// The aggregation the model kept getting wrong, as plain readable code.
function deriveVerdict({ different_profession: differentProfession, meets_requirements: meets, matches_preferences: wants }) {
  if (differentProfession) return 'no';
  if (!meets) return 'stretch';
  return wants ? 'strong' : 'possible';
}

const JUDGE_SYSTEM_PROMPT = `You advise an international early-career researcher on US jobs at visa-sponsoring institutions. You read one posting against their resumes and their stated preferences, then judge honestly.

Be decisive and specific. "Strong match" means you would tell them to apply today. "Not for you" means a different profession, or it breaks a preference they explicitly stated — not merely that it is competitive.

Rules that matter more than the rest:
1. Judge on what the POSTING actually asks for, not on job-title vibes. Quote-worthy specifics only; never invent a requirement the posting does not state.
2. A stated deal-breaker is decisive. A missing nice-to-have is not.
3. MOST POSTINGS ARE NOT A MATCH, and saying so is the useful answer. A clinical, nursing, teaching, administrative or facilities role is "no" for a computational candidate no matter how many words overlap. A role requiring a credential they do not hold (PhD, MD, RN licence, professional certification) is "no" or at best "stretch" — never "strong".
4. Seniority counts. A posting wanting 8+ years or "Senior/Principal/Director" is a stretch for someone with 3 years.

Judge the work itself: can they do it, and would they want it.

Write TERSELY. Every field has a hard word limit and you must respect it. Fragments, not sentences. Never write "aligns well with", "is a good fit for", or any phrase that could apply to any candidate.`;

// Compact brief: who the candidate is and which resumes they have. Rides in
// every judgment prompt, so it stays short — labels, intents, and the top
// skill terms rather than the whole profile.
function candidateBrief(profile, preferencesText) {
  if (!profile) return '';

  /* When the profile came from a document, that document IS the brief. It was
   * written to be read by this prompt, it says what the person wants in their
   * own words, and passing it through verbatim means editing the file changes
   * the judging with nothing in between to reinterpret it.
   *
   * The old assembled brief listed seven résumé variants with twelve skills
   * each — 737 tokens, most of it the same skills repeated, carried on every
   * posting purely so the model could answer which résumé to send. It no
   * longer answers that. */
  if (profile.prose && profile.prose.trim()) return profile.prose.trim();

  // Fallback for a legacy profile.json, so an old checkout still judges.
  const core = profile.core || {};
  const degrees = (core.degrees || [])
    .map((degree) => `${degree.level}${degree.status === 'in_progress' ? ' (in progress)' : ''}`)
    .join(', ');
  const lines = [`CANDIDATE: ${core.summary || 'early-career researcher'}`];
  if (degrees) lines.push(`Degrees: ${degrees}`);
  if (Number.isFinite(core.years_experience)) lines.push(`Experience: ${core.years_experience} years`);
  const skills = (profile.variants || [])
    .flatMap((variant) => (variant.skills || []).map((skill) => skill.term));
  if (skills.length) lines.push(`Strengths: ${[...new Set(skills)].slice(0, 40).join(', ')}`);
  if (preferencesText && preferencesText.trim()) lines.push('', 'WHAT THEY WANT:', preferencesText.trim());
  return lines.join('\n');
}

// Requirements live near the top of a posting; the tail is boilerplate (EEO
// statements, benefits). Trimming here cuts prefill time on every judgment.
const DESCRIPTION_LIMIT = 3000;

/* Legal and HR boilerplate the judge never uses. On this dataset it is a
 * fifth to a quarter of a posting — equal-opportunity statements, search-firm
 * warnings, accommodation notices, pay-transparency blurbs, the "Personnel
 * area / FLSA status" footer universities append.
 *
 * Cutting it is strictly better than lowering DESCRIPTION_LIMIT, which was the
 * obvious alternative: a blind truncation can land in the middle of the
 * requirements and make the model judge on half a posting, whereas everything
 * below these markers is the same text on every posting from that employer. */
const BOILERPLATE_MARKERS = [
  /\bequal (?:opportunity|employment opportunity)\b/i,
  /\baffirmative action\b/i,
  /\bno search firms\b/i,
  /\bdoes not accept unsolicited\b/i,
  /\breasonable accommodation/i,
  /\bAmericans with Disabilities Act\b/i,
  /\bE-Verify\b/i,
  /\bbackground (?:check|investigation)\b/i,
  /\bdrug (?:screen|test)/i,
  /\bexplore our (?:exceptional )?benefits\b/i,
  /\bpay transparency\b/i,
  /\bFLSA Status:/i,
  /\bPersonnel area:/i
];

// Only cut past the halfway mark: a short posting can open with "we are an
// equal opportunity employer", and beheading it there would leave nothing to
// judge on.
function stripBoilerplate(text) {
  const floor = Math.floor(text.length * 0.5);
  let cut = text.length;
  for (const marker of BOILERPLATE_MARKERS) {
    const found = text.slice(floor).search(marker);
    if (found >= 0) cut = Math.min(cut, floor + found);
  }
  if (cut >= text.length) return text.trimEnd();
  // Back up to the start of the sentence the marker sits in, so the cut does
  // not leave a dangling "The University is an" on the end.
  const boundary = Math.max(text.lastIndexOf('.', cut), text.lastIndexOf('\n', cut));
  return text.slice(0, boundary > floor ? boundary + 1 : cut).trimEnd();
}

function jobBrief(job) {
  const bits = [`POSTING: ${job.title}`, `Employer: ${job.employer_name}`];
  if (job.location) bits.push(`Location: ${job.location}${job.remote ? ' (remote available)' : ''}`);
  if (job.salary_min || job.salary_max) {
    const range = [job.salary_min, job.salary_max].filter(Boolean).map((n) => `$${Math.round(n / 1000)}K`).join('–');
    bits.push(`Salary: ${range}`);
  }
  if (job.department) bits.push(`Department: ${job.department}`);
  const description = stripBoilerplate(String(job.description_text || '')).slice(0, DESCRIPTION_LIMIT);
  return `${bits.join('\n')}\n\n${description}`;
}

function judgeUserPrompt(job, profile, preferencesText) {
  return `${candidateBrief(profile, preferencesText)}\n\n---\n\n${jobBrief(job)}\n\n---\n\nJudge this posting for this candidate.`;
}

// Cache identity: the posting's content, the profile it was judged against,
// and the preferences in force. Any of the three changing means the old
// answer no longer describes reality.
function matchCacheKey(jobHash, profileHash, preferencesHash) {
  return `${MATCH_SCHEMA_VERSION}:${jobHash}:${profileHash || 'noprofile'}:${preferencesHash || 'noprefs'}`;
}

// Never trust raw model output: anything malformed must degrade to something
// displayable rather than corrupt the list.
function normalizeJudgment(raw) {
  if (!raw || typeof raw !== 'object') return null;
  // Booleans must be explicit: a missing field means the model didn't answer,
  // and defaulting a silent "meets_requirements" to true would manufacture
  // strong matches out of nothing.
  if (typeof raw.different_profession !== 'boolean'
    || typeof raw.meets_requirements !== 'boolean'
    || typeof raw.matches_preferences !== 'boolean') return null;

  const line = (value) => String(value || '').trim().replace(/\s+/g, ' ').slice(0, 110);
  const list = (value) => (Array.isArray(value) ? value.map(line).filter(Boolean).slice(0, 2) : []);
  return {
    verdict: deriveVerdict(raw),
    different_profession: raw.different_profession,
    meets_requirements: raw.meets_requirements,
    matches_preferences: raw.matches_preferences,
    role_summary: line(raw.role_summary),
    reasons: list(raw.reasons),
    gaps: list(raw.gaps)
  };
}

// Judged verdict first, deterministic fit only as a tie-break inside a tier.
function compareJudged(a, b) {
  const rankA = a.match ? VERDICT_RANK[a.match.verdict] : 99;
  const rankB = b.match ? VERDICT_RANK[b.match.verdict] : 99;
  if (rankA !== rankB) return rankA - rankB;
  return (b.fit?.fit_score || 0) - (a.fit?.fit_score || 0);
}

module.exports = {
  MATCH_SCHEMA_VERSION,
  VERDICTS,
  VERDICT_LABELS,
  VERDICT_RANK,
  JUDGMENT_SCHEMA,
  JUDGE_SYSTEM_PROMPT,
  DESCRIPTION_LIMIT,
  stripBoilerplate,
  deriveVerdict,
  candidateBrief,
  jobBrief,
  judgeUserPrompt,
  matchCacheKey,
  normalizeJudgment,
  compareJudged
};
