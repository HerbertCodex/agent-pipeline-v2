import { type Infer } from '../domain/schema.js';
/** Default folder of validated mockups, relative to the repository root (`design.dir` overrides it). */
export declare const DEFAULT_DESIGN_DIR = "docs/design";
/** A group of validated mockups: a sub-folder of `design.dir` and the name (slug) patterns it takes. */
export declare const designGroupSchema: import("../domain/schema.js").Schema<{
    readonly dir: string;
    readonly match: string[];
}>;
/** The `design` section of `.apv/config.json` (docs/DESIGN.md). */
export declare const designSchema: import("../domain/schema.js").Schema<{
    readonly dir: string | undefined;
    readonly groups: {
        readonly dir: string;
        readonly match: string[];
    }[] | undefined;
    readonly defaultGroup: string | undefined;
}>;
export type DesignSection = Infer<typeof designSchema>;
export interface DesignGroup {
    dir: string;
    match: string[];
}
/** Validated `design` section: folder, groups in order and the folder of the names no group takes (null: the root). */
export interface DesignSettings {
    dir: string;
    groups: DesignGroup[];
    defaultGroup: string | null;
}
/**
 * The validated-mockup folder of a `design` section: relative, inside the repository, without spaces,
 * normalized (no trailing slash). Throws a CONFIG error that names the faulty value.
 */
export declare function designDir(section: DesignSection | undefined): string;
/** Folder of the drafts of the mockup loop (`<design.dir>/brouillons/`): never a group. */
export declare const RESERVED_GROUP = "brouillons";
/**
 * A group sub-folder (`design.groups[].dir`, `design.defaultGroup`, `--group`), without its trailing slash:
 * relative to `design.dir`, without `..`, `.` or empty segment, without spaces; letters, digits, `.`, `_` and `-`
 * only, never under `brouillons/` (the drafts). Throws a CONFIG error that names `field` and the faulty value.
 */
export declare function groupDir(value: string, field: string): string;
/** Every setting of a `design` section, validated (CONFIG error naming the faulty field otherwise). */
export declare function designSettings(section: DesignSection | undefined): DesignSettings;
/** Whether the section declares groups (`design.groups` or `design.defaultGroup`). */
export declare const hasGroups: (settings: DesignSettings) => boolean;
/** Declared group folders: those of `design.groups` in order, then `design.defaultGroup` when it is another one. */
export declare function declaredGroups(settings: DesignSettings): string[];
/** Group a name falls in by the patterns: the first group that matches, else `defaultGroup`, else null (the root of `dir`). */
export declare function groupForName(settings: DesignSettings, slug: string): string | null;
/** Folder of a group: `<dir>/<group>`, or `dir` itself for the root (null). */
export declare const groupFolder: (settings: DesignSettings, group: string | null) => string;
