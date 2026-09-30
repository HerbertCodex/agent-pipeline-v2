import { type Infer } from '../domain/schema.js';
/** Rules of `apv reuse check` (docs/REUSE.md). */
export declare const REUSE_RULES: readonly ["native", "styles", "duplicates", "names", "typography"];
export type ReuseRule = typeof REUSE_RULES[number];
export declare const REUSE_SEVERITIES: readonly ["off", "warning", "error"];
export type ReuseSeverity = typeof REUSE_SEVERITIES[number];
/**
 * Default severity of each rule: a native element or a primitive restyled outside the shared components, and a block
 * copied by the change, fail the check; a component whose name doubles a shared one and a breakable space in a
 * typographic value are warnings (their rule is a prompt to look, not a proof).
 */
export declare const DEFAULT_REUSE_SEVERITY: Readonly<Record<ReuseRule, ReuseSeverity>>;
/** Native elements reserved to the shared components by default: their look and behaviour differ between browsers. */
export declare const DEFAULT_NATIVE_ELEMENTS: readonly ["select", "dialog", "datalist"];
/** The role family of the shared component that stands for a native element (`select` is replaced by a select). */
export declare const ELEMENT_FAMILIES: Readonly<Record<string, string>>;
/** Shared component folders when the project declares none: the usual names, whatever their depth. */
export declare const DEFAULT_SHARED: readonly ["**/components/**", "**/ui/**", "**/shared/**", "**/common/**"];
/** Blocks shorter than this are never reported (the defaults of jscpd: 5 lines, 50 tokens). */
export declare const DEFAULT_DUPLICATES: {
    readonly minLines: 5;
    readonly minTokens: 50;
};
/** Global stylesheets looked for, in this order, when `styles.sources` is absent: the first ones present are read. */
export declare const DEFAULT_STYLE_SOURCES: readonly ["src/app.css", "src/app.scss", "src/app.pcss", "src/app.postcss", "src/global.css", "src/globals.css", "src/index.css", "src/styles.css", "src/styles/app.css", "src/styles/global.css", "src/styles/globals.css", "src/styles/main.css", "src/assets/main.css", "src/assets/base.css", "app/globals.css", "app/global.css", "styles/globals.css", "styles/global.css", "assets/css/main.css", "static/global.css", "public/global.css"];
/** Files that hold interface markup: the native elements, local styles and texts are read there. */
export declare const UI_EXTENSIONS: Set<string>;
/** Component files (a file that is one component), for the map and the name rule. */
export declare const COMPONENT_EXTENSIONS: Set<string>;
/** Stylesheets. */
export declare const STYLE_EXTENSIONS: Set<string>;
/**
 * Paths never analysed: dependencies, build outputs, tool folders (DEFAULT_IGNORE of `structure`), the documentation
 * (validated mockups are HTML copies of the interface by design) and the files a tool writes.
 */
export declare const DEFAULT_REUSE_IGNORE: readonly ["**/node_modules/**", "**/dist/**", "**/build/**", "**/coverage/**", "**/vendor/**", "**/.*/**", "docs/**", "**/*.min.js", "**/*.min.css", "**/*.d.ts", "**/*.generated.*", "**/generated/**", "**/*.lock", "**/package-lock.json"];
/** A native element (`select`) or an element with one attribute value (`input[type=date]`). */
export declare const ELEMENT_SELECTOR: RegExp;
/** A class selector of a primitive (`.btn`), or a prefix of classes (`.btn--*`). */
export declare const PRIMITIVE_SELECTOR: RegExp;
/** The `reuse` section of `.apv/config.json` (docs/REUSE.md). Every field is optional: absent, the defaults apply. */
export declare const reuseSchema: import("../domain/schema.js").Schema<{
    readonly reference: string | undefined;
    readonly shared: string[] | undefined;
    readonly ignore: string[] | undefined;
    readonly native: {
        readonly elements: Record<string, string | null> | undefined;
        readonly allowedPaths: string[] | undefined;
    } | undefined;
    readonly styles: {
        readonly sources: string[] | undefined;
        readonly selectors: string[] | undefined;
        readonly except: string[] | undefined;
        readonly allowedPaths: string[] | undefined;
        readonly nested: "refuse" | "allow" | undefined;
    } | undefined;
    readonly duplicates: {
        readonly minLines: number | undefined;
        readonly minTokens: number | undefined;
        readonly paths: string[] | undefined;
        readonly ignore: string[] | undefined;
    } | undefined;
    readonly names: {
        readonly roles: Record<string, string[] | null> | undefined;
    } | undefined;
    readonly typography: {
        readonly locale: string;
    } | undefined;
    readonly severity: "off" | "warning" | "error" | Record<string, "off" | "warning" | "error"> | undefined;
}>;
export type ReuseSection = Infer<typeof reuseSchema>;
/** The `map` section of `.apv/config.json`: where `apv map` writes the code map, and what it leaves out. */
export declare const DEFAULT_MAP_FILE = ".apv/code-map.md";
export declare const DEFAULT_MAP_MAX_ENTRIES = 400;
export declare const mapSchema: import("../domain/schema.js").Schema<{
    readonly file: string | undefined;
    readonly ignore: string[] | undefined;
    readonly maxEntries: number | undefined;
}>;
export type MapSection = Infer<typeof mapSchema>;
export interface ReuseSettings {
    reference: string | null;
    shared: string[];
    sharedDeclared: boolean;
    ignore: string[];
    native: {
        elements: Record<string, string | null>;
        allowedPaths: string[];
    };
    styles: {
        sources: string[] | null;
        selectors: string[];
        except: string[];
        allowedPaths: string[];
        nested: 'refuse' | 'allow';
    };
    duplicates: {
        minLines: number;
        minTokens: number;
        paths: string[] | null;
        ignore: string[];
    };
    roles: Record<string, string[]>;
    locale: string | null;
    severity: Record<ReuseRule, ReuseSeverity>;
}
/**
 * Role families of the name rule: two components whose last words fall in the same family do the same job
 * (`AdminToast` and `Toast`, `Snackbar` and `Toast`). A compound (`TabBar`) is matched joined (`tabbar`).
 */
export declare const DEFAULT_ROLE_FAMILIES: Readonly<Record<string, readonly string[]>>;
/** A relative path or glob inside the repository, `/` separated, without leading `./` nor trailing slash. */
export declare function relativeGlob(value: string, field: string): string;
/** Effective settings of a `reuse` section: defaults completed, paths checked. Throws a CONFIG error. */
export declare function reuseSettings(section: ReuseSection | undefined): ReuseSettings;
export interface MapSettings {
    file: string;
    ignore: string[];
    maxEntries: number;
}
export declare function mapSettings(section: MapSection | undefined): MapSettings;
/** A matcher over repository paths for a list of globs (`{a,b}` accepted), compiled once. */
export declare function globMatcher(globs: readonly string[]): (path: string) => boolean;
/** Extension of a path, lower case, without the dot (`svelte` for `A.svelte`, `ts` for `x.svelte.ts`). */
export declare function extensionOf(path: string): string;
