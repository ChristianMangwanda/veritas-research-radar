const state = {
  jobs: [],
  employers: [],
  local: { version: 1, triage: {} },
  profile: null,
  lastVisit: null,
  selectedId: null,
  visible: []
};

const LAST_VISIT_KEY = 'veritas_radar_last_visit';
const THEME_KEY = 'veritas_radar_theme';

// Closed postings with these triage states stay visible so an applied-to job
// that disappears from the ATS is flagged rather than silently hidden
const PROTECTED_TRIAGE = new Set(['shortlist', 'applied', 'emailed_lab', 'needs_visa_check']);

const TRIAGE_LABELS = {
  new: 'New',
  shortlist: 'Shortlist',
  applied: 'Applied',
  emailed_lab: 'Emailed lab',
  needs_visa_check: 'Visa check',
  ignore: 'Ignore'
};

const TRIAGE_COLORS = {
  new: 'var(--info-ink)',
  shortlist: 'var(--accent)',
  applied: 'var(--friendly-ink)',
  emailed_lab: 'var(--info-ink)',
  needs_visa_check: 'var(--warn-ink)',
  ignore: 'var(--faint)'
};

const VISA_LABELS = { FRIENDLY: 'Friendly', RESTRICTED: 'Restricted', NEUTRAL: 'No visa language' };
const VISA_TAGS = { FRIENDLY: 'tag-friendly', RESTRICTED: 'tag-restricted', NEUTRAL: '' };

const SKILLS = [
  'python', 'r', 'sql', 'javascript', 'typescript', 'node', 'react', 'nextflow',
  'snakemake', 'docker', 'kubernetes', 'aws', 'gcp', 'azure', 'linux', 'bash',
  'machine learning', 'deep learning', 'pytorch', 'tensorflow', 'scikit-learn',
  'statistics', 'data visualization', 'bioinformatics', 'genomics', 'rna-seq',
  'single-cell', 'proteomics', 'clinical research', 'nlp', 'llm', 'postgres',
  'spark', 'airflow', 'git', 'api', 'etl', 'data engineering'
];

const DOM = {
  jobs: document.querySelector('#jobs'),
  count: document.querySelector('#count'),
  filtersToggle: document.querySelector('#filters-toggle'),
  emptyState: document.querySelector('#empty-state'),
  emptyReset: document.querySelector('#empty-reset'),
  refreshMeta: document.querySelector('#refresh-meta'),
  statActive: document.querySelector('#stat-active'),
  statNew: document.querySelector('#stat-new'),
  statFriendly: document.querySelector('#stat-friendly'),
  statEmployers: document.querySelector('#stat-employers'),
  errorsToggle: document.querySelector('#errors-toggle'),
  errorsPanel: document.querySelector('#errors-panel'),
  errorsList: document.querySelector('#errors-list'),
  discoveryToggle: document.querySelector('#discovery-toggle'),
  discoveryPanel: document.querySelector('#discovery-panel'),
  discoveryList: document.querySelector('#discovery-list'),
  themeToggle: document.querySelector('#theme-toggle'),
  q: document.querySelector('#q'),
  sort: document.querySelector('#sort'),
  source: document.querySelector('#source'),
  visaSeg: document.querySelector('#visa-seg'),
  newOnly: document.querySelector('#new-only'),
  includeClosed: document.querySelector('#include-closed'),
  includeFederal: document.querySelector('#include-federal'),
  type: document.querySelector('#type'),
  cap: document.querySelector('#cap'),
  triageFilter: document.querySelector('#triage-filter'),
  minResearch: document.querySelector('#min-research'),
  minResearchValue: document.querySelector('#min-research-value'),
  resetFilters: document.querySelector('#reset-filters'),
  resume: document.querySelector('#resume'),
  resumeFile: document.querySelector('#resume-file'),
  clearProfile: document.querySelector('#clear-profile'),
  rowTemplate: document.querySelector('#job-row-template'),
  detailPane: document.querySelector('#detail-pane'),
  detailScroll: document.querySelector('.detail-scroll'),
  detailBack: document.querySelector('#detail-back'),
  detailTitle: document.querySelector('#detail-title'),
  detailMeta: document.querySelector('#detail-meta'),
  detailOpen: document.querySelector('#detail-open'),
  triageSeg: document.querySelector('#triage-seg'),
  detailAlerts: document.querySelector('#detail-alerts'),
  detailSignals: document.querySelector('#detail-signals'),
  detailFit: document.querySelector('#detail-fit'),
  detailDescription: document.querySelector('#detail-description-body'),
  detailDisclaimer: document.querySelector('#detail-disclaimer')
};

const narrowLayout = window.matchMedia('(max-width: 1180px)');

// With thousands of jobs (USAJOBS alone returns 2,500) rendering every row on
// each keystroke janks; the sort puts the best matches first, so cap the list
// and reveal the rest on demand.
const LIST_RENDER_CAP = 400;
let showAllRows = false;

let visaFilter = '';

/* ------------------------------------------------------------------------ */
/* Data + persistence                                                        */

async function getJson(url, fallback) {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return response.json();
  } catch {
    return fallback;
  }
}

async function saveLocalState() {
  await fetch('/api/local-state', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ triage: state.local.triage })
  });
}

/* ------------------------------------------------------------------------ */
/* Profile fit scoring (all local; resume text never leaves the browser)     */

function extractProfile(text) {
  const lower = text.toLowerCase();
  const skills = SKILLS.filter((skill) => hasTerm(lower, skill));
  const degrees = [];
  if (/\b(ph\.?d|doctorate|doctoral)\b/i.test(text)) degrees.push('phd');
  if (/\b(master|m\.s\.|msc|m\.sc)\b/i.test(text)) degrees.push('masters');
  if (/\b(bachelor|b\.s\.|bsc|b\.sc)\b/i.test(text)) degrees.push('bachelors');

  const domains = [];
  for (const domain of ['bioinformatics', 'genomics', 'computational biology', 'data science', 'machine learning', 'clinical research', 'software engineering']) {
    if (hasTerm(lower, domain)) domains.push(domain);
  }

  return { skills, degrees, domains, rawLength: text.trim().length };
}

function jobText(job) {
  return `${job.title} ${job.department} ${job.employer_name} ${job.description_text}`.toLowerCase();
}

// Word-boundary term matching: bare includes() made single-letter skills like
// "r" match every posting and "api" match "rapid"
const TERM_REGEXES = new Map();
function hasTerm(text, term) {
  let regex = TERM_REGEXES.get(term);
  if (!regex) {
    regex = new RegExp(`\\b${escapeRegExp(term)}\\b`, 'i');
    TERM_REGEXES.set(term, regex);
  }
  return regex.test(text);
}

function scoreFit(job) {
  if (!state.profile || state.profile.rawLength < 50) {
    return { fit_score: null, matched_skills: [], missing_skills: [], fit_summary: 'Paste resume text to compute local fit.' };
  }
  const text = jobText(job);
  const matchedSkills = state.profile.skills.filter((skill) => hasTerm(text, skill));
  const missingSkills = state.profile.skills.filter((skill) => !hasTerm(text, skill)).slice(0, 6);
  const matchedDomains = state.profile.domains.filter((domain) => hasTerm(text, domain));
  let score = 20;
  score += Math.min(matchedSkills.length * 8, 40);
  score += Math.min(matchedDomains.length * 12, 24);
  score += Math.round((job.research_relevance_score || 0) * 0.16);
  score += phdPenalty(text);
  if (job.veritas_state === 'RESTRICTED') score -= 35;
  score = Math.max(0, Math.min(100, score));
  const fit_summary = `${score >= 75 ? 'Strong' : score >= 50 ? 'Possible' : 'Weak'} fit — ${matchedSkills.length} matching skills, ${matchedDomains.length} matching domains.`;
  return { fit_score: score, matched_skills: matchedSkills, missing_skills: missingSkills, fit_summary };
}

// Only penalize hard PhD requirements; "PhD preferred" or "or equivalent" should
// not sink the score for masters/bachelors candidates
function phdPenalty(text) {
  if (state.profile.degrees.includes('phd')) return 0;
  if (!/\b(phd|ph\.d|doctorate|doctoral)\b/i.test(text)) return 0;
  const softened = /\b(ph\.?d|doctorate|doctoral)\b[^.]{0,60}\b(preferred|desirable|a plus|or equivalent)\b/i.test(text)
    || /\b(preferred|desirable)\b[^.]{0,60}\b(ph\.?d|doctorate|doctoral)\b/i.test(text);
  if (softened) return 0;
  const required = /\b(ph\.?d|doctorate|doctoral degree)\b[^.]{0,60}\b(required|must|necessary)\b/i.test(text)
    || /\b(requires?|must\s+(hold|have|possess))\b[^.]{0,60}\b(ph\.?d|doctorate|doctoral)\b/i.test(text);
  return required ? -18 : -4;
}

/* ------------------------------------------------------------------------ */
/* Filtering + sorting                                                       */

function isNewSinceLastVisit(job) {
  return Boolean(state.lastVisit && job.first_seen_at && job.first_seen_at > state.lastVisit);
}

function triageFor(job) {
  return state.local.triage[job.id]?.status || 'new';
}

function isClosed(job) {
  return job.status === 'closed';
}

function dateDesc(a, b) {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return String(b).localeCompare(String(a));
}

const SORTERS = {
  fit(a, b) {
    const fitA = a.fit.fit_score ?? -1;
    const fitB = b.fit.fit_score ?? -1;
    if (fitA !== fitB) return fitB - fitA;
    return (b.research_relevance_score || 0) - (a.research_relevance_score || 0);
  },
  research(a, b) {
    const delta = (b.research_relevance_score || 0) - (a.research_relevance_score || 0);
    if (delta !== 0) return delta;
    return SORTERS.fit(a, b);
  },
  capexempt(a, b) {
    const delta = (b.cap_exempt_score || 0) - (a.cap_exempt_score || 0);
    if (delta !== 0) return delta;
    return SORTERS.fit(a, b);
  },
  newest_seen(a, b) {
    return dateDesc(a.first_seen_at, b.first_seen_at) || SORTERS.fit(a, b);
  },
  newest_posted(a, b) {
    return dateDesc(a.posted_or_updated_at, b.posted_or_updated_at) || SORTERS.fit(a, b);
  }
};

function filteredJobs() {
  const query = DOM.q.value.trim().toLowerCase();
  const type = DOM.type.value;
  const cap = DOM.cap.value;
  const triage = DOM.triageFilter.value;
  const minResearch = Number(DOM.minResearch.value);
  const sorter = SORTERS[DOM.sort.value] || SORTERS.fit;
  const source = DOM.source.value;

  return state.jobs
    .map((job) => ({ ...job, fit: scoreFit(job) }))
    .filter((job) => !job.citizenship_gated || DOM.includeFederal.checked)
    .filter((job) => !isClosed(job) || DOM.includeClosed.checked || PROTECTED_TRIAGE.has(triageFor(job)))
    .filter((job) => !DOM.newOnly.checked || isNewSinceLastVisit(job))
    .filter((job) => !source || job.source === source)
    .filter((job) => !query || jobText(job).includes(query))
    .filter((job) => !visaFilter || job.veritas_state === visaFilter)
    .filter((job) => !type || job.employer_type === type)
    .filter((job) => !cap || job.cap_exempt_status === cap)
    .filter((job) => !triage || triageFor(job) === triage)
    .filter((job) => Number(job.research_relevance_score || 0) >= minResearch)
    .sort((a, b) => {
      const statusDelta = (isClosed(a) ? 1 : 0) - (isClosed(b) ? 1 : 0);
      if (statusDelta !== 0) return statusDelta;
      return sorter(a, b);
    });
}

function activeFilterCount() {
  let count = 0;
  if (DOM.q.value.trim()) count += 1;
  if (visaFilter) count += 1;
  if (DOM.source.value) count += 1;
  if (DOM.type.value) count += 1;
  if (DOM.cap.value) count += 1;
  if (DOM.triageFilter.value) count += 1;
  if (DOM.newOnly.checked) count += 1;
  if (DOM.includeClosed.checked) count += 1;
  if (DOM.includeFederal.checked) count += 1;
  if (DOM.minResearch.value !== '0') count += 1;
  return count;
}

function resetFilters() {
  DOM.q.value = '';
  DOM.source.value = '';
  DOM.type.value = '';
  DOM.cap.value = '';
  DOM.triageFilter.value = '';
  DOM.newOnly.checked = false;
  DOM.includeClosed.checked = false;
  DOM.includeFederal.checked = false;
  DOM.minResearch.value = '0';
  setVisaFilter('');
  render();
}

/* ------------------------------------------------------------------------ */
/* URL state                                                                 */

function syncUrl() {
  const params = new URLSearchParams();
  if (DOM.q.value.trim()) params.set('q', DOM.q.value.trim());
  if (DOM.sort.value !== 'fit') params.set('sort', DOM.sort.value);
  if (DOM.source.value) params.set('source', DOM.source.value);
  if (DOM.newOnly.checked) params.set('newOnly', '1');
  if (DOM.includeClosed.checked) params.set('includeClosed', '1');
  if (DOM.includeFederal.checked) params.set('federal', '1');
  if (visaFilter) params.set('visa', visaFilter);
  if (DOM.type.value) params.set('type', DOM.type.value);
  if (DOM.cap.value) params.set('cap', DOM.cap.value);
  if (DOM.triageFilter.value) params.set('triage', DOM.triageFilter.value);
  if (DOM.minResearch.value !== '0') params.set('minResearch', DOM.minResearch.value);
  const qs = params.toString();
  history.replaceState(null, '', qs ? `?${qs}` : window.location.pathname);
}

function hydrateFromUrl() {
  const params = new URLSearchParams(window.location.search);
  if (params.has('q')) DOM.q.value = params.get('q');
  if (params.has('sort') && SORTERS[params.get('sort')]) DOM.sort.value = params.get('sort');
  DOM.newOnly.checked = params.get('newOnly') === '1';
  DOM.includeClosed.checked = params.get('includeClosed') === '1';
  DOM.includeFederal.checked = params.get('federal') === '1';
  if (params.has('visa')) setVisaFilter(params.get('visa'), { skipRender: true });
  if (params.has('type')) DOM.type.value = params.get('type');
  if (params.has('cap')) DOM.cap.value = params.get('cap');
  if (params.has('triage')) DOM.triageFilter.value = params.get('triage');
  if (params.has('minResearch')) DOM.minResearch.value = params.get('minResearch');
  if (params.has('source')) DOM.source.value = params.get('source');
}

/* ------------------------------------------------------------------------ */
/* Small builders                                                            */

function el(tagName, className, text) {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function tag(text, kind = '') {
  return el('span', `tag ${kind}`.trim(), text);
}

function meter(value) {
  const wrap = el('span', 'meter');
  const fill = el('i');
  fill.style.width = `${Math.max(0, Math.min(100, Number(value) || 0))}%`;
  wrap.append(fill);
  return wrap;
}

function triageDot(status) {
  const dot = el('span', 'triage-dot');
  dot.style.background = TRIAGE_COLORS[status] || 'var(--faint)';
  return dot;
}

function shortDate(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/* ------------------------------------------------------------------------ */
/* Rendering: stat strip, list, detail                                       */

function renderStats() {
  // Citizen-gated federal jobs are excluded from the headline numbers — a
  // count the user is mostly ineligible for is a vanity metric, not a stat
  const active = state.jobs.filter((job) => !isClosed(job) && !job.citizenship_gated);
  DOM.statActive.textContent = active.length;
  DOM.statNew.textContent = active.filter(isNewSinceLastVisit).length;
  DOM.statFriendly.textContent = active.filter((job) => job.veritas_state === 'FRIENDLY').length;
  DOM.statEmployers.textContent = new Set(active.map((job) => job.employer_id)).size;
}

function render() {
  syncUrl();
  DOM.minResearchValue.textContent = DOM.minResearch.value;

  const filters = activeFilterCount();
  DOM.resetFilters.hidden = filters === 0;
  DOM.resetFilters.querySelector('span').textContent = `(${filters})`;
  DOM.filtersToggle.querySelector('span').textContent = filters ? `(${filters})` : '';

  const jobs = filteredJobs();
  state.visible = jobs;
  DOM.count.textContent = `${jobs.length} job${jobs.length === 1 ? '' : 's'}`;
  DOM.emptyState.hidden = jobs.length > 0;
  DOM.jobs.replaceChildren();

  if (state.selectedId && !jobs.some((job) => job.id === state.selectedId)) {
    state.selectedId = null;
  }

  const toRender = showAllRows ? jobs : jobs.slice(0, LIST_RENDER_CAP);
  for (const job of toRender) {
    DOM.jobs.append(buildRow(job));
  }
  if (jobs.length > toRender.length) {
    const more = el('button', 'ghost-button show-all', `Show all ${jobs.length} jobs (rendering first ${toRender.length})`);
    more.type = 'button';
    more.addEventListener('click', () => {
      showAllRows = true;
      render();
    });
    DOM.jobs.append(more);
  }

  renderDetail();
}

function buildRow(job) {
  const node = DOM.rowTemplate.content.firstElementChild.cloneNode(true);
  node.dataset.id = job.id;
  node.querySelector('.row-title').textContent = job.title;
  node.querySelector('.row-sub').textContent =
    `${job.employer_name} · ${job.location || 'Location unspecified'}`;

  const chips = node.querySelector('.row-chips');
  const status = triageFor(job);
  if (status !== 'new') {
    const label = el('span', 'tag');
    label.append(triageDot(status), document.createTextNode(TRIAGE_LABELS[status]));
    chips.append(label);
  }
  if (isNewSinceLastVisit(job)) chips.append(tag('NEW', 'tag-info'));
  if (isClosed(job)) {
    node.classList.add('is-closed');
    chips.append(tag(PROTECTED_TRIAGE.has(status) ? 'closed — verify' : 'closed', 'tag-warn'));
  }
  chips.append(tag(VISA_LABELS[job.veritas_state] || job.veritas_state, VISA_TAGS[job.veritas_state] ?? ''));

  const scores = node.querySelector('.row-scores');
  if (job.fit.fit_score !== null) {
    const cell = el('span', 'score-cell', `fit ${job.fit.fit_score}`);
    cell.append(meter(job.fit.fit_score));
    scores.append(cell);
  }
  const research = el('span', 'score-cell', `res ${job.research_relevance_score || 0}`);
  research.append(meter(job.research_relevance_score || 0));
  scores.append(research);

  if (job.id === state.selectedId) node.classList.add('is-selected');

  node.addEventListener('click', () => selectJob(job.id));
  node.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      selectJob(job.id);
    }
  });
  return node;
}

function selectJob(id, { scroll = false } = {}) {
  state.selectedId = id;
  for (const row of DOM.jobs.children) {
    row.classList.toggle('is-selected', row.dataset.id === id);
  }
  const row = DOM.jobs.querySelector(`[data-id="${CSS.escape(id)}"]`);
  if (row && scroll) row.scrollIntoView({ block: 'nearest' });
  renderDetail();
}

function selectedJob() {
  return state.visible.find((job) => job.id === state.selectedId) || null;
}

function renderDetail() {
  const job = selectedJob();

  if (narrowLayout.matches) {
    DOM.detailPane.hidden = !job;
  } else {
    DOM.detailPane.hidden = false;
  }

  if (!job) {
    DOM.detailScroll.innerHTML = '';
    const placeholder = el('div', 'detail-placeholder');
    placeholder.append(
      el('span', 'brand-mark', '◉'),
      el('p', '', state.visible.length
        ? 'Select a job to read the full posting, signals, and triage it.'
        : 'No jobs to show.')
    );
    DOM.detailScroll.append(placeholder);
    return;
  }

  // Rebuild the static detail skeleton if the placeholder replaced it
  if (!DOM.detailScroll.querySelector('#detail-title')) {
    DOM.detailScroll.replaceChildren(...buildDetailSkeleton());
    rebindDetailRefs();
  }

  DOM.detailTitle.textContent = job.title;
  DOM.detailMeta.textContent = [
    job.employer_name,
    job.location || 'Location unspecified',
    job.department || null
  ].filter(Boolean).join(' · ');
  DOM.detailOpen.href = job.url;

  const current = triageFor(job);
  for (const button of DOM.triageSeg.querySelectorAll('button')) {
    button.classList.toggle('is-active', button.dataset.value === current);
  }

  renderDetailAlerts(job);
  renderDetailSignals(job);
  renderDetailFit(job);
  renderDetailDescription(job);
  DOM.detailDisclaimer.textContent = job.disclaimer || '';
}

function buildDetailSkeleton() {
  const back = el('button', 'link-button detail-back');
  back.id = 'detail-back';
  back.type = 'button';
  back.textContent = '← Back to list';

  const head = el('div', 'detail-head');
  const title = el('h2'); title.id = 'detail-title';
  const meta = el('p', 'detail-meta'); meta.id = 'detail-meta';
  head.append(title, meta);

  const actions = el('div', 'detail-actions');
  const open = el('a', 'primary-button');
  open.id = 'detail-open';
  open.target = '_blank';
  open.rel = 'noreferrer';
  open.textContent = 'Open posting ↗';
  const seg = el('div', 'segmented triage-seg');
  seg.id = 'triage-seg';
  seg.setAttribute('role', 'group');
  for (const [value, label] of Object.entries(TRIAGE_LABELS)) {
    const button = el('button', '', label);
    button.type = 'button';
    button.dataset.value = value;
    seg.append(button);
  }
  actions.append(open, seg);

  const alerts = el('div'); alerts.id = 'detail-alerts';
  const signals = el('dl', 'signal-grid'); signals.id = 'detail-signals';
  const fit = el('div', 'fit-block'); fit.id = 'detail-fit';

  const description = el('section', 'detail-description');
  const descriptionTitle = el('h3', '', 'Description');
  const body = el('div', 'description-body'); body.id = 'detail-description-body';
  description.append(descriptionTitle, body);

  const disclaimer = el('p', 'disclaimer'); disclaimer.id = 'detail-disclaimer';

  return [back, head, actions, alerts, signals, fit, description, disclaimer];
}

function rebindDetailRefs() {
  DOM.detailBack = document.querySelector('#detail-back');
  DOM.detailTitle = document.querySelector('#detail-title');
  DOM.detailMeta = document.querySelector('#detail-meta');
  DOM.detailOpen = document.querySelector('#detail-open');
  DOM.triageSeg = document.querySelector('#triage-seg');
  DOM.detailAlerts = document.querySelector('#detail-alerts');
  DOM.detailSignals = document.querySelector('#detail-signals');
  DOM.detailFit = document.querySelector('#detail-fit');
  DOM.detailDescription = document.querySelector('#detail-description-body');
  DOM.detailDisclaimer = document.querySelector('#detail-disclaimer');
  bindDetailEvents();
}

function renderDetailAlerts(job) {
  DOM.detailAlerts.replaceChildren();
  if (isClosed(job)) {
    const kind = PROTECTED_TRIAGE.has(triageFor(job)) ? 'alert-warn' : 'alert-warn';
    DOM.detailAlerts.append(el('div', `alert ${kind}`,
      PROTECTED_TRIAGE.has(triageFor(job))
        ? 'This posting closed after you triaged it — verify its status with the employer.'
        : 'This posting is closed. It is kept for 30 days for reference.'));
  }
  if (job.veritas_state === 'RESTRICTED') {
    DOM.detailAlerts.append(el('div', 'alert alert-restricted',
      'Restricted language detected — the highlighted phrases below suggest citizenship or sponsorship limits.'));
  }
  if (job.description_captured === false) {
    DOM.detailAlerts.append(el('div', 'alert alert-warn',
      'Description text was not captured for this aggregator job; signals reflect the title only. Open the posting for the real text.'));
  }
}

function signalCell(label, ...content) {
  const cell = el('div', 'signal');
  const dt = el('dt', '', label);
  const dd = el('dd');
  dd.append(...content);
  cell.append(dt, dd);
  return cell;
}

// What each evidence tag actually proves — shown to the user instead of
// letting a green "verified" pill imply "this job sponsors"
const EVIDENCE_LABELS = [
  [/^ipeds/, 'IPEDS higher-ed registry'],
  [/^irs_eo_bmf/, 'IRS 501(c)(3) master file'],
  [/^uscis/, 'USCIS petition history'],
  [/^dol/, 'DOL LCA disclosures'],
  [/^usajobs/, 'USAJOBS listing'],
  [/^manual/, 'manually curated'],
  [/^cap_exempt_directory/, 'cap-exempt directory match']
];

function evidenceSummary(sources) {
  const seen = new Set();
  for (const source of sources || []) {
    for (const [pattern, label] of EVIDENCE_LABELS) {
      if (pattern.test(String(source))) { seen.add(label); break; }
    }
  }
  return [...seen].join(' · ');
}

const CAP_LABELS = { verified: 'cap-exempt: confirmed', likely: 'cap-exempt: likely', unknown: 'cap-exempt: unknown' };

function renderDetailSignals(job) {
  DOM.detailSignals.replaceChildren();

  const institutionCell = signalCell('Institution status',
    tag(CAP_LABELS[job.cap_exempt_status] || job.cap_exempt_status, job.cap_exempt_status === 'verified' ? 'tag-friendly' : job.cap_exempt_status === 'likely' ? 'tag-accent' : 'tag-warn'),
    ...(typeof job.cap_exempt_score === 'number' && job.cap_exempt_score > 0 ? [document.createTextNode(`score ${job.cap_exempt_score}`)] : []));
  const evidence = evidenceSummary(job.cap_exempt_evidence_sources);
  if (evidence) institutionCell.querySelector('dd').append(el('span', 'signal-note', `via ${evidence}`));

  const sponsorCell = signalCell('Sponsorship history',
    tag(job.sponsor_signal, job.sponsor_signal === 'strong' ? 'tag-friendly' : job.sponsor_signal === 'restricted' ? 'tag-restricted' : job.sponsor_signal === 'moderate' ? 'tag-accent' : 'tag-warn'),
    ...(job.dol_lca_certified_count_3y ? [document.createTextNode(`${job.dol_lca_certified_count_3y} LCA certifications (3y)`)] : []));
  if (job.dol_lca_certified_count_3y) {
    sponsorCell.querySelector('dd').append(el('span', 'signal-note', 'institution-wide, all job titles — not specific to this role'));
  }

  DOM.detailSignals.append(
    signalCell('Visa signal', tag(VISA_LABELS[job.veritas_state] || job.veritas_state, VISA_TAGS[job.veritas_state] ?? '')),
    institutionCell,
    sponsorCell
  );

  const researchCell = signalCell('Research relevance', document.createTextNode(`${job.research_relevance_score || 0} / 100`));
  researchCell.querySelector('dd').append(meter(job.research_relevance_score || 0));
  DOM.detailSignals.append(researchCell);

  DOM.detailSignals.append(
    signalCell('Source', document.createTextNode(job.source || '—')),
    signalCell('First seen', document.createTextNode(shortDate(job.first_seen_at))),
    signalCell('Posted / updated', document.createTextNode(shortDate(job.posted_or_updated_at)))
  );

  if (job.dol_recent_titles?.length) {
    const cell = signalCell('Recent sponsored titles', document.createTextNode(job.dol_recent_titles.slice(0, 4).join(' · ')));
    cell.style.gridColumn = '1 / -1';
    DOM.detailSignals.append(cell);
  }
}

function renderDetailFit(job) {
  DOM.detailFit.replaceChildren();
  if (job.fit.fit_score === null) {
    DOM.detailFit.append(el('p', 'fit-skills', job.fit.fit_summary));
    return;
  }
  DOM.detailFit.append(
    el('p', 'fit-score', `Fit ${job.fit.fit_score} / 100`),
    el('p', '', job.fit.fit_summary)
  );
  if (job.fit.matched_skills.length) {
    DOM.detailFit.append(el('p', 'fit-skills', `Matched skills: ${job.fit.matched_skills.join(', ')}`));
  }
  if (job.fit.missing_skills.length) {
    DOM.detailFit.append(el('p', 'fit-skills', `From your resume, not mentioned: ${job.fit.missing_skills.join(', ')}`));
  }
}

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (char) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]
  ));
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Highlight matched phrases inside the escaped description. Visa phrases wear
// the posting's overall state color; research/skill phrases wear the accent.
function highlightDescription(job) {
  const source = job.description_text || '';
  if (!source) return '<p class="fit-skills">No description text captured. Open the posting to read it at the source.</p>';

  const visaClass = job.veritas_state === 'RESTRICTED' ? 'm-restricted' : 'm-friendly';
  const layers = [
    { phrases: job.matched_phrases || [], className: visaClass },
    { phrases: [...(job.research_role_language || []), ...(job.cap_exempt_language || []), ...(job.international_candidate_language || []), ...(job.fit?.matched_skills || [])], className: 'm-skill' }
  ];

  let html = escapeHtml(source);
  const seen = new Set();
  for (const { phrases, className } of layers) {
    for (const phrase of phrases) {
      const key = phrase.toLowerCase();
      if (!phrase || seen.has(key)) continue;
      seen.add(key);
      // Match against the escaped text so entities never split a phrase match
      const pattern = new RegExp(`(?![^<]*>)(${escapeRegExp(escapeHtml(phrase))})`, 'gi');
      html = html.replace(pattern, `<mark class="${className}">$1</mark>`);
    }
  }
  return html;
}

function renderDetailDescription(job) {
  const legend = el('div', 'legend-row');
  const entries = [
    [job.veritas_state === 'RESTRICTED' ? 'var(--mark-restricted)' : 'var(--mark-friendly)', 'visa language'],
    ['var(--mark-skill)', 'research / skills']
  ];
  for (const [color, label] of entries) {
    const item = el('span');
    const swatch = el('span', 'swatch');
    swatch.style.background = color;
    item.append(swatch, document.createTextNode(label));
    legend.append(item);
  }

  DOM.detailDescription.innerHTML = highlightDescription(job);
  if ((job.matched_phrases || []).length || (job.research_role_language || []).length) {
    DOM.detailDescription.prepend(legend);
  }
}

/* ------------------------------------------------------------------------ */
/* Triage                                                                    */

async function setTriage(job, status) {
  state.local.triage[job.id] = { status, updated_at: new Date().toISOString() };
  await saveLocalState();
  render();
}

/* ------------------------------------------------------------------------ */
/* Visa segmented control                                                    */

function setVisaFilter(value, { skipRender = false } = {}) {
  visaFilter = value || '';
  for (const button of DOM.visaSeg.querySelectorAll('button')) {
    button.classList.toggle('is-active', button.dataset.value === visaFilter);
  }
  if (!skipRender) render();
}

/* ------------------------------------------------------------------------ */
/* Keyboard triage                                                           */

const TRIAGE_KEYS = { s: 'shortlist', a: 'applied', e: 'emailed_lab', v: 'needs_visa_check', x: 'ignore', n: 'new' };

function handleKeydown(event) {
  const target = event.target;
  const typing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;

  if (event.key === '/' && !typing) {
    event.preventDefault();
    DOM.q.focus();
    return;
  }
  if (typing || event.metaKey || event.ctrlKey || event.altKey) return;

  const index = state.visible.findIndex((job) => job.id === state.selectedId);

  if (event.key === 'j' || event.key === 'ArrowDown') {
    event.preventDefault();
    const next = state.visible[Math.min(index + 1, state.visible.length - 1)];
    if (next) selectJob(next.id, { scroll: true });
  } else if (event.key === 'k' || event.key === 'ArrowUp') {
    event.preventDefault();
    const previous = state.visible[Math.max(index - 1, 0)];
    if (previous) selectJob(previous.id, { scroll: true });
  } else if (event.key === 'o' || event.key === 'Enter') {
    const job = selectedJob();
    if (job) window.open(job.url, '_blank', 'noreferrer');
  } else if (TRIAGE_KEYS[event.key]) {
    const job = selectedJob();
    if (job) setTriage(job, TRIAGE_KEYS[event.key]);
  } else if (event.key === 'Escape') {
    if (!DOM.discoveryPanel.hidden || !DOM.errorsPanel.hidden) {
      DOM.discoveryPanel.hidden = true;
      DOM.errorsPanel.hidden = true;
    } else if (narrowLayout.matches) {
      state.selectedId = null;
      render();
    }
  }
}

/* ------------------------------------------------------------------------ */
/* Header widgets                                                            */

function renderRefreshStatus(report) {
  if (!report) {
    DOM.refreshMeta.textContent = 'No refresh report yet — run npm run radar:refresh.';
    return;
  }
  const parts = [
    `Refreshed ${new Date(report.refreshed_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
  ];
  if (report.newly_closed_count) parts.push(`${report.newly_closed_count} newly closed`);
  DOM.refreshMeta.textContent = parts.join(' · ');

  const errored = (report.employers || []).filter((employer) => employer.error);
  if (errored.length) {
    DOM.errorsToggle.hidden = false;
    DOM.errorsToggle.querySelector('span').textContent =
      `${errored.length} source error${errored.length === 1 ? '' : 's'}`;
    DOM.errorsList.replaceChildren();
    for (const employer of errored) {
      DOM.errorsList.append(el('li', '', `${employer.name} (${employer.ats_provider}) — ${employer.error}`));
    }
  }
}

function renderDiscovery(discovery) {
  const candidates = discovery?.candidates || [];
  if (!candidates.length) return;
  DOM.discoveryToggle.hidden = false;
  DOM.discoveryToggle.querySelector('span').textContent = `${candidates.length} discovered employers`;
  DOM.discoveryList.replaceChildren();
  for (const candidate of candidates.slice(0, 60)) {
    const row = el('div', 'discovery-row');
    const head = el('div');
    head.style.display = 'flex';
    head.style.justifyContent = 'space-between';
    head.style.gap = '10px';
    head.append(el('strong', '', candidate.name), tag(`score ${candidate.score}`, 'tag-accent'));
    const badges = el('div', 'row-chips');
    if (candidate.ipeds) badges.append(tag('IPEDS', 'tag-friendly'));
    if (candidate.irs) badges.append(tag(`IRS ${candidate.irs.ntee_cd || '501c3'}`, 'tag-friendly'));
    if (candidate.dol_research_certified_3y) badges.append(tag(`DOL ${candidate.dol_research_certified_3y}`, 'tag-info'));
    if (candidate.uscis_approvals_3y) badges.append(tag(`USCIS ${candidate.uscis_approvals_3y}`, 'tag-info'));
    row.append(head, badges);
    if (candidate.dol_sample_titles?.length) {
      row.append(el('span', 'discovery-titles', candidate.dol_sample_titles.slice(0, 3).join(' · ')));
    }
    DOM.discoveryList.append(row);
  }
}

function populateSources() {
  const counts = new Map();
  for (const job of state.jobs) {
    counts.set(job.source, (counts.get(job.source) || 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  for (const [source, count] of sorted) {
    const option = document.createElement('option');
    option.value = source;
    option.textContent = `${source} (${count})`;
    DOM.source.append(option);
  }
}

/* ------------------------------------------------------------------------ */
/* Theme                                                                     */

function applyTheme(theme) {
  if (theme === 'dark' || theme === 'light') {
    document.documentElement.dataset.theme = theme;
  } else {
    delete document.documentElement.dataset.theme;
  }
}

function toggleTheme() {
  const current = document.documentElement.dataset.theme
    || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const next = current === 'dark' ? 'light' : 'dark';
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next);
}

/* ------------------------------------------------------------------------ */
/* Events + init                                                             */

function toggleDrawer(panel) {
  const isHidden = panel.hidden;
  DOM.errorsPanel.hidden = true;
  DOM.discoveryPanel.hidden = true;
  panel.hidden = !isHidden;
}

function bindDetailEvents() {
  DOM.triageSeg.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-value]');
    const job = selectedJob();
    if (button && job) setTriage(job, button.dataset.value);
  });
  DOM.detailBack.addEventListener('click', () => {
    state.selectedId = null;
    render();
  });
}

function bindEvents() {
  for (const input of [DOM.q, DOM.sort, DOM.source, DOM.newOnly, DOM.includeClosed, DOM.includeFederal, DOM.type, DOM.cap, DOM.triageFilter, DOM.minResearch]) {
    input.addEventListener('input', render);
  }

  DOM.visaSeg.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-value]');
    if (button) setVisaFilter(button.dataset.value);
  });

  DOM.resetFilters.addEventListener('click', resetFilters);
  DOM.emptyReset.addEventListener('click', resetFilters);
  DOM.filtersToggle.addEventListener('click', () => document.body.classList.toggle('show-filters'));

  DOM.resume.addEventListener('input', () => {
    state.profile = extractProfile(DOM.resume.value);
    render();
  });

  DOM.resumeFile.addEventListener('change', async () => {
    const file = DOM.resumeFile.files?.[0];
    if (!file) return;
    DOM.resume.value = await file.text();
    state.profile = extractProfile(DOM.resume.value);
    render();
  });

  DOM.clearProfile.addEventListener('click', () => {
    DOM.resume.value = '';
    DOM.resumeFile.value = '';
    state.profile = null;
    render();
  });

  DOM.errorsToggle.addEventListener('click', () => toggleDrawer(DOM.errorsPanel));
  DOM.discoveryToggle.addEventListener('click', () => toggleDrawer(DOM.discoveryPanel));
  for (const button of document.querySelectorAll('.drawer-close')) {
    button.addEventListener('click', () => {
      button.closest('.drawer').hidden = true;
    });
  }

  DOM.themeToggle.addEventListener('click', toggleTheme);
  document.addEventListener('keydown', handleKeydown);
  narrowLayout.addEventListener('change', renderDetail);

  bindDetailEvents();
}

async function init() {
  applyTheme(localStorage.getItem(THEME_KEY));
  state.lastVisit = localStorage.getItem(LAST_VISIT_KEY);
  localStorage.setItem(LAST_VISIT_KEY, new Date().toISOString());
  hydrateFromUrl();

  const [jobs, employers, local, report, discovery] = await Promise.all([
    getJson('/api/jobs', []),
    getJson('/api/employers', []),
    getJson('/api/local-state', { version: 1, triage: {} }),
    getJson('/api/refresh-report', null),
    getJson('/api/discovery', { candidates: [] })
  ]);
  state.jobs = jobs;
  state.employers = employers;
  state.local = local;
  populateSources();
  // Source options only exist now, so re-apply the source filter from the URL
  const sourceParam = new URLSearchParams(window.location.search).get('source');
  if (sourceParam) DOM.source.value = sourceParam;
  renderStats();
  renderRefreshStatus(report);
  renderDiscovery(discovery);
  bindEvents();

  // Preselect the first job on wide screens so the detail pane is never empty
  render();
  if (!narrowLayout.matches && state.visible.length && !state.selectedId) {
    selectJob(state.visible[0].id);
  }
}

init();
