import { builtinModules } from 'node:module';
import { posix } from 'node:path';
import { gitRead } from '../run/git-probe.js';

/**
 * The aliases a test run resolves besides relative paths (issue #130, security review): `imports` of package.json (`#support/*`),
 * `compilerOptions.paths` of the tsconfig and jsconfig files (`$support/*`), the `$lib` of SvelteKit (`kit.alias` of its
 * configuration, else `src/lib`). All read at the base commit. A bare specifier that is neither an alias, nor a Node module, nor a
 * package declared by the root package.json cannot be followed: the caller leaves the CI lane.
 */

/** Modules SvelteKit provides itself (virtual, nothing to protect). */
const VIRTUAL = /^\$(?:app|env)\/|^\$service-worker$/;
const BUILTINS = new Set(builtinModules.map(m => m.replace(/^node:/, '')));

export interface Aliases {
  /** Repository paths a non-relative specifier written in `from` may designate (to resolve as files), or null when it is no alias. */
  targets(from: string, spec: string): string[] | null;
  /** Whether a bare specifier is a Node module, a virtual module or a package the root package.json declares. */
  isKnownPackage(spec: string): boolean;
  /** Files read to build the aliases that could not be parsed. */
  unreadable: string[];
}

/** JSON with comments and trailing commas (tsconfig), or null. */
function parseLoose(text: string): Record<string, unknown> | null {
  const clean = text.replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_, s: string | undefined) => s ?? '').replace(/,(\s*[}\]])/g, '$1');
  try {
    const value: unknown = JSON.parse(clean);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}
const obj = (v: unknown): Record<string, unknown> | null => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
/** Every string of a value (a target, a list of targets, conditions of `imports`). */
function strings(v: unknown): string[] {
  if (typeof v === 'string') return [v];
  if (Array.isArray(v)) return v.flatMap(strings);
  const o = obj(v);
  return o ? Object.values(o).flatMap(strings) : [];
}

interface Rule { prefix: string; wildcard: boolean; suffix: string; targets: string[] }
const toRule = (key: string, targets: string[]): Rule => {
  const star = key.indexOf('*');
  return star < 0 ? { prefix: key, wildcard: false, suffix: '', targets } : { prefix: key.slice(0, star), wildcard: true, suffix: key.slice(star + 1), targets };
};
function expand(rules: readonly Rule[], spec: string): string[] | null {
  const hits = rules.filter(r => r.wildcard ? spec.startsWith(r.prefix) && spec.endsWith(r.suffix) && spec.length >= r.prefix.length + r.suffix.length : spec === r.prefix);
  if (!hits.length) return null;
  return hits.flatMap(r => r.targets.map(t => r.wildcard ? t.replace('*', spec.slice(r.prefix.length, spec.length - r.suffix.length)) : t));
}

export function readAliases(repo: string, base: string, tree: readonly string[]): Aliases {
  const unreadable: string[] = [];
  const read = (file: string): string | null => gitRead(repo, ['show', `${base}:${file}`]);
  const pkg = obj(parseLoose(read('package.json') ?? '{}')) ?? {};
  // `imports` of the root package.json: targets relative to the root.
  const importRules = Object.entries(obj(pkg['imports']) ?? {}).map(([k, v]) => toRule(k, strings(v).map(t => posix.normalize(t))));
  // `paths` of every tsconfig and jsconfig, applied to the whole repository (wider than needed, never narrower).
  const pathRules: Rule[] = [];
  const baseUrls: string[] = [];
  for (const file of tree.filter(f => /(?:^|\/)[tj]sconfig[^/]*\.json$/.test(f))) {
    const config = parseLoose(read(file) ?? '');
    if (!config) { unreadable.push(file); continue; }
    const options = obj(config['compilerOptions']);
    const dir = posix.dirname(file);
    const baseUrl = typeof options?.['baseUrl'] === 'string' ? posix.join(dir, options['baseUrl']) : dir;
    for (const [k, v] of Object.entries(obj(options?.['paths']) ?? {})) pathRules.push(toRule(k, strings(v).map(t => posix.join(baseUrl, t))));
    // A bare specifier that is no known package is resolved from baseUrl.
    if (typeof options?.['baseUrl'] === 'string') baseUrls.push(baseUrl);
  }
  // SvelteKit: `$lib` is `src/lib` unless `kit.alias` says otherwise; its other aliases come from the same configuration.
  const kitRules: Rule[] = [toRule('$lib', ['src/lib']), toRule('$lib/*', ['src/lib/*'])];
  for (const file of tree.filter(f => /^svelte\.config\.[cm]?[jt]s$/.test(f))) {
    const alias = /\balias\s*:\s*\{([^}]*)\}/.exec(read(file) ?? '')?.[1] ?? '';
    for (const m of alias.matchAll(/(['"]?)([^\s'",:]+)\1\s*:\s*(['"])([^'"]+)\3/g)) {
      kitRules.push(toRule(m[2]!, [posix.normalize(m[4]!)]));
      if (!m[2]!.endsWith('*')) kitRules.push(toRule(`${m[2]}/*`, [`${posix.normalize(m[4]!)}/*`]));
    }
  }
  const declared = new Set(['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].flatMap(k => Object.keys(obj(pkg[k]) ?? {})));
  const isKnownPackage = (spec: string): boolean => {
    if (spec.startsWith('node:') || VIRTUAL.test(spec)) return true;
    const parts = spec.split('/');
    const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
    return BUILTINS.has(name) || declared.has(name);
  };
  return {
    targets: (_from, spec) => {
      if (spec.startsWith('#')) return expand(importRules, spec);
      const found = expand([...kitRules, ...pathRules], spec);
      if (found || isKnownPackage(spec) || !baseUrls.length || spec.startsWith('/')) return found;
      return baseUrls.map(b => posix.join(b, spec));
    },
    isKnownPackage,
    unreadable,
  };
}
