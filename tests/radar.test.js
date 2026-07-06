const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { analyzeText } = require('../scripts/keywords.js');
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
  mapRecruiteeJob,
  mapBreezyJob,
  mapWorkableJob,
  mapUsaJobsJob,
  fetchUsaJobsJobs,
  isResearchRelevantTitle,
  applyJobLifecycle,
  activeScoutedJobs,
  applyEnrichmentOverlay
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
const { parsePeopleAdminAtom, mapPeopleAdminEntry } = require('../radar/scripts/refresh.js');
const { jobRow, supabaseEnv } = require('../radar/scripts/lib/supabase.js');
const { createResolver, significantTokens } = require('../radar/scripts/lib/entity-resolution.js');

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
  testPeopleAdminAdapter();
  testEntityResolution();
  testProviderMappers();
  await testFetchRetry();
  await testUsaJobs();
  testJobLifecycle();
  testZipExtraction();
  testScoutedImporter();
  testAggregatedImporter();
  testEnrichPipeline();
  testEnrichment();

  console.log('Radar tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
