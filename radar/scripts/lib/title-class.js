/**
 * Title-class taxonomy shared by the DOL LCA importer and the refresh
 * pipeline. The whole point of the evidence engine is that "UCSF sponsors"
 * is institution-level noise while "UCSF certified 37 postdoc-class LCAs"
 * is job-relevant signal — so LCA rows and live postings must be classified
 * by ONE function or the join is meaningless.
 *
 * classifyTitle(title, socCode?) returns a class key. Title rules win; the
 * SOC code (present on LCA rows, absent on postings) is the tiebreaker.
 * First match wins, so order encodes precedence (postdoc before clinical so
 * "Postdoctoral Fellow" never falls into the clinical "fellow" bucket).
 */

const TITLE_RULES = [
  ['postdoc', /post-?\s?doc(toral)?\b|\bpostdoc\b/i],
  // "Open Rank"/"Open Level" postings are faculty searches that never spell out
  // "professor" — the single largest miss in the `other` bucket.
  ['faculty', /\b(professor|lecturer|instructor|dean|faculty|chair\b)|open[ -](rank|level)|assistant\/associate\s+professor/i],
  ['data_computational', /\b(data\s+scientist|data\s+(scien|analyt|warehous|governance|stewardship)\w*|bioinformatic\w*|computational\s+(biolog|scient|chem|physic)\w*|bio-?statistician|statistician|machine\s+learning|ml\s+(scientist|engineer)|ai\s+(scientist|researcher|engineer)|informatics|(data|research|quantitative|genomic\w*|imaging|informatics|biostatistical|statistical)\s+analyst)\b/i],
  ['engineering_software', /\b(software|data|devops|platform|systems?|cloud|full-?stack|back-?end|front-?end|application|applications|enterprise|web|mobile|api|integration|python|java|research|hpc)\s+(engineer|developer|architect)\b|\bprogrammer\b|\bweb\s+developer\b/i],
  ['scientist', /\b(scientist|investigator)\b/i],
  ['research_associate', /\bresearch\s+(associate|specialist)\b|\b(associate\s+)?specialist\b/i],
  ['research_support', /\bresearch\s+(assistant|technician|coordinator|technologist|nurse)\b|\blab(oratory)?\s+(manager|technician|assistant|aide)\b|\b(clinical\s+research|study)\s+coordinator\b/i],
  ['clinical', /\b(physician|doctor|nurse|resident|pgy-?\d|clinical\s+fellow|fellow\b.*\b(medicine|oncology|cardiology|pediatric)|therapist|dentist|pharmacist|surgeon|psychiatrist|psychologist|clinician|chiropractor|anesthetist)\b/i]
];

// SOC major/detailed-group fallbacks (LCA rows only)
const SOC_RULES = [
  ['faculty', /^25-1/],
  ['data_computational', /^15-20/],
  ['engineering_software', /^15-12/],
  ['research_support', /^19-4/],
  ['scientist', /^19-[123]/],
  ['clinical', /^29-/]
];

const CLASS_LABELS = {
  postdoc: 'postdoc',
  faculty: 'faculty',
  scientist: 'research scientist',
  data_computational: 'data & computational',
  engineering_software: 'software & data engineering',
  research_associate: 'research associate / specialist',
  research_support: 'research support & coordination',
  clinical: 'clinical',
  other: 'other'
};

function classifyTitle(title, socCode) {
  const text = String(title || '');
  for (const [className, pattern] of TITLE_RULES) {
    if (pattern.test(text)) return className;
  }
  const soc = String(socCode || '');
  for (const [className, pattern] of SOC_RULES) {
    if (pattern.test(soc)) return className;
  }
  return 'other';
}

function classLabel(className) {
  return CLASS_LABELS[className] || className;
}

module.exports = { classifyTitle, classLabel, CLASS_LABELS };
