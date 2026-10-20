import { type Infer } from '../domain/schema.js';
/** Codes of the tree findings of `apv structure check`. */
export declare const FINDING_CODES: readonly ["flat-folder", "repeated-prefix", "mixed-roles", "stray-file"];
export type FindingCode = typeof FINDING_CODES[number];
/**
 * Codes of the findings that compare the change with its base (`--base`): a code file added to a flat folder, and the
 * architecture map (a folder, route or entry point without description, a broken link). `error` by default: new ones block.
 */
export declare const CHANGE_CODES: readonly ["flat-growth", "architecture-map"];
export type ChangeCode = typeof CHANGE_CODES[number];
/** Default path of the architecture map (docs/STRUCTURE.md, « Carte de l'architecture »). */
export declare const DEFAULT_ARCHITECTURE_MAP = "docs/carte-architecture.md";
/** Stack profiles (src/structure/profiles.ts). */
export declare const PROFILE_IDS: readonly ["sveltekit", "nextjs", "nuxt", "astro", "angular", "vue", "react", "python", "go", "generic"];
export type Severity = 'warning' | 'error';
/** Default number of code files a folder may hold directly before `flat-folder`. */
export declare const DEFAULT_MAX_FLAT_FILES = 12;
/**
 * Default roles. A key starting with `-` is a name suffix (`application-actions.ts`: role `actions`, domain
 * `application`); any other key is a name part anywhere in the name (`security-headers.ts`: role `http`),
 * for cross-cutting concerns that have no domain of their own. A key may hold several words (`sign-in`).
 */
export declare const DEFAULT_ROLES: Readonly<Record<string, string>>;
/**
 * Folders left out by default (docs: « exclusions par défaut »): dependencies anywhere (`node_modules`), build outputs and
 * tool folders (`dist`, `build`, `coverage`, `vendor`, a name that starts with a dot) only at the root of the repository
 * or of a package (a folder with its own `package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `composer.json`).
 * A folder of that name deeper in the sources (`src/lib/x/vendor/`) is code like any other. With `--base`, what the change
 * creates is always analysed, default exclusions or not: only `structure.ignore` (of the base) leaves it out.
 */
export declare const DEFAULT_IGNORE: readonly ["**/node_modules/**", "dist/**", "build/**", "coverage/**", "vendor/**", ".*/**"];
/** Roots of the packages of a file list (folders with a manifest), node_modules left out. */
export declare function packageRoots(paths: readonly string[]): Set<string>;
/** Left out by the default exclusions: `node_modules` anywhere, outputs and tool folders at the root of the repository or of a package. */
export declare function defaultIgnored(path: string, roots: ReadonlySet<string>): boolean;
/**
 * The exclusion test of a file list: `structure.ignore` always, the default exclusions for what is not in `always` (the
 * files the change creates, which are always analysed).
 */
export declare function ignoreTest(settings: Pick<StructureSettings, 'ignore'>, paths: readonly string[], always?: ReadonlySet<string>): (path: string) => boolean;
/** The `structure` section of `.apv/config.json` (docs/CONFIGURATION.md, « Arborescence »). */
export declare const structureSchema: import("../domain/schema.js").Schema<{
    readonly roots: string[] | undefined;
    readonly maxFlatFiles: number | undefined;
    readonly roles: Record<string, string | null> | undefined;
    readonly domains: string[] | undefined;
    readonly ignore: string[] | undefined;
    readonly severity: "warning" | "error" | Record<string, "warning" | "error"> | undefined;
    readonly architectureMap: string | undefined;
    readonly profile: "sveltekit" | "nextjs" | "nuxt" | "astro" | "angular" | "vue" | "react" | "python" | "go" | "generic" | undefined;
}>;
export type StructureSection = Infer<typeof structureSchema>;
export interface StructureSettings {
    roots: string[];
    maxFlatFiles: number;
    roles: Record<string, string>;
    domains: string[];
    ignore: RegExp[];
    severity: Record<FindingCode | ChangeCode, Severity>;
    architectureMap: string;
    profile: typeof PROFILE_IDS[number] | null;
}
/** Effective settings of a `structure` section: defaults completed, paths checked. Throws a CONFIG error. */
export declare function structureSettings(section: StructureSection | undefined): StructureSettings;
