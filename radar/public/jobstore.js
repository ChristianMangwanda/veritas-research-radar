/* ---------------------------------------------------------------------------
   jobstore — a local copy of the postings, so opening the app twice does not
   mean downloading them twice.

   Not a service worker and not an offline app. This is one IndexedDB database
   holding the rows exactly as the API returned them, plus a watermark saying
   how fresh they are. Every entry point degrades to the plain network path:
   a blocked database (private browsing), an evicted one, or a schema bump all
   end in "slow load", never in "no jobs".

   THREE THINGS ABOUT THE DATA THAT SHAPE EVERYTHING HERE, each measured
   against the live table rather than assumed:

   1. syncJobs stamps ONE updated_at for a whole run. A 1,000-row sample of the
      newest rows held exactly two distinct timestamps (528 and 472), and a
      single run on 2026-08-15 stamped 23,560 rows. So updated_at cannot be a
      keyset cursor — one value exceeds the page cap — and a client that pulls
      mid-run and sets W = max(updated_at) would permanently skip every row
      that run writes afterwards. Hence: keyset on id, and rewind the
      watermark behind the server's own clock.

   2. A closure is an UPDATE, not a delete. comparableRow() includes status and
      closed_at, so a job going closed gets a fresh updated_at. Measured: a
      1,000-row delta came back 670 active / 330 closed. So the delta query
      MUST NOT carry the active filter — filtering it would hide exactly the
      transitions the delta exists to observe.

   3. Real DELETEs do happen (expired 30-day tombstones, employers dropped from
      the registry) and nothing in updated_at can show them. That is what the
      sweep is for.
--------------------------------------------------------------------------- */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RadarJobStore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DB_NAME = 'veritas_radar';
  var DB_VERSION = 1;
  var JOBS = 'jobs';
  var META = 'meta';

  /* One run's rows land over several minutes behind a timestamp stamped at its
     start, so a watermark taken at face value skips the tail. Rewinding a
     quarter hour costs about one run's rows on the next open (~800, one page)
     and is the difference between "cheap" and "quietly wrong". */
  var WATERMARK_LAG_MS = 15 * 60 * 1000;
  var SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
  /* Above this share of the cache the delta is not a delta. Measured: any gap
     spanning a mass rewrite returns the whole table. */
  var MASS_REWRITE_RATIO = 0.4;

  /* ---------------------------------------------------------------- pure -- */
  /* Everything below this line is decidable without a database or a network,
     which is the only reason it can be tested at all. */

  /** Never trust the device clock: skew would silently skip rows. The server's
   *  own Date header is the reference, and we sit deliberately behind it. */
  function nextWatermark(maxSeenIso, serverDateIso, lagMs) {
    var lag = typeof lagMs === 'number' ? lagMs : WATERMARK_LAG_MS;
    var candidates = [];
    if (maxSeenIso) candidates.push(Date.parse(maxSeenIso));
    if (serverDateIso) candidates.push(Date.parse(serverDateIso));
    candidates = candidates.filter(function (n) { return !isNaN(n); });
    if (!candidates.length) return null;
    return new Date(Math.min.apply(null, candidates) - lag).toISOString();
  }

  /** What a delta row means for the cache. A posting you have acted on is kept
   *  whatever its status — the pipeline is never hidden. */
  function mergeDecision(row, triagedIds) {
    if (!row) return 'skip';
    if (triagedIds && triagedIds.has && triagedIds.has(row.id)) return 'put';
    if (row.status !== 'active') return 'delete';
    if (row.citizenship_gated) return 'delete';
    return 'put';
  }

  /** Ids are colon-composed (workday:cornell:WDR-1) and a bare colon ends the
   *  value. Quoting wrong does not error — the filter just matches nothing,
   *  which is a silent recall loss. */
  function inList(ids) {
    return '(' + ids.map(function (id) {
      return '"' + String(id).replace(/"/g, '\\"') + '"';
    }).join(',') + ')';
  }

  function chunk(items, size) {
    var out = [];
    for (var i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
    return out;
  }

  function shouldSweep(meta, now, tripwireFired) {
    if (tripwireFired) return true;
    if (!meta || !meta.at) return true;
    return (now - Date.parse(meta.at)) > SWEEP_INTERVAL_MS;
  }

  function isMassRewrite(deltaCount, cachedCount) {
    if (!cachedCount) return true;
    return deltaCount > cachedCount * MASS_REWRITE_RATIO;
  }

  /* ------------------------------------------------------------- storage -- */

  function open() {
    return new Promise(function (resolve, reject) {
      if (typeof indexedDB === 'undefined' || !indexedDB) return reject(new Error('no indexedDB'));
      var request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = function () {
        var db = request.result;
        if (!db.objectStoreNames.contains(JOBS)) db.createObjectStore(JOBS, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'key' });
      };
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error || new Error('indexedDB open failed')); };
      request.onblocked = function () { reject(new Error('indexedDB blocked')); };
    });
  }

  function tx(db, store, mode, run) {
    return new Promise(function (resolve, reject) {
      var t = db.transaction(store, mode);
      var s = t.objectStore(store);
      var out = run(s);
      t.oncomplete = function () { resolve(out && out.result !== undefined ? out.result : out); };
      t.onerror = function () { reject(t.error); };
      t.onabort = function () { reject(t.error || new Error('transaction aborted')); };
    });
  }

  /** getAll() on 16,000 rows holds the whole deserialized set in memory at
   *  once, and the caller then builds a job per row — so the peak is both
   *  copies. Measured: 251MB on a warm open against 122MB on a cold one, i.e.
   *  the cache made the memory problem worse than the bug it was fixing.
   *  A cursor hands them over in slices, so each slice can be converted and
   *  released, and the first slice can be drawn immediately. */
  function readChunked(db, size, onChunk) {
    return new Promise(function (resolve, reject) {
      var t = db.transaction(JOBS, 'readonly');
      var batch = [];
      var total = 0;
      var request = t.objectStore(JOBS).openCursor();
      request.onsuccess = function () {
        var cursor = request.result;
        if (!cursor) {
          if (batch.length) { total += batch.length; onChunk(batch); }
          return;
        }
        batch.push(cursor.value);
        if (batch.length >= size) {
          total += batch.length;
          onChunk(batch);
          batch = [];
        }
        cursor.continue();
      };
      request.onerror = function () { reject(request.error); };
      t.oncomplete = function () { resolve(total); };
      t.onerror = function () { reject(t.error); };
      t.onabort = function () { reject(t.error || new Error('read aborted')); };
    });
  }

  function readMeta(db, key) {
    return tx(db, META, 'readonly', function (s) { return s.get(key); });
  }

  function writeMeta(db, record) {
    return tx(db, META, 'readwrite', function (s) { s.put(record); });
  }

  /** Written in batches AFTER the page has rendered — 16,000 puts on the frame
   *  you were trying to speed up would defeat the whole exercise. */
  function putRows(db, rows) {
    return tx(db, JOBS, 'readwrite', function (s) {
      for (var i = 0; i < rows.length; i += 1) s.put(rows[i]);
    });
  }

  function deleteIds(db, ids) {
    if (!ids.length) return Promise.resolve();
    return tx(db, JOBS, 'readwrite', function (s) {
      for (var i = 0; i < ids.length; i += 1) s.delete(ids[i]);
    });
  }

  function clear(db) {
    return tx(db, JOBS, 'readwrite', function (s) { s.clear(); });
  }

  /** iOS Safari evicts silently, so ask before writing 80MB of descriptions
   *  rather than discovering the limit halfway through a transaction — a
   *  half-written cache is worse than none. */
  function hasRoomForDescriptions() {
    if (!navigator.storage || !navigator.storage.estimate) return Promise.resolve(true);
    return navigator.storage.estimate().then(function (e) {
      if (!e || typeof e.quota !== 'number') return true;
      return (e.quota - (e.usage || 0)) > 120 * 1024 * 1024;
    }).catch(function () { return true; });
  }

  return {
    DB_NAME: DB_NAME,
    DB_VERSION: DB_VERSION,
    WATERMARK_LAG_MS: WATERMARK_LAG_MS,
    SWEEP_INTERVAL_MS: SWEEP_INTERVAL_MS,
    // pure, and therefore tested
    nextWatermark: nextWatermark,
    mergeDecision: mergeDecision,
    inList: inList,
    chunk: chunk,
    shouldSweep: shouldSweep,
    isMassRewrite: isMassRewrite,
    // storage
    open: open,
    readChunked: readChunked,
    readMeta: readMeta,
    writeMeta: writeMeta,
    putRows: putRows,
    deleteIds: deleteIds,
    clear: clear,
    hasRoomForDescriptions: hasRoomForDescriptions
  };
}));
