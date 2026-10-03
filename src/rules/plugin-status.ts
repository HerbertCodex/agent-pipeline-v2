import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * What `apv status` says of the plugin (projet pilote, 3 octobre 2026) : a project under APV whose plugin is not loaded
 * in Claude Code runs without its hooks (no seal, no journal, no guard) and nothing said it for days; and an update of the
 * tool brought merge rules that the installed plugin could not satisfy (`apv rules check` refused every merge in the
 * night). Both are said here, with the commands to run, before they block.
 */

/** A merge rule of the catalog `docs/merge-rules.json`: its id, the version that brings it, what it needs. */
export interface CatalogRule { id: string; since: string; needs: string[]; summary: string }
export interface Catalog { needs: Record<string, string>; rules: CatalogRule[] }

/** The plugin as Claude Code installed it for this account: `~/.claude/plugins/installed_plugins.json` and `settings.json`. */
export interface PluginInstall { key: string; version: string | null; sha: string | null; installPath: string | null; enabled: boolean }

export interface PluginStatus {
  /** The project is under APV (`.apv/` or a configuration). */
  project: boolean;
  /** The install of the plugin, null when Claude Code knows none. */
  install: PluginInstall | null;
  /** Why the files of Claude Code could not be read (they exist but are not what is expected), or null. */
  unreadable: string | null;
  /** The hooks are turned off for every plugin (`disableAllHooks` in the settings of the account or the project). */
  hooksDisabled: boolean;
  /** The tool running this command: version and commit (null outside a checkout). */
  tool: { root: string; version: string | null; sha: string | null };
  /** Merge rules the running tool applies that the installed plugin does not know (its hooks may not satisfy them). */
  unknownToPlugin: CatalogRule[];
  /**
   * The installed plugin is not at the level of the running tool in what it runs (hooks, agents, skills, workflows, the
   * manifest, the compiled tool): older (`changed`), newer (`ahead`), from another branch (`diverged`), or not comparable
   * (`unknown`: installed from a commit this checkout does not have, or naming none).
   */
  pluginBehind: 'changed' | 'unknown' | 'ahead' | 'diverged' | null;
  /**
   * Merge rules of the next version of the tool (the upstream branch of its checkout, as last fetched), not in this one;
   * `rules` is null when the catalog of that version could not be read (a partial clone that never fetched it).
   */
  upcoming: { ref: string; behind: number; rules: CatalogRule[] | null } | null;
  needs: Record<string, string>;
}

const PLUGIN_NAME = 'apv';
const CATALOG = join('docs', 'merge-rules.json');
/** What the plugin runs: its hooks, agents, skills and workflows, and the compiled tool they load (`dist/`). */
const PLUGIN_PARTS = ['hooks', 'agents', 'skills', 'workflows', '.claude-plugin', 'dist'];
const SHA = /^[0-9a-f]{7,40}$/;
const PLUGIN_KEY = /^apv@[A-Za-z0-9._-]{1,64}$/;
/** Files of Claude Code and catalogs larger than this are not read. */
const MAX_BYTES = 1024 * 1024;
/** The root of the running tool: `dist/rules/plugin-status.js`, two folders up. */
export const TOOL_ROOT = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');

/**
 * git in a checkout of the tool, never steered by the environment of the caller (GIT_DIR...) nor by the repository
 * (hooks, fsmonitor), never fetching (a partial clone fetches missing objects otherwise), 5 seconds at most.
 */
function git(cwd: string, args: string[]): string | null {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/.test(k)));
  try {
    return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000, env: { ...env, GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' } }).trim();
  } catch { return null; }
}

/** One line of text from a file anyone may write: no control character, no escape sequence, bounded. */
const clean = (text: string, max = 200): string => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const RULE_ID = /^[a-z0-9-]{1,40}$/;

/** Parses a catalog; null when it is not one. Ids and needs that are not plain names are left out; texts are cleaned. */
export function parseCatalog(text: string | null): Catalog | null {
  if (text === null || text.length > MAX_BYTES) return null;
  try {
    const raw = JSON.parse(text) as { needs?: unknown; rules?: unknown };
    if (!Array.isArray(raw.rules)) return null;
    const rules = raw.rules.filter((r): r is CatalogRule => !!r && typeof r === 'object' && typeof (r as CatalogRule).id === 'string' && RULE_ID.test((r as CatalogRule).id)
      && typeof (r as CatalogRule).since === 'string' && /^v?\d+\.\d+\.\d+(?:-[\w.]+)?$/.test((r as CatalogRule).since))
      .map(r => ({ id: r.id, since: r.since, needs: Array.isArray(r.needs) ? r.needs.filter((n): n is string => typeof n === 'string' && RULE_ID.test(n)) : [],
        summary: typeof r.summary === 'string' ? clean(r.summary) : '' }));
    const needs = raw.needs && typeof raw.needs === 'object' ? Object.fromEntries(Object.entries(raw.needs as Record<string, unknown>)
      .filter((e): e is [string, string] => RULE_ID.test(e[0]) && typeof e[1] === 'string').map(([k, v]) => [k, clean(v)])) : {};
    return { needs, rules: rules.filter((r, k) => rules.findIndex(o => o.id === r.id) === k) };
  } catch { return null; }
}

/** Compares two versions `x.y.z[-tag.n]`: negative, zero or positive. A version without tag comes after its tags. */
export function compareVersions(a: string, b: string): number {
  const split = (v: string): [number[], (string | number)[] | null] => {
    const [core, tag] = v.replace(/^v/, '').split('-', 2) as [string, string | undefined];
    return [core.split('.').map(n => Number(n) || 0), tag === undefined ? null : tag.split(/[.-]/).map(p => (/^\d+$/.test(p) ? Number(p) : p))];
  };
  const [ca, ta] = split(a); const [cb, tb] = split(b);
  for (let k = 0; k < Math.max(ca.length, cb.length); k += 1) if ((ca[k] ?? 0) !== (cb[k] ?? 0)) return (ca[k] ?? 0) - (cb[k] ?? 0);
  if (ta === null || tb === null) return ta === tb ? 0 : ta === null ? 1 : -1;
  for (let k = 0; k < Math.max(ta.length, tb.length); k += 1) {
    const x = ta[k]; const y = tb[k];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x !== y) return typeof x === 'number' && typeof y === 'number' ? x - y : String(x) < String(y) ? -1 : 1;
  }
  return 0;
}

/** The rules of `next` that `known` does not have: by id when `known` has a catalog, else by the version they come with. */
export function newRules(next: Catalog | null, known: Catalog | null, knownVersion: string | null): CatalogRule[] {
  if (!next) return [];
  if (known) return next.rules.filter(r => !known.rules.some(k => k.id === r.id));
  if (!knownVersion) return next.rules;
  return next.rules.filter(r => compareVersions(r.since, knownVersion) > 0);
}

/** A JSON file: its value, `undefined` when absent, or an Error when present but unreadable (invalid, too large). */
function readJson(file: string): unknown {
  try {
    const st = statSync(file);
    // Only a regular file is read: a FIFO or a device would block apv status.
    if (!st.isFile()) return new Error(`${file} : pas un fichier ordinaire`);
    if (st.size > MAX_BYTES) return new Error(`${file} : plus de 1 Mio`);
    return JSON.parse(readFileSync(file, 'utf8')) as unknown;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : new Error(`${file} : illisible`);
  }
}
const readText = (file: string): string | null => {
  try { const st = statSync(file); return st.isFile() && st.size <= MAX_BYTES ? readFileSync(file, 'utf8') : null; } catch { return null; }
};
const objectOf = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Error) ? v as Record<string, unknown> : null);

/** The folder of the configuration of Claude Code: CLAUDE_CONFIG_DIR, else `.claude` in the HOME of the environment. */
export function claudeDir(env: NodeJS.ProcessEnv): string {
  return env['CLAUDE_CONFIG_DIR'] || join(env['HOME'] || homedir(), '.claude');
}

/**
 * The settings files that apply in `repo`, in order of precedence (the last wins), as Claude Code ranks them: account,
 * the project file of `repo` (read in the folder of the session), then the local file. In a worktree, Claude Code keeps
 * the local file at the root of the main checkout; one left in the worktree by an earlier version is still read, below
 * it (code.claude.com/docs/en/settings, « Where Claude Code keeps the local file in a git repository »).
 */
const settingsFiles = (dir: string, repo: string | null): string[] => {
  if (!repo) return [join(dir, 'settings.json')];
  const main = mainCheckout(repo);
  const worktree = main !== null && main !== resolve(repo);
  return [join(dir, 'settings.json'), join(repo, '.claude', 'settings.json'), join(repo, '.claude', 'settings.local.json'),
    ...(worktree ? [join(main, '.claude', 'settings.local.json')] : [])];
};

/**
 * The install of the plugin for this account, or null: an entry `apv@<marketplace>` of installed_plugins.json for the
 * account (scope user) or for this project (its projectPath), the enabled one first. Enabled when a settings file says so
 * (`claude plugin install` writes it; the last file wins); absent: off. Throws when the file exists but cannot be read.
 */
export function pluginInstall(dir: string, repo: string | null = null): PluginInstall | null {
  const raw = readJson(join(dir, 'plugins', 'installed_plugins.json'));
  if (raw instanceof Error) throw raw;
  const plugins = objectOf(objectOf(raw)?.['plugins']);
  if (!plugins) return null;
  const settings = settingsFiles(dir, repo).map(f => {
    const value = readJson(f);
    if (value instanceof Error) throw value;
    return objectOf(objectOf(value)?.['enabledPlugins']);
  });
  const enabledOf = (key: string): boolean => settings.reduce<boolean>((on, s) => (typeof s?.[key] === 'boolean' ? s[key] as boolean : on), false);
  const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
  // The project, and its main checkout when the command runs in one of its worktrees (an install for the project names it).
  const places = repo ? [resolve(repo), ...[mainCheckout(repo)].filter((p): p is string => p !== null)] : [];
  const candidates: PluginInstall[] = [];
  let forged = false;
  for (const [key, value] of Object.entries(plugins)) {
    if (key.split('@')[0] !== PLUGIN_NAME) continue;
    // A key that is not a plain plugin name would go into the commands this status gives: never taken, and said.
    if (!PLUGIN_KEY.test(key)) { forged = true; continue; }
    const entries = (Array.isArray(value) ? value : [value]).map(objectOf).filter((e): e is Record<string, unknown> => e !== null);
    // An entry without scope nor projectPath (the older format) is the account's.
    const entry = entries.find(e => e['scope'] === 'user' || (e['scope'] === undefined && e['projectPath'] === undefined))
      ?? entries.find(e => typeof e['projectPath'] === 'string' && places.includes(resolve(e['projectPath'] as string)));
    if (entry) candidates.push({ key, version: str(entry['version']), sha: str(entry['gitCommitSha']), installPath: str(entry['installPath']), enabled: enabledOf(key) });
  }
  if (!candidates.length && forged) throw new Error(`${join(dir, 'plugins', 'installed_plugins.json')} : nom de plugin apv invalide`);
  return candidates.find(c => c.enabled) ?? candidates[0] ?? null;
}

/** The main checkout of the repository of `repo` (first worktree), or null. */
const mainCheckouts = new Map<string, string | null>();
function mainCheckout(repo: string): string | null {
  const key = resolve(repo);
  if (!mainCheckouts.has(key)) {
    const out = git(repo, ['worktree', 'list', '--porcelain']);
    const first = out ? /^worktree (.+)$/m.exec(out)?.[1] : undefined;
    mainCheckouts.set(key, first ? resolve(first) : null);
  }
  return mainCheckouts.get(key)!;
}

/** The folder of a marketplace added from a directory (`claude plugin marketplace add <dossier>`), or null. */
export function marketplaceDir(dir: string, key: string): string | null {
  const source = objectOf(objectOf(objectOf(readJson(join(dir, 'plugins', 'known_marketplaces.json')))?.[key.split('@')[1] ?? ''])?.['source']);
  return source?.['source'] === 'directory' && typeof source['path'] === 'string' ? source['path'] : null;
}

/** The catalog of the running tool, of an install, or of a commit of a checkout of the tool. */
const catalogAt = (root: string): Catalog | null => parseCatalog(readText(join(root, CATALOG)));
const catalogOf = (root: string, ref: string): Catalog | null => (/^[\w./@{}-]+$/.test(ref) && !ref.startsWith('-') ? parseCatalog(git(root, ['show', `${ref}:${CATALOG}`])) : null);

export function pluginStatus(repo: string, env: NodeJS.ProcessEnv, toolRoot = TOOL_ROOT): PluginStatus {
  const project = existsSync(join(repo, '.apv')) || existsSync(join(repo, 'pipeline.v2.json'));
  const dir = claudeDir(env);
  let install: PluginInstall | null = null; let unreadable: string | null = null;
  try { install = pluginInstall(dir, repo); } catch (error) { unreadable = clean((error as Error).message); }
  // disableAllHooks follows the same precedence as the other settings: the last file that sets it wins.
  const hooksDisabled = settingsFiles(dir, repo).reduce<boolean>((off, f) => {
    const value = objectOf(readJson(f))?.['disableAllHooks'];
    return typeof value === 'boolean' ? value : off;
  }, false);
  const pkg = objectOf(readJson(join(toolRoot, 'package.json')));
  const sha = git(toolRoot, ['rev-parse', 'HEAD']);
  const tool = { root: toolRoot, version: typeof pkg?.['version'] === 'string' ? pkg['version'] as string : null, sha };
  const own = catalogAt(toolRoot);
  // The catalog of the installed plugin: its own files, else the commit it was installed from, in this checkout.
  const installed = install?.installPath ? catalogAt(install.installPath) ?? (install.sha && sha ? catalogOf(toolRoot, install.sha) : null) : null;
  // What the running tool applies or runs that the installed plugin does not have; nothing when the tool runs from that copy.
  const fromInstall = !!install?.installPath && resolve(install.installPath) === resolve(toolRoot);
  const differs = !!install && !fromInstall && !!sha && install.sha !== sha;
  const unknownToPlugin = differs ? newRules(own, installed, install!.version) : [];
  let pluginBehind: PluginStatus['pluginBehind'] = null;
  if (differs) {
    const installedSha = install!.sha;
    const known = !!installedSha && SHA.test(installedSha) && git(toolRoot, ['cat-file', '-e', `${installedSha}^{commit}`]) !== null;
    if (!known) pluginBehind = 'unknown';
    else if (git(toolRoot, ['diff', '--quiet', installedSha, sha!, '--', ...PLUGIN_PARTS]) === null) {
      // Which side is behind: the plugin (an ancestor of the tool), the tool (behind the plugin), or neither (diverged).
      const ancestor = (a: string, b: string): boolean => git(toolRoot, ['merge-base', '--is-ancestor', a, b]) !== null;
      pluginBehind = ancestor(installedSha, sha!) ? 'changed' : ancestor(sha!, installedSha) ? 'ahead' : 'diverged';
    }
  }
  // The next version: the upstream of the running checkout, as last fetched; run from the installed copy (no checkout),
  // the folder the marketplace was added from (its upstream, else its HEAD), counted from the installed commit.
  let upcoming: PluginStatus['upcoming'] = null;
  const upstream = sha ? git(toolRoot, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']) : null;
  // The rules of the next version, or null when its catalog cannot be read (never said « no new rule » then).
  const nextRules = (root: string, ref: string): CatalogRule[] | null => {
    const next = catalogOf(root, ref);
    return next ? newRules(next, own, tool.version) : null;
  };
  if (upstream) {
    const behind = Number(git(toolRoot, ['rev-list', '--count', `HEAD..${upstream}`]) ?? '0') || 0;
    upcoming = { ref: clean(upstream, 100), behind, rules: behind ? nextRules(toolRoot, upstream) : [] };
  } else if (!sha && install?.sha && SHA.test(install.sha)) {
    const source = marketplaceDir(dir, install.key);
    const ref = source && git(source, ['rev-parse', 'HEAD']) ? git(source, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']) ?? 'HEAD' : null;
    if (source && ref && /^[\w./@{}-]+$/.test(ref) && !ref.startsWith('-')) {
      const behind = Number(git(source, ['rev-list', '--count', '--end-of-options', `${install.sha}..${ref}`]) ?? '0') || 0;
      upcoming = { ref: clean(`${ref} de ${source}`, 300), behind, rules: behind ? nextRules(source, ref) : [] };
    }
  }
  return { project, install, unreadable, hooksDisabled, tool, unknownToPlugin, pluginBehind, upcoming, needs: own?.needs ?? {} };
}

const short = (sha: string | null): string => (sha ? clean(sha).slice(0, 7) : '?');
const TERMINAL = 'dans un terminal, hors de Claude Code (l\'extension VS Code n\'a pas /plugin)';
const UPDATE = `${TERMINAL} : claude plugin marketplace update herbertcodex-apv && claude plugin update apv@herbertcodex-apv, puis une nouvelle session`;
const INSTALL = `${TERMINAL} : claude plugin marketplace add <dossier ou dépôt du pipeline> puis claude plugin install apv@herbertcodex-apv, puis une nouvelle session`;

/** The lines of `apv status` on the plugin: always one, and the warnings that need the operator. */
export function pluginLines(s: PluginStatus): string[] {
  const lines: string[] = [];
  const describe = (rules: CatalogRule[]): string => rules.map(r => `${r.id}${r.needs.length ? ` (exige : ${r.needs.map(n => s.needs[n] ?? n).join(' ; ')})` : ''}`).join(', ');
  const key = s.install ? clean(s.install.key, 80) : '';
  if (s.unreadable) {
    lines.push(`Plugin : ATTENTION : état illisible (${s.unreadable}) ; vérifier l'installation ${TERMINAL} (claude plugin list).`);
  } else if (!s.install) {
    lines.push(`Plugin : ${s.project ? 'ATTENTION : aucun plugin APV installé pour Claude Code, alors que ce projet est sous APV : ses crochets (sceau des relectures, journal de l\'opérateur, garde-fous) ne tournent pas et aucune fusion ne passera les règles. ' : 'aucun plugin APV installé pour Claude Code. '}Installer ${INSTALL}.`);
  } else if (!s.install.enabled) {
    lines.push(`Plugin : ATTENTION : ${key} installé mais désactivé (enabledPlugins)${s.project ? ' : ses crochets ne tournent pas dans ce projet' : ''}. Activer ${TERMINAL} : claude plugin enable ${key}, puis une nouvelle session.`);
  } else {
    lines.push(`Plugin : ${key} ${clean(s.install.version ?? '?', 40)} (${short(s.install.sha)}) ; outil : ${clean(s.tool.version ?? '?', 40)} (${short(s.tool.sha)}, ${s.tool.root}).`);
  }
  if (s.hooksDisabled) lines.push('  ATTENTION : disableAllHooks est posé dans les réglages de Claude Code : aucun crochet ne tourne (sceau, journal, garde-fous). Retire-le, puis une nouvelle session.');
  const installed = short(s.install?.sha ?? null);
  if (s.pluginBehind === 'changed') {
    lines.push(`  ATTENTION : le plugin installé (${installed}) est plus ancien que l'outil (${short(s.tool.sha)}) : ses crochets, agents, compétences, workflows, son manifeste ou son outil compilé ont changé depuis. Mettre le plugin à jour ${UPDATE}.`);
  } else if (s.pluginBehind === 'ahead') {
    lines.push(`  ATTENTION : le plugin installé (${installed}) est plus récent que cette copie de l'outil (${short(s.tool.sha)}) : mettre l'outil à jour (git pull dans ${s.tool.root}).`);
  } else if (s.pluginBehind === 'diverged') {
    lines.push(`  ATTENTION : le plugin installé (${installed}) et cette copie de l'outil (${short(s.tool.sha)}) viennent de branches différentes : remettre l'outil sur sa branche suivie, puis mettre le plugin à jour ${UPDATE}.`);
  } else if (s.pluginBehind === 'unknown') {
    lines.push(s.install?.sha
      ? `  ATTENTION : le plugin installé (${installed}) vient d'un commit que cette copie de l'outil ne connaît pas : rien ne dit que ses crochets suivent l'outil. Mettre le plugin à jour ${UPDATE}.`
      : `  ATTENTION : le plugin installé ne dit pas de quel commit il vient : rien ne dit que ses crochets suivent l'outil. Mettre le plugin à jour ${UPDATE}.`);
  }
  if (s.unknownToPlugin.length) {
    lines.push(`  ATTENTION : règles de fusion que le plugin installé (${short(s.install?.sha ?? null)}) ne connaît pas : ${describe(s.unknownToPlugin)}. apv stack merge les applique déjà ; mettre le plugin à jour ${UPDATE}.`);
  }
  if (s.upcoming?.behind) {
    lines.push(s.upcoming.rules === null
      ? `  Mise à jour à venir (${s.upcoming.ref}, ${s.upcoming.behind} commit(s)) : règles de fusion non lues (catalogue de cette version absent de la copie : clone partiel, ou branche non récupérée) ; mets à jour l'outil et le plugin ensemble (${UPDATE}).`
      : s.upcoming.rules.length
      ? `  Mise à jour à venir (${s.upcoming.ref}, ${s.upcoming.behind} commit(s)) : nouvelles règles de fusion ${describe(s.upcoming.rules)}. Avant de mettre à jour l'outil, réunis ce qu'elles exigent, puis mets à jour l'outil et le plugin ensemble (${UPDATE}).`
      : `  Mise à jour à venir (${s.upcoming.ref}, ${s.upcoming.behind} commit(s)) : aucune nouvelle règle de fusion ; mets à jour l'outil et le plugin ensemble (${UPDATE}).`);
  }
  return lines;
}
