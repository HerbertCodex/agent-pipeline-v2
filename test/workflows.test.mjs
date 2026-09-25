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
  const rt = runtime((prompt, opts) => ({ taskId: opts.label, status: 'done', confidence: 'prouve', evidence: 'apv gates run --stage task : 12 verts', branch: `apv/relances-${opts.label}`,
    worktree: '/tmp/w', commit: 'b'.repeat(40), checks: [], scopeCheck: 'in', outOfScopeFiles: [], summary: 'ok', openPoints: [] }));
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
    assert.match(call.prompt, /contrôle « ciblé »/);
    assert.match(call.prompt, /`<fichier>:<ligne>` ou `-g "<titre>"`\), `--repeat-each` 20 au plus/);
    assert.doesNotMatch(call.prompt, /Tous les contrôles de la consigne commune/);
  }
  assert.ok(rt.calls[1].prompt.includes('termine depuis le wip abc1234'));
  assert.equal(result.reports.length, 2);
  assert.deepEqual(result.withoutReport, []);
  assert.deepEqual(result.refused, []);
  assert.deepEqual(result.escalation, { verify: [], operator: [] });
  assert.equal(result.baseCommit, WAVE_ARGS.baseCommit);
});

test('vague: a stopped agent is reported, never hidden', async () => {
  const { run } = load('vague.js');
  const rt = runtime((prompt, opts) => opts.label === 'T3' ? null : { taskId: 'T2', status: 'done', confidence: 'prouve', evidence: 'sortie' });
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
const finding = (severity, title, location, confidence = 'prouve') => ({ severity, required: severity !== 'info', title, location, confidence, evidence: 'preuve', fix: 'corriger' });

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

test('revues: the concurrence audit runs alone, never by default, and returns its inventory', async () => {
  const { run, meta } = load('revues.js');
  assert.match(meta.description, /concurrence sur demande/);
  const path = { location: 'src/orders.ts:12', family: '4.1', invariant: 'stock >= 0', protection: 'aucune', status: 'non_conforme', confidence: 'probable', proof: 'lu : update sans condition, aucun test' };
  const rt = runtime((prompt, opts) => ({ domain: opts.label, commit: 'x', findings: [finding('eleve', 'Stock décrémenté dans l\'application', path.location)],
    notVerified: [], cleanup: 'fait', summary: 'ok', paths: [path] }));
  const result = await run(...rt.hooks, { commit: 'c'.repeat(40), reviews: [{ domain: 'concurrence', copy: '/tmp/revues/concurrence' }] });
  assert.equal(rt.calls.length, 1);
  const [call] = rt.calls;
  assert.equal(call.opts.agentType, 'apv:architecte-donnees');
  assert.ok(call.opts.schema.required.includes('paths'), 'the inventory is required');
  assert.deepEqual(call.opts.schema.properties.paths.items.properties.status.enum, ['conforme', 'non_conforme', 'inconnu']);
  assert.match(call.prompt, /references\/concurrence\.md/);
  assert.match(call.prompt, /TOUT le code du commit/);
  assert.match(call.prompt, /Lecture seule/);
  assert.deepEqual(result.findings.map(f => f.id), ['C1']);
  assert.deepEqual(result.reports[0].paths, [path]);

  // The four default domains keep their schema and prompt: no inventory asked, none reported.
  const plain = runtime((prompt, opts) => ({ domain: opts.label, commit: 'x', findings: [], notVerified: [], cleanup: 'fait', summary: 'ok' }));
  const other = await run(...plain.hooks, REVIEW_ARGS);
  for (const c of plain.calls) {
    assert.ok(!c.opts.schema.required.includes('paths'), c.opts.label);
    assert.doesNotMatch(c.prompt, /concurrence\.md/);
  }
  assert.ok(other.reports.every(r => !('paths' in r)));
});

// Calibrated confidence: a report says how sure it is, and why (docs/CONFIANCE.md).
const LEVELS = ['prouve', 'probable', 'suppose'];
const task = (id, extra = {}) => ({ taskId: id, status: 'done', confidence: 'prouve', evidence: 'test rouge puis vert : npm test -- relances (1 échec, puis 14 réussis)',
  branch: `apv/relances-${id}`, worktree: '/tmp/w', commit: 'b'.repeat(40), checks: [], scopeCheck: 'in', outOfScopeFiles: [], summary: 'ok', openPoints: [], ...extra });

test('vague: the report schema requires a confidence level and its evidence, and the prompt defines the levels', async () => {
  const { run } = load('vague.js');
  const rt = runtime((prompt, opts) => task(opts.label));
  await run(...rt.hooks, WAVE_ARGS);
  const { schema } = rt.calls[0].opts;
  for (const field of ['confidence', 'evidence']) assert.ok(schema.required.includes(field), field);
  assert.deepEqual(schema.properties.confidence.enum, LEVELS);
  assert.equal(schema.properties.evidence.minLength, 1);
  const prompt = rt.calls[0].prompt;
  assert.match(prompt, /`prouve` = preuve reproductible jointe/);
  assert.match(prompt, /test qui échoue avant et passe après/);
  assert.match(prompt, /`probable` = lecture du code ou raisonnement vérifiable sans exécution/);
  assert.match(prompt, /`suppose` = hypothèse/);
  assert.match(prompt, /cause observée[^\n]*n'a pas été reproduite reste au mieux `probable`/);
});

test('vague: a report without a level, with an unknown level or a proof-less `prouve` is refused, never counted', async () => {
  const { run } = load('vague.js');
  const tasks = ['T1', 'T2', 'T3', 'T4', 'T5', 'T6'].map(id => ({ id, branch: `apv/relances-${id}` }));
  const answers = {
    T1: task('T1'),
    T2: task('T2', { confidence: undefined }),
    T3: task('T3', { confidence: 'certain' }),
    T4: task('T4', { evidence: '   ' }),
    T5: task('T5', { confidence: 'probable', evidence: 'lu : src/relances.ts:40 filtre par user_id' }),
    T6: task('T6', { confidence: 'suppose', evidence: '' }),
  };
  delete answers.T2.confidence;
  const rt = runtime((prompt, opts) => answers[opts.label]);
  const result = await run(...rt.hooks, { ...WAVE_ARGS, tasks });
  assert.deepEqual(result.reports.map(r => r.taskId), ['T1', 'T5']);
  assert.deepEqual(result.refused.map(r => r.taskId), ['T2', 'T3', 'T4', 'T6']);
  const why = Object.fromEntries(result.refused.map(r => [r.taskId, r.problems.join(' ; ')]));
  assert.match(why.T2, /niveau de confiance absent/);
  assert.match(why.T3, /niveau de confiance inconnu « certain »/);
  assert.match(why.T4, /niveau prouve sans preuve/);
  assert.match(why.T6, /preuve ou justification absente/);
  assert.equal(result.refused[0].report.taskId, 'T2', 'the refused report is kept for the lead, not lost');
  assert.deepEqual(result.withoutReport, []);
  assert.ok(rt.logs.some(l => l.includes('Rapports refusés')));
  assert.deepEqual(result.escalation, { verify: ['T5'], operator: [] });
});

test('vague: escalation lists the probable results to verify and the supposed ones for the operator', async () => {
  const { run } = load('vague.js');
  const rt = runtime((prompt, opts) => opts.label === 'T2'
    ? task('T2', { confidence: 'probable', evidence: 'lu : la requête filtre déjà par user_id (src/a.ts:12)' })
    : task('T3', { status: 'failed', confidence: 'suppose', evidence: 'échec du build, peut-être la version de Node ; à confirmer par node -v sur la CI' }));
  const result = await run(...rt.hooks, WAVE_ARGS);
  assert.deepEqual(result.escalation, { verify: ['T2'], operator: ['T3'] });
  assert.deepEqual(result.refused, []);
});

test('revues: every finding and every inventory path carries its level; a report with one bad claim is refused whole', async () => {
  const { run } = load('revues.js');
  const good = finding('eleve', 'IDOR', 'src/a.ts:1');
  const byDomain = {
    securite: [good],
    fidelite: [{ ...finding('moyen', 'Texte', 'accueil 390 clair'), confidence: undefined }],
    donnees: [finding('faible', 'Index', 'm.sql', 'plausible')],
    rgpd: [{ ...finding('moyen', 'Durée', 'confidentialite.md'), evidence: ' ' }],
  };
  delete byDomain.fidelite[0].confidence;
  const rt = runtime((prompt, opts) => ({ domain: opts.label, commit: 'x', findings: byDomain[opts.label], notVerified: [], cleanup: 'fait', summary: 'ok' }));
  const result = await run(...rt.hooks, REVIEW_ARGS);
  for (const call of rt.calls.filter(c => c.opts.phase === 'Revues')) {
    const item = call.opts.schema.properties.findings.items;
    assert.ok(item.required.includes('confidence') && item.required.includes('evidence'), call.opts.label);
    assert.deepEqual(item.properties.confidence.enum, LEVELS);
    assert.equal(item.properties.evidence.minLength, 1);
    assert.match(call.prompt, /`prouve` si la preuve est reproductible et jointe/);
    assert.match(call.prompt, /`probable` si tu as lu le code ou raisonné sans exécuter/);
    assert.match(call.prompt, /`suppose` pour une hypothèse/);
  }
  assert.deepEqual(result.refused.map(r => r.domain), ['fidelite', 'donnees', 'rgpd']);
  const why = Object.fromEntries(result.refused.map(r => [r.domain, r.problems.join(' ; ')]));
  assert.match(why.fidelite, /niveau de confiance absent/);
  assert.match(why.donnees, /niveau de confiance inconnu « plausible »/);
  assert.match(why.rgpd, /niveau prouve sans preuve/);
  assert.deepEqual(result.reports.map(r => r.domain), ['securite']);
  assert.deepEqual(result.findings.map(f => f.id), ['S1']);
  assert.deepEqual(result.incomplete, []);
  assert.ok(rt.logs.some(l => l.includes('Rapports refusés')));

  // The concurrence inventory: a path without a level, or with an empty proof, refuses the audit.
  const path = { location: 'a.ts:1', family: '4.1', invariant: 'x', protection: 'aucune', status: 'inconnu', proof: 'rien de lu' };
  const audit = runtime((prompt, opts) => ({ domain: opts.label, commit: 'x', findings: [], notVerified: [], cleanup: 'fait', summary: 'ok',
    paths: [path, { ...path, confidence: 'prouve', proof: '' }] }));
  const refused = await run(...audit.hooks, { commit: 'c'.repeat(40), reviews: [{ domain: 'concurrence', copy: '/tmp/c' }] });
  const pathItem = audit.calls[0].opts.schema.properties.paths.items;
  assert.ok(pathItem.required.includes('confidence') && pathItem.required.includes('proof'));
  assert.deepEqual(pathItem.properties.confidence.enum, LEVELS);
  assert.deepEqual(refused.refused.map(r => r.domain), ['concurrence']);
  assert.match(refused.refused[0].problems.join(' ; '), /chemin 1 : niveau de confiance absent/);
  assert.match(refused.refused[0].problems.join(' ; '), /chemin 2 : niveau prouve sans preuve \(proof\)/);
});

test('revues: a merged finding keeps the strongest proof; escalation sorts what to verify and what goes to the operator', async () => {
  const { run } = load('revues.js');
  const byDomain = {
    securite: [finding('eleve', 'IDOR', 'src/r.ts:40', 'prouve')],
    fidelite: [finding('moyen', 'Texte modifié', 'accueil 390 clair', 'probable')],
    donnees: [finding('moyen', 'Pas de filtre user_id', 'src/r.ts:40', 'suppose'), finding('faible', 'Index', 'm.sql', 'suppose')],
    rgpd: [],
  };
  const rt = runtime((prompt, opts) => opts.label === 'dédoublonnage'
    ? { groups: [{ ids: ['S1', 'D1'], reason: 'même requête' }, { ids: ['F1'], reason: '' }, { ids: ['D2'], reason: '' }] }
    : { domain: opts.label, commit: 'x', findings: byDomain[opts.label], notVerified: [], cleanup: 'fait', summary: 'ok' });
  const result = await run(...rt.hooks, REVIEW_ARGS);
  const merged = result.findings.find(f => f.id === 'S1');
  assert.equal(merged.confidence, 'prouve', 'proven by one reviewer, proven');
  assert.match(merged.evidence, /S1 \(prouve\) : /);
  assert.match(merged.evidence, /D1 \(suppose\) : /);
  assert.deepEqual(result.escalation, { verify: ['F1'], operator: ['D2'] });
});

test('vague: the report pastes the raw git outputs; a commit that disagrees with them is listed, never trusted', async () => {
  const { run } = load('vague.js');
  const sha = 'b'.repeat(40);
  const answers = {
    T2: task('T2', { commit: sha, headRevParse: `${sha}\n`, headLog: 'bbbbbbb feat: relances' }),
    // Pilot project, 24 September 2026: the 7 first characters right, the rest invented.
    T3: task('T3', { commit: 'bbbbbbb' + 'f'.repeat(33), headRevParse: sha, headLog: 'bbbbbbb feat: relances' }),
  };
  const rt = runtime((prompt, opts) => answers[opts.label]);
  const result = await run(...rt.hooks, WAVE_ARGS);
  const { schema } = rt.calls[0].opts;
  for (const field of ['headRevParse', 'headLog']) assert.ok(schema.required.includes(field), field);
  assert.match(rt.calls[0].prompt, /sha complet copié de la sortie de `git rev-parse HEAD`[^\n]*jamais retapé/);
  assert.match(rt.calls[0].prompt, /headRevParse : la sortie brute de `git rev-parse HEAD`, collée telle quelle ; headLog : la sortie brute de `git log --oneline -1`/);
  assert.deepEqual(result.commitChecks.map(c => c.taskId), ['T3']);
  assert.match(result.commitChecks[0].problems.join(' ; '), /commit différent de la sortie de git rev-parse HEAD/);
  assert.ok(rt.logs.some(l => l.includes('relire par git rev-parse <branche>')));
  assert.deepEqual(result.reports.map(r => r.taskId), ['T2', 'T3'], 'the work is still reported: only its commit is not trusted');
});

test('revues: copies are absolute paths; the security review reads the scan report of the lead, or notes it not verified', async () => {
  const { run } = load('revues.js');
  const answer = (prompt, opts) => ({ domain: opts.label, commit: REVIEW_ARGS.commit, findings: [], notVerified: [], cleanup: 'fait', summary: 'ok' });
  await assert.rejects(run(...runtime(answer).hooks, { ...REVIEW_ARGS, reviews: [{ domain: 'securite', copy: '../depot-revues/securite' }] }), /chemin absolu/);
  const withScan = runtime(answer);
  const result = await run(...withScan.hooks, { ...REVIEW_ARGS, dast: '/tmp/session/dast-ccccccc' });
  const security = withScan.calls.find(c => c.opts.label === 'securite').prompt;
  assert.match(security, /Scan dynamique : lancé par le chef de projet avant les revues \(`node "\$\{CLAUDE_PLUGIN_ROOT\}\/dist\/cli\.js" dast run`\) ; rapports dans `\/tmp\/session\/dast-ccccccc`/);
  assert.match(security, /Ne relance pas le scan et ne lance pas Docker/);
  assert.ok(withScan.calls.filter(c => c.opts.label !== 'securite').every(c => !c.prompt.includes('Scan dynamique')), 'only the security review');
  assert.equal(result.dast, '/tmp/session/dast-ccccccc');
  const without = runtime(answer);
  await run(...without.hooks, { ...REVIEW_ARGS, dastMissing: 'scan non déclaré par le projet (review.dast)' });
  const noScan = without.calls.find(c => c.opts.label === 'securite').prompt;
  assert.match(noScan, /Scan dynamique : scan non déclaré par le projet \(review\.dast\)\. Ne lance pas Docker et ne cherche aucun détour : note le scan dynamique « non vérifié »/);
});

test('revues: the domains skipped on the plan of apv review plan come back with their reason; securite is never skipped', async () => {
  const { run } = load('revues.js');
  const plain = runtime((prompt, opts) => ({ domain: opts.label, commit: 'x', findings: [], notVerified: [], cleanup: 'fait', summary: 'ok' }));
  const skipped = [{ domain: 'fidelite', reason: 'rien à relire : aucun fichier d\'interface' }, { domain: 'rgpd', reason: 'rien à relire : aucune migration' }];
  const result = await run(...plain.hooks, { ...REVIEW_ARGS, reviews: REVIEW_ARGS.reviews.filter(r => ['securite', 'donnees'].includes(r.domain)), skipped });
  assert.deepEqual(plain.calls.filter(c => c.opts.phase === 'Revues').map(c => c.opts.label), ['securite', 'donnees']);
  assert.deepEqual(result.skipped, skipped);
  assert.ok(plain.logs.some(l => l.includes('Domaines sautés (apv review plan) : fidelite')));
  assert.deepEqual((await run(...runtime(() => null).hooks, REVIEW_ARGS)).skipped, [], 'no plan: nothing skipped');
  const hooks = () => runtime(() => null).hooks;
  const only = REVIEW_ARGS.reviews.slice(1);
  await assert.rejects(run(...hooks(), { ...REVIEW_ARGS, reviews: only, skipped: [{ domain: 'securite', reason: 'rien' }] }), /jamais sautée/);
  await assert.rejects(run(...hooks(), { ...REVIEW_ARGS, reviews: REVIEW_ARGS.reviews.slice(1, 2), skipped: [{ domain: 'rgpd', reason: 'rien' }] }), /securite manque/);
  await assert.rejects(run(...hooks(), { ...REVIEW_ARGS, skipped: [{ domain: 'rgpd', reason: 'rien' }] }), /à la fois revu et sauté/);
  await assert.rejects(run(...hooks(), { ...REVIEW_ARGS, reviews: REVIEW_ARGS.reviews.slice(0, 1), skipped: [{ domain: 'rgpd' }] }), /raison/);
  await assert.rejects(run(...hooks(), { ...REVIEW_ARGS, reviews: REVIEW_ARGS.reviews.slice(0, 1), skipped: [{ domain: 'concurrence', reason: 'x' }] }), /inconnu/);
});
