#!/usr/bin/env node

/**
 * Ask the web for the Taleo career-section codes the guess list could not find.
 *
 * probe-taleo-sections.js resolves a tenant in a couple of requests when the
 * code is conventional (`ext`, `staff`, `2`). It cannot resolve the rest,
 * because a career section path is whatever that university's HR office typed
 * in 2011 and is published nowhere except their own careers page. Guessing
 * wider does not converge — 33 candidate codes left 14 of 19 hosts unread.
 *
 * So: a model with web search reads the employer's careers page and reports the
 * URL it found. Measured cost is about $0.036 per employer, ~89% of which is
 * the web-search call fee rather than tokens, so this is priced per lookup and
 * not worth batching into cheaper models.
 *
 * The model PROPOSES and the live board DISPOSES: every suggested code is run
 * through the same probe used everywhere else, and only codes that actually
 * return requisitions are written out. A model that invents a plausible code
 * costs one wasted request and is never believed. (An earlier website-lookup
 * pass measured ~15% invented answers stated just as confidently as the real
 * ones — verification is the only reason any of this is safe.)
 *
 * Writes radar/data/taleo-sections-probe.json in place, adding the newly
 * resolved sections. It never edits the registry.
 *
 * Usage:
 *   node radar/scripts/resolve-taleo-codes.js [--limit N] [--dry-run]
 */

const fsp = require('fs/promises');
const path = require('path');

const { probeSection, DEFAULT_CODES } = require('./probe-taleo-sections.js');
const { readKey } = require('./lib/openai.js');

const PROBE_PATH = path.resolve(__dirname, '../data/taleo-sections-probe.json');
const ENV_PATH = path.resolve(__dirname, '../../.env');
const MODEL = process.env.RADAR_RESOLVE_MODEL || 'gpt-5.6-luna';
const WEB_SEARCH_CALL_USD = 0.01; // $10 per 1,000 calls
const PRICE_PER_1M = { input: 0.20, output: 1.20 }; // gpt-5.6-luna

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['careers_page_url', 'taleo_urls', 'section_codes', 'host_correction', 'confidence', 'notes'],
  properties: {
    // Evidence before verdict: the URLs come first so the codes are read off
    // something seen, not recalled. Field ORDER is load-bearing under
    // constrained decoding — see JUDGMENT_SCHEMA's note in judge-matches.
    careers_page_url: { type: ['string', 'null'] },
    taleo_urls: {
      type: 'array', items: { type: 'string' },
      description: 'Full Taleo URLs actually seen, e.g. https://host/careersection/CODE/jobsearch.ftl'
    },
    section_codes: {
      type: 'array', items: { type: 'string' },
      description: 'Just the CODE segment from each URL above, e.g. ext, staff, 2'
    },
    host_correction: {
      type: ['string', 'null'],
      description: 'A different taleo.net host if this employer actually uses one'
    },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    notes: { type: 'string' }
  }
};

const SYSTEM = `You find the Taleo career-section URL an employer publishes.

Taleo Enterprise job boards look like:
  https://<tenant>.taleo.net/careersection/<CODE>/jobsearch.ftl?lang=en
where <CODE> is a short path segment chosen by the employer. Real examples:
ext, ex, external, staff, faculty, 1, 2, 3, 4, cs, hourly.

Search for the employer's careers/employment/HR jobs page and read the links on
it. Report the full Taleo URLs you actually saw and the CODE segment of each.
An employer often publishes SEVERAL sections (staff and faculty are usually
separate boards holding different jobs) — list every one you find.

Report only codes taken from a URL you actually saw. Do not guess a code that
looks plausible: a wrong code is worse than none. If you cannot find one,
return empty arrays and confidence low.`;

function parseArgs(argv) {
  const args = { limit: Infinity, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--limit') args.limit = Number(argv[++i]);
    else if (argv[i] === '--dry-run') args.dryRun = true;
  }
  return args;
}

async function askForCodes(key, host, claimedBy) {
  const who = claimedBy.length ? claimedBy.join(' / ') : '(unknown — identify from the host name)';
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: MODEL,
      input: [
        { role: 'system', content: SYSTEM },
        {
          role: 'user',
          content: `Taleo host: ${host}\nBelieved to belong to: ${who}\n\n`
            + `Find the career-section URL(s) published for this Taleo tenant.`
        }
      ],
      tools: [{ type: 'web_search' }],
      text: { format: { type: 'json_schema', name: 'taleo_codes', strict: true, schema: SCHEMA } },
      reasoning: { effort: 'low' }
    })
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`openai ${response.status}: ${text.slice(0, 200)}`);
  const data = JSON.parse(text);
  const searches = (data.output || []).filter((item) => item.type === 'web_search_call').length;
  const message = (data.output || []).find((item) => item.type === 'message');
  const outputText = message?.content?.find((c) => c.type === 'output_text')?.text
    ?? data.output_text ?? '';
  let parsed = null;
  try { parsed = JSON.parse(outputText); } catch { parsed = null; }
  const usage = data.usage || {};
  const cost = ((usage.input_tokens || 0) / 1e6) * PRICE_PER_1M.input
    + ((usage.output_tokens || 0) / 1e6) * PRICE_PER_1M.output
    + searches * WEB_SEARCH_CALL_USD;
  return { parsed, searches, cost };
}

/** A host, however the model spelled it — "https://x.taleo.net/" included. */
function normalizeHost(value) {
  if (!value) return null;
  const match = /([a-z0-9-]+(?:\.[a-z0-9-]+)*\.taleo\.net)/i.exec(String(value));
  return match ? match[1].toLowerCase() : null;
}

/** Codes the model reported, plus any it embedded only in a full URL. */
function candidateCodes(parsed, host) {
  const codes = new Set((parsed?.section_codes || []).map((c) => String(c).trim()).filter(Boolean));
  const hosts = new Set([host]);
  for (const url of parsed?.taleo_urls || []) {
    const match = /([a-z0-9.-]*taleo\.net)\/careersection\/([A-Za-z0-9_.-]+)\//i.exec(url);
    if (match) {
      // A URL the model actually saw names its own host; trust that over the
      // crawl's, which is how a staging tenant (stgwehealny) gets corrected.
      hosts.add(match[1].toLowerCase());
      codes.add(match[2]);
    }
  }
  const corrected = normalizeHost(parsed?.host_correction);
  if (corrected) hosts.add(corrected);
  return { codes: [...codes], hosts: [...hosts] };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const key = readKey(ENV_PATH);
  if (!key) throw new Error('no OPENAI_API_KEY (looked in .env and the environment)');

  const probe = JSON.parse(await fsp.readFile(PROBE_PATH, 'utf8'));
  const unresolved = probe.hosts.filter((entry) => entry.status !== 'readable').slice(0, args.limit);
  console.log(`${unresolved.length} unresolved host(s); ~$${(unresolved.length * 0.036).toFixed(2)} at the measured rate\n`);

  let spend = 0;
  let resolved = 0;
  for (const entry of unresolved) {
    let answer;
    try {
      answer = await askForCodes(key, entry.host, entry.claimed_by || []);
    } catch (error) {
      console.log(`${entry.host}: lookup failed — ${error.message}`);
      continue;
    }
    spend += answer.cost;
    const { codes, hosts } = candidateCodes(answer.parsed, entry.host);
    console.log(`${entry.host}  (${answer.searches} searches, $${answer.cost.toFixed(4)})`);
    console.log(`   proposed: ${codes.length ? codes.join(', ') : '(none)'} `
      + `conf=${answer.parsed?.confidence}`);
    if (answer.parsed?.host_correction && answer.parsed.host_correction !== entry.host) {
      console.log(`   host correction: ${answer.parsed.host_correction}`);
    }
    entry.web_lookup = {
      model: MODEL,
      searches: answer.searches,
      proposed_codes: codes,
      careers_page_url: answer.parsed?.careers_page_url || null,
      confidence: answer.parsed?.confidence || null,
      notes: answer.parsed?.notes || ''
    };
    // A corrected host is worth the standard guess list even when the model
    // found no code — those probes are free, and the original host was often
    // only unreadable because it was a staging tenant that no longer exists.
    const newHosts = hosts.filter((host) => host !== entry.host);
    const codesToTry = codes.length ? codes : (newHosts.length ? DEFAULT_CODES : []);
    if (args.dryRun || !codesToTry.length) continue;

    // Verify against the live board. Only what answers with requisitions counts.
    const sections = [];
    const seenPortals = new Set();
    for (const host of hosts) {
      for (const code of codesToTry) {
        let section = null;
        try {
          section = await probeSection(host, code);
        } catch (error) {
          continue;
        }
        if (section && !seenPortals.has(section.portal)) {
          seenPortals.add(section.portal);
          sections.push({ ...section, host });
        }
      }
    }
    if (sections.length) {
      resolved += 1;
      const host = sections[0].host;
      entry.host = host;
      entry.sections = sections.map(({ host: _h, ...rest }) => rest);
      entry.total_requisitions = sections.reduce((sum, s) => sum + s.total, 0);
      entry.status = 'readable';
      entry.suggested_ats_config = {
        host,
        sections: entry.sections.map(({ code, portal }) => ({ code, portal }))
      };
      console.log(`   VERIFIED: ${entry.sections.map((s) => `${s.code}(${s.total})`).join(' ')}`);
    } else {
      entry.status = 'no_section_found';
      console.log('   none of the proposed codes returned postings — not believed');
    }
  }

  const readable = probe.hosts.filter((entry) => entry.status === 'readable');
  probe.generated_at = new Date().toISOString();
  probe.hosts_readable = readable.length;
  probe.total_requisitions = readable.reduce((sum, entry) => sum + entry.total_requisitions, 0);
  if (!args.dryRun) {
    await fsp.writeFile(PROBE_PATH, `${JSON.stringify(probe, null, 2)}\n`);
  }

  console.log(`\nResolved ${resolved} more host(s) for $${spend.toFixed(2)}`);
  console.log(`${readable.length} of ${probe.hosts.length} hosts readable, `
    + `${probe.total_requisitions} requisitions`);
  console.log(args.dryRun ? '(dry run — nothing written)' : `Updated ${path.relative(process.cwd(), PROBE_PATH)}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { candidateCodes, askForCodes };
