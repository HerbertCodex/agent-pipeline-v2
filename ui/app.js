'use strict';
// Agent Pipeline dashboard. Plain DOM: every value coming from the store is set through textContent.

const STATUS = {
  draft: 'Brouillon', approved: 'Approuvée', running: 'En cours', blocked: 'Bloquée', awaiting_review: 'À relire',
  ready: 'Prête', delivered: 'Livrée', closed: 'Clôturée', rejected: 'Rejetée',
};
const RUN_STATE = {
  created: 'créé', preparing: 'préparation', implementing: 'implémentation', candidate: 'candidat', validating: 'contrôles',
  awaiting_review: 'à relire', ready: 'prêt', failed: 'échoué', rejected: 'rejeté', interrupted: 'interrompu',
};
const TERMINAL = new Set(['closed', 'rejected']);

const state = {
  csrf: '', specs: [], filter: 'active', query: '', selected: null, detail: null, events: [], tab: 'overview',
  showTech: false, jobs: [], preview: null,
};

// ---------- helpers ----------
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}
const $ = (sel) => document.querySelector(sel);
const shortId = (id) => (id || '').slice(0, 8);
const rtf = new Intl.RelativeTimeFormat('fr', { numeric: 'auto' });
function ago(ms) {
  if (!ms) return '';
  const s = Math.round((ms - Date.now()) / 1000);
  const abs = Math.abs(s);
  if (abs < 60) return rtf.format(s, 'second');
  if (abs < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(s / 3600), 'hour');
  return rtf.format(Math.round(s / 86400), 'day');
}
const clock = (ms) => new Date(ms).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
function duration(ms) {
  if (ms === undefined || ms === null) return '';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  return s < 90 ? `${s.toFixed(1)} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
}
function badge(value, label) { return h('span', { class: `badge badge--${value}`, text: label || STATUS[value] || value }); }
function toast(message) {
  const el = $('#toast'); el.textContent = message; el.hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { el.hidden = true; }, 3500);
}
function copyButton(value, label = 'Copier') {
  return h('button', { class: 'btn btn--small', type: 'button', onclick: async () => {
    try { await navigator.clipboard.writeText(value); toast('Copié'); } catch { toast('Copie impossible'); }
  } }, label);
}
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

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

// ---------- data ----------
async function loadSpecs() { state.specs = await api('/api/specs'); renderList(); }
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
  source.onopen = () => { live.textContent = 'En direct'; live.className = 'live live--on'; };
  source.onerror = () => { live.textContent = 'Reconnexion…'; live.className = 'live live--off'; };
  source.addEventListener('events', (message) => {
    const events = JSON.parse(message.data);
    refreshList();
    const d = state.detail;
    if (!d) return;
    const runs = new Set([...d.attempts.map(a => a.runId), ...d.validations.map(v => v.runId)]);
    const relevant = events.filter(e => (e.source === 'lifecycle' && e.id === state.selected) || (e.source === 'run' && runs.has(e.id)));
    if (!relevant.length) return;
    state.events.push(...relevant);
    // Activity appends in place (a full re-render would lose the reader's scroll) and re-renders only when the
    // spec's state may have changed; the design tab holds an iframe that a re-render would reload.
    const stateChanged = relevant.some(e => e.source === 'lifecycle' && !e.type.startsWith('process.') && !e.type.startsWith('role.'));
    if (state.tab === 'activity') { appendTimeline(relevant); if (stateChanged) refreshDetail(); return; }
    if (state.tab !== 'design' || stateChanged) refreshDetail();
  });
}

// ---------- list ----------
function renderList() {
  const nav = $('#spec-list');
  const q = state.query.toLowerCase();
  const specs = state.specs.filter(s => (state.filter === 'all' || !TERMINAL.has(s.status))
    && (!q || `${s.title || ''} ${s.id} ${s.repo}`.toLowerCase().includes(q)));
  nav.replaceChildren();
  if (!specs.length) { nav.append(h('p', { class: 'group', text: 'Aucune spec' })); return; }
  const groups = new Map();
  for (const s of specs) { const repo = (s.repo || '').split('/').filter(Boolean).pop() || 'sans dépôt'; if (!groups.has(repo)) groups.set(repo, []); groups.get(repo).push(s); }
  for (const [repo, items] of groups) {
    nav.append(h('div', { class: 'group', text: repo }));
    for (const s of items) {
      nav.append(h('button', { class: 'spec-item', type: 'button', 'aria-current': s.id === state.selected ? 'true' : 'false', onclick: () => select(s.id) },
        h('span', { class: 'spec-item__title', text: s.title || '(brouillon sans contenu)' }),
        h('span', { class: 'spec-item__meta' }, badge(s.status), s.busy ? h('span', { class: 'dot', title: 'Agent au travail' }) : null,
          h('span', { class: 'mono', text: shortId(s.id) }), h('span', { text: ago(s.updatedAt) }))));
    }
  }
}
function select(id) {
  state.selected = id; state.detail = null; state.events = []; state.tab = 'overview'; state.preview = null;
  history.replaceState(null, '', `#${id}`);
  renderList();
  $('#main').replaceChildren(h('p', { class: 'muted', text: 'Chargement…' }));
  loadDetail().catch(err => $('#main').replaceChildren(h('p', { class: 'notice notice--error', text: err.message })));
}

// ---------- detail ----------
function renderDetail() {
  const d = state.detail; const s = d.summary; const c = d.content;
  const main = $('#main');
  const pendingAmendments = d.scopeAmendments.filter(a => a.status === 'pending').length + d.criterionAmendments.filter(a => a.status === 'pending').length;
  const tabs = [
    ['overview', 'Vue d\'ensemble'], ['criteria', `Critères${c ? ` (${c.acceptance.length})` : ''}`], ['tasks', `Tâches${c ? ` (${c.tasks.length})` : ''}`],
    ['activity', 'Activité'], ['qa', 'QA'], ['design', 'Maquettes'], ['amendments', `Amendements${pendingAmendments ? ` · ${pendingAmendments} en attente` : ''}`],
  ];
  const body = h('div', {});
  main.replaceChildren(
    h('div', { class: 'detail-head' },
      h('div', { class: 'detail-head__row' }, badge(s.status), d.busy ? h('span', { class: 'badge badge--running' }, h('span', { class: 'dot' }), 'agent au travail') : null,
        h('span', { class: 'mono', text: s.id }), copyButton(s.id, 'Copier l\'id'), h('span', { text: d.repo })),
      h('h1', { text: s.title || '(brouillon sans contenu)' })),
    d.legacy ? h('p', { class: 'notice notice--warn', text: 'Document antérieur au format actuel : son intégrité ne peut pas être revérifiée. Affiché en lecture seule, sans action possible.' }) : nextCard(d),
    h('div', { class: 'tabs', role: 'tablist' }, tabs.map(([key, label]) => h('button', { type: 'button', role: 'tab', 'aria-selected': state.tab === key ? 'true' : 'false',
      onclick: () => { state.tab = key; renderDetail(); } }, label))),
    body);
  const view = { overview, criteria, tasks, activity, qa, design, amendments }[state.tab];
  view(body, d);
}

function nextCard(d) {
  const s = d.summary; const actions = [];
  const blocked = s.status === 'blocked';
  const code = s.error && s.error.code;
  const questions = (s.questions || []).length + ((s.design && s.design.questions) || []).length;
  if (!d.approval && s.hash && !questions && !TERMINAL.has(s.status)) actions.push(h('button', { class: 'btn btn--primary', type: 'button', onclick: () => approveDialog(d) }, 'Approuver la spec'));
  if (!d.approval && !TERMINAL.has(s.status)) actions.push(h('button', { class: 'btn', type: 'button', onclick: () => refineDialog(d, questions) }, questions ? 'Répondre aux questions' : 'Affiner'));
  if (d.approval && ['approved', 'running', 'blocked'].includes(s.status) && !['SCOPE_AMENDMENT_REQUIRED', 'QA_REJECTED'].includes(code))
    actions.push(h('button', { class: 'btn btn--primary', type: 'button', disabled: d.busy, onclick: () => job(`/api/specs/${s.id}/run`, 'Exécution lancée') }, blocked ? 'Reprendre l\'exécution' : 'Lancer l\'exécution'));
  if (blocked && ['NO_CHANGE', 'TASK_FAILED', 'REPAIR_NO_CHANGE', 'AGENT', 'EXECUTION'].includes(code))
    actions.push(h('button', { class: 'btn', type: 'button', onclick: () => confirmDialog('Autoriser une nouvelle tentative', 'La tâche échouée sera reconstruite à partir de l\'état actuel puis relancée à la prochaine exécution.', () => api(`/api/specs/${s.id}/retry`, { body: { confirm: true } }), 'Tentative autorisée') }, 'Autoriser une nouvelle tentative'));
  if (d.approval && (code === 'STALE_EVIDENCE' || s.status === 'awaiting_review' || s.status === 'ready'))
    actions.push(h('button', { class: 'btn', type: 'button', disabled: d.busy, onclick: () => job(`/api/specs/${s.id}/verify`, 'Revalidation lancée') }, 'Revalider'));
  if (code === 'SCOPE_AMENDMENT_REQUIRED') actions.push(h('button', { class: 'btn btn--primary', type: 'button', onclick: () => { state.tab = 'amendments'; renderDetail(); } }, 'Voir l\'amendement demandé'));
  if (s.status === 'awaiting_review' || code === 'MERGED_BEFORE_REVIEW') actions.push(h('button', { class: 'btn btn--primary', type: 'button', onclick: () => reviewDialog(d) }, 'Enregistrer ma revue'));
  if (s.publication && s.publication.url && !TERMINAL.has(s.status)) actions.push(h('button', { class: 'btn', type: 'button', disabled: d.busy, onclick: () => job(`/api/specs/${s.id}/sync`, 'Synchronisation lancée') }, 'Synchroniser avec la PR'));
  if (!TERMINAL.has(s.status)) actions.push(h('button', { class: 'btn btn--danger', type: 'button', onclick: () => rejectDialog(d) }, 'Rejeter'));
  return h('section', { class: `card ${blocked ? 'card--blocked' : 'card--next'}`, 'aria-label': 'Action suivante' },
    h('h3', { text: blocked ? `Bloquée · ${code}` : 'Action suivante' }),
    blocked && s.error ? h('p', { text: s.error.message }) : null,
    s.hash && !d.approval ? h('p', { class: 'copy' }, h('span', { class: 'muted', text: 'Hash à approuver' }), h('code', { text: s.hash }), copyButton(s.hash)) : null,
    s.publication && s.publication.url ? h('p', {}, 'PR : ', h('a', { href: s.publication.url, target: '_blank', rel: 'noopener noreferrer', text: s.publication.url })) : null,
    actions.length ? h('div', { class: 'card__actions' }, actions) : null,
    h('div', { class: 'command' }, h('pre', { text: s.nextAction }), copyButton(s.nextAction)));
}

function list(items, render) { return h('ul', { class: 'plain' }, items.map(x => h('li', {}, render ? render(x) : x))); }

function overview(root, d) {
  const c = d.content;
  if (!c) { root.append(h('p', { class: 'muted', text: 'Product n\'a pas encore produit de contenu.' }), h('h3', { text: 'Demande' }), h('pre', { text: d.request })); return; }
  const sec = c.security || {};
  root.append(
    h('section', { class: 'card' }, h('h3', { text: 'Problème' }), h('p', { text: c.problem })),
    h('div', { class: 'grid-2' },
      h('section', { class: 'card' }, h('h3', { text: 'Périmètre' }), list(c.scope)),
      h('section', { class: 'card' }, h('h3', { text: 'Hors périmètre' }), (c.outOfScope || []).length ? list(c.outOfScope) : h('p', { class: 'muted', text: '—' }))),
    h('div', { class: 'grid-2' },
      h('section', { class: 'card' }, h('h3', { text: 'Sécurité' }), h('dl', { class: 'kv' },
        h('dt', { text: 'Voie minimale' }), h('dd', { text: c.minimumLane }),
        h('dt', { text: 'Thèmes OWASP' }), h('dd', { text: (sec.owaspTopics || []).join(', ') || '—' }),
        h('dt', { text: 'Exigences' }), h('dd', { text: String((sec.requirements || []).length) }))),
      h('section', { class: 'card' }, h('h3', { text: 'Décisions du projet couvertes' }),
        (c.decisionCoverage || []).length ? list(c.decisionCoverage, x => [h('code', { text: x.decisionId }), ' → ', x.acceptanceIds.join(', ')]) : h('p', { class: 'muted', text: '—' }))),
    d.impactAdvice.length ? h('section', { class: 'card' }, h('h3', { text: 'Tests existants peut-être mal rangés' }),
      h('p', { class: 'muted', text: 'Avertissement, jamais bloquant : ces tests citent un fichier modifié par une tâche mais sont rangés plus tard ou nulle part.' }),
      list(d.impactAdvice, a => [h('code', { text: a.test }), ` — modifié par ${a.changedBy}, rangé dans ${a.assignedTo || 'aucune tâche'} (${a.evidence === 'declared-later' ? 'déclaré plus tard' : 'import direct'})`])) : null,
    (c.questions || []).length ? h('section', { class: 'card' }, h('h3', { text: 'Questions ouvertes' }), list(c.questions, q => q.question)) : null,
    h('details', { class: 'card' }, h('summary', { text: 'Demande complète de l\'opérateur' }), h('pre', { text: d.request })));
}

function criteria(root, d) {
  const c = d.content; if (!c) return root.append(h('p', { class: 'muted', text: '—' }));
  const qa = d.qa && d.qa.report ? new Map(d.qa.report.criteria.map(x => [x.id, x])) : new Map();
  const corrections = new Map(d.criterionAmendments.filter(a => a.status === 'approved').map(a => [a.criterionId, a]));
  const rows = c.acceptance.map(a => {
    const fix = corrections.get(a.id); const q = qa.get(a.id);
    return h('tr', {},
      h('td', {}, h('code', { text: a.id }), fix ? h('div', {}, badge('warn', 'corrigé')) : null),
      h('td', {}, fix ? [h('p', { class: 'diff-old', text: a.description }), h('p', { text: fix.description })] : h('p', { text: a.description }),
        h('p', { class: 'muted', text: `Vérification : ${fix ? fix.verification : a.verification}` })),
      h('td', {}, q ? badge(q.status, q.status === 'pass' ? 'validé' : q.status === 'fail' ? 'échec' : 'inconnu') : h('span', { class: 'muted', text: '—' }),
        q ? h('p', { class: 'muted', text: q.evidence }) : null));
  });
  root.append(h('div', { class: 'table-wrap' }, h('table', { class: 'data' }, h('thead', {}, h('tr', {}, h('th', { text: 'Critère' }), h('th', { text: 'Description' }), h('th', { text: 'QA' }))), h('tbody', {}, rows))));
}

function gates(receipts) {
  return receipts.length ? h('div', { class: 'card__actions' }, receipts.map(r => h('span', { class: `badge badge--${r.status}`, title: r.diagnostic || '' },
    `${r.gateId} · ${r.status === 'cached' ? 'repris' : r.status}${r.durationMs ? ` · ${duration(r.durationMs)}` : ''}`))) : h('span', { class: 'muted', text: 'aucun contrôle' });
}
function tasks(root, d) {
  const c = d.content; if (!c) return root.append(h('p', { class: 'muted', text: '—' }));
  const done = new Set(d.summary.tasks.filter(t => t.done).map(t => t.id));
  for (const t of c.tasks) {
    const attempts = d.attempts.filter(a => a.taskId === t.id);
    const last = attempts[attempts.length - 1];
    root.append(h('section', { class: 'card' },
      h('div', { class: 'detail-head__row' }, done.has(t.id) ? badge('passed', 'terminée') : last ? badge(last.state === 'failed' ? 'failed' : 'running', RUN_STATE[last.state] || last.state) : badge('draft', 'à faire'),
        h('code', { text: t.id }), (t.dependsOn || []).length ? h('span', { text: `après ${t.dependsOn.join(', ')}` }) : null),
      h('h2', { text: t.title }),
      h('p', { class: 'muted', text: `Critères : ${(t.acceptanceIds || []).join(', ')}` }),
      h('details', {}, h('summary', { text: `Chemins autorisés (${(t.allowedPaths || []).length})` }), list(t.allowedPaths || [], p => h('code', { text: p }))),
      attempts.map(a => h('div', { class: 'card card--nested' },
        h('div', { class: 'detail-head__row' }, h('span', { text: a.kind === 'qa-repair' ? 'Réparation QA' : 'Tentative' }), badge(a.state === 'failed' ? 'failed' : a.state === 'ready' || a.state === 'awaiting_review' ? 'passed' : 'running', RUN_STATE[a.state] || a.state), a.lane ? h('span', { text: `voie ${a.lane}` }) : null, h('span', { class: 'mono', text: shortId(a.runId) })),
        gates(a.receipts),
        a.error ? h('p', { class: 'notice notice--error', text: `${a.error.code} : ${a.error.message}` }) : null,
        a.summary ? h('details', {}, h('summary', { text: 'Résumé de l\'agent' }), h('pre', { text: a.summary })) : null)),
    ));
  }
  const repairs = d.attempts.filter(a => a.kind === 'qa-repair');
  if (repairs.length) root.append(h('section', { class: 'card' }, h('h2', { text: 'Réparations QA' }), repairs.map(a => h('div', {},
    h('div', { class: 'detail-head__row' }, badge(a.state === 'failed' ? 'failed' : 'passed', RUN_STATE[a.state] || a.state), h('span', { class: 'mono', text: shortId(a.runId) })),
    gates(a.receipts), a.summary ? h('details', {}, h('summary', { text: 'Résumé de l\'agent' }), h('pre', { text: a.summary })) : null))));
  if (d.validations.length) root.append(h('section', { class: 'card' }, h('h2', { text: 'Validation d\'intégration' }), d.validations.map(v => h('div', {},
    h('div', { class: 'detail-head__row' }, badge(v.state === 'failed' ? 'failed' : 'passed', RUN_STATE[v.state] || v.state), h('span', { class: 'mono', text: shortId(v.runId) })), gates(v.receipts)))));
}

// ---------- activity ----------
function describe(e) {
  const d = e.data || {};
  const role = d.role ? ({ product: 'Product', qa: 'QA', setup: 'Setup', implementer: 'Implementer' })[d.role] || d.role : '';
  const map = {
    'spec.created': 'Spec créée', 'product.refinement_requested': 'Affinage demandé', 'product.proposed': 'Proposition Product prête',
    'design.proposed': 'Maquette prête', 'spec.approved': `Spec approuvée par ${d.approval ? d.approval.reviewer : ''}`, 'spec.rejected': 'Spec rejetée',
    'role.started': `${role} au travail${d.mode === 'design-proposal' ? ' (maquette)' : ''}`, 'role.finished': `${role} a terminé${d.timingsMs ? ` en ${duration(d.timingsMs.total)}` : ''}`,
    'role.repair_requested': `${role} : réparation de la réponse demandée`, 'workflow.session_started': 'Exécution démarrée', 'workflow.session_finished': 'Exécution arrêtée',
    'workflow.task_started': `Tâche ${d.taskId || ''} démarrée`, 'workflow.task_completed': `Tâche ${d.taskId || ''} terminée`, 'workflow.blocked': `Bloquée : ${d.error ? d.error.code : ''}`,
    'workflow.qa_repair_started': `Réparation QA n° ${d.number || ''} lancée`, 'workflow.review_ready': 'Prête pour la revue', 'workflow.retry_authorized': 'Nouvelle tentative autorisée',
    'integration.created': 'Validation d\'intégration créée', 'integration.adopted': 'Preuve de la tâche adoptée (contrôles non rejoués)', 'integration.adoption_refused': `Adoption refusée : ${d.reason || ''}`,
    'integration.reused': 'Validation de la tâche réutilisée', 'qa.completed': `QA : ${d.qa && d.qa.report ? d.qa.report.verdict : ''}`, 'scope.amendment_requested': 'Amendement de périmètre demandé',
    'scope.amendment_approved': 'Amendement de périmètre approuvé', 'criterion.amendment_proposed': `Correction du critère ${d.criterionId || ''} proposée`,
    'criterion.amendment_approved': `Correction du critère ${d.criterionId || ''} approuvée`, 'spec.reviewed': `Revue enregistrée par ${d.reviewer || ''}`, 'spec.closed': 'Spec clôturée',
    'publication.pr_created': 'PR créée', 'publication.merged_before_review': 'PR fusionnée avant la revue',
    'agent.started': 'Implementer au travail', 'agent.completed': 'Implementer a terminé', 'candidate.created': 'Candidat créé', 'validation.started': `Contrôles lancés (${(d.gateIds || []).join(', ')})`,
    'gate.started': `Contrôle ${d.gateId || ''} lancé`, 'gate.finished': `Contrôle ${d.gateId || ''} : ${d.status || ''}${d.durationMs ? ` (${duration(d.durationMs)})` : ''}`,
    'validation.completed': 'Contrôles réussis', 'validation.failed': 'Contrôles en échec', 'validation.adopted': 'Reçus adoptés', 'run.failed': `Run en échec : ${d.error ? d.error.code : ''}`,
    'agent.repair_no_change': 'Réparation sans changement',
  };
  return map[e.type];
}
function timelineItem(e) {
  const label = describe(e);
  if (!label && !state.showTech) return null;
  return h('li', {}, h('time', { text: clock(e.at) }), h('span', { class: label ? '' : 'tech' },
    label || e.type, e.source === 'run' ? h('span', { class: 'muted mono', text: `  run ${shortId(e.id)}` }) : null));
}
function activity(root) {
  const toggle = h('label', {}, h('input', { type: 'checkbox', checked: state.showTech, onchange: (ev) => { state.showTech = ev.target.checked; renderDetail(); } }), ' Détails techniques');
  const ol = h('ol', { class: 'timeline', id: 'timeline' });
  root.append(h('div', { class: 'timeline__tools' }, toggle, h('span', { class: 'muted', text: 'Mise à jour en direct' })), ol);
  appendTimeline(state.events, true);
}
function appendTimeline(events, initial) {
  const ol = document.getElementById('timeline'); if (!ol) return;
  const atBottom = initial || ol.getBoundingClientRect().bottom <= window.innerHeight + 80;
  for (const e of events) { const li = timelineItem(e); if (li) ol.append(li); }
  if (atBottom) ol.lastElementChild?.scrollIntoView({ block: 'end' });
}

function qa(root, d) {
  if (!d.qa) { root.append(h('p', { class: 'muted', text: 'Pas encore de rapport QA pour le candidat actuel.' })); return; }
  const r = d.qa.report;
  root.append(
    h('section', { class: 'card' }, h('div', { class: 'detail-head__row' }, badge(r.verdict === 'pass' ? 'pass' : 'fail', r.verdict === 'pass' ? 'validé' : 'changements demandés'), h('span', { class: 'mono', text: `candidat ${shortId(r.candidateSha)}` })), h('p', { text: r.summary })),
    (r.findings || []).length ? h('section', { class: 'card' }, h('h3', { text: 'Constats' }), list(r.findings, f => [badge(f.severity === 'minor' ? 'warn' : 'fail', f.severity), ' ', f.path ? h('code', { text: f.path }) : null, ' ', f.description])) : null,
    (r.observations || []).length ? h('section', { class: 'card' }, h('h3', { text: 'Observations' }), list(r.observations)) : null,
    (r.securityChecks || []).length ? h('section', { class: 'card' }, h('h3', { text: 'Exigences de sécurité' }), list(r.securityChecks, x => [badge(x.status), ' ', h('code', { text: x.requirementId }), ' ', x.evidence])) : null);
}

function design(root, d) {
  const g = d.design;
  if (!g) { root.append(h('p', { class: 'muted', text: 'Pas de maquette pour cette spec.' })); return; }
  const screens = g.screens.filter(x => x.available);
  if (!state.preview && screens.length) state.preview = screens[0].file;
  const src = state.preview ? `/api/specs/${d.summary.id}/design/${encodeURIComponent(state.preview)}` : null;
  root.append(
    h('section', { class: 'card' }, h('p', { text: g.summary }),
      g.reusedFrom ? h('p', { class: 'muted', text: `Prolonge la direction de la spec ${shortId(g.reusedFrom)}` }) : null,
      g.loadedStylesheets.length ? h('p', { class: 'muted', text: `Feuilles du projet chargées : ${g.loadedStylesheets.map(x => x.path).join(', ')}` }) : null,
      g.questions.length ? h('div', { class: 'notice notice--warn' }, 'Questions de la maquette : ', list(g.questions, q => q.question)) : null),
    h('div', { class: 'previews' },
      h('div', {}, g.screens.map(x => h('button', { class: 'spec-item', type: 'button', disabled: !x.available, 'aria-current': x.file === state.preview ? 'true' : 'false',
        onclick: () => { state.preview = x.file; renderDetail(); } }, h('span', { class: 'spec-item__title', text: x.title }), h('span', { class: 'spec-item__meta', text: x.available ? x.purpose : 'fichier supprimé' })))),
      src ? h('div', {}, h('iframe', { src, sandbox: '', title: 'Aperçu de la maquette', loading: 'lazy' }),
        h('p', {}, h('a', { href: src, target: '_blank', rel: 'noopener noreferrer', text: 'Ouvrir dans un onglet' }))) : h('p', { class: 'muted', text: 'Aucun aperçu disponible.' })));
}

function amendments(root, d) {
  const scope = d.scopeAmendments; const crit = d.criterionAmendments;
  if (!scope.length && !crit.length) { root.append(h('p', { class: 'muted', text: 'Aucun amendement.' })); return; }
  for (const a of scope) root.append(h('section', { class: 'card' },
    h('div', { class: 'detail-head__row' }, badge(a.status === 'pending' ? 'pending' : 'passed', a.status === 'pending' ? 'en attente' : 'approuvé'), h('span', { text: `Périmètre · tâche ${a.taskId}` })),
    h('p', { text: a.reason }), list(a.paths, p => h('code', { text: p })),
    a.status === 'pending' ? h('div', { class: 'card__actions' }, h('button', { class: 'btn btn--primary', type: 'button', onclick: () => noteDialog('Approuver l\'amendement de périmètre',
      `Autoriser la tâche ${a.taskId} à modifier : ${a.paths.join(', ')}`, (note) => api(`/api/specs/${d.summary.id}/scope-amendments/${a.id}/approve`, { body: { note } }), 'Amendement approuvé') }, 'Approuver')) : h('p', { class: 'muted', text: `par ${a.reviewer} — ${a.note}` })));
  for (const a of crit) root.append(h('section', { class: 'card' },
    h('div', { class: 'detail-head__row' }, badge(a.status === 'pending' ? 'pending' : 'passed', a.status === 'pending' ? 'en attente' : 'approuvé'), h('span', { text: `Critère ${a.criterionId}` })),
    h('p', { class: 'diff-old', text: a.previous.description }), h('p', { text: a.description }), h('p', { class: 'muted', text: `Motif : ${a.reason}` }),
    (a.requirements || []).length ? list(a.requirements, r => [h('code', { text: r.id }), ' : ', h('span', { class: 'diff-old', text: r.previous }), ' → ', r.verification]) : null,
    a.status === 'pending' ? h('div', { class: 'card__actions' }, h('button', { class: 'btn btn--primary', type: 'button', onclick: () => noteDialog('Approuver la correction du critère',
      `Hash : ${a.hash}`, (note) => api(`/api/specs/${d.summary.id}/criterion-amendments/${a.id}/approve`, { body: { hash: a.hash, note } }), 'Correction approuvée') }, 'Approuver')) : h('p', { class: 'muted', text: `par ${a.reviewer} — ${a.note}` })));
}

// ---------- dialogs ----------
function openDialog(title, content, onConfirm, confirmLabel = 'Confirmer') {
  const dialog = $('#dialog');
  $('#dialog-title').textContent = title;
  $('#dialog-body').replaceChildren(...[content].flat());
  const error = $('#dialog-error'); error.hidden = true;
  const confirm = $('#dialog-confirm'); confirm.textContent = confirmLabel; confirm.disabled = false;
  confirm.onclick = async () => {
    confirm.disabled = true; error.hidden = true;
    try { await onConfirm(); dialog.close(); await Promise.all([loadSpecs(), loadDetail(), loadJobs()]); }
    catch (err) { error.textContent = err.message; error.hidden = false; confirm.disabled = false; }
  };
  $('#dialog-cancel').onclick = () => dialog.close();
  dialog.showModal();
}
function field(label, input) { return h('label', { class: 'field' }, h('span', { text: label }), input); }
function noteField() { return h('textarea', { id: 'dlg-note', required: true, minlength: '10', placeholder: 'Pourquoi vous approuvez (au moins 10 caractères)' }); }
const noteValue = () => document.getElementById('dlg-note').value;
function noteDialog(title, text, send, done) {
  openDialog(title, [h('p', { text }), field('Note', noteField())], async () => { await send(noteValue()); toast(done); });
}
function confirmDialog(title, text, send, done) { openDialog(title, h('p', { text }), async () => { await send(); toast(done); }); }
function approveDialog(d) {
  openDialog('Approuver la spec', [
    h('p', { text: 'Vous approuvez exactement ce contenu, spec et maquette comprises. L\'implémentation pourra démarrer.' }),
    h('p', { class: 'copy' }, h('span', { class: 'muted', text: 'Hash' }), h('code', { text: d.summary.hash })),
    field('Note', noteField())], async () => {
    await api(`/api/specs/${d.summary.id}/approve`, { body: { hash: d.summary.hash, note: noteValue() } }); toast('Spec approuvée');
  }, 'Approuver');
}
function reviewDialog(d) {
  const sha = d.summary.candidateSha;
  openDialog('Enregistrer ma revue', [
    h('p', { text: 'Vous approuvez le candidat exact ci-dessous, après l\'avoir relu.' }),
    h('p', { class: 'copy' }, h('span', { class: 'muted', text: 'Candidat' }), h('code', { text: sha })),
    d.review ? h('p', { class: 'muted', text: `Dossier de revue : ${d.review.directory}` }) : null,
    field('Note', noteField())], async () => {
    await api(`/api/specs/${d.summary.id}/review`, { body: { sha, note: noteValue() } }); toast('Revue enregistrée');
  }, 'Approuver le candidat');
}
function rejectDialog(d) {
  openDialog('Rejeter la spec', [h('p', { text: 'La spec ne pourra plus être exécutée. Son historique reste consultable.' }), field('Motif', noteField())], async () => {
    await api(`/api/specs/${d.summary.id}/reject`, { body: { note: noteValue() } }); toast('Spec rejetée');
  }, 'Rejeter');
}
function refineDialog(d, questions) {
  const textarea = h('textarea', { placeholder: questions ? 'Vos réponses aux questions, avec vos décisions exactes' : 'Ce qu\'il faut changer dans la spec' });
  const content = [];
  if (questions) content.push(list([...(d.summary.questions || []), ...((d.summary.design && d.summary.design.questions) || [])], q => q.question));
  content.push(field('Réponse', textarea));
  openDialog(questions ? 'Répondre aux questions' : 'Affiner la spec', content, async () => {
    await api(`/api/specs/${d.summary.id}/refine`, { body: { request: textarea.value } }); toast('Affinage lancé : Product retravaille la spec');
  }, 'Lancer l\'affinage');
}
function newSpecDialog() {
  const repos = [...new Set(state.specs.map(s => s.repo).filter(Boolean))];
  const repo = h('input', { type: 'text', value: repos[0] || '', list: 'repos', spellcheck: 'false' });
  const request = h('textarea', { placeholder: 'Ce que vous voulez obtenir, avec vos décisions et ce qui est hors périmètre' });
  openDialog('Nouvelle spec', [
    field('Dépôt', repo), h('datalist', { id: 'repos' }, repos.map(r => h('option', { value: r }))), field('Demande', request),
    h('p', { class: 'muted', text: 'Product rédige un brouillon ; rien n\'est exécuté avant votre approbation.' })], async () => {
    await api('/api/specs', { body: { repo: repo.value, request: request.value } }); toast('Brouillon en préparation');
  }, 'Lancer le brouillon');
}
async function job(path, done) {
  try { await api(path, { body: {} }); toast(done); await Promise.all([loadJobs(), loadDetail()]); }
  catch (err) { toast(err.message); }
}

// ---------- jobs & maintenance ----------
function renderJobs() {
  const body = $('#jobs-body');
  body.replaceChildren();
  if (!state.jobs.length) { body.append(h('p', { class: 'muted', text: 'Aucune opération lancée depuis ce tableau de bord.' })); return; }
  for (const j of state.jobs) body.append(h('div', { class: 'job' },
    h('div', { class: 'detail-head__row' }, badge(j.state, { running: 'en cours', succeeded: 'terminée', failed: 'échec' }[j.state]), j.state === 'running' ? h('span', { class: 'dot' }) : null,
      h('strong', { text: j.label }), j.specId ? h('button', { class: 'btn btn--small', type: 'button', onclick: () => select(j.specId) }, shortId(j.specId)) : null,
      h('span', { text: ago(j.startedAt) }), j.finishedAt ? h('span', { text: `durée ${duration(j.finishedAt - j.startedAt)}` }) : null),
    j.tail ? h('pre', { text: j.tail }) : null));
}
async function maintenance() {
  state.selected = null; renderList(); history.replaceState(null, '', '#maintenance');
  const main = $('#main'); main.replaceChildren(h('p', { class: 'muted', text: 'Chargement…' }));
  const m = await api('/api/maintenance');
  const mb = (n) => `${(n / 1e6).toFixed(1)} Mo`;
  main.replaceChildren(
    h('h1', { text: 'Maintenance' }),
    h('section', { class: 'card' }, h('h3', { text: 'Espaces de travail obsolètes' }),
      m.garbage.length ? [list(m.garbage, g => [g.reason, h('span', { class: 'muted', text: ` · ${mb(g.bytes)}` })]),
        h('div', { class: 'card__actions' }, h('button', { class: 'btn btn--primary', type: 'button', onclick: () => confirmDialog('Nettoyer les espaces de travail',
          `Supprimer ${m.garbage.length} espaces (${mb(m.garbage.reduce((n, g) => n + g.bytes, 0))}). L'historique, les livraisons et les sources ne sont jamais touchés.`,
          async () => { const r = await api('/api/maintenance/gc', { body: { confirm: true } }); toast(`${r.removed} supprimés, ${mb(r.freedBytes)} libérés`); await maintenance(); }, 'Nettoyage terminé') }, 'Nettoyer'))]
        : h('p', { class: 'muted', text: 'Rien à nettoyer.' })),
    h('section', { class: 'card' }, h('h3', { text: 'Purge de l\'historique (terminal uniquement)' }),
      h('p', { class: 'muted', text: 'La purge efface définitivement des documents et leurs runs : elle reste une commande de terminal.' }),
      m.purge.length ? list(m.purge, p => [h('code', { text: shortId(p.id) }), ` ${p.label} — ${p.reason}`]) : h('p', { class: 'muted', text: 'Aucun document à purger (au-delà de 30 jours).' }),
      m.kept.length ? h('p', { class: 'muted', text: `Toujours conservées : ${m.kept.map(k => shortId(k.id)).join(', ')} (direction visuelle en vigueur)` }) : null,
      h('div', { class: 'command' }, h('pre', { text: 'apv2 prune' }), copyButton('apv2 prune'))));
}

// ---------- boot ----------
async function boot() {
  const session = await api('/api/session');
  state.csrf = session.csrf;
  document.querySelectorAll('[data-filter]').forEach(btn => btn.addEventListener('click', () => {
    state.filter = btn.dataset.filter;
    document.querySelectorAll('[data-filter]').forEach(b => b.setAttribute('aria-pressed', String(b === btn)));
    renderList();
  }));
  $('#search').addEventListener('input', (e) => { state.query = e.target.value; renderList(); });
  $('#open-new').addEventListener('click', newSpecDialog);
  $('#open-maintenance').addEventListener('click', () => maintenance().catch(err => toast(err.message)));
  const setDrawer = (open) => { $('#jobs').hidden = !open; $('#jobs-backdrop').hidden = !open; if (open) { renderJobs(); $('[data-close-drawer]').focus(); } };
  $('#open-jobs').addEventListener('click', () => setDrawer($('#jobs').hidden));
  $('[data-close-drawer]').addEventListener('click', () => setDrawer(false));
  $('#jobs-backdrop').addEventListener('click', () => setDrawer(false));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#jobs').hidden) setDrawer(false); });
  await Promise.all([loadSpecs(), loadJobs()]);
  connectStream();
  setInterval(() => { if (state.jobs.some(j => j.state === 'running') || !$('#jobs').hidden) loadJobs().catch(() => {}); }, 3000);
  const hash = location.hash.slice(1);
  if (hash === 'maintenance') maintenance();
  else if (hash && state.specs.some(s => s.id === hash)) select(hash);
}
boot().catch(err => {
  $('#main').replaceChildren(h('p', { class: 'notice notice--error', text: err.message }));
  $('#live').textContent = 'Déconnecté'; $('#live').className = 'live live--off';
});
