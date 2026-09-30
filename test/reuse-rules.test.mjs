import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TokenTable, blankImports, findClones, occurs, tokenize } from '../dist/reuse/duplicates.js';
import { blocks, elementRule, findElements } from '../dist/reuse/markup.js';
import { Primitives, isLayoutOnly, primitivesOf, restyledPrimitives, styleRules, unwrapScoping } from '../dist/reuse/styles.js';
import { breakableValues, typographyPatterns } from '../dist/reuse/typography.js';
import { clashOf, componentName, describeClash, replacementFor } from '../dist/reuse/names.js';
import { DEFAULT_ROLE_FAMILIES, GENERATED_HEADER, reuseSettings } from '../dist/reuse/config.js';
import { parseAddedLines } from '../dist/reuse/changes.js';
import { codeMapMarkdown, maskSecrets, shares, importsOf, propsOf, routeOf, summaryOf, variantsOf, declaredRoutes } from '../dist/knowledge/code-map.js';
import { configIssues } from '../dist/config/load.js';
import { NOT_SEARCHED } from '../dist/gates/proof-scope.js';
import { apvOnPath } from '../dist/reuse/detect.js';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BLOCK = `function total(items) {
  let sum = 0;
  for (const item of items) {
    if (item.active) sum += item.price * item.quantity;
  }
  return Math.round(sum * 100) / 100;
}
`;

test('duplicates: a copied block is found across files, whitespace and comments ignored, with whole lines', () => {
  const table = new TokenTable();
  const a = tokenize(`// head\n${BLOCK}`, 'js', table);
  const b = tokenize(`const x = 1;\n\n/* copied */\n${BLOCK.replace(/  /g, '    ').replace('let sum = 0;', 'let sum = 0; // start')}`, 'js', table);
  const clones = findClones(new Map([['src/a.js', a], ['src/b.js', b]]), { minTokens: 30, minLines: 5 });
  assert.equal(clones.length, 1);
  const [clone] = clones;
  assert.deepEqual([clone.a.path, clone.a.startLine, clone.a.endLine], ['src/b.js', 4, 10]);
  assert.deepEqual([clone.b.path, clone.b.startLine, clone.b.endLine], ['src/a.js', 2, 8]);
  assert.ok(clone.tokens >= 30 && clone.lines === 7);
  // Under the thresholds: nothing.
  assert.deepEqual(findClones(new Map([['src/a.js', a], ['src/b.js', b]]), { minTokens: 500, minLines: 5 }), []);
  assert.deepEqual(findClones(new Map([['src/a.js', a], ['src/b.js', b]]), { minTokens: 30, minLines: 20 }), []);
});

test('duplicates: a block copied twice gives two clones with the first copy, a copy inside one file never overlaps itself', () => {
  const table = new TokenTable();
  const files = new Map([['a.js', tokenize(BLOCK, 'js', table)], ['b.js', tokenize(BLOCK, 'js', table)], ['c.js', tokenize(BLOCK, 'js', table)]]);
  const clones = findClones(files, { minTokens: 30, minLines: 5 });
  assert.deepEqual(clones.map(c => `${c.a.path}~${c.b.path}`), ['b.js~a.js', 'c.js~a.js']);
  const self = findClones(new Map([['d.js', tokenize(`${BLOCK}\n${BLOCK}`, 'js', table)]]), { minTokens: 30, minLines: 5 });
  assert.equal(self.length, 1);
  assert.ok(self[0].b.end < self[0].a.start, 'the second copy starts after the first');
  const long = new TokenTable();
  assert.equal(occurs(Int32Array.from(tokenize(`${BLOCK}${BLOCK}`, 'js', long), t => t.id), Int32Array.from(tokenize(BLOCK, 'js', long), t => t.id), true), true);
  assert.equal(occurs(Int32Array.from(tokenize(BLOCK, 'js', long), t => t.id), Int32Array.from(tokenize(BLOCK, 'js', long), t => t.id), true), false);
});

test('duplicates: strings, template strings and markup comments are single tokens or dropped', () => {
  const table = new TokenTable();
  const ids = text => tokenize(text, 'svelte', table).map(t => t.id);
  assert.deepEqual(ids('<p>{a}</p><!-- note -->'), ids('<p>{a}</p>'));
  assert.equal(tokenize('const s = `a\nb`;\nx', 'ts', table).at(-1).line, 3, 'a template string spans lines');
  assert.equal(tokenize("<p>C'est\nfini</p>", 'svelte', table).at(-1).line, 2, 'an apostrophe in text ends at the end of its line');
  assert.equal(tokenize('url(https://x.y/z) a', 'css', table).at(-1).line, 1);
  assert.equal(tokenize('# comment\nx = 1', 'py', table).length, 3);
});

test('duplicates: import statements are blanked, lines kept', () => {
  const ts = "import A from '$lib/A.svelte';\nimport {\n  b,\n  c\n} from './x';\nimport './side.css';\nexport { d } from './d';\nconst keep = 1;\n";
  const out = blankImports(ts, 'ts');
  assert.equal(out.split('\n').length, ts.split('\n').length);
  assert.equal(out.trim(), 'const keep = 1;');
  assert.equal(blankImports('from a.b import (\n  c,\n)\nimport os\nx = 1\n', 'py').trim(), 'x = 1');
  assert.equal(blankImports("const s = 'import x from y';\n", 'ts'), "const s = 'import x from y';\n");
});

test('native elements: lower-case tags only, attribute rules, comments ignored', () => {
  const rules = ['select', 'dialog', 'input[type=date]'].map(elementRule);
  const text = [
    '<Select bind:value />',
    '<select bind:value={v}>',
    '<!-- <dialog> in a comment -->',
    '<dialog open>',
    '<input type="text">',
    '<input',
    '  type="date" />',
    '<input type={\'date\'} />',
    '<selection>',
  ].join('\n');
  assert.deepEqual(findElements(text, rules).map(h => `${h.line}:${h.selector}`), ['2:select', '4:dialog', '6:input[type=date]', '8:input[type=date]']);
  assert.throws(() => elementRule('Select'));
});

test('styles: primitives are the classes that open a top-level rule of the global sheet, @layer and @utility included', () => {
  const css = `:root { --x: 1; }
.btn, .btn--primary:hover { color: red; }
@layer components { .input { border: 0; } .pill--ok { color: green; } }
@media (min-width: 40rem) { .panel { padding: 1rem; } }
.card .title { font-weight: 700; }
@keyframes spin { from { opacity: 0; } }
@utility seg { display: flex; }
/* .ghost { } */
.field { .label { color: red; } }`;
  assert.deepEqual(primitivesOf(css), ['btn', 'btn--primary', 'card', 'field', 'input', 'panel', 'pill--ok', 'seg']);
  const nested = styleRules('.card {\n  color: red;\n  &.active { color: blue; }\n  .btn { margin: 0; }\n}\n');
  assert.deepEqual(nested.map(r => `${r.line}:${r.selector}:${r.topLevel}`), ['1:.card:true', '3:.card.active:false', '4:.card .btn:false']);
  assert.equal(unwrapScoping(':global(.btn):hover'), '.btn:hover');
  assert.equal(unwrapScoping('.x :deep(.input)'), '.x .input');
  assert.deepEqual(styleRules('// a { b }\n.x { background: url(//cdn/x.png); }', 1).map(r => r.selector), ['.x']);
});

test('styles: a primitive restyled in a local style is a redefinition, under a class of the component a nested adjustment', () => {
  const primitives = new Primitives(['btn', 'input'], ['.pill--*'], ['.sr-only']);
  const rules = styleRules(`.btn { padding: 0; }
.own { color: red; }
.own .btn { margin: 0; }
:global(.input) { border: 0; }
.pill--warn { color: orange; }
.btn.own { color: blue; }
.sr-only { display: none; }`, 10);
  assert.deepEqual(restyledPrimitives(rules, primitives).map(h => `${h.line}:${h.primitive}:${h.nested}`),
    ['10:btn:false', '12:btn:true', '13:input:false', '14:pill--warn:false', '15:btn:false']);
  assert.equal(new Primitives(['sr-only'], [], ['.sr-only']).has('sr-only'), false, 'an exception is never a primitive');
  const svelte = '<div />\n<style>\n  .btn { color: red; }\n</style>\n';
  assert.deepEqual(blocks(svelte, 'style').flatMap(b => styleRules(b.content, b.line)).map(r => `${r.line}:${r.selector}`), ['3:.btn']);
});

test('typography: French hours, dates, units and thousands need a non-breaking space; other languages are not checked', () => {
  const fr = typographyPatterns('fr-CA');
  assert.ok(fr);
  assert.equal(typographyPatterns('en'), null);
  assert.equal(typographyPatterns(null), null);
  const markup = '<p>Publié à 14 h 47, le 30 septembre, pour 12 € (1 000 vues).</p>\n<p>Publié à 14 h 47.</p>\n<script>\n  const s = `${h} h ${m}`;\n  const n = 10 % 3;\n</script>\n<style>\n  .x { width: calc(100% - 2rem); }\n</style>';
  const hits = breakableValues(markup, 'svelte', fr, true);
  assert.deepEqual(hits.map(h => h.line), [1, 4]);
  assert.deepEqual(hits[0].values, ['heure « 14 h 47 »', 'date « 30 septembre »', 'nombre et unité « 12 € »', 'séparateur de milliers « 1 000 »']);
  assert.deepEqual(hits[1].values, ['heure « ${h} h ${m} »']);
  assert.deepEqual(breakableValues(markup, 'svelte', fr, true, new Set([2, 3])), [], 'only the given lines');
  assert.deepEqual(breakableValues('const label = `${n} %`;\nconst mod = 10 % 3;\n', 'ts', fr, false).map(h => h.line), [1]);
});

test('names: role families, affixes and the exact rule that says why two components double', () => {
  const name = path => componentName(path, DEFAULT_ROLE_FAMILIES);
  assert.equal(name('src/lib/components/TabBar.svelte').family, 'tabbar');
  assert.equal(name('src/routes/admin/AdminToastContainer.svelte').family, 'toast', 'structural words are dropped');
  assert.equal(name('src/lib/ui/DatePicker.svelte').family, 'datepicker', 'the longest compound wins');
  assert.equal(name('src/lib/ui/Article.svelte').family, null);
  const toast = name('src/lib/components/Toast.svelte');
  assert.deepEqual(clashOf(name('src/routes/admin/AdminToast.svelte'), toast), { path: 'src/routes/admin/AdminToast.svelte', with: toast.path, reason: 'affix', family: 'toast' });
  assert.equal(clashOf(name('src/routes/admin/Snackbar.svelte'), toast).reason, 'role');
  assert.equal(clashOf(name('src/routes/admin/Toast.svelte'), toast).reason, 'same-name');
  assert.equal(clashOf(name('src/lib/components/ui/SelectField.svelte'), name('src/lib/components/ui/Select.svelte')).reason, 'affix');
  assert.equal(clashOf(name('src/routes/admin/AdminShell.svelte'), name('src/lib/components/AppLayout.svelte')).reason, 'role');
  assert.equal(clashOf(name('src/routes/Article.svelte'), toast), null);
  // Parts and specific components are not doubles.
  assert.equal(clashOf(name('src/lib/ui/menu/MenuItem.svelte'), name('src/lib/ui/menu/Menu.svelte')), null);
  assert.equal(clashOf(name('src/lib/ui/ToastContainer.svelte'), toast), null);
  assert.equal(clashOf(name('src/lib/admin/AddDeviceDialog.svelte'), name('src/lib/ui/ConfirmDialog.svelte')), null, 'two specific dialogs');
  assert.equal(clashOf(name('src/lib/admin/AddDeviceDialog.svelte'), name('src/lib/ui/Dialog.svelte')).reason, 'affix', 'a new dialog next to the generic one');
  assert.equal(clashOf(name('src/lib/admin/DeviceModal.svelte'), name('src/lib/ui/Dialog.svelte')).reason, 'role');
  assert.equal(clashOf(name('src/lib/ui/menu/Menu.svelte'), name('src/lib/ui/menu/MenuItem.svelte')), null, 'the whole and its part, both ways');
  assert.equal(clashOf(name('src/lib/cards/GuideCard.svelte'), name('src/lib/applications/ApplicationCard.svelte')), null, 'a domain word is not generic');
  assert.equal(name('src/lib/components/AppShell.svelte').generic, true);
  assert.equal(name('src/lib/components/toast/ToastRegion.svelte').generic, true);
  assert.equal(name('src/lib/components/NavIcon.svelte').generic, false);
  assert.equal(clashOf(name('src/lib/admin/AdminIcon.svelte'), name('src/lib/components/NavIcon.svelte')), null);
  assert.equal(clashOf(name('src/lib/admin/ListPager.svelte'), name('src/lib/components/Pagination.svelte')).reason, 'role');
  assert.equal(clashOf(toast, toast), null);
  assert.equal(describeClash(clashOf(name('src/x/Snackbar.svelte'), toast)), 'même rôle que src/lib/components/Toast.svelte (rôle toast)');
});

test('configuration: defaults, overrides, and every invalid value refused by the common loader', () => {
  const d = reuseSettings(undefined);
  assert.deepEqual(d.severity, { native: 'error', styles: 'error', duplicates: 'error', names: 'warning', typography: 'warning', coverage: 'error' });
  assert.equal(reuseSettings({ severity: 'off' }).severity.coverage, 'error', 'the coverage of the check is never lowered');
  assert.deepEqual(Object.keys(d.native.elements), ['select', 'dialog', 'datalist']);
  // Native elements and primitives: the generic shared components only, never a component folder of one feature.
  assert.deepEqual(d.native.allowedPaths, ['**/components/ui/**', '**/ui/**', '**/primitives/**', '**/design-system/**', '**/shared/**', '**/common/**']);
  assert.deepEqual(d.styles.allowedPaths, d.native.allowedPaths);
  assert.deepEqual([d.duplicates.minLines, d.duplicates.minTokens, d.duplicates.styles, d.reference, d.locale, d.styles.nested], [5, 50, 'warning', null, null, 'layout']);
  const s = reuseSettings({ shared: ['src/lib/components/**'], severity: 'warning', names: { roles: { toast: null, feed: ['feed', 'timeline'] } }, native: { elements: { 'input[type=date]': 'src/lib/ui/DateField.svelte' } } });
  assert.deepEqual([s.severity.duplicates, s.roles.toast, s.roles.feed], ['warning', undefined, ['feed', 'timeline']]);
  assert.deepEqual(configIssues({ reuse: { reference: 'origin/main', styles: { nested: 'allow', selectors: ['.btn', '.pill--*'] }, typography: { locale: 'fr' } }, map: { file: 'docs/code-map.md' } }).issues, []);
  for (const reuse of [{ shared: ['../x/**'] }, { shared: ['/abs/**'] }, { native: { elements: { Select: null } } }, { severity: { native: 'fatal' } },
    { duplicates: { minTokens: 1 } }, { styles: { selectors: ['btn'] } }, { typography: { locale: 'français' } }, { bogus: true }, { reference: '-x' }]) {
    assert.ok(configIssues({ reuse }).issues.length, JSON.stringify(reuse));
  }
  assert.ok(configIssues({ map: { file: 'map.txt' } }).issues.length);
});

test('changes: added lines of a unified diff with zero context', () => {
  const diff = ['diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -3,0 +4,2 @@', '+x', '+y', '@@ -10 +12 @@', '-a', '+b',
    'diff --git a/gone.ts b/gone.ts', '--- a/gone.ts', '+++ /dev/null', '@@ -1,2 +0,0 @@', '"+++ b/odd"'].join('\n');
  const added = parseAddedLines(diff);
  assert.deepEqual([...added.get('src/a.ts')], [4, 5, 12]);
  assert.ok(!added.has('gone.ts'));
});

test('code map helpers: routes of the file-based routers, imports, props, variants and the role line', () => {
  assert.deepEqual(routeOf('src/routes/(app)/admin/articles/+page.svelte'), { route: '/admin/articles', root: 'src/routes' });
  assert.deepEqual(routeOf('src/routes/+page.server.ts'), { route: '/', root: 'src/routes' });
  assert.deepEqual(routeOf('app/(shop)/cart/page.tsx'), { route: '/cart', root: 'app' });
  assert.deepEqual(routeOf('src/pages/blog/index.astro'), { route: '/blog', root: 'src/pages' });
  assert.deepEqual(routeOf('app/routes/notes.$id.tsx'), { route: '/notes/:id', root: 'app/routes' });
  assert.equal(routeOf('src/lib/components/Card.svelte'), null);
  assert.deepEqual(declaredRoutes("app.get('/api/items', h)\n@router.post(\"/login\")\n"), [{ route: 'GET /api/items', line: 1 }, { route: 'POST /login', line: 2 }]);
  assert.deepEqual(importsOf("import A, { b as c, type D } from '$lib/x';\nimport './side.css';\nconst m = await import('./lazy.js');", 'ts').map(i => [i.spec, i.names]),
    [['$lib/x', ['b', 'D', 'A']], ['./side.css', []], ['./lazy.js', []]]);
  assert.deepEqual(importsOf('from .models import User, Group as G\nimport os, json\n', 'py').map(i => [i.spec, i.names]), [['.models', ['User', 'Group']], ['os', []], ['json', []]]);
  const svelte = "<!-- @component Bouton du socle. Deux variantes. -->\n<script lang=\"ts\">\n  interface Props { variant?: 'primary' | 'ghost'; size?: 's' | 'm'; onclick?: () => void }\n  let { variant = 'primary', size, onclick, ...rest }: Props = $props();\n</script>";
  const props = propsOf(svelte, 'svelte', 'Button');
  assert.deepEqual(props, ['variant', 'size', 'onclick', '...rest']);
  assert.deepEqual(variantsOf(svelte, props), { variant: ['primary', 'ghost'], size: ['s', 'm'] });
  assert.equal(summaryOf(svelte, 'svelte'), 'Bouton du socle.');
  assert.deepEqual(propsOf("<script setup lang=\"ts\">\ndefineProps<{ title: string; count?: number }>()\n</script>", 'vue', 'Card'), ['title', 'count']);
  assert.deepEqual(propsOf('export function Card({ title, children }: CardProps) { return null }', 'tsx', 'Card'), ['title', 'children']);
  assert.deepEqual(propsOf('const { title } = Astro.props;', 'astro', 'Hero'), ['title']);
  assert.equal(summaryOf('// eslint-disable-next-line\n/** Formate une date. Utilise Intl. */\nexport const f = 1;', 'ts'), 'Formate une date.');
  assert.equal(summaryOf('"""Accès aux données."""\n', 'py'), 'Accès aux données.');
  assert.equal(summaryOf('export const x = 1;', 'ts'), null);
});

test('code map markdown: sections by folder, bounded, deterministic', () => {
  const component = (path, shared, extra = {}) => ({ path, shared, generic: shared, summary: null, props: [], variants: {}, usedBy: [], clashes: [], ...extra });
  const many = Array.from({ length: 45 }, (_, i) => component(`src/lib/components/C${String(i).padStart(2, '0')}.svelte`, true));
  const map = {
    components: [...many, component('src/routes/admin/AdminToast.svelte', false, { usedBy: ['src/routes/admin/+page.svelte'],
      clashes: [{ path: 'src/routes/admin/AdminToast.svelte', with: 'src/lib/components/Toast.svelte', reason: 'affix', family: 'toast' }] })],
    modules: [{ path: 'src/lib/format.ts', feature: false, summary: 'Formats.', exports: [{ name: 'formatDate', kind: 'function' }, { name: 'LOCALE', kind: 'const' }], usedBy: ['a', 'b', 'c', 'd'] }],
    routes: [{ route: '/', files: ['src/routes/+page.svelte'] }],
    skipped: { tests: 2, ignored: 1, silentModules: 0 },
  };
  const text = codeMapMarkdown(map, { maxEntries: 400 });
  assert.equal(text, codeMapMarkdown(map, { maxEntries: 400 }));
  assert.match(text, /^# Carte du code\n/);
  assert.match(text, /### src\/lib\/components\n\n(- `C\d\d\.svelte` : sans description\. Utilisé nulle part\.\n){40}- et 5 autres entrées dans ce dossier/);
  assert.match(text, /- `format\.ts` : Formats\. Exporte : formatDate\(\), LOCALE\. Utilisé par 4 fichiers \(a, …\)\./);
  assert.match(text, /## Propre à une fonctionnalité\n\n### src\/routes\/admin\n\n- `AdminToast\.svelte` \(composant\) : [^\n]*Doublon possible : nom construit sur celui de src\/lib\/components\/Toast\.svelte \(rôle toast\)\./);
  assert.ok(!/[–—]/.test(text), 'no em or en dash');
  // The budget is shared: the small sections are listed whole, the large one gets what they leave.
  assert.deepEqual(shares([45, 1, 1, 1], 20), [17, 1, 1, 1]);
  assert.deepEqual(shares([0, 300, 40, 100], 100), [0, 34, 33, 33]);
  assert.deepEqual(shares([3, 2], 400), [3, 2]);
  const tight = codeMapMarkdown(map, { maxEntries: 20 });
  assert.match(tight, /- et 28 autres entrées dans ce dossier/);
  assert.match(tight, /## Routes\n\n- `\/` : src\/routes \(\+page\.svelte\)/);
  assert.match(tight, /AdminToast\.svelte/, 'the feature section is never starved');
});

// Review of PR #95: one test per correction.

test('H4: only the base class of a top-level rule is a primitive; states, themes and the document never are', () => {
  const css = `.btn { padding: 0; }
.btn.active { color: red; }
.btn--primary:hover { color: blue; }
.dark { --bg: #000; }
.dark .card { color: white; }
html.dark .panel { color: white; }
:root { --x: 1; }
[data-theme="dark"] .field { color: red; }
.is-open { display: block; }
.active { color: red; }
body { margin: 0; }
a:hover { color: red; }`;
  assert.deepEqual(primitivesOf(css), ['btn', 'btn--primary']);
});

test('M: nested adjustments of layout are accepted by default, a redefinition of the look is not', () => {
  const primitives = new Primitives(['btn'], [], []);
  const rules = styleRules('.own .btn { margin-top: 1rem; width: 100%; align-self: end; order: 2 }\n.own .btn { color: red; }\n.own { .btn { border-radius: 0 } }\n');
  const hits = restyledPrimitives(rules, primitives);
  assert.deepEqual(hits.map(h => [h.line, isLayoutOnly(h.properties)]), [[1, true], [2, false], [3, false]]);
  assert.deepEqual(rules[0].properties, ['margin-top', 'width', 'align-self', 'order']);
});

test('M: a native element in a comment, in a script or in a JSX string is not markup', () => {
  const rules = ['select'].map(elementRule);
  const svelte = '<script>\n  // <select> natif\n  const html = "<select>";\n</script>\n<!-- <select> -->\n<select bind:value={v}></select>\n';
  assert.deepEqual(findElements(svelte, rules, 'svelte').map(h => h.line), [6]);
  const jsx = 'const a = "<select>"; // <select>\nexport const F = () => <select value="a" />;\n';
  assert.deepEqual(findElements(jsx, rules, 'tsx').map(h => h.line), [2]);
  assert.deepEqual(findElements('<input type="date" />', ['input[type=date]'].map(elementRule), 'tsx').length, 1, 'attribute values are kept');
});

test('M: the replacement of an element is the generic shared component, primitives first; never a feature component', () => {
  const paths = ['src/lib/components/Dropdown.svelte', 'src/lib/components/ui/Select.svelte', 'src/lib/admin/components/AddDeviceDialog.svelte', 'src/lib/components/ui/ConfirmDialog.svelte'];
  const ui = p => p.includes('/ui/');
  assert.equal(replacementFor(paths, 'select', DEFAULT_ROLE_FAMILIES, ui), 'src/lib/components/ui/Select.svelte');
  assert.equal(replacementFor(paths, 'dialog', DEFAULT_ROLE_FAMILIES, ui), null, 'no generic dialog: none proposed');
  assert.equal(replacementFor(['src/lib/components/Dropdown.svelte'], 'select', DEFAULT_ROLE_FAMILIES, ui), 'src/lib/components/Dropdown.svelte');
});

test('BAS: typography leaves comments and drawings out', () => {
  const fr = typographyPatterns('fr');
  const markup = '<!-- publié à 14 h 47 -->\n<svg viewBox="0 0 24 24"><path d="M 10 20 h 30" /></svg>\n<path d="M 1 2 h 3" />\n<p>à 14 h 47</p>\n';
  assert.deepEqual(breakableValues(markup, 'svelte', fr, true).map(h => h.line), [4]);
});

test('N3: a truncated map keeps every generic component, gives each section a share, and names the folders left out', () => {
  const summary = 'Un composant du socle avec un rôle décrit en une ligne.';
  const component = (path, shared, generic = false) => ({ path, shared, generic, summary, props: ['a', 'b'], variants: {}, usedBy: ['src/routes/+page.svelte'], clashes: [] });
  // Folders that sort before ui/ (admin, agenda...) must not starve the design system.
  const map = {
    components: [
      ...Array.from({ length: 60 }, (_, i) => component(`src/lib/admin/components/A${String(i).padStart(2, '0')}.svelte`, true)),
      ...Array.from({ length: 40 }, (_, i) => component(`src/lib/components/agenda/G${String(i).padStart(2, '0')}.svelte`, true)),
      ...['Select', 'Dialog', 'DatePicker', 'ConfirmDialog', 'Button', 'Pagination'].map(n => component(`src/lib/components/ui/${n}.svelte`, true, true)),
      component('src/lib/components/app-shell/Sidebar.svelte', true, true),
      ...Array.from({ length: 30 }, (_, i) => component(`src/routes/f/F${String(i).padStart(2, '0')}.svelte`, false)),
    ],
    modules: Array.from({ length: 200 }, (_, i) => ({ path: `src/lib/m${String(i).padStart(3, '0')}/mod.ts`, feature: false, summary: 'Un module.', exports: [{ name: 'f', kind: 'function' }], usedBy: [] })),
    routes: Array.from({ length: 50 }, (_, i) => ({ route: `/r${i}`, files: [`src/routes/r${i}/+page.svelte`] })),
    skipped: { tests: 0, ignored: 0, silentModules: 0 }, partial: null,
  };
  const text = codeMapMarkdown(map, { maxEntries: 400, maxBytes: 12288 });
  assert.ok(Buffer.byteLength(text) <= 12288, `${Buffer.byteLength(text)} bytes`);
  for (const name of ['Select', 'Dialog', 'DatePicker', 'ConfirmDialog', 'Button', 'Pagination', 'Sidebar']) assert.ok(text.includes(`\`${name}.svelte\``), `generic component ${name} missing from a truncated map`);
  const section = title => text.split(`## ${title}\n`)[1].split('\n## ')[0];
  assert.match(section('Composants génériques (socle et structure)'), /### src\/lib\/components\/ui/);
  for (const title of ['Modules partagés', 'Routes', 'Autres composants partagés', 'Propre à une fonctionnalité']) assert.match(section(title), /^\n?(### |- )/m, `${title}: a minimum share`);
  assert.match(text, /Dossiers non listés, au-delà de la taille de la carte : [^\n]*src\/lib\/m\d{3} \(1\)/);
  assert.match(codeMapMarkdown({ ...map, partial: { described: 10, total: 60000 } }, { maxEntries: 400 }), /Carte partielle : le dépôt compte 60000 fichiers/);
  assert.equal(codeMapMarkdown(map, { maxEntries: 400, maxBytes: 12288 }), text, 'deterministic');
});

test('BAS: secrets are masked in summaries; paths and words are not', () => {
  // Fake keys assembled at run time: no key-shaped literal in the repository (secret scanning).
  const live = ['sk', 'live', 'abcdefgh12345678'].join('_');
  const test = ['sk', 'test', 'Zx81QwErTy67UiOp90AsDf'].join('_');
  assert.equal(maskSecrets(`clé ${live} et jeton eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig`), 'clé [masqué] et jeton [masqué]');
  assert.equal(maskSecrets('voir src/lib/components/app-shell/toast/ToastRegion'), 'voir src/lib/components/app-shell/toast/ToastRegion');
  assert.equal(maskSecrets('hash 0123456789abcdef0123456789abcdef'), 'hash [masqué]');
  assert.equal(summaryOf(`/** Client de paiement, clé ${test}. */\nexport const x = 1;`, 'ts'), 'Client de paiement, clé [masqué].');
});

test('BAS: patterns with a bounded repetition stay linear on a hostile input', () => {
  const started = Date.now();
  importsOf(`import ${'a '.repeat(40000)}`, 'ts');
  propsOf(`const Card ${'x'.repeat(40000)}`, 'tsx', 'Card');
  summaryOf(`${'# commentaire\n'.repeat(2000)}`, 'py');
  assert.ok(Date.now() - started < 2000, `${Date.now() - started} ms`);
});

test('M: the code map file is never searched for mentions by the scope of a proof', () => {
  assert.ok(NOT_SEARCHED.includes('.apv/code-map.md'));
});

test('M: apv on the PATH is found or reported', () => {
  const dir = mkdtempSync(join(tmpdir(), 'apv3-path-'));
  try {
    assert.equal(apvOnPath(dir), false);
    writeFileSync(join(dir, 'apv'), '#!/bin/sh\n');
    chmodSync(join(dir, 'apv'), 0o755);
    assert.equal(apvOnPath(`/nonexistent:${dir}`), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('H3: a generated file says so in its first lines; a comment that only mentions generation is not enough', () => {
  for (const header of ['// @generated', '/* eslint-disable */\n// This file was automatically generated. Do not edit.', '// Code generated by protoc-gen-go. DO NOT EDIT.', '// Fichier généré, ne pas modifier.', '# auto-generated'])
    assert.ok(GENERATED_HEADER.test(header), header);
  for (const header of ['// Le QR code generated by the authenticator app.', '// Codes générés par l\'appareil : ne pas les journaliser.'])
    assert.ok(!GENERATED_HEADER.test(header), header);
});

test('min-height and white-space place a primitive: layout', () => {
  assert.equal(isLayoutOnly(['min-height', 'white-space', 'margin-top']), true);
  assert.equal(isLayoutOnly(['min-height', 'color']), false);
});
