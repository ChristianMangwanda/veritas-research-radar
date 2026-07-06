#!/usr/bin/env node

/**
 * Hand-curated websites for the evidence-bearing research nonprofits — the
 * automated resolvers failed exactly on the famous ones (short names, domains
 * unrelated to their legal names). Every entry is verified live before it
 * lands in the sidecar: the homepage must actually mention the organization.
 *
 * Usage: node radar/scripts/curated-nonprofit-websites.js
 */

const fsp = require('fs/promises');
const path = require('path');
const { normalizeName } = require('./lib/entity-resolution.js');

const SIDECAR_PATH = path.resolve(__dirname, '../data/employer-websites.json');

const CURATED = {
  'MEMORIAL SLOAN-KETTERING CANCER CENTER': 'mskcc.org',
  'BATTELLE MEMORIAL INSTITUTE': 'battelle.org',
  'DANA-FARBER CANCER INSTITUTE': 'dana-farber.org',
  'BROAD INSTITUTE INC': 'broadinstitute.org',
  'HOWARD HUGHES MEDICAL INSTITUTE': 'hhmi.org',
  'SPHERE INSTITUTE': 'sphereinstitute.org',
  'JACKSON LABORATORY': 'jax.org',
  'SCRIPPS RESEARCH INSTITUTE': 'scripps.edu',
  'FERMI RESEARCH ALLIANCE LLC': 'fnal.gov',
  'COLD SPRING HARBOR LABORATORY': 'cshl.edu',
  'VAN ANDEL RESEARCH INSTITUTE': 'vai.org',
  'J DAVID GLADSTONE INSTITUTES': 'gladstone.org',
  'SOUTHWEST RESEARCH INSTITUTE': 'swri.org',
  'ALLEN INSTITUTE': 'alleninstitute.org',
  'STOWERS INSTITUTE FOR MEDICAL RESEARCH': 'stowers.org',
  'SALK INSTITUTE FOR BIOLOGICAL STUDIES': 'salk.edu',
  'SRI INTERNATIONAL': 'sri.com',
  'CHAN ZUCKERBERG BIOHUB INC': 'czbiohub.org',
  'NATIONWIDE CHILDRENS HOSPITAL INC': 'nationwidechildrens.org',
  'OPENAI INC': 'openai.com',
  'RESEARCH TRIANGLE INSTITUTE': 'rti.org',
  'THE WISTAR INSTITUTE OF ANATOMY AND BIOLOGY': 'wistar.org',
  'NEW YORK STEM CELL FOUNDATION INC': 'nyscf.org',
  'OKLAHOMA MEDICAL RESEARCH FOUNDATION': 'omrf.org',
  'URBAN INSTITUTE': 'urban.org',
  'INSTITUTE FOR SYSTEMS BIOLOGY': 'isbscience.org',
  'ITHAKA HARBORS INC': 'ithaka.org',
  'INSTITUTE FOR ADVANCED STUDY': 'ias.edu',
  'BUCK INSTITUTE FOR RESEARCH ON AGING': 'buckinstitute.org',
  'MARINE BIOLOGICAL LABORATORY': 'mbl.edu',
  'SANFORD': 'sanfordresearch.org',
  'PALO ALTO VETERANS INSTITUTE FOR RESEARCH': 'pavir.org',
  'AMERICAN CHEMICAL SOCIETY': 'acs.org',
  'INSTITUTE FOR CANCER RESEARCH': 'foxchase.org',
  'FERMI FORWARD DISCOVERY GROUP LLC': 'fnal.gov',
  'ALTIUS INSTITUTE FOR BIOMEDICAL SCIENCES': 'altius.org',
  'TRANSLATIONAL GENOMICS RESEARCH INSTITUTE': 'tgen.org',
  'TEXAS HEART INSTITUTE': 'texasheart.org',
  'THE ALLEN INSTITUTE FOR ARTIFICIAL INTELLIGENCE': 'allenai.org',
  'FRAUNHOFER USA INC': 'fraunhofer.us',
  'SAGE BIONETWORKS': 'sagebionetworks.org',
  'PEW RESEARCH CENTER': 'pewresearch.org',
  'BAYLOR RESEARCH INSTITUTE': 'bswhealth.com',
  'WOODWELL CLIMATE RESEARCH CENTER': 'woodwellclimate.org',
  'BARUCH S BLUMBERG INSTITUTE': 'blumberginstitute.org',
  'SOUTHERN RESEARCH INSTITUTE': 'southernresearch.org',
  'ARC RESEARCH INSTITUTE': 'arcinstitute.org',
  'DONALD DANFORTH PLANT SCIENCE CENTER': 'danforthcenter.org',
  'THEISS RESEARCH': 'theissresearch.org',
  'NORTHERN CALIFORNIA INSTITUTE FOR RESEARCH AND EDUCATION INC': 'ncire.org',
  'AMERICAN PHYSICAL SOCIETY': 'aps.org',
  'MONELL CHEMICAL SENSES CENTER': 'monell.org',
  'AMERICAN ENTERPRISE INSTITUTE FOR PUBLIC POLICY RESEARCH': 'aei.org',
  'GMTO CORPORATION': 'gmto.org',
  'NEW YORK STRUCTURAL BIOLOGY CENTER INC': 'nysbc.org',
  'AMERICAN PSYCHOLOGICAL ASSOCIATION': 'apa.org',
  'CLIMATEWORKS FOUNDATION': 'climateworks.org',
  'J CRAIG VENTER INSTITUTE INC': 'jcvi.org',
  'LOVELACE BIOMEDICAL RESEARCH INSTITUTE': 'lovelacebiomedical.org',
  'WOODS HOLE OCEANOGRAPHIC INSTITUTION': 'whoi.edu',
  'CORIELL INSTITUTE FOR MEDICAL RESEARCH INC': 'coriell.org',
  'LIEBER INSTITUTE INC': 'libd.org',
  'INDIANA BIOSCIENCES RESEARCH INSTITUTE INC': 'indianabiosciences.org',
  'GREENWOOD GENETIC CENTER INC': 'ggc.org',
  'FLORIDA INSTITUTE FOR HUMAN AND MACHINE COGNITION': 'ihmc.us',
  'CRITICAL PATH INSTITUTE': 'c-path.org',
  'SETI INSTITUTE': 'seti.org',
  'BAIM INSTITUTE FOR CLINICAL RESEARCH INC': 'baiminstitute.org',
  'NEW JERSEY INNOVATION INSTITUTE INC': 'njii.com',
  'INSTITUTE FOR PROTEIN INNOVATION INC': 'proteininnovation.org',
  'CONVERGENT RESEARCH INC': 'convergentresearch.org',
  'BARBARA ANN KARMANOS CANCER INSTITUTE': 'karmanos.org',
  'BROOKINGS INSTITUTION': 'brookings.edu',
  'ROSKAMP INSTITUTE INC': 'roskampinstitute.org',
  'PHOENIX BIOINFORMATICS CORPORATION': 'phoenixbioinformatics.org',
  'BENAROYA RESEARCH INSTITUTE AT VIRGINIA MASON': 'benaroyaresearch.org',
  'FAR AI INC': 'far.ai'
};

const GENERIC = new Set(['THE', 'INC', 'LLC', 'FOR', 'OF', 'AND', 'AT', 'INSTITUTE', 'INSTITUTION', 'RESEARCH', 'CENTER', 'FOUNDATION', 'CORPORATION', 'AMERICAN', 'NATIONAL', 'INTERNATIONAL']);

function distinctive(name) {
  return name.toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').split(/\s+/)
    .filter((t) => t.length > 2 && !GENERIC.has(t));
}

async function verify(domain, name) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(`https://${domain}/`, {
      signal: controller.signal, redirect: 'follow',
      headers: { 'user-agent': 'veritas-research-radar website verification' }
    });
    if (!response.ok) return false;
    const text = (await response.text()).slice(0, 60000).toUpperCase();
    const tokens = distinctive(name);
    if (!tokens.length) return true; // nothing distinctive to check (rare)
    const matched = tokens.filter((t) => text.includes(t)).length;
    return matched >= Math.min(2, tokens.length);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  let sidecar = {};
  try {
    sidecar = JSON.parse(await fsp.readFile(SIDECAR_PATH, 'utf8'));
  } catch { /* fresh */ }

  let verified = 0;
  const failures = [];
  for (const [name, domain] of Object.entries(CURATED)) {
    const ok = await verify(domain, name);
    const key = normalizeName(name);
    if (ok) {
      sidecar[key] = { website: `https://${domain}/`, source: 'curated-verified', confidence: 'curated', fetched_at: new Date().toISOString() };
      verified += 1;
    } else {
      failures.push(`${name} -> ${domain}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  await fsp.writeFile(SIDECAR_PATH, `${JSON.stringify(sidecar, null, 1)}\n`, 'utf8');
  console.log(`verified ${verified}/${Object.keys(CURATED).length} curated websites into the sidecar`);
  if (failures.length) {
    console.log('FAILED verification (need manual/search resolution):');
    for (const failure of failures) console.log('  ' + failure);
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
