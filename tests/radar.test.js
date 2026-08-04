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
  mapOracleJob,
  mapUltiproJob,
  parseSuccessFactorsSitemap,
  parseSuccessFactorsJobPage,
  mapSuccessFactorsJob,
  mapEightfoldJob,
  mapPaylocityJob,
  parsePaylocityListPage,
  parsePaylocityDetailPage,
  mapInterfolioJob,
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
  fetchEmployerJobs
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
const { jobRow, supabaseEnv } = require('../radar/scripts/lib/supabase.js');
const { createResolver, significantTokens } = require('../radar/scripts/lib/entity-resolution.js');
const {
  TITLE_CLASSES,
  VARIANT_SCHEMA,
  validateManifest,
  variantCacheKey,
  normalizeVariantProfile,
  reconcileCore,
  slugify,
  variantUserPrompt,
  parseArgs
} = require('../radar/scripts/build-profile.js');
const { CLASS_LABELS } = require('../radar/scripts/lib/title-class.js');
const RadarScoring = require('../radar/public/scoring.js');
const RadarPipeline = require('../radar/public/pipeline.js');
const {
  selectAmbiguousJobs,
  validateVerdict,
  buildRoutePrompt,
  askOllama
} = require('../radar/scripts/route-resumes.js');
const { ollamaChat } = require('../radar/scripts/lib/ollama.js');

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

function testProfileIngestion() {
  // Taxonomy stays in lockstep with title-class.js — no hardcoded mirror.
  assert.deepStrictEqual(TITLE_CLASSES, Object.keys(CLASS_LABELS));

  // Manifest validation
  const good = {
    schema_version: 1,
    variants: [
      { id: 'ml', label: 'ML Engineer', file: 'ml.pdf', intent: 'Leads with production ML, PyTorch, MLOps' },
      { id: 'de', label: 'Data Engineer', file: 'de.md', intent: 'Leads with pipelines and warehouse modeling' }
    ]
  };
  assert.strictEqual(validateManifest(good), null);
  assert.match(validateManifest({ schema_version: 2, variants: good.variants }), /schema_version/);
  assert.match(validateManifest({ schema_version: 1, variants: [] }), /non-empty/);
  assert.match(
    validateManifest({ schema_version: 1, variants: [good.variants[0], { ...good.variants[1], id: 'ml' }] }),
    /duplicate/
  );
  assert.match(
    validateManifest({ schema_version: 1, variants: [{ ...good.variants[0], intent: 'too short' }] }),
    /intent/
  );
  assert.strictEqual(
    validateManifest({ schema_version: 1, variants: [{ ...good.variants[0], file: 'resume.docx' }] }),
    null
  ); // .docx is a supported resume format (extracted locally via unzip)
  assert.match(
    validateManifest({ schema_version: 1, variants: [{ ...good.variants[0], file: 'resume.rtf' }] }),
    /file/
  ); // an unsupported extension is still rejected
  assert.match(
    validateManifest({ schema_version: 1, variants: [{ ...good.variants[0], id: 'ML Engineer' }] }),
    /slug/
  );

  // Cache key: stable for identical inputs, changes on intent edit or new text
  const variant = good.variants[0];
  const key = variantCacheKey('resume text body', variant);
  assert.strictEqual(variantCacheKey('resume text body', variant), key);
  assert.notStrictEqual(variantCacheKey('resume text body', { ...variant, intent: 'Rewritten intent line here' }), key);
  assert.notStrictEqual(variantCacheKey('different resume text', variant), key);
  // Renaming the id must NOT invalidate the cache (id is display/routing only)
  assert.strictEqual(variantCacheKey('resume text body', { ...variant, id: 'renamed' }), key);

  // Variant profile normalization: short terms dropped, weights clamped,
  // duplicate terms and self-aliases removed
  const normalized = normalizeVariantProfile({
    skills: [
      { term: 'PyTorch', weight: 5, aliases: ['torch', 'PyTorch', 'x'] },
      { term: 'r', weight: 3 },
      { term: 'pytorch', weight: 1 },
      { term: ' sql ', weight: 0 }
    ]
  });
  assert.deepStrictEqual(normalized.skills, [
    { term: 'pytorch', weight: 3, aliases: ['torch'], broad_aliases: [] },
    { term: 'sql', weight: 1, aliases: [], broad_aliases: [] }
  ]);

  // Matchability normalization: snake_case → spaces, and canonical atomic tokens
  // recovered from compound terms as aliases so they match plain job text (the
  // local model otherwise emits "python_programming"/"rag pipelines" that never
  // hit a posting saying "Python" or "RAG").
  const matchable = normalizeVariantProfile({
    skills: [
      { term: 'python_programming', weight: 3 },
      { term: 'rag pipelines', weight: 2 },
      { term: 'star schema design', weight: 2 },
      { term: 'aws (lambda, ec2)', weight: 1 }
    ]
  });
  // Recovered atomic tokens land in broad_aliases (scoring credits them at
  // weight 1 — a bare "rag" must not earn what "rag pipelines" earns), while
  // parenthetical tokens are the author naming concrete tools: full-weight
  // aliases, with the head kept as the term.
  assert.deepStrictEqual(matchable.skills, [
    { term: 'python programming', weight: 3, aliases: [], broad_aliases: ['python'] },
    { term: 'rag pipelines', weight: 2, aliases: [], broad_aliases: ['rag'] },
    { term: 'star schema design', weight: 2, aliases: [], broad_aliases: [] }, // no allowlisted token → no noisy alias
    { term: 'aws', weight: 1, aliases: ['lambda', 'ec2'], broad_aliases: [] }
  ]);

  // Unmatchable resume phrases are trimmed to a matchable head, with a warning.
  const warnings = [];
  const trimmed = normalizeVariantProfile({
    skills: [
      { term: 'automated summarization pipelines for clinical notes', weight: 3 },
      { term: 'forecasting models (sarimax, prophet)', weight: 3 },
      // Trimming must not end on a connective, and a comma list is a head
      // plus concrete tools — not a four-word phrase.
      { term: 'data ingestion and preparation', weight: 2 },
      { term: 'aws sagemaker, lambda, ec2', weight: 1 },
      // Mid-phrase connective: the concept is "cnns", not "cnns for medical".
      { term: 'cnns for medical imaging', weight: 2 }
    ],
    domains: ['machine_learning', 'AI/ML Engineering', 'machine learning'],
    target_titles: ['machine_learning engineer'],
    // Self-penalty guard: a model asked for "poor fit" terms reaches for the
    // resume. "machine learning" here would dock every ML job.
    avoid_signals: ['registered_nurse', 'machine learning', 'cnns for medical imaging']
  }, (message) => warnings.push(message));
  assert.deepStrictEqual(trimmed.skills, [
    { term: 'automated summarization pipelines', weight: 3, aliases: [], broad_aliases: [] },
    { term: 'forecasting models', weight: 3, aliases: ['sarimax', 'prophet'], broad_aliases: [] },
    { term: 'data ingestion', weight: 2, aliases: [], broad_aliases: [] },
    { term: 'aws sagemaker', weight: 1, aliases: ['lambda', 'ec2'], broad_aliases: ['aws'] },
    { term: 'cnns', weight: 2, aliases: [], broad_aliases: [] }
  ]);
  assert(warnings.some((line) => /trimmed unmatchable term/.test(line)));
  assert(warnings.some((line) => /dropped self-referential avoid signal/.test(line)));
  // Domains/titles/avoid signals normalize + dedupe (underscores never matched).
  assert.deepStrictEqual(trimmed.domains, ['machine learning', 'ai ml engineering']);
  assert.deepStrictEqual(trimmed.target_titles, ['machine learning engineer']);
  assert.deepStrictEqual(trimmed.avoid_signals, ['registered nurse'],
    'own skills/domains must never become self-penalties');
  // Model output for avoid_signals is discarded (reconcileCore sources the
  // curated list), so it must not be a required field the model has to fill.
  assert(!VARIANT_SCHEMA.required.includes('avoid_signals'));
  assert(VARIANT_SCHEMA.properties.avoid_signals);

  // Core reconciliation: degree union (completed beats in_progress), most
  // senior stage, max years, curated avoid signals
  const core = reconcileCore([
    {
      summary: 'ML person.',
      career_stage: 'early_career',
      years_experience: 3,
      degrees: [
        { level: 'masters', field: 'Computer Science', status: 'in_progress' },
        { level: 'bachelors', field: 'Math', status: 'completed' }
      ],
      title_classes: ['data_computational'],
      // Model output here is discarded: every real run returned the person's
      // own history, which would penalize jobs they could plausibly get.
      avoid_signals: ['research assistant', 'machine learning'],
      notes_for_ranking: 'Prefers computational roles.'
    },
    {
      summary: 'Data person.',
      career_stage: 'mid_career',
      years_experience: 5,
      degrees: [{ level: 'masters', field: 'computer science', status: 'completed' }],
      title_classes: ['engineering_software'],
      avoid_signals: ['graduate teaching assistant'],
      notes_for_ranking: 'Prefers computational roles.'
    }
  ]);
  assert.strictEqual(core.career_stage, 'mid_career');
  assert.strictEqual(core.years_experience, 5);
  assert.strictEqual(core.summary, 'ML person.');
  assert.deepStrictEqual(core.degrees, [
    { level: 'masters', field: 'Computer Science', status: 'completed' },
    { level: 'bachelors', field: 'Math', status: 'completed' }
  ]);
  assert(core.avoid_signals.includes('registered nurse'), 'curated cross-profession signals apply');
  assert(!core.avoid_signals.includes('research assistant'), 'model-supplied self-penalties are discarded');
  assert(!core.avoid_signals.includes('machine learning'));
  // A non-computational profile gets no cross-profession list at all.
  const clinicalCore = reconcileCore([{
    summary: 'Nurse.', career_stage: 'early_career', years_experience: 3,
    degrees: [], title_classes: ['clinical'], avoid_signals: [], notes_for_ranking: ''
  }]);
  assert.deepStrictEqual(clinicalCore.avoid_signals, []);
  assert.strictEqual(core.notes_for_ranking, 'Prefers computational roles.');

  // Scaffold id slugs
  assert.strictEqual(slugify('ML Engineer Resume.pdf'), 'ml-engineer-resume');
  assert.strictEqual(slugify('___.pdf'), 'variant');
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

  // Years: far beyond reach blocks; near the user's experience only cautions.
  const tooSenior = assess(`${LONG} Minimum of 10 years of experience is required.`);
  assert.strictEqual(tooSenior.verdict, 'blocked');
  assert.strictEqual(tooSenior.blockers[0].type, 'experience');
  assert(tooSenior.blockers[0].evidence.includes('10 years'));
  assert.strictEqual(assess(`${LONG} Requires a minimum of 5 years of experience.`).verdict, 'likely');
  // "Preferred" is not a wall.
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

  // A cached local-model reading supplies job-side facts only; the comparison
  // stays deterministic. Without a quote it cannot block.
  const claimed = assess(LONG, { classified_requirements: { min_years: 12 } });
  assert.strictEqual(claimed.verdict, 'likely');

  /* Regressions from the first live precision review (2026-08-04). Both of
     these hid a genuinely good job, which is the failure this layer exists to
     avoid — quoted verbatim from the postings that produced them. */

  // Northeastern "Data Scientist", fit 47: one clause holds both words, and
  // the stricter credential was claiming the requirement.
  const optionalPhd = assess(`${LONG} Education & Experience Master’s degree (required) or Ph.D. (optional) in Computer Science, Engineering, or a related field.`);
  assert.strictEqual(optionalPhd.verdict, 'clear', 'an optional PhD is not a requirement');

  // Six University of Chicago postings, fits 27-44: a range asks for its
  // floor, and alternative routes mean the lowest bar is the real one.
  const range = assess(`${LONG} Minimum qualifications include knowledge and skills developed through 5-7 years of work experience in a related job discipline.`);
  assert.strictEqual(range.verdict, 'likely', '5-7 years asks for 5, not 7');
  assert.strictEqual(parseYearsRequirement('requires 5-7 years of experience').min_years, 5);
  const alternatives = assess(`${LONG} Bachelor's degree plus 8 years experience required, Master's degree plus 6 years experience required.`);
  assert.strictEqual(alternatives.verdict, 'likely', 'the most permissive route is the bar');
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

  // Off-track: unknown stays out of Qualified (it lives in All jobs), none is out.
  assert.strictEqual(isQualified(job(fit('unknown', 'clear'))), false);
  assert.strictEqual(isQualified(job(fit('none', 'clear'))), false);
  assert.strictEqual(isQualified(job(fit(null, 'clear'))), false);

  // Blocked is excluded by default but revealable — the same predicate must
  // serve the "+N blocked" count so the two can never disagree.
  const blocked = job(fit('reachable', 'blocked'));
  assert.strictEqual(isQualified(blocked), false);
  assert.strictEqual(isQualified(blocked, { includeBlocked: true }), true);
  // includeBlocked only lifts the eligibility gate, nothing else.
  assert.strictEqual(isQualified(job(fit('none', 'blocked')), { includeBlocked: true }), false);

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

async function testRouterSelection() {
  const fitFor = (score, ambiguous) => ({ fit_score: score, ambiguous, variants: [] });
  const jobs = [
    { id: 'a', fit: fitFor(60, true) },
    { id: 'b', fit: fitFor(50, false) },   // clear call — never routed
    { id: 'c', fit: fitFor(45, true) },
    { id: 'd', fit: fitFor(30, true) },
    { id: 'e', fit: fitFor(null, false) }, // no profile
    { id: 'f', fit: fitFor(70, true) }
  ];

  // fit-desc order, ambiguous only
  assert.deepStrictEqual(
    selectAmbiguousJobs(jobs, {}, {}).map((job) => job.id),
    ['f', 'a', 'c', 'd']
  );
  // --min-fit and --limit respected
  assert.deepStrictEqual(
    selectAmbiguousJobs(jobs, {}, { minFit: 40 }).map((job) => job.id),
    ['f', 'a', 'c']
  );
  assert.deepStrictEqual(
    selectAmbiguousJobs(jobs, {}, { limit: 2 }).map((job) => job.id),
    ['f', 'a']
  );
  // already-verdicted jobs are skipped
  assert.deepStrictEqual(
    selectAmbiguousJobs(jobs, { f: { variant_id: 'ml' } }, {}).map((job) => job.id),
    ['a', 'c', 'd']
  );

  // verdict validation
  assert.strictEqual(validateVerdict({ variant_id: 'zz', confidence: 'high', reason: 'x' }, ['ml', 'de']), null);
  assert.strictEqual(validateVerdict(null, ['ml']), null);
  const normalized = validateVerdict({ variant_id: 'ml', confidence: 'certain', reason: 'MLOps heavy' }, ['ml', 'de']);
  assert.deepStrictEqual(normalized, { variant_id: 'ml', confidence: 'low', reason: 'MLOps heavy' });

  // the prompt grounds the model in the user's declared intents and scores
  const compiled = RadarScoring.compileProfile(SCORING_FIXTURE_PROFILE);
  const job = {
    id: 'j1',
    title: 'Machine Learning Engineer',
    department: 'Research IT',
    title_class: 'data_computational',
    description_text: ML_JOB_DESCRIPTION,
    research_relevance_score: 0
  };
  RadarScoring.scoreAll([job], compiled, null);
  const prompt = buildRoutePrompt(job, SCORING_FIXTURE_PROFILE, job.fit);
  assert(prompt.includes('id: ml'));
  assert(prompt.includes('Leads with production ML'));
  assert(prompt.includes('deterministic score for this job: 46'));
  assert(prompt.includes('Machine Learning Engineer (Research IT)'));

  // stubbed Ollama happy path returns a validated verdict
  const originalFetch = globalThis.fetch;
  try {
    let requestBody = null;
    globalThis.fetch = async (url, init) => {
      requestBody = JSON.parse(init.body);
      return {
        ok: true,
        json: async () => ({ message: { content: '{"variant_id":"de","confidence":"high","reason":"Pipeline-heavy posting"}' } })
      };
    };
    const verdict = await askOllama(job, SCORING_FIXTURE_PROFILE, job.fit, { model: 'qwen3:8b', baseUrl: 'http://stub' });
    assert.deepStrictEqual(verdict, { variant_id: 'de', confidence: 'high', reason: 'Pipeline-heavy posting' });
    assert.strictEqual(requestBody.model, 'qwen3:8b');
    assert.strictEqual(requestBody.stream, false);
    assert.deepStrictEqual(requestBody.format.properties.variant_id.enum, ['ml', 'de']);

    // malformed model output is dropped, not thrown
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ message: { content: 'not json' } }) });
    assert.strictEqual(await askOllama(job, SCORING_FIXTURE_PROFILE, job.fit, { model: 'm', baseUrl: 'http://stub' }), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testLocalExtraction() {
  // Arg parsing: local Ollama is the default; provider/model/positional split
  assert.deepStrictEqual(parseArgs([]), { force: false, provider: 'ollama', model: null, positional: [] });
  assert.strictEqual(parseArgs(['--provider', 'anthropic']).provider, 'anthropic');
  assert.strictEqual(parseArgs(['--anthropic']).provider, 'anthropic');
  assert.strictEqual(parseArgs(['--model', 'qwen2.5:14b-instruct']).model, 'qwen2.5:14b-instruct');
  assert.strictEqual(parseArgs(['--force']).force, true);
  // "--provider anthropic" must not leak its value into positional (single-file) args
  assert.deepStrictEqual(parseArgs(['--provider', 'anthropic', 'resume.txt']).positional, ['resume.txt']);

  // The extraction prompt carries the variant's declared label + intent
  const prompt = variantUserPrompt('RESUME BODY', { label: 'ML Engineer', intent: 'Leads with production ML' });
  assert(prompt.includes('"ML Engineer"'));
  assert(prompt.includes('Leads with production ML'));
  assert(prompt.includes('RESUME BODY'));

  // Cache key is model-tag sensitive: a local profile and a hosted profile of
  // the same resume must not collide
  const variant = { label: 'ML Engineer', intent: 'Leads with production ML' };
  const localKey = variantCacheKey('body', variant, 'ollama:qwen2.5:7b-instruct');
  const hostedKey = variantCacheKey('body', variant, 'claude-opus-4-8');
  assert.notStrictEqual(localKey, hostedKey);
  assert.strictEqual(variantCacheKey('body', variant, 'ollama:qwen2.5:7b-instruct'), localKey);

  // Shared Ollama client: structured happy path, parse-fail, and HTTP error
  const originalFetch = globalThis.fetch;
  try {
    let body = null;
    globalThis.fetch = async (url, init) => {
      body = JSON.parse(init.body);
      return { ok: true, json: async () => ({ message: { content: '{"summary":"x","skills":[]}' } }) };
    };
    const parsed = await ollamaChat({
      baseUrl: 'http://stub', model: 'qwen2.5:7b-instruct',
      system: 'S', user: 'U', format: { type: 'object' }, options: { temperature: 0, num_predict: 8192 }
    });
    assert.deepStrictEqual(parsed, { summary: 'x', skills: [] });
    assert.strictEqual(body.stream, false);
    assert.strictEqual(body.model, 'qwen2.5:7b-instruct');
    assert.strictEqual(body.options.num_predict, 8192);
    assert.deepStrictEqual(body.messages, [{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }]);
    assert(body.format);

    globalThis.fetch = async () => ({ ok: true, json: async () => ({ message: { content: 'not json' } }) });
    assert.strictEqual(await ollamaChat({ baseUrl: 'http://stub', model: 'm', user: 'U' }), null);

    globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => 'boom' });
    let threw = false;
    try {
      await ollamaChat({ baseUrl: 'http://stub', model: 'm', user: 'U' });
    } catch (error) {
      threw = /ollama 500/.test(error.message);
    }
    assert(threw);
  } finally {
    globalThis.fetch = originalFetch;
  }
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
  testProfileIngestion();
  testDegreeGateParsing();
  testVariantScoring();
  testFitEngineRepairs();
  testEligibility();
  testRoleTrack();
  testQualifiedPredicate();
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
  await testRouterSelection();
  await testLocalExtraction();

  console.log('Radar tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
