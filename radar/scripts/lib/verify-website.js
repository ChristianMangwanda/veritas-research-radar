'use strict';

/**
 * Prove a candidate URL belongs to the organisation it was returned for.
 *
 * Shared by both resolvers, because the rule has to be identical whichever
 * source proposed the address — Wikidata is occasionally wrong and a model
 * asked from memory is confidently wrong, and neither gets to write to the
 * directory on its own say-so.
 *
 * Three outcomes, and the distinction between them is the whole point:
 *
 *   ok                  the page loaded and mentions the organisation
 *   ok + blocked        a real server refused us (403/429/406)
 *   not ok              dead, or it loaded and belongs to somebody else
 *
 * The middle case is the one that took a wrong turn first. An early version
 * rejected battelle.org and openai.com on 403 — both correct addresses that
 * defend themselves against automated clients. A fabricated domain fails at
 * DNS or connection; only a real site refuses you deliberately. Discarding
 * those meant discarding exactly the large, well-defended research employers
 * most worth having.
 */

const UA = 'veritas-research-radar/1.0 (personal research job search; contact via github.com/ChristianMangwanda/veritas-research-radar)';
const VERIFY_TIMEOUT_MS = 15000;

/* Corporate noise carrying no identifying information, stripped before
 * comparing a name to page text. */
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

async function verifyWebsite(url, name, { timeoutMs = VERIFY_TIMEOUT_MS } = {}) {
  if (!url || !/^https?:\/\//i.test(url)) return { ok: false, reason: 'not_a_url' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': UA, accept: 'text/html,*/*' },
      redirect: 'follow',
      signal: controller.signal
    });
    if (response.status === 403 || response.status === 429 || response.status === 406) {
      return { ok: true, blocked: true, reason: `http_${response.status}`, final_url: response.url };
    }
    if (!response.ok) return { ok: false, reason: `http_${response.status}` };
    const body = (await response.text()).slice(0, 200000).toLowerCase();
    // The hostname counts as evidence too, and is the strongest kind: an
    // organisation's own name in its own domain is hard to arrive at by
    // accident (jax.org for Jackson Laboratory, salk.edu for Salk).
    const haystack = `${response.url.toLowerCase()} ${body}`;
    const wanted = tokens(name);
    const hits = wanted.filter((word) => haystack.includes(word));

    /* Two matches, not one.
     *
     * A single token was enough in the first version, and salk.edu duly
     * verified as the home of the MAINE STATE POMOLOGICAL SOCIETY — because
     * the word "state" appears somewhere on Salk's page. Institutional English
     * is full of words like state, health, research, center and science, so
     * any one of them matching says nothing at all. Requiring two independent
     * words costs almost no correct answers (an organisation's own site nearly
     * always carries at least two words of its own name, and the domain
     * counts) and removes the whole class of coincidental matches.
     *
     * A name that reduces to one distinctive word keeps the single-hit rule —
     * there is nothing else to ask of it. */
    const needed = wanted.length >= 2 ? 2 : 1;
    if (hits.length < needed) {
      return {
        ok: false,
        reason: hits.length ? 'only_generic_token_matched' : 'page_does_not_mention_org',
        matched_tokens: hits,
        final_url: response.url
      };
    }
    return { ok: true, blocked: false, matched_token: hits.slice(0, 3).join('+'), final_url: response.url };
  } catch (error) {
    // DNS failure and connection refusal both land here — the signature of a
    // domain that does not exist, which is what a hallucination looks like.
    return { ok: false, reason: `fetch_failed: ${error.name}` };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { verifyWebsite, tokens, NOISE, UA };
