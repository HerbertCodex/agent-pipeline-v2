import { type StructureSettings } from './config.js';
import { COMMON_KNOWN, type KnownPath, type StackProfile } from './profiles.js';
/**
 * The architecture map (docs/STRUCTURE.md, « Carte de l'architecture »): one short page that a developer or an agent
 * reads first. Generated parts (the tree, the entry points, the links) are rewritten by `apv map` and
 * `apv structure map`; written parts (summary, layers and flows, cross-cutting rules, roles) sit between markers and are
 * never rewritten. `apv structure check --base` refuses a folder of the first or second level, a main route or an entry
 * point the change adds without a role in the written part, and a link the change breaks.
 */
export type ItemKind = 'folder' | 'route' | 'entry';
/** Something the map must describe: a folder (`src/lib/applications/`), a main route (`/agenda`), an entry point (a file). */
export interface ArchItem {
    kind: ItemKind;
    key: string;
    known: KnownPath | null;
}
export declare const GENERATED_BLOCKS: readonly ["arborescence", "entrees", "liens"];
export declare const WRITTEN_BLOCKS: readonly ["resume", "flux", "regles", "roles"];
type BlockId = typeof GENERATED_BLOCKS[number] | typeof WRITTEN_BLOCKS[number];
/** A role says something: three words at least, placeholders apart (`x`, `divers`, « à décrire » are no role). */
export declare const MIN_ROLE_WORDS = 3;
export declare function meaningfulRole(role: string): boolean;
/** Markers present more than once: a copied block would make a stale map look up to date. */
export declare function duplicateMarkers(text: string): string[];
/** Content of a block, or null when the file does not have it. */
export declare function blockOf(text: string, id: BlockId): string | null;
/** The map without the content of its `roles` block: what a task must leave as it is. */
export declare function withoutRoles(text: string): string;
/** The roles written in the `roles` block: key (a path, `/route`, a glob with `*`) -> role, placeholders left out. */
export declare function writtenRoles(text: string | null): Map<string, string>;
/**
 * The written role of an item: its exact key, else a glob of the roles block (`src/lib/*` or `src/lib/*\/`). With `globs`,
 * only those globs count (for an item the change adds: the globs already at the base, never a catch-all it brings).
 */
export declare function roleOf(item: ArchItem, roles: ReadonlyMap<string, string>, globs?: ReadonlySet<string>): string | null;
/**
 * What the map must describe, from the file list: folders of levels 1 and 2 (from the root and from the anchors of the
 * profile, route folders apart), main routes (first segment), entry points (the profile's, crons, migrations).
 * `read` gives a file's text (crons, scheduled workflows); null when unreadable.
 */
export declare function archItems(files: readonly string[], profile: StackProfile, settings: Pick<StructureSettings, 'ignore'>, read: (path: string) => string | null, always?: ReadonlySet<string>): ArchItem[];
/** A relative Markdown link of the map, broken when its target is neither a file nor a folder of the repository. */
export declare function brokenLinks(text: string, mapPath: string, exists: (path: string) => boolean): {
    target: string;
    line: number;
}[];
export interface MapInputs {
    mapPath: string;
    profile: StackProfile;
    items: ArchItem[];
    /** Files of the repository (links to what exists). */
    files: readonly string[];
    /** Validated mockups folder, when declared. */
    designDir: string | null;
    codeMapPath: string;
    maxFlatFiles: number;
    /** Folders above the threshold, with their proposed subfolders. */
    crowded: {
        folder: string;
        code: number;
        groups: string[];
    }[];
    /** Dependencies of the project (for the draft of the layers). */
    dependencies: readonly string[];
    read: (path: string) => string | null;
}
/** The generated blocks, from the inputs and the written roles of the current file. */
export declare function generatedBlocks(inputs: MapInputs, roles: ReadonlyMap<string, string>): Record<typeof GENERATED_BLOCKS[number], string>;
/** The initial content of the written blocks: a draft to check and complete, never rewritten afterwards. */
export declare function writtenDrafts(inputs: MapInputs): Record<typeof WRITTEN_BLOCKS[number], string>;
/** The whole map, for a new file. */
export declare function newMap(inputs: MapInputs): string;
/**
 * The map with its generated blocks rewritten and everything else kept as it is. A block the file lacks is appended at
 * its end (a written one with its draft): nothing written by hand is ever replaced.
 */
export declare function refreshMap(current: string, inputs: MapInputs): string;
export { COMMON_KNOWN };
