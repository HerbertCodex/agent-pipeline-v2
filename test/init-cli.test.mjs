import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture, git } from './helpers.mjs';
import { apv, write } from './cli-helpers.mjs';
import { briefFromTemplate, initProject, PLUGIN_ROOT, BRIEF_TEMPLATE } from '../dist/commands/init.js';

const read = (repo, path) => readFileSync(join(repo, path), 'utf8');

test('apv init creates .apv/ with a valid ledger, a named configuration and the brief model', async t => {
  const f = fixture(t);
  const r = await apv(f.repo, ['init', '--name', 'Toujours rien', '--json']);
  assert.equal(r.code, 0, r.stderr);
  const out = r.json();
  assert.equal(out.name, 'Toujours rien');
  assert.deepEqual(out.created, ['.apv/', '.apv/config.json', '.apv/DECISIONS.json', '.apv/brief.md', '.apv/specs/', '.apv/state/', '.apv/.gitignore', '.apv/code-map.md', 'docs/carte-architecture.md']);
  assert.deepEqual([out.existing, out.completed], [[], []]);
  // Not a web project: the tree and the code map checks, no reuse section.
  assert.deepEqual(JSON.parse(read(f.repo, '.apv/config.json')), { name: 'Toujours rien', gates: [
    { id: 'structure', command: ['apv', 'structure', 'check', '--base', '{{baseSha}}'], covers: ['architecture'], stage: 'task', readOnly: true, mandatory: true },
    { id: 'code-map', command: ['apv', 'map', '--check'], covers: ['architecture'], stage: 'full', readOnly: true, mandatory: true },
  ] });
  assert.deepEqual([out.reuse.web, out.reuse.gates, out.reuse.section, out.reuse.map], [false, ['structure', 'code-map'], null, '.apv/code-map.md']);
  assert.match(read(f.repo, 'docs/carte-architecture.md'), /^# Carte de l'architecture\n[\s\S]*<!-- apv:ecrit:roles -->/);
  assert.equal((await apv(f.repo, ['structure', 'map', '--check'])).code, 0, 'the architecture map written by init is up to date');
  assert.match(read(f.repo, '.apv/code-map.md'), /^# Carte du code\n/);
  assert.equal((await apv(f.repo, ['map', '--check'])).code, 0, 'the map written by init is up to date');
  for (const dir of ['.apv/specs', '.apv/state']) assert.ok(statSync(join(f.repo, dir)).isDirectory(), dir);
  const brief = read(f.repo, '.apv/brief.md');
  assert.match(brief, /^# Consigne commune des implementers \(Toujours rien\)\n/);
  assert.ok(!brief.includes('```markdown') && !brief.includes('<nom du projet>'), 'fenced model extracted, name substituted');
  assert.match(brief, /## Rapport final/);
  for (const line of ['state/*.log', 'state/task.json', 'receipts/']) assert.ok(read(f.repo, '.apv/.gitignore').split('\n').includes(line), line);
  // The created ledger and configuration are valid for the other commands.
  assert.equal((await apv(f.repo, ['ledger', 'validate'])).code, 0);
  const status = (await apv(f.repo, ['status', '--json'])).json();
  assert.deepEqual([status.config.file, status.config.ignored, status.config.error, status.ledger.decisions], ['.apv/config.json', [], null, 0]);
});

test('apv init is idempotent and never overwrites an existing file', async t => {
  const f = fixture(t);
  write(f.repo, '.apv/config.json', { gates: [{ id: 'unit', command: ['npm', 'test'] }] });
  write(f.repo, '.apv/brief.md', '# Ma consigne\n');
  write(f.repo, '.apv/.gitignore', 'mine/\n');
  const first = await apv(f.repo, ['init']);
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stdout, /Créé : \.apv\/DECISIONS\.json, \.apv\/specs\/, \.apv\/state\//);
  assert.match(first.stdout, /Complété : \.apv\/\.gitignore/);
  assert.match(first.stdout, /Existait déjà \(inchangé\) : \.apv\/, \.apv\/config\.json, \.apv\/brief\.md/);
  assert.deepEqual(JSON.parse(read(f.repo, '.apv/config.json')).gates[0].id, 'unit');
  assert.equal(read(f.repo, '.apv/brief.md'), '# Ma consigne\n');
  assert.match(read(f.repo, '.apv/.gitignore'), /^mine\/\nstate\/\*\.log\n/);
  const again = await apv(f.repo, ['init', '--json']);
  assert.equal(again.code, 0);
  assert.deepEqual([again.json().created, again.json().completed], [[], []]);
  assert.match((await apv(f.repo, ['init'])).stdout, /Rien à créer : \.apv\/ est complet\./);
});

test('apv init names the project after the repository folder and works from a subfolder', async t => {
  const f = fixture(t);
  const r = await apv(join(f.repo, 'docs'), ['init', '--json']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json().name, 'repo');
  assert.ok(existsSync(join(f.repo, '.apv/config.json')), 'created at the repository root');
  assert.ok(!existsSync(join(f.repo, 'docs/.apv')));
});

test('apv init refuses outside a Git repository and rejects wrong calls', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'apv3-nogit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const r = await apv(dir, ['init']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /NOT_A_REPOSITORY.*Pas un dépôt Git/);
  assert.ok(!existsSync(join(dir, '.apv')));
  const f = fixture(t);
  assert.equal((await apv(f.repo, ['init', 'extra'])).code, 2);
  assert.equal((await apv(f.repo, ['init', '--name', ' '])).code, 2);
  assert.equal((await apv(f.repo, ['init', '--bogus'])).code, 2);
  assert.match((await apv(f.repo, ['init', '--help'])).stdout, /sans jamais écraser/);
});

test('the brief comes from the reference of the project lead skill, resolved from dist/', async t => {
  assert.ok(existsSync(join(PLUGIN_ROOT, BRIEF_TEMPLATE)));
  assert.equal(briefFromTemplate('intro\n```markdown\n# Consigne (<nom du projet>)\nTexte `code`.\n```\n', 'X'), '# Consigne (X)\nTexte `code`.\n');
  assert.equal(briefFromTemplate('# Sans bloc\n', 'X'), '# Sans bloc\n');
  const f = fixture(t);
  await assert.rejects(initProject(f.repo, 'X', join(f.root, 'nowhere')), /Modèle de consigne introuvable/);
  assert.ok(!existsSync(join(f.repo, '.apv')), 'nothing written when the model is missing');
});

test('apv spec new writes a draft-valid skeleton that launch mode refuses', async t => {
  const f = fixture(t);
  const r = await apv(f.repo, ['spec', 'new', 'export-csv', '--title', 'Export CSV', '--json']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json(), { created: true, file: '.apv/specs/export-csv.json', id: 'export-csv', title: 'Export CSV' });
  const spec = JSON.parse(read(f.repo, '.apv/specs/export-csv.json'));
  assert.equal(spec.title, 'Export CSV');
  assert.equal(spec.tasks.length, 1);
  const draft = await apv(f.repo, ['spec', 'validate', '.apv/specs/export-csv.json', '--draft', '--json']);
  assert.equal(draft.code, 0, draft.stdout);
  assert.equal(draft.json().security.minimumLane, 'fast', 'the skeleton names nothing security-sensitive');
  const ready = await apv(f.repo, ['spec', 'validate', '.apv/specs/export-csv.json', '--json']);
  assert.equal(ready.code, 1);
  assert.deepEqual(ready.json().issues.map(i => i.code), ['OPEN_QUESTIONS']);
  const human = await apv(join(f.repo, 'src'), ['spec', 'new', 'second']);
  assert.equal(human.code, 0);
  assert.match(human.stdout, /Spec créée : \.apv\/specs\/second\.json/);
  assert.equal(JSON.parse(read(f.repo, '.apv/specs/second.json')).title, 'second');
});

test('apv spec new refuses to overwrite, and rejects ids that are not kebab-case', async t => {
  const f = fixture(t);
  write(f.repo, '.apv/specs/taken.json', '{"mine":true}\n');
  const taken = await apv(f.repo, ['spec', 'new', 'taken']);
  assert.equal(taken.code, 1);
  assert.match(taken.stderr, /existe déjà/);
  assert.equal(read(f.repo, '.apv/specs/taken.json'), '{"mine":true}\n');
  assert.deepEqual((await apv(f.repo, ['spec', 'new', 'taken', '--json'])).json(), { created: false, file: '.apv/specs/taken.json', reason: 'exists' });
  for (const id of ['Bad', 'a_b', '-a', 'a-', 'a--b', 'a/b', 'x'.repeat(81)]) assert.equal((await apv(f.repo, ['spec', 'new', id])).code, 2, id);
  assert.equal((await apv(f.repo, ['spec', 'new'])).code, 2);
  assert.equal((await apv(f.repo, ['spec', 'new', 'a', 'b'])).code, 2);
  assert.equal((await apv(f.repo, ['spec', 'new', 'a', '--draft'])).code, 2);
  assert.equal((await apv(f.repo, ['spec', 'validate', 'x.json', '--title', 't'])).code, 2);
  const dir = mkdtempSync(join(tmpdir(), 'apv3-nogit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal((await apv(dir, ['spec', 'new', 'a'])).code, 1);
});

test('apv init and apv onboard add the validated-mockup line to .gitattributes when design.dir is declared or the folder exists', async t => {
  const declared = fixture(t, { files: { '.apv/config.json': '{ "name": "demo", "design": { "dir": "maquettes" } }\n' } });
  const r = await apv(declared.repo, ['init', '--json']);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.json().created.includes('.gitattributes'));
  assert.match(read(declared.repo, '.gitattributes'), /^# Maquettes validées[^\n]*\nmaquettes\/\*\*\/\*\.html -whitespace\n$/);
  assert.match((await apv(declared.repo, ['init'])).stdout, /Existait déjà \(inchangé\) : [^\n]*\.gitattributes/);
  // Onboarding a project whose default folder exists and whose .gitattributes lacks the line: completed.
  const pilot = fixture(t, { files: { 'docs/design/accueil-validee.html': HTML_SPACED, '.gitattributes': '* text=auto\n' } });
  const dry = await apv(pilot.repo, ['onboard', '--dry-run', '--json']);
  assert.ok(dry.json().completed.includes('.gitattributes'));
  assert.equal(read(pilot.repo, '.gitattributes'), '* text=auto\n', 'dry run writes nothing');
  const onboard = await apv(pilot.repo, ['onboard', '--json']);
  assert.equal(onboard.code, 0, onboard.stderr);
  assert.match(read(pilot.repo, '.gitattributes'), /^\* text=auto\n# Maquettes validées[^\n]*\ndocs\/design\/\*\*\/\*\.html -whitespace\n$/);
  assert.match(onboard.json().next.at(-1), /git add \.apv \.gitattributes/);
  // Groups declared and the root-only line of an earlier version: replaced in place, never duplicated.
  const grouped = fixture(t, { files: { '.apv/config.json': '{ "name": "demo", "design": { "groups": [{ "dir": "admin", "match": ["admin-*"] }] } }\n',
    '.gitattributes': '# maquettes\ndocs/design/*.html -whitespace\n' } });
  const replaced = await apv(grouped.repo, ['init', '--json']);
  assert.equal(replaced.code, 0, replaced.stderr);
  assert.ok(replaced.json().completed.includes('.gitattributes'));
  assert.equal(read(grouped.repo, '.gitattributes'), '# maquettes\ndocs/design/**/*.html -whitespace\n');
  // Neither declared nor present: untouched.
  const bare = fixture(t);
  assert.ok(!(await apv(bare.repo, ['init', '--json'])).json().created.includes('.gitattributes'));
  assert.ok(!existsSync(join(bare.repo, '.gitattributes')));
});

const HTML_SPACED = '<p>Accueil</p> \n';

test('apv init and apv onboard list the checks the rules require that an existing configuration lacks, never changing it', async t => {
  const f = fixture(t, { files: { 'package.json': JSON.stringify({ name: 'x', dependencies: { svelte: '5.0.0' } }), 'src/App.svelte': '<p>x</p>\n',
    '.apv/config.json': JSON.stringify({ name: 'x', gates: [{ id: 'reuse', command: ['apv', 'reuse', 'check'], mandatory: true }, { id: 'structure', command: ['apv', 'structure', 'check'] }] }) } });
  const before = readFileSync(join(f.repo, '.apv/config.json'), 'utf8');
  const init = await apv(f.repo, ['init']);
  assert.equal(init.code, 0, init.stderr);
  assert.match(init.stdout, /ATTENTION : contrôles requis avant toute fusion absents de \.apv\/config\.json : code-map \(apv map --check\), structure \(apv structure check, à rendre obligatoire\)/);
  assert.match(init.stdout, /Règles avant toute fusion, vérifiées par apv stack merge/);
  const onboard = await apv(f.repo, ['onboard', '--dry-run', '--json']);
  assert.deepEqual(onboard.json().reuse.missingRequired, ['code-map (apv map --check)', 'structure (apv structure check, à rendre obligatoire)']);
  assert.equal(readFileSync(join(f.repo, '.apv/config.json'), 'utf8'), before, 'never changed');
});

// Pilot project, 1 October 2026: the repository did not delete merged branches (delete_branch_on_merge false), 54 piled up.
test('apv init reads delete_branch_on_merge of the GitHub repository of origin and gives the command, never runs it', async t => {
  const fakeGh = fileURLToPath(new URL('./support/fake-gh.mjs', import.meta.url));
  chmodSync(fakeGh, 0o755);
  const project = (repo, origin = 'git@github.com:o/r.git', extra = {}) => {
    const f = fixture(t);
    git(f.repo, 'remote', 'add', 'origin', origin);
    const state = join(f.root, 'gh.json');
    writeFileSync(state, JSON.stringify({ prs: {}, calls: [], repo, ...extra }));
    return { f, env: { APV_GH: fakeGh, FAKE_GH_STATE: state }, calls: () => JSON.parse(readFileSync(state, 'utf8')).calls };
  };
  const off = project({ delete_branch_on_merge: false });
  const r = await apv(off.f.repo, ['init'], off.env);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /ATTENTION : le dépôt GitHub o\/r ne supprime pas la branche d'une PR fusionnée \(delete_branch_on_merge faux\) : les branches s'accumulent\. Pour l'activer : gh api -X PATCH repos\/o\/r -F delete_branch_on_merge=true \(commande non lancée par apv init\)\./);
  assert.deepEqual(off.calls(), [['api', 'repos/o/r', '--jq', '{default_branch, fork, delete_branch_on_merge}']], 'one read, never the PATCH');
  const j = await apv(off.f.repo, ['init', '--json'], off.env);
  assert.deepEqual(j.json().github, { repo: 'o/r', host: 'github.com', deleteBranchOnMerge: false, command: 'gh api -X PATCH repos/o/r -F delete_branch_on_merge=true', note: null });

  const on = project({ delete_branch_on_merge: true });
  const ok = await apv(on.f.repo, ['init'], on.env);
  assert.match(ok.stdout, /Dépôt GitHub o\/r : la branche d'une PR fusionnée est supprimée par GitHub \(delete_branch_on_merge\)\./);
  assert.doesNotMatch(ok.stdout, /ATTENTION : le dépôt GitHub/);

  // Read without the rights to see the setting, or a failed call: said, never a failed init.
  const hidden = project({ delete_branch_on_merge: null });
  const h = await apv(hidden.f.repo, ['init'], hidden.env);
  assert.equal(h.code, 0);
  assert.match(h.stdout, /Réglage delete_branch_on_merge du dépôt GitHub o\/r non vérifié : delete_branch_on_merge absent de la réponse/);
  const failing = await apv(hidden.f.repo, ['init', '--json'], { APV_GH: join(hidden.f.root, 'pas-de-gh') });
  assert.equal(failing.code, 0);
  assert.match(failing.json().github.note, /ENOENT/);

  // Another server: asked only when gh is logged in to it; credentials in the address never shown.
  const other = project({ delete_branch_on_merge: false }, 'https://deploy:s3cr3t-token@git.example.com/o/r.git');
  const o = await apv(other.f.repo, ['init', '--json'], other.env);
  assert.equal(o.code, 0, o.stderr);
  assert.deepEqual(other.calls(), [['auth', 'status', '--hostname', 'git.example.com']], 'the repository is never asked');
  assert.match(o.json().github.note, /hôte git\.example\.com inconnu de gh .* non interrogé/);
  const ot = await apv(other.f.repo, ['init'], other.env);
  assert.match(ot.stdout, /Réglage delete_branch_on_merge du dépôt GitHub o\/r non vérifié : hôte git\.example\.com inconnu de gh/);
  for (const out of [o.stdout, o.stderr, ot.stdout, ot.stderr]) assert.ok(!out.includes('s3cr3t') && !out.includes('deploy'), out);
  const known = project({ delete_branch_on_merge: false }, 'https://deploy:s3cr3t-token@ghe.example.com/o/r.git', { authHosts: ['ghe.example.com'] });
  const k = await apv(known.f.repo, ['init', '--json'], known.env);
  assert.deepEqual(known.calls(), [['auth', 'status', '--hostname', 'ghe.example.com'], ['api', '--hostname', 'ghe.example.com', 'repos/o/r', '--jq', '{default_branch, fork, delete_branch_on_merge}']]);
  assert.equal(k.json().github.command, 'gh api --hostname ghe.example.com -X PATCH repos/o/r -F delete_branch_on_merge=true');
  assert.ok(!k.stdout.includes('s3cr3t'));
  const odd = project({}, 'https://deploy:s3cr3t-token@example.com/seul');
  const u = await apv(odd.f.repo, ['init', '--json'], odd.env);
  assert.equal(u.json().github.note, 'adresse de origin non reconnue comme un dépôt GitHub (https://***@example.com/seul)');
  assert.ok(!u.stdout.includes('s3cr3t'));
  assert.deepEqual(odd.calls(), []);

  // No GitHub origin: nothing called, nothing said.
  const local = fixture(t);
  const none = await apv(local.repo, ['init', '--json'], { APV_GH: join(local.root, 'pas-de-gh') });
  assert.deepEqual(none.json().github, { repo: null, host: null, deleteBranchOnMerge: null, command: null, note: 'pas de dépôt distant origin' });
  assert.doesNotMatch((await apv(local.repo, ['init'])).stdout, /delete_branch_on_merge/);
});
