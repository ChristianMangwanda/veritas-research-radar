const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { analyzeText } = require('../scripts/keywords.js');
const {
  scoreFeedOwnership,
  stateOf,
  isAbbreviationOf
} = require('../radar/scripts/lib/feed-ownership.js');
const {
  detectAts,
  registrableDomain
} = require('../radar/scripts/resolve-employer-ats.js');
const {
  enrichJob,
  matchSignals,
  normalizeText,
  fetchJson,
  isRetryableFetchError,
  mapGreenhouseJob,
  mapLeverJob,
  mapAshbyJob,
  mapSmartRecruitersPosting,
  mapWorkdayJob,
  mapOracleJob,
  mapUltiproJob,
  mapTaleoJob,
  parseTaleoDetailPage,
  parseTaleoLocation,
  parseSuccessFactorsSitemap,
  parseSuccessFactorsJobPage,
  mapSuccessFactorsJob,
  mapEightfoldJob,
  mapPaylocityJob,
  parsePaylocityListPage,
  parsePaylocityDetailPage,
  mapInterfolioJob,
  mapGovernmentJobsJob,
  parseGovernmentJobsListPage,
  parseGovernmentJobsDetailPage,
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
  fetchEmployerJobs,
  runPooled,
  hostLane,
  createProviderPacer,
  parseSitemapUrls,
  extractJsonLdJobPosting,
  isChallengeResponse,
  pageUpTitleFromUrl,
  mapPageUpJob,
  mapAdpJob,
  adpLocation,
  fetchAdpJobs,
  validateEmployer,
  ATS_FETCHERS,
  mapCsodJob,
  csodLocation,
  csodPostedAt,
  extractCsodToken,
  fetchCsodJobs,
  mapIcimsJob,
  icimsTitleFromUrl,
  icimsSlugSegments,
  icimsDetailUrl,
  icimsCleanPosting,
  icimsJobPathsFromHtml,
  icimsPrefilterTitle,
  fetchIcimsJobs
} = require('../radar/scripts/refresh.js');
const {
  parseIpedsCsv,
  computeCapExemptScore,
  suggestStatus,
  buildDiscoveryCandidates
} = require('../radar/scripts/enrich.js');
const { createResolver: createEnrichResolver } = require('../radar/scripts/lib/entity-resolution.js');
const { validateScoutedFile, scoutedJobId, canonicalUrl, normalizeScoutedJob } = require('../radar/scripts/import-scouted.js');
const { resolveAggregatedJob, directoryLookup, pseudoEmployerId } = require('../radar/scripts/import-aggregated.js');
const { extractZipEntry, listZipEntries } = require('../radar/scripts/lib/zip.js');
const zlib = require('zlib');
const { normalizeName, parseCsvLine, annualWage, median } = require('../radar/scripts/import-dol-lca.js');
const { parseCsv, csvRecords } = require('../radar/scripts/lib/csv.js');
const { classifyTitle, classLabel } = require('../radar/scripts/lib/title-class.js');
const { parseSalary } = require('../radar/scripts/lib/salary.js');
const { parseDeadline } = require('../radar/scripts/lib/deadline.js');
const { parsePeopleAdminAtom, mapPeopleAdminEntry } = require('../radar/scripts/refresh.js');
const { jobRow, supabaseEnv, rehydrateJob } = require('../radar/scripts/lib/supabase.js');
const { createResolver, significantTokens } = require('../radar/scripts/lib/entity-resolution.js');
const { CLASS_LABELS } = require('../radar/scripts/lib/title-class.js');
const RadarScoring = require('../radar/public/scoring.js');
const RadarPipeline = require('../radar/public/pipeline.js');

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

async function testCsvMultilineRecords() {
  // Quoted fields containing newlines must parse as one record, not mis-split
  const text = 'NAME,STATUS,TITLE\n"Acme\nResearch, Inc.",CERTIFIED,"Staff ""Lead"" Scientist"\nPlain Org,DENIED,Analyst\n';
  assert.deepStrictEqual(parseCsv(text), [
    ['NAME', 'STATUS', 'TITLE'],
    ['Acme\nResearch, Inc.', 'CERTIFIED', 'Staff "Lead" Scientist'],
    ['Plain Org', 'DENIED', 'Analyst']
  ]);
  // CRLF record separators and blank lines
  assert.deepStrictEqual(parseCsv('a,b\r\n\r\nc,d\r\n'), [['a', 'b'], ['c', 'd']]);

  // Streaming shape: physical lines (as readline would emit them) rejoin into
  // whole records when a quoted field spans lines
  const physicalLines = ['NAME,TITLE', '"Acme', 'Research, Inc.","Postdoc', 'Fellow"', 'Plain Org,Analyst'];
  async function* emit() { yield* physicalLines; }
  const records = [];
  for await (const record of csvRecords(emit())) records.push(record);
  assert.deepStrictEqual(records, [
    ['NAME', 'TITLE'],
    ['Acme\nResearch, Inc.', 'Postdoc\nFellow'],
    ['Plain Org', 'Analyst']
  ]);
}

// Ground-truth labeled corpus: every case runs through the analyzer; exact
// cases must classify correctly, not_friendly cases pin known failure modes.
// Per-class precision/recall is printed so pattern edits show their effect.
function testAnalyzerCorpus() {
  const corpus = JSON.parse(fs.readFileSync(path.join(__dirname, 'analyzer-corpus.json'), 'utf8'));
  const stats = {
    RESTRICTED: { tp: 0, fp: 0, fn: 0 },
    FRIENDLY: { tp: 0, fp: 0, fn: 0 },
    NEUTRAL: { tp: 0, fp: 0, fn: 0 }
  };
  const failures = [];
  for (const testCase of corpus.cases) {
    const state = analyzeText(testCase.text).state;
    if (testCase.must === 'exact') {
      if (state !== testCase.label) failures.push(`${testCase.id}: expected ${testCase.label}, got ${state}`);
      if (state === testCase.label) stats[testCase.label].tp += 1;
      else {
        stats[testCase.label].fn += 1;
        if (stats[state]) stats[state].fp += 1;
      }
    } else if (testCase.must === 'not_friendly' && state === 'FRIENDLY') {
      failures.push(`${testCase.id}: must never be FRIENDLY (ground truth ${testCase.label})`);
    }
  }
  for (const [label, s] of Object.entries(stats)) {
    const total = s.tp + s.fn;
    if (!total) continue;
    const precision = s.tp + s.fp ? s.tp / (s.tp + s.fp) : 1;
    const recall = s.tp / total;
    console.log(`  corpus ${label}: precision ${(precision * 100).toFixed(0)}%, recall ${(recall * 100).toFixed(0)}% (n=${total})`);
  }
  assert.deepStrictEqual(failures, [], `analyzer corpus failures:\n${failures.join('\n')}`);
}

// The evidence engine only works if LCA rows and postings classify through
// ONE function — these cases pin the taxonomy on both real LCA titles and
// real posting titles from the dataset.
function testTitleClassEvidence() {
  assert.strictEqual(classifyTitle('Postdoctoral Scholar'), 'postdoc');
  assert.strictEqual(classifyTitle('Postdoc Fellow, Functional Genomics'), 'postdoc');
  assert.strictEqual(classifyTitle('Assistant Clinical Professor'), 'faculty');
  assert.strictEqual(classifyTitle('Research Software Engineer'), 'engineering_software');
  assert.strictEqual(classifyTitle('Computational Biologist'), 'data_computational');
  assert.strictEqual(classifyTitle('Staff Data Scientist, Genomics'), 'data_computational');
  assert.strictEqual(classifyTitle('Staff Scientist'), 'scientist');
  assert.strictEqual(classifyTitle('Research Associate II'), 'research_associate');
  assert.strictEqual(classifyTitle('Associate Specialist'), 'research_associate');
  assert.strictEqual(classifyTitle('Clinical Research Coordinator 1'), 'research_support');
  assert.strictEqual(classifyTitle('MEDICAL ONCOLOGY FELLOW (PGY-4)'), 'clinical');
  assert.strictEqual(classifyTitle('Registrar'), 'other');
  // 2.1 recall: staff data/analyst, developer, open-rank faculty
  assert.strictEqual(classifyTitle('School of Medicine - Open Rank - Neuro-oncology Research'), 'faculty');
  assert.strictEqual(classifyTitle('Open Rank'), 'faculty');
  assert.strictEqual(classifyTitle('Research Analyst, Neurological Surgery'), 'data_computational');
  assert.strictEqual(classifyTitle('Manager of Clinical Research Data Warehousing'), 'data_computational');
  assert.strictEqual(classifyTitle('Chief Research Informatics Officer'), 'data_computational');
  assert.strictEqual(classifyTitle('Python Developer'), 'engineering_software');
  assert.strictEqual(classifyTitle('Enterprise Application Developer II'), 'engineering_software');
  assert.strictEqual(classifyTitle('Staff HPC Engineer'), 'engineering_software');
  // Guard against over-broad matches: facilities/clerical stay in `other`
  assert.strictEqual(classifyTitle('Building Maintenance Mechanic'), 'other');
  assert.strictEqual(classifyTitle('Administrative Assistant'), 'other');
  assert.strictEqual(classifyTitle('Financial Analyst, Budget Office'), 'other');
  // SOC fallback for LCA rows whose title regexes miss
  assert.strictEqual(classifyTitle('Departmental Appointee', '25-1022.00'), 'faculty');
  assert.strictEqual(classifyTitle('Analyst IV', '15-2051.00'), 'data_computational');
  assert.strictEqual(classLabel('postdoc'), 'postdoc');

  // Wage annualization guards
  assert.strictEqual(annualWage('139000', 'Year'), 139000);
  assert.strictEqual(annualWage('40.50', 'Hour'), 84240);
  assert.strictEqual(annualWage('nonsense', 'Year'), null);
  assert.strictEqual(annualWage('50', 'Year'), null); // absurd annual filtered
  assert.strictEqual(median([30, 10, 20]), 20);
  assert.strictEqual(median([10, 20, 30, 40]), 25);
  assert.strictEqual(median([]), null);

  // enrichJob attaches the class bucket matching the posting title
  const employer = {
    id: 'ucsf', name: 'UCSF', type: 'institution_of_higher_education',
    cap_exempt_status: 'verified', evidence_sources: ['ipeds:123'],
    ats_provider: 'lever', ats_token: 'ucsf', research_areas: []
  };
  const job = {
    id: 'lever:ucsf:1', employer_id: 'ucsf', title: 'Postdoctoral Scholar - Neurology',
    department: '', location: 'San Francisco', url: 'https://example.test/1',
    description_text: 'Conduct research in the lab.', posted_or_updated_at: null, source: 'lever'
  };
  const enriched = enrichJob(job, employer, new Map(), {
    certified_count_3y: 161,
    recent_titles: ['Postdoctoral Scholar'],
    title_classes: {
      postdoc: { certified_count_3y: 37, median_annual_wage: 71000, sample_titles: ['Postdoctoral Scholar'] },
      clinical: { certified_count_3y: 80, median_annual_wage: 160000, sample_titles: ['Clinical Resident'] }
    }
  });
  assert.strictEqual(enriched.title_class, 'postdoc');
  assert.deepStrictEqual(enriched.class_evidence, {
    certified_count_3y: 37, median_annual_wage: 71000, sample_titles: ['Postdoctoral Scholar']
  });
  assert.strictEqual(enriched.sponsor_signal, 'strong'); // class-level >= 3

  // No class evidence -> institution-wide count alone caps at moderate
  const noClass = enrichJob({ ...job, title: 'Grants Administrator' }, employer, new Map(), {
    certified_count_3y: 161, recent_titles: [], title_classes: {}
  });
  assert.strictEqual(noClass.title_class, 'other');
  assert.strictEqual(noClass.class_evidence, null);
  assert.strictEqual(noClass.sponsor_signal, 'moderate'); // 161 institution-wide, wrong class
}

function testPeopleAdminAdapter() {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Example University: All Jobs</title>
  <entry>
    <id>https://example.peopleadmin.com/postings/12345</id>
    <published>2026-07-01T10:00:00-04:00</published>
    <link rel="alternate" type="text/html" href="https://example.peopleadmin.com/postings/12345"/>
    <title>Research Technician &amp; Lab Manager</title>
    <content>&lt;div&gt;Join the &lt;strong&gt;genomics&lt;/strong&gt; lab. Visa sponsorship is available.&lt;/div&gt;</content>
    <author><name>Biology - 101</name></author>
  </entry>
  <entry>
    <id>https://example.peopleadmin.com/postings/12346</id>
    <link rel="alternate" type="text/html" href="https://example.peopleadmin.com/postings/12346"/>
    <title>Groundskeeper</title>
    <content>&lt;p&gt;Maintain campus grounds.&lt;/p&gt;</content>
  </entry>
</feed>`;
  const entries = parsePeopleAdminAtom(xml);
  assert.strictEqual(entries.length, 2);
  assert.strictEqual(entries[0].title, 'Research Technician & Lab Manager');
  assert.strictEqual(entries[0].author, 'Biology - 101');
  assert.strictEqual(entries[1].published, null);

  const employer = { id: 'example-university', ats_token: 'example' };
  const job = mapPeopleAdminEntry(entries[0], employer);
  assert.strictEqual(job.id, 'peopleadmin:example:12345');
  assert.strictEqual(job.department, 'Biology - 101');
  assert.strictEqual(job.description_text, 'Join the genomics lab. Visa sponsorship is available.');
  assert.strictEqual(job.source, 'peopleadmin');
  assert.strictEqual(job.posted_or_updated_at, '2026-07-01T10:00:00-04:00');
}

function testSupabaseSink() {
  // Sink stays dormant without credentials — refresh must not need Supabase
  const savedUrl = process.env.SUPABASE_URL;
  const savedKey = process.env.SUPABASE_SERVICE_KEY;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_KEY;
  assert.strictEqual(supabaseEnv(), null);
  if (savedUrl) process.env.SUPABASE_URL = savedUrl;
  if (savedKey) process.env.SUPABASE_SERVICE_KEY = savedKey;

  const row = jobRow({
    id: 'lever:ucsf:1', employer_id: 'ucsf', employer_name: 'UCSF',
    title: 'Postdoc', title_class: 'postdoc', url: 'https://x.test/1',
    citizenship_gated: false, status: 'active', source: 'lever',
    first_seen_at: '2026-07-01T00:00:00Z', posted_or_updated_at: '',
    class_evidence: { certified_count_3y: 3 }
  }, '2026-07-06T00:00:00Z');
  assert.strictEqual(row.id, 'lever:ucsf:1');
  assert.strictEqual(row.title_class, 'postdoc');
  assert.strictEqual(row.citizenship_gated, false);
  // Empty posted dates become SQL NULL, not empty strings (timestamptz rejects '')
  assert.strictEqual(row.posted_or_updated_at, null);
  assert.deepStrictEqual(row.class_evidence, { certified_count_3y: 3 });
  assert.strictEqual(row.payload.id, 'lever:ucsf:1');
  assert.strictEqual(row.updated_at, '2026-07-06T00:00:00Z');

  // The description is stored once (its own column), not twice. It is ~59% of
  // a serialized job, so duplicating it nearly doubled the table.
  const withDescription = jobRow({
    id: 'lever:ucsf:2', employer_id: 'ucsf', title: 'Research Scientist',
    description_text: 'Long posting body about a genomics lab.', status: 'active'
  }, '2026-07-06T00:00:00Z');
  assert.strictEqual(withDescription.description_text, 'Long posting body about a genomics lab.');
  assert.strictEqual('description_text' in withDescription.payload, false, 'payload must not duplicate the description');

  // ...and a row round-trips back to a whole job.
  const restored = rehydrateJob(withDescription);
  assert.strictEqual(restored.description_text, 'Long posting body about a genomics lab.');
  assert.strictEqual(restored.id, 'lever:ucsf:2');
  assert.strictEqual(restored.title, 'Research Scientist');

  // Rows written before the change keep the description inside payload; those
  // must still read back correctly (the column is authoritative when present).
  const legacy = { payload: { id: 'old:1', description_text: 'legacy body' }, description_text: null };
  assert.strictEqual(rehydrateJob(legacy).description_text, 'legacy body', 'legacy rows must still rehydrate');
  const both = { payload: { id: 'x', description_text: 'stale' }, description_text: 'fresh' };
  assert.strictEqual(rehydrateJob(both).description_text, 'fresh', 'the column wins over a stale payload copy');

  // The description must survive the round trip byte-for-byte: the match cache
  // is keyed on a hash of it, so any drift silently invalidates every judgment.
  const body = 'PhD required.\n\n  Spaces & "quotes" — em-dash, ünïcode, \ttab.';
  assert.strictEqual(
    rehydrateJob(jobRow({ id: 'z', description_text: body }, 'now')).description_text,
    body,
    'description must round-trip unchanged'
  );

  // Job ids are colon-composed, and a bare colon ends a PostgREST value. An
  // unquoted list does not error — it matches nothing, which for a DELETE means
  // the rows silently stay behind.
  const { inList } = require('../radar/scripts/lib/supabase.js');
  assert.strictEqual(inList(['workday:cornell:WDR-1']), '("workday:cornell:WDR-1")');
  assert.strictEqual(inList(['a', 'b']), '("a","b")');
  assert.strictEqual(inList(['say "hi"']), '("say ""hi""")', 'embedded quotes are doubled');
}

function testSyncDiff() {
  const { diffJobs, comparableRow, stableStringify, rehydrateJob, jobRow } = require('../radar/scripts/lib/supabase.js');

  const job = (over = {}) => ({
    id: 'lever:ucsf:1', employer_id: 'ucsf', employer_name: 'UCSF', title: 'Postdoc',
    description_text: 'Genomics lab.', status: 'active', source: 'lever',
    first_seen_at: '2026-07-01T00:00:00Z', last_seen_at: '2026-08-01T00:00:00Z',
    citizenship_gated: false,
    provenance: { job_source: 'lever', ats_provider: 'lever', fetched_at: '2026-08-01T00:00:00Z' },
    ...over
  });

  // stableStringify has to match JSON.stringify's treatment of undefined,
  // because the write path is JSON.stringify — comparing against anything the
  // write would not produce manufactures permanent "changed" rows.
  assert.strictEqual(stableStringify({ a: undefined, b: 1 }), '{"b":1}');
  assert.strictEqual(stableStringify({ b: 1, a: 2 }), stableStringify({ a: 2, b: 1 }), 'key order must not matter');
  assert.notStrictEqual(stableStringify([1, 2]), stableStringify([2, 1]), 'array order still matters');

  // THE LOAD-BEARING CASE. Previous rows come back out of a jsonb column and
  // Postgres does not preserve jsonb key order; fresh jobs carry insertion
  // order. Compared naively every row looks changed on every run.
  const shuffled = {};
  for (const key of Object.keys(job()).reverse()) shuffled[key] = job()[key];
  assert.strictEqual(comparableRow(job()), comparableRow(shuffled), 'key order must not count as a change');

  // These two are restamped by enrichJob on every single fetch and read by
  // nobody. Counting them would rewrite all ~18,000 active jobs every run.
  const reseen = job({
    last_seen_at: '2026-08-15T00:00:00Z',
    provenance: { job_source: 'lever', ats_provider: 'lever', fetched_at: '2026-08-15T00:00:00Z' }
  });
  assert.strictEqual(comparableRow(job()), comparableRow(reseen), 'being seen again is not a change');
  assert.deepStrictEqual(diffJobs([job()], [reseen]), { upserts: [], deleteIds: [], unchanged: 1 });

  // Real content changes still write.
  for (const change of [{ description_text: 'Different body.' }, { title: 'Research Scientist' }, { status: 'closed', closed_at: '2026-08-10T00:00:00Z' }]) {
    const diff = diffJobs([job()], [job(change)]);
    assert.strictEqual(diff.upserts.length, 1, `${Object.keys(change)[0]} must be written`);
    assert.strictEqual(diff.unchanged, 0);
  }

  // A legacy row (description still inside payload) against the equivalent
  // fresh job is NOT a change — both sides are compared as built rows.
  const legacyStored = rehydrateJob({
    payload: { ...jobRow(job(), null).payload, description_text: 'Genomics lab.' },
    description_text: null
  });
  assert.strictEqual(comparableRow(legacyStored), comparableRow(job()), 'row generation is not a content change');

  // A closed tombstone is a ROW in the table until it ages out: stable across
  // runs, so neither rewritten nor deleted. Deleting it would resurrect the
  // posting as "new" on the next refresh.
  const tombstone = job({ status: 'closed', closed_at: '2026-08-01T00:00:00Z' });
  assert.deepStrictEqual(diffJobs([tombstone], [tombstone]), { upserts: [], deleteIds: [], unchanged: 1 });

  // Gone from the run's dataset entirely → deleted by id.
  const other = job({ id: 'lever:ucsf:2' });
  const removed = diffJobs([job(), other], [job()]);
  assert.deepStrictEqual(removed.deleteIds, ['lever:ucsf:2']);
  assert.strictEqual(removed.unchanged, 1);

  // New id → upsert, nothing deleted.
  const added = diffJobs([job()], [job(), other]);
  assert.deepStrictEqual(added.upserts.map((j) => j.id), ['lever:ucsf:2']);
  assert.deepStrictEqual(added.deleteIds, []);

  // No trustworthy baseline: write everything, delete NOTHING. This is the
  // bootstrap shape, and it must never remove a row we simply failed to read.
  const bootstrap = diffJobs(null, [job(), other]);
  assert.strictEqual(bootstrap.upserts.length, 2);
  assert.deepStrictEqual(bootstrap.deleteIds, []);

  // Duplicate ids within one run collapse before the upsert — two rows with the
  // same id make Postgres reject the whole batch.
  const duped = diffJobs(null, [job(), job({ title: 'Later wins' })]);
  assert.strictEqual(duped.upserts.length, 1);
  assert.strictEqual(duped.upserts[0].title, 'Later wins');
}

async function testSyncJobsWrites() {
  const { syncJobs } = require('../radar/scripts/lib/supabase.js');
  const savedUrl = process.env.SUPABASE_URL;
  const savedKey = process.env.SUPABASE_SERVICE_KEY;
  process.env.SUPABASE_URL = 'https://x.supabase.co';
  process.env.SUPABASE_SERVICE_KEY = 'service-key';
  const originalFetch = globalThis.fetch;

  const job = (id, over = {}) => ({
    id, employer_id: 'e', title: 'Postdoc', description_text: 'body', status: 'active',
    last_seen_at: '2026-08-01T00:00:00Z',
    provenance: { fetched_at: '2026-08-01T00:00:00Z' },
    ...over
  });

  try {
    // 240 changed rows go out in batches of 100, sequentially, and the DELETE
    // only happens once every one of them has landed. The reverse order could
    // remove a posting whose replacement never arrived.
    let calls = [];
    let inFlight = 0;
    globalThis.fetch = async (url, init) => {
      inFlight += 1;
      assert.strictEqual(inFlight, 1, 'writes must not overlap — this database minds concurrency');
      const body = init.body ? JSON.parse(init.body) : null;
      calls.push({ method: init.method, url: String(url), size: Array.isArray(body) ? body.length : null });
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return { ok: true, status: 200, text: async () => '', json: async () => [] };
    };

    const previous = Array.from({ length: 260 }, (_, i) => job(`j:${i}`));
    const next = [
      ...Array.from({ length: 240 }, (_, i) => job(`j:${i}`, { title: 'Changed' })),
      ...Array.from({ length: 20 }, (_, i) => job(`j:${i + 240}`))
    ];
    const report = { refreshed_at: '2026-08-15T00:00:00Z' };
    const result = await syncJobs(next, report, { previous });

    assert.strictEqual(result.upserted, 240);
    assert.strictEqual(result.unchanged, 20, 'the untouched rows must not be rewritten');
    assert.strictEqual(result.deleted, 0);
    const upserts = calls.filter((c) => c.method === 'POST' && c.url.includes('/jobs'));
    assert.deepStrictEqual(upserts.map((c) => c.size), [100, 100, 40]);
    assert.deepStrictEqual(report.supabase_sync,
      { mode: 'diff', upserted: 240, deleted: 0, unchanged: 20, total: 260 });
    // The old sweep is gone: nothing may delete by timestamp.
    assert(!calls.some((c) => /updated_at=lt/.test(c.url)), 'the timestamp sweep must not come back');

    // Departed rows are deleted by an explicit, quoted id list, after the
    // upserts. Ids are colon-composed, so an unquoted list matches nothing.
    calls = [];
    await syncJobs([job('workday:cornell:1')], null,
      { previous: [job('workday:cornell:1'), job('workday:cornell:2')] });
    const deletes = calls.filter((c) => c.method === 'DELETE');
    assert.strictEqual(deletes.length, 1);
    assert(/id=in\./.test(deletes[0].url), 'deletes go by id list');
    assert(/%22workday%3Acornell%3A2%22/.test(deletes[0].url), `colon-composed ids must be quoted (${deletes[0].url})`);

    // Telemetry is not data. If the refresh_runs insert fails after the jobs
    // are correct, the sync still succeeded — failing here would skip judging
    // for no reason worth having.
    globalThis.fetch = async (url, init) => {
      if (String(url).includes('/refresh_runs')) return { ok: false, status: 500, text: async () => 'nope' };
      return { ok: true, status: 200, text: async () => '', json: async () => [] };
    };
    const telemetryReport = { refreshed_at: '2026-08-15T00:00:00Z' };
    const stillOk = await syncJobs([job('a')], telemetryReport, { previous: [job('a')] });
    assert.strictEqual(stillOk.synced, true, 'a telemetry failure must not fail the sync');
    assert.strictEqual(telemetryReport.refresh_run_recorded, false, 'but it must be recorded');

    // A failing jobs upsert DOES reject, so refresh.js can mark the run failed.
    globalThis.fetch = async () => ({ ok: false, status: 400, text: async () => 'malformed' });
    await assert.rejects(() => syncJobs([job('a', { title: 'new' })], null, { previous: [job('a')] }), /400/);

    // No credentials: dormant, never a partial write.
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_KEY;
    const skipped = await syncJobs([job('a')], null);
    assert.strictEqual(skipped.synced, false);
  } finally {
    globalThis.fetch = originalFetch;
    if (savedUrl) process.env.SUPABASE_URL = savedUrl; else delete process.env.SUPABASE_URL;
    if (savedKey) process.env.SUPABASE_SERVICE_KEY = savedKey; else delete process.env.SUPABASE_SERVICE_KEY;
  }
}

async function testFetchAllJobsKeyset() {
  const { fetchAllJobs } = require('../radar/scripts/lib/supabase.js');
  const savedUrl = process.env.SUPABASE_URL;
  const savedKey = process.env.SUPABASE_SERVICE_KEY;
  process.env.SUPABASE_URL = 'https://x.supabase.co';
  process.env.SUPABASE_SERVICE_KEY = 'service-key';
  const originalFetch = globalThis.fetch;
  const paths = [];
  const rowsFor = (from, count) => Array.from({ length: count }, (_, i) => ({
    id: `job:${String(from + i).padStart(5, '0')}`,
    payload: { id: `job:${String(from + i).padStart(5, '0')}`, title: 'T' },
    description_text: 'body'
  }));

  try {
    // Two full pages then a short one. OFFSET made Postgres walk and discard
    // every row before the window; cursoring on the primary key does not.
    let page = 0;
    globalThis.fetch = async (url) => {
      paths.push(String(url));
      const batch = page === 0 ? rowsFor(0, 500) : page === 1 ? rowsFor(500, 500) : rowsFor(1000, 3);
      page += 1;
      return { ok: true, status: 200, json: async () => batch, text: async () => '' };
    };
    const jobs = await fetchAllJobs();
    assert.strictEqual(jobs.length, 1003);
    assert.strictEqual(paths.length, 3);
    assert(!paths.some((p) => /offset=/.test(p)), 'deep OFFSET is what timed out — it must be gone');
    assert(/select=id%2Cpayload%2Cdescription_text|select=id,payload,description_text/.test(paths[0]),
      'the id column must be selected, since it is the cursor');
    assert(!/id=gt\./.test(paths[0]), 'the first page has no cursor');
    assert(/id=gt\.job%3A00499/.test(paths[1]), `page 2 must resume after the last id seen (${paths[1]})`);
    assert(/id=gt\.job%3A00999/.test(paths[2]));

    // An empty table returns null, NOT []. refresh.js's lifecycle guard depends
    // on telling "nothing there" apart from "read it and it was empty".
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => [], text: async () => '' });
    assert.strictEqual(await fetchAllJobs(), null);

    // A page that fails is retried rather than collapsing the read to empty.
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      if (calls === 1) return { ok: false, status: 500, text: async () => 'boom' };
      return { ok: true, status: 200, json: async () => rowsFor(0, 2), text: async () => '' };
    };
    const retried = await fetchAllJobs();
    assert.strictEqual(retried.length, 2);
    assert.strictEqual(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
    if (savedUrl) process.env.SUPABASE_URL = savedUrl; else delete process.env.SUPABASE_URL;
    if (savedKey) process.env.SUPABASE_SERVICE_KEY = savedKey; else delete process.env.SUPABASE_SERVICE_KEY;
  }
}

function testEntityResolution() {
  const resolver = createResolver([
    { id: 'broad-institute', name: 'Broad Institute', aliases: ['Broad Institute of MIT and Harvard'] },
    { id: 'university-of-chicago', name: 'University of Chicago' },
    { id: 'mayo-clinic', name: 'Mayo Clinic', aliases: ['Mayo Foundation for Medical Education and Research'] },
    { id: 'fred-hutch', name: 'Fred Hutchinson Cancer Center' },
    { id: 'columbia-university', name: 'Columbia University' }
  ]);
  const expect = (raw, id, strategy) => {
    const result = resolver.resolve(raw);
    assert.strictEqual(result.matched?.id ?? null, id, `resolve(${raw}) -> ${result.matched?.id} (${result.strategy})`);
    if (strategy) assert.strictEqual(result.strategy, strategy, `strategy for ${raw}`);
  };

  expect('THE BROAD INSTITUTE INC', 'broad-institute', 'exact');
  expect('Broad Institute of MIT and Harvard', 'broad-institute', 'alias');
  expect('THE UNIVERSITY OF CHICAGO', 'university-of-chicago', 'exact');
  expect('CHICAGO UNIVERSITY', 'university-of-chicago', 'token_set');
  expect('MAYO FOUNDATION FOR MEDICAL EDUCATION AND RESEARCH', 'mayo-clinic', 'alias');
  // Insertion in the middle -> weak overlap match only
  const hutch = resolver.resolve('FRED HUTCHINSON CANCER RESEARCH CENTER');
  assert.strictEqual(hutch.matched?.id, 'fred-hutch');
  assert.strictEqual(hutch.strategy, 'token_overlap');
  assert(hutch.confidence < 0.75, 'insertion match must stay below the scoring gate');
  // Containment with a qualifier suffix
  expect('FRED HUTCHINSON CANCER CENTER SOUTH LAKE UNION', 'fred-hutch', 'containment');
  // False-positive traps
  expect('MAYODAN INDUSTRIES INC', null);
  expect('COLUMBIA SPORTSWEAR COMPANY', null);
  expect('MAYO CLINIC OF SCOTTSDALE', 'mayo-clinic', 'containment');
  assert.deepStrictEqual(significantTokens('The University of Chicago'), ['UNIVERSITY', 'CHICAGO']);
}

function testProviderMappers() {
  const employer = { id: 'example-org', ats_token: 'exampleorg' };

  const greenhouse = mapGreenhouseJob({
    id: 42,
    title: 'Research Engineer',
    departments: [{ name: 'Platform' }],
    offices: [{ location: 'Cambridge, MA' }],
    absolute_url: 'https://boards.greenhouse.io/exampleorg/jobs/42',
    content: '<p>Genomics &amp; pipelines</p>',
    updated_at: '2026-07-01T00:00:00Z'
  }, employer);
  assert.strictEqual(greenhouse.id, 'greenhouse:exampleorg:42');
  assert.strictEqual(greenhouse.location, 'Cambridge, MA');
  assert.strictEqual(greenhouse.description_text, 'Genomics & pipelines');
  assert.strictEqual(greenhouse.source, 'greenhouse');

  const lever = mapLeverJob({
    id: 'abc-123',
    text: 'Data Scientist',
    categories: { team: 'Science', location: 'Seattle, WA' },
    hostedUrl: 'https://jobs.lever.co/exampleorg/abc-123',
    descriptionPlain: 'Single-cell analysis role',
    createdAt: 1751500800000
  }, employer);
  assert.strictEqual(lever.id, 'lever:exampleorg:abc-123');
  assert.strictEqual(lever.department, 'Science');
  assert.strictEqual(lever.posted_or_updated_at, new Date(1751500800000).toISOString());
  assert.strictEqual(lever.source, 'lever');

  const ashby = mapAshbyJob({
    id: 'uuid-1',
    title: 'ML Engineer',
    department: 'Research',
    team: 'Core',
    location: 'San Francisco',
    isRemote: true,
    isListed: true,
    publishedAt: '2026-06-30T12:00:00+00:00',
    jobUrl: 'https://jobs.ashbyhq.com/exampleorg/uuid-1',
    descriptionHtml: '<div>Deep learning research</div>'
  }, employer);
  assert.strictEqual(ashby.id, 'ashby:exampleorg:uuid-1');
  assert.strictEqual(ashby.location, 'San Francisco (Remote)');
  assert.strictEqual(ashby.description_text, 'Deep learning research');
  assert.strictEqual(ashby.source, 'ashby');

  const smartrecruiters = mapSmartRecruitersPosting({
    id: '743999',
    name: 'Research Associate',
    department: { label: 'Immunology' },
    location: { city: 'San Diego', region: 'CA', country: 'us', remote: false, fullLocation: 'San Diego, CA, United States' },
    releasedDate: '2026-06-01T00:00:00.000Z'
  }, {
    postingUrl: 'https://jobs.smartrecruiters.com/ExampleOrg/743999-research-associate',
    jobAd: {
      sections: {
        jobDescription: { text: '<p>Run assays</p>' },
        qualifications: { text: '<p>BS in Biology</p>' }
      }
    }
  }, employer);
  assert.strictEqual(smartrecruiters.id, 'smartrecruiters:exampleorg:743999');
  assert.strictEqual(smartrecruiters.title, 'Research Associate');
  assert.strictEqual(smartrecruiters.department, 'Immunology');
  assert.strictEqual(smartrecruiters.description_text, 'Run assays BS in Biology');
  assert.strictEqual(smartrecruiters.url, 'https://jobs.smartrecruiters.com/ExampleOrg/743999-research-associate');
  assert.strictEqual(smartrecruiters.source, 'smartrecruiters');

  const workdayEmployer = {
    id: 'example-university',
    ats_token: 'exampleu',
    ats_config: { host: 'exampleu.wd5.myworkdayjobs.com', tenant: 'exampleu', site: 'External' },
    research_areas: ['economics']
  };
  const workday = mapWorkdayJob({
    title: 'Research Data Analyst',
    externalPath: '/job/Chicago/Research-Data-Analyst_JR1234',
    locationsText: 'Illinois: Chicago',
    bulletFields: ['JR1234']
  }, {
    title: 'Research Data Analyst',
    location: 'Illinois: Chicago',
    startDate: '2026-07-02',
    jobReqId: 'JR1234',
    externalUrl: 'https://exampleu.wd5.myworkdayjobs.com/External/job/Chicago/Research-Data-Analyst_JR1234',
    jobDescription: '<p><b>Department</b></p>Economics Lab<p>Analyze research data.</p>'
  }, workdayEmployer);
  assert.strictEqual(workday.id, 'workday:exampleu:JR1234');
  assert.strictEqual(workday.posted_or_updated_at, '2026-07-02T00:00:00.000Z');
  assert.strictEqual(workday.description_text, 'Department Economics Lab Analyze research data.');
  assert.strictEqual(workday.source, 'workday');
  // Detail fetch failed -> mapper still produces a usable record from the list item
  const workdayNoDetail = mapWorkdayJob({
    title: 'Postdoctoral Scholar',
    externalPath: '/job/Chicago/Postdoc_JR9',
    locationsText: 'Illinois: Chicago',
    bulletFields: ['JR9']
  }, undefined, workdayEmployer);
  assert.strictEqual(workdayNoDetail.id, 'workday:exampleu:JR9');
  assert.strictEqual(workdayNoDetail.url, 'https://exampleu.wd5.myworkdayjobs.com/External/job/Chicago/Postdoc_JR9');

  // Oracle Fusion HCM CandidateExperience: list item + detail record
  const oracleEmployer = {
    id: 'exampleu-oracle',
    ats_token: 'exampleu',
    ats_config: { host: 'careers.exampleu.edu', site_name: 'exampleu', site_number: 'CX_1' },
    research_areas: ['genomics']
  };
  const oracle = mapOracleJob({
    Id: '200251',
    Title: 'Life Science Research Professional',
    PrimaryLocation: 'Stanford, CA, United States',
    PostedDate: '2026-07-10',
    secondaryLocations: [{ Name: 'Redwood City, CA, United States' }]
  }, {
    ExternalDescriptionStr: '<p>Run assays.</p>',
    ExternalQualificationsStr: '<p>PhD preferred.</p>',
    ExternalPostedStartDate: '2026-07-10',
    ExternalPostedEndDate: '2026-08-15',
    Organization: 'School of Medicine'
  }, oracleEmployer);
  assert.strictEqual(oracle.id, 'oracle:exampleu:200251');
  assert.strictEqual(oracle.source, 'oracle');
  assert.strictEqual(oracle.url, 'https://careers.exampleu.edu/hcmUI/CandidateExperience/en/sites/exampleu/job/200251');
  assert.strictEqual(oracle.location, 'Stanford, CA, United States; Redwood City, CA, United States');
  assert.strictEqual(oracle.description_text, 'Run assays. PhD preferred.');
  assert.strictEqual(oracle.posted_or_updated_at, '2026-07-10T00:00:00.000Z');
  // Oracle exposes a structured close date -> carried as deadline_raw
  assert.strictEqual(oracle.deadline_raw, '2026-08-15');
  // Detail fetch failed -> mapper still produces a usable record from the list item
  const oracleNoDetail = mapOracleJob({
    Id: '9',
    Title: 'Postdoctoral Scholar',
    PrimaryLocation: 'Stanford, CA, United States',
    PostedDate: '2026-07-01'
  }, null, oracleEmployer);
  assert.strictEqual(oracleNoDetail.id, 'oracle:exampleu:9');
  assert.strictEqual(oracleNoDetail.description_text, '');
  assert.strictEqual(oracleNoDetail.deadline_raw, null);
  assert.strictEqual(oracleNoDetail.url, 'https://careers.exampleu.edu/hcmUI/CandidateExperience/en/sites/exampleu/job/9');

  // UltiPro / UKG JobBoard: LoadSearchResults opportunity carries BriefDescription
  // and rich Locations inline, so the mapper needs no per-job detail record.
  const ultiproEmployer = {
    id: 'salk-institute',
    ats_token: 'salk',
    ats_config: { host: 'recruiting2.ultipro.com', tenant: 'SAL1013SIBS' },
    research_areas: ['genomics']
  };
  const ultipro = mapUltiproJob({
    Id: 'ffcfe13a-79d1-460e-b9d8-5482f0a4c6c8',
    Title: 'Research Software Engineer I',
    RequisitionNumber: 'RESEA002823',
    JobCategoryName: 'Research Sciences',
    BriefDescription: 'Build research software for AI-enabled discovery.',
    PostedDate: '2026-07-21T19:10:29.970Z',
    Locations: [{
      LocalizedDescription: 'Salk Main Campus',
      Address: { City: 'La Jolla', State: { Code: 'CA', Name: 'California' } }
    }]
  }, 'board-guid-1', ultiproEmployer);
  // id keys on the stable requisition number, not the per-board opportunity GUID
  assert.strictEqual(ultipro.id, 'ultipro:salk:RESEA002823');
  assert.strictEqual(ultipro.source, 'ultipro');
  assert.strictEqual(ultipro.source_job_id, 'RESEA002823');
  assert.strictEqual(ultipro.department, 'Research Sciences');
  assert.strictEqual(ultipro.location, 'La Jolla, CA');
  assert.strictEqual(ultipro.description_text, 'Build research software for AI-enabled discovery.');
  assert.strictEqual(ultipro.posted_or_updated_at, '2026-07-21T19:10:29.970Z');
  assert.strictEqual(
    ultipro.url,
    'https://recruiting2.ultipro.com/SAL1013SIBS/JobBoard/board-guid-1/OpportunityDetail?opportunityId=ffcfe13a-79d1-460e-b9d8-5482f0a4c6c8'
  );
  // Missing location/req number -> falls back without throwing
  const ultiproSparse = mapUltiproJob({
    Id: 'abc-123',
    Title: 'Postdoctoral Fellow',
    Locations: []
  }, 'board-guid-2', ultiproEmployer);
  assert.strictEqual(ultiproSparse.id, 'ultipro:salk:abc-123');
  assert.strictEqual(ultiproSparse.location, 'Unspecified');
  assert.strictEqual(ultiproSparse.description_text, '');
  assert.strictEqual(ultiproSparse.posted_or_updated_at, null);

  // SuccessFactors CSB: sitemap listing + microdata detail page
  const sfSitemap = parseSuccessFactorsSitemap(
    '<?xml version="1.0"?><urlset>'
    + '<url><loc>https://jobs.example.edu/job/Houston-Research-Assistant-II-Genetics-Houston%2C-TX-TX-77030/1234500/</loc><lastmod>2026-07-25</lastmod></url>'
    + '<url><loc>https://jobs.example.edu/job/Houston-Research-Assistant-II-Genetics-Houston%2C-TX-TX-77030/1234500/</loc><lastmod>2026-07-25</lastmod></url>'
    + '<url><loc>https://jobs.example.edu/content/Benefits/</loc><lastmod>2026-07-01</lastmod></url>'
    + '</urlset>'
  );
  assert.strictEqual(sfSitemap.length, 2); // non-/job/ URL dropped; dupes kept for the fetcher to collapse
  assert.strictEqual(sfSitemap[0].postingId, '1234500');
  assert.strictEqual(sfSitemap[0].slugText, 'Houston Research Assistant II Genetics Houston, TX TX 77030');
  assert.strictEqual(sfSitemap[0].lastmod, '2026-07-25');

  const sfPage = parseSuccessFactorsJobPage(
    '<html><head><title>x</title></head><body>'
    + '<span itemprop="title" class="x">Research Assistant II - Genetics</span>'
    + '<div><b>Location:</b> <span>Houston, TX</span></div>'
    + '<span itemprop="description" class="x"> </span>'
    + '<div class="joblayouttoken"><p>Run PCR assays daily.</p><style>.x{color:red}</style></div>'
    + '<div><b>Requisition ID:</b> <span>24278</span></div>'
    + '<span itemprop="description" class="x">Equal Opportunity boilerplate.</span>'
    + '</body></html>'
  );
  assert.strictEqual(sfPage.title, 'Research Assistant II - Genetics');
  assert.strictEqual(sfPage.location, 'Houston, TX');
  assert.strictEqual(sfPage.reqId, '24278');
  // Body text captured, EEO footer after the second marker excluded, css stripped
  assert.strictEqual(sfPage.description.includes('Run PCR assays daily.'), true);
  assert.strictEqual(sfPage.description.includes('Equal Opportunity'), false);
  assert.strictEqual(sfPage.description.includes('color:red'), false);

  const sfEmployer = { id: 'exampleu-sf', ats_token: 'exsf', ats_config: { host: 'jobs.example.edu' }, research_areas: [] };
  const sf = mapSuccessFactorsJob(sfSitemap[0], sfPage, sfEmployer);
  assert.strictEqual(sf.id, 'successfactors:exsf:1234500');
  assert.strictEqual(sf.source, 'successfactors');
  assert.strictEqual(sf.title, 'Research Assistant II - Genetics');
  assert.strictEqual(sf.location, 'Houston, TX');
  assert.strictEqual(sf.source_job_id, '24278');
  assert.strictEqual(sf.posted_or_updated_at, '2026-07-25T00:00:00.000Z');
  // Detail fetch failed -> record still usable from the sitemap slug alone
  const sfNoPage = mapSuccessFactorsJob(sfSitemap[0], null, sfEmployer);
  assert.strictEqual(sfNoPage.title, 'Houston Research Assistant II Genetics Houston, TX TX 77030');
  assert.strictEqual(sfNoPage.location, 'Unspecified');
  assert.strictEqual(sfNoPage.source_job_id, '1234500');

  // Eightfold PCSX: list item + detail record
  const efEmployer = { id: 'exampleu-ef', ats_token: 'exef', ats_config: { host: 'hiring.example.edu', domain: 'example.edu' }, research_areas: [] };
  const ef = mapEightfoldJob({
    id: 1133914731370,
    displayJobId: '121926',
    name: 'Research Data Analyst',
    locations: ['Baltimore, MD, United States'],
    postedTs: 1785445476,
    department: null
  }, {
    jobDescription: '<p>Analyze study data.</p>',
    locations: ['Baltimore, MD, United States', 'Remote, United States'],
    department: 'School of Public Health'
  }, efEmployer);
  assert.strictEqual(ef.id, 'eightfold:exef:1133914731370');
  assert.strictEqual(ef.source, 'eightfold');
  assert.strictEqual(ef.url, 'https://hiring.example.edu/careers/job/1133914731370');
  assert.strictEqual(ef.location, 'Baltimore, MD, United States; Remote, United States');
  assert.strictEqual(ef.department, 'School of Public Health');
  assert.strictEqual(ef.description_text, 'Analyze study data.');
  assert.strictEqual(ef.posted_or_updated_at, new Date(1785445476 * 1000).toISOString());
  assert.strictEqual(ef.source_job_id, '121926');
  const efNoDetail = mapEightfoldJob({ id: 9, name: 'Postdoctoral Fellow', locations: [], postedTs: null }, null, efEmployer);
  assert.strictEqual(efNoDetail.location, 'Unspecified');
  assert.strictEqual(efNoDetail.description_text, '');
  assert.strictEqual(efNoDetail.posted_or_updated_at, null);
  assert.strictEqual(efNoDetail.source_job_id, '9');

  // Paylocity: list page embeds Jobs[] as an inline `window.pageData` blob;
  // detail page embeds the full description as a schema.org JobPosting JSON-LD block
  const paylocityListHtml = '<html><head></head><body><script>\n'
    + 'window.pageData = {"Jobs":[{"JobId":4209978,"JobTitle":"Research Data Coordinator",'
    + '"LocationName":"Main Campus","PublishedDate":"2026-05-29T10:43:18-05:00",'
    + '"Description":"Job ID AF01 Position Summary The Research Data","HiringDepartment":"Biology"}],'
    + '"ModuleTitle":"Example University"};\n</script></body></html>';
  const { jobs: paylocityListJobs, moduleTitle } = parsePaylocityListPage(paylocityListHtml);
  assert.strictEqual(paylocityListJobs.length, 1);
  assert.strictEqual(paylocityListJobs[0].JobTitle, 'Research Data Coordinator');
  assert.strictEqual(moduleTitle, 'Example University');
  assert.deepStrictEqual(parsePaylocityListPage('<html>no data here</html>').jobs, []);

  const paylocityDetailHtml = '<html><body><script type="application/ld+json">'
    + '{"@context":"https://schema.org","@type":"JobPosting","title":"Research Data Coordinator",'
    + '"datePosted":"2026-05-29T10:43:18-05:00","description":"<p>Full duties include <strong>data cleaning</strong>.</p>",'
    + '"jobLocation":{"@type":"Place","address":{"@type":"PostalAddress","addressLocality":"Boston","addressRegion":"MA"}}}'
    + '</script></body></html>';
  const paylocityDetail = parsePaylocityDetailPage(paylocityDetailHtml);
  assert.strictEqual(paylocityDetail.title, 'Research Data Coordinator');

  const paylocityEmployer = { id: 'exampleu-pl', ats_token: 'expl', ats_config: { host: 'recruiting.paylocity.com', client_guid: 'abc-123' }, research_areas: [] };
  const pl = mapPaylocityJob(paylocityListJobs[0], paylocityDetail, paylocityEmployer);
  assert.strictEqual(pl.id, 'paylocity:expl:4209978');
  assert.strictEqual(pl.source, 'paylocity');
  assert.strictEqual(pl.url, 'https://recruiting.paylocity.com/Recruiting/Jobs/Details/4209978');
  assert.strictEqual(pl.location, 'Main Campus');
  assert.strictEqual(pl.department, 'Biology');
  // Full JSON-LD description wins over the list page's truncated teaser
  assert.strictEqual(pl.description_text, 'Full duties include data cleaning .');
  assert.strictEqual(pl.posted_or_updated_at, new Date('2026-05-29T10:43:18-05:00').toISOString());
  // Detail fetch failed -> falls back to the list page's teaser + location, still usable
  const plNoDetail = mapPaylocityJob(paylocityListJobs[0], null, paylocityEmployer);
  assert.strictEqual(plNoDetail.description_text, 'Job ID AF01 Position Summary The Research Data');
  assert.strictEqual(plNoDetail.location, 'Main Campus');

  // Interfolio: the public_job_boards list response already carries full
  // description/qualifications/instructions HTML — no detail fetch needed
  const interfolioEmployer = { id: 'exampleu-il', ats_token: 'exil', ats_config: { tenant_id: 31694 }, research_areas: [] };
  const il = mapInterfolioJob({
    id: 166705,
    legacy_position_id: 171533,
    name: 'Research Data Coordinator',
    location: 'Boston, MA',
    unit_name: 'Neurosciences (FAC/RA/RS)',
    open_date_raw: '2025-10-01',
    description: '<p>Analyze study data.</p>',
    qualifications: '<p>PhD required.</p>',
    instructions: '<p>Submit a CV.</p>'
  }, interfolioEmployer);
  assert.strictEqual(il.id, 'interfolio:exil:166705');
  assert.strictEqual(il.source, 'interfolio');
  // The public apply URL uses legacy_position_id, not the list item's own id
  assert.strictEqual(il.url, 'https://apply.interfolio.com/171533');
  assert.strictEqual(il.department, 'Neurosciences (FAC/RA/RS)');
  assert.strictEqual(il.description_text, 'Analyze study data. PhD required. Submit a CV.');
  assert.strictEqual(il.posted_or_updated_at, new Date('2025-10-01').toISOString());
  assert.strictEqual(il.source_job_id, '166705');
  // No legacy_position_id -> falls back to the list item's own id for the apply URL
  const ilNoLegacy = mapInterfolioJob({ id: 999, name: 'Postdoctoral Fellow', location: '' }, interfolioEmployer);
  assert.strictEqual(ilNoLegacy.url, 'https://apply.interfolio.com/999');
  assert.strictEqual(ilNoLegacy.location, 'Unspecified');
  assert.strictEqual(ilNoLegacy.description_text, '');
  assert.strictEqual(ilNoLegacy.posted_or_updated_at, null);

  // GovernmentJobs/NeoGov (schooljobs.com): the same list URL a browser hits
  // serves a full page shell UNLESS the request carries an
  // X-Requested-With: XMLHttpRequest header, in which case it returns the
  // plain HTML job table fragment used here (found by network-capturing the
  // real request against a live tenant).
  const govJobsListHtml = `
    <table><tbody>
      <tr>
        <th scope="row" class="job-table-title" data-job-id="5431244">
          <a class="item-details-link" href="/careers/ysu/jobs/5431244/lecturer-civil-engineering">Lecturer, Civil Engineering</a>
        </th>
        <td class="job-table-type">Professional Administrative</td>
        <td class="job-table-posted hidden-sm hidden-xs">07/30/26</td>
        <td class="job-table-closing"></td>
        <td class="job-table-department">Academic Affairs</td>
        <td class="job-table-department">Civil Engineering</td>
        <td class="job-table-location hidden-sm hidden-xs">Youngstown, Ohio</td>
        <td class="job-table-jobnumber">202600123</td>
      </tr>
    </tbody></table>`;
  const govJobsListItems = parseGovernmentJobsListPage(govJobsListHtml);
  assert.strictEqual(govJobsListItems.length, 1);
  assert.strictEqual(govJobsListItems[0].title, 'Lecturer, Civil Engineering');
  assert.strictEqual(govJobsListItems[0].department, 'Academic Affairs / Civil Engineering');
  assert.strictEqual(govJobsListItems[0].location, 'Youngstown, Ohio');
  assert.deepStrictEqual(parseGovernmentJobsListPage('<html>no rows here</html>'), []);

  const govJobsDetailHtml = `
    <div id="details-info" class="tab-content">
      <dl>
        <dt><h2>Summary of Position</h2></dt>
        <dd><p>Teach undergraduate civil engineering courses.</p></dd>
        <dt><h2>Qualifications</h2></dt>
        <dd><p>PhD in Civil Engineering required.</p></dd>
      </dl>
    </div>`;
  const govJobsDetail = parseGovernmentJobsDetailPage(govJobsDetailHtml);
  assert.match(govJobsDetail.description, /Teach undergraduate civil engineering/);

  const govJobsEmployer = { id: 'exampleu-gj', ats_token: 'exgj', ats_config: { host: 'www.schooljobs.com', agency: 'exgj' }, research_areas: [] };
  const gj = mapGovernmentJobsJob(govJobsListItems[0], govJobsDetail, govJobsEmployer);
  assert.strictEqual(gj.id, 'governmentjobs:exgj:5431244');
  assert.strictEqual(gj.source, 'governmentjobs');
  assert.strictEqual(gj.url, 'https://www.schooljobs.com/careers/ysu/jobs/5431244/lecturer-civil-engineering');
  assert.strictEqual(gj.department, 'Academic Affairs / Civil Engineering');
  assert.strictEqual(gj.description_text, 'Summary of Position Teach undergraduate civil engineering courses. Qualifications PhD in Civil Engineering required.');
  assert.strictEqual(gj.posted_or_updated_at, '2026-07-30T00:00:00Z');
  assert.strictEqual(gj.source_job_id, '5431244');
  // Detail fetch failed -> falls back to list-only fields, still usable
  const gjNoDetail = mapGovernmentJobsJob(govJobsListItems[0], null, govJobsEmployer);
  assert.strictEqual(gjNoDetail.description_text, '');
  assert.strictEqual(gjNoDetail.title, 'Lecturer, Civil Engineering');

  // Title prefilter: research-shaped titles pass, admin titles do not
  assert.strictEqual(isResearchRelevantTitle('Senior Research Scientist', workdayEmployer), true);
  assert.strictEqual(isResearchRelevantTitle('Postdoctoral Scholar', workdayEmployer), true);
  assert.strictEqual(isResearchRelevantTitle('Economics Program Coordinator', workdayEmployer), true);
  assert.strictEqual(isResearchRelevantTitle('Parking Attendant', workdayEmployer), false);

  const recruitee = mapRecruiteeJob({
    guid: 'rt-9',
    title: 'Bioinformatics Engineer',
    department: 'Science',
    locations: [{ city: 'Boston', state: 'MA', country: 'United States' }],
    careers_url: 'https://exampleorg.recruitee.com/o/bioinformatics-engineer',
    description: '<p>Build pipelines</p>',
    published_at: '2026-06-15T10:00:00.000Z'
  }, employer);
  assert.strictEqual(recruitee.id, 'recruitee:exampleorg:rt-9');
  assert.strictEqual(recruitee.location, 'Boston, MA, United States');
  assert.strictEqual(recruitee.description_text, 'Build pipelines');
  assert.strictEqual(recruitee.source, 'recruitee');

  const breezy = mapBreezyJob({
    id: 'bz-1',
    friendly_id: 'research-tech',
    name: 'Research Technician',
    department: 'Lab Ops',
    location: { name: 'Seattle, WA' },
    url: 'https://exampleorg.breezy.hr/p/bz-1',
    description: '<p>Assist experiments</p>',
    published_date: '2026-06-20'
  }, employer);
  assert.strictEqual(breezy.id, 'breezy:exampleorg:bz-1');
  assert.strictEqual(breezy.location, 'Seattle, WA');
  assert.strictEqual(breezy.source, 'breezy');

  const workable = mapWorkableJob({
    shortcode: 'AB12CD',
    title: 'Data Scientist',
    department: 'Analytics',
    city: 'New York',
    state: 'NY',
    country: 'United States',
    url: 'https://apply.workable.com/exampleorg/j/AB12CD/',
    description: '<p>Model research data</p>',
    published_on: '2026-06-01'
  }, employer);
  assert.strictEqual(workable.id, 'workable:exampleorg:AB12CD');
  assert.strictEqual(workable.location, 'New York, NY, United States');
  assert.strictEqual(workable.source, 'workable');
}

async function testFetchRetry() {
  const status = (code) => Object.assign(new Error(`HTTP ${code}`), { status: code });
  assert.strictEqual(isRetryableFetchError(new Error('network down')), true);
  assert.strictEqual(isRetryableFetchError(status(429)), true);
  assert.strictEqual(isRetryableFetchError(status(500)), true);
  assert.strictEqual(isRetryableFetchError(status(404)), false);

  const originalFetch = globalThis.fetch;
  try {
    // Transient 500 then success: fetchJson should retry and succeed
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      if (calls === 1) {
        return { ok: false, status: 500, statusText: 'Server Error' };
      }
      return { ok: true, json: async () => ({ jobs: [] }) };
    };
    const result = await fetchJson('https://example.test/jobs', { retryDelayMs: 1 });
    assert.deepStrictEqual(result, { jobs: [] });
    assert.strictEqual(calls, 2);

    // Deterministic 404: no retry
    calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return { ok: false, status: 404, statusText: 'Not Found' };
    };
    await assert.rejects(() => fetchJson('https://example.test/missing', { retryDelayMs: 1 }), /HTTP 404/);
    assert.strictEqual(calls, 1);

    // A 200 carrying HTML is how a board says "challenge" or "maintenance".
    // Unlabelled it surfaces as "Unexpected token '<'", which reads like a
    // parser bug and hides that a whole provider may be answering that way.
    calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'text/html; charset=utf-8' },
        json: async () => { throw new SyntaxError("Unexpected token '<'"); }
      };
    };
    let nonJson = null;
    try {
      await fetchJson('https://tenant.example.test/jobs', { retryDelayMs: 1 });
    } catch (error) {
      nonJson = error;
    }
    assert(nonJson && /non-JSON response/.test(nonJson.message), 'the failure must name itself');
    assert(/text\/html/.test(nonJson.message), 'and say what came back instead');
    assert(/tenant\.example\.test/.test(nonJson.message), 'and which host said it');
    assert.strictEqual(nonJson.nonJson, true);
    assert.strictEqual(nonJson.status, 200);
    assert.strictEqual(calls, 1, 'the same request returns the same page — retrying is waste');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testUsaJobs() {
  const employer = {
    id: 'us-federal-research',
    ats_token: 'data.usajobs.gov',
    ats_config: { position_series: ['1301'], max_pages_per_series: 1 }
  };

  const mapped = mapUsaJobsJob({
    MatchedObjectId: '827345600',
    MatchedObjectDescriptor: {
      PositionTitle: 'Research Physical Scientist',
      PositionURI: 'https://www.usajobs.gov/job/827345600',
      OrganizationName: 'National Institute of Standards and Technology',
      DepartmentName: 'Department of Commerce',
      PositionLocation: [{ LocationName: 'Gaithersburg, Maryland' }],
      QualificationSummary: 'Degree in physical science required.',
      UserArea: { Details: { JobSummary: 'Conduct research in measurement science.' } },
      PublicationStartDate: '2026-07-01'
    }
  }, employer);
  assert.strictEqual(mapped.id, 'usajobs:data.usajobs.gov:827345600');
  assert.strictEqual(mapped.department, 'Department of Commerce — National Institute of Standards and Technology');
  assert.strictEqual(mapped.location, 'Gaithersburg, Maryland');
  assert.strictEqual(mapped.description_text, 'Conduct research in measurement science. Degree in physical science required.');
  assert.strictEqual(mapped.source, 'usajobs');
  // Federal postings are citizen-gated by default even when the description
  // text never says "citizen" — the requirement lives in hiring metadata
  assert.strictEqual(mapped.citizenship_gated, true);
  assert.strictEqual(mapped.restricted_reason, 'US citizenship required (federal hiring path)');

  // A posting that explicitly opens to non-citizens escapes the gate
  const openMapped = mapUsaJobsJob({
    MatchedObjectId: '900000001',
    MatchedObjectDescriptor: {
      PositionTitle: 'Postdoctoral Fellow (Title 42)',
      PositionURI: 'https://www.usajobs.gov/job/900000001',
      QualificationSummary: 'PhD required.',
      UserArea: { Details: { JobSummary: 'This position is filled without regard to citizenship.', WhoMayApply: { Name: 'All qualified candidates' } } }
    }
  }, employer);
  assert.strictEqual(openMapped.citizenship_gated, false);
  assert.strictEqual(openMapped.restricted_reason, null);

  // enrichJob: the mapper-level gate overrides a text scan that found nothing
  const gatedEnriched = enrichJob(mapped, employer, new Map(), {});
  assert.strictEqual(gatedEnriched.veritas_state, 'RESTRICTED');
  assert(gatedEnriched.matched_phrases.includes('US citizenship required (federal hiring path)'));
  assert.strictEqual(gatedEnriched.citizenship_gated, true);

  const savedKey = process.env.USAJOBS_API_KEY;
  const savedEmail = process.env.USAJOBS_EMAIL;
  const originalFetch = globalThis.fetch;
  try {
    // Missing credentials -> skipped-flagged error, not a hard failure
    delete process.env.USAJOBS_API_KEY;
    delete process.env.USAJOBS_EMAIL;
    await assert.rejects(() => fetchUsaJobsJobs(employer), (error) => error.skipped === true);

    // Unexpected body shape -> loud failure (protects the lifecycle)
    process.env.USAJOBS_API_KEY = 'test-key';
    process.env.USAJOBS_EMAIL = 'test@example.test';
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ unexpected: true }) });
    await assert.rejects(() => fetchUsaJobsJobs(employer), /shape unexpected/);

    // Happy path via stubbed fetch
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        SearchResult: {
          SearchResultItems: [{
            MatchedObjectId: '1',
            MatchedObjectDescriptor: { PositionTitle: 'Data Scientist', PositionURI: 'https://www.usajobs.gov/job/1' }
          }]
        }
      })
    });
    const jobs = await fetchUsaJobsJobs(employer);
    assert.strictEqual(jobs.length, 1);
    assert.strictEqual(jobs[0].source, 'usajobs');
  } finally {
    globalThis.fetch = originalFetch;
    if (savedKey === undefined) delete process.env.USAJOBS_API_KEY; else process.env.USAJOBS_API_KEY = savedKey;
    if (savedEmail === undefined) delete process.env.USAJOBS_EMAIL; else process.env.USAJOBS_EMAIL = savedEmail;
  }
}

function testJobLifecycle() {
  const now = '2026-07-03T12:00:00.000Z';
  const job = (id, employerId, extra = {}) => ({
    id,
    employer_id: employerId,
    title: `Job ${id}`,
    first_seen_at: '2026-06-01T00:00:00.000Z',
    ...extra
  });
  const outcomes = (entries) => new Map(Object.entries(entries));

  // Disappeared job under an ok fetch -> tombstone with closed_at set once
  let jobs = applyJobLifecycle({
    previousJobs: [job('a:1', 'a'), job('a:2', 'a')],
    fetchedJobs: [job('a:1', 'a')],
    employerOutcomes: outcomes({ a: { attempted: true, ok: true } }),
    now
  });
  assert.strictEqual(jobs.find((j) => j.id === 'a:1').status, 'active');
  const closed = jobs.find((j) => j.id === 'a:2');
  assert.strictEqual(closed.status, 'closed');
  assert.strictEqual(closed.closed_at, now);

  // Second run: closed_at preserved, not reset
  jobs = applyJobLifecycle({
    previousJobs: jobs,
    fetchedJobs: [job('a:1', 'a')],
    employerOutcomes: outcomes({ a: { attempted: true, ok: true } }),
    now: '2026-07-04T12:00:00.000Z'
  });
  assert.strictEqual(jobs.find((j) => j.id === 'a:2').closed_at, now);

  // Employer errored this run -> jobs carried forward unchanged, NOT closed
  jobs = applyJobLifecycle({
    previousJobs: [job('b:1', 'b')],
    fetchedJobs: [],
    employerOutcomes: outcomes({ b: { attempted: true, ok: false } }),
    now
  });
  assert.strictEqual(jobs.length, 1);
  assert.notStrictEqual(jobs[0].status, 'closed');

  // Tombstone older than retention -> dropped
  jobs = applyJobLifecycle({
    previousJobs: [job('c:1', 'c', { status: 'closed', closed_at: '2026-05-01T00:00:00.000Z' })],
    fetchedJobs: [],
    employerOutcomes: outcomes({ c: { attempted: true, ok: true } }),
    now
  });
  assert.strictEqual(jobs.length, 0);

  // Reappearing job -> revived as active, closed_at cleared
  jobs = applyJobLifecycle({
    previousJobs: [job('d:1', 'd', { status: 'closed', closed_at: '2026-06-25T00:00:00.000Z' })],
    fetchedJobs: [job('d:1', 'd')],
    employerOutcomes: outcomes({ d: { attempted: true, ok: true } }),
    now
  });
  assert.strictEqual(jobs[0].status, 'active');
  assert.strictEqual(jobs[0].closed_at, undefined);

  // Employer removed from registry -> jobs dropped
  jobs = applyJobLifecycle({
    previousJobs: [job('e:1', 'gone-employer')],
    fetchedJobs: [],
    employerOutcomes: outcomes({}),
    now
  });
  assert.strictEqual(jobs.length, 0);
}

function testCrossSourceDedup() {
  const j = (id, source, employer_id, title, location) => ({ id, source, employer_id, employer_name: 'MIT', title, location });
  // ATS + aggregator list the same role -> keep ATS, drop aggregator
  let out = dedupeCrossSource([
    j('greenhouse:mit:1', 'greenhouse', 'mit', 'Postdoctoral Associate', 'Cambridge, MA'),
    j('agg:sci:9', 'science-careers', 'agg:sci', 'Postdoctoral Associate', 'Cambridge, MA')
  ]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].id, 'greenhouse:mit:1');
  // Two DISTINCT reqs from the same ATS with identical titles -> both kept
  out = dedupeCrossSource([
    j('workday:mit:1', 'workday', 'mit', 'Postdoctoral Associate', 'Cambridge, MA'),
    j('workday:mit:2', 'workday', 'mit', 'Postdoctoral Associate', 'Cambridge, MA')
  ]);
  assert.strictEqual(out.length, 2);
  // Scout beats aggregator when no ATS present
  out = dedupeCrossSource([
    j('agent:mit:1', 'agent_scout', 'mit', 'Data Engineer', 'Cambridge'),
    j('agg:nat:2', 'nature-careers', 'agg:nat', 'Data Engineer', 'Cambridge')
  ]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].source, 'agent_scout');
  // Different roles at same employer are untouched
  out = dedupeCrossSource([
    j('greenhouse:mit:1', 'greenhouse', 'mit', 'Postdoc', 'Cambridge'),
    j('agg:sci:2', 'science-careers', 'agg:sci', 'Research Engineer', 'Cambridge')
  ]);
  assert.strictEqual(out.length, 2);
}

function testDeadlineParser() {
  assert.strictEqual(parseDeadline('Close Date 07/21/2026'), '2026-07-21');
  assert.strictEqual(parseDeadline('Close Date: 12/31/26'), '2026-12-31');
  assert.strictEqual(parseDeadline('Application Deadline: March 15, 2026'), '2026-03-15');
  assert.strictEqual(parseDeadline('apply by 3/1/2026'), '2026-03-01');
  assert.strictEqual(parseDeadline('Close Date: Until Filled'), null);
  assert.strictEqual(parseDeadline('Close Date: NA'), null);
  assert.strictEqual(parseDeadline('Review of applications begins Nov 1, 2025'), null); // not a hard deadline
  assert.strictEqual(parseDeadline('closes 07/16/1999'), null); // out of plausible year range
  assert.strictEqual(parseDeadline('a deadline-driven environment'), null);
}

function testSalaryParser() {
  assert.deepStrictEqual(parseSalary('Pay Range $60,000.00 - $80,000.00'),
    { salary_min: 60000, salary_max: 80000, salary_period: 'year', salary_currency: 'USD' });
  assert.strictEqual(parseSalary('$19.23 - $26.44 per hour').salary_period, 'hour');
  assert.strictEqual(parseSalary('$19.23 - $26.44 per hour').salary_min, 39998); // annualized x2080
  assert.deepStrictEqual(parseSalary('$120K \u2013 $150K', { trusted: true }),
    { salary_min: 120000, salary_max: 150000, salary_period: 'year', salary_currency: 'USD' });
  assert.strictEqual(parseSalary('$5,000 signing bonus'), null);       // below annual floor
  assert.strictEqual(parseSalary('awarded a $500,000 research grant'), null); // untrusted single ignored
  assert.strictEqual(parseSalary('$145,000 annually', { trusted: true }).salary_min, 145000);
  assert.strictEqual(parseSalary('no pay listed here'), null);
}

function testWorkModeAndLocation() {
  assert.strictEqual(detectWorkMode({ title: 'Data Analyst (Remote)' }), 'remote');
  assert.strictEqual(detectWorkMode({ title: 'Engineer', location: 'Remote - US' }), 'remote');
  assert.strictEqual(detectWorkMode({ title: 'Analyst', location: 'Hybrid' }), 'hybrid');
  assert.strictEqual(detectWorkMode({ title: 'Scientist', description_text: 'This is a fully remote position.' }), 'remote');
  assert.strictEqual(detectWorkMode({ title: 'Coordinator', description_text: 'Uses remote sensing satellite data.' }), null); // bare "remote" in desc is noise
  assert.strictEqual(detectWorkMode({ title: 'Lab Tech', location: 'Boston, MA' }), null);
  // Institution city only from the clear "… at City" pattern
  assert.strictEqual(institutionCity('University of North Carolina at Chapel Hill'), 'Chapel Hill');
  assert.strictEqual(institutionCity('The University of Texas at Arlington'), 'Arlington');
  assert.strictEqual(institutionCity('Dartmouth College'), null);
  assert.strictEqual(institutionCity('University of Vermont'), null);
}

function testRecallAnomalies() {
  const outcomes = (entries) => new Map(Object.entries(entries));
  const prev = (employerId, count) =>
    Array.from({ length: count }, (_, i) => ({ id: `${employerId}:${i}`, employer_id: employerId, status: 'active' }));

  // A feed with a healthy history that OK-fetches zero must be flagged — this
  // is the silent mass-tombstone the alarm exists to catch.
  let anomalies = detectRecallAnomalies({
    previousJobs: prev('big', 40),
    employerReports: [{ employer_id: 'big', name: 'Big U', ats_provider: 'workday', fetched_jobs: 0 }],
    employerOutcomes: outcomes({ big: { attempted: true, ok: true } })
  });
  assert.strictEqual(anomalies.length, 1);
  assert.strictEqual(anomalies[0].previous_active, 40);

  // Same drop but the fetch errored -> lifecycle carries jobs forward, no alarm
  anomalies = detectRecallAnomalies({
    previousJobs: prev('big', 40),
    employerReports: [{ employer_id: 'big', name: 'Big U', ats_provider: 'workday', fetched_jobs: 0 }],
    employerOutcomes: outcomes({ big: { attempted: true, ok: false } })
  });
  assert.strictEqual(anomalies.length, 0);

  // Small feeds legitimately empty out; below the threshold -> no alarm
  anomalies = detectRecallAnomalies({
    previousJobs: prev('tiny', 2),
    employerReports: [{ employer_id: 'tiny', name: 'Tiny Lab', ats_provider: 'lever', fetched_jobs: 0 }],
    employerOutcomes: outcomes({ tiny: { attempted: true, ok: true } })
  });
  assert.strictEqual(anomalies.length, 0);

  // Feed still returning jobs -> no alarm even with a big history
  anomalies = detectRecallAnomalies({
    previousJobs: prev('big', 40),
    employerReports: [{ employer_id: 'big', name: 'Big U', ats_provider: 'workday', fetched_jobs: 12 }],
    employerOutcomes: outcomes({ big: { attempted: true, ok: true } })
  });
  assert.strictEqual(anomalies.length, 0);

  // Multi-feed employer: fetched_jobs is a SUM across feeds, so a dead
  // secondary feed can hide behind the primary's healthy count and never
  // trip the check above -- the per-feed check catches it independently.
  anomalies = detectRecallAnomalies({
    previousJobs: [],
    employerReports: [{
      employer_id: 'dual', name: 'Dual U', ats_provider: 'workday', fetched_jobs: 12,
      feeds: [
        { ats_provider: 'workday', ok: true, skipped: false, fetchedCount: 12 },
        { ats_provider: 'interfolio', ok: true, skipped: false, fetchedCount: 0 }
      ]
    }],
    employerOutcomes: outcomes({ dual: { attempted: true, ok: true } })
  });
  assert.strictEqual(anomalies.length, 1);
  assert.strictEqual(anomalies[0].ats_provider, 'interfolio');
  assert.strictEqual(anomalies[0].partial_feed, true);

  // Both feeds healthy -> no alarm
  anomalies = detectRecallAnomalies({
    previousJobs: [],
    employerReports: [{
      employer_id: 'dual', name: 'Dual U', ats_provider: 'workday', fetched_jobs: 12,
      feeds: [
        { ats_provider: 'workday', ok: true, skipped: false, fetchedCount: 12 },
        { ats_provider: 'interfolio', ok: true, skipped: false, fetchedCount: 3 }
      ]
    }],
    employerOutcomes: outcomes({ dual: { attempted: true, ok: true } })
  });
  assert.strictEqual(anomalies.length, 0);

  // A feed that errored (not skipped, not ok) shouldn't double-report --
  // that's already visible via the report's own error field
  anomalies = detectRecallAnomalies({
    previousJobs: [],
    employerReports: [{
      employer_id: 'dual', name: 'Dual U', ats_provider: 'workday', fetched_jobs: 12,
      feeds: [
        { ats_provider: 'workday', ok: true, skipped: false, fetchedCount: 12 },
        { ats_provider: 'interfolio', ok: false, skipped: false, fetchedCount: 0, error: 'HTTP 500' }
      ]
    }],
    employerOutcomes: outcomes({ dual: { attempted: true, ok: true } })
  });
  assert.strictEqual(anomalies.length, 0);
}

function testPrefilterAnomalies() {
  // A large tenant that excludes almost every title is more likely an
  // incomplete pattern set than a genuinely irrelevant employer -> flagged.
  let anomalies = detectPrefilterAnomalies({
    employerReports: [{ employer_id: 'big', name: 'Big U', ats_provider: 'workday', fetched_jobs: 1, prefiltered_count: 400, prefilter_survived_count: 1 }]
  });
  assert.strictEqual(anomalies.length, 1);
  assert.strictEqual(anomalies[0].prefiltered_count, 400);

  // Healthy ratio -> no alarm even with a lot of exclusions
  anomalies = detectPrefilterAnomalies({
    employerReports: [{ employer_id: 'ok', name: 'OK U', ats_provider: 'oracle', fetched_jobs: 120, prefiltered_count: 300, prefilter_survived_count: 120 }]
  });
  assert.strictEqual(anomalies.length, 0);

  // Small feed -> below minExcluded, no alarm even at 100% excluded
  anomalies = detectPrefilterAnomalies({
    employerReports: [{ employer_id: 'tiny', name: 'Tiny Lab', ats_provider: 'eightfold', fetched_jobs: 0, prefiltered_count: 5, prefilter_survived_count: 0 }]
  });
  assert.strictEqual(anomalies.length, 0);

  // No prefilter used (successfactors with 0 excluded) -> no alarm
  anomalies = detectPrefilterAnomalies({
    employerReports: [{ employer_id: 'clean', name: 'Clean U', ats_provider: 'successfactors', fetched_jobs: 50, prefiltered_count: 0, prefilter_survived_count: 50 }]
  });
  assert.strictEqual(anomalies.length, 0);

  // Report predates this field (older committed report, or a non-prefiltering
  // driver that never stamps it) -> skipped rather than treated as 0
  anomalies = detectPrefilterAnomalies({
    employerReports: [{ employer_id: 'legacy', name: 'Legacy U', ats_provider: 'workday', fetched_jobs: 0, prefiltered_count: 400 }]
  });
  assert.strictEqual(anomalies.length, 0);

  // The conflation bug this fixes: prefiltered_count vs fetched_jobs (the
  // FINAL count, after the separate auto-tier relevance-score filter) would
  // flag this as a broken prefilter. It isn't — the prefilter correctly let 4
  // titles through; they legitimately scored too low downstream. Using
  // prefilter_survived_count (the prefilter's own pass-through, healthy at
  // 4/79) instead of fetched_jobs (0) must NOT flag this.
  // Confirmed live against Bank Street College of Education.
  anomalies = detectPrefilterAnomalies({
    employerReports: [{ employer_id: 'bank-street-college-of-education', name: 'Bank Street College of Education', ats_provider: 'oracle', fetched_jobs: 0, prefiltered_count: 75, prefilter_survived_count: 4 }]
  });
  assert.strictEqual(anomalies.length, 0);

  // filterResearchRelevant reports the same exclusion count isResearchRelevantTitle would
  const employer = { research_areas: [] };
  const { relevant, excluded } = filterResearchRelevant(
    [{ t: 'Postdoctoral Fellow' }, { t: 'Cafeteria Worker' }, { t: 'Data Scientist' }],
    (item) => item.t,
    employer
  );
  assert.strictEqual(relevant.length, 2);
  assert.strictEqual(excluded, 1);
}

async function testMultiFeedEmployer() {
  // Some institutions genuinely run two separate ATS feeds -- e.g. a Workday
  // staff board plus a completely separate Interfolio faculty board
  // (University of Rochester: confirmed live to have exactly this, a
  // 353-posting faculty board the registry couldn't represent before this).
  const employer = {
    id: 'dual-u', name: 'Dual University', ats_provider: 'workday', ats_token: 'dual',
    ats_config: { host: 'h', tenant: 'dual', site: 's' },
    secondary_ats_feeds: [{ ats_provider: 'interfolio', ats_token: 'dual', ats_config: { tenant_id: 999 } }]
  };
  const okJobs = [{ id: 'workday:dual:1', employer_id: 'dual-u' }];
  okJobs.prefiltered_count = 3;
  okJobs.prefilter_survived_count = 1;

  // One feed fails -> soft success: jobs merge, counts sum, error stays null
  let result = await fetchEmployerJobs(employer, {
    workday: async () => okJobs,
    interfolio: async () => { throw new Error('interfolio 500'); }
  });
  assert.strictEqual(result.jobs.length, 1);
  assert.strictEqual(result.error, null);
  assert.strictEqual(result.skipped, false);
  assert.strictEqual(result.prefilteredCount, 3);
  assert.strictEqual(result.prefilterSurvivedCount, 1);
  assert.strictEqual(result.feeds.length, 2);
  assert.strictEqual(result.feeds[0].ok, true);
  assert.strictEqual(result.feeds[1].ok, false);
  assert.match(result.feeds[1].error, /interfolio 500/);

  // Both feeds fail -> error is set, jobs empty
  result = await fetchEmployerJobs(employer, {
    workday: async () => { throw new Error('workday 500'); },
    interfolio: async () => { throw new Error('interfolio 500'); }
  });
  assert.strictEqual(result.jobs.length, 0);
  assert.match(result.error, /workday 500/);
  assert.match(result.error, /interfolio 500/);

  // Single-feed employers (the ~337 without a secondary feed) keep today's
  // exact shape -- no `feeds` array, so the committed report stays
  // byte-identical for everyone not using this feature.
  const singleFeedEmployer = { id: 'solo-u', name: 'Solo University', ats_provider: 'workday', ats_token: 'solo', ats_config: {} };
  result = await fetchEmployerJobs(singleFeedEmployer, { workday: async () => okJobs });
  assert.strictEqual(result.feeds, undefined);
  assert.strictEqual(result.jobs.length, 1);

  // No ats_provider and no secondary feeds -> skipped, matching today's behavior
  result = await fetchEmployerJobs({ id: 'none-u', name: 'None University' }, {});
  assert.strictEqual(result.skipped, true);
  assert.strictEqual(result.jobs.length, 0);
}

function buildSingleEntryZip(name, content, method = 8) {
  const raw = Buffer.from(content);
  const data = method === 8 ? zlib.deflateRawSync(raw) : raw;
  const nameBuffer = Buffer.from(name);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(nameBuffer.length, 26);
  const localBlock = Buffer.concat([local, nameBuffer, data]);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(nameBuffer.length, 28);
  central.writeUInt32LE(0, 42);
  const centralBlock = Buffer.concat([central, nameBuffer]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralBlock.length, 12);
  eocd.writeUInt32LE(localBlock.length, 16);

  return Buffer.concat([localBlock, centralBlock, eocd]);
}

function testZipExtraction() {
  const csv = 'UNITID,INSTNM\n144050,"University of Chicago"\n';

  const deflated = buildSingleEntryZip('hd2023.csv', csv, 8);
  assert.strictEqual(listZipEntries(deflated).length, 1);
  assert.strictEqual(listZipEntries(deflated)[0].name, 'hd2023.csv');
  assert.strictEqual(extractZipEntry(deflated, (name) => name.endsWith('.csv')).toString('utf8'), csv);

  const stored = buildSingleEntryZip('hd2023.csv', csv, 0);
  assert.strictEqual(extractZipEntry(stored, (name) => name.endsWith('.csv')).toString('utf8'), csv);

  assert.throws(() => extractZipEntry(deflated, (name) => name.endsWith('.xml')), /no entry matched/);
  assert.throws(() => extractZipEntry(Buffer.from('not a zip file at all......'), () => true), /end-of-central-directory/);
}

function testScoutedImporter() {
  // Stable ids: tracking params, fragments, case, trailing slash are ignored
  assert.strictEqual(canonicalUrl('https://Careers.Example.org/jobs/12345/?utm_source=x&gclid=abc#apply'),
    'https://careers.example.org/jobs/12345');
  assert.strictEqual(
    scoutedJobId('fred-hutch', 'https://careers.example.org/jobs/12345?utm_campaign=y'),
    scoutedJobId('fred-hutch', 'https://CAREERS.example.org/jobs/12345/')
  );

  const employersById = new Map([['fred-hutch', { id: 'fred-hutch', ats_provider: null }]]);
  const payload = {
    schema_version: 1,
    employer_id: 'fred-hutch',
    scouted_at: '2026-07-04T00:00:00Z',
    source_url: 'https://careers.example.org/search',
    jobs: [
      { title: 'Research Technician II', url: 'https://careers.example.org/jobs/1', location: 'Seattle, WA' },
      { title: '', url: 'https://careers.example.org/jobs/2' },
      { title: 'Postdoc', url: 'not-a-url' },
      { title: 'Dup', url: 'https://careers.example.org/jobs/1?utm_source=z' }
    ],
    skipped_reason: null
  };
  const result = validateScoutedFile(payload, employersById);
  assert.strictEqual(result.fileError, null);
  assert.strictEqual(result.accepted.length, 1);
  assert.strictEqual(result.rejected.length, 3);
  assert(result.rejected.some((r) => r.reason === 'missing title'));
  assert(result.rejected.some((r) => r.reason === 'duplicate url in snapshot'));

  assert.strictEqual(validateScoutedFile({ schema_version: 2 }, employersById).fileError.includes('schema_version'), true);
  assert.strictEqual(validateScoutedFile({ schema_version: 1, employer_id: 'nope', scouted_at: '2026-07-04T00:00:00Z', jobs: [] }, employersById).fileError.includes('unknown employer_id'), true);

  const normalized = normalizeScoutedJob(result.accepted[0], payload);
  assert.strictEqual(normalized.source, 'agent_scout');
  assert.strictEqual(normalized.employer_id, 'fred-hutch');
  assert.strictEqual(normalized.last_scouted_at, '2026-07-04T00:00:00Z');
  assert(normalized.id.startsWith('scout:fred-hutch:'));

  // TTL: fresh snapshots survive, stale ones drop
  const store = { jobs: [
    { id: 'a', employer_id: 'fred-hutch', last_scouted_at: '2026-07-01T00:00:00Z' },
    { id: 'b', employer_id: 'fred-hutch', last_scouted_at: '2026-06-01T00:00:00Z' },
    { id: 'c', employer_id: 'fred-hutch' }
  ] };
  const active = activeScoutedJobs(store, '2026-07-04T00:00:00.000Z', 14);
  assert.deepStrictEqual(active.map((job) => job.id), ['a']);
}

function testAggregatedImporter() {
  const directory = {
    'YALE UNIVERSITY': { name: 'Yale University', token_key: 'UNIVERSITY YALE', kind: 'ipeds', unitid: '130794', ein: null, ntee_cd: null, uscis_approvals_3y: 710, dol_certified_3y: 0 },
    'RAND': { name: 'RAND Corporation', token_key: 'RAND', kind: 'irs', unitid: null, ein: '95', ntee_cd: 'U30', uscis_approvals_3y: 120, dol_certified_3y: 0 }
  };
  const tokenKeyIndex = new Map([['UNIVERSITY YALE', 'YALE UNIVERSITY'], ['RAND', 'RAND']]);
  const registryResolver = createResolver([{ id: 'university-of-chicago', name: 'University of Chicago' }]);
  const liveProviderIds = new Set(['university-of-chicago']);
  const ctx = { directory, tokenKeyIndex, registryResolver, liveProviderIds };

  // token-order-insensitive directory lookup
  assert.strictEqual(directoryLookup(directory, tokenKeyIndex, 'The Yale University').unitid, '130794');
  assert.strictEqual(directoryLookup(directory, tokenKeyIndex, 'RAND Corp').ein, '95');
  assert.strictEqual(directoryLookup(directory, tokenKeyIndex, 'Nowhere Community College'), null);

  // cap-exempt employer kept with score
  const yaleJob = resolveAggregatedJob({ employer_name: 'Yale University', title: 'Postdoc', url: 'x' }, ctx);
  assert.strictEqual(yaleJob.keep, true);
  assert.strictEqual(yaleJob.kind, 'ipeds');
  assert(yaleJob.score >= 55); // IPEDS 40 + USCIS(710) 15

  // non-cap-exempt employer dropped
  assert.deepStrictEqual(
    resolveAggregatedJob({ employer_name: 'Acme Widgets LLC', title: 'x', url: 'y' }, ctx),
    { keep: false, reason: 'not_cap_exempt' }
  );

  // employer already covered by a live ATS feed is dropped as a duplicate
  const dupe = resolveAggregatedJob({ employer_name: 'University of Chicago', title: 'x', url: 'y' }, ctx);
  assert.strictEqual(dupe.keep, false);
  assert.strictEqual(dupe.reason, 'covered_by_live_ats');

  assert.strictEqual(pseudoEmployerId('Yale University'), 'agg:yale-university');
}

function testEnrichPipeline() {
  // parseIpedsCsv
  const institutions = parseIpedsCsv('UNITID,INSTNM,CITY,STABBR\n144050,"University of Chicago",Chicago,IL\n,,x,y\n');
  assert.strictEqual(institutions.length, 1);
  assert.deepStrictEqual(institutions[0], { unitid: '144050', instnm: 'University of Chicago', city: 'Chicago', stabbr: 'IL', website: null });

  // WEBADDR flows through with scheme normalization (bare domains are common)
  const withSite = parseIpedsCsv('UNITID,INSTNM,CITY,STABBR,WEBADDR\n1,"A College",X,YY,"www.acollege.edu/"\n2,"B College",X,YY,"https://b.edu"\n');
  assert.strictEqual(withSite[0].website, 'https://www.acollege.edu/');
  assert.strictEqual(withSite[1].website, 'https://b.edu/');

  // Scoring table
  const confident = { strategy: 'exact', confidence: 1.0 };
  assert.strictEqual(computeCapExemptScore({ ipeds: { unitid: '1', match: confident } }).score, 40);
  assert.strictEqual(computeCapExemptScore({
    ipeds: { unitid: '1', match: confident },
    irs: { subsection: '03', ntee_cd: 'U40', match: confident }
  }).score, 65);
  assert.strictEqual(computeCapExemptScore({ irs: { subsection: '03', ntee_cd: 'B25', match: confident } }).score, 10);
  assert.strictEqual(computeCapExemptScore({ dol_certified_3y: 9 }).score, 10);
  assert.strictEqual(computeCapExemptScore({ dol_certified_3y: 1000 }).score, 20);
  assert.strictEqual(computeCapExemptScore({ uscis_approvals_3y: 100 }).score, 15);
  // Confidence gate: weak matches never score
  const weak = { strategy: 'token_overlap', confidence: 0.6 };
  assert.strictEqual(computeCapExemptScore({ ipeds: { unitid: '1', match: weak } }).score, 0);

  // Status promotion rules
  const higherEd = { type: 'institution_of_higher_education', cap_exempt_status: 'likely' };
  const nonprofit = { type: 'nonprofit_research_org', cap_exempt_status: 'likely' };
  assert.strictEqual(suggestStatus({ ipeds: { match: confident } }, higherEd), 'verified');
  assert.strictEqual(suggestStatus({ ipeds: { match: weak } }, higherEd), 'likely');
  assert.strictEqual(suggestStatus({ irs: { subsection: '03', ntee_cd: 'H90', match: confident } }, nonprofit), 'verified');
  // Type mismatch -> no promotion
  assert.strictEqual(suggestStatus({ ipeds: { match: confident } }, nonprofit), 'likely');

  // Overlay merge: upgrade but never downgrade, evidence union, identity untouched
  const employers = [
    { id: 'a', name: 'A University', type: 'institution_of_higher_education', cap_exempt_status: 'likely', evidence_sources: ['manual'] },
    { id: 'b', name: 'B Institute', type: 'nonprofit_research_org', cap_exempt_status: 'verified', evidence_sources: ['manual'] }
  ];
  const merged = applyEnrichmentOverlay(employers, { employers: {
    a: { suggested_status: 'verified', evidence_tags: ['ipeds:1'], cap_exempt_score: 78 },
    b: { suggested_status: 'likely', evidence_tags: ['dol_lca'], cap_exempt_score: 30 }
  } });
  assert.strictEqual(merged[0].cap_exempt_status, 'verified');
  assert.deepStrictEqual(merged[0].evidence_sources, ['manual', 'ipeds:1']);
  assert.strictEqual(merged[0].cap_exempt_score, 78);
  assert.strictEqual(merged[1].cap_exempt_status, 'verified', 'manual verified must never downgrade');
  assert.strictEqual(merged[0].name, 'A University');
  assert.deepStrictEqual(applyEnrichmentOverlay(employers, null), employers);

  // Discovery: eligibility gate + registry exclusion + ranking
  const registryResolver = createEnrichResolver([{ id: 'known-org', name: 'Known Research Institute' }]);
  const candidates = buildDiscoveryCandidates({
    irsRows: [
      { is_research: true, name: 'RAND CORPORATION', ein: '1', ntee_cd: 'U30', subsection: '03', state: 'CA' },
      { is_research: true, name: 'KNOWN RESEARCH INSTITUTE', ein: '2', ntee_cd: 'U30', subsection: '03', state: 'MA' },
      { is_research: true, name: 'SLEEPY RESEARCH SOCIETY', ein: '3', ntee_cd: 'U30', subsection: '03', state: 'OH' }
    ],
    ipedsInstitutions: [
      { unitid: '100', instnm: 'Busy State University', city: 'X', stabbr: 'TX' },
      { unitid: '101', instnm: 'Idle College', city: 'Y', stabbr: 'VT' }
    ],
    dolActivity: new Map([
      ['RAND', { certified_count: 34, sample_titles: ['Research Scientist'] }],
      ['BUSY STATE UNIVERSITY', { certified_count: 120, sample_titles: ['Postdoctoral Fellow'] }]
    ]),
    uscisActivity: new Map([['RAND', 120]]),
    registryResolver
  });
  const names = candidates.map((candidate) => candidate.name);
  assert(names.includes('RAND CORPORATION'));
  assert(names.includes('Busy State University'));
  assert(!names.includes('KNOWN RESEARCH INSTITUTE'), 'registry orgs excluded');
  assert(!names.includes('SLEEPY RESEARCH SOCIETY'), 'no activity -> gated out');
  assert(!names.includes('Idle College'), 'no activity -> gated out');
  assert.strictEqual(candidates[0].name, 'Busy State University', 'ipeds+dol outranks irs+dol+uscis here');
  assert(candidates.every((candidate) => candidate.suggested_registry_entry.id.length > 0));
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

const SCORING_FIXTURE_PROFILE = {
  schema_version: 2,
  core: {
    summary: 'ML person.',
    career_stage: 'early_career',
    years_experience: 4,
    degrees: [
      { level: 'masters', field: 'Computer Science', status: 'completed' },
      { level: 'phd', field: 'Computer Science', status: 'in_progress' }
    ],
    avoid_signals: ['registered nurse'],
    notes_for_ranking: ''
  },
  variants: [
    {
      id: 'ml',
      label: 'ML Engineer',
      intent: 'Leads with production ML',
      title_classes: ['data_computational', 'engineering_software'],
      domains: ['machine learning'],
      skills: [
        { term: 'pytorch', weight: 3, aliases: ['torch'] },
        { term: 'python', weight: 3, aliases: [] },
        { term: 'mlops', weight: 2, aliases: [] },
        { term: 'docker', weight: 1, aliases: [] }
      ],
      target_titles: ['machine learning engineer']
    },
    {
      id: 'de',
      label: 'Data Engineer',
      intent: 'Leads with pipelines',
      title_classes: ['engineering_software'],
      domains: ['data engineering'],
      skills: [
        { term: 'airflow', weight: 3, aliases: [] },
        { term: 'sql', weight: 3, aliases: [] },
        { term: 'python', weight: 2, aliases: [] }
      ],
      target_titles: ['data engineer']
    }
  ]
};

const ML_JOB_DESCRIPTION = 'We use PyTorch and torch internals, Python, MLOps and Docker daily. Machine learning production systems.';

function testDegreeGateParsing() {
  const { parseDegreeGate, DEGREE_RANK, compileProfile, scoreJob } = RadarScoring;

  const hard = parseDegreeGate('A PhD in biology is required for this role.', 'scientist');
  assert.strictEqual(hard.required, 'phd');
  assert.strictEqual(hard.softened, false);
  assert.strictEqual(hard.source, 'text');

  const softened = parseDegreeGate('PhD preferred but not required.', 'scientist');
  assert.strictEqual(softened.required, 'phd');
  assert.strictEqual(softened.softened, true);

  const doctoral = parseDegreeGate('Candidates must hold a doctoral degree in a related field.', 'scientist');
  assert.strictEqual(doctoral.required, 'phd');
  assert.strictEqual(doctoral.softened, false);

  const masters = parseDegreeGate("Master's degree required. PhD preferred.", 'scientist');
  assert.strictEqual(masters.required, 'masters');
  assert.strictEqual(masters.softened, false);

  const postdoc = parseDegreeGate('Join our lab and do great research.', 'postdoc');
  assert.strictEqual(postdoc.required, 'phd');
  assert.strictEqual(postdoc.source, 'title_class');

  const mention = parseDegreeGate('Our team includes PhD scientists collaborating broadly.', 'scientist');
  assert.strictEqual(mention.required, null);

  const stateAbbrev = parseDegreeGate('Located in Baltimore, MD 21201. Great team and campus.', 'research_support');
  assert.strictEqual(stateAbbrev.required, null);

  // MD-holders clear PhD gates (equivalent rank)
  assert(DEGREE_RANK.md >= DEGREE_RANK.phd);

  // in_progress matching degree softens the hard penalty (−12, not −25),
  // and does not cap the verdict to stretch
  const compiled = compileProfile(SCORING_FIXTURE_PROFILE);
  const fit = scoreJob({
    title: 'Machine Learning Engineer',
    title_class: 'data_computational',
    department: '',
    description_text: `${ML_JOB_DESCRIPTION} PhD required.`,
    research_relevance_score: 0
  }, compiled, null);
  assert.strictEqual(fit.gate.degree.required, 'phd');
  assert.strictEqual(fit.gate.degree.met, false);
  assert.strictEqual(fit.gate.degree.penalty, RadarScoring.WEIGHTS.DEGREE_GATE_IN_PROGRESS);
  assert.notStrictEqual(fit.verdict, 'stretch');
}

function testVariantScoring() {
  const { compileProfile, scoreJob } = RadarScoring;
  const compiled = compileProfile(SCORING_FIXTURE_PROFILE);

  const fit = scoreJob({
    title: 'Machine Learning Engineer',
    title_class: 'data_computational',
    department: '',
    description_text: ML_JOB_DESCRIPTION,
    research_relevance_score: 0
  }, compiled, null);

  const ml = fit.variants.find((variant) => variant.id === 'ml');
  const de = fit.variants.find((variant) => variant.id === 'de');
  // pytorch(6, torch alias dedupes) + python(6) + mlops(3) + docker(1) = 16
  // + primary class 15 + domain 5 + target title 10 = 46
  assert.strictEqual(ml.score, 46);
  assert.deepStrictEqual(ml.matched[3], ['pytorch', 'python']);
  assert.strictEqual(ml.title_class_match, 'primary');
  assert.strictEqual(ml.target_title_hit, true);
  // python at weight 2 only; no class/domain/title hits
  assert.strictEqual(de.score, 3);
  assert.strictEqual(fit.recommended_variant, 'ml');
  assert.strictEqual(fit.recommended_source, 'deterministic');

  // employer_name is NOT part of the matchable corpus
  const nameOnly = scoreJob({
    title: 'Lab Assistant',
    title_class: 'research_support',
    department: '',
    employer_name: 'PyTorch Machine Learning Institute',
    description_text: 'Wash glassware and prepare buffers.',
    research_relevance_score: 0
  }, compiled, null);
  const mlNameOnly = nameOnly.variants.find((variant) => variant.id === 'ml');
  assert.strictEqual(mlNameOnly.score, 0);

  // Skill points cap at SKILL_CAP even with many core terms
  const wide = compileProfile({
    schema_version: 2,
    core: { career_stage: 'early_career', degrees: [], avoid_signals: [] },
    variants: [{
      id: 'w',
      label: 'Wide',
      skills: Array.from({ length: 10 }, (_, i) => ({ term: `skillterm${i}`, weight: 3, aliases: [] })),
      title_classes: [],
      domains: [],
      target_titles: []
    }]
  });
  const capped = scoreJob({
    title: 'Role',
    title_class: 'other',
    description_text: Array.from({ length: 10 }, (_, i) => `skillterm${i}`).join(' '),
    research_relevance_score: 0
  }, wide, null);
  assert.strictEqual(capped.variants[0].score, RadarScoring.WEIGHTS.SKILL_CAP);
}

function testEligibility() {
  const { compileProfile, scoreJob, parseYearsRequirement, parseLicenseRequirement,
    parseClearanceRequirement, parseStudentOnly, parseInternalOnly } = RadarScoring;
  const compiled = compileProfile(SCORING_FIXTURE_PROFILE); // 4 yrs, masters done, phd in progress
  const assess = (description, extra = {}) => scoreJob({
    title: 'Data Scientist', title_class: 'data_computational',
    description_text: description, research_relevance_score: 0, ...extra
  }, compiled, null).eligibility;

  const LONG = 'We are a research group building analysis pipelines for a large study. '.repeat(8);

  // Clean posting: nothing found, enough text read → clear.
  const clean = assess(`${LONG} Responsibilities include analysis and reporting.`);
  assert.strictEqual(clean.verdict, 'clear');
  assert.deepStrictEqual(clean.blockers, []);
  assert.strictEqual(clean.insufficient_text, false);

  // Years of experience never gates. Postings overstate it, and walling off
  // "5+ years" lost research associate roles that were a stretch rather than
  // an impossibility; the judge model reads the requirement itself.
  const tooSenior = assess(`${LONG} Minimum of 10 years of experience is required.`);
  assert.strictEqual(tooSenior.verdict, 'clear');
  assert.deepStrictEqual(tooSenior.blockers, []);
  assert.deepStrictEqual(tooSenior.cautions, []);
  assert.strictEqual(assess(`${LONG} Requires a minimum of 5 years of experience.`).verdict, 'clear');
  assert.strictEqual(assess(`${LONG} 10 years of experience preferred.`).verdict, 'clear');
  // Years that aren't about experience must not count.
  assert.strictEqual(assess(`${LONG} The required grant runs for 10 years.`).verdict, 'clear');
  assert.strictEqual(parseYearsRequirement('a 3 year appointment is required'), null);

  // Licences: real requirement blocks, a mention does not.
  const nurse = assess(`${LONG} A current Registered Nurse license is required.`);
  assert.strictEqual(nurse.verdict, 'blocked');
  assert.strictEqual(nurse.blockers[0].type, 'license');
  assert.strictEqual(assess(`${LONG} You will collaborate with registered nurses on the ward.`).verdict, 'clear');
  assert(parseLicenseRequirement('An active RN license is required for this post'));
  assert.strictEqual(parseLicenseRequirement('Board certification preferred but not required'), null);

  // Clearance, student-only, internal-only.
  assert.strictEqual(assess(`${LONG} An active security clearance is required.`).verdict, 'blocked');
  assert.strictEqual(assess(`${LONG} Clearance is not required for this position.`).verdict, 'clear');
  assert.strictEqual(assess(`${LONG} Applicants must be currently enrolled students.`).verdict, 'blocked');
  // An invitation is not a restriction.
  assert.strictEqual(assess(`${LONG} Currently enrolled students may also apply.`).verdict, 'clear');
  assert.strictEqual(assess(`${LONG} Internal applicants only.`).verdict, 'blocked');
  assert(parseClearanceRequirement('A top secret clearance is required'));
  assert(parseStudentOnly('Must be a current student, minimum 6 credits required', 'Intern'));
  assert(parseInternalOnly('This posting is open to current employees only.'));

  // Citizenship comes from metadata and always blocks, with a reason.
  const federal = assess(LONG, { citizenship_gated: true, restricted_reason: 'U.S. citizens only' });
  assert.strictEqual(federal.verdict, 'blocked');
  assert.strictEqual(federal.blockers[0].source, 'metadata');

  // Degree: unreachable blocks, in-progress only cautions (it lands before
  // most start dates), softened never blocks.
  const mdOnly = assess(`${LONG} An MD degree in medicine is required for this clinical role.`);
  assert.strictEqual(mdOnly.verdict, 'blocked');
  assert.strictEqual(mdOnly.blockers[0].type, 'degree');
  const phd = assess(`${LONG} A PhD is required.`);
  assert.strictEqual(phd.verdict, 'likely', 'PhD in progress is a caution, not a wall');
  assert.strictEqual(phd.cautions[0].type, 'degree');
  assert.strictEqual(assess(`${LONG} A PhD is preferred.`).verdict, 'clear');

  // Thin text can never claim "clear" — nothing was read — but also never
  // blocks on absence alone.
  const thin = assess('Analyst wanted.');
  assert.strictEqual(thin.verdict, 'likely');
  assert.strictEqual(thin.insufficient_text, true);
  assert.strictEqual(thin.needs_review, true);
  assert.deepStrictEqual(thin.blockers, []);
  // A quoted blocker still blocks in thin text.
  assert.strictEqual(assess('Internal applicants only.').verdict, 'blocked');

  // Every blocker must be quotable — the UI shows the sentence.
  for (const description of [
    `${LONG} Minimum of 10 years of experience is required.`,
    `${LONG} A current Registered Nurse license is required.`,
    `${LONG} An active security clearance is required.`
  ]) {
    for (const blocker of assess(description).blockers) {
      assert(blocker.evidence && blocker.evidence.length > 0, `blocker ${blocker.type} must carry evidence`);
    }
  }

  // A cached local-model reading supplies job-side facts only, and a claimed
  // years requirement is not one the funnel acts on any more — not even as a
  // caution. It reaches the judge as posting text like everything else.
  const claimed = assess(LONG, { classified_requirements: { min_years: 12 } });
  assert.strictEqual(claimed.verdict, 'clear');

  /* Regressions from the first live precision review (2026-08-04). Both of
     these hid a genuinely good job, which is the failure this layer exists to
     avoid — quoted verbatim from the postings that produced them. */

  // Northeastern "Data Scientist", fit 47: one clause holds both words, and
  // the stricter credential was claiming the requirement.
  const optionalPhd = assess(`${LONG} Education & Experience Master’s degree (required) or Ph.D. (optional) in Computer Science, Engineering, or a related field.`);
  assert.strictEqual(optionalPhd.verdict, 'clear', 'an optional PhD is not a requirement');

  // Six University of Chicago postings, fits 27-44: a range asks for its
  // floor, and alternative routes mean the lowest bar is the real one.
  // These no longer change the verdict — years are ignored by the funnel — but
  // the reading itself still has to be right, since it is reported to the user.
  assert.strictEqual(parseYearsRequirement('requires 5-7 years of experience').min_years, 5,
    '5-7 years asks for 5, not 7');
  assert.strictEqual(
    parseYearsRequirement("Bachelor's degree plus 8 years experience required, Master's degree plus 6 years experience required.").min_years,
    6, 'the most permissive route is the bar');
  assert.strictEqual(
    assess(`${LONG} Minimum qualifications include knowledge and skills developed through 5-7 years of work experience.`).verdict,
    'clear', 'and no amount of stated experience hides the job');
}

function testRoleTrack() {
  const { compileProfile, scoreJob, roleTrack, applyJobClassifications, jobContentHash } = RadarScoring;
  const compiled = compileProfile(SCORING_FIXTURE_PROFILE);
  const job = (title, titleClass) => ({ title, title_class: titleClass, description_text: 'x', research_relevance_score: 0 });

  // Primary class of any variant → this is their line of work.
  assert.strictEqual(roleTrack(job('Analyst', 'data_computational'), compiled).status, 'reachable');
  // engineering_software is the 'de' variant's primary class → reachable.
  assert.strictEqual(roleTrack(job('Developer', 'engineering_software'), compiled).status, 'reachable');
  // A class that is only ever secondary → adjacent, not the main track.
  const secondaryOnly = compileProfile({
    ...SCORING_FIXTURE_PROFILE,
    variants: [{ ...SCORING_FIXTURE_PROFILE.variants[0], title_classes: ['data_computational', 'research_associate'] }]
  });
  const adjacent = roleTrack(job('Research Associate', 'research_associate'), secondaryOnly);
  assert.strictEqual(adjacent.status, 'adjacent');
  assert.deepStrictEqual(adjacent.via, ['ml']);
  // A target title outranks the class: the title says exactly what it is.
  const byTitle = roleTrack(job('Machine Learning Engineer', 'faculty'), compiled);
  assert.strictEqual(byTitle.status, 'reachable');
  assert.strictEqual(byTitle.basis, 'target_title');
  // 'other' is the classifier's fallthrough, not a judgment — unknown, not out.
  assert.strictEqual(roleTrack(job('Widget Coordinator', 'other'), compiled).status, 'unknown');
  assert.strictEqual(roleTrack(job('Widget Coordinator', null), compiled).status, 'unknown');
  // A class no variant claims is genuinely off-track.
  assert.strictEqual(roleTrack(job('Staff Nurse', 'clinical'), compiled).status, 'none');
  // Stamped on the fit, and never moves the score.
  const scored = scoreJob(job('Analyst', 'data_computational'), compiled, null);
  assert.strictEqual(scored.track.status, 'reachable');
  assert.strictEqual(scored.fit_score, scoreJob(job('Analyst', 'data_computational'), compiled, null).fit_score);

  // Cached classifications upgrade title_class before scoring.
  const target = { id: 'j1', title: 'Widget Analyst', department: 'Ops', description_text: 'Some text', title_class: 'other' };
  const cache = {
    labels: { data_computational: 'data & computational' },
    entries: {
      j1: { content_hash: jobContentHash(target), title_class: 'data_computational', requirements: { min_years: 3 } }
    }
  };
  assert.strictEqual(applyJobClassifications([target], cache), 1);
  assert.strictEqual(target.title_class, 'data_computational');
  assert.strictEqual(target.title_class_source, 'llm');
  assert.strictEqual(target.title_class_label, 'data & computational');
  assert.strictEqual(target.classified_requirements.min_years, 3);

  // An edited posting must be re-judged, not silently trusted (the staleness
  // bug the route cache has).
  const edited = { id: 'j1', title: 'Widget Analyst', department: 'Ops', description_text: 'Rewritten text', title_class: 'other' };
  assert.strictEqual(applyJobClassifications([edited], cache), 0);
  assert.strictEqual(edited.title_class, 'other');
  // Missing/empty cache is a clean no-op.
  assert.strictEqual(applyJobClassifications([edited], null), 0);
  assert.strictEqual(applyJobClassifications([edited], { entries: {} }), 0);
}

function testQualifiedPredicate() {
  const { isQualified, compileProfile, scoreAll, emptyFit } = RadarScoring;
  const job = (fit, extra = {}) => ({ status: 'active', citizenship_gated: false, fit, ...extra });
  const fit = (track, eligibility) => ({
    fit_score: 10,
    track: track ? { status: track } : null,
    eligibility: eligibility ? { verdict: eligibility } : null
  });

  // No scored profile → unanswerable, never "zero qualified".
  assert.strictEqual(isQualified(job(emptyFit())), false);
  assert.strictEqual(isQualified({ status: 'active' }), false);

  // In-track and not blocked, in both track flavors.
  assert.strictEqual(isQualified(job(fit('reachable', 'clear'))), true);
  assert.strictEqual(isQualified(job(fit('adjacent', 'likely'))), true);
  // Missing eligibility (thin data) must not disqualify — only a quotable block does.
  assert.strictEqual(isQualified(job(fit('reachable', null))), true);

  // Closed and citizen-only postings are out regardless of fit.
  assert.strictEqual(isQualified(job(fit('reachable', 'clear'), { status: 'closed' })), false);
  assert.strictEqual(isQualified(job(fit('reachable', 'clear'), { citizenship_gated: true })), false);

  // Track no longer gates. It was a guess about whether a job was this
  // person's line of work, made from its title class, and it was the last
  // place a real match could vanish without evidence — it existed only to
  // spare a local model that cost 20s a posting. Judging is cents now, so
  // every off-track job gets read rather than assumed away.
  assert.strictEqual(isQualified(job(fit('unknown', 'clear'))), true);
  assert.strictEqual(isQualified(job(fit('none', 'clear'))), true);
  assert.strictEqual(isQualified(job(fit(null, 'clear'))), true);

  // Blocked is excluded by default but revealable — the same predicate must
  // serve the "+N blocked" count so the two can never disagree.
  const blocked = job(fit('reachable', 'blocked'));
  assert.strictEqual(isQualified(blocked), false);
  assert.strictEqual(isQualified(blocked, { includeBlocked: true }), true);
  // includeBlocked lifts the eligibility gate; closed and citizens-only are
  // facts about the posting and stay out either way.
  assert.strictEqual(isQualified(job(fit('none', 'blocked'), { status: 'closed' }), { includeBlocked: true }), false);
  assert.strictEqual(isQualified(job(fit('none', 'blocked'), { citizenship_gated: true }), { includeBlocked: true }), false);

  // Integration: the shapes scoreAll actually stamps satisfy the predicate.
  const scored = {
    id: 'q1', status: 'active', citizenship_gated: false,
    title: 'Machine Learning Engineer', title_class: 'data_computational',
    description_text: `${ML_JOB_DESCRIPTION} ${'filler '.repeat(80)}`,
    research_relevance_score: 40
  };
  const compiled = compileProfile(SCORING_FIXTURE_PROFILE);
  scoreAll([scored], compiled, null);
  assert.strictEqual(scored.fit.track.status, 'reachable');
  assert.strictEqual(isQualified(scored), true);
  // And without a profile, scoreAll stamps emptyFit → not qualified.
  scoreAll([scored], null, null);
  assert.strictEqual(isQualified(scored), false);
}

/* The profession gate: the deterministic layer that keeps a licensed clinical
 * post away from the judge model. It exists because parseLicenseRequirement
 * needs quotable text and a Physician posting never says "must hold a medical
 * licence" — the title carries it. Measured on the live data it removes 373 of
 * 989 qualified postings (5.5h of model time down to 3.4h) and, across 445
 * judgments, every posting it set aside was one the model also called "no".
 *
 * It must stay porous: these tests pin the cases where it has to hold back. */
function testProfessionGate() {
  const { compileProfile, scoreAll, isQualified } = RadarScoring;
  const { classifyTitle } = require('../radar/scripts/lib/title-class.js');

  // The real profile claims `clinical` among its title classes — a
  // bioinformatics résumé mentioning clinical genomics is enough — which is
  // precisely why roleTrack waved 391 clinical postings through as in-track
  // and why this gate has to exist downstream of it. The fixture has to carry
  // that same claim or it tests a scenario the user does not have.
  const withClinicalTrack = {
    ...SCORING_FIXTURE_PROFILE,
    variants: SCORING_FIXTURE_PROFILE.variants.map((variant, index) => (index === 0
      ? { ...variant, title_classes: [...variant.title_classes, 'clinical'] }
      : variant))
  };
  const compiled = compileProfile(withClinicalTrack);
  const clinician = compileProfile({
    ...withClinicalTrack,
    core: {
      ...withClinicalTrack.core,
      degrees: [{ level: 'md', field: 'Medicine', status: 'completed' }]
    }
  });

  const score = (job, profile = compiled) => {
    const row = {
      id: 'p1', status: 'active', citizenship_gated: false,
      description_text: `${ML_JOB_DESCRIPTION} ${'filler '.repeat(80)}`,
      research_relevance_score: 20, ...job
    };
    scoreAll([row], profile, null);
    return row;
  };
  const professionBlockers = (row) =>
    (row.fit.eligibility.blockers || []).filter((entry) => entry.type === 'profession');

  // A clinical title is a different career, not a stretch.
  const physician = score({ title: 'Physician - Electrophysiology', title_class: 'clinical' });
  assert.strictEqual(professionBlockers(physician).length, 1);
  assert.strictEqual(physician.fit.eligibility.verdict, 'blocked');
  assert(professionBlockers(physician)[0].evidence.includes('Physician - Electrophysiology'),
    'the blocker must quote the title — a job is never hidden for an unshowable reason');
  assert.strictEqual(isQualified(physician), false);
  assert.strictEqual(isQualified(physician, { includeBlocked: true }), true,
    'set aside, never deleted: one click brings it back');

  // Someone who holds the credential is not gated out of their own profession.
  assert.strictEqual(
    professionBlockers(score({ title: 'Physician - Electrophysiology', title_class: 'clinical' }, clinician)).length,
    0);

  // The measured miss this guard exists for: a lab post wearing a clinical
  // title. Held back from the gate, so it reaches the model.
  const fellow = score({ title: 'Research Fellow PC - Radiation Oncology', title_class: 'clinical' });
  assert.strictEqual(professionBlockers(fellow).length, 0);

  // Declared avoid-professions gate on the TITLE...
  const nurse = score({ title: 'Registered Nurse - Sleep Medicine', title_class: 'clinical' });
  assert(professionBlockers(nurse).some((entry) => entry.source === 'avoid_signal'));

  // ...but not in the body, where they stay a score penalty. A data posting
  // that mentions nurses is still a data posting.
  const mentions = score({
    title: 'Machine Learning Engineer', title_class: 'data_computational',
    description_text: `${ML_JOB_DESCRIPTION} Collaborates with a registered nurse. ${'filler '.repeat(80)}`
  });
  assert.strictEqual(professionBlockers(mentions).length, 0);

  // And the classifier fix underneath it: "Research Fellow" is a postdoc even
  // when an oncology word sits next to it, or the gate would swallow lab jobs.
  assert.strictEqual(classifyTitle('Research Fellow PC - Radiation Oncology - Waddle lab'), 'postdoc');
  assert.strictEqual(classifyTitle('Postdoctoral Fellow'), 'postdoc');
  assert.strictEqual(classifyTitle('Clinical Fellow, Cardiology'), 'clinical');
  assert.strictEqual(classifyTitle('Physician - Electrophysiology Cardiologist'), 'clinical');
}

/* profile.md is now the only thing the system knows about the candidate, so
 * how it is read decides what gets surfaced. These pin the two places it can
 * quietly lose something: a capability swallowed by punctuation, and a skill
 * dropped for being too short to match. */
/* The bug this exists to prevent: a debounce that never fires.
 *
 * The judgment cache used a plain debounce, correct while a judgment took 20
 * seconds. Six API workers land one every few hundred milliseconds, every
 * write pushed the deadline back, and the file went 42 minutes untouched
 * holding ~2,900 paid-for judgments. Nothing errored — the writes simply
 * stopped. A policy about time needs a test about time. */
async function testFlushScheduler() {
  const { createFlushScheduler } = require('../radar/scripts/lib/flush-scheduler.js');

  // A hand-cranked clock and timer queue, so this runs in microseconds.
  let clock = 1000;
  let queued = null;
  const setTimer = (fn, ms) => { queued = { fn, at: clock + ms }; return 1; };
  const clearTimer = () => { queued = null; };
  const tick = async (ms) => {
    clock += ms;
    if (queued && clock >= queued.at) { const { fn } = queued; queued = null; await fn(); }
  };

  let writes = 0;
  const s = createFlushScheduler({
    flush: async () => { writes += 1; },
    debounceMs: 3000,
    maxWaitMs: 15000,
    now: () => clock,
    setTimer,
    clearTimer
  });

  // Quiet period: a burst still coalesces into one write.
  s.schedule(); s.schedule(); s.schedule();
  await tick(3000);
  assert.strictEqual(writes, 1, 'a burst coalesces');

  // Sustained load: a write every 500ms, far faster than the 3s debounce.
  // The old code wrote NOTHING here. The ceiling must force writes through.
  for (let i = 0; i < 60; i += 1) { s.schedule(); await tick(500); }
  assert(writes >= 2, `sustained writes must still reach disk (got ${writes})`);
  // 30s of continuous load at a 15s ceiling: at least one forced flush.
  assert(writes <= 12, `but not one write per judgment either (got ${writes})`);

  // Shutdown must not drop work that is already paid for.
  const before = writes;
  s.schedule();
  await s.flushNow();
  assert.strictEqual(writes, before + 1, 'flushNow persists immediately');
  assert.strictEqual(s.pending, false);

  // A failed write keeps the work queued rather than silently dropping it.
  let fail = true;
  const flaky = createFlushScheduler({
    flush: async () => { if (fail) throw new Error('disk full'); },
    debounceMs: 1, now: () => clock, setTimer, clearTimer
  });
  flaky.schedule();
  await assert.rejects(() => flaky.flushNow(), /disk full/);
  assert.strictEqual(flaky.pending, true, 'a failed write stays dirty');
  fail = false;
  await flaky.flushNow();
  assert.strictEqual(flaky.pending, false);
}

function testProfileDocument() {
  const RadarProfileDoc = require('../radar/public/profile-doc.js');
  const { parseProfileDocument, parseCapabilities } = RadarProfileDoc;

  /* Dual-env, same trick and same reason as scoring.js: the browser parses the
   * profile document now that it lives in Supabase rather than on the server's
   * disk, and the judge parses it server-side. Two parsers would eventually
   * disagree, and a disagreement here moves profileHash — which silently
   * orphans every paid-for judgment in the cache. So: one file, both runtimes. */
  assert.strictEqual(globalThis.RadarProfileDoc, RadarProfileDoc,
    'must attach to the global in Node too, exactly as the browser sees it');
  assert.strictEqual(typeof globalThis.RadarProfileDoc.parseProfileDocument, 'function');

  // Parenthesised detail is where the most matchable terms live — a posting
  // says "SARIMAX", not "time-series forecasting". Keep the parent AND each
  // item inside, and never let a comma inside brackets split an entry.
  const { terms, dropped } = parseCapabilities('Python, time-series forecasting (SARIMAX, Prophet), AWS (SageMaker, Lambda), R');
  assert.deepStrictEqual(terms, ['Python', 'time-series forecasting', 'SARIMAX', 'Prophet', 'AWS', 'SageMaker', 'Lambda']);
  // "R" cannot be matched safely — a bare letter hits every posting — but it
  // is reported rather than vanishing, which is the whole contract here.
  assert.deepStrictEqual(dropped, ['R']);

  const doc = parseProfileDocument([
    '---',
    'years_experience: 2',
    'career_stage: student',
    'salary_floor: null',
    'locations: [East Coast, remote]',
    'degrees:',
    '  - level: masters',
    '    field: Applied Data Science',
    '    status: in_progress',
    '  - level: bachelors',
    '    field: Forensic Science',
    '    status: completed',
    'avoid:',
    '  - registered nurse',
    '---',
    '',
    '## Who I am',
    'Christian builds ML systems on biological data.',
    '',
    '## What I can do',
    'Python, PyTorch, BLASTp',
    '',
    '## What I want',
    'Computational biology.'
  ].join('\n'));

  assert.strictEqual(RadarScoring.validateProfile(doc), null, 'must satisfy the scoring engine');
  assert.strictEqual(doc.core.years_experience, 2);
  assert.strictEqual(doc.core.career_stage, 'student');
  assert.strictEqual(doc.core.salary_floor, null, 'a null floor is "none stated", never zero');
  assert.deepStrictEqual(doc.core.locations, ['East Coast', 'remote']);
  assert.strictEqual(doc.core.degrees.length, 2);
  assert.deepStrictEqual(doc.core.degrees[0], { level: 'masters', field: 'Applied Data Science', status: 'in_progress' });
  assert.deepStrictEqual(doc.core.avoid_signals, ['registered nurse']);
  assert.deepStrictEqual(doc.variants[0].skills.map((s) => s.term), ['python', 'pytorch', 'blastp']);

  // One profile, one variant — the scoring engine keeps its best-of-N shape
  // with N=1 rather than being torn up.
  assert.strictEqual(doc.variants.length, 1);
  assert.deepStrictEqual(doc.variants[0].title_classes, [],
    'guessing title classes would invent a constraint the document never stated');

  // The prose is what the judge reads, verbatim.
  assert(doc.prose.includes('Christian builds ML systems'));
  assert(doc.prose.includes('Computational biology.'));

  // An empty avoid list is a legitimate answer, not a missing one.
  assert.deepStrictEqual(parseProfileDocument('---\navoid: []\n---\n\n## Who I am\nx').core.avoid_signals, []);
}

function testSeedCacheKeys() {
  const { parseCacheKey } = require('../radar/scripts/seed-supabase.js');
  const { matchCacheKey } = require('../radar/scripts/lib/match.js');

  // Round-trip against the real key builder, so this test fails if the key
  // format ever moves rather than testing a copy of it.
  const key = matchCacheKey('fnv1a:69236853', 'fnv1a:6dffd8d0', 'in-profile');
  assert.deepStrictEqual(parseCacheKey(key), {
    job_hash: 'fnv1a:69236853',
    profile_hash: 'fnv1a:6dffd8d0'
  });

  /* The two dead generations. Both were judged by a local qwen against the
   * résumé-derived profile.json, under preferences that lived in their own
   * file. Their profile hash is not the current one, so nothing would ever
   * read them back — importing them would only make the row count lie. */
  assert.strictEqual(parseCacheKey('1:fnv1a:69236853:fnv1a:cae25871:0ab9086e'), null);
  assert.strictEqual(parseCacheKey('1:fnv1a:69236853:fnv1a:cae25871:0d97e33b'), null);

  // Malformed input must be dropped, never guessed at.
  assert.strictEqual(parseCacheKey(''), null);
  assert.strictEqual(parseCacheKey(null), null);
  assert.strictEqual(parseCacheKey('1:fnv1a:69236853:fnv1a:6dffd8d0'), null, 'too few parts');
  assert.strictEqual(parseCacheKey('2:fnv1a:69236853:fnv1a:6dffd8d0:in-profile'), null,
    'a future schema version is not silently treated as this one');
  assert.strictEqual(parseCacheKey('1:sha1:69236853:fnv1a:6dffd8d0:in-profile'), null,
    'a different hash function would key rows the scorer cannot address');
}

async function testJudgeFunction() {
  const handler = require('../api/judge.js');
  const { inList, MAX_IDS } = handler;

  /* Job ids are colon-composed, and a bare colon ends a PostgREST value. An
   * unquoted list does not error — it matches nothing, which reads as "no
   * judgments are cached" and re-judges the whole screen at full price. */
  assert.strictEqual(inList(['workday:cornell:WDR-00059001']), '("workday:cornell:WDR-00059001")');
  assert.strictEqual(inList(['a', 'b']), '("a","b")');
  assert.strictEqual(inList(['say "hi"']), '("say ""hi""")', 'quotes are doubled, not dropped');

  // The guards, exercised through the real handler with a fake req/res. None of
  // these paths touch the network, so they hold without any deployment.
  const call = async (request) => {
    const captured = { status: null, body: null };
    const response = {
      setHeader() {},
      status(code) { captured.status = code; return response; },
      json(payload) { captured.body = payload; return response; },
      end() { return response; }
    };
    await handler({ headers: {}, ...request }, response);
    return captured;
  };

  assert.strictEqual((await call({ method: 'GET' })).status, 405, 'GET is not a judging verb');
  assert.strictEqual((await call({ method: 'OPTIONS' })).status, 204, 'preflight is answered');

  const saved = {
    url: process.env.SUPABASE_URL,
    service: process.env.SUPABASE_SERVICE_KEY,
    secret: process.env.SUPABASE_SECRET_KEY,
    openai: process.env.OPENAI_API_KEY
  };
  const restore = () => {
    for (const [name, value] of [['SUPABASE_URL', saved.url], ['SUPABASE_SERVICE_KEY', saved.service],
      ['SUPABASE_SECRET_KEY', saved.secret], ['OPENAI_API_KEY', saved.openai]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  };
  for (const name of ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'SUPABASE_SECRET_KEY', 'OPENAI_API_KEY']) {
    delete process.env[name];
  }

  const unconfigured = await call({ method: 'POST', body: { ids: ['x'] } });
  assert.strictEqual(unconfigured.status, 500);
  // The 500 must NAME what is missing. A generic "not configured" cost a live
  // deployment's worth of guessing about which of three variables was wrong.
  assert.match(unconfigured.body.error, /SUPABASE_URL/);
  assert.match(unconfigured.body.error, /OPENAI_API_KEY/);

  /* Supabase's dashboard issues the key as SUPABASE_SECRET_KEY now, while CI
   * holds it as SUPABASE_SERVICE_KEY. Both must satisfy the check — the name a
   * key happened to be pasted under is not a reason for judging to be down. */
  process.env.SUPABASE_URL = 'https://x.supabase.co';
  process.env.OPENAI_API_KEY = 'sk-test';
  process.env.SUPABASE_SECRET_KEY = 'sb_secret_test';
  // 401 rather than 500 is the signal: the config check passed and it moved on
  // to wanting a token.
  const withSecretName = await call({ method: 'POST', body: { ids: [] } });
  assert.strictEqual(withSecretName.status, 401, 'SUPABASE_SECRET_KEY satisfies the config check');
  delete process.env.SUPABASE_SECRET_KEY;
  process.env.SUPABASE_SERVICE_KEY = 'sb_secret_test';
  const withServiceName = await call({ method: 'POST', body: { ids: [] } });
  assert.strictEqual(withServiceName.status, 401, 'and so does the CI name');
  restore();

  assert(MAX_IDS <= 20, 'a batch has to finish inside the function timeout');
}

async function testAuthClient() {
  const { createAuthClient, needsRefresh, SESSION_KEY } = require('../radar/public/auth.js');

  // Expiry arithmetic, in isolation. The margin exists so a token never dies
  // mid-request; without it the UI would have to interpret a 401 that means
  // "try again" rather than "you are signed out".
  assert.strictEqual(needsRefresh(null, 1000), false, 'no session is not a stale session');
  assert.strictEqual(needsRefresh({ access_token: 't', expires_at: 500000 }, 100000), false);
  assert.strictEqual(needsRefresh({ access_token: 't', expires_at: 150000 }, 100000), true, 'inside the margin');
  assert.strictEqual(needsRefresh({ access_token: 't' }, 100000), true, 'unknown expiry counts as stale');

  const makeStorage = () => {
    const map = new Map();
    return {
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => map.set(k, v),
      removeItem: (k) => map.delete(k),
      _map: map
    };
  };
  const ok = (payload) => ({ ok: true, status: 200, json: async () => payload });

  // Password grant stores an absolute expiry, not the relative one GoTrue sends.
  let storage = makeStorage();
  let calls = [];
  let client = createAuthClient({
    url: 'https://x.supabase.co', anonKey: 'anon', storage, now: () => 1000,
    fetchFn: async (url, init) => { calls.push(url); return ok({ access_token: 'a1', refresh_token: 'r1', expires_in: 3600, user: { id: 'u', email: 'e' } }); }
  });
  const session = await client.signIn('e', 'p');
  assert.strictEqual(session.access_token, 'a1');
  assert.strictEqual(session.expires_at, 1000 + 3600000);
  assert.strictEqual(client.signedIn(), true);
  assert.deepStrictEqual(client.user(), { id: 'u', email: 'e' });
  assert(storage.getItem(SESSION_KEY), 'session survives a reload');

  // A fresh token is handed back without touching the network.
  calls = [];
  assert.strictEqual(await client.accessToken(), 'a1');
  assert.deepStrictEqual(calls, [], 'no refresh while the token is good');

  /* Concurrent callers share ONE refresh. The dashboard fires several authed
   * requests at boot; without single-flight they each spend the refresh token
   * and all but one fails. */
  storage = makeStorage();
  storage.setItem(SESSION_KEY, JSON.stringify({ access_token: 'old', refresh_token: 'r1', expires_at: 0 }));
  let refreshCount = 0;
  client = createAuthClient({
    url: 'https://x.supabase.co', anonKey: 'anon', storage, now: () => 1000000,
    fetchFn: async () => { refreshCount += 1; return ok({ access_token: 'a2', refresh_token: 'r2', expires_in: 3600 }); }
  });
  const tokens = await Promise.all([client.accessToken(), client.accessToken(), client.accessToken()]);
  assert.deepStrictEqual(tokens, ['a2', 'a2', 'a2']);
  assert.strictEqual(refreshCount, 1, 'three callers, one refresh');

  // A rejected refresh token will not start working — that is signed out, not
  // a retry loop.
  storage = makeStorage();
  storage.setItem(SESSION_KEY, JSON.stringify({ access_token: 'old', refresh_token: 'bad', expires_at: 0 }));
  client = createAuthClient({
    url: 'https://x.supabase.co', anonKey: 'anon', storage, now: () => 1000000,
    fetchFn: async () => ({ ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) })
  });
  assert.strictEqual(await client.accessToken(), null);
  assert.strictEqual(storage.getItem(SESSION_KEY), null, 'a dead session is cleared, not kept');
  assert.strictEqual(await client.headers(), null, 'no headers means the caller must not pretend');

  // A failed sign-in surfaces the server's reason rather than a generic one.
  client = createAuthClient({
    url: 'https://x.supabase.co', anonKey: 'anon', storage: makeStorage(), now: () => 0,
    fetchFn: async () => ({ ok: false, status: 400, json: async () => ({ error_description: 'Invalid login credentials' }) })
  });
  await assert.rejects(() => client.signIn('e', 'nope'), /Invalid login credentials/);
}

async function testBatchWrite() {
  const { writeAllBatches, isTransientPostgrestError } = require('../radar/scripts/lib/batch-write.js');
  const noSleep = async () => {};
  const rows = (n) => Array.from({ length: n }, (_, i) => ({ id: `r${i}` }));

  // Both PostgREST clients in this repo bake the status into the message, so
  // the classifier has to read it out of the string rather than off the error.
  assert.strictEqual(isTransientPostgrestError(new Error('POST /jobs → 500: boom')), true);
  assert.strictEqual(isTransientPostgrestError(new Error('supabase POST /jobs: 429 slow down')), true);
  assert.strictEqual(isTransientPostgrestError(Object.assign(new Error('x'), { name: 'AbortError' })), true);
  assert.strictEqual(isTransientPostgrestError(new Error('fetch failed')), true);
  // A duplicate key or a malformed row fails identically however small the
  // batch is; retrying or splitting it only buys the same error again.
  assert.strictEqual(isTransientPostgrestError(new Error('POST /match_cache → 400: 21000 cannot affect row a second time')), false);
  assert.strictEqual(isTransientPostgrestError(new Error('POST /jobs → 401: bad key')), false);

  // Batches go out one at a time — this database punishes concurrency, not depth.
  let inFlight = 0;
  const sizes = [];
  await writeAllBatches(rows(250), async (batch) => {
    inFlight += 1;
    assert.strictEqual(inFlight, 1, 'batches must not overlap');
    sizes.push(batch.length);
    await new Promise((resolve) => setTimeout(resolve, 1));
    inFlight -= 1;
  }, { batchSize: 100, sleep: noSleep });
  assert.deepStrictEqual(sizes, [100, 100, 50]);

  // A transient failure is retried, not dropped.
  let attempts = 0;
  const retried = await writeAllBatches(rows(3), async () => {
    attempts += 1;
    if (attempts < 3) throw new Error('supabase POST /jobs: 503 busy');
  }, { batchSize: 10, sleep: noSleep });
  assert.strictEqual(attempts, 3);
  assert.strictEqual(retried.written, 3);

  // A batch that keeps timing out gets cut in half rather than abandoned: the
  // statement timeout is about the size of the write, not the rows in it.
  const accepted = [];
  await writeAllBatches(rows(4), async (batch) => {
    if (batch.length > 1) throw new Error('supabase POST /jobs: 504 statement timeout');
    accepted.push(batch[0].id);
  }, { batchSize: 4, attempts: 2, sleep: noSleep });
  assert.deepStrictEqual(accepted, ['r0', 'r1', 'r2', 'r3'], 'splitting must still write every row exactly once');

  // A deterministic error is thrown immediately — no retries, no splitting.
  let calls = 0;
  await assert.rejects(() => writeAllBatches(rows(4), async () => {
    calls += 1;
    throw new Error('POST /jobs → 400: malformed');
  }, { batchSize: 4, sleep: noSleep }), /400/);
  assert.strictEqual(calls, 1);
}

async function testMatchCacheWriter() {
  const {
    dedupeCacheRows, groupMissesByHash, createCacheWriter
  } = require('../radar/scripts/lib/match-cache.js');
  const noSleep = async () => {};
  const row = (hash, id) => ({ job_hash: hash, profile_hash: 'p', job_id: id });

  // THE 21000 GUARD. Two postings with identical text share a hash, and the
  // cache key is (job_hash, profile_hash) — two such rows in one upsert make
  // Postgres reject the entire batch, losing every judgment it carried.
  const deduped = dedupeCacheRows([row('h1', 'a'), row('h2', 'b'), row('h1', 'c')]);
  assert.strictEqual(deduped.length, 2);
  assert.strictEqual(deduped.find((r) => r.job_hash === 'h1').job_id, 'c', 'last occurrence wins, as merge-duplicates does');
  // Same content under a DIFFERENT profile is a different judgment, not a dupe.
  assert.strictEqual(dedupeCacheRows([row('h1', 'a'), { ...row('h1', 'a'), profile_hash: 'q' }]).length, 2);

  const writes = [];
  const writer = createCacheWriter({
    batchSize: 25, sleep: noSleep,
    upsert: async (rows) => { writes.push(rows); }
  });
  for (let i = 0; i < 60; i += 1) writer.push(row(`h${i % 40}`, `j${i}`));
  const closed = await writer.close();
  assert.strictEqual(closed.unwritten, 0);
  assert.strictEqual(closed.failure, null);
  for (const batch of writes) {
    assert(batch.length <= 25, 'batches stay small');
    const keys = batch.map((r) => `${r.job_hash}:${r.profile_hash}`);
    assert.strictEqual(new Set(keys).size, keys.length, 'no batch may carry a key twice');
  }

  // A row leaves the queue only after Supabase confirms it. The old writer
  // spliced first and awaited second, so a failed batch silently discarded
  // ~50 judgments that had already been paid for.
  let failFirst = true;
  const flaky = createCacheWriter({
    batchSize: 2, sleep: noSleep,
    upsert: async () => {
      if (failFirst) { failFirst = false; throw new Error('supabase POST /match_cache: 503 busy'); }
    }
  });
  flaky.push(row('a', '1'));
  flaky.push(row('b', '2'));
  const recovered = await flaky.close();
  assert.strictEqual(recovered.written, 2, 'a transient failure must not lose paid judgments');
  assert.strictEqual(recovered.unwritten, 0);

  // A terminal failure keeps the rows, reports them, and refuses further work
  // so the run stops buying judgments it cannot store.
  const dead = createCacheWriter({
    batchSize: 1, sleep: noSleep,
    upsert: async () => { throw new Error('POST /match_cache → 400: malformed'); }
  });
  dead.push(row('a', '1'));
  const failed = await dead.close();
  assert(failed.failure, 'the failure must be reported, not swallowed');
  assert.strictEqual(failed.written, 0);
  assert.strictEqual(failed.unwritten, 1, 'unwritten rows are counted, never counted as judged');
  assert.strictEqual(dead.push(row('b', '2')), false, 'a dead sink refuses new rows');

  // Grouping: one judgment per distinct content, first (highest fit) kept.
  const misses = [
    { job: { id: 'a' }, hash: 'h1' },
    { job: { id: 'b' }, hash: 'h2' },
    { job: { id: 'c' }, hash: 'h1' }
  ];
  const { representatives, membersByHash } = groupMissesByHash(misses);
  assert.deepStrictEqual(representatives.map((m) => m.job.id), ['a', 'b'], 'fit order is preserved');
  assert.deepStrictEqual(membersByHash.get('h1').map((j) => j.id), ['a', 'c'], 'duplicates ride along for fan-out');
  const distinct = [{ job: { id: 'x' }, hash: 'h9' }];
  assert.strictEqual(groupMissesByHash(distinct).representatives.length, 1, 'no duplicates is the identity case');
}

async function testOpenAiCooldown() {
  const { judgeOnce, noteRateLimit, awaitCooldown, _resetCooldown } = require('../radar/scripts/lib/openai.js');

  // The pause only ever moves forward: a later 429 carrying a shorter
  // Retry-After must not cut short a wait somebody else already earned.
  _resetCooldown();
  noteRateLimit(150);
  noteRateLimit(5);
  const started = Date.now();
  await awaitCooldown();
  assert(Date.now() - started >= 150, 'a shorter Retry-After must not shorten an existing pause');

  // And an expired pause costs nothing.
  const clear = Date.now();
  await awaitCooldown();
  assert(Date.now() - clear < 100, 'no pause outstanding means no wait');

  // A 429 pauses the whole process, not just the caller that received it.
  _resetCooldown();
  const originalFetch = globalThis.fetch;
  const fetchedAt = [];
  try {
    let first = true;
    globalThis.fetch = async () => {
      fetchedAt.push(Date.now());
      if (first) {
        first = false;
        return { ok: false, status: 429, headers: { get: () => '0.2' }, text: async () => 'slow down' };
      }
      return {
        ok: true, status: 200,
        json: async () => ({ choices: [{ message: { content: '{}' } }], usage: {} })
      };
    };
    const begin = Date.now();
    await judgeOnce({ key: 'k', model: 'gpt-5.6-luna', system: 's', user: 'u', schema: {} });
    const elapsed = Date.now() - begin;
    assert(elapsed >= 200, `a 429 must be waited out, waited ${elapsed}ms`);
    assert(fetchedAt.length === 2, 'one retry after the rate limit');
  } finally {
    globalThis.fetch = originalFetch;
    _resetCooldown();
  }
}

function testJudgeJobsScript() {
  const { parseArgs, diffMisses, rowFromJudgment } = require('../radar/scripts/judge-jobs.js');
  const { deriveVerdict } = require('../radar/scripts/lib/match.js');

  // The spend cap has to default to something, because CI runs this unattended
  // on a schedule and an uncapped loop over a fresh pool is a real bill.
  const defaults = parseArgs([]);
  assert.strictEqual(defaults.maxSpend, 5);
  assert.strictEqual(defaults.limit, Infinity);
  assert.strictEqual(defaults.dryRun, false);
  assert.strictEqual(defaults.pruneStaleProfiles, false, 'pruning is never the default');

  const custom = parseArgs(['--dry-run', '--max-spend', '0.5', '--limit', '10', '--prune-stale-profiles']);
  assert.deepStrictEqual(custom, { dryRun: true, maxSpend: 0.5, limit: 10, pruneStaleProfiles: true });

  // Only postings with no judgment under THIS profile are worth paying for.
  const pool = [{ job: { id: 'a' }, hash: 'fnv1a:1' }, { job: { id: 'b' }, hash: 'fnv1a:2' }];
  assert.deepStrictEqual(diffMisses(pool, new Set(['fnv1a:1'])).map((m) => m.job.id), ['b']);
  assert.strictEqual(diffMisses(pool, new Set(['fnv1a:1', 'fnv1a:2'])).length, 0);
  assert.strictEqual(diffMisses(pool, new Set()).length, 2);

  // A row must carry every column match_cache declares NOT NULL, and the
  // verdict must be the derived one rather than anything the model wrote.
  const judgment = {
    verdict: deriveVerdict({ different_profession: false, meets_requirements: true, matches_preferences: true }),
    different_profession: false,
    meets_requirements: true,
    matches_preferences: true,
    role_summary: 'Research data analyst',
    reasons: ['overlap'],
    gaps: []
  };
  const row = rowFromJudgment({ id: 'workday:x:1' }, 'fnv1a:9', 'fnv1a:p', judgment, 'gpt-5.6-luna', '2026-08-07T00:00:00.000Z');
  assert.strictEqual(row.verdict, 'strong');
  assert.strictEqual(row.job_hash, 'fnv1a:9');
  assert.strictEqual(row.profile_hash, 'fnv1a:p');
  assert.strictEqual(row.job_id, 'workday:x:1');
  for (const column of ['different_profession', 'meets_requirements', 'matches_preferences']) {
    assert.strictEqual(typeof row[column], 'boolean', `${column} is NOT NULL in the table`);
  }
  assert(Array.isArray(row.reasons) && Array.isArray(row.gaps), 'jsonb columns take arrays');

  // A judgment missing its arrays still produces a storable row rather than
  // failing the whole batch on a null.
  const sparse = rowFromJudgment({ id: 'j' }, 'h', 'p', { ...judgment, reasons: undefined, gaps: null }, 'm', 'now');
  assert.deepStrictEqual(sparse.reasons, []);
  assert.deepStrictEqual(sparse.gaps, []);
}

function testJudgedMatch() {
  const {
    deriveVerdict, normalizeJudgment, matchCacheKey, candidateBrief, jobBrief,
    JUDGMENT_SCHEMA, VERDICT_RANK, compareJudged, DESCRIPTION_LIMIT
  } = require('../radar/scripts/lib/match.js');

  // The aggregation the model could not do reliably, now plain code.
  assert.strictEqual(deriveVerdict({ different_profession: true, meets_requirements: true, matches_preferences: true }), 'no',
    'a different profession is a no however well the words overlap');
  assert.strictEqual(deriveVerdict({ different_profession: false, meets_requirements: false, matches_preferences: true }), 'stretch');
  assert.strictEqual(deriveVerdict({ different_profession: false, meets_requirements: true, matches_preferences: false }), 'possible');
  assert.strictEqual(deriveVerdict({ different_profession: false, meets_requirements: true, matches_preferences: true }), 'strong');

  // FIELD ORDER IS THE FIX for the all-"strong" bug: evidence is decoded
  // before any judgment, and the model never emits a verdict at all.
  const order = JUDGMENT_SCHEMA.required;
  assert.strictEqual(order[0], 'role_summary', 'the model must describe the role before judging it');
  assert(order.indexOf('different_profession') < order.indexOf('reasons'));
  assert(!('verdict' in JUDGMENT_SCHEMA.properties), 'verdict is derived, never asked for');

  assert(!('resume_id' in JUDGMENT_SCHEMA.properties),
    'picking which résumé to send is the human\'s call, not a field the model fills');

  const raw = {
    role_summary: 'Bedside nurse practitioner role, clinical not computational',
    different_profession: true,
    meets_requirements: false,
    matches_preferences: false,
    reasons: [],
    gaps: ['  Requires   RN licence  ']
  };
  const judged = normalizeJudgment(raw);
  assert.strictEqual(judged.verdict, 'no');
  assert.strictEqual(judged.gaps[0], 'Requires RN licence', 'whitespace is collapsed for display');

  // A missing boolean means the model did not answer — inventing a default
  // would manufacture matches, so the judgment is discarded and retried.
  assert.strictEqual(normalizeJudgment({ ...raw, meets_requirements: undefined }), null);
  assert.strictEqual(normalizeJudgment(null), null);
  // Long lists and long lines are clamped so one bad judgment can't wreck a row.
  const wordy = normalizeJudgment({ ...raw, reasons: ['a', 'b', 'c', 'd'], gaps: ['x'.repeat(400)] });
  assert.strictEqual(wordy.reasons.length, 2);
  assert(wordy.gaps[0].length <= 110);

  // Cache identity must move when the profile or the preferences move —
  // otherwise yesterday's judgment describes a person who has changed.
  const key = matchCacheKey('job1', 'profA', 'prefA');
  assert.strictEqual(key, matchCacheKey('job1', 'profA', 'prefA'));
  assert.notStrictEqual(key, matchCacheKey('job1', 'profB', 'prefA'));
  assert.notStrictEqual(key, matchCacheKey('job1', 'profA', 'prefB'));
  assert.notStrictEqual(key, matchCacheKey('job2', 'profA', 'prefA'));

  // Judged verdict outranks the deterministic score; fit only breaks ties.
  const rows = [
    { id: 'a', fit: { fit_score: 80 }, match: { verdict: 'stretch' } },
    { id: 'b', fit: { fit_score: 10 }, match: { verdict: 'strong' } },
    { id: 'c', fit: { fit_score: 40 }, match: { verdict: 'strong' } }
  ];
  assert.deepStrictEqual([...rows].sort(compareJudged).map((row) => row.id), ['c', 'b', 'a']);
  assert(VERDICT_RANK.strong < VERDICT_RANK.no);

  // The authored document IS the brief, passed through verbatim. That is the
  // point: editing profile.md changes the judging with nothing in between to
  // reinterpret it, and no seven-variant summary rides on every posting.
  const prose = '## Who I am\nML person.\n\n## What I want\nHealth data research.';
  assert.strictEqual(candidateBrief({ core: {}, variants: [], prose }), prose);

  // A legacy profile.json still judges rather than yielding an empty brief.
  const legacy = candidateBrief({
    core: { summary: 'ML person', degrees: [{ level: 'masters', status: 'in_progress' }], years_experience: 3 },
    variants: [{ id: 'ml-engineer', label: 'ML Engineer', skills: [{ term: 'pytorch', weight: 3 }] }]
  }, 'Wants: health data');
  assert(legacy.includes('pytorch'));
  assert(legacy.includes('health data'), 'stated preferences ride in the prompt');

  // Postings get truncated so prefill time stays bounded.
  const long = jobBrief({ title: 'T', employer_name: 'E', description_text: 'z'.repeat(20000) });
  assert(long.length < DESCRIPTION_LIMIT + 500);

  // Boilerplate is cut from the tail, and only from the tail. The floor
  // matters: plenty of postings open with an equal-opportunity line, and
  // cutting there would hand the model an empty posting to judge.
  const { stripBoilerplate } = require('../radar/scripts/lib/match.js');
  const requirements = 'Requires Python, SQL and three years of experience building ML pipelines. ';
  assert.strictEqual(
    stripBoilerplate(`${requirements}${requirements}The University is an Equal Opportunity Employer and does not discriminate.`),
    `${requirements}${requirements}`.trimEnd(),
    'the EEO tail goes'
  );
  const frontLoaded = `We are an equal opportunity employer. ${requirements.repeat(3)}`;
  assert.strictEqual(stripBoilerplate(frontLoaded), frontLoaded.trimEnd(),
    'a boilerplate opening is kept — the requirements are behind it');
  assert.strictEqual(stripBoilerplate(''), '');
}

function testManifestSync() {
  const { syncManifest, slugify, isResumeFile, labelFromFile } = require('../radar/scripts/lib/manifest-sync.js');

  // The bug this exists to kill: a dropped-in resume used to be silently
  // ignored because the manifest was non-empty and valid.
  const existing = {
    schema_version: 1,
    variants: [{ id: 'ml-engineer', label: 'ML Engineer', file: 'ML.pdf', intent: 'ML engineer' }]
  };
  const synced = syncManifest(existing, ['ML.pdf', 'New_Resume.docx', '.DS_Store', 'notes.rtf']);
  assert.strictEqual(synced.added.length, 1, 'only the unregistered resume is added');
  assert.strictEqual(synced.added[0].file, 'New_Resume.docx');
  assert.strictEqual(synced.added[0].intent, '', 'intent is left for the caller to fill');
  assert.strictEqual(synced.added[0].intent_source, 'auto');
  assert.strictEqual(synced.changed, true);
  assert.strictEqual(synced.manifest.variants.length, 2);
  // The hand-written entry is untouched.
  assert.deepStrictEqual(synced.manifest.variants[0], existing.variants[0]);
  // Dotfiles (.extract-cache.json lives in this dir) and non-resume types are ignored.
  assert.strictEqual(isResumeFile('.extract-cache.json'), false);
  assert.strictEqual(isResumeFile('notes.rtf'), false);
  assert.strictEqual(isResumeFile('CV.PDF'), true, 'extension check is case-insensitive');

  // A file that vanished is reported, never auto-deleted — a moved file must
  // cost one variant, not the whole profile.
  const gone = syncManifest(existing, []);
  assert.strictEqual(gone.missing.length, 1);
  assert.strictEqual(gone.missing[0].file, 'ML.pdf');
  assert.strictEqual(gone.added.length, 0);

  // Ids stay unique when two files slugify the same.
  const collide = syncManifest({ schema_version: 1, variants: [] }, ['Resume.pdf', 'resume.docx']);
  const ids = collide.manifest.variants.map((v) => v.id);
  assert.strictEqual(new Set(ids).size, 2, `ids must be unique, got ${ids.join(',')}`);
  for (const id of ids) assert.match(id, /^[a-z0-9][a-z0-9-]{0,23}$/, `${id} must satisfy manifest id rules`);

  // Null/absent manifest bootstraps from the directory listing.
  const fresh = syncManifest(null, ['Mangwanda_Resume_DataEngineer.docx']);
  assert.strictEqual(fresh.manifest.schema_version, 1);
  assert.strictEqual(fresh.manifest.variants[0].id, 'mangwanda-resume-dataeng');
  assert.strictEqual(fresh.manifest.variants[0].label, 'Mangwanda Resume DataEngineer');
  assert.strictEqual(labelFromFile('CM Resume .pdf'), 'CM Resume');
  assert.strictEqual(slugify('CM Resume .pdf'), 'cm-resume');
}

// The refresh pool decides the order of a committed artifact and how hard we
// hit other people's servers, so both properties are pinned here.
async function testRefreshPool() {
  // Results come back in INPUT order even when completion order is reversed.
  const items = [1, 2, 3, 4, 5, 6, 7, 8];
  const out = await runPooled(items, async (n) => {
    await new Promise((resolve) => setTimeout(resolve, (9 - n) * 4));
    return n * 10;
  }, { concurrency: 4, perProvider: 4 });
  assert.deepStrictEqual(out, [10, 20, 30, 40, 50, 60, 70, 80], 'pool must preserve input order');

  // Global concurrency is never exceeded.
  let inFlight = 0;
  let peak = 0;
  await runPooled(Array.from({ length: 20 }, (_, i) => i), async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
  }, { concurrency: 3, perProvider: 3 });
  assert.strictEqual(peak, 3, `global concurrency cap breached (peak ${peak})`);

  // Per-provider cap holds even when the global cap would allow more.
  const providerItems = Array.from({ length: 12 }, (_, i) => ({ provider: i < 8 ? 'workday' : `p${i}`, id: i }));
  const load = new Map();
  let providerPeak = 0;
  await runPooled(providerItems, async (item) => {
    load.set(item.provider, (load.get(item.provider) || 0) + 1);
    providerPeak = Math.max(providerPeak, load.get('workday') || 0);
    await new Promise((resolve) => setTimeout(resolve, 5));
    load.set(item.provider, load.get(item.provider) - 1);
  }, { concurrency: 8, perProvider: 2, groupOf: (item) => item.provider });
  assert(providerPeak <= 2, `per-provider cap breached (peak ${providerPeak})`);

  // Two employers sharing a host lane never overlap.
  const laneItems = [{ lane: 'a' }, { lane: 'a' }, { lane: 'a' }, { lane: 'b' }];
  let laneActive = 0;
  let laneOverlap = false;
  await runPooled(laneItems, async (item) => {
    if (item.lane === 'a') {
      laneActive += 1;
      if (laneActive > 1) laneOverlap = true;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (item.lane === 'a') laneActive -= 1;
  }, { concurrency: 4, perProvider: 4, laneOf: (item) => item.lane });
  assert(!laneOverlap, 'same-host employers must not run concurrently');

  // A worker that throws drains the pool and then surfaces the error, rather
  // than leaving siblings as unhandled rejections.
  let finished = 0;
  let caught = null;
  try {
    await runPooled([1, 2, 3, 4], async (n) => {
      await new Promise((resolve) => setTimeout(resolve, n * 3));
      if (n === 2) throw new Error('boom');
      finished += 1;
    }, { concurrency: 4, perProvider: 4 });
  } catch (error) {
    caught = error;
  }
  assert(caught && /boom/.test(caught.message), 'pool must rethrow a worker error');
  assert.strictEqual(finished, 3, 'pool must drain remaining work before rethrowing');

  // A named provider overrides the global per-provider cap. ADP's tenants are
  // all one host, so four at a time is what makes it answer 429.
  const adpItems = Array.from({ length: 6 }, (_, i) => ({ provider: i < 4 ? 'adp' : 'workday', id: i }));
  let adpInFlight = 0;
  let adpPeak = 0;
  let workdayPeak = 0;
  let workdayInFlight = 0;
  await runPooled(adpItems, async (item) => {
    if (item.provider === 'adp') { adpInFlight += 1; adpPeak = Math.max(adpPeak, adpInFlight); }
    else { workdayInFlight += 1; workdayPeak = Math.max(workdayPeak, workdayInFlight); }
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (item.provider === 'adp') adpInFlight -= 1; else workdayInFlight -= 1;
  }, { concurrency: 8, perProvider: 4, groupOf: (item) => item.provider, providerLimits: { adp: 1 } });
  assert.strictEqual(adpPeak, 1, `ADP must run one tenant at a time (peak ${adpPeak})`);
  assert(workdayPeak > 1, 'a named limit must not throttle every other provider');

  // hostLane keys on the primary feed; employers with no feed get no lane.
  assert.strictEqual(hostLane({ ats_provider: 'workday', ats_token: 'cornell' }), 'workday:cornell');
  assert.strictEqual(hostLane({ ats_provider: null, ats_token: null }), null);
  // ADP is the exception: every "tenant" is a cid on ONE host, so keying the
  // lane on the token invented 47 lanes over a single server.
  assert.strictEqual(hostLane({ ats_provider: 'adp', ats_token: 'aaa' }), 'adp:workforcenow.adp.com');
  assert.strictEqual(
    hostLane({ ats_provider: 'adp', ats_token: 'aaa' }),
    hostLane({ ats_provider: 'adp', ats_token: 'bbb' }),
    'two ADP tenants must share one lane'
  );
  assert.strictEqual(
    hostLane({ ats_provider: null, ats_token: null, secondary_ats_feeds: [{ ats_provider: 'interfolio', ats_token: 'x' }] }),
    'interfolio:x',
    'an employer whose only feed is a secondary one still gets that lane'
  );

  // The pacer staggers starts within one provider but never across providers.
  const pacer = createProviderPacer(30);
  const started = Date.now();
  await pacer('workday');
  await pacer('workday');
  const sameProviderElapsed = Date.now() - started;
  assert(sameProviderElapsed >= 25, `same-provider starts must be staggered (was ${sameProviderElapsed}ms)`);
  const crossStart = Date.now();
  await pacer('peopleadmin');
  assert(Date.now() - crossStart < 25, 'a different provider must not wait behind another provider');

  // A named provider can be paced more slowly than the rest.
  const slowPacer = createProviderPacer(5, { adp: 40 });
  await slowPacer('adp');
  const adpStart = Date.now();
  await slowPacer('adp');
  assert(Date.now() - adpStart >= 35, 'ADP must get its own, slower stagger');
}

function testProviderBreaker() {
  const { createProviderBreaker, breakerSignature } = require('../radar/scripts/refresh.js');

  // Only failures a vendor produces identically everywhere are evidence about
  // the vendor. A timeout is evidence about the runner's network.
  assert.strictEqual(breakerSignature('non-JSON response (content-type text/html) from x.com'), 'non-json');
  assert.strictEqual(breakerSignature('HTTP 503 Service Unavailable'), 'http:503');
  assert.strictEqual(breakerSignature('fetch failed'), null);
  assert.strictEqual(breakerSignature('The operation was aborted'), null);

  // Four tenants is a bad day; five unrelated tenants failing the same way is
  // the vendor.
  const breaker = createProviderBreaker({ threshold: 5 });
  for (const id of ['a', 'b', 'c', 'd']) breaker.record('workday', id, 'non-JSON response (content-type text/html) from w');
  assert.strictEqual(breaker.openSignature('workday'), null, 'four tenants must not trip the breaker');
  breaker.record('workday', 'e', 'non-JSON response (content-type text/html) from w');
  assert.strictEqual(breaker.openSignature('workday'), 'non-json');
  assert.deepStrictEqual(breaker.tripped(), [{ provider: 'workday', signature: 'non-json' }]);
  assert.strictEqual(breaker.openSignature('oracle'), null, 'one vendor going down says nothing about another');

  // One tenant failing repeatedly is still one tenant.
  const repeat = createProviderBreaker({ threshold: 5 });
  for (let i = 0; i < 10; i += 1) repeat.record('adp', 'same-employer', 'HTTP 429 Too Many Requests');
  assert.strictEqual(repeat.openSignature('adp'), null, 'distinct employers are counted, not attempts');

  // Different failure modes do not pool into one count.
  const mixed = createProviderBreaker({ threshold: 3 });
  mixed.record('oracle', 'a', 'HTTP 500 Server Error');
  mixed.record('oracle', 'b', 'HTTP 404 Not Found');
  mixed.record('oracle', 'c', 'non-JSON response (content-type text/html) from o');
  assert.strictEqual(mixed.openSignature('oracle'), null, 'three unrelated failures are not an outage');

  // Timeouts can never trip it, however many there are — a wedged runner must
  // not stop the refresh from trying.
  const flaky = createProviderBreaker({ threshold: 2 });
  for (const id of ['a', 'b', 'c', 'd']) flaky.record('workday', id, 'fetch failed');
  assert.strictEqual(flaky.openSignature('workday'), null);
}

function testFitAudit() {
  const { histogram, variantCeilings, sampleBlocked, seededShuffle, parseArgs } = require('../radar/scripts/fit-audit.js');

  const jobs = [
    { fit: { fit_score: 52, verdict: 'strong' } },
    { fit: { fit_score: 51, verdict: 'strong' } },
    { fit: { fit_score: 12, verdict: 'stretch' } },
    { fit: { fit_score: null, verdict: null } },
    {}
  ];
  const hist = histogram(jobs);
  assert.strictEqual(hist.scored, 3, 'unscored jobs are excluded');
  assert.strictEqual(hist.buckets.get(50), 2);
  assert.strictEqual(hist.tiers.get('strong'), 2);

  // Ceilings expose the breadth-beats-precision effect (a short skill list
  // cannot reach the cap however perfect the posting).
  const ceilings = variantCeilings({
    variants: [
      { id: 'wide', skills: Array.from({ length: 10 }, () => ({ weight: 3 })) },
      { id: 'narrow', skills: [{ weight: 3 }, { weight: 1 }] }
    ]
  });
  assert.strictEqual(ceilings[0].reachesCap, true);
  assert.strictEqual(ceilings[1].reachesCap, false);
  assert.strictEqual(ceilings[1].rawSkillPoints, 7);

  // Sampling must be reproducible so a reviewed set can be re-checked.
  const blocked = Array.from({ length: 20 }, (_, i) => ({ id: `j${i}`, fit: { eligibility: { verdict: 'blocked' } } }));
  const first = sampleBlocked(blocked, 5, 7);
  assert.strictEqual(first.total, 20);
  assert.strictEqual(first.sample.length, 5);
  assert.deepStrictEqual(first.sample.map((job) => job.id), sampleBlocked(blocked, 5, 7).sample.map((job) => job.id));
  assert.notDeepStrictEqual(seededShuffle(blocked, 1).map((j) => j.id), seededShuffle(blocked, 2).map((j) => j.id));
  assert.strictEqual(sampleBlocked([{ fit: { eligibility: { verdict: 'clear' } } }], 5, 7).total, 0);

  assert.deepStrictEqual(parseArgs(['--sample-blocked', '12', '--seed', '3']), { mode: 'sample-blocked', count: 12, seed: 3 });
  assert.strictEqual(parseArgs(['--histogram']).mode, 'histogram');
  assert.strictEqual(parseArgs([]).mode, null);
}

function testFitEngineRepairs() {
  const { compileProfile, scoreJob, validateProfile, variantHeat, fnv1a, surfaceForms, WEIGHTS } = RadarScoring;
  const mkProfile = (variant) => ({
    schema_version: 2,
    core: { career_stage: 'early_career', degrees: [], avoid_signals: [] },
    variants: [{ id: 'v', label: 'V', skills: [], title_classes: [], domains: [], target_titles: [], ...variant }]
  });
  const mkJob = (description) => ({
    title: 'Role', title_class: 'other', department: '',
    description_text: description, research_relevance_score: 0
  });
  const scoreOf = (variant, description) =>
    scoreJob(mkJob(description), compileProfile(mkProfile(variant)), null).variants[0];

  // Surface forms: plural and hyphen spellings hit the singular/spaced term.
  const etl = { skills: [{ term: 'etl pipeline', weight: 3, aliases: [] }] };
  assert.strictEqual(scoreOf(etl, 'We maintain ETL pipelines daily.').score, 6);
  assert.strictEqual(scoreOf(etl, 'An etl-pipeline mindset.').score, 6);
  // matched_text carries the actual surface string for highlighting.
  assert.deepStrictEqual(scoreOf(etl, 'We maintain ETL pipelines daily.').matched_text, ['etl pipelines']);

  // Underscored domains (live profile shape) now match prose.
  const dom = { domains: ['machine_learning'] };
  const domHit = scoreOf(dom, 'A machine learning group.');
  assert.deepStrictEqual(domHit.domain_hits, ['machine learning']);
  assert.strictEqual(domHit.score, WEIGHTS.DOMAIN_POINTS);

  // Broad aliases credit the parent term at weight 1, and max wins when the
  // real phrase also appears.
  const broad = { skills: [{ term: 'etl pipeline development', weight: 3, aliases: [], broad_aliases: ['etl'] }] };
  const broadOnly = scoreOf(broad, 'Some ETL work.');
  assert.strictEqual(broadOnly.score, 1);
  assert.deepStrictEqual(broadOnly.matched[1], ['etl pipeline development']);
  assert.strictEqual(scoreOf(broad, 'ETL and etl pipeline development.').score, 6);

  // One word, one credit: a phrase serving as a skill never doubles as domain.
  const both = { skills: [{ term: 'python', weight: 3, aliases: [] }], domains: ['python'] };
  assert.strictEqual(scoreOf(both, 'We write python.').score, 6);

  // Skill matching stops at SKILL_MATCH_WINDOW; the degree gate does not.
  const padding = 'lorem ipsum '.repeat(Math.ceil(WEIGHTS.SKILL_MATCH_WINDOW / 12));
  const deep = scoreJob(mkJob(`${padding} python required. PhD required.`),
    compileProfile(mkProfile({ skills: [{ term: 'python', weight: 3, aliases: [] }] })), null);
  assert.strictEqual(deep.variants[0].score, 0, 'deep skill must not score');
  assert.strictEqual(deep.gate.degree.required, 'phd', 'deep gate must still fire');
  assert.strictEqual(deep.thin_text, false);
  assert.strictEqual(scoreJob(mkJob('short'), compileProfile(mkProfile({ skills: [] })), null).thin_text, true);

  // validateProfile structural checks (W11).
  assert.strictEqual(validateProfile(mkProfile({ skills: [] })), null);
  // Duplicates are deduped at compile, not rejected — refusing a whole profile
  // over a repeated title class would strand an otherwise usable import.
  assert.strictEqual(validateProfile(mkProfile({ skills: [], title_classes: ['faculty', 'faculty'] })), null);
  assert.deepStrictEqual(
    compileProfile(mkProfile({ skills: [], title_classes: ['faculty', 'faculty'] })).variants[0].titleClasses,
    ['faculty']);
  assert(/array of strings/.test(validateProfile(mkProfile({ skills: [], domains: [7] }))));
  assert(/broad_aliases/.test(validateProfile(mkProfile({ skills: [{ term: 'python', weight: 3, broad_aliases: 'etl' }] }))));

  // variantHeat bands the pre-penalty scale; fnv1a is stable.
  assert.strictEqual(variantHeat(46), 'h4');
  assert.strictEqual(variantHeat(0), 'h0');
  assert.strictEqual(fnv1a('abc'), fnv1a('abc'));
  assert(/^fnv1a:[0-9a-f]{8}$/.test(fnv1a('abc')));
  assert.notStrictEqual(fnv1a('abc'), fnv1a('abd'));

  // surfaceForms guards: no de-pluralizing short words.
  assert(!surfaceForms('aws').includes('aw'));
  assert(surfaceForms('etl pipelines').includes('etl pipeline'));
}

function testReachabilityDemotion() {
  const { compileProfile, scoreJob, scoreAll } = RadarScoring;
  const compiled = compileProfile(SCORING_FIXTURE_PROFILE);
  const base = {
    title: 'Machine Learning Engineer',
    title_class: 'data_computational',
    department: '',
    description_text: ML_JOB_DESCRIPTION,
    research_relevance_score: 50
  };

  // citizenship gate: −30, capped to stretch, and RESTRICTED language is NOT
  // double-counted on top of it
  const federal = scoreJob({ ...base, citizenship_gated: true, veritas_state: 'RESTRICTED' }, compiled, null);
  assert.strictEqual(federal.fit_score, 46 + 5 - 30);
  assert.strictEqual(federal.verdict, 'stretch');
  assert.strictEqual(federal.gate.citizenship, true);

  // RESTRICTED-only: −15, no hard-gate cap. fit 36 sits in the moderate band
  // (27-38) on the recalibrated scale — demoted from the un-penalized 51, but not
  // hidden (demote-never-hide).
  const restricted = scoreJob({ ...base, veritas_state: 'RESTRICTED' }, compiled, null);
  assert.strictEqual(restricted.fit_score, 46 + 5 - 15);
  assert.strictEqual(restricted.verdict, 'moderate');

  // avoid signals demote (capped) and stage mismatch flags
  const avoid = scoreJob({
    ...base,
    description_text: `${ML_JOB_DESCRIPTION} Registered nurse duties included.`
  }, compiled, null);
  assert.deepStrictEqual(avoid.avoid_hits, ['registered nurse']);
  assert.strictEqual(avoid.fit_score, 46 + 5 - 8);
  const senior = scoreJob({ ...base, title: 'Senior Machine Learning Engineer' }, compiled, null);
  assert.strictEqual(senior.gate.stage_mismatch, true);

  // Reachability never filters: every job in = every job out, all stamped
  const jobs = [
    { ...base },
    { ...base, citizenship_gated: true },
    { title: 'Postdoctoral Fellow', title_class: 'postdoc', description_text: 'Research role.', research_relevance_score: 0 }
  ];
  const out = scoreAll(jobs, compiled, null);
  assert.strictEqual(out.length, 3);
  assert(out.every((job) => job.fit && typeof job.fit === 'object'));
  // the unreachable postdoc is demoted + flagged, still present
  assert.strictEqual(out[2].fit.verdict, 'stretch');
  assert.strictEqual(out[2].fit.gate.degree.required, 'phd');
}

function testVerdictTiers() {
  // Bands: strong>=50, good>=38, moderate>=27, weak>=16, stretch>=0
  const { verdictFor } = RadarScoring;
  assert.strictEqual(verdictFor(50, false), 'strong');
  assert.strictEqual(verdictFor(49, false), 'good');
  assert.strictEqual(verdictFor(38, false), 'good');
  assert.strictEqual(verdictFor(37, false), 'moderate');
  assert.strictEqual(verdictFor(27, false), 'moderate');
  assert.strictEqual(verdictFor(26, false), 'weak');
  assert.strictEqual(verdictFor(16, false), 'weak');
  assert.strictEqual(verdictFor(15, false), 'stretch');
  assert.strictEqual(verdictFor(72, true), 'stretch'); // hard-gate cap overrides score
}

function testTriageMerge() {
  const { mergeTriage } = RadarPipeline;

  // Remote-newer wins the whole record, including variant_sent.
  let merged = mergeTriage(
    { j1: { status: 'applied', updated_at: '2026-08-01T00:00:00Z', variant_sent: 'ml-engineer' } },
    { j1: { status: 'interview', updated_at: '2026-08-02T00:00:00Z', variant_sent: 'data-engineer' } }
  );
  assert.strictEqual(merged.j1.status, 'interview');
  assert.strictEqual(merged.j1.variant_sent, 'data-engineer');

  // Local-newer keeps local untouched.
  merged = mergeTriage(
    { j1: { status: 'offer', updated_at: '2026-08-03T00:00:00Z' } },
    { j1: { status: 'applied', updated_at: '2026-08-01T00:00:00Z' } }
  );
  assert.strictEqual(merged.j1.status, 'offer');

  // Equal timestamps keep local (strict >): a device never discards its own
  // record for an equal remote echo.
  merged = mergeTriage(
    { j1: { status: 'applied', updated_at: '2026-08-01T00:00:00Z', note: 'local note' } },
    { j1: { status: 'applied', updated_at: '2026-08-01T00:00:00Z' } }
  );
  assert.strictEqual(merged.j1.note, 'local note');

  // Record-level LWW is deliberate: a newer remote record WITHOUT variant_sent
  // replaces a local one that had it. Field-level merging would resurrect
  // cleared values; this pins the accepted trade-off.
  merged = mergeTriage(
    { j1: { status: 'applied', updated_at: '2026-08-01T00:00:00Z', variant_sent: 'ml-engineer' } },
    { j1: { status: 'applied', updated_at: '2026-08-02T00:00:00Z' } }
  );
  assert.strictEqual(merged.j1.variant_sent, undefined);

  // Remote-only jobs are added; empty/missing maps are fine.
  merged = mergeTriage(null, { j2: { status: 'shortlist', updated_at: '2026-08-01T00:00:00Z' } });
  assert.strictEqual(merged.j2.status, 'shortlist');
  assert.deepStrictEqual(mergeTriage({}, null), {});
}

function testRestoreTriageRecord() {
  const { restoreTriageRecord, mergeTriage } = RadarPipeline;

  // No prior record → the key is deleted, never rewritten as {status:'new'}
  // (absent and 'new' are different things to mergeTriage and sync push).
  const afterFirstTouch = { j1: { status: 'shortlist', updated_at: '2026-08-03T10:00:00Z' } };
  let restored = restoreTriageRecord(afterFirstTouch, 'j1', undefined);
  assert.strictEqual('j1' in restored, false);

  // Prior record restored verbatim, old updated_at included.
  const prev = { status: 'applied', updated_at: '2026-08-01T00:00:00Z', note: 'asked HR', variant_sent: 'ml-engineer' };
  restored = restoreTriageRecord(
    { j1: { status: 'rejected', updated_at: '2026-08-03T10:00:00Z' } },
    'j1',
    prev
  );
  assert.deepStrictEqual(restored.j1, prev);

  // Input map is not mutated.
  const input = { j1: { status: 'rejected', updated_at: '2026-08-03T10:00:00Z' } };
  restoreTriageRecord(input, 'j1', undefined);
  assert.strictEqual(input.j1.status, 'rejected');

  // Accepted LWW caveat, pinned: a synced device that already pulled the
  // undone (newer) write re-overwrites the verbatim-restored older record.
  const remote = { j1: { status: 'rejected', updated_at: '2026-08-03T10:00:00Z' } };
  const merged = mergeTriage(restoreTriageRecord(remote, 'j1', prev), remote);
  assert.strictEqual(merged.j1.status, 'rejected');
}

function testTriageTransfer() {
  const { validateTriageDoc, mergeLocalState } = RadarPipeline;
  const statuses = new Set(['new', 'shortlist', 'applied', 'interview', 'offer', 'rejected', 'withdrawn', 'ignore', 'emailed_lab', 'needs_visa_check']);

  // Validator: accept a good doc, with and without ignored_employers.
  const good = {
    version: 1,
    triage: { j1: { status: 'applied', updated_at: '2026-08-01T00:00:00Z', note: 'x' } },
    ignored_employers: ['emp-1']
  };
  assert.strictEqual(validateTriageDoc(good, statuses), null);
  assert.strictEqual(validateTriageDoc({ triage: {} }, statuses), null);

  // Validator: reject bad shapes with a reason.
  assert(validateTriageDoc(null, statuses));
  assert(validateTriageDoc([], statuses));
  assert(validateTriageDoc({ version: 1 }, statuses));
  assert(validateTriageDoc({ triage: { j1: 'applied' } }, statuses));
  assert(/unknown status/.test(validateTriageDoc({ triage: { j1: { status: 'aplied' } } }, statuses)));
  assert(validateTriageDoc({ triage: { j1: { status: 'applied', note: 7 } } }, statuses));
  assert(validateTriageDoc({ triage: {}, ignored_employers: 'emp-1' }, statuses));
  assert(validateTriageDoc({ triage: {}, ignored_employers: [1] }, statuses));

  // Merge: newer import wins and is counted; older loses and is not; equal
  // timestamps keep local (mergeTriage strict >).
  const local = {
    triage: {
      j1: { status: 'shortlist', updated_at: '2026-08-01T00:00:00Z' },
      j2: { status: 'offer', updated_at: '2026-08-03T00:00:00Z' },
      j3: { status: 'applied', updated_at: '2026-08-02T00:00:00Z', note: 'local' }
    },
    ignored_employers: ['emp-1']
  };
  const imported = {
    triage: {
      j1: { status: 'applied', updated_at: '2026-08-02T00:00:00Z' },
      j2: { status: 'applied', updated_at: '2026-08-01T00:00:00Z' },
      j3: { status: 'applied', updated_at: '2026-08-02T00:00:00Z' },
      j4: { status: 'shortlist', updated_at: '2026-08-01T00:00:00Z' }
    },
    ignored_employers: ['emp-1', 'emp-2']
  };
  const merged = mergeLocalState(local, imported);
  assert.strictEqual(merged.triage.j1.status, 'applied');
  assert.strictEqual(merged.triage.j2.status, 'offer');
  assert.strictEqual(merged.triage.j3.note, 'local');
  assert.strictEqual(merged.triage.j4.status, 'shortlist');
  assert.strictEqual(merged.mergedCount, 2); // j1 (newer) + j4 (new key)
  assert.deepStrictEqual(merged.ignored_employers, ['emp-1', 'emp-2']);
  assert.strictEqual(merged.addedEmployerCount, 1);

  // Inputs are not mutated.
  assert.strictEqual(local.triage.j1.status, 'shortlist');
  assert.deepStrictEqual(local.ignored_employers, ['emp-1']);
}

function testShouldAutoRefresh() {
  const { shouldAutoRefresh } = RadarPipeline;
  const MIN = 60 * 1000;
  // Pull slots (cron 15 */6 UTC): 00:15, 06:15, 12:15, 18:15.
  const afternoon = Date.parse('2026-08-03T13:00:00Z'); // next slot 18:15

  // Too soon, no slot passed.
  assert.strictEqual(shouldAutoRefresh(afternoon, afternoon + 5 * MIN), false);
  // Long enough, but still no slot passed — nothing new to fetch.
  assert.strictEqual(shouldAutoRefresh(afternoon, afternoon + 30 * MIN), false);
  // Exactly 15 minutes is not "more than" 15 minutes.
  assert.strictEqual(shouldAutoRefresh(afternoon, afternoon + 15 * MIN), false);

  const beforeSlot = Date.parse('2026-08-03T18:10:00Z'); // slot at 18:15
  // Slot passed but under the 15-minute floor (pull may still be running).
  assert.strictEqual(shouldAutoRefresh(beforeSlot, beforeSlot + 10 * MIN), false);
  // Slot passed and past the floor — refresh.
  assert.strictEqual(shouldAutoRefresh(beforeSlot, beforeSlot + 30 * MIN), true);
  // Hours later, slots long gone — refresh.
  assert.strictEqual(shouldAutoRefresh(afternoon, Date.parse('2026-08-04T09:00:00Z')), true);
}

function testDaysSince() {
  const { daysSince } = RadarPipeline;
  const now = Date.parse('2026-08-03T12:00:00Z');
  assert.strictEqual(daysSince('2026-08-01T12:00:00Z', now), 2);
  assert.strictEqual(daysSince('2026-08-03T00:00:00Z', now), 0);
  assert.strictEqual(daysSince('2026-08-04T00:00:00Z', now), 0); // clock skew never goes negative
  assert.strictEqual(daysSince('garbage', now), null);
  assert.strictEqual(daysSince(null, now), null);
  assert.strictEqual(daysSince(undefined, now), null);
}

function testVariantInitials() {
  const { variantInitials } = RadarScoring;
  const map = variantInitials([
    { id: 'ml-engineer' }, { id: 'data-engineer' }, { id: 'bioinformatics' },
    { id: 'data-scientist' }, { id: 'applied-ml-engineer' }, { id: 'data-warehousing' }
  ]);
  assert.strictEqual(map['ml-engineer'], 'ME');
  assert.strictEqual(map['data-engineer'], 'DE');
  assert.strictEqual(map['bioinformatics'], 'BIO');
  assert.strictEqual(map['data-scientist'], 'DS');
  assert.strictEqual(map['applied-ml-engineer'], 'AME');
  assert.strictEqual(map['data-warehousing'], 'DW');
  // Collisions extend rather than duplicate
  const clash = variantInitials([{ id: 'data-science' }, { id: 'data-systems' }]);
  assert.strictEqual(clash['data-science'], 'DS');
  assert.notStrictEqual(clash['data-systems'], 'DS');
  assert.ok(clash['data-systems'].length >= 2);
  // Degenerate inputs
  assert.deepStrictEqual(variantInitials([]), {});
  assert.deepStrictEqual(variantInitials(null), {});
  assert.deepStrictEqual(variantInitials([{ id: '' }, {}]), {});
}

function testNextPullAt() {
  const { nextPullAt } = RadarPipeline;
  const at = (iso) => Date.parse(iso);
  // Before the day's first run -> same-day 00:15 UTC
  assert.strictEqual(nextPullAt(at('2026-08-03T00:00:00Z')), at('2026-08-03T00:15:00Z'));
  // Just after a run -> next slot 6h later
  assert.strictEqual(nextPullAt(at('2026-08-03T00:16:00Z')), at('2026-08-03T06:15:00Z'));
  assert.strictEqual(nextPullAt(at('2026-08-03T11:21:00Z')), at('2026-08-03T12:15:00Z'));
  // Late evening -> rolls to next day
  assert.strictEqual(nextPullAt(at('2026-08-03T23:59:00Z')), at('2026-08-04T00:15:00Z'));
  // Exact boundary is "already fired" -> next slot
  assert.strictEqual(nextPullAt(at('2026-08-03T06:15:00Z')), at('2026-08-03T12:15:00Z'));
}

function testShortlistCsv() {
  const { buildShortlistCsv } = RadarPipeline;
  // Empty -> header only
  assert.strictEqual(buildShortlistCsv([], {}).trim().split('\n').length, 1);
  const jobs = [{
    id: 'j1',
    title: 'Data Scientist, "RegLab"',
    employer_name: 'Stanford, Law School',
    location: 'Stanford, CA',
    url: 'https://example.org/j1',
    deadline: '2026-08-20',
    veritas_state: 'FRIENDLY',
    fit: {
      fit_score: 85,
      verdict: 'strong',
      recommended_variant: 'ds',
      variants: [{ id: 'ds', label: 'Data science' }]
    }
  }, {
    id: 'j2', title: 'Line\nBreak', employer_name: 'X', location: null, url: 'u', fit: null
  }];
  const csv = buildShortlistCsv(jobs, { j1: { status: 'applied' } });
  const lines = csv.trim().split('\n');
  assert.strictEqual(lines[0], 'title,employer,location,url,fit,verdict,best_variant,closes,visa,status');
  // Quotes doubled, comma-bearing fields wrapped
  assert.ok(lines[1].startsWith('"Data Scientist, ""RegLab""","Stanford, Law School"'));
  assert.ok(lines[1].endsWith('85,strong,Data science,2026-08-20,FRIENDLY,applied'));
  // Newline-bearing field is quoted (row spans two physical lines)
  assert.ok(csv.includes('"Line\nBreak"'));
  // Missing fit/triage -> blanks and default status
  assert.ok(csv.trim().endsWith(',,,,,new'));
}

function testPipelineGrouping() {
  const { groupPipeline, PIPELINE_SET } = RadarPipeline;

  const jobs = [
    { id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }, { id: 'f' }, { id: 'g' }, { id: 'h' }
  ];
  const triage = {
    a: { status: 'applied', updated_at: '2026-07-20T00:00:00Z' },   // stalest applied
    b: { status: 'applied', updated_at: '2026-08-01T00:00:00Z' },
    c: { status: 'interview', updated_at: '2026-07-30T00:00:00Z' },
    d: { status: 'offer', updated_at: '2026-08-02T00:00:00Z' },
    e: { status: 'rejected', updated_at: '2026-07-01T00:00:00Z' },
    f: { status: 'rejected', updated_at: '2026-07-15T00:00:00Z' },
    g: { status: 'shortlist', updated_at: '2026-08-01T00:00:00Z' }, // intent, not pipeline
    h: { status: 'needs_visa_check', updated_at: '2026-08-01T00:00:00Z' } // gate, not pipeline
  };

  const groups = groupPipeline(jobs, triage);
  assert.deepStrictEqual(groups.map((group) => group.stage), ['offer', 'interview', 'applied', 'rejected']);

  // In-flight: stalest first, so the application most in need of follow-up tops
  // its group. Terminal: newest outcome first.
  const applied = groups.find((group) => group.stage === 'applied');
  assert.deepStrictEqual(applied.jobs.map((job) => job.id), ['a', 'b']);
  assert.strictEqual(applied.terminal, false);
  const rejected = groups.find((group) => group.stage === 'rejected');
  assert.deepStrictEqual(rejected.jobs.map((job) => job.id), ['f', 'e']);
  assert.strictEqual(rejected.terminal, true);

  // Non-pipeline states are excluded from both grouping and membership set.
  assert.strictEqual(PIPELINE_SET.has('shortlist'), false);
  assert.strictEqual(PIPELINE_SET.has('needs_visa_check'), false);
  assert.strictEqual(PIPELINE_SET.has('new'), false);
  assert.strictEqual(PIPELINE_SET.has('ignore'), false);

  // Untriaged jobs / empty maps produce no groups.
  assert.deepStrictEqual(groupPipeline(jobs, {}), []);
  assert.deepStrictEqual(groupPipeline([], triage), []);
}

function testVerdictRank() {
  const { verdictRank, VERDICT_TIERS } = RadarScoring;
  // Rank follows tier order: 0 = strong, worse tiers rank higher.
  assert.strictEqual(verdictRank('strong'), 0);
  assert.strictEqual(verdictRank('good'), 1);
  assert.strictEqual(verdictRank('moderate'), 2);
  assert.strictEqual(verdictRank('weak'), 3);
  assert.strictEqual(verdictRank('stretch'), 4);
  assert.strictEqual(verdictRank('nonsense'), -1);
  assert.strictEqual(verdictRank(null), -1);
  assert.strictEqual(verdictRank(undefined), -1);
  assert.strictEqual(VERDICT_TIERS.length, 5);

  // The inclusive "at or better than the cutoff" predicate the dashboard's
  // min-verdict filter and digest-local share.
  const atOrBetter = (verdict, min) => {
    const rank = verdictRank(verdict);
    return rank !== -1 && rank <= verdictRank(min);
  };
  assert.strictEqual(atOrBetter('strong', 'good'), true);
  assert.strictEqual(atOrBetter('good', 'good'), true);
  assert.strictEqual(atOrBetter('moderate', 'good'), false);
  assert.strictEqual(atOrBetter(undefined, 'good'), false); // unscored never passes
}

function testRoutingAmbiguity() {
  const { resolveVariant, compileProfile, scoreAll, profileHash } = RadarScoring;

  const close = [
    { id: 'a', score: 30, order: 0 },
    { id: 'b', score: 25, order: 1 }
  ];
  const resolved = resolveVariant(close, null);
  assert.strictEqual(resolved.recommended_variant, 'a');
  assert.strictEqual(resolved.recommended_source, 'deterministic');
  assert.strictEqual(resolved.ambiguous, true);

  const clear = resolveVariant([{ id: 'a', score: 40, order: 0 }, { id: 'b', score: 20, order: 1 }], null);
  assert.strictEqual(clear.ambiguous, false);

  // both scores below the floor: nothing worth routing
  const floor = resolveVariant([{ id: 'a', score: 10, order: 0 }, { id: 'b', score: 8, order: 1 }], null);
  assert.strictEqual(floor.ambiguous, false);

  // exact tie: manifest order wins
  const tie = resolveVariant([{ id: 'b', score: 30, order: 1 }, { id: 'a', score: 30, order: 0 }], null);
  assert.strictEqual(tie.recommended_variant, 'a');

  // cached verdict overrides; unknown variant ids are ignored
  const verdictApplied = resolveVariant(close, { variant_id: 'b', reason: 'MLOps-heavy posting' });
  assert.strictEqual(verdictApplied.recommended_variant, 'b');
  assert.strictEqual(verdictApplied.recommended_source, 'llm');
  assert.strictEqual(verdictApplied.llm_reason, 'MLOps-heavy posting');
  const verdictUnknown = resolveVariant(close, { variant_id: 'zz', reason: 'bad' });
  assert.strictEqual(verdictUnknown.recommended_variant, 'a');
  assert.strictEqual(verdictUnknown.recommended_source, 'deterministic');

  // route cache is only honored when its profile_hash matches the live profile
  const compiled = compileProfile(SCORING_FIXTURE_PROFILE);
  const job = () => ({
    id: 'job-1',
    title: 'Machine Learning Engineer',
    title_class: 'data_computational',
    description_text: ML_JOB_DESCRIPTION,
    research_relevance_score: 0
  });
  const stale = scoreAll([job()], compiled, {
    profile_hash: 'fnv1a:00000000',
    verdicts: { 'job-1': { variant_id: 'de', reason: 'stale' } }
  });
  assert.strictEqual(stale[0].fit.recommended_source, 'deterministic');
  const fresh = scoreAll([job()], compiled, {
    profile_hash: profileHash(SCORING_FIXTURE_PROFILE),
    verdicts: { 'job-1': { variant_id: 'de', reason: 'fresh' } }
  });
  assert.strictEqual(fresh[0].fit.recommended_variant, 'de');
  assert.strictEqual(fresh[0].fit.recommended_source, 'llm');
}

function testProfileV2() {
  const { validateProfile, profileHash, compileProfile, scoreAll, emptyFit } = RadarScoring;

  assert.strictEqual(validateProfile(SCORING_FIXTURE_PROFILE), null);
  assert.match(validateProfile({ ...SCORING_FIXTURE_PROFILE, schema_version: 1 }), /schema_version/);
  assert.match(validateProfile({ ...SCORING_FIXTURE_PROFILE, variants: [] }), /non-empty/);
  const dupe = {
    ...SCORING_FIXTURE_PROFILE,
    variants: [SCORING_FIXTURE_PROFILE.variants[0], { ...SCORING_FIXTURE_PROFILE.variants[1], id: 'ml' }]
  };
  assert.match(validateProfile(dupe), /duplicate/);
  const shortTerm = {
    ...SCORING_FIXTURE_PROFILE,
    variants: [{ ...SCORING_FIXTURE_PROFILE.variants[0], skills: [{ term: 'r', weight: 3 }] }]
  };
  assert.match(validateProfile(shortTerm), /shorter/);

  // hash is stable across JSON key order, sensitive to content
  const reordered = JSON.parse(JSON.stringify(SCORING_FIXTURE_PROFILE));
  reordered.variants = reordered.variants.map((variant) => {
    const { skills, id, label, intent, title_classes, domains, target_titles } = variant;
    return { target_titles, domains, title_classes, skills, intent, label, id };
  });
  assert.strictEqual(profileHash(reordered), profileHash(SCORING_FIXTURE_PROFILE));
  const edited = JSON.parse(JSON.stringify(SCORING_FIXTURE_PROFILE));
  edited.variants[0].intent = 'Different intent line';
  assert.notStrictEqual(profileHash(edited), profileHash(SCORING_FIXTURE_PROFILE));

  // invalid profile compiles to null; scoring without a profile stamps emptyFit
  assert.strictEqual(compileProfile({ schema_version: 1 }), null);
  const jobs = [{ id: 'x', title: 'Role', description_text: 'text' }];
  scoreAll(jobs, null, null);
  assert.strictEqual(jobs[0].fit.fit_score, null);
  assert.strictEqual(typeof emptyFit().fit_summary, 'string');
}

function testPageUpAdapter() {
  const xml = `<?xml version="1.0"?><urlset>
    <url><loc>https://careers.x.edu/</loc></url>
    <url><loc>https://careers.x.edu/jobs/research-associate-east-lansing-michigan-united-states-c9d8d397-9275-4dad-8188-ec21a4ceab6c</loc></url>
    <url><loc>  https://careers.x.edu/jobs/lab-manager-boston-massachusetts-united-states  </loc></url>
  </urlset>`;
  const urls = parseSitemapUrls(xml);
  assert.strictEqual(urls.length, 3);
  assert.strictEqual(urls[2], 'https://careers.x.edu/jobs/lab-manager-boston-massachusetts-united-states', 'whitespace must be trimmed');

  // The slug is the only title available before spending a request, so the
  // trailing UUID has to come off or every title reads as gibberish.
  assert.strictEqual(
    pageUpTitleFromUrl('https://careers.x.edu/jobs/research-associate-east-lansing-michigan-united-states-c9d8d397-9275-4dad-8188-ec21a4ceab6c'),
    'research associate east lansing michigan united states'
  );

  const posting = extractJsonLdJobPosting(`<html><head>
    <script type="application/ld+json">{"@type":"Organization","name":"X"}</script>
    <script type="application/ld+json">{"@type":"JobPosting","title":"Research Associate","datePosted":"2026-07-01T10:00:00Z","validThrough":"2026-09-01T00:00:00Z","description":"<p>Runs a <b>genomics</b> lab.</p>","jobLocation":[{"address":{"addressLocality":"East Lansing","addressRegion":"Michigan"}}]}</script>
  </head></html>`);
  assert(posting, 'must find the JobPosting among several JSON-LD blocks');
  assert.strictEqual(posting.title, 'Research Associate');

  // A malformed block must not stop us finding a good one after it.
  assert(extractJsonLdJobPosting('<script type="application/ld+json">{bad json</script>'
    + '<script type="application/ld+json">{"@type":"JobPosting","title":"OK"}</script>'), 'malformed JSON-LD must not abort the scan');
  assert.strictEqual(extractJsonLdJobPosting('<html>no structured data</html>'), null);

  const job = mapPageUpJob('https://careers.x.edu/jobs/research-associate-abc', posting, {
    id: 'x-university', ats_token: 'careers.x.edu'
  });
  assert.strictEqual(job.title, 'Research Associate');
  assert.strictEqual(job.location, 'East Lansing, Michigan');
  assert.strictEqual(job.source, 'pageup');
  assert.strictEqual(job.deadline_raw, '2026-09-01', 'deadline must be date-only like the other adapters');
  assert(!/[<>]/.test(job.description_text), 'description must be plain text');
  assert(/genomics/.test(job.description_text));

  // Challenge detection: this is the difference between "carry these jobs
  // forward" and "tombstone every one of them".
  assert.strictEqual(isChallengeResponse(''), true, 'empty body is a challenge');
  assert.strictEqual(
    isChallengeResponse('<!DOCTYPE html><html><head><title></title><script>window.awsWafCookie={}</script></head><body></body></html>'),
    true,
    'a complete-looking AWS WAF interstitial must still be detected'
  );
  assert.strictEqual(isChallengeResponse('<html><head><title>Just a moment...</title></head></html>'), true);
  assert.strictEqual(
    isChallengeResponse(`<html><head><title>Research Associate</title></head><body>${'x'.repeat(4000)}</body></html>`),
    false,
    'a real page must not be mistaken for a challenge'
  );
}

function testAdpAdapter() {
  const requisition = {
    itemID: '9200983323121_1',
    requisitionTitle: 'Research Assistant (Tropical Wildfires)',
    postDate: '2026-07-29T15:39:00.000-04:00',
    organizationalUnits: [{ nameCode: { shortName: 'Science' } }, { nameCode: { shortName: 'Wildfire Lab' } }],
    requisitionLocations: [
      { address: { cityName: 'Falmouth', countrySubdivisionLevel1: { codeValue: 'MA' } } },
      { address: { cityName: '', countrySubdivisionLevel1: { codeValue: '' } }, nameCode: { shortName: ' Remote ' } }
    ]
  };
  const job = mapAdpJob(requisition, { requisitionDescription: '<div><p>Study <b>fire</b> spread.</p></div>' }, {
    id: 'woodwell', ats_token: 'cid-1', ats_config: { cid: 'cid-1' }
  });
  assert.strictEqual(job.title, 'Research Assistant (Tropical Wildfires)');
  assert.strictEqual(job.location, 'Falmouth, MA; Remote');
  assert.strictEqual(job.department, 'Science — Wildfire Lab');
  assert.strictEqual(job.source, 'adp');
  assert.strictEqual(job.description_text, 'Study fire spread.');
  assert(job.url.includes('cid=cid-1') && job.url.includes('jobId=9200983323121_1'));

  // An employer with no usable location must not produce an empty string —
  // the dashboard's location filter treats '' and 'Unspecified' differently.
  assert.strictEqual(adpLocation({ requisitionLocations: [] }), 'Unspecified');
  assert.strictEqual(adpLocation({}), 'Unspecified');

  // Detail-fetch failure is fail-soft: the list record still yields a job (it
  // is dropped later for having no description, rather than crashing the run).
  const noDetail = mapAdpJob(requisition, null, { id: 'w', ats_token: 't', ats_config: { cid: 't' } });
  assert.strictEqual(noDetail.description_text, '');
  assert.strictEqual(noDetail.title, 'Research Assistant (Tropical Wildfires)');
}

/**
 * Pins ADP's real (badly behaved) paging contract, measured against live
 * clients: every response is capped at 20 records however large $top is, and
 * $skip is off by one. A driver written against the documented behaviour
 * collected 60 of 130 postings and reported success — the other 70 would have
 * been tombstoned as closed jobs.
 */
async function testAdpPagingContract() {
  const originalFetch = globalThis.fetch;
  const TOTAL = 130;
  const corpus = Array.from({ length: TOTAL }, (_, i) => ({
    itemID: `req_${i}`,
    requisitionTitle: `Research Associate ${i}`,
    requisitionLocations: [{ address: { cityName: 'Frankfort', countrySubdivisionLevel1: { codeValue: 'KY' } } }]
  }));
  let listCalls = 0;

  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    const detailMatch = parsed.pathname.match(/job-requisitions\/(.+)$/);
    if (detailMatch) {
      return { ok: true, status: 200, json: async () => ({ requisitionDescription: '<p>Body</p>' }) };
    }
    listCalls += 1;
    const skip = Number(parsed.searchParams.get('$skip') ?? 0);
    // The two quirks, reproduced exactly.
    const start = skip === 0 ? 0 : skip - 1;
    const size = skip === 0 ? 19 : 20;
    const batch = corpus.slice(start, start + size);
    const body = { jobRequisitions: batch };
    if (skip === 0) body.meta = { totalNumber: TOTAL };
    return { ok: true, status: 200, json: async () => body };
  };

  try {
    const jobs = await fetchAdpJobs({
      id: 'kentucky-state', name: 'Kentucky State University', tier: 'auto',
      ats_provider: 'adp', ats_token: 'cid-1', ats_config: { cid: 'cid-1' }
    });
    assert.strictEqual(jobs.length, TOTAL, `every declared posting must be collected, got ${jobs.length} of ${TOTAL}`);
    assert.strictEqual(new Set(jobs.map((job) => job.id)).size, TOTAL, 'overlapping windows must not produce duplicates');
    // Windows advance by 19, so 130 records need 7 list calls, not 130.
    assert(listCalls <= 10, `paging should take a handful of calls, took ${listCalls}`);
  } finally {
    globalThis.fetch = originalFetch;
  }

  // A feed that comes back short of its own declared total must FAIL rather
  // than return a partial list that reads as "these jobs closed".
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    if (/job-requisitions\/.+$/.test(parsed.pathname)) {
      return { ok: true, status: 200, json: async () => ({ requisitionDescription: 'x' }) };
    }
    const skip = Number(parsed.searchParams.get('$skip') ?? 0);
    const body = { jobRequisitions: skip === 0 ? corpus.slice(0, 19) : [] };
    if (skip === 0) body.meta = { totalNumber: TOTAL };
    return { ok: true, status: 200, json: async () => body };
  };
  try {
    let threw = null;
    try {
      await fetchAdpJobs({ id: 'short', name: 'Short Feed U', ats_provider: 'adp', ats_token: 'c', ats_config: { cid: 'c' } });
    } catch (error) {
      threw = error;
    }
    assert(threw && /incomplete/.test(threw.message), 'a truncated ADP feed must raise, not silently return fewer jobs');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function testCsodAdapter() {
  const employer = { id: 'university-of-arizona', ats_token: 'arizona', ats_config: { site_id: 4 } };
  const item = {
    requisitionId: 26711,
    displayJobTitle: 'Postdoctoral Research Associate',
    postingEffectiveDate: '8/5/2026',
    locations: [{ city: 'Tucson', state: 'AZ', country: 'US' }]
  };
  const detail = {
    displayTitle: 'Postdoctoral Research Associate',
    externalDescription: '<p>Conduct <b>quantum</b> research.</p>',
    openDate: '2026-08-04T23:00:56',
    primaryLocation: { title: 'Tucson Campus', city: 'Tucson', state: 'AZ' }
  };

  const job = mapCsodJob(item, detail, employer);
  assert.strictEqual(job.id, 'csod:arizona:26711');
  assert.strictEqual(job.source, 'csod');
  assert.strictEqual(job.description_text, 'Conduct quantum research.');
  assert.strictEqual(job.location, 'Tucson Campus');
  // The detail's ISO openDate wins over the list's M/D/YYYY, which Date parses
  // by locale and would otherwise land a day off.
  assert.strictEqual(job.posted_or_updated_at, '2026-08-04T23:00:56');

  // With no detail the list date is still usable, but only after being
  // rewritten as an unambiguous ISO day.
  const listOnly = mapCsodJob(item, null, employer);
  assert.strictEqual(listOnly.posted_or_updated_at, '2026-08-05');
  assert.strictEqual(listOnly.location, 'Tucson, AZ');
  assert.strictEqual(listOnly.description_text, '');
  assert(listOnly.url.includes('/careersite/4/home/requisition/26711'));

  assert.strictEqual(csodLocation({ locations: [] }, null), 'Unspecified');
  assert.strictEqual(csodPostedAt({ postingEffectiveDate: 'not a date' }, null), null);

  // The bearer token only exists inside the shell page, so a page shape that
  // stops carrying it has to fail loudly rather than yield an unauthenticated
  // fetcher that reports every employer as empty.
  assert.strictEqual(
    extractCsodToken('<script>csod.context={"corp":"a","token":"abc"};</script>'),
    'abc'
  );
  assert.throws(() => extractCsodToken('<html>no context here</html>'), /no csod\.context/);
  assert.throws(() => extractCsodToken('<script>csod.context={"corp":"a"};</script>'), /no token/);
}

/**
 * Cornerstone reports its own totalCount, so a short read is detectable — and
 * has to be treated as a failure, because a list that silently comes back
 * short is indistinguishable downstream from a batch of jobs that closed.
 */
async function testCsodPagingContract() {
  const originalFetch = globalThis.fetch;
  const employer = { id: 'short-u', ats_token: 'shortu', ats_config: { site_id: 1 } };
  const shell = '<script>csod.context={"corp":"shortu","token":"tok"};</script>';

  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes('/ux/ats/careersite/')) {
      return {
        ok: true,
        status: 200,
        text: async () => shell,
        headers: { getSetCookie: () => ['AWSALB=x; Path=/'] }
      };
    }
    // Declares 40 postings but only ever hands back 5.
    if (String(url).includes('/career-site/v1/search')) {
      const page = JSON.parse(options.body).pageNumber;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            totalCount: 40,
            requisitions: page === 1
              ? [1, 2, 3, 4, 5].map((n) => ({ requisitionId: n, displayJobTitle: `Research Scientist ${n}` }))
              : []
          }
        })
      };
    }
    throw new Error(`unexpected url ${url}`);
  };

  try {
    let threw = null;
    try {
      await fetchCsodJobs(employer);
    } catch (error) {
      threw = error;
    }
    assert(threw && /incomplete/.test(threw.message), 'a short Cornerstone read must raise, not return a partial list');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function testAtsResolverDetection() {
  // Detection must yield a URL a config can be parsed out of, not just a
  // vendor name — the fragment alone names Workday, the URL names the tenant.
  const page = '<a href="https://wd1.myworkdaysite.com/recruiting/upenn/careers-at-penn">Staff jobs</a>';
  const found = detectAts(page, 'https://www.hr.upenn.edu/PennHR/careers-at-penn');
  assert.strictEqual(found.provider, 'workday');
  assert.strictEqual(found.evidence_url, 'https://wd1.myworkdaysite.com/recruiting/upenn/careers-at-penn');

  // Quotes and angle brackets terminate the URL, or the config parse inherits
  // the rest of the markup.
  const quoted = detectAts('<a href="https://uab.taleo.net/careersection/ext/jobsearch.ftl">x</a>', 'https://x.edu');
  assert.strictEqual(quoted.evidence_url, 'https://uab.taleo.net/careersection/ext/jobsearch.ftl');

  // Provenance: a board hosted on the employer's own domain proves itself.
  assert.strictEqual(registrableDomain('https://jobs.hr.upenn.edu/postings/search'), 'upenn.edu');
  assert.strictEqual(registrableDomain('https://www.upenn.edu/'), 'upenn.edu');
  assert.strictEqual(registrableDomain('https://wd1.myworkdaysite.com/x'), 'myworkdaysite.com');
}

function testFeedOwnershipGate() {
  const job = (title, location, description) => ({ title, location, description_text: description });

  // UAB: the location column says "University" and nothing else, so geography
  // abstains entirely — the feed is confirmed because the postings link uab.edu.
  const uab = scoreFeedOwnership({
    employer: {
      name: 'University of Alabama at Birmingham',
      city: 'Birmingham', state: 'AL', website: 'https://www.uab.edu/'
    },
    feedLabel: 'uab',
    jobs: [
      job('RESEARCH ENGINEER III', 'University', 'See https://www.uab.edu/engineering/eitd/ for details.'),
      job('CLINICAL RESEARCH COORDINATOR I', 'University', 'The University of Alabama at Birmingham seeks a coordinator.'),
      job('GRANTS ANALYST', 'University', 'Reports to uab.edu administration.')
    ]
  });
  assert.strictEqual(uab.verdict, 'confirmed');
  assert.strictEqual(uab.reason, 'postings_name_employer');
  assert.strictEqual(uab.signals.usable_location_fraction, 0);
  assert(uab.evidence.length > 0, 'a confirmed feed must carry quotable evidence');

  // SMU: postings rarely name the employer, but every one of them is in Dallas.
  const smu = scoreFeedOwnership({
    employer: { name: 'Southern Methodist University', city: 'Dallas', state: 'TX', website: 'https://www.smu.edu/' },
    feedLabel: 'smu',
    jobs: [
      job('Senior Event Manager', 'TX-Dallas', 'Plan events.'),
      job('Graduate Recruiter', 'TX-Dallas', 'Recruit students.'),
      job('Clinic Coordinator', 'TX-Dallas', 'Coordinate the clinic.')
    ]
  });
  assert.strictEqual(smu.verdict, 'confirmed');
  assert.strictEqual(smu.reason, 'postings_in_employer_city');

  // schneider.taleo.net is filed under Advanced Career Institute, a California
  // college, and serves truck-driver jobs. The claimed employer is named in no
  // posting while another organisation is named in two — the one shape that
  // earns a rejection rather than a shrug.
  const schneider = scoreFeedOwnership({
    employer: { name: 'Advanced Career Institute', city: 'Visalia', state: 'CA', website: 'https://advanced.edu/' },
    feedLabel: 'schneider',
    jobs: [
      job('Intermodal truck driver', 'Intermodal', 'HazMat endorsement required. Schneider pays weekly.'),
      job('Dedicated Reefer truck driver', 'Dedicated', 'Join Schneider and drive for Costco.'),
      job('Tanker truck driver', 'Tanker', 'Top drivers earn up to $87,000.')
    ]
  });
  assert.strictEqual(schneider.verdict, 'rejected');
  assert.strictEqual(schneider.reason, 'postings_name_another_org');
  assert.strictEqual(schneider.signals.name_count, 0);
  assert(schneider.evidence.some((item) => item.signal === 'other_org'));

  // An employer's OWN acronym must never read as a rival's name. Were "utsw"
  // treated as foreign, a feed whose postings use only the short form would be
  // rejected — losing a real employer, the one error this gate cannot make.
  const acronym = scoreFeedOwnership({
    employer: {
      name: 'University of Texas Southwestern Medical Center',
      city: 'Dallas', state: 'TX', website: 'https://www.utsouthwestern.edu/'
    },
    feedLabel: 'utsw',
    jobs: [
      job('Coding Specialist III', 'Other', 'Apply through utsw careers.'),
      job('Patient Care Technician', 'Other', 'utsw offers benefits.'),
      job('Emergency Room Tech', 'Other', 'Work at utsw.')
    ]
  });
  assert.notStrictEqual(acronym.verdict, 'rejected');
  assert.strictEqual(acronym.signals.other_org_count, 0);
  assert.strictEqual(isAbbreviationOf('utsw', 'University of Texas Southwestern Medical Center'), true);
  assert.strictEqual(isAbbreviationOf('schneider', 'Advanced Career Institute'), false);

  // Pitt's branch campuses share the main campus feed. Their own names never
  // appear in it, so neither may claim ownership — but absence of evidence is
  // not evidence of absence, and a silent reject would lose them for good.
  const branch = scoreFeedOwnership({
    employer: { name: 'University of Pittsburgh Bradford', city: 'Bradford', state: 'PA', website: 'https://upb.pitt.edu/' },
    feedLabel: 'cfopitt',
    jobs: [
      job('Postdoctoral Associate', 'Physics & Astronomy', 'Research in the neutrino group.'),
      job('Research Professional', 'All Temps', 'Support a study.'),
      job('Lecturer', 'Dietrich School', 'Teach undergraduates.')
    ]
  });
  assert.strictEqual(branch.verdict, 'inconclusive');
  assert.strictEqual(branch.reason, 'insufficient_evidence');

  // Too few postings to judge is its own answer, distinct from having judged.
  const thin = scoreFeedOwnership({
    employer: { name: 'Somewhere University', city: 'Ames', state: 'IA' },
    jobs: [job('Analyst', 'Ames, IA', 'x')]
  });
  assert.strictEqual(thin.verdict, 'inconclusive');
  assert.strictEqual(thin.reason, 'thin_sample');

  // "CA" must not be read out of "CAMPUS", and full state names count.
  assert.strictEqual(stateOf('Morgantown, WV'), 'WV');
  assert.strictEqual(stateOf('West Virginia University'), 'WV');
  assert.strictEqual(stateOf('Main Campus'), null);
  assert.strictEqual(stateOf('Physics & Astronomy'), null);
}

function testTaleoAdapter() {
  const employer = {
    id: 'university-of-alabama-at-birmingham',
    ats_token: 'uab',
    ats_config: { host: 'uab.taleo.net', sections: [{ code: 'ext', portal: '8100108034' }] },
    research_areas: []
  };
  const section = { code: 'ext', portal: '8100108034' };

  // The location column arrives as a JSON array string, not a plain value.
  assert.strictEqual(parseTaleoLocation('["Birmingham, AL"]'), 'Birmingham, AL');
  assert.strictEqual(parseTaleoLocation('["Birmingham, AL","Huntsville, AL"]'), 'Birmingham, AL; Huntsville, AL');
  assert.strictEqual(parseTaleoLocation('University'), 'University');
  assert.strictEqual(parseTaleoLocation('[not json'), '[not json');
  assert.strictEqual(parseTaleoLocation(''), null);

  const listItem = {
    jobId: '323877',
    contestNo: 'T238419',
    locationsColumns: [1],
    column: ['RESEARCH ENGINEER III', '["Birmingham, AL"]', 'Aug 6, 2026']
  };
  const job = mapTaleoJob(listItem, { description_text: 'Design mechanical systems.' }, employer, section);
  // The id keys on the requisition number a human sees, not the internal jobId,
  // because contestNo survives a re-posting and jobId does not.
  assert.strictEqual(job.id, 'taleo:uab:T238419');
  assert.strictEqual(job.source, 'taleo');
  assert.strictEqual(job.source_job_id, 'T238419');
  assert.strictEqual(job.title, 'RESEARCH ENGINEER III');
  assert.strictEqual(job.location, 'Birmingham, AL');
  assert.strictEqual(job.description_text, 'Design mechanical systems.');
  assert.strictEqual(job.url, 'https://uab.taleo.net/careersection/ext/jobdetail.ftl?job=323877&lang=en');

  // locationsColumns names the location column; it is not always index 1.
  const shifted = mapTaleoJob({
    jobId: '9', contestNo: 'T9', locationsColumns: [2],
    column: ['POSTDOCTORAL FELLOW', 'Research', '["Morgantown, WV"]', 'Aug 1, 2026']
  }, null, employer, section);
  assert.strictEqual(shifted.location, 'Morgantown, WV');
  // A failed detail fetch still yields a usable record rather than dropping it.
  assert.strictEqual(shifted.description_text, '');

  // The description sits in a hidden initialHistory input, double-encoded,
  // segments joined by !*! with segment 0 holding metadata.
  const encoded = encodeURIComponent(encodeURIComponent('<p>Run assays.</p>'));
  const html = `<input type="hidden" name="initialHistory" value="ftlx0!|!x!|!RESEARCH ENGINEER III!|!T238419!*!${encoded}!*!${encoded}" />`;
  const parsed = parseTaleoDetailPage(html);
  assert.strictEqual(parsed.description_text, 'Run assays.');
  assert.strictEqual(parsed.contest_no, 'T238419');

  // A literal percent in the posting used to make decodeURIComponent throw on
  // the whole string, silently leaving the description URL-encoded. Decoding
  // escape-by-escape until it settles is what keeps those postings readable.
  const withPercent = encodeURIComponent(encodeURIComponent('<p>100% effort required.</p>'));
  assert.strictEqual(
    parseTaleoDetailPage(`<input name="initialHistory" value="a!|!b!*!${withPercent}" />`).description_text,
    '100% effort required.'
  );

  // Taleo escapes its own delimiters with a backslash.
  const escaped = encodeURIComponent(encodeURIComponent('Contact\\: hr@uab.edu'));
  assert.strictEqual(
    parseTaleoDetailPage(`<input name="initialHistory" value="a!|!b!*!${escaped}" />`).description_text,
    'Contact: hr@uab.edu'
  );

  // No initialHistory at all -> empty, never a crash.
  assert.deepStrictEqual(parseTaleoDetailPage('<html></html>'), { description_text: '', location: null });

  /* THE HASH MUST NOT MOVE BETWEEN FETCHES. initialHistory ends with the page's
   * own form state, and one of its fields is a csrftoken that Taleo reissues on
   * every request. Storing it made every Taleo posting look new on every
   * refresh: 509 postings re-judged four times a day, 5,904 judgments bought
   * for answers already in the cache. */
  const withState = (token) => encodeURIComponent(encodeURIComponent(
    '<p>Run assays.</p>!|!pSessionTimeout!|!0!|!csrftoken!|!' + token + '!|!isListEmpty!|!false'
  ));
  const first = parseTaleoDetailPage(`<input name="initialHistory" value="a!|!b!*!${withState('AAAAbbbbCCCC1111')}" />`);
  const second = parseTaleoDetailPage(`<input name="initialHistory" value="a!|!b!*!${withState('ZZZZyyyyXXXX9999')}" />`);
  assert.strictEqual(first.description_text, 'Run assays.', 'the posting survives the cut');
  assert.strictEqual(first.description_text, second.description_text,
    'two fetches of one posting must produce identical text');
  assert(!/csrftoken/.test(first.description_text), 'the session token must never reach the description');

  // UTSW appends a requisition attribute table before the state block, and its
  // timestamp moves too. Delimiters packed close together are never prose.
  const withTable = encodeURIComponent(encodeURIComponent(
    '<p>Run assays.</p>!|!Full-time!|!Day Job!|!Regular!|!Standard!|!Sep 12, 2023, 9:38:43 PM'
  ));
  const tabled = parseTaleoDetailPage(`<input name="initialHistory" value="a!|!b!*!${withTable}" />`);
  assert.strictEqual(tabled.description_text, 'Run assays.', 'the attribute table is not description');

  // But a lone delimiter inside real prose must NOT truncate the posting —
  // Towson puts the description and the state in the SAME segment, and cutting
  // by segment emptied it entirely.
  const sparse = encodeURIComponent(encodeURIComponent(
    'A long sentence of real posting prose that runs on for a while.!|!And more prose after a single delimiter.'
  ));
  const kept = parseTaleoDetailPage(`<input name="initialHistory" value="a!|!b!*!${sparse}" />`);
  assert(/And more prose/.test(kept.description_text), 'one delimiter is not a state block');

  // A tenant may run several career sections holding DIFFERENT jobs (WVU keeps
  // its postdocs in `faculty`, not `staff`), so config validation must accept a
  // list and reject a section that lacks the portal the REST call needs.
  const base = {
    id: 'wvu', name: 'West Virginia University', type: 'ihe',
    cap_exempt_status: 'strong', evidence_sources: ['ipeds'],
    careers_url: 'https://wvu.taleo.net/careersection/staff/jobsearch.ftl',
    ats_provider: 'taleo', ats_token: 'wvu'
  };
  validateEmployer({
    ...base,
    ats_config: {
      host: 'wvu.taleo.net',
      sections: [{ code: 'staff', portal: '8100120139' }, { code: 'faculty', portal: '26100021550' }]
    }
  });
  assert.throws(
    () => validateEmployer({ ...base, ats_config: { host: 'wvu.taleo.net', sections: [{ code: 'staff' }] } }),
    /sections needs \{code, portal\}/
  );
  assert.throws(
    () => validateEmployer({ ...base, ats_config: { sections: [{ code: 'staff', portal: '1' }] } }),
    /ats_config.host is missing/
  );
}

function testIcimsAdapter() {
  const employer = { id: 'emory-university', ats_token: 'staff-emory' };
  const url = 'https://staff-emory.icims.com/jobs/167619/research-administrator%2c-post-award-iii---school-of-medicine/job';

  // The sitemap URL is the only title available before paying for a detail
  // fetch, so the percent-encoded slug has to decode into something the title
  // classifier can actually read.
  assert.strictEqual(icimsTitleFromUrl(url), 'research administrator, post award iii school of medicine');
  assert.deepStrictEqual(icimsSlugSegments(url), {
    id: '167619',
    slug: 'research-administrator%2c-post-award-iii---school-of-medicine'
  });

  // The plain transform turns "post-doctoral-scholar" into "post doctoral
  // scholar", which the title classifier rejects while accepting the closed-up
  // spelling — so the prefilter has to offer both readings or the radar drops
  // the postdoc listings it exists to surface.
  const postdocUrl = 'https://careersat-ohsu.icims.com/jobs/35509/post-doctoral-scholar/job';
  assert.strictEqual(icimsTitleFromUrl(postdocUrl), 'post doctoral scholar');
  assert.strictEqual(isResearchRelevantTitle('post doctoral scholar', { research_areas: [] }), false);
  assert(
    isResearchRelevantTitle(icimsPrefilterTitle(postdocUrl), { research_areas: [] }),
    'the iCIMS prefilter must keep post-doctoral postings'
  );
  // A title with no split prefix is passed through untouched, not doubled.
  assert.strictEqual(icimsPrefilterTitle('https://x.icims.com/jobs/1/research-scientist/job'), 'research scientist');

  // in_iframe=1 is what turns the wrapper page into the one carrying JSON-LD.
  assert.strictEqual(icimsDetailUrl('https://x.icims.com/jobs/1/a/job'), 'https://x.icims.com/jobs/1/a/job?in_iframe=1');
  assert.strictEqual(icimsDetailUrl('https://x.icims.com/jobs/1/a/job?ss=1'), 'https://x.icims.com/jobs/1/a/job?ss=1&in_iframe=1');

  const posting = {
    title: 'Research Administrator, Post-Award III',
    description: '<p>Manage <b>grants</b> for research.</p>',
    datePosted: '2024-08-05T21:58:12.733Z',
    jobLocation: [{ address: { addressLocality: 'Atlanta', addressRegion: 'GA' } }]
  };
  const job = mapIcimsJob(url, posting, employer);
  assert.strictEqual(job.id, 'icims:staff-emory:167619');
  assert.strictEqual(job.source, 'icims');
  assert.strictEqual(job.location, 'Atlanta, GA');
  assert.strictEqual(job.description_text, 'Manage grants for research.');

  // iCIMS writes the literal "UNAVAILABLE" into address fields it has no value
  // for, which reached the dashboard as locations like "Remote, UNAVAILABLE".
  const placeholder = {
    ...posting,
    jobLocation: [{ address: { addressLocality: 'Remote', addressRegion: 'UNAVAILABLE', addressCountry: 'US' } }]
  };
  assert.strictEqual(mapIcimsJob(url, placeholder, employer).location, 'Remote');
  assert.deepStrictEqual(
    icimsCleanPosting(placeholder).jobLocation[0].address,
    { addressLocality: 'Remote', addressCountry: 'US' }
  );

  assert.deepStrictEqual(
    icimsJobPathsFromHtml('<a href="/jobs/35509/post-doctoral-scholar/job">x</a><a href="/jobs/1/b/job">y</a>'),
    ['/jobs/35509/post-doctoral-scholar/job', '/jobs/1/b/job']
  );
}

/**
 * Some iCIMS tenants answer /sitemap.xml with 403 while serving search fine
 * (careersat-ohsu does). Falling back matters more than it looks: fetchText
 * throws on 403, and an employer that throws keeps its existing jobs, but an
 * employer that returns [] has every live job tombstoned.
 */
async function testIcimsSitemapFallback() {
  const originalFetch = globalThis.fetch;
  const employer = { id: 'ohsu', ats_token: 'careersat-ohsu' };

  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.includes('/sitemap.xml')) return { ok: false, status: 403, statusText: 'Forbidden' };
    if (target.includes('/jobs/search')) {
      const page = Number(new URL(target).searchParams.get('pr'));
      return {
        ok: true,
        status: 200,
        text: async () => (page === 0 ? '<a href="/jobs/35509/post-doctoral-scholar/job">x</a>' : '')
      };
    }
    if (target.includes('in_iframe=1')) {
      return {
        ok: true,
        status: 200,
        text: async () => '<script type="application/ld+json">'
          + JSON.stringify({
            '@type': 'JobPosting',
            title: 'Post Doctoral Scholar',
            description: 'Research role',
            datePosted: '2026-02-01T00:00:00Z',
            jobLocation: [{ address: { addressLocality: 'Portland', addressRegion: 'OR' } }]
          })
          + '</script>'
      };
    }
    throw new Error(`unexpected url ${target}`);
  };

  try {
    const jobs = await fetchIcimsJobs(employer);
    assert.strictEqual(jobs.length, 1, 'the search fallback must recover the posting the sitemap refused to serve');
    assert.strictEqual(jobs[0].title, 'Post Doctoral Scholar');
    assert.strictEqual(jobs[0].location, 'Portland, OR');
  } finally {
    globalThis.fetch = originalFetch;
  }

  // Both routes down is an unreachable employer, not an empty one.
  globalThis.fetch = async () => ({ ok: false, status: 503, statusText: 'Service Unavailable' });
  try {
    let threw = null;
    try {
      await fetchIcimsJobs(employer);
    } catch (error) {
      threw = error;
    }
    assert(threw && /unreachable/.test(threw.message), 'an unreachable iCIMS listing must raise rather than return []');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

/**
 * validateEmployer throws, and it throws before a single feed is fetched — so
 * one malformed registry entry doesn't degrade the run, it deletes it. That is
 * the right behaviour for committed config, but it means the registry file and
 * the code that reads it have to be checked together, which nothing did: 46 ADP
 * employers were promoted into employers.json while 'adp' was missing from the
 * provider allowlist, and every refresh died on the first one for ~9h until the
 * dead-man switch called it (2026-08-05).
 *
 * So run the real validator over the real registry. Any promotion that writes a
 * provider the fetcher table can't serve now fails here instead of at 03:29 UTC.
 */
function testRegistryValidates() {
  const registry = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'radar', 'employers.json'), 'utf8'));
  const employers = Array.isArray(registry) ? registry : registry.employers;
  assert(Array.isArray(employers) && employers.length, 'employers.json must hold a non-empty employer list');

  for (const employer of employers) {
    assert.doesNotThrow(() => validateEmployer(employer), `committed registry entry ${employer.id} fails validateEmployer`);
  }

  // The allowlist is derived from ATS_FETCHERS, so a provider that validates is
  // guaranteed dispatchable. Assert the property directly: a derivation that
  // regresses to a hand-maintained literal should break this, not production.
  const used = new Set(employers.flatMap((employer) => [
    employer.ats_provider,
    ...(employer.secondary_ats_feeds || []).map((feed) => feed.ats_provider)
  ]).filter(Boolean));
  for (const provider of used) {
    assert(typeof ATS_FETCHERS[provider] === 'function', `registry uses ats_provider "${provider}" with no fetcher in ATS_FETCHERS`);
  }
}

/**
 * The dead-man switch's exit code IS the notification when no push channel is
 * configured. Run it for real in a sandbox tree, because the thing being
 * tested is the process exit status, not a return value.
 */
function testDeadmanExitContract() {
  const os = require('os');
  const { spawnSync } = require('child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-deadman-'));
  const scriptDir = path.join(root, 'radar', 'scripts');
  fs.mkdirSync(scriptDir, { recursive: true });
  fs.mkdirSync(path.join(root, 'radar', 'data'), { recursive: true });
  fs.copyFileSync(
    path.resolve(__dirname, '../radar/scripts/deadman-check.js'),
    path.join(scriptDir, 'deadman-check.js')
  );

  const reportPath = path.join(root, 'radar', 'data', 'refresh-report.json');
  const writeReport = (patch) => fs.writeFileSync(reportPath, JSON.stringify({
    refreshed_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    active_job_count: 100,
    errored_employers: 0,
    recall_anomalies: [],
    ...patch
  }));
  const env = { ...process.env };
  delete env.NTFY_TOPIC;
  const run = (extraEnv = {}) => spawnSync(process.execPath, [path.join(scriptDir, 'deadman-check.js')], {
    env: { ...env, ...extraEnv }, encoding: 'utf8'
  });

  writeReport();
  assert.strictEqual(run().status, 0, 'a healthy pipeline must exit 0');

  // The live 2026-08-04 case: stale, no ntfy topic, nowhere to send the alert.
  writeReport({ refreshed_at: new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString() });
  const stale = run();
  assert.strictEqual(stale.status, 1, 'a stale pipeline with no delivery channel must FAIL the run');
  assert(/12\.\d+h ago|1[23]\.\d+h ago/.test(stale.stderr + stale.stdout), 'the reason must be logged');

  // A recall anomaly is equally undeliverable, and equally must not read green.
  writeReport({ recall_anomalies: [{ name: 'Somewhere University' }] });
  assert.strictEqual(run().status, 1, 'a recall anomaly with no delivery channel must fail the run');

  // A sync that FAILED partway leaves a report that looks perfectly healthy —
  // fresh timestamp, no errors, no anomalies — while the dataset of record is
  // missing that run's writes. That combination is what hid a broken sync
  // behind a green tick, so it has to alarm on its own.
  writeReport({ supabase_sync_status: 'failed', supabase_sync_error: 'statement timeout' });
  const failedSync = run();
  assert.strictEqual(failedSync.status, 1, 'a failed Supabase sync must not read as healthy');
  assert(/statement timeout/.test(failedSync.stdout + failedSync.stderr), 'the reason must be carried through');

  // A successful sync, and an older report from before the field existed, are
  // both fine.
  writeReport({ supabase_sync_status: 'ok' });
  assert.strictEqual(run().status, 0, 'a successful sync is healthy');
  writeReport();
  assert.strictEqual(run().status, 0, 'a report predating the field must not alarm');

  // The reason is also written to the Actions summary page when present.
  const summaryPath = path.join(root, 'summary.md');
  writeReport({ refreshed_at: new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString() });
  run({ GITHUB_STEP_SUMMARY: summaryPath });
  assert(/Radar dead-man alert/.test(fs.readFileSync(summaryPath, 'utf8')), 'step summary must carry the alert');

  // An unreadable report is still a failure, not a silent pass.
  fs.writeFileSync(reportPath, 'not json');
  assert.strictEqual(run().status, 1, 'an unreadable report must fail the run');

  fs.rmSync(root, { recursive: true, force: true });
}

async function main() {
  testSharedAnalyzer();
  testNegationGuard();
  testFixturePages();
  testSignalExtraction();
  testNormalization();
  await testCsvMultilineRecords();
  testAnalyzerCorpus();
  testTitleClassEvidence();
  testSupabaseSink();
  testSyncDiff();
  await testSyncJobsWrites();
  await testFetchAllJobsKeyset();
  testPeopleAdminAdapter();
  testEntityResolution();
  testProviderMappers();
  await testFetchRetry();
  await testUsaJobs();
  testJobLifecycle();
  testCrossSourceDedup();
  testDeadlineParser();
  testSalaryParser();
  testWorkModeAndLocation();
  testRecallAnomalies();
  testPrefilterAnomalies();
  await testMultiFeedEmployer();
  testZipExtraction();
  testScoutedImporter();
  testAggregatedImporter();
  testEnrichPipeline();
  testEnrichment();
  testDegreeGateParsing();
  testVariantScoring();
  testFitEngineRepairs();
  testEligibility();
  testRoleTrack();
  testQualifiedPredicate();
  testProfessionGate();
  await testFlushScheduler();
  testProfileDocument();
  testSeedCacheKeys();
  await testJudgeFunction();
  await testAuthClient();
  await testBatchWrite();
  await testMatchCacheWriter();
  await testOpenAiCooldown();
  testJudgeJobsScript();
  testJudgedMatch();
  testManifestSync();
  testFitAudit();
  testReachabilityDemotion();
  testVerdictTiers();
  testVerdictRank();
  testTriageMerge();
  testRestoreTriageRecord();
  testTriageTransfer();
  testShouldAutoRefresh();
  testDaysSince();
  testVariantInitials();
  testNextPullAt();
  testShortlistCsv();
  testPipelineGrouping();
  testRoutingAmbiguity();
  testProfileV2();
  await testRefreshPool();
  testProviderBreaker();
  testPageUpAdapter();
  testAdpAdapter();
  testCsodAdapter();
  await testCsodPagingContract();
  testAtsResolverDetection();
  testFeedOwnershipGate();
  testTaleoAdapter();
  testIcimsAdapter();
  await testIcimsSitemapFallback();
  testRegistryValidates();
  testDeadmanExitContract();
  await testAdpPagingContract();

  console.log('Radar tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
