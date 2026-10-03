import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { gitRead, resolveFullRef } from '../run/git-probe.js';
import { isComponentFile, routeOf } from '../knowledge/code-map.js';
import { replacementFor } from './names.js';
import { DEFAULT_NATIVE_ELEMENTS, DEFAULT_PRIMITIVE_PATHS, DEFAULT_REUSE_IGNORE, DEFAULT_ROLE_FAMILIES, DEFAULT_STYLE_SOURCES, ELEMENT_FAMILIES, UI_EXTENSIONS, extensionOf, globMatcher, outputMatcher } from './config.js';

/**
 * The gate of `apv reuse check`, added by `apv init` and `apv onboard` to a web project (task stage: it also runs in the
 * full suite). What is new is counted from `{{baseSha}}`, the base of the run, which is part of the proof key of every
 * receipt: a moved remote-tracking ref (`git update-ref`) can never turn a copy into an existing block.
 */
export const REUSE_GATE = { id: 'reuse', command: ['apv', 'reuse', 'check', '--base', '{{baseSha}}'], covers: ['architecture'], stage: 'task', readOnly: true, mandatory: true } as const;
/**
 * The gate of the tree, added by `apv init` and `apv onboard` to every project (task stage, docs/STRUCTURE.md): a code file
 * added to a flat folder, or a folder, main route or entry point added without a role in the architecture map, fails it;
 * what existed at `{{baseSha}}` is reported without blocking.
 */
export const STRUCTURE_GATE = { id: 'structure', command: ['apv', 'structure', 'check', '--base', '{{baseSha}}'], covers: ['architecture'], stage: 'task', readOnly: true, mandatory: true } as const;
/**
 * The gate of the code map, added to every project: it fails when `.apv/code-map.md` no longer matches the code. Task
 * stage (decision D1, 3 October 2026): the implementer regenerates and commits the map with the code, and a stale map
 * blocks in two seconds, before the heavy checks of the full suite (which runs the task checks too).
 */
export const MAP_GATE = { id: 'code-map', command: ['apv', 'map', '--check'], covers: ['architecture'], stage: 'task', readOnly: true, mandatory: true } as const;

/** True when an executable `apv` is on the PATH: the generated checks call it by that name. */
export function apvOnPath(path = process.env['PATH'] ?? ''): boolean {
  for (const dir of path.split(delimiter).filter(Boolean)) {
    for (const name of process.platform === 'win32' ? ['apv.cmd', 'apv.exe', 'apv'] : ['apv']) {
      try { accessSync(join(dir, name), constants.X_OK); if (statSync(join(dir, name)).isFile()) return true; } catch { /* next */ }
    }
  }
  return false;
}

/** Dependencies that make a project a web interface. */
export const WEB_DEPENDENCIES = /^(?:svelte|@sveltejs\/kit|react|react-dom|next|vue|nuxt|astro|solid-js|@solidjs\/start|preact|lit|@angular\/core|@remix-run\/[\w-]+|@builder\.io\/qwik|@qwik\.dev\/core|htmx\.org|alpinejs)$/;
/** Folder names of shared components. */
const SHARED_NAMES = new Set(['components', 'ui', 'shared', 'common', 'widgets', 'primitives', 'design-system', 'designsystem', 'atoms', 'molecules', 'organisms', 'elements']);
/** Files that declare the language of the document. */
const LANG_FILES = ['src/app.html', 'index.html', 'src/index.html', 'public/index.html', 'app.html', 'src/app/layout.tsx', 'app/layout.tsx', 'src/app/layout.jsx', 'app/layout.jsx', 'src/layouts/Layout.astro', 'nuxt.config.ts', 'nuxt.config.js'];

/** The `reuse` section as `apv init` and `apv onboard` write it (validated by the schema of src/reuse/config.ts). */
export interface ReuseDocument {
  reference?: string;
  shared?: string[];
  native: { elements: Record<string, string | null>; allowedPaths?: string[] };
  styles?: { allowedPaths: string[] };
  typography?: { locale: string };
}

export interface ReuseProposal {
  /** A web interface: dependencies or interface files found. */
  web: boolean;
  signals: string[];
  /** The proposed `reuse` section (only what differs from the defaults, plus the shared folders and the reference). */
  section: ReuseDocument;
  shared: string[];
  primitives: string[];
  styleSources: string[];
  locale: string | null;
  reference: string | null;
}

function readJson(path: string): Record<string, unknown> | null {
  try { const value = JSON.parse(readFileSync(path, 'utf8')) as unknown; return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null; }
  catch { return null; }
}

/** The branch changes go to: `origin/HEAD`, else `origin/main` or `origin/master`; null otherwise (to configure). */
export function detectReference(repo: string): string | null {
  const head = gitRead(repo, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  if (head?.startsWith('refs/remotes/')) return head.slice('refs/remotes/'.length);
  for (const name of ['origin/main', 'origin/master']) if (resolveFullRef(repo, name).sha) return name;
  // Never the current branch: comparing a branch with itself would call everything existing.
  return null;
}

/** The language of the interface texts, from the `lang` of the document (`<html lang="fr">`, `lang: 'fr'`). */
export function detectLocale(repo: string): string | null {
  for (const file of LANG_FILES) {
    let text: string;
    try { text = readFileSync(join(repo, file), 'utf8'); } catch { continue; }
    const lang = /<html[^>]*\slang=["']([A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)["']/.exec(text)?.[1] ?? /\blang\s*:\s*["']([A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)["']/.exec(text)?.[1];
    if (lang) return lang.toLowerCase().replace(/-([a-z0-9]+)$/, (_, r: string) => `-${r.toUpperCase()}`);
  }
  return null;
}

/**
 * What `apv init` and `apv onboard` propose for the reuse check: whether the project is a web interface, its shared
 * component folders (the highest folders named components, ui, shared... that hold components, outside the routes), the
 * primitives folder (`ui`, `primitives`) where native elements are allowed, the shared component that replaces each
 * reserved element, its global stylesheets, the language of its texts and the reference branch.
 */
export function detectReuse(repo: string, files: readonly string[]): ReuseProposal {
  const ignored = globMatcher([...DEFAULT_REUSE_IGNORE]);
  const output = outputMatcher(files);
  const kept = files.filter(f => !ignored(f) && !output(f));
  const signals: string[] = [];
  const pkg = readJson(join(repo, 'package.json'));
  const deps = Object.keys({ ...(pkg?.['dependencies'] as object ?? {}), ...(pkg?.['devDependencies'] as object ?? {}) }).filter(d => WEB_DEPENDENCIES.test(d)).sort();
  if (deps.length) signals.push(`package.json : ${deps.join(', ')}`);
  const ui = kept.filter(f => UI_EXTENSIONS.has(extensionOf(f)));
  if (ui.length) signals.push(`${ui.length} fichier(s) d'interface (${[...new Set(ui.map(extensionOf))].sort().map(x => `.${x}`).join(', ')})`);

  const components = kept.filter(isComponentFile);
  const routeRoots = new Set(kept.map(routeOf).filter(r => r !== null).map(r => r!.root));
  const inRoutes = (path: string): boolean => [...routeRoots].some(root => path.startsWith(`${root}/`));
  const sharedDirs = new Set<string>();
  const primitiveDirs = new Set<string>();
  for (const path of components) {
    if (inRoutes(path)) continue;
    const parts = path.split('/').slice(0, -1);
    const first = parts.findIndex(p => SHARED_NAMES.has(p.toLowerCase()));
    if (first < 0) continue;
    sharedDirs.add(parts.slice(0, first + 1).join('/'));
    const primitive = parts.findIndex(p => p === 'ui' || p === 'primitives');
    if (primitive >= 0) primitiveDirs.add(parts.slice(0, primitive + 1).join('/'));
  }
  const shared = [...sharedDirs].sort().map(d => `${d}/**`);
  const primitives = [...primitiveDirs].sort().map(d => `${d}/**`);
  const sharedMatch = globMatcher(shared.length ? shared : ['**/components/**']);
  const sharedComponents = components.filter(sharedMatch);
  const preferred = globMatcher(primitives.length ? primitives : [...DEFAULT_PRIMITIVE_PATHS]);
  const elements: Record<string, string | null> = {};
  for (const element of DEFAULT_NATIVE_ELEMENTS) {
    elements[element] = replacementFor(sharedComponents, ELEMENT_FAMILIES[element]!, DEFAULT_ROLE_FAMILIES, preferred);
  }
  const present = new Set(files);
  const styleSources = DEFAULT_STYLE_SOURCES.filter(s => present.has(s));
  const locale = detectLocale(repo);
  const reference = detectReference(repo);
  const section: ReuseDocument = {
    ...(reference ? { reference } : {}),
    ...(shared.length ? { shared } : {}),
    native: { elements, ...(primitives.length ? { allowedPaths: primitives } : {}) },
    ...(primitives.length ? { styles: { allowedPaths: primitives } } : {}),
    ...(locale ? { typography: { locale } } : {}),
  };
  return { web: deps.length > 0 || ui.length > 0, signals, section, shared, primitives, styleSources, locale, reference };
}
