#!/usr/bin/env node

/**
 * Merge confirmed feeds into the registry. The last step, and the only one that
 * writes to employers.json.
 *
 * It promotes exactly what verify-proposed-feeds.js marked `confirmed` — never
 * `inconclusive`, which is the honest majority verdict for a small feed and the
 * one a human has to settle. Everything upstream is designed so that this step
 * needs no judgement of its own.
 *
 * The one judgement it does encode is naming. Candidates arrive with their IRS
 * legal name, in capitals, which is how the registry ends up holding entries
 * like "WOODS HOLE OCEANOGRAPHIC INSTITUTION" next to "Salk Institute". The
 * name is user-facing — it labels every posting in the dashboard — so a curated
 * display name is used where one is known, with the legal name kept as an alias
 * so the monthly IRS and IPEDS joins still match on it.
 *
 * Usage:
 *   node radar/scripts/promote-verified-feeds.js            # show what would go in
 *   node radar/scripts/promote-verified-feeds.js --approve  # write employers.json
 */

const fsp = require('fs/promises');
const path = require('path');

const DATA_DIR = path.resolve(__dirname, '../data');
const VERIFICATION_PATH = path.join(DATA_DIR, 'proposed-feed-verification.json');
const REGISTRY_PATH = path.resolve(__dirname, '../employers.json');

/* Legal name -> the name a person would recognise. Deliberately explicit rather
 * than an automatic title-caser: "AMERICAN TYPE CULTURE COLLECTION" title-cases
 * fine but "ATCC", "METR" and "MUSC" do not, and a mangled acronym is a worse
 * label than shouting. Anything absent here keeps its legal name. */
const DISPLAY_NAMES = {
  'PEW RESEARCH CENTER': 'Pew Research Center',
  'THE ALLEN INSTITUTE FOR ARTIFICIAL INTELLIGENCE': 'Allen Institute for AI (Ai2)',
  'BENAROYA RESEARCH INSTITUTE AT VIRGINIA MASON': 'Benaroya Research Institute at Virginia Mason',
  'BROOKINGS INSTITUTION': 'Brookings Institution',
  'MINNEAPOLIS HEART INSTITUTE FOUNDATION': 'Minneapolis Heart Institute Foundation',
  'ALTARUM INSTITUTE': 'Altarum Institute',
  'AMERICAN TYPE CULTURE COLLECTION': 'American Type Culture Collection (ATCC)',
  'CHARLES STARK DRAPER LABORATORY INC': 'Draper Laboratory',
  'MODEL EVALUATION AND THREAT RESEARCH': 'Model Evaluation and Threat Research (METR)',
  'RIVERSIDE RESEARCH INSTITUTE': 'Riverside Research Institute',
  'MICHAEL J FOX FOUNDATION FOR PARKINSONS RESEARCH': 'Michael J. Fox Foundation for Parkinson\'s Research',
  // The IRS entity that surfaced this feed is the Foundation; the feed itself
  // is the university's — its postings say "Medical University of South
  // Carolina (MUSC - Univ)" — and the university is the cap-exempt employer
  // doing the hiring. Naming it after the Foundation would file 58 university
  // postings under a fundraising arm.
  'THE MEDICAL UNIVERSITY OF SOUTH CAROLINA FOUNDATION': 'Medical University of South Carolina'
};

function slugify(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
}

async function main() {
  const approve = process.argv.includes('--approve');
  const verification = JSON.parse(await fsp.readFile(VERIFICATION_PATH, 'utf8'));
  const registry = JSON.parse(await fsp.readFile(REGISTRY_PATH, 'utf8'));
  const existingIds = new Set(registry.map((employer) => employer.id));

  const confirmed = verification.results.filter((result) => result.verdict === 'confirmed');
  const added = [];

  for (const result of confirmed) {
    const entry = result.suggested_registry_entry;
    const legalName = result.name;
    const displayName = DISPLAY_NAMES[legalName] || legalName;
    const id = slugify(displayName);
    if (existingIds.has(id)) {
      console.log(`skip ${displayName} — id ${id} already in the registry`);
      continue;
    }
    existingIds.add(id);

    added.push({
      id,
      name: displayName,
      // The legal name has to survive: the monthly IRS EO BMF and USCIS joins
      // match on it, and dropping it would quietly un-enrich the employer.
      aliases: displayName === legalName ? [] : [legalName],
      type: entry.type,
      cap_exempt_status: entry.cap_exempt_status,
      evidence_sources: entry.evidence_sources,
      ats_provider: entry.ats_provider,
      ats_token: entry.ats_token,
      ats_config: entry.ats_config,
      careers_url: entry.careers_url,
      research_areas: [],
      notes: `Resolved from the ranked IRS nonprofit pool (${result.employer_place || 'place unknown'}); `
        + `feed ownership ${result.reason} on a ${result.sample_size}-posting sample, `
        + `and the live adapter read ${result.adapter_jobs} jobs.`
    });
  }

  console.log(`\n${confirmed.length} confirmed, ${added.length} to add:`);
  for (const entry of added) {
    console.log(`  + ${entry.name.padEnd(46)} ${entry.ats_provider}:${entry.ats_token}`);
  }

  if (!approve) {
    console.log('\nDry run. Re-run with --approve to write employers.json.');
    return;
  }
  registry.push(...added);
  await fsp.writeFile(REGISTRY_PATH, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
  console.log(`\nMerged ${added.length} employers into the registry (${registry.length} total).`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { DISPLAY_NAMES, slugify };
