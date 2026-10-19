import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { apv } from './cli-helpers.mjs';
import { ALL_CAPTURES, commonDirOf, operatorSays, png, seedReview } from './support/rules.mjs';
import { latestReviews, recordReview } from '../dist/rules/reviews.js';

/**
 * Part B of docs/ACCELERATION-LOTS.md: a review recorded at C counts at C' for donnees and rgpd when the delta C..C'
 * leaves the perimeter of the domain; securite and fidelite never (decision of the lead on the third security review of
 * #141, M3 and M4: the report of fidelite and of the captures comes back with the fingerprint of the build output, part A),
 * a review of the delta (`--delta-from`) instead, its captures joined for fidelite. Each criterion AC-CARRY-* has its
 * refusal and its acceptance.
 */

const identity = { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@localhost', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@localhost' };
const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args],
  { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...identity } }).trim();
const put = (root, path, value) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), typeof value === 'string' || Buffer.isBuffer(value) ? value : `${JSON.stringify(value, null, 2)}\n`); };
const short = sha => sha.slice(0, 12);

const SITE = {
  'package.json': { name: 'site', devDependencies: { '@sveltejs/kit': '2.0.0', svelte: '5.0.0' } },
  'src/routes/compte/+page.svelte': '<script>import Header from "$lib/components/Header.svelte";</script>\n<Header />\n',
  'src/lib/components/Header.svelte': '<header>Compte</header>\n',
  'src/app.html': '<!doctype html><html><body>%sveltekit.body%</body></html>\n',
};
/** The change C: a screen whose text names an e-mail (fidelite and rgpd retained, securite always). */
const PAGE = { 'src/routes/carte/+page.svelte': '<p class="carte">Votre email de contact</p>\n' };
/** A delta of a test and its two reference images (the commit ec2c6ece of the pilot project, #262). */
const TEST_ONLY = (n = 1) => ({
  'tests/e2e/carte.e2e.ts': `import { test } from "@playwright/test";\ntest("carte ${n}", async () => {});\n`,
  'tests/e2e/carte.e2e.ts-snapshots/carte-1280.png': png(10 + n),
  'tests/e2e/carte.e2e.ts-snapshots/carte-390.png': png(40 + n),
});

/** main holds `files` (SITE) and `base`, `config` merged into .apv/config.json; feat, created, has no commit yet. */
function site(t, { base = {}, config = {}, files = SITE } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'apv3-report-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = join(root, 'origin.git');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  const repo = join(root, 'repo');
  git(root, 'clone', '-q', origin, repo);
  git(repo, 'switch', '-q', '-c', 'main');
  put(repo, '.apv/config.json', { name: 'essai', gates: [{ id: 'unit', stage: 'full', command: [process.execPath, '-e', '0'] }], ...config, rules: { mode: 'strict', ...config.rules } });
  put(repo, 'README.md', 'projet\n');
  for (const [path, value] of Object.entries({ ...files, ...base })) put(repo, path, value);
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'base'); git(repo, 'push', '-q', 'origin', 'main');
  git(repo, 'switch', '-q', '-c', 'feat');
  /** `links`: submodule links (mode 160000) set to a commit id, `{ path: sha }`; the folder stays empty (not checked out). */
  const commit = (files, message = 'suite', links = {}) => {
    for (const [path, value] of Object.entries(files)) put(repo, path, value);
    git(repo, 'add', '-A');
    for (const [path, sha] of Object.entries(links)) { mkdirSync(join(repo, path), { recursive: true }); git(repo, 'update-index', '--add', '--cacheinfo', `160000,${sha},${path}`); }
    git(repo, 'commit', '-q', '--allow-empty', '-m', message);
    return git(repo, 'rev-parse', 'HEAD');
  };
  const check = async sha => {
    const r = await apv(repo, ['rules', 'check', '--commit', sha, '--target', 'origin/main', '--json']);
    return r.json();
  };
  const text = async sha => (await apv(repo, ['rules', 'check', '--commit', sha, '--target', 'origin/main'])).stdout;
  return { repo, commit, check, text };
}

/** main holds `site` (SITE) and `base`; feat adds PAGE at C, reviewed in every domain of its plan but `skip` (four captures for fidelite). */
async function reviewed(t, { change = PAGE, skip = [], fidelityCaptures = ALL_CAPTURES, links = {}, site: files = SITE, config = {}, base = {} } = {}) {
  const s = site(t, { base, config, files });
  const c = s.commit(change, 'change', links);
  const retained = rule(await s.check(c), 'relecture').detail.replace(/^.*: /, '').split(', ');
  for (const d of retained.filter(x => !skip.includes(x))) seedReview(s.repo, c, d, { captures: d === 'fidelite' ? fidelityCaptures : [] });
  if (!skip.length) assert.equal(rule(await s.check(c), 'relecture').status, 'ok');
  return { ...s, c, retained };
}
const rule = (report, id) => report.rules.find(r => r.rule === id);
const domain = (report, d) => rule(report, 'relecture').domains.find(x => x.domain === d);
const diffFiles = (repo, from, to) => git(repo, 'diff', '--name-only', '--no-renames', from, to).split('\n').filter(Boolean).sort();
/** What a head without a fidelity review says, when a usable one at `from` lies below it on the branch. */
const FID_NEVER = from => `relecture fidelite : jamais reportée sans relire (elle reviendra avec l'empreinte du build) ; relecture du delta possible : apv review record --delta-from ${short(from)}`;
/** fidelite at `head`: missing, never reported, a review of the delta from `from` offered. */
function fidelityNeverReported(report, head, from, label = '') {
  const fid = domain(report, 'fidelite');
  assert.equal(fid.status, 'missing', `${label} ${JSON.stringify(fid)}`);
  assert.equal(fid.detail, `aucune relecture enregistrée à ${short(head)} ; ${FID_NEVER(from)}`, label);
}

test('AC-CARRY-FID, AC-USER-2: a delta of a test and two images keeps rgpd of C, said; fidelite and securite are never reported, each asked as a review of the delta', async t => {
  const p = await reviewed(t);
  assert.deepEqual(p.retained.sort(), ['fidelite', 'rgpd', 'securite']);
  const c2 = p.commit(TEST_ONLY());
  const report = await p.check(c2);
  assert.equal(domain(report, 'rgpd').status, 'recorded', JSON.stringify(domain(report, 'rgpd')));
  assert.match(domain(report, 'rgpd').detail, new RegExp(`relecture rgpd reportée de ${short(p.c)} \\(delta sans fichier de son périmètre : 3 fichiers`));
  // fidelite: never reported without a review (third security review of #141, M3, M4), its captures required at C'.
  fidelityNeverReported(report, c2, p.c);
  const captures = rule(report, 'captures');
  assert.equal(captures.status, 'refused', JSON.stringify(captures));
  assert.deepEqual(captures.problems, [`capture(s) absente(s) de la relecture fidelite à ${short(c2)} : ${ALL_CAPTURES.map(c => c.join(":")).join(', ')}`]);
  // securite: refused even for a delta of tests alone (AC-CARRY-SEC), with the review of the delta it can take.
  const relecture = rule(report, 'relecture');
  assert.equal(relecture.status, 'refused');
  assert.equal(domain(report, 'securite').status, 'missing');
  assert.deepEqual([...relecture.problems].sort(), [`fidelite : aucune relecture enregistrée à ${short(c2)} ; ${FID_NEVER(p.c)}`, `securite : aucune relecture enregistrée à ${short(c2)}`]);
  for (const [d, agent] of [['securite', 'qa-securite'], ['fidelite', 'qa-fidelite']]) {
    assert.match(relecture.todo.join('\n'), new RegExp(`Relecture du delta seul ${short(p.c)}\\.\\.${short(c2)} \\(3 fichiers : .*\\) par apv:${agent} .*--domain ${d} --delta-from ${short(p.c)}`), d);
  }
  // The text output says it, domain by domain.
  const out = await p.text(c2);
  assert.match(out, new RegExp(`rgpd : relecture enregistrée \\(.*relecture rgpd reportée de ${short(p.c)} \\(delta sans fichier de son périmètre`));
  assert.ok(out.includes(FID_NEVER(p.c)), out);
  // The reviews of the delta recorded by apv:qa-securite and apv:qa-fidelite, with its four captures at C': accepted, said.
  seedReview(p.repo, c2, 'securite', { delta: { from: p.c, files: diffFiles(p.repo, p.c, c2) } });
  seedReview(p.repo, c2, 'fidelite', { captures: ALL_CAPTURES, delta: { from: p.c, files: diffFiles(p.repo, p.c, c2) } });
  const ok = await p.check(c2);
  assert.equal(rule(ok, 'relecture').status, 'ok', JSON.stringify(rule(ok, 'relecture')));
  assert.match(domain(ok, 'securite').detail, new RegExp(`relecture du delta depuis ${short(p.c)} \\(3 fichiers\\)`));
  assert.match(domain(ok, 'fidelite').detail, new RegExp(`relecture du delta depuis ${short(p.c)} \\(3 fichiers\\)`));
  assert.equal(rule(ok, 'captures').status, 'ok', JSON.stringify(rule(ok, 'captures')));
  assert.equal(rule(ok, 'captures').detail, `captures jointes à ${short(c2)} : ${ALL_CAPTURES.map(c => c.join(":")).join(', ')}`);
});

test('AC-CARRY-FID: a review of the delta of fidelite without its captures counts as a review, the captures stay required at the commit', async t => {
  const p = await reviewed(t);
  const c2 = p.commit(TEST_ONLY());
  seedReview(p.repo, c2, 'fidelite', { delta: { from: p.c, files: diffFiles(p.repo, p.c, c2) } });
  const report = await p.check(c2);
  assert.equal(domain(report, 'fidelite').status, 'recorded', JSON.stringify(domain(report, 'fidelite')));
  const captures = rule(report, 'captures');
  assert.equal(captures.status, 'refused', JSON.stringify(captures));
  assert.match(captures.problems[0], new RegExp(`capture\\(s\\) absente\\(s\\) de la relecture fidelite à ${short(c2)}`));
  // Two of the four captures: the two others are still missing; those of C never count at C'.
  seedReview(p.repo, c2, 'fidelite', { at: '2026-09-30T11:00:00.000Z', captures: ALL_CAPTURES.slice(0, 2), delta: { from: p.c, files: diffFiles(p.repo, p.c, c2) } });
  const half = rule(await p.check(c2), 'captures');
  assert.equal(half.status, 'refused', JSON.stringify(half));
  assert.deepEqual(half.problems, [`capture(s) absente(s) de la relecture fidelite à ${short(c2)} : ${ALL_CAPTURES.slice(2).map(c => c.join(":")).join(', ')}`]);
});
test('AC-CARRY-FID: a delta that touches a component is refused for fidelite, a review of the delta asked; with its captures it is accepted', async t => {
  const p = await reviewed(t);
  const c2 = p.commit({ 'src/lib/components/Composant.svelte': '<p>nouveau</p>\n' });
  const report = await p.check(c2);
  fidelityNeverReported(report, c2, p.c);
  const relecture = rule(report, 'relecture');
  assert.match(relecture.todo.join('\n'), new RegExp(`apv review record --commit ${short(c2)} --domain fidelite --delta-from ${short(p.c)} .*captures à ${short(c2)} des écrans touchés`));
  assert.equal(rule(report, 'captures').status, 'refused');
  // The review of the delta for fidelite, with its four captures at C': relecture and captures accepted for fidelite.
  seedReview(p.repo, c2, 'fidelite', { captures: ALL_CAPTURES, delta: { from: p.c, files: diffFiles(p.repo, p.c, c2) } });
  const after = await p.check(c2);
  assert.equal(domain(after, 'fidelite').status, 'recorded', JSON.stringify(domain(after, 'fidelite')));
  assert.equal(rule(after, 'captures').status, 'ok', JSON.stringify(rule(after, 'captures')));
  assert.match(rule(after, 'captures').detail, new RegExp(`captures jointes à ${short(c2)} :`));
});
test('AC-CARRY-FID: a test file the application names: fidelite not reported either', async t => {
  const p = await reviewed(t, { change: { ...PAGE, 'src/routes/compte/+page.ts': 'import f from "../../../tests/fixtures/pages.ts";\nexport const load = () => ({ f });\n', 'tests/fixtures/pages.ts': 'export default [];\n' } });
  const c2 = p.commit({ 'tests/fixtures/pages.ts': 'export default ["autre"];\n' });
  const report = await p.check(c2);
  fidelityNeverReported(report, c2, p.c);
  assert.equal(rule(report, 'captures').status, 'refused');
});
test('AC-CARRY-RGPD: a line of a test that names a term of the GDPR keeps rgpd; fidelite is not reported', async t => {
  const p = await reviewed(t);
  const c2 = p.commit({ 'tests/e2e/carte.e2e.ts': 'import { test } from "@playwright/test";\ntest("email du contact", async () => {});\n' });
  const report = await p.check(c2);
  assert.equal(domain(report, 'rgpd').status, 'missing', JSON.stringify(domain(report, 'rgpd')));
  assert.match(domain(report, 'rgpd').detail, /n'est pas reportée, le delta touche son périmètre : .*rgpd retenue/);
  fidelityNeverReported(report, c2, p.c);
});
test('AC-CARRY-SEC: a review of the delta whose files differ from the delta recomputed, or that starts from no usable review, proves nothing', async t => {
  const p = await reviewed(t);
  const c2 = p.commit(TEST_ONLY());
  // Files recorded that are not the delta recomputed.
  seedReview(p.repo, c2, 'securite', { delta: { from: p.c, files: ['tests/e2e/carte.e2e.ts'] } });
  let sec = domain(await p.check(c2), 'securite');
  assert.equal(sec.status, 'missing');
  assert.match(sec.detail, new RegExp(`relecture de delta non prouvante : fichiers enregistrés \\(1\\) différents du delta recalculé ${short(p.c)}\\.\\.${short(c2)} \\(3\\)`));
  // A review of the delta from a commit with no security review (the base of the branch is on the target).
  const base = git(p.repo, 'rev-parse', 'origin/main');
  seedReview(p.repo, c2, 'securite', { at: '2026-09-30T11:00:00.000Z', delta: { from: base, files: diffFiles(p.repo, base, c2) } });
  sec = domain(await p.check(c2), 'securite');
  assert.equal(sec.status, 'missing');
  assert.match(sec.detail, /est un commit de la cible, pas de la branche/);
  // The review where the delta starts is blocking: refused.
  const q = await reviewed(t);
  seedReview(q.repo, q.c, 'securite', { high: 1, at: '2026-09-30T11:00:00.000Z' });
  const q2 = q.commit(TEST_ONLY());
  seedReview(q.repo, q2, 'securite', { delta: { from: q.c, files: diffFiles(q.repo, q.c, q2) } });
  sec = domain(await q.check(q2), 'securite');
  assert.equal(sec.status, 'missing');
  assert.match(sec.detail, new RegExp(`relecture securite de départ à ${short(q.c)} : 0 constat\\(s\\) critique\\(s\\) et 1 haut\\(s\\)`));
  // An unsealed review of the delta proves nothing either.
  const s = await reviewed(t);
  const s2 = s.commit(TEST_ONLY());
  seedReview(s.repo, s2, 'securite', { seal: false, delta: { from: s.c, files: diffFiles(s.repo, s.c, s2) } });
  assert.equal(domain(await s.check(s2), 'securite').status, 'missing');
});

test('AC-CARRY-SEC: reviews of the delta in a chain count back to a usable review, five in a row at most', async t => {
  const p = await reviewed(t);
  let from = p.c;
  const heads = [];
  for (let k = 1; k <= 6; k += 1) {
    const next = p.commit(TEST_ONLY(k));
    seedReview(p.repo, next, 'securite', { delta: { from, files: diffFiles(p.repo, from, next) } });
    heads.push(next);
    from = next;
  }
  const fifth = domain(await p.check(heads[4]), 'securite');
  assert.equal(fifth.status, 'recorded', JSON.stringify(fifth));
  const sixth = domain(await p.check(heads[5]), 'securite');
  assert.equal(sixth.status, 'missing', JSON.stringify(sixth));
  assert.match(sixth.detail, /plus de 5 relectures de delta à la suite/);
});

test('AC-CARRY-BLOCK: a blocking review at a commit between C and the head refuses the report', async t => {
  const p = await reviewed(t);
  const c1 = p.commit(TEST_ONLY(1));
  seedReview(p.repo, c1, 'rgpd', { high: 1 });
  const c2 = p.commit(TEST_ONLY(2));
  const report = await p.check(c2);
  const rgpd = domain(report, 'rgpd');
  assert.equal(rgpd.status, 'missing', JSON.stringify(rgpd));
  assert.match(rgpd.detail, new RegExp(`0 constat\\(s\\) critique\\(s\\) et 1 haut\\(s\\) à ${short(c1)}`));
  // A blocking fidelity review between: no review of the delta from below it is offered.
  seedReview(p.repo, c1, 'fidelite', { high: 1, captures: ALL_CAPTURES });
  const fid = domain(await p.check(c2), 'fidelite');
  assert.equal(fid.status, 'missing', JSON.stringify(fid));
  assert.equal(fid.detail, `aucune relecture enregistrée à ${short(c2)}`);
});
test('AC-CARRY-REBASE: C not an ancestor of the head carries nothing; a review of the delta from it is refused', async t => {
  const p = await reviewed(t);
  const c2 = p.commit(TEST_ONLY());
  // The branch rebuilt from main with the same changes (cherry-pick): new commits, the reviews of C left behind.
  git(p.repo, 'reset', '-q', '--hard', 'origin/main');
  git(p.repo, 'cherry-pick', '-x', p.c, c2);
  const rebased = git(p.repo, 'rev-parse', 'HEAD');
  const report = await p.check(rebased);
  for (const d of p.retained) assert.equal(domain(report, d).status, 'missing', d);
  assert.deepEqual(rule(report, 'relecture').problems.sort(), p.retained.map(d => `${d} : aucune relecture enregistrée à ${short(rebased)}`).sort());
  seedReview(p.repo, rebased, 'securite', { delta: { from: p.c, files: diffFiles(p.repo, p.c, rebased) } });
  assert.match(domain(await p.check(rebased), 'securite').detail, new RegExp(`${short(p.c)} n'est pas un ancêtre de ${short(rebased)}`));
});

test('report: the walk is bounded (ten commits), follows a merge of the target carried by carry.ts, and never reports securite nor fidelite', async t => {
  const p = await reviewed(t);
  // A merge of the target (diff identical) after a commit of tests: rgpd of C reported over both.
  p.commit(TEST_ONLY(1));
  git(p.repo, 'switch', '-q', 'main'); put(p.repo, 'src/autre.ts', 'export const autre = 1;\n');
  git(p.repo, 'add', '-A'); git(p.repo, 'commit', '-qm', 'la cible avance'); git(p.repo, 'push', '-q', 'origin', 'main');
  git(p.repo, 'switch', '-q', 'feat'); git(p.repo, 'merge', '-q', '--no-edit', 'origin/main');
  const merged = git(p.repo, 'rev-parse', 'HEAD');
  const atMerge = await p.check(merged);
  assert.equal(domain(atMerge, 'rgpd').status, 'recorded', JSON.stringify(domain(atMerge, 'rgpd')));
  assert.match(domain(atMerge, 'rgpd').detail, new RegExp(`reportée de ${short(p.c)}`));
  assert.equal(domain(atMerge, 'securite').status, 'missing');
  fidelityNeverReported(atMerge, merged, p.c);
  // Ten more commits of tests: C is out of the walk, nothing reported, no review of the delta offered.
  let head = merged;
  for (let k = 2; k <= 11; k += 1) head = p.commit(TEST_ONLY(k));
  const far = await p.check(head);
  for (const d of ['fidelite', 'rgpd']) {
    assert.equal(domain(far, d).status, 'missing', JSON.stringify(domain(far, d)));
    assert.equal(domain(far, d).detail, `aucune relecture enregistrée à ${short(head)}`);
  }
});
test('report: the review of the head always decides, even when an earlier review would be carried', async t => {
  const p = await reviewed(t);
  const c2 = p.commit(TEST_ONLY());
  seedReview(p.repo, c2, 'fidelite', { high: 1, captures: ALL_CAPTURES });
  const fid = domain(await p.check(c2), 'fidelite');
  assert.equal(fid.status, 'missing');
  assert.match(fid.detail, new RegExp(`1 haut\\(s\\) à ${short(c2)}`));
});

test('apv review record --delta-from: an ancestor of the commit, cited by the report, the files of the delta recorded sorted; refused otherwise', async t => {
  const p = await reviewed(t);
  const c2 = p.commit(TEST_ONLY());
  const dir = mkdtempSync(join(tmpdir(), 'apv3-report-rapport-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const report = (text) => { const f = join(dir, `${Math.random().toString(16).slice(2)}.md`); writeFileSync(f, `${text}\n${'constat détaillé du delta. '.repeat(12)}\n`); return f; };
  const common = commonDirOf(p.repo);
  const input = { checkout: p.repo, commit: c2, domain: 'securite', reviewer: 'apv:qa-securite', findings: { critical: 0, high: 0, medium: 0, low: 0 }, captures: [] };
  const record = recordReview(common, { ...input, report: report(`Delta ${short(p.c)}..${short(c2)}`), deltaFrom: short(p.c) });
  assert.deepEqual(record.delta, { from: p.c, files: diffFiles(p.repo, p.c, c2) });
  assert.throws(() => recordReview(common, { ...input, report: report(`Delta vers ${short(c2)}`), deltaFrom: p.c }), /ne cite pas le commit de départ du delta/);
  assert.throws(() => recordReview(common, { ...input, report: report(`Delta ${short(c2)}`), deltaFrom: c2 }), /c'est le commit relu/);
  git(p.repo, 'switch', '-q', '-c', 'ailleurs', 'origin/main');
  const other = p.commit({ 'src/ailleurs.ts': 'export const a = 1;\n' });
  git(p.repo, 'switch', '-q', '--detach', c2);
  assert.throws(() => recordReview(common, { ...input, report: report(`Delta ${short(other)}..${short(c2)}`), deltaFrom: other }), /n'est pas un ancêtre/);
  // Not sealed by the hook here: latestReviews says so, the record is read back with its delta.
  const read = latestReviews(common, c2).get('securite');
  assert.deepEqual(read.record.delta, record.delta);
  // The command line takes it too, and apv review show says it.
  const shown = await apv(p.repo, ['review', 'show', '--commit', c2]);
  assert.match(shown.stdout, new RegExp(`relecture du delta depuis ${short(p.c)} \\(3 fichier\\(s\\)\\)`));
  const bad = await apv(p.repo, ['review', 'plan', '--base', 'origin/main', '--delta-from', p.c]);
  assert.equal(bad.code, 2);
});

/** A submodule that .gitmodules tells Git to ignore (security review of #141, A1). */
const IGNORED_SUBMODULE = { '.gitmodules': '[submodule "vendor"]\n\tpath = src/lib/vendor\n\turl = ./vendor\n\tignore = all\n' };
const SUB = n => String(n).repeat(40);

test('report (review of #141, A1): a submodule link that changes, even ignored by .gitmodules, makes the delta unreadable: nothing reported, no review of the delta', async t => {
  const p = await reviewed(t, { change: { ...PAGE, ...IGNORED_SUBMODULE }, links: { 'src/lib/vendor': SUB(1) } });
  // Only the link changes: Git, reading .gitmodules, would list no file at all.
  const c2 = p.commit({}, 'vendor', { 'src/lib/vendor': SUB(2) });
  const report = await p.check(c2);
  assert.equal(domain(report, 'rgpd').status, 'missing', JSON.stringify(domain(report, 'rgpd')));
  assert.match(domain(report, 'rgpd').detail, /delta illisible : lien de sous-module changé \(src\/lib\/vendor\).*relecture complète exigée/);
  fidelityNeverReported(report, c2, p.c);
  assert.equal(rule(report, 'captures').status, 'refused', JSON.stringify(rule(report, 'captures')));
  // A review of the delta of no file proves nothing, and apv review record refuses to write one.
  seedReview(p.repo, c2, 'securite', { delta: { from: p.c, files: [] } });
  const sec = domain(await p.check(c2), 'securite');
  assert.equal(sec.status, 'missing', JSON.stringify(sec));
  assert.match(sec.detail, /relecture de delta non prouvante : delta illisible : lien de sous-module changé \(src\/lib\/vendor\).*relecture complète exigée/);
  const dir = mkdtempSync(join(tmpdir(), 'apv3-report-rapport-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'rapport.md');
  writeFileSync(file, `Delta ${short(p.c)}..${short(c2)}\n${'constat détaillé du delta. '.repeat(12)}\n`);
  assert.throws(() => recordReview(commonDirOf(p.repo), { checkout: p.repo, commit: c2, domain: 'securite', reviewer: 'apv:qa-securite',
    findings: { critical: 0, high: 0, medium: 0, low: 0 }, captures: [], report: file, deltaFrom: p.c }), /delta illisible : lien de sous-module changé \(src\/lib\/vendor\).*relecture complète exigée/);
  // The link changed beside a test and its images: refused the same way, the test alone would have been carried.
  const q = await reviewed(t, { change: { ...PAGE, ...IGNORED_SUBMODULE }, links: { 'src/lib/vendor': SUB(1) } });
  const q2 = q.commit(TEST_ONLY(), 'tests et vendor', { 'src/lib/vendor': SUB(3) });
  const rgpd = domain(await q.check(q2), 'rgpd');
  assert.equal(rgpd.status, 'missing', JSON.stringify(rgpd));
  assert.match(rgpd.detail, /delta illisible : lien de sous-module changé \(src\/lib\/vendor\)/);
});
test('report (review of #141, A4): the delta is read without renames: a file moved out of a folder keeps the review of both paths', async t => {
  const p = await reviewed(t, { change: { ...PAGE, 'src/routes/(admin)/export/+server.ts': 'export const GET = () => new Response("ok");\n' } });
  assert.ok(p.retained.includes('rgpd'), p.retained.join(', '));
  mkdirSync(join(p.repo, 'src/routes/export'), { recursive: true });
  git(p.repo, 'mv', 'src/routes/(admin)/export/+server.ts', 'src/routes/export/+server.ts');
  const c2 = p.commit({}, 'déplacement hors du groupe admin');
  const rgpd = domain(await p.check(c2), 'rgpd');
  assert.equal(rgpd.status, 'missing', JSON.stringify(rgpd));
  assert.match(rgpd.detail, /n'est pas reportée, le delta touche son périmètre : .*rgpd retenue/);
});

test('report (review of #141, A10): a -diff attribute hides no term of the delta: the lines are read as text', async t => {
  // The attribute is in C (reviewed); the delta only changes a component, whose plan alone would keep fidelite.
  const p = await reviewed(t, { change: { ...PAGE, '.gitattributes': '*.svelte -diff\n' } });
  const c2 = p.commit({ 'src/lib/components/Header.svelte': '<header>Compte</header>\n<script src="https://www.googletagmanager.com/gtag/js"></script>\n<input name="email" />\n' });
  const rgpd = domain(await p.check(c2), 'rgpd');
  assert.equal(rgpd.status, 'missing', JSON.stringify(rgpd));
  assert.match(rgpd.detail, /n'est pas reportée, le delta touche son périmètre : .*rgpd retenue/);
});

/**
 * B2, AC-CARRY-WAIVER (decision of the operator of 17 October 2026): a waiver typed for C counts at C' when the delta
 * leaves its perimeter, for maquette, controles and the reviews donnees, rgpd; never securite, the rule relecture whole,
 * preuve nor instable, and never captures nor relecture:fidelite either (decision of the lead on the third security
 * review of #141: back with the fingerprint of the build output). Its words, date, commit and why are said.
 */
/** What the refusal says of a waiver captures or relecture:fidelite typed for an earlier commit. */
const WAIVER_NEVER = (rule, from) => `la dérogation ${rule} de ${short(from)} n'est jamais reportée (elle reviendra avec l'empreinte du build)`;
const AT = '2026-10-17T18:00:00.000Z';
const says = (p, rule, sha, reason = 'validée à l\'oral, versée demain') => operatorSays(p.repo, `dérogation ${rule} ${short(sha)} : ${reason}`, AT);

test('AC-CARRY-WAIVER, AC-USER-3: the waiver maquette of C counts for a delta without screen, said with his words, their date and commit; a page or a mockup touched refuses it', async t => {
  const p = await reviewed(t);
  assert.equal(rule(await p.check(p.c), 'maquette').status, 'refused');
  says(p, 'maquette', p.c);
  assert.equal(rule(await p.check(p.c), 'maquette').status, 'waived');
  const c2 = p.commit(TEST_ONLY());
  const maquette = rule(await p.check(c2), 'maquette');
  assert.equal(maquette.status, 'waived', JSON.stringify(maquette));
  assert.deepEqual(maquette.waiver.carried.from, p.c);
  assert.match(maquette.detail, new RegExp(`dérogation maquette reportée de ${short(p.c)} : « dérogation maquette ${short(p.c)} : validée à l'oral, versée demain » \\(${AT.replace(/\./g, '\\.')}, delta sans fichier de son périmètre : 3 fichiers`));
  assert.match(await p.text(c2), new RegExp(`dérogation de l'opérateur \\(${AT.replace(/\./g, '\\.')}\\) : validée à l'oral, versée demain ; dérogation maquette reportée de ${short(p.c)}`));
  // A page touched since C: refused, and the refusal says why the waiver of C is not carried.
  const c3 = p.commit({ 'src/routes/autre/+page.svelte': '<p>autre</p>\n' });
  const refused = rule(await p.check(c3), 'maquette');
  assert.equal(refused.status, 'refused');
  assert.match(refused.todo.join('\n'), new RegExp(`la dérogation maquette de ${short(p.c)} n'est pas reportée, le delta touche son périmètre : .*src/routes/autre/\\+page\\.svelte : écran`));
  // A mockup added since C (not a screen of the rule): refused too.
  git(p.repo, 'switch', '-q', '--detach', c2);
  const c4 = p.commit({ 'docs/design/carte.html': '<!doctype html><p>maquette</p>\n' });
  const mockup = rule(await p.check(c4), 'maquette');
  assert.equal(mockup.status, 'refused', JSON.stringify(mockup));
  assert.match(mockup.todo.join('\n'), /docs\/design\/carte\.html : dossier des maquettes/);
  // The decision ledger touched since C: refused.
  git(p.repo, 'switch', '-q', '--detach', c2);
  const c5 = p.commit({ '.apv/DECISIONS.md': '# Décisions\n' });
  assert.match(rule(await p.check(c5), 'maquette').todo.join('\n'), /\.apv\/DECISIONS\.md : registre des décisions/);
});

test('AC-CARRY-WAIVER: preuve, instable, relecture:securite and the rule relecture whole are never carried, whatever the delta', async t => {
  const p = await reviewed(t, { skip: ['securite'] });
  for (const r of ['preuve', 'instable', 'relecture:securite', 'relecture']) says(p, r, p.c, 'sans objet ici, voir la PR');
  const atC = await p.check(p.c);
  assert.equal(rule(atC, 'preuve').status, 'waived');
  assert.equal(domain(atC, 'securite').status, 'waived');
  const c2 = p.commit(TEST_ONLY());
  const report = await p.check(c2);
  assert.equal(rule(report, 'preuve').status, 'refused', JSON.stringify(rule(report, 'preuve')));
  assert.equal(rule(report, 'preuve').waiver, null);
  assert.equal(domain(report, 'securite').status, 'missing');
  assert.equal(rule(report, 'relecture').status, 'refused');
  assert.doesNotMatch(JSON.stringify(report.rules), /reportée de [0-9a-f]{12} : « dérogation (preuve|instable|relecture)/);
});

test('AC-CARRY-WAIVER: relecture:fidelite and captures never carried, even over a delta without screen, said; relecture:rgpd carried, not over a GDPR term', async t => {
  // relecture:fidelite (no fidelity review at C): not carried, captures required at C'.
  const p = await reviewed(t, { skip: ['fidelite', 'rgpd'] });
  says(p, 'relecture:fidelite', p.c);
  says(p, 'relecture:rgpd', p.c);
  const atC = await p.check(p.c);
  assert.equal(domain(atC, 'fidelite').status, 'waived');
  assert.equal(rule(atC, 'captures').status, 'not_applicable');
  const c2 = p.commit(TEST_ONLY());
  const report = await p.check(c2);
  assert.equal(domain(report, 'fidelite').status, 'missing', JSON.stringify(domain(report, 'fidelite')));
  assert.equal(domain(report, 'fidelite').waiver, null);
  assert.ok(rule(report, 'relecture').todo.includes(`fidelite : ${WAIVER_NEVER('relecture:fidelite', p.c)}.`), rule(report, 'relecture').todo.join('\n'));
  assert.equal(rule(report, 'captures').status, 'refused', JSON.stringify(rule(report, 'captures')));
  assert.equal(domain(report, 'rgpd').status, 'waived');
  assert.match(domain(report, 'rgpd').detail, new RegExp(`dérogation relecture:rgpd reportée de ${short(p.c)}`));
  const c3 = p.commit({ 'tests/e2e/carte.e2e.ts': 'import { test } from "@playwright/test";\ntest("email du contact", async () => {});\n' });
  const gdpr = await p.check(c3);
  assert.equal(domain(gdpr, 'rgpd').status, 'missing', JSON.stringify(domain(gdpr, 'rgpd')));
  assert.match(rule(gdpr, 'relecture').todo.join('\n'), new RegExp(`rgpd : la dérogation relecture:rgpd de ${short(p.c)} n'est pas reportée, le delta touche son périmètre : .*rgpd retenue`));
  assert.equal(domain(gdpr, 'fidelite').status, 'missing');
  // captures waived at C (a fidelity review without its captures): not carried over a delta without screen.
  const q = await reviewed(t, { fidelityCaptures: [] });
  assert.equal(rule(await q.check(q.c), 'captures').status, 'refused');
  says(q, 'captures', q.c);
  assert.equal(rule(await q.check(q.c), 'captures').status, 'waived');
  const q2 = q.commit(TEST_ONLY());
  const captures = rule(await q.check(q2), 'captures');
  assert.equal(captures.status, 'refused', JSON.stringify(captures));
  assert.equal(captures.waiver, null);
  assert.ok(captures.todo.includes(`${WAIVER_NEVER('captures', q.c)}.`), captures.todo.join('\n'));
  // The review of the delta of fidelite with its captures at C' passes both.
  seedReview(q.repo, q2, 'fidelite', { captures: ALL_CAPTURES, delta: { from: q.c, files: diffFiles(q.repo, q.c, q2) } });
  const reviewedDelta = await q.check(q2);
  assert.equal(rule(reviewedDelta, 'captures').status, 'ok', JSON.stringify(rule(reviewedDelta, 'captures')));
  assert.equal(domain(reviewedDelta, 'fidelite').status, 'recorded');
});
test('AC-CARRY-WAIVER: controles carried while the configuration of the checks is untouched; a template reason is never carried; a rebase carries nothing', async t => {
  const p = await reviewed(t);
  assert.equal(rule(await p.check(p.c), 'controles').status, 'refused');
  says(p, 'controles', p.c);
  says(p, 'maquette', p.c, '<ta raison>');
  const c2 = p.commit(TEST_ONLY());
  const report = await p.check(c2);
  assert.equal(rule(report, 'controles').status, 'waived', JSON.stringify(rule(report, 'controles')));
  assert.match(rule(report, 'controles').detail, new RegExp(`dérogation controles reportée de ${short(p.c)}`));
  assert.equal(rule(report, 'maquette').status, 'refused', 'a waiver with the template of the tool is not carried');
  const c3 = p.commit({ '.apv/config.json': { name: 'essai', gates: [{ id: 'unit', stage: 'full', command: [process.execPath, '-e', '0;'] }] } });
  const changed = rule(await p.check(c3), 'controles');
  assert.equal(changed.status, 'refused');
  assert.match(changed.todo.join('\n'), /\.apv\/config\.json : configuration des contrôles/);
  // A rebase: the waiver of C is for a commit that is no ancestor.
  git(p.repo, 'reset', '-q', '--hard', 'origin/main');
  git(p.repo, 'cherry-pick', '-x', p.c, c2);
  assert.equal(rule(await p.check(git(p.repo, 'rev-parse', 'HEAD')), 'controles').status, 'refused');
});

test('AC-CARRY-WAIVER (review of #142, A2): controles is carried only when the checks refused at the head are among those refused at C, the web detection included', async t => {
  // A command-line tool (not a web project) whose configuration asks for lint, absent: refused at C for lint alone.
  const p = await reviewed(t, { site: { 'src/cli.mjs': 'export const run = () => 1;\n' }, change: { 'src/cli.mjs': 'export const run = () => 2;\n' },
    config: { rules: { requiredGates: [{ id: 'lint', command: ['npm', 'run', 'lint'] }] } } });
  const atC = rule(await p.check(p.c), 'controles');
  assert.equal(atC.status, 'refused', JSON.stringify(atC));
  assert.deepEqual(atC.problems.map(x => x.split(' ')[0]), ['lint']);
  says(p, 'controles', p.c, 'lint pas encore prêt');
  // A delta of a test: the same refusal, the waiver of C carried.
  const c2 = p.commit({ 'tests/cli.test.mjs': 'import "../src/cli.mjs";\n' });
  assert.equal(rule(await p.check(c2), 'controles').status, 'waived', JSON.stringify(rule(await p.check(c2), 'controles')));
  // A page of interface added under the tests: the project is now a web project, the web checks are required too,
  // which the operator never saw: not carried, said.
  const c3 = p.commit({ 'tests/e2e/fixture.html': '<!doctype html><p>fixture</p>\n' });
  const atC3 = rule(await p.check(c3), 'controles');
  assert.equal(atC3.status, 'refused', JSON.stringify(atC3));
  assert.ok(atC3.problems.length > 1, JSON.stringify(atC3.problems));
  assert.match(atC3.todo.join('\n'), new RegExp(`la dérogation controles de ${short(p.c)} n'est pas reportée.*projet web à ${short(c3)}, pas à ${short(p.c)}`));
});

/** A tracker, an e-mail field, personal fields and a query, on several lines (second review of #141, M1). */
const TERMS = '<p>bloc</p>\n<script src="https://www.googletagmanager.com/gtag/js"></script>\n<input name="email" autocomplete="email" />\n<p>{user.phone} {profile.birthdate}</p>\n{#await supabase.from(\'profiles\').select(\'email\') then rows}{rows.length}{/await}\n';

test('report (second review of #141, M1): a file name with a space hides no term: rgpd is not reported, donnees asked', async t => {
  for (const name of ['src/lib/components/Mon composant.svelte', 'tests/e2e/mon test.e2e.ts']) {
    const p = await reviewed(t, { change: { ...PAGE, [name]: '<p>bloc</p>\n' } });
    const c2 = p.commit({ [name]: TERMS });
    const report = await p.check(c2);
    const rgpd = domain(report, 'rgpd');
    assert.equal(rgpd.status, 'missing', `${name} : ${JSON.stringify(rgpd)}`);
    assert.match(rgpd.detail, /n'est pas reportée, le delta touche son périmètre : .*rgpd retenue/, name);
    assert.equal(domain(report, 'donnees')?.status, 'missing', `${name} : ${JSON.stringify(domain(report, 'donnees'))}`);
  }
});

/** Loaders of src/routes/compte/+page.server.ts that build their path (second review of #141, M2), `dir` the folder they aim at. */
const LOADERS = dir => ({
  "import('…' + n)": `export const load = async ({ params }) => ({ f: (await import('../../../${dir}/' + params.n + '.ts')).default });\n`,
  'import(`…` + n)': `export const load = async ({ params }) => ({ f: (await import(\`../../../${dir}/\` + params.n)).default });\n`,
  'import⏎(x)': `export const load = async ({ params }) => ({ f: (await import\n(\`../../../${dir}/\${params.n}.ts\`)).default });\n`,
  'import/**/(x)': `export const load = async ({ params }) => ({ f: (await import/**/(\`../../../${dir}/\${params.n}.ts\`)).default });\n`,
  'import // ⏎(x)': `export const load = async ({ params }) => ({ f: (await import // chargé à la demande\n(\`../../../${dir}/\${params.n}.ts\`)).default });\n`,
  'gabarit \\⏎': `export const load = async ({ params }) => ({ f: (await import(\`../../../${dir}/\\\n\${params.n}.ts\`)).default });\n`,
  "require('…' + n)": `export const load = ({ params }) => ({ f: require('../../../${dir}/' + params.n) });\n`,
  "readFileSync('…' + n)": `import { readFileSync } from 'node:fs';\nexport const load = ({ params }) => ({ f: readFileSync('${dir}/' + params.n + '.ts', 'utf8') });\n`,
  'createReadStream(x)': `import { createReadStream } from 'node:fs';\nexport const load = ({ params }) => ({ f: createReadStream(\n  params.n) });\n`,
});

test('report (second review of #141, M2): whatever the delta (fixture, support module, test proper, note), fidelite is never reported, its captures required', async t => {
  const cases = [
    { 'tests/fixtures/pages.ts': 'export default ["contenu affiché changé"];\n' },
    { 'tests/support/page.ts': 'export default 1;\n' },
    { 'tests/e2e/helpers.ts': 'export default 1;\n' },
    TEST_ONLY(),
    { '.apv/state/notes.md': '# Notes\n' },
  ];
  for (const files of cases) {
    const p = await reviewed(t);
    const c2 = p.commit(files);
    const report = await p.check(c2);
    fidelityNeverReported(report, c2, p.c, Object.keys(files).join(', '));
    assert.equal(rule(report, 'captures').status, 'refused', `${Object.keys(files).join(', ')} : ${JSON.stringify(rule(report, 'captures'))}`);
  }
});

/** A change made of tests only, fidelite always reviewed: the rule captures reads the loads of the application (loads.ts). */
async function capturesOfTests(t, base) {
  const s = site(t, { base, config: { review: { always: ['fidelite'] } } });
  const c = s.commit(TEST_ONLY());
  return rule(await s.check(c), 'captures');
}

test('captures (second review of #141, M2): every computed load of the application is seen, over lines and comments, for a change of tests', async t => {
  for (const [name, loader] of Object.entries(LOADERS('tests/e2e'))) {
    const captures = await capturesOfTests(t, { 'src/routes/compte/+page.server.ts': loader });
    assert.equal(captures.status, 'refused', `${name} : ${JSON.stringify(captures)}`);
    assert.match(captures.detail, /tests\/e2e\/carte\.e2e\.ts : chargement par motif ou chemin calculé dans src\/routes\/compte\/\+page\.server\.ts/, name);
  }
  // A NUL byte in a comment (third review of #141, M4): the file is still read (Node and esbuild run it).
  const nul = await capturesOfTests(t, { 'src/routes/compte/+page.server.ts': `// \u0000\n${LOADERS('tests/e2e')["import('…' + n)"]}` });
  assert.equal(nul.status, 'refused', JSON.stringify(nul));
  assert.match(nul.detail, /chargement par motif ou chemin calculé dans src\/routes\/compte\/\+page\.server\.ts/);
  // A JavaScript loader named .sql (any case) is read as JavaScript.
  for (const file of ['src/lib/loader.sql', 'src/lib/LOADER.SQL']) {
    const captures = await capturesOfTests(t, { [file]: 'export default (n) => import(n);\n' });
    assert.equal(captures.status, 'refused', `${file} : ${JSON.stringify(captures)}`);
    assert.match(captures.detail, new RegExp(`chargement par motif ou chemin calculé dans ${file.replace(/[./]/g, '\\$&')}`));
  }
});

test('captures (second review of #141, M2): the pilot project, a SQL function named *_import( and loads that only comments or literals hold, need none', async t => {
  const quiet = {
    'supabase/migrations/20261001000000_import.sql': 'create function public.confirm_application_import(p_id uuid) returns void language sql as $$ select 1 $$;\nselect confirm_application_import(p_id);\n',
    'src/lib/home/motion.ts': '/*\n * anime.js et three ne sont importés qu\'à la demande (import() dynamique).\n */\n// require(x) jamais ici, readFileSync(chemin) non plus\nexport const motion = async () => (await import(\'./anime\')).default;\n',
    'src/lib/server/fonts.ts': "import { readFileSync } from 'node:fs';\nexport const font = () => readFileSync('static/fonts/a.woff2');\nexport const json = async () => (await import('./data.json', { with: { type: 'json' } })).default;\nconst url = 'http://exemple.test/'; // import(url) en commentaire\n",
    'src/lib/server/data.json': '{"a":1}\n',
  };
  const captures = await capturesOfTests(t, quiet);
  assert.equal(captures.status, 'not_applicable', JSON.stringify(captures));
  assert.match(captures.detail, /^aucun écran touché : 3 fichiers/);
});

test('captures (second review of #141, M2): beyond the bound of the search for loads, nothing is judged: captures required', async t => {
  // In the base, 17 Mio of text the application holds.
  const captures = await capturesOfTests(t, { 'src/lib/server/grand.txt': 'ligne de texte de l\'application\n'.repeat(560_000) });
  assert.equal(captures.status, 'refused', JSON.stringify(captures));
  assert.match(captures.detail, /recherche des chargements par motif : .*impossible de juger/);
});

test('report (third review of #141, M3): a loader in src/routes/build/+page.ts toward the tests: fidelite and captures of C are not reported, and the rule captures sees it', async t => {
  const loader = "export const load = async ({ params }) => ({ f: (await import('../../../tests/e2e/' + params.n + '.ts')).default });\n";
  const p = await reviewed(t, { change: { ...PAGE, 'src/routes/build/+page.ts': loader } });
  // C' only changes the test that the served route /build loads.
  const c2 = p.commit({ 'tests/e2e/carte.e2e.ts': 'import { test } from "@playwright/test";\ntest("carte changée", async () => {});\n' });
  const report = await p.check(c2);
  fidelityNeverReported(report, c2, p.c);
  const captures = rule(report, 'captures');
  assert.equal(captures.status, 'refused', JSON.stringify(captures));
  assert.match(captures.problems[0], new RegExp(`capture\\(s\\) absente\\(s\\) de la relecture fidelite à ${short(c2)}`));
  // The rule captures alone, for a change of tests: a folder named build or dist below the root is the application.
  for (const file of ['src/routes/build/+page.ts', 'src/lib/dist/charge.ts']) {
    const alone = await capturesOfTests(t, { [file]: loader });
    assert.equal(alone.status, 'refused', `${file} : ${JSON.stringify(alone)}`);
    assert.match(alone.detail, new RegExp(`chargement par motif ou chemin calculé dans ${file.replace(/[./+]/g, '\\$&')}`), file);
  }
  // At the root, a build output is still no source of the application.
  const output = await capturesOfTests(t, { 'build/charge.js': loader, 'dist/charge.js': loader });
  assert.equal(output.status, 'not_applicable', JSON.stringify(output));
});

test('AC-CARRY-WAIVER (reviews of #141 and #143, M1, M2, M3): no waiver relecture:fidelite or captures over any delta, none of relecture:rgpd over a name with a space', async t => {
  const fixture = { ...PAGE, 'tests/fixtures/pages.ts': 'export default [];\n' };
  // relecture:fidelite waived at C (no fidelity review): carried neither over a fixture changed nor over a test proper.
  const p = await reviewed(t, { change: fixture, skip: ['fidelite'] });
  says(p, 'relecture:fidelite', p.c);
  const c2 = p.commit({ 'tests/fixtures/pages.ts': 'export default ["contenu affiché changé"];\n' });
  const report = await p.check(c2);
  assert.equal(domain(report, 'fidelite').status, 'missing', JSON.stringify(domain(report, 'fidelite')));
  assert.ok(rule(report, 'relecture').todo.includes(`fidelite : ${WAIVER_NEVER('relecture:fidelite', p.c)}.`), rule(report, 'relecture').todo.join('\n'));
  git(p.repo, 'switch', '-q', '--detach', p.c);
  const c3 = p.commit(TEST_ONLY());
  assert.equal(domain(await p.check(c3), 'fidelite').status, 'missing');
  // captures waived at C (a fidelity review without its captures): carried over nothing, a loader or not.
  for (const [dir, change] of [['tests/fixtures', { 'tests/fixtures/pages.ts': 'export default ["x"];\n' }], ['tests/e2e', TEST_ONLY()], [null, TEST_ONLY()]]) {
    const loader = dir ? { 'src/routes/compte/+page.server.ts': LOADERS(dir)['import/**/(x)'] } : {};
    const q = await reviewed(t, { change: { ...fixture, ...loader }, fidelityCaptures: [] });
    says(q, 'captures', q.c);
    const q2 = q.commit(change);
    const captures = rule(await q.check(q2), 'captures');
    assert.equal(captures.status, 'refused', `${dir} : ${JSON.stringify(captures)}`);
  }
  // M3 of #143: a loader in src/routes/build/+page.ts at C, both waivers typed for C; C' only changes the test it loads.
  const build = { ...PAGE, 'src/routes/build/+page.ts': "export const load = async ({ params }) => ({ f: (await import('../../../tests/e2e/' + params.n)).default });\n" };
  const m = await reviewed(t, { change: build, skip: ['fidelite'] });
  says(m, 'relecture:fidelite', m.c);
  says(m, 'captures', m.c);
  const m2 = m.commit({ 'tests/e2e/carte.e2e.ts': 'import { test } from "@playwright/test";\ntest("carte changée", async () => {});\n' });
  const atM2 = await m.check(m2);
  assert.equal(domain(atM2, 'fidelite').status, 'missing', JSON.stringify(domain(atM2, 'fidelite')));
  assert.equal(rule(atM2, 'captures').status, 'refused', JSON.stringify(rule(atM2, 'captures')));
  assert.ok(rule(atM2, 'captures').todo.includes(`${WAIVER_NEVER('captures', m.c)}.`), rule(atM2, 'captures').todo.join('\n'));
  // relecture:rgpd waived at C; C' adds a tracker and an e-mail field to a component whose name has a space.
  const name = 'src/lib/components/Mon composant.svelte';
  const r = await reviewed(t, { change: { ...PAGE, [name]: '<p>bloc</p>\n' }, skip: ['rgpd'] });
  says(r, 'relecture:rgpd', r.c, 'texte de la carte relu à l\'oral');
  const r2 = r.commit({ [name]: TERMS });
  const rgpd = domain(await r.check(r2), 'rgpd');
  assert.equal(rgpd.status, 'missing', JSON.stringify(rgpd));
});
