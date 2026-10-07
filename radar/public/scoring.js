/**
 * Resume-variant scoring engine — shared by the dashboard (script tag, no
 * build step) and node scripts/tests (require()), same pattern as
 * scripts/keywords.js.
 *
 * Input: profile.json v2 (the user's own resume variants, each with label,
 * declared intent, and extracted matchable terms) plus the jobs array.
 * Everything here is deterministic: word-boundary term matching over
 * title + department + description_text, title-class alignment, a degree
 * gate parsed from posting text, and employer sponsorship evidence as a
 * tiebreak. An optional route cache (local Ollama verdicts) can override
 * which variant is recommended for jobs the deterministic scores left
 * ambiguous — it never changes the fit score itself.
 *
 * Reachability DEMOTES and FLAGS, it never hides: scoring only writes
 * job.fit; no filter anywhere consults it to drop rows.
 */

(function () {
  'use strict';

  const root = typeof window !== 'undefined' ? window : globalThis;

  const WEIGHTS = {
    SKILL_POINTS: { 3: 6, 2: 3, 1: 1 },
    SKILL_CAP: 40,
    TITLE_CLASS_PRIMARY: 15,
    TITLE_CLASS_SECONDARY: 8,
    DOMAIN_POINTS: 5,
    DOMAIN_CAP: 15,
    TARGET_TITLE: 10,
    RESEARCH_FACTOR: 0.10,
    EVIDENCE_BONUS: [[10, 10], [3, 6], [1, 3]],
    DEGREE_GATE_HARD: -25,
    DEGREE_GATE_IN_PROGRESS: -12,
    DEGREE_GATE_SOFT: -8,
    CITIZENSHIP_GATE: -30,
    RESTRICTED_LANGUAGE: -15,
    AVOID_SIGNAL: -8,
    AVOID_CAP: -16,
    STAGE_MISMATCH: -10,
    AMBIGUITY_MARGIN: 8,
    AMBIGUITY_FLOOR: 15,
    // Skill/domain matching stops after this many collapsed chars: a 6000-word
    // boilerplate posting should not out-score a terse well-fitting one just by
    // listing more technology names. Gates and avoid signals still scan the
    // full corpus — requirements and red flags often live deep in the text.
    SKILL_MATCH_WINDOW: 4000,
    THIN_TEXT_CHARS: 500,
    // A posting whose lowest stated experience bar is above this is blocked.
    // The owner's call (2026-10-06): 4+ years is out of reach, cut it.
    MAX_REQUIRED_YEARS: 3
  };
  // Pre-penalty ceiling of one variant's score — the denominator for any UI
  // that renders variant scores as bars or heat (fit_score is post-penalty
  // and lives on a different scale).
  WEIGHTS.VARIANT_SCORE_MAX = WEIGHTS.SKILL_CAP + WEIGHTS.TITLE_CLASS_PRIMARY
    + WEIGHTS.DOMAIN_CAP + WEIGHTS.TARGET_TITLE;

  // Re-verified 2026-08-04 against the repaired matcher (fit-audit --histogram,
  // 12,440 active jobs): strong 11 · good 34 · moderate 180 · weak 554. The
  // repairs lifted the middle (live domains, plural/hyphen forms) without
  // moving the shape, and the floors still sit on the histogram's natural
  // breaks, so they stand. Tunable — each is a single floor.
  const VERDICT_TIERS = [['strong', 50], ['good', 38], ['moderate', 27], ['weak', 16], ['stretch', 0]];

  // Heat bands for PRE-penalty variant scores (0..VARIANT_SCORE_MAX). Distinct
  // from VERDICT_TIERS, which are calibrated for post-penalty fit_score —
  // feeding variant scores into those thresholds washed every cell pale.
  const VARIANT_HEAT_BANDS = [['h4', 45], ['h3', 34], ['h2', 24], ['h1', 13], ['h0', 0]];

  const DEGREE_RANK = { other: 0, bachelors: 1, masters: 2, phd: 3, md: 3 };

  const EARLY_STAGES = new Set(['student', 'recent_graduate', 'early_career']);
  const SENIOR_TITLE = /\b(senior|staff|principal|lead|director|head|chief)\b/i;

  /* ---------------------------------------------------------------------- */
  /* Text helpers                                                            */

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // \b breaks on terms with non-word edges ("c++", ".net"): a trailing \b
  // after "+" would demand a word character next. Anchor only word-char edges.
  function boundaryPattern(term) {
    const lead = /^[a-z0-9_]/i.test(term) ? '\\b' : '';
    const tail = /[a-z0-9_]$/i.test(term) ? '\\b' : '';
    return `${lead}${escapeRegExp(term)}${tail}`;
  }

  function collapseWhitespace(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  // Underscores and slashes in profile lists ("machine_learning", "AI/ML")
  // can never match prose; normalize them to spaces before registration.
  function normalizePhrase(value) {
    return collapseWhitespace(String(value || '').replace(/[_/]+/g, ' ')).toLowerCase();
  }

  // Finite surface-form enumeration instead of fuzzy matching: the scan
  // resolves match[0] through phraseEntries by exact text, so every matchable
  // spelling must be its own key. Hyphen and space are interchangeable between
  // words; a trailing plural on the last word maps both ways ("etl pipelines"
  // matches "ETL pipeline" and vice versa). Extra keys that never occur in
  // text are harmless — only wrong matches would hurt, hence length guards.
  function surfaceForms(phrase) {
    const forms = new Set([phrase]);
    if (phrase.includes('-')) forms.add(phrase.replace(/-/g, ' '));
    if (phrase.includes(' ')) forms.add(phrase.replace(/ /g, '-'));
    for (const form of [...forms]) {
      const words = form.split(/[ -]/);
      const last = words[words.length - 1];
      if (last.length >= 4 && !last.endsWith('s')) forms.add(`${form}s`);
      if (last.length >= 5 && last.endsWith('s') && !last.endsWith('ss')) forms.add(form.slice(0, -1));
    }
    return [...forms];
  }

  /* ---------------------------------------------------------------------- */
  /* Profile validation + hashing                                            */

  function validateProfile(value) {
    if (!value || typeof value !== 'object') return 'profile is not an object';
    if (value.schema_version !== 2) return `expected schema_version 2 (got ${value.schema_version}) — check the profile document's frontmatter`;
    if (!value.core || typeof value.core !== 'object') return 'profile.core missing';
    if (!Array.isArray(value.variants) || value.variants.length === 0) return 'profile.variants must be a non-empty array';
    const ids = new Set();
    for (const [index, variant] of value.variants.entries()) {
      const where = `variants[${index}]`;
      if (!variant || typeof variant !== 'object') return `${where} is not an object`;
      if (!variant.id || typeof variant.id !== 'string') return `${where}.id missing`;
      if (ids.has(variant.id)) return `duplicate variant id "${variant.id}"`;
      ids.add(variant.id);
      if (!variant.label || typeof variant.label !== 'string') return `${where}.label missing`;
      if (!Array.isArray(variant.skills)) return `${where}.skills must be an array`;
      for (const skill of variant.skills) {
        if (!skill || typeof skill.term !== 'string' || skill.term.length < 2) return `${where} has a skill term shorter than 2 characters`;
        if (typeof skill.weight !== 'number') return `${where} has a skill without a numeric weight`;
        if (skill.broad_aliases !== undefined && !isStringArray(skill.broad_aliases)) {
          return `${where} has a skill with non-string broad_aliases`;
        }
      }
      // Type checks only. Duplicates are deduped at compile time rather than
      // rejected — a repeated title class is harmless, and refusing the whole
      // profile over one would strand an otherwise usable import.
      for (const listName of ['title_classes', 'domains', 'target_titles']) {
        const list = variant[listName];
        if (list === undefined) continue;
        if (!isStringArray(list)) return `${where}.${listName} must be an array of strings`;
      }
    }
    return null;
  }

  function isStringArray(value) {
    return Array.isArray(value) && value.every((item) => typeof item === 'string');
  }

  // FNV-1a 32-bit over a canonical serialization — stable across JSON key
  // order and available in both environments (no crypto dependency). Keys the
  // route cache: a verdict decided against one profile must not survive edits.
  function profileHash(profile) {
    const canonical = JSON.stringify([profile.schema_version, (profile.variants || []).map((variant) => [
      variant.id,
      variant.label,
      variant.intent || '',
      (variant.skills || []).map((skill) => [skill.term, skill.weight, (skill.aliases || []).slice().sort()]),
      (variant.title_classes || []).slice(),
      (variant.domains || []).slice(),
      (variant.target_titles || []).slice()
    ])]);
    return fnv1a(canonical);
  }

  // The house content hash: sync, dual-env, no crypto dependency. Also keys
  // the classify cache (browser sha256 is async-only, unusable at load time).
  function fnv1a(str) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i += 1) {
      hash ^= str.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return `fnv1a:${(hash >>> 0).toString(16).padStart(8, '0')}`;
  }

  /* ---------------------------------------------------------------------- */
  /* Compilation: profile -> precompiled regex banks (once per profile load)  */

  function compileProfile(profileFile) {
    const problem = validateProfile(profileFile);
    if (problem) return null;

    const variants = profileFile.variants.map((variant, order) => {
      // One combined scan per variant: every matchable phrase (skill terms,
      // aliases, domains) goes into a single alternation; the lookup map
      // carries what a phrase means. A phrase can be both a skill alias and
      // a domain, so entries hold both roles. Corpus and phrases are both
      // lowercased, so no 'i' flag — case-insensitive alternations are slower.
      const phraseEntries = new Map();
      const entryFor = (lower) => {
        let entry = phraseEntries.get(lower);
        if (!entry) {
          entry = { skill: null, domain: null };
          phraseEntries.set(lower, entry);
        }
        return entry;
      };
      const registerSkill = (phrase, term, weight) => {
        const lower = normalizePhrase(phrase);
        if (lower.length < 2) return;
        for (const form of surfaceForms(lower)) {
          const entry = entryFor(form);
          if (!entry.skill) entry.skill = { term, weight };
        }
      };
      for (const skill of variant.skills) {
        const weight = Math.min(3, Math.max(1, Math.round(skill.weight)));
        for (const phrase of [skill.term, ...(skill.aliases || [])]) {
          registerSkill(phrase, skill.term, weight);
        }
      }
      // Broad aliases (auto-recovered atomic tokens like bare "etl") credit
      // the parent term at weight 1: a lone generic word should not earn a
      // compound skill's full points. Second pass so that ANY skill's
      // full-weight phrase beats any skill's broad alias for the same text.
      for (const skill of variant.skills) {
        for (const phrase of skill.broad_aliases || []) {
          registerSkill(phrase, skill.term, 1);
        }
      }
      for (const domain of variant.domains || []) {
        const lower = normalizePhrase(domain);
        if (lower.length < 2) continue;
        for (const form of surfaceForms(lower)) {
          const entry = entryFor(form);
          if (!entry.domain) entry.domain = lower;
        }
      }
      const alternates = [...phraseEntries.keys()]
        .sort((a, b) => b.length - a.length) // longest first: alternation is leftmost-first
        .map(boundaryPattern);
      const targetTitles = (variant.target_titles || [])
        .map((title) => normalizePhrase(title))
        .filter((title) => title.length >= 2);
      return {
        id: variant.id,
        label: variant.label,
        order,
        titleClasses: [...new Set(variant.title_classes || [])],
        matchRegex: alternates.length ? new RegExp(`(?:${alternates.join('|')})`, 'g') : null,
        phraseEntries,
        targetTitleRegex: targetTitles.length
          ? new RegExp(`(?:${targetTitles.slice().sort((a, b) => b.length - a.length).map(boundaryPattern).join('|')})`)
          : null
      };
    });

    const core = profileFile.core || {};
    const completedRank = Math.max(0, ...(core.degrees || [])
      .filter((degree) => degree.status === 'completed')
      .map((degree) => DEGREE_RANK[degree.level] || 0));
    const inProgressRank = Math.max(0, ...(core.degrees || [])
      .filter((degree) => degree.status === 'in_progress')
      .map((degree) => DEGREE_RANK[degree.level] || 0));

    // Which kinds of role this person can plausibly hold, pooled across every
    // variant. Distinct from per-variant class points (which decide WHICH
    // resume to send): this decides whether the job is their line of work.
    const primaryClasses = new Set();
    const allClasses = new Set();
    for (const variant of variants) {
      if (variant.titleClasses[0]) primaryClasses.add(variant.titleClasses[0]);
      for (const cls of variant.titleClasses) allClasses.add(cls);
    }

    // Ranks answer "is this credential high enough", which is the right
    // question for phd/masters/bachelors but not for md: a PhD is rank-equal
    // to an MD and satisfies neither the licence nor the training it stands
    // for. Eligibility checks the actual levels held.
    const completedLevels = new Set((core.degrees || [])
      .filter((degree) => degree.status === 'completed').map((degree) => degree.level));
    const inProgressLevels = new Set((core.degrees || [])
      .filter((degree) => degree.status === 'in_progress').map((degree) => degree.level));

    return {
      profile: profileFile,
      hash: profileHash(profileFile),
      careerStage: core.career_stage || 'early_career',
      yearsExperience: Number(core.years_experience) || 0,
      tracks: { primaryClasses, allClasses },
      completedRank,
      inProgressRank,
      completedLevels,
      inProgressLevels,
      // Whether this person can hold a licensed clinical post at all. The
      // profile's degree vocabulary tops out at `md`, so that is the only
      // clinical credential it can currently express — an RN or PharmD
      // candidate would need the schema widened before the profession gate in
      // assessEligibility would be right for them.
      holdsClinicalCredential: completedLevels.has('md') || inProgressLevels.has('md'),
      avoidRegexes: (core.avoid_signals || [])
        .map((signal) => collapseWhitespace(signal).toLowerCase())
        .filter((signal) => signal.length >= 2)
        .map((signal) => ({ signal, regex: new RegExp(boundaryPattern(signal)) })),
      variants
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Degree gate: parsed from posting text (jobs carry no structured field)   */

  const SENTENCE_BOUNDARY = /[.;!?\n•·]/;
  const REQUIREMENT_NEARBY = /\b(required|requires?|requirement|must\s+(hold|have|possess)|minimum|necessary|essential)\b/i;
  // "optional" earns its place here: postings like "Master's degree (required)
  // or Ph.D. (optional)" put both words in one clause, and without it the
  // stricter credential wins a requirement it was never given.
  const SOFTENER = /\b(preferred|desirable|optional|a\s+plus|or\s+equivalent|equivalent\s+experience|nice\s+to\s+have|not\s+required|ideal(ly)?)\b/i;

  // Ordered highest rank first: the strictest hard requirement wins the gate.
  // Abbreviation forms (MS/MSc/BS/BA) and bare "MD" are ambiguous (states,
  // "MS Office"), so they only count with degree/requirement context nearby.
  const DEGREE_BANKS = [
    { level: 'phd', pattern: /\bph\.?\s?d\b|\bdoctora(?:te|l)\b/gi, needsContext: false },
    { level: 'md', pattern: /\bm\.?d\.?(?![a-z0-9])/gi, needsContext: true, context: /\b(medicine|medical|physician|doctor|residency|clinical)\b/i },
    { level: 'masters', pattern: /\bmaster'?s?\b|\bm\.?sc?\.?(?![a-z0-9])/gi, needsContext: 'abbrev', full: /\bmaster/i, context: /\b(degree|required|minimum|qualification)\b/i },
    { level: 'bachelors', pattern: /\bbachelor'?s?\b|\bundergraduate\s+degree\b|\bb\.?s\.?c?\.?(?![a-z0-9])|\bb\.?a\.?(?![a-z0-9])/gi, needsContext: 'abbrev', full: /\bbachelor|\bundergraduate/i, context: /\b(degree|required|minimum|qualification)\b/i }
  ];

  function clauseAround(text, index, length) {
    const before = text.slice(Math.max(0, index - 80), index);
    const after = text.slice(index + length, index + length + 80);
    return `${before.split(SENTENCE_BOUNDARY).pop()} ${after.split(SENTENCE_BOUNDARY)[0]}`;
  }

  // Same window, but tolerant of an abbreviation's own full stop: "Ph.D." ends
  // the clause at its trailing dot, hiding a qualifier that follows it. Only
  // softeners read this — a wider view can then only remove a barrier, never
  // invent one, which is the safe direction to be wrong in.
  function softenerClauseAround(text, index, length) {
    const before = text.slice(Math.max(0, index - 80), index);
    const after = text.slice(index + length, index + length + 80).replace(/^\.(?=\s*[([a-z])/, '');
    return `${before.split(SENTENCE_BOUNDARY).pop()} ${after.split(SENTENCE_BOUNDARY)[0]}`;
  }

  function snippetAround(text, index, length) {
    const start = Math.max(0, index - 45);
    const end = Math.min(text.length, index + length + 45);
    return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`;
  }

  function parseDegreeGate(text, titleClass) {
    return parseDegreeGateCollapsed(collapseWhitespace(text), titleClass);
  }

  // Cheap pre-filter: one scan decides whether any bank could match at all —
  // most non-degree postings then skip the four per-level scans entirely.
  const ANY_DEGREE_TERM = /\bph\.?\s?d\b|\bdoctora|\bmaster|\bbachelor|\bundergraduate\s+degree\b|\bm\.?sc?\.?(?![a-z0-9])|\bb\.?s\.?c?\.?(?![a-z0-9])|\bb\.?a\.?(?![a-z0-9])|\bm\.?d\.?(?![a-z0-9])/i;
  const MAX_MENTIONS_PER_BANK = 8;

  // Internal fast path: scoreJob already collapsed the corpus once.
  function parseDegreeGateCollapsed(corpus, titleClass) {
    let hard = null;
    let soft = null;

    for (const bank of ANY_DEGREE_TERM.test(corpus) ? DEGREE_BANKS : []) {
      if (hard && DEGREE_RANK[hard.required] >= DEGREE_RANK[bank.level]) break;
      bank.pattern.lastIndex = 0;
      let match;
      let mentions = 0;
      while ((match = bank.pattern.exec(corpus)) !== null && mentions < MAX_MENTIONS_PER_BANK) {
        mentions += 1;
        const clause = clauseAround(corpus, match.index, match[0].length);
        if (bank.needsContext === true && !bank.context.test(clause)) continue;
        if (bank.needsContext === 'abbrev' && !bank.full.test(match[0]) && !bank.context.test(clause)) continue;
        const softened = SOFTENER.test(softenerClauseAround(corpus, match.index, match[0].length));
        const required = !softened && REQUIREMENT_NEARBY.test(clause);
        const finding = {
          required: bank.level,
          source: 'text',
          softened,
          evidence: snippetAround(corpus, match.index, match[0].length)
        };
        if (required) {
          if (!hard || DEGREE_RANK[bank.level] > DEGREE_RANK[hard.required]) hard = finding;
          break; // strictest finding for this level recorded
        }
        if (softened && (!soft || DEGREE_RANK[bank.level] > DEGREE_RANK[soft.required])) soft = finding;
        // A degree mention with neither requirement nor softener language
        // ("our PhD scientists") is not a gate at all.
      }
    }

    if (hard) return hard;

    // Postdoc/faculty postings require a doctorate by definition even when the
    // text doesn't spell it out — unless the text explicitly softened it.
    if ((titleClass === 'postdoc' || titleClass === 'faculty') && (!soft || DEGREE_RANK[soft.required] < DEGREE_RANK.phd)) {
      return { required: 'phd', source: 'title_class', softened: false, evidence: `classified as ${titleClass}` };
    }

    if (soft) return soft;
    return { required: null, source: null, softened: false, evidence: null };
  }

  function seniorityFlag(title, careerStage) {
    return SENIOR_TITLE.test(String(title || '')) && EARLY_STAGES.has(careerStage);
  }

  /* ---------------------------------------------------------------------- */
  /* Scoring                                                                 */

  function emptyFit(message) {
    return {
      fit_score: null,
      verdict: null,
      recommended_variant: null,
      recommended_source: null,
      llm_reason: null,
      ambiguous: false,
      variants: [],
      gate: null,
      track: null,
      eligibility: null,
      avoid_hits: [],
      evidence_bonus: 0,
      research_bonus: 0,
      fit_summary: message || 'Import your profile to rank jobs.'
    };
  }

  function scoreVariant(compiledVariant, corpusLower, titleLower, jobTitleClass) {
    const matched = { 3: [], 2: [], 1: [] };
    const matchedText = new Set();
    const domainHits = [];
    let skillPoints = 0;
    if (compiledVariant.matchRegex) {
      compiledVariant.matchRegex.lastIndex = 0;
      // Max wins per canonical term: a broad alias (weight 1) must not lock a
      // term out of full credit when its real phrase also appears.
      const bestWeightByTerm = new Map();
      const seenDomains = new Set();
      let match;
      while ((match = compiledVariant.matchRegex.exec(corpusLower)) !== null) {
        const entry = compiledVariant.phraseEntries.get(match[0]);
        if (!entry) continue;
        if (entry.skill) {
          matchedText.add(match[0]);
          const previous = bestWeightByTerm.get(entry.skill.term) || 0;
          if (entry.skill.weight > previous) bestWeightByTerm.set(entry.skill.term, entry.skill.weight);
        }
        // A phrase serving as a skill for this variant never doubles as its
        // domain — one word, one credit. (A phrase that is domain-only for
        // this variant still counts as a domain.)
        if (entry.domain && !entry.skill && !seenDomains.has(entry.domain)) {
          seenDomains.add(entry.domain);
          domainHits.push(entry.domain);
          matchedText.add(match[0]);
        }
      }
      for (const [term, weight] of bestWeightByTerm) {
        matched[weight].push(term);
        skillPoints += WEIGHTS.SKILL_POINTS[weight];
      }
    }
    skillPoints = Math.min(skillPoints, WEIGHTS.SKILL_CAP);

    let titleClassMatch = null;
    if (jobTitleClass && compiledVariant.titleClasses.length) {
      if (compiledVariant.titleClasses[0] === jobTitleClass) titleClassMatch = 'primary';
      else if (compiledVariant.titleClasses.includes(jobTitleClass)) titleClassMatch = 'secondary';
    }
    const classPoints = titleClassMatch === 'primary' ? WEIGHTS.TITLE_CLASS_PRIMARY
      : titleClassMatch === 'secondary' ? WEIGHTS.TITLE_CLASS_SECONDARY : 0;

    const domainPoints = Math.min(domainHits.length * WEIGHTS.DOMAIN_POINTS, WEIGHTS.DOMAIN_CAP);

    const targetTitleHit = Boolean(compiledVariant.targetTitleRegex && compiledVariant.targetTitleRegex.test(titleLower));

    return {
      id: compiledVariant.id,
      label: compiledVariant.label,
      order: compiledVariant.order,
      score: skillPoints + classPoints + domainPoints + (targetTitleHit ? WEIGHTS.TARGET_TITLE : 0),
      matched,
      matched_text: [...matchedText],
      title_class_match: titleClassMatch,
      domain_hits: domainHits,
      target_title_hit: targetTitleHit
    };
  }

  function resolveVariant(variantScores, verdictEntry) {
    const ranked = variantScores.slice().sort((a, b) => b.score - a.score || a.order - b.order);
    const top = ranked[0];
    const second = ranked[1];
    const ambiguous = Boolean(second)
      && (top.score - second.score) < WEIGHTS.AMBIGUITY_MARGIN
      && top.score >= WEIGHTS.AMBIGUITY_FLOOR;

    // A cached local-LLM verdict (validated upstream against the profile hash)
    // overrides which variant is recommended — never the score.
    if (verdictEntry && variantScores.some((variant) => variant.id === verdictEntry.variant_id)) {
      return {
        recommended_variant: verdictEntry.variant_id,
        recommended_source: 'llm',
        llm_reason: verdictEntry.reason || null,
        ambiguous
      };
    }
    return {
      recommended_variant: top ? top.id : null,
      recommended_source: top ? 'deterministic' : null,
      llm_reason: null,
      ambiguous
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Eligibility: could this person's application be considered at all?       */

  /* Asymmetric by design. A job is only "blocked" on evidence we can quote
     back; anything ambiguous stays "likely" and remains visible. A false
     block hides a job the user could have had — the one unforgivable error.
     Every extractor below therefore demands an explicit requirement cue and
     returns the sentence that triggered it. */

  const LICENSE_BANKS = [
    { type: 'rn_license', pattern: /\bregistered\s+nurse\b|\brn\s+license|\blicensed\s+practical\s+nurse\b|\blpn\b/gi, needsContext: false },
    { type: 'medical_license', pattern: /\bmedical\s+license|\bboard[-\s]?certified\b|\bboard\s+certification\b|\bmedical\s+licensure\b/gi, needsContext: false },
    { type: 'pharmacy_license', pattern: /\bpharmacist\s+licens|\bpharm\.?d\.?\s+licens/gi, needsContext: false },
    { type: 'professional_engineer', pattern: /\bprofessional\s+engineer\b|\bp\.?e\.?\s+licens/gi, needsContext: false },
    { type: 'driver_license', pattern: /\bcdl\b|\bcommercial\s+driver'?s?\s+licens/gi, needsContext: false }
  ];

  const CLEARANCE_PATTERN = /\b(security\s+clearance|top\s+secret|ts\/sci|secret\s+clearance|public\s+trust\s+clearance)\b/gi;
  const STUDENT_ONLY_PATTERN = /\b(currently\s+enrolled|must\s+be\s+a\s+(?:current\s+)?student|current\s+student\s+only|work[-\s]study|degree[-\s]seeking\s+student)\b/gi;
  const INTERNAL_ONLY_PATTERN = /\b(internal\s+(?:applicants?|candidates?|employees?)\s+only|current\s+employees\s+only|open\s+to\s+current\s+employees)\b/gi;
  // "5+ years", "minimum of 7 years", "5-7 years", "five (5) years", "three to
  // five years". The leading figure is the bar: a range asks for its floor,
  // not its ceiling.
  const YEAR_WORDS = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
    nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20
  };
  const YEAR_NUMBER = `(?:\\d{1,2}|${Object.keys(YEAR_WORDS).join('|')})`;
  const YEAR_PAREN = '(?:\\s*\\(\\s*\\d{1,2}\\s*\\+?\\s*\\))?';
  const YEARS_PATTERN = new RegExp(
    `\\b(${YEAR_NUMBER})\\)?${YEAR_PAREN}\\s*(?:(?:[-–—]|to)\\s*${YEAR_NUMBER}${YEAR_PAREN}\\s*)?\\+?\\s*(?:or\\s+more\\s+)?(?:full[-\\s]time\\s+)?years?\\b`,
    'gi'
  );
  // The figure has to be about experience: "5 years of relevant experience",
  // "Experience: 5 years". Not "a 3 year appointment" or "a 10 year grant".
  const YEARS_EXPERIENCE_AFTER = /^[^.;•]{0,50}?\b(experience|expertise|practice|background|working)\b/i;
  const YEARS_EXPERIENCE_BEFORE = /\bexperience\b[^.;•]{0,25}$/i;
  // "within the last 5 years", "up to 5 years": a window or a term, not a bar.
  const YEARS_DURATION_BEFORE = /\b(last|past|previous|within|up\s+to|every|next)(\s+the)?(\s+(last|past|previous))?\s*$/i;
  // "...within the five years immediately preceding the date of application"
  const YEARS_DURATION_AFTER = /^\s*(immediately\s+)?(preceding|prior\s+to\s+the\s+date)\b/i;
  // How postings state a bar. Wider than REQUIREMENT_NEARBY, because "Bachelor's
  // degree and 5 years of relevant experience" is a requirement that never uses
  // the word, and the strict reading missed most of them.
  const YEARS_REQUIREMENT_CUE = /\b(required|requires?|requirement|must|minimum|necessary|essential|at\s+least|qualifications?|need|should\s+have|you\s+(have|bring|possess|will\s+have)|looking\s+for|seeking)\b|\b(degree|diploma|bachelor'?s|master'?s|ph\.?\s?d\.?|equivalent)\s+(and|plus|with)\b|\bexperience\s*:/i;
  // "Preferred" and its kin make a figure a wish.
  const YEARS_SOFTENER = /\b(prefer(s|red)?|desirable|desired|optional|a\s+plus|nice\s+to\s+have|not\s+required|ideal(ly)?|bonus|helpful|beneficial)\b/i;
  // An equivalency route ("Bachelor's or equivalent and 5 years", "or an
  // equivalent combination of education and experience") keeps the job
  // visible: the owner's call, 2026-10-06. It often sits in the next
  // sentence, so this reads past the clause. Substitution is the same route
  // ("four years of experience may substitute for the degree", "in lieu of a
  // degree, 5 years"): there the years replace a degree, they are not a bar on
  // top of one.
  const YEARS_EQUIVALENCY = /\b(equivalen(t|cy)|substitut\w*|in\s+lieu\s+of)\b/i;
  // The figure belongs to a route for people without a bachelor's ("or an
  // associate's degree with 6 years"), which a degree holder does not take.
  const YEARS_LOWER_DEGREE_ROUTE = /\b(associate'?s?|associates|high\s+school|ged|without\s+a\s+(bachelor|degree))\b/i;
  // Bullet lists put the cue in a heading ("Minimum Qualifications") and the
  // figure in a bullet below it, so the nearest heading decides.
  const YEARS_PREFERRED_HEADING = /\b(preferred|desired|desirable|nice\s+to\s+have|bonus|even\s+better|set\s+you\s+apart|additional)\b(?:\s+(qualifications|skills|experience|requirements))?/gi;
  const YEARS_REQUIRED_HEADING = /\b((minimum|required|basic|essential)\s+(qualifications|requirements|education|experience)|requirements|qualifications|what\s+you('ll)?\s+(need|bring)|who\s+you\s+are|must\s+haves?)\b/gi;
  const YEARS_HEADING_LOOKBACK = 600;

  function findRequirement(corpus, pattern, { context = null } = {}) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(corpus)) !== null) {
      const clause = clauseAround(corpus, match.index, match[0].length);
      if (SOFTENER.test(clause)) continue;
      if (context && !context.test(clause)) continue;
      if (!REQUIREMENT_NEARBY.test(clause)) continue;
      return { evidence: snippetAround(corpus, match.index, match[0].length), match };
    }
    return null;
  }

  function lastMatchEnd(pattern, text) {
    pattern.lastIndex = 0;
    let end = -1;
    let match;
    while ((match = pattern.exec(text)) !== null) end = match.index + match[0].length;
    return end;
  }

  // 'required' | 'preferred' | null: which kind of heading the figure sits under.
  // "Preferred Qualifications" ends where its "Qualifications" does, so a tie
  // goes to preferred.
  function yearsHeading(corpus, index) {
    const window = corpus.slice(Math.max(0, index - YEARS_HEADING_LOOKBACK), index);
    const preferred = lastMatchEnd(YEARS_PREFERRED_HEADING, window);
    const required = lastMatchEnd(YEARS_REQUIRED_HEADING, window);
    if (preferred < 0 && required < 0) return null;
    return preferred >= required ? 'preferred' : 'required';
  }

  function parseYearsRequirement(corpus) {
    YEARS_PATTERN.lastIndex = 0;
    let match;
    // Name reflects the reading, not the arithmetic: the lowest stated bar.
    let strictest = null;
    while ((match = YEARS_PATTERN.exec(corpus)) !== null) {
      const figure = match[1].toLowerCase();
      const years = YEAR_WORDS[figure] || Number(figure);
      if (!Number.isFinite(years) || years <= 0 || years > 40) continue;
      const end = match.index + match[0].length;
      const before = corpus.slice(Math.max(0, match.index - 40), match.index);
      const after = corpus.slice(end, end + 60);
      if (YEARS_DURATION_BEFORE.test(before) || YEARS_DURATION_AFTER.test(after)) continue;
      // "years of experience", not "5 years of funding" or "3 year appointment"
      if (!YEARS_EXPERIENCE_AFTER.test(after) && !YEARS_EXPERIENCE_BEFORE.test(before)) continue;
      const clause = clauseAround(corpus, match.index, match[0].length);
      if (YEARS_SOFTENER.test(clause)) continue;
      if (YEARS_EQUIVALENCY.test(corpus.slice(Math.max(0, match.index - 120), end + 160))) continue;
      if (YEARS_LOWER_DEGREE_ROUTE.test(corpus.slice(Math.max(0, match.index - 60), match.index))) continue;
      // A clause that says "required" outright needs no heading; otherwise a
      // figure under "Preferred Qualifications" is a wish, and one under
      // "Minimum Qualifications" (or in a clause that states a bar) is not.
      // A sentence or bullet that opens with the figure ("5+ years of
      // experience in…") is how postings list a bar; mid-sentence ("our lab
      // brings 20 years of experience") it needs a cue.
      if (!REQUIREMENT_NEARBY.test(clause)) {
        const heading = yearsHeading(corpus, match.index);
        if (heading === 'preferred') continue;
        const opensClause = !/[a-z0-9]/i.test(before.split(SENTENCE_BOUNDARY).pop());
        if (heading !== 'required' && !opensClause && !YEARS_REQUIREMENT_CUE.test(clause)) continue;
      }
      // Postings state alternative routes to the same job ("Bachelor's plus 8
      // years, Master's plus 6"). The lowest bar anywhere is the one that has
      // to be cleared, so the most permissive reading is also the correct one.
      if (!strictest || years < strictest.min_years) {
        strictest = { min_years: years, evidence: snippetAround(corpus, match.index, match[0].length) };
      }
    }
    return strictest;
  }

  /* Sponsorship: only a posting that says outright it will not sponsor.
   *
   * Deliberately NOT job.veritas_state === 'RESTRICTED'. That bucket also
   * holds "must be authorized to work in the U.S." (OPT is authorization),
   * export-control boilerplate, ITAR mentions and "green card holders
   * preferred" — none of which says no. Those keep their score penalty and
   * stay visible; only an explicit refusal hides a job. */
  const VISA_WORDS = '(?:(?:visa|immigration|h-?1-?b|employment|employer|work|current|future|or|and|any|now|in|the)\\s+){0,5}';
  const SPONSORSHIP_REFUSALS = [
    // "Visa sponsorship is not available", "sponsorship will not be provided"
    new RegExp('\\bsponsorship\\s+(?:is\\s+|will\\s+|can\\s*)?not\\s+(?:be\\s+)?(?:available|provided|offered|possible|supported)\\b', 'i'),
    // "we will not sponsor", "does not provide visa sponsorship", "is not able to sponsor"
    new RegExp(`\\b(?:will|does|do|can|could|is|are)\\s*(?:not|n['’]t)\\s+(?:be\\s+)?(?:able\\s+to\\s+|currently\\s+|presently\\s+|in\\s+a\\s+position\\s+to\\s+)?(?:provide\\s+|offer\\s+|support\\s+)?${VISA_WORDS}sponsor(?:ship)?\\b`, 'i'),
    // "unable to sponsor", "cannot provide visa sponsorship"
    new RegExp(`\\b(?:cannot|unable\\s+to|not\\s+able\\s+to)\\s+(?:provide\\s+|offer\\s+|support\\s+)?${VISA_WORDS}sponsor(?:ship)?\\b`, 'i'),
    // "not sponsoring", "not offering visa sponsorship"
    new RegExp(`\\bnot\\s+(?:currently\\s+)?(?:sponsoring|(?:offering|providing)\\s+${VISA_WORDS}sponsorship)\\b`, 'i'),
    // "no visa sponsorship", "no current or future sponsorship" — but not
    // "no sponsorship restrictions" or "no sponsorship is required"
    new RegExp(`\\bno\\s+${VISA_WORDS}sponsorship\\b(?!\\s+(?:is\\s+)?(?:restrictions?|limitations?|required|needed|necessary))`, 'i'),
    // "this position is not eligible for visa sponsorship"
    new RegExp(`\\bnot\\s+(?:eligible|available|open)\\s+(?:for|to)\\s+${VISA_WORDS}sponsorship\\b`, 'i'),
    // "candidates who require sponsorship will not be considered"
    new RegExp(`\\b(?:require|need)\\w*\\s+${VISA_WORDS}sponsorship[^.;•]{0,40}\\b(?:will\\s+not|won['’]t|cannot)\\s+be\\s+considered\\b`, 'i'),
    // "must be authorized to work in the U.S. without sponsorship"
    new RegExp(`\\bwithout\\s+(?:the\\s+need\\s+for\\s+|requiring\\s+|needing\\s+)?${VISA_WORDS}sponsorship\\b`, 'i')
  ];
  // The "without sponsorship" form only refuses when it is about authorization.
  const AUTHORIZATION_CONTEXT = /\b(authori[sz]|eligib|legally|permitted|able\s+to\s+work)/i;
  // A refusal of one specific route (a green card, a J-1) is not a refusal of
  // the H-1B, unless the sentence names the H-1B too.
  // TN/E-3/O-1 need "visa" beside them, and a TN after a comma is a state:
  // "Memphis, TN Visa sponsorship is not available" refuses the H-1B too.
  const NARROW_VISA_ROUTE = /\b(permanent\s+residen\w*|green\s+cards?|perm|j-?1|(?:(?<!,\s?)tn|e-?3|o-?1)\s+(?:visas?|status))\b/i;
  const H1B = /\bh-?1-?b\b/i;
  // The bare verb has to be sponsoring a person or a visa: "UMGC does not
  // sponsor logistical support for this role" is about something else. Read
  // to the end of the sentence: the object is often a few words on ("unable
  // to sponsor or take over sponsorship of an employment visa").
  const SPONSOR_VERB_OBJECT = /\b(visas?|h-?1-?b|immigration|employment|work\s+authori[sz]|sponsorship|candidates?|applicants?|individuals?|employees?|petitions?|international|foreign|non-?citizens?)\b|^\s*for\s+(this|the)\s+(position|role|job|opportunity|vacancy)\b|^\s*$/i;
  const REFUSAL_NEGATED = /\b(regardless\s+of|even\s+if|whether\s+or\s+not)\b|\bwith\s+or\s*$/i;
  // "Sponsorship is not available, but OPT candidates are welcome" still lets
  // an OPT holder in, which is not an explicit no. Case-sensitive acronyms:
  // lowercase "opt" is benefits text ("eligible staff may opt in").
  const OPT_ACRONYM = /\b(?:STEM OPT|OPT|CPT|F-?1)\b/g;
  const OPT_WELCOME_AFTER = /^[^.;•]{0,60}\b(welcome|eligible|encouraged|accepted|considered|may\s+apply)\b/i;

  function optWelcome(corpus) {
    OPT_ACRONYM.lastIndex = 0;
    let match;
    while ((match = OPT_ACRONYM.exec(corpus)) !== null) {
      if (OPT_WELCOME_AFTER.test(corpus.slice(match.index + match[0].length, match.index + match[0].length + 80))) return true;
    }
    return false;
  }

  function parseSponsorshipRefusal(corpus) {
    if (!/sponsor/i.test(corpus)) return null;
    if (optWelcome(corpus)) return null;
    for (const pattern of SPONSORSHIP_REFUSALS) {
      const scan = new RegExp(pattern.source, 'gi');
      let match;
      while ((match = scan.exec(corpus)) !== null) {
        const clause = clauseAround(corpus, match.index, match[0].length);
        const before = corpus.slice(Math.max(0, match.index - 80), match.index).split(SENTENCE_BOUNDARY).pop();
        if (REFUSAL_NEGATED.test(before)) continue;
        if (/sponsor$/i.test(match[0])
          && !SPONSOR_VERB_OBJECT.test(corpus.slice(match.index + match[0].length, match.index + match[0].length + 80)
            .split(SENTENCE_BOUNDARY)[0])) continue;
        if (NARROW_VISA_ROUTE.test(clause) && !H1B.test(clause)) continue;
        // A fixed lookback, not the clause: "in the U.S. without sponsorship"
        // would end the clause at the abbreviation's own full stops.
        if (/^without/i.test(match[0])
          && !AUTHORIZATION_CONTEXT.test(corpus.slice(Math.max(0, match.index - 120), match.index))) continue;
        return { evidence: snippetAround(corpus, match.index, match[0].length) };
      }
    }
    return null;
  }

  function parseLicenseRequirement(corpus) {
    for (const bank of LICENSE_BANKS) {
      const found = findRequirement(corpus, bank.pattern);
      if (found) return { license: bank.type, evidence: found.evidence };
    }
    return null;
  }

  // Titles that name a research post, whatever clinical words sit beside them.
  // "Research Fellow, Radiation Oncology" is a lab job; "Clinical Fellow,
  // Cardiology" is not. Used only to hold the profession gate back, so a false
  // match here costs a judgment, never a hidden job.
  const RESEARCH_POST_TITLE = /\b(research|postdoc|post-?doctoral|scientist|bioinformatic\w*|computational|informatics|data)\b/i;

  function parseClearanceRequirement(corpus) {
    const found = findRequirement(corpus, CLEARANCE_PATTERN);
    return found ? { evidence: found.evidence } : null;
  }

  // Enrollment language is usually phrased "must be currently enrolled", which
  // the generic requirement cues (must HOLD/HAVE/POSSESS) miss.
  const STUDENT_CUE = /\b(must\s+be|required|restricted\s+to|eligibility|only|limited\s+to)\b/i;
  // "...students may also apply" invites, it does not restrict.
  const INVITATION = /\b(may\s+(also\s+)?apply|are\s+encouraged|welcome\s+to\s+apply|including)\b/i;

  function parseStudentOnly(corpus, title) {
    // An internship title alone is not a block — plenty are open to grads.
    STUDENT_ONLY_PATTERN.lastIndex = 0;
    let match;
    while ((match = STUDENT_ONLY_PATTERN.exec(corpus)) !== null) {
      const clause = clauseAround(corpus, match.index, match[0].length);
      if (SOFTENER.test(clause) || INVITATION.test(clause)) continue;
      if (!STUDENT_CUE.test(clause)) continue;
      return {
        evidence: snippetAround(corpus, match.index, match[0].length),
        title_hint: /\bintern(ship)?\b|\bco-?op\b/i.test(String(title || ''))
      };
    }
    return null;
  }

  function parseInternalOnly(corpus) {
    INTERNAL_ONLY_PATTERN.lastIndex = 0;
    const match = INTERNAL_ONLY_PATTERN.exec(corpus);
    // Self-describing: "internal applicants only" needs no requirement cue.
    if (!match) return null;
    return { evidence: snippetAround(corpus, match.index, match[0].length) };
  }

  // Merges the deterministic reads with any cached local-model extraction of
  // the same posting. The model supplies job-side FACTS ("this asks for 8
  // years"); the comparison against this person stays deterministic here, so
  // no model ever decides that a job is out of reach.
  function assessEligibility(job, corpusRaw, gateFinding, compiled, degreeMet) {
    const blockers = [];
    const cautions = [];
    const claimed = job.classified_requirements || null;
    const thinText = String(job.description_text || '').length < WEIGHTS.THIN_TEXT_CHARS;

    if (job.citizenship_gated) {
      blockers.push({
        type: 'citizenship',
        evidence: job.restricted_reason || 'Posting is restricted to U.S. citizens.',
        source: 'metadata'
      });
    }

    // "PhD preferred" is not a barrier — it is how a large share of research
    // postings are written, and treating it as one would empty the clear
    // bucket. Only unsoftened requirements are weighed.
    if (gateFinding.required && !degreeMet && !gateFinding.softened) {
      const requiredRank = DEGREE_RANK[gateFinding.required];
      // An MD is a specific credential, not a level — no amount of PhD
      // progress reaches it.
      const inProgressCovers = gateFinding.required === 'md'
        ? compiled.inProgressLevels.has('md')
        : compiled.inProgressRank >= requiredRank;
      const entry = {
        type: 'degree',
        detail: gateFinding.required,
        evidence: gateFinding.evidence || `Requires a ${gateFinding.required}.`,
        source: gateFinding.source === 'title_class' ? 'title_class' : 'text'
      };
      // A credential already under way lands before most start dates.
      if (inProgressCovers) cautions.push(entry);
      else blockers.push(entry);
    }

    /* Years of experience. This was ignored for a while — postings overstate
     * it, and a gate keyed to the profile's own years walled off "5+ years"
     * research associate roles. The owner reversed that on 2026-10-06: a
     * stated bar of 4+ years is out, full stop. The threshold is absolute, not
     * relative to the profile. Ranges take their floor and alternative routes
     * take the lowest bar (see parseYearsRequirement), so "3-5 years" and
     * "Master's plus 2 years, or Bachelor's plus 5" both stay visible. A
     * local-model claim (classified_requirements.min_years) is still not
     * acted on — it is not a sentence we can quote. */
    // Open-rank faculty postings state the bar per rank ("associate-level
    // appointments require 5 years"); the entry rank usually states none.
    const years = /\bopen[\s-]+rank\b/i.test(job.title || '') ? null : parseYearsRequirement(corpusRaw);
    if (years && years.min_years > WEIGHTS.MAX_REQUIRED_YEARS) {
      blockers.push({ type: 'experience', detail: years.min_years, evidence: years.evidence, source: 'text' });
    }

    const sponsorship = parseSponsorshipRefusal(corpusRaw);
    if (sponsorship) blockers.push({ type: 'sponsorship', evidence: sponsorship.evidence, source: 'text' });

    const license = parseLicenseRequirement(corpusRaw);
    if (license) blockers.push({ type: 'license', detail: license.license, evidence: license.evidence, source: 'text' });

    /* The profession gate.
     *
     * parseLicenseRequirement above only fires on quotable text ("must hold an
     * RN license"), and a Physician posting never bothers to say so — the
     * title carries it. So 391 of 989 qualified postings were clinical roles
     * that nothing stopped, and the judge model spent 40% of a five-hour pass
     * re-deriving what the title already said. Measured over 414 judged
     * postings, it called 35 of the 36 clinical-titled ones "no".
     *
     * Porous on purpose. It reads the classified TITLE, never the body, so
     * "Research Associate, Cardiology" is still read by the model; only a
     * title that names the profession is stopped. The research-post exclusion
     * is the single measured miss: "Research Fellow, Radiation Oncology" is a
     * lab post wearing a clinical-sounding title. */
    if (job.title_class === 'clinical'
      && !compiled.holdsClinicalCredential
      && !RESEARCH_POST_TITLE.test(job.title || '')) {
      blockers.push({
        type: 'profession',
        detail: 'clinical',
        evidence: `Title is a licensed clinical role: "${job.title}"`,
        source: 'title_class'
      });
    }

    /* The professions this person said to stay out of, matched against the
     * TITLE only. In the body the same list is a score penalty and should
     * stay one — a data posting that mentions nurses is still a data posting.
     * In the title it IS the job. This half is theirs to extend: adding to
     * avoid_signals widens the gate without touching code. */
    const avoided = compiled.avoidRegexes
      .find((entry) => entry.regex.test(String(job.title || '').toLowerCase()));
    if (avoided) {
      blockers.push({
        type: 'profession',
        detail: avoided.signal,
        evidence: `Title names "${avoided.signal}", which your profile lists as work to avoid`,
        source: 'avoid_signal'
      });
    }

    const clearance = parseClearanceRequirement(corpusRaw);
    if (clearance) blockers.push({ type: 'clearance', evidence: clearance.evidence, source: 'text' });

    const student = parseStudentOnly(corpusRaw, job.title);
    if (student) blockers.push({ type: 'student_only', evidence: student.evidence, source: 'text' });

    const internal = parseInternalOnly(corpusRaw);
    if (internal) blockers.push({ type: 'internal_only', evidence: internal.evidence, source: 'text' });

    // Every blocker must be quotable. A blocker without evidence would hide a
    // job for a reason we cannot show, so it is demoted to a caution.
    const quotable = blockers.filter((entry) => entry.source === 'metadata' || entry.evidence);
    for (const entry of blockers) if (!quotable.includes(entry)) cautions.push(entry);

    let verdict;
    if (quotable.length) verdict = 'blocked';
    // Thin text can't support "clear" — nothing was read, so nothing is known.
    else if (cautions.length || thinText) verdict = 'likely';
    else verdict = 'clear';

    // Where a local model would add something the regexes can't settle.
    const needsReview = Boolean(thinText && !quotable.length);

    return { verdict, blockers: quotable, cautions, insufficient_text: thinText, needs_review: needsReview };
  }

  /* ---------------------------------------------------------------------- */
  /* Role track: is this the kind of job this person does at all?             */

  // Answers a different question from fit_score. Fit asks "how well do the
  // skills line up"; track asks "is this their line of work" — a mismatch the
  // score alone can't express, since a data scientist's terms appear in plenty
  // of postings they could never hold. Never touches the score.
  function roleTrack(job, compiled) {
    const titleLower = String(job.title || '').toLowerCase();
    const via = compiled.variants
      .filter((variant) => variant.targetTitleRegex && variant.targetTitleRegex.test(titleLower))
      .map((variant) => variant.id);
    if (via.length) return { status: 'reachable', basis: 'target_title', via };

    const jobClass = job.title_class;
    if (jobClass && compiled.tracks.primaryClasses.has(jobClass)) {
      return {
        status: 'reachable',
        basis: 'title_class',
        via: compiled.variants.filter((variant) => variant.titleClasses[0] === jobClass).map((variant) => variant.id)
      };
    }
    if (jobClass && compiled.tracks.allClasses.has(jobClass)) {
      return {
        status: 'adjacent',
        basis: 'title_class',
        via: compiled.variants.filter((variant) => variant.titleClasses.includes(jobClass)).map((variant) => variant.id)
      };
    }
    // 'other' is the classifier's fallthrough, not a verdict — the title just
    // didn't match its regexes. Unknown, not out (the classify layer resolves
    // these); demote-never-hide applies.
    if (!jobClass || jobClass === 'other') return { status: 'unknown', basis: null, via: [] };
    return { status: 'none', basis: 'title_class', via: [] };
  }

  // The dashboard's "Qualified" cut: open, in the user's line of work, and not
  // blocked by quotable evidence. Fit score is deliberately NOT consulted —
  // fit ranks this list, it never gates it. Unanswerable without a scored
  // profile (fit_score null), so callers must treat "no profile" as a prompt
  // to import one, not as zero qualified jobs. includeBlocked exists so the
  // blocked-reveal count can reuse this predicate instead of duplicating it.
  /* What reaches the judge.
   *
   * This used to also require roleTrack to say "reachable" or "adjacent" —
   * a guess, made from the posting's title class, about whether a job was this
   * person's line of work. It was the last place a real match could disappear
   * without leaving evidence, and it was carrying 616 of 12,440 postings.
   *
   * It existed to protect a local model that cost twenty seconds a posting.
   * Judging now costs a fraction of a cent, so the guess is not worth its risk:
   * the gate keeps only what is quotably impossible — closed, citizens-only, a
   * licence or degree the posting demands and the profile does not have, a
   * profession that needs credentials you cannot hold. Everything else gets
   * read. */
  function isQualified(job, { includeBlocked = false } = {}) {
    const fit = job.fit;
    if (!fit || fit.fit_score === null) return false;
    if (job.status === 'closed') return false;
    if (job.citizenship_gated) return false;
    if (!includeBlocked && fit.eligibility && fit.eligibility.verdict === 'blocked') return false;
    return true;
  }

  // Upgrades job.title_class from cached local-model classifications, for jobs
  // the title regexes couldn't place. Profile-INDEPENDENT: it describes the
  // job, so it applies before scoring and survives profile changes. Entries
  // whose content hash no longer matches the posting are ignored — an edited
  // description must be re-judged, not silently trusted.
  function jobContentHash(job) {
    return fnv1a(`${job.title || ''} ${job.department || ''} ${job.description_text || ''}`);
  }

  function applyJobClassifications(jobs, classifyCache) {
    const entries = classifyCache && classifyCache.entries;
    if (!entries) return 0;
    let applied = 0;
    for (const job of jobs) {
      const entry = entries[job.id];
      if (!entry || !entry.title_class) continue;
      if (entry.content_hash !== jobContentHash(job)) continue;
      job.title_class = entry.title_class;
      job.title_class_source = 'llm';
      if (classifyCache.labels && classifyCache.labels[entry.title_class]) {
        job.title_class_label = classifyCache.labels[entry.title_class];
      }
      job.classified_requirements = entry.requirements || null;
      applied += 1;
    }
    return applied;
  }

  function verdictFor(score, hardGateFailed) {
    if (hardGateFailed) return 'stretch';
    for (const [tier, floor] of VERDICT_TIERS) {
      if (score >= floor) return tier;
    }
    return VERDICT_TIERS[VERDICT_TIERS.length - 1][0];
  }

  // Heat class for a PRE-penalty variant score (0..VARIANT_SCORE_MAX).
  function variantHeat(score) {
    for (const [band, floor] of VARIANT_HEAT_BANDS) {
      if (score >= floor) return band;
    }
    return 'h0';
  }

  function evidenceBonus(job) {
    const count = (job.class_evidence && job.class_evidence.certified_count_3y) || 0;
    for (const [threshold, bonus] of WEIGHTS.EVIDENCE_BONUS) {
      if (count >= threshold) return bonus;
    }
    return 0;
  }

  function scoreJob(job, compiled, verdictEntry) {
    const corpusRaw = collapseWhitespace(`${job.title || ''} ${job.department || ''} ${job.description_text || ''}`);
    const corpusLower = corpusRaw.toLowerCase();
    const titleLower = String(job.title || '').toLowerCase();
    // Skill/domain matching sees a bounded window (see SKILL_MATCH_WINDOW);
    // gates and avoid signals below keep the full corpus.
    const skillCorpus = corpusLower.slice(0, WEIGHTS.SKILL_MATCH_WINDOW);

    const variantScores = compiled.variants.map((variant) => scoreVariant(variant, skillCorpus, titleLower, job.title_class));
    const best = variantScores.reduce((a, b) => (b.score > a.score ? b : a), variantScores[0]);
    const routing = resolveVariant(variantScores, verdictEntry);

    // Reachability: demote + flag, never hide.
    const gateFinding = parseDegreeGateCollapsed(corpusRaw, job.title_class);
    let degreePenalty = 0;
    let degreeMet = true;
    if (gateFinding.required) {
      const requiredRank = DEGREE_RANK[gateFinding.required];
      degreeMet = compiled.completedRank >= requiredRank;
      if (!degreeMet) {
        if (gateFinding.softened) degreePenalty = WEIGHTS.DEGREE_GATE_SOFT;
        else if (compiled.inProgressRank >= requiredRank) degreePenalty = WEIGHTS.DEGREE_GATE_IN_PROGRESS;
        else degreePenalty = WEIGHTS.DEGREE_GATE_HARD;
      }
    }

    const citizenship = Boolean(job.citizenship_gated);
    const restrictedPenalty = citizenship ? WEIGHTS.CITIZENSHIP_GATE
      : job.veritas_state === 'RESTRICTED' ? WEIGHTS.RESTRICTED_LANGUAGE : 0;

    const stageMismatch = seniorityFlag(job.title, compiled.careerStage);
    const avoidHits = compiled.avoidRegexes
      .filter((entry) => entry.regex.test(corpusLower))
      .map((entry) => entry.signal);
    const avoidPenalty = Math.max(avoidHits.length * WEIGHTS.AVOID_SIGNAL, WEIGHTS.AVOID_CAP);

    const researchBonus = Math.round((job.research_relevance_score || 0) * WEIGHTS.RESEARCH_FACTOR);
    const evidence = evidenceBonus(job);

    const raw = (best ? best.score : 0)
      + researchBonus
      + evidence
      + degreePenalty
      + restrictedPenalty
      + avoidPenalty
      + (stageMismatch ? WEIGHTS.STAGE_MISMATCH : 0);
    const fitScore = Math.max(0, Math.min(100, raw));

    // Hard gates cap the verdict at "stretch": the job stays ranked by score,
    // but the label is honest about reachability.
    const hardGateFailed = citizenship || (gateFinding.required && !degreeMet && !gateFinding.softened && degreePenalty === WEIGHTS.DEGREE_GATE_HARD);
    const verdict = verdictFor(fitScore, hardGateFailed);

    const recommendedLabel = variantScores.find((variant) => variant.id === routing.recommended_variant);
    return {
      fit_score: fitScore,
      verdict,
      recommended_variant: routing.recommended_variant,
      recommended_source: routing.recommended_source,
      llm_reason: routing.llm_reason,
      ambiguous: routing.ambiguous,
      variants: variantScores,
      gate: {
        degree: {
          required: gateFinding.required,
          met: gateFinding.required ? degreeMet : true,
          softened: gateFinding.softened,
          source: gateFinding.source,
          evidence: gateFinding.evidence,
          penalty: degreePenalty
        },
        citizenship,
        stage_mismatch: stageMismatch
      },
      track: roleTrack(job, compiled),
      eligibility: assessEligibility(job, corpusRaw, gateFinding, compiled, degreeMet),
      avoid_hits: avoidHits,
      evidence_bonus: evidence,
      research_bonus: researchBonus,
      thin_text: String(job.description_text || '').length < WEIGHTS.THIN_TEXT_CHARS,
      fit_summary: `${verdict} fit${recommendedLabel ? ` — use: ${recommendedLabel.label}` : ''}`
    };
  }

  function scoreAll(jobs, compiled, routeCache) {
    if (!compiled) {
      for (const job of jobs) job.fit = emptyFit();
      return jobs;
    }
    const verdicts = (routeCache && routeCache.profile_hash === compiled.hash && routeCache.verdicts) || {};
    for (const job of jobs) {
      job.fit = scoreJob(job, compiled, verdicts[job.id]);
    }
    return jobs;
  }

  // Rank of a verdict tier in VERDICT_TIERS order (0 = strong). -1 for
  // unknown/absent, so callers can treat unscored jobs as "no verdict" rather
  // than accidentally ranking them best or worst.
  function verdictRank(tier) {
    return VERDICT_TIERS.findIndex(([name]) => name === tier);
  }

  // Short display initials per variant id ("data-engineer" -> "DE",
  // "bioinformatics" -> "BIO"). Collisions extend with further letters of the
  // flattened id, then a number — every variant gets a unique, stable code.
  function variantInitials(variants) {
    const out = {};
    const used = new Set();
    for (const variant of variants || []) {
      const id = String(variant?.id || '');
      if (!id || out[id]) continue;
      const tokens = id.split(/[-_]+/).filter(Boolean);
      const flat = tokens.join('').toUpperCase();
      const base = (tokens.length > 1 ? tokens.map((token) => token[0]).join('') : flat.slice(0, 3)).toUpperCase();
      let candidate = base;
      let extend = base.length + 1;
      let suffix = 2;
      while (used.has(candidate)) {
        if (extend <= flat.length) {
          candidate = flat.slice(0, extend);
          extend += 1;
        } else {
          candidate = `${base}${suffix}`;
          suffix += 1;
        }
      }
      out[id] = candidate;
      used.add(candidate);
    }
    return out;
  }

  const RadarScoring = {
    WEIGHTS,
    VERDICT_TIERS,
    DEGREE_RANK,
    verdictRank,
    variantInitials,
    compileProfile,
    scoreJob,
    scoreAll,
    parseDegreeGate,
    seniorityFlag,
    resolveVariant,
    assessEligibility,
    parseYearsRequirement,
    parseSponsorshipRefusal,
    parseLicenseRequirement,
    parseClearanceRequirement,
    parseStudentOnly,
    parseInternalOnly,
    roleTrack,
    isQualified,
    applyJobClassifications,
    jobContentHash,
    verdictFor,
    variantHeat,
    profileHash,
    fnv1a,
    surfaceForms,
    validateProfile,
    emptyFit
  };

  root.RadarScoring = RadarScoring;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = RadarScoring;
  }
})();
