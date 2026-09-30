import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture, git } from './helpers.mjs';
import { apv, write } from './cli-helpers.mjs';

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
  assert.deepEqual(config.gates.map(g => [g.id, g.command.join(' '), g.stage, g.readOnly]), [['reuse', 'apv reuse check', 'task', true], ['code-map', 'apv map --check', 'task', true]]);
  assert.deepEqual(config.reuse, {
    reference: 'origin/main',
    shared: ['src/lib/components/**'],
    native: { elements: { select: 'src/lib/components/ui/Select.svelte', dialog: null, datalist: 'src/lib/components/ui/Select.svelte' }, allowedPaths: ['src/lib/components/ui/**'] },
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

test('apv reuse check blocks what a change adds: native select, restyled primitives, copied block; names and hours are warnings', async t => {
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
    'names:src/routes/admin/AdminShell.svelte:1:false',
    'names:src/routes/admin/AdminToast.svelte:1:false',
    'typography:src/routes/admin/+page.svelte:8:false',
  ]);
  const byRule = rule => out.findings.find(x => x.rule === rule && x.isNew);
  assert.match(byRule('native').message, /<select> natif réservé aux composants partagés : utiliser src\/lib\/components\/ui\/Select\.svelte\./);
  assert.match(byRule('styles').message, /« \.btn » redéfinit la primitive \.btn \(src\/app\.css\)/);
  assert.match(out.findings.find(x => x.rule === 'styles' && x.line === 8).message, /ajustement imbriqué refusé/);
  assert.deepEqual(byRule('duplicates').other, { path: 'src/lib/cart/total.ts', line: 2, endLine: 9 });
  assert.match(out.findings.find(x => x.path.endsWith('AdminToast.svelte')).message, /nom construit sur celui de src\/lib\/components\/Toast\.svelte \(rôle toast\)/);
  assert.match(out.findings.find(x => x.path.endsWith('AdminShell.svelte') && x.rule === 'names').message,
    /^même rôle que src\/lib\/components\/Sidebar\.svelte \(rôle shell\) ; même rôle que src\/lib\/components\/TabBar\.svelte \(rôle shell\) ; même rôle que src\/lib\/components\/Topbar\.svelte \(rôle shell\), composants partagés/);
  assert.match(byRule('typography').message, /heure « 14 h 47 » : espace insécable attendue/);
  assert.equal(out.rules.duplicates.existing, 1, 'the copy already on main stays reported, never blocking');
  const human = await apv(f.repo, ['reuse', 'check']);
  assert.match(human.stdout, /\[bloquant\] src\/routes\/admin\/\+page\.svelte:7 : <select> natif/);
  assert.match(human.stdout, /\[bloquant\] src\/routes\/admin\/total\.ts:2-9 : bloc identique à src\/lib\/cart\/total\.ts:2-9/);
  assert.match(human.stdout, /\[existant\] src\/lib\/legacy\/total-copy\.ts/);
  assert.match(human.stdout, /Résultat : ÉCHEC, 4 constat\(s\) bloquant\(s\)/);
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
  const green = await apv(f.repo, ['gates', 'run', '--stage', 'task', '--json'], env);
  assert.equal(green.code, 0, green.stdout + green.stderr);
  assert.deepEqual(green.json().gates.map(g => [g.gate, g.status]), [['reuse', 'passed'], ['code-map', 'passed']]);
  git(f.repo, 'switch', '-q', '-c', 'feature/admin');
  badAdmin(f.repo);
  commit(f.repo, 'admin');
  const red = await apv(f.repo, ['gates', 'run', '--stage', 'task', '--keep-going', '--json'], env);
  assert.equal(red.code, 1);
  const rows = Object.fromEntries(red.json().gates.map(g => [g.gate, g]));
  assert.deepEqual([rows.reuse.status, rows['code-map'].status], ['failed', 'failed']);
  assert.match(rows.reuse.diagnostic, /<select> natif réservé/);
  assert.match(rows['code-map'].diagnostic, /Carte du code périmée/);
  const receipt = JSON.parse(read(f.repo, `.apv/receipts/${red.json().runId}/reuse.json`));
  assert.equal(receipt.status, 'failed');
});
