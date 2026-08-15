'use strict';

/**
 * Sequential batched writes to PostgREST, with the retry discipline the
 * previous write paths did not have.
 *
 * Two lessons are built in. The first: this database minds CONCURRENCY, not
 * depth — four concurrent ranges over the jobs table produced 65 failures where
 * the same work done one request at a time produced none. So batches go out
 * strictly one after another, never fanned out.
 *
 * The second: a timeout is not a verdict on the data. A batch that aborts at
 * 30 seconds usually succeeds when it is smaller, so an exhausted batch is cut
 * in half and retried rather than thrown away. A batch that fails because the
 * rows are wrong fails identically at every size, so only transient errors earn
 * that treatment — splitting a 400 just buys the same 400 twice.
 */

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 1000;

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Transient means "the same request might work later": the connection died, the
 * statement timed out, the server was busy. Anything else — a malformed row, a
 * duplicate key, a revoked credential — is a fact about the request and retrying
 * it only wastes the window.
 *
 * Status codes are read out of the message because both PostgREST clients in
 * this repo bake them into the string rather than onto the error object
 * (`… → 500: detail` in judge-jobs.js, `… : 500 detail` in lib/supabase.js).
 */
function isTransientPostgrestError(error) {
  if (!error) return false;
  if (error.name === 'AbortError') return true;
  const message = String(error.message || error);
  if (/\b(408|425|429|5\d\d)\b/.test(message)) return true;
  return /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|socket hang up|network|timed? ?out|aborted/i.test(message);
}

function chunk(rows, size) {
  const out = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

/**
 * Write every row through `post`, one batch at a time. Resolves with the count
 * written; rejects on the first batch that cannot be written at any size, so
 * the caller can treat a rejection as "these rows are not durable".
 */
async function writeAllBatches(rows, post, options = {}) {
  const {
    batchSize = 100,
    attempts = DEFAULT_ATTEMPTS,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    isTransient = isTransientPostgrestError,
    sleep = defaultSleep
  } = options;

  let written = 0;

  const writeBatch = async (batch) => {
    if (!batch.length) return;
    for (let attempt = 0; ; attempt += 1) {
      try {
        await post(batch);
        written += batch.length;
        return;
      } catch (error) {
        if (!isTransient(error)) throw error;
        if (attempt < attempts - 1) {
          await sleep(baseDelayMs * 2 ** attempt);
          continue;
        }
        // Out of attempts. A single row that still will not go is a real
        // failure; anything larger might just be too big for the window.
        if (batch.length === 1) throw error;
        const half = Math.ceil(batch.length / 2);
        await writeBatch(batch.slice(0, half));
        await writeBatch(batch.slice(half));
        return;
      }
    }
  };

  for (const batch of chunk(rows, Math.max(1, batchSize))) {
    await writeBatch(batch);
  }
  return { written };
}

module.exports = { writeAllBatches, isTransientPostgrestError, chunk };
