import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { demoSpec, fixture, oneTask, withSecurity, git } from './lifecycle-helpers.mjs';
import { apv, write, decision } from './cli-helpers.mjs';
import { checkSpec, parseSpecDocument, specText } from '../dist/spec/check.js';
import { specIssues, validateSpec } from '../dist/lifecycle/contracts.js';
import { assessSecurity } from '../dist/security/owasp.js';

test('a complete spec is valid and reports the recomputed security minimum', async t => {
  const f = fixture(t);
  const file = write(f.root, 'spec.json', demoSpec());
  const r = await apv(f.repo, ['spec', 'validate', file]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^Spec valide : Multiplication et documentation/);
  assert.match(r.stdout, /Minimum de sécurité : voie fast/);
  const json = (await apv(f.repo, ['spec', 'validate', file, '--json'])).json();
  assert.equal(json.valid, true); assert.equal(json.mode, 'ready'); assert.equal(json.requestSource, 'spec');
  assert.equal(json.sha, git(f.repo, 'rev-parse', 'HEAD'));
});

test('every schema error is listed at once, not only the first', async t => {
  const f = fixture(t);
  const spec = demoSpec(); delete spec.title; spec.autorun = true; spec.minimumLane = 'none'; spec.acceptance[0].id = '../bad';
  const r = await apv(f.repo, ['spec', 'validate', write(f.root, 'spec.json', spec), '--json']);
  assert.equal(r.code, 1);
  const messages = r.json().issues.map(i => i.message).join('\n');
  for (const expected of [/\$\.title: missing required property/, /unknown property autorun/, /\$\.minimumLane: expected fast\|standard\|high/, /\$\.acceptance\[0\]\.id: invalid string/])
    assert.match(messages, expected);
  assert.equal(r.json().issues.length, 4);
});

test('every semantic error is listed, in human output too', async t => {
  const f = fixture(t);
  const spec = demoSpec();
  spec.tasks[0].acceptanceIds.push('AC-MISSING'); spec.tasks[1].dependsOn.push('GHOST'); spec.acceptance.push({ ...spec.acceptance[1] });
  spec.tasks[0].allowedPaths.push('{a,b}');
  const r = await apv(f.repo, ['spec', 'validate', write(f.root, 'spec.json', spec)]);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /Spec invalide/);
  assert.match(r.stdout, /4 erreur\(s\)/);
  assert.match(r.stdout, /\[SPEC\] Duplicate item id in acceptance: AC-DOC/);
  assert.match(r.stdout, /\[SPEC\] Task MATH references an unknown acceptance criterion: AC-MISSING/);
  assert.match(r.stdout, /\[GLOB\] Unsupported glob: \{a,b\}/);
  assert.match(r.stdout, /\[SPEC_DAG\] Missing dependency GHOST \(required by DOC\)/);
});

test('the V2 contract still throws the first error only', () => {
  const spec = demoSpec(); spec.tasks[0].acceptanceIds.push('AC-MISSING'); spec.tasks[1].dependsOn.push('GHOST');
  assert.equal(specIssues(spec).length, 2);
  assert.throws(() => validateSpec(spec), /AC-MISSING/);
  const cycle = demoSpec(); cycle.tasks[0].dependsOn.push('DOC');
  assert.deepEqual(specIssues(cycle).map(i => i.code), ['SPEC_DAG']);
});

test('incident 14: the security minimum is recomputed from the request, as at launch', async t => {
  const f = fixture(t);
  const request = 'Expose a REST API endpoint with login and session cookies.';
  const plain = write(f.root, 'plain.json', oneTask());
  // Valid against the spec text alone: nothing security-sensitive is written there.
  assert.equal((await apv(f.repo, ['spec', 'validate', plain])).code, 0);
  const refused = await apv(f.repo, ['spec', 'validate', plain, '--request', request, '--json']);
  assert.equal(refused.code, 1);
  const security = refused.json().issues.find(i => i.code === 'SPEC_SECURITY');
  assert.ok(security, JSON.stringify(refused.json().issues));
  const expected = assessSecurity({ text: request, files: ['src/math.mjs', 'test/math.test.mjs'] });
  for (const topic of expected.topics.map(x => x.id)) assert.match(security.message, new RegExp(topic));
  assert.deepEqual(refused.json().security.topics, expected.topics.map(x => x.id));
  // The same request stored in the document gives the same minimum; a spec covering it is valid.
  const covered = write(f.root, 'covered.json', { request, spec: withSecurity(oneTask(), request) });
  const ok = await apv(f.repo, ['spec', 'validate', covered, '--json']);
  assert.equal(ok.code, 0, JSON.stringify(ok.json().issues));
  assert.equal(ok.json().requestSource, 'document');
  assert.equal(ok.json().security.minimumLane, 'high');
});

test('literal task paths and paths named by the request raise the minimum like V2 did', async t => {
  const f = fixture(t);
  const spec = oneTask(); spec.tasks[0].allowedPaths.push('src/auth/login.mjs');
  const r = await checkSpec({ repo: f.repo, document: parseSpecDocument(spec) });
  assert.equal(r.valid, false);
  assert.ok(r.security.profile.authentication);
  const named = await checkSpec({ repo: f.repo, document: parseSpecDocument(oneTask()), request: 'Update package.json to add a dependency.' });
  assert.ok(named.security.profile.dependencyChange);
});

test('the ledger is read from .apv first, then from the V2 location', async t => {
  const f = fixture(t);
  const file = write(f.root, 'spec.json', demoSpec());
  write(f.repo, '.agent-pipeline/DECISIONS.json', { schemaVersion: 1, decisions: [decision('D-V2')] });
  let r = await apv(f.repo, ['spec', 'validate', file, '--json']);
  assert.equal(r.code, 1); assert.equal(r.json().ledgerFile, '.agent-pipeline/DECISIONS.json');
  assert.match(r.json().issues[0].message, /D-V2 is not covered/);
  write(f.repo, '.apv/DECISIONS.json', { schemaVersion: 1, decisions: [decision('D-V3')] });
  r = await apv(f.repo, ['spec', 'validate', file, '--json']);
  assert.equal(r.json().ledgerFile, '.apv/DECISIONS.json');
  assert.match(r.json().issues[0].message, /D-V3 is not covered/);
  const covered = demoSpec(); covered.decisionCoverage = [{ decisionId: 'D-V3', acceptanceIds: ['AC-MATH'], rationale: 'Covered by the product criterion.' }];
  assert.equal((await apv(f.repo, ['spec', 'validate', write(f.root, 'covered.json', covered)])).code, 0);
  write(f.repo, '.apv/DECISIONS.json', { schemaVersion: 1, decisions: [decision('D-X'), decision('D-X', { sourceQuote: '' })] });
  r = await apv(f.repo, ['spec', 'validate', file, '--json']);
  assert.deepEqual(r.json().issues.map(i => i.code).slice(0, 2), ['DECISION', 'DECISION_SOURCE']);
});

test('open questions pass in draft mode only; the default is the launch rule', async t => {
  const f = fixture(t);
  const file = write(f.root, 'spec.json', demoSpec(true));
  const ready = await apv(f.repo, ['spec', 'validate', file, '--json']);
  assert.equal(ready.code, 1); assert.ok(ready.json().issues.some(i => i.code === 'OPEN_QUESTIONS'));
  assert.equal((await apv(f.repo, ['spec', 'validate', file, '--draft'])).code, 0);
});

test('a resolution must quote the operator request given with the spec', async t => {
  const f = fixture(t);
  write(f.repo, '.apv/DECISIONS.json', { schemaVersion: 1, decisions: [decision('D-MULTI', { status: 'ambiguous', value: 'unresolved',
    clarificationQuestion: 'Multi-site in the MVP?', interpretations: ['inside', 'outside'] })] });
  const spec = demoSpec();
  spec.decisionResolutions = [{ decisionId: 'D-MULTI', value: 'outside', sourceQuote: 'second shop stays outside', rationale: 'Operator answer.' }];
  spec.decisionCoverage = [{ decisionId: 'D-MULTI', acceptanceIds: ['AC-MATH'], rationale: 'Scope stays single-site.' }];
  const file = write(f.root, 'spec.json', spec);
  assert.equal((await apv(f.repo, ['spec', 'validate', file, '--request', 'The second shop stays outside the MVP.'])).code, 0);
  const r = await apv(f.repo, ['spec', 'validate', file, '--request', 'Nothing about it.', '--json']);
  assert.equal(r.code, 1); assert.match(r.json().issues[0].message, /source quote/);
});

test('unreadable files and wrong invocations have distinct exit codes', async t => {
  const f = fixture(t);
  const missing = await apv(f.repo, ['spec', 'validate', join(f.root, 'absent.json')]);
  assert.equal(missing.code, 1); assert.match(missing.stdout, /SPEC_FILE/);
  const broken = await apv(f.repo, ['spec', 'validate', write(f.root, 'broken.json', '{ nope')]);
  assert.equal(broken.code, 1); assert.match(broken.stdout, /Invalid JSON/);
  assert.equal((await apv(f.repo, ['spec', 'validate'])).code, 2);
  assert.equal((await apv(f.repo, ['spec', 'check', 'x'])).code, 2);
  assert.equal((await apv(f.repo, ['spec', 'validate', 'a.json', '--nope'])).code, 2);
  const help = await apv(f.repo, ['spec', '--help']);
  assert.equal(help.code, 0); assert.match(help.stdout, /apv spec validate/);
});

test('spec documents: wrapper keys are strict and the fallback text ignores exclusions', () => {
  assert.equal(parseSpecDocument({ request: 'x', spec: { title: 't' } }).request, 'x');
  assert.throws(() => parseSpecDocument({ spec: {}, extra: 1 }), /Unknown property/);
  assert.throws(() => parseSpecDocument({ spec: {}, request: ' ' }), /non-empty/);
  const spec = demoSpec(); spec.outOfScope = ['No login and no password storage.'];
  assert.doesNotMatch(specText(spec), /password/);
  assert.equal(specText({ invalid: true }), '');
});

test('the request stored by /apv:spec is read by validate and by run start alike (same minimum)', async t => {
  const f = fixture(t);
  const request = 'Expose a REST API endpoint with login and session cookies.';
  // Covered for the stored request, which is stricter than the spec text alone.
  write(f.repo, '.apv/specs/api.json', withSecurity(oneTask(), request));
  write(f.repo, '.apv/state/demande-api.md', `${request}\n`);
  git(f.repo, 'add', '.'); git(f.repo, 'commit', '-qm', 'spec');
  const validated = await apv(f.repo, ['spec', 'validate', '.apv/specs/api.json', '--json']);
  assert.equal(validated.code, 0, JSON.stringify(validated.json().issues));
  assert.deepEqual([validated.json().requestSource, validated.json().requestFile], ['stored', '.apv/state/demande-api.md']);
  const started = await apv(f.repo, ['run', 'start', 'api', '--json'], { APV_LOCK_DIR: join(f.root, 'locks') });
  assert.equal(started.code, 0, started.stdout + started.stderr);
  // Without the stored request, a stricter spec written for a weaker request is refused at both steps.
  write(f.repo, '.apv/specs/plain.json', oneTask());
  write(f.repo, '.apv/state/demande-plain.md', `${request}\n`);
  git(f.repo, 'add', '.'); git(f.repo, 'commit', '-qm', 'plain');
  assert.equal((await apv(f.repo, ['spec', 'validate', '.apv/specs/plain.json'])).code, 1);
  assert.equal((await apv(f.repo, ['run', 'start', 'plain'], { APV_LOCK_DIR: join(f.root, 'locks') })).code, 1);
});

/** A spec of `count` tasks; `deps(i)` lists the dependencies of task i (1-based). */
function sizedSpec(count, deps = () => []) {
  const spec = demoSpec();
  spec.acceptance = []; spec.tasks = [];
  for (let i = 1; i <= count; i++) {
    spec.acceptance.push({ id: `AC-${i}`, description: `La page ${i} de la documentation existe.`, verification: `Lire docs/p${i}.md.` });
    spec.tasks.push({ id: `T${i}`, title: `Page ${i}`, description: `Écrire docs/p${i}.md.`, acceptanceIds: [`AC-${i}`], allowedPaths: [`docs/p${i}.md`],
      dependsOn: deps(i), minimumLane: 'standard' });
  }
  return spec;
}

test('longestChain names the deepest path of the dependency layers, as many tasks as computeWaves has waves', async () => {
  const { longestChain, computeWaves } = await import('../dist/run/state.js');
  const t = (id, dependsOn = []) => ({ id, title: id, dependsOn });
  assert.deepEqual(longestChain([]), []);
  assert.deepEqual(longestChain([t('A'), t('B')]), ['A']);
  const graph = [t('BASE'), t('DATA', ['BASE']), t('DOCS', ['DATA']), t('SIDE', ['BASE']), t('LIST', ['SIDE', 'DOCS']), t('FORM', ['DATA'])];
  assert.deepEqual(longestChain(graph), ['BASE', 'DATA', 'DOCS', 'LIST']);
  assert.equal(longestChain(graph).length, computeWaves(graph).length);
});

test('spec validate warns, without refusing, above the size and depth thresholds of the configuration', async t => {
  const f = fixture(t);
  // The pilot shape: a chain of five layers, and more tasks than the default threshold.
  const spec = sizedSpec(8, i => i >= 2 && i <= 5 ? [`T${i - 1}`] : []);
  const file = write(f.root, 'spec.json', spec);
  const human = await apv(f.repo, ['spec', 'validate', file]);
  assert.equal(human.code, 0, human.stdout + human.stderr);
  assert.match(human.stdout, /^Spec valide/);
  assert.match(human.stdout, /2 avertissement\(s\) :/);
  assert.match(human.stdout, /- \[SPEC_SIZE\] La spec compte 8 tâches \(seuil spec\.maxTasks : 6\) : découpe-la en specs indépendantes de 4 à 6 tâches, livrées en parallèle .*chacune avec sa PR\./);
  assert.match(human.stdout, /- \[SPEC_DEPTH\] Le graphe des tâches a 5 couches de dépendances \(seuil spec\.maxDepth : 3\), chemin le plus long : T1 -> T2 -> T3 -> T4 -> T5\. .*contrats partagés .*besoin du code de l'autre\./);
  const json = (await apv(f.repo, ['spec', 'validate', file, '--json'])).json();
  assert.equal(json.valid, true);
  assert.deepEqual(json.warnings.map(w => w.code), ['SPEC_SIZE', 'SPEC_DEPTH']);
  assert.deepEqual(json.limits, { maxTasks: 6, maxAcceptance: 30, maxDepth: 3 });

  // Thresholds from .apv/config.json: the criteria now exceed theirs, tasks and depth no longer do.
  write(f.repo, '.apv/config.json', { spec: { maxTasks: 10, maxAcceptance: 5, maxDepth: 5 } });
  const tuned = (await apv(f.repo, ['spec', 'validate', file, '--json'])).json();
  assert.equal(tuned.valid, true);
  assert.deepEqual(tuned.limits, { maxTasks: 10, maxAcceptance: 5, maxDepth: 5 });
  assert.equal(tuned.warnings.length, 1);
  assert.match(tuned.warnings[0].message, /La spec compte 8 critères d'acceptation \(seuil spec\.maxAcceptance : 5\)/);

  // A small, shallow spec: no warning, no warning section.
  const small = await apv(f.repo, ['spec', 'validate', write(f.root, 'small.json', sizedSpec(3, i => i === 3 ? ['T1', 'T2'] : []))]);
  assert.equal(small.code, 0);
  assert.doesNotMatch(small.stdout, /avertissement/);
  // An invalid spec keeps its errors and exit 1; warnings never turn it valid or invalid.
  const cyclic = sizedSpec(8, i => i === 1 ? ['T2'] : i === 2 ? ['T1'] : []);
  const refused = (await apv(f.repo, ['spec', 'validate', write(f.root, 'cyclic.json', cyclic), '--json']));
  assert.equal(refused.code, 1);
  assert.deepEqual(refused.json().warnings.map(w => w.code), ['SPEC_SIZE']);
});

test('the spec section of the configuration is validated by the schema', async () => {
  const { configIssues, specLimits } = await import('../dist/config/load.js');
  assert.deepEqual(specLimits(configIssues({}).config), { maxTasks: 6, maxAcceptance: 30, maxDepth: 3 });
  assert.deepEqual(specLimits(configIssues({ spec: { maxDepth: 4 } }).config), { maxTasks: 6, maxAcceptance: 30, maxDepth: 4 });
  assert.equal(configIssues({ spec: {} }).ignored.length, 0, 'spec is a read section');
  assert.match(configIssues({ spec: { maxTasks: 0 } }).issues[0].message, /maxTasks: expected a value in \[1, 100\]/);
  assert.match(configIssues({ spec: { maxAcceptance: 'many' } }).issues[0].message, /maxAcceptance: expected/);
  assert.match(configIssues({ spec: { maxDepth: 3, depth: 2 } }).issues[0].message, /unknown property depth/);
});

test('decision scope: a product decision of another perimeter is not required; one that overlaps, names the spec or has no scope is', async t => {
  const f = fixture(t);
  // demoSpec: tasks allowed on src/math.mjs, test/math.test.mjs and docs/math.md.
  const decisions = [
    decision('D-ACCUEIL', { scope: { paths: ['src/routes/accueil/**', 'static/accueil/**'] } }),
    decision('D-MATH', { scope: { paths: ['src/**'] } }),
    decision('D-SPEC', { scope: { specs: ['multiplication'] } }),
    decision('D-PARTOUT'),
  ];
  write(f.repo, '.apv/DECISIONS.json', { schemaVersion: 1, decisions });
  assert.equal((await apv(f.repo, ['ledger', 'validate'])).code, 0);
  const file = write(f.root, 'multiplication.json', demoSpec());
  const r = await apv(f.repo, ['spec', 'validate', file, '--json']);
  assert.equal(r.code, 1);
  const uncovered = r.json().issues.filter(i => i.code === 'SPEC_DECISIONS').map(i => /Product decision (\S+) is not covered/.exec(i.message)?.[1]);
  assert.deepEqual(uncovered.sort(), ['D-MATH', 'D-PARTOUT', 'D-SPEC'], 'disjoint scope: not required; overlapping, named or unscoped: required');
  const messages = Object.fromEntries(r.json().issues.map(i => [/Product decision (\S+)/.exec(i.message)?.[1], i.message]));
  assert.match(messages['D-MATH'], /son périmètre src\/\*\* recoupe le chemin autorisé src\/math\.mjs/);
  assert.match(messages['D-SPEC'], /son périmètre nomme la spec multiplication/);
  // The message proposes the fix: cover it, or scope it by a superseding decision.
  assert.match(messages['D-PARTOUT'], /sans périmètre \(champ scope absent\)[\s\S]*Solution : rattache-la à un critère \(decisionCoverage[\s\S]*champ scope : paths[\s\S]*supersedes, apv ledger plan puis apply/);
  assert.doesNotMatch(messages['D-MATH'], /donne-lui un périmètre/, 'an already scoped decision is not told to get a scope');
  // Under another file name, the spec is not named by D-SPEC any more.
  const other = await apv(f.repo, ['spec', 'validate', write(f.root, 'autre.json', demoSpec()), '--json']);
  assert.ok(!other.json().issues.some(i => /D-SPEC/.test(i.message)));
  // Covering the required decisions is enough; the out-of-scope one may still be covered.
  const covered = demoSpec();
  covered.decisionCoverage = ['D-MATH', 'D-PARTOUT', 'D-SPEC'].map(decisionId => ({ decisionId, acceptanceIds: ['AC-MATH'], rationale: 'Covered by the product criterion.' }));
  assert.equal((await apv(f.repo, ['spec', 'validate', write(f.root, 'multiplication.json', covered)])).code, 0);
  // A task that now reaches the scoped paths makes the decision required.
  const reaching = structuredClone(covered); reaching.tasks[1].allowedPaths.push('src/routes/**');
  const now = await apv(f.repo, ['spec', 'validate', write(f.root, 'multiplication.json', reaching), '--json']);
  assert.equal(now.code, 1);
  assert.match(now.json().issues.map(i => i.message).join('\n'), /D-ACCUEIL is not covered[\s\S]*son périmètre src\/routes\/accueil\/\*\* recoupe le chemin autorisé src\/routes\/\*\*/);
});

test('decision scope: an ambiguous decision of another perimeter does not block the spec; the scope is checked by the ledger', async t => {
  const f = fixture(t);
  const ambiguous = { status: 'ambiguous', value: 'unresolved', clarificationQuestion: 'Carrousel sur l\'accueil ?', interpretations: ['oui', 'non'] };
  write(f.repo, '.apv/DECISIONS.json', { schemaVersion: 1, decisions: [decision('D-CARROUSEL', { ...ambiguous, scope: { paths: ['src/routes/accueil/**'] } })] });
  assert.equal((await apv(f.repo, ['spec', 'validate', write(f.root, 'spec.json', demoSpec())])).code, 0);
  write(f.repo, '.apv/DECISIONS.json', { schemaVersion: 1, decisions: [decision('D-CARROUSEL', ambiguous)] });
  assert.equal((await apv(f.repo, ['spec', 'validate', write(f.root, 'spec.json', demoSpec())])).code, 1, 'unscoped: still asked by every spec');

  write(f.repo, '.apv/DECISIONS.json', { schemaVersion: 1, decisions: [decision('D-1', { scope: {} }), decision('D-2', { scope: { paths: ['{a,b}/**'] } }),
    decision('D-3', { scope: { specs: ['Pas_Kebab'] } })] });
  const r = await apv(f.repo, ['ledger', 'validate', '--json']);
  assert.equal(r.code, 1);
  const text = r.json().issues.map(i => i.message).join('\n');
  assert.match(text, /specs\[0\]: invalid string/);
  write(f.repo, '.apv/DECISIONS.json', { schemaVersion: 1, decisions: [decision('D-1', { scope: {} }), decision('D-2', { scope: { paths: ['{a,b}/**'] } })] });
  const rules = (await apv(f.repo, ['ledger', 'validate', '--json'])).json().issues;
  assert.deepEqual(rules.map(i => i.code), ['DECISION_SCOPE', 'DECISION_SCOPE']);
  assert.match(rules[0].message, /D-1: scope must name paths or specs/);
  assert.match(rules[1].message, /D-2: scope\.paths: Unsupported glob/);
});

test('decision scope: apv ledger plan and apply accept the field; a ledger without scopes keeps its hash', async t => {
  const f = fixture(t);
  write(f.repo, '.apv/DECISIONS.json', { schemaVersion: 1, decisions: [decision('D-OLD')] });
  git(f.repo, 'add', '.'); git(f.repo, 'commit', '-qm', 'ledger');
  const before = (await apv(f.repo, ['ledger', 'validate', '--json'])).json().hash;
  const { ledgerHash } = await import('../dist/lifecycle/decisions.js');
  assert.equal(before, ledgerHash({ schemaVersion: 1, decisions: [decision('D-OLD')] }));
  const update = write(f.root, 'update.json', { decisions: [decision('D-OLD-2', { supersedes: ['D-OLD'], scope: { paths: ['src/routes/accueil/**'], specs: ['accueil'] } })] });
  const plan = await apv(f.repo, ['ledger', 'plan', '--file', update]);
  assert.equal(plan.code, 0, plan.stderr);
  assert.deepEqual(plan.json().ledger.decisions[0].scope, { paths: ['src/routes/accueil/**'], specs: ['accueil'] });
  const applied = await apv(f.repo, ['ledger', 'apply', '--file', update, '--hash', plan.json().hash, '--note', 'Périmètre de la décision.', '--reviewer', 'Opérateur']);
  assert.equal(applied.code, 0, applied.stderr);
  const { readFileSync } = await import('node:fs');
  assert.match(readFileSync(join(f.repo, '.apv/DECISIONS.md'), 'utf8'), /Scope: paths src\/routes\/accueil\/\*\*, spec accueil/);
  assert.equal((await apv(f.repo, ['spec', 'validate', write(f.root, 'spec.json', demoSpec())])).code, 0, 'the superseding scoped decision no longer blocks an unrelated spec');
});
