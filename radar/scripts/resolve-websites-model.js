#!/usr/bin/env node

/**
 * Ask the model for the websites Wikidata could not supply — concurrently.
 *
 * The free sweep resolved 131 of ~1,900 and was pacing at four more hours,
 * because Wikimedia's anonymous limiter allows about one request a second and
 * spends a minute punishing anything faster. The API has no such constraint,
 * so this runs many at once and finishes the whole remainder in minutes.
 *
 * The model is answering from memory, not looking anything up. For Salk or
 * Battelle that memory is excellent; for "Eagle Hill Institute" it will
 * cheerfully invent eaglehill.org and sound just as certain. A fabricated
 * domain is worse than a blank one — it fails at crawl time and looks exactly
 * like the bot-blocking we are separately trying to diagnose. So nothing is
 * saved on the model's word: every URL must fetch, and the page it returns
 * must mention the organisation.
 *
 * Usage:
 *   node radar/scripts/resolve-websites-model.js --limit 25   # sample first
 *   node radar/scripts/resolve-websites-model.js              # the rest
 */

const fsp = require('fs/promises');
const path = require('path');

const { readKey, judgeOnce, costOf, DEFAULT_MODEL } = require('./lib/openai.js');
const { verifyWebsite, UA } = require('./lib/verify-website.js');

const ROOT = path.resolve(__dirname, '../..');
const DATA_DIR = path.join(ROOT, 'radar', 'data');
const ENV_PATH = path.join(ROOT, '.env');
const RANKING_PATH = path.join(DATA_DIR, 'nonprofit-ranking.json');
const OUT_PATH = path.join(DATA_DIR, 'nonprofit-websites.json');

// The API tolerates this comfortably and it is the whole reason to be here
// rather than waiting on Wikidata.
const CONCURRENCY = 10;
const SAVE_EVERY = 40;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  /* Field order matters under constrained decoding — each field is generated
   * in sequence and conditions the next. `known` and `reasoning` come first so
   * the model commits to whether it actually recognises the organisation
   * BEFORE it produces a domain; asked the other way round, a domain appears
   * first and everything after it is written to justify what was already said. */
  properties: {
    known: { type: 'boolean', description: 'Do you actually recognise this specific organisation? False if you are unsure or would be guessing from the name.' },
    reasoning: { type: 'string', description: 'One sentence: what you know about this organisation, or why you do not recognise it.' },
    website: { type: ['string', 'null'], description: 'Official homepage URL, or null. Null is the correct answer whenever known is false.' }
  },
  required: ['known', 'reasoning', 'website']
};

const SYSTEM = `You identify the official websites of US nonprofit research organisations.

You are working from memory. You cannot browse. That makes "I don't know" the
single most valuable answer you can give: a wrong domain is worse than no
domain, because it gets recorded as fact and quietly breaks things downstream.

Set known=false and website=null whenever you would be inferring the domain
from the organisation's name rather than recalling the organisation itself.
Guessing that "Foo Research Institute" lives at fooresearch.org is exactly the
failure to avoid. Only give a URL for an organisation you genuinely recognise.`;

function userPrompt(org) {
  const bits = [`Organisation: ${org.name}`];
  if (org.state) bits.push(`State: ${org.state}`);
  if (org.ntee_cd) bits.push(`IRS NTEE code: ${org.ntee_cd}`);
  if (org.revenue_amt) bits.push(`Annual revenue: $${Math.round(org.revenue_amt / 1e6)}M`);
  if (org.uscis_approvals_3y) bits.push(`Has sponsored ${org.uscis_approvals_3y} H-1B workers in 3 years`);
  return `${bits.join('\n')}\n\nWhat is this organisation's official website?`;
}

/** Run tasks with a fixed number in flight. */
async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  }));
  return results;
}

async function main() {
  const argv = process.argv.slice(2);
  const limitArg = argv.indexOf('--limit');
  const limit = limitArg >= 0 ? Number(argv[limitArg + 1]) : null;

  const key = readKey(ENV_PATH);
  if (!key) {
    console.error('No OPENAI_API_KEY in the environment or .env — cannot run the model lookup.');
    return 1;
  }
  const model = process.env.RADAR_MATCH_MODEL || DEFAULT_MODEL;

  const ranking = JSON.parse(await fsp.readFile(RANKING_PATH, 'utf8'));
  let existing = { websites: {} };
  try { existing = JSON.parse(await fsp.readFile(OUT_PATH, 'utf8')); } catch { /* first run */ }
  const results = existing.websites || {};

  // Anything the free sweep already answered — including its rejections, which
  // were rejected on evidence — stays answered.
  let todo = ranking.organizations.filter((org) => !org.website
    && org.tier !== 'excluded' && org.tier !== 'unlikely'
    && !results[org.key]);
  if (limit) todo = todo.slice(0, limit);

  console.log(`model: ${model} · concurrency ${CONCURRENCY}`);
  console.log(`already answered: ${Object.keys(results).length} · to resolve: ${todo.length}`);
  if (!todo.length) return 0;

  let asked = 0;
  let kept = 0;
  let blocked = 0;
  let refusedToGuess = 0;
  let failedVerify = 0;
  const usageTotal = { input: 0, cached: 0, output: 0 };

  const save = async () => {
    await fsp.writeFile(OUT_PATH, `${JSON.stringify({
      schema_version: 1,
      generated_at: new Date().toISOString(),
      resolved: Object.values(results).filter((r) => r.website).length,
      websites: results
    }, null, 1)}\n`, 'utf8');
  };

  await pool(todo, CONCURRENCY, async (org) => {
    let answer = null;
    try {
      const { parsed, usage } = await judgeOnce({
        key, model, system: SYSTEM, user: userPrompt(org), schema: SCHEMA
      });
      answer = parsed;
      usageTotal.input += usage.input;
      usageTotal.cached += usage.cached;
      usageTotal.output += usage.output;
    } catch (error) {
      console.warn(`  ${org.name.slice(0, 40)}: ${String(error.message).slice(0, 80)}`);
    }

    asked += 1;
    const base = { name: org.name, ein: org.ein, tier: org.tier, source: 'model', model };

    if (!answer || !answer.known || !answer.website) {
      refusedToGuess += 1;
      results[org.key] = { ...base, website: null, verified: false,
        reason: answer ? 'model_does_not_know' : 'model_error',
        model_note: answer?.reasoning || null, resolved_at: new Date().toISOString() };
    } else {
      const check = await verifyWebsite(answer.website, org.name);
      if (check.ok) {
        kept += 1;
        if (check.blocked) blocked += 1;
        results[org.key] = { ...base, website: check.final_url || answer.website, verified: true,
          blocked: Boolean(check.blocked), matched_token: check.matched_token || null,
          verify_note: check.blocked ? check.reason : null,
          model_note: answer.reasoning || null, resolved_at: new Date().toISOString() };
      } else {
        // The model was confident and wrong. Recorded as such: this is the
        // hallucination rate, and it is worth being able to measure.
        failedVerify += 1;
        results[org.key] = { ...base, website: null, candidate_url: answer.website,
          verified: false, reason: check.reason, model_note: answer.reasoning || null,
          resolved_at: new Date().toISOString() };
      }
    }

    if (asked % SAVE_EVERY === 0) {
      await save();
      console.log(`  ${asked}/${todo.length} · ${kept} verified · ${failedVerify} hallucinated · ${refusedToGuess} declined`);
    }
    return null;
  });

  await save();
  const spend = costOf(model, usageTotal);
  console.log(`\nverified and kept: ${kept}${blocked ? ` (${blocked} live but bot-blocked)` : ''}`);
  console.log(`answered but failed verification: ${failedVerify}`);
  console.log(`model declined to guess: ${refusedToGuess}`);
  const answered = kept + failedVerify;
  if (answered) console.log(`hallucination rate among answers: ${(100 * failedVerify / answered).toFixed(1)}%`);
  console.log(`spend: $${spend.toFixed(2)}`);
  console.log(`total websites on file: ${Object.values(results).filter((r) => r.website).length}`);
  return 0;
}

main().then((code) => process.exit(code)).catch((error) => {
  console.error(error);
  process.exit(1);
});
