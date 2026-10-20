import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, git } from './helpers.mjs';
import { apv, write, decision } from './cli-helpers.mjs';
import { planLedgerUpdate, applyLedgerUpdate } from '../dist/lifecycle/ledger-update.js';
import { decisionLedgerIssues, loadDecisionLedger, resolveLedgerFile } from '../dist/lifecycle/decisions.js';
import { candidateSubject, Git } from '../dist/execution/git.js';

/** Hides the global and system Git configuration for this test, so only the repository's own identity counts. */
function isolateGitConfig(t) {
  const saved = { GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM };
  process.env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null'; process.env.GIT_CONFIG_NOSYSTEM = '1';
  t.after(() => { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; });
}
function identify(repo, name = 'Repo Owner', email = 'owner@example.com') { git(repo, 'config', 'user.name', name); git(repo, 'config', 'user.email', email); }

const ambiguous = { id: 'D-DOMAIN', subject: 'Domain', value: 'unresolved', enforcement: 'product', status: 'ambiguous', source: 'operator', sourceQuote: 'librairie',
  rationale: 'Ambiguous word.', supersedes: [], clarificationQuestion: 'Which kind of shop?', interpretations: ['library', 'bookshop'] };
const update = { decisions: [{ id: 'D-DOMAIN-2', subject: 'Domain', value: 'Bookshop that also lends', enforcement: 'product', status: 'confirmed', source: 'operator',
  sourceQuote: 'Librairie + prêt', rationale: 'Operator answer.', supersedes: ['D-DOMAIN'], clarificationQuestion: '', interpretations: [] }] };

for (const [location, markdown] of [['.apv/DECISIONS.json', '.apv/DECISIONS.md'], ['.agent-pipeline/DECISIONS.json', '.agent-pipeline/DECISIONS.md']])
  test(`ledger updates in ${location} are planned, hash-bound, supersede explicitly and commit`, async t => {
    const f = fixture(t);
    isolateGitConfig(t); identify(f.repo);
    write(f.repo, location, { schemaVersion: 1, decisions: [ambiguous] });
    git(f.repo, 'add', '-A'); git(f.repo, 'commit', '-qm', 'ledger');
    assert.equal(await resolveLedgerFile(f.repo), location);
    const plan = await planLedgerUpdate(f.repo, update);
    assert.equal(plan.file, location);
    assert.deepEqual(plan.superseded, ['D-DOMAIN']);
    assert.deepEqual(plan.ledger.decisions.map(d => d.id), ['D-DOMAIN-2']);
    await assert.rejects(applyLedgerUpdate(f.repo, update, 'wrong', 'Tester', 'Record the operator answer.', true), /changed since/);
    const applied = await applyLedgerUpdate(f.repo, update, plan.hash, 'Tester', 'Record the operator answer.', true);
    assert.equal(JSON.parse(readFileSync(join(f.repo, location), 'utf8')).decisions[0].id, 'D-DOMAIN-2');
    assert.match(readFileSync(join(f.repo, markdown), 'utf8'), /D-DOMAIN-2/);
    assert.equal(git(f.repo, 'log', '-1', '--format=%s'), 'chore(decisions): update decision ledger');
    assert.equal(applied.commitSha, git(f.repo, 'rev-parse', 'HEAD'));
    assert.equal((await loadDecisionLedger(f.repo)).decisions[0].id, 'D-DOMAIN-2');
    await assert.rejects(planLedgerUpdate(f.repo, { decisions: [{ ...update.decisions[0], id: 'D-X', source: 'derived', status: 'proposed', sourceQuote: '', supersedes: ['D-DOMAIN-2'] }] }), /must be an operator decision/);
    await assert.rejects(planLedgerUpdate(f.repo, update), /already exists/);
  });

test('a project without ledger gets the V3 location; .apv wins over the V2 file', async t => {
  const f = fixture(t);
  assert.equal(await resolveLedgerFile(f.repo), '.apv/DECISIONS.json');
  const plan = await planLedgerUpdate(f.repo, { decisions: [decision('D-1')] });
  assert.equal(plan.file, '.apv/DECISIONS.json');
  await applyLedgerUpdate(f.repo, { decisions: [decision('D-1')] }, plan.hash, 'Tester', 'First operator decision.', false);
  assert.ok(existsSync(join(f.repo, '.apv/DECISIONS.json')));
  write(f.repo, '.agent-pipeline/DECISIONS.json', { schemaVersion: 1, decisions: [] });
  assert.equal(await resolveLedgerFile(f.repo), '.apv/DECISIONS.json');
});

test('apv ledger validate lists every error of the ledger', async t => {
  const f = fixture(t);
  const none = await apv(f.repo, ['ledger', 'validate']);
  assert.equal(none.code, 0); assert.match(none.stdout, /Aucun registre/);
  write(f.repo, '.agent-pipeline/DECISIONS.json', { schemaVersion: 1, decisions: [decision('D-A'), decision('D-A'),
    decision('D-B', { status: 'ambiguous', clarificationQuestion: '', interpretations: ['one'] }), decision('D-C', { enforcement: 'bogus' })] });
  const bad = await apv(f.repo, ['ledger', 'validate', '--json']);
  assert.equal(bad.code, 1);
  assert.equal(bad.json().file, '.agent-pipeline/DECISIONS.json');
  assert.match(bad.json().issues[0].message, /enforcement: expected bootstrap\|product\|deferred/);
  write(f.repo, '.apv/DECISIONS.json', { schemaVersion: 1, decisions: [decision('D-A'), decision('D-A'), decision('D-B', { status: 'ambiguous', clarificationQuestion: '', interpretations: ['one'] })] });
  const human = await apv(f.repo, ['ledger', 'validate']);
  assert.equal(human.code, 1);
  assert.match(human.stdout, /Registre invalide : \.apv\/DECISIONS\.json\n3 erreur\(s\)/);
  assert.match(human.stdout, /Duplicate decision id/);
  assert.match(human.stdout, /requires a clarification question/);
  assert.match(human.stdout, /at least two plausible interpretations/);
  write(f.repo, '.apv/DECISIONS.json', { schemaVersion: 1, decisions: [decision('D-A')] });
  const ok = await apv(f.repo, ['ledger', 'validate']);
  assert.equal(ok.code, 0); assert.match(ok.stdout, /Registre valide : \.apv\/DECISIONS\.json \(1 décision\(s\), empreinte [a-f0-9]{64}\)/);
  write(f.repo, '.apv/DECISIONS.json', '{ broken');
  assert.equal((await apv(f.repo, ['ledger', 'validate'])).code, 1);
});

test('apv ledger plan then apply writes exactly the reviewed plan', async t => {
  const f = fixture(t);
  isolateGitConfig(t); identify(f.repo, 'Operator Name', 'operator@example.com');
  const file = write(f.root, 'update.json', { decisions: [decision('D-NEW')] });
  const plan = await apv(f.repo, ['ledger', 'plan', '--file', file]);
  assert.equal(plan.code, 0, plan.stderr);
  const { hash, next } = plan.json();
  assert.match(next, /apv ledger apply/);
  assert.equal((await apv(f.repo, ['ledger', 'apply', '--file', file, '--note', 'Record the decision.'])).code, 2);
  assert.equal((await apv(f.repo, ['ledger', 'apply', '--file', file, '--hash', hash])).code, 2);
  const wrong = await apv(f.repo, ['ledger', 'apply', '--file', file, '--hash', 'f'.repeat(64), '--note', 'Record the decision.']);
  assert.equal(wrong.code, 1); assert.match(wrong.stderr, /LEDGER_HASH/);
  const applied = await apv(f.repo, ['ledger', 'apply', '--file', file, '--hash', hash, '--note', 'Record the decision.', '--commit']);
  assert.equal(applied.code, 0, applied.stderr);
  assert.equal(applied.json().file, '.apv/DECISIONS.json');
  assert.match(git(f.repo, 'log', '-1', '--format=%b'), /Reviewer: Operator Name/);
  assert.equal((await apv(f.repo, ['ledger', 'plan', '--file', join(f.root, 'absent.json')])).code, 2);
  assert.equal((await apv(f.repo, ['ledger', 'drop'])).code, 2);
});

test('apv ledger apply --commit commits as the repository identity, with a Generated-by trailer', async t => {
  const f = fixture(t);
  isolateGitConfig(t); identify(f.repo, 'Repo Owner', 'owner@example.com');
  const file = write(f.root, 'update.json', { decisions: [decision('D-NEW')] });
  const { hash } = (await apv(f.repo, ['ledger', 'plan', '--file', file])).json();
  const applied = await apv(f.repo, ['ledger', 'apply', '--file', file, '--hash', hash, '--note', 'Record the decision.', '--commit']);
  assert.equal(applied.code, 0, applied.stderr);
  assert.equal(git(f.repo, 'log', '-1', '--format=%an <%ae>|%cn <%ce>'), 'Repo Owner <owner@example.com>|Repo Owner <owner@example.com>');
  assert.equal(git(f.repo, 'log', '-1', '--format=%(trailers:key=Generated-by,valueonly)'), 'apv ledger apply');
  assert.match(git(f.repo, 'log', '-1', '--format=%B'), /Reviewer: Repo Owner\nNote: Record the decision\.\n\nGenerated-by: apv ledger apply/);
  assert.doesNotMatch(git(f.repo, 'log', '--format=%an %ae %cn %ce'), /pipeline@localhost|Agent Pipeline/);
});

test('apv ledger apply --commit refuses without a Git identity and writes nothing', async t => {
  const f = fixture(t);
  isolateGitConfig(t);
  const head = git(f.repo, 'rev-parse', 'HEAD');
  const file = write(f.root, 'update.json', { decisions: [decision('D-NEW')] });
  const { hash } = (await apv(f.repo, ['ledger', 'plan', '--file', file])).json();
  const refused = await apv(f.repo, ['ledger', 'apply', '--file', file, '--hash', hash, '--note', 'Record the decision.', '--reviewer', 'Someone', '--commit']);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /GIT_IDENTITY.*user\.name et user\.email absent/);
  assert.match(refused.stderr, /git config user\.name "Votre Nom" && git config user\.email/);
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), head);
  assert.equal(existsSync(join(f.repo, '.apv/DECISIONS.json')), false);
  git(f.repo, 'config', 'user.name', 'Half Configured');
  await assert.rejects(applyLedgerUpdate(f.repo, { decisions: [decision('D-NEW')] }, hash, 'Someone', 'Record the decision.', true), /user\.email absent/);
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), head);
  // Without --commit no identity is needed: the files are written, nothing is committed.
  const written = await apv(f.repo, ['ledger', 'apply', '--file', file, '--hash', hash, '--note', 'Record the decision.', '--reviewer', 'Someone']);
  assert.equal(written.code, 0, written.stderr);
  assert.equal(written.json().commitSha, null);
});

test('a candidate snapshot commits as the repository identity with run and Generated-by trailers', async t => {
  const f = fixture(t);
  isolateGitConfig(t); identify(f.repo);
  const base = git(f.repo, 'rev-parse', 'HEAD');
  write(f.repo, 'src/math.mjs', 'export const add = (a, b) => a + b;\n');
  const sha = await new Git().snapshot(f.repo, base, 'run-1', 'Fix addition');
  assert.equal(git(f.repo, 'log', '-1', '--format=%an <%ae>|%s', sha), 'Repo Owner <owner@example.com>|Fix addition');
  assert.equal(git(f.repo, 'log', '-1', '--format=%(trailers:key=Agent-Pipeline-Run,valueonly)', sha), 'run-1');
  assert.equal(git(f.repo, 'log', '-1', '--format=%(trailers:key=Generated-by,valueonly)', sha), 'apv (candidat)');
});

test('ledger issues report schema problems before rules', () => {
  assert.match(decisionLedgerIssues({ schemaVersion: 2, decisions: [] })[0].message, /schemaVersion: expected 1/);
  assert.equal(decisionLedgerIssues({ schemaVersion: 1, decisions: [decision('D-1')] }).length, 0);
});

test('candidate commit subjects come from the task title', () => {
  assert.equal(candidateSubject('Emprunt, retour et retards', 'run-1'), 'Emprunt, retour et retards');
  assert.equal(candidateSubject('  multi\nline\ttitle ', 'run-1'), 'multi line title');
  assert.equal(candidateSubject('x'.repeat(100), 'run-1').length, 72);
});

test('the readable ledger ends with exactly one newline (git diff --check stays clean)', async () => {
  const { decisionLedgerMarkdown } = await import('../dist/lifecycle/decisions.js');
  const decision = { id: 'un-choix', subject: 'Sujet', value: 'Valeur', enforcement: 'product', status: 'confirmed', source: 'operator',
    sourceQuote: 'citation', rationale: 'Raison.', supersedes: [], clarificationQuestion: '', interpretations: [] };
  const md = decisionLedgerMarkdown({ schemaVersion: 1, decisions: [decision] });
  assert.ok(md.endsWith('Raison.\n'), JSON.stringify(md.slice(-20)));
});
