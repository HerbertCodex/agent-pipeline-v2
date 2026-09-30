import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, git } from './helpers.mjs';
import { apv, write } from './cli-helpers.mjs';
import { proposeSplit } from '../dist/structure/split.js';

/**
 * One test per trial of the review of PR #98: every way around the ratchet, and every false block, on a small SvelteKit
 * project whose `src/lib/tools/` holds 13 modules (threshold 12) and `src/lib/components/ui/` 13 primitives.
 */
const read = (repo, path) => readFileSync(join(repo, path), 'utf8');
const commit = (repo, message) => { git(repo, 'add', '-A'); git(repo, 'commit', '-qm', message); };
const TOOLS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima', 'mike'];
const PRIMITIVES = ['Button', 'Card', 'Chip', 'Dialog', 'Field', 'Icon', 'Input', 'Menu', 'Pill', 'Select', 'Sheet', 'Tabs', 'Toast'];

async function project(t, extra = {}, config = null) {
  const files = {
    'package.json': JSON.stringify({ name: 'boite', dependencies: { '@sveltejs/kit': '2.0.0', svelte: '5.0.0' } }),
    'src/routes/+page.svelte': '<p>x</p>\n',
    ...Object.fromEntries(TOOLS.map(n => [`src/lib/tools/${n}.ts`, `export const ${n} = '${n}';\n`])),
    ...Object.fromEntries(PRIMITIVES.map(n => [`src/lib/components/ui/${n}.svelte`, `<div class="${n.toLowerCase()}"></div>\n`])),
    ...extra,
  };
  const f = fixture(t, { files });
  assert.equal((await apv(f.repo, ['init'])).code, 0);
  if (config) {
    const current = JSON.parse(read(f.repo, '.apv/config.json'));
    write(f.repo, '.apv/config.json', { ...current, ...config });
  }
  commit(f.repo, 'apv');
  const base = git(f.repo, 'rev-parse', 'HEAD');
  git(f.repo, 'switch', '-q', '-c', 'feature');
  const check = async () => (await apv(f.repo, ['structure', 'check', '--base', base, '--json'])).json();
  return { ...f, base, check };
}
const blocking = report => report.changes.filter(c => c.blocking).map(c => `${c.code} ${c.path} ${c.message}`);

test('review: a new module named after an existing stem (dates.extra.ts) is an addition; its known companions are not', async t => {
  const f = await project(t);
  write(f.repo, 'src/lib/tools/alpha.extra.ts', 'export const extra = 1;\n');
  write(f.repo, 'src/lib/tools/alpha.svelte.ts', 'export const reactive = $state(1);\n');
  write(f.repo, 'src/lib/tools/alpha.test.ts', "import { alpha } from './alpha';\n");
  write(f.repo, 'src/lib/tools/bravo.d.ts', 'export declare const b: string;\n');
  const report = await f.check();
  assert.equal(report.ok, false);
  assert.deepEqual(blocking(report).map(b => b.split(' ').slice(0, 2).join(' ')), ['flat-growth src/lib/tools/alpha.extra.ts']);
  assert.match(blocking(report)[0], /src\/lib\/tools\/ a déjà 13 fichiers de code \(seuil 12\)/);
});

test('review: vendor/, build/ and dot folders created under a flat folder are analysed, never excluded', async t => {
  const f = await project(t);
  for (const p of ['src/lib/tools/vendor/lib-a.ts', 'src/lib/tools/build/out.ts', 'src/lib/tools/.priv/hidden.ts']) write(f.repo, p, 'export const x = 1;\n');
  // In the flat folder itself too.
  write(f.repo, 'src/lib/tools/november.ts', 'export const november = 1;\n');
  const report = await f.check();
  const found = blocking(report).join('\n');
  assert.match(found, /flat-growth src\/lib\/tools\/november\.ts/);
  for (const dir of ['src/lib/tools/vendor/', 'src/lib/tools/build/', 'src/lib/tools/.priv/']) assert.match(found, new RegExp(`architecture-map [^\\n]*dossier ${dir.replace(/\./g, '\\.')} ajouté sans rôle`), dir);
  // Existing outputs and tool folders at the root keep their default exclusion.
  const root = await project(t, { 'vendor/lib/a.ts': 'export {};\n', 'build/b.ts': 'export {};\n' });
  assert.ok(!(await root.check()).findings.some(x => x.folder.startsWith('vendor') || x.folder.startsWith('build')));
});

test('review: a symbolic link added by the change blocks, even without the reuse check', async t => {
  const f = await project(t);
  symlinkSync('/etc', join(f.repo, 'src/lib/elsewhere'));
  const report = await f.check();
  assert.ok(report.changes.some(c => c.code === 'coverage' && c.blocking && c.path === 'src/lib/elsewhere' && /lien symbolique ajouté par le changement/.test(c.message)), JSON.stringify(report.changes));
  // Declared in structure.ignore at the base: accepted.
  const g = await project(t, {}, { structure: { ignore: ['src/lib/elsewhere'] } });
  symlinkSync('/etc', join(g.repo, 'src/lib/elsewhere'));
  assert.ok(!(await g.check()).changes.some(c => c.code === 'coverage'));
});

test('review: a duplicated marker blocks, and apv structure map refuses to refresh it', async t => {
  const f = await project(t);
  const map = read(f.repo, 'docs/carte-architecture.md');
  const tree = map.slice(map.indexOf('<!-- apv:genere:arborescence -->'), map.indexOf('<!-- /apv:genere:arborescence -->') + '<!-- /apv:genere:arborescence -->'.length);
  writeFileSync(join(f.repo, 'docs/carte-architecture.md'), map.replace('# Carte de l\'architecture\n', `# Carte de l'architecture\n\n${tree}\n`));
  const report = await f.check();
  assert.ok(report.changes.some(c => c.blocking && /marqueur <!-- apv:genere:arborescence --> présent plusieurs fois/.test(c.message)), JSON.stringify(report.changes));
  const refused = await apv(f.repo, ['structure', 'map']);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /marqueur présent plusieurs fois/);
});

test('review: a catch-all glob the change adds, or a role of a word, never describes a new folder; a glob of the base does', async t => {
  const f = await project(t);
  write(f.repo, 'src/lib/billing/invoice.ts', 'export const invoice = 1;\n');
  const mapFile = 'docs/carte-architecture.md';
  const map = read(f.repo, mapFile);
  writeFileSync(join(f.repo, mapFile), map.replace('<!-- /apv:ecrit:roles -->', '- `src/*/*/` : divers dossiers du projet\n<!-- /apv:ecrit:roles -->'));
  assert.match(blocking(await f.check()).join('\n'), /dossier src\/lib\/billing\/ ajouté sans rôle[^\n]*un motif ajouté par le changement ne décrit pas un élément nouveau/);
  writeFileSync(join(f.repo, mapFile), map.replace('<!-- /apv:ecrit:roles -->', '- `src/lib/billing/` : x\n<!-- /apv:ecrit:roles -->'));
  assert.match(blocking(await f.check()).join('\n'), /dossier src\/lib\/billing\/ ajouté sans rôle/);
  writeFileSync(join(f.repo, mapFile), map.replace('<!-- /apv:ecrit:roles -->', '- `src/lib/billing/` : factures et taxes des commandes\n<!-- /apv:ecrit:roles -->'));
  assert.equal((await f.check()).ok, true);
  // A glob already at the base describes the folders the change adds.
  const g = await project(t);
  git(g.repo, 'switch', '-q', 'main');
  writeFileSync(join(g.repo, mapFile), read(g.repo, mapFile).replace('<!-- /apv:ecrit:roles -->', '- `src/lib/*/` : un dossier par fonctionnalité du code partagé\n<!-- /apv:ecrit:roles -->'));
  commit(g.repo, 'roles');
  const base = git(g.repo, 'rev-parse', 'HEAD');
  git(g.repo, 'switch', '-q', 'feature');
  git(g.repo, 'merge', '-q', 'main');
  write(g.repo, 'src/lib/billing/invoice.ts', 'export const invoice = 1;\n');
  assert.equal((await apv(g.repo, ['structure', 'check', '--base', base, '--json'])).json().ok, true);
});

test('review: a code map written before the « Dossiers » section says so, and apv map once fixes it', async t => {
  const f = await project(t);
  const file = '.apv/code-map.md';
  writeFileSync(join(f.repo, file), read(f.repo, file).replace(/\n## Dossiers\n[\s\S]*?(?=\n## )/, '\n'));
  const stale = await apv(f.repo, ['map', '--check']);
  assert.equal(stale.code, 1);
  assert.match(stale.stdout, /Carte du code périmée par la mise à jour d'APV \(3\.0\.0-alpha\.11 : nouvelle section « Dossiers »/);
  assert.equal((await apv(f.repo, ['map', '--check', '--json'])).json().migration, true);
  await apv(f.repo, ['map']);
  assert.equal((await apv(f.repo, ['map', '--check'])).code, 0);
  // Recognised by the missing section, whatever else changed (a real map drops other entries past its 32 KB bound).
  writeFileSync(join(f.repo, file), read(f.repo, file).replace(/\n## Dossiers\n[\s\S]*?(?=\n## )/, '\n').replace(/\n- `[^\n]*/, ''));
  write(f.repo, 'src/lib/more.ts', 'export const more = 1;\n');
  assert.match((await apv(f.repo, ['map', '--check'])).stdout, /périmée par la mise à jour d'APV/);
  await apv(f.repo, ['map']);
  // Any other difference is a plain stale map.
  write(f.repo, 'src/lib/extra.ts', 'export const extra = 1;\n');
  assert.doesNotMatch((await apv(f.repo, ['map', '--check'])).stdout, /mise à jour d'APV/);
});

test('review: a file named as generated needs reuse.generated of the base, and says so', async t => {
  const f = await project(t);
  write(f.repo, 'src/lib/tools/client.generated.ts', 'export const client = 1;\n');
  assert.match(blocking(await f.check()).join('\n'), /flat-growth src\/lib\/tools\/client\.generated\.ts nommé comme un fichier généré, mais non déclaré dans reuse\.generated de la base/);
  const g = await project(t, {}, { reuse: { generated: ['src/lib/tools/*.generated.ts'] } });
  write(g.repo, 'src/lib/tools/client.generated.ts', 'export const client = 1;\n');
  assert.ok(!(await g.check()).changes.some(c => c.code === 'flat-growth'));
});

test('review: a rename with rewrite in the same folder (Git similarity) is no addition', async t => {
  const long = Array.from({ length: 30 }, (_, i) => `export const line${i} = ${i};`).join('\n');
  const f = await project(t, { 'src/lib/tools/alpha.ts': `${long}\n` });
  git(f.repo, 'mv', 'src/lib/tools/alpha.ts', 'src/lib/tools/omega.ts');
  writeFileSync(join(f.repo, 'src/lib/tools/omega.ts'), `${long.replace('line0 = 0', 'line0 = 100').replace('line1 = 1', 'line1 = 101')}\nexport const more = 1;\n`);
  commit(f.repo, 'rename');
  const report = await f.check();
  assert.ok(!report.changes.some(c => c.code === 'flat-growth'), JSON.stringify(report.changes));
});

test('review: a subfolder made by moving files down from the flat folder gets its role proposed, never blocked', async t => {
  const f = await project(t);
  mkdirSync(join(f.repo, 'src/lib/tools/greek'));
  for (const n of ['alpha', 'bravo']) git(f.repo, 'mv', `src/lib/tools/${n}.ts`, `src/lib/tools/greek/${n}.ts`);
  const report = await f.check();
  assert.equal(report.ok, true, blocking(report).join('\n'));
  const proposed = report.changes.find(c => /dossier src\/lib\/tools\/greek\/ créé par le rangement de src\/lib\/tools\//.test(c.message));
  assert.ok(proposed && !proposed.blocking && proposed.severity === 'warning', JSON.stringify(report.changes));
  assert.match(proposed.message, /rôle proposé à confirmer dans « Rôles » : « - `src\/lib\/tools\/greek\/` : greek : alpha\.ts, bravo\.ts/);
});

test('review: a folder of primitives is never split; a new primitive goes in its own folder', async t => {
  const f = await project(t);
  const flat = (await f.check()).findings.find(x => x.folder === 'src/lib/components/ui' && x.code === 'flat-folder');
  assert.equal(flat.primitives, true);
  assert.equal(flat.groups, undefined);
  assert.match(flat.proposal, /dossier de composants génériques[^\n]*liste à plat, ou un dossier par composant/);
  write(f.repo, 'src/lib/components/ui/Badge.svelte', '<span></span>\n');
  assert.match(blocking(await f.check()).join('\n'), /Badge\.svelte [^\n]*mettre le nouveau composant dans son propre dossier \(src\/lib\/components\/ui\/<Composant>\/\)/);
});

test('review 2: a test file alone never counts in the ratchet, as in the threshold', async t => {
  const f = await project(t);
  write(f.repo, 'src/lib/tools/newthing.test.ts', "import { test } from 'node:test';\n");
  write(f.repo, 'src/lib/tools/flows.test.ts', "import { test } from 'node:test';\n");
  const report = await f.check();
  assert.ok(!report.changes.some(c => c.code === 'flat-growth'), JSON.stringify(report.changes));
});

test('review 2: never a route name for a folder of code, never a synonym of a neighbour, never one file for a domain', () => {
  const dir = 'src/lib/components/applications';
  const entry = (name, tokens) => ({ path: `${dir}/${name}`, stem: name.split('.')[0], files: [`${dir}/${name}`], component: true, tokens });
  const cards = [entry('CompanyLine.svelte', ['company', 'line']), entry('CountryChip.svelte', ['country', 'chip'])];
  const table = [entry('ApplicationsTable.svelte', ['applications', 'table']), entry('RowMenu.svelte', ['row', 'menu'])];
  const accounts = [entry('AccountsList.svelte', ['accounts', 'list']), entry('Lists.svelte', ['lists']), entry('Repository.svelte', ['repository'])];
  const importers = new Map([
    [`${dir}/CountryChip.svelte`, [`${dir}/CompanyLine.svelte`, 'src/lib/components/dashboard/A.svelte']],
    [`${dir}/CompanyLine.svelte`, ['src/lib/components/dashboard/A.svelte', 'src/lib/components/dashboard/B.svelte']],
    [`${dir}/RowMenu.svelte`, [`${dir}/ApplicationsTable.svelte`, 'src/routes/tableau-de-bord/+page.svelte']],
    [`${dir}/ApplicationsTable.svelte`, ['src/routes/tableau-de-bord/+page.svelte', 'src/routes/tableau-de-bord/+layout.svelte']],
    [`${dir}/Lists.svelte`, [`${dir}/AccountsList.svelte`, `${dir}/Repository.svelte`]],
    [`${dir}/AccountsList.svelte`, [`${dir}/Repository.svelte`]],
  ]);
  const files = ['src/lib/components/dashboard/A.svelte', 'src/lib/components/dashboard/B.svelte', 'src/routes/tableau-de-bord/+page.svelte', 'src/routes/tableau-de-bord/+layout.svelte'];
  const split = proposeSplit(dir, [...cards, ...table, ...accounts], { importers, exports: new Map() }, {
    dirs: new Set(['src', 'src/lib', 'src/lib/components', dir, 'src/lib/components/dashboard', 'src/routes', 'src/routes/tableau-de-bord']),
    files: [...cards, ...table, ...accounts].map(e => e.path).concat(files), domains: ['account'], maxFlatFiles: 12,
  });
  assert.deepEqual(split.groups, [], JSON.stringify(split.groups));
  assert.equal(split.unnamed.length, 3);
});
