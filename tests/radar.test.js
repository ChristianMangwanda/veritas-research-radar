const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { analyzeText } = require('../scripts/keywords.js');
const { enrichJob, matchSignals, normalizeText } = require('../radar/scripts/refresh.js');
const { normalizeName, parseCsvLine } = require('../radar/scripts/import-dol-lca.js');

function testSharedAnalyzer() {
  assert.strictEqual(analyzeText('Visa sponsorship is available for this role.').state, 'FRIENDLY');
  assert.strictEqual(analyzeText('Applicants must be authorized to work without sponsorship.').state, 'RESTRICTED');
  assert.strictEqual(analyzeText('Build research data systems for a genomics lab.').state, 'NEUTRAL');
  // US persons / export control
  assert.strictEqual(analyzeText('Open to US persons only due to contract requirements.').state, 'RESTRICTED');
  assert.strictEqual(analyzeText('This role is subject to ITAR.').state, 'RESTRICTED');
  assert.strictEqual(analyzeText('Work is governed by export control regulations.').state, 'RESTRICTED');
  // Restrictive visa counterparts
  assert.strictEqual(analyzeText('We are not sponsoring TN or E-3 visas for this role.').state, 'RESTRICTED');
  // Bare E-Verify participation carries no sponsorship signal
  assert.strictEqual(analyzeText('This employer participates in E-Verify.').state, 'NEUTRAL');
  // Priority: RESTRICTED beats FRIENDLY
  assert.strictEqual(
    analyzeText('US citizenship is required. Visa sponsorship is available for other roles.').state,
    'RESTRICTED'
  );
}

function testNegationGuard() {
  // Negated restricted phrases must not flag the posting
  assert.strictEqual(analyzeText('No security clearance required for this role.').state, 'NEUTRAL');
  assert.strictEqual(analyzeText('This position is not subject to ITAR.').state, 'NEUTRAL');
  // Suppressed restricted matches fall through to FRIENDLY
  assert.strictEqual(
    analyzeText('No security clearance required. Visa sponsorship is available.').state,
    'FRIENDLY'
  );
  // Pattern-internal negators must NOT suppress their own match
  assert.strictEqual(analyzeText('No visa sponsorship available.').state, 'RESTRICTED');
  assert.strictEqual(analyzeText('We cannot sponsor and will not sponsor visas.').state, 'RESTRICTED');
  // Unnegated equivalents stay restricted
  assert.strictEqual(analyzeText('US citizenship is required.').state, 'RESTRICTED');
  assert.strictEqual(analyzeText('Security clearance required.').state, 'RESTRICTED');
  // Sentence boundary stops negator bleed from a prior clause
  assert.strictEqual(analyzeText('No exceptions: US citizenship is required.').state, 'RESTRICTED');
}

function testFixturePages() {
  const fixtureText = (name) => fs
    .readFileSync(path.join(__dirname, 'test-pages', name), 'utf8')
    .replace(/<[^>]+>/g, ' ');
  assert.strictEqual(analyzeText(fixtureText('job-restricted.html')).state, 'RESTRICTED');
  assert.strictEqual(analyzeText(fixtureText('job-friendly.html')).state, 'FRIENDLY');
  assert.strictEqual(analyzeText(fixtureText('job-neutral.html')).state, 'NEUTRAL');
}

function testSignalExtraction() {
  const signals = matchSignals('Research Software Engineer for genomics. H-1B cap-exempt position. International candidates welcome.');
  assert(signals.cap_exempt_language.length > 0);
  assert(signals.research_role_language.length > 0);
  assert(signals.international_candidate_language.length > 0);
}

function testNormalization() {
  assert.strictEqual(normalizeText('<p>Python &amp; genomics&nbsp;role</p>'), 'Python & genomics role');
  assert.strictEqual(normalizeName('The Broad Institute, Inc.'), 'BROAD INSTITUTE');
  assert.deepStrictEqual(parseCsvLine('"A, B",CERTIFIED,"Research Scientist"'), ['A, B', 'CERTIFIED', 'Research Scientist']);
}

function testEnrichment() {
  const employer = {
    id: 'broad-institute',
    name: 'Broad Institute',
    type: 'nonprofit_research_org',
    cap_exempt_status: 'likely',
    evidence_sources: ['manual'],
    ats_provider: 'greenhouse',
    ats_token: 'broadinstitute',
    research_areas: ['genomics']
  };
  const job = {
    id: 'greenhouse:broadinstitute:1',
    employer_id: 'broad-institute',
    title: 'Research Software Engineer',
    department: 'Data Science',
    location: 'Cambridge, MA',
    url: 'https://example.test/job',
    description_text: 'Python genomics role. H-1B cap-exempt position with visa sponsorship available.',
    posted_or_updated_at: null,
    source: 'greenhouse'
  };
  const enriched = enrichJob(job, employer, new Map(), {
    certified_count_3y: 12,
    recent_titles: ['Research Scientist']
  });
  assert.strictEqual(enriched.veritas_state, 'FRIENDLY');
  assert.strictEqual(enriched.sponsor_signal, 'strong');
  assert(enriched.research_relevance_score > 50);
  assert.strictEqual(enriched.cap_exempt_status, 'likely');
  assert.deepStrictEqual(enriched.dol_recent_titles, ['Research Scientist']);
}

testSharedAnalyzer();
testNegationGuard();
testFixturePages();
testSignalExtraction();
testNormalization();
testEnrichment();

console.log('Radar tests passed');
