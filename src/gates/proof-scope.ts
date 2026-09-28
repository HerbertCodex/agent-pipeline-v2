import { isAbsolute, relative } from 'node:path';
import { DEFAULT_GENERATED_PATHS, MAX_SCOPE_FILES, type Gate } from '../domain/contracts.js';
import type { Git } from '../execution/git.js';
import { matches, validRelativePath } from '../policy/policy.js';
import { CONFIG_FILE, LEGACY_CONFIG_FILE, loadConfigAtCommit, type ApvConfig } from '../config/load.js';
import { errorMessage } from '../domain/errors.js';

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
  'azure-pipelines*.yml', 'bitbucket-pipelines.yml', '**/Jenkinsfile', '.gitattributes', '.gitmodules', '.husky/**',
  '**/*.config.*', '**/tsconfig*.json', '**/jsconfig*.json', '**/.babelrc*', '**/.env*', '**/Dockerfile*', '**/docker-compose*', '**/compose.yml',
  '**/compose.yaml', '**/Makefile', '**/*.mk', '**/justfile', '**/Taskfile.yml', '**/Taskfile.yaml', 'vercel.json', 'netlify.toml',
  'scripts/**', '**/*.sh', 'test/**', 'tests/**', 'e2e/**', '**/__tests__/**', '**/*.test.*', '**/*.spec.*', '**/*.e2e.*',
  '**/migrations/**', '**/*.sql',
];

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

async function mergeBaseOf(git: Git, repo: string, a: string, b: string): Promise<string | null> {
  try { return (await git.exec(repo, ['merge-base', a, b])).trim() || null; } catch { return null; }
}
async function resolve(git: Git, repo: string, ref: string): Promise<string | null> {
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
  const head = await resolve(git, repo, input.head);
  const baseMb = head ? await mergeBaseOf(git, repo, input.base, head) : null;
  const refs = new Map<string, { sha: string | null; mb: string | null; config: ApvConfig | null; error: string | null }>();
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
      const sha = await resolve(git, repo, referenceName);
      let config: ApvConfig | null = null;
      let error: string | null = null;
      if (sha) { try { config = loadConfigAtCommit(repo, sha).config; } catch (e) { error = errorMessage(e); } }
      refs.set(referenceName, { sha, mb: sha ? await mergeBaseOf(git, repo, sha, head) : null, config, error });
    }
    const ref = refs.get(referenceName)!;
    if (!ref.sha) { decide(true, `référence ${referenceName} introuvable (skipWhenOnly.reference)`); continue; }
    const at = { referenceSha: ref.sha, reference: ref.mb };
    if (!ref.mb) { decide(true, `aucune base commune entre la référence ${referenceName} et le commit`, at); continue; }
    if (ref.mb === head) { decide(true, `le commit est déjà dans la référence ${referenceName} : aucun changement à comparer`, at); continue; }
    if (!ref.config) { decide(true, `configuration de la référence ${referenceName} illisible${ref.error ? ` : ${ref.error}` : ''}`, at); continue; }
    // The lists of the reference, never those of the change: a change cannot grant itself a dispensation.
    const target = ref.config.gates.find(g => g.id === gate.id)?.skipWhenOnly;
    if (!target) { decide(true, `la référence ${referenceName} ne déclare pas skipWhenOnly pour ${gate.id} (les chemins sont lus à la référence)`, at); continue; }
    const byPath = new Map<string, ChangedFile>();
    for (const from of new Set([baseMb, ref.mb])) for (const f of await diff(from)) if (!byPath.has(f.path) || modeChange(f)) byPath.set(f.path, f);
    const files = [...byPath.keys()].sort();
    const targetGate = ref.config.gates.find(g => g.id === gate.id)!;
    const inputs = [...new Set([...ALWAYS_REQUIRED, ...(configPath ? [configPath] : []),
      ...[gate, targetGate].flatMap(g => [...g.testPaths, ...(g.repeatChanged?.paths ?? []), ...commandPaths(g, repo)])])];
    const blocking: string[] = [];
    let first = '';
    for (const path of files) {
      const f = byPath.get(path)!;
      const why = !validRelativePath(path) ? 'chemin invalide'
        : modeChange(f) ? `${modeChange(f)} (lien symbolique, sous-module ou exécutable : toujours requis)`
        : inputs.some(g => safeMatch(path, g)) ? 'toujours requis (configuration, dépendances, CI, build, tests, scripts ou migrations)'
        : !target.paths.some(g => safeMatch(path, g)) ? 'hors de skipWhenOnly.paths'
        : (target.except ?? []).some(g => safeMatch(path, g)) ? 'exclu par skipWhenOnly.except'
        : null;
      if (!why) continue;
      if (blocking.length < 50) blocking.push(path);
      if (!first) first = `${path} : ${why}`;
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
export function scopeReferenceMissing(gateId: string, name: string): string {
  return `${gateId} : référence ${name} introuvable (skipWhenOnly.reference) : la portée d'une suite complète se compte depuis la branche où va le changement, ` +
    `jamais depuis --base seule, et ses chemins se lisent à cette référence. Récupérer la référence (git fetch) ou corriger skipWhenOnly.reference dans .apv/config.json (par exemple "origin/main").`;
}
