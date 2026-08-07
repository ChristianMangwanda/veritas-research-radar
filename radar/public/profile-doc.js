(function () {
  'use strict';

  /**
   * radar/data/profile.md — the authored profile — read into the shape the rest
   * of the system already expects.
   *
   * This replaces deriving a profile from seven résumé files with a local model.
   * That derivation was the churn engine: profile.json was rewritten whenever any
   * résumé changed, its hash moved, and every cached judgment died with it. The
   * document changes when the person changes, which is rarely, so the cache is
   * stable by nature rather than by clever key partitioning.
   *
   * Shape of the file: YAML-ish frontmatter for the deterministic gates, then
   * Markdown prose. The prose is what the judge model reads — it is carried on
   * every posting, so its length is a real budget.
   *
   * Deliberately hand-rolled rather than pulling in a YAML dependency: the
   * frontmatter is a fixed handful of scalars, one list of strings and one list
   * of degree records, and this repo has no runtime dependencies.
   *
   * Lives in radar/public/ rather than radar/scripts/lib/ because the browser
   * parses the document too now that the profile is stored in Supabase instead
   * of read off the server's disk. Same dual-env trick scoring.js uses, and for
   * the same reason: one parser, so the hash the browser computes and the hash
   * the judge computes can never disagree.
   */

  const root = typeof window !== 'undefined' ? window : globalThis;

  const SECTION = /^##\s+(.+?)\s*$/;

  function splitDocument(text) {
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text.replace(/^﻿/, ''));
    if (!match) return { frontmatter: '', body: text };
    return { frontmatter: match[1], body: match[2] };
  }

  function scalar(raw) {
    const value = String(raw).trim().replace(/^["']|["']$/g, '');
    if (value === '' || value === 'null' || value === '~') return null;
    if (value === 'true') return true;
    if (value === 'false') return false;
    if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
    // Inline lists: [a, b, c]
    if (/^\[.*\]$/.test(value)) {
      return value.slice(1, -1).split(',').map((v) => v.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    }
    return value;
  }

  /** Frontmatter: `key: value`, `key:` followed by `  - item`, and `  - key: value`
   *  blocks for degrees. Two levels is all the format needs. */
  function parseFrontmatter(text) {
    const out = {};
    let listKey = null;
    let record = null;

    const flush = () => {
      if (record && listKey) { out[listKey].push(record); record = null; }
    };

    for (const line of text.split(/\r?\n/)) {
      if (!line.trim() || /^\s*#/.test(line)) continue;

      const item = /^\s+-\s*(.*)$/.exec(line);
      if (item && listKey) {
        const inner = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(item[1]);
        if (inner) {                       // "- level: masters" starts a record
          flush();
          record = { [inner[1]]: scalar(inner[2]) };
        } else {                           // "- registered nurse" is a plain item
          flush();
          out[listKey].push(scalar(item[1]));
        }
        continue;
      }
      // Continuation of the record started above: "    field: Applied Data Science"
      const nested = /^\s{2,}([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
      if (nested && record) { record[nested[1]] = scalar(nested[2]); continue; }

      const top = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
      if (!top) continue;
      flush();
      const [, key, rest] = top;
      if (rest.trim() === '') { listKey = key; out[key] = []; }
      else { listKey = null; out[key] = scalar(rest); }
    }
    flush();
    return out;
  }

  function parseSections(body) {
    const sections = new Map();
    let current = null;
    const buffer = [];
    const close = () => { if (current) sections.set(current.toLowerCase(), buffer.join('\n').trim()); buffer.length = 0; };
    for (const line of body.split(/\r?\n/)) {
      const heading = SECTION.exec(line);
      if (heading) { close(); current = heading[1]; continue; }
      if (current) buffer.push(line);
    }
    close();
    return sections;
  }

  /**
   * "What I can do" is one comma-separated list, but entries carry parenthesised
   * detail — "time-series forecasting (SARIMAX, Prophet)". Splitting naively on
   * commas shreds those; ignoring the parentheses throws away the most matchable
   * terms a posting will actually name. So: split outside parentheses, then keep
   * BOTH the parent term and each item inside.
   */
  function parseCapabilities(text) {
    const parts = [];
    let depth = 0;
    let current = '';
    for (const char of text.replace(/\s+/g, ' ')) {
      if (char === '(') depth += 1;
      if (char === ')') depth = Math.max(0, depth - 1);
      if (char === ',' && depth === 0) { parts.push(current); current = ''; continue; }
      current += char;
    }
    parts.push(current);

    const terms = [];
    const dropped = [];
    const seen = new Set();
    const add = (term) => {
      const clean = term.trim().replace(/^[-•*]\s*/, '').replace(/\.$/, '').trim();
      if (!clean) return;
      // The scoring engine rejects terms under two characters, and it is right
      // to: a bare "R" matches the letter r everywhere and would poison every
      // score. But dropping a stated skill in silence is the exact failure this
      // document exists to prevent, so it is reported instead of vanishing.
      if (clean.length < 2) { dropped.push(clean); return; }
      const key = clean.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      terms.push(clean);
    };

    for (const part of parts) {
      const paren = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(part.trim());
      if (paren) {
        add(paren[1]);
        for (const inner of paren[2].split(',')) add(inner);
      } else {
        add(part);
      }
    }
    return { terms, dropped };
  }

  /** Earlier in the list means more central — the prompt asks for that ordering,
   *  so honour it rather than flattening every term to equal weight. */
  function weightFor(index, total) {
    if (index < total / 3) return 3;
    if (index < (2 * total) / 3) return 2;
    return 1;
  }

  function parseProfileDocument(text) {
    const { frontmatter, body } = splitDocument(text);
    const meta = parseFrontmatter(frontmatter);
    const sections = parseSections(body);

    const { terms: capabilities, dropped } = parseCapabilities(sections.get('what i can do') || '');
    const summary = (sections.get('who i am') || '').replace(/\s+/g, ' ').trim();

    const degrees = (Array.isArray(meta.degrees) ? meta.degrees : [])
      .filter((d) => d && typeof d === 'object' && d.level)
      .map((d) => ({
        level: String(d.level).toLowerCase(),
        field: d.field ? String(d.field) : '',
        status: String(d.status || 'completed').toLowerCase()
      }));

    const profile = {
      schema_version: 2,
      source: 'profile.md',
      core: {
        summary,
        career_stage: meta.career_stage || 'early_career',
        years_experience: Number.isFinite(meta.years_experience) ? meta.years_experience : 0,
        degrees,
        // The `avoid` list gates on posting TITLES (see the profession gate in
        // scoring.js). Empty is a legitimate answer and means no such gate.
        avoid_signals: (Array.isArray(meta.avoid) ? meta.avoid : []).map(String).filter(Boolean),
        work_authorization: meta.work_authorization || '',
        locations: Array.isArray(meta.locations) ? meta.locations : [],
        remote: meta.remote || '',
        salary_floor: Number.isFinite(meta.salary_floor) ? meta.salary_floor : null,
        notes_for_ranking: sections.get('notes') || ''
      },
      /* One profile, so one variant. The scoring engine is built around
       * best-of-N variants and there is no reason to tear that up: N is simply 1
       * now. title_classes stays empty on purpose — it existed to feed the
       * roleTrack gate, which no longer decides anything, and guessing at it
       * would be inventing a constraint the document never stated. */
      variants: [{
        id: 'profile',
        label: 'Profile',
        intent: summary.slice(0, 160),
        title_classes: [],
        domains: [],
        skills: capabilities.map((term, index) => ({
          term: term.toLowerCase(),
          weight: weightFor(index, capabilities.length),
          aliases: []
        }))
      }],
      // What the judge model actually reads. Kept verbatim so editing the
      // document changes the prompt with nothing in between.
      prose: body.trim(),
      // Surfaced so a skill too short to match is a visible decision, not a loss.
      dropped_terms: dropped,
      wants: sections.get('what i want') || '',
      avoids: sections.get('what i do not want') || ''
    };
    return profile;
  }

  const RadarProfileDoc = { parseProfileDocument, parseCapabilities, parseFrontmatter };

  root.RadarProfileDoc = RadarProfileDoc;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = RadarProfileDoc;
  }
})();
