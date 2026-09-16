const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const matching = require('../radar/public/matching.js');
const source = fs.readFileSync('radar/public/app.js', 'utf8');
const matchFunctions = source.slice(source.indexOf('function resetJudgments()'), source.indexOf('/* Filtering + sorting'));
const profile = { core: { salary_floor: 50000 }, prose: 'I want remote work.', variants: [] };
const job = { id: 'j1', title: 'Researcher', employer_name: 'Example', description_text: 'Analyze data.', location: 'Boston' };

function harness() {
  const state = { profile: structuredClone(profile), compiled: {}, jobs: [{ ...job }], jobsById: new Map(), matches: {}, matchesByHash: {}, judgmentProfileHash: null, judgmentCursor: null };
  state.jobsById.set('j1', state.jobs[0]);
  const rows = [];
  const context = vm.createContext({ state, RadarMatching: matching, AbortSignal, Date, console,
    matchRequested: new Set(), JUDGE_ORIGIN: '',
    auth: { signedIn: () => true, accessToken: async () => 'fake' },
    fetch: async () => ({ ok: true, json: async () => ({ model: matching.DEFAULT_MODEL,
      judgment_version: matching.JUDGMENT_VERSION, judgment_contract: await matching.contractFingerprint() }) }),
    authedGet: async (url) => rows.filter((row) => url.includes(encodeURIComponent(row.profile_hash))),
    render() {}
  });
  vm.runInContext(matchFunctions, context);
  return { context, state, rows };
}

test('browser resolves only complete, current fingerprints; profile edits drop old matches', async () => {
  const { context, state, rows } = harness();
  const hash = await matching.profileFingerprint(state.profile);
  rows.push({ profile_hash: hash, job_hash: await matching.jobFingerprint(job), verdict: 'strong', model: matching.DEFAULT_MODEL, judged_at: '2026-09-16T00:00:00Z' });
  await context.loadJudgments();
  assert.equal(state.matches.j1.verdict, 'strong');
  state.profile = { ...state.profile, prose: 'I only want on-site work.' };
  await context.loadJudgments();
  assert.equal(state.matches.j1, undefined);
  assert.notEqual(state.judgmentProfileHash, hash);
});

test('changing a job in the same page removes its old judgment', async () => {
  const { context, state, rows } = harness();
  rows.push({ profile_hash: await matching.profileFingerprint(state.profile), job_hash: await matching.jobFingerprint(job), verdict: 'strong', model: matching.DEFAULT_MODEL, judged_at: '2026-09-16T00:00:00Z' });
  await context.loadJudgments();
  assert.equal(state.matches.j1.verdict, 'strong');
  state.jobs[0].location = 'Seattle';
  await context.loadJudgments();
  assert.equal(state.matches.j1, undefined);
});

test('an in-flight response for the previous profile cannot overwrite a new profile', async () => {
  const { context, state } = harness();
  await context.loadJudgments();
  const oldProfileHash = state.judgmentProfileHash;
  const oldJobHash = state.jobs[0]._judgmentHash;
  let finishResponse, started;
  const posted = new Promise((resolve) => { started = resolve; });
  context.fetch = async (_url, init) => {
    assert.equal(JSON.parse(init.body).profile_hash, oldProfileHash);
    started();
    return new Promise((resolve) => { finishResponse = resolve; });
  };
  const request = context.requestJudgments(state.jobs);
  await posted;
  state.profile = { ...state.profile, prose: 'New preference.' };
  await context.loadJudgments();
  finishResponse({ ok: true, json: async () => ({ profile_hash: oldProfileHash, model: matching.DEFAULT_MODEL,
    job_hashes: { j1: oldJobHash }, judgments: { j1: { verdict: 'strong', model: matching.DEFAULT_MODEL } } }) });
  await request;
  assert.equal(state.matches.j1, undefined);
});

test('a stale API response for edited posting content cannot become current', async () => {
  const { context, state } = harness();
  await context.loadJudgments();
  context.fetch = async () => ({ ok: true, json: async () => ({ profile_hash: state.judgmentProfileHash,
    model: matching.DEFAULT_MODEL, job_hashes: { j1: 'older-content' }, judgments: { j1: { verdict: 'strong' } } }) });
  await context.requestJudgments(state.jobs);
  assert.equal(state.matches.j1, undefined);
});

test('a deployment with a different prompt clears matches and asks for a reload', async () => {
  const { context, state } = harness();
  state.matches.j1 = { verdict: 'strong' };
  context.fetch = async () => ({ ok: true, json: async () => ({ model: matching.DEFAULT_MODEL,
    judgment_version: matching.JUDGMENT_VERSION, judgment_contract: 'different-prompt' }) });
  await context.loadJudgments();
  assert.equal(state.matches.j1, undefined);
  assert.equal(state.matchAvailable, false);
  assert.match(state.judgmentError, /Reload/);
});
