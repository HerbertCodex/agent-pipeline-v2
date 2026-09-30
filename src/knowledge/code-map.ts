import { posix } from 'node:path';
import { buildWorktreeInventory, type Inventory } from './inventory.js';
import { CODE_EXTENSIONS, parseName } from '../structure/names.js';
import { COMPONENT_EXTENSIONS, extensionOf, globMatcher, type MapSettings, type ReuseSettings } from '../reuse/config.js';
import { clashOf, componentName, describeClash, type Clash } from '../reuse/names.js';
import { readWorktree } from '../reuse/changes.js';

/**
 * The code map (`.apv/code-map.md`): what exists in the project, short enough for an agent to read before it creates a
 * component, a module or a route. Built from the working tree inventory (src/knowledge/inventory.ts), without a model,
 * deterministic (sorted by bytes, no commit id, no date) so that a stale map is a plain difference of text.
 */

export interface MapComponent {
  path: string;
  shared: boolean;
  summary: string | null;
  props: string[];
  variants: Record<string, string[]>;
  usedBy: string[];
  /** Shared components this one may double (name rule of `apv reuse check`), composition excepted. */
  clashes: Clash[];
}
export interface MapModule { path: string; feature: boolean; summary: string | null; exports: { name: string; kind: string }[]; usedBy: string[] }
export interface MapRoute { route: string; files: string[] }
export interface CodeMap {
  components: MapComponent[];
  modules: MapModule[];
  routes: MapRoute[];
  /** Files left out: tests, ignored paths, modules that export nothing and nobody imports. */
  skipped: { tests: number; ignored: number; silentModules: number };
}

const byBytes = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const dirOf = (path: string): string => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '.');
const baseOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

// ---------------------------------------------------------------------------------------------------------------
// Routes

export interface RouteOf { route: string; root: string }

/**
 * The route a file serves, for the file-based routers: SvelteKit (`routes/**\/+page.svelte`), Remix (`app/routes/`),
 * Next.js app router (`app/**\/page.tsx`), and the `pages/` folders (Next.js, Nuxt, Astro). Groups `(name)` and
 * parallel slots `@name` are left out of the route. Null for any other file.
 */
export function routeOf(path: string): RouteOf | null {
  const parts = path.split('/');
  const name = parts.at(-1)!;
  const clean = (segments: string[]): string => `/${segments.filter(s => !/^\(.*\)$/.test(s) && !s.startsWith('@')).join('/')}`.replace(/\/+$/, '') || '/';
  const routes = parts.indexOf('routes');
  if (name.startsWith('+') && routes >= 0) return { route: clean(parts.slice(routes + 1, -1)), root: parts.slice(0, routes + 1).join('/') };
  if (routes >= 1 && parts[routes - 1] === 'app' && /\.(tsx|jsx|ts|js)$/.test(name)) {
    const rest = parts.slice(routes + 1);
    const file = (rest.length > 1 && /^route\./.test(rest.at(-1)!) ? rest.slice(0, -1).join('.') : rest.join('.')).replace(/\.(tsx|jsx|ts|js)$/, '');
    return { route: clean(file.split('.').filter(s => s !== '_index' && s !== 'index').map(s => s.replace(/^\$/, ':'))), root: parts.slice(0, routes + 1).join('/') };
  }
  const app = parts[0] === 'app' ? 0 : parts[0] === 'src' && parts[1] === 'app' ? 1 : -1;
  if (app >= 0 && /^(page|route|layout|loading|error|not-found|template|default)\.(tsx|jsx|ts|js|mdx)$/.test(name)) {
    return { route: clean(parts.slice(app + 1, -1)), root: parts.slice(0, app + 1).join('/') };
  }
  const pages = parts[0] === 'pages' ? 0 : parts[0] === 'src' && parts[1] === 'pages' ? 1 : -1;
  if (pages >= 0 && /\.(svelte|vue|astro|tsx|jsx|ts|js|md|mdx)$/.test(name)) {
    const segments = [...parts.slice(pages + 1, -1), name.replace(/\.[^.]+$/, '')].filter(s => s !== 'index');
    return { route: clean(segments), root: parts.slice(0, pages + 1).join('/') };
  }
  return null;
}

const SERVER_ROUTE = /\b(?:app|router|api|server|route|routes|bp|blueprint|r|e|g)\s*\.\s*(get|post|put|patch|delete|all|options|head|route)\s*\(\s*['"`](\/[^'"`\s]*)['"`]/gi;
const DECORATOR_ROUTE = /^\s*@\w+\.(get|post|put|patch|delete|route|api_route)\(\s*['"](\/[^'"]*)['"]/gim;

/** Routes declared in code (Express, Fastify, Hono, Flask, FastAPI, Gin...): `GET /path` with the file and line. */
export function declaredRoutes(text: string): { route: string; line: number }[] {
  const out: { route: string; line: number }[] = [];
  for (const re of [SERVER_ROUTE, DECORATOR_ROUTE]) {
    for (const m of text.matchAll(re)) {
      const method = m[1]!.toLowerCase();
      const route = `${method === 'route' || method === 'all' || method === 'api_route' ? '' : `${method.toUpperCase()} `}${m[2]}`;
      const line = text.slice(0, m.index).split('\n').length;
      if (!out.some(x => x.route === route && x.line === line)) out.push({ route, line });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Imports

interface ImportRef { spec: string; names: string[] }

const JS_IMPORTS = [
  /\bimport\s+(?:type\s+)?([\w$*{}\s,]+?)\s+from\s+['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

/** Imports of a source file: ECMAScript (static, dynamic, `require`) and Python (`import`, `from ... import`). */
export function importsOf(text: string, ext: string): ImportRef[] {
  const out: ImportRef[] = [];
  if (ext === 'py') {
    for (const m of text.matchAll(/^\s*from\s+(\.*[\w.]*)\s+import\s+\(?([^\n#)]+)/gm)) out.push({ spec: m[1]!, names: m[2]!.split(',').map(x => x.trim().split(/\s+as\s+/)[0]!).filter(Boolean) });
    for (const m of text.matchAll(/^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/gm)) for (const spec of m[1]!.split(',')) out.push({ spec: spec.trim(), names: [] });
    return out;
  }
  for (const m of text.matchAll(JS_IMPORTS[0]!)) {
    const clause = m[1]!;
    const names = [...(/\{([^}]*)\}/.exec(clause)?.[1] ?? '').split(',').map(x => x.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]!.trim()).filter(Boolean)];
    const fallback = /^\s*([A-Za-z_$][\w$]*)/.exec(clause.replace(/\{[^}]*\}/, ''))?.[1];
    if (fallback) names.push(fallback);
    out.push({ spec: m[2]!, names });
  }
  for (const re of JS_IMPORTS.slice(1)) for (const m of text.matchAll(re)) out.push({ spec: m[1]!, names: [] });
  return out;
}

const STRIP_EXT = /\.(?:js|mjs|cjs|ts|mts|cts|jsx|tsx|svelte|vue|astro|json|py)$/;
/** Key of a module path: without its extensions (`x.svelte.ts` is `x`). */
function moduleKey(path: string): string {
  const dir = dirOf(path);
  const stem = baseOf(path).split('.')[0]!;
  return dir === '.' ? stem : `${dir}/${stem}`;
}
function stripExtensions(spec: string): string {
  let out = spec;
  for (let i = 0; i < 3 && STRIP_EXT.test(out); i++) out = out.replace(STRIP_EXT, '');
  return out;
}
const ENTRY = new Set(['index', '__init__', 'mod']);

/** Resolves import specifiers to the files of the project: relative paths exactly, aliases (`$lib/`, `@/`, `~/`, `#`) and Python modules by suffix. */
class Resolver {
  private readonly keys = new Map<string, string[]>();
  private readonly byLast = new Map<string, string[]>();
  constructor(files: readonly string[]) {
    for (const path of files) {
      const key = moduleKey(path);
      const add = (k: string): void => {
        this.keys.set(k, [...(this.keys.get(k) ?? []), path]);
        const last = k.slice(k.lastIndexOf('/') + 1);
        if (!(this.byLast.get(last) ?? []).includes(k)) this.byLast.set(last, [...(this.byLast.get(last) ?? []), k]);
      };
      add(key);
      if (ENTRY.has(baseOf(key)) && dirOf(key) !== '.') add(dirOf(key));
    }
  }
  resolve(importer: string, spec: string): string[] {
    const py = importer.endsWith('.py');
    if (py && spec.startsWith('.')) {
      const dots = /^\.+/.exec(spec)![0].length;
      let dir = dirOf(importer);
      for (let i = 1; i < dots; i++) dir = dirOf(dir);
      const rest = spec.slice(dots).replace(/\./g, '/');
      return this.keys.get(rest ? (dir === '.' ? rest : `${dir}/${rest}`) : dir) ?? [];
    }
    if (spec.startsWith('.')) {
      const target = stripExtensions(posix.normalize(posix.join(dirOf(importer), spec)));
      return this.keys.get(target) ?? [];
    }
    let rest: string | null = null;
    if (/^(?:\$|~|#|@\/)/.test(spec)) rest = spec.includes('/') ? spec.slice(spec.indexOf('/') + 1) : null;
    else if (py) rest = spec.replace(/\./g, '/');
    if (!rest) return [];
    rest = stripExtensions(rest);
    const last = rest.slice(rest.lastIndexOf('/') + 1);
    return (this.byLast.get(last) ?? []).filter(k => k === rest || k.endsWith(`/${rest}`)).flatMap(k => this.keys.get(k) ?? []);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Component and module details

const IGNORED_COMMENT = /eslint|@ts-|prettier|biome|licen[cs]e|copyright|svelte-ignore|@jsx|use client|use strict|@vitest|istanbul|c8 ignore|#!/i;

/** Longest role line of an entry: the map stays short enough for an agent to read it whole. */
const SUMMARY_MAX = 90;

/** First sentence of a text, on one line, SUMMARY_MAX characters at most, with Markdown code quotes and table pipes neutralised. */
function sentence(text: string): string | null {
  const flat = text.replace(/^\s*\*+/gm, ' ').replace(/@component/g, ' ').replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  const end = flat.search(/[.!?](?:\s|$)/);
  let out = end >= 0 ? flat.slice(0, end + 1) : flat;
  if (out.length > SUMMARY_MAX) out = `${out.slice(0, out.lastIndexOf(' ', SUMMARY_MAX - 3) > 40 ? out.lastIndexOf(' ', SUMMARY_MAX - 3) : SUMMARY_MAX - 3)}…`;
  return out.replace(/`/g, '\'').replace(/\|/g, '/');
}

/** Role of a file in one line: its `@component` comment, else the first comment of its first 40 lines (tool directives left out). */
export function summaryOf(text: string, ext: string): string | null {
  const component = /<!--\s*@component([\s\S]*?)-->/.exec(text);
  if (component) return sentence(component[1]!);
  const head = text.split('\n').slice(0, 40).join('\n');
  const patterns = ext === 'py'
    ? [/^\s*(?:"""|''')([\s\S]*?)(?:"""|''')/, /^((?:\s*#[^\n]*\n)+)/m]
    : [/<!--([\s\S]*?)-->/g, /\/\*\*?([\s\S]*?)\*\//g, /((?:^[ \t]*\/\/[^\n]*\n?)+)/gm];
  let best: { index: number; text: string } | null = null;
  for (const re of patterns) {
    for (const m of head.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`))) {
      const body = (m[1] ?? '').replace(/^\s*(?:\/\/|#)/gm, ' ');
      if (!body.trim() || IGNORED_COMMENT.test(body)) continue;
      if (!best || m.index < best.index) best = { index: m.index, text: body };
      break;
    }
  }
  return best ? sentence(best.text) : null;
}

/** Top-level comma-separated items of a destructuring or object type (`a, b = 1, ...rest`). */
function topItems(body: string): string[] {
  const out: string[] = [];
  let depth = 0; let current = ''; let quote = '';
  for (const c of body) {
    if (quote) { current += c; if (c === quote) quote = ''; continue; }
    if (c === '\'' || c === '"' || c === '`') { quote = c; current += c; continue; }
    if ('([{<'.includes(c)) depth++;
    if (')]}>'.includes(c)) depth--;
    if ((c === ',' || c === ';' || c === '\n') && depth === 0) { if (current.trim()) out.push(current.trim()); current = ''; continue; }
    current += c;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

function namesOf(items: string[]): string[] {
  return items.map(item => {
    const rest = /^\.\.\.\s*([A-Za-z_$][\w$]*)/.exec(item);
    if (rest) return `...${rest[1]}`;
    return /^(?:readonly\s+)?([A-Za-z_$][\w$]*)/.exec(item)?.[1] ?? '';
  }).filter(n => n && !/^(?:type|interface|const|let|var|function)$/.test(n));
}

/** Props of a component: Svelte (`$props()`, `export let`), Vue (`defineProps`), Astro (`Astro.props`), React (parameters or `XxxProps`). */
export function propsOf(text: string, ext: string, stem: string): string[] {
  const found: string[] = [];
  const add = (body: string | undefined): void => { if (body !== undefined) found.push(...namesOf(topItems(body))); };
  if (ext === 'svelte') {
    add(/let\s*\{([\s\S]*?)\}\s*(?::\s*[^=;]+?)?=\s*\$props\s*\(/.exec(text)?.[1]);
    for (const m of text.matchAll(/\bexport\s+let\s+([A-Za-z_$][\w$]*)/g)) found.push(m[1]!);
  } else if (ext === 'vue') {
    add(/defineProps\s*<\s*\{([\s\S]*?)\}\s*>/.exec(text)?.[1]);
    add(/defineProps\s*\(\s*\{([\s\S]*?)\}\s*\)/.exec(text)?.[1]?.replace(/\{[^{}]*\}/g, ''));
    const list = /defineProps\s*\(\s*\[([^\]]*)\]/.exec(text)?.[1];
    if (list) found.push(...[...list.matchAll(/['"]([\w$-]+)['"]/g)].map(m => m[1]!));
  } else if (ext === 'astro') {
    add(/const\s*\{([\s\S]*?)\}\s*=\s*Astro\.props/.exec(text)?.[1]);
  } else {
    const name = stem.replace(/[^\w$]/g, '');
    add(new RegExp(`function\\s+${name}\\s*(?:<[^>]*>)?\\s*\\(\\s*\\{([\\s\\S]*?)\\}\\s*(?::[^)]*)?\\)`).exec(text)?.[1]
      ?? new RegExp(`(?:const|let)\\s+${name}\\b[^=]*=\\s*(?:\\w+\\()?\\s*\\(\\s*\\{([\\s\\S]*?)\\}\\s*(?::[^)]*)?\\)\\s*=>`).exec(text)?.[1]
      ?? new RegExp(`(?:interface\\s+${name}Props\\s*(?:extends[^{]*)?|type\\s+${name}Props\\s*=\\s*)\\{([\\s\\S]*?)\\n\\}`).exec(text)?.[1]);
  }
  return [...new Set(found)].slice(0, 16);
}

/** String literal unions of the props (`variant?: 'primary' | 'ghost'`), 8 values at most per prop. */
export function variantsOf(text: string, props: readonly string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const prop of props) {
    if (prop.startsWith('...')) continue;
    const m = new RegExp(`\\b${prop}\\??\\s*:\\s*((?:'[^']*'|"[^"]*")(?:\\s*\\|\\s*(?:'[^']*'|"[^"]*"))+)`).exec(text);
    if (m) out[prop] = [...m[1]!.matchAll(/['"]([^'"]*)['"]/g)].map(x => x[1]!).slice(0, 8);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Build

const CONFIG_FILE = /(?:^|\/)[^/]+\.config\.[a-z]+$|(?:^|\/)(?:setup|conftest|manage)\.py$/;

export interface BuildOptions { inventory?: Inventory; read?: (path: string) => string | null }

/** Is this file a component (and not a route file)? Svelte, Vue and Astro files always; JSX files named in PascalCase. */
export function isComponentFile(path: string): boolean {
  const ext = extensionOf(path);
  if (!COMPONENT_EXTENSIONS.has(ext) || routeOf(path)) return false;
  const stem = baseOf(path).split('.')[0] ?? '';
  if (!/^[A-Za-z]/.test(stem)) return false;
  return ext === 'tsx' || ext === 'jsx' ? /^[A-Z]/.test(stem) : true;
}

/**
 * Shared components `path` may double (rule in src/reuse/names.ts), composition excepted: a component that imports the
 * shared one, or is imported by it, builds on it. With `symmetric` false, two shared components are compared once
 * (the later path against the earlier), which is what the map prints.
 */
export function clashesFor(map: CodeMap, path: string, families: Readonly<Record<string, readonly string[]>>, symmetric = true): Clash[] {
  const self = map.components.find(c => c.path === path);
  const candidate = componentName(path, families);
  const out: Clash[] = [];
  for (const shared of map.components) {
    if (!shared.shared || shared.path === path) continue;
    if (!symmetric && self?.shared && !(shared.path < path)) continue;
    if (shared.usedBy.includes(path) || (self?.usedBy.includes(shared.path) ?? false)) continue;
    const clash = clashOf(candidate, componentName(shared.path, families));
    if (clash) out.push(clash);
  }
  return out;
}

export async function buildCodeMap(repo: string, reuse: ReuseSettings, settings: MapSettings, options: BuildOptions = {}): Promise<CodeMap> {
  const inventory = options.inventory ?? await buildWorktreeInventory(repo);
  const read = options.read ?? ((path: string) => readWorktree(repo, path));
  const ignored = globMatcher(settings.ignore);
  const shared = globMatcher(reuse.shared);
  const skipped = { tests: 0, ignored: 0, silentModules: 0 };
  const sources: string[] = [];
  for (const path of inventory.files) {
    const ext = extensionOf(path);
    if (!CODE_EXTENSIONS.has(ext) && !COMPONENT_EXTENSIONS.has(ext)) continue;
    if (ignored(path) || path === settings.file) { skipped.ignored++; continue; }
    if (parseName(path)?.test) { skipped.tests++; continue; }
    sources.push(path);
  }
  sources.sort(byBytes);
  const texts = new Map<string, string>();
  for (const path of sources) { const text = read(path); if (text !== null) texts.set(path, text); }

  // Who imports whom (tests left out: a file used only by its tests is unused).
  const resolver = new Resolver(sources);
  const usedBy = new Map<string, Set<string>>();
  const use = (target: string, importer: string): void => {
    if (target === importer) return;
    let set = usedBy.get(target);
    if (!set) { set = new Set(); usedBy.set(target, set); }
    set.add(importer);
  };
  for (const [importer, text] of texts) {
    for (const ref of importsOf(text, extensionOf(importer))) {
      for (const target of resolver.resolve(importer, ref.spec)) {
        use(target, importer);
        // A barrel (`index.ts`) re-exports its folder: a named import reaches the file of that name.
        if (ENTRY.has(baseOf(target).split('.')[0]!) && ref.names.length) {
          const dir = dirOf(target);
          for (const name of ref.names) for (const file of sources) if (file.startsWith(`${dir}/`) && baseOf(file).split('.')[0] === name) use(file, importer);
        }
      }
    }
  }
  const users = (path: string): string[] => [...(usedBy.get(path) ?? [])].sort(byBytes);

  const routes = new Map<string, Set<string>>();
  const roots = new Set<string>();
  const addRoute = (route: string, file: string): void => { const set = routes.get(route) ?? new Set<string>(); set.add(file); routes.set(route, set); };
  for (const path of sources) {
    const route = routeOf(path);
    if (route) { addRoute(route.route, path); roots.add(route.root); }
  }
  const inFeature = (path: string): boolean => [...roots].some(root => path.startsWith(`${root}/`));

  const exportsByPath = new Map<string, { name: string; kind: string }[]>();
  for (const symbol of inventory.symbols) {
    if (!symbol.exported || symbol.test) continue;
    const list = exportsByPath.get(symbol.path) ?? [];
    if (!list.some(x => x.name === symbol.name)) list.push({ name: symbol.name, kind: symbol.kind });
    exportsByPath.set(symbol.path, list);
  }

  const components: MapComponent[] = [];
  const modules: MapModule[] = [];
  for (const path of sources) {
    const text = texts.get(path) ?? '';
    const ext = extensionOf(path);
    if (routeOf(path)) {
      for (const declared of declaredRoutes(text)) addRoute(declared.route, `${path}:${declared.line}`);
      continue;
    }
    if (isComponentFile(path)) {
      const props = propsOf(text, ext, baseOf(path).split('.')[0]!);
      components.push({ path, shared: shared(path), summary: summaryOf(text, ext), props, variants: variantsOf(text, props), usedBy: users(path), clashes: [] });
      continue;
    }
    for (const declared of declaredRoutes(text)) addRoute(declared.route, `${path}:${declared.line}`);
    if (CONFIG_FILE.test(path)) continue;
    const exports = (exportsByPath.get(path) ?? []).slice().sort((a, b) => byBytes(a.name, b.name));
    const used = users(path);
    if (!exports.length && !used.length) { skipped.silentModules++; continue; }
    modules.push({ path, feature: inFeature(path), summary: summaryOf(text, ext), exports, usedBy: used });
  }
  const map: CodeMap = {
    components, modules,
    routes: [...routes].map(([route, files]) => ({ route, files: [...files].sort(byBytes) })).sort((a, b) => byBytes(a.route, b.route)),
    skipped,
  };
  for (const component of map.components) component.clashes = clashesFor(map, component.path, reuse.roles, false);
  return map;
}

// ---------------------------------------------------------------------------------------------------------------
// Markdown

const PER_FOLDER = 40;
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n > 1 ? many : one}`;

function usage(list: readonly string[], examples: number): string {
  if (!list.length) return 'Utilisé nulle part.';
  const shown = list.slice(0, examples).join(', ');
  return `Utilisé par ${plural(list.length, 'fichier')} (${shown}${list.length > examples ? ', …' : ''}).`;
}

function componentLine(c: MapComponent, withKind: boolean): string {
  const shown = c.props.slice(0, 8).map(p => (c.variants[p] ? `${p} (${c.variants[p]!.join(' / ')})` : p));
  const props = c.props.length ? ` Props : ${shown.join(', ')}${c.props.length > 8 ? ', …' : ''}.` : '';
  const clashes = c.clashes.length ? ` Doublon possible : ${c.clashes.map(describeClash).join(' ; ')}.` : '';
  return `- \`${baseOf(c.path)}\`${withKind ? ' (composant)' : ''} : ${c.summary ?? 'sans description.'}${props} ${usage(c.usedBy, 2)}${clashes}`;
}

function moduleLine(m: MapModule, withKind: boolean): string {
  const shown = m.exports.slice(0, 6).map(e => (e.kind === 'function' || e.kind === 'method' ? `${e.name}()` : e.name));
  const exports = m.exports.length ? ` Exporte : ${shown.join(', ')}${m.exports.length > 6 ? `, et ${m.exports.length - 6} autre(s)` : ''}.` : '';
  return `- \`${baseOf(m.path)}\`${withKind ? ' (module)' : ''} : ${m.summary ?? 'sans description.'}${exports} ${usage(m.usedBy, 1)}`;
}

/** A route and its files, the folder written once: `/admin` : src/routes/admin (+page.svelte, +page.server.ts). */
function routeLine(r: MapRoute): string {
  const dirs = [...new Set(r.files.map(dirOf))];
  const files = dirs.length === 1 && !r.files.some(f => /:\d+$/.test(f)) ? `${dirs[0]} (${r.files.map(baseOf).join(', ')})` : r.files.join(', ');
  return `- \`${r.route}\` : ${files}`;
}

/**
 * Entries each section may list, out of `total`: an equal share for every section, what a small section leaves going to
 * the larger ones, so that no section is starved by the ones printed before it.
 */
export function shares(sizes: readonly number[], total: number): number[] {
  const given = sizes.map(() => 0);
  let remaining = total;
  let open = sizes.map((_, i) => i).filter(i => sizes[i]! > 0);
  while (remaining > 0 && open.length) {
    const share = Math.max(1, Math.floor(remaining / open.length));
    for (const i of open) {
      const give = Math.min(share, sizes[i]! - given[i]!, remaining);
      given[i]! += give;
      remaining -= give;
    }
    open = open.filter(i => given[i]! < sizes[i]!);
  }
  return given;
}

/** The map as Markdown: sections by folder, bounded (40 entries per folder, `maxEntries` shared between the sections), counts of what is left out. */
export function codeMapMarkdown(map: CodeMap, settings: Pick<MapSettings, 'maxEntries'>): string {
  const lines: string[] = [];
  const section = (title: string, entries: { path: string; line: string }[], limit: number, empty: string): void => {
    lines.push(`## ${title}`, '');
    if (!entries.length) { lines.push(empty, ''); return; }
    let budget = limit;
    const folders = new Map<string, string[]>();
    for (const e of entries) folders.set(dirOf(e.path), [...(folders.get(dirOf(e.path)) ?? []), e.line]);
    for (const [dir, list] of [...folders].sort((a, b) => byBytes(a[0], b[0]))) {
      lines.push(`### ${dir}`, '');
      const shown = list.slice(0, Math.min(PER_FOLDER, Math.max(0, budget)));
      budget -= shown.length;
      lines.push(...shown);
      if (list.length > shown.length) lines.push(`- et ${plural(list.length - shown.length, 'autre entrée', 'autres entrées')} dans ce dossier (liste complète : apv map --json).`);
      lines.push('');
    }
  };
  const sharedComponents = map.components.filter(c => c.shared);
  const featureComponents = map.components.filter(c => !c.shared);
  const sharedModules = map.modules.filter(m => !m.feature);
  const featureModules = map.modules.filter(m => m.feature);
  const feature = [...featureComponents.map(c => ({ path: c.path, line: componentLine(c, true) })), ...featureModules.map(m => ({ path: m.path, line: moduleLine(m, true) }))]
    .sort((a, b) => byBytes(a.path, b.path));
  const [componentsLimit, modulesLimit, routesLimit, featureLimit] = shares([sharedComponents.length, sharedModules.length, map.routes.length, feature.length], settings.maxEntries);
  lines.push('# Carte du code', '',
    'Générée par `apv map` à partir des fichiers du dépôt, sans modèle. À lire avant de créer un composant, un module ou une route : réutiliser une entrée existante, ou l\'étendre de façon générique (paramètre, variante) ; un élément utilisé par deux fonctionnalités devient partagé. Ne pas modifier à la main : `apv map` la régénère, et le contrôle `apv map --check` échoue quand elle ne correspond plus au code.', '',
    `Composants partagés : ${sharedComponents.length}. Modules partagés : ${sharedModules.length}. Routes : ${map.routes.length}. Propres à une fonctionnalité : ${featureComponents.length} composant(s), ${featureModules.length} module(s). Laissés de côté : ${map.skipped.tests} test(s), ${map.skipped.ignored} fichier(s) ignoré(s), ${map.skipped.silentModules} module(s) sans export ni import.`, '');
  section('Composants partagés', sharedComponents.map(c => ({ path: c.path, line: componentLine(c, false) })), componentsLimit!, 'Aucun composant partagé (dossiers de `reuse.shared`).');
  section('Modules partagés', sharedModules.map(m => ({ path: m.path, line: moduleLine(m, false) })), modulesLimit!, 'Aucun module partagé.');
  lines.push('## Routes', '');
  if (!map.routes.length) lines.push('Aucune route trouvée.', '');
  else {
    const shown = map.routes.slice(0, routesLimit);
    lines.push(...shown.map(routeLine));
    if (map.routes.length > shown.length) lines.push(`- et ${plural(map.routes.length - shown.length, 'autre route', 'autres routes')} (liste complète : apv map --json).`);
    lines.push('');
  }
  section('Propre à une fonctionnalité', feature, featureLimit!, 'Rien de propre à une fonctionnalité.');
  return `${lines.join('\n').replace(/ +$/gm, '').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}
