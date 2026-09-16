const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto, createHash } = require('node:crypto');
const matching = require('../radar/public/matching.js');
const { parseProfileDocument } = require('../radar/public/profile-doc.js');
const profile = parseProfileDocument('---\nsalary_floor: 50000\nlocations: [Boston]\n---\n## Who I am\nResearcher\n## What I can do\nPython, SQL\n## What I want\nRemote work');
const job = { id: 'j1', title: 'Data researcher', department: 'Science', employer_name: 'Example', description_text: 'Analyze data.', location: 'Boston', remote: true, salary_min: 50000, salary_max: 80000 };

test('judgment fingerprints are identical in Node and a browser runtime', async () => {
  const browser = vm.createContext({ crypto: webcrypto, TextEncoder });
  vm.runInContext(fs.readFileSync('radar/public/matching.js', 'utf8'), browser);
  assert.equal(await browser.RadarMatching.profileFingerprint(profile), await matching.profileFingerprint(profile));
  assert.equal(await browser.RadarMatching.jobFingerprint(job), await matching.jobFingerprint(job));
  assert.equal(await matching.fingerprint({ b: 2, a: 1 }), 'judge2:sha256:' + createHash('sha256').update('{"a":1,"b":2}').digest('hex'));
});

test('all candidate constraints and model changes invalidate a judgment', async () => {
  const initial = await matching.profileFingerprint(profile);
  for (const edit of [
    { prose: profile.prose.replace('Remote work', 'On-site work') },
    { core: { ...profile.core, salary_floor: 90000 } },
    { core: { ...profile.core, locations: ['Seattle'] } },
    { core: { ...profile.core, degrees: [{ level: 'phd', status: 'completed' }] } },
    { core: { ...profile.core, years_experience: 8 } },
    { core: { ...profile.core, work_authorization: 'citizen' } }
  ]) assert.notEqual(await matching.profileFingerprint({ ...profile, ...edit }), initial);
  assert.notEqual(await matching.profileFingerprint(profile, 'another-model'), initial);
  assert.equal(await matching.profileFingerprint({ ...profile, updated_at: 'tomorrow' }), initial);
  assert.match(matching.candidateBrief(profile, ''), /salary_floor.*50000/);
});

test('posting changes invalidate judgments while bookkeeping and ids do not', async () => {
  const initial = await matching.jobFingerprint(job);
  for (const edit of [
    { title: 'Senior researcher' }, { department: 'Engineering' },
    { employer_name: 'Another employer' }, { description_text: 'New requirements' },
    { location: 'Seattle' }, { remote: false }, { salary_min: 90000 }, { salary_max: 120000 }
  ]) assert.notEqual(await matching.jobFingerprint({ ...job, ...edit }), initial);
  assert.equal(await matching.jobFingerprint({ ...job, id: 'other', first_seen_at: 'tomorrow', fit: { fit_score: 99 } }), initial);
});

test('prompt and schema edits automatically change the judgment generation', async () => {
  const src = fs.readFileSync('radar/public/matching.js', 'utf8');
  const context = vm.createContext({ crypto: webcrypto, TextEncoder });
  vm.runInContext(src.replace('Be decisive and specific.', 'Use different judging rules.'), context);
  assert.notEqual(await context.RadarMatching.profileFingerprint(profile), await matching.profileFingerprint(profile));
});

test('preparation waits for descriptions and detects mutations on existing objects', async () => {
  const record = { ...job, _descPending: true };
  await matching.prepareJobs([record]);
  assert.equal(record._judgmentHash, null);
  record._descPending = false;
  await matching.prepareJobs([record]);
  const before = record._judgmentHash;
  record.location = 'Seattle';
  await matching.prepareJobs([record]);
  assert.notEqual(record._judgmentHash, before);
  assert.equal(record._judgmentHash, await matching.jobFingerprint(record));
});
