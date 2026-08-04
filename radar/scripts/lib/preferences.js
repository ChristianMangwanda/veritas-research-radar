'use strict';

/**
 * What you WANT, as opposed to what your resumes say you can DO.
 *
 * The fit engine has always answered "do the words line up" and "is there a
 * stated barrier". It has never had any representation of what the user is
 * actually looking for, which is why good keyword matches can still feel
 * wrong. This module holds that missing input.
 *
 * The user writes prose. The local model turns it into structured fields
 * they can then correct — the prose stays the source of truth, so a bad
 * structuring pass is always recoverable by re-reading the original text.
 */

const PREFERENCES_SCHEMA_VERSION = 1;

// Deliberately small. Every field must be something a matcher can act on;
// anything vaguer belongs in `notes`, which the judge model reads verbatim.
const STRUCTURE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['locations', 'remote', 'salary_min', 'role_types', 'domains',
    'deal_breakers', 'nice_to_haves', 'notes'],
  properties: {
    locations: {
      type: 'array',
      description: 'US places they would work: cities, states, or regions, as written. Empty means anywhere.',
      items: { type: 'string' }
    },
    remote: {
      type: 'string',
      enum: ['required', 'preferred', 'open', 'onsite_preferred'],
      description: 'How much remote work they want. "open" when unstated.'
    },
    salary_min: {
      type: ['integer', 'null'],
      description: 'Annual USD floor they stated. null if they did not say.'
    },
    role_types: {
      type: 'array',
      description: 'Kinds of role they want, in their words (e.g. "research data scientist", "ML engineer", "computational biologist").',
      items: { type: 'string' }
    },
    domains: {
      type: 'array',
      description: 'Subject areas they are drawn to (e.g. "health data", "genomics", "climate").',
      items: { type: 'string' }
    },
    deal_breakers: {
      type: 'array',
      description: 'Things that make a job a no regardless of fit (e.g. "pure front-end", "night shift", "requires relocation to Texas").',
      items: { type: 'string' }
    },
    nice_to_haves: {
      type: 'array',
      description: 'Things that make a job more attractive but are not required.',
      items: { type: 'string' }
    },
    notes: {
      type: 'string',
      description: 'Anything else a matcher should weigh that does not fit the fields above — visa timing, career-stage goals, constraints.'
    }
  }
};

const STRUCTURE_SYSTEM_PROMPT = `You convert a job-seeker's free-text description of what they want into structured preferences for a job-matching system.

Extract ONLY what they actually said. Never invent a salary floor, a location, or a deal-breaker they did not state — an invented constraint silently hides jobs they would have wanted, which is the worst failure this system can have. When something is unstated, use the empty/neutral value ([] , null, or "open").

Keep their wording where you can: "health data" should stay "health data", not become "healthcare analytics".`;

function emptyPreferences() {
  return {
    schema_version: PREFERENCES_SCHEMA_VERSION,
    updated_at: null,
    text: '',
    structured: {
      locations: [],
      remote: 'open',
      salary_min: null,
      role_types: [],
      domains: [],
      deal_breakers: [],
      nice_to_haves: [],
      notes: ''
    }
  };
}

// Defensive: the model is told the schema but we never trust shape blindly,
// and a malformed field must degrade to neutral rather than throw.
function normalizeStructured(raw) {
  const base = emptyPreferences().structured;
  if (!raw || typeof raw !== 'object') return base;
  const list = (value) => (Array.isArray(value)
    ? value.map((entry) => String(entry || '').trim()).filter(Boolean).slice(0, 25)
    : []);
  const remote = ['required', 'preferred', 'open', 'onsite_preferred'].includes(raw.remote)
    ? raw.remote
    : 'open';
  const salary = Number.isFinite(raw.salary_min) && raw.salary_min > 0
    ? Math.round(raw.salary_min)
    : null;
  return {
    locations: list(raw.locations),
    remote,
    salary_min: salary,
    role_types: list(raw.role_types),
    domains: list(raw.domains),
    deal_breakers: list(raw.deal_breakers),
    nice_to_haves: list(raw.nice_to_haves),
    notes: typeof raw.notes === 'string' ? raw.notes.trim().slice(0, 1000) : ''
  };
}

// A compact human-readable rendering, fed to the judge model alongside each
// posting. Short on purpose: it rides in every judgment prompt.
function preferencesPrompt(preferences) {
  const structured = preferences?.structured || emptyPreferences().structured;
  const lines = [];
  if (structured.role_types.length) lines.push(`Wants roles like: ${structured.role_types.join(', ')}`);
  if (structured.domains.length) lines.push(`Drawn to: ${structured.domains.join(', ')}`);
  if (structured.locations.length) lines.push(`Locations: ${structured.locations.join(', ')}`);
  if (structured.remote !== 'open') lines.push(`Remote: ${structured.remote.replace(/_/g, ' ')}`);
  if (structured.salary_min) lines.push(`Salary floor: $${structured.salary_min.toLocaleString()}`);
  if (structured.deal_breakers.length) lines.push(`Deal-breakers: ${structured.deal_breakers.join(', ')}`);
  if (structured.nice_to_haves.length) lines.push(`Nice to have: ${structured.nice_to_haves.join(', ')}`);
  if (structured.notes) lines.push(`Also: ${structured.notes}`);
  return lines.join('\n');
}

// Cheap stable identity for cache invalidation: change what you want and
// every cached judgment is reconsidered.
function preferencesHash(preferences) {
  const material = JSON.stringify([
    PREFERENCES_SCHEMA_VERSION,
    preferences?.text || '',
    preferences?.structured || null
  ]);
  let hash = 0x811c9dc5;
  for (let i = 0; i < material.length; i += 1) {
    hash ^= material.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

module.exports = {
  PREFERENCES_SCHEMA_VERSION,
  STRUCTURE_SCHEMA,
  STRUCTURE_SYSTEM_PROMPT,
  emptyPreferences,
  normalizeStructured,
  preferencesPrompt,
  preferencesHash
};
