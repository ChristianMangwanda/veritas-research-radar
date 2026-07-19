const state = {
  jobs: [],
  employers: [],
  local: { version: 1, triage: {} },
  profile: null,      // profile.json v2 (user's own resume variants)
  compiled: null,     // RadarScoring.compileProfile(profile)
  routeCache: null,   // local Ollama routing verdicts (route-cache.json)
  profileError: null, // validation message when an import is rejected
  loadError: null,    // set when the job load partially/fully failed (distinct from "no matches")
  lastVisit: null,
  selectedId: null,
  visible: []
};

const LAST_VISIT_KEY = 'veritas_radar_last_visit';
const THEME_KEY = 'veritas_radar_theme';

// Full triage funnel, ordered new → shortlisted → outreach → applied →
// interview → outcome. The segmented control and triage filter are both built
// from this order, so adding a state here surfaces it everywhere.
const TRIAGE_LABELS = {
  new: 'New',
  shortlist: 'Shortlist',
  emailed_lab: 'Emailed lab',
  needs_visa_check: 'Visa check',
  applied: 'Applied',
  interview: 'Interview',
  offer: 'Offer',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
  ignore: 'Ignore'
};

const TRIAGE_COLORS = {
  new: 'var(--info-ink)',
  shortlist: 'var(--accent)',
  emailed_lab: 'var(--info-ink)',
  needs_visa_check: 'var(--warn-ink)',
  applied: 'var(--friendly-ink)',
  interview: 'var(--accent)',
  offer: 'var(--friendly-ink)',
  rejected: 'var(--faint)',
  withdrawn: 'var(--faint)',
  ignore: 'var(--faint)'
};

// Closed postings in these states stay visible so a job you're pursuing that
// disappears from the ATS is flagged rather than silently hidden.
const PROTECTED_TRIAGE = new Set(['shortlist', 'emailed_lab', 'needs_visa_check', 'applied', 'interview', 'offer']);

// States that represent a live application awaiting a response — the ones a
// follow-up-aging view (1.5) tracks by how long they've sat without a change.
const IN_FLIGHT_TRIAGE = new Set(['emailed_lab', 'needs_visa_check', 'applied', 'interview']);

// Days without a status change before an in-flight job is "needs follow-up".
const FOLLOWUP_STALE_DAYS = 7;

const VISA_LABELS = { FRIENDLY: 'Friendly', RESTRICTED: 'Restricted', NEUTRAL: 'No visa language' };
const VISA_TAGS = { FRIENDLY: 'tag-friendly', RESTRICTED: 'tag-restricted', NEUTRAL: '' };

const VERDICT_TAGS = { strong: 'tag-friendly', good: 'tag-accent', moderate: '', weak: 'tag-warn', stretch: 'tag-warn' };

// One stable color per resume variant, assigned by manifest order
const VARIANT_COLORS = ['#7c6ff0', '#2f9e8f', '#d97740', '#c65b8a', '#5b8ac6', '#a3a34a', '#8a6d5b', '#5aa869'];

const DOM = {
  jobs: document.querySelector('#jobs'),
  count: document.querySelector('#count'),
  filtersToggle: document.querySelector('#filters-toggle'),
  emptyState: document.querySelector('#empty-state'),
  emptyReset: document.querySelector('#empty-reset'),
  loadError: document.querySelector('#load-error'),
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
  followupOnly: document.querySelector('#followup-only'),
  remoteOnly: document.querySelector('#remote-only'),
  markSeen: document.querySelector('#mark-seen'),
  includeClosed: document.querySelector('#include-closed'),
  includeFederal: document.querySelector('#include-federal'),
  type: document.querySelector('#type'),
  cap: document.querySelector('#cap'),
  triageFilter: document.querySelector('#triage-filter'),
  minResearch: document.querySelector('#min-research'),
  minResearchValue: document.querySelector('#min-research-value'),
  resetFilters: document.querySelector('#reset-filters'),
  profileSummary: document.querySelector('#profile-summary'),
  profileFile: document.querySelector('#profile-file'),
  routeFile: document.querySelector('#route-file'),
  clearProfile: document.querySelector('#clear-profile'),
  syncToken: document.querySelector('#sync-token'),
  syncSave: document.querySelector('#sync-save'),
  syncClear: document.querySelector('#sync-clear'),
  syncStatus: document.querySelector('#sync-status'),
  rowTemplate: document.querySelector('#job-row-template'),
  detailPane: document.querySelector('#detail-pane'),
  detailScroll: document.querySelector('.detail-scroll'),
  detailBack: document.querySelector('#detail-back'),
  detailTitle: document.querySelector('#detail-title'),
  detailMeta: document.querySelector('#detail-meta'),
  detailOpen: document.querySelector('#detail-open'),
  triageSeg: document.querySelector('#triage-seg'),
  detailNote: document.querySelector('#detail-note'),
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

// On GitHub Pages there is no API server: jobs and the refresh report read
// live from Supabase (anon key is public by design; RLS is read-only), other
// endpoints fall back to static JSON copies, and triage state falls back to
// localStorage. The same bundle serves both environments.
const SUPABASE_URL = 'https://nawbdsujjysugaisczta.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_7GXYKvqrAMSfxwPX-0NKyA_CSO2Sz2T';

const STATIC_DATA = {
  '/api/employers': 'data/employers.json',
  '/api/discovery': 'data/discovery-candidates.json'
};

async function supabaseGet(pathname) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1${pathname}`, {
    headers: { apikey: SUPABASE_ANON_KEY, authorization: `Bearer ${SUPABASE_ANON_KEY}` }
  });
  if (!response.ok) throw new Error(`supabase ${response.status}`);
  return response.json();
}

async function tryJson(url) {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

async function loadJobs() {
  state.loadError = null;
  // An empty local file (fresh clone — jobs.json is untracked now) must not
  // shadow the live database
  const local = await tryJson('/api/jobs');
  if (Array.isArray(local) && local.length) return local;
  try {
    // Count first, then fetch pages concurrently — but bounded. A full
    // parallel burst (10 concurrent deep-offset scans of a ~44MB table)
    // makes Supabase 500 the high-offset pages and the dashboard loaded 0
    // jobs; 3 at a time with one retry per page is reliably fast instead.
    const pageSize = 1000;
    const head = await fetch(`${SUPABASE_URL}/rest/v1/jobs?select=id`, {
      headers: { apikey: SUPABASE_ANON_KEY, prefer: 'count=exact', range: '0-0' }
    });
    const total = Number((head.headers.get('content-range') || '').split('/')[1] || 0);
    if (total > 0) {
      const pageCount = Math.ceil(total / pageSize);
      const pages = new Array(pageCount).fill(null);
      let nextPage = 0;
      let failedPages = 0;
      const fetchPage = async (page) => {
        const query = `/jobs?select=payload&order=id&limit=${pageSize}&offset=${page * pageSize}`;
        try {
          return await supabaseGet(query);
        } catch {
          return supabaseGet(query);
        }
      };
      await Promise.all(Array.from({ length: Math.min(3, pageCount) }, async () => {
        while (nextPage < pageCount) {
          const page = nextPage;
          nextPage += 1;
          try {
            pages[page] = await fetchPage(page);
          } catch {
            // One flaky page must not zero out the dashboard — keep every page
            // that did load and report the gap instead of failing the whole load.
            pages[page] = [];
            failedPages += 1;
          }
        }
      }));
      const jobs = pages.flat().map((row) => row.payload);
      if (jobs.length) {
        if (failedPages) {
          state.loadError = `Showing ${jobs.length.toLocaleString()} of ~${total.toLocaleString()} jobs — `
            + `${failedPages} data page${failedPages === 1 ? '' : 's'} failed to load. Refresh to try again.`;
        }
        return jobs;
      }
      // Every page failed: fall through to the committed file rather than
      // returning an empty list that reads as "no jobs".
    }
  } catch { /* fall through */ }
  const fallback = (await tryJson('data/jobs.json')) || [];
  if (!fallback.length) {
    state.loadError = 'Could not load jobs from the database. Check your connection and refresh.';
  }
  return fallback;
}

async function loadRefreshReport() {
  const local = await tryJson('/api/refresh-report');
  if (local) return local;
  try {
    const rows = await supabaseGet('/refresh_runs?select=report&order=refreshed_at.desc&limit=1');
    if (rows[0]?.report) return rows[0].report;
  } catch { /* fall through */ }
  return tryJson('data/refresh-report.json');
}

const LOCAL_TRIAGE_KEY = 'veritas_radar_local_state';

async function getJson(url, fallback) {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return response.json();
  } catch {
    const staticPath = STATIC_DATA[url];
    if (staticPath) {
      try {
        const response = await fetch(staticPath);
        if (response.ok) return response.json();
      } catch { /* fall through */ }
    }
    return fallback;
  }
}

function loadTriageFromBrowser() {
  try {
    const stored = JSON.parse(localStorage.getItem(LOCAL_TRIAGE_KEY));
    if (stored && typeof stored.triage === 'object') return stored;
  } catch { /* corrupted -> fresh */ }
  return { version: 1, triage: {} };
}

async function saveLocalState() {
  try {
    const response = await fetch('/api/local-state', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ triage: state.local.triage })
    });
    if (!response.ok) throw new Error(String(response.status));
  } catch {
    localStorage.setItem(LOCAL_TRIAGE_KEY, JSON.stringify({ version: 1, triage: state.local.triage }));
  }
}

/* ------------------------------------------------------------------------ */
/* Cross-device triage sync (1.2). Optional and off until you paste a sync   */
/* token (Settings → Sync); absent token = today's local-only behavior.      */
/* The token gates two SECURITY DEFINER RPCs — radar_get_triage /            */
/* radar_upsert_triage — so the public anon key alone can neither read nor    */
/* write your triage. Setup + SQL: radar/supabase/triage.sql.                 */

const SYNC_TOKEN_KEY = 'veritas_radar_sync_token';

const triageSync = {
  token() {
    try { return localStorage.getItem(SYNC_TOKEN_KEY) || ''; } catch { return ''; }
  },
  enabled() {
    return Boolean(this.token());
  },
  async rpc(fn, args) {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_ANON_KEY,
        authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify(args)
    });
    if (!response.ok) throw new Error(`sync ${fn}: ${response.status} ${response.statusText}`);
    return response.json();
  },
  async pull() {
    if (!this.enabled()) return null;
    const rows = await this.rpc('radar_get_triage', { p_token: this.token() });
    const triage = {};
    for (const row of rows || []) {
      const record = { status: row.status, updated_at: row.updated_at };
      if (row.note) record.note = row.note;
      if (row.applied_at) record.applied_at = row.applied_at;
      triage[row.job_id] = record;
    }
    return triage;
  },
  async push() {
    if (!this.enabled()) return;
    const rows = Object.entries(state.local.triage).map(([jobId, record]) => ({
      job_id: jobId,
      status: record.status,
      note: record.note ?? null,
      applied_at: record.applied_at ?? null,
      updated_at: record.updated_at || new Date().toISOString()
    }));
    await this.rpc('radar_upsert_triage', { p_token: this.token(), p_rows: rows });
  }
};

function renderSyncStatus(message) {
  if (!DOM.syncStatus) return;
  DOM.syncStatus.textContent = message
    || (triageSync.enabled() ? 'On — triage syncs across your devices.' : 'Off — triage stays on this device only.');
  if (DOM.syncToken) DOM.syncToken.value = triageSync.token();
}

async function saveSyncToken() {
  const token = (DOM.syncToken.value || '').trim();
  if (!token) {
    renderSyncStatus('Enter a token first, or use Turn off.');
    return;
  }
  localStorage.setItem(SYNC_TOKEN_KEY, token);
  renderSyncStatus('Syncing…');
  try {
    const remote = await triageSync.pull(); // validates the token as a side effect
    if (remote) {
      state.local.triage = mergeTriage(state.local.triage, remote);
      await saveLocalState();
    }
    await triageSync.push();
    renderSyncStatus('On — synced across your devices.');
    render();
  } catch (error) {
    // Bad token / unreachable: don't leave a broken token enabled.
    localStorage.removeItem(SYNC_TOKEN_KEY);
    renderSyncStatus(`Sync failed (${error.message}). Check the token and setup.`);
  }
}

function clearSyncToken() {
  localStorage.removeItem(SYNC_TOKEN_KEY);
  if (DOM.syncToken) DOM.syncToken.value = '';
  renderSyncStatus();
}

// Last-write-wins per job by updated_at — merges a remote triage map into a
// local one without losing either side's newer edits.
function mergeTriage(local, remote) {
  const merged = { ...(local || {}) };
  for (const [jobId, record] of Object.entries(remote || {})) {
    const current = merged[jobId];
    if (!current || String(record.updated_at || '') > String(current.updated_at || '')) {
      merged[jobId] = record;
    }
  }
  return merged;
}

// One place every triage mutation persists through: local first (always), then
// best-effort push to Supabase when sync is on. A failed push never blocks the
// UI — the local write already succeeded and the next change retries.
async function persistTriage() {
  await saveLocalState();
  if (triageSync.enabled()) {
    try {
      await triageSync.push();
    } catch (error) {
      console.warn(`Triage sync push failed (kept locally): ${error.message}`);
    }
  }
}

/* ------------------------------------------------------------------------ */
/* Resume-variant profile (all local; built by npm run radar:profile from    */
/* the user's OWN resumes — nothing here generates resume content)           */

const PROFILE_KEY = 'veritas_radar_profile';
const ROUTE_CACHE_KEY = 'veritas_radar_route_cache';

function jobText(job) {
  return `${job.title} ${job.department} ${job.employer_name} ${job.description_text}`.toLowerCase();
}

function loadProfileFromBrowser() {
  try {
    const stored = JSON.parse(localStorage.getItem(PROFILE_KEY));
    if (stored && !RadarScoring.validateProfile(stored)) return stored;
  } catch { /* corrupted -> none */ }
  return null;
}

function loadRouteCacheFromBrowser() {
  try {
    const stored = JSON.parse(localStorage.getItem(ROUTE_CACHE_KEY));
    if (stored && typeof stored.verdicts === 'object') return stored;
  } catch { /* corrupted -> none */ }
  return null;
}

// Compile + score exactly once per profile/route-cache change (9k jobs x
// variants is far too much work to redo per keystroke); rows read the
// pre-stamped job.fit afterwards.
function applyProfile(profile, routeCache) {
  state.profile = profile || null;
  state.routeCache = routeCache || null;
  state.compiled = profile ? RadarScoring.compileProfile(profile) : null;
  RadarScoring.scoreAll(state.jobs, state.compiled, state.routeCache);
  renderProfileCard();
}

function variantColor(variantId) {
  const index = (state.profile?.variants || []).findIndex((variant) => variant.id === variantId);
  return VARIANT_COLORS[(index >= 0 ? index : 0) % VARIANT_COLORS.length];
}

function variantAbbrev(variantId) {
  return String(variantId || '').toUpperCase().slice(0, 6);
}

function variantDot(variantId) {
  const dot = el('span', 'variant-dot');
  dot.style.background = variantColor(variantId);
  return dot;
}

function renderProfileCard() {
  DOM.profileSummary.replaceChildren();

  if (state.profileError) {
    DOM.profileSummary.append(el('p', 'profile-error', state.profileError));
  }

  if (!state.profile) {
    DOM.profileSummary.append(el('p', 'profile-empty',
      'No profile loaded. Build one locally from your resumes with npm run radar:profile — the local dashboard picks it up on reload; on the hosted dashboard, import profile.json here.'));
    return;
  }

  const core = state.profile.core || {};
  const degrees = (core.degrees || [])
    .map((degree) => `${degree.level}${degree.status === 'in_progress' ? '*' : ''}`)
    .join(', ');
  DOM.profileSummary.append(el('p', 'profile-core',
    [degrees || null, (core.career_stage || '').replace(/_/g, ' ') || null,
      Number.isFinite(core.years_experience) ? `${core.years_experience} yrs` : null]
      .filter(Boolean).join(' · ')));

  const list = el('ul', 'profile-variants');
  for (const variant of state.profile.variants) {
    const item = el('li');
    item.append(
      variantDot(variant.id),
      el('span', 'variant-abbrev', variantAbbrev(variant.id)),
      el('span', 'variant-label', variant.label),
      el('span', 'variant-terms', `${(variant.skills || []).length} terms`)
    );
    item.title = variant.intent || '';
    list.append(item);
  }
  DOM.profileSummary.append(list);

  if (state.routeCache && state.compiled && state.routeCache.profile_hash !== state.compiled.hash) {
    DOM.profileSummary.append(el('p', 'profile-error',
      'Route verdicts were decided against an older profile and are ignored — re-run npm run radar:route.'));
  } else if (state.routeCache && state.compiled) {
    const count = Object.keys(state.routeCache.verdicts || {}).length;
    DOM.profileSummary.append(el('p', 'profile-routing',
      `${count} routing verdict${count === 1 ? '' : 's'} from ${state.routeCache.model || 'local model'}`));
  }
}

/* ------------------------------------------------------------------------ */
/* Filtering + sorting                                                       */

function isNewSinceLastVisit(job) {
  return Boolean(state.lastVisit && job.first_seen_at && job.first_seen_at > state.lastVisit);
}

function triageRecord(job) {
  return state.local.triage[job.id] || null;
}

function triageFor(job) {
  return triageRecord(job)?.status || 'new';
}

function noteFor(job) {
  return triageRecord(job)?.note || '';
}

// Days since the last status change, for jobs awaiting a response. Uses the
// already-stored updated_at (stamped whenever the status changes), so a job
// left in "applied" surfaces its own staleness. Non-in-flight jobs return null.
function followupAgeDays(job) {
  const record = triageRecord(job);
  if (!record || !IN_FLIGHT_TRIAGE.has(record.status)) return null;
  const since = Date.parse(record.updated_at || '');
  if (!Number.isFinite(since)) return null;
  return Math.floor((Date.now() - since) / (24 * 60 * 60 * 1000));
}

function needsFollowup(job) {
  const age = followupAgeDays(job);
  return age !== null && age >= FOLLOWUP_STALE_DAYS;
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
  },
  evidence(a, b) {
    const delta = (b.class_evidence?.certified_count_3y || 0) - (a.class_evidence?.certified_count_3y || 0);
    if (delta !== 0) return delta;
    return (b.dol_lca_certified_count_3y || 0) - (a.dol_lca_certified_count_3y || 0) || SORTERS.fit(a, b);
  },
  salary(a, b) {
    const sa = a.salary_max ?? a.salary_min ?? -1;
    const sb = b.salary_max ?? b.salary_min ?? -1;
    if (sa !== sb) return sb - sa;
    return SORTERS.fit(a, b);
  },
  closing(a, b) {
    // Nearest upcoming deadline first; past/none sink to the bottom.
    const da = deadlineDays(a);
    const db = deadlineDays(b);
    const fa = da !== null && da >= 0 ? da : Infinity;
    const fb = db !== null && db >= 0 ? db : Infinity;
    if (fa !== fb) return fa - fb;
    return SORTERS.fit(a, b);
  },
  followup(a, b) {
    // In-flight applications first, stalest (oldest last-change) on top; other
    // jobs fall below, ranked by fit.
    const ageA = followupAgeDays(a);
    const ageB = followupAgeDays(b);
    if (ageA === null && ageB === null) return SORTERS.fit(a, b);
    if (ageA === null) return 1;
    if (ageB === null) return -1;
    return ageB - ageA;
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

  // job.fit is pre-stamped by applyProfile()/scoreAll() — never computed here
  return state.jobs
    .filter((job) => !job.citizenship_gated || DOM.includeFederal.checked)
    .filter((job) => !isClosed(job) || DOM.includeClosed.checked || PROTECTED_TRIAGE.has(triageFor(job)))
    .filter((job) => !DOM.newOnly.checked || isNewSinceLastVisit(job))
    .filter((job) => !DOM.followupOnly.checked || needsFollowup(job))
    .filter((job) => !DOM.remoteOnly.checked || job.remote === true)
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
  if (DOM.followupOnly.checked) count += 1;
  if (DOM.remoteOnly.checked) count += 1;
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
  DOM.followupOnly.checked = false;
  DOM.remoteOnly.checked = false;
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
  if (DOM.followupOnly.checked) params.set('followup', '1');
  if (DOM.remoteOnly.checked) params.set('remote', '1');
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
  DOM.followupOnly.checked = params.get('followup') === '1';
  DOM.remoteOnly.checked = params.get('remote') === '1';
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

function deadlineDays(job) {
  if (!job.deadline) return null;
  const end = Date.parse(`${job.deadline}T23:59:59`);
  if (!Number.isFinite(end)) return null;
  return Math.ceil((end - Date.now()) / (24 * 60 * 60 * 1000));
}

function formatDeadline(job) {
  const n = deadlineDays(job);
  if (n === null || n < 0) return null; // no deadline, or already past
  if (n === 0) return 'closes today';
  if (n <= 14) return `closes in ${n}d`;
  const dt = new Date(`${job.deadline}T00:00:00`);
  return `closes ${dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
}

function formatSalary(job) {
  if (job.salary_min == null) return null;
  const k = (n) => (n >= 1000 ? `$${Math.round(n / 1000)}K` : `$${n}`);
  const range = job.salary_max && job.salary_max !== job.salary_min
    ? `${k(job.salary_min)}–${k(job.salary_max)}`
    : k(job.salary_min);
  // salary_min/max are annualized; a 'hour' period means the source was hourly.
  return job.salary_period === 'hour' ? `${range}/yr (hrly)` : `${range}/yr`;
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

  // "Mark all as seen" only appears when there's actually something new to clear
  const newCount = state.jobs.filter(isNewSinceLastVisit).length;
  DOM.markSeen.hidden = newCount === 0;
  DOM.markSeen.textContent = `Mark all as seen (${newCount})`;

  const filters = activeFilterCount();
  DOM.resetFilters.hidden = filters === 0;
  DOM.resetFilters.querySelector('span').textContent = `(${filters})`;
  DOM.filtersToggle.querySelector('span').textContent = filters ? `(${filters})` : '';

  const jobs = filteredJobs();
  state.visible = jobs;
  DOM.count.textContent = `${jobs.length} job${jobs.length === 1 ? '' : 's'}`;
  if (DOM.loadError) {
    DOM.loadError.hidden = !state.loadError;
    if (state.loadError) DOM.loadError.textContent = state.loadError;
  }
  // A hard load failure (zero rows loaded) is not "no filter matches" — show
  // the error banner instead of the empty-state hint. A *partial* load still
  // has rows, so filtering down to zero should show the normal hint with the
  // banner above it.
  const hardLoadFailure = state.jobs.length === 0 && Boolean(state.loadError);
  DOM.emptyState.hidden = jobs.length > 0 || hardLoadFailure;
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
  const age = followupAgeDays(job);
  if (age !== null) {
    const stale = age >= FOLLOWUP_STALE_DAYS;
    const text = stale ? `⏳ ${age}d, no update`
      : age === 0 ? 'updated today'
        : `${age}d ago`;
    chips.append(tag(text, stale ? 'tag-warn' : ''));
  }
  if (noteFor(job)) chips.append(tag('📝 note', ''));
  const salaryText = formatSalary(job);
  if (salaryText) chips.append(tag(salaryText, 'tag-friendly'));
  const deadlineText = formatDeadline(job);
  if (deadlineText) {
    const soon = (deadlineDays(job) ?? 99) <= 7;
    chips.append(tag(`⏱ ${deadlineText}`, soon ? 'tag-warn' : ''));
  }
  if (isNewSinceLastVisit(job)) chips.append(tag('NEW', 'tag-info'));
  if (isClosed(job)) {
    node.classList.add('is-closed');
    chips.append(tag(PROTECTED_TRIAGE.has(status) ? 'closed — verify' : 'closed', 'tag-warn'));
  }
  // Behavioral evidence is the primary chip; the text scan only appears when
  // it actually found language (NEUTRAL on every row was noise)
  if (job.class_evidence?.certified_count_3y) {
    chips.append(tag(`sponsors ${job.title_class_label} ×${job.class_evidence.certified_count_3y}`, 'tag-friendly'));
  }
  if (job.veritas_state !== 'NEUTRAL') {
    chips.append(tag(VISA_LABELS[job.veritas_state] || job.veritas_state, VISA_TAGS[job.veritas_state] ?? ''));
  }
  if (job.fit?.fit_score !== null && job.fit?.recommended_variant) {
    const use = tag(`use ${variantAbbrev(job.fit.recommended_variant)}${job.fit.ambiguous && job.fit.recommended_source === 'deterministic' ? '?' : ''}`, 'tag-variant');
    use.prepend(variantDot(job.fit.recommended_variant));
    chips.append(use);
    chips.append(tag(job.fit.verdict, VERDICT_TAGS[job.fit.verdict] ?? ''));
    const gate = job.fit.gate;
    if (gate?.citizenship) {
      chips.append(tag('⚠ citizens only', 'tag-restricted'));
    } else if (gate?.degree?.required && !gate.degree.met && !gate.degree.softened) {
      chips.append(tag(`⚠ ${gate.degree.required} required`, 'tag-warn'));
    }
  }

  const scores = node.querySelector('.row-scores');
  if (job.fit?.fit_score != null) {
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
    job.department || null,
    formatSalary(job),
    job.work_mode === 'hybrid' ? 'Hybrid' : null,
    formatDeadline(job)
  ].filter(Boolean).join(' · ');
  DOM.detailOpen.href = job.url;

  const current = triageFor(job);
  for (const button of DOM.triageSeg.querySelectorAll('button')) {
    button.classList.toggle('is-active', button.dataset.value === current);
  }
  // Don't clobber what the user is typing if the note field is focused mid-edit
  if (DOM.detailNote && document.activeElement !== DOM.detailNote) {
    DOM.detailNote.value = noteFor(job);
  }

  renderDetailAlerts(job);
  renderDetailSignals(job);
  renderDetailWhy(job);
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

  const notes = el('section', 'detail-notes');
  const notesLabel = el('label', 'field-label', 'Notes (contact, next step)');
  notesLabel.setAttribute('for', 'detail-note');
  const notesArea = el('textarea', 'note-input');
  notesArea.id = 'detail-note';
  notesArea.rows = 3;
  notesArea.placeholder = 'e.g. emailed Dr. Lee 7/18 — follow up in a week';
  notes.append(notesLabel, notesArea);

  const alerts = el('div'); alerts.id = 'detail-alerts';
  const signals = el('dl', 'signal-grid'); signals.id = 'detail-signals';
  const fit = el('div', 'fit-block'); fit.id = 'detail-fit';

  const description = el('section', 'detail-description');
  const descriptionTitle = el('h3', '', 'Description');
  const body = el('div', 'description-body'); body.id = 'detail-description-body';
  description.append(descriptionTitle, body);

  const disclaimer = el('p', 'disclaimer'); disclaimer.id = 'detail-disclaimer';

  return [back, head, actions, notes, alerts, signals, fit, description, disclaimer];
}

function rebindDetailRefs() {
  DOM.detailBack = document.querySelector('#detail-back');
  DOM.detailTitle = document.querySelector('#detail-title');
  DOM.detailMeta = document.querySelector('#detail-meta');
  DOM.detailOpen = document.querySelector('#detail-open');
  DOM.triageSeg = document.querySelector('#triage-seg');
  DOM.detailNote = document.querySelector('#detail-note');
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

  // Evidence-first: class-level LCA history is the headline, institution-wide
  // counts are context, the text scan is a footnote
  const signalTag = tag(job.sponsor_signal, job.sponsor_signal === 'strong' ? 'tag-friendly' : job.sponsor_signal === 'restricted' ? 'tag-restricted' : job.sponsor_signal === 'moderate' ? 'tag-accent' : 'tag-warn');
  const sponsorCell = signalCell(`Sponsorship evidence — ${job.title_class_label || 'this role'}`, signalTag);
  sponsorCell.style.gridColumn = 'span 2';
  const sponsorDd = sponsorCell.querySelector('dd');
  if (job.class_evidence?.certified_count_3y) {
    sponsorDd.append(document.createTextNode(
      `${job.class_evidence.certified_count_3y} LCA certifications for ${job.title_class_label} roles (3y)`));
    const noteParts = [];
    if (job.class_evidence.median_annual_wage) {
      noteParts.push(`median $${job.class_evidence.median_annual_wage.toLocaleString()}`);
    }
    if (job.dol_lca_certified_count_3y) {
      noteParts.push(`${job.dol_lca_certified_count_3y} institution-wide`);
    }
    if (noteParts.length) sponsorDd.append(el('span', 'signal-note', noteParts.join(' · ')));
  } else if (job.dol_lca_certified_count_3y) {
    sponsorDd.append(document.createTextNode(`${job.dol_lca_certified_count_3y} LCA certifications (3y), institution-wide`));
    sponsorDd.append(el('span', 'signal-note', `none on record for ${job.title_class_label || 'this'} roles — treat as unproven for this role`));
  } else {
    sponsorDd.append(el('span', 'signal-note', 'no LCA sponsorship history on record'));
  }

  DOM.detailSignals.append(
    institutionCell,
    sponsorCell,
    signalCell('Posting language', tag(VISA_LABELS[job.veritas_state] || job.veritas_state, VISA_TAGS[job.veritas_state] ?? ''))
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

// Terms the recommended variant matched in this posting (for highlighting)
function recommendedMatchedTerms(fit) {
  const variant = (fit?.variants || []).find((entry) => entry.id === fit.recommended_variant);
  if (!variant) return [];
  return [...variant.matched[3], ...variant.matched[2], ...variant.matched[1]];
}

const WEIGHT_LABELS = { 3: 'Core', 2: 'Solid', 1: 'Familiar' };

function whyLine(label, ...content) {
  const row = el('div', 'why-line');
  row.append(el('span', 'why-label', label));
  const value = el('span', 'why-value');
  value.append(...content);
  row.append(value);
  return row;
}

function renderDetailWhy(job) {
  DOM.detailFit.replaceChildren();
  const fit = job.fit;
  if (!fit || fit.fit_score === null) {
    DOM.detailFit.append(el('p', 'fit-skills', fit ? fit.fit_summary : ''));
    return;
  }

  const recommended = fit.variants.find((variant) => variant.id === fit.recommended_variant);
  const headline = el('p', 'fit-score', `Fit ${fit.fit_score} / 100 — ${fit.verdict} fit`);
  DOM.detailFit.append(headline);

  if (recommended) {
    const use = el('p', 'why-use');
    use.append(variantDot(recommended.id), document.createTextNode(` Use your ${recommended.label} resume`));
    if (fit.recommended_source === 'llm') {
      use.append(el('span', 'signal-note',
        `resolved locally by ${state.routeCache?.model || 'local model'}${fit.llm_reason ? `: ${fit.llm_reason}` : ''}`));
    } else if (fit.ambiguous) {
      use.append(el('span', 'signal-note',
        'close call between variants — npm run radar:route resolves these with a local model'));
    }
    DOM.detailFit.append(use);
  }

  // Per-variant score bars, best first
  const variantList = el('div', 'why-variants');
  for (const variant of fit.variants.slice().sort((a, b) => b.score - a.score || a.order - b.order)) {
    const row = el('div', 'why-variant');
    row.append(variantDot(variant.id), el('span', 'variant-label', variant.label), el('span', 'why-score', String(variant.score)));
    row.append(meter(variant.score));
    variantList.append(row);

    const matchedParts = [3, 2, 1]
      .filter((weight) => variant.matched[weight].length)
      .map((weight) => `${WEIGHT_LABELS[weight]}: ${variant.matched[weight].join(', ')}`);
    const notes = [];
    if (variant.title_class_match) notes.push(`${variant.title_class_match} class match`);
    if (variant.domain_hits.length) notes.push(`domains: ${variant.domain_hits.join(', ')}`);
    if (variant.target_title_hit) notes.push('title match');
    if (matchedParts.length || notes.length) {
      variantList.append(el('p', 'why-matched', [...matchedParts, ...notes].join(' · ')));
    }
  }
  DOM.detailFit.append(variantList);

  // Gates + bonuses — the honest "why is this ranked here" ledger
  const ledger = el('div', 'why-ledger');
  const degree = fit.gate?.degree;
  if (degree?.required) {
    const status = degree.met ? 'met'
      : degree.softened ? `not met — softened (${degree.penalty})`
        : degree.penalty === RadarScoring.WEIGHTS.DEGREE_GATE_IN_PROGRESS ? `in progress (${degree.penalty})`
          : `not met (${degree.penalty})`;
    const line = whyLine('Degree gate', document.createTextNode(`${degree.required} ${status}`));
    if (degree.evidence) line.querySelector('.why-value').append(el('span', 'signal-note', `“${degree.evidence}”`));
    ledger.append(line);
  }
  if (fit.gate?.citizenship) {
    ledger.append(whyLine('Citizenship', document.createTextNode(`US citizens only (${RadarScoring.WEIGHTS.CITIZENSHIP_GATE})`)));
  } else if (job.veritas_state === 'RESTRICTED') {
    ledger.append(whyLine('Visa language', document.createTextNode(`restricted language (${RadarScoring.WEIGHTS.RESTRICTED_LANGUAGE})`)));
  }
  if (fit.gate?.stage_mismatch) {
    ledger.append(whyLine('Seniority', document.createTextNode(`senior-titled role vs your stage (${RadarScoring.WEIGHTS.STAGE_MISMATCH})`)));
  }
  if (fit.avoid_hits.length) {
    ledger.append(whyLine('Avoid signals', document.createTextNode(`${fit.avoid_hits.join(', ')}`)));
  }
  if (fit.evidence_bonus) {
    ledger.append(whyLine('Sponsor evidence', document.createTextNode(`employer sponsors this role class (+${fit.evidence_bonus})`)));
  }
  if (fit.research_bonus) {
    ledger.append(whyLine('Research relevance', document.createTextNode(`+${fit.research_bonus}`)));
  }
  if (ledger.childElementCount) DOM.detailFit.append(ledger);
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
    { phrases: [...(job.research_role_language || []), ...(job.cap_exempt_language || []), ...(job.international_candidate_language || []), ...recommendedMatchedTerms(job.fit)], className: 'm-skill' }
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
  const prev = state.local.triage[job.id] || {};
  const now = new Date().toISOString();
  const record = { ...prev, status, updated_at: now };
  // Stamp the first time it becomes "applied" so the funnel remembers when you
  // actually applied, independent of any later interview/offer change.
  if (status === 'applied' && !record.applied_at) record.applied_at = now;
  state.local.triage[job.id] = record;
  await persistTriage();
  render();
}

async function setNote(job, note) {
  const prev = state.local.triage[job.id] || { status: 'new' };
  // A note edit must NOT bump updated_at — that would falsely reset the
  // follow-up-aging clock. Keep the prior timestamp (or seed one for a new
  // record), and drop the field entirely when the note is cleared.
  const record = { ...prev, status: prev.status || 'new', updated_at: prev.updated_at || new Date().toISOString() };
  if (note && note.trim()) record.note = note;
  else delete record.note;
  state.local.triage[job.id] = record;
  await persistTriage();
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

  // Notes: debounce while typing (don't persist every keystroke), flush on blur
  // and re-render so the row's note indicator updates.
  let noteTimer = null;
  DOM.detailNote.addEventListener('input', (event) => {
    const job = selectedJob();
    if (!job) return;
    const value = event.target.value;
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => setNote(job, value), 400);
  });
  DOM.detailNote.addEventListener('blur', async (event) => {
    const job = selectedJob();
    if (!job) return;
    clearTimeout(noteTimer);
    await setNote(job, event.target.value);
    render();
  });
}

function markAllSeen() {
  state.lastVisit = new Date().toISOString();
  localStorage.setItem(LAST_VISIT_KEY, state.lastVisit);
  DOM.newOnly.checked = false;
  render();
}

function bindEvents() {
  for (const input of [DOM.q, DOM.sort, DOM.source, DOM.newOnly, DOM.followupOnly, DOM.remoteOnly, DOM.includeClosed, DOM.includeFederal, DOM.type, DOM.cap, DOM.triageFilter, DOM.minResearch]) {
    input.addEventListener('input', render);
  }

  DOM.markSeen.addEventListener('click', markAllSeen);

  DOM.visaSeg.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-value]');
    if (button) setVisaFilter(button.dataset.value);
  });

  DOM.resetFilters.addEventListener('click', resetFilters);
  DOM.emptyReset.addEventListener('click', resetFilters);
  DOM.filtersToggle.addEventListener('click', () => document.body.classList.toggle('show-filters'));

  // Pages-mode import: the local server reads profile.json/route-cache.json
  // straight off disk; on static hosting the user imports the same files here
  // and they persist in localStorage only.
  DOM.profileFile.addEventListener('change', async () => {
    const file = DOM.profileFile.files?.[0];
    if (!file) return;
    DOM.profileFile.value = '';
    let parsed = null;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      state.profileError = 'That file is not valid JSON.';
      renderProfileCard();
      return;
    }
    const problem = RadarScoring.validateProfile(parsed);
    if (problem) {
      state.profileError = `Not a usable profile: ${problem}`;
      renderProfileCard();
      return;
    }
    state.profileError = null;
    localStorage.setItem(PROFILE_KEY, JSON.stringify(parsed));
    applyProfile(parsed, state.routeCache);
    render();
  });

  DOM.routeFile.addEventListener('change', async () => {
    const file = DOM.routeFile.files?.[0];
    if (!file) return;
    DOM.routeFile.value = '';
    let parsed = null;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      state.profileError = 'That file is not valid JSON.';
      renderProfileCard();
      return;
    }
    if (!parsed || typeof parsed.verdicts !== 'object') {
      state.profileError = 'Not a route-cache file (missing verdicts).';
      renderProfileCard();
      return;
    }
    state.profileError = null;
    localStorage.setItem(ROUTE_CACHE_KEY, JSON.stringify(parsed));
    applyProfile(state.profile, parsed);
    render();
  });

  DOM.clearProfile.addEventListener('click', () => {
    localStorage.removeItem(PROFILE_KEY);
    localStorage.removeItem(ROUTE_CACHE_KEY);
    state.profileError = null;
    applyProfile(null, null);
    render();
  });

  DOM.syncSave.addEventListener('click', saveSyncToken);
  DOM.syncClear.addEventListener('click', clearSyncToken);

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
  // The "NEW" watermark must NOT advance on every load — that made everything
  // stop being NEW the moment you reloaded. Read it and leave it; only an
  // explicit "Mark all as seen" advances it. Seed it once on the very first
  // visit so the entire backlog isn't flagged NEW.
  state.lastVisit = localStorage.getItem(LAST_VISIT_KEY);
  if (!state.lastVisit) {
    state.lastVisit = new Date().toISOString();
    localStorage.setItem(LAST_VISIT_KEY, state.lastVisit);
  }
  hydrateFromUrl();

  const [jobs, employers, local, report, discovery, profile, routeCache] = await Promise.all([
    loadJobs(),
    getJson('/api/employers', []),
    getJson('/api/local-state', null),
    loadRefreshReport(),
    getJson('/api/discovery', { candidates: [] }),
    getJson('/api/profile', null),
    getJson('/api/route-cache', null)
  ]);
  state.jobs = jobs;
  state.employers = employers;
  // null means no API server (static hosting) -> browser-local triage
  state.local = local || loadTriageFromBrowser();
  // Cross-device sync (1.2): pull Supabase triage, merge last-write-wins, and
  // push the merged set back so remote picks up any local-only edits. Off (and
  // a clean no-op) until a sync token is set; never blocks load on failure.
  if (triageSync.enabled()) {
    try {
      const remote = await triageSync.pull();
      if (remote) {
        state.local.triage = mergeTriage(state.local.triage, remote);
        await saveLocalState();
        await triageSync.push();
      }
    } catch (error) {
      console.warn(`Triage sync pull failed (using local triage): ${error.message}`);
    }
  }
  // Same split for the resume profile: disk via the local server, otherwise
  // whatever the user imported into this browser. A profile served from disk
  // that fails validation is surfaced, not silently ignored.
  const diskProblem = profile ? RadarScoring.validateProfile(profile) : null;
  if (diskProblem) state.profileError = `profile.json is not usable: ${diskProblem}`;
  applyProfile(!profile || diskProblem ? loadProfileFromBrowser() : profile,
    routeCache || loadRouteCacheFromBrowser());
  populateSources();
  // Source options only exist now, so re-apply the source filter from the URL
  const sourceParam = new URLSearchParams(window.location.search).get('source');
  if (sourceParam) DOM.source.value = sourceParam;
  renderStats();
  renderRefreshStatus(report);
  renderDiscovery(discovery);
  renderSyncStatus();
  bindEvents();

  // Preselect the first job on wide screens so the detail pane is never empty
  render();
  if (!narrowLayout.matches && state.visible.length && !state.selectedId) {
    selectJob(state.visible[0].id);
  }
}

init();
