'use strict';

/**
 * The judge runs on OpenAI now. No local model, no fallback.
 *
 * Why: a local qwen2.5:14b took 20 seconds per posting — 54 hours to read the
 * pool once, and the whole lot thrown away whenever the profile changed. The
 * same work through the API is minutes and a few dollars, which is what makes
 * a lenient funnel affordable: the deterministic layer can stop guessing which
 * jobs are "your line of work" and reject only what is quotably impossible.
 *
 * Model choice was measured, not assumed. Re-judging 789 postings the local
 * 14b had already read:
 *   gpt-5-nano    75% agreement, buried 32 jobs the 14b called a strong match
 *   gpt-5-mini    77% agreement, buried 1
 *   gpt-5.6-luna  63% agreement, buried 0 — and is cheaper than mini
 * The agreement column is a decoy: nano and mini score almost the same and
 * fail in opposite directions. Only "buries a strong match" matters, because
 * a hidden job produces no error and no complaint.
 */

const DEFAULT_MODEL = process.env.RADAR_MATCH_MODEL || 'gpt-5.6-luna';
const ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const MAX_ATTEMPTS = 6;

/** The key lives in .env (gitignored — this repo is public) or the
 *  environment. Read lazily so the server starts without one and simply
 *  reports that judging is unavailable. */
function readKey(envPath) {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  try {
    const text = require('fs').readFileSync(envPath, 'utf8');
    const match = /^\s*OPENAI_API_KEY\s*=\s*["']?(\S+?)["']?\s*$/m.exec(text);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/* Reasoning effort is the difference between a classification call and an
 * essay. The vocabulary moved between model generations — gpt-5-mini/nano take
 * 'minimal', gpt-5.6-* reject it and want 'none' — and getting it wrong is a
 * 400, not a silent slowdown. */
function effortFor(model) {
  if (/^gpt-5\.[3-9]/.test(model)) return 'none';
  if (/^gpt-5/.test(model)) return 'minimal';
  return null;
}

function isRetryable(status) {
  return status === 429 || status === 408 || status >= 500;
}

/**
 * A 429 is a statement about the whole key, not about one request, so the
 * backoff belongs to the process rather than to the caller that happened to
 * receive it. Six workers each retrying privately turn one rate limit into six
 * retry ladders climbing in step, and the jitter (300ms against waits measured
 * in seconds) is far too small to spread them apart.
 *
 * Every attempt waits on the shared deadline before it fetches, so one 429
 * pauses the fleet. `pausedUntil` only ever moves forward: a later 429 with a
 * shorter Retry-After must not shorten a pause somebody else already earned.
 */
let pausedUntil = 0;

function noteRateLimit(waitMs) {
  pausedUntil = Math.max(pausedUntil, Date.now() + waitMs);
}

async function awaitCooldown() {
  const remaining = pausedUntil - Date.now();
  if (remaining <= 0) return;
  // Jitter is a full second here, not 300ms: the point is to stagger the
  // workers as they wake, and they all wake from the same deadline.
  await new Promise((resolve) => setTimeout(resolve, remaining + Math.floor(Math.random() * 1000)));
}

/** Tests only — the cooldown is module state and would leak between cases. */
function _resetCooldown() {
  pausedUntil = 0;
}

/**
 * One judgment. Returns the parsed object, or null when the model refused or
 * produced something unparseable — the caller decides what an absent judgment
 * means, which is never "no".
 */
async function judgeOnce({ key, model = DEFAULT_MODEL, system, user, schema, signal }) {
  const body = {
    model,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    response_format: { type: 'json_schema', json_schema: { name: 'judgment', strict: true, schema } },
    max_completion_tokens: 2000
  };
  const effort = effortFor(model);
  if (effort) body.reasoning_effort = effort;
  else body.temperature = 0;

  let response;
  for (let attempt = 0; ; attempt += 1) {
    await awaitCooldown();
    response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal
    });
    if (!isRetryable(response.status) || attempt >= MAX_ATTEMPTS) break;
    // 429s are routine at any useful concurrency. Dropping them instead of
    // waiting silently biases the results toward whatever got through.
    const retryAfter = Number(response.headers.get('retry-after')) * 1000;
    const wait = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter
      : Math.min(20000, 500 * 2 ** attempt) + Math.floor(Math.random() * 300);
    // A rate limit pauses everyone (the loop top waits on it); 408s and 5xx are
    // about this one request, so they wait alone.
    if (response.status === 429) noteRateLimit(wait);
    else await new Promise((resolve) => setTimeout(resolve, wait));
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`openai ${response.status}: ${detail.slice(0, 200)}`);
  }
  const data = await response.json();
  const usage = data.usage || {};
  let parsed = null;
  try { parsed = JSON.parse(data.choices?.[0]?.message?.content ?? ''); } catch { parsed = null; }
  return {
    parsed,
    usage: {
      input: usage.prompt_tokens || 0,
      cached: usage.prompt_tokens_details?.cached_tokens || 0,
      output: usage.completion_tokens || 0
    }
  };
}

// Published prices per 1M tokens, so the server can report what a run cost
// rather than leaving it to be discovered on a bill.
const PRICES = {
  'gpt-5.6-luna': { input: 0.20, cached: 0.02, output: 1.20 },
  'gpt-5-mini': { input: 0.25, cached: 0.025, output: 2.00 },
  'gpt-5-nano': { input: 0.05, cached: 0.005, output: 0.40 },
  'gpt-4o-mini': { input: 0.15, cached: 0.075, output: 0.60 }
};

const unpricedWarned = new Set();

function costOf(model, usage) {
  const price = PRICES[model];
  // An unpriced model reports every run as free, which silently disables
  // --max-spend. Say so once rather than discovering it on a bill.
  if (!price && !unpricedWarned.has(model)) {
    unpricedWarned.add(model);
    console.warn(`No published price for model "${model}" — spend will report as $0 and --max-spend cannot bind.`);
  }
  if (!price) return 0;
  return ((usage.input - usage.cached) / 1e6) * price.input
    + (usage.cached / 1e6) * price.cached
    + (usage.output / 1e6) * price.output;
}

module.exports = {
  DEFAULT_MODEL, readKey, judgeOnce, costOf, PRICES,
  noteRateLimit, awaitCooldown, _resetCooldown
};
