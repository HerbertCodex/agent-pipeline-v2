import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fixture, git } from './helpers.mjs';
import { apv, write } from './cli-helpers.mjs';
import { pruneStore, readSharedRun, runTime } from '../dist/gates/store.js';

const node = (code, extra = {}) => ({ command: [process.execPath, '-e', code], ...extra });
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const gates = [{ id: 'lint', ...node('process.exit(0)') }, { id: 'unit', ...node('process.exit(0)') }];

function project(t, config = { gates }) {
  const f = fixture(t);
  write(f.repo, '.apv/config.json', config);
  git(f.repo, 'add', '-A'); git(f.repo, 'commit', '-qm', 'config');
  return { ...f, store: join(f.repo, '.git', 'apv', 'receipts') };
}
/** A detached copy of `ref` beside the repository (the delivery copy of /apv:run), removed by the caller. */
function copy(f, name, ref = 'HEAD') {
  const dir = join(f.root, name);
  git(f.repo, 'worktree', 'add', '-q', '--detach', dir, ref);
  return dir;
}
/** Rewrites a JSON file of a run of the shared store, and its digest in the manifest when `manifest` is true. */
function rewrite(runDir, name, change, manifest = false) {
  const file = join(runDir, name);
  const value = JSON.parse(readFileSync(file, 'utf8')); change(value);
  const text = JSON.stringify(value, null, 2) + '\n';
  writeFileSync(file, text);
  if (manifest) {
    const m = JSON.parse(readFileSync(join(runDir, 'manifest.json'), 'utf8'));
    m.files[name] = sha256(text); writeFileSync(join(runDir, 'manifest.json'), JSON.stringify(m));
  }
}

test('a run in a worktree since removed still proves its commit from the main checkout and from another worktree', async t => {
  const f = project(t);
  const head = git(f.repo, 'rev-parse', 'HEAD');
  const delivery = copy(f, 'livraison');
  const run = await apv(delivery, ['gates', 'run', '--stage', 'full', '--json']);
  assert.equal(run.code, 0, run.stdout);
  const out = run.json();
  assert.equal(out.sharedError, null);
  assert.equal(out.sharedDirectory, join(f.store, out.runId));
  const manifest = JSON.parse(readFileSync(join(out.sharedDirectory, 'manifest.json'), 'utf8'));
  assert.equal(manifest.runId, out.runId); assert.equal(manifest.candidateSha, head); assert.equal(manifest.worktree, out.receiptsDirectory.replace(/\/\.apv\/receipts\/.*$/, ''));
  assert.deepEqual(Object.keys(manifest.files).sort(), ['lint.json', 'summary.json', 'unit.json']);
  for (const [name, digest] of Object.entries(manifest.files)) assert.equal(sha256(readFileSync(join(out.sharedDirectory, name))), digest);
  const human = await apv(delivery, ['gates', 'run', '--only', 'lint']);
  assert.match(human.stdout, /Reçus : \.apv\/receipts\/\S+ ; copie partagée : .*\.git\/apv\/receipts\/\S+ \(exécution \S+\)/);
  // The copy is removed as /apv:run removes its delivery copy: its receipts leave with it.
  git(f.repo, 'worktree', 'remove', delivery);
  assert.ok(!existsSync(delivery));

  const v = await apv(f.repo, ['gates', 'verify', '--commit', head, '--json']);
  assert.equal(v.code, 0, JSON.stringify(v.json()));
  assert.ok(v.json().gates.every(g => g.state === 'passed' && g.source === 'shared' && g.runId), JSON.stringify(v.json().gates));
  assert.equal(v.json().store, f.store); assert.deepEqual(v.json().altered, []);
  const text = await apv(f.repo, ['gates', 'verify', '--commit', head.slice(0, 10)]);
  assert.equal(text.code, 0);
  assert.match(text.stdout, /lint\s+réussi\s+\S+\/lint\.json \(magasin partagé\)/);
  assert.match(text.stdout, /Magasin partagé des reçus : .*\.git\/apv\/receipts/);
  assert.match(text.stdout, /Preuve complète : 2 contrôle\(s\)/);
  // From another worktree of the repository, on another branch.
  git(f.repo, 'branch', 'ailleurs');
  const other = join(f.root, 'autre');
  git(f.repo, 'worktree', 'add', '-q', other, 'ailleurs');
  assert.equal((await apv(other, ['gates', 'verify', '--commit', head])).code, 0);
  // --skip-proven sees the proof too: the delivery does not run the suite twice.
  const skipped = await apv(other, ['gates', 'run', '--stage', 'full', '--skip-proven', '--json']);
  assert.equal(skipped.code, 0); assert.equal(skipped.json().skipped, true);
});

test('the shared store never proves another commit, a dirty run or another configuration', async t => {
  const f = project(t);
  const head = git(f.repo, 'rev-parse', 'HEAD');
  const delivery = copy(f, 'livraison');
  assert.equal((await apv(delivery, ['gates', 'run'])).code, 0);
  write(delivery, 'scratch.txt', 'uncommitted\n');
  assert.equal((await apv(delivery, ['gates', 'run'])).code, 0);
  git(f.repo, 'worktree', 'remove', '--force', delivery);
  // Another commit: no proof, whatever the previous one had.
  write(f.repo, 'docs/next.md', 'next\n'); git(f.repo, 'add', '-A'); git(f.repo, 'commit', '-qm', 'next');
  const next = await apv(f.repo, ['gates', 'verify', '--commit', 'HEAD', '--json']);
  assert.equal(next.code, 1);
  assert.deepEqual(next.json().missing, ['lint', 'unit']);
  assert.ok(next.json().gates.every(g => g.state === 'missing'));
  // The exact commit stays proven by its clean run; the later dirty run does not override it (it proves nothing).
  assert.equal((await apv(f.repo, ['gates', 'verify', '--commit', head])).code, 0);
  // Another configuration of the checks: ignored, as for local receipts.
  write(f.repo, 'other.json', { gates: [{ id: 'lint', ...node('process.exit(0)'), timeoutMs: 5000 }] });
  const other = await apv(f.repo, ['gates', 'verify', '--commit', head, '--config', 'other.json', '--json']);
  assert.equal(other.code, 1); assert.equal(other.json().gates[0].state, 'missing'); assert.ok(other.json().gates[0].otherConfig >= 1);
  // Only dirty runs at a commit: state dirty, from the shared store as from the worktree.
  const dirtyCopy = copy(f, 'sale');
  write(dirtyCopy, 'scratch.txt', 'uncommitted\n');
  assert.equal((await apv(dirtyCopy, ['gates', 'run'])).code, 0);
  git(f.repo, 'worktree', 'remove', '--force', dirtyCopy);
  const dirty = await apv(f.repo, ['gates', 'verify', '--commit', 'HEAD', '--json']);
  assert.equal(dirty.code, 1); assert.ok(dirty.json().gates.every(g => g.state === 'dirty'), JSON.stringify(dirty.json().gates));
});

test('an altered run of the shared store is refused as a whole, and reported', async t => {
  const f = project(t, { gates: [{ id: 'lint', ...node('process.exit(0)') }, { id: 'unit', ...node('process.exit(1)') }] });
  const head = git(f.repo, 'rev-parse', 'HEAD');
  const delivery = copy(f, 'livraison');
  const run = (await apv(delivery, ['gates', 'run', '--keep-going', '--json'])).json();
  git(f.repo, 'worktree', 'remove', delivery);
  const dir = run.sharedDirectory;
  assert.equal((await apv(f.repo, ['gates', 'verify', '--commit', head])).code, 1);
  // A failure turned into a success without its manifest: the digest differs, the whole run is refused.
  const pass = r => { r.status = 'passed'; r.exitCode = 0; r.diagnostic = ''; };
  rewrite(dir, 'unit.json', pass);
  let v = await apv(f.repo, ['gates', 'verify', '--commit', head, '--json']);
  assert.equal(v.code, 1);
  assert.deepEqual(v.json().gates.map(g => g.state), ['missing', 'missing']);
  assert.equal(v.json().altered.length, 1); assert.equal(v.json().altered[0].runId, run.runId);
  assert.match(v.json().altered[0].reason, /empreinte de unit\.json/);
  assert.match((await apv(f.repo, ['gates', 'verify', '--commit', head])).stdout, new RegExp(`refusées \\(altérées\\) : ${run.runId} \\(empreinte de unit\\.json`));
  // The manifest rewritten to match: the digests agree, the verdict is then the forged one. Stated limit: the
  // manifest detects an alteration of the files, not a forger who rewrites both (docs/CLI.md). What it still
  // refuses: a receipt that contradicts its run (another commit, another run, a file named after another check).
  rewrite(dir, 'unit.json', r => { r.candidateSha = 'f'.repeat(40); }, true);
  v = await apv(f.repo, ['gates', 'verify', '--commit', head, '--json']);
  assert.match(v.json().altered[0].reason, /unit\.json contredit son exécution/);
  // An added or a removed file: refused too.
  rewrite(dir, 'unit.json', r => { r.candidateSha = head; }, true);
  writeFileSync(join(dir, 'extra.json'), '{}');
  assert.match((await apv(f.repo, ['gates', 'verify', '--commit', head, '--json'])).json().altered[0].reason, /fichiers différents/);
  rmSync(join(dir, 'extra.json')); rmSync(join(dir, 'lint.json'));
  assert.match((await apv(f.repo, ['gates', 'verify', '--commit', head, '--json'])).json().altered[0].reason, /fichiers différents/);
  rmSync(join(dir, 'manifest.json'));
  assert.equal(readSharedRun(dir).intact, false);
  assert.match((await apv(f.repo, ['gates', 'verify', '--commit', head, '--json'])).json().altered[0].reason, /manifeste absent/);
  // An altered run cannot be exported either.
  const exported = await apv(f.repo, ['gates', 'receipts', 'export', run.runId, '--out', join(f.root, 'export')]);
  assert.equal(exported.code, 1); assert.match(exported.stderr, /RECEIPT_EXPORT.*refusée : manifeste absent/);
});

test('local receipts behave as before: read first, a run of the worktree hides its shared copy', async t => {
  const f = project(t);
  const head = git(f.repo, 'rev-parse', 'HEAD');
  const run = (await apv(f.repo, ['gates', 'run', '--json'])).json();
  let v = (await apv(f.repo, ['gates', 'verify', '--commit', head, '--json'])).json();
  assert.equal(v.ok, true); assert.ok(v.gates.every(g => g.source === 'local'));
  // The shared copy of a run the worktree has is not read: altering it changes nothing, nothing is reported.
  rewrite(run.sharedDirectory, 'unit.json', r => { r.status = 'failed'; r.exitCode = 1; });
  v = (await apv(f.repo, ['gates', 'verify', '--commit', head, '--json'])).json();
  assert.equal(v.ok, true); assert.deepEqual(v.altered, []);
  // Without any shared store (receipts written before it existed): the worktree alone proves, as before.
  rmSync(join(f.repo, '.git', 'apv'), { recursive: true, force: true });
  v = (await apv(f.repo, ['gates', 'verify', '--commit', head, '--json'])).json();
  assert.equal(v.ok, true); assert.ok(v.gates.every(g => g.source === 'local'));
  const text = await apv(f.repo, ['gates', 'verify', '--commit', head]);
  assert.doesNotMatch(text.stdout, /magasin partagé/);
  // The local directory is unchanged: receipts and summary only, never a manifest.
  assert.deepEqual(readdirSync(run.receiptsDirectory).sort(), ['lint.json', 'summary.json', 'unit.json']);
});

test('a shared store that cannot be written is reported; the run and its local receipts stand', { skip: process.getuid?.() === 0 && 'root ignores permissions' }, async t => {
  const f = project(t);
  mkdirSync(join(f.repo, '.git', 'apv'));
  chmodSync(join(f.repo, '.git', 'apv'), 0o500);
  t.after(() => { try { chmodSync(join(f.repo, '.git', 'apv'), 0o700); } catch { /* Already removed with the fixture. */ } });
  const run = await apv(f.repo, ['gates', 'run', '--json']);
  assert.equal(run.code, 0);
  assert.equal(run.json().sharedDirectory, null); assert.match(run.json().sharedError, /EACCES|permission/i);
  assert.match((await apv(f.repo, ['gates', 'run'])).stdout, /Attention : copie dans le magasin partagé impossible .*disparaîtront avec ce worktree/);
  assert.equal((await apv(f.repo, ['gates', 'verify', '--commit', 'HEAD'])).code, 0);
});

test('retention is bounded: keepRuns and keepDays from the configuration, prune on demand, other entries untouched', async t => {
  const f = project(t, { gates: [{ id: 'lint', ...node('process.exit(0)') }], receipts: { keepRuns: 2 } });
  const ids = [];
  for (let i = 0; i < 3; i++) {
    ids.push((await apv(f.repo, ['gates', 'run', '--json'])).json().runId);
    await new Promise(r => setTimeout(r, 1100)); // Run identifiers are to the second.
  }
  // The configuration keeps 2 runs: the oldest shared copy is gone, the local receipts are all there.
  assert.deepEqual(readdirSync(f.store).filter(n => !n.startsWith('.')).sort(), ids.slice(1).sort());
  assert.equal(readdirSync(join(f.repo, '.apv/receipts')).filter(n => n !== '.gitignore').length, 3);
  // A run older than keepDays (30 by default) goes, whatever keepRuns; a stale interrupted copy too; foreign entries stay.
  const old = '20200101T000000Z-0badc0de';
  cpSync(join(f.store, ids[2]), join(f.store, old), { recursive: true });
  mkdirSync(join(f.store, '.tmp-stale')); const past = new Date(Date.now() - 2 * 3_600_000); utimesSync(join(f.store, '.tmp-stale'), past, past);
  mkdirSync(join(f.store, '.tmp-fresh'));
  mkdirSync(join(f.store, 'notes'));
  const pruned = await apv(f.repo, ['gates', 'receipts', 'prune', '--json']);
  assert.equal(pruned.code, 0);
  assert.deepEqual(pruned.json().removed, [old]); assert.equal(pruned.json().kept, 2); assert.equal(pruned.json().temporary, 1);
  assert.deepEqual(readdirSync(f.store).sort(), ['.tmp-fresh', 'notes', ...ids.slice(1)].sort());
  // Options replace the configuration.
  const one = await apv(f.repo, ['gates', 'receipts', 'prune', '--keep-runs', '1']);
  assert.match(one.stdout, /1 exécution\(s\) retirée\(s\), 1 gardée\(s\) \(30 jours, 1 exécutions au plus\)/);
  assert.deepEqual(readdirSync(f.store).filter(n => !n.startsWith('.') && n !== 'notes'), [ids[2]]);
  assert.equal((await apv(f.repo, ['gates', 'receipts', 'prune', '--keep-days', '0'])).code, 2);
  // The library bound: keepDays measured on the start written in the identifier.
  assert.equal(runTime(ids[2]) <= Date.now(), true);
  assert.deepEqual(pruneStore(f.store, { keepDays: 1, keepRuns: 5 }, Date.now() + 2 * 86_400_000).removed, [ids[2]]);
  assert.throws(() => pruneStore(f.store, { keepDays: 0, keepRuns: 5 }), /keepDays/);
  // The configuration section is validated.
  write(f.repo, '.apv/config.json', { gates: [{ id: 'lint', ...node('process.exit(0)') }], receipts: { keepRuns: 0 } });
  assert.match((await apv(f.repo, ['gates', 'run'])).stderr, /receipts\.keepRuns/);
});

test('receipts list and export: runs of the worktree and of the shared store, export with digests', async t => {
  const f = project(t);
  const head = git(f.repo, 'rev-parse', 'HEAD');
  const local = (await apv(f.repo, ['gates', 'run', '--json'])).json();
  const delivery = copy(f, 'livraison');
  const shared = (await apv(delivery, ['gates', 'run', '--json'])).json();
  git(f.repo, 'worktree', 'remove', delivery);
  const list = await apv(f.repo, ['gates', 'receipts', 'list', '--json']);
  assert.equal(list.code, 0);
  const runs = Object.fromEntries(list.json().runs.map(r => [r.runId, r]));
  assert.equal(runs[local.runId].local !== null && runs[local.runId].shared !== null, true);
  assert.equal(runs[shared.runId].local, null); assert.equal(runs[shared.runId].intact, true);
  assert.equal(runs[shared.runId].candidateSha, head); assert.equal(runs[shared.runId].ok, true); assert.equal(runs[shared.runId].dirty, false);
  const text = await apv(f.repo, ['gates', 'receipts', 'list', '--commit', 'HEAD', '--limit', '1']);
  assert.match(text.stdout, /Exécutions \(1 sur 2, commit [0-9a-f]{12}\)/);
  assert.match(text.stdout, /exécution\s+commit\s+stage\s+verdict\s+arbre\s+emplacement/);
  assert.equal((await apv(f.repo, ['gates', 'receipts', 'list', '--commit', 'nope'])).code, 1);

  const out = join(f.root, 'export');
  const exported = await apv(f.repo, ['gates', 'receipts', 'export', shared.runId, '--out', out, '--json']);
  assert.equal(exported.code, 0, exported.stderr);
  assert.equal(exported.json().source, 'shared');
  const dir = join(out, shared.runId);
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  for (const [name, digest] of Object.entries(manifest.files)) assert.equal(sha256(readFileSync(join(dir, name))), digest);
  assert.equal(readSharedRun(dir).intact, true);
  const fromLocal = await apv(f.repo, ['gates', 'receipts', 'export', local.runId, '--out', out]);
  assert.equal(fromLocal.code, 0); assert.match(fromLocal.stdout, /exportée \(worktree\)/);
  assert.equal(readSharedRun(join(out, local.runId)).intact, true);
  // Refusals: destination already there, unknown run, invalid identifier, missing --out, foreign option.
  assert.match((await apv(f.repo, ['gates', 'receipts', 'export', shared.runId, '--out', out])).stderr, /existe déjà/);
  assert.match((await apv(f.repo, ['gates', 'receipts', 'export', '20200101T000000Z-00000000', '--out', out])).stderr, /introuvable/);
  assert.match((await apv(f.repo, ['gates', 'receipts', 'export', '../x', '--out', out])).stderr, /invalide/);
  assert.equal((await apv(f.repo, ['gates', 'receipts', 'export', shared.runId])).code, 2);
  assert.equal((await apv(f.repo, ['gates', 'receipts', 'list', '--out', out])).code, 2);
  assert.equal((await apv(f.repo, ['gates', 'receipts'])).code, 2);
  assert.equal((await apv(f.repo, ['gates', 'run', '--limit', '3'])).code, 2);
});

test('verify --commit-config reads the checks declared by the verified commit, not by the checkout', async t => {
  const f = project(t);
  git(f.repo, 'checkout', '-q', '-b', 'apv/spec');
  write(f.repo, '.apv/config.json', { gates: [...gates, { id: 'e2e', stage: 'full', ...node('process.exit(0)') }] });
  git(f.repo, 'add', '-A'); git(f.repo, 'commit', '-qm', 'e2e');
  const head = git(f.repo, 'rev-parse', 'HEAD');
  git(f.repo, 'checkout', '-q', 'main');
  const delivery = copy(f, 'livraison', head);
  assert.equal((await apv(delivery, ['gates', 'run', '--stage', 'full'])).code, 0);
  git(f.repo, 'worktree', 'remove', delivery);
  // The main checkout declares two checks, the commit three: compared with the checkout, another configuration.
  const checkout = await apv(f.repo, ['gates', 'verify', '--commit', head, '--json']);
  assert.equal(checkout.code, 1); assert.ok(checkout.json().gates.every(g => g.otherConfig >= 1));
  const atCommit = await apv(f.repo, ['gates', 'verify', '--commit', head, '--commit-config', '--json']);
  assert.equal(atCommit.code, 0, JSON.stringify(atCommit.json()));
  assert.deepEqual(atCommit.json().required, ['lint', 'unit', 'e2e']);
  assert.equal(atCommit.json().config, `${head}:.apv/config.json`);
  assert.equal((await apv(f.repo, ['gates', 'verify', '--commit', head, '--commit-config', '--config', 'x.json'])).code, 2);
  assert.equal((await apv(f.repo, ['gates', 'run', '--commit-config'])).code, 2);
  assert.equal((await apv(f.repo, ['gates', 'verify', '--commit', 'nope', '--commit-config'])).code, 1);
});
