import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture, git } from './helpers.mjs';
import { apv, write } from './cli-helpers.mjs';
import { detectReference } from '../dist/reuse/detect.js';
import { buildWorktreeInventory } from '../dist/knowledge/inventory.js';
import { buildCodeMap } from '../dist/knowledge/code-map.js';
import { mapSettings, reuseSettings } from '../dist/reuse/config.js';
import { mapFields } from '../dist/commands/init.js';

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const read = (repo, path) => readFileSync(join(repo, path), 'utf8');
const commit = (repo, message) => { git(repo, 'add', '-A'); git(repo, 'commit', '-qm', message); };

/** A total, copied later: 9 lines, well above 5 lines and 50 tokens. */
const TOTAL = `export function total(items: { price: number; quantity: number; active: boolean }[]): number {
  let sum = 0;
  for (const item of items) {
    if (!item.active) continue;
    sum += item.price * item.quantity;
  }
  const rounded = Math.round(sum * 100) / 100;
  return rounded;
}
`;

/**
 * A SvelteKit project like the pilot: a shell of shared components (Sidebar, TabBar, Topbar, Toast), a primitive Select,
 * a global sheet with primitives, French texts; one block already copied twice on main (adoption: never blocking).
 */
const PROJECT = {
  'package.json': JSON.stringify({ name: 'demo', dependencies: { svelte: '5.0.0', '@sveltejs/kit': '2.0.0' } }),
  'src/app.html': '<!doctype html>\n<html lang="fr">\n<body>%sveltekit.body%</body>\n</html>\n',
  'src/app.css': '.btn { padding: 0.5rem; }\n.btn--primary { color: white; }\n@layer components { .input { border: 1px solid; } .panel { padding: 1rem; } }\n',
  'src/lib/components/Sidebar.svelte': '<!-- @component Barre latérale repliable de l\'application. -->\n<script lang="ts">\n  let { collapsed = false }: { collapsed?: boolean } = $props();\n</script>\n<nav class:collapsed>…</nav>\n',
  'src/lib/components/TabBar.svelte': '<script lang="ts">\n  let { tabs }: { tabs: string[] } = $props();\n</script>\n<nav>{#each tabs as tab (tab)}<a href="#{tab}">{tab}</a>{/each}</nav>\n',
  'src/lib/components/Topbar.svelte': '<header>Toujours rien</header>\n',
  'src/lib/components/Toast.svelte': '<script lang="ts">\n  // Message bref, annoncé aux lecteurs d\'écran.\n  let { message }: { message: string } = $props();\n</script>\n<div role="status">{message}</div>\n',
  'src/lib/components/ui/Select.svelte': '<!-- @component Liste déroulante du socle. -->\n<script lang="ts">\n  let { value = $bindable(), options }: { value: string; options: string[] } = $props();\n</script>\n<select bind:value class="input">{#each options as o (o)}<option>{o}</option>{/each}</select>\n',
  'src/lib/cart/total.ts': TOTAL,
  'src/lib/legacy/total-copy.ts': `// Ancienne copie, déjà présente sur main.\n${TOTAL}`,
  'src/routes/+layout.svelte': '<script lang="ts">\n  import Sidebar from \'$lib/components/Sidebar.svelte\';\n  import TabBar from \'$lib/components/TabBar.svelte\';\n  import Topbar from \'$lib/components/Topbar.svelte\';\n  let { children } = $props();\n</script>\n<Topbar /><Sidebar /><TabBar tabs={[\'a\']} />{@render children()}\n',
  'src/routes/+page.svelte': '<script lang="ts">\n  import Select from \'$lib/components/ui/Select.svelte\';\n  import Toast from \'$lib/components/Toast.svelte\';\n  import { total } from \'$lib/cart/total\';\n  let v = $state(\'a\');\n</script>\n<Select bind:value={v} options={[\'a\']} />\n<Toast message={String(total([]))} />\n',
};

/** The project on main, with `origin/main` pointing at it (the reference the check counts from). */
function project(t) {
  const f = fixture(t, { files: PROJECT });
  git(f.repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  return f;
}

/** `apv` on the PATH of the checks, as the plugin makes it in Claude Code sessions. */
function withApvOnPath(f) {
  const bin = join(f.root, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'apv'), `#!/bin/sh\nexec "${process.execPath}" "${CLI}" "$@"\n`);
  chmodSync(join(bin, 'apv'), 0o755);
  return { PATH: `${bin}:${process.env.PATH}` };
}

/** The admin of the pilot, rebuilt the wrong way: own shell and toast, native select, restyled primitives, a copied block, a breakable hour. */
function badAdmin(repo) {
  write(repo, 'src/routes/admin/AdminShell.svelte', '<script lang="ts">\n  let { children } = $props();\n</script>\n<aside class="admin-shell">{@render children()}</aside>\n<style>\n  .admin-shell { display: grid; }\n  .btn { padding: 0; }\n  .admin-shell .input { border: 0; }\n</style>\n');
  write(repo, 'src/routes/admin/AdminToast.svelte', '<script lang="ts">\n  let { message }: { message: string } = $props();\n</script>\n<div role="status" class="admin-toast">{message}</div>\n');
  write(repo, 'src/routes/admin/+page.svelte', '<script lang="ts">\n  import AdminShell from \'./AdminShell.svelte\';\n  import AdminToast from \'./AdminToast.svelte\';\n  let v = $state(\'a\');\n</script>\n<AdminShell>\n  <select bind:value={v}><option>a</option></select>\n  <p>Publié à 14 h 47.</p>\n  <AdminToast message="ok" />\n</AdminShell>\n');
  write(repo, 'src/routes/admin/total.ts', TOTAL.replace('total(', 'adminTotal('));
}

test('apv onboard on an existing web project: reuse and code map checks, detected section, map written, what is already duplicated listed', async t => {
  const f = project(t);
  const r = await apv(f.repo, ['onboard', '--json']);
  assert.equal(r.code, 0, r.stderr);
  const out = r.json();
  const config = JSON.parse(read(f.repo, '.apv/config.json'));
  // The base of the run ({{baseSha}}, in the proof key) says what is new; the map is checked by the full suite.
  assert.deepEqual(config.gates.map(g => [g.id, g.command.join(' '), g.stage, g.readOnly]), [['reuse', 'apv reuse check --base {{baseSha}}', 'task', true], ['code-map', 'apv map --check', 'full', true]]);
  assert.deepEqual(config.reuse, {
    reference: 'origin/main',
    shared: ['src/lib/components/**'],
    native: { elements: { select: 'src/lib/components/ui/Select.svelte', dialog: null, datalist: 'src/lib/components/ui/Select.svelte' }, allowedPaths: ['src/lib/components/ui/**'] },
    styles: { allowedPaths: ['src/lib/components/ui/**'] },
    typography: { locale: 'fr' },
  });
  assert.equal(out.reuse.web, true);
  assert.deepEqual(out.reuse.gates, ['reuse', 'code-map']);
  assert.ok(out.created.includes('.apv/code-map.md'));
  assert.equal(out.reuse.existing.counts.duplicates, 1);
  assert.match(out.reuse.existing.examples[0].place, /^src\/lib\/legacy\/total-copy\.ts:2-10$/);
  assert.match(out.reuse.existing.examples[0].message, /bloc identique à src\/lib\/cart\/total\.ts:1-9 \(9 lignes/);
  const text = (await apv(f.repo, ['onboard', '--dry-run'])).stdout;
  assert.match(text, /Réutilisation des éléments existants :/);
  const map = read(f.repo, '.apv/code-map.md');
  assert.match(map, /### src\/lib\/components\n\n- `Sidebar\.svelte` : Barre latérale repliable de l'application\. Props : collapsed\. Utilisé par 1 fichier \(src\/routes\/\+layout\.svelte\)\./);
  assert.match(map, /### src\/lib\/components\/ui\n\n- `Select\.svelte` : Liste déroulante du socle\. Props : value, options\. Utilisé par 1 fichier \(src\/routes\/\+page\.svelte\)\./);
  assert.match(map, /- `total\.ts` : sans description\. Exporte : total\(\)\. Utilisé par 1 fichier/);
  assert.match(map, /- `\/` : src\/routes \(\+layout\.svelte, \+page\.svelte\)/);
  // Adoption: on main, the old copy is reported as existing, never blocking; the map is up to date.
  commit(f.repo, 'apv');
  git(f.repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  const check = await apv(f.repo, ['reuse', 'check', '--json']);
  assert.equal(check.code, 0, check.stdout);
  assert.deepEqual([check.json().rules.duplicates.new, check.json().rules.duplicates.existing], [0, 1]);
  assert.equal((await apv(f.repo, ['map', '--check'])).code, 0);
});

test('apv reuse check blocks what a change adds: native select, restyled primitives, copied block, redone shared components; hours are warnings', async t => {
  const f = project(t);
  assert.equal((await apv(f.repo, ['onboard'])).code, 0);
  commit(f.repo, 'apv');
  git(f.repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(f.repo, 'switch', '-q', '-c', 'feature/admin');
  badAdmin(f.repo);
  const r = await apv(f.repo, ['reuse', 'check', '--json']);
  assert.equal(r.code, 1);
  const out = r.json();
  assert.equal(out.base.source, 'reference');
  const found = out.findings.filter(x => x.isNew).map(x => `${x.rule}:${x.path}:${x.line}:${x.blocking}`);
  assert.deepEqual(found, [
    'native:src/routes/admin/+page.svelte:7:true',
    'styles:src/routes/admin/AdminShell.svelte:7:true',
    'styles:src/routes/admin/AdminShell.svelte:8:true',
    'duplicates:src/routes/admin/total.ts:2:true',
    'names:src/routes/admin/AdminShell.svelte:1:true',
    'names:src/routes/admin/AdminToast.svelte:1:true',
    'typography:src/routes/admin/+page.svelte:8:false',
  ]);
  const byRule = rule => out.findings.find(x => x.rule === rule && x.isNew);
  assert.match(byRule('native').message, /<select> natif réservé aux composants partagés : utiliser src\/lib\/components\/ui\/Select\.svelte\./);
  assert.match(byRule('styles').message, /« \.btn » redéfinit la primitive \.btn \(src\/app\.css\)/);
  assert.match(out.findings.find(x => x.rule === 'styles' && x.line === 8).message, /sous une classe du composant avec border \(seule la mise en page est permise/);
  assert.deepEqual(byRule('duplicates').other, { path: 'src/lib/cart/total.ts', line: 2, endLine: 9 });
  assert.match(out.findings.find(x => x.path.endsWith('AdminToast.svelte')).message, /^refait src\/lib\/components\/Toast\.svelte \(rôle toast\), composant partagé générique/);
  assert.match(out.findings.find(x => x.path.endsWith('AdminShell.svelte') && x.rule === 'names').message,
    /^refait src\/lib\/components\/Sidebar\.svelte \(rôle sidebar\), src\/lib\/components\/TabBar\.svelte \(rôle tabbar\), src\/lib\/components\/Topbar\.svelte \(rôle topbar\), composants partagés génériques : l'utiliser, ou le composer/);
  assert.match(byRule('typography').message, /heure « 14 h 47 » : espace insécable attendue/);
  assert.equal(out.rules.duplicates.existing, 1, 'the copy already on main stays reported, never blocking');
  const human = await apv(f.repo, ['reuse', 'check']);
  assert.match(human.stdout, /\[bloquant\] src\/routes\/admin\/\+page\.svelte:7 : <select> natif/);
  assert.match(human.stdout, /\[bloquant\] src\/routes\/admin\/total\.ts:2-9 : bloc identique à src\/lib\/cart\/total\.ts:2-9/);
  assert.match(human.stdout, /\[existant\] src\/lib\/legacy\/total-copy\.ts/);
  assert.match(human.stdout, /Résultat : ÉCHEC, 6 constat\(s\) bloquant\(s\)/);
  // The same project fixed: the shared components reused, the block imported, the hour unbreakable.
  rmSync(join(f.repo, 'src/routes/admin'), { recursive: true });
  write(f.repo, 'src/routes/admin/+page.svelte', '<script lang="ts">\n  import Select from \'$lib/components/ui/Select.svelte\';\n  import Toast from \'$lib/components/Toast.svelte\';\n  import { total } from \'$lib/cart/total\';\n  let v = $state(\'a\');\n</script>\n<Select bind:value={v} options={[\'a\']} />\n<p>Publié à 14 h 47.</p>\n<Toast message={String(total([]))} />\n');
  const fixed = await apv(f.repo, ['reuse', 'check', '--json']);
  assert.equal(fixed.code, 0, JSON.stringify(fixed.json().findings.filter(x => x.isNew)));
  assert.deepEqual(fixed.json().findings.filter(x => x.isNew), []);
});

test('apv reuse check: a block already duplicated on the base and only moved is not new; editing both copies makes it new', async t => {
  const f = project(t);
  git(f.repo, 'switch', '-q', '-c', 'feature/move');
  write(f.repo, 'src/lib/legacy/total-copy.ts', `// Ancienne copie, déjà présente sur main.\n// Une ligne de plus au-dessus.\n${TOTAL}`);
  const moved = await apv(f.repo, ['reuse', 'check', '--base', 'origin/main', '--json']);
  assert.equal(moved.code, 0);
  assert.equal(moved.json().base.source, 'option');
  assert.deepEqual([moved.json().rules.duplicates.new, moved.json().rules.duplicates.existing], [0, 1]);
  const edited = TOTAL.replace('let sum = 0;', 'let sum = 0; let seen = 0;').replace('sum += item.price * item.quantity;', 'sum += item.price * item.quantity; seen++;');
  write(f.repo, 'src/lib/cart/total.ts', edited);
  write(f.repo, 'src/lib/legacy/total-copy.ts', edited);
  const both = await apv(f.repo, ['reuse', 'check', '--base', 'origin/main', '--json']);
  assert.equal(both.code, 1);
  assert.equal(both.json().rules.duplicates.new, 1);
});

test('apv reuse check: configuration, severities, no base, wrong calls', async t => {
  const f = project(t);
  // Without base nor reference, everything counts as new.
  const none = await apv(f.repo, ['reuse', 'check', '--json']);
  assert.equal(none.code, 1);
  assert.equal(none.json().base.source, 'none');
  assert.match((await apv(f.repo, ['reuse', 'check'])).stdout, /aucune base \(ni --base ni reuse\.reference\) : tout compte comme nouveau/);
  // Severities: off and warning never block.
  write(f.repo, '.apv/config.json', { reuse: { severity: { duplicates: 'warning', native: 'off' } } });
  const soft = await apv(f.repo, ['reuse', 'check', '--json']);
  assert.equal(soft.code, 0);
  assert.equal(soft.json().rules.native.active, false);
  assert.equal(soft.json().findings.find(x => x.rule === 'duplicates').blocking, false);
  // A sheet imported by the global sheet holds primitives too.
  write(f.repo, 'src/app.css', "@import './styles/buttons.css';\n.input { border: 1px solid; }\n");
  write(f.repo, 'src/styles/buttons.css', '.btn { padding: 0.5rem; }\n');
  write(f.repo, 'src/routes/local.svelte', '<a class="btn">x</a>\n<style>\n  .btn { padding: 0; }\n</style>\n');
  const imported = (await apv(f.repo, ['reuse', 'check', '--json'])).json();
  assert.deepEqual(imported.primitives, { sources: ['src/app.css', 'src/styles/buttons.css'], count: 2 });
  assert.ok(imported.findings.some(x => x.rule === 'styles' && x.path === 'src/routes/local.svelte' && x.line === 3));
  // Thresholds: a block under minLines is not a copy.
  write(f.repo, '.apv/config.json', { reuse: { duplicates: { minLines: 20 } } });
  assert.equal((await apv(f.repo, ['reuse', 'check', '--json'])).json().rules.duplicates.new, 0);
  // An unknown reference is refused with what to do.
  write(f.repo, '.apv/config.json', { reuse: { reference: 'origin/nowhere' } });
  const missing = await apv(f.repo, ['reuse', 'check']);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /REUSE_BASE.*origin\/nowhere.*git fetch/);
  write(f.repo, '.apv/config.json', { reuse: { native: { elements: { Select: null } } } });
  assert.equal((await apv(f.repo, ['reuse', 'check'])).code, 1, 'invalid configuration');
  rmSync(join(f.repo, '.apv'), { recursive: true });
  assert.equal((await apv(f.repo, ['reuse', 'check', '--base', 'nowhere'])).code, 1);
  for (const args of [['reuse'], ['reuse', 'scan'], ['reuse', 'check', 'x'], ['reuse', 'check', '--base', '-x'], ['reuse', 'check', '--bogus'], ['map', 'x'], ['map', '--bogus']]) {
    assert.equal((await apv(f.repo, args)).code, 2, args.join(' '));
  }
  assert.match((await apv(f.repo, ['help', 'reuse'])).stdout, /apv reuse check \[--base <ref>\]/);
  assert.match((await apv(f.repo, ['help', 'map'])).stdout, /apv map \[--check\]/);
});

test('apv map: written, checked, stale when the code changes, missing, JSON model; a custom file', async t => {
  const f = project(t);
  const missing = await apv(f.repo, ['map', '--check']);
  assert.equal(missing.code, 1);
  assert.match(missing.stdout, /Carte du code absente : \.apv\/code-map\.md\. Lancez apv map/);
  const written = await apv(f.repo, ['map']);
  assert.equal(written.code, 0);
  assert.match(written.stdout, /Carte du code écrite : \.apv\/code-map\.md \(5 composant\(s\) partagé\(s\)/);
  assert.match((await apv(f.repo, ['map'])).stdout, /Carte du code à jour/);
  assert.equal((await apv(f.repo, ['map', '--check'])).code, 0);
  write(f.repo, 'src/routes/settings/+page.svelte', '<script lang="ts">\n  import Select from \'$lib/components/ui/Select.svelte\';\n</script>\n<Select value="a" options={[]} />\n');
  const stale = await apv(f.repo, ['map', '--check']);
  assert.equal(stale.code, 1);
  assert.match(stale.stdout, /Carte du code périmée : \.apv\/code-map\.md ne correspond plus au code\. Lancez apv map/);
  assert.match(stale.stdout, /Attendu, absent de la carte :\n[\s\S]*`\/settings` : src\/routes\/settings \(\+page\.svelte\)/);
  const model = (await apv(f.repo, ['map', '--check', '--json'])).json();
  assert.equal(model.status, 'stale');
  assert.deepEqual(model.map.components.find(c => c.path.endsWith('Select.svelte')).usedBy, ['src/routes/+page.svelte', 'src/routes/settings/+page.svelte']);
  // A module of the framework (`$app/stores`) is never a file of the project.
  write(f.repo, 'src/lib/stores.ts', 'export const count = 1;\n');
  write(f.repo, 'src/routes/about/+page.svelte', "<script lang=\"ts\">\n  import { page } from '$app/stores';\n</script>\n<p>{$page.url.pathname}</p>\n");
  assert.deepEqual((await apv(f.repo, ['map', '--json'])).json().map.modules.find(m => m.path === 'src/lib/stores.ts').usedBy, []);
  write(f.repo, '.apv/config.json', { map: { file: 'docs/CODE-MAP.md' } });
  assert.equal((await apv(f.repo, ['map', '--json'])).json().file, 'docs/CODE-MAP.md');
  assert.ok(existsSync(join(f.repo, 'docs/CODE-MAP.md')));
});

test('apv init on a new web project declares both checks, and apv gates run proves them at the task stage (receipts)', async t => {
  const f = project(t);
  const env = withApvOnPath(f);
  const init = await apv(f.repo, ['init', '--json']);
  assert.equal(init.code, 0, init.stderr);
  assert.deepEqual(init.json().reuse.gates, ['reuse', 'code-map']);
  assert.match((await apv(f.repo, ['init'])).stdout, /Existait déjà/);
  commit(f.repo, 'apv');
  git(f.repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  const main = git(f.repo, 'rev-parse', 'HEAD');
  assert.match((await apv(f.repo, ['gates', 'run', '--stage', 'task', '--json'], env)).stderr, /reuse uses \{\{baseSha\}\}: pass --base/, 'the base of the run is required');
  const green = await apv(f.repo, ['gates', 'run', '--stage', 'task', '--base', 'origin/main', '--json'], env);
  assert.equal(green.code, 0, green.stdout + green.stderr);
  assert.deepEqual(green.json().gates.map(g => [g.gate, g.status]), [['reuse', 'passed']]);
  assert.deepEqual(green.json().reserved, ['code-map'], 'the map is checked by the full suite only');
  const full = await apv(f.repo, ['gates', 'run', '--stage', 'full', '--base', 'origin/main', '--json'], env);
  assert.equal(full.code, 0, full.stdout + full.stderr);
  assert.deepEqual(full.json().gates.map(g => [g.gate, g.status]).sort(), [['code-map', 'passed'], ['reuse', 'passed']]);
  git(f.repo, 'switch', '-q', '-c', 'feature/admin');
  badAdmin(f.repo);
  commit(f.repo, 'admin');
  // A remote-tracking ref moved onto the change never makes its copies « existing »: the base is the one of the run.
  git(f.repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  const red = await apv(f.repo, ['gates', 'run', '--stage', 'full', '--base', main, '--keep-going', '--json'], env);
  assert.equal(red.code, 1);
  const rows = Object.fromEntries(red.json().gates.map(g => [g.gate, g]));
  assert.deepEqual([rows.reuse.status, rows['code-map'].status], ['failed', 'failed']);
  assert.match(rows.reuse.diagnostic, /<select> natif réservé/);
  assert.match(rows['code-map'].diagnostic, /Carte du code périmée/);
  const receipt = JSON.parse(read(f.repo, `.apv/receipts/${red.json().runId}/reuse.json`));
  assert.equal(receipt.status, 'failed');
});

// Review of PR #95: one test per correction.

test('H1: apv map never reads nor writes through a symbolic link, and writes inside the repository only', async t => {
  const f = project(t);
  const outside = join(f.root, 'outside.md');
  writeFileSync(outside, 'SECRET OUTSIDE\n');
  mkdirSync(join(f.repo, '.apv'), { recursive: true });
  symlinkSync(outside, join(f.repo, '.apv/code-map.md'));
  for (const args of [['map', '--check'], ['map'], ['map', '--check', '--json']]) {
    const r = await apv(f.repo, args);
    assert.equal(r.code, 1, args.join(' '));
    assert.match(r.stderr, /MAP_PATH.*lien symbolique/);
    assert.doesNotMatch(r.stdout + r.stderr, /SECRET OUTSIDE/);
  }
  assert.equal(readFileSync(outside, 'utf8'), 'SECRET OUTSIDE\n', 'never overwritten');
  // A linked folder on the way is refused too.
  rmSync(join(f.repo, '.apv'), { recursive: true });
  mkdirSync(join(f.root, 'elsewhere'));
  symlinkSync(join(f.root, 'elsewhere'), join(f.repo, '.apv'));
  assert.equal((await apv(f.repo, ['map'])).code, 1);
  assert.ok(!existsSync(join(f.root, 'elsewhere/code-map.md')));
  // Written atomically: no temporary file left.
  rmSync(join(f.repo, '.apv'));
  assert.equal((await apv(f.repo, ['map'])).code, 0);
  assert.deepEqual(readdirSync(join(f.repo, '.apv')), ['code-map.md']);
});

test('H3: generated files (by name or first lines) are left out and listed apart, never counted', async t => {
  const f = project(t);
  git(f.repo, 'switch', '-q', '-c', 'feature/types');
  const table = name => `      ${name}: {\n        Row: { id: string; title: string; created_at: string; owner: string; status: string }\n        Insert: { id?: string; title: string; created_at?: string; owner: string; status?: string }\n        Update: { id?: string; title?: string; created_at?: string; owner?: string; status?: string }\n        Relationships: []\n      }\n`;
  write(f.repo, 'src/lib/database.types.ts', `export type Database = {\n  public: {\n    Tables: {\n${table('a')}${table('b')}${table('c')}    }\n  }\n}\n`);
  write(f.repo, 'src/lib/api/client.ts', `/* eslint-disable */\n// This file was generated by openapi-typescript. Do not edit.\n${TOTAL}${TOTAL.replace('total(', 'total2(')}`);
  const r = await apv(f.repo, ['reuse', 'check', '--base', 'origin/main', '--json']);
  assert.equal(r.code, 0, JSON.stringify(r.json().findings.filter(x => x.isNew)));
  assert.deepEqual(r.json().generated, { count: 2, files: ['src/lib/api/client.ts', 'src/lib/database.types.ts'] });
  assert.ok(!r.json().findings.some(x => x.path.includes('database.types') || x.path.includes('api/client')));
  assert.match((await apv(f.repo, ['reuse', 'check', '--base', 'origin/main'])).stdout, /Fichiers générés laissés de côté : 2 \(src\/lib\/api\/client\.ts, src\/lib\/database\.types\.ts\)/);
});

test('M: a copy is reported on the side the change adds, whatever the path order', async t => {
  const f = project(t);
  git(f.repo, 'switch', '-q', '-c', 'feature/copy');
  write(f.repo, 'src/aaa/copy.ts', TOTAL.replace('total(', 'copied('));
  const r = await apv(f.repo, ['reuse', 'check', '--base', 'origin/main', '--json']);
  const found = r.json().findings.find(x => x.rule === 'duplicates' && x.isNew);
  assert.equal(found.path, 'src/aaa/copy.ts');
  assert.equal(found.other.path, 'src/lib/cart/total.ts');
});

test('M: native elements are allowed in the generic shared components only; the target is the generic one, never the file itself', async t => {
  const f = project(t);
  git(f.repo, 'switch', '-q', '-c', 'feature/filters');
  write(f.repo, 'src/lib/components/Dropdown.svelte', '<script lang="ts">\n  let { value } = $props();\n</script>\n<button>{value}</button>\n');
  write(f.repo, 'src/lib/admin/components/Filters.svelte', '<select name="s"><option>a</option></select>\n');
  write(f.repo, 'src/lib/admin/components/Confirm.svelte', '<dialog open>ok</dialog>\n');
  const r = await apv(f.repo, ['reuse', 'check', '--base', 'origin/main', '--json']);
  const native = r.json().findings.filter(x => x.rule === 'native');
  assert.deepEqual(native.map(x => x.path), ['src/lib/admin/components/Confirm.svelte', 'src/lib/admin/components/Filters.svelte']);
  assert.match(native[1].message, /utiliser src\/lib\/components\/ui\/Select\.svelte\./, 'the generic one in ui/, not Dropdown');
  assert.match(native[0].message, /aucun composant partagé ne le remplace encore/);
  // Allowed nowhere: the shared component that wraps the element is still never reported against itself.
  write(f.repo, '.apv/config.json', { reuse: { native: { allowedPaths: ['nowhere/**'] } } });
  const self = (await apv(f.repo, ['reuse', 'check', '--base', 'origin/main', '--json'])).json();
  assert.ok(!self.findings.some(x => x.rule === 'native' && x.path === 'src/lib/components/ui/Select.svelte'));
});

test('M: styles copied between components are a warning by default (duplicates.styles), code copies stay blocking', async t => {
  const f = project(t);
  git(f.repo, 'switch', '-q', '-c', 'feature/styles');
  const style = markup => `${markup}\n<style>\n${Array.from({ length: 12 }, (_, i) => `  .field-${i} { display: flex; gap: ${i}px; align-items: center; }`).join('\n')}\n</style>\n`;
  write(f.repo, 'src/routes/a/Field.svelte', style('<label class="field-0">Nom</label>'));
  write(f.repo, 'src/routes/b/Field.svelte', style('<p class="field-1">{count} éléments</p>'));
  const r = await apv(f.repo, ['reuse', 'check', '--base', 'origin/main', '--json']);
  assert.equal(r.code, 0);
  const copy = r.json().findings.find(x => x.rule === 'duplicates' && x.isNew);
  assert.deepEqual([copy.severity, copy.blocking], ['warning', false]);
  assert.match(copy.message, /^styles identiques à/);
  write(f.repo, '.apv/config.json', { reuse: { duplicates: { styles: 'error' } } });
  assert.equal((await apv(f.repo, ['reuse', 'check', '--base', 'origin/main'])).code, 1);
});

test('M: without a common history the base is refused with what to do; the reference is never the current branch', async t => {
  const f = project(t);
  git(f.repo, 'checkout', '-q', '--orphan', 'lonely');
  git(f.repo, 'commit', '-qm', 'orphan');
  const r = await apv(f.repo, ['reuse', 'check', '--base', 'main']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /REUSE_BASE.*aucune base commune entre main et HEAD : clone superficiel \(git fetch --unshallow/);
  const bare = fixture(t, { files: PROJECT });
  assert.equal(detectReference(bare.repo), null, 'no origin: to configure, never main itself');
  git(bare.repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  assert.equal(detectReference(bare.repo), 'origin/main');
});

test('M: a repository beyond the inventory limit gets a partial map, never a failure', async t => {
  const f = project(t);
  const inventory = await buildWorktreeInventory(f.repo, { maxFiles: 5 });
  assert.equal(inventory.truncated, true);
  assert.equal(inventory.files.length, 5);
  assert.ok(inventory.fileCount > 5);
  const map = await buildCodeMap(f.repo, reuseSettings(undefined), mapSettings(undefined), { maxFiles: 5 });
  assert.deepEqual(map.partial, { described: 5, total: inventory.fileCount });
  assert.deepEqual(mapFields({ path: null, text: '', partial: false, error: 'Repository file count exceeds alpha indexing limit' }).map, null);
  assert.match(mapFields({ path: '.apv/code-map.md', text: '', partial: true }).mapNote, /carte partielle/);
});

test('BAS: an untracked file is listed in the map without its summary', async t => {
  const f = project(t);
  write(f.repo, 'src/lib/components/Draft.svelte', '<!-- @component Brouillon local, clé interne. -->\n<p>x</p>\n');
  const map = (await apv(f.repo, ['map', '--json'])).json().map;
  assert.equal(map.components.find(c => c.path.endsWith('Draft.svelte')).summary, null);
  git(f.repo, 'add', 'src/lib/components/Draft.svelte');
  assert.equal((await apv(f.repo, ['map', '--json'])).json().map.components.find(c => c.path.endsWith('Draft.svelte')).summary, 'Brouillon local, clé interne.');
});

test('M: apv init warns when apv is not on the PATH of the generated checks', async t => {
  const f = project(t);
  const r = await apv(f.repo, ['init']);
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(read(f.repo, '.apv/config.json')).gates.length, 2);
  const json = (await apv(fixture(t, { files: PROJECT }).repo, ['init', '--json'])).json();
  assert.equal(typeof json.reuse.apvOnPath, 'boolean');
  if (!json.reuse.apvOnPath) assert.match(r.stdout, /ATTENTION : apv n'est pas sur le PATH/);
});

test('the original case, replayed: a PR that redoes the shell, the toast and the select fails on all three; a wrapper that composes the shell passes', async t => {
  const sidebarStyle = `<style>\n${['nav', 'nav__item', 'nav__icon', 'nav__label', 'nav__badge', 'nav__toggle', 'nav__footer'].map(c => `  .${c} { display: flex; align-items: center; gap: 0.5rem; padding: 0.25rem 0.75rem; }`).join('\n')}\n</style>\n`;
  const f = fixture(t, { files: {
    'package.json': JSON.stringify({ dependencies: { svelte: '5.0.0' } }),
    'src/app.html': '<html lang="fr"><body>%sveltekit.body%</body></html>\n',
    'src/lib/components/ui/Select.svelte': '<script lang="ts">\n  let { value = $bindable(), options }: { value: string; options: string[] } = $props();\n</script>\n<select bind:value>{#each options as o (o)}<option>{o}</option>{/each}</select>\n',
    'src/lib/components/shell/Sidebar.svelte': `<script lang="ts">\n  let { children } = $props();\n</script>\n<nav class="nav">{@render children()}</nav>\n${sidebarStyle}`,
    'src/lib/components/shell/Toast.svelte': '<script lang="ts">\n  let { text }: { text: string } = $props();\n</script>\n<div role="status">{text}</div>\n',
    'src/routes/+layout.svelte': "<script lang=\"ts\">\n  import Sidebar from '$lib/components/shell/Sidebar.svelte';\n  import Toast from '$lib/components/shell/Toast.svelte';\n  let { children } = $props();\n</script>\n<Sidebar>{@render children()}</Sidebar><Toast text=\"ok\" />\n",
  } });
  git(f.repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  assert.equal((await apv(f.repo, ['onboard'])).code, 0);
  commit(f.repo, 'apv');
  const main = git(f.repo, 'rev-parse', 'HEAD');
  // The pull request of the pilot: its own shell (the side bar's look copied), its own toast, a native select.
  git(f.repo, 'switch', '-q', '-c', 'feature/admin');
  write(f.repo, 'src/lib/admin/components/AdminShell.svelte', `<script lang="ts">\n  let { children } = $props();\n</script>\n<aside class="nav">{@render children()}</aside>\n${sidebarStyle}`);
  write(f.repo, 'src/lib/admin/components/AdminToast.svelte', '<script lang="ts">\n  let { text }: { text: string } = $props();\n</script>\n<p role="status" class="admin-toast">{text}</p>\n');
  write(f.repo, 'src/routes/admin/+page.svelte', "<script lang=\"ts\">\n  import AdminShell from '$lib/admin/components/AdminShell.svelte';\n  import AdminToast from '$lib/admin/components/AdminToast.svelte';\n  let v = $state('a');\n</script>\n<AdminShell><select bind:value={v}><option>a</option></select><AdminToast text=\"ok\" /></AdminShell>\n");
  commit(f.repo, 'admin');
  const r = await apv(f.repo, ['reuse', 'check', '--base', main, '--json']);
  assert.equal(r.code, 1);
  const blocking = r.json().findings.filter(x => x.blocking).map(x => `${x.rule}:${x.path}`);
  assert.ok(blocking.includes('names:src/lib/admin/components/AdminShell.svelte'), blocking.join(' | '));
  assert.ok(blocking.includes('names:src/lib/admin/components/AdminToast.svelte'), blocking.join(' | '));
  assert.ok(blocking.includes('native:src/routes/admin/+page.svelte'), blocking.join(' | '));
  const copy = r.json().findings.find(x => x.rule === 'duplicates' && x.path === 'src/lib/admin/components/AdminShell.svelte');
  assert.deepEqual([copy.other.path, copy.severity, copy.blocking], ['src/lib/components/shell/Sidebar.svelte', 'error', true], 'the look of a generic shared component copied: blocking');
  assert.match(copy.message, /^styles identiques à ceux du composant partagé/);
  assert.match(r.json().findings.find(x => x.path.endsWith('AdminToast.svelte')).message, /^refait src\/lib\/components\/shell\/Toast\.svelte \(rôle toast\), composant partagé générique/);
  // The same need met by composition: a wrapper that imports the shared shell and the shared toast, the shared select.
  rmSync(join(f.repo, 'src/lib/admin'), { recursive: true });
  write(f.repo, 'src/lib/admin/components/AdminShell.svelte', "<script lang=\"ts\">\n  import Sidebar from '$lib/components/shell/Sidebar.svelte';\n  let { children } = $props();\n</script>\n<Sidebar><h2>Administration</h2>{@render children()}</Sidebar>\n");
  write(f.repo, 'src/routes/admin/+page.svelte', "<script lang=\"ts\">\n  import AdminShell from '$lib/admin/components/AdminShell.svelte';\n  import Select from '$lib/components/ui/Select.svelte';\n  import Toast from '$lib/components/shell/Toast.svelte';\n  let v = $state('a');\n</script>\n<AdminShell><Select bind:value={v} options={['a']} /><Toast text=\"ok\" /></AdminShell>\n");
  commit(f.repo, 'admin composed');
  const fixed = await apv(f.repo, ['reuse', 'check', '--base', main, '--json']);
  assert.equal(fixed.code, 0, JSON.stringify(fixed.json().findings.filter(x => x.isNew)));
  assert.deepEqual(fixed.json().findings.filter(x => x.isNew), []);
});

test('styles copied between two components of features stay a warning; a weak resemblance of names too', async t => {
  const f = project(t);
  git(f.repo, 'switch', '-q', '-c', 'feature/weak');
  write(f.repo, 'src/routes/news/NewsCard.svelte', '<p>news</p>\n');
  write(f.repo, 'src/lib/components/FirstVisit.svelte', '<p>x</p>\n');
  commit(f.repo, 'base features');
  const base = git(f.repo, 'rev-parse', 'HEAD');
  write(f.repo, 'src/lib/components/FirstVisitHint.svelte', '<p>hint</p>\n');
  const r = (await apv(f.repo, ['reuse', 'check', '--base', base, '--json'])).json();
  const names = r.findings.find(x => x.rule === 'names');
  assert.deepEqual([names.path, names.severity, names.blocking], ['src/lib/components/FirstVisitHint.svelte', 'warning', false]);
  assert.equal(r.ok, true);
});
