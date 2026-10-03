import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitRead } from '../run/git-probe.js';

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
  /** The tool running this command: version and commit (null outside a checkout). */
  tool: { root: string; version: string | null; sha: string | null };
  /** Merge rules the running tool applies that the installed plugin does not know (its hooks may not satisfy them). */
  unknownToPlugin: CatalogRule[];
  /** Merge rules of the next version of the tool (the upstream branch of its checkout, as last fetched), not in this one. */
  upcoming: { ref: string; behind: number; rules: CatalogRule[] } | null;
  needs: Record<string, string>;
}

const PLUGIN_NAME = 'apv';
const CATALOG = join('docs', 'merge-rules.json');
/** The root of the running tool: `dist/rules/plugin-status.js`, two folders up. */
export const TOOL_ROOT = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');

/** Parses a catalog; null when it is not one. */
export function parseCatalog(text: string | null): Catalog | null {
  if (text === null) return null;
  try {
    const raw = JSON.parse(text) as { needs?: unknown; rules?: unknown };
    if (!Array.isArray(raw.rules)) return null;
    const rules = raw.rules.filter((r): r is CatalogRule => !!r && typeof r === 'object' && typeof (r as CatalogRule).id === 'string' && typeof (r as CatalogRule).since === 'string')
      .map(r => ({ id: r.id, since: r.since, needs: Array.isArray(r.needs) ? r.needs.filter((n): n is string => typeof n === 'string') : [], summary: typeof r.summary === 'string' ? r.summary : '' }));
    const needs = raw.needs && typeof raw.needs === 'object' ? Object.fromEntries(Object.entries(raw.needs as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string')) : {};
    return { needs, rules };
  } catch { return null; }
}

/** Compares two versions `x.y.z[-tag.n]`: negative, zero or positive. A version without tag comes after its tags. */
export function compareVersions(a: string, b: string): number {
  const split = (v: string): [number[], (string | number)[] | null] => {
    const [core, tag] = v.replace(/^v/, '').split('-', 2) as [string, string | undefined];
    return [core.split('.').map(n => Number(n) || 0), tag === undefined ? null : tag.split('.').map(p => (/^\d+$/.test(p) ? Number(p) : p))];
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

const readJson = (file: string): unknown => { try { return JSON.parse(readFileSync(file, 'utf8')) as unknown; } catch { return null; } };
const readText = (file: string): string | null => { try { return readFileSync(file, 'utf8'); } catch { return null; } };

/** The folder of the configuration of Claude Code: CLAUDE_CONFIG_DIR, else ~/.claude. */
export function claudeDir(env: NodeJS.ProcessEnv): string {
  return env['CLAUDE_CONFIG_DIR'] || join(homedir(), '.claude');
}

/**
 * The install of the plugin for this account, or null: the entry `apv@<marketplace>` of installed_plugins.json, enabled
 * when the settings of the account (then those of the project, which take precedence) do not turn it off.
 */
export function pluginInstall(dir: string, repo: string | null = null): PluginInstall | null {
  const installed = readJson(join(dir, 'plugins', 'installed_plugins.json')) as { plugins?: Record<string, unknown> } | null;
  const key = Object.keys(installed?.plugins ?? {}).find(k => k.split('@')[0] === PLUGIN_NAME);
  if (!key) return null;
  const entries = (installed!.plugins![key] as Array<Record<string, unknown>> | undefined) ?? [];
  const entry = entries.find(e => e['scope'] === 'user') ?? entries[0] ?? {};
  const settings = [join(dir, 'settings.json'), ...(repo ? [join(repo, '.claude', 'settings.json'), join(repo, '.claude', 'settings.local.json')] : [])];
  let enabled: boolean | null = null;
  for (const file of settings) {
    const value = (readJson(file) as { enabledPlugins?: Record<string, unknown> } | null)?.enabledPlugins?.[key];
    if (typeof value === 'boolean') enabled = value;
  }
  const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
  // A plugin installed for the project only (scope project) counts as enabled where it is installed.
  return { key, version: str(entry['version']), sha: str(entry['gitCommitSha']), installPath: str(entry['installPath']), enabled: enabled ?? false };
}

/** The folder of a marketplace added from a directory (`claude plugin marketplace add <dossier>`), or null. */
export function marketplaceDir(dir: string, key: string): string | null {
  const known = readJson(join(dir, 'plugins', 'known_marketplaces.json')) as Record<string, { source?: { source?: unknown; path?: unknown } }> | null;
  const source = known?.[key.split('@')[1] ?? '']?.source;
  return source?.source === 'directory' && typeof source.path === 'string' ? source.path : null;
}

/** The catalog of the running tool, of an install, or of a commit of a checkout of the tool. */
const catalogAt = (root: string): Catalog | null => parseCatalog(readText(join(root, CATALOG)));
const catalogOf = (root: string, ref: string): Catalog | null => parseCatalog(gitRead(root, ['show', `${ref}:${CATALOG}`]));

export function pluginStatus(repo: string, env: NodeJS.ProcessEnv, toolRoot = TOOL_ROOT): PluginStatus {
  const project = existsSync(join(repo, '.apv')) || existsSync(join(repo, 'pipeline.v2.json'));
  const dir = claudeDir(env);
  const install = pluginInstall(dir, repo);
  // Run from the installed copy (no checkout): the next version is read in the folder the marketplace was added from.
  if (!gitRead(toolRoot, ['rev-parse', 'HEAD']) && install) toolRoot = marketplaceDir(dir, install.key) ?? toolRoot;
  const pkg = readJson(join(toolRoot, 'package.json')) as { version?: unknown } | null;
  const tool = { root: toolRoot, version: typeof pkg?.version === 'string' ? pkg.version : null, sha: gitRead(toolRoot, ['rev-parse', 'HEAD']) };
  const own = catalogAt(toolRoot);
  // The catalog of the installed plugin: its own files, else the commit it was installed from, in this checkout.
  const installed = install?.installPath ? catalogAt(install.installPath) ?? (install.sha && tool.sha ? catalogOf(toolRoot, install.sha) : null) : null;
  const unknownToPlugin = install && install.sha !== tool.sha ? newRules(own, installed, install.version) : [];
  let upcoming: PluginStatus['upcoming'] = null;
  const upstream = tool.sha ? gitRead(toolRoot, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']) : null;
  if (upstream) {
    const behind = Number(gitRead(toolRoot, ['rev-list', '--count', `HEAD..${upstream}`]) ?? '0') || 0;
    const rules = behind ? newRules(catalogOf(toolRoot, upstream), own, tool.version) : [];
    upcoming = { ref: upstream, behind, rules };
  }
  return { project, install, tool, unknownToPlugin, upcoming, needs: own?.needs ?? {} };
}

const short = (sha: string | null): string => (sha ? sha.slice(0, 7) : '?');
const UPDATE = 'claude plugin marketplace update herbertcodex-apv && claude plugin update apv@herbertcodex-apv, puis une nouvelle session';
const INSTALL = 'claude plugin marketplace add <dossier ou dépôt du pipeline> puis claude plugin install apv@herbertcodex-apv (dans un terminal : l\'extension VS Code n\'a pas /plugin), puis une nouvelle session';

/** The lines of `apv status` on the plugin: always one, and the warnings that need the operator. */
export function pluginLines(s: PluginStatus): string[] {
  const lines: string[] = [];
  const describe = (rules: CatalogRule[]): string => rules.map(r => `${r.id}${r.needs.length ? ` (exige : ${r.needs.map(n => s.needs[n] ?? n).join(' ; ')})` : ''}`).join(', ');
  if (!s.install) {
    lines.push(`Plugin : ${s.project ? 'ATTENTION : aucun plugin APV installé pour Claude Code, alors que ce projet est sous APV : ses crochets (sceau des relectures, journal de l\'opérateur, garde-fous) ne tournent pas et aucune fusion ne passera les règles. ' : 'aucun plugin APV installé pour Claude Code. '}Installer : ${INSTALL}.`);
  } else if (!s.install.enabled) {
    lines.push(`Plugin : ATTENTION : ${s.install.key} installé mais désactivé (enabledPlugins)${s.project ? ' : ses crochets ne tournent pas dans ce projet' : ''}. Activer : claude plugin enable ${s.install.key}, puis une nouvelle session.`);
  } else {
    lines.push(`Plugin : ${s.install.key} ${s.install.version ?? '?'} (${short(s.install.sha)}) ; outil : ${s.tool.version ?? '?'} (${short(s.tool.sha)}, ${s.tool.root}).`);
  }
  if (s.unknownToPlugin.length) {
    lines.push(`  ATTENTION : règles de fusion que le plugin installé (${short(s.install?.sha ?? null)}) ne connaît pas : ${describe(s.unknownToPlugin)}. apv stack merge les applique déjà ; mettre le plugin à jour : ${UPDATE}.`);
  }
  if (s.upcoming?.behind) {
    lines.push(s.upcoming.rules.length
      ? `  Mise à jour à venir (${s.upcoming.ref}, ${s.upcoming.behind} commit(s)) : nouvelles règles de fusion ${describe(s.upcoming.rules)}. Avant de mettre à jour l'outil, réunis ce qu'elles exigent, puis mets à jour l'outil et le plugin ensemble (${UPDATE}).`
      : `  Mise à jour à venir (${s.upcoming.ref}, ${s.upcoming.behind} commit(s)) : aucune nouvelle règle de fusion.`);
  }
  return lines;
}
