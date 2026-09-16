const assert = require('node:assert/strict');
const { test } = require('node:test');
const health = require('../radar/public/feed-health.js');
const { criticalRefreshProblems, applyJobLifecycle, isRetryableFetchError } = require('../radar/scripts/refresh.js');
const employer = { employer_id: 'e1', name: 'Example', ats_provider: 'workday', ats_token: 'example', error: null, skipped: false };
function report(previous, entry, hour) {
  const now = `2026-09-16T${String(hour).padStart(2, '0')}:00:00Z`;
  return { refreshed_at: now, employers: health.updateFeedHealth([{ ...entry }], previous, now) };
}

test('a single persistent failing feed raises an alarm and recovery clears it', () => {
  const good = report(null, employer, 0);
  const one = report(good, { ...employer, error: 'HTTP 422' }, 6);
  const two = report(one, { ...employer, error: 'HTTP 422' }, 12);
  const three = report(two, { ...employer, error: 'HTTP 422' }, 18);
  assert.equal(health.persistentFailures(two).length, 0);
  assert.equal(health.persistentFailures(three).length, 1);
  assert.deepEqual(criticalRefreshProblems(three), [],
    'individual source alarms must not block judging jobs from healthy feeds');
  assert.equal(three.employers[0].feed_health[0].last_success_at, good.refreshed_at);
  assert.equal(health.forJob({ employer_id: 'e1', source: 'workday', id: 'workday:example:123' }, three).consecutive_failures, 3);
  assert.equal(health.persistentFailures(report(three, employer, 23)).length, 0);
  assert.equal(health.persistentFailures(report(three, { ...employer, ats_provider: 'pageup', error: 'blocked' }, 23)).length, 0);
});

test('partial employer failures are tracked independently', () => {
  const entry = { ...employer, feeds: [
    { ats_provider: 'workday', ats_token: 'one', ok: true, error: null },
    { ats_provider: 'taleo', ats_token: 'two', ok: false, error: 'HTTP 404' }
  ] };
  let current = null;
  for (const hour of [0, 6, 12]) current = report(current, entry, hour);
  assert.equal(health.persistentFailures(current)[0].ats_provider, 'taleo');
  assert.equal(health.persistentFailures(current).length, 1);
});

test('replaying a report does not count another failure and skips are not successes', () => {
  const one = report(null, { ...employer, error: 'timeout' }, 6);
  const repeated = report(one, { ...employer, error: 'timeout' }, 6);
  assert.equal(repeated.employers[0].feed_health[0].consecutive_failures, 1);
  const skipped = report(repeated, { ...employer, skipped: true }, 12);
  assert.equal(skipped.employers[0].feed_health[0].consecutive_failures, 1);
  assert.equal(skipped.employers[0].feed_health[0].last_success_at, null);
});

test('outages preserve jobs and their last observation', () => {
  const old = { id: 'workday:example:1', employer_id: 'e1', status: 'active', last_seen_at: '2026-09-01' };
  assert.deepEqual(applyJobLifecycle({ previousJobs: [old], fetchedJobs: [], employerOutcomes: new Map([['e1', { attempted: true, ok: false }]]), now: '2026-09-16' }), [old]);
});

test('backoff accepts both Retry-After formats and permanent errors are not retried', () => {
  assert.equal(health.retryDelay({ retryAfter: '2' }, 0, 1000), 2000);
  assert.equal(health.retryDelay({ retryAfter: 'Wed, 16 Sep 2026 12:00:10 GMT' }, 0, 1000, Date.parse('2026-09-16T12:00:00Z')), 10000);
  assert.equal(health.retryDelay({}, 2, 1000), 4000);
  assert.equal(health.retryDelay({ retryAfter: '9999' }, 0, 1000), 60000);
  assert.equal(isRetryableFetchError({ status: 408 }), true);
  for (const status of [400, 401, 403, 404, 422]) assert.equal(isRetryableFetchError({ status }), false);
});
