/**
 * Entity resolution for employer names across government datasets
 * (DOL LCA, IRS EO BMF, IPEDS, USCIS) and the curated registry.
 *
 * Matching is confidence-ordered. Strategies 1-3 are O(1) Map lookups and are
 * safe to run against millions of rows; containment/overlap scan the entry
 * list and are intended for registry-scale inputs only.
 */

const STOPWORDS = new Set(['OF', 'AND', 'AT', 'IN', 'FOR']);
const LEGAL_SUFFIXES = /\b(THE|INC|INCORPORATED|LLC|LLP|LP|LTD|CORP|CORPORATION|CO|COMPANY|PC|PLLC)\b/g;

function normalizeName(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/&/g, ' AND ')
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(LEGAL_SUFFIXES, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function significantTokens(value) {
  return normalizeName(value)
    .split(' ')
    .filter((token) => token && !STOPWORDS.has(token));
}

function isContiguousSubsequence(shorter, longer) {
  if (shorter.length === 0 || shorter.length > longer.length) return false;
  for (let start = 0; start <= longer.length - shorter.length; start += 1) {
    let matches = true;
    for (let i = 0; i < shorter.length; i += 1) {
      if (longer[start + i] !== shorter[i]) {
        matches = false;
        break;
      }
    }
    if (matches) return true;
  }
  return false;
}

/**
 * Builds a resolver over registry-style entries [{id, name, aliases?}].
 * resolve(rawName) -> { matched: entry|null, confidence, strategy, normalized }
 */
function createResolver(entries, options = {}) {
  const { containmentMinTokens = 2, overlapThreshold = 0.8 } = options;

  const exactByName = new Map();
  const exactByAlias = new Map();
  const byTokenSetKey = new Map();
  const prepared = [];

  for (const entry of entries) {
    const normalized = normalizeName(entry.name);
    const tokens = significantTokens(entry.name);
    if (normalized && !exactByName.has(normalized)) exactByName.set(normalized, entry);
    const tokenKey = [...tokens].sort().join(' ');
    if (tokenKey && !byTokenSetKey.has(tokenKey)) byTokenSetKey.set(tokenKey, entry);
    for (const alias of entry.aliases || []) {
      const normalizedAlias = normalizeName(alias);
      if (normalizedAlias && !exactByAlias.has(normalizedAlias)) exactByAlias.set(normalizedAlias, entry);
      const aliasKey = significantTokens(alias).sort().join(' ');
      if (aliasKey && !byTokenSetKey.has(aliasKey)) byTokenSetKey.set(aliasKey, entry);
    }
    prepared.push({ entry, tokens, tokenSet: new Set(tokens) });
  }

  function resolve(rawName) {
    const normalized = normalizeName(rawName);
    const miss = { matched: null, confidence: 0, strategy: null, normalized };
    if (!normalized) return miss;

    const exactHit = exactByName.get(normalized);
    if (exactHit) return { matched: exactHit, confidence: 1.0, strategy: 'exact', normalized };

    const aliasHit = exactByAlias.get(normalized);
    if (aliasHit) return { matched: aliasHit, confidence: 0.95, strategy: 'alias', normalized };

    const rawTokens = normalized.split(' ').filter((token) => token && !STOPWORDS.has(token));
    const tokenSetHit = byTokenSetKey.get([...rawTokens].sort().join(' '));
    if (tokenSetHit) return { matched: tokenSetHit, confidence: 0.9, strategy: 'token_set', normalized };

    // Containment: shorter name's tokens appear contiguously inside the longer's.
    // The min-token guard keeps single shared words (COLUMBIA) from matching.
    for (const { entry, tokens } of prepared) {
      const [shorter, longer] = tokens.length <= rawTokens.length
        ? [tokens, rawTokens]
        : [rawTokens, tokens];
      if (shorter.length >= containmentMinTokens && isContiguousSubsequence(shorter, longer)) {
        return { matched: entry, confidence: 0.75, strategy: 'containment', normalized };
      }
    }

    // Token overlap: near-identical token sets with insertions ("...Cancer
    // RESEARCH Center"). Low confidence — callers treat these as alias hints.
    const rawSet = new Set(rawTokens);
    for (const { entry, tokenSet } of prepared) {
      const smaller = rawSet.size <= tokenSet.size ? rawSet : tokenSet;
      const larger = smaller === rawSet ? tokenSet : rawSet;
      let intersection = 0;
      for (const token of smaller) {
        if (larger.has(token)) intersection += 1;
      }
      if (intersection >= 2 && smaller.size > 0 && intersection / smaller.size >= overlapThreshold) {
        return { matched: entry, confidence: 0.6, strategy: 'token_overlap', normalized };
      }
    }

    return miss;
  }

  return { resolve };
}

module.exports = { normalizeName, significantTokens, createResolver, STOPWORDS };
