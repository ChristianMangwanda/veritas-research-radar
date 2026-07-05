/**
 * Veritas Keyword Engine - Enhanced Edition
 * Analyzes job description text for visa sponsorship eligibility signals
 * Comprehensive patterns covering edge cases and nuanced language
 */

(function () {
  'use strict';

  const root = typeof window !== 'undefined' ? window : globalThis;

  // Create global namespace
  root.Veritas = root.Veritas || {};

  // Comprehensive keyword patterns for detecting visa restrictions and sponsorship
  const KEYWORDS = {
    RESTRICTED: [
      // Direct citizenship requirements
      /us\s+citi[sz]en(ship)?(\s+is)?\s+(required|only|must|necessary|needed)/gi,
      /must\s+be\s+(a\s+)?us\s+citi[sz]en/gi,
      /only\s+us\s+citi[sz]ens/gi,
      /exclusively\s+us\s+citi[sz]ens/gi,
      /\buscitizens?\b/gi,
      /american\s+citi[sz]ens?\s+only/gi,

      // Security clearance (implies citizenship)
      /security\s+clearance\s+(required|needed|necessary)/gi,
      /(secret|top\s+secret|ts\/sci)\s+(security\s+)?clearance/gi,
      /must\s+(be\s+able\s+to\s+)?(obtain|maintain|hold|possess)\s+(an?\s+)?(active\s+|current\s+)?security\s+clearance/gi,
      /clearable/gi,

      // Direct "no sponsorship" statements
      /no\s+(visa\s+)?sponsorship(\s+available|\s+provided)?/gi,
      /not\s+sponsoring/gi,
      /cannot\s+sponsor/gi,
      /will\s+not\s+sponsor/gi,
      /unable\s+to\s+sponsor/gi,
      /do(es)?\s+not\s+(provide\s+)?sponsor/gi,
      /not\s+eligible\s+for\s+(visa\s+)?sponsorship/gi,
      /no\s+h-?1b\s+sponsorship/gi,
      /not\s+providing\s+sponsorship/gi,
      /no\s+current\s+or\s+future.*sponsorship/gi,
      /no\s+sponsorship.*available/gi,
      /not\s+available\s+for\s+sponsorship/gi,
      /not\s+require\s+visa\s+support.*(h-?1b|opt|cpt|stem)/gi,
      /would\s+not\s+require\s+(visa\s+)?(support|sponsorship)/gi,
      /does\s+not\s+provide\s+(immigration\s+|visa\s+)?(sponsorship|support)/gi,
      /not\s+provide\s+immigration\s+sponsorship/gi,
      /(does|do|will)\s+not\s+commit\s+to\s+(providing\s+)?(visa\s+|immigration\s+)?sponsorship/gi,

      // Authorization without sponsorship requirements
      /must\s+be\s+authorized\s+to\s+work\s+without(\s+visa)?\s+sponsorship/gi,
      /legally\s+authorized\s+to\s+work\s+without\s+sponsorship/gi,
      /currently\s+authorized\s+to\s+work\s+without\s+sponsorship/gi,
      /authorized\s+to\s+work.*without.*sponsorship/gi,
      /work\s+authorization.*without.*sponsorship/gi,

      // Indefinite work authorization (implies permanent residence)
      /indefinite\s+(work\s+|legal\s+)?authorization/gi,
      /authorized\s+to\s+work.*indefinitely/gi,
      /authorization.*indefinitely.*required/gi,

      // Green card / permanent resident requirements
      /green\s+card\s+(holder\s+)?only/gi,
      /permanent\s+resident(s)?\s+only/gi,
      /green\s+card\s+(required|holders?\s+preferred)/gi,
      /must\s+(be\s+)?.*permanent\s+resident/gi,
      /lawful\s+permanent\s+resident.*required/gi,

      // Existing work authorization (strict)
      /must\s+(currently\s+)?have\s+work\s+authorization/gi,
      /require(s|d)?\s+(current\s+)?work\s+authorization/gi,
      /us\s+work\s+authorization\s+(is\s+)?required/gi,
      /proof\s+of\s+(us\s+)?work\s+authorization\s+required/gi,

      // Citizen or permanent resident (combined)
      /citi[sz]en\s+or\s+(lawful\s+)?permanent\s+resident/gi,
      /us\s+citi[sz]en\s+or\s+green\s+card/gi,

      // "Must be authorized" (catches various forms)
      /candidate\s+must\s+be\s+authorized\s+to\s+work/gi,
      /must\s+possess\s+unrestricted\s+work\s+authorization/gi,

      // No H-1B variations
      /no\s+h-?1b/gi,
      /not\s+accepting\s+h-?1b/gi,
      /h-?1b\s+not\s+available/gi,

      // Other restrictive phrases
      /sponsorship\s+(is\s+)?not\s+available/gi,
      /visa\s+sponsorship\s+is\s+not\s+available/gi,
      /not\s+providing\s+visa\s+support/gi,
      /(employer\s+)?work\s+permit\s+sponsorship\s+(is\s+)?not\s+available/gi,
      /will\s+not\s+(provide|offer|support)\s+(visa\s+)?(sponsorship|support)/gi,
      /do\s+not\s+offer.*sponsorship/gi,
      /not\s+(available|eligible).*\b(opt|cpt|optional\s+practical\s+training|curricular\s+practical\s+training)\b/gi,
      /\b(opt|cpt)\s+(is\s+)?not\s+(eligible|available|accepted)/gi,

      // US persons / export control (ITAR/EAR) - citizenship proxy common in research/defense labs
      /\bus\s+persons?\s+only\b/gi,
      /must\s+be\s+(a\s+)?us\s+person\b/gi,
      /\bitar\b/gi,
      /export\s+control(led)?\s+(laws?|regulations?|requirements?)/gi,
      /deemed\s+export/gi,
      /subject\s+to\s+(itar|ear|export\s+control)/gi,

      // Restrictive counterparts to specific work visas
      /not\s+(accepting|sponsoring)\s+(tn|e-?3|o-?1|l-?1|h-?1b)\b/gi,
      /(tn|e-?3)\s+visa\s+not\s+(accepted|available|supported)/gi

      // Deliberately NOT flagged: bare E-Verify participation. Nearly all US employers
      // use E-Verify, so it carries no sponsorship signal by itself; restrictive
      // E-Verify phrasings pair with "without sponsorship" language already caught above.
    ],

    FRIENDLY: [
      // Direct sponsorship offers
      /we\s+(will\s+)?sponsor/gi,
      /sponsorship\s+(is\s+|may\s+be\s+|will\s+be\s+)?(available|provided|offered|possible|considered)/gi,
      /visa\s+sponsorship\s+(is\s+|may\s+be\s+|will\s+be\s+)?(available|provided|offered|considered)/gi,
      /can\s+sponsor/gi,
      /able\s+to\s+sponsor/gi,
      /willing\s+to\s+sponsor/gi,
      /does\s+sponsor/gi,
      /offers?\s+(visa\s+)?sponsorship/gi,
      /provides?\s+(visa\s+)?sponsorship/gi,
      /sponsorship\s+opportunities\s+available/gi,

      // H-1B specific (positive)
      /h-?1b\s+(visa\s+)?(sponsorship|eligible|welcome|accepted|available)/gi,
      /sponsor(s|ing)?\s+(h-?1b|visa)/gi,
      /h-?1b\s+visa\s+support/gi,
      /petitions?\s+for\s+h-?1b/gi,
      /files?\s+h-?1b\s+petitions?/gi,
      /h-?1b\s+cap\s+exempt/gi,
      /will\s+file\s+h-?1b/gi,

      // Cap-exempt H-1B (universities, nonprofit research orgs — the phrase
      // only appears in sponsorship contexts; README promised this since v1.2
      // but the pattern was missing until the corpus caught it)
      /cap[-\s]?exempt/gi,

      // OPT/CPT direct mentions (require positive context)
      /opt\s*(\/|and|or)?\s*cpt\s+(eligible|welcome|accepted|students?)/gi,
      /\b(opt|cpt|stem\s+opt)\b[^.\n]{0,40}\b(welcome|encouraged)\b/gi,
      /f-?1\s+(opt|cpt)\s+(eligible|welcome|accepted)/gi,
      /stem\s+opt\s+(eligible|welcome|accepted|extension)/gi,
      /opt\s+extension\s+(available|eligible)/gi,

      // International student friendly
      /international\s+(students?|candidates?)\s+(are\s+)?(welcome|encouraged|eligible)/gi,
      /f-?1\s+visa\s+holders?\s+(are\s+)?(welcome|eligible|encouraged)/gi,
      /students?\s+on\s+f-?1\s+visa/gi,
      /opt\s+students?\s+(welcome|eligible)/gi,
      /welcomes?\s+international\s+(students?|candidates?)/gi,
      /international\s+applicants?\s+(welcome|encouraged)/gi,

      // Immigration support
      /immigration\s+(support|assistance|sponsorship)/gi,
      /visa\s+(support|assistance)/gi,
      /work\s+authorization\s+sponsorship/gi,
      /support.*visa.*process/gi,
      /assist(s|ance)?\s+with\s+(visa|immigration)/gi,
      /relocation\s+and\s+visa\s+support/gi,
      // Requires providing-context: bare "immigration services" is the name of
      // the federal agency (USCIS) and appears in citizen-only postings
      /(provides?|provided|offers?|offered|access\s+to)\s+immigration\s+services/gi,

      // TN visa (Canada/Mexico)
      /tn\s+visa/gi,
      /tn-?1\s+visa/gi,
      /nafta\s+professionals?/gi,

      // E-3 visa (Australia)
      /e-?3\s+visa/gi,

      // Other work visas
      /l-?1\s+visa/gi,
      /o-?1\s+visa/gi,
      /accepts?\s+(h-?1b|opt|cpt|tn|e-?3)/gi,

      // Sponsor qualified candidates
      /sponsor(s|ing)?\s+(qualified\s+)?(candidates?|applicants?)/gi,
      /provides?\s+work\s+authorization/gi,

      // Transfer sponsorship
      /transfer\s+h-?1b/gi,
      /h-?1b\s+transfer/gi,

      // Future sponsorship mentions
      /future\s+sponsorship/gi,
      /sponsorship\s+after/gi,

      // Positive authorization statements
      /open\s+to\s+(all\s+)?work\s+authorization\s+(types|statuses)/gi,
      /all\s+work\s+authorizations?\s+considered/gi,

      // Company-specific positive signals
      /global\s+mobility/gi,
      /immigration\s+team/gi
    ]
  };

  // Negation handling for BOTH match types. Looks only at text BEFORE the match,
  // within the same sentence/clause, so pattern-internal negators ("no visa
  // sponsorship", "without sponsorship") never suppress their own match.
  // Applying it to FRIENDLY matches matters just as much: "applicants should
  // not expect that such sponsorship will be offered" is a refusal, not an offer.
  const SENTENCE_BOUNDARY = /[.!?;:\n\r•|]/;
  const NEGATORS = [
    /\bno\b/i,
    /\bnot\b/i,
    /\bnever\b/i,
    /\bwithout\s+requiring\b/i,
    /\bregardless\s+of\b/i,
    /\beven\s+if\b/i,
    /\bunable\s+to\b/i,
    /\bcannot\b/i
  ];

  /**
   * Checks whether a match is preceded by a negator in the same clause
   * (e.g. "No security clearance required", "not subject to ITAR",
   * "should not expect that sponsorship will be offered")
   * @param {string} textContent - The full analyzed text
   * @param {number} matchIndex - Character offset of the match
   * @returns {boolean} True if the match should be suppressed
   */
  function isNegatedMatch(textContent, matchIndex) {
    const windowStart = Math.max(0, matchIndex - 80);
    const window = textContent.slice(windowStart, matchIndex);
    const clause = window.split(SENTENCE_BOUNDARY).pop();
    return NEGATORS.some(negator => negator.test(clause));
  }

  /**
   * Analyzes text content for visa eligibility keywords
   * @param {string} textContent - The text to analyze
   * @returns {Object} Analysis result with state and matches
   */
  root.Veritas.analyzeText = function (textContent) {
    if (!textContent || textContent.trim().length === 0) {
      return { state: 'NEUTRAL', matches: [] };
    }

    let state = 'NEUTRAL';
    let matches = [];

    // Priority: RESTRICTED > FRIENDLY (pessimistic approach for user safety)
    // Check for restrictions first
    for (const pattern of KEYWORDS.RESTRICTED) {
      const matchArray = [...textContent.matchAll(pattern)];
      matchArray.forEach(match => {
        if (isNegatedMatch(textContent, match.index)) {
          return;
        }
        state = 'RESTRICTED';
        matches.push({
          type: 'RESTRICTED',
          text: match[0],
          index: match.index
        });
      });
    }

    // Only check FRIENDLY if no restrictions found
    if (state === 'NEUTRAL') {
      for (const pattern of KEYWORDS.FRIENDLY) {
        const matchArray = [...textContent.matchAll(pattern)];
        matchArray.forEach(match => {
          if (isNegatedMatch(textContent, match.index)) {
            return;
          }
          state = 'FRIENDLY';
          matches.push({
            type: 'FRIENDLY',
            text: match[0],
            index: match.index
          });
        });
      }
    }

    return { state, matches };
  };

  /**
   * Extracts job description content from the current page
   * Uses multiple strategies to find the most relevant text
   * @returns {string} Extracted job description text
   */
  root.Veritas.extractJobDescription = function () {
    // Strategy 1: Look for common job description containers
    const selectors = [
      '[class*="description"]',
      '[class*="job-details"]',
      '[class*="jobDetails"]',
      '[id*="job-description"]',
      '[id*="jobDescription"]',
      '[class*="details"]',
      'article',
      'main'
    ];

    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (element && element.innerText.length > 200) {
        return element.innerText;
      }
    }

    // Fallback: Get all visible text from body
    // Filter out navigation, headers, footers
    const body = document.body.cloneNode(true);
    const elementsToRemove = body.querySelectorAll('nav, header, footer, script, style, [role="navigation"]');
    elementsToRemove.forEach(el => el.remove());

    return body.innerText || document.body.innerText || '';
  };

  root.Veritas.KEYWORDS = KEYWORDS;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      KEYWORDS,
      analyzeText: root.Veritas.analyzeText,
      isNegatedMatch,
      // Backwards-compatible alias for the pre-rename name
      isNegatedRestrictedMatch: isNegatedMatch
    };
  }

})();
