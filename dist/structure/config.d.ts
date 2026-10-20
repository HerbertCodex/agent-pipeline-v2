import { type Infer } from '../domain/schema.js';
/** Codes of the tree findings of `apv structure check`. */
export declare const FINDING_CODES: readonly ["flat-folder", "repeated-prefix", "mixed-roles", "stray-file"];
export type FindingCode = typeof FINDING_CODES[number];
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
 * Paths never analysed, whatever the configuration: dependencies, build outputs and tool folders
 * (a path segment that starts with a dot: `.github`, `.claude`, `.svelte-kit`).
 */
export declare const DEFAULT_IGNORE: readonly ["**/node_modules/**", "**/dist/**", "**/build/**", "**/coverage/**", "**/vendor/**", "**/.*/**"];
/** The `structure` section of `.apv/config.json` (docs/CONFIGURATION.md, « Arborescence »). */
export declare const structureSchema: import("../domain/schema.js").Schema<{
    readonly roots: string[] | undefined;
    readonly maxFlatFiles: number | undefined;
    readonly roles: Record<string, string | null> | undefined;
    readonly domains: string[] | undefined;
    readonly ignore: string[] | undefined;
    readonly severity: "warning" | "error" | Record<string, "warning" | "error"> | undefined;
}>;
export type StructureSection = Infer<typeof structureSchema>;
export interface StructureSettings {
    roots: string[];
    maxFlatFiles: number;
    roles: Record<string, string>;
    domains: string[];
    ignore: RegExp[];
    severity: Record<FindingCode, Severity>;
}
/** Effective settings of a `structure` section: defaults completed, paths checked. Throws a CONFIG error. */
export declare function structureSettings(section: StructureSection | undefined): StructureSettings;
