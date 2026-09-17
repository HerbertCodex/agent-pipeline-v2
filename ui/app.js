'use strict';
// Agent Pipeline operator console. Plain DOM: every value coming from the store is set through textContent.

const STATUS = {
  draft: 'brouillon', approved: 'approuvée', running: 'en cours', blocked: 'bloquée', awaiting_review: 'à relire',
  ready: 'prête', delivered: 'livrée', closed: 'clôturée', rejected: 'rejetée',
};
const RUN_STATE = {
  created: 'créé', preparing: 'préparation', implementing: 'implémentation', candidate: 'candidat', validating: 'contrôles',
  awaiting_review: 'à relire', ready: 'prêt', failed: 'échec', rejected: 'rejeté', interrupted: 'interrompu',
};
const TERMINAL = new Set(['closed', 'rejected']);
const STAGES = ['Brouillon', 'Approuvée', 'Tâches', 'Contrôles', 'QA', 'Revue', 'Clôture'];

const state = {
  csrf: '', specs: [], project: null, filter: 'active', query: '', selected: null, view: 'home', detail: null, events: [],
  tab: 'overview', showTech: false, jobs: [], preview: null,
};

// ---------- helpers ----------
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}
const $ = (sel) => document.querySelector(sel);
const shortId = (id) => (id || '').slice(0, 8);
const repoName = (repo) => (repo || '').split('/').filter(Boolean).pop() || 'sans dépôt';
const PROJECT_KEY = 'apv2.project';
function remember(key, value) { try { if (value) localStorage.setItem(key, value); else localStorage.removeItem(key); } catch { /* storage may be unavailable */ } }
function recall(key) { try { return localStorage.getItem(key); } catch { return null; } }
const rtf = new Intl.RelativeTimeFormat('fr', { numeric: 'auto' });
function ago(ms) {
  if (!ms) return '';
  const s = Math.round((ms - Date.now()) / 1000); const a = Math.abs(s);
  if (a < 60) return rtf.format(s, 'second');
  if (a < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (a < 86400) return rtf.format(Math.round(s / 3600), 'hour');
  return rtf.format(Math.round(s / 86400), 'day');
}
const clock = (ms) => new Date(ms).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
function duration(ms) {
  if (ms === undefined || ms === null) return '';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  return s < 90 ? `${s.toFixed(1)} s` : `${Math.floor(s / 60)} min ${String(Math.round(s % 60)).padStart(2, '0')}`;
}
const pill = (signal, text, dot) => h('span', { class: `pill sig-${signal}` }, dot ? h('span', { class: 'pulse' }) : null, text);
function toast(message) {
  const el = $('#toast'); el.textContent = message; el.hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { el.hidden = true; }, 3500);
}
async function copy(value) { try { await navigator.clipboard.writeText(value); toast('Copié dans le presse-papiers'); } catch { toast('Copie impossible'); } }
const copyButton = (value, label = 'Copier', cls = 'btn btn--small') => h('button', { class: cls, type: 'button', onclick: () => copy(value) }, label);
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
// DOM append would print null and false as text; content helpers use this instead.
const add = (parent, ...items) => parent.append(...items.flat(Infinity).filter(x => x !== null && x !== undefined && x !== false));
/** A draft has no title until Product answers; say what is happening instead of showing an empty spec. */
const specTitle = (s, busy = s.busy) => s.title || (busy ? 'Nouvelle spec — Product rédige' : '(brouillon sans contenu)');
const list = (items, render) => h('ul', {}, items.map(x => h('li', {}, render ? render(x) : x)));

async function api(path, options = {}) {
  const init = { headers: {}, credentials: 'same-origin' };
  if (options.body !== undefined) {
    init.method = 'POST';
    init.headers['Content-Type'] = 'application/json';
    init.headers['X-APV2-CSRF'] = state.csrf;
    init.body = JSON.stringify(options.body);
  }
  const res = await fetch(path, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `Erreur ${res.status}`);
  return data;
}

// ---------- what a spec needs ----------
function needs(s) {
  const code = s.error && s.error.code;
  const questions = (s.questions || []).length + ((s.design && s.design.questions) || []).length;
  if (s.status === 'draft' && questions) return 'Questions de Product à trancher';
  if (s.status === 'draft' && s.hash) return 'Spec à approuver';
  if (s.status === 'approved' && !s.busy) return 'Exécution à lancer';
  if (s.status === 'awaiting_review') return 'Candidat à relire';
  if (s.status === 'blocked') return ({
    SCOPE_AMENDMENT_REQUIRED: 'Amendement de périmètre à approuver', MERGED_BEFORE_REVIEW: 'PR fusionnée : revue à enregistrer',
    QA_REJECTED: 'QA rejetée : suite à décider', STALE_EVIDENCE: 'Preuve expirée : revalider', NO_CHANGE: 'Tentative sans changement : relancer ou suivre',
  })[code] || `Bloquée : ${code || 'inconnu'}`;
  if (s.status === 'ready') return s.publication && s.publication.url ? 'PR à fusionner' : 'À intégrer, puis clôturer';
  if (s.status === 'delivered') return 'À intégrer, puis clôturer';
  return null;
}
function signalOf(s) {
  if (s.busy || s.status === 'running') return 'run';
  if (s.status === 'blocked') return 'bad';
  if (s.status === 'closed') return 'ok';
  if (s.status === 'rejected' || (s.status === 'draft' && !s.hash)) return 'idle';
  return needs(s) ? 'wait' : 'idle';
}

// ---------- data ----------
async function loadSpecs() {
  state.specs = await api('/api/specs');
  renderProjects(); renderList();
  if (state.view === 'home') renderHome();
}
async function loadDetail() {
  if (!state.selected) return;
  const id = state.selected;
  const [detail, events] = await Promise.all([api(`/api/specs/${id}`), api(`/api/specs/${id}/events`)]);
  if (state.selected !== id) return;
  state.detail = detail; state.events = events;
  renderDetail();
}
async function loadJobs() {
  state.jobs = await api('/api/jobs');
  const running = state.jobs.filter(j => j.state === 'running').length;
  const count = $('#jobs-count'); count.hidden = running === 0; count.textContent = String(running);
  if (!$('#jobs').hidden) renderJobs();
}
const refreshList = debounce(() => loadSpecs().catch(() => {}), 1200);
const refreshDetail = debounce(() => loadDetail().catch(() => {}), 700);

function connectStream() {
  const live = $('#live');
  const source = new EventSource('/api/stream');
  source.onopen = () => { live.textContent = 'en direct'; live.className = 'live live--on'; };
  source.onerror = () => { live.textContent = 'reconnexion…'; live.className = 'live live--off'; };
  source.addEventListener('events', (message) => {
    const events = JSON.parse(message.data);
    refreshList();
    const d = state.detail;
    if (state.view !== 'detail' || !d) return;
    const runs = new Set([...d.attempts.map(a => a.runId), ...d.validations.map(v => v.runId)]);
    const relevant = events.filter(e => (e.source === 'lifecycle' && e.id === state.selected) || (e.source === 'run' && runs.has(e.id)));
    if (!relevant.length) return;
    state.events.push(...relevant);
    // Activity appends in place (a re-render would lose the reader's scroll); the design tab holds an iframe
    // that a re-render would reload. Both re-render only when the spec's own state may have changed.
    const stateChanged = relevant.some(e => e.source === 'lifecycle' && !e.type.startsWith('process.') && !e.type.startsWith('role.'));
    if (state.tab === 'activity') {
      appendTimeline(relevant);
      if (stateChanged) refreshDetail(); else $('#decision')?.replaceWith(decision(d));
      return;
    }
    if (state.tab !== 'design' || stateChanged) refreshDetail(); else $('#decision')?.replaceWith(decision(d));
  });
}

// ---------- projects ----------
/** Projects known to the store, most recently active first, with the counts shown in the switcher. */
function projects() {
  const byRepo = new Map();
  for (const s of state.specs) {
    const key = s.repo || '';
    const p = byRepo.get(key) || { repo: key, name: repoName(key), active: 0, waiting: 0, busy: 0, total: 0, updatedAt: 0 };
    p.total++; p.updatedAt = Math.max(p.updatedAt, s.updatedAt || 0);
    if (!TERMINAL.has(s.status)) { p.active++; if (s.busy) p.busy++; else if (needs(s)) p.waiting++; }
    byRepo.set(key, p);
  }
  const all = [...byRepo.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  // Two repositories with the same folder name are told apart by their parent folder.
  for (const p of all) if (all.some(o => o !== p && o.name === p.name)) p.name = p.repo.split('/').filter(Boolean).slice(-2).join('/');
  return all;
}
const inProject = (s) => state.project === null || (s.repo || '') === state.project;
const projectSpecs = () => state.specs.filter(inProject);
function setProject(repo) {
  state.project = repo; remember(PROJECT_KEY, repo);
  if (state.view === 'detail') { const s = state.specs.find(x => x.id === state.selected); if (s && !inProject(s)) { goHome(); return; } }
  renderProjects(); renderList();
  if (state.view === 'home') renderHome();
}
function renderProjects() {
  const all = projects();
  if (state.project !== null && !all.some(p => p.repo === state.project)) state.project = null;
  const row = (repo, name, detail, p) => h('button', { class: 'project', type: 'button', 'aria-current': state.project === repo ? 'true' : 'false', title: repo || undefined, onclick: () => setProject(repo) },
    h('span', { class: 'project__name', text: name }),
    h('span', { class: 'project__counts' },
      p.busy ? h('span', { class: 'pulse', title: `${p.busy} en cours` }) : null,
      p.waiting ? h('span', { class: 'project__badge', title: `${p.waiting} à décider`, text: String(p.waiting) }) : null,
      h('span', { class: 'project__meta', text: detail })));
  const sum = all.reduce((t, p) => ({ active: t.active + p.active, waiting: t.waiting + p.waiting, busy: t.busy + p.busy }), { active: 0, waiting: 0, busy: 0 });
  const activeText = (n) => n ? `${n} active${n > 1 ? 's' : ''}` : 'rien d\'actif';
  const nav = $('#projects'); nav.replaceChildren();
  add(nav,
    h('div', { class: 'group' }, h('span', { class: 'label', text: 'Projets' }), h('span', { class: 'label', text: String(all.length) })),
    row(null, 'Tous les projets', activeText(sum.active), sum),
    all.map(p => row(p.repo, p.name, activeText(p.active), p)));
}

// ---------- sidebar ----------
function renderList() {
  const nav = $('#spec-list');
  const q = state.query.toLowerCase();
  const specs = projectSpecs().filter(s => (state.filter === 'all' || !TERMINAL.has(s.status))
    && (!q || `${s.title || ''} ${s.id} ${s.repo}`.toLowerCase().includes(q)));
  nav.replaceChildren();
  if (!specs.length) {
    const hidden = state.filter === 'active' ? projectSpecs().filter(s => TERMINAL.has(s.status)).length : 0;
    add(nav, h('div', { class: 'list-empty' }, h('p', { text: state.filter === 'active' ? 'Aucune spec active.' : 'Aucune spec.' }),
      hidden ? h('button', { class: 'btn btn--small', type: 'button', onclick: () => setFilter('all') }, `Voir les ${hidden} terminée${hidden > 1 ? 's' : ''}`) : null));
    return;
  }
  const groups = new Map();
  for (const s of specs) { const r = repoName(s.repo); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(s); }
  for (const [repo, items] of groups) {
    if (state.project === null) nav.append(h('div', { class: 'group' }, h('span', { class: 'label', text: repo }), h('span', { class: 'label', text: String(items.length) })));
    for (const s of items) {
      nav.append(h('button', { class: `spec-item sig-${signalOf(s)}`, type: 'button', 'aria-current': s.id === state.selected ? 'true' : 'false', onclick: () => select(s.id) },
        h('span', { class: 'spec-item__title', text: specTitle(s) }),
        h('span', { class: 'spec-item__meta' }, s.busy ? h('span', { class: 'pulse', title: 'Un agent travaille' }) : null,
          h('span', { text: STATUS[s.status] || s.status }), h('span', { class: 'mono', text: shortId(s.id) }), h('span', { text: ago(s.updatedAt) }))));
    }
  }
}

// ---------- home ----------
function renderHome() {
  const specs = projectSpecs();
  const scope = state.project === null ? null : projects().find(p => p.repo === state.project);
  const active = specs.filter(s => !TERMINAL.has(s.status));
  const waiting = active.filter(s => needs(s) && !s.busy);
  const working = active.filter(s => s.busy || s.status === 'running');
  const blocked = active.filter(s => s.status === 'blocked');
  const closed = specs.filter(s => s.status === 'closed').slice(0, 5);
  const stat = (label, value, signal) => h('div', { class: `stat${signal ? ` sig-${signal}` : ''}` }, h('span', { class: 'label', text: label }), h('span', { class: 'stat__value', text: String(value) }));
  const row = (s, why) => h('button', { class: `queue__row sig-${signalOf(s)}`, type: 'button', onclick: () => select(s.id) },
    h('span', { class: 'queue__body' }, h('span', { class: 'queue__title', text: specTitle(s) }),
      h('span', { class: 'queue__why' }, why)),
    h('span', { class: 'label', text: state.project === null ? `${repoName(s.repo)} · ${ago(s.updatedAt)}` : ago(s.updatedAt) }));
  $('#main').replaceChildren(h('div', { class: 'main__inner' },
    h('div', { class: 'home__head' }, h('div', {},
      h('p', { class: 'home__scope' }, h('span', { class: 'label', text: scope ? 'Projet' : 'Tous les projets' }),
        scope ? [h('strong', { text: scope.name }), h('span', { class: 'mono muted', text: scope.repo })] : h('span', { class: 'muted', text: `${projects().length} dépôts suivis` })),
      h('h1', { text: waiting.length ? 'Ce qui attend votre décision' : 'Rien n\'attend votre décision' }),
      h('p', { text: waiting.length ? `${waiting.length} spec${waiting.length > 1 ? 's' : ''} à traiter. Les agents s'arrêtent tant que vous n'avez pas tranché.` : 'Les agents avancent seuls, ou rien n\'est en cours. Lancez une nouvelle spec quand vous voulez.' })),
      h('button', { class: waiting.length ? 'btn' : 'btn btn--primary', type: 'button', onclick: newSpecDialog }, 'Nouvelle spec')),
    h('div', { class: 'stats' }, stat('Actives', active.length), stat('Agents au travail', working.length, working.length ? 'run' : null),
      stat('À décider', waiting.length, waiting.length ? 'wait' : null), stat('Bloquées', blocked.length, blocked.length ? 'bad' : null),
      stat('Clôturées', specs.filter(s => s.status === 'closed').length, 'ok')),
    h('div', { class: 'section-title' }, h('span', { class: 'label', text: 'À traiter' })),
    waiting.length ? h('div', { class: 'queue' }, waiting.map(s => row(s, needs(s)))) : h('p', { class: 'empty', text: 'Aucune décision en attente.' }),
    working.length ? [h('div', { class: 'section-title' }, h('span', { class: 'label', text: 'En cours' })),
      h('div', { class: 'queue' }, working.map(s => row(s, [h('span', { class: 'pulse' }), ' ', s.title ? 'Un agent travaille sur cette spec' : 'Le contenu apparaîtra à la fin de la rédaction'])))] : null,
    closed.length ? [h('div', { class: 'section-title' }, h('span', { class: 'label', text: 'Dernières clôturées' })),
      h('div', { class: 'queue' }, closed.map(s => row(s, 'Fusionnée et clôturée')))] : null));
}
function goHome() {
  state.view = 'home'; state.selected = null; state.detail = null;
  if (location.hash) history.pushState(null, '', location.pathname);
  renderList(); renderHome();
}

// ---------- detail ----------
function select(id) {
  const spec = state.specs.find(s => s.id === id);
  if (spec && !inProject(spec)) { state.project = spec.repo || ''; remember(PROJECT_KEY, state.project); renderProjects(); }
  state.view = 'detail'; state.selected = id; state.detail = null; state.events = []; state.tab = 'overview'; state.preview = null;
  if (location.hash !== `#${id}`) history.pushState(null, '', `#${id}`);
  renderList();
  $('#main').replaceChildren(h('div', { class: 'main__inner' }, h('p', { class: 'muted', text: 'Chargement…' })));
  $('#main').scrollTop = 0;
  loadDetail().catch(err => $('#main').replaceChildren(h('div', { class: 'main__inner' }, h('p', { class: 'notice sig-bad', text: err.message }))));
}

function stage(d) {
  const s = d.summary; const c = d.content;
  const total = c ? c.tasks.length : 0; const done = s.tasks.filter(t => t.done).length;
  const validated = d.validations.some(v => ['ready', 'awaiting_review'].includes(v.state));
  let index = 0; let note = '';
  if (s.status === 'draft') { index = 0; note = needs(s) || 'Product rédige'; }
  else if (s.status === 'approved') { index = 1; note = 'Prête à lancer'; }
  else if (['running', 'blocked', 'rejected'].includes(s.status)) {
    if (!d.approval) { index = 0; }
    else if (done < total) { index = 2; note = `${done}/${total} tâches`; }
    else if (!validated) { index = 3; note = 'Validation d\'ensemble'; }
    else if (!d.qa || d.qa.report.verdict !== 'pass') { index = 4; note = d.qa ? 'Changements demandés' : 'Évaluation'; }
    else { index = 5; }
  }
  else if (s.status === 'awaiting_review') { index = 5; note = 'À vous'; }
  else if (['ready', 'delivered'].includes(s.status)) { index = 6; note = 'À fusionner'; }
  else if (s.status === 'closed') { index = 7; }
  return { index, note, signal: s.status === 'rejected' ? 'idle' : signalOf({ ...s, busy: d.busy }) };
}
function rail(d) {
  const { index, note, signal } = stage(d);
  return h('ol', { class: `rail sig-${signal}`, 'aria-label': 'Avancement dans le pipeline' }, STAGES.map((label, i) =>
    h('li', { class: i < index ? 'is-done' : i === index ? 'is-current' : '', 'aria-current': i === index ? 'step' : null },
      h('span', { class: 'rail__node' }), h('span', { class: 'rail__label', text: label }),
      i === index && note ? h('span', { class: 'rail__note', text: note }) : null)));
}

function renderDetail() {
  const d = state.detail; const s = d.summary; const c = d.content;
  const pending = d.scopeAmendments.filter(a => a.status === 'pending').length + d.criterionAmendments.filter(a => a.status === 'pending').length;
  const qaOpen = d.qa && d.qa.report.verdict !== 'pass';
  const tabs = [
    ['overview', 'Vue d\'ensemble'], ['criteria', 'Critères', c ? c.acceptance.length : null], ['tasks', 'Tâches', c ? c.tasks.length : null],
    ['activity', 'Activité'], ['qa', 'QA', qaOpen ? '!' : null, qaOpen], ['design', 'Maquettes', d.design ? d.design.screens.length : null],
    ['amendments', 'Amendements', pending || null, pending > 0],
  ];
  const body = h('div', {});
  $('#main').replaceChildren(h('div', { class: 'main__inner' },
    h('div', { class: 'crumbs' }, h('button', { class: 'btn btn--ghost btn--small', type: 'button', onclick: goHome }, '← À traiter'),
      pill(signalOf({ ...s, busy: d.busy }), STATUS[s.status] || s.status, d.busy),
      h('span', { class: 'idchip' }, shortId(s.id), h('button', { type: 'button', onclick: () => copy(s.id) }, 'copier')),
      h('span', { class: 'mono', text: d.repo })),
    h('h1', { text: specTitle(s, d.busy) }),
    rail(d),
    d.legacy ? h('p', { class: 'notice sig-wait', text: 'Document antérieur au format actuel : son intégrité ne peut pas être revérifiée. Affiché en lecture seule, sans action possible.' }) : decision(d),
    h('div', { class: 'tabs', role: 'tablist' }, tabs.map(([key, label, n, alert]) => h('button', { type: 'button', role: 'tab', 'aria-selected': state.tab === key ? 'true' : 'false',
      onclick: () => { state.tab = key; renderDetail(); } }, label, n !== null && n !== undefined ? h('span', { class: `n${alert ? ' n--alert' : ''}`, text: String(n) }) : null))),
    body));
  ({ overview, criteria, tasks, activity, qa, design, amendments })[state.tab](body, d);
}

const PROVIDERS = { claude: 'Claude Code', codex: 'Codex', command: 'agent externe' };
const hhmm = (ms) => new Date(ms).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
/**
 * What the busy spec is doing now, read backwards from its activity: the role at work (Product, Design, QA)
 * or, inside a run, the Implementer, the checks or the workspace preparation of a task, with its start time.
 * Returns null when the latest step has just finished and the next one has not started yet.
 */
function currentWork(d) {
  const tasks = new Map(((d.content && d.content.tasks) || []).map(t => [t.id, t.title]));
  const runTask = new Map(d.attempts.map(a => [a.runId, a.taskId]));
  const subject = (runId) => { const t = runTask.get(runId); return t ? `${t} · ${tasks.get(t) || ''}` : 'validation d\'ensemble'; };
  const ROLE = { product: ['Product', 'rédige la spec'], qa: ['QA', 'évalue le candidat'], setup: ['Setup', 'prépare la configuration'] };
  const RUN = { 'agent.started': 'Implementer', 'agent.repair_started': 'Implementer (réparation)', 'validation.started': 'Contrôles', 'workspace.preparing': 'Préparation de l\'espace de travail' };
  const DONE = new Set(['role.finished', 'agent.completed', 'validation.completed', 'validation.failed', 'session.finished', 'workflow.session_finished', 'run.failed']);
  for (let i = state.events.length - 1; i >= 0; i--) {
    const e = state.events[i]; const x = e.data || {};
    if (DONE.has(e.type)) return null;
    if (e.source === 'lifecycle' && e.type === 'role.started') {
      const [who, what] = x.mode === 'design-proposal' ? ['Design', 'prépare les maquettes'] : ROLE[x.role] || [x.role, 'travaille'];
      return { who, what, provider: PROVIDERS[x.provider] || x.provider, since: e.at };
    }
    if (e.source === 'run' && RUN[e.type]) {
      const provider = e.type.startsWith('agent.') ? PROVIDERS[d.implementer] || d.implementer : null;
      return { who: RUN[e.type], what: subject(e.id), provider, since: e.at };
    }
  }
  return null;
}

function decision(d) {
  const s = d.summary; const code = s.error && s.error.code;
  const questions = (s.questions || []).length + ((s.design && s.design.questions) || []).length;
  const primary = []; const secondary = [];
  const btn = (label, onclick, kind = 'btn', disabled = false) => h('button', { class: kind, type: 'button', disabled, onclick }, label);
  if (s.status === 'draft' && s.hash && !questions) primary.push(btn('Approuver la spec', () => approveDialog(d), 'btn btn--primary', d.busy));
  if (s.status === 'draft') (questions ? primary : secondary).push(btn(questions ? 'Répondre aux questions' : 'Affiner', () => refineDialog(d, questions), questions ? 'btn btn--primary' : 'btn', d.busy));
  if (code === 'SCOPE_AMENDMENT_REQUIRED') primary.push(btn('Examiner l\'amendement', () => { state.tab = 'amendments'; renderDetail(); }, 'btn btn--primary'));
  if (s.status === 'awaiting_review' || code === 'MERGED_BEFORE_REVIEW') primary.push(btn('Enregistrer ma revue', () => reviewDialog(d), 'btn btn--primary'));
  if (d.approval && !d.busy && ['approved', 'running', 'blocked'].includes(s.status) && !['SCOPE_AMENDMENT_REQUIRED', 'QA_REJECTED', 'MERGED_BEFORE_REVIEW'].includes(code))
    (primary.length ? secondary : primary).push(btn(s.status === 'blocked' ? 'Reprendre l\'exécution' : 'Lancer l\'exécution', () => job(`/api/specs/${s.id}/run`, 'Exécution lancée'), primary.length ? 'btn' : 'btn btn--primary', d.busy));
  if (s.stoppedWork) {
    primary.push(btn('Adopter le travail conservé', () => confirmDialog('Adopter le travail conservé',
      `L'agent s'est arrêté avant de rendre son résultat, mais ses fichiers sont dans ${s.stoppedWork.workspace}. Ils seront enregistrés tels quels, puis soumis aux contrôles, à la QA et à votre revue. Relisez-les avant d'adopter.`,
      () => api(`/api/specs/${s.id}/run`, { body: { acceptCurrent: true } }), 'Adoption lancée'), 'btn btn--primary', d.busy));
    secondary.push(btn('Jeter et recommencer', () => confirmDialog('Jeter le travail conservé',
      'La tâche repart de la base approuvée, avec le diagnostic de la tentative arrêtée. Le travail conservé est abandonné.',
      () => api(`/api/specs/${s.id}/retry`, { body: { confirm: true } }), 'Nouvelle tentative autorisée')));
  }
  else if (s.status === 'blocked' && ['NO_CHANGE', 'TASK_FAILED', 'REPAIR_NO_CHANGE', 'REPAIR_NO_PROGRESS', 'GATES_FAILED', 'AGENT', 'EXECUTION'].includes(code))
    secondary.push(btn('Autoriser une nouvelle tentative', () => confirmDialog('Autoriser une nouvelle tentative', 'La tâche échouée est reconstruite à partir de l\'état actuel, puis relancée à la prochaine exécution.', () => api(`/api/specs/${s.id}/retry`, { body: { confirm: true } }), 'Nouvelle tentative autorisée')));
  if (d.approval && (code === 'STALE_EVIDENCE' || ['awaiting_review', 'ready'].includes(s.status))) secondary.push(btn('Revalider', () => job(`/api/specs/${s.id}/verify`, 'Revalidation lancée'), 'btn', d.busy));
  if (s.publication && s.publication.url && !TERMINAL.has(s.status)) secondary.push(btn('Synchroniser avec la PR', () => job(`/api/specs/${s.id}/sync`, 'Synchronisation lancée'), 'btn', d.busy));
  if (!TERMINAL.has(s.status)) secondary.push(btn('Rejeter', () => rejectDialog(d), 'btn btn--quiet-danger'));
  const why = needs({ ...s, busy: d.busy });
  const work = d.busy ? currentWork(d) : null;
  const title = d.busy ? (work ? `${work.who} au travail` : s.status === 'draft' ? 'Product rédige la spec' : 'Un agent travaille') : s.status === 'blocked' ? why : why || (s.status === 'closed' ? 'Spec clôturée' : s.status === 'rejected' ? 'Spec rejetée' : 'Rien à faire pour l\'instant');
  return h('section', { id: 'decision', class: `decision sig-${signalOf({ ...s, busy: d.busy })}`, 'aria-label': 'Décision attendue' },
    h('div', { class: 'decision__text' },
      h('span', { class: 'label', text: d.busy ? 'En cours' : why ? 'À vous' : 'État' }),
      h('span', { class: 'decision__title', text: title }),
      work ? h('p', { class: 'decision__work' }, h('span', { text: work.what }),
        h('span', { class: 'muted', text: [work.provider, `depuis ${hhmm(work.since)}`].filter(Boolean).join(' · ') })) : null,
      s.status === 'blocked' && s.error ? h('p', { class: 'muted', text: s.error.message }) : null,
      s.status === 'draft' && s.hash ? h('span', { class: 'hash' }, 'hash', h('code', { text: s.hash }), copyButton(s.hash)) : null,
      s.status === 'awaiting_review' ? h('span', { class: 'hash' }, 'candidat', h('code', { text: s.candidateSha })) : null,
      s.publication && s.publication.url ? h('a', { href: s.publication.url, target: '_blank', rel: 'noopener noreferrer', text: s.publication.url }) : null),
    h('div', { class: 'decision__actions' }, primary, secondary),
    // While an agent works, the stored next action describes the state before it finished.
    !d.busy && s.nextAction && s.nextAction.startsWith('apv2 ') ? h('div', { class: 'decision__cli' }, h('span', { class: 'label', text: 'terminal' }), h('pre', { text: s.nextAction }), copyButton(s.nextAction)) : null);
}

function overview(root, d) {
  const c = d.content;
  if (!c) { add(root, h('p', { class: 'lead muted', text: 'Product n\'a pas encore produit de contenu.' }), h('div', { class: 'sheet' }, h('div', { class: 'sheet__cell' }, h('span', { class: 'label', text: 'Demande' }), h('pre', { text: d.request })))); return; }
  const sec = c.security || {};
  add(root, 
    h('p', { class: 'lead', text: c.problem }),
    h('div', { class: 'sheet' },
      h('div', { class: 'sheet__row' },
        h('div', { class: 'sheet__cell' }, h('span', { class: 'label', text: 'Périmètre' }), list(c.scope || [])),
        h('div', { class: 'sheet__cell' }, h('span', { class: 'label', text: 'Hors périmètre' }), (c.outOfScope || []).length ? list(c.outOfScope) : h('p', { class: 'muted', text: '—' }))),
      h('div', { class: 'sheet__row' },
        h('div', { class: 'sheet__cell' }, h('span', { class: 'label', text: 'Sécurité' }), h('dl', { class: 'facts' },
          h('dt', { text: 'Voie minimale' }), h('dd', { class: 'mono', text: c.minimumLane }),
          h('dt', { text: 'Thèmes OWASP' }), h('dd', { text: (sec.owaspTopics || []).join(', ') || '—' }),
          h('dt', { text: 'Exigences' }), h('dd', { class: 'mono', text: String((sec.requirements || []).length) }))),
        h('div', { class: 'sheet__cell' }, h('span', { class: 'label', text: 'Décisions du projet couvertes' }),
          (c.decisionCoverage || []).length ? list(c.decisionCoverage, x => [h('code', { text: x.decisionId }), h('span', { class: 'muted', text: ` → ${x.acceptanceIds.join(', ')}` })]) : h('p', { class: 'muted', text: '—' })))),
    (c.questions || []).length ? h('div', { class: 'sheet' }, h('div', { class: 'sheet__cell' }, h('span', { class: 'label', text: 'Questions ouvertes' }), list(c.questions, q => q.question))) : null,
    d.impactAdvice.length ? h('div', { class: 'sheet' }, h('div', { class: 'sheet__cell' }, h('span', { class: 'label', text: 'Tests existants peut-être mal rangés' }),
      h('p', { class: 'muted', text: 'Avertissement, jamais bloquant.' }),
      list(d.impactAdvice, a => [h('code', { text: a.test }), h('span', { class: 'muted', text: ` — modifié par ${a.changedBy}, rangé dans ${a.assignedTo || 'aucune tâche'} (${a.evidence === 'declared-later' ? 'déclaré plus tard' : 'import direct'})` })]))) : null,
    h('div', { class: 'sheet' }, h('details', { class: 'sheet__cell' }, h('summary', { text: 'Demande complète de l\'opérateur' }), h('pre', { text: d.request }))));
}

function criteria(root, d) {
  const c = d.content; if (!c) return add(root, h('p', { class: 'muted', text: '—' }));
  const qaMap = d.qa ? new Map(d.qa.report.criteria.map(x => [x.id, x])) : new Map();
  const fixes = new Map(d.criterionAmendments.filter(a => a.status === 'approved').map(a => [a.criterionId, a]));
  const verdict = { pass: ['ok', 'validé'], fail: ['bad', 'échec'], unknown: ['wait', 'inconnu'] };
  add(root, h('div', { class: 'sheet table-wrap' }, h('table', { class: 'ledger' },
    h('thead', {}, h('tr', {}, h('th', { class: 'label', text: 'Critère' }), h('th', { class: 'label', text: 'Exigence' }), h('th', { class: 'label', text: 'QA' }))),
    h('tbody', {}, c.acceptance.map(a => {
      const fix = fixes.get(a.id); const q = qaMap.get(a.id); const [sig, word] = q ? verdict[q.status] || ['idle', q.status] : ['idle', '—'];
      return h('tr', {},
        h('td', {}, h('code', { text: a.id }), fix ? h('div', {}, pill('wait', 'corrigé')) : null),
        h('td', {}, fix ? h('p', { class: 'strike', text: a.description }) : null, h('p', { text: fix ? fix.description : a.description }),
          h('p', { class: 'evidence', text: `Vérification : ${fix ? fix.verification : a.verification}` })),
        h('td', {}, q ? pill(sig, word) : h('span', { class: 'muted', text: '—' }), q ? h('p', { class: 'evidence', text: q.evidence }) : null));
    })))));
}

function gateSignal(status) { return ({ passed: 'ok', cached: 'ok', failed: 'bad', timed_out: 'bad', blocked: 'bad', cancelled: 'idle', spawn_error: 'bad' })[status] || 'idle'; }
function gates(receipts) {
  if (!receipts.length) return h('p', { class: 'muted', text: 'aucun contrôle' });
  return h('div', { class: 'gates' }, receipts.map(r => h('span', { class: `gate sig-${gateSignal(r.status)}`, title: r.diagnostic || '' },
    r.gateId, h('span', { text: r.status === 'cached' ? 'repris' : r.status === 'passed' ? 'ok' : r.status }), r.durationMs ? h('span', { class: 'muted', text: duration(r.durationMs) }) : null)));
}
function runSignal(state) { return state === 'failed' ? 'bad' : ['ready', 'awaiting_review'].includes(state) ? 'ok' : state === 'interrupted' ? 'wait' : 'run'; }
function attemptBlock(a, label) {
  return h('div', { class: 'attempt' },
    h('div', { class: 'attempt__head' }, h('strong', { text: label }), pill(runSignal(a.state), RUN_STATE[a.state] || a.state), a.lane ? h('span', { class: 'mono', text: `voie ${a.lane}` }) : null, h('span', { class: 'mono muted', text: shortId(a.runId) })),
    gates(a.receipts),
    a.error ? h('p', { class: 'error', text: `${a.error.code} — ${a.error.message}` }) : null,
    a.summary ? h('details', {}, h('summary', { text: 'Résumé de l\'agent' }), h('pre', { text: a.summary })) : null);
}
function tasks(root, d) {
  const c = d.content; if (!c) return add(root, h('p', { class: 'muted', text: '—' }));
  const done = new Set(d.summary.tasks.filter(t => t.done).map(t => t.id));
  add(root, h('div', { class: 'sheet' }, c.tasks.map((t, i) => {
    const attempts = d.attempts.filter(a => a.taskId === t.id); const last = attempts[attempts.length - 1];
    const status = done.has(t.id) ? pill('ok', 'terminée') : last ? pill(runSignal(last.state), RUN_STATE[last.state] || last.state, last.state !== 'failed' && d.busy) : pill('idle', 'à faire');
    return h('div', { class: 'task' },
      h('span', { class: 'task__num', text: String(i + 1).padStart(2, '0') }),
      h('div', {},
        h('div', { class: 'task__head' }, h('h2', { text: t.title }), status),
        h('p', { class: 'task__meta' }, h('code', { text: t.id }), `  ·  critères ${(t.acceptanceIds || []).join(', ')}`, (t.dependsOn || []).length ? `  ·  après ${t.dependsOn.join(', ')}` : ''),
        h('details', {}, h('summary', { text: `Chemins autorisés (${(t.allowedPaths || []).length})` }), list(t.allowedPaths || [], p => h('code', { text: p }))),
        attempts.map((a, n) => attemptBlock(a, attempts.length > 1 ? `Tentative ${n + 1}` : 'Tentative'))));
  })));
  const repairs = d.attempts.filter(a => a.kind === 'qa-repair');
  if (repairs.length) add(root, h('div', { class: 'section-title' }, h('span', { class: 'label', text: 'Réparations QA' })), h('div', { class: 'sheet' }, h('div', { class: 'sheet__cell' }, repairs.map((a, n) => attemptBlock(a, `Réparation ${n + 1}`)))));
  if (d.validations.length) add(root, h('div', { class: 'section-title' }, h('span', { class: 'label', text: 'Validation d\'ensemble' })), h('div', { class: 'sheet' }, h('div', { class: 'sheet__cell' }, d.validations.map(v => attemptBlock(v, 'Intégration')))));
}

// ---------- activity ----------
function describe(e) {
  const d = e.data || {};
  const role = d.role ? ({ product: 'Product', qa: 'QA', setup: 'Setup', implementer: 'Implementer' })[d.role] || d.role : '';
  return ({
    'spec.created': 'Spec créée', 'product.refinement_requested': 'Affinage demandé', 'product.proposed': 'Proposition de Product prête',
    'design.proposed': 'Maquette prête', 'spec.approved': `Spec approuvée par ${d.approval ? d.approval.reviewer : '?'}`, 'spec.rejected': 'Spec rejetée',
    'role.started': `${role} au travail${d.mode === 'design-proposal' ? ' sur la maquette' : ''}`, 'role.finished': `${role} a terminé${d.mode === 'design-proposal' ? ' la maquette' : ''}${d.timingsMs ? ` en ${duration(d.timingsMs.total)}` : ''}`,
    'role.repair_requested': `${role} : réponse à corriger`, 'workflow.session_started': 'Exécution démarrée', 'workflow.session_finished': 'Exécution arrêtée',
    'workflow.task_started': `Tâche ${d.taskId || ''} démarrée`, 'workflow.task_completed': `Tâche ${d.taskId || ''} terminée`, 'workflow.blocked': `Bloquée : ${d.error ? d.error.code : ''}`,
    'workflow.qa_repair_started': `Réparation QA n° ${d.number || ''} lancée`, 'workflow.review_ready': 'Prête pour la revue', 'workflow.retry_authorized': 'Nouvelle tentative autorisée',
    'integration.created': 'Validation d\'ensemble lancée', 'integration.adopted': 'Preuve de la tâche reprise, contrôles non rejoués', 'integration.adoption_refused': `Reprise refusée : ${d.reason || ''}`,
    'integration.reused': 'Validation de la tâche réutilisée', 'qa.completed': `QA : ${d.qa && d.qa.report ? (d.qa.report.verdict === 'pass' ? 'validée' : 'changements demandés') : ''}`,
    'scope.amendment_requested': 'Amendement de périmètre demandé', 'scope.amendment_approved': 'Amendement de périmètre approuvé',
    'criterion.amendment_proposed': `Correction du critère ${d.criterionId || ''} proposée`, 'criterion.amendment_approved': `Correction du critère ${d.criterionId || ''} approuvée`,
    'spec.reviewed': `Revue enregistrée par ${d.reviewer || '?'}`, 'spec.closed': 'Spec clôturée', 'publication.pr_created': 'PR ouverte', 'publication.merged_before_review': 'PR fusionnée avant la revue',
    'agent.started': 'Implementer au travail', 'agent.completed': 'Implementer a terminé', 'candidate.created': 'Candidat créé',
    'validation.started': `Contrôles lancés : ${(d.gateIds || []).join(', ')}`, 'gate.finished': `Contrôle ${d.gateId || ''} : ${d.status === 'passed' ? 'réussi' : d.status === 'cached' ? 'repris' : d.status || ''}${d.durationMs ? ` (${duration(d.durationMs)})` : ''}`,
    'validation.completed': 'Contrôles réussis', 'validation.failed': 'Contrôles en échec', 'validation.adopted': 'Reçus repris', 'run.failed': `Run en échec : ${d.error ? d.error.code : ''}`,
    'agent.repair_no_change': 'Réparation sans changement', 'agent.repair_no_progress': 'Réparation sans effet : mêmes contrôles en échec',
  })[e.type];
}
function eventSignal(e) {
  const d = e.data || {};
  if (e.type === 'gate.finished') return gateSignal(d.status);
  if (/blocked|failed|refused|rejected|no_change/.test(e.type)) return 'bad';
  if (/approved|reviewed|closed|completed|adopted|reused/.test(e.type)) return e.type === 'qa.completed' && d.qa && d.qa.report && d.qa.report.verdict !== 'pass' ? 'wait' : 'ok';
  if (/requested|review_ready|proposed|pr_created/.test(e.type)) return 'wait';
  if (/started|role\.|agent\.|validation\./.test(e.type)) return 'run';
  return 'idle';
}
function timelineItem(e) {
  const label = describe(e);
  if (!label && !state.showTech) return null;
  return h('li', {}, h('time', { text: clock(e.at) }), h('span', { class: `timeline__dot sig-${eventSignal(e)}` }),
    h('span', { class: `timeline__text${label ? '' : ' is-tech'}` }, label || e.type, e.source === 'run' ? h('span', { class: 'timeline__run', text: `run ${shortId(e.id)}` }) : null));
}
function activity(root) {
  add(root, h('div', { class: 'timeline__tools' },
    h('label', {}, h('input', { type: 'checkbox', checked: state.showTech, onchange: (ev) => { state.showTech = ev.target.checked; renderDetail(); } }), ' Détails techniques'),
    h('span', { class: 'label', text: 'mise à jour en direct' })),
    h('div', { class: 'sheet' }, h('ol', { class: 'timeline', id: 'timeline' })));
  appendTimeline(state.events, true);
}
function appendTimeline(events, initial) {
  const ol = document.getElementById('timeline'); if (!ol) return;
  const main = $('#main');
  const atBottom = initial || main.scrollTop + main.clientHeight >= main.scrollHeight - 120;
  for (const e of events) { const li = timelineItem(e); if (li) ol.append(li); }
  if (!initial && atBottom) main.scrollTop = main.scrollHeight;
}

function qa(root, d) {
  if (!d.qa) { add(root, h('p', { class: 'empty', text: 'Pas encore de rapport QA pour le candidat actuel.' })); return; }
  const r = d.qa.report; const passed = r.verdict === 'pass';
  const count = (status) => r.criteria.filter(c => c.status === status).length;
  add(root, 
    h('div', { class: 'sheet' }, h('div', { class: 'sheet__cell' },
      h('div', { class: 'task__head' }, pill(passed ? 'ok' : 'bad', passed ? 'validé' : 'changements demandés'),
        h('span', { class: 'mono muted', text: `${count('pass')}/${r.criteria.length} critères · candidat ${shortId(r.candidateSha)}` })),
      h('p', { class: 'lead', text: r.summary }))),
    (r.findings || []).length ? h('div', { class: 'sheet' }, h('div', { class: 'sheet__cell' }, h('span', { class: 'label', text: 'Constats' }),
      list(r.findings, f => [pill(f.severity === 'minor' ? 'wait' : 'bad', f.severity), ' ', f.path ? h('code', { text: f.path }) : null, h('p', { text: f.description })]))) : null,
    (r.observations || []).length ? h('div', { class: 'sheet' }, h('div', { class: 'sheet__cell' }, h('span', { class: 'label', text: 'Observations' }), list(r.observations))) : null,
    (r.securityChecks || []).length ? h('div', { class: 'sheet' }, h('div', { class: 'sheet__cell' }, h('span', { class: 'label', text: 'Exigences de sécurité' }),
      list(r.securityChecks, x => [pill(x.status === 'pass' ? 'ok' : x.status === 'fail' ? 'bad' : 'wait', x.requirementId), h('span', { class: 'muted', text: ` ${x.evidence}` })]))) : null);
}

function design(root, d) {
  const g = d.design;
  if (!g) { add(root, h('p', { class: 'empty', text: 'Cette spec n\'a pas de maquette.' })); return; }
  const available = g.screens.filter(x => x.available);
  if (!state.preview && available.length) state.preview = available[0].file;
  const src = state.preview ? `/api/specs/${d.summary.id}/design/${encodeURIComponent(state.preview)}` : null;
  add(root, 
    h('p', { class: 'lead', text: g.summary }),
    g.reusedFrom || g.loadedStylesheets.length ? h('p', { class: 'muted' }, g.reusedFrom ? `Prolonge la direction de la spec ${shortId(g.reusedFrom)}. ` : '', g.loadedStylesheets.length ? `Feuilles du projet chargées : ${g.loadedStylesheets.map(x => x.path).join(', ')}.` : '') : null,
    g.questions.length ? h('div', { class: 'notice sig-wait' }, 'Questions de la maquette : ', list(g.questions, q => q.question)) : null,
    h('div', { class: 'previews' },
      h('div', { class: 'screen-list' }, g.screens.map(x => h('button', { type: 'button', disabled: !x.available, 'aria-current': x.file === state.preview ? 'true' : 'false',
        onclick: () => { state.preview = x.file; renderDetail(); } }, h('strong', { text: x.title }), h('span', { class: 'muted', text: x.available ? x.purpose : 'aperçu supprimé après clôture' })))),
      src ? h('div', {}, h('iframe', { src, sandbox: '', title: 'Aperçu de la maquette', loading: 'lazy' }), h('p', {}, h('a', { href: src, target: '_blank', rel: 'noopener noreferrer', text: 'Ouvrir dans un onglet' })))
        : h('p', { class: 'empty', text: 'Aucun aperçu disponible : les fichiers ont été nettoyés après la clôture.' })));
}

function amendments(root, d) {
  const scope = d.scopeAmendments; const crit = d.criterionAmendments;
  if (!scope.length && !crit.length) { add(root, h('p', { class: 'empty', text: 'Aucun amendement.' })); return; }
  const head = (a, title) => h('div', { class: 'amend__head' }, h('div', { class: 'task__head' }, pill(a.status === 'pending' ? 'wait' : 'ok', a.status === 'pending' ? 'en attente' : 'approuvé'), h('h2', { text: title })),
    a.status === 'pending' ? null : h('span', { class: 'muted', text: `par ${a.reviewer || '?'}` }));
  add(root, h('div', { class: 'sheet' },
    scope.map(a => h('div', { class: 'amend' }, head(a, `Périmètre de la tâche ${a.taskId}`),
      h('p', { class: 'muted', text: a.reason }), list(a.paths, p => h('code', { text: p })),
      a.status === 'pending' ? h('div', { class: 'decision__actions' }, h('button', { class: 'btn btn--primary', type: 'button', onclick: () => noteDialog('Approuver l\'amendement de périmètre',
        `La tâche ${a.taskId} pourra modifier : ${a.paths.join(', ')}.`, (note) => api(`/api/specs/${d.summary.id}/scope-amendments/${a.id}/approve`, { body: { note } }), 'Amendement approuvé') }, 'Approuver')) : h('p', { class: 'muted', text: a.note || '' }))),
    crit.map(a => h('div', { class: 'amend' }, head(a, `Critère ${a.criterionId}`),
      h('p', { class: 'strike', text: a.previous.description }), h('p', { text: a.description }), h('p', { class: 'muted', text: `Motif : ${a.reason}` }),
      (a.requirements || []).length ? list(a.requirements, r => [h('code', { text: r.id }), ' ', h('span', { class: 'strike', text: r.previous }), ' → ', r.verification]) : null,
      a.status === 'pending' ? h('div', { class: 'decision__actions' }, h('button', { class: 'btn btn--primary', type: 'button', onclick: () => noteDialog('Approuver la correction du critère',
        `Hash : ${a.hash}`, (note) => api(`/api/specs/${d.summary.id}/criterion-amendments/${a.id}/approve`, { body: { hash: a.hash, note } }), 'Correction approuvée') }, 'Approuver')) : h('p', { class: 'muted', text: a.note || '' })))));
}

// ---------- dialogs ----------
function openDialog(title, content, onConfirm, confirmLabel = 'Confirmer', danger = false) {
  const dialog = $('#dialog');
  $('#dialog-title').textContent = title;
  $('#dialog-body').replaceChildren(h('div', { class: 'stack' }, content));
  const error = $('#dialog-error'); error.hidden = true;
  const confirm = $('#dialog-confirm'); confirm.textContent = confirmLabel; confirm.disabled = false;
  confirm.className = danger ? 'btn btn--quiet-danger' : 'btn btn--primary';
  confirm.onclick = async () => {
    confirm.disabled = true; error.hidden = true; confirm.textContent = 'Envoi…';
    try { await onConfirm(); dialog.close(); await Promise.all([loadSpecs(), loadDetail(), loadJobs()]); }
    catch (err) { error.textContent = err.message; error.hidden = false; confirm.disabled = false; confirm.textContent = confirmLabel; }
  };
  $('#dialog-cancel').onclick = () => dialog.close();
  dialog.showModal();
  dialog.querySelector('textarea, input')?.focus();
}
const field = (label, input) => h('label', { class: 'field' }, h('span', { text: label }), input);
const noteField = (placeholder = 'Ce que vous avez vérifié (au moins 10 caractères)') => h('textarea', { id: 'dlg-note', required: true, minlength: '10', placeholder });
const noteValue = () => document.getElementById('dlg-note').value;
function noteDialog(title, text, send, done) { openDialog(title, [h('p', { text }), field('Note', noteField())], async () => { await send(noteValue()); toast(done); }, 'Approuver'); }
function confirmDialog(title, text, send, done) { openDialog(title, h('p', { text }), async () => { await send(); toast(done); }); }
function approveDialog(d) {
  openDialog('Approuver la spec', [
    h('p', { text: 'Vous approuvez exactement ce contenu, spec et maquette comprises. L\'implémentation pourra démarrer.' }),
    h('span', { class: 'hash' }, 'hash', h('code', { text: d.summary.hash })),
    field('Note', noteField())], async () => { await api(`/api/specs/${d.summary.id}/approve`, { body: { hash: d.summary.hash, note: noteValue() } }); toast('Spec approuvée'); }, 'Approuver');
}
function reviewDialog(d) {
  const sha = d.summary.candidateSha;
  openDialog('Enregistrer ma revue', [
    h('p', { text: 'Vous approuvez ce candidat exact, après l\'avoir relu.' }),
    h('span', { class: 'hash' }, 'candidat', h('code', { text: sha })),
    d.review ? h('p', { class: 'muted', text: `Dossier de revue : ${d.review.directory}` }) : null,
    field('Note', noteField())], async () => { await api(`/api/specs/${d.summary.id}/review`, { body: { sha, note: noteValue() } }); toast('Revue enregistrée'); }, 'Approuver le candidat');
}
function rejectDialog(d) {
  openDialog('Rejeter la spec', [h('p', { text: 'La spec ne pourra plus être exécutée. Son historique reste consultable.' }), field('Motif', noteField('Pourquoi vous la rejetez (au moins 10 caractères)'))],
    async () => { await api(`/api/specs/${d.summary.id}/reject`, { body: { note: noteValue() } }); toast('Spec rejetée'); }, 'Rejeter la spec', true);
}
function refineDialog(d, questions) {
  const textarea = h('textarea', { placeholder: questions ? 'Vos réponses, avec vos décisions exactes' : 'Ce qu\'il faut changer dans la spec' });
  const all = [...(d.summary.questions || []), ...((d.summary.design && d.summary.design.questions) || [])];
  openDialog(questions ? 'Répondre aux questions' : 'Affiner la spec', [questions ? list(all, q => q.question) : null, field('Réponse', textarea),
    h('p', { class: 'muted', text: 'Product retravaille la spec ; un nouveau hash sera à approuver.' })],
    async () => { await api(`/api/specs/${d.summary.id}/refine`, { body: { request: textarea.value } }); toast('Affinage lancé'); }, 'Lancer l\'affinage');
}
function newSpecDialog() {
  const repos = [...new Set(state.specs.map(s => s.repo).filter(Boolean))];
  const repo = h('input', { type: 'text', value: state.project || repos[0] || '', list: 'repos', spellcheck: 'false' });
  const request = h('textarea', { placeholder: 'Ce que vous voulez obtenir, vos décisions, et ce qui est hors périmètre' });
  openDialog('Nouvelle spec', [field('Dépôt', repo), h('datalist', { id: 'repos' }, repos.map(r => h('option', { value: r }))), field('Demande', request),
    h('p', { class: 'muted', text: 'Product rédige un brouillon ; rien n\'est exécuté avant votre approbation.' })],
    async () => { await api('/api/specs', { body: { repo: repo.value, request: request.value } }); toast('Brouillon en préparation'); }, 'Lancer le brouillon');
}
async function job(path, done) {
  try { await api(path, { body: {} }); toast(done); await Promise.all([loadJobs(), loadDetail()]); }
  catch (err) { toast(err.message); }
}

// ---------- operations & maintenance ----------
function renderJobs() {
  const body = $('#jobs-body');
  body.replaceChildren();
  if (!state.jobs.length) { body.append(h('p', { class: 'empty', text: 'Aucune opération lancée depuis la console.' })); return; }
  for (const j of state.jobs) body.append(h('div', { class: 'job' },
    h('div', { class: 'job__head' }, pill({ running: 'run', succeeded: 'ok', failed: 'bad' }[j.state], { running: 'en cours', succeeded: 'terminée', failed: 'échec' }[j.state], j.state === 'running'),
      h('strong', { text: j.label }), j.specId ? h('button', { class: 'btn btn--small', type: 'button', onclick: () => { setDrawer(false); select(j.specId); } }, shortId(j.specId)) : null,
      h('span', { class: 'muted', text: ago(j.startedAt) }), j.finishedAt ? h('span', { class: 'mono muted', text: duration(j.finishedAt - j.startedAt) }) : null),
    j.tail ? h('pre', { text: j.tail }) : null));
}
function setDrawer(open) {
  $('#jobs').hidden = !open; $('#jobs-backdrop').hidden = !open;
  if (open) { renderJobs(); $('[data-close-drawer]').focus(); } else { $('#open-jobs').focus(); }
}
async function maintenance() {
  state.view = 'maintenance'; state.selected = null; renderList(); if (location.hash !== '#maintenance') history.pushState(null, '', '#maintenance');
  const main = $('#main'); main.replaceChildren(h('div', { class: 'main__inner' }, h('p', { class: 'muted', text: 'Chargement…' })));
  const m = await api('/api/maintenance');
  const mb = (n) => `${(n / 1e6).toFixed(1)} Mo`;
  const total = m.garbage.reduce((n, g) => n + g.bytes, 0);
  main.replaceChildren(h('div', { class: 'main__inner' },
    h('div', { class: 'home__head' }, h('div', {},
      h('p', { class: 'home__scope' }, h('span', { class: 'label', text: scope ? 'Projet' : 'Tous les projets' }),
        scope ? [h('strong', { text: scope.name }), h('span', { class: 'mono muted', text: scope.repo })] : h('span', { class: 'muted', text: `${projects().length} dépôts suivis` })),
      h('h1', { text: 'Maintenance' }), h('p', { text: 'Espaces de travail et historique. Les sources et les livraisons ne sont jamais touchées.' }))),
    h('div', { class: 'section-title' }, h('span', { class: 'label', text: 'Espaces de travail obsolètes' }), m.garbage.length ? h('span', { class: 'label', text: mb(total) }) : null),
    m.garbage.length ? h('div', { class: 'sheet' }, h('div', { class: 'sheet__cell' }, list(m.garbage, g => [g.reason, h('span', { class: 'muted mono', text: `  ${mb(g.bytes)}` })]),
      h('div', { class: 'decision__actions' }, h('button', { class: 'btn btn--primary', type: 'button', onclick: () => confirmDialog('Nettoyer les espaces de travail',
        `Supprimer ${m.garbage.length} espaces (${mb(total)}). L'historique, les livraisons et les sources ne sont jamais touchés.`,
        async () => { const r = await api('/api/maintenance/gc', { body: { confirm: true } }); toast(`${r.removed} supprimés, ${mb(r.freedBytes)} libérés`); await maintenance(); }, 'Nettoyage terminé') }, 'Nettoyer'))))
      : h('p', { class: 'empty', text: 'Rien à nettoyer.' }),
    h('div', { class: 'section-title' }, h('span', { class: 'label', text: 'Purge de l\'historique — terminal uniquement' })),
    h('div', { class: 'sheet' }, h('div', { class: 'sheet__cell' },
      h('p', { class: 'muted', text: 'La purge efface définitivement des documents et leurs runs. Elle reste une commande de terminal, à relire avant de confirmer.' }),
      m.purge.length ? list(m.purge, p => [h('code', { text: shortId(p.id) }), ` ${p.label} — ${p.reason}`]) : h('p', { text: 'Aucun document à purger au-delà de 30 jours.' }),
      m.kept.length ? h('p', { class: 'muted', text: `Toujours conservées : ${m.kept.map(k => shortId(k.id)).join(', ')} (direction visuelle en vigueur).` }) : null,
      h('div', { class: 'decision__cli' }, h('span', { class: 'label', text: 'terminal' }), h('pre', { text: 'apv2 prune' }), copyButton('apv2 prune'))))));
}

function setFilter(filter) {
  state.filter = filter;
  document.querySelectorAll('[data-filter]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.filter === filter)));
  renderList();
}

// ---------- boot ----------
async function boot() {
  const session = await api('/api/session');
  state.csrf = session.csrf;
  $('#store-path').textContent = session.stateDir;
  state.project = recall(PROJECT_KEY);
  document.querySelectorAll('[data-filter]').forEach(btn => btn.addEventListener('click', () => setFilter(btn.dataset.filter)));
  $('#search').addEventListener('input', (e) => { state.query = e.target.value; renderList(); });
  $('#home-link').addEventListener('click', (e) => { e.preventDefault(); goHome(); });
  $('#open-new').addEventListener('click', newSpecDialog);
  $('#open-maintenance').addEventListener('click', () => maintenance().catch(err => toast(err.message)));
  $('#open-jobs').addEventListener('click', () => setDrawer($('#jobs').hidden));
  $('[data-close-drawer]').addEventListener('click', () => setDrawer(false));
  $('#jobs-backdrop').addEventListener('click', () => setDrawer(false));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#jobs').hidden) setDrawer(false); });
  await Promise.all([loadSpecs(), loadJobs()]);
  connectStream();
  setInterval(() => { if (state.jobs.some(j => j.state === 'running') || !$('#jobs').hidden) loadJobs().catch(() => {}); }, 3000);
  setInterval(() => { if (state.view === 'home') renderHome(); }, 30000);
  const route = () => {
    const hash = location.hash.slice(1);
    if (hash === 'maintenance') { if (state.view !== 'maintenance') maintenance().catch(err => toast(err.message)); }
    else if (hash && state.specs.some(s => s.id === hash)) { if (state.selected !== hash) select(hash); }
    else if (state.view !== 'home') goHome();
    else renderHome();
  };
  window.addEventListener('hashchange', route);
  route();
}
boot().catch(err => {
  $('#main').replaceChildren(h('div', { class: 'main__inner' }, h('p', { class: 'notice sig-bad', text: err.message })));
  $('#live').textContent = 'déconnecté'; $('#live').className = 'live live--off';
});
