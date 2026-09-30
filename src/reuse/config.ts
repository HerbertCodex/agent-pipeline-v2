import { isAbsolute, posix } from 'node:path';
import { s, type Infer } from '../domain/schema.js';
import { invariant } from '../domain/errors.js';
import { globToRegExp } from '../db/glob.js';

/** Rules of `apv reuse check` (docs/REUSE.md). */
export const REUSE_RULES = ['native', 'styles', 'duplicates', 'names', 'typography'] as const;
export type ReuseRule = typeof REUSE_RULES[number];
export const REUSE_SEVERITIES = ['off', 'warning', 'error'] as const;
export type ReuseSeverity = typeof REUSE_SEVERITIES[number];

/**
 * Default severity of each rule: a native element or a primitive restyled outside the shared components, and a block
 * copied by the change, fail the check; a component whose name doubles a shared one and a breakable space in a
 * typographic value are warnings (their rule is a prompt to look, not a proof).
 */
export const DEFAULT_REUSE_SEVERITY: Readonly<Record<ReuseRule, ReuseSeverity>> = { native: 'error', styles: 'error', duplicates: 'error', names: 'warning', typography: 'warning' };

/** Native elements reserved to the shared components by default: their look and behaviour differ between browsers. */
export const DEFAULT_NATIVE_ELEMENTS = ['select', 'dialog', 'datalist'] as const;

/** The role family of the shared component that stands for a native element (`select` is replaced by a select). */
export const ELEMENT_FAMILIES: Readonly<Record<string, string>> = { select: 'select', datalist: 'select', dialog: 'dialog', details: 'accordion', input: 'input', progress: 'spinner', table: 'table' };

/** Shared component folders when the project declares none: the usual names, whatever their depth. */
export const DEFAULT_SHARED = ['**/components/**', '**/ui/**', '**/shared/**', '**/common/**'] as const;

/** Blocks shorter than this are never reported (the defaults of jscpd: 5 lines, 50 tokens). */
export const DEFAULT_DUPLICATES = { minLines: 5, minTokens: 50 } as const;

/** Global stylesheets looked for, in this order, when `styles.sources` is absent: the first ones present are read. */
export const DEFAULT_STYLE_SOURCES = [
  'src/app.css', 'src/app.scss', 'src/app.pcss', 'src/app.postcss', 'src/global.css', 'src/globals.css', 'src/index.css', 'src/styles.css',
  'src/styles/app.css', 'src/styles/global.css', 'src/styles/globals.css', 'src/styles/main.css', 'src/assets/main.css', 'src/assets/base.css',
  'app/globals.css', 'app/global.css', 'styles/globals.css', 'styles/global.css', 'assets/css/main.css', 'static/global.css', 'public/global.css',
] as const;

/** Files that hold interface markup: the native elements, local styles and texts are read there. */
export const UI_EXTENSIONS = new Set(['svelte', 'vue', 'tsx', 'jsx', 'astro', 'html', 'htm', 'hbs', 'handlebars', 'erb', 'ejs', 'njk', 'twig', 'liquid', 'mdx']);
/** Component files (a file that is one component), for the map and the name rule. */
export const COMPONENT_EXTENSIONS = new Set(['svelte', 'vue', 'tsx', 'jsx', 'astro']);
/** Stylesheets. */
export const STYLE_EXTENSIONS = new Set(['css', 'scss', 'sass', 'less', 'pcss', 'postcss', 'styl']);

/** Folders of tools, left out wherever they are: never a hidden folder in general (`src/.hidden/` is analysed). */
export const TOOL_FOLDERS = ['.git', '.svelte-kit', '.next', '.nuxt', '.output', '.vercel', '.netlify', '.turbo', '.cache', '.parcel-cache', '.astro', '.angular',
  '.docusaurus', '.expo', '.yarn', '.pnpm-store', '.husky', '.idea', '.vscode', '.github', '.claude', '.apv', '.apv2'] as const;
/** Build outputs and vendored code: left out at the root of the repository and of each package (a folder with a `package.json`) only. */
export const OUTPUT_FOLDERS = ['dist', 'build', 'coverage', 'vendor'] as const;

/**
 * Paths never analysed: dependencies, tool folders, the documentation (validated mockups are HTML copies of the
 * interface by design) and minified or declaration files. Build outputs: OUTPUT_FOLDERS, see outputMatcher.
 */
export const DEFAULT_REUSE_IGNORE = ['**/node_modules/**', ...TOOL_FOLDERS.map(d => `**/${d}/**`), 'docs/**', '**/*.min.js', '**/*.min.css', '**/*.d.ts', '**/*.lock', '**/package-lock.json'] as const;

/** Build outputs (OUTPUT_FOLDERS) at the root of the repository and at the root of each package that `files` holds. */
export function outputMatcher(files: readonly string[]): (path: string) => boolean {
  const roots = ['', ...files.filter(f => f.endsWith('/package.json') && !f.includes('node_modules/')).map(f => f.slice(0, -'package.json'.length))];
  const prefixes = roots.flatMap(root => OUTPUT_FOLDERS.map(d => `${root}${d}/`));
  return path => prefixes.some(p => path.startsWith(p));
}

/**
 * Files a tool writes (database types, clients, schemas), recognised by their name: left out of every rule and listed
 * apart in the report, never counted. A file whose first lines say it is generated (`@generated`, « do not edit »,
 * « auto-generated ») is treated the same way (GENERATED_HEADER), but only when it already said so at the base: a change
 * that adds the mention is reported, never trusted. An interface file (UI_EXTENSIONS) is never generated.
 */
export const GENERATED_PATHS = ['**/*.generated.*', '**/*.gen.*', '**/generated/**', '**/__generated__/**', '**/database.types.*', '**/supabase.types.*'] as const;
export const GENERATED_HEADER = /@generated\b|\bdo not (?:edit|modify)\b|\bauto-?generated\b|\bthis file (?:was|is|has been) (?:automatically )?generated\b|\bcode generated by [^\n]{0,80}do not edit|généré automatiquement|fichier généré[^\n]{0,80}ne pas modifier/i;

/**
 * Where native elements and primitive styles may be written by default: the generic shared components (a design system
 * folder), never a component folder of one feature (`src/lib/admin/components`).
 */
export const DEFAULT_PRIMITIVE_PATHS = ['**/components/ui/**', '**/ui/**', '**/primitives/**', '**/design-system/**', '**/shared/**', '**/common/**'] as const;

/** Nested adjustments of a primitive under a class of the component: `layout` (default) accepts layout properties only. */
export const NESTED_MODES = ['layout', 'refuse', 'allow'] as const;
export type NestedMode = typeof NESTED_MODES[number];

/** Default bound of the code map in bytes: a few tens of kilobytes, read whole by an agent before each task. */
export const DEFAULT_MAP_MAX_BYTES = 32_768;

const glob = s.string(1, 4096);
const globs = s.array(glob, 0, 200);
const severity = s.enum(REUSE_SEVERITIES);
/** A native element (`select`) or an element with one attribute value (`input[type=date]`). */
export const ELEMENT_SELECTOR = /^[a-z][a-z0-9-]*(?:\[[a-z][a-z0-9-]*=[A-Za-z0-9_-]+\])?$/;
/** A class selector of a primitive (`.btn`), or a prefix of classes (`.btn--*`). */
export const PRIMITIVE_SELECTOR = /^\.[A-Za-z_][A-Za-z0-9_-]*\*?$/;
const WORD = /^[a-z0-9]+$/;
const ROLE = /^[a-z][a-z0-9-]*$/;
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const LOCALE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

/** The `reuse` section of `.apv/config.json` (docs/REUSE.md). Every field is optional: absent, the defaults apply. */
export const reuseSchema = s.object({
  /** The branch the change goes to (`origin/main`): what the change adds is counted from its merge base. `--base` wins. */
  reference: s.optional(s.string(1, 200, REFERENCE)),
  /** Globs of the shared component folders (`src/lib/components/**`). */
  shared: s.optional(s.array(glob, 1, 100)),
  /** Globs of files a tool writes, accepted as generated even when the change creates them (see GENERATED_PATHS). */
  generated: s.optional(globs),
  /** Globs of paths left out of every rule, added to the defaults. */
  ignore: s.optional(globs),
  native: s.optional(s.object({
    /** Reserved elements, each with the shared component to use instead (`null`: the one the map finds, if any). */
    elements: s.optional(s.record(ELEMENT_SELECTOR, s.nullable(s.string(1, 4096)), 50)),
    /** Where the reserved elements are allowed (the generic shared components that wrap them); absent: DEFAULT_PRIMITIVE_PATHS. */
    allowedPaths: s.optional(globs),
  })),
  styles: s.optional(s.object({
    /** Global stylesheets whose top-level classes are the primitives; absent: the first of DEFAULT_STYLE_SOURCES present. */
    sources: s.optional(s.array(glob, 0, 20)),
    /** Primitive classes added to those read in the sources (`.btn`, `.pill--*`). */
    selectors: s.optional(s.array(s.string(2, 200, PRIMITIVE_SELECTOR), 0, 500)),
    /** Classes of the sources that are not primitives (utilities a component may restyle), same syntax. */
    except: s.optional(s.array(s.string(2, 200, PRIMITIVE_SELECTOR), 0, 500)),
    /** Where the primitives may be (re)defined; absent: DEFAULT_PRIMITIVE_PATHS. The sources themselves always may. */
    allowedPaths: s.optional(globs),
    /** A primitive adjusted under a class of the component (`.panel .btn`): layout properties only by default. */
    nested: s.optional(s.enum(NESTED_MODES)),
  })),
  duplicates: s.optional(s.object({
    minLines: s.optional(s.number(2, 1000)),
    minTokens: s.optional(s.number(10, 10000)),
    /** Globs of the files compared; absent: every code, markup and style file. */
    paths: s.optional(globs),
    /** Globs left out of the comparison, added to the defaults (tests are always left out). */
    ignore: s.optional(globs),
    /** Severity of a block copied between style sheets or `<style>` blocks only: `warning` by default (see docs/REUSE.md). */
    styles: s.optional(severity),
  })),
  names: s.optional(s.object({
    /** Role families added to the defaults (`"toast": ["toast", "snackbar"]`); `null` removes a default family. */
    roles: s.optional(s.record(ROLE, s.nullable(s.array(s.string(1, 50, WORD), 1, 50)), 100)),
    /** Families whose generic shared component a new component must never redo (`strongSeverity`, error by default). */
    strong: s.optional(s.array(s.string(1, 50, ROLE), 0, 100)),
    strongSeverity: s.optional(severity),
  })),
  typography: s.optional(s.object({
    /** Language of the interface texts (`fr`, `fr-CA`); only the languages that require non-breaking spaces are checked. */
    locale: s.string(2, 35, LOCALE),
  })),
  severity: s.optional(s.union(severity, s.record(/^(?:native|styles|duplicates|names|typography)$/, severity, 5))),
});
export type ReuseSection = Infer<typeof reuseSchema>;

/** The `map` section of `.apv/config.json`: where `apv map` writes the code map, and what it leaves out. */
export const DEFAULT_MAP_FILE = '.apv/code-map.md';
export const DEFAULT_MAP_MAX_ENTRIES = 400;
export const mapSchema = s.object({
  file: s.optional(s.string(1, 4096, /\.md$/)),
  ignore: s.optional(globs),
  /** Entries listed in the whole map (the rest is counted per folder, never listed). */
  maxEntries: s.optional(s.number(20, 5000)),
  /** Size of the whole map in bytes; the shared components come first. */
  maxBytes: s.optional(s.number(4096, 1_000_000)),
});
export type MapSection = Infer<typeof mapSchema>;

export interface ReuseSettings {
  reference: string | null;
  shared: string[];
  sharedDeclared: boolean;
  generated: string[];
  ignore: string[];
  native: { elements: Record<string, string | null>; allowedPaths: string[] };
  styles: { sources: string[] | null; selectors: string[]; except: string[]; allowedPaths: string[]; nested: NestedMode };
  duplicates: { minLines: number; minTokens: number; paths: string[] | null; ignore: string[]; styles: ReuseSeverity };
  roles: Record<string, string[]>;
  /** Families of STRONG_FAMILIES (or `names.strong`), and the severity of a new component that redoes one of their generic shared components. */
  strong: string[];
  strongSeverity: ReuseSeverity;
  locale: string | null;
  severity: Record<ReuseRule, ReuseSeverity>;
}

/**
 * Role families of the name rule: two components whose last words fall in the same family do the same job
 * (`AdminToast` and `Toast`, `Snackbar` and `Toast`). A compound (`TabBar`) is matched joined (`tabbar`).
 */
export const DEFAULT_ROLE_FAMILIES: Readonly<Record<string, readonly string[]>> = {
  shell: ['shell', 'appshell', 'layout', 'frame', 'scaffold', 'chrome'],
  sidebar: ['sidebar', 'sidenav', 'sidemenu', 'navrail', 'rail'],
  topbar: ['topbar', 'navbar', 'appbar', 'topnav', 'masthead'],
  tabbar: ['tabbar', 'bottomnav', 'bottombar', 'tabnav', 'bottomtabs'],
  toast: ['toast', 'toaster', 'toasts', 'snackbar', 'notification', 'notifications', 'notifier', 'flash'],
  dialog: ['dialog', 'modal', 'popup', 'lightbox', 'alertdialog'],
  drawer: ['drawer', 'sheet', 'offcanvas', 'bottomsheet'],
  select: ['select', 'dropdown', 'combobox', 'picker', 'listbox', 'selector', 'autocomplete', 'multiselect'],
  datepicker: ['datepicker', 'calendar', 'datefield', 'dateinput'],
  menu: ['menu', 'contextmenu', 'dropdownmenu', 'menubar'],
  popover: ['popover', 'tooltip', 'hovercard'],
  button: ['button', 'btn'],
  icon: ['icon', 'icons', 'glyph'],
  input: ['input', 'textfield', 'textinput', 'textbox', 'textarea'],
  checkbox: ['checkbox', 'switch', 'toggle'],
  tabs: ['tabs', 'tablist', 'segmented', 'segmentedcontrol'],
  card: ['card', 'tile'],
  badge: ['badge', 'chip', 'pill', 'tag'],
  table: ['table', 'datatable', 'datagrid'],
  pagination: ['pagination', 'pager', 'paginator'],
  spinner: ['spinner', 'loader', 'throbber'],
  skeleton: ['skeleton', 'shimmer'],
  alert: ['alert', 'banner', 'callout', 'notice'],
  avatar: ['avatar'],
  breadcrumb: ['breadcrumb', 'breadcrumbs'],
  accordion: ['accordion', 'collapsible', 'disclosure'],
  empty: ['emptystate', 'empty', 'placeholder'],
};

/**
 * Families of the application's structure and of its design system: a new component that redoes the generic shared one
 * (its name is only its role: `Sidebar`, `Toast`, `Select`) without composing it is a copy of the interface, blocking by
 * default. The other resemblances of names stay warnings.
 */
export const STRONG_FAMILIES = ['shell', 'sidebar', 'tabbar', 'topbar', 'toast', 'select', 'dialog', 'datepicker', 'pagination', 'tabs', 'icon'] as const;

/** A relative path or glob inside the repository, `/` separated, without leading `./` nor trailing slash. */
export function relativeGlob(value: string, field: string): string {
  const clean = posix.normalize(value.trim().replace(/\\/g, '/')).replace(/\/+$/, '').replace(/^\.\//, '');
  invariant(value.trim() !== '' && !isAbsolute(clean) && !clean.startsWith('/') && clean !== '..' && !clean.startsWith('../') && clean !== '.', 'CONFIG',
    `${field} : chemin relatif dans le dépôt attendu (${value})`);
  try { globToRegExp(clean); } catch { invariant(false, 'CONFIG', `${field} : motif invalide (${value})`); }
  return clean;
}

/** Effective settings of a `reuse` section: defaults completed, paths checked. Throws a CONFIG error. */
export function reuseSettings(section: ReuseSection | undefined): ReuseSettings {
  const shared = (section?.shared ?? [...DEFAULT_SHARED]).map(g => relativeGlob(g, 'reuse.shared'));
  const roles: Record<string, string[]> = Object.fromEntries(Object.entries(DEFAULT_ROLE_FAMILIES).map(([k, v]) => [k, [...v]]));
  for (const [key, words] of Object.entries(section?.names?.roles ?? {})) {
    if (words === null) delete roles[key];
    else roles[key] = [...new Set(words)];
  }
  const value = section?.severity;
  const severity = Object.fromEntries(REUSE_RULES.map(rule => [rule, typeof value === 'string' ? value : value?.[rule] ?? DEFAULT_REUSE_SEVERITY[rule]])) as Record<ReuseRule, ReuseSeverity>;
  const elements = section?.native?.elements ?? Object.fromEntries(DEFAULT_NATIVE_ELEMENTS.map(e => [e, null]));
  for (const target of Object.values(elements)) if (target !== null) relativeGlob(target, 'reuse.native.elements');
  return {
    reference: section?.reference ?? null,
    shared,
    sharedDeclared: section?.shared !== undefined,
    generated: (section?.generated ?? []).map(g => relativeGlob(g, 'reuse.generated')),
    ignore: [...DEFAULT_REUSE_IGNORE, ...(section?.ignore ?? []).map(g => relativeGlob(g, 'reuse.ignore'))],
    native: { elements: { ...elements }, allowedPaths: (section?.native?.allowedPaths ?? [...DEFAULT_PRIMITIVE_PATHS]).map(g => relativeGlob(g, 'reuse.native.allowedPaths')) },
    styles: {
      sources: section?.styles?.sources ? section.styles.sources.map(g => relativeGlob(g, 'reuse.styles.sources')) : null,
      selectors: [...new Set(section?.styles?.selectors ?? [])],
      except: [...new Set(section?.styles?.except ?? [])],
      allowedPaths: (section?.styles?.allowedPaths ?? [...DEFAULT_PRIMITIVE_PATHS]).map(g => relativeGlob(g, 'reuse.styles.allowedPaths')),
      nested: section?.styles?.nested ?? 'layout',
    },
    duplicates: {
      minLines: section?.duplicates?.minLines ?? DEFAULT_DUPLICATES.minLines,
      minTokens: section?.duplicates?.minTokens ?? DEFAULT_DUPLICATES.minTokens,
      paths: section?.duplicates?.paths ? section.duplicates.paths.map(g => relativeGlob(g, 'reuse.duplicates.paths')) : null,
      ignore: (section?.duplicates?.ignore ?? []).map(g => relativeGlob(g, 'reuse.duplicates.ignore')),
      styles: section?.duplicates?.styles ?? 'warning',
    },
    roles,
    strong: [...new Set(section?.names?.strong ?? [...STRONG_FAMILIES])],
    strongSeverity: section?.names?.strongSeverity ?? 'error',
    locale: section?.typography?.locale ?? null,
    severity,
  };
}

export interface MapSettings { file: string; ignore: string[]; maxEntries: number; maxBytes: number }

export function mapSettings(section: MapSection | undefined): MapSettings {
  return {
    file: section?.file ? relativeGlob(section.file, 'map.file') : DEFAULT_MAP_FILE,
    ignore: [...DEFAULT_REUSE_IGNORE, ...(section?.ignore ?? []).map(g => relativeGlob(g, 'map.ignore'))],
    maxEntries: section?.maxEntries ?? DEFAULT_MAP_MAX_ENTRIES,
    maxBytes: section?.maxBytes ?? DEFAULT_MAP_MAX_BYTES,
  };
}

/** A matcher over repository paths for a list of globs (`{a,b}` accepted), compiled once. */
export function globMatcher(globs: readonly string[]): (path: string) => boolean {
  const res = globs.map(g => globToRegExp(g));
  return path => res.some(re => re.test(path));
}

/** Extension of a path, lower case, without the dot (`svelte` for `A.svelte`, `ts` for `x.svelte.ts`). */
export function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}
