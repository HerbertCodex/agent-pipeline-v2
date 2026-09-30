import { type Infer } from '../domain/schema.js';
/** Rules of `apv reuse check` (docs/REUSE.md). */
export declare const REUSE_RULES: readonly ["native", "styles", "duplicates", "names", "typography", "coverage"];
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
/** Folders of tools, left out wherever they are: never a hidden folder in general (`src/.hidden/` is analysed). */
export declare const TOOL_FOLDERS: readonly [".git", ".svelte-kit", ".next", ".nuxt", ".output", ".vercel", ".netlify", ".turbo", ".cache", ".parcel-cache", ".astro", ".angular", ".docusaurus", ".expo", ".yarn", ".pnpm-store", ".husky", ".idea", ".vscode", ".github", ".claude", ".apv", ".apv2"];
/** Build outputs and vendored code: left out at the root of the repository and of each package (a folder with a `package.json`) only. */
export declare const OUTPUT_FOLDERS: readonly ["dist", "build", "coverage", "vendor"];
/**
 * Paths never analysed: dependencies, tool folders, the documentation (validated mockups are HTML copies of the
 * interface by design) and minified or declaration files. Build outputs: OUTPUT_FOLDERS, see outputMatcher.
 */
export declare const DEFAULT_REUSE_IGNORE: readonly ["**/node_modules/**", ...string[], "docs/**", "**/*.min.js", "**/*.min.css", "**/*.d.ts", "**/*.lock", "**/package-lock.json"];
/**
 * Extensions a framework declares for its components (`extensions: ['.svelte', '.svx']` of `svelte.config.js`): read as
 * interface files too.
 */
export declare function frameworkExtensions(read: (path: string) => string | null, files: readonly string[]): string[];
/** Build outputs (OUTPUT_FOLDERS) at the root of the repository and at the root of each package that `files` holds. */
export declare function outputMatcher(files: readonly string[]): (path: string) => boolean;
/**
 * Files a tool writes (database types, clients, schemas), recognised by their name: left out of every rule and listed
 * apart in the report, never counted. A file whose first lines say it is generated (`@generated`, « do not edit »,
 * « auto-generated ») is treated the same way (GENERATED_HEADER), but only when it already said so at the base: a change
 * that adds the mention is reported, never trusted. An interface file (UI_EXTENSIONS) is never generated.
 */
export declare const GENERATED_PATHS: readonly ["**/*.generated.*", "**/*.gen.*", "**/generated/**", "**/__generated__/**", "**/database.types.*", "**/supabase.types.*"];
export declare const GENERATED_HEADER: RegExp;
/**
 * Where native elements and primitive styles may be written by default: the generic shared components (a design system
 * folder), never a component folder of one feature (`src/lib/admin/components`).
 */
export declare const DEFAULT_PRIMITIVE_PATHS: readonly ["**/components/ui/**", "**/ui/**", "**/primitives/**", "**/design-system/**", "**/shared/**", "**/common/**"];
/** Nested adjustments of a primitive under a class of the component: `layout` (default) accepts layout properties only. */
export declare const NESTED_MODES: readonly ["layout", "refuse", "allow"];
export type NestedMode = typeof NESTED_MODES[number];
/** Default bound of the code map in bytes: a few tens of kilobytes, read whole by an agent before each task. */
export declare const DEFAULT_MAP_MAX_BYTES = 32768;
/** A native element (`select`) or an element with one attribute value (`input[type=date]`). */
export declare const ELEMENT_SELECTOR: RegExp;
/** A class selector of a primitive (`.btn`), or a prefix of classes (`.btn--*`). */
export declare const PRIMITIVE_SELECTOR: RegExp;
/** The `reuse` section of `.apv/config.json` (docs/REUSE.md). Every field is optional: absent, the defaults apply. */
export declare const reuseSchema: import("../domain/schema.js").Schema<{
    readonly reference: string | undefined;
    readonly shared: string[] | undefined;
    readonly generated: string[] | undefined;
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
        readonly nested: "refuse" | "layout" | "allow" | undefined;
    } | undefined;
    readonly duplicates: {
        readonly minLines: number | undefined;
        readonly minTokens: number | undefined;
        readonly paths: string[] | undefined;
        readonly ignore: string[] | undefined;
        readonly styles: "off" | "warning" | "error" | undefined;
    } | undefined;
    readonly names: {
        readonly roles: Record<string, string[] | null> | undefined;
        readonly strong: string[] | undefined;
        readonly strongSeverity: "off" | "warning" | "error" | undefined;
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
    readonly maxBytes: number | undefined;
}>;
export type MapSection = Infer<typeof mapSchema>;
export interface ReuseSettings {
    reference: string | null;
    shared: string[];
    sharedDeclared: boolean;
    generated: string[];
    /** The globs of `reuse.ignore` as declared (the only ones that exempt a file the change creates or modifies). */
    declaredIgnore: string[];
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
        nested: NestedMode;
    };
    duplicates: {
        minLines: number;
        minTokens: number;
        paths: string[] | null;
        ignore: string[];
        styles: ReuseSeverity;
    };
    roles: Record<string, string[]>;
    /** Families of STRONG_FAMILIES (or `names.strong`), and the severity of a new component that redoes one of their generic shared components. */
    strong: string[];
    strongSeverity: ReuseSeverity;
    locale: string | null;
    severity: Record<ReuseRule, ReuseSeverity>;
}
/**
 * Role families of the name rule: two components whose last words fall in the same family do the same job
 * (`AdminToast` and `Toast`, `Snackbar` and `Toast`). A compound (`TabBar`) is matched joined (`tabbar`).
 */
export declare const DEFAULT_ROLE_FAMILIES: Readonly<Record<string, readonly string[]>>;
/**
 * Families of the application's structure and of its design system: a new component that redoes the generic shared one
 * (its name is only its role: `Sidebar`, `Toast`, `Select`) without composing it is a copy of the interface, blocking by
 * default. The other resemblances of names stay warnings.
 */
export declare const STRONG_FAMILIES: readonly ["shell", "sidebar", "tabbar", "topbar", "toast", "select", "dialog", "datepicker", "pagination", "tabs", "icon"];
/** A relative path or glob inside the repository, `/` separated, without leading `./` nor trailing slash. */
export declare function relativeGlob(value: string, field: string): string;
/** Effective settings of a `reuse` section: defaults completed, paths checked. Throws a CONFIG error. */
export declare function reuseSettings(section: ReuseSection | undefined): ReuseSettings;
export interface MapSettings {
    file: string;
    ignore: string[];
    maxEntries: number;
    maxBytes: number;
}
export declare function mapSettings(section: MapSection | undefined): MapSettings;
/** A matcher over repository paths for a list of globs (`{a,b}` accepted), compiled once. */
export declare function globMatcher(globs: readonly string[]): (path: string) => boolean;
/** Extension of a path, lower case, without the dot (`svelte` for `A.svelte`, `ts` for `x.svelte.ts`). */
export declare function extensionOf(path: string): string;
