'use strict';

/**
 * Does this job feed actually belong to the employer we think it does?
 *
 * The crawl finds a job board and records whose it is by matching a name. That
 * attribution has now been wrong in both directions, twice, from independent
 * discoveries: `uta.peopleadmin.com` matched UT *Austin* and belongs to UT
 * *Arlington*, and `schneider.taleo.net` is filed under a small California
 * college while serving 428 truck-driver jobs for the freight company. A name
 * match is a hypothesis. This module is where the hypothesis has to survive
 * contact with what the feed actually contains.
 *
 * Three outcomes, deliberately — the same shape as verify-website.js:
 *
 *   confirmed      the postings themselves place this feed with this employer
 *   rejected       the postings are positively somebody else's
 *   inconclusive   not enough evidence either way -> a human decides
 *
 * `inconclusive` is not a failure mode, it is the honest majority case for
 * small feeds, and it must never be promoted automatically. Collapsing it into
 * either neighbour is how you either lose real employers or admit a trucking
 * company.
 *
 * Evidence is QUOTABLE by design: every signal carries the text that produced
 * it, so a wrong verdict can be read and argued with rather than re-derived.
 */

const { tokens } = require('./verify-website.js');

const US_STATES = {
  AL: 'ALABAMA', AK: 'ALASKA', AZ: 'ARIZONA', AR: 'ARKANSAS', CA: 'CALIFORNIA',
  CO: 'COLORADO', CT: 'CONNECTICUT', DE: 'DELAWARE', FL: 'FLORIDA', GA: 'GEORGIA',
  HI: 'HAWAII', ID: 'IDAHO', IL: 'ILLINOIS', IN: 'INDIANA', IA: 'IOWA',
  KS: 'KANSAS', KY: 'KENTUCKY', LA: 'LOUISIANA', ME: 'MAINE', MD: 'MARYLAND',
  MA: 'MASSACHUSETTS', MI: 'MICHIGAN', MN: 'MINNESOTA', MS: 'MISSISSIPPI',
  MO: 'MISSOURI', MT: 'MONTANA', NE: 'NEBRASKA', NV: 'NEVADA',
  NH: 'NEW HAMPSHIRE', NJ: 'NEW JERSEY', NM: 'NEW MEXICO', NY: 'NEW YORK',
  NC: 'NORTH CAROLINA', ND: 'NORTH DAKOTA', OH: 'OHIO', OK: 'OKLAHOMA',
  OR: 'OREGON', PA: 'PENNSYLVANIA', RI: 'RHODE ISLAND', SC: 'SOUTH CAROLINA',
  SD: 'SOUTH DAKOTA', TN: 'TENNESSEE', TX: 'TEXAS', UT: 'UTAH', VT: 'VERMONT',
  VA: 'VIRGINIA', WA: 'WASHINGTON', WV: 'WEST VIRGINIA', WI: 'WISCONSIN',
  WY: 'WYOMING', DC: 'DISTRICT OF COLUMBIA', PR: 'PUERTO RICO'
};

/* Thresholds. Calibrated against the nine live Taleo tenants — eight genuine
 * university boards plus the known-bad Schneider one — rather than picked to
 * look reasonable. Kept as named constants so a recalibration is one edit and
 * shows up in a diff. */
const MIN_SAMPLE = 3;
const NAME_CONFIRM = 0.5;
const CITY_CONFIRM = 0.3;
const STATE_CONFIRM = 0.6;
const NAME_SUPPORT = 0.15;
const NAME_ABSENT = 0.05;
const STATE_ABSENT = 0.15;
/* Counted, not proportioned. Schneider's board names "Schneider" in only 2 of
 * 20 postings — most job descriptions never name their employer at all — so a
 * fraction tuned to catch that would have been fitted to one example. Two
 * independent postings naming an organisation is a pattern where one is noise,
 * the same reasoning that made the website verifier demand two tokens rather
 * than one. It only ever applies when the claimed employer is named in NONE. */
const OTHER_ORG_MIN_COUNT = 2;
// A location column that is mostly department names ("Physics & Astronomy") or
// campus labels ("University") carries no geography. Below this share of
// parseable places, the location signals abstain instead of voting no.
const MIN_USABLE_LOCATIONS = 0.4;

function upper(value) {
  return String(value || '').toUpperCase();
}

/* Longest name first, or "WEST VIRGINIA" resolves to VIRGINIA — every WVU
 * posting would have been read as being in the wrong state. Same trap waits in
 * NORTH/SOUTH CAROLINA, NORTH/SOUTH DAKOTA and NEW YORK vs YORK. */
const STATES_BY_LENGTH = Object.entries(US_STATES)
  .sort(([, a], [, b]) => b.length - a.length);

/** The state a location string names, by abbreviation or full name. */
function stateOf(locationText) {
  const text = upper(locationText);
  if (!text) return null;
  for (const [abbr, name] of STATES_BY_LENGTH) {
    if (text.includes(name)) return abbr;
  }
  // Abbreviations only count standalone, or "CA" matches "CAMPUS".
  const match = /\b([A-Z]{2})\b/.exec(text);
  if (match && US_STATES[match[1]]) return match[1];
  return null;
}

/** Distinctive words in an employer name — "of", "university", "the" are not. */
function nameTokens(name) {
  // verify-website's NOISE already drops legal and geographic filler; drop the
  // institution words too, or every university matches every other one.
  const INSTITUTIONAL = new Set([
    'university', 'college', 'institute', 'school', 'center', 'centre',
    'hospital', 'health', 'medical', 'research', 'science', 'sciences',
    'system', 'campus', 'district', 'academy', 'clinic'
  ]);
  return tokens(name).filter((token) => !INSTITUTIONAL.has(token));
}

/**
 * Could `label` be shorthand for `name`? True when its letters appear in order
 * within the name — "utsw" inside "University of Texas SouthWestern". Loose on
 * purpose: this only ever suppresses a rejection, so over-matching costs an
 * inconclusive while under-matching would throw away a real employer.
 */
function isAbbreviationOf(label, name) {
  const letters = upper(name).replace(/[^A-Z]/g, '');
  const needle = upper(label).replace(/[^A-Z]/g, '');
  if (!needle || !letters) return false;
  let at = 0;
  for (const character of needle) {
    at = letters.indexOf(character, at);
    if (at === -1) return false;
    at += 1;
  }
  return true;
}

/** The registrable part of a domain: "www.uab.edu" -> "uab.edu". */
function domainOf(website) {
  if (!website) return null;
  const match = /^(?:https?:\/\/)?(?:www\d?\.)?([a-z0-9.-]+)/i.exec(String(website).trim());
  return match ? match[1].toLowerCase().replace(/\/$/, '') : null;
}

/**
 * Score one candidate feed. `jobs` are records as the drivers emit them, so
 * this works for any provider — the gate is about evidence, not about Taleo.
 */
function scoreFeedOwnership({ employer, jobs, feedLabel = null, thresholds = {} } = {}) {
  const limits = {
    minSample: MIN_SAMPLE,
    nameConfirm: NAME_CONFIRM,
    cityConfirm: CITY_CONFIRM,
    stateConfirm: STATE_CONFIRM,
    nameSupport: NAME_SUPPORT,
    nameAbsent: NAME_ABSENT,
    stateAbsent: STATE_ABSENT,
    otherOrgMinCount: OTHER_ORG_MIN_COUNT,
    minUsableLocations: MIN_USABLE_LOCATIONS,
    ...thresholds
  };
  const sample = (jobs || []).filter(Boolean);
  const evidence = [];

  if (sample.length < limits.minSample) {
    return {
      verdict: 'inconclusive',
      reason: 'thin_sample',
      sample_size: sample.length,
      signals: {},
      evidence
    };
  }

  const wanted = nameTokens(employer?.name);
  const domain = domainOf(employer?.website);
  const city = upper(employer?.city);
  const state = upper(employer?.state);
  const stateName = US_STATES[state] || null;

  let nameHits = 0;
  let cityHits = 0;
  let stateHits = 0;
  let usableLocations = 0;
  let labelHits = 0;

  /* The tenant slug is a name too. schneider.taleo.net says "Schneider" in
   * every posting and never says "Advanced Career Institute", the college the
   * crawl filed it under — that is positive evidence of another owner, not
   * merely absent evidence of this one. Only distinctive slugs qualify: a
   * generic or employer-matching label proves nothing either way. */
  const label = (feedLabel || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const labelIsForeign = label.length >= 4
    && !wanted.some((token) => token.includes(label) || label.includes(token))
    && (!domain || !domain.includes(label))
    // "utsw" is UT Southwestern's own abbreviation, not a rival's name. Treating
    // an employer's acronym as foreign would reject a real feed whose postings
    // happen to use only the short form — the one error this must never make.
    && !isAbbreviationOf(label, employer?.name);

  for (const job of sample) {
    const locationText = upper(job.location);
    const body = `${job.title || ''} ${job.description_text || ''}`;
    const bodyUpper = upper(body);
    const bodyLower = body.toLowerCase();

    // --- name / domain ---------------------------------------------------
    // Two distinctive tokens, never one: salk.edu was once "verified" as the
    // Maine State Pomological Society off the shared word "state".
    const matched = wanted.filter((token) => bodyLower.includes(token));
    const domainHit = domain ? bodyLower.includes(domain) : false;
    if (domainHit || matched.length >= 2 || (wanted.length === 1 && matched.length === 1)) {
      nameHits += 1;
      if (evidence.length < 6) {
        const needle = domainHit ? domain : matched[0];
        const at = bodyLower.indexOf(needle);
        evidence.push({
          signal: domainHit ? 'domain' : 'name',
          job: job.title,
          quote: body.slice(Math.max(0, at - 60), at + 90).replace(/\s+/g, ' ').trim()
        });
      }
    }

    if (labelIsForeign && bodyLower.includes(label)) {
      labelHits += 1;
      if (evidence.length < 8) {
        const at = bodyLower.indexOf(label);
        evidence.push({
          signal: 'other_org',
          job: job.title,
          quote: body.slice(Math.max(0, at - 60), at + 90).replace(/\s+/g, ' ').trim()
        });
      }
    }

    // --- geography -------------------------------------------------------
    const found = stateOf(locationText);
    if (found) usableLocations += 1;
    if (city && locationText.includes(city)) cityHits += 1;
    if (state && (found === state || (stateName && locationText.includes(stateName)))) {
      stateHits += 1;
      if (evidence.length < 8) {
        evidence.push({ signal: 'state', job: job.title, quote: job.location });
      }
    }
  }

  const size = sample.length;
  const signals = {
    name_fraction: nameHits / size,
    city_fraction: cityHits / size,
    state_fraction: stateHits / size,
    name_count: nameHits,
    other_org_count: labelHits,
    usable_location_fraction: usableLocations / size,
    name_tokens: wanted,
    domain
  };

  const locationsUsable = signals.usable_location_fraction >= limits.minUsableLocations;

  // Confirm on any single sufficient signal. A feed whose postings repeatedly
  // name the employer is settled regardless of what its location column holds,
  // which matters because Taleo's location column is frequently a department.
  if (signals.name_fraction >= limits.nameConfirm) {
    return { verdict: 'confirmed', reason: 'postings_name_employer', sample_size: size, signals, evidence };
  }
  if (locationsUsable && signals.city_fraction >= limits.cityConfirm) {
    return { verdict: 'confirmed', reason: 'postings_in_employer_city', sample_size: size, signals, evidence };
  }
  if (locationsUsable && signals.state_fraction >= limits.stateConfirm
      && signals.name_fraction >= limits.nameSupport) {
    return { verdict: 'confirmed', reason: 'state_and_name_agree', sample_size: size, signals, evidence };
  }

  // Reject on POSITIVE contrary evidence only. Two forms qualify: the postings
  // repeatedly name a different organisation, or they are readably somewhere
  // else. Absence of evidence stays inconclusive — plenty of honest feeds never
  // name their owner, and a silent reject loses a real employer for good.
  if (signals.other_org_count >= limits.otherOrgMinCount && signals.name_count === 0) {
    return { verdict: 'rejected', reason: 'postings_name_another_org', sample_size: size, signals, evidence };
  }
  if (locationsUsable
      && signals.name_fraction <= limits.nameAbsent
      && signals.city_fraction === 0
      && signals.state_fraction <= limits.stateAbsent) {
    return { verdict: 'rejected', reason: 'postings_belong_elsewhere', sample_size: size, signals, evidence };
  }

  return { verdict: 'inconclusive', reason: 'insufficient_evidence', sample_size: size, signals, evidence };
}

module.exports = {
  scoreFeedOwnership,
  stateOf,
  isAbbreviationOf,
  nameTokens,
  domainOf,
  US_STATES
};
