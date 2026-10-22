import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { apv } from './cli-helpers.mjs';
import { configIssues } from '../dist/config/load.js';
import { pathsIn, toolingTouched } from '../dist/release/unstable.js';

/**
 * docs/UNE-SUITE-PAR-PR.md: a pull request merges on its task checks, targeted tests and reviews; the only full suite runs once,
 * in `apv release auto`, on the head of main. The release repeats every test modified since production (no credit from a branch);
 * an old unstable test unrelated to the change no longer blocks production.
 */

const identity = { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@localhost', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@localhost' };
const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args],
  { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...identity } }).trim();
const put = (root, path, value) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`); };
const node = code => [process.execPath, '-e', code];
const ALLOW = { APV_ALLOW_MERGE: '1' };
const RELEASE = { branch: 'production', from: 'main' };
/** Appends `line` (and the arguments of the command) to `log` each time the command really runs. */
const logged = (log, line, extra = '') => node(`require("fs").appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(line)} + process.argv.slice(1).filter(a => !a.startsWith("times=")).map(a => " " + a).join("") + "\\n");${extra}`);

/**
 * An origin and a clone, main and production at the same commit; `unit` (full) logs each run and repeats the changed test
 * files `tests/**` (each repetition logged too). `files`: committed at the base.
 */
function project(t, { gates = null, extra = {}, files = {}, release = RELEASE } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'apv4-une-suite-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const log = join(root, 'runs.log');
  const origin = join(root, 'origin.git');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  const repo = join(root, 'repo');
  git(root, 'clone', '-q', origin, repo);
  git(repo, 'switch', '-q', '-c', 'main');
  const unit = { id: 'unit', stage: 'full', command: logged(log, 'unit'),
    repeatChanged: { paths: ['tests/**'], command: [...logged(log, 'repeat'), 'times={{repeat}}'], times: 2, reference: 'origin/main' } };
  put(repo, '.apv/config.json', { name: 'essai', gates: gates ?? [{ id: 'lint', stage: 'task', command: node('0') }, unit], ...extra, release });
  put(repo, '.gitignore', '.apv/receipts/\n.apv/state/\n');
  put(repo, 'README.md', 'projet\n');
  for (const [path, text] of Object.entries(files)) put(repo, path, text);
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'base'); git(repo, 'push', '-q', 'origin', 'main');
  git(repo, 'push', '-q', 'origin', 'main:production');
  const commit = (path, text, message = path) => { put(repo, path, text); git(repo, 'add', '-A'); git(repo, 'commit', '-qm', message); return git(repo, 'rev-parse', 'HEAD'); };
  const branch = name => git(repo, 'switch', '-q', '-c', name, 'origin/main');
  /** Merges `name` into main with a merge commit (the tree of the branch when it contains main), then pushes main. */
  const merge = name => { git(repo, 'switch', '-q', 'main'); git(repo, 'merge', '-q', '--no-ff', '-m', `fusion de ${name}`, name); git(repo, 'push', '-q', 'origin', 'main'); return git(repo, 'rev-parse', 'HEAD'); };
  const ran = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];
  const remote = ref => git(origin, 'rev-parse', ref);
  const journal = () => readFileSync(join(repo, '.apv', 'state', 'stack.log'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(e => e.event === 'release');
  return { root, repo, origin, log, commit, branch, merge, ran, remote, journal };
}

test('two pull requests merged: one suite at the release, which repeats every test modified since production', async t => {
  const p = project(t);
  p.branch('feat1'); p.commit('tests/a.test.js', 'test a\n');
  p.branch('feat2'); p.commit('tests/b.test.js', 'test b\n');
  p.merge('feat1');
  const merged = p.merge('feat2');
  const r = await apv(p.repo, ['release', 'auto'], ALLOW);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const runs = p.ran();
  assert.equal(runs[0], 'unit', 'one suite');
  assert.equal(runs.length, 2, runs.join(' | '));
  assert.match(runs[1], /^repeat tests\/a\.test\.js.*tests\/b\.test\.js$|^repeat tests\/b\.test\.js.*tests\/a\.test\.js$/, 'both changed tests repeated at the release');
  assert.doesNotMatch(r.stderr, /crédit de répétition/);
  assert.equal(p.remote('production'), merged);
  assert.equal(p.journal().pop().published, true);
});

test('a pull request needs no branch suite: its task checks are enough for the rules, the release runs the only full suite', async t => {
  const p = project(t);
  p.branch('feat'); p.commit('src/a.js', 'a\n');
  const before = p.ran().length;
  const task = await apv(p.repo, ['gates', 'run', '--stage', 'task', '--base', 'origin/main']);
  assert.equal(task.code, 0, task.stdout + task.stderr);
  assert.equal(p.ran().length, before, 'the full check did not run');
  p.merge('feat');
  const r = await apv(p.repo, ['release', 'auto'], ALLOW);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.deepEqual(p.ran().slice(before), ['unit']);
  assert.equal(p.remote('production'), p.remote('main'));
});

test('options removed in alpha.6: gates run --fresh-copy is an incorrect call, normalizeEnv in a stack says to delete the key', async t => {
  const p = project(t);
  const r = await apv(p.repo, ['gates', 'run', '--stage', 'full', '--fresh-copy', '--base', 'origin/main']);
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.deepEqual(p.ran(), [], 'nothing run');
  const messages = value => configIssues(value).issues.map(i => i.message).join('\n');
  assert.match(messages({ gates: [{ id: 'unit', stage: 'full', command: ['npm', 'test'] }], stacks: [{ id: '1', lockFile: '/tmp/x.lock', fingerprint: ['true'], normalizeEnv: ['E2E_STACK'] }] }),
    /normalizeEnv retiré en alpha\.6.*supprimer la clé/);
});

test('audit of the dependencies required only when they change (docs, part 5): same task check at the task stage and at the release, nothing otherwise', async t => {
  const alog = join(mkdtempSync(join(tmpdir(), 'apv4-une-suite-audit-')), 'audit.log');
  t.after(() => rmSync(dirname(alog), { recursive: true, force: true }));
  // The command of docs/UNE-SUITE-PAR-PR.md, 5, with `git diff <base>...HEAD`: it audits (here, logs) only when a manifest or lock file changed.
  const code = `const { execFileSync } = require("child_process"); const changed = execFileSync("git", ["diff", "--name-only", process.argv[1] + "...HEAD"], { encoding: "utf8" }).split("\\n");`
    + ` if (changed.some(f => /(^|\\/)(package\\.json|package-lock\\.json|pnpm-lock\\.yaml|yarn\\.lock)$/.test(f))) require("fs").appendFileSync(${JSON.stringify(alog)}, "audit\\n");`;
  const audit = { id: 'audit-dependances', stage: 'task', command: [...node(code), '{{baseSha}}'], covers: ['security'], reuse: false };
  const p = project(t, { gates: [audit, { id: 'unit', stage: 'full', command: node('0') }] });
  const audited = () => existsSync(alog) ? readFileSync(alog, 'utf8').trim().split('\n').length : 0;
  p.branch('code'); p.commit('src/a.js', 'a\n');
  assert.equal((await apv(p.repo, ['gates', 'run', '--stage', 'task', '--base', 'origin/main'])).code, 0);
  assert.equal(audited(), 0, 'code only: no audit at the task stage');
  p.merge('code');
  assert.equal((await apv(p.repo, ['release', 'auto'], ALLOW)).code, 0);
  assert.equal(audited(), 0, 'code only: no audit at the release');
  p.branch('deps'); p.commit('package.json', '{}\n');
  assert.equal((await apv(p.repo, ['gates', 'run', '--stage', 'task', '--base', 'origin/main'])).code, 0);
  assert.equal(audited(), 1, 'a manifest changed: audited at the task stage');
  p.merge('deps');
  assert.equal((await apv(p.repo, ['release', 'auto'], ALLOW)).code, 0);
  assert.equal(audited(), 2, 'and again at the release, from production');
  assert.equal(p.remote('production'), p.remote('main'));
});

/** A browser check that fails at its first pass naming `failing`, passes at the relaunch; `affectedList` prints `listed`. */
function flakyGate(dir, failing, { listed = 'tests/other.spec.ts', affectedList = true } = {}) {
  const marker = join(dir, `first-${Math.random().toString(16).slice(2)}`);
  const first = `const fs=require("fs"); if (!fs.existsSync(${JSON.stringify(marker)})) { fs.writeFileSync(${JSON.stringify(marker)}, ""); console.log("  1) [chromium] › ${failing}:3:5 › carte"); process.exit(1); }`;
  return { id: 'browser', stage: 'full', command: node(first), retryFailed: { command: node('0'), testPattern: '^\\s*\\d+\\) (\\[[^\\]]+\\] › .+?)\\s*$' },
    ...(affectedList ? { affectedList: [...node(`console.log("Listing tests:\\n  [chromium] › ${listed}:1:1 › x\\nTotal: 1 test in 1 file")`), '{{baseSha}}'] } : {}) };
}

test('AC-3: an old test, unrelated to the diff, that fails 1 time out of 2 passes: published, the finding written in the journal and the follow-up', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'apv4-une-suite-flaky-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const p = project(t, { gates: [flakyGate(dir, 'tests/old.spec.ts')], files: { 'tests/old.spec.ts': 'old\n', 'src/x.js': 'x\n' } });
  const sha = p.commit('src/x.js', 'x2\n'); git(p.repo, 'push', '-q', 'origin', 'main');
  const r = await apv(p.repo, ['release', 'auto'], ALLOW);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(p.remote('production'), sha);
  assert.match(r.stdout, /Constat : test instable sans rapport avec le changement depuis [0-9a-f]{12} : \[chromium\] › tests\/old\.spec\.ts:3:5 › carte \(browser\) échoue 1 fois sur 2 passages/);
  const entry = p.journal().pop();
  assert.deepEqual(entry.unstable.map(u => [u.gate, u.files, u.failed, u.passes, u.blocking]), [['browser', ['tests/old.spec.ts'], 1, 2, null]]);
  const followUp = readFileSync(join(p.repo, '.apv', 'state', 'suivi-constats.md'), 'utf8');
  assert.match(followUp, /## Tests instables à la mise en ligne\n- \d{4}-\d\d-\d\d, mise en ligne de [0-9a-f]{12}, test instable sans rapport avec le changement : .*tests\/old\.spec\.ts.*échoue 1 fois sur 2 passages/);
});

test('AC-3, refusals: a test the change concerns (affectedList), a check without affectedList at production, a name without its file: refused as today', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'apv4-une-suite-flaky-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const files = { 'tests/old.spec.ts': 'old\n', 'src/x.js': 'x\n' };
  const cases = [
    [flakyGate(dir, 'tests/old.spec.ts', { listed: 'tests/old.spec.ts' }), /tests\/old\.spec\.ts:3:5 › carte : concerné par le changement depuis la production \(affectedList/],
    [flakyGate(dir, 'tests/old.spec.ts', { affectedList: false }), /browser ne déclare pas affectedList à la production/],
    [flakyGate(dir, 'tests/absent.spec.ts'), /fichier du test introuvable dans son nom/]];
  for (const [gate, why] of cases) {
    const p = project(t, { gates: [gate], files });
    const before = p.remote('production');
    p.commit('src/x.js', 'x2\n'); git(p.repo, 'push', '-q', 'origin', 'main');
    const r = await apv(p.repo, ['release', 'auto'], ALLOW);
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /réussi\(s\) seulement après relance .*browser \(règle instable\)/);
    assert.match(r.stdout, why);
    assert.equal(p.remote('production'), before);
    assert.equal(existsSync(join(p.repo, '.apv', 'state', 'suivi-constats.md')), false, 'no finding: it blocks');
  }
  // affectedList added by the change itself (absent at production): never read from the change.
  const p = project(t, { gates: [flakyGate(dir, 'tests/old.spec.ts', { affectedList: false })], files });
  put(p.repo, '.apv/config.json', { name: 'essai', gates: [flakyGate(dir, 'tests/old.spec.ts')], release: RELEASE });
  p.commit('src/x.js', 'x2\n'); git(p.repo, 'push', '-q', 'origin', 'main');
  const r = await apv(p.repo, ['release', 'auto'], ALLOW);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /ne déclare pas affectedList à la production/);
});

/** A browser check like `flakyGate`, whose `affectedList` is `list` (by default the script `scripts/affected-list.mjs` of the project). */
function scriptedGate(dir, list = ['node', 'scripts/affected-list.mjs', '{{baseSha}}']) {
  const { affectedList: _unused, ...gate } = flakyGate(dir, 'tests/old.spec.ts');
  return { ...gate, affectedList: list };
}
const say = file => `console.log("Listing tests:\\n  [chromium] › tests/${file}.spec.ts:1:1 › x\\nTotal: 1 test in 1 file");`;
const [HONEST, LIE] = [say('old'), say('other')];
const NODE_LIST = ['node', 'scripts/affected-list.mjs', '{{baseSha}}'];

test('toolingTouched: scripts, manifests, locks, settings, configuration files at any depth and the paths the command names; not the application', () => {
  const tracked = ['src/lib/Comp.svelte', 'tests/a.spec.ts', 'docs/notes.md', 'tools/list.mjs'];
  const touched = changed => toolingTouched(changed, ['node', 'tools/list.mjs', '{{baseSha}}'], tracked);
  assert.deepEqual(touched(['src/lib/Comp.svelte', 'tests/a.spec.ts', 'docs/notes.md', 'supabase/migrations/1.sql', 'static/a.png']), []);
  assert.deepEqual(touched(['tools/list.mjs']), ['tools/list.mjs'], 'a path the command names');
  for (const f of ['scripts/x.mjs', 'apps/web/scripts/y/z.sh', 'package.json', 'apps/web/package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'npm-shrinkwrap.json',
    '.npmrc', 'apps/web/.npmrc', '.yarnrc', '.yarnrc.yml', 'bunfig.toml', 'tsconfig.json', 'tsconfig.base.json', 'vite.config.ts', 'apps/web/playwright.config.ts', 'affected.config.json',
    '.apv/config.json', 'jsconfig.json', 'deno.json', 'deno.jsonc', '.pnpmfile.cjs', '.yarn/releases/yarn.cjs', 'vitest.workspace.ts', '.mocharc.cjs', '.babelrc', '.swcrc',
    'tests/support/projects.mjs', 'apps/web/test/support/a.ts', '.gitattributes']) {
    assert.deepEqual(touched([f]), [f], f);
  }
});

test('P1, pilot project: node scripts/e2e/affected-list.mjs, a component alone changes: the list is read in a fresh copy, an unrelated test is published', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'apv4-une-suite-flaky-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const list = ['node', 'scripts/e2e/affected-list.mjs', '{{baseSha}}'];
  // A comment that mentions « import (GRAPH_CODE). » is nothing to the rule: no analysis of the script.
  const script = (file) => `/**\n * Liste les tests concernés : le code qui n'agit que par\n * import (GRAPH_CODE).\n */\nimport { execFileSync } from 'node:child_process';\n${say(file)}\n`;
  const files = file => ({ 'tests/old.spec.ts': 'old\n', 'src/lib/Comp.svelte': '<p>a</p>\n', 'scripts/e2e/affected-list.mjs': script(file) });
  const unrelated = project(t, { gates: [scriptedGate(dir, list)], files: files('other') });
  const sha = unrelated.commit('src/lib/Comp.svelte', '<p>b</p>\n'); git(unrelated.repo, 'push', '-q', 'origin', 'main');
  const ok = await apv(unrelated.repo, ['release', 'auto'], ALLOW);
  assert.equal(ok.code, 0, ok.stdout + ok.stderr);
  assert.equal(unrelated.remote('production'), sha);
  assert.match(ok.stdout, /Constat : test instable sans rapport avec le changement/);
  // The same change when the script lists the unstable test: judged, concerned, refused.
  const concerned = project(t, { gates: [scriptedGate(dir, list)], files: files('old') });
  const before = concerned.remote('production');
  concerned.commit('src/lib/Comp.svelte', '<p>b</p>\n'); git(concerned.repo, 'push', '-q', 'origin', 'main');
  const no = await apv(concerned.repo, ['release', 'auto'], ALLOW);
  assert.equal(no.code, 1, no.stdout + no.stderr);
  assert.match(no.stdout, /concerné par le changement depuis la production \(affectedList/);
  assert.equal(concerned.remote('production'), before);
});

/**
 * Review of PR #162: what a script loads cannot be followed, so the judgment « sans rapport » is refused when the change touches
 * the tooling (a path rule), and the list is read in a fresh copy of the commit, never in the copy where the suite ran (what the
 * tests of the change wrote there is not the commit). The witness, a change of the application alone, is published (P1).
 */
test('F4, M1, M2: a change to the tooling is refused; what the suite writes in its own copy cannot act on the list', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'apv4-une-suite-flaky-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lib = text => ({ 'scripts/lib/list.mjs': `export const list = () => { ${text} };\n` });
  const PKG = { name: 'x', scripts: { 'e2e:changed': 'node scripts/affected-list.mjs' } };
  const NPM_LIST = ['npm', 'run', 'e2e:changed', '--', '{{baseSha}}'];
  // The suite writes UNTRACKED files (or rewrites a tracked one) in its copy, then the list is read: the fresh copy has none of them.
  const UNIT = [{ id: 'unit', stage: 'full', command: ['node', 'tests/run.mjs'] }];
  const writer = written => `import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'; import { dirname } from 'node:path';\n${Object.entries(written).map(([f, c]) =>
    `mkdirSync(dirname(${JSON.stringify(f)}), { recursive: true }); writeFileSync(${JSON.stringify(f)}, ${JSON.stringify(c)}); chmodSync(${JSON.stringify(f)}, 0o755);`).join('\n')}\n`;
  const TOOLING = /touche l'outillage de affectedList/;
  const CONCERNED = /concerné par le changement depuis la production \(affectedList/;
  const cases = [
    // The change rewrites the tooling.
    ['F4 script', { files: { 'scripts/affected-list.mjs': "import { list } from './lib/list.mjs'; list();\n", ...lib(HONEST) }, attack: { 'scripts/affected-list.mjs': `process.exit(0);\n` }, why: TOOLING }],
    ['F4 local import', { files: { 'scripts/affected-list.mjs': "import { list } from './lib/list.mjs'; list();\n", ...lib(HONEST) }, attack: lib(LIE), why: TOOLING }],
    ['A1 import() with a template', { files: { 'scripts/affected-list.mjs': 'const { list } = await import(`./lib/list.mjs`); list();\n', ...lib(HONEST) }, attack: lib(LIE), why: TOOLING }],
    ['A9 computed path', { files: { 'scripts/affected-list.mjs': "const m = await import(new URL('./lib/' + 'list.mjs', import.meta.url)); m.list();\n", ...lib(HONEST) }, attack: lib(LIE), why: TOOLING }],
    ['A2 npm script that calls another', { list: NPM_LIST, files: { 'package.json': { name: 'x', scripts: { 'e2e:changed': 'npm run e2e:core --', 'e2e:core': 'node scripts/affected-list.mjs' } }, 'scripts/affected-list.mjs': `${HONEST}\n` },
      attack: { 'scripts/affected-list.mjs': `${LIE}\n` }, why: TOOLING }],
    ['A3 npm run --silent', { list: ['npm', 'run', '--silent', 'e2e:changed', '--', '{{baseSha}}'], files: { 'package.json': PKG, 'scripts/affected-list.mjs': `${HONEST}\n` }, attack: { 'scripts/affected-list.mjs': `${LIE}\n` }, why: TOOLING }],
    ['A3b npm test', { list: ['npm', 'test', '--', '{{baseSha}}'], files: { 'package.json': { name: 'x', scripts: { test: 'node scripts/affected-list.mjs' } }, 'scripts/affected-list.mjs': `${HONEST}\n` },
      attack: { 'package.json': { name: 'x', scripts: { test: 'node -e 0' } } }, why: TOOLING }],
    ['A4 shell script', { list: ['sh', 'scripts/affected.sh', '{{baseSha}}'], files: { 'scripts/affected.sh': 'node scripts/lib/list.mjs\n', ...lib(HONEST) }, attack: lib(LIE), why: TOOLING }],
    ['A5 .npmrc', { list: NPM_LIST, files: { 'package.json': PKG, 'scripts/affected-list.mjs': `${HONEST}\n` },
      attack: { '.npmrc': 'node-options=--require ./evil.cjs\n', 'evil.cjs': `${LIE} process.exit(0);\n` }, why: TOOLING }],
    ['A8 # import of package.json', { files: { 'package.json': { name: 'x', imports: { '#list': './scripts/lib/list.mjs' } }, 'scripts/affected-list.mjs': "import { list } from '#list'; list();\n", ...lib(HONEST) }, attack: lib(LIE), why: TOOLING }],
    ['A10 symbolic link', { files: { 'scripts/real.mjs': `${HONEST}\n` }, links: [['scripts/affected-list.mjs', 'real.mjs']], attack: { 'scripts/real.mjs': `${LIE}\n` }, why: TOOLING }],
    ['A11 configuration file read by the script', { files: { 'scripts/affected-list.mjs': "import { readFileSync } from 'node:fs'; const c = JSON.parse(readFileSync('affected.config.json', 'utf8')); console.log(`Listing tests:\\n  [chromium] › ${c.prefix}old.spec.ts:1:1 › x`);\n", 'affected.config.json': '{"prefix":"tests/"}\n' },
      attack: { 'affected.config.json': '{"prefix":"nowhere/"}\n' }, why: TOOLING }],
    ['A12 static import', { files: { 'scripts/affected-list.mjs': "import { list } from './lib/list.mjs'; list();\n", ...lib(HONEST) }, attack: lib(LIE), why: TOOLING }],
    ['D1 child_process runs a file the change rewrites', { files: { 'scripts/affected-list.mjs': "import { execFileSync } from 'node:child_process'; execFileSync(process.execPath, ['scripts/lib/list.mjs'], { stdio: 'inherit' });\n", 'scripts/lib/list.mjs': `${HONEST}\n` },
      attack: { 'scripts/lib/list.mjs': `${LIE}\n` }, why: TOOLING }],
    ['D2 createRequire with a computed path', { files: { 'scripts/affected-list.mjs': "import { createRequire } from 'node:module'; const load = createRequire(import.meta.url); load('./lib/' + 'list.cjs')();\n", 'scripts/lib/list.cjs': `module.exports = () => { ${HONEST} };\n` },
      attack: { 'scripts/lib/list.cjs': `module.exports = () => { ${LIE} };\n` }, why: TOOLING }],
    // The suite writes in its own copy: the list is read in another, where none of it exists, and stays honest.
    ['A6 the suite rewrites the script', { extra: UNIT, files: { 'scripts/affected-list.mjs': `${HONEST}\n`, 'tests/run.mjs': '\n' },
      attack: { 'tests/run.mjs': `import { writeFileSync } from 'node:fs'; writeFileSync('scripts/affected-list.mjs', ${JSON.stringify(LIE)});\n` }, why: CONCERNED }],
    ['B1 node_modules/.bin/node shadow', { list: NPM_LIST, extra: UNIT, files: { 'package.json': PKG, 'scripts/affected-list.mjs': `${HONEST}\n`, 'tests/run.mjs': '\n' },
      attack: { 'tests/run.mjs': writer({ 'node_modules/.bin/node': '#!/bin/sh\necho "Listing tests:"; echo "  [chromium] › tests/other.spec.ts:1:1 › x"\n' }) }, why: CONCERNED }],
    ['B2 untracked .npmrc', { list: NPM_LIST, extra: UNIT, files: { 'package.json': PKG, 'scripts/affected-list.mjs': `${HONEST}\n`, 'tests/run.mjs': '\n' },
      attack: { 'tests/run.mjs': writer({ '.npmrc': 'node-options=--require ./evil.cjs\n', 'evil.cjs': `${LIE} process.exit(0);\n` }) }, why: CONCERNED }],
    ['B3 list.js created before list/index.js', { list: ['node', 'scripts/affected-list.cjs', '{{baseSha}}'], extra: UNIT,
      files: { 'scripts/affected-list.cjs': "require('./lib/list')();\n", 'scripts/lib/list/index.js': `module.exports = () => { ${HONEST} };\n`, 'tests/run.mjs': '\n' },
      attack: { 'tests/run.mjs': writer({ 'scripts/lib/list.js': `module.exports = () => { ${LIE} };\n` }) }, why: CONCERNED }],
    ['B4 package.json main created in a module folder', { list: ['node', 'scripts/affected-list.cjs', '{{baseSha}}'], extra: UNIT,
      files: { 'scripts/affected-list.cjs': "require('./lib/list')();\n", 'scripts/lib/list/index.js': `module.exports = () => { ${HONEST} };\n`, 'tests/run.mjs': '\n' },
      attack: { 'tests/run.mjs': writer({ 'scripts/lib/list/package.json': '{"main":"evil.js"}', 'scripts/lib/list/evil.js': `module.exports = () => { ${LIE} };\n` }) }, why: CONCERNED }],
    // In the fresh copy the import of list.js finds only list.ts: the list fails, which blocks as well.
    ['B5 list.js created beside list.ts', { extra: UNIT, files: { 'scripts/affected-list.mjs': "import { list } from './lib/list.js'; list();\n", 'scripts/lib/list.ts': `export const list = () => { ${HONEST} };\n`, 'tests/run.mjs': '\n' },
      attack: { 'tests/run.mjs': writer({ 'scripts/lib/list.js': `export const list = () => { ${LIE} };\n` }) }, why: /affectedList en échec/ }],
  ];
  for (const [name, { list = NODE_LIST, files, attack, why, extra = [], links = [] }] of cases) {
    const p = project(t, { gates: [scriptedGate(dir, list), ...extra], files: { 'tests/old.spec.ts': 'old\n', 'src/x.js': 'x\n', ...files } });
    for (const [link, target] of links) { rmSync(join(p.repo, link), { force: true }); symlinkSync(target, join(p.repo, link)); }
    if (links.length) { git(p.repo, 'add', '-A'); git(p.repo, 'commit', '-qm', 'liens'); git(p.repo, 'push', '-q', 'origin', 'main'); git(p.repo, 'push', '-q', 'origin', 'main:production', '--force'); }
    const before = p.remote('production');
    put(p.repo, 'src/x.js', 'x2\n');
    for (const [path, text] of Object.entries(attack)) put(p.repo, path, text);
    git(p.repo, 'add', '-A'); git(p.repo, 'commit', '-qm', 'attaque'); git(p.repo, 'push', '-q', 'origin', 'main');
    const r = await apv(p.repo, ['release', 'auto'], ALLOW);
    assert.equal(r.code, 1, `${name}\n${r.stdout}${r.stderr}`);
    assert.match(r.stdout, why, name);
    assert.equal(p.remote('production'), before, name);
    assert.equal(existsSync(join(p.repo, '.apv', 'state', 'suivi-constats.md')), false, `${name}: no finding, it blocks`);
  }
  // The witness: only the application changes, the command and its script are untouched: judged, unrelated, published.
  const w = project(t, { gates: [scriptedGate(dir)], files: { 'tests/old.spec.ts': 'old\n', 'src/x.js': 'x\n', 'scripts/affected-list.mjs': `${LIE}\n` } });
  const sha = w.commit('src/x.js', 'x2\n'); git(w.repo, 'push', '-q', 'origin', 'main');
  const ok = await apv(w.repo, ['release', 'auto'], ALLOW);
  assert.equal(ok.code, 0, ok.stdout + ok.stderr);
  assert.equal(w.remote('production'), sha);
});

/** A setup that appends `label cwd` to `log`: what prepares a copy, and where. */
const labelled = (log, label) => node(`require("fs").appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(label)} + " " + process.cwd() + "\\n")`);

test('M3, M4: the copy of the judgment is prepared by the setup of production, never of the candidate, and is not the copy of the suite', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'apv4-une-suite-flaky-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, 'setups.log');
  const p = project(t, { gates: [scriptedGate(dir, ['node', 'scripts/affected-list.mjs', '{{baseSha}}'])], extra: { batch: { setup: labelled(log, 'production') } },
    files: { 'tests/old.spec.ts': 'old\n', 'src/x.js': 'x\n', 'scripts/affected-list.mjs': `${say('other')}\n` } });
  // The candidate declares its own setup (and changes the code): the judgment must not run it.
  const config = JSON.parse(readFileSync(join(p.repo, '.apv', 'config.json'), 'utf8'));
  put(p.repo, '.apv/config.json', { ...config, batch: { setup: labelled(log, 'candidat') } });
  p.commit('src/x.js', 'x2\n'); git(p.repo, 'push', '-q', 'origin', 'main');
  const r = await apv(p.repo, ['release', 'auto'], ALLOW);
  const lines = readFileSync(log, 'utf8').trim().split('\n').map(l => l.split(' '));
  assert.ok(lines.length >= 2, `${r.stdout}${r.stderr}\n${lines.join('\n')}`);
  const [last] = lines.slice(-1);
  assert.equal(last[0], 'production', 'the last copy prepared, the one of the judgment, ran the setup of production');
  assert.deepEqual(lines.filter(l => l[0] === 'production').length, 1, 'once');
  const suite = lines.find(l => l[0] === 'candidat');
  assert.ok(suite, 'the suite, itself, ran the candidate (not the judgment)');
  assert.notEqual(last[1], suite[1], 'the copy of the judgment is not the one of the suite');
  assert.match(last[1], /-jugement$/);
});

test('F1: a copy left locked by an earlier pass (git worktree lock) is unlocked and removed at the start of apv release auto', async t => {
  const p = project(t);
  const common = join(p.repo, '.git');
  const stale = join(common, 'apv', 'fresh', 'abcdef0123456789');
  mkdirSync(dirname(stale), { recursive: true });
  git(p.repo, 'worktree', 'add', '-q', '--detach', stale, 'HEAD');
  git(p.repo, 'worktree', 'lock', stale);
  assert.match(git(p.repo, 'worktree', 'list', '--porcelain'), /abcdef0123456789/);
  const r = await apv(p.repo, ['release', 'auto'], ALLOW);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(existsSync(stale), false, 'the directory is gone');
  assert.doesNotMatch(git(p.repo, 'worktree', 'list', '--porcelain'), /abcdef0123456789/, 'and the entry of Git');
});

test('F1, link: a link in fresh/ to the worktree of an agent (registered, locked) is never followed; a real stale copy is still removed', async t => {
  const p = project(t);
  const common = join(p.repo, '.git');
  const fresh = join(common, 'apv', 'fresh');
  mkdirSync(fresh, { recursive: true });
  const agent = join(p.root, 'agent-wt');
  git(p.repo, 'worktree', 'add', '-q', '--detach', agent, 'HEAD');
  writeFileSync(join(agent, 'wip.txt'), 'travail non commité\n');
  git(p.repo, 'worktree', 'lock', agent);
  const data = join(p.root, 'donnees'); mkdirSync(data); writeFileSync(join(data, 'x.txt'), 'x\n');
  symlinkSync(agent, join(fresh, 'lien-agent')); symlinkSync(p.repo, join(fresh, 'lien-principal')); symlinkSync(data, join(fresh, 'lien-donnees'));
  const stale = join(fresh, 'bbbbbbbbbbbbbbbb');
  git(p.repo, 'worktree', 'add', '-q', '--detach', stale, 'HEAD'); git(p.repo, 'worktree', 'lock', stale);
  const r = await apv(p.repo, ['release', 'auto'], ALLOW);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(readFileSync(join(agent, 'wip.txt'), 'utf8'), 'travail non commité\n', 'the work of the agent is intact');
  assert.match(git(p.repo, 'worktree', 'list', '--porcelain'), /agent-wt/, 'and still registered');
  assert.ok(existsSync(join(p.repo, 'README.md')) && existsSync(join(data, 'x.txt')), 'the main checkout and the data are intact');
  assert.match(r.stderr, /lien-agent non touchée : lien symbolique/);
  assert.equal(existsSync(stale), false, 'the real stale copy is removed');
  git(p.repo, 'worktree', 'unlock', agent);
});

test('the paths named by batch.setup (read at production) are tooling too: a change to them is refused', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'apv4-une-suite-flaky-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const p = project(t, { gates: [scriptedGate(dir)], extra: { batch: { setup: [process.execPath, 'tools/prepare.mjs'] } },
    files: { 'tests/old.spec.ts': 'old\n', 'src/x.js': 'x\n', 'tools/prepare.mjs': '\n', 'scripts/affected-list.mjs': `${say('other')}\n` } });
  const before = p.remote('production');
  put(p.repo, 'src/x.js', 'x2\n'); put(p.repo, 'tools/prepare.mjs', '// change\n');
  git(p.repo, 'add', '-A'); git(p.repo, 'commit', '-qm', 'setup change'); git(p.repo, 'push', '-q', 'origin', 'main');
  const r = await apv(p.repo, ['release', 'auto'], ALLOW);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /touche l'outillage de affectedList \(tools\/prepare\.mjs\)/);
  assert.equal(p.remote('production'), before);
});

test('AC-4: a test modified by the pull request that is unstable blocks: relaunched in the suite, or failing in the repetition (1 time out of 5)', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'apv4-une-suite-flaky-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const p = project(t, { gates: [flakyGate(dir, 'tests/old.spec.ts')], files: { 'tests/old.spec.ts': 'old\n' } });
  const before = p.remote('production');
  p.commit('tests/old.spec.ts', 'old, modifié\n'); git(p.repo, 'push', '-q', 'origin', 'main');
  const r = await apv(p.repo, ['release', 'auto'], ALLOW);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /tests\/old\.spec\.ts:3:5 › carte : fichier ajouté ou modifié depuis la production \(tests\/old\.spec\.ts\)/);
  assert.equal(p.remote('production'), before);

  // The repetition of the modified test fails once out of its five passes: red, never published.
  const count = join(dir, 'count');
  const fifth = `const fs = require("fs"); const n = (fs.existsSync(${JSON.stringify(count)}) ? Number(fs.readFileSync(${JSON.stringify(count)}, "utf8")) : 0) + 1; fs.writeFileSync(${JSON.stringify(count)}, String(n)); if (n % 5 === 0) { console.log("  1) [chromium] › tests/new.spec.ts:1:1 › nouveau"); process.exit(1); }`;
  const q = project(t, { gates: [{ id: 'browser', stage: 'full', command: node('0'), repeatChanged: { paths: ['tests/**'], times: 5, reference: 'origin/main',
    command: [...node(`for (let i = 0; i < 5; i++) { ${fifth.replace('process.exit(1);', 'process.exitCode = 1;')} }`), 'times={{repeat}}'] } }] });
  const was = q.remote('production');
  q.commit('tests/new.spec.ts', 'nouveau\n'); git(q.repo, 'push', '-q', 'origin', 'main');
  const red = await apv(q.repo, ['release', 'auto'], ALLOW);
  assert.equal(red.code, 1, red.stdout + red.stderr);
  assert.match(red.stdout, /Suite complète rouge à .*browser \(failed\)/);
  assert.equal(q.remote('production'), was);
});

test('AC-5: a migration added and not confirmed stops the release before any suite', async t => {
  const p = project(t, { release: { ...RELEASE, migrations: ['supabase/migrations/*.sql'] } });
  p.branch('feat'); p.commit('supabase/migrations/20261020120000_ajout.sql', 'select 1;\n');
  p.merge('feat');
  const before = p.ran().length;
  const r = await apv(p.repo, ['release', 'auto'], ALLOW);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^En attente : .*20261020120000/);
  assert.equal(p.ran().length, before);
  assert.notEqual(p.remote('production'), p.remote('main'));
  assert.equal((await apv(p.repo, ['release'], ALLOW)).code, 1);
});

test('configuration: affectedList needs retryFailed and {{baseSha}}', () => {
  const messages = value => configIssues(value).issues.map(i => i.message).join('\n');
  const gate = { id: 'unit', stage: 'full', command: ['npm', 'test'] };
  assert.match(messages({ gates: [{ ...gate, affectedList: ['npx', 'playwright', 'test', '--list', '--only-changed', '{{baseSha}}'] }] }), /affectedList .*declare retryFailed too/);
  assert.match(messages({ gates: [{ ...gate, retryFailed: { command: ['npm', 'test'] }, affectedList: ['npx', 'playwright', 'test', '--list', '--only-changed={{baseSha}}'] }] }), /placeholder as a whole argument/);
  assert.equal(messages({ gates: [{ ...gate, retryFailed: { command: ['npm', 'test'] }, affectedList: ['npx', 'playwright', 'test', '--list', '--only-changed', '{{baseSha}}'] }] }), '');
});

test('pathsIn: a path of the commit as written, the only file a runner path ends, never a suffix several files end (all of them for the list)', () => {
  const tracked = ['tests/e2e/a.spec.ts', 'tests/unit/a.spec.ts', 'tests/e2e/b.spec.ts', 'src/x.ts'];
  assert.deepEqual(pathsIn('[chromium] › tests/e2e/b.spec.ts:3:5 › carte', tracked), ['tests/e2e/b.spec.ts']);
  assert.deepEqual(pathsIn('[chromium] › e2e/b.spec.ts:3:5 › carte', tracked), ['tests/e2e/b.spec.ts']);
  assert.deepEqual(pathsIn('[chromium] › a.spec.ts:3:5 › carte', tracked), [], 'two files end with a.spec.ts');
  assert.deepEqual(pathsIn('a.spec.ts', tracked, true), ['tests/e2e/a.spec.ts', 'tests/unit/a.spec.ts']);
  assert.deepEqual(pathsIn('› carte sans fichier', tracked), []);
});
