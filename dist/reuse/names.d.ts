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
export declare function componentName(path: string, families: Readonly<Record<string, readonly string[]>>): ComponentName;
/**
 * Families made of other families: an application shell holds the side bar, the top bar and the tab bar. A new
 * `AdminShell` next to a shared `Sidebar` rebuilds the navigation the application already has.
 */
export declare const COMPOSITE_FAMILIES: Readonly<Record<string, readonly string[]>>;
export type ClashReason = 'same-name' | 'affix' | 'role';
export interface Clash {
    path: string;
    with: string;
    reason: ClashReason;
    family: string | null;
}
/**
 * How a component name doubles a shared one, by a rule anyone can check by hand:
 * - `same-name`: the same words (`admin/Toast.svelte` and `ui/Toast.svelte`);
 * - `affix`: the shared name starts or ends the other one (`AdminToast` and `Toast`, `SelectField` and `Select`);
 * - `role`: the shared component is generic (its name is only its role: `Toast`, `AppShell`, `TabBar`) and the new one
 *   ends in the same role family (`Snackbar`, `AdminLayout`), or is a composite of it (`AdminShell` next to `Sidebar`).
 * A part of the shared component (`MenuItem`, `ToastContainer`: only structural words added) is never a double.
 * Null when none applies.
 */
export declare function clashOf(candidate: ComponentName, shared: ComponentName): Clash | null;
/** The clash in words: « même rôle que src/lib/Toast.svelte (rôle toast) ». */
export declare function describeClash(clash: Clash): string;
