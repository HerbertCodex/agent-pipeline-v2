import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { Git } from '../execution/git.js';
import { loadConfigAtCommit, type ApvConfig } from '../config/load.js';
import { buildCodeMap } from '../knowledge/code-map.js';
import { GENERATED_PATHS, globMatcher, mapSettings, reuseSettings } from '../reuse/config.js';
import { collectChanges, readWorktree, resolveBase, type ChangeBase, type Changes } from '../reuse/changes.js';
import { designDir } from '../design/config.js';
import { environment } from '../execution/process.js';
import { analyzeStructure, type StructureReport } from './analyze.js';
import { archItems, brokenLinks, duplicateMarkers, roleOf, writtenRoles, type ArchItem, type MapInputs } from './archmap.js';
import { ignoreTest, structureSettings, type Severity, type StructureSettings } from './config.js';
import { COMPANION_INFIXES, entryKey, parseName } from './names.js';
import { detectProfile, profileById, type StackProfile } from './profiles.js';
import { usageFromMap, type UsageGraph } from './split.js';

/** A finding of the comparison with the base (`--base`), or about the architecture map. */
export interface ChangeFinding {
  code: 'flat-growth' | 'architecture-map' | 'configuration' | 'coverage';
  severity: Severity;
  /** Added by the change (never true without base). */
  isNew: boolean;
  /** `error` and new: the check fails. */
  blocking: boolean;
  path: string;
  message: string;
}

export interface StructureCheckReport extends StructureReport {
  base: ChangeBase;
  changes: ChangeFinding[];
  architectureMap: { path: string; exists: boolean; profile: string; items: number; described: number };
  /** The usage graph could not be built (the split then reads the names only). */
  usageError: string | null;
}

export type StructureConfig = { structure?: ApvConfig['structure'] | undefined; reuse?: ApvConfig['reuse'] | undefined; map?: ApvConfig['map'] | undefined; design?: ApvConfig['design'] | undefined };

const TEST_INFIX = /^(?:test|tests|spec|specs|e2e|bench|fixture|fixtures|mock|mocks|stories|story)$/;
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const inside = (path: string, dir: string): boolean => dir === '.' || path === dir || path.startsWith(`${dir}/`);

/**
 * Modules per folder, as `flat-folder` counts them: one per module key (`x.ts`, `x.svelte.ts` and `x.test.ts` are one;
 * `x.extra.ts` is another), tests alone apart. The default exclusions never apply to `always` (what the change creates).
 */
export function folderEntries(paths: readonly string[], settings: Pick<StructureSettings, 'ignore' | 'roots'>, always: ReadonlySet<string> = new Set()): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  const ignored = ignoreTest(settings, paths, always);
  for (const p of paths) {
    if (ignored(p)) continue;
    const f = parseName(p);
    if (!f || f.test || !settings.roots.some(r => inside(p, r))) continue;
    const keys = out.get(f.dir) ?? new Map<string, string>();
    const key = entryKey(f);
    const known = keys.get(key);
    // The main file of a module: fewest name parts (`x.ts` before `x.svelte.ts`), then the name.
    if (!known || f.infixes.length < (parseName(known)?.infixes.length ?? 0) || (f.infixes.length === (parseName(known)?.infixes.length ?? 0) && p < known)) keys.set(key, p);
    out.set(f.dir, keys);
  }
  return out;
}

/** The usage graph of the working tree, from the code map (who imports whom, what modules export). */
export async function usageGraph(repo: string, config: StructureConfig): Promise<UsageGraph> {
  const map = await buildCodeMap(repo, reuseSettings(config.reuse), mapSettings(config.map));
  return usageFromMap(map);
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

/** The stack profile: `structure.profile`, else detected. */
export function profileOf(repo: string, settings: StructureSettings, files: readonly string[]): StackProfile {
  return settings.profile ? profileById(settings.profile) : detectProfile(repo, files);
}

function dependencies(repo: string): string[] {
  try {
    const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as Record<string, unknown>;
    return Object.keys({ ...(pkg['dependencies'] as object ?? {}), ...(pkg['devDependencies'] as object ?? {}) }).sort(byText);
  } catch { return []; }
}

/** Everything the architecture map is written from. */
export function mapInputs(repo: string, config: StructureConfig, settings: StructureSettings, files: readonly string[], report: StructureReport): MapInputs {
  // The map is part of the tree it describes (its folder included), even before it is written.
  files = [...new Set([...files, settings.architectureMap])].sort(byText);
  const profile = profileOf(repo, settings, files);
  const read = (path: string): string | null => readWorktree(repo, path);
  const flat = report.findings.filter(f => f.code === 'flat-folder');
  return {
    mapPath: settings.architectureMap,
    profile,
    items: archItems(files, profile, settings, read),
    files,
    designDir: existsSync(join(repo, designDir(config.design))) ? designDir(config.design) : null,
    codeMapPath: mapSettings(config.map).file,
    maxFlatFiles: settings.maxFlatFiles,
    crowded: flat.map(f => ({ folder: f.folder, code: f.files.length, groups: (f.groups ?? []).map(g => g.dir) })),
    dependencies: dependencies(repo),
    read,
  };
}

export interface CheckOptions {
  /** `--base`: any commit-ish. Without it, nothing is compared: the analysis and the map are reported, never blocking. */
  base?: string;
  paths?: readonly string[];
  /** Precomputed changes and usage (tests). */
  changes?: Changes;
  usage?: UsageGraph | null;
  /** Tracked files, for the analysis without base. */
  tracked?: readonly string[];
}

/**
 * `apv structure check` (docs/STRUCTURE.md). Without base: the analysis of the tracked files, and the architecture map
 * signalled without blocking. With `--base`: the configuration of the base judges the change (it never loosens its own
 * check); what the change adds is compared with the base: a code file added to a flat folder (or that makes one), a
 * folder, main route or entry point without role in the architecture map, a link of the map the change breaks. What
 * existed at the base is signalled without blocking; moves that empty a flat folder into its subfolders are accepted.
 */
export async function checkStructure(repo: string, config: StructureConfig, options: CheckOptions = {}): Promise<StructureCheckReport> {
  const git = new Git();
  const changes = options.base !== undefined ? options.changes ?? await collectChanges(repo, resolveBase(repo, options.base, null)) : null;
  const mergeBase = changes?.base.mergeBase ?? null;
  let judged: StructureConfig = config;
  const out: ChangeFinding[] = [];
  const codeTouched = (): boolean => !!changes && changes.files.some(f => (changes.created.has(f) || changes.renamed.has(f) || (changes.added.get(f)?.size ?? 0) > 0) && parseName(f) !== null);
  if (mergeBase) {
    const atBase = loadConfigAtCommit(repo, mergeBase);
    if (atBase.file) {
      judged = { ...config, structure: atBase.config.structure, reuse: atBase.config.reuse };
      if (stable(config.structure ?? null) !== stable(atBase.config.structure ?? null)) {
        const blocking = codeTouched();
        out.push({ code: 'configuration', severity: blocking ? 'error' : 'warning', isNew: true, blocking, path: atBase.file.slice(atBase.file.indexOf(':') + 1),
          message: 'section structure de la configuration modifiée par le changement : le contrôle juge avec celle de la base ; c\'est une décision de l\'opérateur, à fusionner dans une PR de configuration à part.' });
      }
    }
  }
  const settings = structureSettings(judged.structure);
  let usage: UsageGraph | null = options.usage === undefined ? null : options.usage;
  let usageError: string | null = null;
  if (options.usage === undefined) {
    try { usage = await usageGraph(repo, config); } catch (error) { usageError = error instanceof Error ? error.message : String(error); }
  }
  const files = changes ? changes.files : options.tracked ?? (await git.exec(repo, ['ls-files', '--cached', '--deduplicate', '-z'])).split('\0').filter(Boolean);
  // What the change creates or moves is always analysed, default exclusions or not (only structure.ignore of the base).
  const created = new Set(changes && !changes.all ? [...changes.created, ...changes.renamed.keys()] : []);
  const report = analyzeStructure(files, settings, { ...(options.paths?.length ? { paths: options.paths } : {}), ...(usage ? { usage } : {}), always: created });
  const wanted = (dir: string): boolean => !options.paths?.length || options.paths.some(p => inside(dir, p));

  // What the change moves or creates: the analysis findings on those files are new; the others existed.
  const touchedPaths = new Set(changes && !changes.all ? [...changes.created, ...changes.renamed.keys()] : []);
  for (const f of report.findings) {
    const isNew = !changes || changes.all || f.files.some(p => touchedPaths.has(p));
    Object.assign(f, { isNew, blocking: f.severity === 'error' && isNew });
  }

  const baseFiles = mergeBase ? (await git.exec(repo, ['ls-tree', '-r', '--name-only', '-z', mergeBase])).split('\0').filter(Boolean) : null;

  // Links and submodules the change adds: their content escapes the check (docs/STRUCTURE.md, section 2).
  if (changes && !changes.all) {
    for (const { path, kind } of changes.special) {
      if (settings.ignore.some(re => re.test(path))) continue;
      out.push({ code: 'coverage', severity: 'error', isNew: true, blocking: true, path,
        message: `${kind} ajouté par le changement : son contenu échappe au contrôle de l'arborescence ; le retirer, ou le déclarer dans structure.ignore (configuration de la base, décision de l'opérateur).` });
    }
  }

  // Flat folders: every code file the change creates or moves in blocks, except a known companion of a module that was
  // there (its tests, `.svelte.ts`, `.server.ts`, `.d.ts`), a rename in place and a move down into a subfolder.
  if (changes && baseFiles && !changes.all) {
    const now = folderEntries(files, settings, created);
    const before = folderEntries(baseFiles, settings);
    const baseStems = new Map<string, Set<string>>();
    for (const p of baseFiles) { const f = parseName(p); if (f && !f.test) baseStems.set(f.dir, new Set([...(baseStems.get(f.dir) ?? []), f.stem])); }
    const max = settings.maxFlatFiles;
    const reuseGenerated = globMatcher(reuseSettings(judged.reuse).generated);
    const generatedName = globMatcher([...GENERATED_PATHS]);
    const ignored = ignoreTest(settings, files, created);
    const reported = new Set<string>();
    for (const path of [...created].sort(byText)) {
      const f = parseName(path);
      if (!f || ignored(path) || !settings.roots.some(r => inside(path, r)) || !wanted(f.dir)) continue;
      const dir = f.dir;
      const count = now.get(dir)?.size ?? 0;
      if (count <= max) continue;
      const from = changes.renamed.get(path);
      if (from) {
        const origin = posix.dirname(from);
        // Renamed in place (Git similarity, `-M`), or moved down from a flat folder into one of its subfolders.
        if (origin === dir) continue;
        if (dir.startsWith(`${origin}/`) && (before.get(origin)?.size ?? 0) > max) continue;
      }
      const companion = f.infixes.length > 0 && f.infixes.every(i => COMPANION_INFIXES.has(i) || TEST_INFIX.test(i));
      if ((companion || f.test) && (baseStems.get(dir)?.has(f.stem) ?? false)) continue;
      const key = `${dir}/${entryKey(f)}`;
      if (reported.has(key)) continue;
      reported.add(key);
      const severity = settings.severity['flat-growth'];
      const had = before.get(dir)?.size ?? 0;
      const size = had > max ? `${dir}/ a déjà ${had} fichiers de code (seuil ${max})` : `${dir}/ passe de ${had} à ${count} fichiers de code (seuil ${max})`;
      if (generatedName(path)) {
        if (reuseGenerated(path)) continue;
        out.push({ code: 'flat-growth', severity, isNew: true, blocking: severity === 'error', path,
          message: `nommé comme un fichier généré, mais non déclaré dans reuse.generated de la base : ${size} ; le déclarer (PR de configuration, décision de l'opérateur) s'il est vraiment écrit par un outil, sinon le ranger dans un sous-dossier.` });
        continue;
      }
      const main = now.get(dir)?.get(entryKey(f)) ?? path;
      const flat = report.findings.find(x => x.folder === dir && x.code === 'flat-folder');
      const group = flat?.groups?.find(g => g.members.includes(main));
      const core = flat?.core?.find(c => c.path === main);
      const others = group?.members.filter(m => m !== main).map(m => posix.basename(m)) ?? [];
      // Placed by a rule of names (prefix, role, neighbouring folder): the move of the plan.
      const byName = report.findings.find(x => x.folder === dir && x.code !== 'flat-folder' && x.moves.some(m => m.from === main));
      const move = byName?.moves.find(m => m.from === main);
      const where = flat?.primitives
        ? `dossier de composants génériques : mettre le nouveau composant dans son propre dossier (${dir}/<Composant>/), jamais un fichier de plus à plat`
        : group
        ? `à ranger dans ${dir}/${group.dir}/ (${group.existing ? 'sous-dossier existant' : 'sous-dossier proposé'}${others.length ? ` avec ${others.slice(0, 4).join(', ')}${others.length > 4 ? ', …' : ''}` : ''} ; ${group.reasons[0]})`
        : move ? `à ranger en ${move.to} (${byName!.code} : ${byName!.proposal.replace(/[.\s]+$/, '')})`
        : core ? 'fichier que le dossier importe beaucoup : le ranger d\'abord avec l\'opérateur (apv structure check --path) plutôt que d\'alourdir la racine'
          : `aucun groupe nommé ne s'impose : le placer dans un sous-dossier de fonctionnalité (apv structure check --path ${dir} donne le découpage proposé), décidé avec l'opérateur`;
      out.push({ code: 'flat-growth', severity, isNew: true, blocking: severity === 'error', path, message: `fichier de code ajouté à un dossier à plat : ${size} ; ${where}.` });
    }
  }

  // Architecture map.
  const profile = profileOf(repo, settings, files);
  const mapPath = settings.architectureMap;
  const mapText = readWorktree(repo, mapPath);
  const roles = writtenRoles(mapText);
  const items = archItems(files, profile, settings, p => readWorktree(repo, p), created);
  const scoped = (item: ArchItem): boolean => !options.paths?.length || (item.kind === 'folder' && wanted(item.key.replace(/\/$/, '')));
  const severity = settings.severity['architecture-map'];
  const label = { folder: 'dossier', route: 'route principale', entry: 'point d\'entrée' } as const;
  const added = { folder: ['ajouté', 'existant'], route: ['ajoutée', 'existante'], entry: ['ajouté', 'existant'] } as const;
  const duplicated = mapText === null ? [] : duplicateMarkers(mapText);
  if (!changes) {
    const undescribed = items.filter(i => scoped(i) && roleOf(i, roles) === null);
    if (mapText === null) out.push({ code: 'architecture-map', severity: 'warning', isNew: false, blocking: false, path: mapPath, message: `carte de l'architecture absente : apv structure map l'écrit (partie générée remplie, partie écrite à compléter).` });
    else for (const i of undescribed) out.push({ code: 'architecture-map', severity: 'warning', isNew: false, blocking: false, path: mapPath, message: `${label[i.kind]} ${i.key} sans rôle dans « Rôles ».` });
    for (const m of duplicated) out.push({ code: 'architecture-map', severity: 'warning', isNew: false, blocking: false, path: mapPath, message: `marqueur ${m} présent plusieurs fois : garder un seul bloc.` });
    for (const b of mapText === null ? [] : brokenLinks(mapText, mapPath, p => existsSync(join(repo, p)))) {
      out.push({ code: 'architecture-map', severity: 'warning', isNew: false, blocking: false, path: `${mapPath}:${b.line}`, message: `lien cassé : ${b.target}.` });
    }
  } else if (baseFiles) {
    const baseKeys = new Set(archItems(baseFiles, profile, settings, p => gitShow(repo, mergeBase!, p)).map(i => i.key));
    const baseMapPath = structureSettings(judged.structure).architectureMap;
    const baseMap = gitShow(repo, mergeBase!, baseMapPath);
    // A new item is described by its own key, or by a glob the base already had: never by a catch-all the change brings.
    const baseGlobs = new Set([...writtenRoles(baseMap).keys()].filter(k => k.includes('*')));
    if (mapText === null && baseMap !== null) {
      out.push({ code: 'architecture-map', severity, isNew: true, blocking: severity === 'error', path: mapPath, message: 'carte de l\'architecture supprimée par le changement : la rétablir (apv structure map).' });
    }
    const duplicatedAtBase = new Set(baseMap === null ? [] : duplicateMarkers(baseMap));
    for (const m of duplicated) {
      const isNew = !duplicatedAtBase.has(m);
      out.push({ code: 'architecture-map', severity: isNew ? severity : 'warning', isNew, blocking: isNew && severity === 'error', path: mapPath,
        message: `marqueur ${m} présent plusieurs fois : un bloc recopié ferait croire la carte à jour ; garder un seul bloc de chaque.` });
    }
    // Folders a move down from their flat parent creates: the split proposed them, their role is proposed, never blocking.
    const before = folderEntries(baseFiles, settings);
    const descent = (item: ArchItem): string[] => {
      if (item.kind !== 'folder') return [];
      const dir = item.key.replace(/\/$/, '');
      const parent = posix.dirname(dir);
      if ((before.get(parent)?.size ?? 0) <= settings.maxFlatFiles) return [];
      return [...changes.renamed].filter(([to, from]) => to.startsWith(`${dir}/`) && posix.dirname(from) === parent).map(([to]) => to).sort(byText);
    };
    for (const i of items.filter(scoped)) {
      const isNew = !baseKeys.has(i.key);
      if (roleOf(i, roles, isNew ? baseGlobs : undefined) !== null) continue;
      const moved = isNew ? descent(i) : [];
      if (moved.length) {
        const name = posix.basename(i.key.replace(/\/$/, ''));
        out.push({ code: 'architecture-map', severity: 'warning', isNew: true, blocking: false, path: mapPath,
          message: `dossier ${i.key} créé par le rangement de ${posix.dirname(i.key.replace(/\/$/, ''))}/ : rôle proposé à confirmer dans « Rôles » : « - \`${i.key}\` : ${name} : ${moved.slice(0, 4).map(m => posix.basename(m)).join(', ')}${moved.length > 4 ? ', …' : ''} (découpage proposé) ».` });
        continue;
      }
      const catchAll = isNew && roleOf(i, roles) !== null;
      out.push({ code: 'architecture-map', severity: isNew ? severity : 'warning', isNew, blocking: isNew && severity === 'error', path: mapPath,
        message: `${label[i.kind]} ${i.key} ${added[i.kind][isNew ? 0 : 1]} sans rôle dans la carte de l'architecture${mapText === null ? ' (carte absente : apv structure map)' : ''}${catchAll ? ' (un motif ajouté par le changement ne décrit pas un élément nouveau)' : ''} : écrire « - \`${i.key}\` : <rôle en une ligne, trois mots au moins> » dans le bloc « Rôles »${i.known ? ` (rôle connu de la pile : ${i.known.role})` : ''}.` });
    }
    if (mapText !== null) {
      const baseSet = new Set(baseFiles);
      const baseDirs = new Set(baseFiles.flatMap(f => { const d: string[] = []; for (let x = posix.dirname(f); x !== '.'; x = posix.dirname(x)) d.push(x); return d; }));
      const brokenAtBase = new Set(baseMap === null ? [] : brokenLinks(baseMap, baseMapPath, p => baseSet.has(p) || baseDirs.has(p)).map(b => b.target));
      for (const b of brokenLinks(mapText, mapPath, p => existsSync(join(repo, p)))) {
        const isNew = !brokenAtBase.has(b.target);
        out.push({ code: 'architecture-map', severity: isNew ? severity : 'warning', isNew, blocking: isNew && severity === 'error', path: `${mapPath}:${b.line}`, message: `lien cassé : ${b.target}${isNew ? ' (cassé par le changement)' : ''} ; corriger la cible ou retirer le lien.` });
      }
    }
  }
  out.sort((a, b) => Number(b.blocking) - Number(a.blocking) || byText(a.code, b.code) || byText(a.path, b.path) || byText(a.message, b.message));
  const blocked = out.some(f => f.blocking) || report.findings.some(f => f.blocking);
  return {
    ...report,
    ok: !blocked,
    base: changes?.base ?? { source: 'none', ref: null, mergeBase: null },
    changes: out,
    architectureMap: { path: mapPath, exists: mapText !== null, profile: profile.id, items: items.length, described: items.length - items.filter(i => roleOf(i, roles) === null).length },
    usageError,
  };
}

/** A file at a commit, or null. */
function gitShow(repo: string, commit: string, path: string): string | null {
  try {
    return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '--no-pager', 'show', '--no-textconv', '--end-of-options', `${commit}:${path}`], {
      cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 4 * 1024 * 1024, timeout: 30_000,
      env: { ...environment(['PATH', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TEMP', 'TMP', 'LANG']), GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' },
    });
  } catch { return null; }
}
