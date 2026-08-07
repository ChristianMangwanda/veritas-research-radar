#!/usr/bin/env node

/**
 * Carry the laptop's private state into Supabase, once.
 *
 * Three things move: the profile document, the judgments already bought from
 * the model, and the triage state. The judgments are the reason this script
 * exists rather than being a nice-to-have — there are thousands of them and
 * every one cost money at the API. Losing them to the migration would mean
 * paying for the same answers twice.
 *
 * The cache is keyed `1:<jobHash>:<profileHash>:<prefsHash>` and holds three
 * generations of that key. Only the current one is importable:
 *
 *   ...:fnv1a:6dffd8d0:in-profile   the live regime — profile.md, gpt-5.6-luna
 *   ...:fnv1a:cae25871:0ab9086e     judged by a local qwen against the old
 *   ...:fnv1a:cae25871:0d97e33b     résumé-derived profile.json, with the
 *                                   preferences that lived in preferences.json
 *
 * The older two are not skipped for being old. They are skipped because their
 * profile hash is not the current one, so nothing would ever read them back:
 * the dashboard queries match_cache by the hash of the profile it just parsed.
 * Importing them would put unreadable rows in the table and make the count lie.
 *
 * Idempotent — every write is an upsert, so re-running after a failure is safe
 * and re-running after more judging picks up the new entries.
 *
 * Usage:
 *   SUPABASE_URL=… SUPABASE_SERVICE_KEY=… node radar/scripts/seed-supabase.js [--dry-run]
 */

const fsp = require('fs/promises');
const path = require('path');

const { loadEnvFile } = require('./lib/env-file.js');
const { supabaseEnv } = require('./lib/supabase.js');

// Run by hand, so read .env — explicitly, rather than having lib/supabase.js
// do it for every script including the one that deletes rows.
loadEnvFile();
const { parseProfileDocument } = require('../public/profile-doc.js');
const RadarScoring = require('../public/scoring.js');

const DATA_DIR = path.resolve(__dirname, '../data');
const PROFILE_PATH = path.join(DATA_DIR, 'profile.md');
const MATCH_CACHE_PATH = path.join(DATA_DIR, 'match-cache.json');
const LOCAL_STATE_PATH = path.join(DATA_DIR, 'local-state.json');

const BATCH_SIZE = 500;

/**
 * Split a cache key back into the two hashes the table is keyed on.
 *
 * Returns null for anything that is not a current-regime key, which is how the
 * legacy generations are dropped. Pure, so the shapes are pinned by tests
 * rather than by running the migration and looking at what landed.
 */
function parseCacheKey(key) {
  const parts = String(key || '').split(':');
  // 1 : fnv1a : xxxxxxxx : fnv1a : yyyyyyyy : in-profile
  if (parts.length !== 6) return null;
  if (parts[0] !== '1') return null;
  if (parts[1] !== 'fnv1a' || parts[3] !== 'fnv1a') return null;
  // Preferences folded into the profile document; anything else is a hash from
  // the deleted preferences.json era and belongs to a profile that no longer
  // exists.
  if (parts[5] !== 'in-profile') return null;
  return { job_hash: `${parts[1]}:${parts[2]}`, profile_hash: `${parts[3]}:${parts[4]}` };
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function makeClient({ url, key }) {
  const request = async (method, pathname, { body, headers = {} } = {}) => {
    const response = await fetch(`${url}/rest/v1${pathname}`, {
      method,
      headers: {
        apikey: key,
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        ...headers
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${pathname} → ${response.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  };
  const upsert = (table, rows, onConflict) => request('POST', `/${table}?on_conflict=${onConflict}`, {
    body: rows,
    headers: { prefer: 'resolution=merge-duplicates,return=minimal' }
  });
  return { request, upsert };
}

/** The one user. Asserted rather than assumed — every row below hangs off it. */
async function resolveUserId(url, key) {
  const response = await fetch(`${url}/auth/v1/admin/users`, {
    headers: { apikey: key, authorization: `Bearer ${key}` }
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`admin/users → ${response.status}: ${text.slice(0, 200)}`);
  const users = JSON.parse(text).users || [];
  if (users.length === 0) {
    throw new Error('No user exists yet — create one in Authentication → Users before seeding.');
  }
  if (users.length > 1) {
    throw new Error(`Expected exactly one user, found ${users.length}. This project assumes a single owner.`);
  }
  return users[0].id;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const env = supabaseEnv();
  if (!env) {
    console.error('SUPABASE_URL and SUPABASE_SERVICE_KEY must both be set.');
    return 1;
  }
  const client = makeClient(env);

  const userId = dryRun ? '(dry-run)' : await resolveUserId(env.url, env.key);
  console.log(`user: ${userId}${dryRun ? '' : ''}`);

  /* ---- profile document ---------------------------------------------- */
  const profileText = await fsp.readFile(PROFILE_PATH, 'utf8').catch(() => null);
  if (!profileText) {
    console.error(`No profile at ${path.relative(process.cwd(), PROFILE_PATH)} — nothing to seed.`);
    return 1;
  }
  const profile = parseProfileDocument(profileText);
  const invalid = RadarScoring.validateProfile(profile);
  if (invalid) {
    console.error(`profile.md does not validate: ${invalid}`);
    return 1;
  }
  const currentHash = RadarScoring.profileHash(profile);
  console.log(`profile: ${profileText.length} bytes, hash ${currentHash}`);

  /* ---- judgments ------------------------------------------------------ */
  const cache = await readJson(MATCH_CACHE_PATH, { entries: {} });
  const entries = Object.entries(cache.entries || {});
  const rows = [];
  const skipped = new Map();
  for (const [key, value] of entries) {
    const parsed = parseCacheKey(key);
    if (!parsed) {
      const suffix = String(key).split(':').slice(3).join(':') || '(unparseable)';
      skipped.set(suffix, (skipped.get(suffix) || 0) + 1);
      continue;
    }
    rows.push({
      job_hash: parsed.job_hash,
      profile_hash: parsed.profile_hash,
      job_id: null,
      verdict: value.verdict,
      different_profession: value.different_profession,
      meets_requirements: value.meets_requirements,
      matches_preferences: value.matches_preferences,
      role_summary: value.role_summary ?? null,
      reasons: Array.isArray(value.reasons) ? value.reasons : [],
      gaps: Array.isArray(value.gaps) ? value.gaps : [],
      judged_at: value.judged_at,
      model: value.model ?? null
    });
  }

  const importable = new Set(rows.map((row) => row.profile_hash));
  if (rows.length && !importable.has(currentHash)) {
    // Not fatal: the rows are still worth storing, and re-judging will fill the
    // current hash. But the dashboard will look empty until it does, and that
    // is worth saying out loud rather than discovering in the UI.
    console.warn(`WARNING: profile.md hashes to ${currentHash}, which appears in NONE of the`);
    console.warn(`         imported judgments (${[...importable].join(', ')}). They will not be read`);
    console.warn('         back until the document is restored or the postings are re-judged.');
  }
  console.log(`judgments: ${rows.length} importable of ${entries.length}`);
  for (const [suffix, count] of skipped) {
    console.log(`  skipped ${count} keyed ${suffix} — a profile generation nothing reads`);
  }

  /* ---- triage ---------------------------------------------------------- */
  const localState = await readJson(LOCAL_STATE_PATH, { triage: {}, ignored_employers: [] });
  const triageRows = Object.entries(localState.triage || {}).map(([jobId, record]) => ({
    job_id: jobId,
    status: record.status,
    note: record.note ?? null,
    applied_at: record.applied_at ?? null,
    variant_sent: record.variant_sent ?? null,
    // Preserved verbatim, never restamped: last-write-wins merges compare this,
    // so restamping would make every imported row beat anything newer.
    updated_at: record.updated_at
  }));
  const ignored = Array.isArray(localState.ignored_employers) ? localState.ignored_employers : [];
  console.log(`triage: ${triageRows.length} rows, ${ignored.length} ignored employers`);

  if (dryRun) {
    console.log('\nDry run — nothing written.');
    return 0;
  }

  /* ---- write ----------------------------------------------------------- */
  await client.upsert('profile_documents', [{
    user_id: userId, content: profileText, updated_at: new Date().toISOString()
  }], 'user_id');
  console.log('wrote profile_documents');

  for (let at = 0; at < rows.length; at += BATCH_SIZE) {
    const batch = rows.slice(at, at + BATCH_SIZE);
    await client.upsert('match_cache', batch, 'job_hash,profile_hash');
    console.log(`  match_cache ${Math.min(at + BATCH_SIZE, rows.length)}/${rows.length}`);
  }

  if (triageRows.length) {
    await client.upsert('triage', triageRows, 'job_id');
    console.log('wrote triage');
  }
  await client.upsert('user_state', [{
    user_id: userId, ignored_employers: ignored, updated_at: new Date().toISOString()
  }], 'user_id');
  console.log('wrote user_state');

  console.log('\nSeeded. Re-running is safe — every write is an upsert.');
  return 0;
}

if (require.main === module) {
  main().then((code) => process.exit(code)).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { parseCacheKey };
