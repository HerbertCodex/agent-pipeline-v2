import { execFileSync } from 'node:child_process';
import { posix } from 'node:path';
import { globToRegExp } from '../db/glob.js';
import { CODE_EXTENSIONS, parseName } from '../structure/names.js';
import { buildCodeMap, clashesFor, importsOf, withoutQuery, type CodeMap } from '../knowledge/code-map.js';
import { nonSourceExtensions } from '../knowledge/languages.js';
import { listMockups, listMockupsAt, sha256File } from '../design/registry.js';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfigAtCommit } from '../config/load.js';
import { collectChanges, isAdded, readAtBase, readWorktree, readWorktreeStatus, resolveBase, type ChangeBase, type Changes } from './changes.js';
import {
  COMPONENT_EXTENSIONS, DEFAULT_PRIMITIVE_PATHS, DEFAULT_STYLE_SOURCES, ELEMENT_FAMILIES, DEFAULT_REUSE_IGNORE, GENERATED_HEADER, GENERATED_PATHS, REUSE_RULES, frameworkExtensions, outputMatcher, STYLE_EXTENSIONS, UI_EXTENSIONS, extensionOf, globMatcher, mapSettings, reuseSettings,
  type MapSection, type ReuseRule, type ReuseSection, type ReuseSettings, type ReuseSeverity,
} from './config.js';
import { TokenTable, blankImports, findClones, occurs, tokenize, type Token } from './duplicates.js';
import { blocks, elementRule, findElements } from './markup.js';
import { componentName, describeClash, replacementFor } from './names.js';
import { Primitives, isLayoutOnly, primitivesOf, restyledPrimitives, styleRules } from './styles.js';
import { environment } from '../execution/process.js';
import { rangesOf } from './markup.js';
import { breakableValues, typographyPatterns } from './typography.js';

export interface ReuseFinding {
  rule: ReuseRule;
  severity: 'warning' | 'error';
  /** Added or modified by the change (always true without base). */
  isNew: boolean;
  /** `error` and new: makes the check fail. */
  blocking: boolean;
  path: string;
  line: number;
  endLine?: number;
  message: string;
  /** The other copy of a duplicated block, or the shared component a name doubles. */
  other?: { path: string; line: number; endLine?: number };
}

export interface RuleSummary { severity: ReuseSeverity; active: boolean; note: string | null; new: number; existing: number }

export interface ReuseReport {
  ok: boolean;
  base: ChangeBase;
  analyzedFiles: number;
  rules: Record<ReuseRule, RuleSummary>;
  findings: ReuseFinding[];
  primitives: { sources: string[]; count: number };
  /** Files a tool writes (by name or first lines), left out of every rule: their count and the first 20. */
  generated: { count: number; files: string[] };
  /**
   * Files left out: by `reuse.ignore`, or by a default exclusion for a file already there at the base. `changed`: every
   * one the change creates or modifies, never truncated; `existing`: the first 20 of the others; `count`: all.
   */
  excluded: { count: number; changed: string[]; why: Record<string, ExcludedReason>; existing: string[] };
}

export interface ReuseConfig {
  reuse?: ReuseSection | undefined;
  map?: MapSection | undefined;
  design?: { dir?: string | undefined } | undefined;
  /** The checks the configuration declares: compared with those of the base (a change never weakens what judges it). */
  gates?: readonly { id: string; command: readonly string[]; mandatory?: boolean | undefined }[] | undefined;
}

/** JSON with sorted keys: two configurations compare by content, whatever the order of their fields. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

/** The checks of the reuse itself: `apv reuse check` and `apv map --check`, whatever the form of the call. */
const judgesReuse = (command: readonly string[]): boolean => command.some((a, i) => (a === 'reuse' && command[i + 1] === 'check') || (a === 'map' && command.slice(i + 1).includes('--check')));

/**
 * What a change does to the configuration the reuse check watches, from `before` (its base) to `after`: the sections
 * `reuse`, `map` and `design.dir`, the checks that judge the reuse, and the mandatory checks. Each one is a decision
 * of the operator, merged in a pull request of configuration of its own: `apv reuse check` refuses it mixed with code,
 * and `apv stack plan` names it in a stack (to merge alone first). Empty when nothing watched changes.
 */
export function reuseConfigChanges(before: ReuseConfig, after: ReuseConfig): string[] {
  const out: string[] = [];
  const sections = (c: ReuseConfig): string => stable({ reuse: c.reuse ?? null, map: c.map ?? null, designDir: c.design?.dir ?? null });
  if (sections(after) !== sections(before)) {
    out.push('configuration de réutilisation modifiée par le changement (sections reuse, map ou design.dir) : le contrôle juge avec celle de la base ; c\'est une décision de l\'opérateur, à fusionner dans une PR de configuration à part.');
  }
  const candidateGates = after.gates ?? [];
  for (const gate of before.gates ?? []) {
    const now = candidateGates.find(g => g.id === gate.id);
    if (judgesReuse(gate.command) && (!now || stable(now) !== stable(gate))) {
      out.push(`contrôle « ${gate.id} » (${gate.command.join(' ')}) ${now ? 'modifié' : 'retiré'} par le changement : il juge la réutilisation ; décision de l'opérateur, à fusionner dans une PR de configuration à part.`);
    } else if (gate.mandatory && (!now || now.mandatory !== true)) {
      out.push(`contrôle obligatoire « ${gate.id} » ${now ? 'rendu facultatif' : 'retiré'} par le changement : décision de l'opérateur, à fusionner dans une PR de configuration à part.`);
    }
  }
  return out;
}

/** Folders of sources: a code or style file there is held to the strict coverage of the check. */
const SOURCE_ROOTS = /^(?:src|app|lib|pages|components|routes|server)\/|^(?:packages|apps)\/[^/]+\/(?:src|app|lib|pages|components|routes|server)\//;
const withoutExtensions = (path: string): string => path.replace(/(?:\.[A-Za-z0-9]{1,6}){1,3}$/, '');

export interface CheckOptions {
  /** `--base`: any commit-ish; else `reuse.reference`; else no base (everything counts as new). */
  base?: string;
  /** Precomputed changes (tests, onboarding). */
  changes?: Changes;
}

const SCRIPT_EXTENSIONS = new Set(['ts', 'js', 'mjs', 'cjs', 'mts', 'cts']);
const LOCALE_FILE = /(?:^|\/)(?:locales?|i18n|messages|lang|translations)\//;

/** Content of a file at a commit, or null (absent, unreadable, larger than 4 MB); Git runs with the environment of the checks only. */
function gitShow(repo: string, spec: string): string | null {
  try {
    return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '--no-pager', 'show', '--no-textconv', '--end-of-options', spec], {
      cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 4 * 1024 * 1024, timeout: 30_000,
      env: { ...environment(['PATH', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TEMP', 'TMP', 'LANG']), GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' },
    });
  } catch { return null; }
}


const order = (a: ReuseFinding, b: ReuseFinding): number =>
  REUSE_RULES.indexOf(a.rule) - REUSE_RULES.indexOf(b.rule) || Number(b.isNew) - Number(a.isNew) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || a.line - b.line;

/**
 * `apv reuse check` (docs/REUSE.md): what a change adds against the existing components of the project. Every rule
 * reports what the change adds (new) and what was already there (existing, never blocking), so that a project with a
 * history adopts the check without first cleaning everything.
 */
export async function checkReuse(repo: string, config: ReuseConfig, options: CheckOptions = {}): Promise<ReuseReport> {
  const changes = options.changes ?? await collectChanges(repo, resolveBase(repo, options.base, reuseSettings(config.reuse).reference));
  // The configuration that judges the change is the one of its base: a change never loosens its own check
  // (`reuse.ignore`, `severity: "off"`, thresholds, the checks themselves). Its own changes are reported below.
  let judged: ReuseConfig = config;
  const configFindings: { path: string; message: string }[] = [];
  if (changes.base.mergeBase) {
    const atBase = loadConfigAtCommit(repo, changes.base.mergeBase);
    if (atBase.file) {
      judged = atBase.config;
      const file = atBase.file.slice(atBase.file.indexOf(':') + 1);
      for (const message of reuseConfigChanges(atBase.config, config)) configFindings.push({ path: file, message });
    }
  }
  const base = reuseSettings(judged.reuse);
  const mapConfig = mapSettings(judged.map);
  const designDir = judged.design?.dir?.replace(/\/+$/, '');
  const cache = new Map<string, string | null>();
  const read = (path: string): string | null => {
    if (!cache.has(path)) cache.set(path, readWorktree(repo, path));
    return cache.get(path)!;
  };
  // Interface files: the known extensions and those the framework declares (`.svx` in svelte.config.js).
  const settings: Ctx = { ...base, ui: new Set([...UI_EXTENSIONS, ...frameworkExtensions(read, changes.files)]) };
  const relevant = (ext: string): boolean => CODE_EXTENSIONS.has(ext) || settings.ui.has(ext) || STYLE_EXTENSIONS.has(ext);

  // FAIL CLOSED (docs/REUSE.md, section 2.8). A file the change creates, modifies or moves, tracked by Git, whose
  // extension is code, interface or style, is analysed. It leaves the check only through what the configuration declares
  // (`reuse.ignore`, `reuse.generated`, a validated mockup of the ledger) or because it was already excluded at the base
  // under the same path. The default exclusions (dependencies, tool folders, build outputs, docs) apply to the files that
  // existed at the base; a file the change puts there is analysed AND reported, blocking. An unreadable one is reported.
  const touched = (path: string): boolean => !changes.all && (changes.created.has(path) || changes.renamed.has(path) || (changes.added.get(path)?.size ?? 0) > 0);
  const atBase = (path: string): boolean => !changes.all && !changes.created.has(path) && !changes.renamed.has(path);
  const declaredIgnore = globMatcher(settings.declaredIgnore);
  const byDefault = globMatcher([...DEFAULT_REUSE_IGNORE, ...(designDir ? [`${designDir}/**`] : [])]);
  // Packages as the base knows them: a package.json the change adds never makes a folder of build outputs.
  const output = outputMatcher(changes.files.filter(f => !f.endsWith('package.json') || atBase(f) || changes.all));
  const generatedName = globMatcher([...GENERATED_PATHS]);
  const declaredGenerated = globMatcher(settings.generated);
  // Validated mockups as the ledger of the BASE registers them, checked against the files on disk.
  let mockups = new Set<string>();
  // Fingerprints the base registers, by file: a mockup the change only moves (`apv design organize`) keeps its exclusion
  // when its content is exactly the registered one.
  let registered = new Map<string, string>();
  try {
    const listed = changes.base.mergeBase ? await listMockupsAt(repo, changes.base.mergeBase) : listMockups(repo);
    mockups = new Set(listed.filter(m => m.state === 'ok' && m.file).map(m => m.file!));
    registered = new Map(listed.filter(m => m.file && m.sha256).map(m => [m.file!, m.sha256!]));
  } catch { /* no ledger: none */ }
  const movedMockup = (path: string): boolean => {
    const from = changes.renamed.get(path);
    const expected = from === undefined ? undefined : registered.get(from);
    if (!expected) return false;
    try { return lstatSync(join(repo, path)).isFile() && sha256File(join(repo, path)) === expected; } catch { return false; }
  };
  // Strict coverage: a component anywhere; a code, interface or style file in a source folder, or imported by the
  // application. A script of the CI or a documentation page is analysed where it is, never forced out of an exclusion.
  // The import graph of the application, from its sources and components, followed from file to file (5 steps): ES
  // imports, `import.meta.glob` and `globEager`, `require.context`, CSS `@import` and `url()`.
  let imported: { exact: Set<string>; suffixes: string[]; files: Set<string> } | null = null;
  const present = new Set(changes.files);
  const graph = (): NonNullable<typeof imported> => {
    if (imported) return imported;
    const found = { exact: new Set<string>(), suffixes: [] as string[], files: new Set<string>() };
    const reads = (file: string): void => {
      const ext = extensionOf(file);
      const text = read(file) ?? '';
      const at = (spec: string): string => posix.normalize(spec.startsWith('/') ? spec.slice(1) : posix.join(posix.dirname(file), spec));
      if (STYLE_EXTENSIONS.has(ext) || settings.ui.has(ext)) {
        for (const m of text.matchAll(/@import\s+(?:url\(\s*)?['"]?([^'")\s;]+)|\burl\(\s*['"]?([^'")\s]+)/g)) {
          const spec = withoutQuery((m[1] ?? m[2])!);
          if (/^(?:[a-z]+:|#|data:)/i.test(spec)) continue;
          for (const candidate of [at(spec), posix.normalize(spec.replace(/^\//, ''))]) if (present.has(candidate)) found.files.add(candidate);
        }
      }
      if (!(settings.ui.has(ext) || SCRIPT_EXTENSIONS.has(ext) || ext === 'tsx' || ext === 'jsx')) return;
      for (const ref of importsOf(text, ext)) {
        if (ref.spec.startsWith('.')) found.exact.add(withoutExtensions(posix.normalize(posix.join(posix.dirname(file), ref.spec))));
        else if (/^(?:\$|~|#|@\/)/.test(ref.spec) && ref.spec.includes('/')) found.suffixes.push(withoutExtensions(ref.spec.slice(ref.spec.indexOf('/') + 1)));
      }
      // import.meta.glob('./x/*.ts'), globEager, arrays of patterns; require.context('./dir', true, /\.ts$/).
      for (const m of text.matchAll(/import\.meta\.glob(?:Eager)?\s*(?:<[^>]{0,200}>)?\s*\(\s*(\[[^\]]{0,2000}\]|['"`][^'"`]{1,500}['"`])/g)) {
        for (const q of m[1]!.matchAll(/['"`]([^'"`]{1,500})['"`]/g)) {
          const pattern = q[1]!;
          if (pattern.startsWith('!') || !(pattern.startsWith('.') || pattern.startsWith('/'))) continue;
          const re = globToRegExp(at(pattern));
          for (const candidate of changes.files) if (re.test(candidate)) found.files.add(candidate);
        }
      }
      for (const m of text.matchAll(/require\.context\(\s*['"`]([^'"`]{1,500})['"`]\s*(?:,\s*(true|false))?\s*(?:,\s*\/((?:[^/\\\n]|\\.){1,200})\/[a-z]*)?/g)) {
        const dir = at(m[1]!); const deep = m[2] !== 'false';
        let re: RegExp | null = null;
        try { re = m[3] ? new RegExp(m[3]) : null; } catch { re = null; }
        for (const candidate of changes.files) {
          if (!candidate.startsWith(`${dir}/`)) continue;
          const rest = candidate.slice(dir.length + 1);
          if (!deep && rest.includes('/')) continue;
          if (!re || re.test(`./${rest}`)) found.files.add(candidate);
        }
      }
    };
    const seen = new Set<string>();
    let wave = changes.files.filter(f => SOURCE_ROOTS.test(f) || COMPONENT_EXTENSIONS.has(extensionOf(f)));
    imported = found;
    for (let step = 0; step < 5 && wave.length; step++) {
      for (const file of wave) { seen.add(file); reads(file); }
      wave = changes.files.filter(f => !seen.has(f) && relevant(extensionOf(f)) && reached(f));
    }
    return found;
  };
  const reached = (path: string): boolean => {
    const g = imported!;
    if (g.files.has(path)) return true;
    const key = withoutExtensions(path);
    const dir = key.endsWith('/index') ? key.slice(0, -'/index'.length) : null;
    return g.exact.has(key) || (dir !== null && g.exact.has(dir)) || g.suffixes.some(x => key === x || key.endsWith(`/${x}`));
  };
  const importedByApp = (path: string): boolean => { graph(); return reached(path); };
  const strict = (path: string): boolean => {
    const ext = extensionOf(path);
    if (COMPONENT_EXTENSIONS.has(ext) || (settings.ui.has(ext) && !UI_EXTENSIONS.has(ext))) return true;
    // Code and styles in a build output or a vendored folder: always, whatever imports them.
    if (output(path) && (CODE_EXTENSIONS.has(ext) || STYLE_EXTENSIONS.has(ext))) return true;
    return relevant(ext) && (SOURCE_ROOTS.test(path) || importedByApp(path));
  };
  const generated: string[] = [];
  const excludedChanged: string[] = [];
  const excludedWhy: Record<string, ExcludedReason> = {};
  const excludedExisting: string[] = [];
  const coverage: { path: string; message: string; severity?: 'warning' }[] = [];
  const header = (text: string | null): boolean => GENERATED_HEADER.test((text ?? '').slice(0, 600));
  const files = changes.files.filter(path => {
    const ext = extensionOf(path);
    const counts = relevant(ext);
    const changed = touched(path);
    const exclude = (why: ExcludedReason): false => {
      if (counts) {
        (changed ? excludedChanged : excludedExisting).push(path);
        if (changed) excludedWhy[path] = why;
      }
      return false;
    };
    if (declaredIgnore(path)) return exclude('declared');
    if (byDefault(path) || output(path)) {
      if (!counts || !changed) return exclude('base');
      if (mockups.has(path) || movedMockup(path)) return exclude('mockup');
      const held = strict(path);
      if (!held) return exclude('not-strict');
      // Already excluded at the base under the same path: accepted, except code and styles of an output folder.
      if (atBase(path) && !output(path)) return exclude('base');
      coverage.push({ path, message: `fichier créé ou déplacé par le changement dans un dossier exclu par défaut (dépendances, outils, sorties de build, documentation) : il est analysé ; le déclarer dans reuse.ignore de .apv/config.json, avec l'accord de l'opérateur, ou le déplacer.` });
    }
    if (!counts) return true;
    if (changed) {
      const status = readWorktreeStatus(repo, path);
      if (status.text === null) {
        if (!strict(path)) return exclude('not-strict');
        coverage.push({ path, message: `fichier du changement illisible comme texte (${status.reason}) alors que son extension est .${ext} : le contrôle ne peut pas l'analyser ; le ramener à du texte UTF-8 de moins de 2 Mo, ou le déclarer dans reuse.ignore avec l'accord de l'opérateur.` });
        return false;
      }
    }
    if (settings.ui.has(ext)) return true;
    if (declaredGenerated(path)) { generated.push(path); return false; }
    const byName = generatedName(path);
    if (!byName && !header(read(path))) return true;
    let trusted = changes.all || !changed;
    if (!trusted) {
      const before = readAtBase(repo, changes, path, gitShow);
      trusted = before !== null && (byName ? generatedName(changes.renamed.get(path) ?? path) : header(before));
    }
    if (trusted || !strict(path)) { generated.push(path); return false; }
    coverage.push({ path, message: `${byName ? 'nommé comme un fichier généré' : 'mention « fichier généré » en tête'}, mais ${byName ? 'créé par le changement (absent à la base)' : 'ajoutée par le changement (absente à la base)'} : un fichier ne sort pas du contrôle par son nom ni par un commentaire, il reste analysé. S'il est vraiment écrit par un outil, déclarez-le dans reuse.generated de .apv/config.json (motif de chemin), avec l'accord de l'opérateur.` });
    return true;
  });
  // A file of the change imports a file of an extension the check does not read: said, never silently skipped.
  for (const path of files.filter(touched)) {
    const ext = extensionOf(path);
    if (!(settings.ui.has(ext) || SCRIPT_EXTENSIONS.has(ext) || ext === 'tsx' || ext === 'jsx')) continue;
    for (const ref of importsOf(read(path) ?? '', ext)) {
      if (!ref.spec.startsWith('.')) continue;
      const target = posix.normalize(posix.join(posix.dirname(path), ref.spec));
      const targetExt = extensionOf(target);
      if (!present.has(target) || relevant(targetExt) || nonSourceExtensions.has(targetExt) || targetExt === 'json') continue;
      coverage.push({ path, severity: 'warning', message: `importe ${target}, d'extension .${targetExt} que le contrôle ne lit pas : déclarer l'extension au framework (svelte.config.js, extensions) pour qu'il soit analysé.` });
    }
  }
  const isTest = (path: string): boolean => parseName(path)?.test ?? /(?:^|\/)(?:tests?|__tests__|e2e|fixtures)\//.test(path);
  let map: CodeMap | null = null;
  const codeMap = async (): Promise<CodeMap> => (map ??= await buildCodeMap(repo, settings, mapConfig, { read }));

  const findings: ReuseFinding[] = [];
  const summary = Object.fromEntries(REUSE_RULES.map(rule => [rule, { severity: settings.severity[rule], active: settings.severity[rule] !== 'off', note: null, new: 0, existing: 0 }])) as Record<ReuseRule, RuleSummary>;
  const add: Add = (finding, override) => {
    const severity = (override ?? settings.severity[finding.rule]) as 'warning' | 'error';
    findings.push({ ...finding, severity, blocking: severity === 'error' && finding.isNew });
  };

  for (const item of coverage) add({ rule: 'coverage', isNew: true, path: item.path, line: 1, message: item.message }, item.severity);
  // Links and submodules the change adds: their content is never read here.
  for (const { path, kind } of changes.special) {
    if (declaredIgnore(path)) continue;
    add({ rule: 'coverage', isNew: true, path, line: 1, message: `${kind} ajouté par le changement : son contenu n'est pas analysé par le contrôle ; le retirer, ou le déclarer dans reuse.ignore (configuration de la base, décision de l'opérateur).` }, 'error');
  }
  // A change of the configuration mixed with code blocks; a change of configuration alone (a PR of configuration) is said.
  // Any code, interface or style file of the change, analysed or left out.
  const codeTouched = changes.files.some(f => touched(f) && relevant(extensionOf(f)));
  for (const item of configFindings) add({ rule: 'coverage', isNew: true, path: item.path, line: 1, message: item.message }, codeTouched ? 'error' : 'warning');
  if (summary.native.active) await nativeRule(settings, files, read, isTest, changes, codeMap, add);
  const primitives = summary.styles.active ? stylesRule(settings, files, read, isTest, changes, add, summary.styles) : { sources: [], count: 0 };
  if (summary.duplicates.active) duplicatesRule(repo, settings, files, read, isTest, changes, add);
  if (summary.names.active) {
    const current = await codeMap();
    const analyzed = new Set(files);
    for (const component of current.components) {
      if (!changes.all && !changes.created.has(component.path)) continue;
      if (!analyzed.has(component.path)) continue;
      const clashes = changes.all ? component.clashes : clashesFor(current, component.path, settings.roles, true);
      if (!clashes.length) continue;
      // Strong: it redoes a generic shared component of the structure or of the design system (`AdminToast` next to
      // `ToastRegion`, `AdminShell` next to `Sidebar`) without composing it (composition is never a clash).
      // Same family exactly (a toast next to the toast, a dialog next to the dialog); a layout next to the side bar, or a
      // part named after it (`SidebarSection`), stays a warning.
      const strong = clashes.filter(c => { const shared = componentName(c.with, settings.roles); return shared.generic && shared.family !== null && c.family === shared.family && settings.strong.includes(shared.family); });
      const severity = strong.length && settings.strongSeverity !== 'off' ? settings.strongSeverity : undefined;
      const listed = strong.length ? strong : clashes;
      add({ rule: 'names', isNew: true, path: component.path, line: 1, other: { path: listed[0]!.with, line: 1 },
        message: strong.length
          ? `refait ${listed.map(c => `${c.with} (rôle ${componentName(c.with, settings.roles).family})`).join(', ')}, ${listed.length > 1 ? 'composants partagés génériques' : 'composant partagé générique'} : l'utiliser, ou le composer (l'importer et l'envelopper), ou l'étendre (paramètre, variante) ; jamais une copie propre à une fonctionnalité.`
          : `${clashes.map(describeClash).join(' ; ')}, ${clashes.length > 1 ? 'composants partagés' : 'composant partagé'} : le réutiliser ou l'étendre (paramètre, variante), sinon justifier ce nouveau composant dans le rapport.` }, severity);
    }
  }
  if (summary.typography.active) {
    const patterns = typographyPatterns(settings.locale);
    if (!patterns) {
      summary.typography.active = false;
      summary.typography.note = settings.locale
        ? `la langue « ${settings.locale} » n'exige pas d'espace insécable dans ces valeurs : règle inactive`
        : 'langue des textes non déclarée (reuse.typography.locale) : règle inactive';
    } else {
      for (const path of files) {
        const ext = extensionOf(path);
        const markup = settings.ui.has(ext);
        if (isTest(path) || !(markup || SCRIPT_EXTENSIONS.has(ext) || (ext === 'json' && LOCALE_FILE.test(path)))) continue;
        const whole = changes.all || changes.created.has(path);
        const lines = whole ? undefined : changes.added.get(path);
        if (!whole && !lines?.size) continue;
        const text = read(path);
        if (text === null) continue;
        for (const hit of breakableValues(text, ext, patterns, markup, lines)) {
          add({ rule: 'typography', isNew: true, path, line: hit.line,
            message: `${hit.values.join(', ')} : espace insécable attendue (U+00A0, ou fine U+202F ; &nbsp; ou &#8239; dans le balisage, \\u00a0 ou \\u202f dans une chaîne), sinon la valeur se coupe en fin de ligne.` });
        }
      }
    }
  }
  for (const finding of findings) summary[finding.rule][finding.isNew ? 'new' : 'existing']++;
  findings.sort(order);
  return { ok: !findings.some(f => f.blocking), base: changes.base, analyzedFiles: files.length, rules: summary, findings, primitives,
    generated: { count: generated.length, files: generated.slice(0, 20) },
    excluded: { count: excludedChanged.length + excludedExisting.length, changed: excludedChanged, why: excludedWhy, existing: excludedExisting.slice(0, 20) } };
}

/**
 * Why a file of the change is left out: declared in `reuse.ignore`, already excluded at the base under the same path, a
 * validated mockup of the base ledger, or neither a component nor a source nor imported by the application.
 */
export type ExcludedReason = 'declared' | 'base' | 'mockup' | 'not-strict';

/** The settings of one check, with the interface extensions of the project. */
type Ctx = ReuseSettings & { ui: Set<string> };
type Add = (finding: Omit<ReuseFinding, 'severity' | 'blocking'>, severity?: 'warning' | 'error') => void;
type Read = (path: string) => string | null;

async function nativeRule(settings: Ctx, files: string[], read: Read, isTest: (p: string) => boolean, changes: Changes, codeMap: () => Promise<CodeMap>, add: Add): Promise<void> {
  const rules = Object.keys(settings.native.elements).sort().map(elementRule);
  const allowed = globMatcher(settings.native.allowedPaths);
  const preferred = globMatcher([...DEFAULT_PRIMITIVE_PATHS, ...settings.native.allowedPaths]);
  let shared: string[] | null = null;
  for (const path of files) {
    if (!settings.ui.has(extensionOf(path)) || allowed(path) || isTest(path)) continue;
    const text = read(path);
    if (text === null) continue;
    for (const hit of findElements(text, rules, extensionOf(path))) {
      let target = settings.native.elements[hit.selector] ?? null;
      if (target === null) {
        shared ??= (await codeMap()).components.filter(c => c.shared).map(c => c.path);
        const family = ELEMENT_FAMILIES[elementRule(hit.selector).tag];
        target = family ? replacementFor(shared, family, settings.roles, preferred) : null;
      }
      // The shared component that wraps the element is its replacement: never reported against itself.
      if (target === path) continue;
      const tag = hit.selector.replace(/^([a-z0-9-]+)(.*)$/, '<$1$2>');
      add({ rule: 'native', isNew: isAdded(changes, path, hit.line), path, line: hit.line,
        message: target
          ? `${tag} natif réservé aux composants partagés : utiliser ${target}.`
          : `${tag} natif réservé aux composants partagés (${settings.native.allowedPaths.join(', ')}) : aucun composant partagé ne le remplace encore ; en créer un là, paramétrable, et le déclarer dans reuse.native.elements.` });
    }
  }
}

function stylesRule(settings: Ctx, files: string[], read: Read, isTest: (p: string) => boolean, changes: Changes, add: Add, summary: RuleSummary): { sources: string[]; count: number } {
  const present = new Set(files);
  const declared = settings.styles.sources
    ? files.filter(globMatcher(settings.styles.sources))
    : DEFAULT_STYLE_SOURCES.filter(path => present.has(path));
  // The sheets a global sheet imports (`@import './styles/buttons.css'`) are global too.
  const sources: string[] = [];
  const queue = [...declared];
  while (queue.length && sources.length < 50) {
    const path = queue.shift()!;
    if (sources.includes(path)) continue;
    sources.push(path);
    for (const m of (read(path) ?? '').matchAll(/@import\s+(?:url\(\s*)?['"]([^'"]+)['"]/g)) {
      const target = m[1]!;
      if (!target.startsWith('.')) continue;
      const resolved = posix.normalize(posix.join(posix.dirname(path), target));
      if (present.has(resolved)) queue.push(resolved);
    }
  }
  const classes = sources.flatMap(path => primitivesOf(read(path) ?? ''));
  const primitives = new Primitives(classes, settings.styles.selectors, settings.styles.except);
  if (!primitives.size) {
    summary.active = false;
    summary.note = sources.length ? `aucune classe primitive dans ${sources.join(', ')} : règle inactive` : 'aucune feuille globale trouvée (reuse.styles.sources) : règle inactive';
    return { sources, count: 0 };
  }
  const allowed = globMatcher([...settings.styles.allowedPaths, ...sources]);
  const sourceList = sources.length ? sources.join(', ') : 'reuse.styles.selectors';
  for (const path of files) {
    const ext = extensionOf(path);
    const markup = settings.ui.has(ext);
    if (allowed(path) || isTest(path) || !(markup || STYLE_EXTENSIONS.has(ext))) continue;
    const text = read(path);
    if (text === null) continue;
    const rules = markup ? blocks(text, 'style').flatMap(b => styleRules(b.content, b.line)) : styleRules(text);
    for (const hit of restyledPrimitives(rules, primitives)) {
      if (hit.nested && (settings.styles.nested === 'allow' || (settings.styles.nested === 'layout' && isLayoutOnly(hit.properties)))) continue;
      add({ rule: 'styles', isNew: isAdded(changes, path, hit.line), path, line: hit.line,
        message: hit.nested
          ? `« ${hit.selector} » ajuste la primitive .${hit.primitive} (${sourceList}) sous une classe du composant avec ${hit.properties.filter(p => settings.styles.nested === 'refuse' || !isLayoutOnly([p])).join(', ') || 'des propriétés'}${settings.styles.nested === 'layout' ? ' (seule la mise en page est permise : marges, largeur, alignement, ordre, position)' : ''} : ajouter une variante à la primitive ou au composant partagé.`
          : `« ${hit.selector} » redéfinit la primitive .${hit.primitive} (${sourceList}) dans un style local : utiliser la classe telle quelle, ou ajouter une variante à la primitive ou au composant partagé.` });
    }
  }
  return { sources, count: primitives.size };
}

function duplicatesRule(repo: string, settings: Ctx, files: string[], read: Read, isTest: (p: string) => boolean, changes: Changes, add: Add): void {
  const shared = globMatcher(settings.shared);
  const primitive = globMatcher([...DEFAULT_PRIMITIVE_PATHS, ...settings.native.allowedPaths]);
  /** A generic shared component: a component of the shared folders whose name is only its role, or of the primitives. */
  const genericShared = (path: string): boolean => COMPONENT_EXTENSIONS.has(extensionOf(path)) && shared(path) && (primitive(path) || componentName(path, settings.roles).generic);
  // Lines of style: whole style sheets, and the `<style>` blocks of interface files.
  const styleLines = new Map<string, [number, number][] | 'all'>();
  const inStyle = (path: string, from: number, to: number): boolean => {
    let ranges = styleLines.get(path);
    if (!ranges) {
      const ext = extensionOf(path);
      ranges = STYLE_EXTENSIONS.has(ext) ? 'all' : settings.ui.has(ext) ? rangesOf(read(path) ?? '', 'style') : [];
      styleLines.set(path, ranges);
    }
    return ranges === 'all' || ranges.some(([a, b]) => from >= a && to <= b);
  };
  const included = settings.duplicates.paths ? globMatcher(settings.duplicates.paths) : (path: string) => {
    const ext = extensionOf(path);
    return CODE_EXTENSIONS.has(ext) || STYLE_EXTENSIONS.has(ext) || COMPONENT_EXTENSIONS.has(ext) || settings.ui.has(ext);
  };
  const excluded = globMatcher(settings.duplicates.ignore);
  const table = new TokenTable();
  const tokens = new Map<string, Token[]>();
  for (const path of files) {
    if (!included(path) || excluded(path) || isTest(path)) continue;
    const text = read(path);
    if (text !== null) tokens.set(path, tokenize(blankImports(text, extensionOf(path)), extensionOf(path), table));
  }
  const options = { minTokens: settings.duplicates.minTokens, minLines: settings.duplicates.minLines };
  const baseIds = new Map<string, Int32Array | null>();
  const atBase = (path: string): Int32Array | null => {
    if (!baseIds.has(path)) {
      const text = readAtBase(repo, changes, path, gitShow);
      baseIds.set(path, text === null ? null : Int32Array.from(tokenize(blankImports(text, extensionOf(path)), extensionOf(path), table), t => t.id));
    }
    return baseIds.get(path)!;
  };
  const touched = (path: string, from: number, to: number): boolean => {
    if (changes.all || changes.created.has(path)) return true;
    const lines = changes.added.get(path);
    if (!lines) return false;
    for (let l = from; l <= to; l++) if (lines.has(l)) return true;
    return false;
  };
  for (const found of findClones(tokens, options)) {
    // The finding sits on the copy the change adds or modifies, never on the original it copies.
    const swap = !touched(found.a.path, found.a.startLine, found.a.endLine) && touched(found.b.path, found.b.startLine, found.b.endLine);
    const clone = swap ? { ...found, a: found.b, b: found.a } : found;
    let isNew = touched(clone.a.path, clone.a.startLine, clone.a.endLine) || touched(clone.b.path, clone.b.startLine, clone.b.endLine);
    // Touched but already duplicated at the base (same tokens in both files there): the copy is not the change's.
    if (isNew && !changes.all) {
      const needle = Int32Array.from(tokens.get(clone.a.path)!.slice(clone.a.start, clone.a.end + 1), t => t.id);
      const a = atBase(clone.a.path); const b = atBase(clone.b.path);
      if (a && b && (clone.a.path === clone.b.path ? occurs(a, needle, true) : occurs(a, needle) && occurs(b, needle))) isNew = false;
    }
    // Style declarations only: their own severity (`duplicates.styles`, warning by default).
    const styles = inStyle(clone.a.path, clone.a.startLine, clone.a.endLine) && inStyle(clone.b.path, clone.b.startLine, clone.b.endLine);
    // Styles copied from a generic shared component (its look redone elsewhere) are a copy of the interface: the severity
    // of code copies. Only styles copied between components of features take `duplicates.styles`.
    const fromShared = genericShared(clone.a.path) || genericShared(clone.b.path);
    const severity = styles && !fromShared ? settings.duplicates.styles : settings.severity.duplicates;
    if (severity === 'off') continue;
    add({ rule: 'duplicates', isNew, path: clone.a.path, line: clone.a.startLine, endLine: clone.a.endLine,
      other: { path: clone.b.path, line: clone.b.startLine, endLine: clone.b.endLine },
      message: `${styles ? `styles identiques à${fromShared ? ' ceux du composant partagé' : ''}` : 'bloc identique à'} ${clone.b.path}:${clone.b.startLine}-${clone.b.endLine} (${clone.lines} lignes, ${clone.tokens} jetons) : ${styles ? 'les mettre dans une primitive ou une variante partagée' : 'le factoriser dans un module ou un composant partagé et paramétrable'}, puis retirer la copie.` }, severity);
  }
}
