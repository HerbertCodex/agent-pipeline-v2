import { globToRegExp } from '../db/glob.js';
import { screenKey } from '../design/registry.js';
import { routeOf } from '../knowledge/code-map.js';
import type { Decision } from '../lifecycle/decisions.js';
import { anchoredQuote, type OperatorMessage } from './operator.js';

/** Decision ids of a validated mockup (`apv design register`). */
const MOCKUP_ID = /^maquette-([a-z0-9]+(?:-[a-z0-9]+)*?)-validee(?:-v[0-9]+)?$/;
const VALUE_SCREENS = /Écrans : ([^.]+)\./;

/**
 * Whether a file is a screen: a page, a layout or an error page of the routes the tool knows (SvelteKit `+page.svelte`,
 * Next `app/**\/page.tsx`, Remix `app/routes/*.tsx`, Nuxt, Astro, Vue `pages/**`), or a file of `rules.screens`. Server
 * code of a route (`+page.server.ts`, `+server.ts`, `pages/api/**`) is not a screen.
 */
export function isScreen(path: string, extra: readonly RegExp[] = []): boolean {
  if (extra.some(re => re.test(path))) return true;
  const route = routeOf(path);
  if (!route) return false;
  const name = path.slice(path.lastIndexOf('/') + 1);
  if (name.startsWith('+')) return /^\+(page|layout|error)(@[^.]*)?\.svelte$/.test(name);
  if (/(^|\/)(pages|routes)\/api(\/|\.)/.test(path) || /(^|\/)app\/api\//.test(path)) return false;
  if (/^(page|layout|template|not-found|error|loading|default)\.(tsx|jsx|js|mdx)$/.test(name)) return true;
  return /\.(svelte|vue|astro|tsx|jsx|mdx)$/.test(name);
}

export interface Mockup { id: string; slug: string; screens: string[]; paths: string[]; sourceQuote: string }

/** The confirmed operator mockups of a ledger. */
export function mockupsOf(decisions: readonly Decision[]): Mockup[] {
  return decisions.filter(d => MOCKUP_ID.test(d.id) && d.status === 'confirmed' && d.source === 'operator').map(d => ({
    id: d.id,
    slug: MOCKUP_ID.exec(d.id)![1]!,
    screens: VALUE_SCREENS.exec(d.value)?.[1]?.split(',').map(x => x.trim()).filter(Boolean) ?? [],
    paths: d.scope?.paths ?? [],
    sourceQuote: d.sourceQuote,
  }));
}

/** Keys a route answers to: the whole route and each of its fixed segments (`/admin/articles`: admin-articles, admin, articles). */
function routeKeys(path: string): string[] {
  const route = routeOf(path)?.route ?? null;
  if (!route) return [];
  const segments = route.split('/').filter(s => s && !/^[[:]/.test(s));
  const keys = [screenKey(route), ...segments.map(screenKey)];
  if (route === '/') keys.push('accueil', 'home', 'index');
  return [...new Set(keys.filter(Boolean))];
}

/** Whether a mockup covers a screen file: a path of its scope matches the file, or its name or one of its screens names its route. */
export function covers(mockup: Mockup, path: string): boolean {
  for (const glob of mockup.paths) {
    try { if (globToRegExp(glob).test(path)) return true; } catch { /* invalid glob: ignored */ }
  }
  const keys = routeKeys(path);
  return [mockup.slug, ...mockup.screens].some(s => keys.includes(screenKey(s)));
}

export interface ScreenCoverage {
  file: string;
  /** The mockup that covers it and why it counts (merged at the base, or validated by words the operator typed), or null. */
  mockup: { id: string; anchor: 'base' | 'operator' } | null;
  /** Mockups of the change that would cover it, whose validation is not found among the operator's messages. */
  unanchored: string[];
}

/**
 * For each screen the change adds or modifies, the validated mockup that covers it. A mockup counts when it is in the
 * ledger of the base (merged, so reviewed), or when the change brings it and its quote is found word for word among the
 * messages the operator typed (src/rules/operator.ts): a validation an agent wrote in the ledger alone never counts.
 */
export function screenCoverage(files: readonly string[], atBase: readonly Decision[], atHead: readonly Decision[], messages: readonly OperatorMessage[]): ScreenCoverage[] {
  const base = mockupsOf(atBase);
  const baseIds = new Set(base.map(m => m.id));
  const added = mockupsOf(atHead).filter(m => !baseIds.has(m.id));
  return files.map(file => {
    const fromBase = base.find(m => covers(m, file));
    if (fromBase) return { file, mockup: { id: fromBase.id, anchor: 'base' }, unanchored: [] };
    const candidates = added.filter(m => covers(m, file));
    const anchored = candidates.find(m => anchoredQuote(messages, m.sourceQuote) !== null);
    if (anchored) return { file, mockup: { id: anchored.id, anchor: 'operator' }, unanchored: [] };
    return { file, mockup: null, unanchored: candidates.map(m => m.id) };
  });
}

export function screenMatchers(globs: readonly string[]): RegExp[] {
  return globs.map(g => globToRegExp(g));
}
