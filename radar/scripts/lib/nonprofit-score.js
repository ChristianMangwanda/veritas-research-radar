'use strict';

/**
 * Is this nonprofit a research EMPLOYER, or just filed under a research code?
 *
 * The cap-exempt directory holds 14,414 nonprofits, all carrying NTEE codes in
 * H (medical research), U (science research) or V (social science research).
 * That reads like the statutory category — INA 214(g)(5)(C), "nonprofit
 * research organization" — and it is not. NTEE records what an organisation
 * FILED AS, not what it does or whether it hires anyone:
 *
 *   Maine Narrow Gauge Railroad & Industrial Heritage   U99
 *   Maine State Pomological Society (apple growers)     U52E
 *   Maine Cancer Foundation (a grantmaker)              H30Z
 *
 * A railroad museum and an apple growers' society are indistinguishable from
 * the Jackson Laboratory by NTEE alone. The IRS business master file separates
 * them on two fields the ingest previously discarded:
 *
 *   FOUNDATION   grantmaker vs operating charity
 *   REVENUE_AMT  whether there is an organisation here at all
 *
 * The output is a rank, not a verdict. Getting this wrong in the strict
 * direction is the expensive error — a research institute scored too low is
 * one you never see, and you will never know it existed. So the thresholds
 * below are deliberately generous, and `excluded` is reserved for the two
 * cases that are categorically not employers of researchers.
 */

/* IRS FOUNDATION codes. 02/03/04 are private foundations — 04 in particular is
 * the non-operating kind whose entire function is to hand money to other
 * people. They do not run labs and they do not sponsor visas for scientists. */
const PRIVATE_FOUNDATION_CODES = new Set(['02', '03', '04']);

/* NTEE detail codes that describe an activity other than doing research.
 * Deliberately short: each one is a category, not a guess about an individual
 * organisation, and anything not listed gets the benefit of the doubt. */
/* NTEE "common codes" are the two digits after the major letter, and they mean
 * fixed things across every major group:
 *
 *   01 alliance/advocacy   02 management support   03 professional society
 *   05 RESEARCH INSTITUTES & PUBLIC POLICY ANALYSIS
 *   11 single-org support  12 fundraising          19 nonmonetary support
 *
 * 05 was in this list as "research council / think tank support" — the exact
 * inverse of what it means. It excluded 43 organisations over $20M including
 * Altarum Institute, the Advanced Robotics for Manufacturing Institute, and a
 * $1bn energy research alliance. That is the failure this whole file is
 * supposed to prevent: a buried research employer produces no error and no
 * complaint, it just never appears.
 */
const NON_EMPLOYER_NTEE = [
  [/^H12/, 'health fundraising'],       // 1,189 of the pool — fundraising arms
  [/^[HUV]11/, 'single-organization support'],
  [/^[HUV]12/, 'fundraising / fund distribution'],
  [/^[HUV]03/, 'professional society'],
  [/^[HUV]19/, 'nonmonetary support']
];

/* The inverse: common codes that say the organisation performs research. */
const RESEARCH_COMMON_CODE = /^[HUV]0?5/;

/** Revenue floors. An organisation employing research staff on H-1B has
 *  payroll; one filing under $250k does not have a lab. */
const REVENUE_SUBSTANTIAL = 5_000_000;
const REVENUE_VIABLE = 500_000;
const REVENUE_MINIMAL = 250_000;

function nteeNote(ntee) {
  const code = String(ntee || '').trim().toUpperCase();
  for (const [pattern, label] of NON_EMPLOYER_NTEE) {
    if (pattern.test(code)) return label;
  }
  return null;
}

/**
 * Score one directory entry against its IRS master-file row.
 *
 * Returns { score, tier, reasons, excluded } where score is 0-100 and tier is
 * one of 'proven' | 'strong' | 'possible' | 'unlikely' | 'excluded'.
 * `reasons` carries the evidence for each component so a wrong rank is
 * arguable rather than mysterious — the same contract the job funnel uses.
 */
function scoreNonprofit(entry, irs) {
  const reasons = [];
  let score = 0;

  // Proven sponsorship outranks every inference below it. An organisation that
  // has actually petitioned for someone is a research employer whatever its
  // paperwork says, so this alone floors the tier.
  const uscis = Number(entry?.uscis_approvals_3y) || 0;
  const dol = Number(entry?.dol_certified_3y) || 0;
  if (uscis > 0) {
    score += Math.min(45, 20 + uscis);
    reasons.push({ signal: 'uscis', detail: `${uscis} H-1B approval${uscis === 1 ? '' : 's'} in 3y`, weight: Math.min(45, 20 + uscis) });
  }
  if (dol > 0) {
    score += Math.min(15, 5 + dol);
    reasons.push({ signal: 'dol', detail: `${dol} certified LCA${dol === 1 ? '' : 's'} in 3y`, weight: Math.min(15, 5 + dol) });
  }

  if (!irs) {
    // No master-file row to judge against. Not evidence of anything — the join
    // is on EIN and the file is a snapshot, so absence means unknown.
    reasons.push({ signal: 'irs', detail: 'no IRS master-file row matched this EIN', weight: 0 });
    return {
      score,
      tier: uscis > 0 ? 'proven' : 'unlikely',
      reasons,
      excluded: null
    };
  }

  // --- the two categorical exclusions -------------------------------------
  const foundation = String(irs.foundation || '').trim().padStart(2, '0');
  if (PRIVATE_FOUNDATION_CODES.has(foundation)) {
    // A grantmaker with real sponsorship history is a contradiction worth
    // seeing rather than deleting, so proven sponsors survive exclusion.
    if (uscis === 0) {
      return {
        score: 0,
        tier: 'excluded',
        reasons: [...reasons, { signal: 'foundation', detail: `IRS foundation code ${foundation} — private foundation (grantmaker)`, weight: 0 }],
        excluded: 'private_foundation'
      };
    }
    reasons.push({ signal: 'foundation', detail: `foundation code ${foundation}, but it has sponsored — kept`, weight: 0 });
  }

  const activityNote = nteeNote(irs.ntee_cd || entry?.ntee_cd);
  if (activityNote && uscis === 0) {
    return {
      score: 0,
      tier: 'excluded',
      reasons: [...reasons, { signal: 'ntee', detail: `${(irs.ntee_cd || entry?.ntee_cd || '').trim()} — ${activityNote}`, weight: 0 }],
      excluded: 'not_an_employer'
    };
  }

  // --- size ----------------------------------------------------------------
  const revenue = Number(irs.revenue_amt) || 0;
  const assets = Number(irs.asset_amt) || 0;
  if (revenue >= REVENUE_SUBSTANTIAL) {
    score += 30;
    reasons.push({ signal: 'revenue', detail: `$${Math.round(revenue / 1e6)}M annual revenue`, weight: 30 });
  } else if (revenue >= REVENUE_VIABLE) {
    score += 18;
    reasons.push({ signal: 'revenue', detail: `$${Math.round(revenue / 1000)}k annual revenue`, weight: 18 });
  } else if (revenue >= REVENUE_MINIMAL) {
    score += 8;
    reasons.push({ signal: 'revenue', detail: `$${Math.round(revenue / 1000)}k annual revenue — small`, weight: 8 });
  } else if (revenue > 0) {
    reasons.push({ signal: 'revenue', detail: `$${Math.round(revenue / 1000)}k — below a payroll`, weight: 0 });
  } else if (assets >= REVENUE_VIABLE) {
    // Revenue is blank on plenty of rows; assets keep those from reading as
    // empty shells when they are not.
    score += 10;
    reasons.push({ signal: 'assets', detail: `$${Math.round(assets / 1e6)}M assets, revenue not reported`, weight: 10 });
  } else {
    reasons.push({ signal: 'revenue', detail: 'no revenue or assets reported', weight: 0 });
  }

  // --- what it says it does ------------------------------------------------
  const ntee = String(irs.ntee_cd || entry?.ntee_cd || '').trim().toUpperCase();
  if (RESEARCH_COMMON_CODE.test(ntee)) {
    // "05" — research institutes and public policy analysis.
    score += 20;
    reasons.push({ signal: 'ntee', detail: `${ntee} — research institute / policy analysis`, weight: 20 });
  } else if (/^(H90|H92|U(1[0-9]|2[0-9]|3[0-9]|4[0-9]|5[0-9]))/.test(ntee)) {
    // Research-performing detail codes: medical research institutes and the
    // science/engineering research bands.
    score += 20;
    reasons.push({ signal: 'ntee', detail: `${ntee} — research-performing category`, weight: 20 });
  } else if (/^[HUV]/.test(ntee)) {
    score += 8;
    reasons.push({ signal: 'ntee', detail: `${ntee} — research-adjacent category`, weight: 8 });
  }

  // 501(c)(3) is a prerequisite for the nonprofit-research exemption.
  if (String(irs.subsection || '').trim().padStart(2, '0') === '03') {
    score += 5;
    reasons.push({ signal: 'subsection', detail: '501(c)(3)', weight: 5 });
  }

  score = Math.max(0, Math.min(100, score));
  let tier;
  if (uscis > 0) tier = 'proven';
  else if (score >= 50) tier = 'strong';
  else if (score >= 28) tier = 'possible';
  else tier = 'unlikely';

  return { score, tier, reasons, excluded: null };
}

module.exports = {
  scoreNonprofit,
  nteeNote,
  PRIVATE_FOUNDATION_CODES,
  NON_EMPLOYER_NTEE,
  RESEARCH_COMMON_CODE,
  REVENUE_SUBSTANTIAL,
  REVENUE_VIABLE,
  REVENUE_MINIMAL
};
