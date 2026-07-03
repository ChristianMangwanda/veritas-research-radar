const state = {
  jobs: [],
  employers: [],
  local: { version: 1, triage: {} },
  profile: null
};

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
  q: document.querySelector('#q'),
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
  if (/\b(phd|ph\.d|doctorate)\b/i.test(text) && !state.profile.degrees.includes('phd')) score -= 18;
  if (job.veritas_state === 'RESTRICTED') score -= 35;
  score = Math.max(0, Math.min(100, score));
  const fit_summary = `${score >= 75 ? 'Strong' : score >= 50 ? 'Possible' : 'Weak'} fit: ${matchedSkills.length} matching skills, ${matchedDomains.length} matching domains. Verify visa language before applying.`;
  return { fit_score: score, matched_skills: matchedSkills, missing_skills: missingSkills, fit_summary };
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

function filteredJobs() {
  const query = DOM.q.value.trim().toLowerCase();
  const visa = DOM.visa.value;
  const type = DOM.type.value;
  const cap = DOM.cap.value;
  const triage = DOM.triageFilter.value;
  const minResearch = Number(DOM.minResearch.value);

  return state.jobs
    .map((job) => ({ ...job, fit: scoreFit(job) }))
    .filter((job) => !query || jobText(job).includes(query))
    .filter((job) => !visa || job.veritas_state === visa)
    .filter((job) => !type || job.employer_type === type)
    .filter((job) => !cap || job.cap_exempt_status === cap)
    .filter((job) => !triage || triageFor(job) === triage)
    .filter((job) => Number(job.research_relevance_score || 0) >= minResearch)
    .sort((a, b) => {
      const fitA = a.fit.fit_score ?? -1;
      const fitB = b.fit.fit_score ?? -1;
      if (fitA !== fitB) return fitB - fitA;
      return (b.research_relevance_score || 0) - (a.research_relevance_score || 0);
    });
}

function render() {
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
    badges.append(
      badge(job.veritas_state, job.veritas_state.toLowerCase()),
      badge(`cap-exempt: ${job.cap_exempt_status}`, job.cap_exempt_status),
      badge(`sponsor: ${job.sponsor_signal}`, job.sponsor_signal),
      badge(`research ${job.research_relevance_score || 0}`)
    );
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
  for (const input of [DOM.q, DOM.visa, DOM.type, DOM.cap, DOM.triageFilter, DOM.minResearch]) {
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

async function init() {
  const [jobs, employers, local, report] = await Promise.all([
    getJson('/api/jobs', []),
    getJson('/api/employers', []),
    getJson('/api/local-state', { version: 1, triage: {} }),
    getJson('/api/refresh-report', null)
  ]);
  state.jobs = jobs;
  state.employers = employers;
  state.local = local;
  DOM.refreshMeta.textContent = report
    ? `Last refresh ${new Date(report.refreshed_at).toLocaleString()} · ${report.job_count} jobs · ${report.errored_employers} source errors`
    : 'No refresh report yet. Run npm run radar:refresh.';
  bindEvents();
  render();
}

init();
