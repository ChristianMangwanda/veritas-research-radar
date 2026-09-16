(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RadarFeedHealth = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const FAILURE_THRESHOLD = 3;
  const key = (feed) => `${feed.ats_provider || ''}:${feed.ats_token || ''}`;

  function updateFeedHealth(employers, previousReport, now) {
    const previous = new Map((previousReport?.employers || []).map((entry) => [entry.employer_id, entry]));
    const advances = Date.parse(now) > Date.parse(previousReport?.refreshed_at || '1970-01-01');
    for (const employer of employers) {
      const before = previous.get(employer.employer_id);
      const old = new Map((before?.feed_health || []).map((feed) => [key(feed), feed]));
      const feeds = employer.feeds || (employer.ats_provider ? [{
        ats_provider: employer.ats_provider, ats_token: employer.ats_token,
        ok: !employer.error, skipped: employer.skipped, error: employer.error
      }] : []);
      employer.feed_health = feeds.map((feed) => {
        const prior = old.get(key(feed));
        const failed = !feed.ok && !feed.skipped;
        const healthy = feed.ok && !feed.skipped;
        const failures = failed ? (prior?.consecutive_failures || 0) + (advances ? 1 : 0)
          : healthy ? 0 : prior?.consecutive_failures || 0;
        return { ats_provider: feed.ats_provider, ats_token: feed.ats_token,
          error: feed.error || null, skipped: Boolean(feed.skipped),
          consecutive_failures: failures,
          last_success_at: healthy ? now : prior?.last_success_at || null,
          first_failure_at: failed ? prior?.first_failure_at || now : healthy ? null : prior?.first_failure_at || null,
          persistent_failure: failures >= FAILURE_THRESHOLD };
      });
    }
    return employers;
  }

  function failures(report) {
    return (report?.employers || []).flatMap((employer) => {
      const feeds = employer.feed_health || employer.feeds || [{
        ats_provider: employer.ats_provider, error: employer.error
      }];
      return feeds.filter((feed) => feed.error || feed.persistent_failure)
        .map((feed) => ({ employer_id: employer.employer_id, name: employer.name, ...feed }));
    });
  }

  function persistentFailures(report) {
    return failures(report).filter((feed) => feed.persistent_failure);
  }

  function forJob(job, report) {
    return failures(report).find((feed) => feed.employer_id === job.employer_id
      && feed.ats_provider === job.source
      && (!feed.ats_token || String(job.id).startsWith(`${feed.ats_provider}:${feed.ats_token}:`))) || null;
  }

  // Retry-After supports seconds and HTTP dates. Cap waits so a single source
  // cannot occupy a worker indefinitely. Never retry permanent 4xx responses.
  function retryDelay(error, attempt, baseMs, now = Date.now()) {
    const raw = error.retryAfter;
    const seconds = raw == null || raw === '' ? NaN : Number(raw);
    const requested = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(raw || '') - now;
    return Math.min(60000, Math.max(0, Number.isFinite(requested) ? requested : baseMs * 2 ** attempt));
  }

  return { FAILURE_THRESHOLD, updateFeedHealth, failures, persistentFailures, forJob, retryDelay };
}));
