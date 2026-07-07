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
    AMBIGUITY_FLOOR: 15
  };

  const VERDICT_TIERS = [['strong', 70], ['good', 55], ['moderate', 40], ['weak', 25], ['stretch', 0]];

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
      }
    }
    return null;
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
    let hash = 0x811c9dc5;
    for (let i = 0; i < canonical.length; i += 1) {
      hash ^= canonical.charCodeAt(i);
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
      for (const skill of variant.skills) {
        const weight = Math.min(3, Math.max(1, Math.round(skill.weight)));
        for (const phrase of [skill.term, ...(skill.aliases || [])]) {
          const lower = collapseWhitespace(phrase).toLowerCase();
          if (lower.length < 2) continue;
          const entry = entryFor(lower);
          if (!entry.skill) entry.skill = { term: skill.term, weight };
        }
      }
      for (const domain of variant.domains || []) {
        const lower = collapseWhitespace(domain).toLowerCase();
        if (lower.length < 2) continue;
        const entry = entryFor(lower);
        if (!entry.domain) entry.domain = lower;
      }
      const alternates = [...phraseEntries.keys()]
        .sort((a, b) => b.length - a.length) // longest first: alternation is leftmost-first
        .map(boundaryPattern);
      const targetTitles = (variant.target_titles || [])
        .map((title) => collapseWhitespace(title).toLowerCase())
        .filter((title) => title.length >= 2);
      return {
        id: variant.id,
        label: variant.label,
        order,
        titleClasses: variant.title_classes || [],
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

    return {
      profile: profileFile,
      hash: profileHash(profileFile),
      careerStage: core.career_stage || 'early_career',
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
      avoid_hits: [],
      evidence_bonus: 0,
      research_bonus: 0,
      fit_summary: message || 'Import your profile to rank jobs.'
    };
  }

  function scoreVariant(compiledVariant, corpusLower, titleLower, jobTitleClass) {
    const matched = { 3: [], 2: [], 1: [] };
    const domainHits = [];
    let skillPoints = 0;
    if (compiledVariant.matchRegex) {
      compiledVariant.matchRegex.lastIndex = 0;
      const seenTerms = new Set();
      const seenDomains = new Set();
      let match;
      while ((match = compiledVariant.matchRegex.exec(corpusLower)) !== null) {
        const entry = compiledVariant.phraseEntries.get(match[0]);
        if (!entry) continue;
        if (entry.skill && !seenTerms.has(entry.skill.term)) {
          seenTerms.add(entry.skill.term);
          matched[entry.skill.weight].push(entry.skill.term);
          skillPoints += WEIGHTS.SKILL_POINTS[entry.skill.weight];
        }
        if (entry.domain && !seenDomains.has(entry.domain)) {
          seenDomains.add(entry.domain);
          domainHits.push(entry.domain);
        }
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

  function verdictFor(score, hardGateFailed) {
    if (hardGateFailed) return 'stretch';
    for (const [tier, floor] of VERDICT_TIERS) {
      if (score >= floor) return tier;
    }
    return VERDICT_TIERS[VERDICT_TIERS.length - 1][0];
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

    const variantScores = compiled.variants.map((variant) => scoreVariant(variant, corpusLower, titleLower, job.title_class));
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
      avoid_hits: avoidHits,
      evidence_bonus: evidence,
      research_bonus: researchBonus,
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

  const RadarScoring = {
    WEIGHTS,
    VERDICT_TIERS,
    DEGREE_RANK,
    compileProfile,
    scoreJob,
    scoreAll,
    parseDegreeGate,
    seniorityFlag,
    resolveVariant,
    verdictFor,
    profileHash,
    validateProfile,
    emptyFit
  };

  root.RadarScoring = RadarScoring;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = RadarScoring;
  }
})();
