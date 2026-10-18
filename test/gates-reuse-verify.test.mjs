import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, git } from './helpers.mjs';
import { apv, write } from './cli-helpers.mjs';
import { loadConfig } from '../dist/config/load.js';
import { validateReceipt } from '../dist/domain/contracts.js';
import { Git } from '../dist/execution/git.js';
import { verifyGates } from '../dist/gates/verify.js';
import { DEFAULT_REUSE_MAX_AGE_MS, inputsDigest } from '../dist/gates/reuse.js';

/**
 * PR A0 of docs/ACCELERATION-LOTS.md (5.5, AC-REUSE-A0): no tool writes a receipt `cached` yet, but `apv gates verify`
 * already refuses any such receipt whose reuse does not check out against Git and the store, and accepts a correct one.
 * The receipts `cached` here are written by hand, as A1 will write them: origin = a real run of `apv gates run`.
 */

const sha256 = text => createHash('sha256').update(text).digest('hex');
const node = code => [process.execPath, '-e', code];
const gates = [{ id: 'lint', command: node('process.exit(0)') }, { id: 'unit', command: node('process.exit(0)') }];
const HOUR = 3_600_000;

/** A project whose suite passed at C (the origin), then C' with the same tree (an empty commit, as a new lot head). */
async function proven(t) {
  const f = fixture(t);
  write(f.repo, '.apv/config.json', { gates });
  git(f.repo, 'add', '-A'); git(f.repo, 'commit', '-qm', 'config');
  const from = git(f.repo, 'rev-parse', 'HEAD');
  const run = await apv(f.repo, ['gates', 'run', '--stage', 'full', '--json']);
  assert.equal(run.code, 0, run.stdout);
  const runId = run.json().runId;
  git(f.repo, 'commit', '-q', '--allow-empty', '-m', 'tête du lot');
  const head = git(f.repo, 'rev-parse', 'HEAD');
  const local = join(f.repo, '.apv', 'receipts');
  const store = join(f.repo, '.git', 'apv', 'receipts');
  const origin = gate => JSON.parse(readFileSync(join(local, runId, `${gate}.json`), 'utf8'));
  return { ...f, from, head, runId, local, store, origin, config: loadConfig(f.repo).config };
}

/** A run directory of the worktree with its summary and receipts (as `apv gates run` writes it). */
function writeRun(p, candidateSha, receipts, runId = `20261018T120000Z-${randomUUID().slice(0, 8)}`) {
  const dir = join(p.local, runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'summary.json'), JSON.stringify({ runId, candidateSha, baseSha: null, dirty: false, stage: 'full', ok: true }));
  for (const r of receipts) writeFileSync(join(dir, `${r.gateId}.json`), JSON.stringify({ ...r, runId }));
  return runId;
}

/** The receipt `cached` A1 would write at C' for `gate`, from its origin at C; `change` alters it. */
async function cached(p, gate, change = r => r) {
  const o = p.origin(gate);
  const digest = (await inputsDigest(new Git(), p.repo, p.head)).digest;
  const { nearTimeout, lockWaitMs, ...rest } = o;
  return change({ ...rest, id: randomUUID(), candidateSha: p.head, status: 'cached', reusedFrom: o.id, startedAt: o.startedAt + 1000, durationMs: 0,
    reuse: { fromRun: p.runId, fromCommit: p.from, basis: 'tree', inputsDigest: digest, ignoreDigest: sha256(JSON.stringify([])), environment: o.environmentHash, changed: 0, files: [] } });
}

/** Proof of C' by a receipt `cached` for each check (the run of C' holds only reused receipts). */
async function reuseAll(p, change = (r, gate) => r) {
  return writeRun(p, p.head, await Promise.all(gates.map(g => cached(p, g.id, r => change(r, g.id)))));
}

/** Verification of C' two seconds after the latest origin (a fixed clock: the age check is deterministic). */
const verify = (p, extra = {}) => verifyGates({ repo: p.repo, config: p.config, commit: p.head, now: extra.now ?? Math.max(...gates.map(g => p.origin(g.id).startedAt)) + 2000, ...extra });
const unitOf = result => result.gates.find(g => g.gateId === 'unit');

test('AC-REUSE-A0 accepted: a reused receipt whose origin, tree, digests and age check out proves its check', async t => {
  const p = await proven(t);
  // Without receipts at C', nothing proves it (no fallback to the commit of the origin).
  assert.equal((await verify(p)).ok, false);
  await reuseAll(p);
  const result = await verify(p);
  assert.equal(result.ok, true, JSON.stringify(result.gates));
  assert.deepEqual(result.reused, ['lint', 'unit']);
  const unit = unitOf(result);
  assert.equal(unit.state, 'passed'); assert.equal(unit.status, 'cached');
  assert.deepEqual({ ...unit.reuse, origin: null }, { proven: true, reason: 'arbre identique', fromRun: p.runId, fromCommit: p.from, basis: 'tree', origin: null });
  const text = await apv(p.repo, ['gates', 'verify', '--commit', p.head]);
  assert.equal(text.code, 0, text.stdout);
  assert.match(text.stdout, new RegExp(`unit\\s+réutilisé de ${p.from.slice(0, 12)} \\(arbre identique\\)`));
  assert.match(text.stdout, /Reçus réutilisés \(cached\), recontrôlés depuis Git et le magasin/);
  assert.match(text.stdout, /- unit : prouvé : arbre identique \(origine \S+\/unit\.json au commit [0-9a-f]{12}\)/);
});

test('AC-REUSE-A0 accepted: the origin is read from the shared store when the worktree no longer has its run', async t => {
  const p = await proven(t);
  const origins = Object.fromEntries(gates.map(g => [g.id, p.origin(g.id)]));
  p.origin = gate => origins[gate];
  await reuseAll(p);
  rmSync(join(p.local, p.runId), { recursive: true });
  assert.ok(existsSync(join(p.store, p.runId)));
  const result = await verify(p);
  assert.equal(result.ok, true, JSON.stringify(result.gates));
  assert.deepEqual(result.reused, ['lint', 'unit']);
});

test('AC-REUSE-A0 refused: a receipt cached without reuse record, or targeted', async t => {
  const p = await proven(t);
  await reuseAll(p, (r, gate) => {
    if (gate === 'unit') { const { reuse, ...rest } = r; return rest; }
    return { ...r, targeted: true };
  });
  const result = await verify(p);
  assert.equal(result.ok, false);
  const unit = unitOf(result);
  assert.equal(unit.state, 'reuse');
  assert.equal(unit.reuse.proven, false);
  assert.match(unit.reuse.reason, /reçu sans relevé reuse/);
  // A targeted receipt never counts at stage full anyway: no clean complete receipt left, missing.
  assert.equal(result.gates.find(g => g.gateId === 'lint').state, 'missing');
  // Exit 1 with the reason, through the command.
  const text = await apv(p.repo, ['gates', 'verify', '--commit', p.head]);
  assert.equal(text.code, 1);
  assert.match(text.stdout, /unit\s+reçu réutilisé non prouvant/);
  assert.match(text.stdout, /- unit : NE PROUVE RIEN : reçu sans relevé reuse/);
  assert.match(text.stdout, /Manque : .*unit \(reçu réutilisé non prouvant\)/);
  const json = (await apv(p.repo, ['gates', 'verify', '--commit', p.head, '--json'])).json();
  assert.equal(json.gates.find(g => g.gateId === 'unit').state, 'reuse');
});

test('AC-REUSE-A0 refused: origin absent from the worktree and the shared store (retention), or absent from its run', async t => {
  const p = await proven(t);
  await reuseAll(p, (r, gate) => gate === 'unit' ? r : { ...r, reusedFrom: randomUUID() });
  const origins = p.origin('unit');
  rmSync(join(p.local, p.runId), { recursive: true });
  rmSync(join(p.store, p.runId), { recursive: true });
  const result = await verify(p, { now: origins.startedAt + 2000 });
  assert.equal(result.ok, false);
  assert.equal(unitOf(result).state, 'reuse');
  assert.match(unitOf(result).reuse.reason, /exécution d'origine \S+ absente du worktree et du magasin partagé/);
});

test('AC-REUSE-A0 refused: an origin id that is not in its run', async t => {
  const p = await proven(t);
  await reuseAll(p, (r, gate) => gate === 'unit' ? { ...r, reusedFrom: randomUUID() } : r);
  const unit = unitOf(await verify(p));
  assert.equal(unit.state, 'reuse');
  assert.match(unit.reuse.reason, /reçu d'origine \S+ absent de l'exécution \S+ du worktree/);
});

test('AC-REUSE-A0 refused: an origin run altered in the shared store', async t => {
  const p = await proven(t);
  const o = p.origin('unit'); const lint = p.origin('lint');
  p.origin = gate => gate === 'unit' ? o : lint;
  await reuseAll(p);
  rmSync(join(p.local, p.runId), { recursive: true });
  const file = join(p.store, p.runId, 'unit.json');
  writeFileSync(file, readFileSync(file, 'utf8').replace('"passed"', '"passed" '));
  const unit = unitOf(await verify(p));
  assert.equal(unit.state, 'reuse');
  assert.match(unit.reuse.reason, /exécution d'origine \S+ refusée, altérée dans le magasin partagé : empreinte de unit\.json différente/);
});

/** Rewrites the origin receipt of `gate` in the worktree (not protected by a manifest: read as is, like any local receipt). */
function rewriteOrigin(p, gate, change) {
  const file = join(p.local, p.runId, `${gate}.json`);
  writeFileSync(file, JSON.stringify(change(JSON.parse(readFileSync(file, 'utf8')))));
}

test('AC-REUSE-A0 refused: an origin passed after retry, cached (no chain), dirty, of another configuration', async t => {
  const cases = [
    [o => ({ ...o, status: 'passed_after_retry', retry: { command: ['true'], first: { status: 'failed', exitCode: 1, durationMs: 1, stdoutHash: '', stderrHash: '', diagnostic: '' }, output: '', tests: [] } }), /origine passed_after_retry : seul un reçu exécuté et réussi au premier passage/],
    [o => ({ ...o, status: 'cached', reusedFrom: randomUUID() }), /origine cached : seul un reçu exécuté/],
    [o => ({ ...o, dirty: true }), /origine écrite sur un arbre modifié/],
    [o => ({ ...o, configHash: 'f'.repeat(64) }), /origine écrite pour une autre configuration des contrôles/],
    [o => ({ ...o, gateId: 'lint' }), /reçu d'origine d'un autre contrôle \(lint\)/],
    [o => ({ ...o, targeted: true }), /origine ciblée/],
  ];
  for (const [change, reason] of cases) {
    const p = await proven(t);
    await reuseAll(p);
    rewriteOrigin(p, 'unit', change);
    const result = await verify(p);
    assert.equal(result.ok, false, String(reason));
    assert.equal(unitOf(result).state, 'reuse', String(reason));
    assert.match(unitOf(result).reuse.reason, reason);
    assert.equal(result.gates.find(g => g.gateId === 'lint').state, 'passed');
  }
});

test('AC-REUSE-A0 refused: an origin too old, dated after its reuse or in the future; accepted just under the age', async t => {
  const p = await proven(t);
  await reuseAll(p);
  const start = p.origin('unit').startedAt;
  const earliest = Math.min(start, p.origin('lint').startedAt);
  assert.equal((await verify(p, { now: earliest + DEFAULT_REUSE_MAX_AGE_MS })).ok, true);
  const old = await verify(p, { now: start + DEFAULT_REUSE_MAX_AGE_MS + HOUR });
  assert.equal(old.ok, false);
  assert.equal(unitOf(old).state, 'reuse');
  assert.match(unitOf(old).reuse.reason, /origine trop vieille \(25 h, au plus 24 h\) : l'âge ne se renouvelle jamais par une reprise/);
  assert.match(unitOf(await verify(p, { now: start - 1 })).reuse.reason, /origine datée après sa reprise ou dans le futur/);
  const q = await proven(t);
  await reuseAll(q, r => ({ ...r, startedAt: r.startedAt - 5000 }));
  assert.match(unitOf(await verify(q)).reuse.reason, /origine datée après sa reprise ou dans le futur/);
});

test('AC-REUSE-A0 refused: another tree, another declared commit, an unknown commit', async t => {
  const p = await proven(t);
  writeFileSync(join(p.repo, 'README.md'), '# Changed\n');
  git(p.repo, 'commit', '-qam', 'autre arbre');
  p.head = git(p.repo, 'rev-parse', 'HEAD');
  await reuseAll(p);
  const unit = unitOf(await verify(p));
  assert.equal(unit.state, 'reuse');
  assert.match(unit.reuse.reason, /arbre de [0-9a-f]{12} différent de celui de [0-9a-f]{12} \(basis tree\)/);

  const q = await proven(t);
  await reuseAll(q, (r, gate) => gate === 'unit' ? { ...r, reuse: { ...r.reuse, fromCommit: q.head } } : { ...r, reuse: { ...r.reuse, fromCommit: '0'.repeat(40) } });
  const result = await verify(q);
  assert.match(unitOf(result).reuse.reason, /reçu d'origine au commit [0-9a-f]{12}, pas au commit déclaré/);
  assert.match(result.gates.find(g => g.gateId === 'lint').reuse.reason, /reçu d'origine au commit/);

  // Origin and receipt agree on a commit the repository does not have: its tree cannot be recomputed.
  const u = await proven(t);
  const unknown = '0123456789abcdef'.repeat(2) + '01234567';
  await reuseAll(u, (r, gate) => gate === 'unit' ? { ...r, reuse: { ...r.reuse, fromCommit: unknown } } : r);
  rewriteOrigin(u, 'unit', o => ({ ...o, candidateSha: unknown }));
  const lost = unitOf(await verify(u));
  assert.equal(lost.state, 'reuse');
  assert.match(lost.reuse.reason, /commit d'origine 0123456789ab introuvable dans le dépôt/);
});

test('AC-REUSE-A0 refused: a run of the same tree altered in the shared store could hide a later failure', async t => {
  const p = await proven(t);
  // A second run, at C' (same tree), whose shared copy is then altered and whose worktree copy is gone.
  // --replay all: a second run that executes on the same tree (A1 would reuse the first).
  const again = await apv(p.repo, ['gates', 'run', '--stage', 'full', '--replay', 'all', '--json']);
  assert.equal(again.code, 0, again.stdout);
  const second = again.json().runId;
  rmSync(join(p.local, second), { recursive: true });
  const file = join(p.store, second, 'unit.json');
  writeFileSync(file, readFileSync(file, 'utf8').replace('"passed"', '"failed"'));
  await reuseAll(p);
  const result = await verify(p);
  assert.ok(result.altered.some(a => a.runId === second), 'reported as altered, never counted');
  assert.equal(unitOf(result).state, 'reuse');
  assert.match(unitOf(result).reuse.reason, new RegExp(`exécution ${second} du même arbre altérée dans le magasin partagé : un échec plus récent ne peut pas être exclu`));
});

test('AC-REUSE-A0 refused: a later failed run of the same tree whose manifest is made unreadable (« { ») still blocks the reuse', async t => {
  const p = await proven(t);
  // --replay all: a second run that executes on the same tree (A1 would reuse the first).
  const again = await apv(p.repo, ['gates', 'run', '--stage', 'full', '--replay', 'all', '--json']);
  assert.equal(again.code, 0, again.stdout);
  const second = again.json().runId;
  rmSync(join(p.local, second), { recursive: true });
  const file = join(p.store, second, 'unit.json');
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), status: 'failed', exitCode: 1 }));
  // Without its manifest the run names no commit: the scan of the same tree used to skip it, and the failure was hidden.
  writeFileSync(join(p.store, second, 'manifest.json'), '{');
  await reuseAll(p);
  const result = await verify(p);
  assert.equal(result.ok, false);
  assert.ok(result.altered.some(a => a.runId === second), 'reported as altered, never counted');
  assert.equal(unitOf(result).state, 'reuse');
  assert.match(unitOf(result).reuse.reason, new RegExp(`exécution ${second} du magasin partagé au manifeste absent ou illisible : son commit est inconnu, un échec plus récent sur le même arbre ne peut pas être exclu`));
});

test('AC-REUSE-A0 refused: another environment, other output digests, inputs digest or files declared, basis inputs', async t => {
  const cases = [
    [r => ({ ...r, reuse: { ...r.reuse, environment: 'e'.repeat(64) } }), /identité d'environnement différente de celle de l'origine/],
    [r => ({ ...r, stdoutHash: 'a'.repeat(64) }), /empreintes de sortie différentes de celles de l'origine/],
    [r => ({ ...r, reuse: { ...r.reuse, inputsDigest: 'a'.repeat(64) } }), /empreinte des entrées différente de celle recalculée au commit/],
    [r => ({ ...r, reuse: { ...r.reuse, changed: 1, files: ['README.md'] } }), /reprise à arbre identique qui déclare des fichiers changés/],
    [r => ({ ...r, reuse: { ...r.reuse, ignoreDigest: sha256(JSON.stringify(['docs/**'])) } }), /reprise à arbre identique qui déclare des fichiers ignorés/],
    [r => ({ ...r, reuse: { ...r.reuse, basis: 'inputs' } }), /reprise par entrées identiques \(basis inputs\) : reuse\.ignore se lit à la base commune avec la cible : aucune cible/],
  ];
  for (const [change, reason] of cases) {
    const p = await proven(t);
    await reuseAll(p, (r, gate) => gate === 'unit' ? change(r) : r);
    const result = await verify(p);
    assert.equal(result.ok, false, String(reason));
    assert.equal(unitOf(result).state, 'reuse', String(reason));
    assert.match(unitOf(result).reuse.reason, reason);
  }
});

test('AC-REUSE-A0 refused: a later failure, or a later pass after retry, on the same tree wins over the origin', async t => {
  for (const status of ['failed', 'passed_after_retry']) {
    const p = await proven(t);
    const o = p.origin('unit');
    const extra = status === 'failed' ? { exitCode: 1 } : { exitCode: 0, retry: { command: ['true'], first: { status: 'failed', exitCode: 1, durationMs: 1, stdoutHash: '', stderrHash: '', diagnostic: '' }, output: '', tests: [] } };
    // At C (the origin's commit, same tree), a run after the origin failed.
    const { nearTimeout, lockWaitMs, ...rest } = o;
    writeRun(p, p.from, [{ ...rest, id: randomUUID(), status, startedAt: o.startedAt + 500, ...extra }]);
    await reuseAll(p);
    const unit = unitOf(await verify(p));
    assert.equal(unit.state, 'reuse', status);
    assert.match(unit.reuse.reason, new RegExp(`échec plus récent sur le même arbre : \\S+/unit\\.json \\(${status}`));
  }
  // An earlier failure, or a later one on another tree, does not.
  const q = await proven(t);
  const o = q.origin('unit');
  const { nearTimeout, lockWaitMs, ...rest } = o;
  writeRun(q, q.from, [{ ...rest, id: randomUUID(), status: 'failed', exitCode: 1, startedAt: o.startedAt - 500 }]);
  const before = git(q.repo, 'rev-parse', 'HEAD~2');
  writeRun(q, before, [{ ...rest, id: randomUUID(), candidateSha: before, status: 'failed', exitCode: 1, startedAt: o.startedAt + 500 }]);
  await reuseAll(q);
  assert.equal((await verify(q)).ok, true, JSON.stringify((await verify(q)).gates));
});

test('AC-REUSE-A0: the receipt contract keeps reuse to receipts cached, and verify still requires a receipt at the exact commit', async t => {
  const p = await proven(t);
  const good = await cached(p, 'unit');
  assert.equal(validateReceipt(good).reuse.basis, 'tree');
  assert.throws(() => validateReceipt({ ...good, status: 'passed', reusedFrom: null }), /Only a cached receipt records a reuse/);
  assert.throws(() => validateReceipt({ ...good, reuse: { ...good.reuse, basis: 'arbre' } }));
  // A cached receipt of C' does not prove C, and the origin alone does not prove C'.
  await reuseAll(p);
  const atFrom = await verifyGates({ repo: p.repo, config: p.config, commit: p.from });
  assert.equal(atFrom.ok, true);
  assert.deepEqual(atFrom.reused, []);
  assert.ok(readdirSync(p.local).length >= 2);
});

test('the inputs digest is unambiguous: a file name with a line feed and a tab never imitates two files (relecture sécurité de A0)', async t => {
  const f = fixture(t);
  // Tree 1: files a and b. Tree 2: a single file whose name carries, after a line feed, the line of b in the former
  // encoding (`mode blob<TAB>path` joined by line feeds): both trees gave the same digest.
  writeFileSync(join(f.repo, 'a'), 'A\n'); writeFileSync(join(f.repo, 'b'), 'B\n');
  git(f.repo, 'add', '-A'); git(f.repo, 'commit', '-qm', 'a et b');
  const one = git(f.repo, 'rev-parse', 'HEAD');
  const blobB = git(f.repo, 'rev-parse', `${one}:b`);
  git(f.repo, 'rm', '-q', 'a', 'b');
  for (const p of ['README.md', 'docs/guide.md', 'src/math.mjs', 'test/math.test.mjs', '.gitignore']) git(f.repo, 'rm', '-q', p);
  writeFileSync(join(f.repo, `a\n100644 ${blobB}\tb`), 'A\n');
  git(f.repo, 'add', '-A'); git(f.repo, 'commit', '-qm', 'un seul fichier au nom piège');
  const two = git(f.repo, 'rev-parse', 'HEAD');
  const entries = commit => git(f.repo, 'ls-tree', '-r', '-z', '--full-tree', commit).split('\0').filter(Boolean)
    .filter(e => ['a', 'b'].includes(e.slice(e.indexOf('\t') + 1)) || e.includes('\n'));
  // The former encoding, on the files of both trees that matter here: the same text, hence the same digest.
  const former = commit => entries(commit).map(e => { const tab = e.indexOf('\t'); const [mode, , blob] = e.slice(0, tab).split(' '); return `${mode} ${blob}\t${e.slice(tab + 1)}`; })
    .sort((x, y) => { const px = x.slice(x.indexOf('\t') + 1); const py = y.slice(y.indexOf('\t') + 1); return px < py ? -1 : px > py ? 1 : 0; }).join('\n');
  assert.equal(former(two), former(one), 'the trap does collide under the former encoding');
  // The digest of the whole trees now differs.
  const g = new Git();
  git(f.repo, 'checkout', '-q', one);
  const d1 = await inputsDigest(g, f.repo, one);
  const d2 = await inputsDigest(g, f.repo, two);
  assert.notEqual(d1.digest, d2.digest);
  // On trees reduced to exactly those files, too (the former encoding of the whole trees was then equal).
  const only = async (from, keep) => {
    git(f.repo, 'checkout', '-q', '--detach', from);
    for (const e of git(f.repo, 'ls-files', '-z').split('\0').filter(Boolean)) if (!keep.includes(e)) git(f.repo, 'rm', '-q', '--', e);
    git(f.repo, 'commit', '-qm', 'réduit');
    return git(f.repo, 'rev-parse', 'HEAD');
  };
  const small1 = await only(one, ['a', 'b']);
  // `two` already holds only the trap file: its whole tree read in the former encoding was the text of `small1`.
  const small2 = two;
  assert.deepEqual(git(f.repo, 'ls-tree', '-r', '-z', '--name-only', two).split('\0').filter(Boolean), [`a\n100644 ${blobB}\tb`]);
  assert.notEqual((await inputsDigest(g, f.repo, small1)).digest, (await inputsDigest(g, f.repo, small2)).digest);
  assert.equal((await inputsDigest(g, f.repo, small2)).files, 1);
});
