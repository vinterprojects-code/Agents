/* Agent Control Panel
 * Static page that talks to api.github.com directly with a fine-grained token kept in localStorage.
 * The token is only ever sent to https://api.github.com (see api()). It is never logged.
 */
'use strict';

const API = 'https://api.github.com';
const WORKFLOW = 'agent-team.yml';
const POLL_MS = 10000;
const KEYS = { token: 'agentPanel.token', repo: 'agentPanel.repo', polling: 'agentPanel.polling' };

const AGENTS = {
  manager:   { name: 'Manager',   jobs: { manager: 'Planning', finalize: 'Wrapping up' } },
  developer: { name: 'Developer', jobs: { developer: 'Coding', 'developer-fix': 'Coding (fix round)' } },
  qa:        { name: 'QA',        jobs: { qa: 'Testing', 'qa-retest': 'Re-testing' } },
};
const JOB_AGENT = {};
for (const [k, a] of Object.entries(AGENTS)) for (const j of Object.keys(a.jobs)) JOB_AGENT[j] = k;

const LABELS = {
  'agent:manager':   { color: 'B794FF', description: 'Task starts with the manager (plans first)' },
  'agent:developer': { color: '35D4F5', description: 'Task starts with the developer (skips planning)' },
  'priority:high':   { color: 'FF7A7A', description: 'High priority' },
  'priority:normal': { color: '9AA7C2', description: 'Normal priority' },
  'priority:low':    { color: '243049', description: 'Low priority' },
};

/* ------------------------------------------------------------------ storage */
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* storage blocked */ } },
};
// The previous dashboard kept a read-only token under this key. It is not used any more.
store.del('agentTok');

/* -------------------------------------------------------------------- state */
const S = {
  token: store.get(KEYS.token) || '',
  repo: store.get(KEYS.repo) || store.get('agentRepo') || guessRepo(),
  polling: store.get(KEYS.polling) !== 'off',
  me: null, repoInfo: null, canAct: false,
  rate: { remaining: null, limit: null, reset: null, blockedUntil: 0 },
  lastUpdate: 0, lastError: null,
  data: {},             // shared caches
  filters: { agent: 'all', prState: 'open' },
  ui: { prTab: 'overview', sbsFile: null, msgOpen: {} },
};

function guessRepo() {
  // https://OWNER.github.io/REPO/dashboard/  ->  OWNER/REPO
  const m = location.hostname.match(/^([^.]+)\.github\.io$/i);
  const seg = location.pathname.split('/').filter(Boolean)[0];
  return m && seg ? `${m[1]}/${seg}` : '';
}

/* ---------------------------------------------------------------- utilities */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Small element builder. Children may be strings (text nodes), nodes, arrays, or falsy (skipped). */
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  append(el, kids);
  return el;
}
function append(el, ...kids) {
  for (const c of kids.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
function setKids(el, ...kids) { el.replaceChildren(); return append(el, kids); }

function ago(iso) {
  if (!iso) return '';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
const timeEl = iso => h('time', { datetime: iso, title: iso ? new Date(iso).toLocaleString() : '' }, ago(iso));
const clock = ms => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const R = () => S.repo;
const isOwnerLogin = login => !!S.repoInfo && login === S.repoInfo.owner.login;

/* ------------------------------------------------------------------ GitHub API */
class ApiError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; Object.assign(this, extra || {}); }
}
const etags = new Map();

function trackRate(res) {
  const rem = res.headers.get('x-ratelimit-remaining');
  if (rem != null) {
    S.rate.remaining = +rem;
    S.rate.limit = +res.headers.get('x-ratelimit-limit');
    S.rate.reset = +res.headers.get('x-ratelimit-reset') * 1000;
  }
}

/**
 * Calls the GitHub REST API. GETs use ETags, so unchanged data costs no rate limit.
 * Throws ApiError with a readable message for every failure.
 */
async function api(path, { method = 'GET', body, accept, raw = false, cache = true } = {}) {
  const url = path.startsWith('https://') ? path : API + path;
  if (!url.startsWith(API + '/')) throw new ApiError(0, 'Blocked a request to a non-GitHub address.');
  if (S.rate.blockedUntil > Date.now()) throw rateError(S.rate.blockedUntil);

  const headers = {
    Accept: accept || 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    Authorization: `Bearer ${S.token}`,
  };
  const key = `${accept || ''} ${url}`;
  const cached = method === 'GET' && cache ? etags.get(key) : null;
  if (cached) headers['If-None-Match'] = cached.etag;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let res;
  try {
    res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' });
  } catch {
    throw new ApiError(0, 'Could not reach GitHub. Check your connection.');
  }
  trackRate(res);
  if (res.status === 304 && cached) return cached.data;

  const text = res.status === 204 ? '' : await res.text();
  let data = null;
  if (text) {
    if (raw && res.ok) data = text;
    else { try { data = JSON.parse(text); } catch { data = text; } }
  }

  if (!res.ok) {
    const msg = (data && data.message) || res.statusText || 'Request failed';
    const remaining = res.headers.get('x-ratelimit-remaining');
    if ((res.status === 403 || res.status === 429) && (remaining === '0' || /rate limit/i.test(msg))) {
      const retry = +res.headers.get('retry-after');
      const until = retry ? Date.now() + retry * 1000 : (+res.headers.get('x-ratelimit-reset') * 1000 || Date.now() + 60000);
      S.rate.blockedUntil = until;
      showRateBanner();
      throw rateError(until);
    }
    let detail = '';
    if (data && Array.isArray(data.errors)) {
      detail = data.errors.map(e => (typeof e === 'string' ? e : e.message || [e.field, e.code].filter(Boolean).join(' '))).filter(Boolean).join('; ');
    }
    throw new ApiError(res.status, describe(res.status, msg, detail));
  }
  if (method === 'GET' && cache) {
    const et = res.headers.get('etag');
    if (et) etags.set(key, { etag: et, data });
  }
  return data;
}

function describe(status, rawMsg, detail) {
  const msg = String(rawMsg).replace(/\.+$/, '');
  const d = detail ? ` (${detail})` : '';
  if (status === 401) return 'GitHub rejected the token (it may be expired or revoked). Disconnect in Settings and connect with a new token.';
  if (status === 403) return `GitHub refused this action: ${msg}${d}. The token may be missing a permission (see Settings → Token permissions).`;
  if (status === 404) return `Not found: ${msg}. The item may not exist, or the token can't see it.`;
  return `GitHub error ${status}: ${msg}${d}`;
}
function rateError(until) {
  return new ApiError(429, `GitHub rate limit reached. It resets at ${clock(until)}.`, { rateLimited: true, reset: until });
}
const errText = e => (e && e.message) || String(e);

const paged = path => api(path + (path.includes('?') ? '&' : '?') + 'per_page=100');

/* -------------------------------------------------------------- data loaders */
async function loadCore() {
  const r = R();
  const [issues, pulls, runsRes, workflow] = await Promise.all([
    api(`/repos/${r}/issues?state=all&labels=agent-task&sort=updated&direction=desc&per_page=100`),
    api(`/repos/${r}/pulls?state=open&per_page=50`),
    api(`/repos/${r}/actions/workflows/${WORKFLOW}/runs?per_page=40`),
    api(`/repos/${r}/actions/workflows/${WORKFLOW}`),
  ]);
  const tasks = issues.filter(i => !i.pull_request);
  // Runs for labels other than agent-task are skipped instantly. Ignore them.
  const runs = runsRes.workflow_runs.filter(x => x.conclusion !== 'skipped');
  for (const run of runs) run._issue = issueOfRun(run, tasks);
  Object.assign(S.data, { tasks, pulls, runs, workflow });
  return S.data;
}

function issueOfRun(run, tasks) {
  const m = (run.display_title || run.name || '').match(/issue #(\d+)/i);
  if (m) return +m[1];
  // Runs started before the run-name change are titled with the issue title.
  const t = tasks.find(i => i.title === run.display_title);
  return t ? t.number : null;
}

async function loadJobs(runIds) {
  const r = R();
  const out = {};
  await Promise.all(runIds.map(async id => {
    out[id] = (await api(`/repos/${r}/actions/runs/${id}/jobs?per_page=50`)).jobs;
  }));
  return out;
}

// GitHub's own setup/cleanup steps say nothing about what the agent is doing.
const isHousekeeping = name => /^(Set up job|Complete job|Post |Run actions\/checkout)/.test(name);

const activeRuns = () => (S.data.runs || []).filter(x => x.status !== 'completed');

function linkedPull(issueNumber, pulls) {
  return (pulls || []).find(p => {
    const m = p.head && p.head.ref.match(/^agent\/issue-(\d+)$/);
    if (m && +m[1] === issueNumber) return true;
    return new RegExp(`\\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\\s+#${issueNumber}\\b`, 'i').test(p.body || '');
  });
}

function taskColumn(t) {
  if (t.state === 'closed') return 'done';
  if (linkedPull(t.number, S.data.pulls)) return 'review';
  if (activeRuns().some(x => x._issue === t.number)) return 'progress';
  return 'pending';
}
const labelVal = (t, prefix) => {
  const l = (t.labels || []).map(x => (typeof x === 'string' ? x : x.name)).find(n => n.startsWith(prefix));
  return l ? l.slice(prefix.length) : null;
};

/** Combines check runs and commit statuses for a commit. */
async function loadChecks(sha) {
  const r = R();
  const [cr, st] = await Promise.all([
    api(`/repos/${r}/commits/${sha}/check-runs?per_page=100`),
    api(`/repos/${r}/commits/${sha}/status`),
  ]);
  const items = [];
  for (const c of cr.check_runs || []) {
    const state = c.status !== 'completed' ? 'pending'
      : ['success', 'neutral', 'skipped'].includes(c.conclusion) ? 'success' : 'failure';
    items.push({ name: c.name, state, detail: c.status !== 'completed' ? c.status.replace('_', ' ') : c.conclusion, url: c.html_url, kind: 'Check run' });
  }
  for (const s of st.statuses || []) {
    items.push({ name: s.context, state: s.state === 'error' ? 'failure' : s.state, detail: s.description || s.state, url: s.target_url, kind: 'Status' });
  }
  const overall = items.some(i => i.state === 'failure') ? 'failure'
    : items.some(i => i.state === 'pending') ? 'pending' : items.length ? 'success' : 'none';
  return { items, overall };
}

function qaVerdict(pr, checks) {
  const st = checks && checks.items.find(i => i.name === 'Agent QA');
  if (st) return { verdict: st.state === 'success' ? 'PASS' : st.state === 'pending' ? 'PENDING' : 'FAIL', source: 'Agent QA status' };
  const m = (pr.body || '').match(/QA verdict:\s*([A-Z]+)/);
  return m ? { verdict: m[1], source: 'pull request description' } : null;
}

/* ------------------------------------------------------------------ UI bits */
function stateBox(text, retry) {
  return h('div', { class: 'state' }, h('p', {}, text), retry && h('button', { type: 'button', class: 'btn sm', onclick: retry }, 'Retry'));
}
function errorBox(e, retry) {
  return h('div', { class: 'error-box', role: 'alert' }, errText(e), retry && h('div', {}, h('button', { type: 'button', class: 'btn sm', style: 'margin-top:8px', onclick: retry }, 'Retry')));
}
const loading = (n = 3) => h('div', { 'aria-busy': 'true', 'aria-label': 'Loading' }, Array.from({ length: n }, () => h('div', { class: 'skeleton' })));

let toastTimer;
function toast(msg, isError) {
  const t = $('#toast');
  // An open modal dialog sits above everything else, so show the toast inside it.
  const host = [...document.querySelectorAll('dialog[open]')].pop() || document.body;
  if (t.parentNode !== host) host.appendChild(t);
  t.textContent = msg;
  t.className = 'toast' + (isError ? ' err' : '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, isError ? 9000 : 5000);
}

function confirmDialog(title, text, okLabel = 'Confirm', danger = false) {
  const d = $('#confirm');
  $('#cf-title').textContent = title;
  $('#cf-text').textContent = text;
  const ok = $('#cf-ok');
  ok.textContent = okLabel;
  ok.className = 'btn ' + (danger ? 'danger' : 'primary');
  d.returnValue = '';
  d.showModal();
  return new Promise(res => d.addEventListener('close', () => res(d.returnValue === 'ok'), { once: true }));
}

function stateBadge(state, label) {
  const cls = { success: 'ok', failure: 'bad', pending: 'warn', none: 'plain' }[state] || 'plain';
  return h('span', { class: `badge ${cls}` }, label);
}
const checkLabel = o => ({ success: 'Checks passing', failure: 'Checks failing', pending: 'Checks running', none: 'No checks' }[o]);

/** Runs an async action from a button: disables it, shows errors, never fails silently. */
async function act(btn, fn, okMsg) {
  if (!S.canAct) { toast(notOwnerText(), true); return; }
  const label = btn && btn.textContent;
  if (btn) { btn.disabled = true; btn.setAttribute('aria-busy', 'true'); btn.textContent = 'Working…'; }
  try {
    const r = await fn();
    if (okMsg) toast(typeof okMsg === 'function' ? okMsg(r) : okMsg);
    refresh(true);
    return r;
  } catch (e) {
    toast(errText(e), true);
  } finally {
    if (btn && btn.isConnected) { btn.disabled = false; btn.removeAttribute('aria-busy'); btn.textContent = label; }
  }
}
const notOwnerText = () => `Read-only: you are signed in as ${S.me ? S.me.login : '?'}, but only the repo owner (${S.repoInfo ? S.repoInfo.owner.login : '?'}) can act from this panel.`;
function ownerOnly(btn) { if (!S.canAct) { btn.disabled = true; btn.title = notOwnerText(); } return btn; }

/* ---------------------------------------------------------------- avatars */
const av = (bg, body, hair, skin, extra) => `<svg viewBox="0 0 64 64" width="48" height="48" aria-hidden="true"><rect width="64" height="64" fill="${bg}"/><path d="M10 66Q10 46 32 46Q54 46 54 66Z" fill="${body}"/><rect x="28" y="38" width="8" height="9" fill="${skin}"/><circle cx="32" cy="30" r="13" fill="${skin}"/><path d="M19 29Q18 13 32 13Q46 13 45 29Q40 21 32 22Q24 21 19 29Z" fill="${hair}"/><circle cx="27.5" cy="31" r="1.4" fill="#2C2C2A"/><circle cx="36.5" cy="31" r="1.4" fill="#2C2C2A"/><path d="M28 37Q32 40 36 37" stroke="#8A5436" stroke-width="1.5" fill="none" stroke-linecap="round"/>${extra}</svg>`;
const AVATARS = {
  manager: av('#2a2147', '#7a5fd6', '#2C2C2A', '#E8B894', '<path d="M26 45L32 52L30 45Z" fill="#fff"/><path d="M38 45L32 52L34 45Z" fill="#fff"/><path d="M32 49l-3 4 3 11 3-11z" fill="#FAC775"/>'),
  developer: av('#0f2f38', '#1597b3', '#6B4423', '#C98B63', '<path d="M17 31Q16 9 32 9Q48 9 47 31" stroke="#2C2C2A" stroke-width="3" fill="none"/><rect x="14" y="27" width="6" height="10" rx="3" fill="#85B7EB"/><rect x="44" y="27" width="6" height="10" rx="3" fill="#85B7EB"/>'),
  qa: av('#3a2a10', '#c98a2a', '#712B13', '#F5CBA7', '<circle cx="46" cy="22" r="5" fill="#712B13"/><circle cx="27.5" cy="31" r="5" stroke="#2C2C2A" stroke-width="1.5" fill="none"/><circle cx="36.5" cy="31" r="5" stroke="#2C2C2A" stroke-width="1.5" fill="none"/>'),
};
function avatarEl(key) { const d = h('div', { class: 'avatar' }); d.innerHTML = AVATARS[key]; return d; }

/* ================================================================== ROUTER */
const TITLES = { overview: 'Overview', tasks: 'Tasks', prs: 'Pull requests', settings: 'Settings' };
function route() {
  const [screen = 'overview', id] = location.hash.replace(/^#\/?/, '').split('/');
  return { screen: TITLES[screen] ? screen : 'overview', id: id ? +id : null };
}
function go(hash) { if (location.hash !== hash) location.hash = hash; else render(); }

let renderToken = 0;
function render() {
  const { screen, id } = route();
  $('#page-title').textContent = TITLES[screen];
  document.title = `${TITLES[screen]} · Agent Control Panel`;
  $$('.nav-btn').forEach(b => b.toggleAttribute('aria-current', false));
  $$(`.nav-btn[data-route="${screen}"]`).forEach(b => b.setAttribute('aria-current', 'page'));
  const view = $('#view');
  // Opening or closing a task card keeps the board mounted.
  if (screen === 'tasks' && view.dataset.screen === 'tasks' && view.childElementCount) {
    if (id && TaskPanel.num !== id) TaskPanel.open(id);
    return;
  }
  renderToken++;
  view.replaceChildren();
  view.dataset.screen = screen;
  if (screen === 'overview') Overview.mount(view);
  if (screen === 'tasks') Tasks.mount(view, id);
  if (screen === 'prs') (id ? PRDetail.mount(view, id) : PRList.mount(view));
  if (screen === 'settings') Settings.mount(view);
  if (screen !== 'tasks' && $('#task-panel').open) $('#task-panel').close();
  refresh(true);
}

/* ================================================================ POLLING */
let pollTimer = null, refreshing = null, pendingRefresh = false;
function schedule() {
  clearTimeout(pollTimer);
  if (!S.polling || !S.token) return;
  pollTimer = setTimeout(async () => {
    if (!document.hidden) await refresh();
    schedule();
  }, POLL_MS);
}
async function refresh(force) {
  if (!S.token) return;
  if (refreshing) { if (force) pendingRefresh = true; return refreshing; }
  const { screen } = route();
  const token = renderToken;
  refreshing = (async () => {
    try {
      if (screen === 'overview') await Overview.update();
      if (screen === 'tasks') await Tasks.update();
      if (screen === 'prs') await (route().id ? PRDetail.update() : PRList.update());
      if (screen === 'settings') await Settings.update();
      S.lastError = null;
      S.lastUpdate = Date.now();
      if (S.rate.blockedUntil && S.rate.blockedUntil < Date.now()) { S.rate.blockedUntil = 0; hideBanner(); }
    } catch (e) {
      S.lastError = e;
      if (token === renderToken) showScreenError(e);
    } finally {
      refreshing = null;
      updateLive();
      if (pendingRefresh) { pendingRefresh = false; refresh(); }
    }
  })();
  return refreshing;
}
function showScreenError(e) {
  const slot = $('#screen-error');
  if (slot) setKids(slot, errorBox(e, () => refresh(true)));
  else toast(errText(e), true);
}
function updateLive() {
  const parts = [];
  let cls = 'pulse';
  if (S.rate.blockedUntil > Date.now()) { cls += ' err'; parts.push(`Rate limited until ${clock(S.rate.blockedUntil)}`); }
  else if (S.lastError) { cls += ' err'; parts.push('Last update failed'); }
  else if (!S.polling) { cls += ' off'; parts.push('Live updates off'); }
  else parts.push(document.hidden ? 'Paused (tab hidden)' : 'Live, every 10 s');
  if (S.lastUpdate) parts.push(`updated ${clock(S.lastUpdate)}`);
  for (const el of [$('#live-top'), $('#live-side')]) setKids(el, h('span', { class: cls, 'aria-hidden': 'true' }), parts.join(' · '));
  const slot = $('#screen-error');
  if (slot && !S.lastError) slot.replaceChildren();
}
document.addEventListener('visibilitychange', () => {
  updateLive();
  if (!document.hidden && S.polling && S.token) { refresh(); schedule(); }
});

function showRateBanner() {
  const b = $('#banner');
  b.className = 'banner';
  b.textContent = `GitHub rate limit reached. Requests are paused until ${clock(S.rate.blockedUntil)}, then resume automatically.`;
  b.hidden = false;
  clearTimeout(showRateBanner.t);
  showRateBanner.t = setTimeout(() => { S.rate.blockedUntil = 0; hideBanner(); refresh(true); }, Math.max(1000, S.rate.blockedUntil - Date.now() + 1000));
}
function hideBanner() { $('#banner').hidden = true; }

/* Re-render a region only when its data actually changed (keeps focus and scroll stable). */
const sigs = new Map();
function changed(key, value) {
  const s = JSON.stringify(value);
  if (sigs.get(key) === s) return false;
  sigs.set(key, s);
  return true;
}

/* ================================================================ OVERVIEW */
const Overview = {
  mount(view) {
    sigs.clear();
    append(view,
      h('div', { id: 'screen-error' }),
      h('section', { class: 'section', 'aria-labelledby': 'ov-stats' },
        h('h2', { id: 'ov-stats', class: 'sr-only', style: 'position:absolute;left:-9999px' }, 'Stats'),
        h('div', { class: 'grid tiles', id: 'ov-tiles' }, loading(2))),
      h('section', { class: 'section', 'aria-labelledby': 'ov-agents-h' },
        h('div', { class: 'section-head' }, h('h2', { id: 'ov-agents-h' }, 'Agents'), h('div', { id: 'ov-wf' })),
        h('p', { class: 'muted small', style: 'margin:-4px 0 12px' }, 'All three agents run in one GitHub Actions workflow ("Agent team"). Pause and Resume switch that workflow off and on, so they affect the whole team. Stop cancels the run the agent is working in.'),
        h('div', { class: 'grid agents', id: 'ov-agents' }, loading(4))),
      h('div', { class: 'grid two-col' },
        h('section', { class: 'panel', 'aria-labelledby': 'ov-wait-h' },
          h('div', { class: 'section-head' }, h('h2', { id: 'ov-wait-h' }, 'Waiting for you')),
          h('div', { id: 'ov-wait' }, loading(3))),
        h('section', { class: 'panel', 'aria-labelledby': 'ov-feed-h' },
          h('div', { class: 'section-head' }, h('h2', { id: 'ov-feed-h' }, 'Activity')),
          h('div', { id: 'ov-feed' }, loading(5)))),
    );
  },

  async update() {
    await loadCore();
    const d = S.data;
    // Jobs: every active run, plus the last few finished runs (for "last step" on idle agents;
    // the newest finished run may have been cancelled before an agent ran).
    const finished = d.runs.filter(x => x.status === 'completed').slice(0, 3);
    const ids = [...activeRuns().map(x => x.id), ...finished.map(x => x.id)];
    const jobs = await loadJobs([...new Set(ids)]);
    if (route().screen !== 'overview') return;
    this.renderTiles();
    this.renderAgents(jobs, finished);
    await Promise.all([this.renderWaiting(), this.renderFeed()]);
  },

  renderTiles() {
    const { tasks, pulls } = S.data;
    const weekAgo = Date.now() - 7 * 86400000;
    const open = tasks.filter(t => t.state === 'open');
    const stats = [
      ['Open tasks', open.length],
      ['In progress', open.filter(t => taskColumn(t) === 'progress').length],
      ['Awaiting review', pulls.length],
      ['Done this week', tasks.filter(t => t.state === 'closed' && Date.parse(t.closed_at) >= weekAgo).length],
    ];
    if (!changed('tiles', stats)) return;
    setKids($('#ov-tiles'), stats.map(([l, n]) => h('div', { class: 'panel tile' }, h('div', { class: 'lbl' }, l), h('div', { class: 'num' }, n))));
  },

  agentState(key, jobs, finished) {
    const a = AGENTS[key];
    for (const run of activeRuns()) {
      const js = jobs[run.id] || [];
      const job = js.find(j => JOB_AGENT[j.name] === key && j.status === 'in_progress');
      if (job) return { status: a.jobs[job.name], working: true, run, job };
    }
    for (const run of activeRuns()) {
      const js = jobs[run.id] || [];
      const job = js.find(j => JOB_AGENT[j.name] === key && (j.status === 'queued' || j.status === 'waiting' || j.status === 'pending'));
      if (job) return { status: 'Waiting', waiting: true, run, job };
    }
    let lastJob = null;
    for (const run of finished) {
      lastJob = (jobs[run.id] || []).filter(j => JOB_AGENT[j.name] === key && j.conclusion !== 'skipped').pop();
      if (lastJob) break;
    }
    return { status: 'Idle', run: null, job: null, lastJob };
  },

  renderAgents(jobs, finished) {
    const wf = S.data.workflow;
    const paused = wf.state !== 'active';
    const wfSig = [wf.state];
    if (changed('wf', wfSig)) {
      setKids($('#ov-wf'), paused ? h('span', { class: 'badge warn' }, `Team paused (${wf.state.replace(/_/g, ' ')})`) : h('span', { class: 'badge ok' }, 'Team active'));
    }
    const states = Object.keys(AGENTS).map(k => [k, this.agentState(k, jobs, finished)]);
    const sig = states.map(([k, s]) => [k, s.status, s.run && s.run.id, s.job && s.job.id, s.job && s.job.steps.map(x => x.status + x.conclusion), s.lastJob && s.lastJob.id, paused, S.ui.msgOpen[k], s.run && s.run._issue]);
    if (!changed('agents', sig)) return;
    // keep any message being typed
    const drafts = {};
    $$('#ov-agents textarea').forEach(t => { drafts[t.dataset.agent] = t.value; });
    setKids($('#ov-agents'), states.map(([k, s]) => this.agentCard(k, s, paused, drafts[k])));
  },

  agentCard(key, s, paused, draft) {
    const a = AGENTS[key];
    const issueNo = s.run ? s.run._issue : null;
    const task = issueNo && S.data.tasks.find(t => t.number === issueNo);
    let progress = 0, step = null, progressText = '';
    if (s.job && s.job.steps && s.job.steps.length) {
      const steps = s.job.steps;
      const done = steps.filter(x => x.status === 'completed').length;
      progress = Math.round(done / steps.length * 100);
      step = steps.find(x => x.status === 'in_progress') || [...steps].reverse().find(x => x.status === 'completed');
      progressText = `Step ${Math.min(done + 1, steps.length)} of ${steps.length}`;
    }
    let logline;
    if (s.working && step && isHousekeeping(step.name)) {
      const last = [...s.job.steps].reverse().find(x => x.status === 'completed' && !isHousekeeping(x.name));
      logline = `▶ ${step.name}${last ? ` (after: ${last.name})` : ''}`;
    } else if (s.working && step) logline = `▶ ${step.name}`;
    else if (s.waiting) logline = `… queued: ${s.job.name}`;
    else if (s.lastJob) {
      const lastStep = [...(s.lastJob.steps || [])].reverse().find(x => x.conclusion && x.conclusion !== 'skipped' && !isHousekeeping(x.name));
      const mark = s.lastJob.conclusion === 'success' ? '✓' : '✗';
      logline = `${mark} ${s.lastJob.name}: ${lastStep ? lastStep.name : 'finished'} (${s.lastJob.conclusion}) · ${ago(s.lastJob.completed_at)}`;
    } else logline = 'No runs yet';

    const badgeCls = s.working ? 'working' : s.waiting ? 'warn' : paused ? 'warn' : 'plain';
    const badgeText = !s.working && !s.waiting && paused ? 'Paused' : s.status;

    const pauseBtn = ownerOnly(h('button', { type: 'button', class: 'btn sm', onclick: e => this.togglePause(e.currentTarget, paused) }, paused ? 'Resume' : 'Pause'));
    const stopBtn = ownerOnly(h('button', { type: 'button', class: 'btn sm danger', disabled: !s.run, title: s.run ? '' : 'Nothing running', onclick: e => this.stop(e.currentTarget, s.run, a.name) }, 'Stop'));
    const msgBtn = ownerOnly(h('button', { type: 'button', class: 'btn sm', disabled: !issueNo, title: issueNo ? '' : 'No current task to message about', 'aria-expanded': String(!!S.ui.msgOpen[key]), onclick: () => { S.ui.msgOpen[key] = !S.ui.msgOpen[key]; sigs.delete('agents'); refresh(true); } }, 'Message'));
    if (!s.run) stopBtn.disabled = true;
    if (!issueNo) msgBtn.disabled = true;

    let msgForm = null;
    if (S.ui.msgOpen[key] && issueNo) {
      const id = `msg-${key}`;
      const ta = h('textarea', { id, rows: 3, dataset: { agent: key }, required: true });
      ta.value = draft || '';
      msgForm = h('form', { class: 'message-form', onsubmit: e => {
        e.preventDefault();
        const text = ta.value.trim();
        if (!text) { toast('Write a message first.', true); return; }
        act(e.submitter, async () => {
          await api(`/repos/${R()}/issues/${issueNo}/comments`, { method: 'POST', body: { body: `**Message for the ${a.name.toLowerCase()} agent:**\n\n${text}` } });
          ta.value = ''; S.ui.msgOpen[key] = false; sigs.delete('agents');
        }, `Message posted on issue #${issueNo}. The agents read the owner's comments when their next step starts.`);
      } },
      h('label', { for: id }, `Message to ${a.name} (posted as a comment on #${issueNo})`), ta,
      h('button', { type: 'submit', class: 'btn sm primary' }, 'Post message'));
    }

    return h('article', { class: `panel agent ${key}${s.working ? ' working' : ''}`, 'aria-label': `${a.name} agent` },
      h('div', { class: 'agent-head' }, avatarEl(key),
        h('div', {}, h('div', { class: 'agent-name' }, a.name), h('span', { class: `badge ${badgeCls}` }, badgeText))),
      h('dl', { class: 'kv' },
        h('dt', {}, 'Task'), h('dd', {}, issueNo ? h('a', { href: `#/tasks/${issueNo}` }, `#${issueNo} ${task ? task.title : ''}`) : '—'),
        h('dt', {}, 'Run'), h('dd', {}, s.run ? h('a', { href: s.run.html_url, target: '_blank', rel: 'noopener' }, `#${s.run.run_number} (${s.run.status.replace('_', ' ')})`) : '—')),
      h('div', {},
        h('div', { class: 'meta', style: 'margin:0 0 4px' }, s.job ? progressText : 'No active job'),
        h('div', { class: 'progress', role: 'progressbar', 'aria-label': `${a.name} progress`, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': progress }, h('i', { style: `width:${progress}%` }))),
      h('div', {}, h('div', { class: 'meta', style: 'margin:0 0 4px' }, 'Last step'), h('div', { class: 'logline', title: logline }, logline)),
      h('div', { class: 'btn-row' }, pauseBtn, stopBtn, msgBtn),
      msgForm);
  },

  async togglePause(btn, paused) {
    const ok = await confirmDialog(paused ? 'Resume the team?' : 'Pause the team?',
      paused ? 'This switches the "Agent team" workflow back on. New tasks will start again.'
        : 'This switches off the "Agent team" workflow for all three agents. New tasks will not start. A run already in progress keeps going unless you press Stop.',
      paused ? 'Resume' : 'Pause');
    if (!ok) return;
    act(btn, () => api(`/repos/${R()}/actions/workflows/${WORKFLOW}/${paused ? 'enable' : 'disable'}`, { method: 'PUT' }),
      paused ? 'Team resumed.' : 'Team paused. No new runs will start.');
  },

  async stop(btn, run, who) {
    const ok = await confirmDialog('Stop this run?', `Cancels run #${run.run_number} (issue #${run._issue || '?'}). ${who} and every later step in this run stop.`, 'Stop run', true);
    if (!ok) return;
    act(btn, () => api(`/repos/${R()}/actions/runs/${run.id}/cancel`, { method: 'POST' }), 'Cancel requested. GitHub stops the run within a few seconds.');
  },

  async renderWaiting() {
    const box = $('#ov-wait');
    const pulls = S.data.pulls;
    if (!pulls.length) { if (changed('wait', [])) setKids(box, stateBox('Nothing to review. Open pull requests appear here.')); return; }
    const rows = await Promise.all(pulls.slice(0, 15).map(async p => {
      try { return { p, checks: await loadChecks(p.head.sha) }; } catch (e) { return { p, err: e }; }
    }));
    const sig = rows.map(r => [r.p.number, r.p.updated_at, r.checks && r.checks.overall, r.err && errText(r.err)]);
    if (!changed('wait', sig)) return;
    setKids(box, h('ul', { class: 'list' }, rows.map(({ p, checks, err }) => {
      const qa = qaVerdict(p, checks);
      return h('li', {},
        h('div', { class: 'grow' },
          h('div', { class: 'title-line' }, `#${p.number} ${p.title}`),
          h('div', { class: 'meta' },
            p.draft ? h('span', { class: 'badge warn' }, 'Draft') : null,
            err ? h('span', { class: 'badge bad' }, 'Checks unavailable') : stateBadge(checks.overall, checkLabel(checks.overall)),
            qa ? h('span', { class: `badge ${qa.verdict === 'PASS' ? 'ok' : qa.verdict === 'PENDING' ? 'warn' : 'bad'}` }, `QA ${qa.verdict}`) : null,
            h('span', { class: 'mono' }, p.head.ref), timeEl(p.updated_at))),
        h('button', { type: 'button', class: 'btn sm primary', onclick: () => go(`#/prs/${p.number}`) }, 'Review'));
    })));
  },

  async renderFeed() {
    const box = $('#ov-feed');
    const r = R();
    let events = [], comments = [], err = null;
    try {
      [events, comments] = await Promise.all([
        api(`/repos/${r}/events?per_page=40`),
        api(`/repos/${r}/issues/comments?sort=created&direction=desc&per_page=25`),
      ]);
    } catch (e) { err = e; }
    const items = [];
    for (const ev of events || []) {
      const it = feedFromEvent(ev);
      if (it) items.push(it);
    }
    for (const c of comments || []) {
      const n = +c.issue_url.split('/').pop();
      items.push({ time: c.created_at, kind: 'comment', label: 'Comment', title: `${c.user.login} commented on #${n}`, snippet: c.body, url: c.html_url, foreign: !isOwnerLogin(c.user.login) && c.user.type !== 'Bot' });
    }
    for (const run of (S.data.runs || []).slice(0, 15)) {
      const st = run.status === 'completed' ? run.conclusion : run.status.replace('_', ' ');
      items.push({ time: run.updated_at, kind: 'run', label: 'Run', title: `Agent team run #${run.run_number}${run._issue ? ` for issue #${run._issue}` : ''}: ${st}`, url: run.html_url });
    }
    items.sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
    const top = items.slice(0, 40);
    if (!changed('feed', [top.map(i => [i.time, i.title]), err && errText(err)])) return;
    setKids(box,
      err ? errorBox(new ApiError(err.status, `Some activity could not load: ${errText(err)}`)) : null,
      top.length ? h('ul', { class: 'list feed' }, top.map(i => h('li', {},
        h('span', { class: `kind ${i.kind}` }, i.label),
        h('div', { class: 'grow' },
          h('div', { class: 'title-line' }, i.url ? h('a', { href: i.url, target: '_blank', rel: 'noopener' }, i.title) : i.title),
          i.snippet ? h('div', { class: 'snippet' }, i.snippet.slice(0, 300)) : null,
          h('div', { class: 'meta' }, timeEl(i.time), i.foreign ? h('span', { class: 'badge warn' }, 'Not from the owner: agents ignore it') : null))))) : stateBox('No activity yet.'));
  },
};

function feedFromEvent(ev) {
  const p = ev.payload || {};
  const who = ev.actor ? ev.actor.login : 'someone';
  const base = { time: ev.created_at };
  switch (ev.type) {
    case 'IssuesEvent': return { ...base, kind: 'issue', label: 'Issue', title: `${who} ${p.action} issue #${p.issue.number}: ${p.issue.title}`, url: p.issue.html_url };
    case 'PullRequestEvent': {
      const action = p.action === 'closed' && p.pull_request.merged ? 'merged' : p.action;
      const n = p.pull_request.number || p.number;
      return { ...base, kind: 'pr', label: 'PR', title: `${who} ${action} pull request #${n}${p.pull_request.title ? `: ${p.pull_request.title}` : ''}`, url: p.pull_request.html_url || `https://github.com/${R()}/pull/${n}` };
    }
    case 'PullRequestReviewEvent': return { ...base, kind: 'pr', label: 'Review', title: `${who} reviewed pull request #${p.pull_request.number}${p.review && p.review.state ? ` (${p.review.state.toLowerCase().replace('_', ' ')})` : ''}`, url: p.review && p.review.html_url };
    case 'PushEvent': {
      const n = p.size != null ? p.size : (p.commits || []).length;
      return { ...base, kind: 'push', label: 'Push', title: `${who} pushed ${n ? `${n} commit${n === 1 ? '' : 's'} ` : ''}to ${(p.ref || '').replace('refs/heads/', '')}` };
    }
    case 'CreateEvent': return { ...base, kind: 'push', label: 'Branch', title: `${who} created ${p.ref_type} ${p.ref || ''}` };
    case 'DeleteEvent': return { ...base, kind: 'push', label: 'Branch', title: `${who} deleted ${p.ref_type} ${p.ref || ''}` };
    case 'IssueCommentEvent': return null; // shown from the comments API instead (it is fresher)
    default: return { ...base, kind: 'other', label: 'Event', title: `${who}: ${ev.type.replace(/Event$/, '')}` };
  }
}

/* ================================================================== TASKS */
const COLUMNS = [['pending', 'Pending'], ['progress', 'In progress'], ['review', 'In review'], ['done', 'Done']];

const Tasks = {
  mount(view, openId) {
    sigs.clear();
    const filterBtns = [['all', 'All agents'], ['manager', 'Manager'], ['developer', 'Developer'], ['qa', 'QA']].map(([v, l]) =>
      h('button', { type: 'button', 'aria-pressed': String(S.filters.agent === v), onclick: e => { S.filters.agent = v; const me = e.currentTarget; $$('.seg button', view).forEach(b => b.setAttribute('aria-pressed', String(b === me))); sigs.delete('board'); this.renderBoard(); } }, l));
    append(view,
      h('div', { id: 'screen-error' }),
      h('div', { class: 'section-head' },
        h('div', { class: 'toolbar' }, h('span', { class: 'muted small', id: 'filter-label' }, 'Filter by agent:'), h('div', { class: 'seg', role: 'group', 'aria-labelledby': 'filter-label' }, filterBtns)),
        h('button', { type: 'button', class: 'btn primary', 'data-action': 'new-task' }, '+ New task')),
      h('p', { class: 'muted small', style: 'margin:-4px 0 14px' }, 'The agent filter uses the agent working on a task right now, otherwise its starting agent. Tasks in review are with QA.'),
      h('div', { class: 'board', id: 'board' }, COLUMNS.map(([k, l]) => h('section', { class: 'col', 'aria-label': l }, h('div', { class: 'col-head' }, l), loading(2)))));
    if (openId) TaskPanel.open(openId);
  },

  async update() {
    await loadCore();
    const active = activeRuns();
    this.jobs = active.length ? await loadJobs(active.map(x => x.id)) : {};
    if (route().screen !== 'tasks') return;
    this.renderBoard();
    if ($('#task-panel').open) await TaskPanel.update();
  },

  agentOf(t, col) {
    if (col === 'progress') {
      const run = activeRuns().find(x => x._issue === t.number);
      const job = run && (this.jobs[run.id] || []).find(j => j.status === 'in_progress');
      if (job && JOB_AGENT[job.name]) return JOB_AGENT[job.name];
    }
    if (col === 'review') return 'qa';
    return labelVal(t, 'agent:') || 'manager';
  },

  renderBoard() {
    const board = $('#board');
    if (!board || !S.data.tasks) return;
    const prio = { high: 0, normal: 1, low: 2 };
    const cards = S.data.tasks.map(t => {
      const col = taskColumn(t);
      return { t, col, agent: this.agentOf(t, col), pr: linkedPull(t.number, S.data.pulls), prio: labelVal(t, 'priority:') || 'normal' };
    }).filter(c => S.filters.agent === 'all' || c.agent === S.filters.agent);
    const sig = [S.filters.agent, cards.map(c => [c.t.number, c.t.updated_at, c.col, c.agent, c.prio, c.pr && c.pr.number])];
    if (!changed('board', sig)) return;
    setKids(board, COLUMNS.map(([k, label]) => {
      const list = cards.filter(c => c.col === k).sort((a, b) => (prio[a.prio] - prio[b.prio]) || (Date.parse(b.t.updated_at) - Date.parse(a.t.updated_at)));
      const shown = k === 'done' ? list.slice(0, 20) : list;
      return h('section', { class: 'col', 'aria-label': `${label}, ${list.length} tasks` },
        h('div', { class: 'col-head' }, h('h3', {}, label), h('span', { class: 'count' }, list.length)),
        shown.length ? shown.map(c => h('button', { type: 'button', class: `card ${c.agent}`, onclick: () => go(`#/tasks/${c.t.number}`) },
          h('div', { class: 'num' }, `#${c.t.number}`),
          h('div', { class: 'title-line' }, c.t.title),
          h('div', { class: 'badges' },
            h('span', { class: `badge ${c.agent}` }, AGENTS[c.agent].name),
            h('span', { class: `badge plain ${c.prio === 'high' ? 'bad' : ''}` }, `${c.prio[0].toUpperCase()}${c.prio.slice(1)} priority`),
            c.pr ? h('span', { class: 'badge plain' }, `PR #${c.pr.number}`) : null,
            h('span', { class: 'badge plain' }, ago(c.t.updated_at))))) : h('p', { class: 'muted small' }, 'No tasks'),
        k === 'done' && list.length > 20 ? h('p', { class: 'muted small' }, `Showing the latest 20 of ${list.length}.`) : null);
    }));
  },
};

const TaskPanel = {
  num: null,
  open(num) {
    this.num = num;
    sigs.delete('panel-head'); sigs.delete('panel-comments');
    const d = $('#task-panel');
    const body = $('#task-panel-body');
    const ta = h('textarea', { id: 'tp-comment', rows: 4 });
    setKids(body,
      h('div', { class: 'drawer-head' },
        h('div', { id: 'tp-head', style: 'flex:1;min-width:0' }, h('h2', { id: 'tp-title' }, `Task #${num}`), loading(2)),
        h('button', { type: 'button', class: 'btn ghost icon', 'aria-label': 'Close panel', onclick: () => d.close() }, '✕')),
      h('div', { id: 'tp-error' }),
      h('div', { id: 'tp-actions', class: 'btn-row' }),
      h('section', { 'aria-labelledby': 'tp-desc-h' }, h('h3', { id: 'tp-desc-h', style: 'margin-bottom:8px' }, 'Description'), h('div', { id: 'tp-body' }, loading(3))),
      h('section', { 'aria-labelledby': 'tp-com-h' }, h('h3', { id: 'tp-com-h', style: 'margin-bottom:8px' }, 'Comments'), h('div', { id: 'tp-comments', style: 'display:flex;flex-direction:column;gap:10px' }, loading(3))),
      h('form', { id: 'tp-form', onsubmit: e => {
        e.preventDefault();
        const text = ta.value.trim();
        if (!text) { toast('Write a comment first.', true); return; }
        act(e.submitter, async () => {
          await api(`/repos/${R()}/issues/${num}/comments`, { method: 'POST', body: { body: text } });
          ta.value = '';
          await this.update();
        }, 'Comment posted.');
      } }, h('label', { for: 'tp-comment' }, 'Add a comment'), ta,
        h('div', { class: 'btn-row', style: 'margin-top:8px' }, ownerOnly(h('button', { type: 'submit', class: 'btn primary' }, 'Comment')))));
    if (!d.open) d.showModal();
    this.update();
  },

  async update() {
    const num = this.num;
    const r = R();
    try {
      const [issue, comments] = await Promise.all([api(`/repos/${r}/issues/${num}`), paged(`/repos/${r}/issues/${num}/comments`)]);
      if (this.num !== num || !$('#task-panel').open) return;
      $('#tp-error').replaceChildren();
      this.renderHead(issue);
      this.renderComments(comments);
    } catch (e) {
      setKids($('#tp-error'), errorBox(e, () => this.update()));
    }
  },

  renderHead(issue) {
    const col = issue.pull_request ? null : taskColumn(issue);
    const pr = linkedPull(issue.number, S.data.pulls);
    const run = activeRuns().find(x => x._issue === issue.number);
    const sig = [issue.updated_at, issue.state, col, pr && pr.number, run && run.id, S.data.workflow && S.data.workflow.state];
    if (!changed('panel-head', sig)) return;
    const labels = (issue.labels || []).map(l => (typeof l === 'string' ? l : l.name));
    setKids($('#tp-head'),
      h('h2', { id: 'tp-title' }, `#${issue.number} ${issue.title}`),
      h('div', { class: 'meta' },
        h('span', { class: `badge ${issue.state === 'open' ? 'ok' : 'plain'}` }, issue.state === 'open' ? 'Open' : `Closed${issue.state_reason ? ` (${issue.state_reason.replace('_', ' ')})` : ''}`),
        col ? h('span', { class: 'badge plain' }, COLUMNS.find(c => c[0] === col)[1]) : null,
        labels.map(l => h('span', { class: 'badge plain mono' }, l)),
        h('span', {}, 'by ', issue.user.login), timeEl(issue.created_at),
        h('a', { href: issue.html_url, target: '_blank', rel: 'noopener' }, 'Open on GitHub')));
    setKids($('#tp-body'), h('div', { class: 'body-text' }, issue.body || 'No description.'));

    const acts = $('#tp-actions');
    const closeBtn = issue.state === 'open'
      ? h('button', { type: 'button', class: 'btn danger', onclick: async e => {
        const b = e.currentTarget;
        if (await confirmDialog('Close this task?', `Closes issue #${issue.number} as completed.`, 'Close task', true))
          act(b, async () => { await api(`/repos/${R()}/issues/${issue.number}`, { method: 'PATCH', body: { state: 'closed', state_reason: 'completed' } }); await this.update(); }, 'Task closed.');
      } }, 'Close')
      : h('button', { type: 'button', class: 'btn', onclick: e => act(e.currentTarget, async () => { await api(`/repos/${R()}/issues/${issue.number}`, { method: 'PATCH', body: { state: 'open' } }); await this.update(); }, 'Task reopened.') }, 'Reopen');
    const canRun = issue.state === 'open' && !run && labels.includes('agent-task');
    const runBtn = h('button', { type: 'button', class: 'btn primary', disabled: !canRun,
      title: run ? 'The team is already working on this task' : !labels.includes('agent-task') ? 'Only agent-task issues can be run' : issue.state !== 'open' ? 'Reopen the task first' : '',
      onclick: async e => {
        const b = e.currentTarget;
        if (S.data.workflow && S.data.workflow.state !== 'active') { toast('The team is paused. Resume it on the Overview first.', true); return; }
        if (await confirmDialog('Run the team on this task?', `Starts the Agent team workflow for issue #${issue.number}. It uses your Claude subscription.`, 'Start'))
          act(b, () => api(`/repos/${R()}/actions/workflows/${WORKFLOW}/dispatches`, { method: 'POST', body: { ref: S.repoInfo.default_branch, inputs: { issue: String(issue.number) } } }), 'Run requested. It appears on the Overview within a few seconds.');
      } }, run ? 'Team is working…' : 'Run the team');
    setKids(acts, ownerOnly(runBtn), ownerOnly(closeBtn),
      pr ? h('button', { type: 'button', class: 'btn', onclick: () => go(`#/prs/${pr.number}`) }, `Review PR #${pr.number}`) : null,
      run ? h('a', { class: 'btn', href: run.html_url, target: '_blank', rel: 'noopener' }, 'View run') : null);
  },

  renderComments(comments) {
    if (!changed('panel-comments', comments.map(c => [c.id, c.updated_at]))) return;
    setKids($('#tp-comments'), comments.length ? comments.map(commentEl) : h('p', { class: 'muted small' }, 'No comments yet.'));
  },
};

function commentEl(c) {
  const owner = isOwnerLogin(c.user.login);
  const bot = c.user.type === 'Bot';
  return h('article', { class: `comment${owner || bot ? '' : ' foreign'}` },
    h('div', { class: 'comment-head' },
      h('strong', {}, c.user.login),
      owner ? h('span', { class: 'badge ok' }, 'Owner') : bot ? h('span', { class: 'badge plain' }, 'Bot') : h('span', { class: 'badge warn' }, 'Not the owner: agents ignore this'),
      timeEl(c.created_at)),
    h('div', { class: 'comment-body' }, c.body || ''));
}

/* =========================================================== PR LIST */
const PRList = {
  mount(view) {
    sigs.clear();
    const seg = [['open', 'Open'], ['closed', 'Closed and merged']].map(([v, l]) =>
      h('button', { type: 'button', 'aria-pressed': String(S.filters.prState === v), onclick: () => { S.filters.prState = v; render(); } }, l));
    append(view,
      h('div', { id: 'screen-error' }),
      h('div', { class: 'section-head' }, h('div', { class: 'seg', role: 'group', 'aria-label': 'Pull request state' }, seg)),
      h('div', { class: 'panel', id: 'pr-list' }, loading(4)));
  },
  async update() {
    const list = await api(`/repos/${R()}/pulls?state=${S.filters.prState}&per_page=50&sort=updated&direction=desc`);
    const rows = await Promise.all(list.map(async p => {
      if (p.state !== 'open') return { p };
      try { return { p, checks: await loadChecks(p.head.sha) }; } catch (e) { return { p, err: e }; }
    }));
    if (route().screen !== 'prs' || route().id) return;
    const sig = rows.map(r => [r.p.number, r.p.updated_at, r.checks && r.checks.overall]);
    if (!changed('prlist', sig)) return;
    setKids($('#pr-list'), rows.length ? h('ul', { class: 'list' }, rows.map(({ p, checks, err }) => {
      const st = p.merged_at ? ['plain', 'Merged'] : p.state === 'closed' ? ['plain', 'Closed'] : p.draft ? ['warn', 'Draft'] : ['ok', 'Open'];
      return h('li', {},
        h('div', { class: 'grow' },
          h('div', { class: 'title-line' }, `#${p.number} ${p.title}`),
          h('div', { class: 'meta' },
            h('span', { class: `badge ${st[0]}` }, st[1]),
            checks ? stateBadge(checks.overall, checkLabel(checks.overall)) : err ? h('span', { class: 'badge bad' }, 'Checks unavailable') : null,
            h('span', { class: 'mono' }, `${p.head.ref} → ${p.base.ref}`),
            h('span', {}, p.user.login), timeEl(p.updated_at))),
        h('button', { type: 'button', class: 'btn sm primary', onclick: () => go(`#/prs/${p.number}`) }, p.state === 'open' ? 'Review' : 'View'));
    })) : stateBox(S.filters.prState === 'open' ? 'No open pull requests.' : 'No closed pull requests yet.'));
  },
};

/* ========================================================= PR DETAIL */
const PRDetail = {
  num: null, pr: null, files: null, checks: null, filesSha: null,
  mount(view, num) {
    sigs.clear();
    this.num = num; this.pr = null; this.files = null; this.filesSha = null; this.checks = null;
    S.ui.sbsFile = null;
    const tabs = [['overview', 'Overview'], ['files', 'Files and diff'], ['sbs', 'Before / after'], ['conversation', 'Conversation']];
    append(view,
      h('div', { id: 'screen-error' }),
      h('p', {}, h('a', { href: '#/prs' }, '← All pull requests')),
      h('div', { id: 'pr-head', class: 'section', style: 'margin-top:10px' }, loading(3)),
      h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Pull request sections' }, tabs.map(([k, l]) =>
        h('button', { type: 'button', role: 'tab', id: `tab-${k}`, 'aria-controls': `pane-${k}`, 'aria-selected': String(S.ui.prTab === k), onclick: () => this.tab(k) }, l))),
      tabs.map(([k]) => h('section', { id: `pane-${k}`, role: 'tabpanel', 'aria-labelledby': `tab-${k}`, hidden: S.ui.prTab !== k }, loading(4))));
  },
  tab(k) {
    S.ui.prTab = k;
    $$('.tabs [role=tab]').forEach(b => b.setAttribute('aria-selected', String(b.id === `tab-${k}`)));
    $$('[role=tabpanel]').forEach(p => { p.hidden = p.id !== `pane-${k}`; });
    if (k === 'sbs') this.renderSbs();
  },

  async update() {
    const r = R(), n = this.num;
    const [pr, comments, reviews] = await Promise.all([
      api(`/repos/${r}/pulls/${n}`),
      paged(`/repos/${r}/issues/${n}/comments`),
      paged(`/repos/${r}/pulls/${n}/reviews`),
    ]);
    // mergeable is computed in the background; ask again (uncached) if GitHub hasn't finished.
    let p = pr;
    if (p.state === 'open' && p.mergeable === null) {
      await new Promise(res => setTimeout(res, 1500));
      p = await api(`/repos/${r}/pulls/${n}`, { cache: false });
    }
    let checks = null, checksErr = null;
    try { checks = await loadChecks(p.head.sha); } catch (e) { checksErr = e; }
    if (this.filesSha !== p.head.sha) {
      this.files = await paged(`/repos/${r}/pulls/${n}/files`);
      this.filesSha = p.head.sha;
      sigs.delete('pr-files'); S.ui.sbsFile = null; this.sbsCache = {};
    }
    if (this.num !== n || route().id !== n) return;
    this.pr = p; this.checks = checks;
    this.renderHead(p);
    this.renderOverview(p, checks, checksErr);
    this.renderFiles();
    if (S.ui.prTab === 'sbs') this.renderSbs();
    this.renderConversation(p, comments, reviews);
  },

  renderHead(p) {
    if (!changed('pr-head', [p.updated_at, p.state, p.merged, p.changed_files])) return;
    const st = p.merged ? ['plain', 'Merged'] : p.state === 'closed' ? ['plain', 'Closed'] : p.draft ? ['warn', 'Draft'] : ['ok', 'Open'];
    setKids($('#pr-head'),
      h('h2', { style: 'font-size:20px' }, `#${p.number} ${p.title}`),
      h('div', { class: 'meta', style: 'font-size:13px;margin-top:8px' },
        h('span', { class: `badge ${st[0]}` }, st[1]),
        h('span', { class: 'mono' }, `${p.head.ref} → ${p.base.ref}`),
        h('span', {}, 'by ', p.user.login),
        h('span', {}, `${p.changed_files} file${p.changed_files === 1 ? '' : 's'} changed`),
        h('span', { class: 'stat-add' }, `+${p.additions} added`), h('span', { class: 'stat-del' }, `−${p.deletions} removed`),
        timeEl(p.updated_at),
        h('a', { href: p.html_url, target: '_blank', rel: 'noopener' }, 'Open on GitHub')));
  },

  mergeBlock(p, checks) {
    if (p.merged) return 'This pull request is already merged.';
    if (p.state !== 'open') return 'This pull request is closed.';
    if (p.draft) return 'This is a draft (QA did not pass, or it was opened as a draft). Mark it ready for review on GitHub before merging.';
    if (p.mergeable === false || p.mergeable_state === 'dirty') return 'This branch has merge conflicts with the base branch. Resolve them first.';
    if (p.mergeable === null) return 'GitHub is still checking whether this can be merged. Try again in a few seconds.';
    if (!checks) return 'Check status could not be loaded, so merging is disabled.';
    const failing = checks.items.filter(i => i.state === 'failure');
    if (failing.length) return `Checks are failing: ${failing.map(i => i.name).join(', ')}.`;
    if (p.mergeable_state === 'blocked') return 'GitHub reports this pull request as blocked (for example, a required review or check is missing).';
    return null;
  },

  renderOverview(p, checks, checksErr) {
    const qa = qaVerdict(p, checks);
    const block = this.mergeBlock(p, checks);
    const sig = [p.updated_at, p.mergeable, p.mergeable_state, p.state, checks && checks.items, checksErr && errText(checksErr)];
    if (!changed('pr-overview', sig)) return;
    const pending = checks && checks.items.some(i => i.state === 'pending');
    const ta = h('textarea', { id: 'rc-body', rows: 3 });
    setKids($('#pane-overview'),
      h('div', { class: 'grid two-col' },
        h('div', { style: 'display:flex;flex-direction:column;gap:16px' },
          h('section', { class: 'panel checks', 'aria-labelledby': 'ck-h' },
            h('div', { class: 'section-head' }, h('h3', { id: 'ck-h' }, 'Checks'), checks ? stateBadge(checks.overall, checkLabel(checks.overall)) : null),
            qa ? h('p', { style: 'margin-bottom:10px' }, h('span', { class: `badge ${qa.verdict === 'PASS' ? 'ok' : qa.verdict === 'PENDING' ? 'warn' : 'bad'}` }, `QA agent: ${qa.verdict}`), h('span', { class: 'muted small' }, ` from the ${qa.source}`)) : h('p', { class: 'muted small', style: 'margin-bottom:10px' }, 'No QA agent result on this pull request.'),
            checksErr ? errorBox(checksErr) : checks.items.length ? h('ul', { class: 'list' }, checks.items.map(i => h('li', {},
              stateBadge(i.state, { success: 'Passed', failure: 'Failed', pending: 'Running' }[i.state] || i.state),
              h('div', { class: 'grow' }, h('div', { class: 'title-line' }, i.url ? h('a', { href: i.url, target: '_blank', rel: 'noopener' }, i.name) : i.name), h('div', { class: 'meta' }, `${i.kind}: ${i.detail || ''}`))))) : h('p', { class: 'muted small' }, 'No check runs or statuses on the latest commit.')),
          h('section', { class: 'panel', 'aria-labelledby': 'desc-h' }, h('h3', { id: 'desc-h', style: 'margin-bottom:8px' }, 'Description'), h('div', { class: 'body-text' }, p.body || 'No description.'))),
        h('section', { class: 'merge-box', 'aria-labelledby': 'mg-h' },
          h('h3', { id: 'mg-h' }, 'Decision'),
          block ? h('p', { class: 'reason', role: 'status' }, `Merge disabled: ${block}`) : pending ? h('p', { class: 'reason', role: 'status' }, 'Some checks are still running. You can merge, but waiting is safer.') : h('p', { class: 'ok-box' }, 'Ready to merge: no conflicts and no failing checks.'),
          ownerOnly(h('button', { type: 'button', class: 'btn success block', disabled: !!block, onclick: e => this.merge(e.currentTarget) }, 'Approve and merge into main')),
          h('p', { class: 'muted small' }, `Squash merges into ${p.base.ref} and deletes the ${p.head.ref} branch.`),
          h('form', { onsubmit: e => this.requestChanges(e, ta) },
            h('label', { for: 'rc-body' }, 'Request changes (what should change?)'), ta,
            ownerOnly(h('button', { type: 'submit', class: 'btn block', style: 'margin-top:8px', disabled: p.state !== 'open' }, 'Request changes'))),
          ownerOnly(h('button', { type: 'button', class: 'btn danger block', disabled: p.state !== 'open', onclick: e => this.closePr(e.currentTarget) }, 'Close without merging')))));
  },

  async merge(btn) {
    const p = this.pr;
    const ok = await confirmDialog('Merge this pull request?', `Squash merge #${p.number} "${p.title}" into ${p.base.ref}, then delete the branch ${p.head.ref}. This changes ${p.base.ref} right away.`, 'Merge');
    if (!ok) return;
    act(btn, async () => {
      const res = await api(`/repos/${R()}/pulls/${p.number}/merge`, { method: 'PUT', body: { merge_method: 'squash', sha: p.head.sha, commit_title: `${p.title} (#${p.number})` } });
      if (!res || !res.merged) throw new ApiError(0, (res && res.message) || 'GitHub did not merge the pull request.');
      let branchMsg = '';
      if (p.head.repo && p.head.repo.full_name === R()) {
        try {
          await api(`/repos/${R()}/git/refs/heads/${p.head.ref.split('/').map(encodeURIComponent).join('/')}`, { method: 'DELETE' });
          branchMsg = ` Branch ${p.head.ref} deleted.`;
        } catch (e) {
          branchMsg = e.status === 422 ? ` Branch ${p.head.ref} was already gone.` : ` Could not delete branch ${p.head.ref}: ${errText(e)}`;
        }
      }
      sigs.clear();
      return `Merged #${p.number} into ${p.base.ref}.${branchMsg}`;
    }, msg => msg);
  },

  requestChanges(e, ta) {
    e.preventDefault();
    const text = ta.value.trim();
    if (!text) { toast('Describe the changes you want first.', true); return; }
    act(e.submitter, async () => {
      await api(`/repos/${R()}/pulls/${this.num}/reviews`, { method: 'POST', body: { event: 'REQUEST_CHANGES', body: text } });
      ta.value = '';
    }, 'Review submitted: changes requested.');
  },

  async closePr(btn) {
    const ok = await confirmDialog('Close without merging?', `Closes #${this.pr.number}. The branch stays, so you can reopen it on GitHub later.`, 'Close pull request', true);
    if (!ok) return;
    act(btn, () => api(`/repos/${R()}/pulls/${this.num}`, { method: 'PATCH', body: { state: 'closed' } }), 'Pull request closed.');
  },

  renderFiles() {
    if (!changed('pr-files', [this.filesSha])) return;
    const files = this.files || [];
    setKids($('#pane-files'), files.length ? files.map(f => h('section', { class: 'file', 'aria-label': f.filename },
      h('div', { class: 'file-head' },
        h('span', { class: 'mono' }, f.previous_filename ? `${f.previous_filename} → ${f.filename}` : f.filename),
        h('span', { class: 'meta', style: 'margin:0' }, h('span', { class: 'badge plain' }, f.status), h('span', { class: 'stat-add' }, `+${f.additions}`), h('span', { class: 'stat-del' }, `−${f.deletions}`))),
      f.patch ? diffTable(f.patch) : h('p', { class: 'muted small', style: 'padding:12px' }, 'No text diff (binary file, or too large for the API).'))) : stateBox('No changed files.'));
  },

  sbsCache: {},
  async renderSbs() {
    const pane = $('#pane-sbs');
    const files = this.files;
    const p = this.pr;
    if (!files || !p) { setKids(pane, loading(4)); return; }
    if (!files.length) { setKids(pane, stateBox('No changed files.')); return; }
    if (!S.ui.sbsFile || !files.some(f => f.filename === S.ui.sbsFile)) S.ui.sbsFile = files[0].filename;
    const f = files.find(x => x.filename === S.ui.sbsFile);
    const key = `${this.filesSha}:${f.filename}`;
    if (sigs.get('pr-sbs') === key && pane.dataset.done === '1') return;
    sigs.set('pr-sbs', key);
    pane.dataset.done = '0';
    const picker = h('div', { class: 'file-pick', role: 'group', 'aria-label': 'Choose a file' }, files.map(x =>
      h('button', { type: 'button', class: 'btn sm', 'aria-pressed': String(x.filename === f.filename), onclick: () => { S.ui.sbsFile = x.filename; this.renderSbs(); } }, x.filename)));
    const holder = h('div', {}, loading(6));
    setKids(pane, picker, holder);
    try {
      if (!this.sbsCache[key]) {
        const get = (path, ref) => api(`/repos/${R()}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${ref}`, { accept: 'application/vnd.github.raw+json', raw: true });
        const [before, after] = await Promise.all([
          f.status === 'added' ? null : get(f.previous_filename || f.filename, p.base.sha),
          f.status === 'removed' ? null : get(f.filename, p.head.sha),
        ]);
        this.sbsCache[key] = { before, after };
      }
      if (S.ui.sbsFile !== f.filename) return;
      const { before, after } = this.sbsCache[key];
      const marks = changedLines(f.patch || '');
      setKids(holder, h('div', { class: 'file' },
        h('div', { class: 'file-head' }, h('span', { class: 'mono' }, f.filename), h('span', { class: 'muted small' }, `Before: ${p.base.ref} (${p.base.sha.slice(0, 7)}) · After: ${p.head.ref} (${p.head.sha.slice(0, 7)})`)),
        h('div', { class: 'sbs' },
          h('div', {}, h('h4', {}, 'Before'), before == null ? h('p', { class: 'muted small', style: 'padding:12px' }, 'File did not exist.') : codeTable(before, marks.del, 'del')),
          h('div', {}, h('h4', {}, 'After'), after == null ? h('p', { class: 'muted small', style: 'padding:12px' }, 'File was deleted.') : codeTable(after, marks.add, 'add')))));
      pane.dataset.done = '1';
    } catch (e) {
      sigs.delete('pr-sbs');
      setKids(holder, errorBox(e, () => this.renderSbs()));
    }
  },

  renderConversation(p, comments, reviews) {
    const sig = [comments.map(c => [c.id, c.updated_at]), reviews.map(r => [r.id, r.state])];
    if (!changed('pr-conv', sig)) return;
    const pane = $('#pane-conversation');
    const old = $('#pr-comment', pane);
    const draft = old ? old.value : '';
    const items = [
      ...comments.map(c => ({ t: c.created_at, el: commentEl(c) })),
      ...reviews.filter(r => r.state !== 'PENDING').map(r => ({ t: r.submitted_at, el: h('article', { class: 'comment' },
        h('div', { class: 'comment-head' }, h('strong', {}, r.user.login), h('span', { class: `badge ${r.state === 'APPROVED' ? 'ok' : r.state === 'CHANGES_REQUESTED' ? 'bad' : 'plain'}` }, `Review: ${r.state.toLowerCase().replace('_', ' ')}`), timeEl(r.submitted_at)),
        r.body ? h('div', { class: 'comment-body' }, r.body) : null) })),
    ].sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
    const ta = h('textarea', { id: 'pr-comment', rows: 4 });
    ta.value = draft;
    setKids(pane,
      h('div', { style: 'display:flex;flex-direction:column;gap:10px;margin-bottom:16px' }, items.length ? items.map(i => i.el) : h('p', { class: 'muted small' }, 'No comments or reviews yet.')),
      h('form', { class: 'panel', onsubmit: e => {
        e.preventDefault();
        const text = ta.value.trim();
        if (!text) { toast('Write a comment first.', true); return; }
        act(e.submitter, async () => { await api(`/repos/${R()}/issues/${p.number}/comments`, { method: 'POST', body: { body: text } }); ta.value = ''; }, 'Comment posted.');
      } }, h('label', { for: 'pr-comment', style: 'margin-top:0' }, 'Comment on this pull request'), ta,
        h('div', { class: 'btn-row', style: 'margin-top:8px' }, ownerOnly(h('button', { type: 'submit', class: 'btn primary' }, 'Comment')))));
  },
};

/* Unified diff -> table with old/new line numbers and +/− signs (never color alone). */
function diffTable(patch) {
  const rows = [];
  let o = 0, n = 0;
  for (const line of patch.split('\n')) {
    const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/);
    if (m) { o = +m[1]; n = +m[2]; rows.push(h('tr', { class: 'hunk' }, h('td', { colspan: 4 }, line))); continue; }
    if (line.startsWith('\\')) { rows.push(h('tr', {}, h('td', { class: 'ln' }), h('td', { class: 'ln' }), h('td', { class: 'sign' }), h('td', { class: 'muted' }, line))); continue; }
    const c = line[0], text = line.slice(1);
    if (c === '+') rows.push(h('tr', { class: 'add' }, h('td', { class: 'ln' }), h('td', { class: 'ln' }, n++), h('td', { class: 'sign', 'aria-label': 'added' }, '+'), h('td', {}, text)));
    else if (c === '-') rows.push(h('tr', { class: 'del' }, h('td', { class: 'ln' }, o++), h('td', { class: 'ln' }), h('td', { class: 'sign', 'aria-label': 'removed' }, '−'), h('td', {}, text)));
    else rows.push(h('tr', {}, h('td', { class: 'ln' }, o++), h('td', { class: 'ln' }, n++), h('td', { class: 'sign' }, ' '), h('td', {}, text)));
  }
  return h('div', { class: 'diff' }, h('table', {}, h('tbody', {}, rows)));
}
function changedLines(patch) {
  const add = new Set(), del = new Set();
  let o = 0, n = 0;
  for (const line of patch.split('\n')) {
    const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)/);
    if (m) { o = +m[1]; n = +m[2]; continue; }
    if (line.startsWith('\\')) continue;
    if (line[0] === '+') add.add(n++);
    else if (line[0] === '-') del.add(o++);
    else { o++; n++; }
  }
  return { add, del };
}
function codeTable(text, marked, kind) {
  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const max = 4000;
  const rows = lines.slice(0, max).map((l, i) => {
    const on = marked.has(i + 1);
    return h('tr', { class: on ? kind : '' }, h('td', { class: 'ln' }, i + 1), h('td', { class: 'sign', 'aria-label': on ? (kind === 'add' ? 'added' : 'removed') : null }, on ? (kind === 'add' ? '+' : '−') : ' '), h('td', {}, l));
  });
  return h('div', { class: 'diff' }, h('table', {}, h('tbody', {}, rows)), lines.length > max ? h('p', { class: 'muted small', style: 'padding:8px 12px' }, `Showing the first ${max} of ${lines.length} lines.`) : null);
}

/* =============================================================== SETTINGS */
const Settings = {
  mount(view) {
    sigs.clear();
    const repoIn = h('input', { id: 'set-repo', value: S.repo, autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
    const poll = h('input', { type: 'checkbox', id: 'set-poll', checked: S.polling, onchange: e => {
      S.polling = e.target.checked;
      store.set(KEYS.polling, S.polling ? 'on' : 'off');
      updateLive(); schedule();
      toast(S.polling ? 'Live updates on.' : 'Live updates off. Data refreshes when you change screens.');
    } });
    append(view,
      h('div', { id: 'screen-error' }),
      h('div', { class: 'grid two-col' },
        h('section', { class: 'panel', 'aria-labelledby': 'acc-h' },
          h('h2', { id: 'acc-h', style: 'margin-bottom:12px' }, 'Connected account'),
          h('div', { id: 'set-account' }, loading(2)),
          h('form', { onsubmit: async e => {
            e.preventDefault();
            const v = repoIn.value.trim();
            const b = e.submitter;
            b.disabled = true;
            try { await connect(S.token, v); toast(`Now using ${v}.`); render(); }
            catch (err) { toast(errText(err), true); }
            finally { if (b.isConnected) b.disabled = false; }
          } }, h('label', { for: 'set-repo' }, 'Repository (owner/name)'), repoIn,
            h('button', { type: 'submit', class: 'btn', style: 'margin-top:8px' }, 'Save repository')),
          h('label', { class: 'check', for: 'set-poll', style: 'margin-top:16px' }, poll, 'Live updates (poll GitHub every 10 seconds while this tab is visible)'),
          h('button', { type: 'button', class: 'btn danger', style: 'margin-top:16px', onclick: disconnect }, 'Disconnect and forget token')),
        h('section', { class: 'panel', 'aria-labelledby': 'perm-h' },
          h('h2', { id: 'perm-h', style: 'margin-bottom:12px' }, 'Token permissions'),
          h('p', { class: 'muted small' }, 'Fine-grained token, only this repository:'),
          h('ul', { class: 'small' },
            h('li', {}, h('strong', {}, 'Actions: read and write'), ' (agent status, Pause/Resume, Stop, Run the team)'),
            h('li', {}, h('strong', {}, 'Contents: read and write'), ' (before/after view, merge, delete branch)'),
            h('li', {}, h('strong', {}, 'Issues: read and write'), ' (tasks, comments, labels, close/reopen)'),
            h('li', {}, h('strong', {}, 'Pull requests: read and write'), ' (review, request changes, close)'),
            h('li', {}, h('strong', {}, 'Commit statuses: read'), ' and Checks: read if listed (check results)')),
          h('div', { id: 'set-rate', style: 'margin-top:12px' }))));
  },
  async update() {
    const me = await api('/user');
    const repo = await api(`/repos/${R()}`);
    S.me = me; S.repoInfo = repo; S.canAct = me.login === repo.owner.login;
    if (route().screen !== 'settings') return;
    setKids($('#set-account'),
      h('div', { style: 'display:flex;gap:12px;align-items:center' },
        h('img', { src: me.avatar_url, alt: '', width: 44, height: 44, style: 'border-radius:50%' }),
        h('div', {}, h('div', { class: 'title-line' }, me.login), h('div', { class: 'meta' }, me.name || ''))),
      h('dl', { class: 'kv', style: 'margin-top:12px' },
        h('dt', {}, 'Repository'), h('dd', { class: 'mono' }, h('a', { href: repo.html_url, target: '_blank', rel: 'noopener' }, repo.full_name)),
        h('dt', {}, 'Visibility'), h('dd', {}, repo.visibility),
        h('dt', {}, 'Default branch'), h('dd', { class: 'mono' }, repo.default_branch),
        h('dt', {}, 'Access'), h('dd', {}, S.canAct ? h('span', { class: 'badge ok' }, 'Owner: can act') : h('span', { class: 'badge warn' }, 'Read-only: not the owner'))));
    const rr = S.rate;
    setKids($('#set-rate'), h('p', { class: 'small muted' }, rr.limit ? `API rate limit: ${rr.remaining} of ${rr.limit} requests left, resets at ${clock(rr.reset)}. Unchanged data is served with ETags and does not count.` : ''));
  },
};

/* ============================================================== NEW TASK */
function openNewTask() {
  const d = $('#new-task');
  $('#nt-result').replaceChildren();
  if (!S.canAct) setKids($('#nt-result'), h('p', { class: 'error-box' }, notOwnerText()));
  $('#nt-submit').disabled = !S.canAct;
  d.showModal();
  $('#nt-name').focus();
}
async function ensureLabels(names) {
  const existing = new Set((await paged(`/repos/${R()}/labels`)).map(l => l.name));
  for (const n of names) {
    if (existing.has(n) || !LABELS[n]) continue;
    try { await api(`/repos/${R()}/labels`, { method: 'POST', body: { name: n, ...LABELS[n] } }); }
    catch (e) { if (e.status !== 422) throw e; } // 422 = created meanwhile
  }
}
$('#new-task-form').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  const out = $('#nt-result');
  const title = f.title.value.trim(), details = f.details.value.trim();
  if (!title || !details) { setKids(out, h('p', { class: 'error-box' }, 'Title and "What you want" are required.')); (title ? f.details : f.title).focus(); return; }
  if (!S.canAct) { setKids(out, h('p', { class: 'error-box' }, notOwnerText())); return; }
  const agent = f.agent.value, priority = f.priority.value;
  const done = f.done.value.split('\n').map(s => s.trim()).filter(Boolean);
  const avoid = f.avoid.value.trim();
  // Same layout as .github/ISSUE_TEMPLATE/task.md ("Agent task").
  const body = `**What I want**\n${details}\n\n**Done when**\n${done.length ? done.map(x => `- ${x.replace(/^[-*]\s*/, '')}`).join('\n') : '- <not specified>'}\n\n**Don't touch**\n- ${avoid || '<nothing specified>'}\n\n_Starting agent: ${AGENTS[agent].name}. Priority: ${priority}. Created from the Agent Control Panel._`;
  const labels = ['agent-task', `agent:${agent}`, `priority:${priority}`];
  const btn = $('#nt-submit');
  btn.disabled = true; btn.textContent = 'Creating…';
  setKids(out, h('p', { class: 'muted small' }, 'Creating the issue…'));
  try {
    if (S.data.workflow && S.data.workflow.state !== 'active') throw new ApiError(0, 'The team is paused, so the task would not start. Resume it on the Overview first.');
    await ensureLabels(labels);
    const issue = await api(`/repos/${R()}/issues`, { method: 'POST', body: { title, body, labels } });
    f.reset();
    setKids(out, h('div', { class: 'ok-box' }, `Created task #${issue.number}. The team starts in a few seconds. `,
      h('a', { href: `#/tasks/${issue.number}`, onclick: () => $('#new-task').close() }, 'Open task'), ' · ',
      h('a', { href: issue.html_url, target: '_blank', rel: 'noopener' }, 'View on GitHub')));
    refresh(true);
  } catch (err) {
    setKids(out, h('p', { class: 'error-box', role: 'alert' }, `Could not create the task: ${errText(err)}`));
  } finally {
    btn.disabled = !S.canAct; btn.textContent = 'Create task';
  }
});
$$('#new-task [data-close]').forEach(b => b.addEventListener('click', () => $('#new-task').close()));

/* ======================================================= CONNECT / BOOT */
async function connect(token, repo) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new ApiError(0, 'Enter the repository as owner/name.');
  const prev = { token: S.token, repo: S.repo };
  S.token = token; S.repo = repo;
  try {
    const me = await api('/user', { cache: false });
    const info = await api(`/repos/${repo}`, { cache: false });
    try { await api(`/repos/${repo}/actions/workflows/${WORKFLOW}`, { cache: false }); }
    catch (e) { if (e.status === 404) throw new ApiError(404, `This repository has no .github/workflows/${WORKFLOW}, or the token lacks Actions access.`); throw e; }
    S.me = me; S.repoInfo = info; S.canAct = me.login === info.owner.login;
    store.set(KEYS.token, token); store.set(KEYS.repo, repo);
    etags.clear(); S.data = {};
    $('#side-repo').textContent = repo;
    return me;
  } catch (e) {
    S.token = prev.token; S.repo = prev.repo;
    throw e;
  }
}

function disconnect() {
  store.del(KEYS.token);
  S.token = ''; S.me = null; S.repoInfo = null; S.canAct = false; S.data = {};
  etags.clear(); sigs.clear(); clearTimeout(pollTimer);
  $$('dialog[open]').forEach(d => d.close());
  showConnect();
  toast('Disconnected. The token was removed from this browser.');
}

function showConnect(err) {
  $('#app').hidden = true;
  $('#connect').hidden = false;
  $('#connect-repo').value = S.repo;
  $('#connect-token').value = '';
  const box = $('#connect-error');
  box.hidden = !err;
  box.textContent = err ? errText(err) : '';
  (S.repo ? $('#connect-token') : $('#connect-repo')).focus();
}
function showApp() {
  $('#connect').hidden = true;
  $('#app').hidden = false;
  if (!S.canAct) {
    const b = $('#banner');
    b.className = 'banner warn';
    b.textContent = notOwnerText();
    b.hidden = false;
  }
  render();
  schedule();
}

$('#connect-form').addEventListener('submit', async e => {
  e.preventDefault();
  const token = $('#connect-token').value.trim();
  const repo = $('#connect-repo').value.trim();
  const box = $('#connect-error');
  if (!token) { box.hidden = false; box.textContent = 'Paste your token first.'; return; }
  const btn = $('#connect-submit');
  btn.disabled = true; btn.textContent = 'Checking the token…';
  try { await connect(token, repo); showApp(); }
  catch (err) { box.hidden = false; box.textContent = errText(err); }
  finally { btn.disabled = false; btn.textContent = 'Connect'; }
});

document.addEventListener('click', e => {
  const nav = e.target.closest('[data-route]');
  if (nav) { go(`#/${nav.dataset.route}`); return; }
  const a = e.target.closest('[data-action="new-task"]');
  if (a) openNewTask();
});
window.addEventListener('hashchange', () => { if (S.token && !$('#app').hidden) render(); });
$('#task-panel').addEventListener('close', () => { if (route().screen === 'tasks' && route().id) history.replaceState(null, '', '#/tasks'); TaskPanel.num = null; });
// Clicking the dark backdrop closes dialogs.
$$('dialog').forEach(d => d.addEventListener('click', e => { if (e.target === d) d.close(); }));

(async function boot() {
  if (!S.token) { showConnect(); return; }
  try { await connect(S.token, S.repo); showApp(); }
  catch (e) {
    if (e.status === 401) {
      store.del(KEYS.token); S.token = '';
      showConnect(new ApiError(401, 'GitHub rejected your saved token (expired or revoked), so it was removed. Paste a new token to reconnect.'));
      return;
    }
    showConnect(e);
  }
})();
