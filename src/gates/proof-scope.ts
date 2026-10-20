import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, posix, relative, sep } from 'node:path';
import { DEFAULT_GENERATED_PATHS, MAX_SCOPE_FILES, type Gate } from '../domain/contracts.js';
import type { Git } from '../execution/git.js';
import { matches, validRelativePath } from '../policy/policy.js';
import { CONFIG_FILE, LEGACY_CONFIG_FILE, loadConfigAtCommit, type ApvConfig } from '../config/load.js';
import { errorMessage } from '../domain/errors.js';
import { designDir } from '../design/config.js';
import { environment, runProcess } from '../execution/process.js';
import { resolveReference } from './repeat.js';
import { webImpact } from '../web/impact.js';

/**
 * Scope of the proof of a check (`skipWhenOnly`, docs/APV3-SPEC.md, section 21): a change that only touches files with
 * no effect on what the check proves (documentation, decisions, specs) does not pay its full run. The check is « not
 * required » only when EVERY file changed since the merge base of `--base` and HEAD, and since the merge base of the
 * reference (the branch the change goes to) and HEAD, matches the paths the reference declares (never those of the
 * change), none of their `except`, none of `ALWAYS_REQUIRED` nor of the inputs of the check, and keeps its mode and type.
 * Anything else, or anything unknown, makes it required: the default is always the full run.
 */

/**
 * Files that always require the checks, whatever the configuration says: the configuration of the checks, the
 * dependencies (manifests and lock files), the CI and repository machinery, the build, test and runtime
 * configuration, the tests and test scripts, the database migrations.
 */
export const ALWAYS_REQUIRED: readonly string[] = [
  CONFIG_FILE, LEGACY_CONFIG_FILE,
  '**/package.json', ...DEFAULT_GENERATED_PATHS, '**/.npmrc', '**/.yarnrc', '**/.yarnrc.yml', '**/pnpm-workspace.yaml', '**/.nvmrc', '**/.node-version',
  '**/.tool-versions', '**/.python-version', '**/requirements*.txt', '**/pyproject.toml', '**/setup.py', '**/setup.cfg', '**/Pipfile', '**/Cargo.toml',
  '**/go.mod', '**/go.work', '**/Gemfile', '**/*.gemspec', '**/composer.json', '**/pom.xml', '**/build.gradle*', '**/settings.gradle*', '**/*.csproj',
  '**/pubspec.yaml', '**/mix.exs', '**/flake.nix', '**/deno.json', '**/deno.jsonc', '**/bunfig.toml',
  '.github/**', '.gitlab-ci.yml', '.gitlab/**', '.circleci/**', '.buildkite/**', '.woodpecker/**', '.woodpecker.yml', '.drone.yml', '.travis.yml',
  'azure-pipelines*.yml', 'bitbucket-pipelines.yml', '**/Jenkinsfile', '**/.gitattributes', '.gitmodules', '.husky/**',
  '**/*.config.*', '**/tsconfig*.json', '**/jsconfig*.json', '**/.babelrc*', '**/.env*', '**/Dockerfile*', '**/docker-compose*', '**/compose.yml',
  '**/compose.yaml', '**/Makefile', '**/*.mk', '**/justfile', '**/Taskfile.yml', '**/Taskfile.yaml', 'vercel.json', 'netlify.toml',
  'scripts/**', '**/*.sh', 'test/**', 'tests/**', 'e2e/**', '**/__tests__/**', '**/*.test.*', '**/*.spec.*', '**/*.e2e.*',
  '**/migrations/**', '**/*.sql',
  // Content the application compiles, serves or loads by convention of its framework (Next.js pages/ and app/, Astro, mdsvex):
  // Markdown, MDX, mdsvex and HTML under the source, static, public, content, app and pages folders, at any depth.
  ...['src', 'static', 'public', 'content', 'app', 'pages'].flatMap(dir => ['md', 'mdx', 'svx', 'html'].flatMap(ext => [`${dir}/**/*.${ext}`, `**/${dir}/**/*.${ext}`])),
];
/** Most needles of one literal search, and most symbolic links read; beyond, the check is required. */
const MAX_NEEDLES = 1000;
const MAX_LINKS = 500;

/** A file of a raw diff: its path, its status (`A`, `M`, `D`, `T`...) and its modes before and after. */
export interface ChangedFile { path: string; status: string; oldMode: string; newMode: string }
/** The decision for one check that declares `skipWhenOnly`. */
export interface ScopeDecision {
  gateId: string;
  required: boolean;
  reason: string;
  /** Merge base of `--base` and HEAD. */
  base: string | null;
  /** Merge base of the reference and HEAD. */
  reference: string | null;
  referenceName: string;
  /** The commit the reference named: its configuration gives the paths. */
  referenceSha: string | null;
  /** The files changed since the merge bases, sorted (every one when not required, the first `MAX_SCOPE_FILES` otherwise). */
  files: string[];
  /** How many files changed. */
  fileCount: number;
  /** The files that make the check required (50 at most). */
  blocking: string[];
}

/** Parses `git diff --raw -z --no-renames`: `:<old mode> <new mode> <old> <new> <status>\0<path>\0`. */
export function parseRawDiff(out: string): ChangedFile[] {
  const parts = out.split('\0');
  const files: ChangedFile[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const meta = parts[i]!;
    if (!meta.startsWith(':')) break;
    const [oldMode = '', newMode = '', , , status = ''] = meta.slice(1).split(' ');
    files.push({ path: parts[i + 1]!, status: status.slice(0, 1), oldMode, newMode });
  }
  return files;
}

/** Why a file changes the kind of thing it is (mode or type), or null: a symbolic link, a submodule, an executable. */
export function modeChange(f: ChangedFile): string | null {
  const regular = (mode: string): boolean => mode === '100644';
  if (f.status === 'T') return 'type changé';
  if (f.status === 'A') return regular(f.newMode) ? null : `ajouté en mode ${f.newMode}`;
  if (f.status === 'D') return regular(f.oldMode) ? null : `supprimé depuis le mode ${f.oldMode}`;
  if (f.oldMode !== f.newMode) return `mode ${f.oldMode} -> ${f.newMode}`;
  return regular(f.newMode) ? null : `mode ${f.newMode}`;
}

/**
 * The paths a check names in its commands, as exact paths and directories (`scripts/e2e.sh`, `--config=e2e/pw.ts`):
 * a change to a script the check runs always requires it. Options, placeholders and paths outside the repository ignored.
 */
export function commandPaths(gate: Gate, repo: string): string[] {
  const argvs = [gate.command, gate.affected ?? [], gate.retryFailed?.command ?? [], gate.repeatChanged?.command ?? []];
  const out = new Set<string>();
  for (const arg of argvs.flat()) {
    if (arg.includes('{{')) continue;
    let token = arg.includes('=') ? arg.slice(arg.lastIndexOf('=') + 1) : arg;
    if (!token || token.startsWith('-')) continue;
    if (isAbsolute(token)) {
      const rel = relative(repo, token);
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) continue;
      token = rel;
    }
    token = token.replace(/^(?:\.\/)+/, '').replace(/\/+$/, '');
    if (!validRelativePath(token) || /[{}]/.test(token)) continue;
    out.add(token);
    if (!/[*?]/.test(token)) out.add(`${token}/**`);
  }
  return [...out];
}

const safeMatch = (path: string, glob: string): boolean => { try { return matches(path, glob); } catch { return false; } };
/** Case-insensitive: a file that must require the check still does on a case-insensitive file system (`Package.json`, `SRC/`). */
const ciMatch = (path: string, glob: string): boolean => safeMatch(path.toLowerCase(), glob.toLowerCase());

/**
 * Files never searched for mentions: APV's configuration, decisions, specs, state and code map (never read by the
 * application; the configuration lists the dispensed paths themselves, the map names every file of the project), and the ignore files of tools (`.gitignore`, `.prettierignore`...:
 * they read nothing). Any other file under `.apv/` (a tool script) is searched.
 */
export const NOT_SEARCHED: readonly string[] = ['.apv/config.json', '.apv/DECISIONS.*', '.apv/specs/**', '.apv/state/**', '.apv/code-map.md', 'pipeline.v2.json', '**/.*ignore'];

/** What a file or folder is searched as: its path, its name, and each parent folder as a path segment or a quoted name. */
export function mentionNeedles(file: string, folders = true): { needle: string; folder: string | null }[] {
  const out: { needle: string; folder: string | null }[] = [{ needle: file, folder: null }, { needle: posix.basename(file), folder: null }];
  if (file.includes('/')) out.push({ needle: file.split('/').join('\\'), folder: null });
  if (!folders) return out;
  const parts = file.split('/');
  for (let i = 1; i < parts.length; i++) {
    const dir = parts.slice(0, i).join('/');
    const win = parts.slice(0, i).join('\\');
    for (const needle of [`${dir}/`, `/${dir}`, `'${dir}'`, `"${dir}"`, `\`${dir}\``, `\\${win}`, `${win}\\`]) out.push({ needle, folder: dir });
  }
  return out;
}

/**
 * The files among `candidates` the rest of the tree may read (`git grep -F -i` at `head`, the whole tracked tree except
 * `searchable` = false and `NOT_SEARCHED`): a file whose path or name appears literally, and every file under a parent
 * folder that appears as a path segment (`docs/`, `/docs`) or a quoted name (`'docs'`, `"docs"`, `` `docs` ``: a
 * `readdirSync('docs')`, a `join('docs', name)`, an `import.meta.glob('../docs/*.md')`). False positives are accepted:
 * the default is the full run. Null when the search could not be made (then every candidate is required).
 */
export async function mentionedFiles(repo: string, head: string, candidates: readonly string[], searchable: (path: string) => boolean,
  withFolders: (file: string) => boolean = () => true): Promise<Set<string> | null> {
  const byNeedle = new Map<string, Set<string>>();
  for (const file of candidates) {
    if (/[\n\r\0]/.test(file)) return null;
    for (const { needle, folder } of mentionNeedles(file, withFolders(file))) {
      const key = needle.toLowerCase();
      if (!byNeedle.has(key)) byNeedle.set(key, new Set());
      // A folder named: every candidate under it.
      for (const f of folder === null ? [file] : candidates.filter(c => c.toLowerCase().startsWith(`${folder.toLowerCase()}/`))) byNeedle.get(key)!.add(f);
    }
  }
  if (!byNeedle.size) return new Set();
  if (byNeedle.size > MAX_NEEDLES) return null;
  const r = await runProcess({ command: ['git', '-c', 'core.quotePath=false', 'grep', '-F', '-i', '-o', '-z', '-I', '--no-color', '--no-textconv', '-f', '-', head, '--'],
    cwd: repo, env: { ...environment(['PATH', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TEMP', 'LANG']), GIT_TERMINAL_PROMPT: '0' }, timeoutMs: 120000,
    input: `${[...byNeedle.keys()].join('\n')}\n`, maxOutputBytes: 64 * 1024 * 1024 });
  if (r.truncated || (r.exitCode !== 0 && r.exitCode !== 1) || (r.status !== 'passed' && r.exitCode !== 1)) return null;
  const matched = new Set<string>();
  const prefix = `${head}:`;
  for (const record of r.stdout.split('\n')) {
    if (!record) continue;
    const cut = record.indexOf('\0');
    // A record that does not parse (a file name with a line break): the search is not trusted.
    if (cut < 0 || !record.startsWith(prefix)) return null;
    const path = record.slice(prefix.length, cut);
    if (!searchable(path) || NOT_SEARCHED.some(g => ciMatch(path, g))) continue;
    matched.add(record.slice(cut + 1).toLowerCase());
  }
  // `-o` prints the longest match only (`docs/content.md`, never the `docs/` inside it): every needle a match contains counts.
  const found = new Set<string>();
  for (const m of matched) for (const [needle, files] of byNeedle) if (m.includes(needle)) for (const f of files) found.add(f);
  return found;
}

/** The real path of `abs` (symbolic links resolved), through its nearest existing ancestor when it does not exist. */
function realPath(abs: string): string {
  let head = abs;
  const rest: string[] = [];
  for (;;) {
    try { return join(realpathSync(head), ...rest.reverse()); }
    catch {
      const parent = dirname(head);
      if (parent === head) return abs;
      rest.push(basename(head));
      head = parent;
    }
  }
}

/**
 * The files among `candidates` that a symbolic link of `head` points to, or lies under. A target is resolved to its
 * real path (links of the checkout followed) before it is judged outside the repository; a link to the root of the
 * repository or to one of its ancestors makes every candidate linked. Null beyond `MAX_LINKS` links or when the tree
 * cannot be read.
 */
export async function linkedFiles(git: Git, repo: string, head: string, candidates: readonly string[]): Promise<Set<string> | null> {
  let tree: string;
  try { tree = await git.exec(repo, ['ls-tree', '-r', '-z', '--full-tree', head]); } catch { return null; }
  const links = tree.split('\0').filter(e => e.startsWith('120000 ')).map(e => ({ oid: e.split(' ')[2]!.split('\t')[0]!, path: e.slice(e.indexOf('\t') + 1) }));
  if (!links.length) return new Set();
  if (links.length > MAX_LINKS) return null;
  const r = await runProcess({ command: ['git', 'cat-file', '--batch'], cwd: repo, env: environment(['PATH', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TEMP', 'LANG']),
    timeoutMs: 60000, input: `${links.map(l => l.oid).join('\n')}\n`, maxOutputBytes: 4 * 1024 * 1024 });
  if (r.status !== 'passed' || r.truncated) return null;
  let root: string;
  try { root = realpathSync(repo); } catch { return null; }
  const targets: string[] = [];
  let rest = Buffer.from(r.stdout, 'utf8');
  for (const link of links) {
    const nl = rest.indexOf(10);
    const header = rest.subarray(0, nl).toString('utf8').split(' ');
    const size = Number(header[2]);
    if (header[1] !== 'blob' || !Number.isInteger(size)) return null;
    const target = rest.subarray(nl + 1, nl + 1 + size).toString('utf8');
    rest = rest.subarray(nl + 1 + size + 1);
    const real = realPath(isAbsolute(target) ? target : join(root, dirname(link.path), target));
    const rel = relative(root, real);
    // The root itself, or one of its ancestors: the link reaches every file.
    if (rel === '' || root.startsWith(`${real}${sep}`) || real === sep) return new Set(candidates);
    if (rel.startsWith('..') || isAbsolute(rel)) continue;
    targets.push(rel.split(sep).join('/').toLowerCase());
  }
  return new Set(candidates.filter(file => { const f = file.toLowerCase(); return targets.some(t => f === t || f.startsWith(`${t}/`)); }));
}

async function mergeBaseOf(git: Git, repo: string, a: string, b: string): Promise<string | null> {
  try { return (await git.exec(repo, ['merge-base', a, b])).trim() || null; } catch { return null; }
}
async function resolveCommit(git: Git, repo: string, ref: string): Promise<string | null> {
  try { return (await git.exec(repo, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`])).trim() || null; } catch { return null; }
}

export interface ScopeInput {
  /** `--base` (any revision); its merge base with `head` must not be `head`. */
  base: string;
  /** In place of `skipWhenOnly.reference` (`apv stack batch`: its target). */
  reference?: string;
  /** The commit whose committed content is compared. */
  head: string;
  /** The working tree has uncommitted changes: every check is required. */
  dirty?: boolean;
  /** The configuration file read, when inside the repository: always required too. */
  configFile?: string | null;
}

/**
 * The scope decisions of the checks of `config` that declare `skipWhenOnly` (the others are always required). Pure
 * function of the configuration, the commit, the base and the reference: `apv gates run` decides with it before
 * anything waits, `apv gates verify` recomputes it from the commit, and the two agree. A required check makes its
 * dependencies required (transitively): a check never runs without what it depends on.
 */
export async function planScope(git: Git, repo: string, config: ApvConfig, input: ScopeInput): Promise<Map<string, ScopeDecision>> {
  const decisions = new Map<string, ScopeDecision>();
  const scoped = config.gates.filter(g => g.skipWhenOnly);
  if (!scoped.length) return decisions;
  const head = await resolveCommit(git, repo, input.head);
  const baseMb = head ? await mergeBaseOf(git, repo, input.base, head) : null;
  const refs = new Map<string, { sha: string | null; reason: string; mb: string | null; config: ApvConfig | null; error: string | null }>();
  const diffs = new Map<string, ChangedFile[]>();
  const diff = async (from: string): Promise<ChangedFile[]> => {
    if (!diffs.has(from)) {
      diffs.set(from, parseRawDiff(await git.exec(repo, ['diff', '--raw', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', '--no-abbrev', '--ignore-submodules=none', from, head!, '--'])));
    }
    return diffs.get(from)!;
  };
  const configPath = input.configFile && !isAbsolute(relative(repo, input.configFile)) && !relative(repo, input.configFile).startsWith('..')
    ? relative(repo, input.configFile) : null;
  for (const gate of scoped) {
    const settings = gate.skipWhenOnly!;
    const referenceName = input.reference ?? settings.reference;
    const decide = (required: boolean, reason: string, extra: Partial<ScopeDecision> = {}): void => {
      decisions.set(gate.id, { gateId: gate.id, required, reason, base: baseMb, reference: null, referenceName, referenceSha: null, files: [], fileCount: 0, blocking: [], ...extra });
    };
    if (!head) { decide(true, `commit ${input.head} introuvable`); continue; }
    if (input.dirty) { decide(true, 'arbre de travail modifié : seul un commit se compare'); continue; }
    if (!baseMb) { decide(true, `aucune base commune entre --base ${input.base} et le commit`); continue; }
    if (baseMb === head) { decide(true, `base égale au commit ou en aval (--base ${input.base}) : aucun changement à comparer`); continue; }
    if (!refs.has(referenceName)) {
      const { sha, reason } = await resolveReference(git, repo, referenceName);
      let config: ApvConfig | null = null;
      let error: string | null = null;
      if (sha) { try { config = loadConfigAtCommit(repo, sha).config; } catch (e) { error = errorMessage(e); } }
      refs.set(referenceName, { sha, reason, mb: sha ? await mergeBaseOf(git, repo, sha, head) : null, config, error });
    }
    const ref = refs.get(referenceName)!;
    if (!ref.sha) { decide(true, `référence ${referenceName} ${ref.reason} (skipWhenOnly.reference)`); continue; }
    const at = { referenceSha: ref.sha, reference: ref.mb };
    if (!ref.mb) { decide(true, `aucune base commune entre la référence ${referenceName} et le commit`, at); continue; }
    if (ref.mb === head) { decide(true, `le commit est déjà dans la référence ${referenceName} : aucun changement à comparer`, at); continue; }
    if (!ref.config) { decide(true, `configuration de la référence ${referenceName} illisible${ref.error ? ` : ${ref.error}` : ''}`, at); continue; }
    // The lists of the reference, never those of the change: a change cannot grant itself a dispensation.
    const target = ref.config.gates.find(g => g.id === gate.id)?.skipWhenOnly;
    if (!target) { decide(true, `la référence ${referenceName} ne déclare pas skipWhenOnly pour ${gate.id} (les chemins sont lus à la référence)`, at); continue; }
    // The reference names itself: a change that points its reference elsewhere than where the target points is never dispensed.
    if (target.reference !== settings.reference) {
      decide(true, `la référence du contrôle (${settings.reference}) diffère de celle que déclare ${referenceName} (${target.reference}) : une dispense se compte depuis la cible, jamais depuis une autre branche`, at);
      continue;
    }
    const byPath = new Map<string, ChangedFile>();
    for (const from of new Set([baseMb, ref.mb])) for (const f of await diff(from)) if (!byPath.has(f.path) || modeChange(f)) byPath.set(f.path, f);
    const files = [...byPath.keys()].sort();
    const targetGate = ref.config.gates.find(g => g.id === gate.id)!;
    const design = [config, ref.config].map(c => { try { return designDir(c.design); } catch { return 'docs/design'; } });
    // A project that audits its site: every file the web audit would find « web » requires the check too.
    const webSettings = [config.web, ref.config.web].filter((w): w is NonNullable<ApvConfig['web']> => w !== undefined);
    const webEffect = (path: string): boolean => webSettings.some(w => webImpact([path], w).required);
    const named = [gate, targetGate].flatMap(g => commandPaths(g, repo));
    const inputs = [...new Set([...ALWAYS_REQUIRED, ...(configPath ? [configPath] : []), ...design.map(d => `${d}/**`),
      ...[gate, targetGate].flatMap(g => [...g.testPaths, ...(g.repeatChanged?.paths ?? [])]), ...named])];
    const blocking: string[] = [];
    let first = '';
    for (const path of files) {
      const f = byPath.get(path)!;
      const why = !validRelativePath(path) ? 'chemin invalide'
        : modeChange(f) ? `${modeChange(f)} (lien symbolique, sous-module ou exécutable : toujours requis)`
        : inputs.some(g => ciMatch(path, g)) ? 'toujours requis (configuration, dépendances, CI, build, maquettes, tests, scripts, migrations ou contenu de l\'application)'
        : webEffect(path) ? 'effet web (section web : l\'audit web le jugerait requis)'
        : !target.paths.some(g => safeMatch(path, g)) ? 'hors de skipWhenOnly.paths'
        : (target.except ?? []).some(g => ciMatch(path, g)) ? 'exclu par skipWhenOnly.except'
        : null;
      if (!why) continue;
      if (blocking.length < 50) blocking.push(path);
      if (!first) first = `${path} : ${why}`;
    }
    // A file the application or its tests read by name, or that a symbolic link points to, is never without effect.
    const rest = blocking.length ? [] : files;
    if (rest.length) {
      // Searched: the whole tracked tree but the files the list of the reference dispenses (by declaration without effect).
      const dispensable = (path: string): boolean => target.paths.some(g => safeMatch(path, g)) && !(target.except ?? []).some(g => ciMatch(path, g))
        && !inputs.some(g => ciMatch(path, g));
      // A file listed exactly (a pattern without wildcard) is searched by its path and name only; one reached by a
      // wildcard pattern, by its folders too (a folder read whole).
      const byWildcard = (path: string): boolean => target.paths.some(g => /[*?]/.test(g) && safeMatch(path, g));
      const mentioned = await mentionedFiles(repo, head, rest, path => !dispensable(path), path => byWildcard(path) || !target.paths.includes(path));
      const linked = await linkedFiles(git, repo, head, rest);
      if (!mentioned || !linked) { blocking.push(...rest.slice(0, 50)); first = `${rest[0]} : recherche des mentions ou des liens symboliques impossible ou trop grande, toujours requis`; }
      else {
        for (const path of rest) {
          const why = mentioned.has(path) ? 'nommé (ou son dossier) dans un fichier suivi qui n\'est pas lui-même dispensé : peut-être lu par l\'application ou les tests (à mettre dans except, ou lister des fichiers précis)'
            : linked.has(path) ? 'cible d\'un lien symbolique du dépôt' : null;
          if (!why) continue;
          if (blocking.length < 50) blocking.push(path);
          if (!first) first = `${path} : ${why}`;
        }
      }
    }
    const since = `depuis ${baseMb.slice(0, 12)} (--base) et ${ref.mb.slice(0, 12)} (${referenceName})`;
    const common = { ...at, files: files.slice(0, MAX_SCOPE_FILES), fileCount: files.length, blocking };
    if (blocking.length) decide(true, `${files.length} fichier(s) changé(s) ${since}, dont ${blocking.length === 50 ? 'au moins 50' : blocking.length} qui le requièrent ; ${first}`, common);
    else if (files.length > MAX_SCOPE_FILES) decide(true, `${files.length} fichiers changés ${since} : au-delà de ${MAX_SCOPE_FILES}, toujours requis`, common);
    else decide(false, files.length ? `${files.length} fichier(s) changé(s) ${since}, tous sans effet sur ce contrôle (skipWhenOnly de ${referenceName})`
      : `aucun fichier changé ${since}`, { ...at, files, fileCount: files.length, blocking: [] });
  }
  // A check that runs needs its dependencies: a required check (or one without skipWhenOnly) makes them required.
  const byId = new Map(config.gates.map(g => [g.id, g]));
  const requiredBy = (id: string, seen = new Set<string>()): string | null => {
    for (const g of config.gates) {
      if (!g.dependsOn.includes(id) || seen.has(g.id)) continue;
      seen.add(g.id);
      const d = decisions.get(g.id);
      if (!d || d.required) return g.id;
      const up = requiredBy(g.id, seen);
      if (up) return up;
    }
    return null;
  };
  for (const [id, d] of decisions) {
    if (d.required || !byId.has(id)) continue;
    const by = requiredBy(id);
    if (by) decisions.set(id, { ...d, required: true, reason: `dépendance de ${by}, qui est requis ; ${d.reason}` });
  }
  return decisions;
}

/** The receipt field `scope` of a decision. */
export function scopeRecord(d: ScopeDecision): { required: boolean; reason: string; base: string | null; reference: string | null; referenceName: string;
  referenceSha: string | null; fileCount: number; files: string[]; blocking: string[] } {
  return { required: d.required, reason: d.reason.slice(0, 2000), base: d.base, reference: d.reference, referenceName: d.referenceName, referenceSha: d.referenceSha,
    fileCount: d.fileCount, files: d.files.slice(0, MAX_SCOPE_FILES), blocking: d.blocking };
}

/** The refusal of a full run whose `skipWhenOnly.reference` does not resolve. */
export function scopeReferenceMissing(gateId: string, name: string, detail = 'introuvable'): string {
  return `${gateId} : référence ${name} ${detail} (skipWhenOnly.reference) : la portée d'une suite complète se compte depuis la branche où va le changement, ` +
    `jamais depuis --base seule, et ses chemins se lisent à cette référence. Récupérer la référence (git fetch) ou corriger skipWhenOnly.reference dans .apv/config.json (par exemple "origin/main").`;
}
