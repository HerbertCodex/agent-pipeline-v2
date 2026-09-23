import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

/**
 * Loads a plugin workflow the way the Claude Code runtime documents it: `export const meta = {...}`
 * first, as a pure literal, then a plain JavaScript body with top-level await that uses agent(),
 * parallel(), pipeline(), phase(), log() and the `args` global.
 */
function load(file) {
  const text = readFileSync(join(root, 'workflows', file), 'utf8');
  const match = /^export const meta = (\{[\s\S]*?\n\})\n/.exec(text);
  assert.ok(match, `${file}: export const meta must be the first statement`);
  assert.ok(!/\$\{|\.\.\.|\b[a-z]\w*\(/.test(match[1].replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, "''")), `${file}: meta must be a pure literal`);
  const meta = new Function(`return ${match[1]}`)();
  const body = text.slice(match[0].length);
  assert.ok(!/\bimport\s*\(|\bimport\s+[\w{*]/.test(body), `${file}: no module loading`);
  assert.ok(!/Date\.now\(|Math\.random\(|new Date\(\)/.test(body), `${file}: no clock or randomness (resume)`);
  return { meta, text, run: new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', body) };
}

/** Minimal stand-in for the runtime: records every agent() call and answers with `answer`. */
function runtime(answer) {
  const calls = [];
  const logs = [];
  const phases = [];
  const agent = async (prompt, opts = {}) => { calls.push({ prompt, opts }); return answer(prompt, opts, calls.length - 1); };
  const parallel = async thunks => Promise.all(thunks.map(t => t().catch(() => null)));
  const pipeline = async (items, ...stages) => Promise.all(items.map(async (item, index) => {
    let value = item;
    try { for (const stage of stages) value = await stage(value, item, index); return value; } catch { return null; }
  }));
  return { calls, logs, phases, hooks: [agent, parallel, pipeline, t => phases.push(t), m => logs.push(m)] };
}

const WAVE_ARGS = {
  specId: 'relances', specFile: '.apv/specs/relances.json', base: 'apv/relances', baseCommit: 'a'.repeat(40),
  brief: '.apv/brief.md', notes: '.apv/state/notes-relances-vague-1.md', wave: 1,
  tasks: [{ id: 'T2', branch: 'apv/relances-T2' }, { id: 'T3', branch: 'apv/relances-T3', resume: 'termine depuis le wip abc1234' }],
};

test('the plugin ships exactly the two documented workflows, with literal meta blocks', () => {
  const files = readdirSync(join(root, 'workflows')).sort();
  assert.deepEqual(files, ['revues.js', 'vague.js']);
  for (const file of files) {
    const { meta, text } = load(file);
    assert.equal(meta.name, file.slice(0, -3));
    assert.ok(meta.description.length > 40 && meta.description.length <= 400, file);
    assert.ok(Array.isArray(meta.phases) && meta.phases.length >= 1, file);
    for (const p of meta.phases) assert.ok(text.includes(`phase('${p.title}')`), `${file}: phase ${p.title} is used`);
    assert.ok(!/[–—]/.test(text), `${file} contains an em or en dash`);
  }
});

test('vague: one isolated apv:implementer per task, with the start and scope instructions', async () => {
  const { run } = load('vague.js');
  const rt = runtime((prompt, opts) => ({ taskId: opts.label, status: 'done', branch: `apv/relances-${opts.label}`, worktree: '/tmp/w', commit: 'b'.repeat(40),
    checks: [], scopeCheck: 'in', outOfScopeFiles: [], summary: 'ok', openPoints: [] }));
  const result = await run(...rt.hooks, WAVE_ARGS);
  assert.equal(rt.calls.length, 2);
  for (const [i, call] of rt.calls.entries()) {
    const task = WAVE_ARGS.tasks[i];
    assert.equal(call.opts.agentType, 'apv:implementer');
    assert.equal(call.opts.isolation, 'worktree');
    assert.equal(call.opts.label, task.id);
    assert.deepEqual(call.opts.schema.properties.status.enum, ['done', 'failed', 'wip']);
    assert.ok(call.prompt.includes(`git switch -c ${task.branch} ${WAVE_ARGS.baseCommit}`), 'creates its branch from the exact base');
    assert.ok(call.prompt.includes(`git switch ${task.branch}\``), 'resumes an existing branch');
    assert.ok(call.prompt.includes(`{"spec": "${WAVE_ARGS.specFile}", "task": "${task.id}"}`), 'task marker');
    assert.ok(call.prompt.includes(`scope check --spec ${WAVE_ARGS.specFile} --task ${task.id} --base ${WAVE_ARGS.baseCommit}`), 'scope check at the end');
    assert.ok(call.prompt.includes('.apv/brief.md') && call.prompt.includes('notes-relances-vague-1.md'));
    assert.match(call.prompt, /Ne pousse pas, ne fusionne pas/);
    assert.ok(call.prompt.includes('node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js"'), 'the bundled tool, not an interpolated value');
    assert.ok(call.prompt.includes(`gates run --stage task --base ${WAVE_ARGS.baseCommit}\``), 'task checks only, from the exact base');
    assert.match(call.prompt, /seulement les fichiers e2e que tu as créés ou modifiés, sous `node "\$\{CLAUDE_PLUGIN_ROOT\}\/dist\/cli\.js" lock run e2e -- /);
    assert.match(call.prompt, /réservés à la suite complète » ne sont ni lancés ni annoncés verts/);
    assert.doesNotMatch(call.prompt, /Tous les contrôles de la consigne commune/);
  }
  assert.ok(rt.calls[1].prompt.includes('termine depuis le wip abc1234'));
  assert.equal(result.reports.length, 2);
  assert.deepEqual(result.withoutReport, []);
  assert.equal(result.baseCommit, WAVE_ARGS.baseCommit);
});

test('vague: a stopped agent is reported, never hidden', async () => {
  const { run } = load('vague.js');
  const rt = runtime((prompt, opts) => opts.label === 'T3' ? null : { taskId: 'T2', status: 'done' });
  const result = await run(...rt.hooks, WAVE_ARGS);
  assert.deepEqual(result.withoutReport, ['T3']);
  assert.ok(rt.logs.some(l => l.includes('T3')));
});

test('vague: refuses to start without its inputs', async () => {
  const { run } = load('vague.js');
  await assert.rejects(run(...runtime(() => null).hooks, undefined), /\/apv:run/);
  await assert.rejects(run(...runtime(() => null).hooks, { ...WAVE_ARGS, baseCommit: '' }), /baseCommit/);
  await assert.rejects(run(...runtime(() => null).hooks, { ...WAVE_ARGS, tasks: [{ id: 'T1' }] }), /branche/);
});

const REVIEW_ARGS = {
  commit: 'c'.repeat(40), branch: 'apv/relances', specFile: '.apv/specs/relances.json', common: 'écarts assumés : aucun',
  reviews: [
    { domain: 'securite', copy: '/tmp/revues/securite', context: 'port 5301' },
    { domain: 'fidelite', copy: '/tmp/revues/fidelite' },
    { domain: 'donnees', copy: '/tmp/revues/donnees' },
    { domain: 'rgpd', copy: '/tmp/revues/rgpd' },
  ],
};
const finding = (severity, title, location) => ({ severity, required: severity !== 'info', title, location, evidence: 'preuve', fix: 'corriger' });

test('revues: read-only reviewers in parallel on their own copy, then one deduplication pass', async () => {
  const { run } = load('revues.js');
  const byDomain = {
    securite: [finding('eleve', 'IDOR sur les relances', 'src/routes/relances/+page.server.ts:40')],
    fidelite: [finding('moyen', 'Texte modifié', 'écran relances, 390, clair')],
    donnees: [finding('moyen', 'Pas de filtre user_id', 'src/routes/relances/+page.server.ts:40'), finding('faible', 'Index manquant', 'supabase/migrations/1.sql')],
    rgpd: [],
  };
  const rt = runtime((prompt, opts) => {
    if (opts.label === 'dédoublonnage') return { groups: [{ ids: ['S1', 'D1'], reason: 'même requête sans filtre' }, { ids: ['F1'], reason: '' }] };
    return { domain: opts.label, commit: REVIEW_ARGS.commit, findings: byDomain[opts.label], notVerified: [], cleanup: 'fait', summary: 'ok' };
  });
  const result = await run(...rt.hooks, REVIEW_ARGS);
  const reviewers = rt.calls.filter(c => c.opts.phase === 'Revues');
  assert.deepEqual(reviewers.map(c => c.opts.agentType), ['apv:qa-securite', 'apv:qa-fidelite', 'apv:architecte-donnees', 'apv:dpo']);
  for (const [i, call] of reviewers.entries()) {
    assert.equal(call.opts.isolation, undefined, 'reviewers work on the detached copy they are given');
    assert.ok(call.prompt.includes(REVIEW_ARGS.reviews[i].copy));
    assert.ok(call.prompt.includes(REVIEW_ARGS.commit));
    assert.match(call.prompt, /Lecture seule/);
    assert.match(call.prompt, /Ne relance ni la suite complète ni Playwright, sauf besoin précis de ton domaine/);
    assert.match(call.prompt, /« non vérifié »/);
  }
  assert.ok(reviewers[0].prompt.includes('port 5301'));
  assert.equal(rt.calls.length, 5);
  // D2 was forgotten by the deduplication agent: it is kept on its own, and said.
  assert.deepEqual(result.findings.map(f => f.ids), [['S1', 'D1'], ['F1'], ['D2']]);
  assert.deepEqual(result.findings[0].domains, ['securite', 'donnees']);
  assert.equal(result.findings[0].severity, 'eleve');
  assert.ok(rt.logs.some(l => l.includes('D2')));
  assert.equal(result.raw.length, 4);
  assert.deepEqual(result.incomplete, []);
});

test('revues: a single review needs no consolidation; a lost reviewer is listed', async () => {
  const { run } = load('revues.js');
  const rt = runtime((prompt, opts) => opts.label === 'fidelite' ? null
    : { domain: opts.label, commit: 'x', findings: [finding('faible', 'a', 'b'), finding('info', 'c', 'd')], notVerified: ['ZAP : Docker absent'], cleanup: 'fait', summary: 'ok' });
  const result = await run(...rt.hooks, { ...REVIEW_ARGS, reviews: REVIEW_ARGS.reviews.slice(0, 2) });
  assert.equal(rt.calls.length, 2, 'no deduplication agent with one report');
  assert.deepEqual(result.incomplete, ['fidelite']);
  assert.deepEqual(result.findings.map(f => f.id), ['S1', 'S2']);
  assert.deepEqual(result.reports[0].notVerified, ['ZAP : Docker absent']);
});

test('revues: refuses unknown domains, duplicates and missing copies', async () => {
  const { run } = load('revues.js');
  const hooks = () => runtime(() => null).hooks;
  await assert.rejects(run(...hooks(), undefined), /\/apv:review/);
  await assert.rejects(run(...hooks(), { ...REVIEW_ARGS, reviews: [{ domain: 'perf', copy: '/tmp/x' }] }), /inconnu/);
  await assert.rejects(run(...hooks(), { ...REVIEW_ARGS, reviews: [{ domain: 'rgpd' }] }), /copie isolée/);
  await assert.rejects(run(...hooks(), { ...REVIEW_ARGS, reviews: [{ domain: 'rgpd', copy: '/a' }, { domain: 'rgpd', copy: '/b' }] }), /double/);
});
