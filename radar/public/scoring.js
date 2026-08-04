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
    THIN_TEXT_CHARS: 500
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
    if (value.schema_version !== 2) return `expected schema_version 2 (got ${value.schema_version}) — re-run npm run radar:profile`;
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

    return {
      profile: profileFile,
      hash: profileHash(profileFile),
      careerStage: core.career_stage || 'early_career',
      yearsExperience: Number(core.years_experience) || 0,
      tracks: { primaryClasses, allClasses },
      completedRank,
      inProgressRank,
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
  const SOFTENER = /\b(preferred|desirable|a\s+plus|or\s+equivalent|equivalent\s+experience|nice\s+to\s+have|not\s+required|ideal(ly)?)\b/i;

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
        const softened = SOFTENER.test(clause);
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
    roleTrack,
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
