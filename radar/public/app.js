const state = {
  jobs: [],
  local: { version: 1, triage: {}, ignored_employers: [] },
  profile: null,      // parsed profile document (schema_version 2)
  profileText: '',    // the markdown as stored, so the editor shows what is saved
  compiled: null,     // RadarScoring.compileProfile(profile)
  routeCache: null,   // retired; kept so scoreAll's signature stays honest
  profileError: null, // validation message when the document does not parse
  matches: {},        // jobId -> judged match
  matchesByHash: {},  // jobContentHash -> judged match, as stored
  judgmentCursor: null, // newest judged_at seen, so polls fetch only what is new
  matchPending: 0,      // qualified postings with no judgment yet
  matchAvailable: false, // true once judgments have been read (i.e. signed in)
  loadError: null,    // set when the job load partially/fully failed (distinct from "no matches")
  lastVisit: null,
  selectedId: null,
  visible: []
};

const LAST_VISIT_KEY = 'veritas_radar_last_visit';

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
  statPossible: document.querySelector('#stat-possible'),
  statusToggle: document.querySelector('#status-toggle'),
  statusPanel: document.querySelector('#status-panel'),
  statusRefresh: document.querySelector('#status-refresh'),
  statusInstruments: document.querySelector('#status-instruments'),
  statusProfile: document.querySelector('#status-profile'),
  authForm: document.querySelector('#auth-form'),
  authEmail: document.querySelector('#auth-email'),
  authPassword: document.querySelector('#auth-password'),
  authSubmit: document.querySelector('#auth-submit'),
  authError: document.querySelector('#auth-error'),
  authSignedIn: document.querySelector('#auth-signed-in'),
  authWho: document.querySelector('#auth-who'),
  authSignout: document.querySelector('#auth-signout'),
  profileEditor: document.querySelector('#profile-editor'),
  profileText: document.querySelector('#profile-text'),
  profileEditorError: document.querySelector('#profile-editor-error'),
  profileSave: document.querySelector('#profile-save'),
  profileCancel: document.querySelector('#profile-cancel'),
  errorsList: document.querySelector('#errors-list'),
  discoverySummary: document.querySelector('#discovery-summary'),
  discoveryList: document.querySelector('#discovery-list'),
  q: document.querySelector('#q'),
  sort: document.querySelector('#sort'),
  visaSeg: document.querySelector('#visa-seg'),
  markSeen: document.querySelector('#mark-seen'),
  recency: document.querySelector('#recency'),
  ignoredSection: document.querySelector('#ignored-section'),
  ignoredSummary: document.querySelector('#ignored-summary'),
  ignoredPanel: document.querySelector('#ignored-panel'),
  undoBar: document.querySelector('#undo-bar'),
  undoMsg: document.querySelector('#undo-msg'),
  undoBtn: document.querySelector('#undo-btn'),
  blockedNote: document.querySelector('#blocked-note'),
  viewSeg: document.querySelector('#view-seg'),
  pipelineStats: document.querySelector('#pipeline-stats'),
  pipelineEmpty: document.querySelector('#pipeline-empty'),
  resetFilters: document.querySelector('#reset-filters'),
  rowTemplate: document.querySelector('#job-row-template'),
  detailPane: document.querySelector('#detail-pane'),
  detailScroll: document.querySelector('.detail-scroll'),
  detailBack: document.querySelector('#detail-back'),
  detailTitle: document.querySelector('#detail-title'),
  detailMeta: document.querySelector('#detail-meta'),
  detailOpen: document.querySelector('#detail-open'),
  triageControls: null,
  triageStepper: null,
  triageStateLine: null,
  triageLinks: null,
  detailNote: document.querySelector('#detail-note'),
  detailAlerts: document.querySelector('#detail-alerts'),
  detailSignals: document.querySelector('#detail-signals'),
  detailFit: document.querySelector('#detail-fit'),
  detailDescription: document.querySelector('#detail-description-body'),
  detailDisclaimer: document.querySelector('#detail-disclaimer')
};

// Tripwire: the cache above has no null guards, so a renamed/removed id in
// index.html surfaces as a crash deep inside render(). Warn loudly at boot
// instead. Detail-pane refs are null by design until buildDetailSkeleton()
// runs and rebindDetailRefs() fills them in.
{
  const DETAIL_BOUND_LATER = new Set([
    'detailScroll', 'detailBack', 'detailTitle', 'detailMeta', 'detailOpen',
    'triageControls', 'triageStepper', 'triageStateLine', 'triageLinks',
    'detailNote', 'detailAlerts', 'detailSignals', 'detailFit',
    'detailDescription', 'detailDisclaimer'
  ]);
  for (const [key, node] of Object.entries(DOM)) {
    if (node === null && !DETAIL_BOUND_LATER.has(key)) console.warn(`DOM cache miss: ${key}`);
  }
}

const narrowLayout = window.matchMedia('(max-width: 1180px)');

// With thousands of jobs (USAJOBS alone returns 2,500) rendering every row on
// each keystroke janks; the sort puts the best matches first, so cap the list
// and reveal the rest on demand.
const LIST_RENDER_CAP = 400;
let showAllRows = false;

let visaFilter = '';
// The radar opens on what you can apply to; blocked jobs are one click away.
let showBlocked = false;

/* 'possible' = open, not citizens-only, no quoted barrier — grouped by how the
 * model read each one; 'radar' = every active job; 'pipeline' = jobs you've
 * applied to / contacted, grouped by stage. Pipeline ignores every filter
 * except search — an application must never vanish because a filter tightened.
 *
 * This tab was called "Qualified". It was the wrong word: the funnel rejects
 * only what is quotably impossible and the judge is measurably lenient, so
 * what survives is what you could plausibly apply to — not what you are
 * qualified for. Claiming the stronger word made the list feel checked when
 * nothing had checked it. */
let viewMode = 'possible';

// Job id whose detail pane shows the "did you apply?" nudge after the user
// opened its posting. Self-scoped: only ever rendered for the matching job.
let applyNudgeJobId = null;

/* ------------------------------------------------------------------------ */
/* Data + persistence                                                        */

// On GitHub Pages there is no API server: jobs and the refresh report read
// live from Supabase (anon key is public by design; RLS is read-only), other
// endpoints fall back to static JSON copies, and triage state falls back to
// localStorage. The same bundle serves both environments.
const SUPABASE_URL = 'https://nawbdsujjysugaisczta.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_7GXYKvqrAMSfxwPX-0NKyA_CSO2Sz2T';

const STATIC_DATA = {
  '/api/discovery': 'data/discovery-candidates.json'
};

async function supabaseGet(pathname) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1${pathname}`, {
    headers: { apikey: SUPABASE_ANON_KEY, authorization: `Bearer ${SUPABASE_ANON_KEY}` }
  });
  if (!response.ok) throw new Error(`supabase ${response.status}`);
  return response.json();
}

/* The signed-in half of the database: the profile document, the judgments and
 * triage. Postings are public and stay on the anon key above; everything here
 * is yours, and RLS refuses the anon key outright rather than returning an
 * empty list — so a missing session is an error to handle, not silence. */
const auth = RadarAuth.createAuthClient({
  url: SUPABASE_URL,
  anonKey: SUPABASE_ANON_KEY,
  storage: window.localStorage
});

async function authedFetch(pathname, init = {}) {
  const headers = await auth.headers();
  if (!headers) return null;
  const response = await fetch(`${SUPABASE_URL}/rest/v1${pathname}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...headers, ...(init.headers || {}) }
  });
  if (response.status === 401 || response.status === 403) {
    // The session died under us. Say so once, rather than letting every
    // subsequent call fail in its own way.
    state.session = null;
    return null;
  }
  if (!response.ok) throw new Error(`supabase ${response.status} on ${pathname}`);
  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

const authedGet = (pathname) => authedFetch(pathname);

/** Upsert rows, merging on conflict — the same verb syncJobs uses server-side. */
const authedUpsert = (table, rows, onConflict) => authedFetch(
  `/${table}?on_conflict=${onConflict}`,
  { method: 'POST', body: JSON.stringify(rows), headers: { prefer: 'resolution=merge-duplicates,return=minimal' } }
);

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
  state.loadFailedPages = 0;
  state.loadTotalPages = 0;
  state.loadShown = 0;
  state.loadTotal = 0;
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
        // description_text lives in its own column and is no longer duplicated
        // inside payload, so it has to be selected and rejoined below.
        const query = `/jobs?select=payload,description_text&order=id&limit=${pageSize}&offset=${page * pageSize}`;
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
      // Rows written before the payload slimming still carry the description
      // inside payload, so prefer the column and fall back to it.
      const jobs = pages.flat()
        .filter((row) => row && row.payload)
        .map((row) => ({
          ...row.payload,
          description_text: row.description_text ?? row.payload.description_text ?? null
        }));
      if (jobs.length) {
        if (failedPages) {
          // The banner renderer uses the structured fields; the message string
          // doubles as the "there is a problem" signal.
          state.loadFailedPages = failedPages;
          state.loadTotalPages = pageCount;
          state.loadShown = jobs.length;
          state.loadTotal = total;
          state.loadError = `Showing ${jobs.length.toLocaleString()} of ~${total.toLocaleString()} jobs — `
            + `${failedPages} data page${failedPages === 1 ? '' : 's'} failed to load.`;
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
    if (stored && typeof stored.triage === 'object') {
      if (!Array.isArray(stored.ignored_employers)) stored.ignored_employers = [];
      return stored;
    }
  } catch { /* corrupted -> fresh */ }
  return { version: 1, triage: {}, ignored_employers: [] };
}

/* Signed out, triage still works — it just lives in this browser, exactly as it
 * did on the hosted page before there was an account. The first sign-in merges
 * whatever accumulated here into the database (see importBrowserTriage). */
function saveTriageToBrowser() {
  localStorage.setItem(LOCAL_TRIAGE_KEY, JSON.stringify({
    version: 1,
    triage: state.local.triage,
    ignored_employers: state.local.ignored_employers || []
  }));
}

function triageRow(jobId, record) {
  return {
    job_id: jobId,
    status: record.status,
    note: record.note ?? null,
    applied_at: record.applied_at ?? null,
    variant_sent: record.variant_sent ?? null,
    updated_at: record.updated_at
  };
}

/**
 * Persist ONE triage record.
 *
 * The local server took the whole document on every keystroke and replaced it
 * wholesale. That was fine for a single writer on a single disk and is exactly
 * wrong across devices: two browsers touching different jobs would each write
 * their complete map and the later one would erase the other's work. A row at
 * a time cannot do that.
 */
async function persistTriageRecord(jobId) {
  const record = state.local.triage[jobId];
  if (!auth.signedIn()) { saveTriageToBrowser(); return; }
  try {
    if (!record) {
      // Undo back to "never triaged". That is a different state from "triaged
      // as new", so the row has to actually go.
      await authedFetch(`/triage?job_id=eq.${encodeURIComponent(jobId)}`,
        { method: 'DELETE', headers: { prefer: 'return=minimal' } });
    } else {
      await authedUpsert('triage', [triageRow(jobId, record)], 'job_id');
    }
  } catch (error) {
    // Keep the change rather than losing it to a network blip; the next
    // sign-in merge will carry it up.
    console.warn('triage write failed, kept in this browser:', error.message);
    saveTriageToBrowser();
  }
}

async function persistIgnoredEmployers() {
  if (!auth.signedIn()) { saveTriageToBrowser(); return; }
  const userId = auth.user()?.id;
  if (!userId) return;
  try {
    await authedUpsert('user_state', [{
      user_id: userId,
      ignored_employers: state.local.ignored_employers || [],
      updated_at: new Date().toISOString()
    }], 'user_id');
  } catch (error) {
    console.warn('ignored-employer write failed:', error.message);
  }
}

// Employers hidden from the list. This used to be deliberately device-local,
// on the reasoning that it is a preference rather than application state — but
// that reasoning was really "there is nowhere shared to put it". There is now,
// and hiding an employer on the laptop should hide it on the phone.
function ignoredEmployers() {
  return new Set(state.local.ignored_employers || []);
}

async function ignoreEmployer(job) {
  pushUndo(
    { type: 'ignore_employer', employerId: job.employer_id, prevSelectedId: state.selectedId },
    `Ignored ${job.employer_name || job.employer_id}`
  );
  const set = ignoredEmployers();
  set.add(job.employer_id);
  state.local.ignored_employers = [...set];
  state.selectedId = null;
  await persistIgnoredEmployers();
  render();
}

async function unignoreEmployer(employerId) {
  state.local.ignored_employers = (state.local.ignored_employers || [])
    .filter((id) => id !== employerId);
  await persistIgnoredEmployers();
  render();
}

/* One place every triage mutation persists through.
 *
 * There used to be a Supabase sync here gated by a token you pasted into the
 * sidebar, and it was removed as machinery for a fleet of devices that did not
 * exist. The sync is back, but the reasoning that killed it still holds — what
 * changed is that there is an account now, so the token, the RPCs and the
 * pasted secret are all gone. Rows are written as themselves, one at a time. */
async function persistTriage(jobId) {
  await persistTriageRecord(jobId);
}

/* ------------------------------------------------------------------------ */
/* Profile: a document you write, stored in your account and parsed here.    */
/*                                                                          */
/* It used to be a file the local server read off disk, which the hosted     */
/* page could only obtain by reaching back to localhost over a CORS bridge   */
/* while the laptop happened to be running. Now the browser fetches the      */
/* document and parses it with radar/public/profile-doc.js — the same parser */
/* the judge uses server-side, because two parsers would eventually disagree */
/* and a disagreement moves profileHash, orphaning every judgment paid for.  */

const CLASSIFY_CACHE_KEY = 'veritas_radar_classify_cache';

function jobText(job) {
  // Built once per job and cached — the search filter runs this for every job on
  // every render, and (with the debounced search box) that must stay cheap.
  return (job._searchBlob ??= `${job.title} ${job.department} ${job.employer_name} ${job.description_text}`.toLowerCase());
}

/**
 * Fetch the profile document and parse it. Returns the parsed profile, and
 * keeps the raw markdown so the editor can show exactly what is stored rather
 * than a re-serialisation of the parse.
 */
async function loadProfileDocument() {
  const rows = await authedGet('/profile_documents?select=content,updated_at&limit=1');
  const content = rows?.[0]?.content;
  if (!content) { state.profileText = ''; state.profileError = null; return null; }
  state.profileText = content;
  const parsed = RadarProfileDoc.parseProfileDocument(content);
  const invalid = RadarScoring.validateProfile(parsed);
  state.profileError = invalid || null;
  return invalid ? null : parsed;
}

function loadClassifyCacheFromBrowser() {
  try {
    const stored = JSON.parse(localStorage.getItem(CLASSIFY_CACHE_KEY));
    if (stored && typeof stored.entries === 'object') return stored;
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
  renderStatusProfile();
}

/* The profile's whole presence in the UI: one block in the status drawer.
 *
 * It used to be two sidebar panels — a résumé list with upload and rename, and
 * a card summarising the profile derived from them. Both are gone, because
 * neither was editable in any way that mattered: the profile is a document you
 * open in an editor. What survives is the part you cannot get anywhere else —
 * whether the server actually loaded it, and what it dropped on the way in.
 * A profile that failed to parse must be visible, or every job after it is
 * judged against nothing and the list looks merely disappointing. */
function renderStatusProfile() {
  if (!DOM.statusProfile) return;
  DOM.statusProfile.replaceChildren();
  DOM.statusProfile.append(el('p', 'instrument-head-label', 'Profile'));

  if (state.profileError) {
    DOM.statusProfile.append(el('p', 'profile-error', state.profileError));
  }

  if (!auth.signedIn()) {
    DOM.statusProfile.append(el('p', 'drawer-note',
      'Sign in to load your profile. Postings are public and need no account; the profile, the judgments and your triage are yours.'));
    return;
  }

  if (!state.compiled) {
    DOM.statusProfile.append(el('p', 'drawer-note',
      state.profileText
        ? 'Your profile could not be parsed — fix it below.'
        : 'No profile yet. Write one with radar/PROFILE-PROMPT.md as a guide, then paste it in below.'));
    DOM.statusProfile.append(profileEditButton('Write profile'));
    return;
  }

  const capabilities = state.profile?.variants?.[0]?.skills?.length || 0;
  DOM.statusProfile.append(el('p', 'drawer-note',
    `${capabilities} capabilities · every job is judged against this document and nothing else.`));

  // A skill too short to match is reported, never silently lost — that is the
  // one failure this document exists to prevent.
  const dropped = state.profile?.dropped_terms || [];
  if (dropped.length) {
    DOM.statusProfile.append(el('p', 'drawer-note',
      `Not matchable, so ignored: ${dropped.join(', ')} — too short to search for safely.`));
  }
  DOM.statusProfile.append(profileEditButton('Edit profile'));
}

function profileEditButton(label) {
  const button = el('button', 'link-button', label);
  button.type = 'button';
  button.addEventListener('click', () => openProfileEditor());
  return button;
}

/* ------------------------------------------------------------------------ */
/* The profile editor.                                                       */
/*                                                                           */
/* Validation happens HERE, before the document is stored, using the same    */
/* parser the judge will use. Saving a profile that does not parse would     */
/* leave every posting judged against nothing while the UI looked fine.      */

function openProfileEditor() {
  if (!DOM.profileEditor || !DOM.profileText) return;
  DOM.profileText.value = state.profileText || '';
  DOM.profileEditorError.hidden = true;
  DOM.profileEditor.hidden = false;
  DOM.profileText.focus();
}

function closeProfileEditor() {
  if (DOM.profileEditor) DOM.profileEditor.hidden = true;
}

async function saveProfileDocument() {
  const content = DOM.profileText.value;
  const parsed = RadarProfileDoc.parseProfileDocument(content);
  const invalid = RadarScoring.validateProfile(parsed);
  if (invalid) {
    DOM.profileEditorError.textContent = invalid;
    DOM.profileEditorError.hidden = false;
    return;
  }
  const userId = auth.user()?.id;
  if (!userId) return;

  DOM.profileSave.disabled = true;
  try {
    await authedUpsert('profile_documents', [{
      user_id: userId, content, updated_at: new Date().toISOString()
    }], 'user_id');
  } catch (error) {
    DOM.profileEditorError.textContent = `Could not save: ${error.message}`;
    DOM.profileEditorError.hidden = false;
    return;
  } finally {
    DOM.profileSave.disabled = false;
  }

  const previousHash = state.compiled?.hash;
  state.profileText = content;
  state.profileError = null;
  applyProfile(parsed, null);
  closeProfileEditor();

  /* Judgments are keyed on the profile hash, so an edit that moves it makes
   * every cached verdict unaddressable — not lost, but not read either. The
   * 6-hourly job re-judges under the new hash; say so rather than letting the
   * Possible tab look mysteriously empty. */
  if (previousHash && state.compiled?.hash !== previousHash) {
    state.matches = {};
    state.matchesByHash = {};
    state.judgmentCursor = null;
    await loadJudgments();
  }
  render();
}

/* ------------------------------------------------------------------------ */
/* Signing in.                                                               */
/*                                                                           */
/* There used to be a CORS bridge here: the hosted page reached back to       */
/* http://localhost:4173 to borrow the profile from the laptop, whenever the  */
/* laptop happened to be awake and running the server, in Chrome, having      */
/* answered a Private Network Access preflight. It worked, and it was a       */
/* workaround for not having anywhere to put the document. Now there is.      */

function renderAuthSection() {
  if (!DOM.authForm || !DOM.authSignedIn) return;
  const user = auth.user();
  DOM.authForm.hidden = Boolean(user);
  DOM.authSignedIn.hidden = !user;
  if (user && DOM.authWho) DOM.authWho.textContent = `Signed in as ${user.email || 'you'}`;
}

async function handleSignIn(event) {
  event.preventDefault();
  DOM.authError.hidden = true;
  DOM.authSubmit.disabled = true;
  try {
    await auth.signIn(DOM.authEmail.value.trim(), DOM.authPassword.value);
    DOM.authPassword.value = '';
    renderAuthSection();
    await loadAuthedState();
    render();
  } catch (error) {
    DOM.authError.textContent = error.message;
    DOM.authError.hidden = false;
  } finally {
    DOM.authSubmit.disabled = false;
  }
}

async function handleSignOut() {
  await auth.signOut();
  // Everything private goes with the session — leaving judgments on screen
  // after signing out would be a lie about who can see them.
  state.profile = null;
  state.compiled = null;
  state.profileText = '';
  state.matches = {};
  state.matchesByHash = {};
  state.judgmentCursor = null;
  state.local = { version: 1, triage: {}, ignored_employers: [] };
  RadarScoring.scoreAll(state.jobs, null, null);
  renderAuthSection();
  closeProfileEditor();
  render();
}

/**
 * Everything behind the sign-in, in one place: the profile, the judgments,
 * triage, and the hidden-employer list.
 */
async function loadAuthedState() {
  if (!auth.signedIn()) return;
  try {
    const [profile, triageRows, stateRows] = await Promise.all([
      loadProfileDocument(),
      loadTriageRows(),
      authedGet('/user_state?select=ignored_employers&limit=1')
    ]);
    state.local.triage = triageRows;
    state.local.ignored_employers = stateRows?.[0]?.ignored_employers || [];
    await importBrowserTriage();
    applyProfile(profile, null);
    await loadJudgments();
  } catch (error) {
    console.warn('could not load your account state:', error.message);
  }
  renderAuthSection();
  renderStatusProfile();
}

async function loadTriageRows() {
  const rows = await authedGet('/triage?select=*&order=job_id') || [];
  const triage = {};
  for (const row of rows) {
    const record = { status: row.status, updated_at: row.updated_at };
    // Absent fields are omitted rather than set to null: the record shape the
    // rest of the app reads has always used "missing" to mean "never set".
    if (row.note != null) record.note = row.note;
    if (row.applied_at != null) record.applied_at = row.applied_at;
    if (row.variant_sent != null) record.variant_sent = row.variant_sent;
    triage[row.job_id] = record;
  }
  return triage;
}

/**
 * Carry triage made before signing in (or while signed out) into the account,
 * once. Uses the merge that has been sitting in pipeline.js since the sync was
 * removed — last-write-wins by updated_at, ties keeping what is already stored.
 */
const TRIAGE_IMPORTED_KEY = 'veritas_radar_triage_imported';

async function importBrowserTriage() {
  if (localStorage.getItem(TRIAGE_IMPORTED_KEY)) return;
  const stored = loadTriageFromBrowser();
  const localTriage = stored.triage || {};
  if (!Object.keys(localTriage).length && !(stored.ignored_employers || []).length) {
    localStorage.setItem(TRIAGE_IMPORTED_KEY, new Date().toISOString());
    return;
  }
  const merged = RadarPipeline.mergeTriage(state.local.triage, localTriage);
  const changed = Object.entries(merged).filter(([jobId, record]) => {
    const existing = state.local.triage[jobId];
    return !existing || existing.updated_at !== record.updated_at || existing.status !== record.status;
  });
  if (changed.length) {
    await authedUpsert('triage', changed.map(([jobId, record]) => triageRow(jobId, record)), 'job_id');
  }
  state.local.triage = merged;
  const employers = new Set([...(state.local.ignored_employers || []), ...(stored.ignored_employers || [])]);
  if (employers.size !== (state.local.ignored_employers || []).length) {
    state.local.ignored_employers = [...employers];
    await persistIgnoredEmployers();
  }
  localStorage.setItem(TRIAGE_IMPORTED_KEY, new Date().toISOString());
  if (changed.length) console.info(`carried ${changed.length} triage records into your account`);
}

/* ------------------------------------------------------------------------ */
/* Judged matches: the model's read of a posting against your profile.        */
/* Absent on the hosted dashboard, which has no key behind it — everything    */
/* below degrades to the deterministic ordering.                              */

const MATCH_LABELS = {
  strong: 'Strong match',
  possible: 'Worth a look',
  stretch: 'Stretch',
  no: 'Not for you'
};

const MATCH_TAGS = {
  strong: 'tag-friendly',
  possible: 'tag-accent',
  stretch: 'tag-warn',
  no: 'tag-restricted'
};

const MATCH_RANK = { strong: 0, possible: 1, stretch: 2, no: 4 };
// Unjudged sits between "stretch" and "no": promising enough to look at,
// never ranked above something the model actually endorsed.
const UNJUDGED_RANK = 3;

function matchRank(job) {
  const verdict = state.matches[job.id]?.verdict;
  return verdict ? MATCH_RANK[verdict] : UNJUDGED_RANK;
}

/* The Possible tab is grouped by verdict rather than carrying a Match column.
 *
 * A column repeated the same four words down four hundred rows and still left
 * you counting to find out how many were strong. A section header states the
 * verdict once and its size for free, which is the question you actually open
 * this tab with: how much is worth reading tonight. */
const GROUP_KEYS = ['strong', 'possible', 'stretch', 'unread', 'no'];

const GROUP_LABELS = {
  strong: 'Strong match',
  possible: 'Worth a look',
  stretch: 'Stretch',
  unread: 'Not yet read',
  no: 'Not for you'
};

// Flag colours for the same verdicts, used where a row has no group heading.
const VERDICT_FLAGS = {
  strong: 'flag-accent',
  possible: 'flag-accent',
  stretch: 'flag-warn',
  no: 'flag-muted'
};

const GROUP_NOTES = {
  stretch: 'Missing something the posting asks for — read before ruling out',
  unread: 'Queued for the model — ranked by keyword fit meanwhile',
  no: 'The model reads these as a different line of work'
};

function groupKeyFor(job) {
  return state.matches[job.id]?.verdict || 'unread';
}

/* Requests go out one at a time — the server judges serially, so parallel
 * posts only waste round trips — but they QUEUE rather than get dropped. The
 * earlier version bailed out whenever a request was already in flight, and a
 * dropped poll took the whole poll chain with it: the backlog then sat still
 * until some unrelated re-render happened to restart it. */
let matchChain = Promise.resolve();
const matchRequested = new Set();

/* Where the judge lives. Same origin in production; when this page is served
 * by the dev server on localhost there is no function alongside it, so point
 * at the deployment — the alternative is a local stub that behaves differently
 * from the thing that actually runs. */
const JUDGE_ORIGIN = /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname)
  ? (window.RADAR_JUDGE_ORIGIN || '')
  : '';

function serializeMatch(task) {
  const next = matchChain.then(task, task);
  matchChain = next.catch(() => {});
  return next;
}

/* A posting's judgment is found by content, not by id.
 *
 * Two postings with identical text share a verdict, and a posting whose text
 * was edited needs a new one — which is exactly what hashing title, department
 * and body gives. Computed once per job and kept, because resolving the whole
 * pool runs on every judgment load. */
function jobHash(job) {
  return (job._contentHash ??= RadarScoring.jobContentHash(job));
}

function resolveJudgments() {
  if (!state.compiled) return 0;
  let resolved = 0;
  for (const job of state.jobs) {
    const record = state.matchesByHash[jobHash(job)];
    if (record && !state.matches[job.id]) { state.matches[job.id] = record; resolved += 1; }
  }
  return resolved;
}

/**
 * Read the judgments for the current profile out of the database.
 *
 * Incremental after the first call: `judged_at` is a cursor, so the poll that
 * picks up what the 6-hourly job wrote costs one empty page rather than
 * re-downloading thousands of rows.
 */
async function loadJudgments() {
  if (!auth.signedIn() || !state.compiled) return;
  const PAGE = 1000;
  const base = `/match_cache?profile_hash=eq.${encodeURIComponent(state.compiled.hash)}`
    + '&select=job_hash,verdict,different_profession,meets_requirements,matches_preferences,'
    + 'role_summary,reasons,gaps,judged_at,model';
  const cursor = state.judgmentCursor;
  let newest = cursor;
  try {
    for (let offset = 0; ; offset += PAGE) {
      const rows = await authedGet(
        `${base}${cursor ? `&judged_at=gt.${encodeURIComponent(cursor)}` : ''}`
        + `&order=judged_at.asc&limit=${PAGE}&offset=${offset}`);
      if (!rows || !rows.length) break;
      for (const row of rows) {
        const { job_hash: hash, ...record } = row;
        state.matchesByHash[hash] = record;
        if (!newest || record.judged_at > newest) newest = record.judged_at;
      }
      if (rows.length < PAGE) break;
    }
  } catch (error) {
    console.warn('could not load judgments:', error.message);
    return;
  }
  state.judgmentCursor = newest;
  state.matchAvailable = true;
  if (resolveJudgments()) render();
}

/**
 * Ask the judge to read specific postings — ids only.
 *
 * The old endpoint took whole job payloads because the client already had
 * them, and a backlog pass shipped tens of megabytes of posting text to ask
 * "have you read these yet". The function fetches the postings itself now, so
 * this is a list of ids and nothing else.
 */
const JUDGE_BATCH = 20;

async function requestJudgments(jobs) {
  if (!auth.signedIn() || !jobs.length) return;
  const token = await auth.accessToken();
  if (!token) return;
  const batch = jobs.slice(0, JUDGE_BATCH);
  try {
    const response = await fetch(`${JUDGE_ORIGIN}/api/judge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ ids: batch.map((job) => job.id) })
    });
    if (!response.ok) throw new Error(String(response.status));
    const result = await response.json();
    let fresh = 0;
    for (const [id, record] of Object.entries(result.judgments || {})) {
      if (!state.matches[id]) fresh += 1;
      state.matches[id] = record;
      const job = state.jobs.find((candidate) => candidate.id === id);
      if (job) state.matchesByHash[jobHash(job)] = record;
    }
    // Re-render only when something actually arrived, so the list doesn't
    // flicker under the user while they read.
    if (fresh) render();
  } catch (error) {
    console.warn('judge request failed:', error.message);
  }
}

/* What's on screen gets read first; the next screenful is queued behind it so
 * scrolling rarely waits.
 *
 * There is no backlog pass here any more. The page used to hand the server its
 * entire eligible pool because the reading only happened while a tab was open,
 * so a list left unattended stayed unread. The 6-hourly job in CI does that
 * now — postings arrive already judged, and this only covers the gap between
 * a posting appearing and the next scheduled run. */
function pumpMatches() {
  if (viewMode !== 'possible' || !state.compiled || !state.visible.length) return;
  if (!auth.signedIn()) return;
  const onScreen = state.visible.slice(0, 12).filter((job) => !state.matches[job.id]);
  const prefetch = state.visible.slice(12, 40).filter((job) => !state.matches[job.id]);
  const batch = (onScreen.length ? onScreen : prefetch).slice(0, JUDGE_BATCH);
  if (!batch.length) return;
  const key = batch.map((job) => job.id).join(',');
  if (matchRequested.has(key)) return;
  matchRequested.add(key);
  serializeMatch(() => requestJudgments(batch));
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
  }
};

// Named predicates so the blocked-note can apply "every filter except this
// one". filteredJobs() applies all of them.
// job.fit is pre-stamped by applyProfile()/scoreAll() — never computed here.
function filterPredicates() {
  const query = DOM.q.value.trim().toLowerCase();
  const recencyFloor = DOM.recency.value ? Date.now() - Number(DOM.recency.value) * 3600 * 1000 : null;
  const ignored = ignoredEmployers();

  return {
    // Ignored employers vanish from discovery — but never a job you already
    // acted on (demote-never-hide: the pipeline is sacred).
    ignoredEmployer: (job) => {
      if (!ignored.size || !ignored.has(job.employer_id)) return true;
      const status = triageFor(job);
      return PROTECTED_TRIAGE.has(status) || RadarPipeline.PIPELINE_SET.has(status);
    },
    // The default view is "jobs you could actually apply to". Blocked jobs are
    // hidden, never deleted: the counter beside the list says how many and
    // reveals them with their evidence. Anything already acted on stays put —
    // the pipeline is sacred. Citizenship keeps its own control, so gated jobs
    // are excluded here to avoid two switches fighting over the same rows.
    eligibility: (job) => {
      if (showBlocked || job.fit?.eligibility?.verdict !== 'blocked') return true;
      if (job.citizenship_gated) return true;
      const status = triageFor(job);
      return PROTECTED_TRIAGE.has(status) || RadarPipeline.PIPELINE_SET.has(status);
    },
    // The Possible view's whole definition, in the tested scoring module.
    // Blocked jobs ride the same showBlocked toggle as the eligibility rule.
    // Acted-on jobs stay visible here like everywhere else — the pipeline is
    // sacred, even when a shortlisted job is blocked.
    possible: (job) => {
      if (viewMode !== 'possible') return true;
      if (!RadarScoring.isQualified(job, { includeBlocked: showBlocked })) {
        const status = triageFor(job);
        return PROTECTED_TRIAGE.has(status) || RadarPipeline.PIPELINE_SET.has(status);
      }
      // The model read it and said it's a different line of work. Same
      // demote-never-hide contract as blocked jobs: it drops off the list but
      // the count beside the list says how many and one click brings them
      // back with the reasoning attached.
      if (!showBlocked && state.matches[job.id]?.verdict === 'no') {
        const status = triageFor(job);
        return PROTECTED_TRIAGE.has(status) || RadarPipeline.PIPELINE_SET.has(status);
      }
      return true;
    },
    /* Two rules that used to be checkboxes. Neither had a second setting worth
     * offering: a citizens-only posting cannot be applied to on any visa, and a
     * closed one cannot be applied to at all. A job you already acted on is the
     * exception in both cases — it stays visible and flagged, because a posting
     * vanishing from under an application is the thing you need to see. */
    federal: (job) => !job.citizenship_gated,
    closed: (job) => !isClosed(job) || PROTECTED_TRIAGE.has(triageFor(job)),
    query: (job) => !query || jobText(job).includes(query),
    visa: (job) => !visaFilter || job.veritas_state === visaFilter,
    recency: (job) => {
      if (recencyFloor === null) return true;
      const seen = Date.parse(job.first_seen_at || '');
      return Number.isFinite(seen) && seen >= recencyFloor;
    }
  };
}

// Hiding jobs silently would be the same mistake as not finding them. The
// counter says exactly how many the eligibility rule is holding back, and one
// click shows them with the sentence that blocked each one.
function renderBlockedNote() {
  if (!state.compiled) {
    DOM.blockedNote.hidden = true;
    return;
  }
  if (showBlocked) {
    const shown = state.visible.filter((job) => job.fit?.eligibility?.verdict === 'blocked'
      || state.matches[job.id]?.verdict === 'no').length;
    DOM.blockedNote.hidden = shown === 0;
    DOM.blockedNote.textContent = `Showing ${shown.toLocaleString()} set aside · hide`;
    DOM.blockedNote.title = '';
    return;
  }
  // Count what only THIS rule removes, so the number matches what the toggle
  // would reveal rather than everything every filter dropped. On Qualified the
  // possible predicate also enforces blocking, so it must be excluded from
  // "others" and re-checked with the block lifted — otherwise the count is 0.
  const predicates = filterPredicates();
  const excluded = new Set(['eligibility', 'possible']);
  const others = Object.entries(predicates).filter(([key]) => !excluded.has(key)).map(([, fn]) => fn);
  const hidden = state.jobs.filter((job) => job.fit?.eligibility?.verdict === 'blocked'
    && !predicates.eligibility(job)
    && (viewMode !== 'possible' || RadarScoring.isQualified(job, { includeBlocked: true }))
    && others.every((predicate) => predicate(job))).length;
  // On Qualified, the model's "different line of work" calls are set aside
  // the same way blocked jobs are — counted, never deleted, one click back.
  const setAside = viewMode === 'possible'
    ? state.jobs.filter((job) => state.matches[job.id]?.verdict === 'no'
      && RadarScoring.isQualified(job, { includeBlocked: true })).length
    : 0;
  const total = hidden + setAside;
  DOM.blockedNote.hidden = total === 0;
  if (viewMode !== 'possible') {
    DOM.blockedNote.textContent = `${hidden.toLocaleString()} blocked hidden · show`;
    return;
  }
  // The breakdown moves to the tooltip. Spelled out inline it read
  // "+714 set aside (714 blocked) · show" — a number, then the same number
  // again — on the busiest row of the page.
  const parts = [];
  if (hidden) parts.push(`${hidden.toLocaleString()} with a quoted barrier`);
  if (setAside) parts.push(`${setAside.toLocaleString()} the model reads as a different line of work`);
  DOM.blockedNote.textContent = `${total.toLocaleString()} set aside · show`;
  DOM.blockedNote.title = parts.join(' · ');
}

function filteredJobs() {
  const predicates = Object.values(filterPredicates());
  // Qualified ranks by the model's judgment first, deterministic fit only as
  // a tie-break inside a tier (and as the order for what gets judged next).
  const sorter = viewMode === 'possible'
    ? (a, b) => (matchRank(a) - matchRank(b)) || SORTERS.fit(a, b)
    : (SORTERS[DOM.sort.value] || SORTERS.fit);
  return state.jobs
    .filter((job) => predicates.every((test) => test(job)))
    .sort((a, b) => {
      const statusDelta = (isClosed(a) ? 1 : 0) - (isClosed(b) ? 1 : 0);
      if (statusDelta !== 0) return statusDelta;
      return sorter(a, b);
    });
}

// Counts for one facet, computed with every OTHER filter applied — so the
// numbers answer "what would I get if I picked this option now".
function activeFilterCount() {
  let count = 0;
  if (DOM.q.value.trim()) count += 1;
  if (visaFilter) count += 1;
  if (DOM.recency.value) count += 1;
  // Showing set-aside jobs is a departure from the default view, so it counts
  // as an active filter.
  if (showBlocked) count += 1;
  return count;
}

function clearAllFilters() {
  DOM.q.value = '';
  DOM.recency.value = '';
  DOM.sort.value = 'newest_seen';
  setVisaFilter('', { skipRender: true });
  // Reset returns to the default view, which hides set-aside jobs.
  showBlocked = false;
}

function resetFilters() {
  clearAllFilters();
  render();
}

/* ------------------------------------------------------------------------ */
/* URL state                                                                 */

function buildParams() {
  const params = new URLSearchParams();
  if (DOM.q.value.trim()) params.set('q', DOM.q.value.trim());
  if (DOM.sort.value !== 'newest_seen') params.set('sort', DOM.sort.value);
  if (visaFilter) params.set('visa', visaFilter);
  if (DOM.recency.value) params.set('recency', DOM.recency.value);
  if (showBlocked) params.set('blocked', '1');
  if (viewMode !== 'possible') params.set('view', viewMode);
  return params;
}

function syncUrl() {
  const qs = buildParams().toString();
  history.replaceState(null, '', qs ? `?${qs}` : window.location.pathname);
}

// Params of retired filters (source, type, cap, triage, minResearch,
// minVerdict, newOnly, followup, remote, includeClosed, federal) are simply
// ignored here; the first syncUrl() scrubs them from old bookmarks.
function hydrateFromUrl(paramsOverride) {
  const params = paramsOverride || new URLSearchParams(window.location.search);
  if (params.has('q')) DOM.q.value = params.get('q');
  if (params.has('sort') && SORTERS[params.get('sort')]) DOM.sort.value = params.get('sort');
  showBlocked = params.get('blocked') === '1';
  if (params.has('visa')) setVisaFilter(params.get('visa'), { skipRender: true });
  if (params.has('recency')) DOM.recency.value = params.get('recency');
  // Legacy bookmarks: ?view=routing (removed 2026-08-04) and ?view=qualified
  // (renamed 2026-08-05) both fall through to the Possible default.
  const view = params.get('view');
  if (view === 'pipeline' || view === 'radar') setViewMode(view, { skipRender: true });
}

/* ------------------------------------------------------------------------ */
/* Ignored employers. "Ignore employer" hides every posting from a place, so
   the way back has to exist somewhere; it lives in the status drawer now
   rather than the filter sidebar, which is for choosing what to look at, not
   for undoing decisions. The section hides itself when nothing is hidden. */

function renderIgnoredSection() {
  const ignored = state.local.ignored_employers || [];
  DOM.ignoredSection.hidden = ignored.length === 0;
  if (!ignored.length) return;
  DOM.ignoredSummary.textContent = `Hidden employers · ${ignored.length}`;
  DOM.ignoredPanel.replaceChildren();
  for (const employerId of ignored) {
    const name = state.jobs.find((job) => job.employer_id === employerId)?.employer_name || employerId;
    const row = el('div', 'ignored-row');
    const unhide = el('button', 'link-button', 'Unhide');
    unhide.type = 'button';
    unhide.addEventListener('click', () => unignoreEmployer(employerId));
    row.append(el('span', 'ignored-name', name), unhide);
    DOM.ignoredPanel.append(row);
  }
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

const SORT_LABELS = {
  fit: 'fit',
  evidence: 'evidence',
  research: 'research',
  capexempt: 'cap-exempt',
  newest_seen: 'newest found',
  newest_posted: 'newest posted',
  salary: 'salary',
  closing: 'closing soon'
};

// Partial-load banner in the mock's wording: what failed, what's shown, and
// the reassurance that matters (the pipeline aborts rather than overwrites —
// Tier 0 behavior). Hard failures keep the plain message.
function renderLoadBanner() {
  if (!DOM.loadError) return;
  DOM.loadError.hidden = !state.loadError;
  if (!state.loadError) return;
  DOM.loadError.replaceChildren();
  if (state.loadFailedPages > 0) {
    const pullTime = state.report?.refreshed_at
      ? new Date(state.report.refreshed_at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
      : 'last';
    DOM.loadError.append(
      el('span', '',
        `${state.loadFailedPages} of ${state.loadTotalPages} feed pages failed on the ${pullTime} pull. `
        + `${state.loadShown.toLocaleString()} of ~${state.loadTotal.toLocaleString()} jobs shown. `
        + 'Nothing was deleted — the dataset aborts rather than overwrite.')
    );
    const retry = el('button', 'ghost-button retry-pull', 'Retry pull');
    retry.id = 'retry-pull';
    retry.type = 'button';
    retry.addEventListener('click', retryLoad);
    DOM.loadError.append(retry);
  } else {
    DOM.loadError.textContent = state.loadError;
  }
}

async function reloadData() {
  state.jobs = await loadJobs();
  RadarScoring.applyJobClassifications(state.jobs, state.classifyCache);
  RadarScoring.scoreAll(state.jobs, state.compiled, state.routeCache);
  render();
  lastLoadAt = Date.now();
}

async function retryLoad() {
  const button = document.querySelector('#retry-pull');
  if (button) {
    button.disabled = true;
    button.textContent = 'Retrying…';
  }
  await reloadData();
}

// Quiet re-fetch when the user returns to a long-lived tab after a scheduled
// pull has landed. Selection survives (render only clears it if the job
// vanished); the window scrollTop is snapshotted since render() rebuilds rows.
let lastLoadAt = Date.now();
let refreshInFlight = false;

async function maybeRefreshOnFocus() {
  if (document.visibilityState !== 'visible') return;
  if (refreshInFlight || !RadarPipeline.shouldAutoRefresh(lastLoadAt, Date.now())) return;
  refreshInFlight = true;
  const savedScroll = window.scrollY;
  try {
    await reloadData();
    state.report = await loadRefreshReport();
    renderRefreshStatus(state.report);
    window.scrollTo(0, savedScroll);
  } finally {
    refreshInFlight = false;
  }
}

function renderStats() {
  // Citizen-gated federal jobs are excluded from the headline numbers — a
  // count the user is mostly ineligible for is a vanity metric, not a stat.
  const active = state.jobs.filter((job) => !isClosed(job) && !job.citizenship_gated);
  DOM.statActive.textContent = active.length.toLocaleString();
  DOM.statNew.textContent = active.filter(isNewSinceLastVisit).length.toLocaleString();
  /* Headline number = what the Possible tab actually lists.
   *
   * It used to be the eligibility predicate alone, which counted the ~4,000
   * postings the model had already read and rejected. The header said 5,108
   * and the list said 1,331, and both were labelled "possible". A headline
   * that disagrees with the list under it is worse than no headline: you
   * cannot tell which one is lying. '–' without a profile — unanswerable,
   * not zero. */
  DOM.statPossible.textContent = state.compiled
    ? state.jobs.filter((job) => RadarScoring.isQualified(job)
      && state.matches[job.id]?.verdict !== 'no').length.toLocaleString()
    : '–';
  renderHealthDot();
}

// One dot summarizes system health: red when a feed errored, a recall alarm
// fired, or the browser itself failed to load pages of data.
function renderHealthDot() {
  const report = state.report;
  const errored = (report?.employers || []).some((employer) => employer.error);
  const alarms = (report?.recall_anomalies || []).length > 0;
  const trouble = errored || alarms || Boolean(state.loadError);
  DOM.statusToggle.querySelector('.health-dot').classList.toggle('is-alarm', trouble);
  DOM.statusToggle.title = trouble
    ? 'Something needs attention — open for details'
    : 'All systems quiet';
}

function render() {
  syncUrl();
  // Stats live here, not only in reload paths — importing/clearing a profile
  // re-renders without reloading, and the strip must follow (4 linear passes
  // over the dataset, negligible at render frequency).
  renderStats();

  // "Mark all as seen" only appears when there's actually something new to clear
  const newCount = state.jobs.filter(isNewSinceLastVisit).length;
  DOM.markSeen.hidden = newCount === 0;
  DOM.markSeen.textContent = `Mark all as seen (${newCount})`;

  const filters = activeFilterCount();
  DOM.resetFilters.hidden = filters === 0;
  DOM.resetFilters.querySelector('.count-slot').textContent = `(${filters})`;
  DOM.filtersToggle.querySelector('.count-slot').textContent = filters ? `(${filters})` : '';
  renderLoadBanner();
  renderIgnoredSection();

  if (viewMode === 'pipeline') {
    // The blocked note belongs to the list views; without this it lingers
    // with a stale count from the last list render.
    DOM.blockedNote.hidden = true;
    renderPipelineList();
    renderDetail();
    return;
  }

  DOM.pipelineStats.hidden = true;
  DOM.pipelineEmpty.hidden = true;

  const jobs = filteredJobs();
  state.visible = jobs;
  DOM.count.textContent = viewMode === 'possible'
    ? possibleCountLine(jobs)
    : `${jobs.length.toLocaleString()} job${jobs.length === 1 ? '' : 's'} · sorted by ${SORT_LABELS[DOM.sort.value] || 'fit'}`;
  renderBlockedNote();
  // A hard load failure (zero rows loaded) is not "no filter matches" — show
  // the error banner instead of the empty-state hint. A *partial* load still
  // has rows, so filtering down to zero should show the normal hint with the
  // banner above it.
  const hardLoadFailure = state.jobs.length === 0 && Boolean(state.loadError);
  DOM.emptyState.hidden = jobs.length > 0 || hardLoadFailure;
  DOM.jobs.replaceChildren();

  // Possible is unanswerable without a profile — say so, never an unranked
  // fallback list or a lying "0 possible" hint. (A dead Supabase load shows
  // the error banner instead, not this.)
  if (viewMode === 'possible' && !state.compiled && !hardLoadFailure) {
    state.visible = [];
    DOM.emptyState.hidden = true;
    DOM.jobs.append(buildProfilePrompt());
    renderDetail();
    return;
  }

  if (state.selectedId && !jobs.some((job) => job.id === state.selectedId)) {
    state.selectedId = null;
  }

  const toRender = showAllRows ? jobs : jobs.slice(0, LIST_RENDER_CAP);
  if (viewMode === 'possible') {
    appendGroupedRows(toRender, jobs);
  } else {
    for (const job of toRender) DOM.jobs.append(buildRow(job));
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
  pumpMatches();
}

/* Rows under verdict headers. The list arrives already sorted by matchRank
 * then fit, so each group is contiguous and this is one pass, not a bucketing.
 *
 * Counts come from the FULL filtered list while rows come from the capped
 * slice: a header that says "Strong match · 488" when the render cap stopped
 * at 400 is telling you the truth about your shortlist, and the "show all"
 * button below handles the rest. Counting the slice instead would quietly
 * shrink every number the moment the list got long. */
function appendGroupedRows(toRender, allJobs) {
  const counts = new Map();
  for (const job of allJobs) {
    const key = groupKeyFor(job);
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  let current = null;
  for (const job of toRender) {
    const key = groupKeyFor(job);
    if (key !== current) {
      current = key;
      const header = el('div', 'group-header');
      header.append(el('span', 'group-name', GROUP_LABELS[key] || key));
      header.append(el('span', 'group-count', String(counts.get(key) || 0)));
      if (GROUP_NOTES[key]) header.append(el('span', 'group-note', GROUP_NOTES[key]));
      DOM.jobs.append(header);
    }
    DOM.jobs.append(buildRow(job));
  }
}

// Deliberately terse: the section headers now carry the breakdown, and the
// header stat carries the total. All this line adds is whether the model is
// still working through the list.
function possibleCountLine(jobs) {
  // Without a profile the list is a prompt, not a result — "0 jobs" would
  // read as an answer.
  if (!state.compiled) return '';
  const total = `${jobs.length.toLocaleString()} job${jobs.length === 1 ? '' : 's'}`;
  if (!state.matchAvailable) return total;
  const judged = jobs.filter((job) => state.matches[job.id]).length;
  return judged < jobs.length ? `${total} · ${judged.toLocaleString()} read…` : total;
}

/* The Possible tab's first-run state. There is no button: the profile is a
   file the local server reads off disk, and the honest instruction is to go
   start it — not to hand you an import dialog for a file this build no longer
   produces. */
function buildProfilePrompt() {
  const wrap = el('div', 'empty-state profile-prompt');
  wrap.append(el('h2', undefined, 'No profile loaded'));
  wrap.append(el('p', undefined,
    'Possible ranks open postings against radar/data/profile.md — who you are, in one document you write. '
    + 'Start the local radar with npm start and this page reads it off disk.'));
  wrap.append(el('p', 'profile-prompt-hint',
    'All jobs works without one. Writing the document: radar/PROFILE-PROMPT.md.'));
  return wrap;
}

// The pipeline list: only jobs the user acted on, only the search box narrows
// it. No render cap — the pipeline is dozens of rows, and slicing across
// stage groups would be incoherent.
function pipelineJobs() {
  const query = DOM.q.value.trim().toLowerCase();
  return state.jobs
    .filter((job) => RadarPipeline.PIPELINE_SET.has(triageFor(job)))
    .filter((job) => !query || jobText(job).includes(query));
}

function renderPipelineList() {
  const groups = RadarPipeline.groupPipeline(pipelineJobs(), state.local.triage);
  const visible = groups.flatMap((group) => group.jobs);
  state.visible = visible;
  DOM.count.textContent = `${visible.length} application${visible.length === 1 ? '' : 's'}`;
  DOM.emptyState.hidden = true;
  // Same rule as the radar empty-state: a hard load failure shows the error
  // banner, not a misleading "no applications yet".
  DOM.pipelineEmpty.hidden = visible.length > 0 || (state.jobs.length === 0 && Boolean(state.loadError));
  renderPipelineStats();
  DOM.jobs.replaceChildren();

  if (state.selectedId && !visible.some((job) => job.id === state.selectedId)) {
    state.selectedId = null;
  }

  let terminalWrap = null;
  for (const group of groups) {
    let host = DOM.jobs;
    if (group.terminal) {
      if (!terminalWrap) {
        // Named from the REAL groups present, so the line never claims
        // states that aren't there.
        const summaryText = groups.filter((g) => g.terminal)
          .map((g) => `${TRIAGE_LABELS[g.stage]} (${g.jobs.length})`)
          .join(' and ');
        terminalWrap = el('details', 'pipeline-terminal');
        terminalWrap.append(el('summary', '', `${summaryText} — collapsed`));
        DOM.jobs.append(terminalWrap);
      }
      host = terminalWrap;
    }
    host.append(el('div', 'group-header', `${TRIAGE_LABELS[group.stage]} · ${group.jobs.length}`));
    for (const job of group.jobs) host.append(buildRow(job));
  }
}

// Funnel counts over the whole dataset (not the search-narrowed list, so the
// numbers stay stable while typing). Leads with New + Shortlist so the strip
// reads as the whole funnel, even though those stages live in the radar view.
function renderPipelineStats() {
  const counts = { new: 0, shortlist: 0 };
  for (const job of state.jobs) {
    const status = triageFor(job);
    if (status === 'new' && !isClosed(job)) counts.new += 1;
    else if (status === 'shortlist') counts.shortlist += 1;
    else if (RadarPipeline.PIPELINE_SET.has(status)) counts[status] = (counts[status] || 0) + 1;
  }
  const always = new Set(['new', 'shortlist', 'applied', 'interview', 'offer']);
  DOM.pipelineStats.replaceChildren();
  for (const stage of ['new', 'shortlist', 'emailed_lab', 'needs_visa_check', 'applied', 'interview', 'offer']) {
    const total = counts[stage] || 0;
    if (total === 0 && !always.has(stage)) continue;
    const cell = el('div', 'stage-cell');
    cell.append(
      el('span', `stage-count${stage === 'new' ? ' stat-accent' : ''}`, total.toLocaleString()),
      el('span', 'stage-label', TRIAGE_LABELS[stage])
    );
    DOM.pipelineStats.append(cell);
  }
  DOM.pipelineStats.hidden = false;
}

/* ------------------------------------------------------------------------ */
/* Status panel — the seven systems behind the dataset, one drawer           */

const GITHUB_REPO_URL = 'https://github.com/ChristianMangwanda/veritas-research-radar';

// Static facts about each system; live bits come from the refresh report and
// the discovery feed. No fabricated activity history — the only tile with
// per-run squares is the radar itself, drawn from the CURRENT report.
const INSTRUMENTS = [
  { id: 'radar', label: 'Research job radar', cadence: 'every 6h' },
  { id: 'firehose', label: 'Aggregator firehose', cadence: '2× daily' },
  { id: 'scout', label: 'Employer scout', cadence: 'weekly' },
  { id: 'enrich', label: 'Enrichment', cadence: 'monthly · IPEDS/IRS' },
  { id: 'pages', label: 'Deploy to Pages', cadence: 'every 6h' },
  { id: 'digest', label: 'Daily digest', cadence: 'needs NTFY_TOPIC' },
  { id: 'deadman', label: 'Dead-man switch', cadence: 'every 2h' }
];

// Everything live inside the status drawer: the next-pull countdown and the
// system tiles. Re-run on refresh-report updates and every drawer open, so
// the countdown is honest whenever it's actually visible.
function renderStatusPanel() {
  DOM.statusRefresh.replaceChildren();
  const head = el('div', 'instrument-head');
  const nextAt = RadarPipeline.nextPullAt(Date.now());
  const windowMs = 6 * 3600 * 1000;
  const elapsed = Math.max(0, Math.min(1, 1 - (nextAt - Date.now()) / windowMs));
  const gauge = el('span', 'pull-gauge');
  const gaugeFill = el('i');
  gaugeFill.style.width = `${Math.round(elapsed * 100)}%`;
  gauge.append(gaugeFill);
  const pullNow = el('a', 'ghost-button pull-now', 'Pull now ↗');
  pullNow.href = `${GITHUB_REPO_URL}/actions/workflows/research-radar.yml`;
  pullNow.target = '_blank';
  pullNow.rel = 'noreferrer';
  pullNow.title = 'Opens the GitHub Actions workflow — Run workflow triggers a pull';
  head.append(el('span', 'instrument-head-label', 'Next pull'), gauge,
    el('span', 'instrument-eta', formatEta(nextAt - Date.now())), pullNow);
  DOM.statusRefresh.append(head);
  renderJudgeProgress();

  DOM.statusInstruments.replaceChildren();
  const tiles = el('div', 'instrument-tiles');
  const report = state.report;
  for (const instrument of INSTRUMENTS) {
    const tile = el('div', `instrument-tile${instrument.id === 'digest' ? ' is-dashed' : ''}`);
    tile.append(el('span', 'instrument-label', instrument.label));
    const detail = el('span', 'instrument-detail');
    let detailText = instrument.cadence;
    if (instrument.id === 'radar' && report?.refreshed_at) {
      detailText = `${instrument.cadence} · ${new Date(report.refreshed_at)
        .toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
    } else if (instrument.id === 'scout' && state.discovery?.candidates?.length) {
      detailText = `${instrument.cadence} · +${state.discovery.candidates.length} found`;
    } else if (instrument.id === 'deadman') {
      const alarms = (report?.recall_anomalies || []).length;
      const errored = (report?.employers || []).filter((employer) => employer.error).length;
      detailText = alarms || errored ? `every 2h · ALARM` : 'every 2h · quiet';
      if (alarms || errored) tile.classList.add('is-alarm');
    }
    detail.textContent = detailText;
    tile.append(detail);

    // Real per-employer outcome squares on the radar tile only (current pull)
    if (instrument.id === 'radar' && report?.employers?.length) {
      const squares = el('span', 'activity-squares');
      for (const employer of report.employers.slice(0, 40)) {
        const kind = employer.error ? 'sq-error' : employer.skipped ? 'sq-skip' : 'sq-ok';
        const square = el('i', `sq ${kind}`);
        square.title = `${employer.name}${employer.error ? ` — ${employer.error}` : employer.skipped ? ' — skipped' : ''}`;
        squares.append(square);
      }
      if (report.employers.length > 40) {
        squares.append(el('span', 'sq-more', `+${report.employers.length - 40}`));
      }
      tile.append(squares);
    }
    tiles.append(tile);
  }
  DOM.statusInstruments.append(tiles);
  renderStatusProfile();
}

/* How far the model has got through the qualified list. This belongs in the
 * status drawer and not above the list: reading 989 postings is hours of
 * background work, so it wants a place you can check, not a number that sits
 * in front of you counting. Absent entirely on the hosted dashboard, which
 * has no model behind it. */
function renderJudgeProgress() {
  if (!state.matchAvailable || !state.compiled) return;
  const qualified = state.jobs.filter((job) => RadarScoring.isQualified(job));
  const read = qualified.filter((job) => state.matches[job.id]).length;
  const row = el('div', 'instrument-head');
  const bar = el('span', 'pull-gauge');
  const fill = el('i');
  fill.style.width = `${qualified.length ? Math.round((read / qualified.length) * 100) : 0}%`;
  bar.append(fill);
  row.append(
    el('span', 'instrument-head-label', 'Postings read'),
    bar,
    el('span', 'instrument-eta', `${read.toLocaleString()} / ${qualified.length.toLocaleString()}`)
  );
  /* Counted here rather than reported by a server queue. Judging runs in CI
   * after each refresh now, so "still queued" is not a live number this page
   * could know — what it can say is how much of the pool has been read. */
  const unread = qualified.length - read;
  row.title = unread
    ? `${unread.toLocaleString()} not read yet — the next scheduled run reads them`
    : 'Everything qualified has been read';
  DOM.statusRefresh.append(row);
}

// The evidence sub-line under a row's visa tag — strongest behavioral signal
// first: class-specific certifications, then any LCA history, then the
// cap-exempt read. One line, so the column never wraps into chip soup.
function visaEvidenceLine(job) {
  if (job.class_evidence?.certified_count_3y) {
    return `×${job.class_evidence.certified_count_3y} ${job.title_class_label || 'matching'} roles`;
  }
  if (job.dol_lca_certified_count_3y) return `${job.dol_lca_certified_count_3y} LCAs · 3y`;
  return CAP_LABELS[job.cap_exempt_status] || '';
}

const BLOCKER_LABELS = {
  citizenship: 'citizens only',
  degree: 'degree',
  experience: 'experience',
  license: 'licence',
  profession: 'different profession',
  clearance: 'clearance',
  student_only: 'students only',
  internal_only: 'internal only'
};

// "+7 over ML/comp-bio" — how decisively the RECOMMENDED variant beats the
// best other one. When a local-LLM verdict picked a variant the deterministic
// scores didn't rank first, a "+N over" line would contradict itself; say who
// made the call instead. Single variant: no runner-up, so say the verdict.
function buildRow(job) {
  const node = DOM.rowTemplate.content.firstElementChild.cloneNode(true);
  node.dataset.id = job.id;
  const status = triageFor(job);
  const fit = job.fit;

  // ROLE — flags line, title, employer sub-line, note excerpt, pipeline meta
  const flags = node.querySelector('.row-flags');
  const addFlag = (text, kind = '') => flags.append(el('span', `flag ${kind}`, text));
  if (isNewSinceLastVisit(job)) addFlag('NEW', 'flag-accent');
  if (status !== 'new') addFlag(TRIAGE_LABELS[status], 'flag-status');
  /* The verdict, on the tabs that have no section header to carry it. In
   * Possible the group heading says it once for a whole run of rows; in All
   * jobs and Applied there is no heading, and dropping the Match column would
   * otherwise leave a strong match and a stretch looking identical. */
  const verdict = state.matches[job.id]?.verdict;
  if (viewMode !== 'possible' && verdict) {
    addFlag(GROUP_LABELS[verdict] || verdict, VERDICT_FLAGS[verdict] || '');
  }
  const eligibility = job.fit?.eligibility;
  if (eligibility?.verdict === 'blocked') {
    addFlag(`BLOCKED — ${BLOCKER_LABELS[eligibility.blockers[0]?.type] || 'requirement'}`, 'flag-red');
  } else if (eligibility?.insufficient_text) {
    // Distinct from a clean read: the posting was too thin to judge.
    addFlag('thin text', 'flag-muted');
  }
  /* The degree gate, which used to sit in the Résumé-sent column. It fires
   * where the eligibility blocker does not: a posting that asks for a doctorate
   * without a sentence clean enough to quote is not blocked, but it is still
   * the thing worth knowing before you spend an evening on the application.
   * Only shown when no BLOCKED flag already said it. */
  const degreeGate = job.fit?.gate?.degree;
  if (eligibility?.verdict !== 'blocked'
    && degreeGate?.required && !degreeGate.met && !degreeGate.softened) {
    addFlag(`${degreeGate.required} required`, 'flag-warn');
  }
  const age = followupAgeDays(job);
  if (age !== null && age >= FOLLOWUP_STALE_DAYS) addFlag(`${age}d no update`, 'flag-red');
  if (isClosed(job)) {
    node.classList.add('is-closed');
    addFlag(PROTECTED_TRIAGE.has(status) ? 'closed — verify' : 'closed', 'flag-red');
  }
  flags.hidden = flags.children.length === 0;

  node.querySelector('.row-title').textContent = job.title;
  const subParts = [job.employer_name, job.location || 'Location unspecified'];
  if (job.work_mode === 'hybrid') subParts.push('Hybrid');
  else if (job.remote === true) subParts.push('Remote');
  const salaryText = formatSalary(job);
  if (salaryText) subParts.push(salaryText);
  node.querySelector('.row-sub').textContent = subParts.join(' · ');

  const note = noteFor(job);
  if (note) {
    const noteEl = node.querySelector('.row-note');
    noteEl.textContent = `📝 ${note.length > 80 ? `${note.slice(0, 80)}…` : note}`;
    noteEl.hidden = false;
  }

  if (viewMode === 'pipeline') {
    const record = state.local.triage[job.id];
    const metaParts = [];
    const appliedAge = RadarPipeline.daysSince(record?.applied_at);
    if (appliedAge !== null) metaParts.push(appliedAge === 0 ? 'applied today' : `applied ${appliedAge}d ago`);
    if (age === null) {
      // Stage age for the states followupAgeDays deliberately excludes
      // (offer/rejected/withdrawn) — in-flight rows carry the no-update flag.
      const stageAge = RadarPipeline.daysSince(record?.updated_at);
      if (stageAge !== null && stageAge > 0) metaParts.push(`in stage ${stageAge}d`);
    } else if (age > 0 && age < FOLLOWUP_STALE_DAYS) {
      metaParts.push(`updated ${age}d ago`);
    }
    if (metaParts.length) {
      const metaEl = node.querySelector('.row-meta');
      metaEl.textContent = metaParts.join(' · ');
      metaEl.hidden = false;
    }
  }

  /* MATCH — the reasoning only.
   *
   * There used to be a Match column here carrying the verdict as a chip plus a
   * fit number and bar. The verdict is a section heading now (or a flag, on
   * the ungrouped tabs), and the number was a compressed keyword count that
   * printing as "53" made look like a percentage — it lives in the detail
   * pane, where the words around it say what it is. What stays on the row is
   * what neither a heading nor a score can give you: what the model says
   * matched, and what it says is missing. */
  const judgment = state.matches[job.id];
  if (judgment) {
    const line = node.querySelector('.row-match');
    line.replaceChildren();
    if (judgment.role_summary && judgment.verdict === 'no') {
      line.append(el('span', 'match-why', judgment.role_summary));
    }
    for (const reason of judgment.reasons || []) line.append(el('span', 'match-why', `+ ${reason}`));
    for (const gap of judgment.gaps || []) line.append(el('span', 'match-why match-gap', `− ${gap}`));
    line.hidden = line.childElementCount === 0;
  }

  // VISA — the tag always renders (the mock's column has no blank cells)
  const visaTag = node.querySelector('.visa-tag');
  visaTag.textContent = job.veritas_state === 'NEUTRAL' ? 'No info' : (VISA_LABELS[job.veritas_state] || job.veritas_state);
  visaTag.classList.add('tag');
  if (VISA_TAGS[job.veritas_state]) visaTag.classList.add(VISA_TAGS[job.veritas_state]);
  const evidence = visaEvidenceLine(job);
  if (evidence) node.querySelector('.visa-evidence').textContent = evidence;

  // CLOSES
  const closes = node.querySelector('.cell-closes');
  const days = deadlineDays(job);
  if (days != null && days >= 0) {
    closes.textContent = `${days}d`;
    if (days <= 7) closes.classList.add('closes-soon');
  } else {
    closes.textContent = '—';
  }

  if (job.id === state.selectedId) node.classList.add('is-selected');

  // Row-level quick action: open the posting and arm the "did you apply?"
  // nudge without a trip through the detail pane. Only for jobs not yet in
  // the pipeline — same rule as the nudge itself.
  if (viewMode !== 'pipeline' && job.url && !isClosed(job) && NUDGE_STATES.has(triageFor(job))) {
    const apply = el('button', 'row-apply', 'Apply ↗');
    apply.type = 'button';
    apply.title = 'Open the posting — then mark it applied';
    apply.addEventListener('click', (event) => {
      event.stopPropagation();
      window.open(job.url, '_blank', 'noreferrer');
      selectJob(job.id);
      maybeNudgeApply(job);
    });
    node.append(apply);
  }

  node.addEventListener('click', () => selectJob(job.id));
  node.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      event.stopPropagation();
      selectJob(job.id);
    }
  });
  return node;
}

function selectJob(id, { scroll = false } = {}) {
  state.selectedId = id;
  // querySelectorAll, not children: pipeline rows can sit inside the
  // collapsed "closed out" <details>.
  for (const row of DOM.jobs.querySelectorAll('.job-row')) {
    row.classList.toggle('is-selected', row.dataset.id === id);
  }
  const row = DOM.jobs.querySelector(`[data-id="${CSS.escape(id)}"]`);
  if (row) {
    const wrap = row.closest('details');
    if (wrap) wrap.open = true;
    if (scroll) row.scrollIntoView({ block: 'nearest' });
  }
  renderDetail();
}

function selectedJob() {
  return state.visible.find((job) => job.id === state.selectedId) || null;
}

function renderDetail() {
  const job = selectedJob();

  // Narrow layouts show the detail pane as an overlay only when a row is
  // selected; wide layouts keep it always present.
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
  const postedAge = RadarPipeline.daysSince(job.posted_or_updated_at);
  DOM.detailMeta.textContent = [
    job.employer_name,
    job.location || 'Location unspecified',
    job.department || null,
    formatSalary(job),
    job.work_mode === 'hybrid' ? 'Hybrid' : null,
    formatDeadline(job),
    postedAge !== null ? (postedAge === 0 ? 'posted today' : `posted ${postedAge}d ago`) : null
  ].filter(Boolean).join(' · ');
  DOM.detailOpen.href = job.url;

  renderTriageControls(job);
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

// The stepper renders progress (done steps filled soft, the current step
// solid); a terminal status dims it and shows a state line with a Reopen
// escape hatch instead.
function renderTriageControls(job) {
  const current = triageFor(job);
  const currentIndex = STEPPER_ORDER.indexOf(current);
  const terminal = currentIndex === -1;
  DOM.triageStepper.classList.toggle('is-terminal', terminal);
  for (const button of DOM.triageStepper.querySelectorAll('button')) {
    const index = STEPPER_ORDER.indexOf(button.dataset.value);
    button.classList.toggle('is-active', !terminal && index === currentIndex);
    button.classList.toggle('is-done', !terminal && index < currentIndex);
  }
  for (const button of DOM.triageLinks.querySelectorAll('button')) {
    button.classList.toggle('is-active', button.dataset.value === current);
  }
  if (terminal) {
    const age = RadarPipeline.daysSince(state.local.triage[job.id]?.updated_at);
    DOM.triageStateLine.replaceChildren(
      el('span', '', `${TRIAGE_LABELS[current] || current}${age !== null && age > 0 ? ` · ${age}d ago` : ''} — `)
    );
    const reopen = el('button', 'link-button', 'Reopen');
    reopen.type = 'button';
    reopen.addEventListener('click', () => setTriage(job, 'new'));
    DOM.triageStateLine.append(reopen);
    DOM.triageStateLine.hidden = false;
  } else {
    DOM.triageStateLine.hidden = true;
  }
}

// The stepper shows the forward path of an application; terminal outcomes
// (rejected/withdrawn/ignore) are demoted to links below it — they are exits,
// not stages you progress through.
const STEPPER_ORDER = ['new', 'shortlist', 'emailed_lab', 'needs_visa_check', 'applied', 'interview', 'offer'];
const STEPPER_LABELS = {
  new: 'New',
  shortlist: 'Shortlist',
  emailed_lab: 'Emailed',
  needs_visa_check: 'Visa',
  applied: 'Applied',
  interview: 'Interview',
  offer: 'Offer'
};
const TRIAGE_LINK_LABELS = { rejected: 'Reject', withdrawn: 'Withdraw', ignore: 'Ignore' };

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
  actions.append(open);

  const controls = el('div', 'triage-controls');
  controls.id = 'triage-controls';
  const controlsLabel = el('p', 'field-label', 'Triage');
  const stepper = el('div', 'triage-stepper');
  stepper.id = 'triage-stepper';
  stepper.setAttribute('role', 'group');
  stepper.setAttribute('aria-label', 'Application stage');
  for (const value of STEPPER_ORDER) {
    const button = el('button', '', STEPPER_LABELS[value]);
    button.type = 'button';
    button.dataset.value = value;
    stepper.append(button);
  }
  const stateLine = el('p', 'triage-state-line');
  stateLine.id = 'triage-state-line';
  stateLine.hidden = true;
  const links = el('div', 'triage-links');
  links.id = 'triage-links';
  for (const [value, label] of Object.entries(TRIAGE_LINK_LABELS)) {
    const button = el('button', 'link-button', label);
    button.type = 'button';
    button.dataset.value = value;
    links.append(button);
  }
  // An action, not a status — no data-value, so the triage delegation skips it
  const ignoreEmp = el('button', 'link-button ignore-employer', 'Ignore employer');
  ignoreEmp.id = 'ignore-employer';
  ignoreEmp.type = 'button';
  ignoreEmp.title = 'Hide every posting from this employer (undo in the sidebar; jobs you acted on stay)';
  links.append(ignoreEmp);
  controls.append(controlsLabel, stepper, stateLine, links);

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

  /* `fit` before `signals`: the model's verdict and the eligibility ledger are
   * what you opened the job to read. The sponsorship and institution signals
   * are context you check second, once you already believe the role fits. */
  return [back, head, actions, controls, notes, alerts, fit, signals, description, disclaimer];
}

function rebindDetailRefs() {
  DOM.detailBack = document.querySelector('#detail-back');
  DOM.detailTitle = document.querySelector('#detail-title');
  DOM.detailMeta = document.querySelector('#detail-meta');
  DOM.detailOpen = document.querySelector('#detail-open');
  DOM.triageControls = document.querySelector('#triage-controls');
  DOM.triageStepper = document.querySelector('#triage-stepper');
  DOM.triageStateLine = document.querySelector('#triage-state-line');
  DOM.triageLinks = document.querySelector('#triage-links');
  DOM.detailNote = document.querySelector('#detail-note');
  DOM.detailAlerts = document.querySelector('#detail-alerts');
  DOM.detailSignals = document.querySelector('#detail-signals');
  DOM.detailFit = document.querySelector('#detail-fit');
  DOM.detailDescription = document.querySelector('#detail-description-body');
  DOM.detailDisclaimer = document.querySelector('#detail-disclaimer');
  bindDetailEvents();
}

// States where opening the posting plausibly means "I'm about to apply" —
// anything already in the pipeline doesn't need the reminder.
const NUDGE_STATES = new Set(['new', 'shortlist', 'emailed_lab', 'needs_visa_check']);

function maybeNudgeApply(job) {
  if (!NUDGE_STATES.has(triageFor(job))) return;
  applyNudgeJobId = job.id;
  renderDetail();
}

function renderDetailAlerts(job) {
  DOM.detailAlerts.replaceChildren();
  if (applyNudgeJobId === job.id && NUDGE_STATES.has(triageFor(job))) {
    const nudge = el('div', 'alert alert-info apply-nudge');
    nudge.append(el('span', '', 'Opened the posting — did you apply?'));
    const mark = el('button', 'ghost-button', 'Mark applied');
    mark.type = 'button';
    mark.addEventListener('click', () => {
      applyNudgeJobId = null;
      setTriage(job, 'applied');
    });
    const dismiss = el('button', 'ghost-button', 'Dismiss');
    dismiss.type = 'button';
    dismiss.addEventListener('click', () => {
      applyNudgeJobId = null;
      renderDetail();
    });
    nudge.append(mark, dismiss);
    DOM.detailAlerts.append(nudge);
  }
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
  researchCell.querySelector('dd').append(el('span', 'signal-note', `Source: ${job.source || '—'} feed`));
  DOM.detailSignals.append(researchCell);

  DOM.detailSignals.append(
    signalCell('First seen / posted',
      document.createTextNode(`${shortDate(job.first_seen_at)} · ${shortDate(job.posted_or_updated_at)}`))
  );

  const appliedAt = state.local.triage[job.id]?.applied_at;
  if (appliedAt) {
    const age = RadarPipeline.daysSince(appliedAt);
    DOM.detailSignals.append(signalCell('Applied',
      document.createTextNode(`${shortDate(appliedAt)}${age !== null ? ` · ${age}d ago` : ''}`)));
  }

  if (job.dol_recent_titles?.length) {
    const cell = signalCell('Recent sponsored titles', document.createTextNode(job.dol_recent_titles.slice(0, 4).join(' · ')));
    cell.style.gridColumn = '1 / -1';
    DOM.detailSignals.append(cell);
  }
}

// Terms the recommended variant matched in this posting (for highlighting)
// Highlighting wants what the posting actually SAYS: matched_text holds the
// surface forms that hit ("torch", "ETL pipelines"), while matched[] holds the
// canonical résumé terms the why-panel prints.
function recommendedMatchedTerms(fit) {
  const variant = (fit?.variants || [])[0];
  if (!variant) return [];
  if (variant.matched_text?.length) return variant.matched_text;
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

  /* The model's read, at the top of the pane.
   *
   * It was never here — the verdict lived only in a row column, so opening a
   * job to decide whether it was worth an evening showed you every
   * deterministic signal and none of the actual judgment. Now that the column
   * is gone, the pane is where the reasoning belongs, in full rather than as
   * the row's excerpt. */
  const judgment = state.matches[job.id];
  if (judgment) {
    const block = el('div', 'detail-judgment');
    const head = el('p', 'detail-judgment-head');
    head.append(tag(MATCH_LABELS[judgment.verdict] || judgment.verdict, MATCH_TAGS[judgment.verdict] || ''));
    if (judgment.role_summary) head.append(el('span', 'detail-judgment-role', judgment.role_summary));
    block.append(head);
    for (const reason of judgment.reasons || []) block.append(el('p', 'match-why', `+ ${reason}`));
    for (const gap of judgment.gaps || []) block.append(el('p', 'match-why match-gap', `− ${gap}`));
    DOM.detailFit.append(block);
  }

  const fit = job.fit;
  if (!fit || fit.fit_score === null) {
    DOM.detailFit.append(el('p', 'fit-skills', fit ? fit.fit_summary : ''));
    return;
  }

  /* This used to headline a routing call — "Send this one" — computed by
   * scoring seven résumés against the posting and printing the winner plus the
   * margin it won by, and then a chooser recording which one you actually
   * sent. Both are gone: the profile is one document, and which résumé to
   * attach is a decision made offline by someone who has read the posting.
   * What's left is the deterministic score, kept here and nowhere else —
   * in a detail pane it reads as the hint it is, and on a row it read as a
   * percentage the arithmetic never earned. */
  DOM.detailFit.append(el('p', 'send-verdict',
    `${fit.verdict} fit · ${fit.fit_score} / 100 keyword overlap`));

  // Eligibility first: whether the application can be considered at all
  // outranks how well it scores. Every barrier shows the sentence it came
  // from, so a wrong call is visible rather than mysterious.
  const ledger = el('div', 'why-ledger');
  const eligibility = fit.eligibility;
  if (eligibility) {
    const verdictText = eligibility.verdict === 'blocked' ? 'blocked'
      : eligibility.verdict === 'likely' ? 'likely eligible'
        : 'clear to apply';
    const line = whyLine('Eligibility', document.createTextNode(verdictText));
    const value = line.querySelector('.why-value');
    for (const entry of [...eligibility.blockers, ...eligibility.cautions]) {
      const label = BLOCKER_LABELS[entry.type] || entry.type;
      const isBlocker = eligibility.blockers.includes(entry);
      value.append(el('span', `signal-note${isBlocker ? ' is-warn' : ''}`,
        `${isBlocker ? '⚠' : '·'} ${label}${entry.detail ? ` (${entry.detail})` : ''}${entry.evidence ? `: “${entry.evidence}”` : ''}`));
    }
    if (eligibility.insufficient_text) {
      value.append(el('span', 'signal-note', '· posting text too short to judge — read it before ruling it out'));
    }
    ledger.append(line);
  }
  /* The "Role track" line is gone. It reported whether a posting's title class
   * appeared in your profile's track list — and profile.md deliberately sets
   * no track list, because guessing one would invent a constraint you never
   * stated. So the line printed "outside your tracks" on every job, including
   * the ones the model had just called a strong match. A field that always
   * says the same wrong thing is worse than an absent one. */
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

  // Was "your résumé text never leaves the machine" — true when a local model
  // read your résumés, and false since. The posting and profile.md go to the
  // API; say so rather than leaving a reassurance that stopped being accurate.
  DOM.detailFit.append(el('p', 'send-footnote',
    'Keyword score computed here · the verdict above comes from the API reading this posting against profile.md'));
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
// A visa clause is a sentence at most. Anything longer is a capture bug.
const HIGHLIGHT_PHRASE_LIMIT = 200;

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
      // 202 of 3,671 captured phrases are extraction spill rather than a
      // phrase — one runs 14,262 characters, the whole posting. Highlighting
      // those paints the entire description one colour and says nothing.
      // Classification still uses them; only the highlight is skipped.
      if (phrase.length > HIGHLIGHT_PHRASE_LIMIT) continue;
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
  // Warm swatch = visa language, blue = skills. Naming which kind of visa
  // language it is earns the two warm shades their difference.
  const entries = [
    job.veritas_state === 'RESTRICTED'
      ? ['var(--mark-restricted)', 'restrictive visa language']
      : ['var(--mark-friendly)', 'visa-friendly language'],
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
  const before = state.local.triage[job.id];
  pushUndo(
    { type: 'triage', jobId: job.id, prev: before ? { ...before } : undefined },
    `${TRIAGE_LABELS[status] || status} — was ${TRIAGE_LABELS[before?.status || 'new']}`
  );
  const prev = before || {};
  const now = new Date().toISOString();
  const record = { ...prev, status, updated_at: now };
  // Stamp the first time it becomes "applied" so the funnel remembers when you
  // actually applied, independent of any later interview/offer change.
  // Which résumé went is NOT guessed: it used to be back-filled from whichever
  // variant scored highest, which quietly recorded something you never did.
  // Pick it in the detail pane, or leave it blank.
  if (status === 'applied' && !record.applied_at) record.applied_at = now;
  state.local.triage[job.id] = record;
  await persistTriage(job.id);
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
  await persistTriage(job.id);
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

function setViewMode(value, { skipRender = false } = {}) {
  viewMode = value === 'pipeline' || value === 'radar' ? value : 'possible';
  for (const button of DOM.viewSeg.querySelectorAll('button')) {
    button.classList.toggle('is-active', button.dataset.value === viewMode);
  }
  document.body.classList.toggle('pipeline-mode', viewMode === 'pipeline');
  document.body.classList.toggle('possible-mode', viewMode === 'possible');
  showAllRows = false;
  if (!skipRender) render();
}

/* ------------------------------------------------------------------------ */
/* Keyboard triage                                                           */

/* Undo: a small stack over triage changes and employer ignores. The bar is
   transient feedback (6s); the stack outlives it, so u / Cmd+Z can keep
   walking back after the bar hides. */

const UNDO_MAX = 20;
const undoStack = [];
let undoTimer = null;

function pushUndo(entry, message) {
  undoStack.push(entry);
  if (undoStack.length > UNDO_MAX) undoStack.shift();
  showUndoBar(message);
}

function showUndoBar(message) {
  if (!DOM.undoBar) return;
  DOM.undoMsg.textContent = message;
  DOM.undoBar.hidden = false;
  clearTimeout(undoTimer);
  undoTimer = setTimeout(hideUndoBar, 6000);
}

function hideUndoBar() {
  clearTimeout(undoTimer);
  if (DOM.undoBar) DOM.undoBar.hidden = true;
}

async function undoLast() {
  const entry = undoStack.pop();
  hideUndoBar();
  if (!entry) return;
  if (entry.type === 'triage') {
    // Direct restore, never through setTriage — no re-entrant undo push, and
    // restoreTriageRecord keeps absent ≠ {status:'new'} for sync/LWW.
    state.local.triage = RadarPipeline.restoreTriageRecord(state.local.triage, entry.jobId, entry.prev);
    await persistTriage(entry.jobId);
    render();
  } else if (entry.type === 'ignore_employer') {
    state.local.ignored_employers = (state.local.ignored_employers || [])
      .filter((id) => id !== entry.employerId);
    state.selectedId = entry.prevSelectedId;
    await persistIgnoredEmployers();
    render();
  }
}

// Uppercase 'O' (shift+o) is deliberate — plain 'o' opens the posting. The
// modifier bail below ignores shiftKey, so shifted letters land here. Known
// trade: CapsLock+o reads as 'O' and sets offer; not worth case-folding.
const TRIAGE_KEYS = {
  s: 'shortlist', a: 'applied', e: 'emailed_lab', v: 'needs_visa_check',
  i: 'interview', O: 'offer', r: 'rejected', w: 'withdrawn',
  x: 'ignore', n: 'new'
};

function handleKeydown(event) {
  const target = event.target;
  const typing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;

  if (event.key === '/' && !typing) {
    event.preventDefault();
    DOM.q.focus();
    return;
  }
  // Cmd/Ctrl+Z must beat the modifier bail — but not while typing, where the
  // note textarea keeps the browser's native text undo.
  if (event.key === 'z' && (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && !typing) {
    event.preventDefault();
    undoLast();
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
  } else if (event.key === 'o') {
    const job = selectedJob();
    if (job) {
      window.open(job.url, '_blank', 'noreferrer');
      maybeNudgeApply(job);
    }
  } else if (event.key === 'Enter') {
    // Rows stop propagation; a focused button/link must keep native
    // activation — only bare-body Enter re-reveals the selected job.
    if (event.target !== document.body) return;
    const job = selectedJob();
    if (job) {
      event.preventDefault();
      selectJob(job.id, { scroll: true });
    }
  } else if (event.key === 'u') {
    undoLast();
  } else if (TRIAGE_KEYS[event.key]) {
    const job = selectedJob();
    if (job) setTriage(job, TRIAGE_KEYS[event.key]);
  } else if (event.key === 'Escape') {
    if (!DOM.statusPanel.hidden) {
      DOM.statusPanel.hidden = true;
    } else if (narrowLayout.matches) {
      state.selectedId = null;
      render();
    }
  }
}

/* ------------------------------------------------------------------------ */
/* Header widgets                                                            */

function formatEta(ms) {
  const minutes = Math.max(0, Math.round(ms / 60000));
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

// The one-line pulse under the brand: refresh time, countdown to the next
// scheduled pull, newly closed. Re-rendered on a minute interval so the
// countdown stays honest without re-rendering anything else.
function renderRefreshMetaLine() {
  const report = state.report;
  if (!report?.refreshed_at) return;
  const refreshedAt = new Date(report.refreshed_at)
    .toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const eta = RadarPipeline.nextPullAt(Date.now()) - Date.now();
  const parts = [`Refreshed ${refreshedAt}`, `next pull ${formatEta(eta)}`];
  if (report.newly_closed_count) parts.push(`${report.newly_closed_count} newly closed`);
  DOM.refreshMeta.textContent = parts.join(' · ');
}

function renderRefreshStatus(report) {
  if (!report) {
    DOM.refreshMeta.textContent = 'No refresh report yet — run npm run radar:refresh.';
    return;
  }
  renderRefreshMetaLine();

  const errored = (report.employers || []).filter((employer) => employer.error);
  DOM.errorsList.hidden = errored.length === 0;
  DOM.errorsList.replaceChildren();
  for (const employer of errored) {
    DOM.errorsList.append(el('li', '', `${employer.name} (${employer.ats_provider}) — ${employer.error}`));
  }
  renderStatusPanel();
  renderHealthDot();
}

function renderDiscovery(discovery) {
  const candidates = discovery?.candidates || [];
  if (!candidates.length) return;
  // A maintenance queue, not a coverage stat — it lives collapsed in the
  // status drawer. (The list is capped upstream at 250 by enrich.js.)
  DOM.discoverySummary.textContent = `Employer discovery queue · ${candidates.length} candidates`;
  DOM.discoveryList.replaceChildren();
  for (const candidate of candidates.slice(0, 10)) {
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
  if (candidates.length > 10) {
    DOM.discoveryList.append(el('p', 'drawer-note',
      `Top 10 of ${candidates.length} shown — the full queue lives in radar/data/discovery-candidates.json.`));
  }
}

/* ------------------------------------------------------------------------ */
/* Events + init                                                             */

function toggleStatusPanel() {
  const opening = DOM.statusPanel.hidden;
  // Re-render on open so the countdown reflects now, not page-load time.
  if (opening) renderStatusPanel();
  DOM.statusPanel.hidden = !opening;
}

function bindDetailEvents() {
  // One delegation covers the stepper AND the demoted terminal links —
  // both live inside #triage-controls and carry data-value.
  DOM.triageControls.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-value]');
    const job = selectedJob();
    if (button && job) setTriage(job, button.dataset.value);
  });
  DOM.detailBack.addEventListener('click', () => {
    state.selectedId = null;
    render();
  });

  document.querySelector('#ignore-employer').addEventListener('click', () => {
    const job = selectedJob();
    if (job) ignoreEmployer(job);
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

  // The nudge also fires from the detail pane's own open-posting link (the
  // <a> navigates normally; this just adds the reminder).
  DOM.detailOpen.addEventListener('click', () => {
    const job = selectedJob();
    if (job) maybeNudgeApply(job);
  });
}

function markAllSeen() {
  state.lastVisit = new Date().toISOString();
  localStorage.setItem(LAST_VISIT_KEY, state.lastVisit);
  render();
}

function bindEvents() {
  // Any filter/sort change re-caps the list: a fresh filter shouldn't inherit a
  // previous "show all N" expansion. (render() itself must NOT reset the cap —
  // triage edits etc. re-render and should keep the list expanded.)
  const onFilterChange = () => { showAllRows = false; render(); };
  // The search box fires per keystroke over thousands of jobs — debounce it;
  // the discrete inputs (selects, checkboxes) fire once, so bind them directly.
  let searchTimer = null;
  DOM.q.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(onFilterChange, 150);
  });
  for (const input of [DOM.sort, DOM.recency]) {
    input.addEventListener('input', onFilterChange);
  }

  DOM.markSeen.addEventListener('click', markAllSeen);
  DOM.undoBtn.addEventListener('click', undoLast);

  if (DOM.authForm) DOM.authForm.addEventListener('submit', handleSignIn);
  if (DOM.authSignout) DOM.authSignout.addEventListener('click', handleSignOut);
  if (DOM.profileSave) DOM.profileSave.addEventListener('click', saveProfileDocument);
  if (DOM.profileCancel) DOM.profileCancel.addEventListener('click', closeProfileEditor);

  DOM.blockedNote.addEventListener('click', () => {
    showBlocked = !showBlocked;
    showAllRows = false;
    render();
  });

  DOM.viewSeg.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-value]');
    if (button) setViewMode(button.dataset.value);
  });

  DOM.visaSeg.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-value]');
    if (button) setVisaFilter(button.dataset.value);
  });

  DOM.resetFilters.addEventListener('click', resetFilters);
  DOM.emptyReset.addEventListener('click', resetFilters);
  DOM.filtersToggle.addEventListener('click', () => document.body.classList.toggle('show-filters'));

  DOM.statusToggle.addEventListener('click', toggleStatusPanel);

  DOM.statusPanel.addEventListener('click', async (event) => {
    const button = event.target.closest('.copy-cmd');
    if (!button) return;
    try {
      await navigator.clipboard.writeText(button.dataset.cmd);
      button.textContent = 'Copied ✓';
      setTimeout(() => { button.textContent = 'Copy'; }, 1500);
    } catch { /* clipboard denied — the command is right there to select */ }
  });
  for (const button of document.querySelectorAll('.drawer-close')) {
    button.addEventListener('click', () => {
      button.closest('.drawer').hidden = true;
    });
  }

  document.addEventListener('keydown', handleKeydown);
  document.addEventListener('visibilitychange', maybeRefreshOnFocus);
  narrowLayout.addEventListener('change', renderDetail);
  // Detail events bind in rebindDetailRefs() after the skeleton is built —
  // the shell in index.html is empty until the first selection.
}

async function init() {
  // Light-only since the 2026-08-03 redesign — drop any stored dark preference
  try { localStorage.removeItem('veritas_radar_theme'); } catch { /* fine */ }
  // Saved views retired with the 2026-08-04 three-tab restructure
  try { localStorage.removeItem('veritas_radar_views'); } catch { /* fine */ }
  // The token-gated triage sync was retired 2026-08-05 and replaced by a real
  // account; a stale shared secret must not sit in localStorage either way.
  try { localStorage.removeItem('veritas_radar_sync_token'); } catch { /* fine */ }
  // The profile and route cache used to be mirrored here by the localhost
  // bridge. The profile lives in your account now, and route-cache never
  // shipped — leaving copies behind would mean an old profile could outlive
  // an edit made on another device.
  try { localStorage.removeItem('veritas_radar_profile'); } catch { /* fine */ }
  try { localStorage.removeItem('veritas_radar_route_cache'); } catch { /* fine */ }
  // The "NEW" watermark must NOT advance on every load — that made everything
  // stop being NEW the moment you reloaded. Read it and leave it; only an
  // explicit "Mark all as seen" advances it. Seed it once on the very first
  // visit so the entire backlog isn't flagged NEW.
  state.lastVisit = localStorage.getItem(LAST_VISIT_KEY);
  if (!state.lastVisit) {
    state.lastVisit = new Date().toISOString();
    localStorage.setItem(LAST_VISIT_KEY, state.lastVisit);
  }
  // Normalize the default view's body classes even when no ?view param will
  // call setViewMode (hydrateFromUrl only calls it for non-default views).
  setViewMode(viewMode, { skipRender: true });
  hydrateFromUrl();

  /* Public data first — postings, the refresh report, the discovery queue —
   * because none of it needs an account and the list should be on screen
   * before any auth round-trip finishes. */
  const [jobs, report, discovery] = await Promise.all([
    loadJobs(),
    loadRefreshReport(),
    getJson('/api/discovery', { candidates: [] })
  ]);
  state.jobs = jobs;
  // Job-side classifications describe the posting, not the person, so they
  // apply before scoring and regardless of whether a profile is loaded.
  // (Browser-only: the server never had a classify-cache route.)
  state.classifyCache = loadClassifyCacheFromBrowser();
  RadarScoring.applyJobClassifications(state.jobs, state.classifyCache);
  state.report = report || null;
  state.discovery = discovery || null;
  // Signed out, triage is whatever this browser accumulated; signing in merges
  // it upward and takes over.
  state.local = loadTriageFromBrowser();
  if (!Array.isArray(state.local.ignored_employers)) state.local.ignored_employers = [];
  /* Score with no profile so every job carries a fit stamp. All jobs sorts on
   * job.fit whether or not anyone is signed in, and an unstamped job crashes
   * the comparator — which is exactly what happened when this call was moved
   * behind the sign-in. */
  applyProfile(null, null);
  renderAuthSection();
  renderRefreshStatus(report);
  renderDiscovery(discovery);
  // Keep the next-pull countdown honest without touching anything else
  setInterval(renderRefreshMetaLine, 60000);
  bindEvents();

  // Preselect the first job on wide screens so the detail pane is never empty
  render();
  if (!narrowLayout.matches && state.visible.length && !state.selectedId) {
    selectJob(state.visible[0].id);
  }

  /* Your half of the data, after the public half is already drawn. Then a
   * quiet poll: the 6-hourly job writes judgments while nothing is open, and
   * a tab left up all day should notice without being reloaded. */
  await loadAuthedState();
  render();
  setInterval(() => { loadJudgments(); }, 60000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) loadJudgments();
  });
}

init();
