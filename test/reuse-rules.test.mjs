import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TokenTable, blankImports, findClones, occurs, tokenize } from '../dist/reuse/duplicates.js';
import { blocks, elementRule, findElements } from '../dist/reuse/markup.js';
import { Primitives, primitivesOf, restyledPrimitives, styleRules, unwrapScoping } from '../dist/reuse/styles.js';
import { breakableValues, typographyPatterns } from '../dist/reuse/typography.js';
import { clashOf, componentName, describeClash } from '../dist/reuse/names.js';
import { DEFAULT_ROLE_FAMILIES, reuseSettings } from '../dist/reuse/config.js';
import { parseAddedLines } from '../dist/reuse/changes.js';
import { codeMapMarkdown, shares, importsOf, propsOf, routeOf, summaryOf, variantsOf, declaredRoutes } from '../dist/knowledge/code-map.js';
import { configIssues } from '../dist/config/load.js';

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
  assert.deepEqual(d.severity, { native: 'error', styles: 'error', duplicates: 'error', names: 'warning', typography: 'warning' });
  assert.deepEqual(Object.keys(d.native.elements), ['select', 'dialog', 'datalist']);
  assert.deepEqual(d.native.allowedPaths, d.shared);
  assert.deepEqual([d.duplicates.minLines, d.duplicates.minTokens, d.reference, d.locale, d.styles.nested], [5, 50, null, null, 'refuse']);
  const s = reuseSettings({ shared: ['src/lib/components/**'], severity: 'warning', names: { roles: { toast: null, feed: ['feed', 'timeline'] } }, native: { elements: { 'input[type=date]': 'src/lib/ui/DateField.svelte' } } });
  assert.deepEqual([s.severity.duplicates, s.roles.toast, s.roles.feed, s.native.allowedPaths], ['warning', undefined, ['feed', 'timeline'], ['src/lib/components/**']]);
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
  const component = (path, shared, extra = {}) => ({ path, shared, summary: null, props: [], variants: {}, usedBy: [], clashes: [], ...extra });
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
