'use strict';

/**
 * Writing judgments to match_cache, safely.
 *
 * Two postings with byte-identical title, department and description produce
 * the same jobContentHash, and the cache is keyed on (job_hash, profile_hash) —
 * deliberately, because a verdict is about the posting's content, not about
 * which employer's board it happened to appear on. Every read path already
 * resolves through the hash and fans one row out to every job sharing it.
 *
 * The write path never learned that. It carried one row per JOB, so a batch
 * could contain the same key twice, and Postgres rejects such a batch whole
 * ("ON CONFLICT DO UPDATE command cannot affect row a second time", 21000).
 * Measured against a real pool: 7,859 qualified postings, 7,671 distinct
 * hashes, and because misses are sorted by fit score the duplicates land
 * adjacent — 64 of 158 batches carried one. Every rejected batch was work
 * already paid for.
 *
 * So: collapse to one representative per hash BEFORE spending anything, dedupe
 * again immediately before each write as a belt-and-braces guard, and treat a
 * row as durable only once PostgREST has confirmed it.
 */

const { writeAllBatches, isTransientPostgrestError } = require('./batch-write.js');

const DEFAULT_BATCH = 25;

function cacheRowKey(row) {
  return `${row.job_hash} ${row.profile_hash}`;
}

/** Last occurrence wins, matching the upsert's own merge-duplicates semantics
 *  (the same idiom the jobs sink uses on id). */
function dedupeCacheRows(rows) {
  return [...new Map(rows.map((row) => [cacheRowKey(row), row])).values()];
}

/**
 * Collapse misses to one representative per content hash.
 *
 * The first entry per hash is kept, and callers pass the list already sorted by
 * fit score, so a spend cap still cuts the least promising work rather than an
 * arbitrary one. `membersByHash` lets a caller apply the single judgment to
 * every job that shares the hash.
 */
function groupMissesByHash(misses) {
  const membersByHash = new Map();
  const representatives = [];
  for (const miss of misses) {
    const existing = membersByHash.get(miss.hash);
    if (existing) {
      existing.push(miss.job);
      continue;
    }
    membersByHash.set(miss.hash, [miss.job]);
    representatives.push(miss);
  }
  return { representatives, membersByHash };
}

/**
 * The single writer. Workers judge concurrently and hand rows over; exactly one
 * upsert is ever in flight, and rows leave the queue only after the write that
 * carried them succeeded.
 *
 * Ordering is the whole point. The previous version spliced the queue before
 * awaiting the request, so a failed batch took ~50 paid judgments with it and
 * the run reported them as judged.
 */
function createCacheWriter({
  upsert,
  batchSize = DEFAULT_BATCH,
  attempts = 3,
  baseDelayMs = 1000,
  isTransient = isTransientPostgrestError,
  sleep
} = {}) {
  const pending = [];
  let chain = Promise.resolve();
  let failure = null;
  let written = 0;

  const flushOnce = async () => {
    if (failure || !pending.length) return;
    const take = Math.min(batchSize, pending.length);
    const batch = dedupeCacheRows(pending.slice(0, take));
    try {
      await writeAllBatches(batch, upsert, { batchSize: batch.length, attempts, baseDelayMs, isTransient, sleep });
      // Confirmed — only now do these rows stop being our problem.
      pending.splice(0, take);
      written += take;
    } catch (error) {
      failure = error;
    }
  };

  // Errors are captured into `failure`, never rethrown into the chain, so a
  // synchronous push() can extend it without risking an unhandled rejection.
  const enqueueFlush = () => {
    chain = chain.then(flushOnce);
  };

  return {
    push(row) {
      if (failure) return false;
      pending.push(row);
      if (pending.length >= batchSize) enqueueFlush();
      return true;
    },
    get failed() {
      return Boolean(failure);
    },
    async close() {
      await chain;
      while (!failure && pending.length) {
        await flushOnce();
      }
      return { written, unwritten: pending.length, failure };
    }
  };
}

module.exports = { dedupeCacheRows, groupMissesByHash, createCacheWriter, cacheRowKey };
