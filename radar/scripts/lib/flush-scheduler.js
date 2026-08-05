'use strict';

/**
 * A debounce that cannot starve.
 *
 * The judgment cache used a plain debounce: every write cleared the pending
 * timer and set a fresh one three seconds out. That is correct only while
 * writes are rarer than the delay. When judging moved from a local model at
 * 20s per posting to six API workers landing one every few hundred
 * milliseconds, every write pushed the deadline back and the timer never fired
 * — the file sat 42 minutes untouched holding ~2,900 paid-for judgments that
 * would have died with the process. Nothing errored; the writes simply stopped
 * happening. Speeding up the producer silently broke the writer.
 *
 * So the debounce has a ceiling. Bursts still coalesce, but once `maxWaitMs`
 * has passed since the last flush, the pending timer is left alone to fire.
 *
 * Timers and the clock are injectable so the behaviour can be tested without
 * waiting in real seconds — this is a policy about time, and a policy about
 * time that is not tested is a policy that will drift again.
 */
function createFlushScheduler({
  flush,
  debounceMs = 3000,
  maxWaitMs = 15000,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout
} = {}) {
  let timer = null;
  let lastFlushAt = now();
  let dirty = false;

  async function run() {
    timer = null;
    if (!dirty) return;
    dirty = false;
    lastFlushAt = now();
    try {
      await flush();
    } catch (error) {
      dirty = true; // keep the work queued rather than dropping it
      throw error;
    }
  }

  return {
    /** Mark work pending and (re)arm the timer, subject to the ceiling. */
    schedule() {
      dirty = true;
      if (timer !== null) {
        if (now() - lastFlushAt >= maxWaitMs) return; // past the ceiling: let it fire
        clearTimer(timer);
      }
      timer = setTimer(run, debounceMs);
    },
    /** Write now — used on shutdown, where a signal gives no second chance. */
    async flushNow() {
      if (timer !== null) { clearTimer(timer); timer = null; }
      await run();
    },
    get pending() { return dirty; }
  };
}

module.exports = { createFlushScheduler };
