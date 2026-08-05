#!/usr/bin/env node

/**
 * Fold sharded crawl output back into radar/data/ats-discovery.json.
 *
 * scout_discover.py --shard i/N --out shard-i.json writes ONLY what that
 * worker crawled, so the shards are disjoint by construction and merging is a
 * union rather than a reconciliation. Each shard round-tripping the shared
 * file instead would mean the last writer silently erased every other worker's
 * results — the exact failure that makes parallel crawling look like it worked
 * and quietly lose 7/8 of the run.
 *
 * Disjoint is the expectation, not a guarantee: a shard re-run after a partial
 * failure, or two runs with different --shard counts, can legitimately produce
 * the same key twice. Newest crawled_at wins, and collisions are reported
 * rather than resolved in silence.
 *
 * Usage:
 *   node radar/scripts/merge-discovery.js shards/*.json
 *   node radar/scripts/merge-discovery.js --dry-run shards/*.json
 */

const fsp = require('fs/promises');
const path = require('path');

const DATA_DIR = path.resolve(__dirname, '../data');
const DISCOVERY_PATH = path.join(DATA_DIR, 'ats-discovery.json');
const SCHEMA_VERSION = 1;

function crawledAt(entry) {
  const time = Date.parse(entry?.crawled_at || '');
  return Number.isFinite(time) ? time : 0;
}

async function readEmployers(file) {
  const parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
  const employers = parsed.employers;
  if (!employers || typeof employers !== 'object') {
    throw new Error(`${path.basename(file)}: no "employers" object — not a discovery file`);
  }
  return { employers, shard: parsed.shard || null };
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const files = args.filter((arg) => !arg.startsWith('--'));
  if (!files.length) {
    console.error('usage: merge-discovery.js [--dry-run] <shard.json...>');
    return 1;
  }

  // The base is whatever is already committed. A merge ADDS to the census; it
  // never republishes a subset as the whole thing, so a run where six of eight
  // shards timed out still lands six shards of progress.
  let merged = {};
  try {
    merged = JSON.parse(await fsp.readFile(DISCOVERY_PATH, 'utf8')).employers || {};
  } catch {
    console.warn('no existing ats-discovery.json — starting from the shards alone');
  }
  const before = Object.keys(merged).length;

  let added = 0;
  let refreshed = 0;
  const collisions = [];
  const seen = new Map(); // key -> file that contributed the winning entry

  for (const file of files) {
    let employers;
    let shard;
    try {
      ({ employers, shard } = await readEmployers(file));
    } catch (error) {
      // One unreadable artifact must not throw away the other seven.
      console.error(`SKIPPED ${path.basename(file)}: ${error.message}`);
      continue;
    }

    let fileAdded = 0;
    for (const [key, entry] of Object.entries(employers)) {
      const prior = merged[key];
      if (prior && seen.has(key)) {
        collisions.push({ key, files: [seen.get(key), path.basename(file)] });
      }
      if (!prior) {
        merged[key] = entry;
        seen.set(key, path.basename(file));
        added += 1;
        fileAdded += 1;
      } else if (crawledAt(entry) > crawledAt(prior)) {
        merged[key] = entry;
        seen.set(key, path.basename(file));
        refreshed += 1;
      }
    }
    console.log(`  ${path.basename(file)}${shard ? ` (shard ${shard})` : ''}: `
      + `${Object.keys(employers).length} crawled, ${fileAdded} new`);
  }

  if (collisions.length) {
    console.warn(`\n${collisions.length} key(s) appeared in more than one shard — `
      + 'newest crawl won. Expected only if shards were re-run or resized:');
    for (const hit of collisions.slice(0, 5)) {
      console.warn(`  ${hit.key}: ${hit.files.join(' + ')}`);
    }
  }

  const withAts = Object.values(merged).filter((entry) => (entry.ats || []).length).length;
  console.log(`\n${before} → ${Object.keys(merged).length} crawled `
    + `(+${added} new, ${refreshed} refreshed) · ${withAts} with an ATS detected`);

  if (dryRun) {
    console.log('--dry-run: nothing written');
    return 0;
  }

  await fsp.writeFile(DISCOVERY_PATH, `${JSON.stringify({
    schema_version: SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    employers: merged
  }, null, 1)}\n`, 'utf8');
  console.log(`wrote ${path.relative(process.cwd(), DISCOVERY_PATH)}`);
  return 0;
}

main().then((code) => process.exit(code)).catch((error) => {
  console.error(error);
  process.exit(1);
});
