const state = {
  jobs: [],
  employers: [],
  local: { version: 1, triage: {} },
  profile: null,
  lastVisit: null
};

const LAST_VISIT_KEY = 'veritas_radar_last_visit';

// Closed postings with these triage states stay visible so an applied-to job
// that disappears from the ATS is flagged rather than silently hidden
const PROTECTED_TRIAGE = new Set(['shortlist', 'applied', 'emailed_lab', 'needs_visa_check']);

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
  refreshMeta: document.querySelector('#refresh-meta'),
  refreshErrors: document.querySelector('#refresh-errors'),
  discovery: document.querySelector('#discovery'),
  q: document.querySelector('#q'),
  sort: document.querySelector('#sort'),
  source: document.querySelector('#source'),
  newOnly: document.querySelector('#new-only'),
  includeClosed: document.querySelector('#include-closed'),
  visa: document.querySelector('#visa'),
  type: document.querySelector('#type'),
  cap: document.querySelector('#cap'),
  triageFilter: document.querySelector('#triage-filter'),
  minResearch: document.querySelector('#min-research'),
  minResearchValue: document.querySelector('#min-research-value'),
  resume: document.querySelector('#resume'),
  resumeFile: document.querySelector('#resume-file'),
  clearProfile: document.querySelector('#clear-profile'),
  template: document.querySelector('#job-card-template')
};

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

function extractProfile(text) {
  const lower = text.toLowerCase();
  const skills = SKILLS.filter((skill) => lower.includes(skill));
  const degrees = [];
  if (/\b(ph\.?d|doctorate|doctoral)\b/i.test(text)) degrees.push('phd');
  if (/\b(master|m\.s\.|msc|m\.sc)\b/i.test(text)) degrees.push('masters');
  if (/\b(bachelor|b\.s\.|bsc|b\.sc)\b/i.test(text)) degrees.push('bachelors');

  const domains = [];
  for (const domain of ['bioinformatics', 'genomics', 'computational biology', 'data science', 'machine learning', 'clinical research', 'software engineering']) {
    if (lower.includes(domain)) domains.push(domain);
  }

  return { skills, degrees, domains, rawLength: text.trim().length };
}

function jobText(job) {
  return `${job.title} ${job.department} ${job.employer_name} ${job.description_text}`.toLowerCase();
}

function scoreFit(job) {
  if (!state.profile || state.profile.rawLength < 50) {
    return { fit_score: null, matched_skills: [], missing_skills: [], fit_summary: 'Paste resume text to compute local fit.' };
  }
  const text = jobText(job);
  const matchedSkills = state.profile.skills.filter((skill) => text.includes(skill));
  const missingSkills = state.profile.skills.filter((skill) => !text.includes(skill)).slice(0, 6);
  const matchedDomains = state.profile.domains.filter((domain) => text.includes(domain));
  let score = 20;
  score += Math.min(matchedSkills.length * 8, 40);
  score += Math.min(matchedDomains.length * 12, 24);
  score += Math.round((job.research_relevance_score || 0) * 0.16);
  score += phdPenalty(text);
  if (job.veritas_state === 'RESTRICTED') score -= 35;
  score = Math.max(0, Math.min(100, score));
  const fit_summary = `${score >= 75 ? 'Strong' : score >= 50 ? 'Possible' : 'Weak'} fit: ${matchedSkills.length} matching skills, ${matchedDomains.length} matching domains. Verify visa language before applying.`;
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

function isNewSinceLastVisit(job) {
  return Boolean(state.lastVisit && job.first_seen_at && job.first_seen_at > state.lastVisit);
}

function badge(text, kind = '') {
  const span = document.createElement('span');
  span.className = `badge ${kind}`.trim();
  span.textContent = text;
  return span;
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
  const visa = DOM.visa.value;
  const type = DOM.type.value;
  const cap = DOM.cap.value;
  const triage = DOM.triageFilter.value;
  const minResearch = Number(DOM.minResearch.value);
  const sorter = SORTERS[DOM.sort.value] || SORTERS.fit;

  const source = DOM.source.value;
  return state.jobs
    .map((job) => ({ ...job, fit: scoreFit(job) }))
    .filter((job) => !isClosed(job) || DOM.includeClosed.checked || PROTECTED_TRIAGE.has(triageFor(job)))
    .filter((job) => !DOM.newOnly.checked || isNewSinceLastVisit(job))
    .filter((job) => !source || job.source === source)
    .filter((job) => !query || jobText(job).includes(query))
    .filter((job) => !visa || job.veritas_state === visa)
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

function syncUrl() {
  const params = new URLSearchParams();
  if (DOM.q.value.trim()) params.set('q', DOM.q.value.trim());
  if (DOM.sort.value !== 'fit') params.set('sort', DOM.sort.value);
  if (DOM.source.value) params.set('source', DOM.source.value);
  if (DOM.newOnly.checked) params.set('newOnly', '1');
  if (DOM.includeClosed.checked) params.set('includeClosed', '1');
  if (DOM.visa.value) params.set('visa', DOM.visa.value);
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
  if (params.has('visa')) DOM.visa.value = params.get('visa');
  if (params.has('type')) DOM.type.value = params.get('type');
  if (params.has('cap')) DOM.cap.value = params.get('cap');
  if (params.has('triage')) DOM.triageFilter.value = params.get('triage');
  if (params.has('minResearch')) DOM.minResearch.value = params.get('minResearch');
  if (params.has('source')) DOM.source.value = params.get('source');
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

function render() {
  syncUrl();
  DOM.minResearchValue.textContent = DOM.minResearch.value;
  const jobs = filteredJobs();
  DOM.count.textContent = `${jobs.length} job${jobs.length === 1 ? '' : 's'}`;
  DOM.jobs.replaceChildren();

  for (const job of jobs) {
    const node = DOM.template.content.firstElementChild.cloneNode(true);
    node.querySelector('h2').textContent = job.title;
    node.querySelector('.meta').textContent = `${job.employer_name} · ${job.location || 'Unspecified'} · ${job.department || 'No department'}`;
    const link = node.querySelector('.apply');
    link.href = job.url;
    link.textContent = 'Open role';

    const badges = node.querySelector('.badges');
    if (isNewSinceLastVisit(job)) badges.append(badge('NEW', 'new'));
    if (isClosed(job)) {
      node.classList.add('job-card--closed');
      const protectedTriage = PROTECTED_TRIAGE.has(triageFor(job));
      badges.append(badge(protectedTriage ? 'posting closed — verify status' : 'closed', protectedTriage ? 'weak' : 'closed'));
    }
    badges.append(
      badge(job.veritas_state, job.veritas_state.toLowerCase()),
      badge(`cap-exempt: ${job.cap_exempt_status}`, job.cap_exempt_status),
      badge(`sponsor: ${job.sponsor_signal}`, job.sponsor_signal),
      badge(`research ${job.research_relevance_score || 0}`)
    );
    if (typeof job.cap_exempt_score === 'number' && job.cap_exempt_score > 0) {
      badges.append(badge(`cap-exempt score ${job.cap_exempt_score}`, job.cap_exempt_score >= 55 ? 'strong' : 'moderate'));
    }
    badges.append(badge(job.source, 'source'));
    if (job.cap_exempt_language?.length) badges.append(badge('cap-exempt language', 'likely'));
    if (job.international_candidate_language?.length) badges.append(badge('international language', 'moderate'));

    node.querySelector('.fit').textContent = job.fit.fit_score === null ? job.fit.fit_summary : `Fit ${job.fit.fit_score}: ${job.fit.fit_summary}`;
    node.querySelector('.description').textContent = `${job.description_text || ''}`.slice(0, 420);
    const matched = [
      ...(job.matched_phrases || []),
      ...(job.research_role_language || []),
      ...(job.fit.matched_skills || [])
    ];
    node.querySelector('.matches').textContent = matched.length ? `Matched: ${[...new Set(matched)].slice(0, 10).join(', ')}` : 'No matched phrases recorded.';

    const select = node.querySelector('.triage select');
    select.value = triageFor(job);
    select.addEventListener('change', async () => {
      state.local.triage[job.id] = {
        status: select.value,
        updated_at: new Date().toISOString()
      };
      await saveLocalState();
      render();
    });

    DOM.jobs.append(node);
  }
}

function bindEvents() {
  for (const input of [DOM.q, DOM.sort, DOM.source, DOM.newOnly, DOM.includeClosed, DOM.visa, DOM.type, DOM.cap, DOM.triageFilter, DOM.minResearch]) {
    input.addEventListener('input', render);
  }

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
}

function renderRefreshStatus(report) {
  if (!report) {
    DOM.refreshMeta.textContent = 'No refresh report yet. Run npm run radar:refresh.';
    return;
  }
  const parts = [
    `Last refresh ${new Date(report.refreshed_at).toLocaleString()}`,
    `${report.active_job_count ?? report.job_count} active jobs`,
    `${report.errored_employers} source errors`
  ];
  if (report.newly_closed_count) parts.push(`${report.newly_closed_count} newly closed`);
  DOM.refreshMeta.textContent = parts.join(' · ');

  const errored = (report.employers || []).filter((employer) => employer.error);
  if (errored.length) {
    DOM.refreshErrors.hidden = false;
    DOM.refreshErrors.querySelector('summary').textContent = `${errored.length} source error${errored.length === 1 ? '' : 's'} on last refresh`;
    const list = DOM.refreshErrors.querySelector('ul');
    list.replaceChildren();
    for (const employer of errored) {
      const item = document.createElement('li');
      item.textContent = `${employer.name} (${employer.ats_provider}) — ${employer.error}`;
      list.append(item);
    }
  }
}

function renderDiscovery(discovery) {
  const candidates = discovery?.candidates || [];
  if (!candidates.length) return;
  DOM.discovery.hidden = false;
  DOM.discovery.querySelector('summary').textContent =
    `${candidates.length} discovered cap-exempt employer candidate${candidates.length === 1 ? '' : 's'}`;
  const list = DOM.discovery.querySelector('.discovery-list');
  list.replaceChildren();
  for (const candidate of candidates.slice(0, 50)) {
    const row = document.createElement('div');
    row.className = 'discovery-row';
    const title = document.createElement('strong');
    title.textContent = candidate.name;
    const badges = document.createElement('span');
    badges.className = 'badges';
    badges.append(badge(`score ${candidate.score}`));
    if (candidate.ipeds) badges.append(badge('IPEDS', 'likely'));
    if (candidate.irs) badges.append(badge(`IRS ${candidate.irs.ntee_cd || '501c3'}`, 'likely'));
    if (candidate.dol_research_certified_3y) badges.append(badge(`DOL ${candidate.dol_research_certified_3y}`, 'moderate'));
    if (candidate.uscis_approvals_3y) badges.append(badge(`USCIS ${candidate.uscis_approvals_3y}`, 'moderate'));
    row.append(title, badges);
    if (candidate.dol_sample_titles?.length) {
      const titles = document.createElement('span');
      titles.className = 'discovery-titles';
      titles.textContent = candidate.dol_sample_titles.slice(0, 3).join(' · ');
      row.append(titles);
    }
    list.append(row);
  }
}

async function init() {
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
  renderRefreshStatus(report);
  renderDiscovery(discovery);
  bindEvents();
  render();
}

init();
