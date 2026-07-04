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
  isResearchRelevantTitle,
  applyJobLifecycle
} = require('../radar/scripts/refresh.js');
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
  testProviderMappers();
  await testFetchRetry();
  testJobLifecycle();
  testEnrichment();

  console.log('Radar tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
