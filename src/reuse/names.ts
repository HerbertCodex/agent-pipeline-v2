import { posix } from 'node:path';
import { related, singular, tokenize } from '../structure/names.js';

/**
 * Words that say where a component sits, not what it does: dropped from the end of a name before its role is read
 * (`ToastContainer` does the job of a toast, `EmptyState` of an empty state).
 */
const STRUCTURAL = new Set(['container', 'wrapper', 'root', 'provider', 'list', 'group', 'item', 'items', 'content', 'view', 'panel', 'center',
  'host', 'region', 'area', 'stack', 'outlet', 'portal', 'state', 'component', 'widget', 'base', 'custom', 'new', 'old', 'v2']);

/** Words that only say a component belongs to the application or to the design system (`AppShell`, `BaseButton`, `UiSelect`). */
const GENERIC = new Set(['app', 'base', 'ui', 'core', 'common', 'shared', 'global', 'main', 'default', 'root']);

export interface ComponentName {
  path: string;
  /** File name before its first dot (`AdminToast`). */
  stem: string;
  words: string[];
  /** Role family of the name (`toast`), or null. */
  family: string | null;
  /** The name is only its role (`Toast`, `ToastRegion`, `AppShell`, `TabBar`): a generic component of that family. */
  generic: boolean;
}

/** Words of a component file name, and its role family: the longest compound (3 words at most) that ends the name. */
export function componentName(path: string, families: Readonly<Record<string, readonly string[]>>): ComponentName {
  const stem = posix.basename(path).split('.')[0] ?? '';
  const words = tokenize(stem);
  let end = words.length;
  while (end > 1 && STRUCTURAL.has(words[end - 1]!)) end--;
  let family: string | null = null;
  for (let k = Math.min(3, end); k >= 1 && !family; k--) {
    const joined = words.slice(end - k, end).join('');
    for (const [name, members] of Object.entries(families)) {
      if (members.includes(joined) || members.includes(singular(joined))) { family = name; break; }
    }
  }
  let start = 0;
  while (start < end - 1 && GENERIC.has(words[start]!)) start++;
  const core = words.slice(start, end).join('');
  const generic = family !== null && ((families[family] ?? []).includes(core) || (families[family] ?? []).includes(singular(core)));
  return { path, stem, words, family, generic };
}

/**
 * Families made of other families: an application shell holds the side bar, the top bar and the tab bar. A new
 * `AdminShell` next to a shared `Sidebar` rebuilds the navigation the application already has.
 */
export const COMPOSITE_FAMILIES: Readonly<Record<string, readonly string[]>> = { shell: ['sidebar', 'topbar', 'tabbar'] };

export type ClashReason = 'same-name' | 'affix' | 'role';
export interface Clash { path: string; with: string; reason: ClashReason; family: string | null }

const sameWords = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((w, i) => related(w, b[i]!));

/**
 * How a component name doubles a shared one, by a rule anyone can check by hand:
 * - `same-name`: the same words (`admin/Toast.svelte` and `ui/Toast.svelte`);
 * - `affix`: the shared name starts or ends the other one (`AdminToast` and `Toast`, `SelectField` and `Select`);
 * - `role`: the shared component is generic (its name is only its role: `Toast`, `AppShell`, `TabBar`) and the new one
 *   ends in the same role family (`Snackbar`, `AdminLayout`), or is a composite of it (`AdminShell` next to `Sidebar`).
 * A part of the shared component (`MenuItem`, `ToastContainer`: only structural words added) is never a double.
 * Null when none applies.
 */
export function clashOf(candidate: ComponentName, shared: ComponentName): Clash | null {
  if (candidate.path === shared.path || !candidate.words.length || !shared.words.length) return null;
  const base = { path: candidate.path, with: shared.path };
  if (sameWords(candidate.words, shared.words)) return { ...base, reason: 'same-name', family: candidate.family };
  const n = shared.words.length;
  const extra = (words: readonly string[]): boolean => words.some(w => !STRUCTURAL.has(w));
  // One is a part of the other (`MenuItem` and `Menu`, `ToastRegion` and `Toast`): only structural words differ.
  const core = (words: readonly string[]): string[] => { let end = words.length; while (end > 1 && STRUCTURAL.has(words[end - 1]!)) end--; return words.slice(0, end); };
  if (sameWords(core(candidate.words), core(shared.words))) return null;
  // A part of the shared component (`MenuItem` next to `Menu`, `ToastContainer` next to `Toast`) is not a double.
  if (candidate.words.length > n && ((sameWords(candidate.words.slice(0, n), shared.words) && extra(candidate.words.slice(n)))
    || (sameWords(candidate.words.slice(-n), shared.words) && extra(candidate.words.slice(0, -n))))) {
    return { ...base, reason: 'affix', family: candidate.family };
  }
  // A role is doubled only against a generic shared component, one whose name is its role: two specific dialogs
  // (`AddDeviceDialog`, `ConfirmDialog`) do different jobs; a new `AdminToast` next to `Toast` does the same one.
  if (!shared.generic || !candidate.family || !shared.family) return null;
  if (candidate.family === shared.family) return { ...base, reason: 'role', family: candidate.family };
  if (COMPOSITE_FAMILIES[candidate.family]?.includes(shared.family)) return { ...base, reason: 'role', family: candidate.family };
  return null;
}

const CLASH_LABEL: Readonly<Record<ClashReason, string>> = {
  'same-name': 'même nom que',
  affix: 'nom construit sur celui de',
  role: 'même rôle que',
};

/** The clash in words: « même rôle que src/lib/Toast.svelte (rôle toast) ». */
export function describeClash(clash: Clash): string {
  return `${CLASH_LABEL[clash.reason]} ${clash.with}${clash.family ? ` (rôle ${clash.family})` : ''}`;
}

/**
 * The shared component that replaces a native element or a family: a generic one (its name is only its role, `Select`,
 * `Dialog`), never a component of one feature (`AddDeviceDialog`); those under `preferred` (the design system folders)
 * first, then the shortest path. Null when there is none.
 */
export function replacementFor(paths: readonly string[], family: string, families: Readonly<Record<string, readonly string[]>>, preferred: (path: string) => boolean): string | null {
  const candidates = paths.map(p => componentName(p, families)).filter(c => c.family === family && c.generic)
    .sort((a, b) => Number(preferred(b.path)) - Number(preferred(a.path)) || a.path.length - b.path.length || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return candidates[0]?.path ?? null;
}
