#!/usr/bin/env node

/**
 * Find websites for the ranked nonprofits, cheapest source first.
 *
 * 14,340 of the 14,414 cap-exempt nonprofits have no website on file, which is
 * the only thing standing between them and the ATS crawl. score-nonprofits.js
 * cut that to a lookup pool of ~1,900 plausible research employers; this
 * resolves their addresses.
 *
 * Stage 1 (here): Wikidata. Free, no key, and it holds the official website
 * (property P856) for exactly the kind of organisation we care about — Salk,
 * Wistar, Boyce Thompson all resolve. Whatever it misses goes to a paid model
 * lookup afterwards, on a much smaller bill.
 *
 * EVERY result is verified before it is kept. A resolver that returns a
 * plausible-looking domain for an organisation it knows nothing about poisons
 * the directory silently: the crawl then fails on it and looks exactly like
 * the bot-blocking we are already trying to diagnose. So a candidate URL must
 * fetch, and the page it returns must actually mention the organisation.
 *
 * Usage:
 *   node radar/scripts/find-nonprofit-websites.js --limit 25   # sample
 *   node radar/scripts/find-nonprofit-websites.js              # the whole pool
 *   node radar/scripts/find-nonprofit-websites.js --tier proven
 */

const fsp = require('fs/promises');
const path = require('path');

const DATA_DIR = path.resolve(__dirname, '../data');
const RANKING_PATH = path.join(DATA_DIR, 'nonprofit-ranking.json');
const OUT_PATH = path.join(DATA_DIR, 'nonprofit-websites.json');

const UA = 'veritas-research-radar/1.0 (personal research job search; contact via github.com/ChristianMangwanda/veritas-research-radar)';
const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';

/* Wikimedia's anonymous rate limit is real and I hit it: a 250ms gap (4/sec)
 * over 25 lookups drew "You are making too many requests to the API". Their
 * guidance for unauthenticated use is about one request a second, so that is
 * what this does. 1,900 organisations is then ~35 minutes, which is free and
 * unattended and therefore fine. */
const REQUEST_GAP_MS = 1100;
const RATE_LIMIT_BACKOFF_MS = 60000;
const FETCH_TIMEOUT_MS = 12000;
const VERIFY_TIMEOUT_MS = 15000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* Corporate noise that carries no identifying information. Stripped before
 * comparing a Wikidata label to an IRS legal name, which are rarely written
 * the same way ("JACKSON LABORATORY" vs "Jackson Laboratory"). */
const NOISE = new Set([
  'the', 'inc', 'incorporated', 'corp', 'corporation', 'llc', 'ltd', 'co',
  'company', 'foundation', 'trust', 'fund', 'association', 'society',
  'organization', 'organisation', 'of', 'for', 'and', 'a', 'an', 'usa', 'us',
  'america', 'american', 'national', 'international'
]);

function tokens(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word && word.length > 2 && !NOISE.has(word));
}

/**
 * Does this Wikidata hit plausibly denote the organisation we asked about?
 *
 * wbsearchentities is a fuzzy search and will happily return SOMETHING for
 * every query. Without this guard, an obscure institute silently acquires the
 * website of whatever shared a word with it.
 */
function labelMatches(queryName, label) {
  const wanted = tokens(queryName);
  const got = new Set(tokens(label));
  if (!wanted.length || !got.size) return false;
  const overlap = wanted.filter((word) => got.has(word)).length;
  const shorter = Math.min(wanted.length, got.size);

  /* Every distinctive word of the shorter name must appear in the longer one:
   * "Wistar Institute" vs "The Wistar Institute of Anatomy and Biology" passes.
   *
   * The single-token case needs its own rule. "Maine Cancer Foundation" against
   * "American Cancer Society" reduces to ['maine','cancer'] vs ['cancer'] once
   * the corporate noise is stripped — one shared word, one word on the shorter
   * side, and a bare "covers the shorter name" test calls that a match. So a
   * lone token only counts when BOTH sides are that single token; otherwise a
   * generic word like "cancer" or "research" hands an organisation somebody
   * else's homepage. */
  if (shorter === 1) return overlap === 1 && wanted.length === 1 && got.size === 1;
  return overlap >= shorter;
}

/* Rate limiting must never look like a negative result.
 *
 * This returned null for any non-OK response, so a 429 was indistinguishable
 * from "this organisation has no Wikidata entry" — a sample run reported 9
 * entity matches and 0 websites, which read as a disappointing hit rate and
 * was actually the API refusing to talk to me. Wrong answers that look like
 * data are worse than errors.
 */
async function getJson(url, timeoutMs = FETCH_TIMEOUT_MS, attempt = 0) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers: { 'user-agent': UA }, signal: controller.signal });
    if (response.status === 429 || response.status === 403) {
      if (attempt >= 3) throw new Error(`rate limited by Wikidata after ${attempt} retries — stopping rather than reporting empty results`);
      const wait = RATE_LIMIT_BACKOFF_MS * (attempt + 1);
      console.warn(`  rate limited (HTTP ${response.status}); backing off ${wait / 1000}s`);
      await sleep(wait);
      return getJson(url, timeoutMs, attempt + 1);
    }
    if (!response.ok) return null;
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      // HTML where JSON was promised is what an error page looks like.
      throw new Error(`Wikidata returned non-JSON (${text.slice(0, 80).replace(/\s+/g, ' ')})`);
    }
  } catch (error) {
    if (error.name === 'AbortError') return null;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function wikidataSearch(name) {
  const url = `${WIKIDATA_API}?action=wbsearchentities&search=${encodeURIComponent(name)}`
    + '&language=en&uselang=en&type=item&limit=5&format=json';
  const data = await getJson(url);
  const hits = data?.search || [];
  for (const hit of hits) {
    // Match against the label AND the description: IRS legal names often carry
    // words ("institute of anatomy and biology") that only appear in one.
    if (labelMatches(name, `${hit.label || ''} ${hit.description || ''}`)
      || labelMatches(name, hit.label || '')) {
      return { id: hit.id, label: hit.label, description: hit.description };
    }
  }
  return null;
}

/** P856 is "official website". Batched 50 ids per call — the API allows it and
 *  it turns 1,900 round trips into ~40. */
async function wikidataWebsites(ids) {
  const found = new Map();
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const url = `${WIKIDATA_API}?action=wbgetentities&ids=${batch.join('|')}`
      + '&props=claims&format=json';
    const data = await getJson(url, 25000);
    for (const [qid, entity] of Object.entries(data?.entities || {})) {
      const claims = entity?.claims?.P856 || [];
      const value = claims[0]?.mainsnak?.datavalue?.value;
      if (typeof value === 'string' && /^https?:\/\//i.test(value)) found.set(qid, value);
    }
    await sleep(REQUEST_GAP_MS);
  }
  return found;
}

/**
 * Prove the URL belongs to this organisation.
 *
 * Two failure modes to separate: a URL that does not resolve (dead), and one
 * that resolves to somebody else (wrong). The second is the dangerous one,
 * because it looks like success everywhere downstream.
 */
async function verify(url, name) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': UA, accept: 'text/html,*/*' },
      redirect: 'follow',
      signal: controller.signal
    });
    /* A 403 is not a wrong answer — it is a live server refusing us.
     *
     * The first run rejected battelle.org and openai.com on 403. Both are the
     * correct addresses; both defend themselves against automated clients. A
     * hallucinated domain fails at DNS or connection, never with a considered
     * "no" from a real web server, so treating a refusal as a bad URL discards
     * exactly the large, well-defended research employers most worth having.
     *
     * Kept, and flagged: the ATS crawl already has a blocked-site problem to
     * solve, and this tells it which addresses it will need help reaching
     * rather than pretending they do not exist. */
    if (response.status === 403 || response.status === 429 || response.status === 406) {
      return { ok: true, blocked: true, reason: `http_${response.status}`, final_url: response.url };
    }
    if (!response.ok) return { ok: false, reason: `http_${response.status}` };
    const html = (await response.text()).slice(0, 200000).toLowerCase();
    const wanted = tokens(name);
    // One distinctive word is enough — organisations rarely print their full
    // IRS legal name, and demanding all of them would reject correct answers.
    const hit = wanted.find((word) => html.includes(word));
    if (!hit) return { ok: false, reason: 'page_does_not_mention_org', final_url: response.url };
    return { ok: true, matched_token: hit, final_url: response.url };
  } catch (error) {
    return { ok: false, reason: `fetch_failed: ${error.name}` };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const limitArg = argv.indexOf('--limit');
  const limit = limitArg >= 0 ? Number(argv[limitArg + 1]) : null;
  const tierArg = argv.indexOf('--tier');
  const onlyTier = tierArg >= 0 ? argv[tierArg + 1] : null;

  const ranking = JSON.parse(await fsp.readFile(RANKING_PATH, 'utf8'));
  let pool = ranking.organizations.filter((org) => !org.website
    && org.tier !== 'excluded' && org.tier !== 'unlikely');
  if (onlyTier) pool = pool.filter((org) => org.tier === onlyTier);
  if (limit) pool = pool.slice(0, limit);

  // Resume: never re-ask about something already answered.
  let previous = { websites: {} };
  try { previous = JSON.parse(await fsp.readFile(OUT_PATH, 'utf8')); } catch { /* first run */ }
  const results = previous.websites || {};
  const todo = pool.filter((org) => !results[org.key]);

  console.log(`pool: ${pool.length} · already resolved: ${pool.length - todo.length} · to look up: ${todo.length}`);
  if (!todo.length) return 0;

  /* Batched, and saved after every batch.
   *
   * This ran as three sequential phases — search all 1,900, then fetch all
   * websites, then verify all of them — and wrote the file once at the very
   * end. That is a three-hour run with a single point of total loss, which is
   * the same mistake the ATS crawler had and the same fix: checkpoint often
   * enough that a crash costs minutes. Interleaving the phases per batch also
   * means partial progress is genuinely usable rather than a heap of entity
   * ids with no websites attached.
   */
  const BATCH = 25;
  let kept = 0;
  let rejected = 0;
  let blocked = 0;
  let searched = 0;

  const save = async () => {
    await fsp.writeFile(OUT_PATH, `${JSON.stringify({
      schema_version: 1,
      generated_at: new Date().toISOString(),
      resolved: Object.values(results).filter((r) => r.website).length,
      websites: results
    }, null, 1)}\n`, 'utf8');
  };

  for (let offset = 0; offset < todo.length; offset += BATCH) {
    const batch = todo.slice(offset, offset + BATCH);

    const matched = [];
    for (const org of batch) {
      const hit = await wikidataSearch(org.name);
      if (hit) matched.push({ org, hit });
      searched += 1;
      await sleep(REQUEST_GAP_MS);
    }

    const sites = await wikidataWebsites(matched.map((m) => m.hit.id));

    for (const { org, hit } of matched) {
      const url = sites.get(hit.id);
      if (!url) continue;
      const check = await verify(url, org.name);
      if (check.ok) {
        kept += 1;
        if (check.blocked) blocked += 1;
        results[org.key] = {
          name: org.name, ein: org.ein, tier: org.tier,
          website: check.final_url || url,
          source: 'wikidata', wikidata_id: hit.id,
          verified: true,
          blocked: Boolean(check.blocked),
          matched_token: check.matched_token || null,
          verify_note: check.blocked ? check.reason : null,
          resolved_at: new Date().toISOString()
        };
      } else {
        rejected += 1;
        results[org.key] = {
          name: org.name, ein: org.ein, tier: org.tier,
          website: null, candidate_url: url,
          source: 'wikidata', wikidata_id: hit.id,
          verified: false, reason: check.reason,
          resolved_at: new Date().toISOString()
        };
      }
      await sleep(REQUEST_GAP_MS);
    }

    await save();
    console.log(`  ${searched}/${todo.length} searched · ${kept} kept (${blocked} blocked) · ${rejected} rejected`);
  }

  const unresolved = todo.length - kept - rejected;
  console.log(`\nverified and kept: ${kept}${blocked ? ` (${blocked} live but bot-blocked — will need an unblocker)` : ''}`);
  console.log(`found but failed verification: ${rejected}`);
  console.log(`no Wikidata answer (-> model lookup): ${unresolved}`);

  await save();
  console.log(`wrote ${path.relative(process.cwd(), OUT_PATH)}`);
  return 0;
}

main().then((code) => process.exit(code)).catch((error) => {
  console.error(error);
  process.exit(1);
});
