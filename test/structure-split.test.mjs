import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, git } from './helpers.mjs';
import { apv, write } from './cli-helpers.mjs';
import { analyzeStructure } from '../dist/structure/analyze.js';
import { structureSettings } from '../dist/structure/config.js';
import { proposeSplit } from '../dist/structure/split.js';
import { archItems, blockOf, brokenLinks, newMap, refreshMap, roleOf, writtenRoles } from '../dist/structure/archmap.js';
import { detectProfile, profileById, PROFILES } from '../dist/structure/profiles.js';

const read = (repo, path) => readFileSync(join(repo, path), 'utf8');
const commit = (repo, message) => { git(repo, 'add', '-A'); git(repo, 'commit', '-qm', message); };

/**
 * Example project: a SvelteKit application whose `src/lib/orders/` holds 14 modules without a common prefix. Who imports
 * whom says the split: the checkout (used by the components of `components/orders/checkout/`), the list, the tracking,
 * the invoice, and the core that the whole folder imports (model, dates, money).
 */
const mod = (name, ...imports) => `${imports.map(i => `import { ${i.split('/').pop()} } from '${i.startsWith('$') ? i : `./${i}`}';`).join('\n')}\nexport const ${name.replace(/-/g, '')} = 1;\n`;
const cmp = (...imports) => `<script lang="ts">\n${imports.map(i => `  import { ${i.split('/').pop()} } from '${i}';`).join('\n')}\n</script>\n<p>x</p>\n`;
const EXAMPLE = {
  'package.json': JSON.stringify({ name: 'boutique', dependencies: { '@sveltejs/kit': '2.0.0', svelte: '5.0.0' } }),
  'src/app.html': '<!doctype html>\n<html lang="fr"><body>%sveltekit.body%</body></html>\n',
  'src/hooks.server.ts': 'export const handle = async ({ event, resolve }) => resolve(event);\n',
  'src/lib/orders/model.ts': mod('model'),
  'src/lib/orders/dates.ts': mod('dates'),
  'src/lib/orders/money.ts': mod('money'),
  'src/lib/orders/checkout.ts': mod('checkout', 'payment', 'address', 'model', 'money'),
  'src/lib/orders/checkout.test.ts': "import { checkout } from './checkout';\n",
  'src/lib/orders/payment.ts': mod('payment', 'money', 'model'),
  'src/lib/orders/address.ts': mod('address', 'model'),
  'src/lib/orders/list.ts': mod('list', 'model', 'dates', 'filters'),
  'src/lib/orders/filters.ts': mod('filters', 'model'),
  'src/lib/orders/pagination.ts': mod('pagination'),
  'src/lib/orders/tracking.ts': mod('tracking', 'carrier', 'eta', 'dates'),
  'src/lib/orders/tracking.test.ts': "import { tracking } from './tracking';\n",
  'src/lib/orders/carrier.ts': mod('carrier', 'model'),
  'src/lib/orders/eta.ts': mod('eta', 'dates'),
  'src/lib/orders/invoice.ts': mod('invoice', 'tax', 'money', 'dates', 'model'),
  'src/lib/orders/tax.ts': mod('tax', 'money'),
  'src/lib/components/orders/checkout/CheckoutForm.svelte': cmp('$lib/orders/checkout', '$lib/orders/address'),
  'src/lib/components/orders/checkout/PaymentStep.svelte': cmp('$lib/orders/payment'),
  'src/lib/components/orders/OrderTable.svelte': cmp('$lib/orders/list', '$lib/orders/pagination', '$lib/orders/filters'),
  'src/lib/components/shipping/TrackingPanel.svelte': cmp('$lib/orders/tracking', '$lib/orders/eta'),
  'src/lib/components/shipping/CarrierBadge.svelte': cmp('$lib/orders/carrier'),
  'src/routes/orders/+page.svelte': cmp('$lib/orders/list', '$lib/components/orders/OrderTable.svelte'),
  'src/routes/orders/+page.ts': "import { list } from '$lib/orders/list';\nexport const load = () => ({ list });\n",
  'src/routes/orders/[id]/invoice/+page.svelte': cmp('$lib/orders/invoice', '$lib/orders/tax'),
};

function example(t, extra = {}) {
  const f = fixture(t, { files: { ...EXAMPLE, ...extra } });
  git(f.repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  return f;
}

/** The usage graph of the example, as the code map computes it (hand-written: the unit tests read no file). */
function exampleGraph() {
  const importers = new Map();
  const add = (target, user) => importers.set(target, [...(importers.get(target) ?? []), user]);
  const o = n => `src/lib/orders/${n}.ts`;
  for (const [user, targets] of [
    [o('checkout'), ['payment', 'address', 'model', 'money']], [o('payment'), ['money', 'model']], [o('address'), ['model']],
    [o('list'), ['model', 'dates', 'filters']], [o('filters'), ['model']], [o('tracking'), ['carrier', 'eta', 'dates']], [o('carrier'), ['model']],
    [o('eta'), ['dates']], [o('invoice'), ['tax', 'money', 'dates', 'model']], [o('tax'), ['money']],
    ['src/lib/components/orders/checkout/CheckoutForm.svelte', ['checkout', 'address']], ['src/lib/components/orders/checkout/PaymentStep.svelte', ['payment']],
    ['src/lib/components/orders/OrderTable.svelte', ['list', 'pagination', 'filters']], ['src/lib/components/shipping/TrackingPanel.svelte', ['tracking', 'eta']],
    ['src/lib/components/shipping/CarrierBadge.svelte', ['carrier']], ['src/routes/orders/+page.svelte', ['list']], ['src/routes/orders/+page.ts', ['list']],
    ['src/routes/orders/[id]/invoice/+page.svelte', ['invoice', 'tax']],
  ]) for (const t of targets) add(o(t), user);
  add('src/lib/components/orders/OrderTable.svelte', 'src/routes/orders/+page.svelte');
  return { importers, exports: new Map() };
}
const paths = Object.keys(EXAMPLE);
const flat = report => report.findings.find(f => f.code === 'flat-folder');
const groupsOf = f => Object.fromEntries(f.groups.map(g => [g.dir, g.members.map(m => m.split('/').pop())]));

test('split: a flat folder without common prefix is split by use, its core kept at the root', () => {
  const report = analyzeStructure(paths, structureSettings(undefined), { usage: exampleGraph() });
  const f = flat(report);
  assert.equal(f.folder, 'src/lib/orders');
  assert.deepEqual(f.core.map(c => c.path.split('/').pop()), ['dates.ts', 'model.ts', 'money.ts']);
  assert.match(f.core.find(c => c.path.endsWith('model.ts')).reason, /importé par 7 fichiers du dossier/);
  // Named by the vocabulary of the project, never after one of their files: the folder that uses them, the route.
  assert.deepEqual(groupsOf(f), {
    checkout: ['address.ts', 'checkout.ts', 'payment.ts'],
    shipping: ['carrier.ts', 'eta.ts', 'tracking.ts'],
  });
  const checkout = f.groups.find(g => g.dir === 'checkout');
  // Same split as the components of the same domain, and why.
  assert.deepEqual([checkout.existing, checkout.naming, checkout.conventions], [false, 'mirror', ['feature-folders', 'mirror']]);
  assert.match(checkout.reasons[0], /même découpage que src\/lib\/components\/orders\/checkout\//);
  assert.ok(checkout.reasons.some(r => /liés par import : .*checkout\.ts importe address\.ts/.test(r)), checkout.reasons.join(' | '));
  assert.deepEqual(f.groups.filter(g => g.dir !== 'checkout').map(g => [g.dir, g.naming, g.reasons[0]]), [
    ['shipping', 'place', 'nom repris : dossier src/lib/components/shipping/, qui les utilise (3 sur 3)'],
  ]);
  // Used together, but no name of the project says what they do: grouped, never named after a file nor after the route
  // that uses them (`/orders/[id]/invoice`: the language of the URLs stays in src/routes), left to the operator.
  assert.deepEqual(f.unnamed.map(u => u.members.map(m => m.split('/').pop())), [['filters.ts', 'list.ts'], ['invoice.ts', 'tax.ts']]);
  // Plan: tests follow their module; the core stays; the unnamed group and the lone file stay for the operator.
  const moved = new Map(report.plan.map(m => [m.from, m.to]));
  assert.equal(moved.get('src/lib/orders/checkout.test.ts'), 'src/lib/orders/checkout/checkout.test.ts');
  assert.equal(moved.get('src/lib/orders/tracking.ts'), 'src/lib/orders/shipping/tracking.ts');
  assert.equal(moved.get('src/lib/orders/model.ts'), undefined);
  assert.equal(moved.get('src/lib/orders/list.ts'), undefined);
  assert.deepEqual(report.folders.find(x => x.folder === 'src/lib/orders').unplaced, ['src/lib/orders/filters.ts', 'src/lib/orders/invoice.ts', 'src/lib/orders/list.ts', 'src/lib/orders/pagination.ts', 'src/lib/orders/tax.ts']);
  assert.match(f.proposal, /dont 6 par usage dans 2 sous-dossier\(s\), 3 fichier\(s\) socle gardés à la racine, 2 groupe\(s\) à nommer par l'opérateur\), 5 fichier\(s\) restent à placer/);
  // Once applied, the folder is no longer flat.
  const after = analyzeStructure(paths.map(p => moved.get(p) ?? p), structureSettings(undefined), { usage: exampleGraph() });
  assert.equal(flat(after), undefined);
});

test('split: the root always ends under the threshold when a group is close enough', () => {
  const settings = structureSettings({ maxFlatFiles: 5 });
  const f = flat(analyzeStructure(paths, settings, { usage: exampleGraph() }));
  const pending = f.unnamed.find(u => u.members.includes('src/lib/orders/pagination.ts'));
  assert.ok(pending, JSON.stringify(f.unnamed));
  assert.ok(pending.reasons.some(r => /^pagination\.ts rattaché au groupe le plus proche \(similarité \d,\d\d\) pour ramener la racine sous le seuil$/.test(r)), pending.reasons.join(' | '));
});

test('split: deterministic and explainable, whatever the order of the files and of the graph', () => {
  const settings = structureSettings(undefined);
  const one = JSON.stringify(analyzeStructure(paths, settings, { usage: exampleGraph() }));
  const graph = exampleGraph();
  const reversed = { importers: new Map([...graph.importers].reverse().map(([k, v]) => [k, [...v].reverse()])), exports: graph.exports };
  assert.equal(JSON.stringify(analyzeStructure([...paths].reverse(), settings, { usage: reversed })), one);
  // Without a graph, only the names are read: no group by use.
  const names = flat(analyzeStructure(paths, settings));
  assert.equal(names.groups, undefined);
  assert.match(names.proposal, /sans préfixe commun ni rôle reconnu/);
});

test('split: an existing subfolder attracts what its files use; generic folders never name a group', () => {
  const entry = (path, tokens) => ({ path, stem: path.split('/').pop().split('.')[0], files: [path], component: /\.svelte$/.test(path), tokens });
  const dir = 'src/lib/components/ui';
  const entries = [entry(`${dir}/Dialog.svelte`, ['dialog']), entry(`${dir}/ConfirmDialog.svelte`, ['confirm', 'dialog']), entry(`${dir}/ModalHead.svelte`, ['modal', 'head']), entry(`${dir}/listbox.ts`, ['listbox'])];
  const importers = new Map([
    [`${dir}/Dialog.svelte`, [`${dir}/ConfirmDialog.svelte`, 'src/lib/components/agenda/A.svelte', 'src/lib/components/settings/B.svelte']],
    [`${dir}/ModalHead.svelte`, [`${dir}/Dialog.svelte`]],
    [`${dir}/ConfirmDialog.svelte`, ['src/lib/components/agenda/A.svelte']],
    [`${dir}/listbox.ts`, [`${dir}/menu/Menu.svelte`, `${dir}/menu/MenuItem.svelte`]],
  ]);
  const split = proposeSplit(dir, entries, { importers, exports: new Map() }, {
    dirs: new Set(['src', 'src/lib', 'src/lib/components', dir, `${dir}/menu`, 'src/lib/components/agenda', 'src/lib/components/settings']),
    files: [...entries.map(e => e.path), `${dir}/menu/Menu.svelte`, `${dir}/menu/MenuItem.svelte`], domains: [], maxFlatFiles: 12,
  });
  assert.deepEqual(split.groups.map(g => [g.dir, g.existing, g.members.map(m => m.split('/').pop())]), [['menu', true, ['listbox.ts']]]);
  // `dialog` is no name of the project here: the group waits for the operator, never named after Dialog.svelte.
  assert.deepEqual(split.unnamed.map(u => u.members.map(m => m.split('/').pop())), [['ConfirmDialog.svelte', 'Dialog.svelte', 'ModalHead.svelte']]);
  assert.ok(!split.groups.some(g => ['agenda', 'settings'].includes(g.dir)), 'a shared folder is never split by who uses it');
});

test('profiles: detected from the dependencies, conventions documented by official links', () => {
  for (const p of PROFILES) {
    for (const c of p.conventions) assert.match(c.url, /^https:\/\//, `${p.id}:${c.id}`);
    for (const k of [...p.known, ...p.entries]) assert.ok(p.conventions.some(c => c.id === k.convention), `${p.id}: ${k.path} -> ${k.convention}`);
  }
  assert.equal(profileById('sveltekit').conventions.find(c => c.id === 'sveltekit-server').url, 'https://svelte.dev/docs/kit/server-only-modules');
  assert.equal(profileById('nope').id, 'generic');
  assert.equal(detectProfile('/nonexistent', ['go.mod']).id, 'go');
});

test('architecture map: generated parts rewritten, written parts kept, roles and links read', () => {
  const profile = profileById('sveltekit');
  const files = [...paths, 'docs/carte-architecture.md', 'README.md', 'supabase/migrations/001_init.sql', 'vercel.json'];
  const text = { 'vercel.json': '{ "crons": [{ "path": "/api/cron", "schedule": "0 5 * * *" }] }' };
  const items = archItems(files, profile, { ignore: [] }, p => text[p] ?? null);
  const keys = items.map(i => `${i.kind}:${i.key}`);
  for (const k of ['folder:src/lib/', 'folder:src/lib/orders/', 'folder:src/lib/components/orders/', 'folder:src/routes/', 'route:/orders', 'entry:src/hooks.server.ts', 'entry:supabase/migrations/', 'entry:vercel.json']) assert.ok(keys.includes(k), k);
  assert.ok(!keys.some(k => k.startsWith('folder:src/routes/orders')), 'route folders are routes, not folders');
  assert.equal(items.find(i => i.key === 'src/lib/server/')?.known ?? null, null);
  const inputs = { mapPath: 'docs/carte-architecture.md', profile, items, files, designDir: null, codeMapPath: '.apv/code-map.md', maxFlatFiles: 12,
    crowded: [{ folder: 'src/lib/orders', code: 14, groups: ['checkout', 'list'] }], dependencies: ['@supabase/supabase-js', 'resend'], read: p => text[p] ?? null };
  const map = newMap(inputs);
  assert.match(map, /```mermaid\nflowchart LR\n  nav\["Navigateur"\]/);
  assert.match(map, /Services externes : Resend, Supabase/);
  assert.match(map, /`src\/lib\/orders\/` : \*\*à décrire\*\* dans « Rôles »\. Convention : dossiers par fonctionnalité \(\[documentation\]\(https:\/\/svelte\.dev\/docs\/kit\/\$lib\)\)\. Dossier à plat \(14 fichiers de code, seuil 12\) : ne pas y ajouter de fichier ; sous-dossiers proposés : checkout, list\./);
  assert.match(map, /\[`src\/hooks\.server\.ts`\]\(\.\.\/src\/hooks\.server\.ts\) : hooks serveur/);
  assert.ok(!/[–—]/.test(map), 'no em or en dash');
  assert.equal(refreshMap(map, inputs), map, 'regenerating a fresh map changes nothing');
  // A role written by hand is kept and shown; a written block is never rewritten.
  const edited = map.replace('- `src/lib/orders/` : à décrire', '- `src/lib/orders/` : commandes : panier, paiement, suivi.').replace('À compléter : ce que fait le projet', 'Une boutique');
  const refreshed = refreshMap(edited, { ...inputs, crowded: [] });
  assert.match(refreshed, /- `src\/lib\/orders\/` : commandes : panier, paiement, suivi\. Convention/);
  assert.match(blockOf(refreshed, 'resume'), /^Une boutique/);
  assert.equal(blockOf(refreshed, 'roles'), blockOf(edited, 'roles'));
  // Roles: placeholders never count; a glob describes several folders.
  const roles = writtenRoles(refreshed);
  assert.equal(roles.get('src/lib/orders/'), 'commandes : panier, paiement, suivi.');
  assert.equal(roleOf({ kind: 'folder', key: 'src/lib/components/orders/', known: null }, roles), null);
  assert.equal(roleOf({ kind: 'folder', key: 'src/lib/components/orders/', known: null }, new Map([['src/lib/components/*/', 'composants de fonctionnalité']])), 'composants de fonctionnalité');
  // Links: relative ones checked, URLs, anchors and code blocks ignored.
  const exists = p => ['README.md', 'src'].includes(p);
  assert.deepEqual(brokenLinks('[a](../README.md) [b](../absent.md#x) [c](https://x.y) [d](#top)\n```\n[e](../nope.md)\n```\n[f](../src/)\n', 'docs/carte.md', exists),
    [{ target: '../absent.md#x', line: 1 }]);
});

test('e2e: apv init writes the architecture map and the structure gate; a flat folder is split by use', async t => {
  const f = example(t);
  const init = await apv(f.repo, ['init', '--json']);
  assert.equal(init.code, 0, init.stderr);
  assert.deepEqual(init.json().reuse.gates, ['reuse', 'structure', 'code-map']);
  const map = read(f.repo, 'docs/carte-architecture.md');
  assert.match(map, /Pile : SvelteKit \(\[structure d'un projet SvelteKit\]\(https:\/\/svelte\.dev\/docs\/kit\/project-structure\)\)/);
  assert.match(map, /- `src\/lib\/orders\/` : \*\*à décrire\*\*[^\n]*Dossier à plat \(14 fichiers de code, seuil 12\)[^\n]*sous-dossiers proposés : checkout, [a-z, -]+\./);
  assert.match(read(f.repo, '.apv/code-map.md'), /## Dossiers\n\nArborescence commentée[^\n]*docs\/carte-architecture\.md[\s\S]*- `src\/lib\/orders\/` : 14 fichiers ; sous-dossiers proposés : checkout/);
  assert.equal((await apv(f.repo, ['map', '--check'])).code, 0, 'code map and architecture map up to date');
  const check = await apv(f.repo, ['structure', 'check', '--json']);
  assert.equal(check.code, 0);
  const report = check.json();
  assert.equal(report.architectureMap.profile, 'sveltekit');
  const orders = flat(report);
  assert.deepEqual(Object.keys(groupsOf(orders)).sort(), ['checkout', 'shipping']);
  assert.deepEqual(orders.core.map(c => c.path.split('/').pop()).sort(), ['dates.ts', 'model.ts', 'money.ts']);
  const text = (await apv(f.repo, ['structure', 'check', '--path', 'src/lib/orders'])).stdout;
  assert.match(text, /    socle : model\.ts \(importé par 7 fichiers du dossier/);
  assert.match(text, /    checkout\/ : address\.ts, checkout\.ts, payment\.ts\n      pourquoi : nom repris : même découpage que src\/lib\/components\/orders\/checkout\/[^\n]*\n      convention : dossiers par fonctionnalité \(https:\/\/svelte\.dev\/docs\/kit\/\$lib\) ; même découpage que les composants/);
  assert.match(text, /    checkout\.ts -> checkout\/checkout\.ts \(avec checkout\.test\.ts\)/);
});

test('e2e: an added file in a flat folder is blocked with its subfolder; a move into the proposed subfolder is accepted', async t => {
  const f = example(t);
  assert.equal((await apv(f.repo, ['init'])).code, 0);
  commit(f.repo, 'apv');
  git(f.repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  const base = git(f.repo, 'rev-parse', 'HEAD');
  const clean = await apv(f.repo, ['structure', 'check', '--base', base, '--json']);
  assert.equal(clean.code, 0, clean.stdout);
  assert.ok(clean.json().changes.every(c => !c.isNew), 'nothing new: the existing flat folder and roles to write are said, never blocking');
  assert.ok(clean.json().findings.every(x => x.isNew === false && x.blocking === false));

  // Added to the flat folder: blocked, with the subfolder where it belongs.
  git(f.repo, 'switch', '-q', '-c', 'feature/refund');
  write(f.repo, 'src/lib/orders/refund.ts', mod('refund', 'payment', 'money'));
  write(f.repo, 'src/lib/components/orders/checkout/RefundStep.svelte', cmp('$lib/orders/refund', '$lib/orders/payment'));
  const added = await apv(f.repo, ['structure', 'check', '--base', base]);
  assert.equal(added.code, 1, added.stdout);
  assert.match(added.stdout, /\[bloquant\] dossier à plat alourdi : src\/lib\/orders\/refund\.ts : fichier de code ajouté à un dossier à plat : src\/lib\/orders\/ a déjà 14 fichiers de code \(seuil 12\) ; à ranger dans src\/lib\/orders\/checkout\/ \(sous-dossier proposé avec address\.ts, checkout\.ts, payment\.ts ; nom repris : même découpage que src\/lib\/components\/orders\/checkout\/\)\./);
  assert.match(added.stdout, /Résultat : ÉCHEC, 1 constat\(s\) bloquant\(s\) : placer chaque fichier dans le sous-dossier proposé/);

  // In a new subfolder: accepted by the ratchet, but the new folder must be described in the architecture map.
  mkdirSync(join(f.repo, 'src/lib/orders/checkout'), { recursive: true });
  renameSync(join(f.repo, 'src/lib/orders/refund.ts'), join(f.repo, 'src/lib/orders/checkout/refund.ts'));
  let red = (await apv(f.repo, ['structure', 'check', '--base', base, '--json'])).json();
  assert.deepEqual(red.changes.filter(c => c.blocking).map(c => [c.code, c.message.split(' sans')[0]]), [['architecture-map', 'dossier src/lib/orders/checkout/ ajouté']]);
  const mapFile = 'docs/carte-architecture.md';
  writeFileSync(join(f.repo, mapFile), read(f.repo, mapFile).replace('<!-- /apv:ecrit:roles -->', '- `src/lib/orders/checkout/` : panier, paiement et remboursement.\n<!-- /apv:ecrit:roles -->'));
  red = (await apv(f.repo, ['structure', 'check', '--base', base, '--json'])).json();
  assert.equal(red.ok, true, JSON.stringify(red.changes.filter(c => c.blocking)));

  // Moving the checkout files down into their subfolder empties the flat folder: always accepted.
  for (const name of ['checkout.ts', 'checkout.test.ts', 'payment.ts', 'address.ts']) git(f.repo, 'mv', `src/lib/orders/${name}`, `src/lib/orders/checkout/${name}`);
  const moved = await apv(f.repo, ['structure', 'check', '--base', base, '--json']);
  assert.equal(moved.code, 0, JSON.stringify(moved.json().changes));
  assert.equal(flat(moved.json()), undefined, 'the folder is no longer flat');
});

test('e2e: crossing the threshold blocks; the configuration of the base judges; a broken link blocks, an old one is signalled', async t => {
  const twelve = Object.fromEntries(['a1', 'b2', 'c3', 'd4', 'e5', 'f6', 'g7', 'h8', 'i9', 'j10', 'k11', 'l12'].map(n => [`src/lib/tools/${n}.ts`, `export const ${n} = 1;\n`]));
  const f = example(t, twelve);
  assert.equal((await apv(f.repo, ['init'])).code, 0);
  const mapFile = 'docs/carte-architecture.md';
  writeFileSync(join(f.repo, mapFile), `${read(f.repo, mapFile)}\nAncien lien : [vieux](./vieux.md)\n`);
  commit(f.repo, 'apv');
  const base = git(f.repo, 'rev-parse', 'HEAD');
  git(f.repo, 'switch', '-q', '-c', 'feature/more');
  write(f.repo, 'src/lib/tools/m13.ts', 'export const m13 = 1;\n');
  // The change raises the threshold for itself: judged with the base configuration, and said.
  const config = JSON.parse(read(f.repo, '.apv/config.json'));
  write(f.repo, '.apv/config.json', { ...config, structure: { maxFlatFiles: 100 } });
  writeFileSync(join(f.repo, mapFile), `${read(f.repo, mapFile)}\nNouveau lien : [absent](../src/absent.ts)\n`);
  const out = (await apv(f.repo, ['structure', 'check', '--base', base, '--json'])).json();
  assert.equal(out.ok, false);
  const blocking = out.changes.filter(c => c.blocking).map(c => `${c.code}: ${c.message}`);
  assert.ok(blocking.some(m => /^flat-growth: .*src\/lib\/tools\/ passe de 12 à 13 fichiers de code \(seuil 12\)/.test(m)), blocking.join('\n'));
  assert.ok(blocking.some(m => /^configuration: section structure de la configuration modifiée par le changement/.test(m)), blocking.join('\n'));
  assert.ok(blocking.some(m => /^architecture-map: lien cassé : \.\.\/src\/absent\.ts \(cassé par le changement\)/.test(m)), blocking.join('\n'));
  assert.ok(out.changes.some(c => !c.blocking && /lien cassé : \.\/vieux\.md ;/.test(c.message)), 'a link already broken at the base is signalled only');
  // The map deleted by the change blocks.
  git(f.repo, 'checkout', '-q', '--', '.apv/config.json');
  git(f.repo, 'rm', '-q', '-f', mapFile);
  const gone = (await apv(f.repo, ['structure', 'check', '--base', base, '--json'])).json();
  assert.ok(gone.changes.some(c => c.blocking && /carte de l'architecture supprimée/.test(c.message)));
});

test('apv structure map: creates the map, never rewrites its written parts, --check finds a stale one', async t => {
  const f = example(t);
  const created = await apv(f.repo, ['structure', 'map']);
  assert.equal(created.code, 0, created.stderr);
  assert.match(created.stdout, /Carte de l'architecture écrite : docs\/carte-architecture\.md/);
  assert.equal((await apv(f.repo, ['structure', 'map', '--check'])).code, 0);
  const mapFile = 'docs/carte-architecture.md';
  writeFileSync(join(f.repo, mapFile), read(f.repo, mapFile).replace('À compléter : ce que fait le projet, pour qui, en deux phrases.', 'Boutique en ligne.'));
  write(f.repo, 'src/lib/catalog/products.ts', 'export const products = [];\n');
  const stale = await apv(f.repo, ['structure', 'map', '--check']);
  assert.equal(stale.code, 1);
  assert.match(stale.stdout, /périmée[\s\S]*`src\/lib\/catalog\/`/);
  assert.equal((await apv(f.repo, ['map', '--check'])).code, 1, 'apv map --check checks it too');
  assert.match((await apv(f.repo, ['map'])).stdout, /Carte de l'architecture mise à jour/);
  assert.match(read(f.repo, mapFile), /Boutique en ligne\./);
  assert.match(read(f.repo, mapFile), /`src\/lib\/catalog\/` : \*\*à décrire\*\*/);
  const again = (await apv(f.repo, ['structure', 'map', '--check', '--json'])).json();
  assert.equal(again.status, 'up-to-date', JSON.stringify(again.difference));
});

test('split: a name that is an existing subfolder joins it; one use never names a group', () => {
  const dir = 'src/lib/home';
  const entry = (name, tokens) => ({ path: `${dir}/${name}`, stem: name.split('.')[0], files: [`${dir}/${name}`], component: /\.svelte$/.test(name), tokens });
  const entries = [entry('LexiconScene.svelte', ['lexicon', 'scene']), entry('lexicon-scene.ts', ['lexicon', 'scene']), entry('HomeLexicon.svelte', ['home', 'lexicon'])];
  const importers = new Map([
    [`${dir}/lexicon-scene.ts`, [`${dir}/LexiconScene.svelte`, `${dir}/HomeLexicon.svelte`]],
    [`${dir}/LexiconScene.svelte`, [`${dir}/HomeLexicon.svelte`]],
    [`${dir}/HomeLexicon.svelte`, ['src/routes/+page.svelte']],
  ]);
  const split = proposeSplit(dir, entries, { importers, exports: new Map() }, {
    dirs: new Set(['src', 'src/lib', dir, `${dir}/scenes`, 'src/routes']), files: [...entries.map(e => e.path), `${dir}/scenes/Plane.svelte`, 'src/routes/+page.svelte'], domains: [], maxFlatFiles: 12,
  });
  assert.deepEqual(split.groups.map(g => [g.dir, g.existing, g.naming]), [['scenes', true, 'existing']]);
  assert.match(split.groups[0].reasons[0], /sous-dossier existant src\/lib\/home\/scenes\/ \(mot commun à 2 fichiers, « scene »/);
});
